import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CLAIM, Issuer, parseContext, requestHeaders, Verifier } from "@causalweb/protocol";
import { test } from "vitest";
import { recordFailureDecision } from "./operator.mjs";
import { OrderSourceStore, OrderViewStore } from "./order-store.mjs";

async function freePort() {
  const listener = createServer();
  await new Promise((resolveListen) => listener.listen(0, "127.0.0.1", resolveListen));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  await new Promise((resolveClose) => listener.close(resolveClose));
  return address.port;
}

function start(environment, port) {
  const child = spawn(process.execPath, ["reference/service.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, ...environment, CW_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ready = new Promise((resolveReady, rejectReady) => {
    let output = "";
    const earlyExit = (code) => rejectReady(new Error(`service exited before listening: ${code}`));
    child.once("error", rejectReady);
    child.once("exit", earlyExit);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (!output.includes(`https://127.0.0.1:${port}\n`)) return;
      child.off("exit", earlyExit);
      resolveReady();
    });
  });
  return { child, ready };
}

async function stop(service) {
  if (service.child.exitCode !== null || service.child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => service.child.once("exit", resolveExit));
  service.child.kill("SIGTERM");
  await exited;
  assert.ok(service.child.exitCode === 0 || service.child.signalCode === "SIGTERM");
}

async function kill(service) {
  if (service.child.exitCode !== null || service.child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => service.child.once("exit", resolveExit));
  assert.equal(service.child.kill("SIGKILL"), true);
  await exited;
  assert.ok(service.child.exitCode !== 0 || service.child.signalCode !== null);
}

async function waitForCrash(service) {
  if (service.child.exitCode === null && service.child.signalCode === null)
    await new Promise((resolveExit) => service.child.once("exit", resolveExit));
  assert.notEqual(service.child.exitCode, 0);
}

