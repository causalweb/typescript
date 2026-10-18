import assert from "node:assert/strict";
import { serializeContext } from "@causalweb/sdk/client";
import { test } from "vitest";
import { placeAndObserve } from "../bin/client.mjs";

const SOURCE = "https://source.example";
const VIEW = "https://view.example";

function located(response, url) {
  Object.defineProperty(response, "url", { value: url });
  return response;
}

test("reference client retries only explicit causal lag and rejects unaware or ordinary responses", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const issued = () =>
      located(
        new Response(null, {
          status: 201,
          headers: { "causal-context": serializeContext(["a.b.c"]) },
        }),
        `${SOURCE}/orders`,
      );
    const lag = () =>
      located(
        Response.json(
          {
            type: "https://github.com/causalweb/spec/problems/requirements-not-satisfied",
            title: "Not yet projected",
            status: 412,
            outcomes: [{ index: 0, outcome: "unsatisfied", retryable: true }],
          },
          {
            status: 412,
            headers: {
              "content-type": "application/problem+json",
              "causal-result": "unsatisfied",
            },
          },
        ),
        `${VIEW}/orders`,
      );
    const confirmed = () =>
      located(
        Response.json({ orders: ["first"] }, { headers: { "causal-result": "satisfied" } }),
        `${VIEW}/orders`,
      );
    let queue = [issued(), lag(), confirmed()];
    globalThis.fetch = async (url, init) => {
      if (url === `${SOURCE}/orders`) assert.equal(init.headers["cw-request-key"], "request-1");
      return queue.shift();
    };
    assert.deepEqual(await placeAndObserve(SOURCE, VIEW, "first", "token", "request-1"), {
      status: 200,
      body: { orders: ["first"] },
    });
    assert.equal(queue.length, 0);

    for (const response of [
      located(new Response(null, { status: 401 }), `${VIEW}/orders`),
      located(new Response(null, { status: 200 }), `${VIEW}/orders`),
    ]) {
      queue = [issued(), response];
      globalThis.fetch = async () => queue.shift();
      await assert.rejects(() => placeAndObserve(SOURCE, VIEW, "first", "token", "request-1"));
      assert.equal(queue.length, 0);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
