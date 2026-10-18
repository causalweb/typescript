export type ErrorCode =
  | "invalid-evidence"
  | "invalid-requirements"
  | "too-large"
  | "not-observation"
  | "invalid-configuration"
  | "unconfirmed";

export class ProtocolError extends Error {
  constructor(readonly code: ErrorCode) {
    super(`Causal Web: ${code}`);
    this.name = "ProtocolError";
  }
}

export type ObservationErrorCode =
  | "authorization-unavailable"
  | "read-unavailable"
  | "snapshot-target-mismatch"
  | "invalid-representation"
  | "invalid-clock"
  | "verification-failed";
export type ObservationPhase = "before-read" | "read" | "before-response" | "representation";

/** Local adapter/contract failure, never an indexed causal outcome.
 * The original cause is available for application diagnostics and may contain
 * secrets. Redact it before logging; never put it into a response body. */
export class ObservationError extends Error {
  constructor(
    readonly code: ObservationErrorCode,
    readonly phase: ObservationPhase,
    options?: ErrorOptions,
  ) {
    super(`Causal Web observer: ${code}`, options);
    this.name = "ObservationError";
  }

  /** Ordinary empty error, without application data, a causal marker, or the cause. */
  toResponse(): Response {
    const unavailable = [
      "authorization-unavailable",
      "read-unavailable",
      "snapshot-target-mismatch",
    ].includes(this.code);
    return new Response(null, {
      status: unavailable ? 503 : 500,
      headers: { "Cache-Control": "no-store" },
    });
  }
}

export function invalid(): never {
  throw new ProtocolError("invalid-evidence");
}
