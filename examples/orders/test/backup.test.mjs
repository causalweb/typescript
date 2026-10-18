import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Issuer } from "@causalweb/sdk";
import { test } from "vitest";
import { createBackup, restoreBackup } from "../bin/backup.mjs";
import { OrderSourceStore, OrderViewStore } from "../src/order-store.mjs";

const IDENTITY = {
  issuer: "https://orders.example",
  domain: "https://orders.example/domains/orders",
  audience: "https://view.example/causal",
  subject: "tenant-a",
};

test("backup and restore preserve a version-one source for atomic upgrade", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "causalweb-reference-legacy-backup-"));
  assert.equal(resolve(directory, ".."), resolve(tmpdir()));
  context.onTestFinished(async () => {
    await rm(directory, { recursive: true });
  });
  const sourcePath = join(directory, "source.sqlite");
  const viewPath = join(directory, "view.sqlite");
  const source = new OrderSourceStore(sourcePath, IDENTITY);
  const historical = source.commit("historical", 1000n, 4600n, "old-write");
  source.close();
  const view = new OrderViewStore(viewPath, IDENTITY);
  view.close();
  const legacy = new DatabaseSync(sourcePath);
  legacy.exec("DROP TABLE source_requests");
  legacy.prepare("UPDATE reference_identity SET version = 1 WHERE id = 1").run();
  legacy.close();
  const backupPath = join(directory, "backup");
  const restoredPath = join(directory, "restored");
  await createBackup(sourcePath, viewPath, backupPath);
  await restoreBackup(backupPath, restoredPath);
  const upgraded = new OrderSourceStore(join(restoredPath, "source.sqlite"), IDENTITY);
  assert.equal(upgraded.unissued()[0].id, historical.id);
  assert.equal(upgraded.commit("current", 1000n, 4600n, "new-write").position, "2");
  upgraded.close();
});

test("paired backup preserves a new view contract and its operator decision", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "causalweb-reference-contract-backup-"));
  assert.equal(resolve(directory, ".."), resolve(tmpdir()));
  context.onTestFinished(async () => {
    await rm(directory, { recursive: true });
  });
  const sourcePath = join(directory, "source.sqlite");
  const viewPath = join(directory, "view.sqlite");
  const contract = { contract: "reference-orders/test-rollover", schema: "orders/test-rollover" };
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const issuer = new Issuer(
    IDENTITY.issuer,
    "key-1",
    privateKey,
    new Set([IDENTITY.domain]),
    3600n,
  );
  const source = new OrderSourceStore(sourcePath, IDENTITY);
  const first = source.commit("first", 1000n, 4600n, "first");
  const evidenceFor = (event) =>
    issuer.issueCommitted(
      {
        subject: IDENTITY.subject,
        audiences: [IDENTITY.audience],
        domain: IDENTITY.domain,
        position: BigInt(event.position),
        issuedAt: 1000n,
        expiresAt: 4600n,
        evidenceId: event.id,
      },
      1000n,
    );
  source.materialize(first.id, evidenceFor(first), 1000n, 4600n);
  const event = source.commit("second", 1000n, 4600n, "second");
  const evidence = evidenceFor(event);
  source.materialize(event.id, evidence, 1000n, 4600n);
  source.close();
  const view = new OrderViewStore(viewPath, IDENTITY, () => {}, contract);
  view.accept({ ...event, evidence });
  view.decideFailure("failed", "2", "operator-a");
  view.close();
  const backupPath = join(directory, "backup");
  const restoredPath = join(directory, "restored");
  await createBackup(sourcePath, viewPath, backupPath);
  await restoreBackup(backupPath, restoredPath);
  const restoredViewPath = join(restoredPath, "view.sqlite");
  assert.throws(
    () => new OrderViewStore(restoredViewPath, IDENTITY),
    /view contract does not match configuration/,
  );
  const restoredView = new OrderViewStore(restoredViewPath, IDENTITY, () => {}, contract);
  assert.equal(restoredView.snapshot().firstTerminalFailure, "2");
  restoredView.close();
});

