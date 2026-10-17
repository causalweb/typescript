import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const json = path => JSON.parse(readFileSync(join(root, path), "utf8"));
function check() {
  const pkg = json("package.json"), config = json(".changeset/config.json"), pre = json(".changeset/pre.json");
  assert.equal(pkg.private, true, "registry publishing remains disabled pending maintainer approval");
  assert.match(pkg.version, /^\d+\.\d+\.\d+-experimental(?:\.\d+)?$/, "only experimental SDK versions are currently approved");
  assert.equal(pre.mode, "pre"); assert.equal(pre.tag, "experimental", "stable promotion requires a separate reviewed decision");
  assert.equal(config.commit, false);
  assert.deepEqual(config.privatePackages, { version: true, tag: false });
  const lock = json("package-lock.json");
  assert.equal(lock.version, pkg.version); assert.equal(lock.packages[""].version, pkg.version);
}

const command = process.argv[2];
assert.ok(command === "check" || command === "prepare", "usage: npm run release:check or npm run version:prepare");
check();
if (command === "check" && process.env.CAUSALWEB_CHANGESET_BASE) {
  assert.match(process.env.CAUSALWEB_CHANGESET_BASE, /^[a-f0-9]{40}$/);
  execFileSync(process.execPath, [join(root, "node_modules/@changesets/cli/bin.js"), "status", "--since", process.env.CAUSALWEB_CHANGESET_BASE],
    { cwd: root, stdio: "inherit" });
}
if (command === "prepare") {
  assert.ok(process.env.npm_execpath?.endsWith("npm-cli.js"), "use npm run version:prepare");
  execFileSync(process.execPath, [join(root, "node_modules/@changesets/cli/bin.js"), "version"], { cwd: root, stdio: "inherit" });
  execFileSync(process.execPath, [process.env.npm_execpath, "install", "--package-lock-only", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"],
    { cwd: root, stdio: "inherit" });
  check();
  execFileSync(process.execPath, [join(root, "node_modules/@changesets/cli/bin.js"), "add", "--empty", "--message", "Release preparation only; prior changesets supply the release notes."],
    { cwd: root, stdio: "inherit" });
}
console.log("Experimental release metadata checked; nothing published or tagged");
