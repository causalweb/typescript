import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  acceptConfirmation,
  Issuer,
  ObservationError,
  observe,
  ProtocolError,
  type Representation,
  requestHeaders,
  Snapshot,
  sourceKey,
  Verifier,
} from "@causalweb/protocol";

// Synthetic SDK exercise. This does not establish source durability or recovery.
const source = "https://source.example",
  domain = `${source}/domains/orders/epoch-1`;
const subject = "tenant-42",
  audience = "orders-view",
  target = "/orders/42";
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const issuer = new Issuer(source, "local-test-key", privateKey, new Set([domain]), 300n);
const verifier = new Verifier(audience, [
  {
    issuer: source,
    keys: new Map([["local-test-key", publicKey]]),
    domains: new Set([domain]),
    maxLifetimeSeconds: 300n,
    clockSkewSeconds: 0n,
  },
]);
const evidence = issuer.issueCommitted(
  { subject, audiences: [audience], domain, position: 5n, issuedAt: 100n, expiresAt: 200n },
  100n,
);
const request = { method: "GET", headers: requestHeaders([evidence]) };

function readAt(frontier: bigint): Snapshot<Representation> {
  return new Snapshot(
    target,
    {
      status: 200,
      headers: new Headers({ "Content-Type": "application/json" }),
      body: Buffer.from('{"order":42}'),
    },
    "orders-projection/v1",
    "orders-schema/v1",
    new Map([
      [
        sourceKey(source, domain),
        { kind: "relevant", frontiers: [frontier], progressPossible: true },
      ],
    ]),
  );
}

const options = {
  request,
  target,
  designatedObservation: true,
  verifier,
  subject,
  authorize: () => true,
  clock: () => 100n,
};
const stale = await observe({ ...options, read: () => readAt(4n) });
assert.equal(stale.status, 412);
assert.throws(() => acceptConfirmation(stale, true), ProtocolError);
const failure = await stale.json();
assert.deepEqual(failure, {
  type: "https://github.com/causalweb/spec/problems/requirements-not-satisfied",
  title: "Causal requirements were not satisfied",
  status: 412,
  outcomes: [{ index: 0, outcome: "unsatisfied", retryable: true }],
});
const fresh = await observe({ ...options, read: () => readAt(5n) });
acceptConfirmation(fresh, true);
assert.equal(await fresh.text(), '{"order":42}');
const denied = await observe({
  ...options,
  authorize: () => false,
  read: () => {
    throw new Error("must not select state");
  },
});
assert.equal(denied.status, 403);
assert.equal(denied.headers.has("causal-result"), false);
const cause = new Error("synthetic database outage");
try {
  await observe({
    ...options,
    read: () => {
      throw cause;
    },
  });
  assert.fail("must reject local read failure");
} catch (error) {
  assert.ok(error instanceof ObservationError);
  assert.equal(error.code, "read-unavailable");
  assert.equal(error.cause, cause);
  const response = error.toResponse();
  assert.equal(response.status, 503);
  assert.equal(response.headers.has("causal-result"), false);
  assert.equal(await response.text(), "");
}
console.log(
  "Installed-package consumer: stale rejection, confirmation, access denial, and local-error conversion passed",
);
