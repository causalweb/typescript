# TypeScript-source / Rust-observer experiment

`scripts/interop.mjs` runs this POSIX-only experiment after it verifies the ordinary wire exchange. It starts two independent loopback processes with separate state documents:

- `scripts/persistent-source-service.mjs` is a TypeScript source. It replaces a source/outbox document before it issues or returns ES256 evidence.
- Rust's `persistent_observer` example receives source events, verifies TypeScript evidence, and replaces one projection document containing both the response data and its prefix frontier.

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
3. The Rust observer process restarts from its document and still confirms the prior evidence. A modified evidence string is rejected at its delivery boundary.
4. A source operation stops after its source/outbox record is stored but before evidence is returned. `POST /recover` issues the missing evidence; Rust first reports a stale constrained observation, then confirms after delivery.

This demonstrates that the evidence, storage cut, and HTTP binding are exercised across independently coded runtimes. It does not establish database crash consistency, power-loss durability, authenticated application-event delivery, TLS, authorization, concurrent writers, a general HTTP server, or a reusable storage adapter. The fixed clock, generated test key, bounded parser, loopback network, and atomic file replacement are test controls. Causal evidence authenticates its own claim set; it does not authenticate or bind the order payload sent through the test delivery endpoint.
