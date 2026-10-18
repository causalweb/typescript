import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import { parseContext, requestHeaders } from "@causalweb/protocol";

const loadCount =
  process.argv.length === 2
    ? null
    : process.argv[2] === "--load" && process.argv.length === 4
      ? Number(process.argv[3])
      : Number.NaN;
if (loadCount !== null && (!Number.isSafeInteger(loadCount) || loadCount < 1 || loadCount > 500))
  throw new Error("usage: quickstart.mjs [--load ORDER_COUNT_FROM_1_TO_500]");

const directory = await mkdtemp(join(tmpdir(), "causalweb-quickstart-"));
assert.equal(resolve(directory, ".."), resolve(tmpdir()));
const tlsKey = resolve("test/fixtures/localhost-key.pem");
const tlsCertificate = resolve("test/fixtures/localhost-cert.pem");
const certificate = await readFile(tlsCertificate);
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const signingKey = join(directory, "signing.pem");
const verificationKey = join(directory, "verification.pem");
const keyring = join(directory, "keyring.json");
const appToken = randomBytes(32).toString("base64url");
const deliveryToken = randomBytes(32).toString("base64url");
const services = new Set();

async function freePort() {
  const listener = createServer();
  await new Promise((done) => listener.listen(0, "127.0.0.1", done));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  await new Promise((done) => listener.close(done));
  return address.port;
}

function start(environment, port) {
  const child = spawn(process.execPath, ["reference/service.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, ...environment, CW_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  services.add(child);
  return new Promise((resolveReady, rejectReady) => {
    let output = "";
    let errors = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      errors = (errors + chunk).slice(-1000);
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes(`https://127.0.0.1:${port}\n`)) {
        child.off("error", rejectReady);
        child.off("exit", earlyExit);
        resolveReady(child);
      }
    });
    const earlyExit = () => rejectReady(new Error(`service could not start: ${errors}`));
    child.once("error", rejectReady);
    child.once("exit", earlyExit);
  });
}

async function stop(child) {
  if (child.exitCode === null && child.signalCode === null) {
    const exit = new Promise((done) => child.once("exit", done));
    child.kill("SIGTERM");
    await exit;
  }
  services.delete(child);
}

