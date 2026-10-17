# TypeScript-source / Rust-observer experiment

`scripts/interop.mjs` runs this POSIX-only experiment after it verifies the ordinary wire exchange. It starts two independent loopback processes with separate state documents:

- `scripts/persistent-source-service.mjs` is a TypeScript source. It replaces a source/outbox document before it issues or returns ES256 evidence.
- The TypeScript source attaches a test-only ES256 JWS delivery proof over each event. Rust's `persistent_observer` receives an event only when its proof and the test's independently generated bearer credential are valid, verifies TypeScript causal evidence, and replaces one projection document containing both the response data and its prefix frontier.

The pinned Rust checkout is required because the test executes its public examples:

```sh
npm ci --ignore-scripts
npm run build
node scripts/interop.mjs /path/to/causalweb-rust
```

The Linux peer job is the reproducible CI execution. Windows intentionally skips it because both Rust persistence fixtures require POSIX atomic rename semantics.

## Observed exchange

The test performs these actual HTTP exchanges:

1. The TypeScript source commits an order and returns `Causal-Context` evidence. A Rust constrained `GET /orders` is `unsatisfied` before `POST /deliver` advances its persisted frontier, then is confirmed.
2. The TypeScript source process restarts from its document. Positions three then two are delivered to Rust; position three remains pending until position two arrives, then both apply in source order. A duplicate delivery is harmless.
3. The Rust observer rejects a delivery without its independently generated bearer credential before it reads or mutates projection state. It also rejects a changed event payload when presented with the original source-generated ES256 proof. It is then forcibly terminated immediately after it replaces its projection document, and a new process confirms the prior evidence from that document. A modified evidence string is rejected at its delivery boundary.
4. The TypeScript source is forcibly terminated immediately after its source/outbox record is stored but before evidence is returned. A new process runs `POST /recover` to issue the missing evidence; Rust first reports a stale constrained observation, then confirms after delivery.
5. A later source event is delivered to Rust's test-only `POST /terminal` route through the same authenticated, source-signed envelope. Rust records that position as terminal, reports `failed` for its evidence across restart, and continues to confirm the preceding applied event.

This demonstrates that the evidence, storage cut, HTTP binding, the `failed` outcome, and a narrowly authenticated and integrity-protected test delivery boundary are exercised across independently coded runtimes, including termination after defined file-replacement boundaries. The source-generated JWS is an application-test envelope, not a Causal Web protocol field or an endorsed production event format; it binds the delivered event fields, including the causal evidence string, to the source key. The generated bearer credential is process-local test configuration and is not persisted. Neither mechanism provides TLS, authorization, key lifecycle, delivery confidentiality, a general replay-defense policy, or a generic terminal-failure detector. It does not establish database crash consistency or power-loss durability: neither fixture calls `fsync`, and a clean rename result is not evidence that storage survives a machine or filesystem failure. It also does not establish concurrent writers, a general HTTP server, or a reusable storage adapter. The fixed clock, generated test key, bounded parser, loopback network, and atomic file replacement are test controls. Deployments must independently authenticate and integrity-protect their event channels.
