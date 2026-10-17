import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  acceptConfirmation,
  Issuer,
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
console.log(
  "Rust -> TypeScript and TypeScript -> Rust signed evidence and HTTP field compatibility passed; stale, expired, forged, and tenant-mismatched requests fail closed (synthetic snapshots, not durable service integration)",
);
