import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
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
import { OrderSourceStore, OrderViewStore } from "./order-store.mjs";

const ISSUER = "https://orders.example";
const DOMAIN = "https://orders.example/domains/orders";
const AUDIENCE = "https://view.example/causal";
const SUBJECT = "tenant-a";
const NOW = 1_000n;
const IDENTITY = { issuer: ISSUER, domain: DOMAIN, audience: AUDIENCE, subject: SUBJECT };

test("request keys bind one committed fact across retries and expiry", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "causalweb-reference-requests-"));
  assert.equal(resolve(directory, ".."), resolve(tmpdir()));
  const path = join(directory, "source.sqlite");
  let source = new OrderSourceStore(path, IDENTITY);
  context.onTestFinished(async () => {
    source.close();
    await rm(directory, { recursive: true });
  });
  assert.throws(() => source.commit("first", NOW, NOW + 3600n), /request key/);
  const first = source.commit("first", NOW, NOW + 3600n, "request-1");
  assert.deepEqual(source.commit("first", NOW + 1n, NOW + 3601n, "request-1"), first);
  assert.throws(
    () => source.commit("different", NOW, NOW + 3600n, "request-1"),
    /bound to another order/,
  );
  source.materialize(first.id, "first-evidence", NOW, NOW + 3600n);
  source.delivered(first.id, "first-evidence");
  source.close();
  source = new OrderSourceStore(path, IDENTITY);
  const retry = source.commit("first", NOW + 3600n, NOW + 7200n, "request-1");
  assert.equal(retry.id, first.id);
  assert.equal(retry.position, first.position);
  assert.equal(retry.evidence, "first-evidence");
  source.refresh(first.id, retry.evidence, "fresh-evidence", NOW + 3600n, NOW + 7200n, NOW + 3600n);
  assert.equal(
    source.commit("first", NOW + 3600n, NOW + 7200n, "request-1").evidence,
    "fresh-evidence",
  );
  assert.equal(source.commit("second", NOW + 3600n, NOW + 7200n, "request-2").position, "2");
});

test("source adds request mapping without changing older committed positions", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "causalweb-reference-upgrade-"));
  assert.equal(resolve(directory, ".."), resolve(tmpdir()));
  const path = join(directory, "source.sqlite");
  let source = new OrderSourceStore(path, IDENTITY);
  context.onTestFinished(async () => {
    source.close();
    await rm(directory, { recursive: true });
  });
  const historical = source.commit("historical", NOW, NOW + 3600n, "old-write");
  source.close();
  const legacy = new DatabaseSync(path);
  legacy.exec("DROP TABLE source_requests");
  legacy.prepare("UPDATE reference_identity SET version = 1 WHERE id = 1").run();
  legacy.close();
  source = new OrderSourceStore(path, IDENTITY);
  assert.equal(source.unissued()[0].id, historical.id);
  const upgraded = new DatabaseSync(path, { readOnly: true });
  assert.equal(
    upgraded.prepare("SELECT version FROM reference_identity WHERE id = 1").get().version,
    2,
  );
  upgraded.close();
  const current = source.commit("current", NOW, NOW + 3600n, "new-write");
  assert.equal(current.position, "2");
  assert.equal(source.commit("current", NOW, NOW + 3600n, "new-write").id, current.id);
});

test("source refuses to reconstruct a missing version-two request map", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "causalweb-reference-map-loss-"));
  assert.equal(resolve(directory, ".."), resolve(tmpdir()));
  context.onTestFinished(async () => {
    await rm(directory, { recursive: true });
  });
  const path = join(directory, "source.sqlite");
  const source = new OrderSourceStore(path, IDENTITY);
  source.commit("first", NOW, NOW + 3600n, "request-1");
  source.close();
  const damaged = new DatabaseSync(path);
  damaged.exec("DROP TABLE source_requests");
  damaged.close();
  assert.throws(() => new OrderSourceStore(path, IDENTITY), /request mapping is missing/);
});

