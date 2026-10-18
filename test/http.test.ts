import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { test } from "vitest";
import {
  fetchObservation,
  Issuer,
  ObservationError,
  observe,
  type Representation,
  Snapshot,
  sourceKey,
  Verifier,
  waitForObservation,
} from "../src/index.js";

const testAuthentication = { authenticated: () => true };

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

test("real loopback HTTP enforces dependencies and safely converts local adapter failures", async (t) => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const issuerName = "https://source.example",
    domain = "https://source.example/domains/test";
  const producer = new Issuer(issuerName, "test", privateKey, new Set([domain]), 3600n);
  const consumer = new Verifier("https://view.example/causal", [
    {
      issuer: issuerName,
      keys: new Map([["test", publicKey]]),
      domains: new Set([domain]),
      maxLifetimeSeconds: 3600n,
      clockSkewSeconds: 0n,
    },
  ]);
  // Synthetic test lineage; durable source/projection tests are a separate gate.
  let frontier = 4n;
  let failAt: "none" | "authorization" | "read" | "after-read" = "none";
  const privateCause = new Error("synthetic private backend credential");
  let localFailure: ObservationError | undefined;
  const server = createServer((req, res) => {
    let checks = 0;
    const headers = new Headers();
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i],
        value = req.rawHeaders[i + 1];
      assert.ok(typeof name === "string");
      assert.ok(typeof value === "string");
      headers.append(name, value);
    }
    void observe({
      request: { method: req.method ?? "GET", headers },
      target: "/view",
      designatedObservation: true,
      verifier: consumer,
      subject: "test-subject",
      authorize: () => {
        checks++;
        if (failAt === "authorization" || (failAt === "after-read" && checks === 2))
          throw privateCause;
        return true;
      },
      clock: () => 100n,
      read: () => {
        if (failAt === "read") throw privateCause;
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
    })
      .catch((error) => {
        if (!(error instanceof ObservationError)) throw error;
        localFailure = error;
        return error.toResponse();
      })
      .then(async (response) => {
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      })
      .catch(() => {
        res.writeHead(500);
        res.end();
      });
  });
  t.onTestFinished(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = await listen(server);
  const token = producer.issueCommitted(
    {
      subject: "test-subject",
      audiences: ["https://view.example/causal"],
      domain,
      position: 5n,
      issuedAt: 1n,
      expiresAt: 1000n,
    },
    100n,
  );
  const stale = await fetchObservation(`${base}/view`, [token], testAuthentication);
  assert.equal(stale.kind, "causal-failure");
  assert.equal(stale.response.bodyUsed, true);
  assert.equal(stale.response.body?.locked, false, "the SDK must release its body reader");
  if (stale.kind === "causal-failure") {
    assert.equal(stale.problem.status, 412);
    assert.equal(stale.problem.outcomes[0]?.outcome, "unsatisfied");
  }
  await assert.rejects(
    waitForObservation(`${base}/view`, [token], {
      authenticated: () => true,
      signal: AbortSignal.timeout(20),
    }),
    { name: "TimeoutError" },
  );
  setTimeout(() => {
    frontier = 5n;
  }, 50);
  const waited = await waitForObservation(`${base}/view`, [token], {
    authenticated: () => true,
    signal: AbortSignal.timeout(2000),
  });
  assert.equal(waited.kind, "confirmed");
  await waited.response.body?.cancel();
  const fresh = await fetchObservation(`${base}/view`, [token], testAuthentication);
  assert.equal(fresh.kind, "confirmed");
  assert.deepEqual(await fresh.response.json(), { state: "indexed" });
  await assert.rejects(fetchObservation(`${base}/view`, [token], { authenticated: () => false }), {
    code: "unconfirmed",
  });
  for (const stage of ["authorization", "read", "after-read"] as const) {
    failAt = stage;
    const unavailable = await fetchObservation(`${base}/view`, [token], testAuthentication);
    assert.equal(unavailable.kind, "ordinary-error");
    assert.equal(unavailable.response.status, 503);
    assert.equal(unavailable.response.headers.has("causal-result"), false);
    assert.equal(unavailable.response.headers.get("cache-control"), "no-store");
    assert.equal(await unavailable.response.text(), "");
    assert.ok(localFailure);
    assert.equal(localFailure.cause, privateCause);
    assert.equal(
      localFailure.phase,
      stage === "authorization" ? "before-read" : stage === "read" ? "read" : "before-response",
    );
  }
  const ordinary = await waitForObservation(`${base}/view`, [token], {
    authenticated: () => true,
    signal: AbortSignal.timeout(2000),
  });
  assert.equal(ordinary.kind, "ordinary-error");
  await ordinary.response.body?.cancel();
});

