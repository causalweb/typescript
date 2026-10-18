import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

import { ORDER_CONTRACT, ORDER_SCHEMA, OrderViewStore } from "./order-store.mjs";

const directory = await mkdtemp(join(tmpdir(), "causalweb-failure-history-measure-"));
assert.equal(resolve(directory, ".."), resolve(tmpdir()));
const path = join(directory, "view.sqlite");
const identity = {
  issuer: "https://measure.example",
  domain: "https://measure.example/orders",
  audience: "https://view.measure.example/causal",
  subject: "measure-principal",
};
let view;
let database;
try {
  view = new OrderViewStore(path, identity);
  view.accept({
    id: "urn:uuid:00000000-0000-4000-8000-000000000002",
    position: "2",
    order: "second",
    issuedAt: "1",
    expiresAt: "2",
    evidence: "measurement-fixture",
  });
  database = new DatabaseSync(path);
  const insert = database.prepare(
    "INSERT INTO view_failure_events (position, contract, schema, action, operator, recorded_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const target of [0, 200, 1000, 5000]) {
    const existing = database
      .prepare("SELECT count(*) AS count FROM view_failure_events")
      .get().count;
    database.exec("BEGIN IMMEDIATE");
    try {
      for (let index = existing; index < target; index += 1)
        insert.run(
          "2",
          ORDER_CONTRACT,
          ORDER_SCHEMA,
          index % 2 === 0 ? "failed" : "resolved",
          "measure-operator",
          "2026-10-18T00:00:00.000Z",
        );
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    const start = performance.now();
    for (let sample = 0; sample < 100; sample += 1) assert.equal(view.snapshot().frontier, null);
    process.stdout.write(
      `${JSON.stringify({
        events: target,
        meanSnapshotMs: (performance.now() - start) / 100,
        node: process.version,
        platform: process.platform,
      })}\n`,
    );
  }
} finally {
  database?.close();
  view?.close();
  await rm(directory, { recursive: true });
}
