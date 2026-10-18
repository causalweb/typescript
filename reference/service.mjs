import { createPrivateKey, createPublicKey, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { dirname, resolve } from "node:path";

import {
  handleNodeObservation,
  Issuer,
  PROFILE,
  ProtocolError,
  position,
  Snapshot,
  serializeContext,
  sourceKey,
  Verifier,
} from "@causalweb/protocol";
import { sendDelivery, validDeliveryProof } from "./delivery.mjs";
import { ORDER_CONTRACT, ORDER_SCHEMA, OrderSourceStore, OrderViewStore } from "./order-store.mjs";
import { materializeEvent } from "./source-evidence.mjs";

const MAX_BODY_BYTES = 16_384;

function setting(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function verificationKeys(path) {
  const entries = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 16)
    throw new Error("verification keyring must contain 1 to 16 keys");
  const keys = new Map();
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      Object.keys(entry).length !== 2 ||
      typeof entry.kid !== "string" ||
      !entry.kid ||
      entry.kid.length > 128 ||
      typeof entry.publicKeyFile !== "string" ||
      !entry.publicKeyFile ||
      keys.has(entry.kid)
    )
      throw new Error("invalid verification keyring entry");
    const key = createPublicKey(readFileSync(resolve(dirname(path), entry.publicKeyFile)));
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1")
      throw new Error("verification keys must be P-256");
    keys.set(entry.kid, key);
  }
  return keys;
}

function protectedConfig() {
  const role = setting("CW_ROLE");
  if (role !== "source" && role !== "view") throw new Error("CW_ROLE must be source or view");
  const port = Number(setting("CW_PORT"));
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error("CW_PORT must be a TCP port");
  const issuer = setting("CW_ISSUER");
  const domain = setting("CW_DOMAIN");
  const audience = setting("CW_AUDIENCE");
  const subject = setting("CW_SUBJECT");
  const viewContract = {
    contract: process.env.CW_VIEW_CONTRACT ?? ORDER_CONTRACT,
    schema: process.env.CW_VIEW_SCHEMA ?? ORDER_SCHEMA,
  };
  if (
    role === "view" &&
    (!viewContract.contract ||
      !viewContract.schema ||
      (process.env.CW_VIEW_CONTRACT === undefined) !== (process.env.CW_VIEW_SCHEMA === undefined))
  )
    throw new Error("CW_VIEW_CONTRACT and CW_VIEW_SCHEMA must be configured together");
  const kid = setting("CW_KID");
  const appToken = setting("CW_APP_TOKEN");
  const deliveryToken = setting("CW_DELIVERY_TOKEN");
  if (appToken === deliveryToken)
    throw new Error("application and delivery credentials must differ");
  const database = setting("CW_DATABASE");
  const tls = {
    key: readFileSync(setting("CW_TLS_KEY_FILE")),
    cert: readFileSync(setting("CW_TLS_CERT_FILE")),
  };
  const viewUrl = role === "source" ? new URL(setting("CW_VIEW_URL")) : null;
  if (
    viewUrl &&
    (viewUrl.protocol !== "https:" ||
      viewUrl.pathname !== "/" ||
      viewUrl.username ||
      viewUrl.password ||
      viewUrl.search ||
      viewUrl.hash)
  )
    throw new Error("CW_VIEW_URL must be an HTTPS origin");
  const keys = role === "view" ? verificationKeys(setting("CW_VERIFY_KEYRING_FILE")) : null;
  const key =
    role === "source"
      ? createPrivateKey(readFileSync(setting("CW_SIGNING_KEY_FILE")))
      : keys.get(kid);
  if (!key) throw new Error("CW_KID must name a configured verification key");
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1")
    throw new Error("the signing key must be P-256");
  return {
    role,
    port,
    issuer,
    domain,
    audience,
    subject,
    viewContract,
    kid,
    appToken,
    deliveryToken,
    database,
    tls,
    viewUrl,
    key,
    keys,
  };
}

function credentialMatches(actual, expected) {
  if (typeof actual !== "string" || !actual.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(actual.slice(7));
  const configured = Buffer.from(expected);
  return supplied.length === configured.length && timingSafeEqual(supplied, configured);
}

function response(res, status, body, headers = {}) {
  res.writeHead(status, {
    "cache-control": "no-store",
    ...(body === undefined ? {} : { "content-type": "application/json" }),
    ...headers,
  });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

async function jsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("request body too large");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    const error = new Error("invalid JSON");
    error.status = 400;
    throw error;
  }
}

