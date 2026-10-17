import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "causalweb-release-rehearsal-"));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli?.endsWith("npm-cli.js"), "run npm run test:release");
const env = { ...process.env };
delete env.NODE_PATH;
delete env.CAUSALWEB_CHANGESET_BASE;
for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete env[key];
const run = (program, args) =>
  execFileSync(program, args, {
    cwd: scratch,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
const npm = (args) => run(process.execPath, [npmCli, ...args]);
const json = (path) => JSON.parse(readFileSync(join(scratch, path), "utf8"));
try {
  for (const path of [
    "package.json",
    "package-lock.json",
    "CHANGELOG.md",
    ".changeset",
    "scripts/release.mjs",
  ])
    cpSync(join(root, path), join(scratch, path), { recursive: true });
  // This same rehearsal is used by the Rust release-metadata project.
  const rust = existsSync(join(root, "Cargo.toml"));
  if (rust)
    for (const path of ["Cargo.toml", "Cargo.lock", "src"])
      cpSync(join(root, path), join(scratch, path), { recursive: true });
  run("git", ["init", "--initial-branch=main"]);
  run("git", [
    "add",
    "package.json",
    "package-lock.json",
    "CHANGELOG.md",
    ".changeset",
    "scripts/release.mjs",
  ]);
  run("git", [
    "-c",
    "user.name=Release rehearsal",
    "-c",
    "user.email=release-check@example.invalid",
    "commit",
    "-m",
    "fixture",
  ]);
  const base = run("git", ["rev-parse", "HEAD"]).trim();
  npm(["ci", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"]);
  const before = json("package.json").version;
  const prePath = join(scratch, ".changeset/pre.json"),
    originalPre = readFileSync(prePath, "utf8");
  writeFileSync(prePath, JSON.stringify({ ...JSON.parse(originalPre), mode: "exit" }));
  const rejected = spawnSync(process.execPath, [join(scratch, "scripts/release.mjs"), "prepare"], {
    cwd: scratch,
    env,
    encoding: "utf8",
  });
  assert.notEqual(rejected.status, 0, "stable-exit intent must block before versioning");
  assert.equal(json("package.json").version, before);
  writeFileSync(prePath, originalPre);
  npm(["run", "release:check"]);
  writeFileSync(join(scratch, "release-check-marker.txt"), "synthetic changed package\n");
  run("git", ["add", "release-check-marker.txt"]);
  env.CAUSALWEB_CHANGESET_BASE = base;
  const missingNote = spawnSync(process.execPath, [join(scratch, "scripts/release.mjs"), "check"], {
    cwd: scratch,
    env,
    encoding: "utf8",
  });
  assert.notEqual(missingNote.status, 0, "changed package without a new changeset must fail");
  delete env.CAUSALWEB_CHANGESET_BASE;
  npm(["run", "version:prepare"]);
  run("git", ["add", "package.json", "package-lock.json", "CHANGELOG.md", ".changeset"]);
  env.CAUSALWEB_CHANGESET_BASE = base;
  npm(["run", "release:check"]);
  const after = json("package.json").version;
  assert.notEqual(after, before, "pending changesets must produce a version change");
  assert.match(after, /^\d+\.\d+\.\d+-experimental\.\d+$/);
  assert.equal(json("package.json").private, true);
  assert.equal(json("package-lock.json").packages[""].version, after);
  const preparedLock = json("package-lock.json");
  preparedLock.version = before;
  preparedLock.packages[""].version = before;
  assert.deepEqual(
    preparedLock,
    JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")),
    "version preparation changed dependency resolution",
  );
  assert.ok(readFileSync(join(scratch, "CHANGELOG.md"), "utf8").includes(after));
  if (rust) {
    const originalLock = readFileSync(join(root, "Cargo.lock"), "utf8");
    assert.equal(
      readFileSync(join(scratch, "Cargo.lock"), "utf8"),
      originalLock.replace(
        `name = "causalweb"\nversion = "${before}"`,
        `name = "causalweb"\nversion = "${after}"`,
      ),
    );
  }
  assert.equal(run("git", ["tag", "--list"]).trim(), "", "preparation must not create tags");
  console.log(
    `Changesets rehearsal: ${before} -> ${after}; stable exit rejected; no publication or tags`,
  );
} catch (error) {
  // Child output contains only this synthetic repository's release metadata.
  if (error && typeof error === "object" && "stderr" in error)
    process.stderr.write(String(error.stderr));
  throw error;
} finally {
  assert.equal(dirname(scratch), resolve(tmpdir()));
  assert.ok(scratch.startsWith(join(resolve(tmpdir()), "causalweb-release-rehearsal-")));
  rmSync(scratch, { recursive: true, force: true });
}
