import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { MAX_POSITION, position } from "@causalweb/protocol";

export const ORDER_CONTRACT = "reference-orders/v1";
export const ORDER_SCHEMA = "orders/v1";

function required(row, name) {
  if (row === undefined) throw new Error(`missing ${name}`);
  return row;
}

function canonicalPosition(value) {
  const parsed = position(value);
  if (parsed < 1n) throw new Error("order positions start at one");
  return parsed;
}

function sameEvent(row, event) {
  return row.event_id === event.id && row.order_value === event.order;
}

function bindIdentity(database, role, identity, viewContract) {
  if (
    !identity ||
    ["issuer", "domain", "audience", "subject"].some(
      (field) => typeof identity[field] !== "string" || !identity[field],
    )
  )
    throw new Error("database identity is required");
  database.exec("BEGIN IMMEDIATE");
  try {
    const schemaVersion = role === "view" ? 3 : 2;
    const existing = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'reference_identity'",
      )
      .get();
    const contractExists =
      role === "view" &&
      database
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'view_contract'")
        .get() !== undefined;
    const hasHistory =
      role === "source"
        ? database.prepare("SELECT 1 FROM source_orders LIMIT 1").get() !== undefined ||
          database.prepare("SELECT next_position FROM source_state WHERE id = 1").get()
            ?.next_position !== "1"
        : contractExists ||
          database.prepare("SELECT 1 FROM view_orders LIMIT 1").get() !== undefined ||
          database.prepare("SELECT 1 FROM view_pending LIMIT 1").get() !== undefined ||
          database.prepare("SELECT frontier FROM view_state WHERE id = 1").get()?.frontier !== null;
    if (!existing) {
      if (hasHistory) throw new Error("populated database has no bound identity");
      database.exec(`
        CREATE TABLE reference_identity (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          version INTEGER NOT NULL CHECK (version IN (1, 2, 3)),
          role TEXT NOT NULL,
          issuer TEXT NOT NULL,
          domain TEXT NOT NULL,
          audience TEXT NOT NULL,
          subject TEXT NOT NULL
        );
      `);
    }
    const bound = database.prepare("SELECT * FROM reference_identity WHERE id = 1").get();
    if (!bound) {
      if (hasHistory) throw new Error("populated database has no bound identity");
      database
        .prepare(
          "INSERT INTO reference_identity (id, version, role, issuer, domain, audience, subject) VALUES (1, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          schemaVersion,
          role,
          identity.issuer,
          identity.domain,
          identity.audience,
          identity.subject,
        );
    } else if (
      (bound.version !== schemaVersion &&
        bound.version !== 1 &&
        !(role === "view" && bound.version === 2)) ||
      bound.role !== role ||
      ["issuer", "domain", "audience", "subject"].some((field) => bound[field] !== identity[field])
    )
      throw new Error("database identity or schema version does not match configuration");
    if (role === "source") {
      const requestsExist =
        database
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'source_requests'")
          .get() !== undefined;
      if (bound?.version === 2 && !requestsExist)
        throw new Error("source request mapping is missing");
      database.exec(`
        CREATE TABLE IF NOT EXISTS source_requests (
          request_key TEXT PRIMARY KEY,
          position TEXT NOT NULL UNIQUE REFERENCES source_orders(position)
        );
      `);
    } else {
      const decisionsExist =
        database
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'view_failure_events'",
          )
          .get() !== undefined;
      if (bound?.version >= 2 && !decisionsExist)
        throw new Error("view failure history is missing");
      if (bound?.version === 1 && decisionsExist)
        throw new Error("view failure history predates schema upgrade");
      database.exec(`
        CREATE TABLE IF NOT EXISTS view_failure_events (
          id INTEGER PRIMARY KEY,
          position TEXT NOT NULL,
          contract TEXT NOT NULL,
          schema TEXT NOT NULL,
          action TEXT NOT NULL CHECK (action IN ('failed', 'resolved')),
          operator TEXT NOT NULL,
          recorded_at TEXT NOT NULL
        );
      `);
      if (bound?.version === 3) {
        if (!contractExists) throw new Error("view contract binding is missing");
        const stored = database
          .prepare("SELECT contract, schema FROM view_contract WHERE id = 1")
          .get();
        if (stored?.contract !== viewContract.contract || stored.schema !== viewContract.schema)
          throw new Error("view contract does not match configuration");
      } else {
        if (contractExists) throw new Error("view contract binding predates schema upgrade");
        if (
          bound &&
          (viewContract.contract !== ORDER_CONTRACT || viewContract.schema !== ORDER_SCHEMA)
        )
          throw new Error("legacy view requires its original contract");
        database.exec(`
          CREATE TABLE view_contract (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            contract TEXT NOT NULL,
            schema TEXT NOT NULL
          );
        `);
        database
          .prepare("INSERT INTO view_contract (id, contract, schema) VALUES (1, ?, ?)")
          .run(viewContract.contract, viewContract.schema);
      }
    }
    if (bound && bound.version !== schemaVersion)
      database.exec(`
          CREATE TABLE reference_identity_next (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            version INTEGER NOT NULL CHECK (version IN (1, 2, 3)),
            role TEXT NOT NULL,
            issuer TEXT NOT NULL,
            domain TEXT NOT NULL,
            audience TEXT NOT NULL,
            subject TEXT NOT NULL
          );
          INSERT INTO reference_identity_next
            SELECT id, ${schemaVersion}, role, issuer, domain, audience, subject FROM reference_identity;
          DROP TABLE reference_identity;
          ALTER TABLE reference_identity_next RENAME TO reference_identity;
        `);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function readViewCut(database, includeOrders) {
  const state = database.prepare("SELECT frontier FROM view_state WHERE id = 1").get();
  const rows = includeOrders ? [] : null;
  const statement = database.prepare(
    `SELECT position${includeOrders ? ", order_value" : ""} FROM view_orders ORDER BY length(position), position`,
  );
  let expected = 1n;
  let intact = state !== undefined;
  for (const row of statement.iterate()) {
    try {
      if (canonicalPosition(row.position) !== expected) intact = false;
    } catch {
      intact = false;
    }
    if (rows) rows.push(row);
    expected += 1n;
  }
  if (state?.frontier === null) intact &&= expected === 1n;
  else {
    try {
      intact &&= canonicalPosition(state?.frontier) === expected - 1n;
    } catch {
      intact = false;
    }
  }
  return { frontier: intact ? state.frontier : "unknown", rows };
}

