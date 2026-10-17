import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { Issuer, serializeContext } from "../dist/src/index.js";

const ISSUER = "https://typescript-orders.example";
const KID = "typescript-persistent-demo";
const SUBJECT = "tenant-example";
const AUDIENCE = "https://orders-view.example/causal";
const DOMAIN = "https://typescript-orders.example/domains/orders";
const LIFETIME = 3600n;

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`${name} is required`);
  return process.argv[index + 1];
}

const statePath = argument("--state");
const now = BigInt(argument("--now"));
const bind = argument("--listen");
const privateJwk = JSON.parse(process.env.CAUSALWEB_DEMO_PRIVATE_JWK ?? "");
const key = createPrivateKey({ key: privateJwk, format: "jwk" });
const issuer = new Issuer(ISSUER, KID, key, new Set([DOMAIN]), LIFETIME);

function deliveryProof(event) {
  const header = Buffer.from(
    JSON.stringify({ alg: "ES256", kid: KID, typ: "causalweb-demo-delivery+jwt" }),
  ).toString("base64url");
  const payload = Buffer.from(JSON.stringify(event)).toString("base64url");
  const input = `${header}.${payload}`;
  return `${input}.${sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

function delivery(event) {
  return { ...event, deliveryProof: deliveryProof(event) };
}

function initial() {
  return { nextPosition: "1", events: [] };
}

function load() {
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    if (
      !state ||
      typeof state.nextPosition !== "string" ||
      !Array.isArray(state.events) ||
      state.events.some(
        (event) =>
          !event ||
          typeof event.id !== "string" ||
          typeof event.position !== "string" ||
          typeof event.order !== "string" ||
          typeof event.issuedAt !== "string" ||
          typeof event.expiresAt !== "string" ||
          typeof event.evidence !== "string",
      )
    )
      throw new Error("invalid source state");
    return state;
  } catch (error) {
    if (error?.code === "ENOENT") return initial();
    throw error;
  }
}

function replace(state) {
  mkdirSync(dirname(statePath), { recursive: true });
  const temporary = `${statePath}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(state));
  renameSync(temporary, statePath);
}

function evidenceFor(event) {
  return {
    ...event,
    evidence: issuer.issueCommitted(
      {
        subject: SUBJECT,
        audiences: [AUDIENCE],
        domain: DOMAIN,
        position: BigInt(event.position),
        issuedAt: BigInt(event.issuedAt),
        expiresAt: BigInt(event.expiresAt),
        evidenceId: event.id,
      },
      now,
    ),
  };
}

function commit(order, { interruptAfterCommit, crashAfterCommit }) {
  if (!/^[a-z0-9-]+$/.test(order)) throw new Error("invalid order");
  const state = load();
  const position = BigInt(state.nextPosition);
  const event = {
    id: `urn:uuid:${randomUUID()}`,
    position: position.toString(),
    order,
    issuedAt: now.toString(),
    expiresAt: (now + LIFETIME).toString(),
    evidence: "",
  };
  replace({ nextPosition: (position + 1n).toString(), events: [...state.events, event] });
  if (crashAfterCommit) process.exit(86);
  if (interruptAfterCommit) throw new Error("injected interruption after durable source commit");
  const issued = evidenceFor(event);
  const recovered = load();
  if (recovered.events.at(-1)?.id !== event.id)
    throw new Error("source fact changed before issuance");
  replace({ ...recovered, events: [...recovered.events.slice(0, -1), issued] });
  return issued;
}

function recover() {
  const state = load();
  const events = state.events.map((event) => (event.evidence ? event : evidenceFor(event)));
  if (events.some((event, index) => event !== state.events[index])) replace({ ...state, events });
  return events;
}

function respond(response, status, body, headers = {}) {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(body ? JSON.stringify(body) : undefined);
}

const server = createServer((request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "POST" && url.pathname === "/shutdown") {
      respond(response, 204);
      server.close();
      return;
    }
    if (request.method === "POST" && url.pathname === "/recover") {
      respond(response, 200, recover().map(delivery));
      return;
    }
    const order = url.pathname.match(/^\/orders\/([a-z0-9-]+)$/)?.[1];
    if (request.method === "POST" && order) {
      const event = commit(order, {
        interruptAfterCommit: url.searchParams.has("interrupt-after-commit"),
        crashAfterCommit: url.searchParams.has("crash-after-commit"),
      });
      respond(response, 201, delivery(event), {
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