test("a legacy 200 is rejected and a cross-origin redirect never forwards evidence", async (t) => {
  const requests: string[] = [];
  const originRequirements: string[] = [];
  const destination = createServer((req, res) => {
    requests.push(req.headers["causal-require"]?.toString() ?? "");
    res.end("must not be reached");
  });
  t.onTestFinished(() => {
    destination.closeAllConnections();
    destination.close();
  });
  const otherOrigin = await listen(destination);
  const server = createServer((req, res) => {
    if (req.url === "/redirect") {
      originRequirements.push(req.headers["causal-require"]?.toString() ?? "");
      res.writeHead(302, { Location: `${otherOrigin}/view` });
      res.end();
    } else res.end("unaware origin");
  });
  t.onTestFinished(() => {
    server.closeAllConnections();
    server.close();
  });
  const origin = await listen(server);
  await assert.rejects(
    fetchObservation(`${origin}/legacy`, ["opaque-test-token"], testAuthentication),
    { code: "unconfirmed" },
  );
  await assert.rejects(
    fetchObservation(`${origin}/redirect`, ["opaque-test-token"], testAuthentication),
    { code: "unconfirmed" },
  );
  assert.deepEqual(requests, []);

  const adapter = spawn(process.execPath, ["scripts/conformance-adapter.mjs"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  adapter.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  adapter.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  adapter.stdin.end(
    `${JSON.stringify({
      version: 1,
      profile: "http-redirect-agent-v1",
      case: { id: "HTTP-006" },
      url: `${origin}/redirect`,
      requirement: "opaque-test-token",
    })}\n`,
  );
  const [code] = await once(adapter, "close");
  assert.equal(code, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), {
    id: "HTTP-006",
    result: { client_accepts_constrained_success: false },
  });
  assert.equal(originRequirements.at(-1), '"opaque-test-token"');
  assert.deepEqual(requests, []);
});

test("waiting returns terminal causal failure without retrying it", async (t) => {
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.writeHead(503, {
      "Causal-Result": "unsatisfied",
      "Content-Type": "application/problem+json",
      "Cache-Control": "no-store",
    });
    res.end(
      JSON.stringify({
        type: "https://github.com/causalweb/spec/problems/requirements-not-satisfied",
        title: "Not satisfied",
        status: 503,
        outcomes: [{ index: 0, outcome: "failed", retryable: false }],
      }),
    );
  });
  t.onTestFinished(() => {
    server.closeAllConnections();
    server.close();
  });
  const origin = await listen(server);
  const result = await waitForObservation(`${origin}/view`, ["opaque-test-token"], {
    authenticated: () => true,
    signal: AbortSignal.timeout(2000),
  });
  assert.equal(result.kind, "causal-failure");
  assert.equal(requests, 1);
  for (const method of ["POST", "HEAD"]) {
    await assert.rejects(
      waitForObservation(`${origin}/view`, ["opaque-test-token"], {
        authenticated: () => true,
        request: { method },
        signal: AbortSignal.timeout(2000),
      }),
      { code: "invalid-configuration" },
    );
  }
  assert.equal(requests, 1);
});

test("malformed outcome order, excessive problems, and cancelled exchanges fail closed", async (t) => {
  const server = createServer((req, res) => {
    if (req.url === "/cancel") return;
    res.writeHead(412, {
      "Causal-Result": "unsatisfied",
      "Content-Type": "application/problem+json",
      "Cache-Control": "no-store",
    });
    if (req.url === "/body-cancel") {
      res.write('{"partial":');
      return;
    }
    if (req.url === "/large") res.end(" ".repeat(65537));
    else
      res.end(
        JSON.stringify({
          type: "https://github.com/causalweb/spec/problems/requirements-not-satisfied",
          title: "Not satisfied",
          status: 412,
          outcomes: [{ index: 1, outcome: "unsatisfied", retryable: true }],
        }),
      );
  });
  t.onTestFinished(() => {
    server.closeAllConnections();
    server.close();
  });
  const origin = await listen(server);
  const inspected: Response[] = [];
  const authentication = {
    authenticated: (response: Response) => {
      inspected.push(response);
      return true;
    },
  };
  for (const [path, code] of [
    ["order", "unconfirmed"],
    ["large", "too-large"],
  ]) {
    await assert.rejects(fetchObservation(`${origin}/${path}`, ["test"], authentication), { code });
    assert.equal(inspected.at(-1)?.body?.locked, false, `body reader retained after ${path}`);
  }
  const controller = new AbortController();
  await assert.rejects(
    fetchObservation(`${origin}/body-cancel`, ["test"], {
      request: { signal: controller.signal },
      authenticated: (response) => {
        inspected.push(response);
        controller.abort();
        return true;
      },
    }),
  );
  assert.equal(inspected.at(-1)?.body?.locked, false, "body reader retained after cancellation");
  await assert.rejects(
    fetchObservation(`${origin}/cancel`, ["test"], {
      ...testAuthentication,
      request: { signal: AbortSignal.timeout(20) },
    }),
  );
});

test("plaintext evidence transport is rejected outside literal loopback", async () => {
  await assert.rejects(
    fetchObservation("http://192.0.2.1/not-contacted", ["test"], testAuthentication),
    { code: "invalid-configuration" },
  );
});