function validEvent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProtocolError("invalid-evidence");
  const fields = ["id", "position", "order", "issuedAt", "expiresAt", "evidence"];
  if (
    Object.keys(value).length !== fields.length ||
    fields.some((field) => typeof value[field] !== "string")
  )
    throw new ProtocolError("invalid-evidence");
  position(value.position);
  if (!/^urn:uuid:[0-9a-f-]{36}$/.test(value.id) || !/^[a-z0-9-]{1,80}$/.test(value.order))
    throw new ProtocolError("invalid-evidence");
  if (!/^(0|[1-9][0-9]*)$/.test(value.issuedAt) || !/^(0|[1-9][0-9]*)$/.test(value.expiresAt))
    throw new ProtocolError("invalid-evidence");
  return value;
}

const config = protectedConfig();
function testFaultPoint(point) {
  if (process.env.NODE_ENV === "test" && process.env.CW_TEST_FAULT_POINT === point)
    process.kill(process.pid, "SIGKILL");
}
const identity = {
  issuer: config.issuer,
  domain: config.domain,
  audience: config.audience,
  subject: config.subject,
};
const issuer =
  config.role === "source"
    ? new Issuer(config.issuer, config.kid, config.key, new Set([config.domain]), 3600n)
    : null;
const verifier =
  config.role === "view"
    ? new Verifier(config.audience, [
        {
          issuer: config.issuer,
          keys: config.keys,
          domains: new Set([config.domain]),
          maxLifetimeSeconds: 3600n,
          clockSkewSeconds: 30n,
        },
      ])
    : null;
const store =
  config.role === "source"
    ? new OrderSourceStore(config.database, identity)
    : new OrderViewStore(config.database, identity, testFaultPoint, config.viewContract);

function materialize(event) {
  if (!issuer) throw new Error("source issuer is unavailable");
  const now = BigInt(Math.floor(Date.now() / 1000));
  return materializeEvent(
    store,
    event,
    issuer,
    config.subject,
    config.audience,
    config.domain,
    now,
  );
}

function recover() {
  for (const event of store.unissued()) materialize(event);
}

let shuttingDown = false;
const deliveryAbort = new AbortController();
let deliveryJob = null;
let lastDeliveryFailure = null;
function reportDeliveryFailure(reason) {
  if (reason === lastDeliveryFailure) return;
  lastDeliveryFailure = reason;
  process.stderr.write(`delivery retry pending: ${reason}\n`);
}
function deliverPending() {
  if (deliveryJob || shuttingDown || config.role !== "source") return deliveryJob;
  deliveryJob = (async () => {
    try {
      recover();
      for (let event of store.undelivered()) {
        if (shuttingDown) break;
        if (BigInt(event.expiresAt) <= BigInt(Math.floor(Date.now() / 1000)))
          event = materialize(event);
        const status = await sendDelivery(
          event,
          config.viewUrl,
          config.deliveryToken,
          config.kid,
          config.key,
          deliveryAbort.signal,
        );
        if (status !== 204) {
          reportDeliveryFailure(`HTTP ${status}`);
          break;
        }
        store.delivered(event.id, event.evidence);
        lastDeliveryFailure = null;
      }
    } catch (error) {
      if (!shuttingDown) reportDeliveryFailure(error instanceof Error ? error.name : "error");
    }
  })().finally(() => {
    deliveryJob = null;
  });
  return deliveryJob;
}

function snapshot() {
  const state = store.snapshot();
  return new Snapshot(
    "/orders",
    {
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      body: Buffer.from(JSON.stringify({ orders: state.orders })),
    },
    config.viewContract.contract,
    config.viewContract.schema,
    new Map([
      [
        sourceKey(config.issuer, config.domain),
        {
          kind: "relevant",
          frontiers: [
            state.frontier === null || state.frontier === "unknown"
              ? state.frontier
              : BigInt(state.frontier),
          ],
          progressPossible: true,
          ...(state.firstTerminalFailure === undefined
            ? {}
            : { firstTerminalFailure: BigInt(state.firstTerminalFailure) }),
        },
      ],
    ]),
  );
}

