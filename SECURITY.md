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

`fetchObservation` requires an explicit response-authentication check, rejects non-TLS non-loopback destinations, applies a ten-second exchange deadline, and bounds parsed problem bodies. Hosts still own the underlying TLS/client configuration and must not disable certificate validation. The scalar/URI parser is security-sensitive code and needs independent review and broader fuzzing before stability.

The initial `npm audit` run on 2026-10-17 reported zero known registry advisories. It is a time-limited automated check, not a source-code audit or assurance against malicious packages. CI repeats the advisory check; unavailable advisory data is not a clean result. Runtime parsing reuses `structured-headers`; compile-time tooling is separate from the protocol engine.
