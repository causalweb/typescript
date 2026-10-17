import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    const projection = createServer((request, response) => {
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
    });
    const projectionOrigin = await new Promise((resolve, reject) => {
      projection.once("error", reject);
      projection.listen(0, "127.0.0.1", () => {
        const address = projection.address();
        assert.ok(address && typeof address !== "string");
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });
    assert.equal(typeof projectionOrigin, "string");
    try {
      const operation = await fetch(`${sourceOrigin}/orders/http-first`, { method: "POST" });
      assert.equal(operation.status, 201);
      const [token] = parseContext([operation.headers.get("causal-context") ?? ""]);
      assert.ok(token);
      const event = await operation.json();
      assert.equal(event.position, 1);
      const stale = await fetchObservation(`${projectionOrigin}/orders`, [token], {
        authenticated: () => true,
      });
      assert.equal(stale.kind, "causal-failure");
      if (stale.kind === "causal-failure")
        assert.equal(stale.problem.outcomes[0].outcome, "unsatisfied");
      const applied = persistentVerifier.verify(token, first.subject, 100n);
      assert.equal(applied.position, "1");
      writeProjection({ frontier: applied.position, orders: ["http-first"] });
      const confirmed = await fetchObservation(`${projectionOrigin}/orders`, [token], {
        authenticated: () => true,
      });
      assert.equal(confirmed.kind, "confirmed");
      if (confirmed.kind === "confirmed")
        assert.deepEqual(await confirmed.response.json(), {
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
console.log(
  `Rust -> TypeScript and TypeScript -> Rust signed evidence and HTTP field compatibility passed; stale, expired, forged, and tenant-mismatched requests fail closed.${
    persistentSourceChecked
      ? " TypeScript also verifies evidence issued and recovered from Rust's test-only local source outbox (not a durable service deployment)."
      : " The POSIX-only persistent-source fixture is not run on this platform."
  }`,
);
