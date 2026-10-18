import { parseItem, parseList, serializeList, Token } from "structured-headers";
import { ProtocolError } from "../protocol/error.js";
import { integer, nonempty, object, parseObject } from "../protocol/json.js";
import { DEFAULT_LIMITS, type Limits, validateLimits } from "../protocol/limits.js";

const encoder = new TextEncoder();
const byteLength = (value: string) => encoder.encode(value).byteLength;

export function parseContext(lines: readonly string[], limits: Limits = DEFAULT_LIMITS): string[] {
  validateLimits(limits);
  const bytes =
    lines.reduce((sum, line) => sum + byteLength(line), 0) + Math.max(0, lines.length - 1) * 2;
  if (bytes > limits.maxHeaderBytes) throw new ProtocolError("too-large");
  let list: ReturnType<typeof parseList>;
  try {
    list = parseList(lines.join(", "));
  } catch {
    throw new ProtocolError("invalid-requirements");
  }
  if (list.length > limits.maxRequirements) throw new ProtocolError("too-large");
  if (!list.length) throw new ProtocolError("invalid-requirements");
  return list.map(([value, parameters]) => {
    if (typeof value !== "string" || parameters.size)
      throw new ProtocolError("invalid-requirements");
    if (byteLength(value) > limits.maxTokenBytes) throw new ProtocolError("too-large");
    return value;
  });
}

export function serializeContext(
  tokens: readonly string[],
  limits: Limits = DEFAULT_LIMITS,
): string {
  validateLimits(limits);
  if (tokens.length > limits.maxRequirements) throw new ProtocolError("too-large");
  if (!tokens.length) throw new ProtocolError("invalid-requirements");
  for (const token of tokens) {
    if (byteLength(token) > limits.maxTokenBytes) throw new ProtocolError("too-large");
    if (/[^\x20-\x7E]/.test(token)) throw new ProtocolError("invalid-requirements");
  }
  const field = serializeList(tokens.map((token) => [token, new Map()]));
  if (byteLength(field) > limits.maxHeaderBytes) throw new ProtocolError("too-large");
  return field;
}

export function requestHeaders(
  tokens: readonly string[],
  limits: Limits = DEFAULT_LIMITS,
): Headers {
  return new Headers({
    "Causal-Require": serializeContext(tokens, limits),
    "Cache-Control": "no-cache, no-store",
  });
}

export function contextHeaders(
  tokens: readonly string[],
  limits: Limits = DEFAULT_LIMITS,
): Headers {
  return new Headers({
    "Causal-Context": serializeContext(tokens, limits),
    "Cache-Control": "private, no-store",
  });
}

export const allowedStatus = (status: number) =>
  (status >= 200 && status <= 299 && status !== 202) || status === 404 || status === 410;

export function nominated(headers: Headers): boolean {
  return (headers.get("connection") ?? "")
    .split(",")
    .some((value) =>
      ["causal-require", "causal-context", "causal-result"].includes(value.trim().toLowerCase()),
    );
}

export function result(headers: Headers): string | null {
  const value = headers.get("causal-result");
  if (value === null) return null;
  try {
    const [item, parameters] = parseItem(value);
    if (!(item instanceof Token) || parameters.size) throw new Error();
    return item.toString();
  } catch {
    throw new ProtocolError("unconfirmed");
  }
}

export function acceptConfirmation(
  response: Pick<Response, "status" | "headers">,
  authenticated: boolean,
): void {
  if (
    !authenticated ||
    !allowedStatus(response.status) ||
    nominated(response.headers) ||
    result(response.headers) !== "satisfied"
  )
    throw new ProtocolError("unconfirmed");
}

export interface FailureOutcome {
  readonly index: number;
  readonly outcome: "satisfied" | "unsatisfied" | "unknown" | "unsupported" | "expired" | "failed";
  readonly retryable: boolean;
  readonly disposition?: "applied" | "irrelevant";
}

export interface FailureProblem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly outcomes: readonly FailureOutcome[];
}

const outcomeNames: ReadonlySet<FailureOutcome["outcome"]> = new Set([
  "satisfied",
  "unsatisfied",
  "unknown",
  "unsupported",
  "expired",
  "failed",
]);

