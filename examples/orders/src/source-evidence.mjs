import { randomUUID } from "node:crypto";

export function materializeEvent(store, event, issuer, subject, audience, domain, now) {
  const expired = BigInt(event.expiresAt) <= now;
  if (event.evidence !== null && !expired) throw new Error("evidence is not expired");
  const issuedAt = expired ? now : BigInt(event.issuedAt);
  const expiresAt = expired ? now + 3600n : BigInt(event.expiresAt);
  const evidence = issuer.issueCommitted(
    {
      subject,
      audiences: [audience],
      domain,
      position: BigInt(event.position),
      issuedAt,
      expiresAt,
      evidenceId: event.evidence === null ? event.id : `urn:uuid:${randomUUID()}`,
    },
    now,
  );
  if (event.evidence === null) store.materialize(event.id, evidence, issuedAt, expiresAt);
  else store.refresh(event.id, event.evidence, evidence, issuedAt, expiresAt, now);
  return { ...event, issuedAt: issuedAt.toString(), expiresAt: expiresAt.toString(), evidence };
}
