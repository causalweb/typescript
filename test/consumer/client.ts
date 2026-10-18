import assert from "node:assert/strict";
import {
  acceptConfirmation,
  contextHeaders,
  parseContext,
  requestHeaders,
  serializeContext,
} from "@causalweb/sdk/client";

const opaqueEvidence = "eyJhbGciOiJFUzI1NiJ9.eyJqdGkiOiJ0ZXN0In0.signature";
const field = serializeContext([opaqueEvidence]);
assert.deepEqual(parseContext([field]), [opaqueEvidence]);
assert.equal(requestHeaders([opaqueEvidence]).get("cache-control"), "no-cache, no-store");
assert.equal(contextHeaders([opaqueEvidence]).get("cache-control"), "private, no-store");
acceptConfirmation(
  new Response(null, { status: 200, headers: { "Causal-Result": "satisfied" } }),
  true,
);
console.log("Installed-package portable client entry passed");
