import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import fastify from "fastify";
import { test } from "vitest";
import { handleFastifyObservation } from "../src/fastify.js";
import {
  fetchObservation,
  Issuer,
  type Representation,
  Snapshot,
  sourceKey,
  Verifier,
} from "../src/index.js";

test("the Fastify adapter keeps ordinary routing and handles constrained observations", async (t) => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const issuerName = "https://source.example";
  const domain = "https://source.example/domains/fastify";
  const issuer = new Issuer(issuerName, "test", privateKey, new Set([domain]), 3600n);
  const verifier = new Verifier("https://view.example/causal", [
    {
      issuer: issuerName,
      keys: new Map([["test", publicKey]]),
      domains: new Set([domain]),
      maxLifetimeSeconds: 3600n,
      clockSkewSeconds: 0n,
    },
  ]);
  const token = issuer.issueCommitted(
    {
      subject: "subject",
      audiences: ["https://view.example/causal"],
      domain,
      position: 5n,
      issuedAt: 1n,
      expiresAt: 1000n,
    },
    100n,
  );
  let frontier = 4n;
  const app = fastify();
  app.get("/view", async (request, reply) => {
    if (
      await handleFastifyObservation(request, reply, {
        target: "/view",
        designatedObservation: true,
        verifier,
        subject: "subject",
        authorize: () => true,
        clock: () => 100n,
        read: () =>
          new Snapshot<Representation>(
            "/view",
            {
              status: 200,
              headers: new Headers({ "Content-Type": "application/json" }),
              body: Buffer.from('{"state":"indexed"}'),
            },
            "test-contract/v1",
            "test-schema/v1",
            new Map([
              [
                sourceKey(issuerName, domain),
                { kind: "relevant", frontiers: [frontier], progressPossible: true },
              ],
            ]),
          ),
      })
    )
      return reply;
    return reply.code(200).send({ state: "ordinary" });
  });
  t.onTestFinished(async () => {
    await app.close();
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });

  const ordinary = await fetch(`${address}/view`);
  assert.deepEqual(await ordinary.json(), { state: "ordinary" });
  assert.equal(ordinary.headers.has("causal-result"), false);

  const stale = await fetchObservation(`${address}/view`, [token], { authenticated: () => true });
  assert.equal(stale.kind, "causal-failure");
  if (stale.kind === "causal-failure")
    assert.equal(stale.problem.outcomes[0]?.outcome, "unsatisfied");

  frontier = 5n;
  const confirmed = await fetchObservation(`${address}/view`, [token], {
    authenticated: () => true,
  });
  assert.equal(confirmed.kind, "confirmed");
  assert.deepEqual(await confirmed.response.json(), { state: "indexed" });
});
