import assert from "node:assert/strict";
import { generateKeyPairSync, type KeyObject, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  acceptConfirmation,
  Issuer,
  ObservationError,
  observe,
  type Representation,
  requestHeaders,
  Snapshot,
  sourceKey,
  Verifier,
} from "../src/index.js";

const ISSUER = "https://orders.example";
const DOMAIN = "https://orders.example/domains/orders";
const VIEW_AUDIENCE = "https://orders-view.example/causal";
const SUBJECT = "tenant-example";
const TARGET = "/orders";
const CLOCK = 100n;

type SourceEvent = Readonly<{
  id: string;
  position: bigint;
  order: string;
  evidence: string;
}>;
type SourceRow = Readonly<{ id: string; position: number; order_value: string; evidence: string }>;
type PendingRow = SourceRow;

function sourceEvent(row: SourceRow): SourceEvent {
  return {
    id: row.id,
    position: BigInt(row.position),
    order: row.order_value,
    evidence: row.evidence,
  };
}

function row<T>(value: unknown, description: string): T {
  assert.ok(value !== undefined, `missing ${description}`);
  return value as T;
}

/**
 * Test-only SQLite source. The source fact and outbox evidence share one database transaction.
 * It deliberately returns evidence only after COMMIT succeeds.
 */
class SqliteSource {
  readonly #database: DatabaseSync;
  readonly #issuer: Issuer;

