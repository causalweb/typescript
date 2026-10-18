import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { fetchObservation } from "../src/client/index.js";

afterEach(() => vi.unstubAllGlobals());

test("portable client rejects constrained HEAD before network I/O", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await assert.rejects(
    fetchObservation("https://view.example/orders", ["a.b.c"], {
      authenticated: () => true,
      request: { method: "head" },
    }),
    { code: "invalid-configuration" },
  );
  assert.equal(fetch.mock.calls.length, 0);
});

test("portable client rejects hop-by-hop causal fields before network I/O", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await assert.rejects(
    fetchObservation("https://view.example/orders", ["a.b.c"], {
      authenticated: () => true,
      request: { headers: { Connection: "keep-alive, Causal-Require" } },
    }),
    { code: "invalid-configuration" },
  );
  assert.equal(fetch.mock.calls.length, 0);
});
