# SQLite transactional experiment

`test/sqlite-projection.test.ts` is a reproducible Node.js experiment using the built-in `node:sqlite` API. It is not a general-purpose database adapter or a production deployment profile.

Run it through the repository suite:

```sh
npm ci --ignore-scripts
npm test
```

The experiment opens two independent SQLite databases: a source database and a projection database. The source inserts its source fact and signed outbox record, advances its position, and commits them in one `BEGIN IMMEDIATE` transaction. It returns the evidence only after `COMMIT`. The projection verifies evidence before it mutates its database, keeps gaps pending, and applies contiguous events in a write transaction. Its response bytes and lineage frontier are selected inside one read transaction.

The test demonstrates a stale constrained read before delivery, confirmation after delivery, out-of-order delivery, duplicate delivery, forged-evidence rejection, rollback before a source commit, and reconstruction of both databases after close/reopen. WAL mode and `synchronous = FULL` are requested as test controls.

## Limits

This is evidence about the transaction shape required by Causal Web, not a claim of a production adapter. It has one process, a fixed test clock, a test-only in-memory signing key, one local filesystem, no TLS, no application authentication or authorization integration, no key management, no multi-writer/load/failover campaign, no forced operating-system or power-loss crash, and no cross-language database deployment. Operators remain responsible for database durability settings, schema migration, authorization, recovery, backup, monitoring, and capacity controls.
