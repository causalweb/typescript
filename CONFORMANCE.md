# Implementation and conformance report

Status: Experimental source preview; no full deployment conformance claim

The normative input is draft `0.1.1-experimental`, with exact source, peer, and runner pins in [SPEC_REVISION](SPEC_REVISION), [RUST_REVISION](RUST_REVISION), and [CONFORMANCE_REVISION](CONFORMANCE_REVISION). Shared vector revision: `0.1.2`.

The repository also provides a development-only JSON Lines adapter for the separate [`causalweb/conformance`](https://github.com/causalweb/conformance) runner. Build first, then invoke its pinned runner with `node scripts/conformance-adapter.mjs` as the adapter command. It supports the 32-case `evidence-verification-v1` profile and the 17-case `prefix-evaluation-v1` profile. The latter invokes this implementation's JWS verifier, exact position parser, and `Snapshot` lineage evaluator; its manifest explicitly excludes the three context-reduction cases because this implementation does not expose a Core Carrier reducer. The adapter exposes only the public profile outcomes, does not expose local diagnostics or implement a server, and is not full protocol conformance.

## Evidence obtained

- All six baseline JWS, 26 security, twenty prefix/composition, and twelve HTTP outcome fixtures pass through this implementation's own code. The shared runner independently invokes this engine for 32 evidence-verification cases and 17 selected prefix-evaluation cases.
- Native Node.js cryptography supplies ES256; no Rust engine, FFI, subprocess, or shared protocol implementation is used by the library.
- The development peer check parses each implementation's actual field strings and signed evidence in both directions. It checks stale/covered state, expiration, forgery, and subject mismatch with synthetic snapshots. On Linux, it also invokes Rust's POSIX-only local source fixture: a source fact is persisted before issuance, an injected interruption leaves a recoverable blank outbox entry, and TypeScript independently validates both issued and recovered evidence. The same peer starts its constrained-observation endpoint and a deliberately limited Rust loopback HTTP source, observes a genuine stale response, verifies the delivered token before advancing its persistent projection document, then confirms the observation.
- Real loopback HTTP tests exercise the public client/observer interfaces, reject an unaware 200, avoid cross-origin redirect forwarding, validate failure order, enforce a problem-body limit, and cancel an interrupted exchange.
- A persistent local-service experiment uses separate source/projection directories and HTTP services. It keeps response bytes and a prefix frontier in one atomically replaced document, reports an actual stale causal failure before delivery, and confirms after delivery. It covers out-of-order and duplicate delivery, a modified token, logical service reconstruction, and an injected interruption after durable source commit followed by outbox recovery.
- Additional tests cover nested/escaped duplicate names, invalid UTF-8, exact integral NumericDates, Unicode scalar handling, URI syntax without normalization, empty/missing limits, control characters, expiry after reading, and access changes.

Twenty-two local test functions pass on Windows, including retained local adapter causes, both authorization checkpoints, clock errors, snapshot-contract errors, rejection of non-byte JavaScript bodies, safe HTTP conversion, runtime-private issuer configuration, and the persistent local-service experiment. Real HTTP tests retain the local cause while returning empty ordinary 503 responses. A separate package check installs the actual `.tgz` into a temporary application, compiles with strict Node-only types, checks invalid API uses at compile time, and exercises stale/covered/denied observations and the public error API. The committed CI workflow tests Node.js on Linux and Windows and runs a separate pinned-Rust peer job. A workflow is not evidence that CI passed; refer to the run on the reviewed commit.

## Policies and assumptions

The only configured algorithm is ES256. Unknown protected-header parameters are rejected by local policy. Trust contains exact issuer strings, per-issuer key IDs and domain authority, audience, positive maximum lifetime, and non-negative skew. The subject is exact-matched to the already authenticated application partition. Keys and domain sets are copied on construction; no key URL in evidence is followed.

Positions and dates use exact arithmetic. Unknown authenticated profiles keep their position opaque and yield `unsupported` after expiry precedence. Numeric frontiers cover every relevant component; unknown lineage blocks a positive claim. Exclusions are trusted adapter statements bound to the snapshot's versioned contract/schema and a position interval.

No deliberate progress waiting, context reduction, online revocation lookup, or background key discovery is implemented. Policy must be current at request time and remain authorized through response commitment. Do not cache verified evidence across revocation or authorization changes.

## Not yet claimed

A test-only local-file experiment exercises an outbox-shaped source record, source-order recovery, and an atomically replaced representation/lineage document. It does not provide a reusable database/outbox adapter, a durable signing-key store, an fsync protocol, a projection transaction, separate-process crash injection, or the required database and load tests. `Snapshot` cannot prove that a caller used a real transaction. HTTP helpers do not by themselves establish a complete deployment's TLS, browser, proxy, cancellation, authorization, or conditional-request behavior.

Generic identifier grammar and JSON edge cases remain candidates for explicit cross-runtime specification clarification, especially URI scheme syntax versus exact identity comparison, fragments in the phrase "absolute URI", and lone Unicode escapes. Both implementations preserve exact identity strings; neither may treat normalization as new issuer/domain authority. These questions block stability, not further experimentation.

No browser support, external pilot, independent security audit, exhaustive conformance coverage, comprehensive fuzzing, or production-readiness certification is claimed. Independent protocol engines written by the founding author are not independent external review. The Rust fixture has only a bounded loopback-test HTTP parser; it has no transactional store, `fsync`, durable key store, TLS, authentication, concurrency control, or Windows persistence path. The TypeScript projection is a test harness, not a reusable adapter. Real persistent service interoperability remains a separate release gate.