async function exchange(port, certificate, path, method = "GET", headers = {}, body) {
  return new Promise((resolveResponse, rejectResponse) => {
    const request = httpsRequest(
      `https://127.0.0.1:${port}${path}`,
      { method, headers, ca: certificate },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.once("error", rejectResponse);
        response.once("end", () =>
          resolveResponse({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    request.once("error", rejectResponse);
    request.end(body);
  });
}

function deliveryBody(event, key) {
  const header = Buffer.from(
    JSON.stringify({ alg: "ES256", kid: "key-1", typ: "causalweb-reference-delivery+jwt" }),
  ).toString("base64url");
  const payload = Buffer.from(JSON.stringify(event)).toString("base64url");
  const input = `${header}.${payload}`;
  return JSON.stringify({
    event,
    proof: `${input}.${sign("sha256", Buffer.from(input), {
      key,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url")}`,
  });
}

test("live HTTPS view reports only operator-recorded terminal failure", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "causalweb-reference-failed-http-"));
  assert.equal(resolve(directory, ".."), resolve(tmpdir()));
  const tlsKey = resolve("test/fixtures/localhost-key.pem");
  const tlsCertificate = resolve("test/fixtures/localhost-cert.pem");
  const certificate = await readFile(tlsCertificate);
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const verificationKey = join(directory, "verification.pem");
  const keyring = join(directory, "verification-keys.json");
  await writeFile(verificationKey, publicKey.export({ format: "pem", type: "spki" }));
  await writeFile(keyring, JSON.stringify([{ kid: "key-1", publicKeyFile: "verification.pem" }]));
  const port = await freePort();
  const settings = {
    CW_ROLE: "view",
    CW_DATABASE: join(directory, "view.sqlite"),
    CW_ISSUER: "https://orders.example",
    CW_DOMAIN: "https://orders.example/domains/orders",
    CW_AUDIENCE: "https://view.example/causal",
    CW_SUBJECT: "tenant-a",
    CW_VIEW_CONTRACT: "reference-orders/test-live-contract",
    CW_VIEW_SCHEMA: "orders/test-live-contract",
    CW_KID: "key-1",
    CW_APP_TOKEN: "application-secret-for-tenant-a",
    CW_DELIVERY_TOKEN: "separate-delivery-secret",
    CW_TLS_KEY_FILE: tlsKey,
    CW_TLS_CERT_FILE: tlsCertificate,
    CW_VERIFY_KEYRING_FILE: keyring,
  };
  const identity = {
    issuer: settings.CW_ISSUER,
    domain: settings.CW_DOMAIN,
    audience: settings.CW_AUDIENCE,
    subject: settings.CW_SUBJECT,
  };
  const now = BigInt(Math.floor(Date.now() / 1000));
  const issuer = new Issuer(
    identity.issuer,
    "key-1",
    privateKey,
    new Set([identity.domain]),
    3600n,
  );
  const event = (value) => {
    const id = `urn:uuid:00000000-0000-4000-8000-00000000000${value}`;
    return {
      id,
      position: String(value),
      order: `order-${value}`,
      issuedAt: now.toString(),
      expiresAt: (now + 3600n).toString(),
      evidence: issuer.issueCommitted(
        {
          subject: identity.subject,
          audiences: [identity.audience],
          domain: identity.domain,
          position: BigInt(value),
          issuedAt: now,
          expiresAt: now + 3600n,
          evidenceId: id,
        },
        now,
      ),
    };
  };
  const first = event(1);
  const second = event(2);
  let view = start(settings, port);
  context.onTestFinished(async () => {
    await stop(view);
    await rm(directory, { recursive: true });
  });
  await view.ready;
  const deliver = (item) =>
    exchange(
      port,
      certificate,
      "/deliver",
      "POST",
      { authorization: `Bearer ${settings.CW_DELIVERY_TOKEN}` },
      deliveryBody(item, privateKey),
    );
  assert.equal((await deliver(second)).status, 204);
  const read = (item, authenticated = true) =>
    exchange(port, certificate, "/orders", "GET", {
      ...Object.fromEntries(requestHeaders([item.evidence])),
      ...(authenticated ? { authorization: `Bearer ${settings.CW_APP_TOKEN}` } : {}),
    });
  assert.equal((await read(second)).status, 412);
  recordFailureDecision("mark-failed", "2", settings);
  const failed = await read(second);
  assert.equal(failed.status, 503);
  assert.equal(failed.headers["causal-result"], "unsatisfied");
  assert.equal(JSON.parse(failed.body.toString("utf8")).outcomes[0].outcome, "failed");
  assert.equal((await read(first)).status, 412);
  const denied = await read(second, false);
  assert.equal(denied.status, 401);
  assert.equal(denied.headers["causal-result"], undefined);
  await stop(view);
  view = start(settings, port);
  await view.ready;
  assert.equal((await read(second)).status, 503);
  recordFailureDecision("resolve-failed", "2", settings);
  assert.equal((await read(second)).status, 412);
  recordFailureDecision("mark-failed", "2", settings);
  assert.equal((await deliver(first)).status, 204);
  const satisfied = await read(second);
  assert.equal(satisfied.status, 200);
  assert.equal(satisfied.headers["causal-result"], "satisfied");
});

test("invalid protocol identity does not bind an empty database", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "causalweb-reference-config-"));
  const tlsKey = resolve("test/fixtures/localhost-key.pem");
  const tlsCertificate = resolve("test/fixtures/localhost-cert.pem");
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const signingKey = join(directory, "signing.pem");
  const verificationKey = join(directory, "verification.pem");
  const keyring = join(directory, "keyring.json");
  await writeFile(signingKey, privateKey.export({ format: "pem", type: "pkcs8" }));
  await writeFile(verificationKey, publicKey.export({ format: "pem", type: "spki" }));
  await writeFile(keyring, JSON.stringify([{ kid: "key-1", publicKeyFile: "verification.pem" }]));
  const common = {
    CW_ISSUER: "https://orders.example",
    CW_DOMAIN: "https://orders.example/domains/orders",
    CW_AUDIENCE: "https://view.example/causal",
    CW_SUBJECT: "tenant-a",
    CW_KID: "key-1",
    CW_APP_TOKEN: "application-secret-for-tenant-a",
    CW_DELIVERY_TOKEN: "separate-delivery-secret",
    CW_TLS_KEY_FILE: tlsKey,
    CW_TLS_CERT_FILE: tlsCertificate,
    NODE_ENV: "test",
  };
  const viewPort = await freePort();
  const sourcePort = await freePort();
  const configurations = [
    {
      environment: {
        ...common,
        CW_ROLE: "source",
        CW_DATABASE: join(directory, "source.sqlite"),
        CW_SIGNING_KEY_FILE: signingKey,
        CW_VIEW_URL: `https://127.0.0.1:${viewPort}`,
      },
      invalid: [
        { CW_ISSUER: `${common.CW_ISSUER}#fragment` },
        { CW_VIEW_URL: `https://127.0.0.1:${viewPort}/unexpected-path` },
      ],
      port: sourcePort,
    },
    {
      environment: {
        ...common,
        CW_ROLE: "view",
        CW_DATABASE: join(directory, "view.sqlite"),
        CW_VERIFY_KEYRING_FILE: keyring,
      },
      invalid: [
        { CW_DOMAIN: `${common.CW_DOMAIN}#fragment` },
        { CW_VIEW_CONTRACT: "reference-orders/test-unpaired" },
      ],
      port: viewPort,
    },
  ];
  const running = [];
  context.onTestFinished(async () => {
    for (const service of running) await stop(service);
    assert.ok(directory.startsWith(join(resolve(tmpdir()), "causalweb-reference-config-")));
    await rm(directory, { recursive: true });
  });
  for (const { environment, invalid, port } of configurations) {
    for (const invalidFields of invalid) {
      const rejected = start({ ...environment, ...invalidFields }, port);
      await assert.rejects(rejected.ready, /service exited before listening/);
      await assert.rejects(access(environment.CW_DATABASE), { code: "ENOENT" });
    }
    const accepted = start(environment, port);
    running.push(accepted);
    await accepted.ready;
    await access(environment.CW_DATABASE);
  }
});