test("quiescent paired SQLite backup restores source facts and a state-bound view cut", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "causalweb-reference-backup-"));
  assert.equal(resolve(directory, ".."), resolve(tmpdir()));
  context.onTestFinished(async () => {
    await rm(directory, { recursive: true });
  });
  const sourcePath = join(directory, "source.sqlite");
  const viewPath = join(directory, "view.sqlite");
  const backupPath = join(directory, "backup");
  const restoredPath = join(directory, "restored");
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const issuer = new Issuer(
    "https://orders.example",
    "key-1",
    privateKey,
    new Set(["https://orders.example/domains/orders"]),
    3600n,
  );
  let source = new OrderSourceStore(sourcePath, IDENTITY);
  let view = new OrderViewStore(viewPath, IDENTITY);
  for (const order of ["first", "second", "third"]) {
    const event = source.commit(order, 1000n, 4600n, order);
    const evidence = issuer.issueCommitted(
      {
        subject: "tenant-a",
        audiences: ["https://view.example/causal"],
        domain: "https://orders.example/domains/orders",
        position: BigInt(event.position),
        issuedAt: 1000n,
        expiresAt: 4600n,
        evidenceId: event.id,
      },
      1000n,
    );
    source.materialize(event.id, evidence, 1000n, 4600n);
    if (order === "first") view.accept({ ...event, evidence });
  }
  view.accept(source.undelivered()[2]);
  view.decideFailure("failed", "3", "operator-a");
  assert.deepEqual(view.snapshot(), {
    frontier: "1",
    orders: ["first"],
    firstTerminalFailure: "3",
  });
  source.close();
  view.close();

  execFileSync(
    process.execPath,
    ["examples/orders/bin/backup.mjs", "create", sourcePath, viewPath, backupPath],
    {
      cwd: process.cwd(),
    },
  );
  const manifest = JSON.parse(await readFile(join(backupPath, "manifest.json"), "utf8"));
  assert.equal(manifest.format, "causalweb-order-reference-backup/v2");
  await assert.rejects(() => createBackup(sourcePath, viewPath, backupPath));
  const unrelatedSourcePath = join(directory, "unrelated-source.sqlite");
  const unrelated = new OrderSourceStore(unrelatedSourcePath, IDENTITY);
  unrelated.commit("different", 1000n, 4600n, "different");
  unrelated.close();
  await assert.rejects(
    () => createBackup(unrelatedSourcePath, viewPath, join(directory, "mismatched")),
    /disagrees with source/,
  );
  const unrelatedViewPath = join(directory, "unrelated-view.sqlite");
  const unrelatedView = new OrderViewStore(unrelatedViewPath, {
    ...IDENTITY,
    domain: `${IDENTITY.domain}/different`,
  });
  unrelatedView.close();
  await assert.rejects(
    () => createBackup(sourcePath, unrelatedViewPath, join(directory, "wrong-domain")),
    /deployment identities do not match/,
  );
  execFileSync(
    process.execPath,
    ["examples/orders/bin/backup.mjs", "restore", backupPath, restoredPath],
    {
      cwd: process.cwd(),
    },
  );
  await assert.rejects(() => restoreBackup(backupPath, restoredPath));
  source = new OrderSourceStore(join(restoredPath, "source.sqlite"), IDENTITY);
  view = new OrderViewStore(join(restoredPath, "view.sqlite"), IDENTITY);
  assert.deepEqual(view.snapshot(), {
    frontier: "1",
    orders: ["first"],
    firstTerminalFailure: "3",
  });
  assert.deepEqual(
    source.undelivered().map((event) => event.position),
    ["1", "2", "3"],
  );
  view.accept(source.undelivered()[1]);
  assert.deepEqual(view.snapshot(), { frontier: "3", orders: ["first", "second", "third"] });
  source.close();
  view.close();

  const damagedMapping = new DatabaseSync(join(restoredPath, "source.sqlite"));
  try {
    damagedMapping.exec("PRAGMA foreign_keys = OFF");
    damagedMapping
      .prepare("UPDATE source_requests SET position = '999' WHERE request_key = 'first'")
      .run();
  } finally {
    damagedMapping.close();
  }
  await assert.rejects(
    () =>
      createBackup(
        join(restoredPath, "source.sqlite"),
        join(restoredPath, "view.sqlite"),
        join(directory, "bad-mapping"),
      ),
    /request mapping is inconsistent/,
  );

  await appendFile(join(backupPath, "view.sqlite"), "corruption");
  await assert.rejects(
    () => restoreBackup(backupPath, join(directory, "rejected")),
    /checksum mismatch/,
  );
  await assert.rejects(() => readFile(join(directory, "rejected", "RESTORED.json")));
});
