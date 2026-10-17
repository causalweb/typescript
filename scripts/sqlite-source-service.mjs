// Test-only SQLite source service for the cross-runtime transaction experiment.
// It is not a package API, delivery protocol, or production storage adapter.

import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";

import { Issuer, serializeContext } from "../dist/src/index.js";

const ISSUER = "https://typescript-sqlite-orders.example";
const KID = "typescript-sqlite-demo";
const SUBJECT = "tenant-example";
const AUDIENCE = "https://orders-view.example/causal";
const DOMAIN = "https://typescript-sqlite-orders.example/domains/orders";
const LIFETIME = 3600n;

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`${name} is required`);
  return process.argv[index + 1];
}

const databasePath = argument("--database");
const now = BigInt(argument("--now"));
const bind = argument("--listen");
const privateJwk = JSON.parse(process.env.CAUSALWEB_DEMO_PRIVATE_JWK ?? "");
const key = createPrivateKey({ key: privateJwk, format: "jwk" });
const issuer = new Issuer(ISSUER, KID, key, new Set([DOMAIN]), LIFETIME);
const database = new DatabaseSync(databasePath);

database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = FULL;
  CREATE TABLE IF NOT EXISTS source_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    next_position INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS source_facts (
    position INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    order_value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS source_outbox (
    position INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    order_value TEXT NOT NULL,
    issued_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    evidence TEXT
  );
  INSERT OR IGNORE INTO source_state (id, next_position) VALUES (1, 1);
`);

function row(value, description) {
  if (!value) throw new Error(`missing ${description}`);
  return value;
}

function deliveryProof(event) {
  const header = Buffer.from(
    JSON.stringify({ alg: "ES256", kid: KID, typ: "causalweb-demo-delivery+jwt" }),
  ).toString("base64url");
  const payload = Buffer.from(JSON.stringify(event)).toString("base64url");
  const input = `${header}.${payload}`;
  return `${input}.${sign("sha256", Buffer.from(input), {
    key,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url")}`;
}

function publicEvent(sourceEvent) {
  if (typeof sourceEvent.evidence !== "string")
    throw new Error("outbox evidence is not materialized");
  const event = {
    id: sourceEvent.id,
    position: String(sourceEvent.position),
    order: sourceEvent.order_value,
    issuedAt: String(sourceEvent.issued_at),
    expiresAt: String(sourceEvent.expires_at),
    evidence: sourceEvent.evidence,
  };
  return { ...event, deliveryProof: deliveryProof(event) };
}

function materialize(sourceEvent) {
  if (typeof sourceEvent.evidence === "string") return sourceEvent;
  const evidence = issuer.issueCommitted(
    {
      subject: SUBJECT,
      audiences: [AUDIENCE],
      domain: DOMAIN,
      position: BigInt(sourceEvent.position),
      issuedAt: BigInt(sourceEvent.issued_at),
      expiresAt: BigInt(sourceEvent.expires_at),
      evidenceId: sourceEvent.id,
    },
    now,
  );
  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare(
        "UPDATE source_outbox SET evidence = ? WHERE position = ? AND id = ? AND evidence IS NULL",
      )
      .run(evidence, sourceEvent.position, sourceEvent.id);
    const updated = row(
      database
        .prepare(
          "SELECT position, id, order_value, issued_at, expires_at, evidence FROM source_outbox WHERE position = ?",
        )
        .get(sourceEvent.position),
      "materialized outbox event",
    );
    if (updated.id !== sourceEvent.id || typeof updated.evidence !== "string")
      throw new Error("outbox changed during evidence materialization");
    database.exec("COMMIT");
    return updated;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function commit(order) {
  if (!/^[a-z0-9-]+$/.test(order)) throw new Error("invalid order");
  database.exec("BEGIN IMMEDIATE");
  let sourceEvent;
  try {
    const state = row(
      database.prepare("SELECT next_position FROM source_state WHERE id = 1").get(),
      "source state",
    );
    const position = state.next_position;
    sourceEvent = {
      position,
      id: `urn:uuid:${randomUUID()}`,
      order_value: order,
      issued_at: Number(now),
      expires_at: Number(now + LIFETIME),
      evidence: null,
    };
    database
      .prepare("INSERT INTO source_facts (position, id, order_value) VALUES (?, ?, ?)")
      .run(position, sourceEvent.id, order);
    database
      .prepare(
        "INSERT INTO source_outbox (position, id, order_value, issued_at, expires_at, evidence) VALUES (?, ?, ?, ?, ?, NULL)",
      )
      .run(position, sourceEvent.id, order, sourceEvent.issued_at, sourceEvent.expires_at);
    database.prepare("UPDATE source_state SET next_position = ? WHERE id = 1").run(position + 1);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return sourceEvent;
}

function recover() {
  const events = database
    .prepare(
      "SELECT position, id, order_value, issued_at, expires_at, evidence FROM source_outbox ORDER BY position",
    )
    .all();
  return events.map((event) => publicEvent(materialize(event)));
}

function respond(response, status, body, headers = {}) {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(body === undefined ? undefined : JSON.stringify(body));
}

const server = createServer((request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "POST" && url.pathname === "/shutdown") {
      respond(response, 204);
      server.close(() => database.close());
      return;
    }
    if (request.method === "POST" && url.pathname === "/recover") {
      respond(response, 200, recover());
      return;
    }
    const order = url.pathname.match(/^\/orders\/([a-z0-9-]+)$/)?.[1];
    if (request.method === "POST" && order) {
      const sourceEvent = commit(order);
      if (url.searchParams.has("crash-after-commit")) process.exit(86);
      if (url.searchParams.has("interrupt-after-commit"))
        throw new Error("injected interruption after durable source commit");
      const event = publicEvent(materialize(sourceEvent));
      respond(response, 201, event, {
        "causal-context": serializeContext([event.evidence]),
        "cache-control": "private, no-store",
      });
      return;
    }
    respond(response, 404, {});
  } catch (error) {
    respond(response, 500, { error: error instanceof Error ? error.message : "source failure" });
  }
});

server.listen(bind, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected listener address");
  process.stdout.write(`http://127.0.0.1:${address.port}\n`);
});