const activeRequests = new Set();
const server = createServer(config.tls, (request, res) => {
  const task = (async () => {
    const path = new URL(request.url ?? "/", "https://localhost").pathname;
    if (config.role === "source" && request.method === "POST" && path === "/orders") {
      if (!credentialMatches(request.headers.authorization, config.appToken))
        return response(res, 401);
      const body = await jsonBody(request);
      const now = BigInt(Math.floor(Date.now() / 1000));
      const committed = store.commit(
        body?.order,
        now,
        now + 3600n,
        request.headers["cw-request-key"],
      );
      testFaultPoint("after-source-commit");
      const event =
        committed.evidence === null || BigInt(committed.expiresAt) <= now
          ? materialize(committed)
          : committed;
      response(
        res,
        201,
        { id: event.id, position: event.position, order: event.order },
        {
          "causal-context": serializeContext([event.evidence]),
          "cache-control": "private, no-store",
        },
      );
      void deliverPending();
      return;
    }
    if (config.role === "view" && request.method === "POST" && path === "/deliver") {
      if (!credentialMatches(request.headers.authorization, config.deliveryToken))
        return response(res, 401);
      const body = await jsonBody(request);
      let event;
      let checked;
      try {
        event = validEvent(body?.event);
        if (!validDeliveryProof(event, body?.proof, config.kid, config.key))
          return response(res, 400);
        const now = BigInt(Math.floor(Date.now() / 1000));
        checked = verifier.verify(event.evidence, config.subject, now);
        if (checked.expired(now)) return response(res, 400);
      } catch (error) {
        if (error instanceof ProtocolError && error.code === "invalid-evidence")
          return response(res, 400);
        if (error instanceof ProtocolError && error.code === "too-large") return response(res, 413);
        throw error;
      }
      if (
        checked.profile !== PROFILE ||
        checked.issuer !== config.issuer ||
        checked.domain !== config.domain ||
        checked.position !== event.position ||
        checked.issuedAt.toString() !== event.issuedAt ||
        checked.expiresAt.toString() !== event.expiresAt
      )
        return response(res, 400);
      store.accept(event);
      return response(res, 204);
    }
    if (config.role === "view" && request.method === "GET" && path === "/orders") {
      const authorized = () => credentialMatches(request.headers.authorization, config.appToken);
      if (!authorized()) return response(res, 401);
      const handled = await handleNodeObservation(request, res, {
        target: "/orders",
        designatedObservation: true,
        verifier,
        subject: config.subject,
        authorize: authorized,
        clock: () => BigInt(Math.floor(Date.now() / 1000)),
        read: snapshot,
        onLocalError: (error) =>
          process.stderr.write(`observation error: ${error.code} ${error.phase}\n`),
      });
      if (handled) return;
      const state = snapshot().representation;
      res.writeHead(state.status, Object.fromEntries(state.headers));
      res.end(state.body);
      return;
    }
    response(res, 404);
  })().catch((error) => {
    process.stderr.write(`request error: ${error instanceof Error ? error.name : "error"}\n`);
    if (!res.headersSent)
      response(res, [400, 409, 413].includes(error?.status) ? error.status : 500);
    else res.destroy();
  });
  activeRequests.add(task);
  void task.finally(() => activeRequests.delete(task));
});
server.requestTimeout = 10_000;
server.headersTimeout = 10_000;
server.maxHeadersCount = 64;
const timer = config.role === "source" ? setInterval(() => void deliverPending(), 1000) : null;
server.listen(config.port, "127.0.0.1", () => {
  process.stdout.write(`https://127.0.0.1:${config.port}\n`);
  if (config.role === "source") void deliverPending();
});
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (timer) clearInterval(timer);
  deliveryAbort.abort();
  const deadline = setTimeout(() => server.closeAllConnections(), 10_000);
  try {
    await new Promise((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose())),
    );
    await Promise.allSettled([...activeRequests]);
    if (deliveryJob) await deliveryJob;
  } finally {
    clearTimeout(deadline);
    store.close();
  }
}
process.on("SIGTERM", () => {
  void shutdown().catch((error) => {
    process.stderr.write(`shutdown error: ${error instanceof Error ? error.name : "error"}\n`);
    process.exitCode = 1;
  });
});
