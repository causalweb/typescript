# SQLite transactional experiment

`test/sqlite-projection.test.ts` is a reproducible Node.js experiment using the built-in `node:sqlite` API. It is not a general-purpose database adapter or a production deployment profile.

Run it through the repository suite:

```sh
npm ci --ignore-scripts
npm test
```

The experiment opens two independent SQLite databases: a source database and a projection database. The source inserts its source fact and signed outbox record, advances its position, and commits them in one `BEGIN IMMEDIATE` transaction. It returns the evidence only after `COMMIT`. The projection verifies evidence before it mutates its database, keeps gaps pending, and applies contiguous events in a write transaction. Its response bytes and lineage frontier are selected inside one read transaction.

`scripts/sqlite-source-service.mjs` and `test/sqlite-source-service.test.ts` additionally isolate the source side in a local test process. That process first commits the source fact and an outbox row with no evidence; it materializes the signed evidence in a subsequent transaction. An injected response interruption returns `500` without `Causal-Context` after the first commit; an injected process exit leaves the same blank row durable. In either case, recovery materializes the evidence. This demonstrates that the source service does not return or deliver evidence before its source fact is durable. It is preparation for a future cross-runtime experiment, not cross-language interoperability evidence.

`scripts/sqlite-observer-service.mjs` and `test/sqlite-cross-process.test.ts` run that source with a separate local observer process and a separate SQLite database. Before delivery, a constrained observation is `unsatisfied`; after a verified delivery it is confirmed. The observer writes its response inputs and source frontier in one transaction, survives an injected process exit after that commit, keeps an out-of-order event pending, and drains it when its predecessor arrives. The same test recovers a source process that exits after committing a blank outbox row, then delivers the recovered evidence to the already-running observer. Its test-only delivery parser caps bodies at 16,384 bytes and rejects an oversized delivery before projection mutation. The test uses a per-run bearer credential and source-signed delivery envelope solely to prove that a rejected delivery does not advance the projection. The bearer and envelope are not Causal Web protocol fields, a general replay defense, TLS, or an endorsed event format.

The test demonstrates a stale constrained read before delivery, confirmation after delivery, out-of-order delivery, duplicate delivery, forged-evidence rejection, rollback before a source commit, and reconstruction of both databases after close/reopen. WAL mode and `synchronous = FULL` are requested as test controls.

## Limits

This is evidence about the transaction shape required by Causal Web, not a claim of a production adapter. It has test-only local processes, a fixed test clock, a test-only per-run signing key, one local filesystem, no TLS, no application authentication or authorization integration, no key management, no multi-writer/load/failover campaign, no forced operating-system or power-loss crash, and no cross-language database deployment. Operators remain responsible for database durability settings, schema migration, authorization, recovery, backup, monitoring, and capacity controls.
