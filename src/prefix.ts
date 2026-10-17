import { ProtocolError } from "./error.js";
import { MAX_POSITION, PROFILE, position, type VerifiedEvidence } from "./evidence.js";

export type Frontier = bigint | null | "unknown";
export type Mapping =
  | Readonly<{
      kind: "relevant";
      frontiers: readonly Frontier[];
      firstTerminalFailure?: bigint;
      progressPossible: boolean;
    }>
  | Readonly<{ kind: "excluded"; first: bigint; last: bigint }>;
export type Outcome =
  | "satisfied"
  | "unsatisfied"
  | "unknown"
  | "unsupported"
  | "expired"
  | "failed";
export interface Evaluation {
  readonly outcome: Outcome;
  readonly retryable: boolean;
  readonly disposition?: "applied" | "irrelevant";
}
export const sourceKey = (issuer: string, domain: string): string =>
  JSON.stringify([issuer, domain]);

/** Construct only from trusted adapter state, never client-supplied lineage or exclusions. */
export class Snapshot<T> {
  readonly #lineage: ReadonlyMap<string, Mapping>;
  constructor(
    readonly target: string,
    readonly representation: T,
    readonly contract: string,
    readonly schema: string,
    lineage: ReadonlyMap<string, Mapping>,
  ) {
    if (!target || !contract || !schema) throw new ProtocolError("invalid-configuration");
    const validPosition = (p: bigint) => typeof p === "bigint" && p >= 0n && p <= MAX_POSITION;
    const entries: [string, Mapping][] = [];
    for (const [key, mapping] of lineage) {
      if (mapping.kind === "relevant") {
        if (
          typeof mapping.progressPossible !== "boolean" ||
          mapping.frontiers.some((f) => f !== null && f !== "unknown" && !validPosition(f)) ||
          (mapping.firstTerminalFailure !== undefined &&
            !validPosition(mapping.firstTerminalFailure))
        )
          throw new ProtocolError("invalid-configuration");
        entries.push([
          key,
          Object.freeze({ ...mapping, frontiers: Object.freeze([...mapping.frontiers]) }),
        ]);
      } else if (mapping.kind === "excluded") {
        if (
          !validPosition(mapping.first) ||
          !validPosition(mapping.last) ||
          mapping.first > mapping.last
        )
          throw new ProtocolError("invalid-configuration");
        entries.push([key, Object.freeze({ ...mapping })]);
      } else throw new ProtocolError("invalid-configuration");
    }
    this.#lineage = new Map(entries);
    Object.freeze(this);
  }

  evaluate(evidence: VerifiedEvidence, now: bigint): Evaluation {
    const result = (outcome: Outcome): Evaluation => ({ outcome, retryable: false });
    if (evidence.expired(now)) return result("expired");
    if (evidence.profile !== PROFILE) return result("unsupported");
    const mapping = this.#lineage.get(sourceKey(evidence.issuer, evidence.domain));
    if (!mapping) return result("unsupported");
    const required = position(evidence.position);
    if (mapping.kind === "excluded")
      return required >= mapping.first && required <= mapping.last
        ? { outcome: "satisfied", disposition: "irrelevant", retryable: false }
        : result("unknown");
    if (
      mapping.frontiers.length > 0 &&
      mapping.frontiers.every((f) => typeof f === "bigint" && f >= required)
    )
      return { outcome: "satisfied", disposition: "applied", retryable: false };
    if (mapping.firstTerminalFailure !== undefined && mapping.firstTerminalFailure <= required)
      return result("failed");
    if (
      !mapping.frontiers.length ||
      mapping.frontiers.includes("unknown") ||
      !mapping.progressPossible
    )
      return result("unknown");
    return { outcome: "unsatisfied", retryable: true };
  }
}
