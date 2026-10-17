import { parseItem, parseList, serializeList, Token } from "structured-headers";
import { ProtocolError } from "./error.js";
import { DEFAULT_LIMITS, PROFILE, Verifier, validateLimits, type Limits } from "./evidence.js";
import { integer, nonempty, object, parseObject } from "./json.js";
import { Snapshot, type Evaluation, type Outcome } from "./prefix.js";

export function parseContext(lines: readonly string[], limits: Limits = DEFAULT_LIMITS): string[] {
  validateLimits(limits);
  const bytes = lines.reduce((sum, s) => sum + Buffer.byteLength(s), 0) + Math.max(0, lines.length - 1) * 2;
  if (bytes > limits.maxHeaderBytes) throw new ProtocolError("too-large");
  let list: ReturnType<typeof parseList>;
  try { list = parseList(lines.join(", ")); } catch { throw new ProtocolError("invalid-requirements"); }
  if (list.length > limits.maxRequirements) throw new ProtocolError("too-large");
  if (!list.length) throw new ProtocolError("invalid-requirements");
  return list.map(([value, parameters]) => {
    if (typeof value !== "string" || parameters.size) throw new ProtocolError("invalid-requirements");
    if (Buffer.byteLength(value) > limits.maxTokenBytes) throw new ProtocolError("too-large");
    return value;
  });
}

export function serializeContext(tokens: readonly string[], limits: Limits = DEFAULT_LIMITS): string {
  validateLimits(limits);
  if (tokens.length > limits.maxRequirements) throw new ProtocolError("too-large");
  if (!tokens.length) throw new ProtocolError("invalid-requirements");
  for (const token of tokens) {
    if (Buffer.byteLength(token) > limits.maxTokenBytes) throw new ProtocolError("too-large");
    if (/[^\x20-\x7E]/.test(token)) throw new ProtocolError("invalid-requirements");
  }
  const field = serializeList(tokens.map(t => [t, new Map()]));
  if (Buffer.byteLength(field) > limits.maxHeaderBytes) throw new ProtocolError("too-large");
  return field;
}

export function requestHeaders(tokens: readonly string[], limits: Limits = DEFAULT_LIMITS): Headers {
  return new Headers({ "Causal-Require": serializeContext(tokens, limits), "Cache-Control": "no-cache, no-store" });
}

export function contextHeaders(tokens: readonly string[], limits: Limits = DEFAULT_LIMITS): Headers {
  return new Headers({ "Causal-Context": serializeContext(tokens, limits), "Cache-Control": "private, no-store" });
}

const allowedStatus = (status: number) => ((status >= 200 && status <= 299) && status !== 202) || status === 404 || status === 410;
function nominated(headers: Headers): boolean {
  return (headers.get("connection") ?? "").split(",").some(s => ["causal-require", "causal-context", "causal-result"].includes(s.trim().toLowerCase()));
}
function result(headers: Headers): string | null {
  const value = headers.get("causal-result");
  if (value === null) return null;
  try {
    const [item, parameters] = parseItem(value);
    if (!(item instanceof Token) || parameters.size) throw new Error();
    return item.toString();
  } catch { throw new ProtocolError("unconfirmed"); }
}

export function acceptConfirmation(response: Pick<Response, "status" | "headers">, authenticated: boolean): void {
  if (!authenticated || !allowedStatus(response.status) || nominated(response.headers) || result(response.headers) !== "satisfied")
    throw new ProtocolError("unconfirmed");
}

function ordinary(status: number): Response { return new Response(null, { status, headers: { "Cache-Control": "no-store" } }); }
function problem(status: number, kind: string, title: string, outcomes?: readonly (Evaluation & { index: number })[]): Response {
  return Response.json({ type: `https://github.com/causalweb/spec/problems/${kind}`, title, status,
    ...(outcomes ? { outcomes } : {}) }, { status, headers: { "Content-Type": "application/problem+json", "Cache-Control": "no-store",
    ...(outcomes ? { "Causal-Result": "unsatisfied" } : {}) } });
}
function protocolError(error: unknown): Response {
  if (!(error instanceof ProtocolError) || error.code === "invalid-configuration") return ordinary(500);
  if (error.code === "too-large") return problem(431, "request-too-large", "Causal request exceeds configured limits");
  if (error.code === "not-observation") return problem(400, "not-observation", "Endpoint is not a supported observation");
  return problem(400, "invalid-requirements", "Invalid causal requirements");
}

