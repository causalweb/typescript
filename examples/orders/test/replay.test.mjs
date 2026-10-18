import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Issuer, requestHeaders } from "@causalweb/sdk";
import { test } from "vitest";
import { OrderSourceStore, OrderViewStore } from "../src/order-store.mjs";

const IDENTITY = {
  issuer: "https://orders.example",
  domain: "https://orders.example/domains/orders",
  audience: "https://view.example/causal",
  subject: "tenant-a",
};
const CONTRACT = { contract: "reference-orders/test-replay", schema: "orders/test-replay" };

async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise((done) => server.close(done));
  return address.port;
}

async function startView(settings, port) {
  const child = spawn(process.execPath, ["examples/orders/src/service.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, ...settings, CW_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((ready, reject) => {
    let output = "";
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`view exited before ready: ${code}`)));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes(`https://127.0.0.1:${port}\n`)) ready();
    });
  });
  return child;
}

async function stopView(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const stopped = new Promise((done) => child.once("exit", done));
  child.kill("SIGTERM");
  await stopped;
}

async function observe(port, certificate, evidence, token) {
  return new Promise((done, reject) => {
    const request = httpsRequest(
      `https://127.0.0.1:${port}/orders`,
      {
        ca: certificate,
        headers: {
          ...Object.fromEntries(requestHeaders([evidence])),
          authorization: `Bearer ${token}`,
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.once("error", reject);
        response.once("end", () =>
          done({
            status: response.statusCode,
            result: response.headers["causal-result"],
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.once("error", reject);
    request.end();
  });
}

test("operator replays acknowledged source history to a new contract-bound view", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "causalweb-reference-replay-"));
  assert.equal(resolve(directory, ".."), resolve(tmpdir()));
  const sourcePath = join(directory, "source.sqlite");
  const viewPath = join(directory, "view.sqlite");
  const signingKey = join(directory, "signing.pem");
  const verificationKey = join(directory, "verification.pem");
  const keyring = join(directory, "keyring.json");
  const tlsKey = resolve("test/fixtures/localhost-key.pem");
  const tlsCertificate = resolve("test/fixtures/localhost-cert.pem");
  const certificate = await readFile(tlsCertificate);
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  await writeFile(signingKey, privateKey.export({ format: "pem", type: "pkcs8" }));
  await writeFile(verificationKey, publicKey.export({ format: "pem", type: "spki" }));
  await writeFile(keyring, JSON.stringify([{ kid: "key-1", publicKeyFile: "verification.pem" }]));
  const now = BigInt(Math.floor(Date.now() / 1000));
  const issuer = new Issuer(
    IDENTITY.issuer,
    "key-1",
    privateKey,
    new Set([IDENTITY.domain]),
    3600n,
  );
  const source = new OrderSourceStore(sourcePath, IDENTITY);
  const first = source.commit("first", now, now + 3600n, "first");
  const second = source.commit("second", now - 7200n, now - 3600n, "second");
  const signEvent = (event, issuedAt, expiresAt) =>
    issuer.issueCommitted(
      {
        subject: IDENTITY.subject,
        audiences: [IDENTITY.audience],
        domain: IDENTITY.domain,
        position: BigInt(event.position),
        issuedAt,
        expiresAt,
        evidenceId: event.id,
      },
      issuedAt,
    );
  const firstEvidence = signEvent(first, now, now + 3600n);
  const expiredEvidence = signEvent(second, now - 7200n, now - 3600n);
  source.materialize(first.id, firstEvidence, now, now + 3600n);
  source.materialize(second.id, expiredEvidence, now - 7200n, now - 3600n);
  source.delivered(first.id, firstEvidence);
  source.delivered(second.id, expiredEvidence);
  source.close();

  const port = await freePort();
  const settings = {
    CW_ROLE: "view",
    CW_DATABASE: viewPath,
    CW_ISSUER: IDENTITY.issuer,
    CW_DOMAIN: IDENTITY.domain,
    CW_AUDIENCE: IDENTITY.audience,
    CW_SUBJECT: IDENTITY.subject,
    CW_VIEW_CONTRACT: CONTRACT.contract,
    CW_VIEW_SCHEMA: CONTRACT.schema,
    CW_KID: "key-1",
    CW_APP_TOKEN: "application-secret",
    CW_DELIVERY_TOKEN: "delivery-secret",
    CW_TLS_KEY_FILE: tlsKey,
    CW_TLS_CERT_FILE: tlsCertificate,
    CW_VERIFY_KEYRING_FILE: keyring,
  };
  const child = await startView(settings, port);
  context.onTestFinished(async () => {
    await stopView(child);
    await rm(directory, { recursive: true });
  });
  assert.equal(
    (await observe(port, certificate, firstEvidence, settings.CW_APP_TOKEN)).status,
    412,
  );

  const replaySettings = {
    CW_ROLE: "source",
    CW_DATABASE: sourcePath,
    CW_ISSUER: IDENTITY.issuer,
    CW_DOMAIN: IDENTITY.domain,
    CW_AUDIENCE: IDENTITY.audience,
    CW_SUBJECT: IDENTITY.subject,
    CW_KID: "key-1",
    CW_SIGNING_KEY_FILE: signingKey,
    CW_DELIVERY_TOKEN: settings.CW_DELIVERY_TOKEN,
    CW_VIEW_URL: `https://127.0.0.1:${port}`,
    NODE_EXTRA_CA_CERTS: tlsCertificate,
  };
  const runReplay = (overrides = {}) =>
    execFileSync(process.execPath, ["examples/orders/bin/replay.mjs"], {
      cwd: process.cwd(),
      env: { ...process.env, ...replaySettings, ...overrides },
      encoding: "utf8",
      timeout: 20_000,
    });
  assert.throws(() => runReplay({ CW_DELIVERY_TOKEN: "wrong-secret" }), /delivery rejected/);
  const empty = new OrderViewStore(viewPath, IDENTITY, () => {}, CONTRACT);
  assert.deepEqual(empty.snapshot(), { frontier: null, orders: [] });
  empty.close();

  assert.deepEqual(JSON.parse(runReplay()), { acknowledged: 2, through: "2" });
  const replayed = new OrderViewStore(viewPath, IDENTITY, () => {}, CONTRACT);
  assert.deepEqual(replayed.snapshot(), { frontier: "2", orders: ["first", "second"] });
  replayed.close();
  const sourceAudit = new DatabaseSync(sourcePath, { readOnly: true });
  const sourceRows = sourceAudit
    .prepare("SELECT position, evidence, delivered FROM source_orders ORDER BY position")
    .all();
  sourceAudit.close();
  assert.deepEqual(
    sourceRows.map((row) => [row.position, row.delivered]),
    [
      ["1", 1],
      ["2", 1],
    ],
  );
  assert.notEqual(sourceRows[1].evidence, expiredEvidence);
  const confirmed = await observe(port, certificate, sourceRows[1].evidence, settings.CW_APP_TOKEN);
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.result, "satisfied");
  assert.deepEqual(JSON.parse(confirmed.body), { orders: ["first", "second"] });

  assert.deepEqual(JSON.parse(runReplay()), { acknowledged: 2, through: "2" });
  const unchanged = new OrderViewStore(viewPath, IDENTITY, () => {}, CONTRACT);
  assert.deepEqual(unchanged.snapshot(), { frontier: "2", orders: ["first", "second"] });
  unchanged.close();
});

test("source replay cursor covers history across bounded batches", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "causalweb-reference-replay-page-"));
  assert.equal(resolve(directory, ".."), resolve(tmpdir()));
  context.onTestFinished(async () => {
    await rm(directory, { recursive: true });
  });
  const source = new OrderSourceStore(join(directory, "source.sqlite"), IDENTITY);
  for (let index = 1; index <= 101; index += 1)
    source.commit(`order-${index}`, 1000n, 4600n, `request-${index}`);
  const first = source.replayBatch();
  assert.equal(first.length, 100);
  assert.equal(first[0].position, "1");
  assert.equal(first[99].position, "100");
  assert.deepEqual(
    source.replayBatch("100").map((event) => event.position),
    ["101"],
  );
  assert.deepEqual(source.replayBatch("101"), []);
  source.close();
});
