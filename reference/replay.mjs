import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Issuer } from "@causalweb/protocol";
import { sendDelivery } from "./delivery.mjs";
import { OrderSourceStore } from "./order-store.mjs";
import { materializeEvent } from "./source-evidence.mjs";

function setting(settings, name) {
  const value = settings[name];
  if (typeof value !== "string" || !value) throw new Error(`${name} is required`);
  return value;
}

export async function replaySourceHistory(settings = process.env) {
  if (settings.CW_ROLE && settings.CW_ROLE !== "source") throw new Error("CW_ROLE must be source");
  const identity = Object.fromEntries(
    ["issuer", "domain", "audience", "subject"].map((field) => [
      field,
      setting(settings, `CW_${field.toUpperCase()}`),
    ]),
  );
  const viewUrl = new URL(setting(settings, "CW_VIEW_URL"));
  if (
    viewUrl.protocol !== "https:" ||
    viewUrl.pathname !== "/" ||
    viewUrl.username ||
    viewUrl.password ||
    viewUrl.search ||
    viewUrl.hash
  )
    throw new Error("CW_VIEW_URL must be an HTTPS origin");
  const kid = setting(settings, "CW_KID");
  const key = createPrivateKey(readFileSync(setting(settings, "CW_SIGNING_KEY_FILE")));
  const issuer = new Issuer(identity.issuer, kid, key, new Set([identity.domain]), 3600n);
  const token = setting(settings, "CW_DELIVERY_TOKEN");
  const store = new OrderSourceStore(setting(settings, "CW_DATABASE"), identity);
  let cursor = "0";
  let acknowledged = 0;
  try {
    while (true) {
      const batch = store.replayBatch(cursor);
      if (!batch.length) break;
      for (let event of batch) {
        const now = BigInt(Math.floor(Date.now() / 1000));
        if (event.evidence === null || BigInt(event.expiresAt) <= now)
          event = materializeEvent(
            store,
            event,
            issuer,
            identity.subject,
            identity.audience,
            identity.domain,
            now,
          );
        const status = await sendDelivery(event, viewUrl, token, kid, key);
        if (status !== 204) throw new Error(`delivery rejected: HTTP ${status}`);
        cursor = event.position;
        acknowledged += 1;
      }
    }
    return { acknowledged, through: cursor };
  } finally {
    store.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) {
    process.stderr.write("usage: node reference/replay.mjs\n");
    process.exitCode = 1;
  } else {
    try {
      process.stdout.write(`${JSON.stringify(await replaySourceHistory())}\n`);
    } catch (error) {
      const reason =
        error instanceof Error && /^delivery rejected: HTTP [0-9]{3}$/.test(error.message)
          ? error.message
          : error instanceof Error
            ? error.name
            : "error";
      process.stderr.write(`replay failed: ${reason}\n`);
      process.exitCode = 1;
    }
  }
}
