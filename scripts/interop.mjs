import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createPublicKey, generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  acceptConfirmation,
  fetchObservation,
  Issuer,
  observe,
  parseContext,
  Snapshot,
  serializeContext,
  sourceKey,
  Verifier,
} from "../dist/src/index.js";

const rust = process.argv[2];
assert.ok(rust, "usage: npm run build && node scripts/interop.mjs PATH_TO_RUST_CHECKOUT");
assert.equal(
  execFileSync("git", ["-C", rust, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  readFileSync("RUST_REVISION", "utf8").trim(),
);
assert.equal(
  execFileSync("git", ["-C", rust, "status", "--porcelain"], { encoding: "utf8" }).trim(),
  "",
  "Rust peer checkout must be clean",
);
const cargo = process.platform === "win32" ? "cargo.exe" : "cargo";
const run = (example, input) =>
  JSON.parse(
    execFileSync(cargo, ["run", "--locked", "--quiet", "--example", example], {
      cwd: rust,
      encoding: "utf8",
      ...(input ? { input: JSON.stringify(input) } : {}),
    }),
  );

const fixture = run("wire_fixture");
assert.equal(fixture.synthetic_test_fixture, true);
const issuer = "https://issuer.example",
  domain = `${issuer}/domains/test`,
  audience = "https://verifier.example/causal",
  subject = "opaque-test-subject";
const verifier = new Verifier(audience, [
  {
    issuer,
    keys: new Map([["test-key", createPublicKey({ key: fixture.public_jwk, format: "jwk" })]]),
    domains: new Set([domain]),
    maxLifetimeSeconds: 86400n,
    clockSkewSeconds: 0n,
  },
]);
assert.deepEqual(parseContext([fixture.require_field]), [fixture.compact]);
const evidence = verifier.verify(fixture.compact, subject, 100n);
const cut = (frontier) =>
  new Snapshot(
    "/test",
    null,
    "interop/v1",
    "test-schema/v1",
    new Map([
      [
        sourceKey(issuer, domain),
        { kind: "relevant", frontiers: [frontier], progressPossible: true },
      ],
    ]),
  );
assert.equal(cut(4n).evaluate(evidence, 100n).outcome, "unsatisfied");
assert.equal(cut(5n).evaluate(evidence, 100n).outcome, "satisfied");
acceptConfirmation(
  { status: fixture.fresh_status, headers: new Headers({ "Causal-Result": fixture.result_field }) },
  true,
);

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const producer = new Issuer(issuer, "typescript-test-key", privateKey, new Set([domain]), 86400n);
const compact = producer.issueCommitted(
  { subject, audiences: [audience], domain, position: 5n, issuedAt: 1n, expiresAt: 1000n },
  100n,
);
const input = {
  issuer,
  subject,
  audience,
  domain,
  kid: "typescript-test-key",
  public_jwk: publicKey.export({ format: "jwk" }),
  compact,
  causal_require: serializeContext([compact]),
  now: 100,
  frontier: "4",
};
const stale = run("verify_fixture", input);
assert.equal(stale.status, 412);
assert.equal(stale.confirmed, false);
const current = run("verify_fixture", { ...input, frontier: "5" });
assert.equal(current.status, 200);
assert.equal(current.confirmed, true);
const expired = run("verify_fixture", { ...input, frontier: "5", now: 1000 });
assert.equal(expired.status, 412);
assert.equal(expired.confirmed, false);
const tenantMismatch = run("verify_fixture", { ...input, subject: "wrong-tenant", frontier: "5" });
assert.equal(tenantMismatch.status, 400);
assert.equal(tenantMismatch.causal_result, null);
const segments = compact.split(".");
segments[2] = (segments[2][0] === "A" ? "B" : "A") + segments[2].slice(1);
const forged = segments.join(".");
const invalid = run("verify_fixture", {
  ...input,
  compact: forged,
  causal_require: serializeContext([forged]),
  frontier: "5",
});
assert.equal(invalid.status, 400);
assert.equal(invalid.causal_result, null);

const persistentSourceChecked = process.platform !== "win32";
if (persistentSourceChecked) {
  const root = mkdtempSync(join(tmpdir(), "causalweb-rust-source-"));
  try {
    const { privateKey: persistentPrivateKey, publicKey: persistentPublicKey } =
      generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const privateJwk = persistentPrivateKey.export({ format: "jwk" });
    assert.equal(typeof privateJwk.d, "string");
    const deliveryCredential = randomBytes(32).toString("base64url");
    const persistentEnvironment = {
      ...process.env,
      CAUSALWEB_DEMO_PRIVATE_KEY: privateJwk.d,
    };
    const state = join(root, "source.json");
    const persistent = (arguments_) =>
      JSON.parse(
        execFileSync(
          cargo,
          [
            "run",
            "--locked",
            "--quiet",
            "--example",
            "persistent_source",
            "--",
            "--state",
            state,
            "--now",
            "100",
            ...arguments_,
          ],
          { cwd: rust, encoding: "utf8", env: persistentEnvironment },
        ),
      );
    const first = persistent(["--order", "first"]);
    assert.equal(first.test_only, true);
    assert.equal(first.event.position, 1);
    assert.equal(first.events.length, 1);
    const persistentVerifier = new Verifier(first.audience, [
      {
        issuer: first.issuer,
        keys: new Map([[first.kid, persistentPublicKey]]),
        domains: new Set([first.domain]),
        maxLifetimeSeconds: 3600n,
        clockSkewSeconds: 0n,
      },
    ]);
    const firstEvidence = persistentVerifier.verify(first.event.evidence, first.subject, 100n);
    const persistentCut = (frontier) =>
      new Snapshot(
        "/orders",
        null,
        "persistent-peer/v1",
        "orders/v1",
        new Map([
          [
            sourceKey(first.issuer, first.domain),
            { kind: "relevant", frontiers: [frontier], progressPossible: true },
          ],
        ]),
      );
    assert.equal(persistentCut(0n).evaluate(firstEvidence, 100n).outcome, "unsatisfied");
    assert.equal(persistentCut(1n).evaluate(firstEvidence, 100n).outcome, "satisfied");

    const interrupted = spawnSync(
      cargo,
      [
        "run",
        "--locked",
        "--quiet",
        "--example",
        "persistent_source",
        "--",
        "--state",
        state,
        "--now",
        "100",
        "--order",
        "recovered",
        "--interrupt-after-commit",
      ],
      { cwd: rust, encoding: "utf8", env: persistentEnvironment },
    );
    assert.notEqual(interrupted.status, 0, "injected interruption unexpectedly succeeded");
    assert.match(interrupted.stderr, /interruption after durable source commit/);
    const recovered = persistent(["--recover"]);
    assert.equal(recovered.events.length, 2);
    const recoveredEvent = recovered.events.at(-1);
    assert.ok(recoveredEvent?.evidence, "recovery did not issue outbox evidence");
    const recoveredEvidence = persistentVerifier.verify(
      recoveredEvent.evidence,
      first.subject,
      100n,
    );
    assert.equal(persistentCut(1n).evaluate(recoveredEvidence, 100n).outcome, "unsatisfied");
    assert.equal(persistentCut(2n).evaluate(recoveredEvidence, 100n).outcome, "satisfied");

    const sourceState = join(root, "http-source.json");
    const source = spawn(
      cargo,
      [
        "run",
        "--locked",
        "--quiet",
        "--example",
        "persistent_source",
        "--",
        "--state",
        sourceState,
        "--now",
        "100",
        "--listen",
        "127.0.0.1:0",
      ],
      { cwd: rust, env: persistentEnvironment, stdio: ["ignore", "pipe", "pipe"] },
    );
    assert.ok(source.stdout);
    const sourceOrigin = await new Promise((resolve, reject) => {
      let output = "";
      const rejectEarlyExit = (code) =>
        reject(new Error(`Rust source exited before listening (${code})`));
      source.once("error", reject);
      source.once("exit", rejectEarlyExit);
      source.stdout.setEncoding("utf8");
      source.stdout.on("data", (chunk) => {
        output += chunk;
        const [line] = output.split("\n");
        if (line?.startsWith("http://")) {
          source.off("exit", rejectEarlyExit);
          resolve(line.trim());
        }
      });
    });
    assert.equal(typeof sourceOrigin, "string");

    const projectionPath = join(root, "http-projection.json");
    const writeProjection = (state) => {
      const temporary = `${projectionPath}.tmp`;
      writeFileSync(temporary, JSON.stringify(state));
      renameSync(temporary, projectionPath);
    };
    writeProjection({ frontier: "0", orders: [] });
    const projectionSnapshot = () => {
      const state = JSON.parse(readFileSync(projectionPath, "utf8"));
      return new Snapshot(
        "/orders",
        {
          status: 200,
          headers: new Headers({ "Content-Type": "application/json" }),
          body: Buffer.from(JSON.stringify(state)),
        },
        "persistent-peer-http/v1",
        "orders/v1",
        new Map([
          [
            sourceKey(first.issuer, first.domain),
            { kind: "relevant", frontiers: [BigInt(state.frontier)], progressPossible: true },
          ],
        ]),
      );
    };
    const deliveryProofValid = (event, proof) => {
      if (typeof proof !== "string") return false;
      const [header, payload, signature, extra] = proof.split(".");
      if (!header || !payload || !signature || extra !== undefined) return false;
      try {
        const protectedHeader = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
        if (
          protectedHeader?.alg !== "ES256" ||
          protectedHeader?.kid !== first.kid ||
          protectedHeader?.typ !== "causalweb-demo-delivery+jwt" ||
          !isDeepStrictEqual(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")), event)
        )
          return false;
        return verify(
          "sha256",
          Buffer.from(`${header}.${payload}`),
          { key: persistentPublicKey, dsaEncoding: "ieee-p1363" },
          Buffer.from(signature, "base64url"),
        );
      } catch {
        return false;
      }
    };
    const deliverRustEvent = async (event, credential = deliveryCredential) => {
      const { deliveryProof, ...sourceEvent } = event;
      const response = await fetch(`${projectionOrigin}/deliver`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(credential === null ? {} : { authorization: `Bearer ${credential}` }),
        },
        body: JSON.stringify({ event: sourceEvent, proof: deliveryProof }),
      });
      return response.status;
    };
    const projectionHandler = (request, response) => {
      if (request.method === "POST" && request.url === "/deliver") {
        void (async () => {
          if (request.headers.authorization !== `Bearer ${deliveryCredential}`) {
            response.writeHead(401).end();
            return;
          }
          let body = "";
          for await (const chunk of request) {
            body += chunk;
            if (body.length > 16_384) {
              response.writeHead(413).end();
              return;
            }
          }
          try {
            const delivery = JSON.parse(body);
            if (!deliveryProofValid(delivery?.event, delivery?.proof))
              throw new Error("invalid proof");
            const applied = persistentVerifier.verify(delivery.event.evidence, first.subject, 100n);
            const state = JSON.parse(readFileSync(projectionPath, "utf8"));
            if (BigInt(applied.position) !== BigInt(state.frontier) + 1n)
              throw new Error("delivery is not next in source order");
            writeProjection({
              frontier: applied.position,
              orders: [...state.orders, delivery.event.order],
            });
            response.writeHead(204).end();
          } catch {
            response.writeHead(400).end();
          }
        })();
        return;
      }
      const headers = new Headers();
      for (let index = 0; index < request.rawHeaders.length; index += 2)
        headers.append(request.rawHeaders[index], request.rawHeaders[index + 1]);
      void observe({
        request: { method: request.method ?? "GET", headers },
        target: "/orders",
        designatedObservation: request.url === "/orders",
        verifier: persistentVerifier,
        subject: first.subject,
        authorize: () => true,
        clock: () => 100n,
        read: projectionSnapshot,
      })
        .then(async (result) => {
          response.writeHead(result.status, Object.fromEntries(result.headers));
          response.end(Buffer.from(await result.arrayBuffer()));
        })
        .catch(() => response.writeHead(500).end());
    };
    const startProjection = async () => {
      const server = createServer(projectionHandler);
      const origin = await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          assert.ok(address && typeof address !== "string");
          resolve(`http://127.0.0.1:${address.port}`);
        });
      });
      assert.equal(typeof origin, "string");
      return { server, origin };
    };
    let { server: projection, origin: projectionOrigin } = await startProjection();
    try {
      const operation = await fetch(`${sourceOrigin}/orders/http-first`, { method: "POST" });
      assert.equal(operation.status, 201);
      const [token] = parseContext([operation.headers.get("causal-context") ?? ""]);
      assert.ok(token);
      const event = await operation.json();
      assert.equal(event.position, 1);
      assert.equal(await deliverRustEvent(event, null), 401);
      const stale = await fetchObservation(`${projectionOrigin}/orders`, [token], {
        authenticated: () => true,
      });
      assert.equal(stale.kind, "causal-failure");
      if (stale.kind === "causal-failure")
        assert.equal(stale.problem.outcomes[0].outcome, "unsatisfied");
      assert.equal(await deliverRustEvent({ ...event, order: "altered" }), 400);
      assert.equal(await deliverRustEvent(event), 204);
      const confirmed = await fetchObservation(`${projectionOrigin}/orders`, [token], {
        authenticated: () => true,
      });
      assert.equal(confirmed.kind, "confirmed");
      if (confirmed.kind === "confirmed")
        assert.deepEqual(await confirmed.response.json(), {
          frontier: "1",
          orders: ["http-first"],
        });
      await new Promise((resolve) => projection.close(resolve));
      ({ server: projection, origin: projectionOrigin } = await startProjection());
      const confirmedAfterRestart = await fetchObservation(`${projectionOrigin}/orders`, [token], {
        authenticated: () => true,
      });
      assert.equal(confirmedAfterRestart.kind, "confirmed");
      if (confirmedAfterRestart.kind === "confirmed")
        assert.deepEqual(await confirmedAfterRestart.response.json(), {
          frontier: "1",
          orders: ["http-first"],
        });
      const shutdown = await fetch(`${sourceOrigin}/shutdown`, { method: "POST" });
      assert.equal(shutdown.status, 204);
      await new Promise((resolve) => source.once("exit", resolve));
    } finally {
      await new Promise((resolve) => projection.close(resolve));
      if (source.exitCode === null) source.kill();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (persistentSourceChecked) {
  const root = mkdtempSync(join(tmpdir(), "causalweb-typescript-source-rust-observer-"));
  let source;
  let observer;
  try {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const privateJwk = privateKey.export({ format: "jwk" });
    const publicJwk = publicKey.export({ format: "jwk" });
    const deliveryCredential = randomBytes(32).toString("base64url");
    const sourceEnvironment = {
      ...process.env,
      CAUSALWEB_DEMO_PRIVATE_JWK: JSON.stringify(privateJwk),
    };
    const observerEnvironment = {
      ...process.env,
      CAUSALWEB_DEMO_PUBLIC_JWK: JSON.stringify(publicJwk),
      CAUSALWEB_DEMO_DELIVERY_CREDENTIAL: deliveryCredential,
    };
    const waitForOrigin = (child, name) =>
      new Promise((resolve, reject) => {
        let output = "";
        const rejectEarlyExit = (code) =>
          reject(new Error(`${name} exited before listening (${code})`));
        child.once("error", reject);
        child.once("exit", rejectEarlyExit);
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          output += chunk;
          const [line] = output.split("\n");
          if (line?.startsWith("http://")) {
            child.off("exit", rejectEarlyExit);
            resolve(line.trim());
          }
        });
      });
    const startSource = async () => {
      source = spawn(
        process.execPath,
        [
          "scripts/persistent-source-service.mjs",
          "--state",
          join(root, "source.json"),
          "--now",
          "100",
          "--listen",
          "0",
        ],
        { cwd: process.cwd(), env: sourceEnvironment, stdio: ["ignore", "pipe", "pipe"] },
      );
      return waitForOrigin(source, "TypeScript source");
    };
    const startObserver = async () => {
      observer = spawn(
        cargo,
        [
          "run",
          "--locked",
          "--quiet",
          "--example",
          "persistent_observer",
          "--",
          "--state",
          join(root, "projection.json"),
          "--now",
          "100",
          "--listen",
          "127.0.0.1:0",
        ],
        { cwd: rust, env: observerEnvironment, stdio: ["ignore", "pipe", "pipe"] },
      );
      return waitForOrigin(observer, "Rust observer");
    };
    const deliver = async (origin, event, path = "/deliver", credential = deliveryCredential) => {
      const { deliveryProof, ...sourceEvent } = event;
      assert.equal(typeof deliveryProof, "string", "source event lacks a delivery proof");
      const response = await fetch(`${origin}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(credential === null ? {} : { authorization: `Bearer ${credential}` }),
        },
        body: JSON.stringify({ event: sourceEvent, proof: deliveryProof }),
      });
      return response.status;
    };
    const waitForExit = (child) =>
      child.exitCode === null
        ? new Promise((resolve) => child.once("exit", resolve))
        : Promise.resolve(child.exitCode);
    const stop = async (child, origin) => {
      const response = await fetch(`${origin}/shutdown`, { method: "POST" });
      assert.equal(response.status, 204);
      await new Promise((resolve) => child.once("exit", resolve));
    };

    let sourceOrigin = await startSource();
    let observerOrigin = await startObserver();
    assert.equal(typeof sourceOrigin, "string");
    assert.equal(typeof observerOrigin, "string");

    const firstOperation = await fetch(`${sourceOrigin}/orders/first`, { method: "POST" });
    assert.equal(firstOperation.status, 201);
    const first = await firstOperation.json();
    const [firstEvidence] = parseContext([firstOperation.headers.get("causal-context") ?? ""]);
    assert.equal(firstEvidence, first.evidence);
    const stale = await fetchObservation(`${observerOrigin}/orders`, [firstEvidence], {
      authenticated: () => true,
    });
    assert.equal(stale.kind, "causal-failure");
    if (stale.kind === "causal-failure")
      assert.equal(stale.problem.outcomes[0].outcome, "unsatisfied");
    assert.equal(
      await deliver(observerOrigin, first, "/deliver", null),
      401,
      "unauthenticated delivery must not advance the projection",
    );
    const stillStale = await fetchObservation(`${observerOrigin}/orders`, [firstEvidence], {
      authenticated: () => true,
    });
    assert.equal(stillStale.kind, "causal-failure");
    assert.equal(
      await deliver(observerOrigin, { ...first, order: "altered" }),
      400,
      "a proof must not authorize an altered event payload",
    );
    const observerCrash = waitForExit(observer);
    await assert.rejects(deliver(observerOrigin, first, "/deliver?crash-after-apply"));
    assert.equal(await observerCrash, 86);
    observerOrigin = await startObserver();
    const confirmedFirst = await fetchObservation(`${observerOrigin}/orders`, [firstEvidence], {
      authenticated: () => true,
    });
    assert.equal(confirmedFirst.kind, "confirmed");
    if (confirmedFirst.kind === "confirmed")
      assert.deepEqual(await confirmedFirst.response.json(), { frontier: "1", orders: ["first"] });

    await stop(source, sourceOrigin);
    sourceOrigin = await startSource();
    const second = await (await fetch(`${sourceOrigin}/orders/second`, { method: "POST" })).json();
    const third = await (await fetch(`${sourceOrigin}/orders/third`, { method: "POST" })).json();
    assert.equal(await deliver(observerOrigin, third), 204);
    const secondStale = await fetchObservation(`${observerOrigin}/orders`, [third.evidence], {
      authenticated: () => true,
    });
    assert.equal(secondStale.kind, "causal-failure");
    assert.equal(await deliver(observerOrigin, second), 204);
    assert.equal(await deliver(observerOrigin, second), 204, "duplicate delivery must be harmless");
    const confirmedThird = await fetchObservation(`${observerOrigin}/orders`, [third.evidence], {
      authenticated: () => true,
    });
    assert.equal(confirmedThird.kind, "confirmed");
    if (confirmedThird.kind === "confirmed")
      assert.deepEqual(await confirmedThird.response.json(), {
        frontier: "3",
        orders: ["first", "second", "third"],
      });

    await stop(observer, observerOrigin);
    observerOrigin = await startObserver();
    const afterRestart = await fetchObservation(`${observerOrigin}/orders`, [third.evidence], {
      authenticated: () => true,
    });
    assert.equal(afterRestart.kind, "confirmed");
    const forged = `${third.evidence.slice(0, -1)}${third.evidence.endsWith("A") ? "B" : "A"}`;
    assert.equal(await deliver(observerOrigin, { ...third, evidence: forged }), 400);

    const sourceCrash = waitForExit(source);
    await assert.rejects(
      fetch(`${sourceOrigin}/orders/recovered?crash-after-commit`, { method: "POST" }),
    );
    assert.equal(await sourceCrash, 86);
    sourceOrigin = await startSource();
    const recovered = await (await fetch(`${sourceOrigin}/recover`, { method: "POST" })).json();
    const recoveredEvent = recovered.at(-1);
    assert.ok(recoveredEvent?.evidence, "source recovery did not issue outbox evidence");
    const staleRecovered = await fetchObservation(
      `${observerOrigin}/orders`,
      [recoveredEvent.evidence],
      {
        authenticated: () => true,
      },
    );
    assert.equal(staleRecovered.kind, "causal-failure");
    assert.equal(await deliver(observerOrigin, recoveredEvent), 204);
    const confirmedRecovered = await fetchObservation(
      `${observerOrigin}/orders`,
      [recoveredEvent.evidence],
      { authenticated: () => true },
    );
    assert.equal(confirmedRecovered.kind, "confirmed");
    if (confirmedRecovered.kind === "confirmed")
      assert.deepEqual(await confirmedRecovered.response.json(), {
        frontier: "4",
        orders: ["first", "second", "third", "recovered"],
      });

    const terminal = await (
      await fetch(`${sourceOrigin}/orders/terminal`, { method: "POST" })
    ).json();
    assert.equal(await deliver(observerOrigin, terminal, "/terminal"), 204);
    const failed = await fetchObservation(`${observerOrigin}/orders`, [terminal.evidence], {
      authenticated: () => true,
    });
    assert.equal(failed.kind, "causal-failure");
    if (failed.kind === "causal-failure")
      assert.equal(failed.problem.outcomes[0].outcome, "failed");
    const stillCovered = await fetchObservation(
      `${observerOrigin}/orders`,
      [recoveredEvent.evidence],
      {
        authenticated: () => true,
      },
    );
    assert.equal(stillCovered.kind, "confirmed");

    await stop(observer, observerOrigin);
    observerOrigin = await startObserver();
    const failedAfterRestart = await fetchObservation(
      `${observerOrigin}/orders`,
      [terminal.evidence],
      {
        authenticated: () => true,
      },
    );
    assert.equal(failedAfterRestart.kind, "causal-failure");
    if (failedAfterRestart.kind === "causal-failure")
      assert.equal(failedAfterRestart.problem.outcomes[0].outcome, "failed");

    const unknown = await (
      await fetch(`${sourceOrigin}/orders/unknown`, { method: "POST" })
    ).json();
    assert.equal(await deliver(observerOrigin, unknown, "/unknown"), 204);
    const unknownResult = await fetchObservation(`${observerOrigin}/orders`, [unknown.evidence], {
      authenticated: () => true,
    });
    assert.equal(unknownResult.kind, "causal-failure");
    if (unknownResult.kind === "causal-failure")
      assert.equal(unknownResult.problem.outcomes[0].outcome, "unknown");

    await stop(observer, observerOrigin);
    observerOrigin = await startObserver();
    const unknownAfterRestart = await fetchObservation(
      `${observerOrigin}/orders`,
      [unknown.evidence],
      {
        authenticated: () => true,
      },
    );
    assert.equal(unknownAfterRestart.kind, "causal-failure");
    if (unknownAfterRestart.kind === "causal-failure")
      assert.equal(unknownAfterRestart.problem.outcomes[0].outcome, "unknown");

    await stop(source, sourceOrigin);
    await stop(observer, observerOrigin);
  } finally {
    if (source?.exitCode === null) source.kill();
    if (observer?.exitCode === null) observer.kill();
    rmSync(root, { recursive: true, force: true });
  }
}
console.log(
  `Rust -> TypeScript and TypeScript -> Rust signed evidence and HTTP field compatibility passed; stale, expired, forged, and tenant-mismatched requests fail closed.${
    persistentSourceChecked
      ? " TypeScript also verifies evidence issued and recovered from Rust's test-only local source outbox (not a durable service deployment)."
      : " The POSIX-only persistent-source fixture is not run on this platform."
  }`,
);
