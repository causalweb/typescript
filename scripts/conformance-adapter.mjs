import { createPublicKey, generateKeyPairSync, sign } from "node:crypto";

import { CLAIM, PROFILE, position, Snapshot, sourceKey, Verifier } from "../dist/src/index.js";

let source = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  source += chunk;
});
function evidenceResult(input) {
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
  return { id: testCase.id, outcome };
}

function signedEvidence(privateKey, claims) {
  const protectedHeader = Buffer.from(
    JSON.stringify({ alg: "ES256", kid: "prefix-conformance", typ: "cw-evidence+jwt" }),
  ).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const input = `${protectedHeader}.${payload}`;
  const signature = sign("sha256", Buffer.from(input), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${input}.${signature}`;
}

function prefixResult(input) {
  const vector = input.vector;
  const testCase = input.case;
  const issuer = "https://issuer.example";
  const audience = "https://verifier.example/causal";
  const subject = "opaque-tenant";
  if (
    input.version !== 1 ||
    input.profile !== "prefix-evaluation-v1" ||
    !vector ||
    typeof vector.domain_a !== "string" ||
    typeof vector.domain_b !== "string" ||
    !testCase ||
    typeof testCase.id !== "string"
  )
    throw new Error("invalid prefix conformance input");
  if (testCase.kind === "position-validation") {
    try {
      position(testCase.position);
      return { id: testCase.id, outcome: "accept" };
    } catch {
      return { id: testCase.id, outcome: "reject-request" };
    }
  }
  if (testCase.kind === "position-validation-and-comparison") {
    try {
      return {
        id: testCase.id,
        outcome:
          position(testCase.frontier) >= position(testCase.position) ? "satisfied" : "unsatisfied",
      };
    } catch {
      return { id: testCase.id, outcome: "reject-request" };
    }
  }
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const verifier = new Verifier(audience, [
    {
      issuer,
      keys: new Map([["prefix-conformance", publicKey]]),
      domains: new Set([vector.domain_a, vector.domain_b]),
      maxLifetimeSeconds: 86400n,
      clockSkewSeconds: 0n,
    },
  ]);
  const outcomes = testCase.requirements.map((requirement) => {
    const domain = vector[requirement.domain];
    if (typeof domain !== "string") throw new Error("unknown prefix domain alias");
    const claims = {
      iss: issuer,
      sub: subject,
      aud: audience,
      iat: 1,
      exp: requirement.expires_at ?? 1000,
      jti: `urn:prefix-conformance:${testCase.id}:${requirement.domain}`,
      [CLAIM]: {
        v: 1,
        profile: requirement.profile_supported === false ? "urn:test:unknown-profile" : PROFILE,
        domain,
        position: requirement.position,
        commit: "stable",
      },
    };
    const evidence = verifier.verify(signedEvidence(privateKey, claims), subject, 100n);
    const state = testCase.state;
    const lineage = new Map();
    if (!state.configured_domains || state.configured_domains.includes(requirement.domain)) {
      if (state.authorized_exclusions?.includes(requirement.domain)) {
        lineage.set(sourceKey(issuer, domain), {
          kind: "excluded",
          first: 0n,
          last: 18446744073709551615n,
        });
      } else {
        const selected = state.selected_state_frontiers ?? state.frontiers ?? {};
        const parseFrontier = (value) => (value === null ? null : position(value));
        const frontiers =
          state.component_frontiers?.[requirement.domain]?.map(parseFrontier) ??
          (state.lineage_available === false
            ? ["unknown"]
            : Object.hasOwn(selected, requirement.domain)
              ? [parseFrontier(selected[requirement.domain])]
              : ["unknown"]);
        const firstTerminalFailure = state.terminal_failures
          ?.filter((failure) => failure.domain === requirement.domain)
          .map((failure) => position(failure.position))
          .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))[0];
        lineage.set(sourceKey(issuer, domain), {
          kind: "relevant",
          frontiers,
          progressPossible: true,
          ...(firstTerminalFailure === undefined ? {} : { firstTerminalFailure }),
        });
      }
    }
    const evaluated = new Snapshot(
      "/orders/123",
      null,
      "contract/v1",
      "schema/v1",
      lineage,
    ).evaluate(evidence, 100n);
    return {
      outcome: evaluated.outcome,
      ...(evaluated.disposition ? { disposition: evaluated.disposition } : {}),
    };
  });
  return {
    id: testCase.id,
    outcomes,
    aggregate_success: outcomes.every((outcome) => outcome.outcome === "satisfied"),
  };
}

process.stdin.on("end", () => {
  try {
    const input = JSON.parse(source);
    const response =
      input.profile === "evidence-verification-v1" ? evidenceResult(input) : prefixResult(input);
    process.stdout.write(`${JSON.stringify(response)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
});