export interface Representation { readonly status: number; readonly headers: Headers; readonly body: Uint8Array; }
export interface ObservationOptions {
  readonly request: Pick<Request, "method" | "headers">;
  readonly target: string;
  readonly designatedObservation: boolean;
  readonly verifier: Verifier;
  readonly subject: string;
  /** Current access check, invoked before selection and before response commitment.
   * False produces 403; a thrown/rejected check produces 503. Log adapter failures
   * inside the callback; exception messages are never included in the HTTP response. */
  readonly authorize: () => boolean | Promise<boolean>;
  readonly clock: () => bigint;
  readonly read: () => Snapshot<Representation> | Promise<Snapshot<Representation>>;
}

async function authorizationFailure(authorize: ObservationOptions["authorize"]): Promise<Response | undefined> {
  try {
    const allowed = await authorize();
    if (typeof allowed !== "boolean") return ordinary(503);
    return allowed ? undefined : ordinary(403);
  } catch { return ordinary(503); }
}

/** One attempt; no progress wait. The transport and storage adapters retain their own obligations. */
export async function observe(options: ObservationOptions): Promise<Response> {
  const { request, target, designatedObservation, verifier, subject, authorize, clock, read } = options;
  const initialDenial = await authorizationFailure(authorize);
  if (initialDenial) return initialDenial;
  let tokens: string[];
  try {
    if (nominated(request.headers)) throw new ProtocolError("invalid-requirements");
    const field = request.headers.get("causal-require");
    tokens = parseContext(field === null ? [] : [field], verifier.limits);
    if (request.method === "HEAD") throw new ProtocolError("invalid-requirements");
    if (!designatedObservation) throw new ProtocolError("not-observation");
    const now = clock();
    for (const token of tokens) verifier.verify(token, subject, now);
  } catch (error) { return protocolError(error); }
  let snapshot: Snapshot<Representation>;
  let representation: Representation;
  try {
    snapshot = await read();
    if (snapshot.target !== target) return ordinary(503);
    representation = { status: snapshot.representation.status, headers: new Headers(snapshot.representation.headers),
      body: Uint8Array.from(snapshot.representation.body) };
  } catch { return ordinary(503); }
  const currentDenial = await authorizationFailure(authorize);
  if (currentDenial) return currentDenial;
  let outcomes: (Evaluation & { index: number })[];
  try {
    const now = clock();
    outcomes = tokens.map((token, index) => ({ ...snapshot.evaluate(verifier.verify(token, subject, now), now), index }));
  } catch (error) { return protocolError(error); }
  if (!outcomes.every(o => o.outcome === "satisfied")) {
    return problem(outcomes.some(o => o.outcome === "failed") ? 503 : 412, "requirements-not-satisfied", "Causal requirements were not satisfied", outcomes);
  }
  if (!allowedStatus(representation.status) || nominated(representation.headers)) return ordinary(500);
  const headers = representation.headers;
  headers.delete("causal-context");
  headers.set("Causal-Result", "satisfied"); headers.set("Cache-Control", "private, no-store");
  if ((headers.get("vary") ?? "").split(",").some(s => s.trim() === "*")) headers.set("Vary", "*");
  else headers.append("Vary", "Causal-Require");
  return new Response([204, 205].includes(representation.status) ? null : Uint8Array.from(representation.body), { status: representation.status, headers });
}

export function capabilities(verifier: Verifier): object {
  return { protocol: "0.1", status: "experimental", audience: verifier.audience, profiles: [PROFILE], evidence_formats: ["application/cw-evidence+jwt"],
    algorithms: ["ES256"], max_requirements: verifier.limits.maxRequirements, max_header_bytes: verifier.limits.maxHeaderBytes, max_wait_seconds: 0 };
}