function assertSourceLineage(database) {
  let expected = 1n;
  const rows = database.prepare(
    "SELECT position FROM source_orders ORDER BY length(position), position",
  );
  for (const row of rows.iterate()) {
    let actual;
    try {
      actual = canonicalPosition(row.position);
    } catch {
      throw new Error("source lineage requires repair");
    }
    if (actual !== expected) throw new Error("source lineage requires repair");
    expected += 1n;
  }
  const state = database.prepare("SELECT next_position FROM source_state WHERE id = 1").get();
  if (state?.next_position !== expected.toString())
    throw new Error("source lineage requires repair");
}

function latestFailureActions(database, contract, schema) {
  const actions = new Map();
  const rows = database.prepare(
    "SELECT position, contract, schema, action, operator FROM view_failure_events ORDER BY id",
  );
  for (const row of rows.iterate()) {
    canonicalPosition(row.position);
    if (
      row.contract !== contract ||
      row.schema !== schema ||
      (row.action !== "failed" && row.action !== "resolved") ||
      typeof row.operator !== "string" ||
      !row.operator
    )
      throw new Error("view failure history requires repair");
    actions.set(row.position, row.action);
  }
  return actions;
}

export class OrderSourceStore {
  #database;

  constructor(path, identity) {
    this.#database = new DatabaseSync(path, { timeout: 2000 });
    try {
      this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS source_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        next_position TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS source_orders (
        position TEXT PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        order_value TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        evidence TEXT,
        delivered INTEGER NOT NULL DEFAULT 0 CHECK (delivered IN (0, 1))
      );
      INSERT OR IGNORE INTO source_state (id, next_position) VALUES (1, '1');
    `);
      bindIdentity(this.#database, "source", identity);
      assertSourceLineage(this.#database);
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  commit(order, issuedAt, expiresAt, requestKey) {
    if (typeof order !== "string" || !/^[a-z0-9-]{1,80}$/.test(order)) {
      const error = new Error("invalid order");
      error.status = 400;
      throw error;
    }
    if (typeof requestKey !== "string" || !/^[A-Za-z0-9._~-]{1,128}$/.test(requestKey)) {
      const error = new Error("invalid request key");
      error.status = 400;
      throw error;
    }
    if (typeof issuedAt !== "bigint" || typeof expiresAt !== "bigint" || issuedAt >= expiresAt)
      throw new Error("invalid evidence interval");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.#database
        .prepare(
          "SELECT o.event_id AS id, o.position, o.order_value AS `order`, o.issued_at AS issuedAt, o.expires_at AS expiresAt, o.evidence FROM source_requests r JOIN source_orders o ON o.position = r.position WHERE r.request_key = ?",
        )
        .get(requestKey);
      if (prior) {
        if (prior.order !== order) {
          const error = new Error("request key is bound to another order");
          error.status = 409;
          throw error;
        }
        this.#database.exec("COMMIT");
        return { ...prior };
      }
      const state = required(
        this.#database.prepare("SELECT next_position FROM source_state WHERE id = 1").get(),
        "source state",
      );
      const next = canonicalPosition(state.next_position);
      if (next > MAX_POSITION) throw new Error("source domain exhausted");
      const event = {
        id: `urn:uuid:${randomUUID()}`,
        position: next.toString(),
        order,
        issuedAt: issuedAt.toString(),
        expiresAt: expiresAt.toString(),
        evidence: null,
      };
      this.#database
        .prepare(
          "INSERT INTO source_orders (position, event_id, order_value, issued_at, expires_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(event.position, event.id, event.order, event.issuedAt, event.expiresAt);
      this.#database
        .prepare("UPDATE source_state SET next_position = ? WHERE id = 1")
        .run((next + 1n).toString());
      this.#database
        .prepare("INSERT INTO source_requests (request_key, position) VALUES (?, ?)")
        .run(requestKey, event.position);
      this.#database.exec("COMMIT");
      return event;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  unissued(limit = 100) {
    return this.#database
      .prepare(
        "SELECT event_id AS id, position, order_value AS `order`, issued_at AS issuedAt, expires_at AS expiresAt, evidence FROM source_orders WHERE evidence IS NULL ORDER BY length(position), position LIMIT ?",
      )
      .all(limit);
  }

  materialize(id, evidence, issuedAt, expiresAt) {
    if (typeof evidence !== "string" || !evidence) throw new Error("missing evidence");
    if (typeof issuedAt !== "bigint" || typeof expiresAt !== "bigint" || issuedAt >= expiresAt)
      throw new Error("invalid evidence interval");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const event = required(
        this.#database
          .prepare("SELECT evidence, issued_at, expires_at FROM source_orders WHERE event_id = ?")
          .get(id),
        "source event",
      );
      if (
        event.evidence !== null &&
        (event.evidence !== evidence ||
          event.issued_at !== issuedAt.toString() ||
          event.expires_at !== expiresAt.toString())
      )
        throw new Error("conflicting evidence for source event");
      if (event.evidence === null)
        this.#database
          .prepare(
            "UPDATE source_orders SET evidence = ?, issued_at = ?, expires_at = ? WHERE event_id = ? AND evidence IS NULL",
          )
          .run(evidence, issuedAt.toString(), expiresAt.toString(), id);
      this.#database.exec("COMMIT");
      return { evidence, issuedAt: issuedAt.toString(), expiresAt: expiresAt.toString() };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  refresh(id, previousEvidence, evidence, issuedAt, expiresAt, now) {
    if (typeof previousEvidence !== "string" || !previousEvidence)
      throw new Error("missing previous evidence");
    if (typeof evidence !== "string" || !evidence || evidence === previousEvidence)
      throw new Error("missing fresh evidence");
    if (
      typeof issuedAt !== "bigint" ||
      typeof expiresAt !== "bigint" ||
      typeof now !== "bigint" ||
      issuedAt > now ||
      expiresAt <= now
    )
      throw new Error("invalid fresh evidence interval");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const prior = required(
        this.#database
          .prepare("SELECT evidence, expires_at FROM source_orders WHERE event_id = ?")
          .get(id),
        "source event",
      );
      if (prior.evidence !== previousEvidence || BigInt(prior.expires_at) > now)
        throw new Error("source event is not eligible for evidence refresh");
      this.#database
        .prepare(
          "UPDATE source_orders SET evidence = ?, issued_at = ?, expires_at = ? WHERE event_id = ? AND evidence = ?",
        )
        .run(evidence, issuedAt.toString(), expiresAt.toString(), id, previousEvidence);
      this.#database.exec("COMMIT");
      return { evidence, issuedAt: issuedAt.toString(), expiresAt: expiresAt.toString() };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  undelivered(limit = 100) {
    return this.#database
      .prepare(
        "SELECT event_id AS id, position, order_value AS `order`, issued_at AS issuedAt, expires_at AS expiresAt, evidence FROM source_orders WHERE evidence IS NOT NULL AND delivered = 0 ORDER BY length(position), position LIMIT ?",
      )
      .all(limit);
  }

  delivered(id, evidence) {
    const result = this.#database
      .prepare(
        "UPDATE source_orders SET delivered = 1 WHERE event_id = ? AND evidence = ? AND delivered = 0",
      )
      .run(id, evidence);
    if (result.changes === 0) {
      const row = required(
        this.#database
          .prepare("SELECT evidence, delivered FROM source_orders WHERE event_id = ?")
          .get(id),
        "source event",
      );
      if (row.evidence !== evidence || row.delivered !== 1)
        throw new Error("delivery acknowledgement does not match source event");
    }
  }

  close() {
    this.#database.close();
  }
}

export class OrderViewStore {
  #database;
  #faultPoint;
  #contract;
  #schema;

  constructor(
    path,
    identity,
    faultPoint = () => {},
    viewContract = { contract: ORDER_CONTRACT, schema: ORDER_SCHEMA },
  ) {
    if (
      !viewContract ||
      typeof viewContract.contract !== "string" ||
      !viewContract.contract ||
      typeof viewContract.schema !== "string" ||
      !viewContract.schema
    )
      throw new Error("view contract and schema are required");
    this.#faultPoint = faultPoint;
    this.#contract = viewContract.contract;
    this.#schema = viewContract.schema;
    this.#database = new DatabaseSync(path, { timeout: 2000 });
    try {
      this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS view_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        frontier TEXT
      );
      CREATE TABLE IF NOT EXISTS view_orders (
        position TEXT PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        order_value TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        evidence TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS view_pending (
        position TEXT PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        order_value TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        evidence TEXT NOT NULL
      );
      INSERT OR IGNORE INTO view_state (id, frontier) VALUES (1, NULL);
    `);
      bindIdentity(this.#database, "view", identity, viewContract);
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  accept(event) {
    const incoming = canonicalPosition(event.position);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const cut = readViewCut(this.#database, false);
      if (cut.frontier === "unknown") throw new Error("view lineage requires repair");
      const frontier = cut.frontier === null ? null : canonicalPosition(cut.frontier);
      if (frontier !== null && incoming <= frontier) {
        const applied = required(
          this.#database
            .prepare("SELECT * FROM view_orders WHERE position = ?")
            .get(event.position),
          "applied event",
        );
        if (!sameEvent(applied, event)) throw new Error("conflicting applied event");
      } else {
        const pending = this.#database
          .prepare("SELECT * FROM view_pending WHERE position = ?")
          .get(event.position);
        if (pending) {
          if (!sameEvent(pending, event)) throw new Error("conflicting pending event");
        } else {
          this.#database
            .prepare(
              "INSERT INTO view_pending (position, event_id, order_value, issued_at, expires_at, evidence) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .run(
              event.position,
              event.id,
              event.order,
              event.issuedAt,
              event.expiresAt,
              event.evidence,
            );
        }
        let next = frontier === null ? 1n : frontier + 1n;
        while (next <= MAX_POSITION) {
          const item = this.#database
            .prepare("SELECT * FROM view_pending WHERE position = ?")
            .get(next.toString());
          if (!item) break;
          this.#database
            .prepare(
              "INSERT INTO view_orders (position, event_id, order_value, issued_at, expires_at, evidence) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .run(
              item.position,
              item.event_id,
              item.order_value,
              item.issued_at,
              item.expires_at,
              item.evidence,
            );
          this.#database.prepare("DELETE FROM view_pending WHERE position = ?").run(item.position);
          this.#faultPoint("before-frontier");
          this.#database
            .prepare("UPDATE view_state SET frontier = ? WHERE id = 1")
            .run(item.position);
          next += 1n;
        }
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    this.#faultPoint("after-view-commit");
  }

  decideFailure(action, value, operator) {
    const selected = canonicalPosition(value).toString();
    if (
      typeof operator !== "string" ||
      !operator ||
      operator.length > 128 ||
      Array.from(operator).some((character) => character.charCodeAt(0) < 32)
    )
      throw new Error("operator identity is required");
    if (action !== "failed" && action !== "resolved") throw new Error("invalid failure action");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const cut = readViewCut(this.#database, false);
      if (cut.frontier === "unknown") throw new Error("view lineage requires repair");
      const latest = latestFailureActions(this.#database, this.#contract, this.#schema).get(
        selected,
      );
      if (action === "failed") {
        const frontier = cut.frontier === null ? 0n : canonicalPosition(cut.frontier);
        if (BigInt(selected) <= frontier) throw new Error("position is already accounted for");
        if (!this.#database.prepare("SELECT 1 FROM view_pending WHERE position = ?").get(selected))
          throw new Error("failure position has no authenticated pending record");
      } else if (latest !== "failed" && latest !== "resolved") {
        throw new Error("position has no active failure decision");
      }
      if (latest !== action)
        this.#database
          .prepare(
            "INSERT INTO view_failure_events (position, contract, schema, action, operator, recorded_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(selected, this.#contract, this.#schema, action, operator, new Date().toISOString());
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  snapshot() {
    this.#database.exec("BEGIN");
    try {
      const cut = readViewCut(this.#database, true);
      this.#faultPoint("after-view-cut");
      let firstTerminalFailure;
      if (cut.frontier !== "unknown") {
        const frontier = cut.frontier === null ? 0n : canonicalPosition(cut.frontier);
        try {
          for (const [value, action] of latestFailureActions(
            this.#database,
            this.#contract,
            this.#schema,
          )) {
            const failed = BigInt(value);
            if (action !== "failed" || failed <= frontier) continue;
            if (!this.#database.prepare("SELECT 1 FROM view_pending WHERE position = ?").get(value))
              throw new Error("failure record has no pending fact");
            if (firstTerminalFailure === undefined || failed < firstTerminalFailure)
              firstTerminalFailure = failed;
          }
        } catch {
          cut.frontier = "unknown";
          firstTerminalFailure = undefined;
        }
      }
      this.#database.exec("COMMIT");
      return {
        frontier: cut.frontier,
        orders: cut.rows.map((row) => row.order_value),
        ...(firstTerminalFailure === undefined
          ? {}
          : { firstTerminalFailure: firstTerminalFailure.toString() }),
      };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.#database.close();
  }
}
