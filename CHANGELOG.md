# Changelog

## Unreleased

- Fail closed with ordinary 503 responses for synchronous/asynchronous authorization outages at both authorization checks; false still means 403. Do not expose exception text or application data.
- Keep issuer configuration/key references in runtime-private fields and freeze issuer instances.
- Clean generated output before builds; install the real `.tgz` into an isolated consumer and check strict Node-only types, negative type cases, and runtime behavior in Linux/Windows CI. No public TypeScript API or wire revision changes.
- Implement an independent Node.js ES256 producer/consumer and prefix evaluator without a Rust runtime dependency.
- Add strict duplicate-aware JSON with exact integral NumericDates and non-normalizing URI validation.
- Add Structured Fields, all-dependency observation evaluation, indexed failures, bounded fail-closed fetch, and capability metadata.
- Exercise shared fixtures, real loopback HTTP, negative parsing/trust cases, and bidirectional Rust wire-message checks.
- Preserve experimental status and document missing durable adapters, crash recovery, browser support, external review, and registry releases.
