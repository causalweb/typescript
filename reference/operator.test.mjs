import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  Issuer,
  observe,
  requestHeaders,
  Snapshot,
  sourceKey,
  Verifier,
} from "@causalweb/protocol";
import { test } from "vitest";
import { recordFailureDecision } from "./operator.mjs";
import { ORDER_CONTRACT, ORDER_SCHEMA, OrderViewStore } from "./order-store.mjs";

const IDENTITY = {
  issuer: "https://orders.example",
  domain: "https://orders.example/domains/orders",
  audience: "https://view.example/causal",
  subject: "tenant-a",
};
const NOW = 1_000n;

function viewOutcome(view, identity, contract, evidence) {
  const state = view.snapshot();
  return new Snapshot(
    "/orders",
    null,
    contract.contract,
    contract.schema,
    new Map([
      [
        sourceKey(identity.issuer, identity.domain),
        {
          kind: "relevant",
          frontiers: [state.frontier === null ? null : BigInt(state.frontier)],
          progressPossible: true,
          ...(state.firstTerminalFailure === undefined
            ? {}
            : { firstTerminalFailure: BigInt(state.firstTerminalFailure) }),
        },
      ],
    ]),
  ).evaluate(evidence, NOW).outcome;
}

test("operator changes cannot mix with an in-flight view cut", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "causalweb-reference-cut-"));
  assert.equal(resolve(directory, ".."), resolve(tmpdir()));
  const path = join(directory, "view.sqlite");
  const settings = {
    CW_ROLE: "view",
    CW_DATABASE: path,
    CW_ISSUER: IDENTITY.issuer,
    CW_DOMAIN: IDENTITY.domain,
    CW_AUDIENCE: IDENTITY.audience,
    CW_SUBJECT: IDENTITY.subject,
  };
  let nextAction;
  const view = new OrderViewStore(path, IDENTITY, (point) => {
    if (point !== "after-view-cut" || nextAction === undefined) return;
    const action = nextAction;
    nextAction = undefined;
    execFileSync(process.execPath, ["reference/operator.mjs", action, "2"], {
      cwd: process.cwd(),
      env: { ...process.env, ...settings },
      timeout: 5000,
    });
  });
  context.onTestFinished(async () => {
    view.close();
    await rm(directory, { recursive: true });
  });
  view.accept({
    id: "urn:uuid:00000000-0000-4000-8000-000000000002",
    position: "2",
    order: "second",
    issuedAt: "1000",
    expiresAt: "4600",
    evidence: "signed-test-evidence",
  });
  nextAction = "mark-failed";
  assert.deepEqual(view.snapshot(), { frontier: null, orders: [] });
  assert.equal(view.snapshot().firstTerminalFailure, "2");
  nextAction = "resolve-failed";
  assert.equal(view.snapshot().firstTerminalFailure, "2");
  assert.deepEqual(view.snapshot(), { frontier: null, orders: [] });
});

