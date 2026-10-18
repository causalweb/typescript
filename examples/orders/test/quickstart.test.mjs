import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "vitest";

test("two-process HTTPS quickstart confirms a committed order", () => {
  const output = execFileSync(process.execPath, ["examples/orders/bin/quickstart.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(output, "stale 412 → authenticated delivery → confirmed 200\n");
});
