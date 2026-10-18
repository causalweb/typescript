import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { test } from "vitest";
import {
  fetchObservation,
  handleNodeObservation,
  Issuer,
  type ObservationError,
  type Representation,
  Snapshot,
  sourceKey,
  Verifier,
} from "../src/index.js";

async function listen(server: Server): Promise<{ origin: string; port: number }> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { origin: `http://127.0.0.1:${address.port}`, port: address.port };
}

function rawGet(port: number, fields: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let reply = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk) => {
      reply += chunk;
    });
    socket.once("end", () => resolve(reply));
    socket.once("connect", () => {
      socket.end(["GET /view HTTP/1.1", "Host: 127.0.0.1", ...fields, "", ""].join("\r\n"));
    });
  });
}

test("the Node bridge preserves duplicate causal fields and safely owns causal responses", async (t) => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const issuerName = "https://source.example";
  const domain = "https://source.example/domains/test";
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
  let failRead = false;
  let localError: ObservationError | undefined;
  let receivedCausalFields = 0;
  const server = createServer((request, response) => {
    receivedCausalFields = request.rawHeaders.filter(
      (field) => field.toLowerCase() === "causal-require",
    ).length;
    void handleNodeObservation(request, response, {
      target: "/view",
      designatedObservation: true,
      verifier,
      subject: "subject",
      authorize: () => true,
      clock: () => 100n,
      read: () => {
        if (failRead) throw new Error("private projection connection string");
        return new Snapshot<Representation>(
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
        );
      },
      onLocalError: (error) => {
        localError = error;
      },
    })
      .then((handled) => {
        if (!handled) {
          response.writeHead(204, { "Cache-Control": "no-store" });
          response.end();
        }
      })
      .catch(() => {
        if (!response.headersSent) response.writeHead(500, { "Cache-Control": "no-store" });
        response.end();
      });
  });
  t.onTestFinished(() => {
    server.closeAllConnections();
    server.close();
  });
  const { origin, port } = await listen(server);

  const ordinary = await fetch(`${origin}/view`);
  assert.equal(ordinary.status, 204);
  assert.equal(ordinary.headers.has("causal-result"), false);

  const stale = await fetchObservation(`${origin}/view`, [token], { authenticated: () => true });
  assert.equal(stale.kind, "causal-failure");
  if (stale.kind === "causal-failure")
    assert.equal(stale.problem.outcomes[0]?.outcome, "unsatisfied");

  frontier = 5n;
  const duplicate = await rawGet(port, [
    `Causal-Require: "${token}"`,
    `Causal-Require: "${token}"`,
  ]);
  assert.match(duplicate, /^HTTP\/1\.1 200 /);
  assert.equal(receivedCausalFields, 2);
  assert.match(duplicate, /Causal-Result: satisfied/i);

  const confirmed = await fetchObservation(`${origin}/view`, [token], {
    authenticated: () => true,
  });
  assert.equal(confirmed.kind, "confirmed");
  assert.deepEqual(await confirmed.response.json(), { state: "indexed" });

  failRead = true;
  const unavailable = await fetchObservation(`${origin}/view`, [token], {
    authenticated: () => true,
  });
  assert.equal(unavailable.kind, "ordinary-error");
  assert.equal(unavailable.response.status, 503);
  assert.equal(unavailable.response.headers.has("causal-result"), false);
  assert.equal(await unavailable.response.text(), "");
  assert.equal(localError?.code, "read-unavailable");
  assert.equal(localError?.cause instanceof Error, true);
});
