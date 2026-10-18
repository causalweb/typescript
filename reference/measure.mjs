import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { Issuer, Verifier } from "@causalweb/protocol";
import { OrderSourceStore, OrderViewStore } from "./order-store.mjs";

const count = process.argv[2] === undefined ? 1000 : Number(process.argv[2]);
if (!Number.isSafeInteger(count) || count < 1 || count > 5000)
  throw new Error("usage: measure.mjs [integer order count from 1 to 5000]");

const identity = {
  issuer: "https://measure.example",
  domain: "https://measure.example/orders",
  audience: "https://view.measure.example/causal",
  subject: "measure-principal",
};
const directory = await mkdtemp(join(tmpdir(), "causalweb-measure-"));
assert.equal(resolve(directory, ".."), resolve(tmpdir()));
const sourcePath = join(directory, "source.sqlite");
const viewPath = join(directory, "view.sqlite");
let source;
let view;
try {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const issuer = new Issuer(
    identity.issuer,
    "measure-key",
    privateKey,
    new Set([identity.domain]),
    3600n,
  );
  const verifier = new Verifier(identity.audience, [
    {
      issuer: identity.issuer,
      keys: new Map([["measure-key", publicKey]]),
      domains: new Set([identity.domain]),
      maxLifetimeSeconds: 3600n,
      clockSkewSeconds: 0n,
    },
  ]);
  source = new OrderSourceStore(sourcePath, identity);
  view = new OrderViewStore(viewPath, identity);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const phases = { commitMs: 0, issueMs: 0, verifyMs: 0, applyMs: 0 };
  let observedRssPeakBytes = process.memoryUsage().rss;
  const started = performance.now();
  for (let index = 0; index < count; index += 1) {
    let phaseStarted = performance.now();
    const event = source.commit(`order-${index}`, now, now + 3600n, `order-${index}`);
    phases.commitMs += performance.now() - phaseStarted;

    phaseStarted = performance.now();
    const evidence = issuer.issueCommitted(
      {
        subject: identity.subject,
        audiences: [identity.audience],
        domain: identity.domain,
        position: BigInt(event.position),
        issuedAt: now,
        expiresAt: now + 3600n,
        evidenceId: event.id,
      },
      now,
    );
    source.materialize(event.id, evidence, now, now + 3600n);
    phases.issueMs += performance.now() - phaseStarted;

    phaseStarted = performance.now();
    const checked = verifier.verify(evidence, identity.subject, now);
    assert.equal(checked.position, event.position);
    phases.verifyMs += performance.now() - phaseStarted;

    phaseStarted = performance.now();
    view.accept({ ...event, evidence });
    source.delivered(event.id, evidence);
    phases.applyMs += performance.now() - phaseStarted;
    observedRssPeakBytes = Math.max(observedRssPeakBytes, process.memoryUsage().rss);
  }
  const elapsedMs = performance.now() - started;
  const snapshotStarted = performance.now();
  const snapshot = view.snapshot();
  const snapshotMs = performance.now() - snapshotStarted;
  assert.equal(snapshot.frontier, String(count));
  assert.equal(snapshot.orders.length, count);
  source.close();
  source = null;
  view.close();
  view = null;
  process.stdout.write(
    `${JSON.stringify({
      workload: "single-process source commit, ES256 issue/verify, and view apply; no HTTP",
      node: process.version,
      count,
      elapsedMs,
      ordersPerSecond: (count * 1000) / elapsedMs,
      ...phases,
      snapshotMs,
      observedRssPeakBytes,
      sourceDatabaseBytes: (await stat(sourcePath)).size,
      viewDatabaseBytes: (await stat(viewPath)).size,
    })}\n`,
  );
} finally {
  source?.close();
  view?.close();
  assert.ok(directory.startsWith(join(resolve(tmpdir()), "causalweb-measure-")));
  await rm(directory, { recursive: true });
}