test("reference services recover across source and projection commit crash boundaries", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "causalweb-reference-crash-"));
  assert.equal(resolve(directory, ".."), resolve(tmpdir()));
  const tlsKey = resolve("test/fixtures/localhost-key.pem");
  const tlsCertificate = resolve("test/fixtures/localhost-cert.pem");
  const certificate = await readFile(tlsCertificate);
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const signingKey = join(directory, "signing.pem");
  const verificationKey = join(directory, "verification.pem");
  const keyring = join(directory, "keyring.json");
  await writeFile(signingKey, privateKey.export({ format: "pem", type: "pkcs8" }));
  await writeFile(verificationKey, publicKey.export({ format: "pem", type: "spki" }));
  await writeFile(keyring, JSON.stringify([{ kid: "key-1", publicKeyFile: "verification.pem" }]));
  const sourcePort = await freePort();
  const viewPort = await freePort();
  const identity = {
    issuer: "https://orders.example",
    domain: "https://orders.example/domains/orders",
    audience: "https://view.example/causal",
    subject: "tenant-a",
  };
  const common = {
    CW_ISSUER: identity.issuer,
    CW_DOMAIN: identity.domain,
    CW_AUDIENCE: identity.audience,
    CW_SUBJECT: identity.subject,
    CW_KID: "key-1",
    CW_APP_TOKEN: "application-secret-for-tenant-a",
    CW_DELIVERY_TOKEN: "separate-delivery-secret",
    CW_TLS_KEY_FILE: tlsKey,
    CW_TLS_CERT_FILE: tlsCertificate,
    NODE_ENV: "test",
  };
  const sourceEnvironment = {
    ...common,
    CW_ROLE: "source",
    CW_DATABASE: join(directory, "source.sqlite"),
    CW_SIGNING_KEY_FILE: signingKey,
    CW_VIEW_URL: `https://127.0.0.1:${viewPort}`,
    NODE_EXTRA_CA_CERTS: tlsCertificate,
  };
  const viewEnvironment = {
    ...common,
    CW_ROLE: "view",
    CW_DATABASE: join(directory, "view.sqlite"),
    CW_VERIFY_KEYRING_FILE: keyring,
  };
  const orderHeaders = {
    authorization: `Bearer ${common.CW_APP_TOKEN}`,
    "content-type": "application/json",
    "cw-request-key": "first",
  };
  let source = start(
    { ...sourceEnvironment, CW_TEST_FAULT_POINT: "before-source-commit" },
    sourcePort,
  );
  let view;
  context.onTestFinished(async () => {
    await stop(source);
    if (view) await stop(view);
    assert.ok(directory.startsWith(join(resolve(tmpdir()), "causalweb-reference-crash-")));
    await rm(directory, { recursive: true });
  });
  await source.ready;
  await assert.rejects(
    exchange(
      sourcePort,
      certificate,
      "/orders",
      "POST",
      orderHeaders,
      JSON.stringify({ order: "first" }),
    ),
  );
  await waitForCrash(source);
  const uncommitted = new OrderSourceStore(sourceEnvironment.CW_DATABASE, identity);
  assert.deepEqual(uncommitted.unissued(), []);
  uncommitted.close();
  const rolledBackSource = new DatabaseSync(sourceEnvironment.CW_DATABASE, { readOnly: true });
  assert.equal(
    rolledBackSource.prepare("SELECT COUNT(*) AS count FROM source_orders").get().count,
    0,
  );
  assert.equal(
    rolledBackSource.prepare("SELECT next_position FROM source_state WHERE id = 1").get()
      .next_position,
    "1",
  );
  assert.equal(
    rolledBackSource.prepare("SELECT COUNT(*) AS count FROM source_requests").get().count,
    0,
  );
  rolledBackSource.close();

  source = start({ ...sourceEnvironment, CW_TEST_FAULT_POINT: "after-source-commit" }, sourcePort);
  await source.ready;
  await assert.rejects(
    exchange(
      sourcePort,
      certificate,
      "/orders",
      "POST",
      orderHeaders,
      JSON.stringify({ order: "first" }),
    ),
  );
  await waitForCrash(source);
  const committed = new OrderSourceStore(sourceEnvironment.CW_DATABASE, identity);
  assert.deepEqual(
    committed.unissued().map((event) => [event.position, event.order]),
    [["1", "first"]],
  );
  committed.close();

  view = start(viewEnvironment, viewPort);
  await view.ready;
  source = start(sourceEnvironment, sourcePort);
  await source.ready;
  const recoveredResponse = await exchange(
    sourcePort,
    certificate,
    "/orders",
    "POST",
    orderHeaders,
    JSON.stringify({ order: "first" }),
  );
  assert.equal(recoveredResponse.status, 201);
  assert.equal(JSON.parse(recoveredResponse.body.toString("utf8")).position, "1");
  const awaitOrders = async (expected) => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const state = new OrderViewStore(viewEnvironment.CW_DATABASE, identity);
      const actual = state.snapshot();
      state.close();
      if (JSON.stringify(actual.orders) === JSON.stringify(expected)) return actual;
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    assert.fail(`view did not reach ${JSON.stringify(expected)}`);
  };
  const awaitDeliveryAcknowledgement = async () => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const state = new OrderSourceStore(sourceEnvironment.CW_DATABASE, identity);
      const pending = state.undelivered();
      state.close();
      if (pending.length === 0) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    assert.fail("source did not acknowledge view delivery");
  };
  assert.equal((await awaitOrders(["first"])).frontier, "1");
  await awaitDeliveryAcknowledgement();

  await stop(view);
  view = start({ ...viewEnvironment, CW_TEST_FAULT_POINT: "before-frontier" }, viewPort);
  await view.ready;
  const second = await exchange(
    sourcePort,
    certificate,
    "/orders",
    "POST",
    { ...orderHeaders, "cw-request-key": "second" },
    JSON.stringify({ order: "second" }),
  );
  assert.equal(second.status, 201);
  await waitForCrash(view);
  const rolledBack = new OrderViewStore(viewEnvironment.CW_DATABASE, identity);
  assert.deepEqual(rolledBack.snapshot(), { frontier: "1", orders: ["first"] });
  rolledBack.close();
  view = start(viewEnvironment, viewPort);
  await view.ready;
  assert.equal((await awaitOrders(["first", "second"])).frontier, "2");
  await awaitDeliveryAcknowledgement();

  await stop(view);
  view = start({ ...viewEnvironment, CW_TEST_FAULT_POINT: "after-view-commit" }, viewPort);
  await view.ready;
  const third = await exchange(
    sourcePort,
    certificate,
    "/orders",
    "POST",
    { ...orderHeaders, "cw-request-key": "third" },
    JSON.stringify({ order: "third" }),
  );
  assert.equal(third.status, 201);
  await waitForCrash(view);
  const durable = new OrderViewStore(viewEnvironment.CW_DATABASE, identity);
  assert.deepEqual(durable.snapshot(), { frontier: "3", orders: ["first", "second", "third"] });
  durable.close();
  view = start(viewEnvironment, viewPort);
  await view.ready;
  const [evidence] = parseContext([third.headers["causal-context"]]);
  assert.ok(evidence);
  const read = await exchange(viewPort, certificate, "/orders", "GET", {
    ...Object.fromEntries(requestHeaders([evidence])),
    authorization: `Bearer ${common.CW_APP_TOKEN}`,
  });
  assert.equal(read.status, 200);
  assert.equal(read.headers["causal-result"], "satisfied");
});

