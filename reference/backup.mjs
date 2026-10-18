import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { constants, copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync, backup as sqliteBackup } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { position } from "@causalweb/protocol";
import { ORDER_CONTRACT, ORDER_SCHEMA } from "./order-store.mjs";

const FORMAT = "causalweb-order-reference-backup/v2";
const FILES = ["source.sqlite", "view.sqlite"];
const TABLES = [
  ["reference_identity", "source_orders", "source_state"],
  ["reference_identity", "view_orders", "view_pending", "view_state"],
];

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function inspect(path, requiredTables) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    if (database.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok")
      throw new Error("SQLite integrity check failed");
    const names = new Set(
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((r) => r.name),
    );
    if (requiredTables.some((name) => !names.has(name)))
      throw new Error("database role schema is missing");
    if (database.prepare("PRAGMA foreign_key_check").get())
      throw new Error("database request mapping is inconsistent");
  } finally {
    database.close();
  }
}

function inspectPair(sourcePath, viewPath) {
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  const view = new DatabaseSync(viewPath, { readOnly: true });
  try {
    const sourceIdentity = source
      .prepare(
        "SELECT version, role, issuer, domain, audience, subject FROM reference_identity WHERE id = 1",
      )
      .get();
    const viewIdentity = view
      .prepare(
        "SELECT version, role, issuer, domain, audience, subject FROM reference_identity WHERE id = 1",
      )
      .get();
    if (
      (sourceIdentity?.version !== 1 && sourceIdentity?.version !== 2) ||
      sourceIdentity.role !== "source" ||
      (viewIdentity?.version !== 1 && viewIdentity?.version !== 2) ||
      viewIdentity.role !== "view" ||
      ["issuer", "domain", "audience", "subject"].some(
        (field) => sourceIdentity[field] !== viewIdentity[field],
      )
    )
      throw new Error("source and view deployment identities do not match");
    if (
      sourceIdentity.version === 2 &&
      !source
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'source_requests'")
        .get()
    )
      throw new Error("source request mapping is missing");
    if (
      viewIdentity.version === 2 &&
      !view
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'view_failure_events'",
        )
        .get()
    )
      throw new Error("view failure history is missing");
    let next = 1n;
    for (const row of source
      .prepare("SELECT position FROM source_orders ORDER BY length(position), position")
      .iterate()) {
      if (position(row.position) !== next) throw new Error("source history is not contiguous");
      next += 1n;
    }
    if (
      source.prepare("SELECT next_position FROM source_state WHERE id = 1").get()?.next_position !==
      next.toString()
    )
      throw new Error("source next position disagrees with history");

    const state = view.prepare("SELECT frontier FROM view_state WHERE id = 1").get();
    if (!state) throw new Error("view frontier is missing");
    const frontier = state.frontier === null ? 0n : position(state.frontier);
    const lookup = source.prepare(
      "SELECT event_id, order_value, evidence FROM source_orders WHERE position = ?",
    );
    let expected = 1n;
    for (const row of view
      .prepare(
        "SELECT position, event_id, order_value FROM view_orders ORDER BY length(position), position",
      )
      .iterate()) {
      if (position(row.position) !== expected)
        throw new Error("view applied history is not contiguous");
      const fact = lookup.get(row.position);
      if (!fact?.evidence || fact.event_id !== row.event_id || fact.order_value !== row.order_value)
        throw new Error("view applied fact disagrees with source");
      expected += 1n;
    }
    if (frontier !== expected - 1n) throw new Error("view frontier disagrees with applied state");
    for (const row of view
      .prepare("SELECT position, event_id, order_value FROM view_pending")
      .iterate()) {
      if (position(row.position) <= frontier) throw new Error("pending fact is already covered");
      const fact = lookup.get(row.position);
      if (!fact?.evidence || fact.event_id !== row.event_id || fact.order_value !== row.order_value)
        throw new Error("view pending fact disagrees with source");
    }
    if (viewIdentity.version === 2) {
      const latest = new Map();
      for (const row of view
        .prepare(
          "SELECT position, contract, schema, action, operator FROM view_failure_events ORDER BY id",
        )
        .iterate()) {
        if (
          position(row.position) < 1n ||
          row.contract !== ORDER_CONTRACT ||
          row.schema !== ORDER_SCHEMA ||
          !["failed", "resolved"].includes(row.action) ||
          !row.operator
        )
          throw new Error("view failure history is invalid");
        latest.set(row.position, row.action);
      }
      for (const [value, action] of latest) {
        if (action !== "failed" || position(value) <= frontier) continue;
        if (!view.prepare("SELECT 1 FROM view_pending WHERE position = ?").get(value))
          throw new Error("active view failure has no pending fact");
      }
    }
  } finally {
    source.close();
    view.close();
  }
}

