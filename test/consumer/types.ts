import { Issuer, Snapshot, type VerifiedEvidence } from "@causalweb/protocol";

function invalidUses(issuer: Issuer, snapshot: Snapshot<null>): void {
  // @ts-expect-error A plain object must not impersonate authenticated evidence.
  const forged: VerifiedEvidence = { issuer: "https://source.example" };
  void forged;
  // @ts-expect-error Prefix positions must not use rounding-prone number values.
  issuer.issueCommitted({ subject: "tenant", audiences: ["view"], domain: "urn:test:domain", position: 5, issuedAt: 1n, expiresAt: 2n }, 1n);
  // @ts-expect-error Evaluation requires authenticated evidence, not a compact string.
  snapshot.evaluate("unverified-token", 1n);
}
void invalidUses;
