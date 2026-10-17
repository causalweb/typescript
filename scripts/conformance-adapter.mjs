import { createPublicKey, generateKeyPairSync, sign } from "node:crypto";

import {
  acceptConfirmation,
  CLAIM,
  ObservationError,
  observe,
  PROFILE,
  parseContext,
  position,
  Snapshot,
  sourceKey,
  Verifier,
} from "../dist/src/index.js";

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

function httpResult(input) {
  const testCase = input.case;
  if (
    input.version !== 1 ||
    input.profile !== "http-client-confirmation-v1" ||
    !testCase ||
    typeof testCase.id !== "string" ||
    !testCase.response ||
    typeof testCase.response.status !== "number"
  )
    throw new Error("invalid HTTP conformance input");
  if (typeof testCase.request?.causal_require === "string") {
    let rejected = false;
    try {
      parseContext([testCase.request.causal_require]);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error("malformed requirement unexpectedly parsed");
  }
  if (typeof testCase.request?.evidence_count === "number") {
    let rejected = false;
    try {
      parseContext([Array(testCase.request.evidence_count).fill('"x"').join(", ")]);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error("oversized requirement set unexpectedly parsed");
  }
  const headers = new Headers();
  if (typeof testCase.response.causal_result === "string")
    headers.set("Causal-Result", testCase.response.causal_result);
  let confirmation = true;
  try {
    acceptConfirmation({ status: testCase.response.status, headers }, true);
  } catch {
    confirmation = false;
  }
  const result = {
    client_accepts_constrained_success:
      confirmation && testCase.response.status >= 200 && testCase.response.status <= 299,
    ...(typeof testCase.client_accepts_causal_confirmation === "boolean"
      ? { client_accepts_causal_confirmation: confirmation }
      : {}),
  };
  return { id: testCase.id, result };
}

function observerEvidence(privateKey, assumptions, testCase, requirement, index) {
  return signedEvidence(privateKey, {
    iss: assumptions.issuer,
    sub: assumptions.subject,
    aud: assumptions.audience,
    iat: 1,
    exp: requirement.expires_at ?? 1000,
    jti: `urn:observer-conformance:${testCase.id}:${index}`,
    [CLAIM]: {
      v: 1,
      profile: requirement.profile ?? PROFILE,
      domain: assumptions.domain,
      position: requirement.position,
      commit: "stable",
    },
  });
}

function observerLineage(assumptions, state) {
  const frontiers = state.frontiers.map((value) => {
    if (value === "unknown") return "unknown";
    return value === null ? null : position(value);
  });
  const mapping = {
    kind: "relevant",
    frontiers,
    progressPossible: state.progress_possible,
    ...(state.first_terminal_failure === undefined
      ? {}
      : { firstTerminalFailure: position(state.first_terminal_failure) }),
  };
  return new Map([[sourceKey(assumptions.issuer, assumptions.domain), mapping]]);
}

async function observerResult(input) {
  const vector = input.vector;
  const testCase = input.case;
  if (
    input.version !== 1 ||
    input.profile !== "http-observer-v1" ||
    !vector ||
    !vector.assumptions ||
    !testCase ||
    typeof testCase.id !== "string" ||
    !testCase.request ||
    !testCase.expected
  )
    throw new Error("invalid observer conformance input");
  const assumptions = vector.assumptions;
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const verifier = new Verifier(assumptions.audience, [
    {
      issuer: assumptions.issuer,
      keys: new Map([["prefix-conformance", publicKey]]),
      domains: new Set([assumptions.domain]),
      maxLifetimeSeconds: 86400n,
      clockSkewSeconds: 0n,
    },
  ]);
  const headers = new Headers();
  const request = testCase.request;
  if (request.connection_nominates_causal) headers.set("Connection", "causal-require");
  if (typeof request.raw_causal_require === "string") {
    headers.set("Causal-Require", request.raw_causal_require);
  } else if (typeof request.requirement_count === "number") {
    headers.set("Causal-Require", Array(request.requirement_count).fill('"x"').join(", "));
  } else {
    const requirements = request.requirements ?? [];
    requirements.forEach((requirement, index) => {
      headers.append(
        "Causal-Require",
        `"${observerEvidence(privateKey, assumptions, testCase, requirement, index)}"`,
      );
    });
  }
  let authorizationCalls = 0;
  let clockCalls = 0;
  let readCalls = 0;
  const authorize = () => {
    authorizationCalls += 1;
    return !(
      testCase.authorization === "deny-before-read" ||
      (testCase.authorization === "deny-before-response" && authorizationCalls > 1)
    );
  };
  const clock = () => {
    clockCalls += 1;
    return BigInt(
      clockCalls === 1
        ? assumptions.validation_time
        : (testCase.clock_after_read ?? assumptions.validation_time),
    );
  };
  const representation = testCase.representation ?? { status: 200, body: "unused" };
  const responseHeaders = new Headers();
  if (representation.causal_context) responseHeaders.set("Causal-Context", "not-evidence");
  const snapshot = new Snapshot(
    assumptions.target,
    {
      status: representation.status,
      headers: responseHeaders,
      body: Buffer.from(representation.body),
    },
    "contract/v1",
    "schema/v1",
    observerLineage(assumptions, testCase.state ?? { frontiers: [], progress_possible: false }),
  );
  let response;
  try {
    response = await observe({
      request: { method: request.method, headers },
      target: assumptions.target,
      designatedObservation: testCase.designated_observation !== false,
      verifier,
      subject: assumptions.subject,
      authorize,
      clock,
      read: () => {
        readCalls += 1;
        return snapshot;
      },
    });
  } catch (error) {
    if (!(error instanceof ObservationError)) throw error;
    response = error.toResponse();
  }
  const body = await response.text();
  const result = {
    status: response.status,
    causal_result: response.headers.get("Causal-Result"),
    cache_control: response.headers.get("Cache-Control"),
    read_calls: readCalls,
    ...(Object.hasOwn(testCase.expected, "vary_contains_causal_require")
      ? {
          vary_contains_causal_require:
            response.headers
              .get("Vary")
              ?.split(",")
              .some((value) => value.trim().toLowerCase() === "causal-require") === true,
        }
      : {}),
    ...(Object.hasOwn(testCase.expected, "context_removed")
      ? { context_removed: response.headers.get("Causal-Context") === null }
      : {}),
    ...(Object.hasOwn(testCase.expected, "body") ? { body } : {}),
    ...(Object.hasOwn(testCase.expected, "outcomes")
      ? { outcomes: JSON.parse(body).outcomes }
      : {}),
  };
  return { id: testCase.id, result };
}

process.stdin.on("end", async () => {
  try {
    const input = JSON.parse(source);
    const response =
      input.profile === "evidence-verification-v1"
        ? evidenceResult(input)
        : input.profile === "prefix-evaluation-v1"
          ? prefixResult(input)
          : input.profile === "http-client-confirmation-v1"
            ? httpResult(input)
            : await observerResult(input);
    process.stdout.write(`${JSON.stringify(response)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
});