test("configured HTTPS services recover delivery and confirm only the committed view", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "causalweb-reference-service-"));
  assert.equal(resolve(directory, ".."), resolve(tmpdir()));
  const tlsKey = resolve("test/fixtures/localhost-key.pem");
  const tlsCertificate = resolve("test/fixtures/localhost-cert.pem");
  const certificate = await readFile(tlsCertificate);
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const signingKey = join(directory, "signing.pem");
  const verificationKey = join(directory, "verification.pem");
  const keyring = join(directory, "verification-keys.json");
  await writeFile(signingKey, privateKey.export({ format: "pem", type: "pkcs8" }));
  await writeFile(verificationKey, publicKey.export({ format: "pem", type: "spki" }));
  await writeFile(keyring, JSON.stringify([{ kid: "key-1", publicKeyFile: "verification.pem" }]));
  const sourcePort = await freePort();
  const viewPort = await freePort();
  const common = {
    CW_ISSUER: "https://orders.example",
    CW_DOMAIN: "https://orders.example/domains/orders",
    CW_AUDIENCE: "https://view.example/causal",
    CW_SUBJECT: "tenant-a",
    CW_KID: "key-1",
    CW_APP_TOKEN: "application-secret-for-tenant-a",
    CW_DELIVERY_TOKEN: "separate-delivery-secret",
    CW_TLS_KEY_FILE: tlsKey,
    CW_TLS_CERT_FILE: tlsCertificate,
  };
  const sourceEnvironment = {
    ...common,
    CW_ROLE: "source",
    CW_DATABASE: join(directory, "source.sqlite"),
    CW_SIGNING_KEY_FILE: signingKey,
    CW_VIEW_URL: `https://127.0.0.1:${viewPort}`,
    NODE_EXTRA_CA_CERTS: tlsCertificate,
  };
  const viewEnvironment = {
    ...common,
    CW_ROLE: "view",
    CW_DATABASE: join(directory, "view.sqlite"),
    CW_VERIFY_KEYRING_FILE: keyring,
  };
  let source = start(sourceEnvironment, sourcePort);
  let view;
  let blockedDeliveryServer;
  context.onTestFinished(async () => {
    await stop(source);
    if (view) await stop(view);
    if (blockedDeliveryServer) {
      blockedDeliveryServer.closeAllConnections();
      await new Promise((resolveClose) => blockedDeliveryServer.close(resolveClose));
    }
    assert.ok(directory.startsWith(join(resolve(tmpdir()), "causalweb-reference-service-")));
    await rm(directory, { recursive: true });
  });
  await source.ready;
  const denied = await exchange(
    sourcePort,
    certificate,
    "/orders",
    "POST",
    {
      "content-type": "application/json",
    },
    JSON.stringify({ order: "first" }),
  );
  assert.equal(denied.status, 401);
  const malformed = await exchange(
    sourcePort,
    certificate,
    "/orders",
    "POST",
    { authorization: `Bearer ${common.CW_APP_TOKEN}`, "content-type": "application/json" },
    Buffer.concat([
      Buffer.from('{"order":"valid","ignored":"'),
      Buffer.from([0xff]),
      Buffer.from('"}'),
    ]),
  );
  assert.equal(malformed.status, 400);
  assert.equal(malformed.headers["causal-context"], undefined);
  const oversized = await exchange(
    sourcePort,
    certificate,
    "/orders",
    "POST",
    { authorization: `Bearer ${common.CW_APP_TOKEN}`, "content-type": "application/json" },
    JSON.stringify({ order: "valid", ignored: "x".repeat(16_384) }),
  );
  assert.equal(oversized.status, 413);
  assert.equal(oversized.headers["causal-context"], undefined);
  const issued = await exchange(
    sourcePort,
    certificate,
    "/orders",
    "POST",
    {
      authorization: `Bearer ${common.CW_APP_TOKEN}`,
      "content-type": "application/json",
      "cw-request-key": "first",
    },
    JSON.stringify({ order: "first" }),
  );
  assert.equal(issued.status, 201);
  assert.equal(JSON.parse(issued.body.toString("utf8")).position, "1");
  const retried = await exchange(
    sourcePort,
    certificate,
    "/orders",
    "POST",
    {
      authorization: `Bearer ${common.CW_APP_TOKEN}`,
      "content-type": "application/json",
      "cw-request-key": "first",
    },
    JSON.stringify({ order: "first" }),
  );
  assert.equal(retried.status, 201);
  assert.deepEqual(retried.body, issued.body);
  assert.equal(retried.headers["causal-context"], issued.headers["causal-context"]);
  const conflictingRetry = await exchange(
    sourcePort,
    certificate,
    "/orders",
    "POST",
    {
      authorization: `Bearer ${common.CW_APP_TOKEN}`,
      "content-type": "application/json",
      "cw-request-key": "first",
    },
    JSON.stringify({ order: "different" }),
  );
  assert.equal(conflictingRetry.status, 409);
  assert.equal(conflictingRetry.headers["causal-context"], undefined);
  const missingKey = await exchange(
    sourcePort,
    certificate,
    "/orders",
    "POST",
    { authorization: `Bearer ${common.CW_APP_TOKEN}`, "content-type": "application/json" },
    JSON.stringify({ order: "missing-key" }),
  );
  assert.equal(missingKey.status, 400);
  assert.equal(missingKey.headers["causal-context"], undefined);
  const [evidence] = parseContext([issued.headers["causal-context"]]);
  assert.ok(evidence);
  await kill(source);
  const unfinished = new OrderSourceStore(sourceEnvironment.CW_DATABASE, {
    issuer: common.CW_ISSUER,
    domain: common.CW_DOMAIN,
    audience: common.CW_AUDIENCE,
    subject: common.CW_SUBJECT,
  });
  const now = BigInt(Math.floor(Date.now() / 1000));
  unfinished.commit("recovered", now - 7200n, now - 3600n, "recovered");
  const expired = unfinished.commit("expired-issued", now - 7200n, now - 3600n, "expired-issued");
  const oldEvidence = new Issuer(
    common.CW_ISSUER,
    common.CW_KID,
    privateKey,
    new Set([common.CW_DOMAIN]),
    3600n,
  ).issueCommitted(
    {
      subject: common.CW_SUBJECT,
      audiences: [common.CW_AUDIENCE],
      domain: common.CW_DOMAIN,
      position: BigInt(expired.position),
      issuedAt: now - 7200n,
      expiresAt: now - 3600n,
      evidenceId: expired.id,
    },
    now - 7200n,
  );
  unfinished.materialize(expired.id, oldEvidence, now - 7200n, now - 3600n);
  unfinished.close();

  view = start(viewEnvironment, viewPort);
  await view.ready;
  const causalHeaders = Object.fromEntries(requestHeaders([evidence]));
  causalHeaders.authorization = `Bearer ${common.CW_APP_TOKEN}`;
  const stale = await exchange(viewPort, certificate, "/orders", "GET", causalHeaders);
  assert.equal(stale.status, 412);
  assert.equal(stale.headers["causal-result"], "unsatisfied");
  const claims = JSON.parse(Buffer.from(evidence.split(".")[1], "base64url").toString("utf8"));
  const event = {
    ...JSON.parse(issued.body.toString("utf8")),
    issuedAt: String(claims.iat),
    expiresAt: String(claims.exp),
    evidence,
  };
  const invalidDelivery = JSON.stringify({ event, proof: "invalid" });
  assert.equal(
    (await exchange(viewPort, certificate, "/deliver", "POST", {}, invalidDelivery)).status,
    401,
  );
  assert.equal(
    (
      await exchange(
        viewPort,
        certificate,
        "/deliver",
        "POST",
        { authorization: `Bearer ${common.CW_DELIVERY_TOKEN}` },
        invalidDelivery,
      )
    ).status,
    400,
  );
  const signatureBytes = Buffer.from(evidence.split(".")[2], "base64url");
  signatureBytes[0] ^= 1;
  const forgedEvent = {
    ...event,
    evidence: `${evidence.split(".").slice(0, 2).join(".")}.${signatureBytes.toString("base64url")}`,
  };
  const signedDelivery = (signedEvent) => deliveryBody(signedEvent, privateKey);
  const expiredDelivery = await exchange(
    viewPort,
    certificate,
    "/deliver",
    "POST",
    { authorization: `Bearer ${common.CW_DELIVERY_TOKEN}` },
    signedDelivery({ ...expired, evidence: oldEvidence }),
  );
  assert.equal(expiredDelivery.status, 400);
  assert.equal(expiredDelivery.headers["causal-result"], undefined);
  const afterExpired = new DatabaseSync(viewEnvironment.CW_DATABASE);
  assert.equal(afterExpired.prepare("SELECT count(*) AS count FROM view_pending").get().count, 0);
  assert.equal(afterExpired.prepare("SELECT count(*) AS count FROM view_orders").get().count, 0);
  afterExpired.close();
  const forgedDelivery = signedDelivery(forgedEvent);
  const rejectedForgery = await exchange(
    viewPort,
    certificate,
    "/deliver",
    "POST",
    { authorization: `Bearer ${common.CW_DELIVERY_TOKEN}` },
    forgedDelivery,
  );
  assert.equal(rejectedForgery.status, 400);
  assert.equal(rejectedForgery.headers["causal-result"], undefined);
  const alternateProfile = "https://profile.example/other";
  const otherClaims = structuredClone(claims);
  otherClaims[CLAIM].profile = alternateProfile;
  const otherInput = `${evidence.split(".")[0]}.${Buffer.from(JSON.stringify(otherClaims)).toString("base64url")}`;
  const otherEvidence = `${otherInput}.${sign("sha256", Buffer.from(otherInput), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url")}`;
  assert.equal(
    new Verifier(common.CW_AUDIENCE, [
      {
        issuer: common.CW_ISSUER,
        keys: new Map([[common.CW_KID, publicKey]]),
        domains: new Set([common.CW_DOMAIN]),
        maxLifetimeSeconds: 3600n,
        clockSkewSeconds: 30n,
      },
    ]).verify(otherEvidence, common.CW_SUBJECT, BigInt(Math.floor(Date.now() / 1000))).profile,
    alternateProfile,
  );
  const otherProfile = await exchange(
    viewPort,
    certificate,
    "/deliver",
    "POST",
    { authorization: `Bearer ${common.CW_DELIVERY_TOKEN}` },
    signedDelivery({ ...event, evidence: otherEvidence }),
  );
  assert.equal(otherProfile.status, 400);
  assert.equal(otherProfile.headers["causal-result"], undefined);
  const mismatchedIssued = await exchange(
    viewPort,
    certificate,
    "/deliver",
    "POST",
    { authorization: `Bearer ${common.CW_DELIVERY_TOKEN}` },
    signedDelivery({ ...event, issuedAt: (BigInt(event.issuedAt) - 1n).toString() }),
  );
  assert.equal(mismatchedIssued.status, 400);
  assert.equal(mismatchedIssued.headers["causal-result"], undefined);
  const malformedEvent = await exchange(
    viewPort,
    certificate,
    "/deliver",
    "POST",
    { authorization: `Bearer ${common.CW_DELIVERY_TOKEN}` },
    JSON.stringify({ event: { position: "not-a-position" }, proof: "invalid" }),
  );
  assert.equal(malformedEvent.status, 400);
  assert.equal(malformedEvent.headers["causal-result"], undefined);
  const deliveryHeaders = { authorization: `Bearer ${common.CW_DELIVERY_TOKEN}` };
  for (const [body, status] of [
    [Buffer.from("{", "utf8"), 400],
    [Buffer.from([0xff]), 400],
    [Buffer.alloc(16_385, 0x20), 413],
    [JSON.stringify({ event: { ...event, issuedAt: "not-a-date" }, proof: "invalid" }), 400],
    [JSON.stringify({ event: { ...event, expiresAt: "-1" }, proof: "invalid" }), 400],
  ]) {
    const rejected = await exchange(
      viewPort,
      certificate,
      "/deliver",
      "POST",
      deliveryHeaders,
      body,
    );
    assert.equal(rejected.status, status);
    assert.equal(rejected.headers["causal-result"], undefined);
  }
  assert.equal(
    (await exchange(viewPort, certificate, "/orders", "GET", causalHeaders)).status,
    412,
  );
  const expiredRead = await exchange(viewPort, certificate, "/orders", "GET", {
    ...Object.fromEntries(requestHeaders([oldEvidence])),
    authorization: `Bearer ${common.CW_APP_TOKEN}`,
  });
  assert.equal(expiredRead.status, 412);
  assert.equal(expiredRead.headers["causal-result"], "unsatisfied");
  assert.equal(JSON.parse(expiredRead.body.toString("utf8")).outcomes[0].outcome, "expired");
  const deniedView = await exchange(
    viewPort,
    certificate,
    "/orders",
    "GET",
    Object.fromEntries(requestHeaders([evidence])),
  );
  assert.equal(deniedView.status, 401);
  assert.equal(deniedView.headers["causal-result"], undefined);

  source = start(sourceEnvironment, sourcePort);
  await source.ready;
  let confirmed;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    confirmed = await exchange(viewPort, certificate, "/orders", "GET", causalHeaders);
    if (confirmed.status === 200 && JSON.parse(confirmed.body.toString("utf8")).orders.length === 3)
      break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.headers["causal-result"], "satisfied");
  assert.deepEqual(JSON.parse(confirmed.body.toString("utf8")), {
    orders: ["first", "recovered", "expired-issued"],
  });
  await stop(source);
  const acknowledged = new OrderSourceStore(sourceEnvironment.CW_DATABASE, {
    issuer: common.CW_ISSUER,
    domain: common.CW_DOMAIN,
    audience: common.CW_AUDIENCE,
    subject: common.CW_SUBJECT,
  });
  const firstId = JSON.parse(issued.body.toString("utf8")).id;
  acknowledged.delivered(firstId, evidence);
  acknowledged.close();
  const expiredForRetry = new DatabaseSync(sourceEnvironment.CW_DATABASE);
  expiredForRetry
    .prepare("UPDATE source_orders SET issued_at = '0', expires_at = '1' WHERE event_id = ?")
    .run(firstId);
  expiredForRetry.close();
  source = start(sourceEnvironment, sourcePort);
  await source.ready;
  const refreshedRetry = await exchange(
    sourcePort,
    certificate,
    "/orders",
    "POST",
    {
      authorization: `Bearer ${common.CW_APP_TOKEN}`,
      "content-type": "application/json",
      "cw-request-key": "first",
    },
    JSON.stringify({ order: "first" }),
  );
  assert.equal(refreshedRetry.status, 201);
  assert.deepEqual(refreshedRetry.body, issued.body);
  const [freshEvidence] = parseContext([refreshedRetry.headers["causal-context"]]);
  assert.ok(freshEvidence);
  assert.notEqual(freshEvidence, evidence);
  const freshRead = await exchange(viewPort, certificate, "/orders", "GET", {
    ...Object.fromEntries(requestHeaders([freshEvidence])),
    authorization: `Bearer ${common.CW_APP_TOKEN}`,
  });
  assert.equal(freshRead.status, 200);
  assert.equal(freshRead.headers["causal-result"], "satisfied");
  await kill(view);
  view = start(viewEnvironment, viewPort);
  await view.ready;
  const afterRestart = await exchange(viewPort, certificate, "/orders", "GET", causalHeaders);
  assert.equal(afterRestart.status, 200);
  assert.equal(afterRestart.headers["causal-result"], "satisfied");
  assert.deepEqual(JSON.parse(afterRestart.body.toString("utf8")), {
    orders: ["first", "recovered", "expired-issued"],
  });

  const rotated = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const rotatedSigningKey = join(directory, "signing-2.pem");
  const rotatedVerificationKey = join(directory, "verification-2.pem");
  await writeFile(rotatedSigningKey, rotated.privateKey.export({ format: "pem", type: "pkcs8" }));
  await writeFile(
    rotatedVerificationKey,
    rotated.publicKey.export({ format: "pem", type: "spki" }),
  );
  await writeFile(
    keyring,
    JSON.stringify([
      { kid: "key-1", publicKeyFile: "verification.pem" },
      { kid: "key-2", publicKeyFile: "verification-2.pem" },
    ]),
  );
  await stop(source);
  await stop(view);
  view = start({ ...viewEnvironment, CW_KID: "key-2" }, viewPort);
  await view.ready;
  source = start(
    { ...sourceEnvironment, CW_KID: "key-2", CW_SIGNING_KEY_FILE: rotatedSigningKey },
    sourcePort,
  );
  await source.ready;
  assert.equal(
    (await exchange(viewPort, certificate, "/orders", "GET", causalHeaders)).status,
    200,
  );
  const afterRotation = await exchange(
    sourcePort,
    certificate,
    "/orders",
    "POST",
    {
      authorization: `Bearer ${common.CW_APP_TOKEN}`,
      "content-type": "application/json",
      "cw-request-key": "after-rotation",
    },
    JSON.stringify({ order: "after-rotation" }),
  );
  assert.equal(afterRotation.status, 201);
  const [newEvidence] = parseContext([afterRotation.headers["causal-context"]]);
  assert.ok(newEvidence);
  const newHeaders = Object.fromEntries(requestHeaders([newEvidence]));
  newHeaders.authorization = `Bearer ${common.CW_APP_TOKEN}`;
  let newlyConfirmed;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    newlyConfirmed = await exchange(viewPort, certificate, "/orders", "GET", newHeaders);
    if (newlyConfirmed.status === 200) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  assert.equal(newlyConfirmed.status, 200);
  assert.equal(newlyConfirmed.headers["causal-result"], "satisfied");
  assert.deepEqual(JSON.parse(newlyConfirmed.body.toString("utf8")), {
    orders: ["first", "recovered", "expired-issued", "after-rotation"],
  });
  const cliResult = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "reference/client.mjs",
        `https://127.0.0.1:${sourcePort}`,
        `https://127.0.0.1:${viewPort}`,
        "from-client",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CW_APP_TOKEN: common.CW_APP_TOKEN,
          NODE_EXTRA_CA_CERTS: tlsCertificate,
        },
        encoding: "utf8",
        timeout: 20_000,
      },
    ),
  );
  assert.equal(cliResult.status, 200);
  assert.deepEqual(cliResult.body, {
    orders: ["first", "recovered", "expired-issued", "after-rotation", "from-client"],
  });
  await stop(view);
  const rotatedAppToken = "new-application-secret-for-tenant-a";
  view = start({ ...viewEnvironment, CW_KID: "key-2", CW_APP_TOKEN: rotatedAppToken }, viewPort);
  await view.ready;
  const revoked = await exchange(viewPort, certificate, "/orders", "GET", newHeaders);
  assert.equal(revoked.status, 401);
  assert.equal(revoked.headers["causal-result"], undefined);
  const reauthorized = await exchange(viewPort, certificate, "/orders", "GET", {
    ...newHeaders,
    authorization: `Bearer ${rotatedAppToken}`,
  });
  assert.equal(reauthorized.status, 200);
  assert.equal(reauthorized.headers["causal-result"], "satisfied");

  const blockedPort = await freePort();
  let deliveryStarted;
  const waitingForDelivery = new Promise((resolveStarted) => {
    deliveryStarted = resolveStarted;
  });
  blockedDeliveryServer = createHttpsServer(
    { key: await readFile(tlsKey), cert: certificate },
    () => deliveryStarted(),
  );
  await new Promise((resolveListen) =>
    blockedDeliveryServer.listen(blockedPort, "127.0.0.1", resolveListen),
  );
  await stop(source);
  source = start(
    {
      ...sourceEnvironment,
      CW_KID: "key-2",
      CW_SIGNING_KEY_FILE: rotatedSigningKey,
      CW_VIEW_URL: `https://127.0.0.1:${blockedPort}`,
    },
    sourcePort,
  );
  await source.ready;
  const pending = await exchange(
    sourcePort,
    certificate,
    "/orders",
    "POST",
    {
      authorization: `Bearer ${common.CW_APP_TOKEN}`,
      "content-type": "application/json",
      "cw-request-key": "shutdown-pending",
    },
    JSON.stringify({ order: "shutdown-pending" }),
  );
  assert.equal(pending.status, 201);
  await waitingForDelivery;
  const shutdownStarted = Date.now();
  await stop(source);
  assert.ok(Date.now() - shutdownStarted < 2_000);
  const persisted = new OrderSourceStore(sourceEnvironment.CW_DATABASE, {
    issuer: common.CW_ISSUER,
    domain: common.CW_DOMAIN,
    audience: common.CW_AUDIENCE,
    subject: common.CW_SUBJECT,
  });
  assert.ok(persisted.undelivered().some((event) => event.order === "shutdown-pending"));
  persisted.close();
  source = start(
    { ...sourceEnvironment, CW_KID: "key-2", CW_SIGNING_KEY_FILE: rotatedSigningKey },
    sourcePort,
  );
  await source.ready;
  const [pendingEvidence] = parseContext([pending.headers["causal-context"]]);
  assert.ok(pendingEvidence);
  const pendingHeaders = {
    ...Object.fromEntries(requestHeaders([pendingEvidence])),
    authorization: `Bearer ${rotatedAppToken}`,
  };
  let recovered;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    recovered = await exchange(viewPort, certificate, "/orders", "GET", pendingHeaders);
    if (recovered.status === 200) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  assert.equal(recovered.status, 200);
  assert.equal(recovered.headers["causal-result"], "satisfied");

  await stop(source);
  source = start(
    {
      ...sourceEnvironment,
      CW_KID: "key-2",
      CW_SIGNING_KEY_FILE: rotatedSigningKey,
      CW_DELIVERY_TOKEN: "wrong-delivery-secret",
    },
    sourcePort,
  );
  await source.ready;
  const refusedDelivery = new Promise((resolveRefusal, rejectRefusal) => {
    const timeout = setTimeout(() => {
      source.child.stderr.off("data", onData);
      rejectRefusal(new Error("source did not report rejected delivery"));
    }, 5000);
    const onData = (chunk) => {
      if (!chunk.toString().includes("delivery retry pending: HTTP 401")) return;
      clearTimeout(timeout);
      source.child.stderr.off("data", onData);
      resolveRefusal();
    };
    source.child.stderr.on("data", onData);
  });
  const blocked = await exchange(
    sourcePort,
    certificate,
    "/orders",
    "POST",
    {
      authorization: `Bearer ${common.CW_APP_TOKEN}`,
      "content-type": "application/json",
      "cw-request-key": "rejected-delivery",
    },
    JSON.stringify({ order: "rejected-delivery" }),
  );
  assert.equal(blocked.status, 201);
  await refusedDelivery;
  await stop(source);
  const held = new OrderSourceStore(sourceEnvironment.CW_DATABASE, {
    issuer: common.CW_ISSUER,
    domain: common.CW_DOMAIN,
    audience: common.CW_AUDIENCE,
    subject: common.CW_SUBJECT,
  });
  assert.ok(held.undelivered().some((event) => event.order === "rejected-delivery"));
  held.close();
  const [blockedEvidence] = parseContext([blocked.headers["causal-context"]]);
  const recoveredHeaders = {
    ...Object.fromEntries(requestHeaders([blockedEvidence])),
    authorization: `Bearer ${rotatedAppToken}`,
  };
  const notTerminal = await exchange(viewPort, certificate, "/orders", "GET", recoveredHeaders);
  assert.equal(notTerminal.status, 412);
  assert.equal(notTerminal.headers["causal-result"], "unsatisfied");
  assert.equal(JSON.parse(notTerminal.body).outcomes[0].outcome, "unsatisfied");
  source = start(
    { ...sourceEnvironment, CW_KID: "key-2", CW_SIGNING_KEY_FILE: rotatedSigningKey },
    sourcePort,
  );
  await source.ready;
  let accepted;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    accepted = await exchange(viewPort, certificate, "/orders", "GET", recoveredHeaders);
    if (accepted.status === 200) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers["causal-result"], "satisfied");
});
