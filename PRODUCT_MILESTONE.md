# First deployable TypeScript milestone

Status: implementation target, not a conformance or production claim.

The first product is a small order-source service and an independently stored order-view service. A committed order produces Causal Web evidence. The view can lag, then account for that order and confirm a constrained read. The two services use the public TypeScript protocol package and separate transactional databases. The source-to-view delivery envelope is an application mechanism, not a new Causal Web wire field.

The developer-facing target is a small integration surface: an application supplies its committed source fact, authenticated principal, and state-bound snapshot through documented SDK calls. The SDK owns evidence syntax, HTTP fields, verification, and fail-closed confirmation. The reference service may contain operator and storage code, but its protocol integration must not require application authors to copy that code.

## Required behavior

1. A source transaction assigns a unique ordered position, commits the order fact and recoverable outbox entry together, and returns evidence only after that transaction commits. Interrupted evidence issuance remains recoverable without inventing or changing the source fact.
   An undelivered fact must also recover after its previously issued evidence expires: reissue fresh evidence for that same stable fact without reusing the position for a different fact, and make the view's duplicate handling safe when an earlier delivery may have committed but its acknowledgement was lost.
   A client write uses a reusable application request key committed with its fact, so a retry after an uncertain response cannot assign another position for that same intent. A conflicting use of the key fails without a causal success marker.
2. Delivery is authenticated and integrity-protected independently of causal evidence. The view checks its authorization policy and verifies evidence before it changes projection state. A duplicate with identical content is a no-op; a conflicting duplicate is rejected. A later position stays pending until every earlier position is accounted for.
3. Projection data and its accounted frontier commit in one transaction. A read selects both from one database snapshot. A crash can leave the frontier behind applied state but cannot leave it ahead. A missing or damaged lineage record produces `unknown`, never `satisfied`.
4. The view authenticates the ordinary application request, binds evidence to the authenticated subject, authorizes the target and issuer/domain mapping, and repeats target authorization before response commitment. Evidence possession grants no access.
5. External HTTP uses authenticated TLS with operator-managed credentials. The application configures trusted issuer keys, audience, subject mapping, key rotation, and delivery credentials. No test certificate, fixed clock, generated ephemeral key, or permissive authorization belongs in the deployable path.
6. Bounded request and delivery bytes, finite processing time, cancellation, shutdown, and redacted diagnostics apply at the service boundary. A failed local read or verifier returns an ordinary marker-free error; it never becomes a causal outcome by guesswork.

## Scope and limits

The initial deployment target is one host with two independently running Node.js processes and two SQLite databases. Operators must supply persistent storage, a TLS terminator or service certificates, credentials, backup, and a recovery procedure. This target does not claim multi-host failover or survival of a filesystem or power-loss failure that the configured SQLite durability mode cannot withstand.

The application may use a consecutive SQLite integer sequence internally, but public Prefix Profile positions are unsigned 64-bit decimal strings. Before a reusable adapter or full Prefix Issuer claim, storage must represent the complete profile range exactly or publish and enforce a narrower issuance limit without accepting out-of-range values. A JavaScript `number` must never silently round a position.

Rust feature development is deferred. Existing Rust results remain historical evidence for the pinned experimental wire revision; they do not establish interoperability for any future breaking wire revision.

## Exit evidence

- A clean-checkout quickstart launches both services with operator-provided configuration and a real application principal. It shows stale rejection, authenticated delivery, and confirmed read through the installed package.
- A separate consumer application integrates through public package exports without copying the reference service's evidence, delivery-proof, or HTTP parsing code. An external developer completes that integration and records the application code required and the points of confusion.
- Process-termination tests cover both sides of source and projection commits, evidence recovery (including an outage longer than evidence lifetime and an ambiguous delivery acknowledgement), restart, duplicate and out-of-order delivery, conflicting input, expired and forged evidence, authorization changes, lost lineage, and a recorded terminal failure.
- A documented fault model, schema migration and backup/restore exercise, key-rotation exercise, resource measurements, and a class-specific conformance report accompany the runnable services.
- An external developer follows the [walkthrough and pilot protocol](PILOT.md) without author assistance and records difficulties. A separate external review and pilot are still required before protocol maturity changes.

The existing test-only SQLite scripts remain experiments until the above evidence exists. Do not relabel them as deployable services merely by moving files or changing package metadata.