test("source commitment and view snapshot survive restart without a frontier ahead of state", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "causalweb-reference-store-"));
  assert.equal(resolve(directory, ".."), resolve(tmpdir()));
  const sourcePath = join(directory, "source.sqlite");
  const viewPath = join(directory, "view.sqlite");
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const issuer = new Issuer(ISSUER, "key-1", privateKey, new Set([DOMAIN]), 3600n);
  const verifier = new Verifier(AUDIENCE, [
    {
      issuer: ISSUER,
      keys: new Map([["key-1", publicKey]]),
      domains: new Set([DOMAIN]),
      maxLifetimeSeconds: 3600n,
      clockSkewSeconds: 0n,
    },
  ]);
  let source = new OrderSourceStore(sourcePath, IDENTITY);
  let view = new OrderViewStore(viewPath, IDENTITY);
  context.onTestFinished(async () => {
    source.close();
    view.close();
    assert.ok(directory.startsWith(join(resolve(tmpdir()), "causalweb-reference-store-")));
    await rm(directory, { recursive: true });
  });

  const first = source.commit("first", NOW, NOW + 3600n, "first");
  const second = source.commit("second", NOW, NOW + 3600n, "second");
  assert.equal(first.position, "1");
  assert.equal(second.position, "2");
  assert.deepEqual(
    source.unissued().map((event) => event.position),
    ["1", "2"],
  );
  source.close();
  assert.throws(
    () => new OrderSourceStore(sourcePath, { ...IDENTITY, domain: `${DOMAIN}/wrong` }),
    /identity or schema version/,
  );
  source = new OrderSourceStore(sourcePath, IDENTITY);

  const signEvent = (event) => {
    const evidence = issuer.issueCommitted(
      {
        subject: SUBJECT,
        audiences: [AUDIENCE],
        domain: DOMAIN,
        position: BigInt(event.position),
        issuedAt: BigInt(event.issuedAt),
        expiresAt: BigInt(event.expiresAt),
        evidenceId: event.id,
      },
      NOW,
    );
    source.materialize(event.id, evidence, BigInt(event.issuedAt), BigInt(event.expiresAt));
    return { ...event, evidence };
  };
  const signedFirst = signEvent(first);
  const signedSecond = signEvent(second);
  assert.equal(source.undelivered().length, 2);

  const constrained = async (token) => {
    return observe({
      request: { method: "GET", headers: requestHeaders([token]) },
      target: "/orders",
      designatedObservation: true,
      verifier,
      subject: SUBJECT,
      authorize: () => true,
      clock: () => NOW,
      read: () => {
        const state = view.snapshot();
        return new Snapshot(
          "/orders",
          {
            status: 200,
            headers: new Headers({ "content-type": "application/json" }),
            body: Buffer.from(JSON.stringify(state.orders)),
          },
          "reference-orders/v1",
          "orders/v1",
          new Map([
            [
              sourceKey(ISSUER, DOMAIN),
              {
                kind: "relevant",
                frontiers: [
                  state.frontier === null || state.frontier === "unknown"
                    ? state.frontier
                    : BigInt(state.frontier),
                ],
                progressPossible: true,
              },
            ],
          ]),
        );
      },
    });
  };

  assert.equal((await constrained(signedFirst.evidence)).status, 412);
  verifier.verify(signedSecond.evidence, SUBJECT, NOW);
  view.accept(signedSecond);
  assert.deepEqual(view.snapshot(), { frontier: null, orders: [] });
  assert.equal((await constrained(signedSecond.evidence)).status, 412);
  view.close();
  assert.throws(
    () => new OrderViewStore(viewPath, { ...IDENTITY, subject: "other-tenant" }),
    /identity or schema version/,
  );
  view = new OrderViewStore(viewPath, IDENTITY);
  assert.deepEqual(view.snapshot(), { frontier: null, orders: [] });

  verifier.verify(signedFirst.evidence, SUBJECT, NOW);
  view.accept(signedFirst);
  assert.deepEqual(view.snapshot(), { frontier: "2", orders: ["first", "second"] });
  view.accept(signedSecond);
  assert.throws(() => view.accept({ ...signedSecond, order: "tampered" }), /conflicting/);
  assert.deepEqual(view.snapshot(), { frontier: "2", orders: ["first", "second"] });
  const response = await constrained(signedSecond.evidence);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("causal-result"), "satisfied");
  assert.deepEqual(await response.json(), ["first", "second"]);

  source.delivered(first.id, signedFirst.evidence);
  source.delivered(second.id, signedSecond.evidence);
  assert.deepEqual(source.undelivered(), []);

  view.close();
  const damaged = new DatabaseSync(viewPath);
  damaged.prepare("UPDATE view_orders SET position = '3' WHERE position = '2'").run();
  assert.equal(damaged.prepare("SELECT COUNT(*) AS count FROM view_orders").get().count, 2);
  damaged.close();
  view = new OrderViewStore(viewPath, IDENTITY);
  assert.equal(view.snapshot().frontier, "unknown");
  assert.throws(() => view.accept(signedSecond), /lineage requires repair/);
  const uncertain = await constrained(signedSecond.evidence);
  assert.equal(uncertain.status, 412);
  assert.equal((await uncertain.json()).outcomes[0].outcome, "unknown");
});

