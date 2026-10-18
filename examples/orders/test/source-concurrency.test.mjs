import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { OrderSourceStore, OrderViewStore } from "../src/order-store.mjs";

const identity = {
  issuer: "https://orders.example",
  domain: "https://orders.example/domains/orders",
  audience: "https://view.example/causal",
  subject: "tenant-a",
};

test("two source processes serialize keyed writes behind a transient SQLite writer lock", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "causalweb-source-writers-"));
  assert.equal(resolve(directory, ".."), resolve(tmpdir()));
  const path = join(directory, "source.sqlite");
  const initialized = new OrderSourceStore(path, identity);
  initialized.close();
  const children = [];
  context.onTestFinished(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.send({ kind: "stop" });
        await once(child, "exit");
      }
    }
    await rm(directory, { recursive: true });
  });

  const writer = async () => {
    const child = fork(
      fileURLToPath(new URL("./fixtures/source-writer.mjs", import.meta.url)),
      [path, JSON.stringify(identity)],
      {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    children.push(child);
    const [ready] = await once(child, "message");
    assert.equal(ready.kind, "ready");
    return child;
  };
  const first = await writer();
  const second = await writer();
  const lock = new DatabaseSync(path);
  let lockHeld = false;
  try {
    lock.exec("BEGIN IMMEDIATE");
    lockHeld = true;
    const result = (child) => once(child, "message").then(([message]) => message);
    const firstResult = result(first);
    const secondResult = result(second);
    first.send({ kind: "commit", order: "first", key: "same-request" });
    second.send({ kind: "commit", order: "first", key: "same-request" });
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    lock.exec("COMMIT");
    lockHeld = false;
    const [a, b] = await Promise.all([firstResult, secondResult]);
    assert.equal(a.error, undefined);
    assert.equal(b.error, undefined);
    assert.equal(a.event.position, "1");
    assert.deepEqual(b.event, a.event);

    const distinct = result(second);
    second.send({ kind: "commit", order: "second", key: "next-request" });
    const next = await distinct;
    assert.equal(next.error, undefined);
    assert.equal(next.event.position, "2");
  } finally {
    if (lockHeld) lock.exec("ROLLBACK");
    lock.close();
  }
  const source = new OrderSourceStore(path, identity);
  assert.deepEqual(
    source.unissued().map((event) => event.position),
    ["1", "2"],
  );
  source.close();
}, 10000);

test("view startup waits for a transient SQLite writer lock", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "causalweb-view-startup-"));
  assert.equal(resolve(directory, ".."), resolve(tmpdir()));
  const path = join(directory, "view.sqlite");
  const initialized = new OrderViewStore(path, identity);
  initialized.close();
  const lock = new DatabaseSync(path);
  let lockHeld = false;
  let child;
  context.onTestFinished(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, "exit");
    }
    lock.close();
    await rm(directory, { recursive: true });
  });
  try {
    lock.exec("BEGIN IMMEDIATE");
    lockHeld = true;
    child = fork(
      fileURLToPath(new URL("./fixtures/view-open.mjs", import.meta.url)),
      [path, JSON.stringify(identity)],
      {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    const [starting] = await once(child, "message");
    assert.equal(starting.kind, "starting");
    const result = once(child, "message").then(([message]) => message);
    child.send({ kind: "open" });
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    lock.exec("COMMIT");
    lockHeld = false;
    assert.deepEqual(await result, {
      kind: "opened",
      snapshot: { frontier: null, orders: [] },
    });
  } finally {
    if (lockHeld) lock.exec("ROLLBACK");
  }
}, 10000);
