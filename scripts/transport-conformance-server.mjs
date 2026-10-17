import { generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";

import {
  CLAIM,
  headersFromIncoming,
  ObservationError,
  observe,
  PROFILE,
  Snapshot,
  sourceKey,
  Verifier,
  writeFetchResponse,
} from "../dist/src/index.js";

const issuer = "https://issuer.example";
const audience = "https://verifier.example/causal";
const subject = "opaque-tenant";
const domain = "https://issuer.example/domains/orders/2026";
const target = "/orders/123";
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const verifier = new Verifier(audience, [
  {
    issuer,
    keys: new Map([["transport-conformance", publicKey]]),
    domains: new Set([domain]),
    maxLifetimeSeconds: 86400n,
    clockSkewSeconds: 0n,
  },
]);

function signedEvidence(id, index) {
  const protectedHeader = Buffer.from(
    JSON.stringify({ alg: "ES256", kid: "transport-conformance", typ: "cw-evidence+jwt" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: issuer,
      sub: subject,
      aud: audience,
      iat: 1,
      exp: 1000,
      jti: `urn:transport-conformance:${id}:${index}`,
      [CLAIM]: { v: 1, profile: PROFILE, domain, position: "5", commit: "stable" },
    }),
  ).toString("base64url");
  const input = `${protectedHeader}.${payload}`;
  const signature = sign("sha256", Buffer.from(input), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${input}.${signature}`;
}

function fixture(id) {
  return id === "TRN-001"
    ? [signedEvidence(id, 0), signedEvidence(id, 1)]
    : [signedEvidence(id, 0)];
}

function specification(pathname) {
  if (pathname === "/observe/TRN-001") {
    return { frontiers: [4n], status: 200, body: "stale", context: false };
  }
  if (pathname === "/observe/TRN-002") {
    return { frontiers: [5n], status: 200, body: "covered", context: true };
  }
  return { frontiers: [5n], status: 202, body: "pending", context: false };
}

async function observation(request, response) {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (pathname === "/ordinary" && !request.rawHeaders.some((value) => value === "Causal-Require")) {
    response.writeHead(204, { "X-CausalWeb-Conformance-Read-Calls": "0", Connection: "close" });
    response.end();
    return;
  }
  let readCalls = 0;
  const selected = specification(pathname);
  let result;
  try {
    result = await observe({
      request: { method: request.method ?? "GET", headers: headersFromIncoming(request) },
      target,
      designatedObservation: true,
      verifier,
      subject,
      authorize: () => true,
      clock: () => 100n,
      read: () => {
        readCalls += 1;
        const headers = new Headers();
        if (selected.context) headers.set("Causal-Context", "not-evidence");
        return new Snapshot(
          target,
          { status: selected.status, headers, body: Buffer.from(selected.body) },
          "contract/v1",
          "schema/v1",
          new Map([
            [
              sourceKey(issuer, domain),
              { kind: "relevant", frontiers: selected.frontiers, progressPossible: true },
            ],
          ]),
        );
      },
    });
  } catch (error) {
    if (!(error instanceof ObservationError)) throw error;
    result = error.toResponse();
  }
  result.headers.set("X-CausalWeb-Conformance-Read-Calls", String(readCalls));
  result.headers.set(
    "Content-Length",
    String(result.body === null ? 0 : (await result.clone().arrayBuffer()).byteLength),
  );
  await writeFetchResponse(result, response);
}

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (pathname.startsWith("/fixture/")) {
    const body = JSON.stringify({ requirements: fixture(pathname.slice("/fixture/".length)) });
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      Connection: "close",
    });
    response.end(body);
    return;
  }
  try {
    await observation(request, response);
  } catch {
    response.writeHead(500, { "X-CausalWeb-Conformance-Read-Calls": "0", Connection: "close" });
    response.end();
  }
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("transport server lacks an address");
  process.stdout.write(
    `${JSON.stringify({ format: "causal-web-conformance-transport-server-v1", origin: `http://127.0.0.1:${address.port}` })}\n`,
  );
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