test("populated unbound database fails closed instead of guessing its deployment identity", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "causalweb-reference-identity-"));
  assert.equal(resolve(directory, ".."), resolve(tmpdir()));
  context.onTestFinished(async () => {
    await rm(directory, { recursive: true });
  });
  const path = join(directory, "source.sqlite");
  const source = new OrderSourceStore(path, IDENTITY);
  const event = source.commit("historical", NOW, NOW + 3600n, "historical");
  source.close();
  const legacy = new DatabaseSync(path);
  legacy.exec("DROP TABLE reference_identity");
  legacy.close();
  assert.throws(
    () => new OrderSourceStore(path, IDENTITY),
    /populated database has no bound identity/,
  );
  const preserved = new DatabaseSync(path, { readOnly: true });
  assert.equal(
    preserved.prepare("SELECT event_id FROM source_orders WHERE position = '1'").get()?.event_id,
    event.id,
  );
  preserved.close();

  const emptyPath = join(directory, "empty.sqlite");
  const empty = new OrderSourceStore(emptyPath, IDENTITY);
  empty.close();
  const unboundEmpty = new DatabaseSync(emptyPath);
  unboundEmpty.exec("DROP TABLE reference_identity");
  unboundEmpty.close();
  const rebound = new OrderSourceStore(emptyPath, IDENTITY);
  assert.equal(rebound.commit("first", NOW, NOW + 3600n, "first").position, "1");
  rebound.close();
});

test("expired outbox evidence can be reissued for the same fact after an ambiguous acknowledgement", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "causalweb-reference-refresh-"));
  assert.equal(resolve(directory, ".."), resolve(tmpdir()));
  const source = new OrderSourceStore(join(directory, "source.sqlite"), IDENTITY);
  const view = new OrderViewStore(join(directory, "view.sqlite"), IDENTITY);
  context.onTestFinished(async () => {
    source.close();
    view.close();
    await rm(directory, { recursive: true });
  });
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const issuer = new Issuer(ISSUER, "key-1", privateKey, new Set([DOMAIN]), 3600n);
  const verifier = new Verifier(AUDIENCE, [
    {
      issuer: ISSUER,
      keys: new Map([["key-1", publicKey]]),
      domains: new Set([DOMAIN]),
      maxLifetimeSeconds: 3600n,
      clockSkewSeconds: 0n,
    },
  ]);
  const first = source.commit("first", NOW, NOW + 3600n, "first");
  const second = source.commit("second", NOW, NOW + 3600n, "second");
  const issue = (event, id, issuedAt, expiresAt, now) =>
    issuer.issueCommitted(
      {
        subject: SUBJECT,
        audiences: [AUDIENCE],
        domain: DOMAIN,
        position: BigInt(event.position),
        issuedAt,
        expiresAt,
        evidenceId: id,
      },
      now,
    );
  const firstEvidence = issue(first, first.id, NOW, NOW + 3600n, NOW);
  const secondEvidence = issue(second, second.id, NOW, NOW + 3600n, NOW);
  source.materialize(first.id, firstEvidence, NOW, NOW + 3600n);
  source.materialize(second.id, secondEvidence, NOW, NOW + 3600n);
  const original = { ...second, evidence: secondEvidence };
  verifier.verify(original.evidence, SUBJECT, NOW);
  view.accept(original);
  assert.deepEqual(view.snapshot(), { frontier: null, orders: [] });

  const later = NOW + 7200n;
  const premature = NOW + 100n;
  const prematureEvidence = issue(
    second,
    `urn:uuid:${randomUUID()}`,
    premature,
    premature + 3600n,
    premature,
  );
  assert.throws(
    () =>
      source.refresh(
        second.id,
        secondEvidence,
        prematureEvidence,
        premature,
        premature + 3600n,
        premature,
      ),
    /not eligible/,
  );
  const refreshedEvidence = issue(second, `urn:uuid:${randomUUID()}`, later, later + 3600n, later);
  source.refresh(second.id, secondEvidence, refreshedEvidence, later, later + 3600n, later);
  assert.equal(source.undelivered()[1].evidence, refreshedEvidence);
  assert.throws(() => source.delivered(second.id, secondEvidence), /does not match/);
  const refreshed = {
    ...second,
    issuedAt: later.toString(),
    expiresAt: (later + 3600n).toString(),
    evidence: refreshedEvidence,
  };
  verifier.verify(refreshed.evidence, SUBJECT, later);
  view.accept(refreshed);
  assert.deepEqual(view.snapshot(), { frontier: null, orders: [] });
  view.accept({ ...first, evidence: firstEvidence });
  view.accept(refreshed);
  assert.deepEqual(view.snapshot(), { frontier: "2", orders: ["first", "second"] });
  assert.throws(() => view.accept({ ...refreshed, order: "forged" }), /conflicting/);
  source.delivered(second.id, refreshedEvidence);
  assert.throws(
    () => source.refresh(second.id, refreshedEvidence, firstEvidence, later, later + 3600n, later),
    /not eligible/,
  );
});
