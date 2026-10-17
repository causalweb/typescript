import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { acceptConfirmation, parseContext, requestHeaders } from "../src/index.js";

type StartedService = Readonly<{
  child: ReturnType<typeof spawn>;
  origin: Promise<string>;
}>;
type TlsFixture = Readonly<{ key: string; certificate: string }>;
type SecureResponse = Readonly<{ status: number; body: Buffer }>;
type SourceEvent = Readonly<{
  id: string;
  position: string;
  order: string;
  issuedAt: string;
  expiresAt: string;
  evidence: string;
  deliveryProof: string;
}>;

function sourceEvent(value: unknown): SourceEvent {
  assert.ok(value && typeof value === "object");
  const event = value as Record<string, unknown>;
  for (const field of [
    "id",
    "position",
    "order",
    "issuedAt",
    "expiresAt",
    "evidence",
    "deliveryProof",
  ])
    assert.equal(typeof event[field], "string", `source event ${field} is not a string`);
  return event as unknown as SourceEvent;
}

function start(
  script: string,
  database: string,
  environment: NodeJS.ProcessEnv,
  tls?: TlsFixture,
): StartedService {
  const arguments_ = [script, "--database", database, "--now", "100", "--listen", "0"];
  if (tls) arguments_.push("--tls-key", tls.key, "--tls-cert", tls.certificate);
  const child = spawn(process.execPath, arguments_, {
    cwd: process.cwd(),
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.ok(child.stdout);
  return {
    child,
    origin: new Promise<string>((resolveOrigin, rejectOrigin) => {
      let output = "";
      const rejectEarlyExit = (code: number | null) =>
        rejectOrigin(new Error(`${script} exited before listening (${code})`));
      child.once("error", rejectOrigin);
      child.once("exit", rejectEarlyExit);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        output += chunk;
        const [line] = output.split("\n");
        if (!line?.startsWith(tls ? "https://" : "http://")) return;
        child.off("exit", rejectEarlyExit);
        resolveOrigin(line.trim());
      });
    }),
  };
}

async function secureRequest(
  origin: string,
  path: string,
  method: string,
  headers: Record<string, string>,
  certificate?: Buffer,
  body?: string,
): Promise<SecureResponse> {
  return new Promise((resolveResponse, rejectResponse) => {
    const request = httpsRequest(
      `${origin}${path}`,
      { method, headers, ca: certificate },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("error", rejectResponse);
        response.once("end", () =>
          resolveResponse({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }),
        );
      },
    );
    request.once("error", rejectResponse);
    request.end(body);
  });
}

async function stop(service: StartedService, origin: string): Promise<void> {
  const stopped =
    service.child.exitCode === null
      ? new Promise<void>((resolveExit) => service.child.once("exit", () => resolveExit()))
      : Promise.resolve();
  const response = await fetch(`${origin}/shutdown`, { method: "POST" });
  assert.equal(response.status, 204);
  await stopped;
}

async function issue(sourceOrigin: string, order: string): Promise<SourceEvent> {
  const response = await fetch(`${sourceOrigin}/orders/${order}`, { method: "POST" });
  assert.equal(response.status, 201);
  const value = sourceEvent(await response.json());
  const [token] = parseContext([response.headers.get("causal-context") ?? ""]);
  assert.equal(token, value.evidence);
  return value;
}