export interface FailureProblem { readonly type: string; readonly title: string; readonly status: number; readonly outcomes: readonly (Evaluation & { index: number })[]; }
const outcomeNames: ReadonlySet<string> = new Set(["satisfied", "unsatisfied", "unknown", "unsupported", "expired", "failed"]);
async function readFailure(response: Response, count: number): Promise<FailureProblem> {
  const reader = response.body?.getReader();
  if (!reader) throw new ProtocolError("unconfirmed");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 65536) { await reader.cancel().catch(() => {}); throw new ProtocolError("too-large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try {
    const body = parseObject(Buffer.concat(chunks), 32);
    if (body.type !== "https://github.com/causalweb/spec/problems/requirements-not-satisfied"
      || integer(body.status, 599n) !== BigInt(response.status) || !Array.isArray(body.outcomes) || body.outcomes.length !== count)
      throw new Error();
    const outcomes = body.outcomes.map((value, index) => {
      const item = object(value), outcome = nonempty(item.outcome);
      if (integer(item.index, BigInt(count)) !== BigInt(index) || !outcomeNames.has(outcome) || typeof item.retryable !== "boolean"
        || (["expired", "unsupported"].includes(outcome) && item.retryable)
        || (item.disposition !== undefined && (outcome !== "satisfied" || !["applied", "irrelevant"].includes(String(item.disposition))))) throw new Error();
      return { index, outcome: outcome as Outcome, retryable: item.retryable,
        ...(item.disposition !== undefined ? { disposition: item.disposition as "applied" | "irrelevant" } : {}) };
    });
    if (outcomes.every(o => o.outcome === "satisfied") || response.status !== (outcomes.some(o => o.outcome === "failed") ? 503 : 412)) throw new Error();
    return { type: body.type, title: nonempty(body.title), status: response.status, outcomes };
  } catch { throw new ProtocolError("unconfirmed"); }
}

export type ObservationResult = { readonly kind: "confirmed" | "ordinary-error"; readonly response: Response }
  | { readonly kind: "causal-failure"; readonly response: Response; readonly problem: FailureProblem };

export interface ObservationFetchOptions {
  readonly authenticated: (response: Response) => boolean | Promise<boolean>;
  readonly request?: Omit<RequestInit, "redirect">;
}

/** No automatic redirects, a ten-second exchange deadline, and no silent unconstrained fallback. */
export async function fetchObservation(input: string | URL, tokens: readonly string[], options: ObservationFetchOptions): Promise<ObservationResult> {
  const destination = new URL(input);
  if (destination.protocol !== "https:" && !(destination.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(destination.hostname)))
    throw new ProtocolError("invalid-configuration");
  if (typeof options.authenticated !== "function") throw new ProtocolError("invalid-configuration");
  const init = options.request ?? {};
  const headers = new Headers(init.headers);
  requestHeaders(tokens).forEach((value, name) => headers.set(name, value));
  const signals = [AbortSignal.timeout(10000)];
  if (init.signal) signals.push(init.signal);
  const response = await fetch(input, { ...init, headers, redirect: "manual", cache: "no-store", signal: AbortSignal.any(signals) });
  try {
    if (nominated(response.headers)) throw new ProtocolError("unconfirmed");
    const marker = result(response.headers);
    if (marker !== null && !await options.authenticated(response)) throw new ProtocolError("unconfirmed");
    if (marker === "satisfied") { acceptConfirmation(response, true); return { kind: "confirmed", response }; }
    if (marker === "unsatisfied" && [412, 503].includes(response.status)) {
      if (!/^application\/problem\+json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) throw new ProtocolError("unconfirmed");
      return { kind: "causal-failure", response, problem: await readFailure(response, tokens.length) };
    }
    if (marker !== null || response.status < 400) throw new ProtocolError("unconfirmed");
    return { kind: "ordinary-error", response };
  } catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
}
