import { generateKeyPairSync } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Issuer, Snapshot, sourceKey, Verifier } from "@causalweb/sdk";
import {
  ORDER_CONTRACT,
  ORDER_SCHEMA,
  OrderViewStore,
} from "../examples/orders/src/order-store.mjs";

const NOW = 100n;
const ISSUER = "https://issuer.example";
const DOMAIN = "https://issuer.example/domains/orders";
const AUDIENCE = "https://view.example/causal";

function identity(partition) {
  if (!["a", "b", "a-v2"].includes(partition)) throw new Error("invalid partition");
  return {
    issuer: ISSUER,
    domain: DOMAIN,
    audience: AUDIENCE,
    subject: `tenant-${partition === "a-v2" ? "a" : partition}`,
  };
}

function verified(position, subject) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const token = new Issuer(ISSUER, "test-key", privateKey, new Set([DOMAIN]), 1000n).issueCommitted(
    {
      subject,
      audiences: [AUDIENCE],
      domain: DOMAIN,
      position: BigInt(position),
      issuedAt: NOW,
      expiresAt: NOW + 500n,
      evidenceId: `urn:uuid:00000000-0000-4000-8000-00000000000${position}`,
    },
    NOW,
  );
  const evidence = new Verifier(AUDIENCE, [
    {
      issuer: ISSUER,
      keys: new Map([["test-key", publicKey]]),
      domains: new Set([DOMAIN]),
      maxLifetimeSeconds: 1000n,
      clockSkewSeconds: 0n,
    },
  ]).verify(token, subject, NOW);
  return { token, evidence };
}

function event(position, subject) {
  const { token, evidence } = verified(position, subject);
  return {
    id: `urn:uuid:00000000-0000-4000-8000-00000000000${position}`,
    position: evidence.position,
    order: `order-${position}`,
    issuedAt: evidence.issuedAt.toString(),
    expiresAt: evidence.expiresAt.toString(),
    evidence: token,
  };
}

function observe(view, position, subject, viewContract) {
  const { evidence } = verified(position, subject);
  const state = view.snapshot();
  return new Snapshot(
    "/orders",
    null,
    viewContract.contract,
    viewContract.schema,
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
          ...(state.firstTerminalFailure === undefined
            ? {}
            : { firstTerminalFailure: BigInt(state.firstTerminalFailure) }),
        },
      ],
    ]),
  ).evaluate(evidence, NOW).outcome;
}

function run(input) {
  if (input.version !== 1 || input.profile !== "terminal-failure-draft-v1")
    throw new Error("invalid terminal-failure profile input");
  const { id, partition, operation, position, contract, schema } = input.step ?? {};
  if (typeof id !== "string" || !id || !["a", "b", "a-v2"].includes(partition))
    throw new Error("invalid terminal-failure step");
  const viewContract =
    partition === "a-v2"
      ? { contract: "reference-orders/v2", schema: "orders/v2" }
      : { contract: ORDER_CONTRACT, schema: ORDER_SCHEMA };
  if (
    (partition === "a-v2" &&
      (contract !== viewContract.contract || schema !== viewContract.schema)) ||
    (partition !== "a-v2" && (contract !== undefined || schema !== undefined))
  )
    throw new Error("invalid terminal-failure contract");
  const selected = identity(partition);
  const workspace = realpathSync(input.workspace);
  if (
    dirname(workspace) !== realpathSync(tmpdir()) ||
    !basename(workspace).startsWith("causalweb-terminal-profile-")
  )
    throw new Error("invalid terminal-failure workspace");
  const path = join(workspace, `${partition}.sqlite`);
  const exists = existsSync(path);
  if (operation === "setup" ? exists : !exists)
    throw new Error("unexpected terminal-failure store state");
  if (exists && dirname(realpathSync(path)) !== workspace)
    throw new Error("terminal-failure store escapes workspace");
  let outcome;
  const view = new OrderViewStore(path, selected, () => {}, viewContract);
  try {
    if (operation === "setup") {
      view.accept(event("1", selected.subject));
      view.accept({ ...event("3", selected.subject), sourceReportedFailure: true });
      view.accept(event("4", selected.subject));
      outcome = "ready";
    } else if (operation === "observe" && ["1", "2", "3", "4"].includes(position)) {
      outcome = observe(view, position, selected.subject, viewContract);
    } else if (operation === "mark" && position === "3") {
      view.decideFailure("failed", position, "test-view-operator");
      outcome = "recorded";
    } else if (operation === "resolve" && position === "3") {
      view.decideFailure("resolved", position, "test-view-operator");
      outcome = "resolved";
    } else if (operation === "account" && position === "2") {
      view.accept(event(position, selected.subject));
      outcome = "applied";
    } else throw new Error("invalid terminal-failure operation");
  } finally {
    view.close();
  }
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const audit_count = database
      .prepare("SELECT COUNT(*) AS count FROM view_failure_events")
      .get().count;
    return { id, outcome, audit_count };
  } finally {
    database.close();
  }
}

let source = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  source += chunk;
});
process.stdin.on("end", () => {
  try {
    process.stdout.write(`${JSON.stringify(run(JSON.parse(source)))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "terminal adapter failed"}\n`);
    process.exitCode = 1;
  }
});
