import { userInfo } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ORDER_CONTRACT, ORDER_SCHEMA, OrderViewStore } from "./order-store.mjs";

export function recordFailureDecision(action, value, settings = process.env) {
  if (action !== "mark-failed" && action !== "resolve-failed")
    throw new Error("action must be mark-failed or resolve-failed");
  if (settings.CW_ROLE && settings.CW_ROLE !== "view") throw new Error("CW_ROLE must be view");
  const identity = Object.fromEntries(
    ["issuer", "domain", "audience", "subject"].map((field) => {
      const name = `CW_${field.toUpperCase()}`;
      const value = settings[name];
      if (!value) throw new Error(`${name} is required`);
      return [field, value];
    }),
  );
  const database = settings.CW_DATABASE;
  if (!database) throw new Error("CW_DATABASE is required");
  const viewContract = {
    contract: settings.CW_VIEW_CONTRACT ?? ORDER_CONTRACT,
    schema: settings.CW_VIEW_SCHEMA ?? ORDER_SCHEMA,
  };
  if (
    !viewContract.contract ||
    !viewContract.schema ||
    (settings.CW_VIEW_CONTRACT === undefined) !== (settings.CW_VIEW_SCHEMA === undefined)
  )
    throw new Error("CW_VIEW_CONTRACT and CW_VIEW_SCHEMA must be configured together");
  const store = new OrderViewStore(database, identity, () => {}, viewContract);
  try {
    store.decideFailure(
      action === "mark-failed" ? "failed" : "resolved",
      value,
      userInfo().username,
    );
  } finally {
    store.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action, value, extra] = process.argv.slice(2);
    if (!action || !value || extra)
      throw new Error("usage: operator.mjs mark-failed|resolve-failed POSITION");
    recordFailureDecision(action, value);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "operator command failed"}\n`);
    process.exitCode = 1;
  }
}
