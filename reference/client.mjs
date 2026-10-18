import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseContext, waitForObservation } from "@causalweb/protocol/client";

function origin(input) {
  const value = new URL(input);
  if (
    value.protocol !== "https:" ||
    value.pathname !== "/" ||
    value.search ||
    value.hash ||
    value.username ||
    value.password
  )
    throw new Error("source and view must be HTTPS origins");
  return value;
}

export async function placeAndObserve(sourceOrigin, viewOrigin, order, token, requestKey) {
  const source = new URL("/orders", origin(sourceOrigin));
  const view = new URL("/orders", origin(viewOrigin));
  if (typeof order !== "string" || !/^[a-z0-9-]{1,80}$/.test(order))
    throw new Error("invalid order identifier");
  if (typeof token !== "string" || !token) throw new Error("CW_APP_TOKEN is required");
  if (typeof requestKey !== "string" || !/^[A-Za-z0-9._~-]{1,128}$/.test(requestKey))
    throw new Error("a reusable request key is required");
  const deadline = AbortSignal.timeout(15_000);
  const issued = await fetch(source, {
    method: "POST",
    redirect: "manual",
    signal: deadline,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "cw-request-key": requestKey,
    },
    body: JSON.stringify({ order }),
  });
  try {
    if (issued.status !== 201 || issued.url !== source.href || issued.redirected)
      throw new Error(`source operation was not committed: HTTP ${issued.status}`);
    const field = issued.headers.get("causal-context");
    if (!field) throw new Error("source did not return causal evidence");
    const evidence = parseContext([field]);
    const result = await waitForObservation(view, evidence, {
      request: { headers: { authorization: `Bearer ${token}` } },
      signal: deadline,
      authenticated: (response) => response.url === view.href && !response.redirected,
    });
    try {
      if (result.kind !== "confirmed")
        throw new Error(`observation did not confirm: HTTP ${result.response.status}`);
      return { status: result.response.status, body: await result.response.json() };
    } finally {
      await result.response.body?.cancel().catch(() => {});
    }
  } finally {
    await issued.body?.cancel().catch(() => {});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [source, view, order, suppliedKey] = process.argv.slice(2);
  try {
    if (!source || !view || !order || process.argv.length > 6)
      throw new Error(
        "usage: client.mjs SOURCE_HTTPS_ORIGIN VIEW_HTTPS_ORIGIN ORDER_ID [REQUEST_KEY]",
      );
    const requestKey = suppliedKey ?? randomUUID();
    process.stderr.write(`request key for retry: ${requestKey}\n`);
    const result = await placeAndObserve(source, view, order, process.env.CW_APP_TOKEN, requestKey);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "client failed"}\n`);
    process.exitCode = 1;
  }
}