async function readFailure(response: Response, count: number): Promise<FailureProblem> {
  const reader = response.body?.getReader();
  if (!reader) throw new ProtocolError("unconfirmed");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 65536) {
        await reader.cancel().catch(() => {});
        throw new ProtocolError("too-large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    const body = parseObject(bytes, 32);
    if (
      body.type !== "https://github.com/causalweb/spec/problems/requirements-not-satisfied" ||
      integer(body.status, 599n) !== BigInt(response.status) ||
      !Array.isArray(body.outcomes) ||
      body.outcomes.length !== count
    )
      throw new Error();
    const outcomes = body.outcomes.map((value, index) => {
      const item = object(value);
      const outcome = nonempty(item.outcome);
      if (
        integer(item.index, BigInt(count)) !== BigInt(index) ||
        !outcomeNames.has(outcome as FailureOutcome["outcome"]) ||
        typeof item.retryable !== "boolean" ||
        (["expired", "unsupported"].includes(outcome) && item.retryable) ||
        (item.disposition !== undefined &&
          (outcome !== "satisfied" ||
            !["applied", "irrelevant"].includes(String(item.disposition))))
      )
        throw new Error();
      return {
        index,
        outcome: outcome as FailureOutcome["outcome"],
        retryable: item.retryable,
        ...(item.disposition !== undefined
          ? { disposition: item.disposition as "applied" | "irrelevant" }
          : {}),
      };
    });
    if (
      outcomes.every((outcome) => outcome.outcome === "satisfied") ||
      response.status !== (outcomes.some((outcome) => outcome.outcome === "failed") ? 503 : 412)
    )
      throw new Error();
    return { type: body.type, title: nonempty(body.title), status: response.status, outcomes };
  } catch {
    throw new ProtocolError("unconfirmed");
  }
}

export type ObservationResult =
  | { readonly kind: "confirmed" | "ordinary-error"; readonly response: Response }
  | {
      readonly kind: "causal-failure";
      readonly response: Response;
      readonly problem: FailureProblem;
    };

export interface ObservationFetchOptions {
  readonly authenticated: (response: Response) => boolean | Promise<boolean>;
  readonly request?: Omit<RequestInit, "redirect">;
}

export interface ObservationWaitOptions extends ObservationFetchOptions {
  readonly signal: AbortSignal;
}

function exchangeSignal(signal: AbortSignal | null | undefined): {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
} {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException("Timed out", "TimeoutError")),
    10000,
  );
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    },
  };
}

/** Portable Fetch client: no redirects, a ten-second exchange deadline, and no silent
 * unconstrained fallback. It transports opaque evidence only; source issuance and observer
 * verification require a separate trusted runtime. */
export async function fetchObservation(
  input: string | URL,
  tokens: readonly string[],
  options: ObservationFetchOptions,
): Promise<ObservationResult> {
  const destination = new URL(input);
  if (
    destination.protocol !== "https:" &&
    !(destination.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(destination.hostname))
  )
    throw new ProtocolError("invalid-configuration");
  if (typeof options.authenticated !== "function") throw new ProtocolError("invalid-configuration");
  const init = options.request ?? {};
  if (typeof init.method === "string" && init.method.toUpperCase() === "HEAD")
    throw new ProtocolError("invalid-configuration");
  const headers = new Headers(init.headers);
  requestHeaders(tokens).forEach((value, name) => {
    headers.set(name, value);
  });
  if (nominated(headers)) throw new ProtocolError("invalid-configuration");
  const exchange = exchangeSignal(init.signal);
  let response: Response;
  try {
    response = await fetch(input, {
      ...init,
      headers,
      redirect: "manual",
      cache: "no-store",
      signal: exchange.signal,
    });
  } catch (error) {
    exchange.dispose();
    throw error;
  }
  try {
    if (nominated(response.headers)) throw new ProtocolError("unconfirmed");
    const marker = result(response.headers);
    if (marker !== null && !(await options.authenticated(response)))
      throw new ProtocolError("unconfirmed");
    if (marker === "satisfied") {
      acceptConfirmation(response, true);
      return { kind: "confirmed", response };
    }
    if (marker === "unsatisfied" && [412, 503].includes(response.status)) {
      if (
        !/^application\/problem\+json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")
      )
        throw new ProtocolError("unconfirmed");
      return {
        kind: "causal-failure",
        response,
        problem: await readFailure(response, tokens.length),
      };
    }
    if (marker !== null || response.status < 400) throw new ProtocolError("unconfirmed");
    return { kind: "ordinary-error", response };
  } catch (error) {
    await response.body?.cancel().catch(() => {});
    throw error;
  } finally {
    exchange.dispose();
  }
}

export async function waitForObservation(
  input: string | URL,
  tokens: readonly string[],
  options: ObservationWaitOptions,
): Promise<ObservationResult> {
  if (!(options.signal instanceof AbortSignal)) throw new ProtocolError("invalid-configuration");
  const method = options.request?.method ?? "GET";
  if (typeof method !== "string" || method.toUpperCase() !== "GET")
    throw new ProtocolError("invalid-configuration");
  while (true) {
    const result = await fetchObservation(input, tokens, {
      authenticated: options.authenticated,
      request: { ...options.request, signal: options.signal },
    });
    if (
      result.kind !== "causal-failure" ||
      result.problem.outcomes.some(
        (outcome) => outcome.outcome !== "unsatisfied" || !outcome.retryable,
      )
    )
      return result;
    await result.response.body?.cancel().catch(() => {});
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        options.signal.removeEventListener("abort", abort);
        resolve();
      }, 250);
      const abort = () => {
        clearTimeout(timeout);
        reject(options.signal.reason);
      };
      if (options.signal.aborted) abort();
      else options.signal.addEventListener("abort", abort, { once: true });
    });
  }
}