function exchange(port, path, method, headers, body) {
  return new Promise((resolveResponse, rejectResponse) => {
    const request = httpsRequest(
      `https://127.0.0.1:${port}${path}`,
      { method, headers, ca: certificate, timeout: 5000 },
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
    request.once("timeout", () => request.destroy(new Error("quickstart request timed out")));
    request.once("error", rejectResponse);
    request.end(body);
  });
}

try {
  await writeFile(signingKey, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  await writeFile(verificationKey, publicKey.export({ format: "pem", type: "spki" }));
  await writeFile(keyring, JSON.stringify([{ kid: "demo-key", publicKeyFile: verificationKey }]));
  const ports = new Set();
  while (ports.size < 3) ports.add(await freePort());
  const [sourcePort, viewPort, unavailablePort] = [...ports];
  const common = {
    CW_ISSUER: "https://quickstart.example",
    CW_DOMAIN: "https://quickstart.example/orders",
    CW_AUDIENCE: "https://view.quickstart.example/causal",
    CW_SUBJECT: "demo-principal",
    CW_KID: "demo-key",
    CW_APP_TOKEN: appToken,
    CW_DELIVERY_TOKEN: deliveryToken,
    CW_TLS_KEY_FILE: tlsKey,
    CW_TLS_CERT_FILE: tlsCertificate,
  };
  const sourceEnvironment = {
    ...common,
    CW_ROLE: "source",
    CW_DATABASE: join(directory, "source.sqlite"),
    CW_SIGNING_KEY_FILE: signingKey,
    NODE_EXTRA_CA_CERTS: tlsCertificate,
  };
  const viewEnvironment = {
    ...common,
    CW_ROLE: "view",
    CW_DATABASE: join(directory, "view.sqlite"),
    CW_VERIFY_KEYRING_FILE: keyring,
  };
  let source = await start(
    { ...sourceEnvironment, CW_VIEW_URL: `https://127.0.0.1:${unavailablePort}` },
    sourcePort,
  );
  const issued = await exchange(
    sourcePort,
    "/orders",
    "POST",
    {
      authorization: `Bearer ${appToken}`,
      "content-type": "application/json",
      "cw-request-key": "quickstart",
    },
    JSON.stringify({ order: "quickstart" }),
  );
  assert.equal(issued.status, 201);
  const [evidence] = parseContext([issued.headers["causal-context"]]);
  assert.ok(evidence);
  await start(viewEnvironment, viewPort);
  const stale = await exchange(viewPort, "/orders", "GET", {
    ...Object.fromEntries(requestHeaders([evidence])),
    authorization: `Bearer ${appToken}`,
  });
  assert.equal(stale.status, 412);
  assert.equal(stale.headers["causal-result"], "unsatisfied");
  await stop(source);
  source = await start(
    { ...sourceEnvironment, CW_VIEW_URL: `https://127.0.0.1:${viewPort}` },
    sourcePort,
  );
  const confirmed = JSON.parse(
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
          CW_APP_TOKEN: appToken,
          NODE_EXTRA_CA_CERTS: tlsCertificate,
        },
        encoding: "utf8",
        timeout: 20_000,
      },
    ),
  );
  assert.equal(confirmed.status, 200);
  assert.deepEqual(confirmed.body, { orders: ["quickstart", "from-client"] });
  if (loadCount === null) {
    process.stdout.write("stale 412 → authenticated delivery → confirmed 200\n");
  } else {
    const writeLatencies = [];
    let lastEvidence;
    const started = performance.now();
    for (let index = 0; index < loadCount; index += 1) {
      const writeStarted = performance.now();
      const issuedOrder = await exchange(
        sourcePort,
        "/orders",
        "POST",
        {
          authorization: `Bearer ${appToken}`,
          "content-type": "application/json",
          "cw-request-key": `load-${index}`,
        },
        JSON.stringify({ order: `load-${index}` }),
      );
      assert.equal(issuedOrder.status, 201);
      [lastEvidence] = parseContext([issuedOrder.headers["causal-context"]]);
      assert.ok(lastEvidence);
      writeLatencies.push(performance.now() - writeStarted);
    }
    const writesDoneMs = performance.now() - started;
    const requiredHeaders = {
      ...Object.fromEntries(requestHeaders([lastEvidence])),
      authorization: `Bearer ${appToken}`,
    };
    const deadline = performance.now() + 60_000;
    let pollCount = 0;
    while (true) {
      const observed = await exchange(viewPort, "/orders", "GET", requiredHeaders);
      pollCount += 1;
      if (observed.status === 200) {
        assert.equal(observed.headers["causal-result"], "satisfied");
        const state = JSON.parse(observed.body.toString("utf8"));
        assert.equal(state.orders.length, loadCount + 2);
        assert.equal(state.orders.at(-1), `load-${loadCount - 1}`);
        break;
      }
      assert.equal(observed.status, 412);
      assert.equal(observed.headers["causal-result"], "unsatisfied");
      if (performance.now() >= deadline) throw new Error("load confirmation deadline exceeded");
      await delay(50);
    }
    const confirmedMs = performance.now() - started;
    writeLatencies.sort((a, b) => a - b);
    const percentile = (fraction) =>
      writeLatencies[Math.ceil(writeLatencies.length * fraction) - 1];
    process.stdout.write(
      `${JSON.stringify({
        workload: "sequential HTTPS writes, authenticated delivery, confirmed view; two processes",
        node: process.version,
        count: loadCount,
        writesDoneMs,
        confirmedMs,
        confirmedOrdersPerSecond: (loadCount * 1000) / confirmedMs,
        writeP50Ms: percentile(0.5),
        writeP95Ms: percentile(0.95),
        confirmationPolls: pollCount,
      })}\n`,
    );
  }
} finally {
  await Promise.all([...services].map(stop));
  assert.ok(directory.startsWith(join(resolve(tmpdir()), "causalweb-quickstart-")));
  await rm(directory, { recursive: true });
}