test("only a durable view-operator decision makes an uncovered dependency failed", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "causalweb-reference-operator-"));
  assert.equal(resolve(directory, ".."), resolve(tmpdir()));
  const path = join(directory, "view.sqlite");
  let view = new OrderViewStore(path, IDENTITY);
  context.onTestFinished(async () => {
    view.close();
    await rm(directory, { recursive: true });
  });
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const issuer = new Issuer(
    IDENTITY.issuer,
    "key-1",
    privateKey,
    new Set([IDENTITY.domain]),
    3600n,
  );
  const verifier = new Verifier(IDENTITY.audience, [
    {
      issuer: IDENTITY.issuer,
      keys: new Map([["key-1", publicKey]]),
      domains: new Set([IDENTITY.domain]),
      maxLifetimeSeconds: 3600n,
      clockSkewSeconds: 0n,
    },
  ]);
  const signed = (position) => ({
    id: `urn:uuid:00000000-0000-4000-8000-00000000000${position}`,
    position: String(position),
    order: `order-${position}`,
    issuedAt: "1000",
    expiresAt: "4600",
    evidence: issuer.issueCommitted(
      {
        subject: IDENTITY.subject,
        audiences: [IDENTITY.audience],
        domain: IDENTITY.domain,
        position: BigInt(position),
        issuedAt: NOW,
        expiresAt: NOW + 3600n,
        evidenceId: `urn:uuid:00000000-0000-4000-8000-00000000000${position}`,
      },
      NOW,
    ),
  });
  const first = signed(1);
  const second = signed(2);
  const evaluate = async (event) =>
    observe({
      request: { method: "GET", headers: requestHeaders([event.evidence]) },
      target: "/orders",
      designatedObservation: true,
      verifier,
      subject: IDENTITY.subject,
      authorize: () => true,
      clock: () => NOW,
      read: () => {
        const state = view.snapshot();
        return new Snapshot(
          "/orders",
          { status: 200, headers: new Headers(), body: Buffer.from(JSON.stringify(state.orders)) },
          ORDER_CONTRACT,
          ORDER_SCHEMA,
          new Map([
            [
              sourceKey(IDENTITY.issuer, IDENTITY.domain),
              {
                kind: "relevant",
                frontiers: [state.frontier === null ? null : BigInt(state.frontier)],
                progressPossible: true,
                ...(state.firstTerminalFailure === undefined
                  ? {}
                  : { firstTerminalFailure: BigInt(state.firstTerminalFailure) }),
              },
            ],
          ]),
        );
      },
    });

  view.accept({ ...second, sourceReportedFailure: true });
  assert.equal((await evaluate(second)).status, 412);
  assert.throws(() => view.decideFailure("failed", "1", "operator-a"), /no authenticated pending/);
  assert.throws(() => view.decideFailure("failed", "2", ""), /operator identity/);
  view.close();
  const settings = {
    CW_ROLE: "view",
    CW_DATABASE: path,
    CW_ISSUER: IDENTITY.issuer,
    CW_DOMAIN: IDENTITY.domain,
    CW_AUDIENCE: IDENTITY.audience,
    CW_SUBJECT: IDENTITY.subject,
  };
  assert.throws(
    () => recordFailureDecision("mark-failed", "2", { ...settings, CW_SUBJECT: "tenant-b" }),
    /identity or schema version/,
  );
  execFileSync(process.execPath, ["reference/operator.mjs", "mark-failed", "2"], {
    cwd: process.cwd(),
    env: { ...process.env, ...settings },
  });
  view = new OrderViewStore(path, IDENTITY);
  assert.equal(view.snapshot().firstTerminalFailure, "2");
  assert.equal((await evaluate(first)).status, 412);
  const failed = await evaluate(second);
  assert.equal(failed.status, 503);
  assert.equal((await failed.json()).outcomes[0].outcome, "failed");
  view.close();
  recordFailureDecision("resolve-failed", "2", settings);
  recordFailureDecision("resolve-failed", "2", settings);
  view = new OrderViewStore(path, IDENTITY);
  assert.equal((await evaluate(second)).status, 412);
  view.decideFailure("failed", "2", "operator-a");
  view.accept(first);
  assert.equal(view.snapshot().frontier, "2");
  assert.equal(view.snapshot().firstTerminalFailure, undefined);
  const confirmed = await evaluate(second);
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.headers.get("causal-result"), "satisfied");
  const audit = new DatabaseSync(path, { readOnly: true });
  assert.deepEqual(
    audit
      .prepare("SELECT action FROM view_failure_events ORDER BY id")
      .all()
      .map((row) => row.action),
    ["failed", "resolved", "failed"],
  );
  audit.close();
  const damaged = new DatabaseSync(path);
  damaged.prepare("UPDATE view_failure_events SET contract = ? WHERE id = 1").run("other/v1");
  damaged.close();
  assert.equal(view.snapshot().frontier, "unknown");
  assert.throws(() => view.decideFailure("resolved", "2", "operator-a"), /requires repair/);
});

