import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const previewRequested = process.argv[2] === "--preview-artifact";
assert.ok(
  process.argv.length === 2 || (process.argv.length === 3 && previewRequested),
  "usage: node scripts/check-package.mjs [--preview-artifact]",
);
const preview = join(root, "preview");
if (previewRequested) assert.ok(!existsSync(preview), "preview directory already exists");
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
  const requiredFiles = [
    "dist/src/index.js",
    "dist/src/index.d.ts",
    "dist/src/client/index.js",
    "dist/src/client/index.d.ts",
    "dist/src/server/node.js",
    "dist/src/server/node.d.ts",
    "dist/src/server/fastify.js",
    "dist/src/server/fastify.d.ts",
    "MIGRATION.md",
    "PILOT.md",
    "RELEASING.md",
    "RUST_REVISION",
    "CONFORMANCE_REVISION",
    "CHANGELOG.md",
    "LICENSE.md",
  ];
  for (const required of requiredFiles)
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
  const installed = join(consumer, "node_modules", manifest.name);
  for (const required of requiredFiles)
    assert.ok(existsSync(join(installed, required)), `missing installed artifact: ${required}`);
  const packagedPaths = new Set(packed.files.map((file) => file.path));
  for (const file of packed.files.filter((item) => item.path.endsWith(".md"))) {
    const markdown = readFileSync(join(installed, file.path), "utf8");
    for (const [, link] of markdown.matchAll(/\]\(([^)]+)\)/g)) {
      if (/^(?:#|[A-Za-z][A-Za-z0-9+.-]*:)/.test(link)) continue;
      const target = link.split("#", 1)[0];
      const packagePath = posix.normalize(posix.join(posix.dirname(file.path), target));
      assert.ok(
        packagedPaths.has(packagePath) && existsSync(join(installed, packagePath)),
        `broken package link: ${file.path} -> ${link}`,
      );
    }
  }
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
  execFileSync(process.execPath, [join(consumer, "dist", "client.js")], {
    cwd: consumer,
    env: environment,
    stdio: "inherit",
  });
  execFileSync(process.execPath, [join(consumer, "dist", "integration.js")], {
    cwd: consumer,
    env: environment,
    stdio: "inherit",
  });
  const installedClient = join(consumer, "order-client.mjs");
  copyFileSync(join(root, "examples", "orders", "bin", "client.mjs"), installedClient);
  execFileSync(process.execPath, [join(root, "examples", "orders", "bin", "quickstart.mjs")], {
    cwd: root,
    env: { ...environment, CAUSALWEB_QUICKSTART_CLIENT_SCRIPT: installedClient },
    stdio: "inherit",
    timeout: 30_000,
  });
  console.log("Installed-package HTTPS client against persistent reference passed");
  if (previewRequested) {
    const archive = readFileSync(join(scratch, packed.filename));
    mkdirSync(preview);
    copyFileSync(join(scratch, packed.filename), join(preview, packed.filename));
    const digest = createHash("sha256").update(archive).digest("hex");
    writeFileSync(join(preview, "SHA256SUMS"), `${digest}  ${packed.filename}\n`);
    writeFileSync(
      join(preview, "SOURCE_COMMIT"),
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }),
    );
  }
} finally {
  assert.equal(dirname(scratch), resolve(tmpdir()));
  assert.ok(scratch.startsWith(join(resolve(tmpdir()), "causalweb-npm-consumer-")));
  rmSync(scratch, { recursive: true, force: true });
}
