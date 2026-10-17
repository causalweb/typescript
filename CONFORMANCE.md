# Implementation and conformance report

Status: Experimental source preview; no full deployment conformance claim

The normative input is draft `0.1.1-experimental`, with exact source and peer pins in [SPEC_REVISION](SPEC_REVISION) and [RUST_REVISION](RUST_REVISION). Shared vector revision: `0.1.2`.

## Evidence obtained

- All six baseline JWS, 26 security, twenty prefix/composition, and twelve HTTP outcome fixtures pass through this implementation's own code.
- Native Node.js cryptography supplies ES256; no Rust engine, FFI, subprocess, or shared protocol implementation is used by the library.
- The development peer check parses each implementation's actual field strings and signed evidence in both directions. It checks stale/covered state, expiration, forgery, and subject mismatch with synthetic snapshots.
- Real loopback HTTP tests exercise the public client/observer interfaces, reject an unaware 200, avoid cross-origin redirect forwarding, validate failure order, enforce a problem-body limit, and cancel an interrupted exchange.
- Additional tests cover nested/escaped duplicate names, invalid UTF-8, exact integral NumericDates, Unicode scalar handling, URI syntax without normalization, empty/missing limits, control characters, expiry after reading, and access changes.

Nineteen local test functions pass on Windows, including authorization outages at both checks and runtime-private issuer configuration. A separate package check installs the actual `.tgz` into a temporary application, compiles with strict Node-only types, checks invalid API uses at compile time, and runs stale/covered/denied observations. The committed CI workflow tests Node.js on Linux and Windows and runs a separate pinned-Rust peer job. A workflow is not evidence that CI passed; refer to the actual run on the reviewed commit.

## Policies and assumptions

The only configured algorithm is ES256. Unknown protected-header parameters are rejected by local policy. Trust contains exact issuer strings, per-issuer key IDs and domain authority, audience, positive maximum lifetime, and non-negative skew. The subject is exact-matched to the already authenticated application partition. Keys and domain sets are copied on construction; no key URL in evidence is followed.

Positions and dates use exact arithmetic. Unknown authenticated profiles keep their position opaque and yield `unsupported` after expiry precedence. Numeric frontiers cover every relevant component; unknown lineage blocks a positive claim. Exclusions are trusted adapter statements bound to the snapshot's versioned contract/schema and a position interval.

No deliberate progress waiting, context reduction, online revocation lookup, or background key discovery is implemented. Policy must be current at request time and remain authorized through response commitment. Do not cache verified evidence across revocation or authorization changes.

## Not yet claimed

No complete Prefix Issuer or Prefix Verifier class is claimed: a database/outbox adapter, projection transaction, source-order recovery, and the required crash tests are not yet included. `Snapshot` cannot prove that the caller used a real transaction. HTTP helpers do not by themselves establish a complete deployment's TLS, browser, proxy, cancellation, authorization, or conditional-request behavior.

Generic identifier grammar and JSON edge cases remain candidates for explicit cross-runtime specification clarification, especially URI scheme syntax versus exact identity comparison, fragments in the phrase "absolute URI", and lone Unicode escapes. Both implementations preserve exact identity strings; neither may treat normalization as new issuer/domain authority. These questions block stability, not further experimentation.

No browser support, external pilot, independent security audit, exhaustive conformance coverage, comprehensive fuzzing, or production-readiness certification is claimed. Independent protocol engines written by the founding author are not independent external review. Real persistent service interoperability remains a separate release gate.
