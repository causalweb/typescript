// Test-only SQLite observer for the cross-process transaction experiment.
// It is not a package API, delivery protocol, or production storage adapter.

import { createPublicKey, verify } from "node:crypto";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";

import { handleNodeObservation, Snapshot, sourceKey, Verifier } from "../dist/src/index.js";

const ISSUER = "https://typescript-sqlite-orders.example";
const KID = "typescript-sqlite-demo";
const SUBJECT = "tenant-example";
const AUDIENCE = "https://orders-view.example/causal";
const DOMAIN = "https://typescript-sqlite-orders.example/domains/orders";
const TARGET = "/orders";
const MAX_DELIVERY_BYTES = 16_384;

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`${name} is required`);
  return process.argv[index + 1];
}

const databasePath = argument("--database");
const now = BigInt(argument("--now"));
const bind = argument("--listen");
const publicJwk = JSON.parse(process.env.CAUSALWEB_DEMO_PUBLIC_JWK ?? "");
const credential = process.env.CAUSALWEB_DEMO_DELIVERY_CREDENTIAL;
if (typeof credential !== "string" || !credential)
  throw new Error("delivery credential is required");
const key = createPublicKey({ key: publicJwk, format: "jwk" });
const verifier = new Verifier(AUDIENCE, [
  {
    issuer: ISSUER,
    keys: new Map([[KID, key]]),
    domains: new Set([DOMAIN]),
    maxLifetimeSeconds: 3600n,
    clockSkewSeconds: 0n,
  },
]);
const database = new DatabaseSync(databasePath);

database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = FULL;
  CREATE TABLE IF NOT EXISTS projection_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    frontier INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS projection_orders (
    position INTEGER PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    order_value TEXT NOT NULL,
    evidence TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS projection_pending (
    position INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    order_value TEXT NOT NULL,
    issued_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    evidence TEXT NOT NULL
  );
  INSERT OR IGNORE INTO projection_state (id, frontier) VALUES (1, 0);
`);

function row(value, description) {
  if (!value) throw new Error(`missing ${description}`);
  return value;
}

function event(value) {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.id !== "string" ||
    typeof value.position !== "string" ||
    typeof value.order !== "string" ||
    typeof value.issuedAt !== "string" ||
    typeof value.expiresAt !== "string" ||
    typeof value.evidence !== "string"
  )
    throw new Error("invalid delivery event");
  return value;
}

function decimal(value, description) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))
    throw new Error(`invalid ${description}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`unsupported ${description}`);
  return parsed;
}