test("new view contract starts without decisions from the prior contract", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "causalweb-reference-contract-rollover-"));
  assert.equal(resolve(directory, ".."), resolve(tmpdir()));
  context.onTestFinished(async () => {
    await rm(directory, { recursive: true });
  });
  const oldPath = join(directory, "old-view.sqlite");
  const newPath = join(directory, "new-view.sqlite");
  const event = {
    id: "urn:uuid:00000000-0000-4000-8000-000000000002",
    position: "2",
    order: "second",
    issuedAt: "1000",
    expiresAt: "4600",
    evidence: "signed-test-evidence",
  };
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const token = new Issuer(
    IDENTITY.issuer,
    "key-1",
    privateKey,
    new Set([IDENTITY.domain]),
    3600n,
  ).issueCommitted(
    {
      subject: IDENTITY.subject,
      audiences: [IDENTITY.audience],
      domain: IDENTITY.domain,
      position: 2n,
      issuedAt: NOW,
      expiresAt: NOW + 3600n,
    },
    NOW,
  );
  const verified = new Verifier(IDENTITY.audience, [
    {
      issuer: IDENTITY.issuer,
      keys: new Map([["key-1", publicKey]]),
      domains: new Set([IDENTITY.domain]),
      maxLifetimeSeconds: 3600n,
      clockSkewSeconds: 0n,
    },
  ]).verify(token, IDENTITY.subject, NOW);
  const evaluate = (view, contract) => viewOutcome(view, IDENTITY, contract, verified);
  const oldView = new OrderViewStore(oldPath, IDENTITY);
  oldView.accept(event);
  oldView.decideFailure("failed", "2", "operator-a");
  assert.equal(evaluate(oldView, { contract: ORDER_CONTRACT, schema: ORDER_SCHEMA }), "failed");
  oldView.close();

  const nextContract = {
    contract: "reference-orders/test-rollover",
    schema: "orders/test-rollover",
  };
  let newView = new OrderViewStore(newPath, IDENTITY, () => {}, nextContract);
  newView.accept(event);
  assert.equal(evaluate(newView, nextContract), "unsatisfied");
  assert.throws(
    () => new OrderViewStore(newPath, IDENTITY),
    /view contract does not match configuration/,
  );
  assert.throws(
    () => new OrderViewStore(oldPath, IDENTITY, () => {}, nextContract),
    /view contract does not match configuration/,
  );
  newView.close();
  newView = new OrderViewStore(newPath, IDENTITY, () => {}, nextContract);
  assert.equal(evaluate(newView, nextContract), "unsatisfied");
  newView.close();
  recordFailureDecision("mark-failed", "2", {
    CW_ROLE: "view",
    CW_DATABASE: newPath,
    CW_ISSUER: IDENTITY.issuer,
    CW_DOMAIN: IDENTITY.domain,
    CW_AUDIENCE: IDENTITY.audience,
    CW_SUBJECT: IDENTITY.subject,
    CW_VIEW_CONTRACT: nextContract.contract,
    CW_VIEW_SCHEMA: nextContract.schema,
  });
  newView = new OrderViewStore(newPath, IDENTITY, () => {}, nextContract);
  assert.equal(evaluate(newView, nextContract), "failed");
  newView.close();
  const audit = new DatabaseSync(newPath, { readOnly: true });
  const recorded = audit.prepare("SELECT contract, schema FROM view_failure_events").get();
  audit.close();
  assert.equal(recorded.contract, nextContract.contract);
  assert.equal(recorded.schema, nextContract.schema);
});

test("operator failure for one tenant cannot affect another tenant after restart", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "causalweb-reference-tenant-failure-"));
  assert.equal(resolve(directory, ".."), resolve(tmpdir()));
  context.onTestFinished(async () => {
    await rm(directory, { recursive: true });
  });
  const pathA = join(directory, "tenant-a.sqlite");
  const pathB = join(directory, "tenant-b.sqlite");
  const identityB = { ...IDENTITY, subject: "tenant-b" };
  const event = {
    id: "urn:uuid:00000000-0000-4000-8000-000000000002",
    position: "2",
    order: "second",
    issuedAt: "1000",
    expiresAt: "4600",
    evidence: "signed-test-evidence",
  };
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const issuer = new Issuer(
    IDENTITY.issuer,
    "key-1",
    privateKey,
    new Set([IDENTITY.domain]),
    3600n,
  );
  const verifier = new Verifier(IDENTITY.audience, [
    {
      issuer: IDENTITY.issuer,
      keys: new Map([["key-1", publicKey]]),
      domains: new Set([IDENTITY.domain]),
      maxLifetimeSeconds: 3600n,
      clockSkewSeconds: 0n,
    },
  ]);
  const outcome = (view, identity) => {
    const token = issuer.issueCommitted(
      {
        subject: identity.subject,
        audiences: [identity.audience],
        domain: identity.domain,
        position: 2n,
        issuedAt: NOW,
        expiresAt: NOW + 3600n,
      },
      NOW,
    );
    const evidence = verifier.verify(token, identity.subject, NOW);
    return viewOutcome(
      view,
      identity,
      { contract: ORDER_CONTRACT, schema: ORDER_SCHEMA },
      evidence,
    );
  };
  let viewA = new OrderViewStore(pathA, IDENTITY);
  let viewB = new OrderViewStore(pathB, identityB);
  viewA.accept(event);
  viewB.accept(event);
  viewA.decideFailure("failed", "2", "operator-a");
  assert.equal(outcome(viewA, IDENTITY), "failed");
  assert.equal(outcome(viewB, identityB), "unsatisfied");
  viewA.close();
  viewB.close();
  assert.throws(() => new OrderViewStore(pathA, identityB), /identity or schema version/);
  viewA = new OrderViewStore(pathA, IDENTITY);
  viewB = new OrderViewStore(pathB, identityB);
  assert.equal(outcome(viewA, IDENTITY), "failed");
  assert.equal(outcome(viewB, identityB), "unsatisfied");
  viewA.close();
  viewB.close();
});

