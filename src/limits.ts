import { ProtocolError } from "./error.js";

export interface Limits {
  readonly maxRequirements: number;
  readonly maxHeaderBytes: number;
  readonly maxTokenBytes: number;
  readonly maxDecodedBytes: number;
  readonly maxJsonDepth: number;
}

export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
  maxRequirements: 16,
  maxHeaderBytes: 16384,
  maxTokenBytes: 8192,
  maxDecodedBytes: 8192,
  maxJsonDepth: 32,
});

export function validateLimits(limits: Limits): void {
  const fields: readonly (keyof Limits)[] = [
    "maxRequirements",
    "maxHeaderBytes",
    "maxTokenBytes",
    "maxDecodedBytes",
    "maxJsonDepth",
  ];
  if (
    !limits ||
    typeof limits !== "object" ||
    fields.some((key) => !Number.isSafeInteger(limits[key]) || limits[key] <= 0) ||
    limits.maxJsonDepth < 2 ||
    limits.maxJsonDepth > 64
  )
    throw new ProtocolError("invalid-configuration");
}
