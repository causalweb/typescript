import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "vitest";

test("two-process HTTPS measurement confirms all written orders", () => {
  const report = JSON.parse(
    execFileSync(process.execPath, ["reference/quickstart.mjs", "--load", "3"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 30_000,
    }),
  );
  assert.equal(report.count, 3);
  assert.ok(report.confirmedMs >= report.writesDoneMs);
  assert.ok(report.confirmedOrdersPerSecond > 0);
  assert.ok(report.confirmationPolls >= 1);
});
