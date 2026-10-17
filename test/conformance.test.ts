import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import {
  acceptConfirmation,
  CLAIM,
  type Frontier,
  Issuer,
  type Mapping,
  ObservationError,
  observe,
  PROFILE,
  ProtocolError,
  parseContext,
  position,
  type Representation,
  requestHeaders,
  Snapshot,
  serializeContext,
  sourceKey,
  Verifier,
} from "../src/index.js";
import { fixture } from "./fixtures.js";

const ISSUER = "https://issuer.example",
  DOMAIN = `${ISSUER}/domains/a`,
  OTHER = `${ISSUER}/domains/b`;
const SUBJECT = "opaque-tenant",
  AUDIENCE = "https://verifier.example/causal",
  TARGET = "/orders/123";
const claims = (p = "5") => ({
  iss: ISSUER,
  sub: SUBJECT,
  aud: AUDIENCE,
  iat: 1,
  exp: 1000,
  jti: "urn:test:synthetic",
  [CLAIM]: { v: 1, profile: PROFILE, domain: DOMAIN, position: p, commit: "stable" },
});
const header = () => ({ alg: "ES256", kid: "test-key", typ: "cw-evidence+jwt" });
const pair = () => generateKeyPairSync("ec", { namedCurve: "prime256v1" });
function rawSign(
  privateKey: ReturnType<typeof pair>["privateKey"],
  payload: string | Buffer,
  h = JSON.stringify(header()),
): string {
  const input = `${Buffer.from(h).toString("base64url")}.${Buffer.from(payload).toString("base64url")}`;
  return `${input}.${sign("sha256", Buffer.from(input), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}
function verifier(publicKey: ReturnType<typeof pair>["publicKey"], skew = 0n): Verifier {
  return new Verifier(AUDIENCE, [
    {
      issuer: ISSUER,
      keys: new Map([["test-key", publicKey]]),
      domains: new Set([DOMAIN, OTHER]),
      maxLifetimeSeconds: 86400n,
      clockSkewSeconds: skew,
    },
  ]);
}
function snapshot(
  frontiers: readonly Frontier[],
  representation?: Representation,
): Snapshot<Representation> {
  return new Snapshot(
    TARGET,
    representation ?? { status: 200, headers: new Headers(), body: Buffer.from("indexed") },
    "contract/v1",
    "schema/v1",
    new Map([[sourceKey(ISSUER, DOMAIN), { kind: "relevant", frontiers, progressPossible: true }]]),
  );
}

for (const [name, count] of [
  ["jws-evidence.json", 6],
  ["evidence-validation.json", 26],
] as const) {
  test(`all ${count} pinned ${name} fixtures`, () => {
    const file = fixture(name);
    const consumer = new Verifier(file.expected_audience, [
      {
        issuer: file.expected_issuer,
        keys: new Map([
          [file.public_jwk.kid, createPublicKey({ key: file.public_jwk, format: "jwk" })],
        ]),
        domains: new Set(file.authorized_domains ?? ["https://issuer.example/domains/orders/2026"]),
        maxLifetimeSeconds: BigInt(file.max_lifetime_seconds ?? 86400),
        clockSkewSeconds: BigInt(file.clock_skew_seconds ?? 0),
      },
    ]);
    assert.equal(file.cases.length, count);
    for (const entry of file.cases) {
      if (entry.expected === "reject-request")
        assert.throws(
          () => consumer.verify(entry.compact, file.expected_subject, BigInt(file.validation_time)),
          ProtocolError,
          entry.id,
        );
      else {
        const evidence = consumer.verify(
          entry.compact,
          file.expected_subject,
          BigInt(file.validation_time),
        );
        if (entry.expected === "accept")
          assert.equal(evidence.expired(BigInt(file.validation_time)), false, entry.id);
        else if (entry.expected === "expired")
          assert.equal(evidence.expired(BigInt(file.validation_time)), true, entry.id);
        else if (entry.expected === "unsupported")
          assert.equal(
            snapshot([5n]).evaluate(evidence, BigInt(file.validation_time)).outcome,
            "unsupported",
            entry.id,
          );
        else assert.fail(`unrecognized expected result ${entry.id}`);
      }
    }
  });
}

test("all twenty pinned prefix/composition fixtures", () => {
  const vectors = fixture("prefix-evaluation.json"),
    keys = pair(),
    consumer = verifier(keys.publicKey);
  assert.equal(vectors.cases.length, 20);
  const frontier = (v: string | null | undefined): Frontier => {
    if (v === null) return null;
    assert.ok(typeof v === "string", "fixture frontier must be a position or bottom");
    return position(v);
  };
  for (const entry of vectors.cases) {
    if (entry.kind === "position-validation") {
      assert.equal(entry.expected, "reject-request");
      assert.throws(() => position(entry.position), ProtocolError, entry.id);
      continue;
    }
    if (entry.kind === "position-validation-and-comparison") {
      assert.equal(entry.expected, "satisfied");
      assert.ok(position(entry.frontier) >= position(entry.position), entry.id);
      continue;
    }
    if (entry.kind === "context-reduction") {
      const retained = entry.evidence.map((e) => e.position);
      assert.ok(
        entry.allowed_retained_positions.some(
          (allowed) => JSON.stringify(allowed) === JSON.stringify(retained),
        ),
        entry.id,
      );
      continue;
    }
    const state = entry.state,
      outcomes = [];
    for (const requirement of entry.requirements) {
      const alias = requirement.domain,
        domain = vectors[alias],
        c = claims(requirement.position);
      c[CLAIM].domain = domain;
      c.exp = requirement.expires_at ?? 1000;
      if (requirement.profile_supported === false) c[CLAIM].profile = "urn:test:unknown-profile";
      const evidence = consumer.verify(rawSign(keys.privateKey, JSON.stringify(c)), SUBJECT, 100n);
      const lineage = new Map<string, Mapping>();
      if (!state.configured_domains || state.configured_domains.includes(alias)) {
        if (state.authorized_exclusions?.includes(alias))
          lineage.set(sourceKey(ISSUER, domain), {
            kind: "excluded",
            first: 0n,
            last: 18446744073709551615n,
          });
        else {
          const all = state.selected_state_frontiers ?? state.frontiers ?? {};
          const frontiers =
            state.component_frontiers?.[alias]?.map(frontier) ??
            (state.lineage_available === false
              ? ["unknown"]
              : Object.hasOwn(all, alias)
                ? [frontier(all[alias])]
                : ["unknown"]);
          const failures = (state.terminal_failures ?? [])
            .filter((f) => f.domain === alias)
            .map((f) => position(f.position));
          const failure = failures.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[0];
          lineage.set(sourceKey(ISSUER, domain), {
            kind: "relevant",
            frontiers,
            progressPossible: true,
            ...(failure !== undefined ? { firstTerminalFailure: failure } : {}),
          });
        }
      }
      const evaluated = new Snapshot(TARGET, null, "contract/v1", "schema/v1", lineage).evaluate(
        evidence,
        100n,
      );
      outcomes.push({
        outcome: evaluated.outcome,
        ...(evaluated.disposition ? { disposition: evaluated.disposition } : {}),
      });
    }
    assert.deepEqual(outcomes, entry.expected, entry.id);
    assert.equal(
      outcomes.every((o) => o.outcome === "satisfied"),
      entry.aggregate_success,
      entry.id,
    );
  }
});

test("all twelve pinned HTTP response fixtures", () => {
  const vectors = fixture("http-outcomes.json");
  assert.equal(vectors.cases.length, 12);
  for (const entry of vectors.cases) {
    const response = { status: entry.response.status, headers: new Headers() };
    if (entry.response.causal_result != null)
      response.headers.set("Causal-Result", entry.response.causal_result);
    let confirmed = true;
    try {
      acceptConfirmation(response, true);
    } catch (error) {
      assert.ok(error instanceof ProtocolError);
      confirmed = false;
    }
    assert.equal(
      confirmed && response.status >= 200 && response.status <= 299,
      entry.client_accepts_constrained_success,
      entry.id,
    );
    if (entry.client_accepts_causal_confirmation !== undefined)
      assert.equal(confirmed, entry.client_accepts_causal_confirmation, entry.id);
    const requireField = entry.request?.causal_require;
    if (requireField) assert.throws(() => parseContext([requireField]), ProtocolError);
    if (entry.id === "HTTP-008")
      assert.throws(() => parseContext([Array(17).fill('"x"').join(", ")]), { code: "too-large" });
  }
});

test("issuer, stale observation, covered observation, and client confirmation", async () => {
  const keys = pair(),
    consumer = verifier(keys.publicKey),
    producer = new Issuer(ISSUER, "test-key", keys.privateKey, new Set([DOMAIN]), 86400n);
  const token = producer.issueCommitted(
    {
      subject: SUBJECT,
      audiences: [AUDIENCE],
      domain: DOMAIN,
      position: 5n,
      issuedAt: 1n,
      expiresAt: 1000n,
    },
    100n,
  );
  const request = { method: "GET", headers: requestHeaders([token]) };
  const stale = await observe({
    request,
    target: TARGET,
    designatedObservation: true,
    verifier: consumer,
    subject: SUBJECT,
    authorize: () => true,
    clock: () => 100n,
    read: () => snapshot([4n]),
  });
  assert.equal(stale.status, 412);
  assert.throws(() => acceptConfirmation(stale, true));
  const fresh = await observe({
    request,
    target: TARGET,
    designatedObservation: true,
    verifier: consumer,
    subject: SUBJECT,
    authorize: () => true,
    clock: () => 100n,
    read: () => snapshot([5n]),
  });
  acceptConfirmation(fresh, true);
  assert.equal(await fresh.text(), "indexed");
  assert.equal(fresh.headers.get("cache-control"), "private, no-store");
});

test("canonical encodings, nested duplicates, and exact NumericDates", () => {
  const keys = pair(),
    consumer = verifier(keys.publicKey),
    base = JSON.stringify(claims());
  for (const extra of [
    ',"extension":{"x":1,"x":2}',
    ',"extension":[{"x":1,"\\u0078":2}]',
    ',"\\u0069ss":"https://issuer.example"',
  ]) {
    assert.throws(
      () =>
        consumer.verify(rawSign(keys.privateKey, `${base.slice(0, -1)}${extra}}`), SUBJECT, 100n),
      ProtocolError,
    );
  }
  for (const value of ["1.0", "1e0", "100e-2", "0.1e1"]) {
    assert.doesNotThrow(() =>
      consumer.verify(
        rawSign(keys.privateKey, base.replace('"iat":1', `"iat":${value}`)),
        SUBJECT,
        100n,
      ),
    );
  }
  for (const value of ["1.5", "9007199254740990.5", "1e9999", "-1", "1e-9999"]) {
    assert.throws(
      () =>
        consumer.verify(
          rawSign(keys.privateKey, base.replace('"iat":1', `"iat":${value}`)),
          SUBJECT,
          100n,
        ),
      ProtocolError,
    );
  }
  const token = rawSign(keys.privateKey, base),
    segments = token.split(".");
  segments[0] += "=";
  assert.throws(() => consumer.verify(segments.join("."), SUBJECT, 100n), ProtocolError);
  assert.throws(
    () => consumer.verify(rawSign(keys.privateKey, Buffer.from([0xff])), SUBJECT, 100n),
    ProtocolError,
  );
});

test("unauthorized and invalid evidence never selects state", async () => {
  const keys = pair(),
    consumer = verifier(keys.publicKey);
  let read = false;
  for (const [token, subject] of [
    ["not-a-jws", SUBJECT],
    [rawSign(keys.privateKey, JSON.stringify(claims())), "another-tenant"],
  ] as const) {
    const response = await observe({
      request: { method: "GET", headers: requestHeaders([token]) },
      target: TARGET,
      designatedObservation: true,
      verifier: consumer,
      subject,
      authorize: () => true,
      clock: () => 100n,
      read: () => {
        read = true;
        return snapshot([5n]);
      },
    });
    assert.equal(response.status, 400);
    assert.equal(read, false);
    const body = await response.text();
    assert.ok(!body.includes("outcomes") && !body.includes(ISSUER));
  }
});

test("expiry, authorization, target, and Vary are checked at response commitment", async () => {
  const keys = pair(),
    consumer = verifier(keys.publicKey),
    c = claims();
  c.exp = 101;
  const request = {
    method: "GET",
    headers: requestHeaders([rawSign(keys.privateKey, JSON.stringify(c))]),
  };
  let ticks = 0;
  const expired = await observe({
    request,
    target: TARGET,
    designatedObservation: true,
    verifier: consumer,
    subject: SUBJECT,
    authorize: () => true,
    clock: () => (++ticks === 1 ? 100n : 101n),
    read: () => snapshot([5n]),
  });
  assert.equal(expired.status, 412);
  assert.equal((await expired.json()).outcomes[0].outcome, "expired");
  let checks = 0;
  const denied = await observe({
    request,
    target: TARGET,
    designatedObservation: true,
    verifier: consumer,
    subject: SUBJECT,
    authorize: () => ++checks === 1,
    clock: () => 100n,
    read: () => snapshot([5n]),
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.has("causal-result"), false);
  for (const status of [200, 404, 410]) {
    const response = await observe({
      request,
      target: TARGET,
      designatedObservation: true,
      verifier: consumer,
      subject: SUBJECT,
      authorize: () => true,
      clock: () => 100n,
      read: () =>
        snapshot([5n], { status, headers: new Headers({ Vary: "*" }), body: new Uint8Array() }),
    });
    assert.equal(response.status, status);
    assert.equal(response.headers.get("vary"), "*");
    acceptConfirmation(response, true);
  }
});

test("structured fields preserve all evidence and reject prohibited forms", () => {
  for (const field of ["", "()", "token", "123", '"x";a', '"x",', '"unterminated', '"bad\\escape"'])
    assert.throws(() => parseContext([field]), ProtocolError, field);
  const tokens = ["opaque-a", "opaque-b", "opaque-a"];
  assert.deepEqual(parseContext([serializeContext(tokens)]), tokens);
  assert.deepEqual(parseContext(['"a"', '"b"']), ["a", "b"]);
});

test("authorization outages retain local causes and convert to safe responses at both checks", async () => {
  const keys = pair(),
    consumer = verifier(keys.publicKey);
  const request = {
    method: "GET",
    headers: requestHeaders([rawSign(keys.privateKey, JSON.stringify(claims()))]),
  };
  for (const failAt of [1, 2]) {
    for (const asynchronous of [false, true]) {
      let checks = 0,
        reads = 0;
      const failure = new Error("private authorization backend credential");
      let local: ObservationError | undefined;
      await assert.rejects(
        observe({
          request,
          target: TARGET,
          designatedObservation: true,
          verifier: consumer,
          subject: SUBJECT,
          authorize: () => {
            if (++checks !== failAt) return true;
            if (asynchronous) return Promise.reject(failure);
            throw failure;
          },
          clock: () => 100n,
          read: () => {
            reads++;
            return snapshot([5n]);
          },
        }),
        (error) => {
          assert.ok(error instanceof ObservationError);
          assert.equal(error.code, "authorization-unavailable");
          assert.equal(error.phase, failAt === 1 ? "before-read" : "before-response");
          assert.equal(error.cause, failure);
          assert.ok(!JSON.stringify(error).includes("private"));
          assert.ok(!error.message.includes("private"));
          local = error;
          return true;
        },
      );
      assert.ok(local);
      const response = local.toResponse();
      assert.equal(response.status, 503);
      assert.equal(response.headers.has("causal-result"), false);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(await response.text(), "");
      assert.equal(reads, failAt === 1 ? 0 : 1);
    }
  }
  await assert.rejects(
    observe({
      request,
      target: TARGET,
      designatedObservation: true,
      verifier: consumer,
      subject: SUBJECT,
      authorize: (() => "yes") as unknown as () => boolean,
      clock: () => 100n,
      read: () => {
        throw new Error("must not read");
      },
    }),
    { code: "authorization-unavailable", phase: "before-read" },
  );
});

test("read and clock failures preserve diagnostics instead of becoming causal outcomes", async () => {
  const keys = pair(),
    consumer = verifier(keys.publicKey);
  const request = {
    method: "GET",
    headers: requestHeaders([rawSign(keys.privateKey, JSON.stringify(claims()))]),
  };
  const base = {
    request,
    target: TARGET,
    designatedObservation: true,
    verifier: consumer,
    subject: SUBJECT,
    authorize: () => true,
    clock: () => 100n,
    read: () => snapshot([5n]),
  };
  const cause = new Error("private backend password");
  for (const asynchronous of [false, true]) {
    let local: ObservationError | undefined;
    await assert.rejects(
      observe({
        ...base,
        read: () => {
          if (asynchronous) return Promise.reject(cause);
          throw cause;
        },
      }),
      (error) => {
        assert.ok(error instanceof ObservationError);
        assert.equal(error.code, "read-unavailable");
        assert.equal(error.phase, "read");
        assert.equal(error.cause, cause);
        local = error;
        return true;
      },
    );
    assert.ok(local);
    const response = local.toResponse();
    assert.equal(response.status, 503);
    assert.equal(response.headers.has("causal-result"), false);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(await response.text(), "");
  }
  for (const thrown of [
    null,
    "non-Error adapter rejection",
    new ProtocolError("invalid-evidence"),
  ]) {
    await assert.rejects(
      observe({
        ...base,
        read: () => {
          throw thrown;
        },
      }),
      (error) => {
        assert.ok(error instanceof ObservationError);
        assert.equal(error.code, "read-unavailable");
        assert.equal(error.cause, thrown);
        assert.equal(error.toResponse().status, 503);
        return true;
      },
    );
  }
  for (const failAt of [1, 2]) {
    let ticks = 0;
    await assert.rejects(
      observe({
        ...base,
        clock: () => {
          if (++ticks === failAt) throw cause;
          return 100n;
        },
      }),
      (error) => {
        assert.ok(error instanceof ObservationError);
        assert.equal(error.code, "invalid-clock");
        assert.equal(error.phase, failAt === 1 ? "before-read" : "before-response");
        assert.equal(error.cause, cause);
        assert.equal(error.toResponse().status, 500);
        return true;
      },
    );
  }
  await assert.rejects(observe({ ...base, clock: (() => 100) as unknown as () => bigint }), {
    code: "invalid-clock",
  });
});

test("snapshot contract errors are local and malformed JavaScript bodies cannot be coerced into confirmed bytes", async () => {
  const keys = pair(),
    consumer = verifier(keys.publicKey);
  const request = {
    method: "GET",
    headers: requestHeaders([rawSign(keys.privateKey, JSON.stringify(claims()))]),
  };
  const base = {
    request,
    target: TARGET,
    designatedObservation: true,
    verifier: consumer,
    subject: SUBJECT,
    authorize: () => true,
    clock: () => 100n,
    read: () => snapshot([5n]),
  };
  await assert.rejects(observe({ ...base, target: "/wrong" }), (error) => {
    assert.ok(error instanceof ObservationError);
    assert.equal(error.code, "snapshot-target-mismatch");
    assert.equal(error.toResponse().status, 503);
    return true;
  });
  for (const body of ["not bytes", [1, 2, 3], null, new ArrayBuffer(4)]) {
    await assert.rejects(
      observe({
        ...base,
        read: () =>
          snapshot([5n], {
            status: 200,
            headers: new Headers(),
            body: body as unknown as Uint8Array,
          }),
      }),
      (error) => {
        assert.ok(error instanceof ObservationError);
        assert.equal(error.code, "invalid-representation");
        assert.equal(error.toResponse().status, 500);
        assert.equal(error.toResponse().headers.has("causal-result"), false);
        return true;
      },
    );
  }
  for (const status of [202, 304]) {
    await assert.rejects(
      observe({
        ...base,
        read: () => snapshot([5n], { status, headers: new Headers(), body: new Uint8Array() }),
      }),
      { code: "invalid-representation", phase: "representation" },
    );
  }
});
