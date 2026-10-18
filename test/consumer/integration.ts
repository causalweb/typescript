import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import {
  contextHeaders,
  handleNodeObservation,
  Issuer,
  parseContext,
  Snapshot,
  sourceKey,
  Verifier,
  waitForObservation,
} from "@causalweb/sdk";
import { fetchObservation } from "@causalweb/sdk/client";

const issuerName = "https://source.example";
const domain = `${issuerName}/orders`;
const audience = "https://view.example/causal";
const subject = "tenant-a";
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const issuer = new Issuer(issuerName, "key-1", privateKey, new Set([domain]), 300n);
const verifier = new Verifier(audience, [
  {
    issuer: issuerName,
    keys: new Map([["key-1", publicKey]]),
    domains: new Set([domain]),
    maxLifetimeSeconds: 300n,
    clockSkewSeconds: 0n,
  },
]);
let committedOrder: string | null = null;
let frontier: bigint | null = null;
let viewSelections = 0;
const serverErrors: unknown[] = [];
const server = createServer((request, response) => {
  void (async () => {
    if (request.method === "POST" && request.url === "/orders") {
      if (request.headers.authorization !== "Bearer application-token") {
        response.writeHead(401);
        response.end();
        return;
      }
      committedOrder = "first";
      const now = BigInt(Math.floor(Date.now() / 1000));
      const token = issuer.issueCommitted(
        {
          subject,
          audiences: [audience],
          domain,
          position: 1n,
          issuedAt: now,
          expiresAt: now + 300n,
        },
        now,
      );
      response.writeHead(201, Object.fromEntries(contextHeaders([token])));
      response.end(JSON.stringify({ position: "1" }));
      return;
    }
    if (request.method === "GET" && request.url === "/view") {
      const handled = await handleNodeObservation(request, response, {
        target: "/view",
        designatedObservation: true,
        verifier,
        subject,
        authorize: () => request.headers.authorization === "Bearer application-token",
        clock: () => BigInt(Math.floor(Date.now() / 1000)),
        read: () => {
          viewSelections++;
          if (viewSelections === 2) setTimeout(() => (frontier = 1n), 10);
          return new Snapshot(
            "/view",
            {
              status: 200,
              headers: new Headers({ "Content-Type": "application/json" }),
              body: Buffer.from(JSON.stringify({ orders: committedOrder ? [committedOrder] : [] })),
            },
            "consumer-orders/v1",
            "consumer-schema/v1",
            new Map([
              [
                sourceKey(issuerName, domain),
                { kind: "relevant", frontiers: [frontier], progressPossible: true },
              ],
            ]),
          );
        },
      });
      assert.equal(handled, true);
      return;
    }
    response.writeHead(404);
    response.end();
  })().catch((error) => {
    serverErrors.push(error);
    if (!response.headersSent) response.writeHead(500);
    response.end();
  });
});

try {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const write = await fetch(`${origin}/orders`, {
    method: "POST",
    headers: { authorization: "Bearer application-token" },
  });
  assert.equal(write.status, 201);
  const field = write.headers.get("causal-context");
  assert.ok(field);
  const tokens = parseContext([field]);
  await write.body?.cancel();
  const view = `${origin}/view`;
  const options = {
    request: { headers: { authorization: "Bearer application-token" } },
    authenticated: (response: Response) => response.url === view && !response.redirected,
  };
  const stale = await fetchObservation(view, tokens, options);
  assert.equal(stale.kind, "causal-failure");
  if (stale.kind === "causal-failure")
    assert.equal(stale.problem.outcomes[0]?.outcome, "unsatisfied");
  const beforeDenied = viewSelections;
  const denied = await fetchObservation(view, tokens, {
    authenticated: options.authenticated,
  });
  assert.equal(denied.kind, "ordinary-error");
  assert.equal(denied.response.status, 403);
  assert.equal(denied.response.headers.has("causal-result"), false);
  assert.equal(viewSelections, beforeDenied);
  await denied.response.body?.cancel();
  const confirmed = await waitForObservation(view, tokens, {
    ...options,
    signal: AbortSignal.timeout(2000),
  });
  assert.equal(confirmed.kind, "confirmed");
  assert.deepEqual(await confirmed.response.json(), { orders: ["first"] });
  assert.ok(viewSelections >= 3);
  assert.deepEqual(serverErrors, []);
  console.log("Installed-package HTTP write/context/observation passed");
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
