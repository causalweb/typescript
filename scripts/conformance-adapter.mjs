import { createPublicKey } from "node:crypto";

import { PROFILE, Verifier } from "../dist/src/index.js";

let source = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  source += chunk;
});
process.stdin.on("end", () => {
  const input = JSON.parse(source);
  const testCase = input.case;
  const trust = input.trust;
  let outcome = "reject-request";
  try {
    if (input.version !== 1 || input.profile !== "evidence-verification-v1")
      throw new Error("unsupported conformance profile");
    const verifier = new Verifier(trust.audience, [
      {
        issuer: trust.issuer,
        keys: new Map([
          [trust.public_jwk.kid, createPublicKey({ key: trust.public_jwk, format: "jwk" })],
        ]),
        domains: new Set(trust.domains),
        maxLifetimeSeconds: BigInt(trust.maximum_lifetime_seconds),
        clockSkewSeconds: BigInt(trust.clock_skew_seconds),
      },
    ]);
    const now = BigInt(trust.now);
    const evidence = verifier.verify(testCase.compact, trust.subject, now);
    outcome = evidence.expired(now)
      ? "expired"
      : evidence.profile === PROFILE
        ? "accept"
        : "unsupported";
  } catch {
    // The adapter output is intentionally coarse: detailed diagnostics stay local.
  }
  process.stdout.write(`${JSON.stringify({ id: testCase.id, outcome })}\n`);
});
