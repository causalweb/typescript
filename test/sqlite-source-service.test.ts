import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { parseContext, Verifier } from "../src/index.js";

const ISSUER = "https://typescript-sqlite-orders.example";
const KID = "typescript-sqlite-demo";
const SUBJECT = "tenant-example";
const AUDIENCE = "https://orders-view.example/causal";
const DOMAIN = "https://typescript-sqlite-orders.example/domains/orders";

function start(database: string, privateJwk: JsonWebKey) {
  const child = spawn(
    process.execPath,
    ["scripts/sqlite-source-service.mjs", "--database", database, "--now", "100", "--listen", "0"],
    {
      cwd: process.cwd(),
      env: { ...process.env, CAUSALWEB_DEMO_PRIVATE_JWK: JSON.stringify(privateJwk) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  assert.ok(child.stdout);
  return {
    child,
    origin: new Promise<string>((resolveOrigin, rejectOrigin) => {
      let output = "";
      const rejectEarlyExit = (code: number | null) =>
        rejectOrigin(new Error(`SQLite source exited before listening (${code})`));
      child.once("error", rejectOrigin);
      child.once("exit", rejectEarlyExit);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        output += chunk;
        const [line] = output.split("\n");
        if (!line?.startsWith("http://")) return;
        child.off("exit", rejectEarlyExit);
        resolveOrigin(line.trim());
      });
    }),
  };
}

async function stop(child: ReturnType<typeof spawn>, origin: string): Promise<void> {
  const response = await fetch(`${origin}/shutdown`, { method: "POST" });
  assert.equal(response.status, 204);
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

test("SQLite source commits fact and outbox before evidence and recovers a blank outbox row", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "causalweb-sqlite-source-"));
  const database = join(root, "source.sqlite");
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const privateJwk = privateKey.export({ format: "jwk" });
  const verifier = new Verifier(AUDIENCE, [
    {
      issuer: ISSUER,
      keys: new Map([[KID, publicKey]]),
      domains: new Set([DOMAIN]),
      maxLifetimeSeconds: 3600n,
      clockSkewSeconds: 0n,
    },
  ]);
  let source = start(database, privateJwk);
  let origin = await source.origin;
  context.after(async () => {
    if (source.child.exitCode === null) await stop(source.child, origin);
    assert.equal(resolve(root, ".."), resolve(tmpdir()));
    assert.ok(root.startsWith(join(resolve(tmpdir()), "causalweb-sqlite-source-")));
    await rm(root, { recursive: true, force: true });
  });

  const firstResponse = await fetch(`${origin}/orders/first`, { method: "POST" });
  assert.equal(firstResponse.status, 201);
  const first = await firstResponse.json();
  const [token] = parseContext([firstResponse.headers.get("causal-context") ?? ""]);
  assert.equal(token, first.evidence);
  const verified = verifier.verify(first.evidence, SUBJECT, 100n);
  assert.equal(verified.position, "1");
  const connection = new DatabaseSync(database);
  const facts = connection.prepare("SELECT COUNT(*) AS count FROM source_facts").get();
  const outbox = connection.prepare("SELECT COUNT(*) AS count FROM source_outbox").get();
  const sourceEvidence = connection
    .prepare("SELECT evidence FROM source_outbox WHERE position = 1")
    .get();
  assert.ok(facts);
  assert.ok(outbox);
  assert.ok(sourceEvidence);
  assert.equal(facts.count, 1);
  assert.equal(outbox.count, 1);
  assert.equal(sourceEvidence.evidence, first.evidence);
  connection.close();

  const interrupted = await fetch(`${origin}/orders/interrupted?interrupt-after-commit`, {
    method: "POST",
  });
  assert.equal(interrupted.status, 500);
  assert.equal(interrupted.headers.get("causal-context"), null);
  const committedWithoutEvidence = new DatabaseSync(database);
  const interruptedFacts = committedWithoutEvidence
    .prepare("SELECT COUNT(*) AS count FROM source_facts")
    .get();
  const blankOutboxRows = committedWithoutEvidence
    .prepare("SELECT COUNT(*) AS count FROM source_outbox WHERE evidence IS NULL")
    .get();
  assert.ok(interruptedFacts);
  assert.ok(blankOutboxRows);
  assert.equal(interruptedFacts.count, 2);
  assert.equal(blankOutboxRows.count, 1);
  committedWithoutEvidence.close();

  const recoveredAfterInterruption = await (
    await fetch(`${origin}/recover`, { method: "POST" })
  ).json();
  assert.equal(recoveredAfterInterruption.length, 2);
  const interruptedEvent = recoveredAfterInterruption.at(-1);
  assert.ok(interruptedEvent);
  assert.equal(verifier.verify(interruptedEvent.evidence, SUBJECT, 100n).position, "2");

  const stopped = new Promise<number | null>((resolveExit) =>
    source.child.once("exit", resolveExit),
  );
  await assert.rejects(fetch(`${origin}/orders/recover?crash-after-commit`, { method: "POST" }));
  assert.equal(await stopped, 86);

  source = start(database, privateJwk);
  origin = await source.origin;
  const recovered = await (await fetch(`${origin}/recover`, { method: "POST" })).json();
  assert.equal(recovered.length, 3);
  const recoveredEvent = recovered.at(-1);
  assert.ok(recoveredEvent);
  assert.equal(verifier.verify(recoveredEvent.evidence, SUBJECT, 100n).position, "3");
  const reopened = new DatabaseSync(database);
  const unmaterialized = reopened
    .prepare("SELECT COUNT(*) AS count FROM source_outbox WHERE evidence IS NULL")
    .get();
  assert.ok(unmaterialized);
  assert.equal(unmaterialized.count, 0);
  reopened.close();
});
