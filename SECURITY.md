# Security policy

This implementation is experimental and has not received an independent security audit. [Report exploitable vulnerabilities privately](https://github.com/causalweb/typescript/security/advisories/new), not in public issues or Discussions. Never include real tenant evidence, credentials, or private deployment topology in a public report. Maintainers coordinate remediation and disclosure; no response SLA is promised.

## Required integration controls

- Commit the source operation and propagation recovery information durably before issuing evidence. Signing is not a database commit.
- Keep representation and lineage in the same immutable cut or transaction. A newer global frontier cannot approve an older cache entry.
- Configure exact issuer/key/domain authority, audience, subject, maximum lifetime, clock skew, and finite limits. Refresh policy after revocation; never reuse verified evidence across policy changes.
- Perform current application authentication and target authorization. `authorize` and `authenticated` callbacks must reflect that policy; returning `true` unconditionally is for synthetic tests or a separately enforced boundary only.
- Use authenticated TLS outside a protected channel, redact causal fields from logs and traces, and apply ordinary CSRF, CORS, routing, header/trailer, response-size, and concurrency controls.
- Treat exclusions as privileged, versioned projection decisions. Never trust a client declaration of irrelevance or progress.

For the order-reference SQLite services, back up source and view only as a quiescent pair. A source restore behind any externally issued evidence can erase a published stable fact and must not resume under the same source-domain identifier. The paired backup exercise checks local database consistency and accidental corruption but cannot prove that no later evidence escaped or protect a backup from an attacker who can rewrite both files and its manifest.

The reference databases bind their deployment identity to stored state. Do not transplant a source or view database to a different issuer, domain, audience, or application principal merely by changing environment variables. Populated prebinding databases need explicit reviewed migration evidence; the reference startup intentionally refuses to infer their identity.

The library uses Node.js ES256 with P-256 keys and a fixed algorithm policy. It rejects noncanonical encodings, duplicate names at every JSON depth, unsupported header extensions, invalid lifetime/subject/audience/domain claims, and excessive input before the observer selects state. It performs no key fetching, automatic redirects, unbounded progress waits, or silent unconstrained fallback.

Handle `ObservationError` before committing HTTP. Its original `cause` is local and can contain secrets; non-enumerability is not protection from a logger that follows cause chains. Log only approved/redacted metadata and use `toResponse()` for an empty ordinary error without causal markers or application data. Never serialize the cause or use a framework's debug renderer for remote callers. A local adapter outage is not an indexed causal `failed` outcome. See [MIGRATION.md](MIGRATION.md).

`fetchObservation` requires an explicit response-authentication check, rejects non-TLS non-loopback destinations, applies a ten-second exchange deadline, and bounds parsed problem bodies. Hosts still own the underlying TLS/client configuration and must not disable certificate validation. The scalar/URI parser is security-sensitive code and needs independent review and broader fuzzing before stability.

The local JSON-file test in `test/persistent-projection.test.ts` replaces one document atomically so representation bytes and frontier share a cut. It does not flush file or directory metadata, persist signing keys, or establish crash safety across operating-system processes or filesystems. Treat it as an executable design constraint, not a deployment recommendation.

CI runs `npm audit --audit-level=high` against the current lockfile. This is an automated, time-limited advisory check, not a source-code audit or assurance against malicious packages; unavailable advisory data is not a clean result. A raw installed-manifest scan found package manifests without a `license` field, including runtime dependencies `busboy` and `streamsearch` as well as nested test/browser fixture manifests. It must not be presented as a clean license review. Before any package publication, maintainers must complete a license/provenance review against the exact release lockfile and retain applicable notices. Runtime parsing reuses `structured-headers`; compile-time tooling, Changesets, and Biome are separate from the protocol engine. New dependency resolution requires a fresh review.