async function deliver(
  observerOrigin: string,
  event: SourceEvent,
  credential: string | null,
  suffix = "",
): Promise<Response> {
  const { deliveryProof, ...sourceEvent } = event;
  return fetch(`${observerOrigin}/deliver${suffix}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(credential === null ? {} : { authorization: `Bearer ${credential}` }),
    },
    body: JSON.stringify({ event: sourceEvent, proof: deliveryProof }),
  });
}

async function constrained(observerOrigin: string, evidence: string): Promise<Response> {
  return fetch(`${observerOrigin}/orders`, { headers: requestHeaders([evidence]) });
}

test("SQLite observer TLS requires its explicit test trust anchor", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "causalweb-sqlite-tls-"));
  const sourceDatabase = join(root, "source.sqlite");
  const observerDatabase = join(root, "observer.sqlite");
  const fixture = {
    key: resolve("test/fixtures/localhost-key.pem"),
    certificate: resolve("test/fixtures/localhost-cert.pem"),
  };
  const certificate = await readFile(fixture.certificate);
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const credential = "tls-test-delivery-credential";
  const source = start("scripts/sqlite-source-service.mjs", sourceDatabase, {
    ...process.env,
    CAUSALWEB_DEMO_PRIVATE_JWK: JSON.stringify(privateKey.export({ format: "jwk" })),
  });
  const observer = start(
    "scripts/sqlite-observer-service.mjs",
    observerDatabase,
    {
      ...process.env,
      CAUSALWEB_DEMO_PUBLIC_JWK: JSON.stringify(publicKey.export({ format: "jwk" })),
      CAUSALWEB_DEMO_DELIVERY_CREDENTIAL: credential,
    },
    fixture,
  );
  const sourceOrigin = await source.origin;
  const observerOrigin = await observer.origin;
  context.after(async () => {
    if (source.child.exitCode === null) await stop(source, sourceOrigin);
    if (observer.child.exitCode === null) {
      const stopped = new Promise<void>((resolveExit) =>
        observer.child.once("exit", () => resolveExit()),
      );
      const response = await secureRequest(observerOrigin, "/shutdown", "POST", {}, certificate);
      assert.equal(response.status, 204);
      await stopped;
    }
    assert.equal(resolve(root, ".."), resolve(tmpdir()));
    assert.ok(root.startsWith(join(resolve(tmpdir()), "causalweb-sqlite-tls-")));
    await rm(root, { recursive: true, force: true });
  });

  await assert.rejects(secureRequest(observerOrigin, "/orders", "GET", {}));
  const issued = await issue(sourceOrigin, "tls-first");
  const requireHeaders = Object.fromEntries(requestHeaders([issued.evidence]));
  const stale = await secureRequest(observerOrigin, "/orders", "GET", requireHeaders, certificate);
  assert.equal(stale.status, 412);
  const { deliveryProof, ...event } = issued;
  const delivered = await secureRequest(
    observerOrigin,
    "/deliver",
    "POST",
    { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    certificate,
    JSON.stringify({ event, proof: deliveryProof }),
  );
  assert.equal(delivered.status, 204);
  const confirmed = await secureRequest(
    observerOrigin,
    "/orders",
    "GET",
    requireHeaders,
    certificate,
  );
  assert.equal(confirmed.status, 200);
  assert.deepEqual(JSON.parse(confirmed.body.toString("utf8")), {
    orders: ["tls-first"],
    frontier: "1",
  });
});

test("independent SQLite source and observer processes preserve committed causal cuts", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "causalweb-sqlite-cross-process-"));
  const sourceDatabase = join(root, "source.sqlite");
  const observerDatabase = join(root, "observer.sqlite");
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const credential = "cross-process-test-credential";
  const sourceEnvironment = {
    ...process.env,
    CAUSALWEB_DEMO_PRIVATE_JWK: JSON.stringify(privateKey.export({ format: "jwk" })),
  };
  const observerEnvironment = {
    ...process.env,
    CAUSALWEB_DEMO_PUBLIC_JWK: JSON.stringify(publicKey.export({ format: "jwk" })),
    CAUSALWEB_DEMO_DELIVERY_CREDENTIAL: credential,
  };
  let source = start("scripts/sqlite-source-service.mjs", sourceDatabase, sourceEnvironment);
  let observer = start(
    "scripts/sqlite-observer-service.mjs",
    observerDatabase,
    observerEnvironment,
  );
  let sourceOrigin = await source.origin;
  let observerOrigin = await observer.origin;
  context.after(async () => {
    if (source.child.exitCode === null) await stop(source, sourceOrigin);
    if (observer.child.exitCode === null) await stop(observer, observerOrigin);
    assert.equal(resolve(root, ".."), resolve(tmpdir()));
    assert.ok(root.startsWith(join(resolve(tmpdir()), "causalweb-sqlite-cross-process-")));
    await rm(root, { recursive: true, force: true });
  });

  const first = await issue(sourceOrigin, "first");
  const stale = await constrained(observerOrigin, first.evidence);
  assert.equal(stale.status, 412, await stale.text());
  assert.equal((await deliver(observerOrigin, first, null)).status, 401);
  const staleAfterUnauthorizedDelivery = await constrained(observerOrigin, first.evidence);
  assert.equal(
    staleAfterUnauthorizedDelivery.status,
    412,
    await staleAfterUnauthorizedDelivery.text(),
  );
  const oversized = await fetch(`${observerOrigin}/deliver`, {
    method: "POST",
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    body: Buffer.alloc(16_385),
  });
  assert.equal(oversized.status, 413);
  const staleAfterOversizedDelivery = await constrained(observerOrigin, first.evidence);
  assert.equal(staleAfterOversizedDelivery.status, 412, await staleAfterOversizedDelivery.text());
  assert.equal(
    (await deliver(observerOrigin, { ...first, order: "altered" }, credential)).status,
    400,
  );
  const staleAfterInvalidProof = await constrained(observerOrigin, first.evidence);
  assert.equal(staleAfterInvalidProof.status, 412, await staleAfterInvalidProof.text());
  assert.equal(
    (await deliver(observerOrigin, first, credential, "?interrupt-before-commit")).status,
    400,
  );
  const staleAfterInterruptedApply = await constrained(observerOrigin, first.evidence);
  assert.equal(staleAfterInterruptedApply.status, 412, await staleAfterInterruptedApply.text());
  assert.equal((await deliver(observerOrigin, first, credential)).status, 204);
  const confirmedFirst = await constrained(observerOrigin, first.evidence);
  acceptConfirmation(confirmedFirst, true);
  assert.deepEqual(await confirmedFirst.json(), { orders: ["first"], frontier: "1" });

  const second = await issue(sourceOrigin, "second");
  const observerStopped = new Promise<number | null>((resolveExit) =>
    observer.child.once("exit", resolveExit),
  );
  await assert.rejects(deliver(observerOrigin, second, credential, "?crash-after-apply"));
  assert.equal(await observerStopped, 87);
  observer = start("scripts/sqlite-observer-service.mjs", observerDatabase, observerEnvironment);
  observerOrigin = await observer.origin;
  const confirmedAfterRestart = await constrained(observerOrigin, second.evidence);
  acceptConfirmation(confirmedAfterRestart, true);
  assert.deepEqual(await confirmedAfterRestart.json(), {
    orders: ["first", "second"],
    frontier: "2",
  });

  const interrupted = await fetch(`${sourceOrigin}/orders/interrupted?interrupt-after-commit`, {
    method: "POST",
  });
  assert.equal(interrupted.status, 500);
  assert.equal(interrupted.headers.get("causal-context"), null);
  const recovered: unknown = await (
    await fetch(`${sourceOrigin}/recover`, { method: "POST" })
  ).json();
  assert.ok(Array.isArray(recovered));
  assert.equal(recovered.length, 3);
  const recoveredEvent = sourceEvent(recovered.at(-1));
  const staleRecovered = await constrained(observerOrigin, recoveredEvent.evidence);
  assert.equal(staleRecovered.status, 412, await staleRecovered.text());
  assert.equal((await deliver(observerOrigin, recoveredEvent, credential)).status, 204);
  const confirmedRecovered = await constrained(observerOrigin, recoveredEvent.evidence);
  acceptConfirmation(confirmedRecovered, true);
  assert.deepEqual(await confirmedRecovered.json(), {
    orders: ["first", "second", "interrupted"],
    frontier: "3",
  });

  const fourth = await issue(sourceOrigin, "fourth");
  const fifth = await issue(sourceOrigin, "fifth");
  assert.equal((await deliver(observerOrigin, fifth, credential)).status, 204);
  const delayed = await constrained(observerOrigin, fifth.evidence);
  assert.equal(delayed.status, 412, await delayed.text());
  assert.equal((await deliver(observerOrigin, fourth, credential)).status, 204);
  assert.equal((await deliver(observerOrigin, fifth, credential)).status, 204);
  const confirmedFifth = await constrained(observerOrigin, fifth.evidence);
  acceptConfirmation(confirmedFifth, true);
  assert.deepEqual(await confirmedFifth.json(), {
    orders: ["first", "second", "interrupted", "fourth", "fifth"],
    frontier: "5",
  });

  const sourceStopped = new Promise<number | null>((resolveExit) =>
    source.child.once("exit", resolveExit),
  );
  await assert.rejects(
    fetch(`${sourceOrigin}/orders/sixth?crash-after-commit`, { method: "POST" }),
  );
  assert.equal(await sourceStopped, 86);
  source = start("scripts/sqlite-source-service.mjs", sourceDatabase, sourceEnvironment);
  sourceOrigin = await source.origin;
  const recoveredAfterCrash: unknown = await (
    await fetch(`${sourceOrigin}/recover`, { method: "POST" })
  ).json();
  assert.ok(Array.isArray(recoveredAfterCrash));
  assert.equal(recoveredAfterCrash.length, 6);
  const recoveredAfterCrashEvent = sourceEvent(recoveredAfterCrash.at(-1));
  const staleAfterSourceRestart = await constrained(
    observerOrigin,
    recoveredAfterCrashEvent.evidence,
  );
  assert.equal(staleAfterSourceRestart.status, 412, await staleAfterSourceRestart.text());
  assert.equal((await deliver(observerOrigin, recoveredAfterCrashEvent, credential)).status, 204);
  const confirmedAfterSourceRestart = await constrained(
    observerOrigin,
    recoveredAfterCrashEvent.evidence,
  );
  acceptConfirmation(confirmedAfterSourceRestart, true);
  assert.deepEqual(await confirmedAfterSourceRestart.json(), {
    orders: ["first", "second", "interrupted", "fourth", "fifth", "sixth"],
    frontier: "6",
  });
});
