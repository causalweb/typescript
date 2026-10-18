import type { JsonWebKey } from "node:crypto";
import { readFileSync } from "node:fs";

interface EvidenceFixtures {
  expected_audience: string;
  expected_issuer: string;
  expected_subject: string;
  public_jwk: JsonWebKey & { kid: string };
  authorized_domains?: string[];
  max_lifetime_seconds?: number;
  clock_skew_seconds?: number;
  validation_time: number;
  cases: { id: string; compact: string; expected: string; trusted_issuer?: string }[];
}

type Domain = "domain_a" | "domain_b";
type PositionCase =
  | { id: string; kind: "position-validation"; position: string; expected: "reject-request" }
  | {
      id: string;
      kind: "position-validation-and-comparison";
      position: string;
      frontier: string;
      expected: "satisfied";
    };
type ReductionCase = {
  id: string;
  kind: "context-reduction";
  evidence: { domain: Domain; position: string; exp: number }[];
  required_usable_until: number;
  allowed_retained_positions: string[][];
};
type EvaluationCase = {
  id: string;
  kind?: undefined;
  requirements: {
    domain: Domain;
    position: string;
    expires_at?: number;
    profile_supported?: boolean;
  }[];
  state: {
    configured_domains?: Domain[];
    authorized_exclusions?: Domain[];
    lineage_available?: boolean;
    frontiers?: Partial<Record<Domain, string | null>>;
    selected_state_frontiers?: Partial<Record<Domain, string | null>>;
    component_frontiers?: Partial<Record<Domain, (string | null)[]>>;
    terminal_failures?: { domain: Domain; position: string }[];
  };
  expected: { outcome: string; disposition?: string }[];
  aggregate_success: boolean;
};
interface PrefixFixtures {
  domain_a: string;
  domain_b: string;
  cases: (PositionCase | ReductionCase | EvaluationCase)[];
}
interface HttpFixtures {
  cases: {
    id: string;
    response: { status: number; causal_result?: string | null };
    request?: { causal_require?: string };
    client_accepts_constrained_success: boolean;
    client_accepts_causal_confirmation?: boolean;
  }[];
}
interface FixtureFiles {
  "jws-evidence.json": EvidenceFixtures;
  "evidence-validation.json": EvidenceFixtures;
  "uri-identities.json": EvidenceFixtures;
  "prefix-evaluation.json": PrefixFixtures;
  "http-outcomes.json": HttpFixtures;
}

// These types describe repository-owned metadata, including an unpinned draft URI fixture,
// not validated wire input.
// The implementation under test must still validate every evidence byte.
export function fixture<Name extends keyof FixtureFiles>(name: Name): FixtureFiles[Name] {
  return JSON.parse(readFileSync(`test/vectors/${name}`, "utf8")) as FixtureFiles[Name];
}