export async function createBackup(sourcePath, viewPath, destination) {
  const inputs = [resolve(sourcePath), resolve(viewPath)];
  if (inputs[0] === inputs[1]) throw new Error("source and view databases must differ");
  for (const input of inputs) {
    if (!(await stat(input)).isFile()) throw new Error("database path must name a file");
  }
  for (let index = 0; index < inputs.length; index += 1) inspect(inputs[index], TABLES[index]);
  await mkdir(destination);
  const hashes = [];
  for (let index = 0; index < inputs.length; index += 1) {
    const database = new DatabaseSync(inputs[index], { readOnly: true });
    const output = join(destination, FILES[index]);
    try {
      await sqliteBackup(database, output);
    } finally {
      database.close();
    }
    inspect(output, TABLES[index]);
    hashes.push(await hashFile(output));
  }
  inspectPair(join(destination, FILES[0]), join(destination, FILES[1]));
  await writeFile(
    join(destination, "manifest.json"),
    JSON.stringify({ format: FORMAT, sourceSha256: hashes[0], viewSha256: hashes[1] }),
    { flag: "wx" },
  );
}

export async function restoreBackup(backupDirectory, destination) {
  const manifest = JSON.parse(await readFile(join(backupDirectory, "manifest.json"), "utf8"));
  if (
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    Object.keys(manifest).length !== 3 ||
    manifest.format !== FORMAT ||
    !/^[a-f0-9]{64}$/.test(manifest.sourceSha256) ||
    !/^[a-f0-9]{64}$/.test(manifest.viewSha256)
  )
    throw new Error("invalid backup manifest");
  for (let index = 0; index < FILES.length; index += 1) {
    const input = join(backupDirectory, FILES[index]);
    if ((await hashFile(input)) !== manifest[index === 0 ? "sourceSha256" : "viewSha256"])
      throw new Error("backup checksum mismatch");
    inspect(input, TABLES[index]);
  }
  inspectPair(join(backupDirectory, FILES[0]), join(backupDirectory, FILES[1]));
  await mkdir(destination);
  for (const file of FILES)
    await copyFile(join(backupDirectory, file), join(destination, file), constants.COPYFILE_EXCL);
  for (let index = 0; index < FILES.length; index += 1) {
    const output = join(destination, FILES[index]);
    if ((await hashFile(output)) !== manifest[index === 0 ? "sourceSha256" : "viewSha256"])
      throw new Error("restored database checksum mismatch");
    inspect(output, TABLES[index]);
  }
  inspectPair(join(destination, FILES[0]), join(destination, FILES[1]));
  await writeFile(join(destination, "RESTORED.json"), JSON.stringify(manifest), { flag: "wx" });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, first, second, third] = process.argv.slice(2);
  try {
    if (command === "create" && first && second && third) await createBackup(first, second, third);
    else if (command === "restore" && first && second && !third) await restoreBackup(first, second);
    else
      throw new Error(
        "usage: backup.mjs create SOURCE_DB VIEW_DB NEW_DIR | restore BACKUP_DIR NEW_DIR",
      );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "backup operation failed"}\n`);
    process.exitCode = 1;
  }
}
