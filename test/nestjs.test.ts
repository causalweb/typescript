import "reflect-metadata";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { Controller, Get, Module, Req, Res } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Request, Response } from "express";
import { test } from "vitest";
import {
  fetchObservation,
  handleNodeObservation,
  Issuer,
  type Representation,
  Snapshot,
  sourceKey,
  Verifier,
} from "../src/index.js";

test("the NestJS Express integration owns causal responses without replacing ordinary routes", async (t) => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const issuerName = "https://source.example";
  const domain = "https://source.example/domains/nest";
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

  @Controller()
  class ObservationController {
    @Get("view")
    async view(@Req() request: Request, @Res() response: Response): Promise<void> {
      const handled = await handleNodeObservation(request, response, {
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
      });
      if (!handled) response.status(200).json({ state: "ordinary" });
    }
  }

  @Module({ controllers: [ObservationController] })
  class ApplicationModule {}

  const app = await NestFactory.create(ApplicationModule, { logger: false });
  t.onTestFinished(async () => {
    await app.close();
  });
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;

  const ordinary = await fetch(`${origin}/view`);
  assert.deepEqual(await ordinary.json(), { state: "ordinary" });
  assert.equal(ordinary.headers.has("causal-result"), false);

  const stale = await fetchObservation(`${origin}/view`, [token], { authenticated: () => true });
  assert.equal(stale.kind, "causal-failure");
  if (stale.kind === "causal-failure")
    assert.equal(stale.problem.outcomes[0]?.outcome, "unsatisfied");

  frontier = 5n;
  const confirmed = await fetchObservation(`${origin}/view`, [token], {
    authenticated: () => true,
  });
  assert.equal(confirmed.kind, "confirmed");
  assert.deepEqual(await confirmed.response.json(), { state: "indexed" });
});