test("view version-one data upgrades atomically and version-three missing history fails closed", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "causalweb-reference-view-upgrade-"));
  assert.equal(resolve(directory, ".."), resolve(tmpdir()));
  context.onTestFinished(async () => {
    await rm(directory, { recursive: true });
  });
  const path = join(directory, "view.sqlite");
  const view = new OrderViewStore(path, IDENTITY);
  view.accept({
    id: "urn:uuid:00000000-0000-4000-8000-000000000002",
    position: "2",
    order: "second",
    issuedAt: "1000",
    expiresAt: "4600",
    evidence: "signed-test-evidence",
  });
  view.close();
  const legacy = new DatabaseSync(path);
  legacy.exec("DROP TABLE view_failure_events; DROP TABLE view_contract");
  legacy.prepare("UPDATE reference_identity SET version = 1 WHERE id = 1").run();
  legacy.close();
  const upgraded = new OrderViewStore(path, IDENTITY);
  assert.deepEqual(upgraded.snapshot(), { frontier: null, orders: [] });
  upgraded.decideFailure("failed", "2", "operator-a");
  upgraded.close();
  const persisted = new DatabaseSync(path);
  assert.equal(
    persisted.prepare("SELECT version FROM reference_identity WHERE id = 1").get().version,
    3,
  );
  persisted.exec("DROP TABLE view_failure_events");
  persisted.close();
  assert.throws(() => new OrderViewStore(path, IDENTITY), /view failure history is missing/);
});

test("legacy view decisions migrate under their original contract only", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "causalweb-reference-contract-upgrade-"));
  assert.equal(resolve(directory, ".."), resolve(tmpdir()));
  context.onTestFinished(async () => {
    await rm(directory, { recursive: true });
  });
  const path = join(directory, "view.sqlite");
  const view = new OrderViewStore(path, IDENTITY);
  view.accept({
    id: "urn:uuid:00000000-0000-4000-8000-000000000002",
    position: "2",
    order: "second",
    issuedAt: "1000",
    expiresAt: "4600",
    evidence: "signed-test-evidence",
  });
  view.decideFailure("failed", "2", "operator-a");
  view.close();
  const legacy = new DatabaseSync(path);
  legacy.exec("DROP TABLE view_contract");
  legacy.prepare("UPDATE reference_identity SET version = 2 WHERE id = 1").run();
  legacy.close();
  assert.throws(
    () =>
      new OrderViewStore(path, IDENTITY, () => {}, {
        contract: "reference-orders/test-rollover",
        schema: "orders/test-rollover",
      }),
    /legacy view requires its original contract/,
  );
  const upgraded = new OrderViewStore(path, IDENTITY);
  assert.equal(upgraded.snapshot().firstTerminalFailure, "2");
  upgraded.close();
  const persisted = new DatabaseSync(path, { readOnly: true });
  const version = persisted
    .prepare("SELECT version FROM reference_identity WHERE id = 1")
    .get().version;
  const contract = persisted
    .prepare("SELECT contract, schema FROM view_contract WHERE id = 1")
    .get();
  persisted.close();
  assert.equal(version, 3);
  assert.equal(contract.contract, ORDER_CONTRACT);
  assert.equal(contract.schema, ORDER_SCHEMA);
  const missing = new DatabaseSync(path);
  missing.exec("DROP TABLE view_contract");
  missing.close();
  assert.throws(() => new OrderViewStore(path, IDENTITY), /view contract binding is missing/);
});