  constructor(path: string, key: KeyObject) {
    this.#database = new DatabaseSync(path);
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS source_state (id INTEGER PRIMARY KEY CHECK (id = 1), next_position INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS source_outbox (
        position INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        order_value TEXT NOT NULL,
        evidence TEXT NOT NULL
      );
      INSERT OR IGNORE INTO source_state (id, next_position) VALUES (1, 1);
    `);
    this.#issuer = new Issuer(ISSUER, "sqlite-demo", key, new Set([DOMAIN]), 3600n);
  }

  commit(order: string, interruptBeforeCommit = false): SourceEvent {
    assert.match(order, /^[a-z0-9-]+$/);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const state = row<{ next_position: number }>(
        this.#database.prepare("SELECT next_position FROM source_state WHERE id = 1").get(),
        "source state",
      );
      const position = BigInt(state.next_position);
      const id = `urn:uuid:${randomUUID()}`;
      const evidence = this.#issuer.issueCommitted(
        {
          subject: SUBJECT,
          audiences: [VIEW_AUDIENCE],
          domain: DOMAIN,
          position,
          issuedAt: CLOCK,
          expiresAt: CLOCK + 3600n,
          evidenceId: id,
        },
        CLOCK,
      );
      this.#database
        .prepare(
          "INSERT INTO source_outbox (position, id, order_value, evidence) VALUES (?, ?, ?, ?)",
        )
        .run(Number(position), id, order, evidence);
      this.#database
        .prepare("UPDATE source_state SET next_position = ? WHERE id = 1")
        .run(Number(position + 1n));
      if (interruptBeforeCommit) throw new Error("injected interruption before source commit");
      this.#database.exec("COMMIT");
      return { id, position, order, evidence };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  events(): readonly SourceEvent[] {
    return (
      this.#database
        .prepare("SELECT id, position, order_value, evidence FROM source_outbox ORDER BY position")
        .all() as SourceRow[]
    ).map(sourceEvent);
  }

  close(): void {
    this.#database.close();
  }
}

/**
 * Test-only SQLite projection. The body inputs and source frontier are selected in one read transaction.
 */
class SqliteProjection {
  readonly #database: DatabaseSync;
  readonly #verifier: Verifier;

  constructor(path: string, key: KeyObject) {
    this.#database = new DatabaseSync(path);
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS projection_state (id INTEGER PRIMARY KEY CHECK (id = 1), frontier INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS projection_orders (position INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, order_value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projection_pending (
        position INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        order_value TEXT NOT NULL,
        evidence TEXT NOT NULL
      );
      INSERT OR IGNORE INTO projection_state (id, frontier) VALUES (1, 0);
    `);
    this.#verifier = new Verifier(VIEW_AUDIENCE, [
      {
        issuer: ISSUER,
        keys: new Map([["sqlite-demo", key]]),
        domains: new Set([DOMAIN]),
        maxLifetimeSeconds: 3600n,
        clockSkewSeconds: 0n,
      },
    ]);
  }

  deliver(event: SourceEvent): void {
    const evidence = this.#verifier.verify(event.evidence, SUBJECT, CLOCK);
    assert.equal(evidence.domain, DOMAIN);
    assert.equal(BigInt(evidence.position), event.position);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const state = row<{ frontier: number }>(
        this.#database.prepare("SELECT frontier FROM projection_state WHERE id = 1").get(),
        "projection state",
      );
      const frontier = BigInt(state.frontier);
      if (event.position <= frontier) {
        const applied = row<{ event_id: string }>(
          this.#database
            .prepare("SELECT event_id FROM projection_orders WHERE position = ?")
            .get(Number(event.position)),
          "already-applied event",
        );
        assert.equal(applied.event_id, event.id, "position collision after projection commit");
        this.#database.exec("COMMIT");
        return;
      }
      this.#database
        .prepare(
          "INSERT INTO projection_pending (position, id, order_value, evidence) VALUES (?, ?, ?, ?)",
        )
        .run(Number(event.position), event.id, event.order, event.evidence);
      let next = frontier + 1n;
      while (true) {
        const pending = this.#database
          .prepare(
            "SELECT id, position, order_value, evidence FROM projection_pending WHERE position = ?",
          )
          .get(Number(next)) as PendingRow | undefined;
        if (!pending) break;
        this.#database
          .prepare("DELETE FROM projection_pending WHERE position = ?")
          .run(Number(next));
        this.#database
          .prepare(
            "INSERT INTO projection_orders (position, event_id, order_value) VALUES (?, ?, ?)",
          )
          .run(pending.position, pending.id, pending.order_value);
        this.#database
          .prepare("UPDATE projection_state SET frontier = ? WHERE id = 1")
          .run(Number(next));
        next += 1n;
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  snapshot(): Snapshot<Representation> {
    this.#database.exec("BEGIN");
    try {
      const state = row<{ frontier: number }>(
        this.#database.prepare("SELECT frontier FROM projection_state WHERE id = 1").get(),
        "projection state",
      );
      const orders = this.#database
        .prepare("SELECT order_value FROM projection_orders ORDER BY position")
        .all() as unknown as readonly { order_value: string }[];
      const body = Buffer.from(
        JSON.stringify({
          orders: orders.map(({ order_value }) => order_value),
          frontier: String(state.frontier),
        }),
      );
      this.#database.exec("COMMIT");
      return new Snapshot(
        TARGET,
        { status: 200, headers: new Headers({ "Content-Type": "application/json" }), body },
        "sqlite-transaction/v1",
        "orders/v1",
        new Map([
          [
            sourceKey(ISSUER, DOMAIN),
            { kind: "relevant", frontiers: [BigInt(state.frontier)], progressPossible: true },
          ],
        ]),
      );
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  constrainedObservation(request: Pick<Request, "method" | "headers">): Promise<Response> {
    return observe({
      request,
      target: TARGET,
      designatedObservation: true,
      verifier: this.#verifier,
      subject: SUBJECT,
      authorize: () => true,
      clock: () => CLOCK,
      read: () => this.snapshot(),
    }).catch((error: unknown) => {
      if (error instanceof ObservationError) return error.toResponse();
      throw error;
    });
  }

  frontier(): bigint {
    return BigInt(
      row<{ frontier: number }>(
        this.#database.prepare("SELECT frontier FROM projection_state WHERE id = 1").get(),
        "projection state",
      ).frontier,
    );
  }

  close(): void {
    this.#database.close();
  }
}

function requestFor(evidence: string): Request {
  return new Request(`https://orders-view.example${TARGET}`, {
    headers: requestHeaders([evidence]),
  });
}

test("SQLite source and projection preserve transactional causal cuts across restart", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "causalweb-sqlite-demo-"));
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  let source = new SqliteSource(join(root, "source.db"), privateKey);
  let projection = new SqliteProjection(join(root, "projection.db"), publicKey);
  context.after(async () => {
    source.close();
    projection.close();
    assert.equal(resolve(root, ".."), resolve(tmpdir()));
    assert.ok(root.startsWith(join(resolve(tmpdir()), "causalweb-sqlite-demo-")));
    await rm(root, { recursive: true, force: true });
  });

  await assert.rejects(
    async () => source.commit("rolled-back", true),
    /injected interruption before source commit/,
  );
  assert.equal(source.events().length, 0, "a rolled-back source operation leaked into the outbox");

  const first = source.commit("first");
  const stale = await projection.constrainedObservation(requestFor(first.evidence));
  assert.equal(stale.status, 412, await stale.text());
  projection.deliver(first);
  const confirmed = await projection.constrainedObservation(requestFor(first.evidence));
  acceptConfirmation(confirmed, true);
  assert.deepEqual(await confirmed.json(), { orders: ["first"], frontier: "1" });

  const second = source.commit("second");
  const third = source.commit("third");
  projection.deliver(third);
  const delayed = await projection.constrainedObservation(requestFor(third.evidence));
  assert.equal(delayed.status, 412, "a pending event advanced the observation frontier");
  projection.deliver(second);
  const covered = await projection.constrainedObservation(requestFor(third.evidence));
  acceptConfirmation(covered, true);
  assert.deepEqual(await covered.json(), { orders: ["first", "second", "third"], frontier: "3" });

  const beforeDuplicate = projection.snapshot();
  projection.deliver(third);
  assert.deepEqual(projection.snapshot().representation.body, beforeDuplicate.representation.body);
  const last = third.evidence.at(-1);
  assert.ok(last);
  assert.throws(() =>
    projection.deliver({
      ...third,
      evidence: `${third.evidence.slice(0, -1)}${last === "A" ? "B" : "A"}`,
    }),
  );
  assert.equal(projection.frontier(), 3n);

  source.close();
  projection.close();
  source = new SqliteSource(join(root, "source.db"), privateKey);
  projection = new SqliteProjection(join(root, "projection.db"), publicKey);
  assert.equal(source.events().length, 3, "source restart lost committed events");
  const afterRestart = await projection.constrainedObservation(requestFor(third.evidence));
  acceptConfirmation(afterRestart, true);
  assert.deepEqual(await afterRestart.json(), {
    orders: ["first", "second", "third"],
    frontier: "3",
  });
});
