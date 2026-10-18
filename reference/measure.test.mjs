import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "vitest";

test("reference measurement exercises committed, verified, and applied facts", () => {
  const report = JSON.parse(
    execFileSync(process.execPath, ["reference/measure.mjs", "3"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 10_000,
    }),
  );
  assert.equal(report.count, 3);
  assert.ok(report.elapsedMs > 0);
  assert.ok(report.ordersPerSecond > 0);
  assert.ok(report.sourceDatabaseBytes > 0);
  assert.ok(report.viewDatabaseBytes > 0);
  const invalid = spawnSync(process.execPath, ["reference/measure.mjs", "0"], {
    cwd: process.cwd(),
    timeout: 10_000,
  });
  assert.notEqual(invalid.status, 0);
});
