# Security policy

This implementation is experimental and has not received an independent security audit. [Report exploitable vulnerabilities privately](https://github.com/causalweb/typescript/security/advisories/new), not in public issues or Discussions. Never include real tenant evidence, credentials, or private deployment topology in a public report. Maintainers coordinate remediation and disclosure; no response SLA is promised.

## Required integration controls

- Commit the source operation and propagation recovery information durably before issuing evidence. Signing is not a database commit.
- Keep representation and lineage in the same immutable cut or transaction. A newer global frontier cannot approve an older cache entry.
- Configure exact issuer/key/domain authority, audience, subject, maximum lifetime, clock skew, and finite limits. Refresh policy after revocation; never reuse verified evidence across policy changes.
- Perform current application authentication and target authorization. `authorize` and `authenticated` callbacks must reflect that policy; returning `true` unconditionally is for synthetic tests or a separately enforced boundary only.
- Use authenticated TLS outside a protected channel, redact causal fields from logs and traces, and apply ordinary CSRF, CORS, routing, header/trailer, response-size, and concurrency controls.
- Treat exclusions as privileged, versioned projection decisions. Never trust a client declaration of irrelevance or progress.

The library uses Node.js ES256 with P-256 keys and a fixed algorithm policy. It rejects noncanonical encodings, duplicate names at every JSON depth, unsupported header extensions, invalid lifetime/subject/audience/domain claims, and excessive input before the observer selects state. It performs no key fetching, automatic redirects, unbounded progress waits, or silent unconstrained fallback.

Handle `ObservationError` before committing HTTP. Its original `cause` is local and can contain secrets; non-enumerability is not protection from a logger that follows cause chains. Log only approved/redacted metadata and use `toResponse()` for an empty ordinary error without causal markers or application data. Never serialize the cause or use a framework's debug renderer for remote callers. A local adapter outage is not an indexed causal `failed` outcome. See [MIGRATION.md](MIGRATION.md).

`fetchObservation` requires an explicit response-authentication check, rejects non-TLS non-loopback destinations, applies a ten-second exchange deadline, and bounds parsed problem bodies. Hosts still own the underlying TLS/client configuration and must not disable certificate validation. The scalar/URI parser is security-sensitive code and needs independent review and broader fuzzing before stability.

The [persistent local-service experiment](PERSISTENT_DEMO.md) replaces one JSON file atomically within a local filesystem so its test can bind representation bytes and frontier. It does not flush file or directory metadata, persist signing keys, or establish crash safety across operating-system processes or filesystems. Treat it as an executable design constraint, not a deployment recommendation.

The `npm audit --audit-level=high --json` run on 2026-10-18 reports zero known registry vulnerabilities at every severity. Its [machine-readable result](security/npm-audit-2026-10-18.json) records 227 resolved dependency entries (two production, 226 development, and 28 optional; categories overlap). The reviewed `package-lock.json` SHA-256 is `e7505f427e1dc788fb041c468c4310670f49469635513b94989f334ad24fd3aa`.

This is a time-limited automated advisory check, not a source-code audit or assurance against malicious packages. CI repeats the advisory check; unavailable advisory data is not a clean result. A raw installed-manifest scan found package manifests without a `license` field, including runtime dependencies `busboy` and `streamsearch` as well as nested test/browser fixture manifests. It must not be presented as a clean license review. Before any package publication, maintainers must complete a license/provenance review against the exact release lockfile and retain applicable notices. Runtime parsing reuses `structured-headers`; compile-time tooling, Changesets, and Biome are separate from the protocol engine. New dependency resolution requires a fresh review.
