# Changelog

## 0.1.0-experimental.0

### Minor Changes

- bf2229a: Add experimental Node HTTP and Fastify 5 observer adapters. The Node bridge
  preserves repeated received `Causal-Require` field lines, routes ordinary
  requests back to the host, and converts local observer failures into
  marker-free ordinary errors. The Fastify adapter is an optional peer entry
  point. Neither adapter is a new protocol profile or a durable projection
  integration. Add loopback compatibility coverage for NestJS 12 on Express;
  it uses the Node bridge rather than a Nest-specific package.
- aea1dd9: Preserve local observer failures as `ObservationError` with the original cause and safe code/phase metadata. Hosts must handle rejection and call `toResponse()` instead of relying on the earlier silently constructed 500/503 response. See `MIGRATION.md` before updating a Git-based integration.

  Reject malformed JavaScript representation bodies rather than coercing strings or arrays into confirmed bytes. Keep indexed causal outcomes distinct from adapter failures. Verify the public error contract using real HTTP and an installed-package consumer. No protocol wire revision or production-readiness claim changes.
- 507e539: Add the `@causalweb/sdk/client` entry for portable Fetch request construction and constrained-observation response confirmation. It transports opaque evidence without importing Node cryptography or server adapters; it does not add browser evidence issuance, JWS verification, key discovery, CORS bypass, or a production browser conformance claim.
- Rename the unreleased package to `@causalweb/sdk` and organize its implementation into protocol, server, and portable client modules. Public operations and wire behavior remain unchanged; existing source-checkout consumers must update direct internal file imports to the new folders. Storage durability, recovery, delivery, and authorization remain application responsibilities.

### Patch Changes

- 507e539: Add a portable `waitForObservation` helper for a lagging view. It requires a caller deadline, retries only validated retryable `unsatisfied` outcomes, and returns terminal failures and ordinary errors without retrying them.
- 507e539: Include a walkthrough and pilot evidence guide in the package archive so external evaluators can report integration results without treating project-authored demos as independent adoption.
- 507e539: Reject fragment-bearing issuer, profile, and domain URI identities in the experimental TypeScript implementation, and exercise the specification draft's three complete signed URI cases in the consumer. This is a breaking validation change for applications using literal `#` identifiers; `%23` remains valid and exact. Published specification and conformance pins remain unchanged pending compatibility review.
- b0c6a1e: Extend the development-only conformance adapter with selected HTTP client confirmation cases. It covers 11 response/parser cases and explicitly excludes redirect forwarding; no production HTTP-agent or full conformance claim is added.
- aea1dd9: Release the client problem-body reader on success, malformed input, size rejection, and cancellation. Fail closed during authorization outages and keep issuer policy/key references private at runtime. Add strict Node-only type and runtime tests against the actual package archive.
- 2678b6d: Add the experimental fixed-cut HTTP observer conformance adapter profile. It exercises public observer behavior with ephemeral evidence and synthetic snapshots; it does not add a network-server or storage-adapter claim.
- 507e539: Include release and peer revision records in the SDK archive, distinguish source-only reference and test files from packaged files, and check that relative links in packaged Markdown resolve within the archive.
- 5743541: Put the runnable local demo first in the package README and use the documented client package import in the observation example. No SDK behavior changes.
- f3c2bd6: Add a reproducible persistent local-service experiment using the public Node.js API. It verifies stale rejection, delayed and out-of-order propagation, idempotent duplicate delivery, forged-evidence rejection, logical service reconstruction, and a narrow source-outbox recovery path. The experiment is test-only and documents its filesystem, process, concurrency, and key-management limits. It does not add a storage adapter or a production conformance claim.
- 617f1f0: Pin the development conformance checks to a runner revision that rejects prefix-profile exclusions referring to absent vector case IDs.
- 6577ae9: Extend the development-only conformance adapter to run the shared prefix-evaluation profile through the Node.js verifier and snapshot evaluator. The profile covers 17 selected vector cases and explicitly excludes context reduction; it does not add a production API or full conformance claim.
- 507e539: Reject constrained `HEAD` requests and `Connection` headers that nominate a causal field before sending them. Protocol version 0.1 cannot carry the required per-item failure body on `HEAD`, and causal fields must remain end-to-end.
- b24173f: Reject IPv6 zone identifiers in URI IP-literals. RFC 9844 obsoletes RFC 6874 and restores RFC 3986's IP-literal grammar; Node's `isIP` alone accepts scoped addresses. This is a breaking validation change for applications using zone-qualified URI identities. Published specification and conformance pins remain unchanged pending compatibility review.
- 52ea5db: Extend the Linux peer check to independently verify evidence issued and recovered by Rust's POSIX-only local source fixture. This is test evidence, not a production source or projection adapter.
- 10496c6: Add an experimental safe Prefix Profile carrier-reduction helper. It retains original verified evidence by index only when a dominant item has the same issuer, subject, audience set, profile version, domain, and commitment semantics, is at least as far in source order, and remains usable through the caller's explicit horizon.
- aaf5d01: Add a reproducible SQLite transaction experiment using the public Node.js protocol API. It verifies atomic source fact/outbox commitment, a projection response and frontier selected from one transactional cut, stale rejection before delivery, ordered propagation, rollback, forged-evidence rejection, and close/reopen recovery. It is test-only and does not add a production database adapter or deployment claim.
- 507e539: Expose the verified evidence issuance time as an exact bigint so application delivery envelopes can bind it to signed evidence. The order reference now rejects a correctly signed delivery envelope whose `issuedAt` disagrees with the enclosed evidence.

Pending release notes live in the source repository's `.changeset/` directory and are generated into version entries by Changesets. A changelog version does not imply npm publication.

## Pre-Changesets engineering history

- Preserve local observer failures as `ObservationError` with original cause, safe code/phase metadata, and explicit `toResponse()` conversion. This breaks the unreleased rejection contract; hosts must install the documented error boundary. Protocol HTTP outcomes and wire revision are unchanged. Invalid JavaScript representation bodies are rejected rather than coerced into confirmed bytes.
- Release the client problem-body reader on completion, rejection, size limits, and abort; regression assertions use real HTTP responses.
- Detect synchronous/asynchronous authorization outages at both checks; safe conversion returns ordinary 503, while false still means 403. Do not expose exception text or application data.
- Keep issuer configuration/key references in runtime-private fields and freeze issuer instances.
- Clean generated output before builds; install the real `.tgz` into an isolated consumer and check strict Node-only types, negative type cases, and runtime behavior in Linux/Windows CI. No public TypeScript API or wire revision changes.
- Implement an independent Node.js ES256 producer/consumer and prefix evaluator without a Rust runtime dependency.
- Add strict duplicate-aware JSON with exact integral NumericDates and non-normalizing URI validation.
- Add Structured Fields, all-dependency observation evaluation, indexed failures, bounded fail-closed fetch, and capability metadata.
- Exercise shared fixtures, real loopback HTTP, negative parsing/trust cases, and bidirectional Rust wire-message checks.
- Preserve experimental status and document missing durable adapters, crash recovery, browser support, external review, and registry releases.