function proofValid(deliveryEvent, proof) {
  if (typeof proof !== "string") return false;
  const [header, payload, signature, extra] = proof.split(".");
  if (!header || !payload || !signature || extra !== undefined) return false;
  try {
    const protectedHeader = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
    if (
      protectedHeader?.alg !== "ES256" ||
      protectedHeader?.kid !== KID ||
      protectedHeader?.typ !== "causalweb-demo-delivery+jwt" ||
      !isDeepStrictEqual(
        JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
        deliveryEvent,
      )
    )
      return false;
    return verify(
      "sha256",
      Buffer.from(`${header}.${payload}`),
      { key, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}

async function body(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_DELIVERY_BYTES) throw new Error("delivery too large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function equalStored(stored, delivered) {
  return (
    stored.event_id === delivered.id &&
    stored.order_value === delivered.order &&
    stored.evidence === delivered.evidence
  );
}

function drain(frontier) {
  let next = frontier + 1;
  while (true) {
    const pending = database
      .prepare(
        "SELECT position, id, order_value, issued_at, expires_at, evidence FROM projection_pending WHERE position = ?",
      )
      .get(next);
    if (!pending) return next - 1;
    database.prepare("DELETE FROM projection_pending WHERE position = ?").run(next);
    database
      .prepare(
        "INSERT INTO projection_orders (position, event_id, order_value, evidence) VALUES (?, ?, ?, ?)",
      )
      .run(pending.position, pending.id, pending.order_value, pending.evidence);
    database.prepare("UPDATE projection_state SET frontier = ? WHERE id = 1").run(next);
    next += 1;
  }
}

function deliver(deliveryEvent) {
  const evidence = verifier.verify(deliveryEvent.evidence, SUBJECT, now);
  const position = decimal(evidence.position, "verified position");
  const issuedAt = decimal(deliveryEvent.issuedAt, "delivery issued-at");
  const expiresAt = decimal(deliveryEvent.expiresAt, "delivery expires-at");
  if (position < 1 || evidence.domain !== DOMAIN) throw new Error("invalid verified position");
  if (
    deliveryEvent.position !== evidence.position ||
    deliveryEvent.expiresAt !== evidence.expiresAt.toString()
  )
    throw new Error("delivery does not match evidence");
  database.exec("BEGIN IMMEDIATE");
  try {
    const state = row(
      database.prepare("SELECT frontier FROM projection_state WHERE id = 1").get(),
      "projection state",
    );
    if (position <= state.frontier) {
      const applied = row(
        database
          .prepare(
            "SELECT event_id, order_value, evidence FROM projection_orders WHERE position = ?",
          )
          .get(position),
        "applied delivery",
      );
      if (!equalStored(applied, deliveryEvent)) throw new Error("conflicting covered delivery");
      database.exec("COMMIT");
      return;
    }
    const pending = database
      .prepare("SELECT id, order_value, evidence FROM projection_pending WHERE position = ?")
      .get(position);
    if (pending) {
      if (!equalStored({ event_id: pending.id, ...pending }, deliveryEvent))
        throw new Error("conflicting pending delivery");
    } else {
      database
        .prepare(
          "INSERT INTO projection_pending (position, id, order_value, issued_at, expires_at, evidence) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          position,
          deliveryEvent.id,
          deliveryEvent.order,
          issuedAt,
          expiresAt,
          deliveryEvent.evidence,
        );
    }
    drain(state.frontier);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function snapshot() {
  database.exec("BEGIN");
  try {
    const state = row(
      database.prepare("SELECT frontier FROM projection_state WHERE id = 1").get(),
      "projection state",
    );
    const orders = database
      .prepare("SELECT order_value FROM projection_orders ORDER BY position")
      .all();
    const representation = {
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      body: Buffer.from(
        JSON.stringify({
          orders: orders.map((entry) => entry.order_value),
          frontier: String(state.frontier),
        }),
      ),
    };
    database.exec("COMMIT");
    return new Snapshot(
      TARGET,
      representation,
      "sqlite-cross-process/v1",
      "orders/v1",
      new Map([
        [
          sourceKey(ISSUER, DOMAIN),
          { kind: "relevant", frontiers: [BigInt(state.frontier)], progressPossible: true },
        ],
      ]),
    );
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function respond(response, status, body) {
  response.writeHead(
    status,
    body === undefined ? undefined : { "content-type": "application/json" },
  );
  response.end(body === undefined ? undefined : JSON.stringify(body));
}

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "POST" && url.pathname === "/shutdown") {
      respond(response, 204);
      server.close(() => database.close());
      return;
    }
    if (request.method === "POST" && url.pathname === "/deliver") {
      if (request.headers.authorization !== `Bearer ${credential}`) {
        respond(response, 401);
        return;
      }
      try {
        const delivery = JSON.parse(await body(request));
        const deliveryEvent = event(delivery?.event);
        if (!proofValid(deliveryEvent, delivery?.proof)) throw new Error("invalid delivery proof");
        deliver(deliveryEvent);
        if (url.searchParams.has("crash-after-apply")) process.exit(87);
        respond(response, 204);
      } catch {
        respond(response, 400);
      }
      return;
    }
    if (url.pathname === TARGET) {
      const handled = await handleNodeObservation(request, response, {
        target: TARGET,
        designatedObservation: true,
        verifier,
        subject: SUBJECT,
        authorize: () => true,
        clock: () => now,
        read: snapshot,
      });
      if (handled) return;
      if (request.method !== "GET") {
        respond(response, 405);
        return;
      }
      const ordinary = snapshot().representation;
      response.writeHead(ordinary.status, Object.fromEntries(ordinary.headers));
      response.end(ordinary.body);
      return;
    }
    respond(response, 404, {});
  })().catch(() => {
    if (!response.headersSent) respond(response, 500);
  });
});

server.listen(bind, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected listener address");
  process.stdout.write(`http://127.0.0.1:${address.port}\n`);
});
