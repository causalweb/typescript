export type ErrorCode = "invalid-evidence" | "invalid-requirements" | "too-large" | "not-observation" | "invalid-configuration" | "unconfirmed";

export class ProtocolError extends Error {
  constructor(readonly code: ErrorCode) {
    super(`Causal Web: ${code}`);
    this.name = "ProtocolError";
  }
}

export function invalid(): never { throw new ProtocolError("invalid-evidence"); }
