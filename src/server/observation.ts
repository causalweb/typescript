import { allowedStatus, nominated, parseContext } from "../client/index.js";
import { ObservationError, type ObservationPhase, ProtocolError } from "../protocol/error.js";
import { PROFILE, type Verifier } from "../protocol/evidence.js";
import { type Evaluation, Snapshot } from "../protocol/prefix.js";

function ordinary(status: number): Response {
  return new Response(null, { status, headers: { "Cache-Control": "no-store" } });
}
function problem(
  status: number,
  kind: string,
  title: string,
  outcomes?: readonly (Evaluation & { index: number })[],
): Response {
  return Response.json(
    {
      type: `https://github.com/causalweb/spec/problems/${kind}`,
      title,
      status,
      ...(outcomes ? { outcomes } : {}),
    },
    {
      status,
      headers: {
        "Content-Type": "application/problem+json",
        "Cache-Control": "no-store",
        ...(outcomes ? { "Causal-Result": "unsatisfied" } : {}),
      },
    },
  );
}
function protocolError(error: unknown, phase: ObservationPhase): Response {
  if (!(error instanceof ProtocolError) || error.code === "invalid-configuration")
    throw new ObservationError("verification-failed", phase, { cause: error });
  if (error.code === "too-large")
    return problem(431, "request-too-large", "Causal request exceeds configured limits");
  if (error.code === "not-observation")
    return problem(400, "not-observation", "Endpoint is not a supported observation");
  return problem(400, "invalid-requirements", "Invalid causal requirements");
}

export interface Representation {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Uint8Array;
}
export interface ObservationOptions {
  readonly request: Pick<Request, "method" | "headers">;
  readonly target: string;
  readonly designatedObservation: boolean;
  readonly verifier: Verifier;
  readonly subject: string;
  /** Current access check, invoked before selection and before response commitment.
   * False produces 403; a thrown/rejected check rejects with ObservationError.
   * Its cause remains local. The host must handle it before writing a response. */
  readonly authorize: () => boolean | Promise<boolean>;
  readonly clock: () => bigint;
  readonly read: () => Snapshot<Representation> | Promise<Snapshot<Representation>>;
}

async function authorized(
  authorize: ObservationOptions["authorize"],
  phase: ObservationPhase,
): Promise<boolean> {
  try {
    const allowed = await authorize();
    if (typeof allowed !== "boolean") throw new TypeError("authorize must resolve to a boolean");
    return allowed;
  } catch (cause) {
    throw new ObservationError("authorization-unavailable", phase, { cause });
  }
}

function readClock(clock: ObservationOptions["clock"], phase: ObservationPhase): bigint {
  try {
    const now = clock();
    if (typeof now !== "bigint" || now < 0n)
      throw new TypeError("clock must return non-negative bigint UTC seconds");
    return now;
  } catch (cause) {
    throw new ObservationError("invalid-clock", phase, { cause });
  }
}

/** One attempt; no progress wait. Local adapter/contract failures reject with
 * ObservationError; denied access and protocol outcomes return HTTP responses.
 * The host owns transport cancellation, bounded adapter work, and error handling. */
export async function observe(options: ObservationOptions): Promise<Response> {
  const { request, target, designatedObservation, verifier, subject, authorize, clock, read } =
    options;
  if (!(await authorized(authorize, "before-read"))) return ordinary(403);
  let tokens: string[];
  try {
    if (nominated(request.headers)) throw new ProtocolError("invalid-requirements");
    const field = request.headers.get("causal-require");
    tokens = parseContext(field === null ? [] : [field], verifier.limits);
    if (request.method === "HEAD") throw new ProtocolError("invalid-requirements");
    if (!designatedObservation) throw new ProtocolError("not-observation");
    const now = readClock(clock, "before-read");
    for (const token of tokens) verifier.verify(token, subject, now);
  } catch (error) {
    if (error instanceof ObservationError) throw error;
    return protocolError(error, "before-read");
  }
  let snapshot: Snapshot<Representation>;
  let representation: Representation;
  try {
    snapshot = await read();
  } catch (cause) {
    throw new ObservationError("read-unavailable", "read", { cause });
  }
  if (!(snapshot instanceof Snapshot))
    throw new ObservationError("invalid-representation", "representation");
  if (snapshot.target !== target) throw new ObservationError("snapshot-target-mismatch", "read");
  try {
    const value = snapshot.representation;
    if (!value) throw new TypeError("snapshot representation is missing");
    const { status, headers, body } = value;
    if (!Number.isInteger(status) || !(headers instanceof Headers) || !(body instanceof Uint8Array))
      throw new TypeError(
        "snapshot representation must have an integer status, Headers, and Uint8Array body",
      );
    representation = { status, headers: new Headers(headers), body: Uint8Array.from(body) };
  } catch (cause) {
    throw new ObservationError("invalid-representation", "representation", { cause });
  }
  if (!(await authorized(authorize, "before-response"))) return ordinary(403);
  let outcomes: (Evaluation & { index: number })[];
  try {
    const now = readClock(clock, "before-response");
    outcomes = tokens.map((token, index) => ({
      ...snapshot.evaluate(verifier.verify(token, subject, now), now),
      index,
    }));
  } catch (error) {
    if (error instanceof ObservationError) throw error;
    return protocolError(error, "before-response");
  }
  if (!outcomes.every((outcome) => outcome.outcome === "satisfied")) {
    return problem(
      outcomes.some((outcome) => outcome.outcome === "failed") ? 503 : 412,
      "requirements-not-satisfied",
      "Causal requirements were not satisfied",
      outcomes,
    );
  }
  if (!allowedStatus(representation.status) || nominated(representation.headers))
    throw new ObservationError("invalid-representation", "representation");
  const headers = representation.headers;
  headers.delete("causal-context");
  headers.set("Causal-Result", "satisfied");
  headers.set("Cache-Control", "private, no-store");
  if ((headers.get("vary") ?? "").split(",").some((value) => value.trim() === "*"))
    headers.set("Vary", "*");
  else headers.append("Vary", "Causal-Require");
  return new Response(
    [204, 205].includes(representation.status) ? null : Uint8Array.from(representation.body),
    { status: representation.status, headers },
  );
}

export function capabilities(verifier: Verifier): object {
  return {
    protocol: "0.1",
    status: "experimental",
    audience: verifier.audience,
    profiles: [PROFILE],
    evidence_formats: ["application/cw-evidence+jwt"],
    algorithms: ["ES256"],
    max_requirements: verifier.limits.maxRequirements,
    max_header_bytes: verifier.limits.maxHeaderBytes,
    max_wait_seconds: 0,
  };
}
