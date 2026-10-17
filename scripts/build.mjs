import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "dist");
assert.equal(dirname(output), root);
// Only generated output is removed; renamed/deleted modules must not enter an archive.
rmSync(output, { recursive: true, force: true });
execFileSync(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "--project", join(root, "tsconfig.json")],
  { cwd: root, stdio: "inherit" });
