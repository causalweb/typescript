import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "causalweb-npm-consumer-"));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
// Run npm's JS entry point directly so Windows does not need a shell for .cmd files.
const npmCli = process.env.npm_execpath;
assert.ok(npmCli?.endsWith("npm-cli.js"), "run with npm run test:package");
const environment = { ...process.env };
delete environment.NODE_PATH;
function npm(args, cwd, capture = false) {
  return execFileSync(process.execPath, [npmCli, ...args], {
    cwd,
    env: environment,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
}

try {
  const [packed] = JSON.parse(
    npm(["pack", "--json", "--ignore-scripts", "--pack-destination", scratch], root, true),
  );
  for (const required of [
    "dist/src/index.js",
    "dist/src/index.d.ts",
    "dist/src/node-http.js",
    "dist/src/node-http.d.ts",
    "dist/src/fastify.js",
    "dist/src/fastify.d.ts",
    "CROSS_RUNTIME_DEMO.md",
    "MIGRATION.md",
    "PERSISTENT_DEMO.md",
    "CHANGELOG.md",
    "LICENSE.md",
  ])
    assert.ok(
      packed.files.some((file) => file.path === required),
      `missing package artifact: ${required}`,
    );
  assert.ok(
    packed.files.every((file) => !/^(test|scripts|node_modules)\//.test(file.path)),
    "development files leaked into the package",
  );
  const consumer = join(scratch, "application");
  cpSync(join(root, "test", "consumer"), consumer, { recursive: true });
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({
      name: "causalweb-consumer-test",
      version: "0.0.0",
      private: true,
      type: "module",
      dependencies: { [manifest.name]: `file:../${packed.filename}` },
      devDependencies: {
        typescript: manifest.devDependencies.typescript,
        "@types/node": manifest.devDependencies["@types/node"],
        fastify: manifest.devDependencies.fastify,
      },
    }),
  );
  npm(["install", "--ignore-scripts", "--no-audit", "--no-fund"], consumer);
  execFileSync(
    process.execPath,
    [join(consumer, "node_modules", "typescript", "bin", "tsc"), "--project", "tsconfig.json"],
    { cwd: consumer, env: environment, stdio: "inherit" },
  );
  execFileSync(process.execPath, [join(consumer, "dist", "main.js")], {
    cwd: consumer,
    env: environment,
    stdio: "inherit",
  });
  execFileSync(process.execPath, [join(consumer, "dist", "fastify.js")], {
    cwd: consumer,
    env: environment,
    stdio: "inherit",
  });
} finally {
  assert.equal(dirname(scratch), resolve(tmpdir()));
  assert.ok(scratch.startsWith(join(resolve(tmpdir()), "causalweb-npm-consumer-")));
  rmSync(scratch, { recursive: true, force: true });
}
