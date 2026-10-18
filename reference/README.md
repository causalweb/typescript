# Order source and view reference

This is an application reference built on the public `@causalweb/protocol` API. It runs two HTTPS Node.js processes with separate SQLite databases. It demonstrates a committed source fact, recoverable outbox, authenticated delivery, a state-bound projection frontier, stale rejection, and a confirmed observation. It is currently source code in this repository, not a published package or a certified deployment.

Read the [fault model and recovery rules](FAULT_MODEL.md) before using persistent data. In particular, reuse the same application request key when retrying a write after losing its response. An older source backup may be unsafe to restore under the same domain after evidence has escaped.

The [resource measurements](MEASUREMENTS.md) provide reproducible storage/SDK and two-process localhost HTTPS workloads with local samples. They are not production capacity figures.

The [class-specific conformance matrix](CLASS_REPORT.md) distinguishes passing SDK runner profiles from the reference service's still-unmet issuer, verifier, carrier, client, and server obligations.

Run its end-to-end test from the TypeScript repository:

```sh
npm ci --ignore-scripts
npm test
```

For a short local walkthrough, run `npm run demo` after `npm ci --ignore-scripts`. It starts source and view as separate HTTPS processes, demonstrates an actual stale `412`, restarts the source with delivery enabled, and runs the SDK client until it sees a confirmed `200`. The demo uses a test-only localhost certificate and disposable keys, credentials, and databases; it is not an operator deployment or persistence exercise.

The test generates an ES256 issuer key, starts both services with separate databases, uses a test-only localhost certificate, verifies that missing application credentials and invalid deliveries cannot advance the view, and kills the source inside a transaction before its first fact commits. It verifies rollback, retries the same request key, then kills and restarts the source after that commit to confirm outbox recovery. It reissues evidence for both a blank entry and an undelivered entry whose original interval expired. It then forcibly terminates the view after confirmation, checks the same state-bound result after restart, and rotates the source signing key while the view retains both public keys. Old unexpired and newly issued evidence both confirm after the rotation. Store tests cover out-of-order delivery, ambiguous acknowledgements, refreshed evidence for the same stable fact, conflicting duplicates, and lost lineage. These are local process tests; they do not establish host or power-loss durability.

## Operator configuration

Run `node reference/service.mjs` separately for `CW_ROLE=source` and `CW_ROLE=view`. Both processes require the following environment variables:

| Variable | Meaning |
| --- | --- |
| `CW_ROLE` | `source` or `view` |
| `CW_PORT` | Local HTTPS port; each role needs its own port |
| `CW_DATABASE` | Path to that role's persistent SQLite database; parent directory must exist |
| `CW_ISSUER`, `CW_DOMAIN`, `CW_AUDIENCE`, `CW_SUBJECT` | Exact issuer, source-domain, verifier-audience, and one application principal identifiers |
| `CW_KID` | Identifier of the source's active signing key; the view must have its public key in the keyring |
| `CW_APP_TOKEN` | Application bearer credential for the configured principal |
| `CW_DELIVERY_TOKEN` | Separate bearer credential for source-to-view delivery |
| `CW_TLS_KEY_FILE`, `CW_TLS_CERT_FILE` | PEM server key and certificate files supplied by the operator |

The source additionally requires `CW_SIGNING_KEY_FILE` (a persistent P-256 private PEM key) and `CW_VIEW_URL` (the view's HTTPS origin). The view requires `CW_VERIFY_KEYRING_FILE`, a JSON array of `{ "kid": "key-1", "publicKeyFile": "verification.pem" }` entries. Public-key paths are relative to the manifest, or absolute. The manifest must contain the active `CW_KID`; keep retired verification keys for at least the longest still-accepted evidence lifetime unless emergency revocation requires rejection. Rotate by installing both old and new public keys, then restarting the view and source with the new active `CW_KID` and source private key. This reference has no live reload or coordinated zero-downtime rotation. The source uses the platform's HTTPS trust store when sending deliveries; for a private CA, configure Node's trust store through the operator's normal deployment procedure. The services bind to `127.0.0.1`; external access needs an authenticated TLS terminator within the deployment trust boundary.

Each database binds its role, issuer, domain, audience, and principal on first initialization (source and view schema version 2). Changing those environment values on an existing database fails before serving traffic; signing-key rotation does not change this identity. An older populated reference database without identity metadata also fails closed. Do not attach an identity to historical data by guessing from current environment: that requires a reviewed migration with proof of the original deployment configuration and complete source history, or an explicit new-domain rollover. Empty prebinding databases can initialize under the selected identity.

On startup, a source at schema version 1 atomically adds the `source_requests` mapping table and advances its bound identity to version 2. Existing committed facts and positions remain intact, but requests made before this mapping existed cannot be retroactively deduplicated. A version-2 database missing the mapping fails closed instead of creating an empty replacement. Stop the old source before upgrading; do not run old and new binaries against the same database. Reopening after an interrupted upgrade retries the atomic migration. An old binary rejects schema version 2; **rollback after new writes is unsafe**. Keep the new binary or restore a quiescent pre-upgrade pair only if no post-backup evidence escaped. The paired-backup checker accepts older backup-format-v2 snapshots with source schema version 1 and verifies mapping foreign keys when present.

On startup, a view at schema version 1 atomically adds its empty `view_failure_events` history and advances to version 2 without changing applied rows, pending rows, or the frontier. A version-2 view missing that history fails closed. Stop the old view before upgrading; a live old process would ignore operator decisions made by the new code. Reopening after an interrupted migration retries it. The old binary rejects version 2 on restart. To roll back, use a quiescent pre-upgrade pair only after establishing that no later evidence or operator decision needs preserving. A restored version-1 view upgrades again when opened by the new code. The paired-backup checker accepts both view versions and preserves version-2 failure history.

## Operator terminal-failure decision

The view operator may record a confirmed terminally blocked position that has already arrived as an authenticated pending event. This is a manual operational assertion, not an automatic conclusion from retries, a dead-letter entry, or a source claim. Use the view's existing `CW_DATABASE`, `CW_ISSUER`, `CW_DOMAIN`, `CW_AUDIENCE`, and `CW_SUBJECT` settings, with `CW_ROLE=view`. The OS account running the command must have write access to the view database:

```sh
node reference/operator.mjs mark-failed 2
node reference/operator.mjs resolve-failed 2
```

The first command appends a failure decision for position 2 only if that position is pending and not already covered. A constrained observation for an affected uncovered position then returns `503` with `failed`; earlier uncovered positions remain `unsatisfied`. The second command appends a resolution decision after the operator has repaired the cause or established that progress is viable again. Applying the record and advancing the frontier also makes the covered position `satisfied`. Repeating either command has no extra effect. The database records the OS username as an audit label, not as proof of identity; filesystem permissions and the operator's deployment controls are the authority boundary. Restrict database write access accordingly. Do not expose this command through the application HTTP API or let a source delivery invoke it. Keep incident details in restricted operator records, not public causal responses.

The source accepts `POST /orders` with `Authorization: Bearer <CW_APP_TOKEN>`, a required application-only `CW-Request-Key` header (1–128 ASCII letters, digits, `.`, `_`, `~`, or `-`), and `{"order":"order-id"}`. Choose a new key for each intended write and persist it until its outcome is known; retry the **same** order with the **same** key after an uncertain response. The key is bound to one order under the configured principal and source database. A matching retry returns the same fact and position, with the original evidence while valid or fresh evidence for that same fact after expiry. Reusing a key for a different order returns marker-free `409`; a missing/invalid key returns marker-free `400`. This header is an application contract, not a Causal Web protocol field. The source returns `201`, a small order identifier body, and `Causal-Context` only after the source fact and outbox entry commit. A background worker signs blank outbox entries on recovery and retries delivery. The view accepts source deliveries on `POST /deliver` with `CW_DELIVERY_TOKEN` and the signed event proof. A client calls `GET /orders` with its application credential and `Causal-Require` from the source response. It receives `412` while the view lags and a confirmed `200` when that same view snapshot accounts for the order. Use the SDK's `fetchObservation` or `acceptConfirmation` to enforce the client-side success rule.

The source SQLite connection waits at most two seconds for a competing writer lock. A local two-process test covers a short collision and keyed deduplication, but this is not a throughput or multi-replica deployment guarantee; sustained lock contention can still fail a request without a causal marker.

Both POST routes reject bodies over 16 KiB and malformed UTF-8 or JSON before mutating storage. Application-credential rotation takes effect after the view restarts with the new `CW_APP_TOKEN`; old credentials then receive an ordinary, marker-free `401`, even when their causal evidence remains valid.

Send `SIGTERM` for an orderly stop. The service cancels outbound delivery, stops accepting connections, waits for active handlers, and closes SQLite after the delivery job settles. After ten seconds it closes remaining HTTP connections. A stalled-delivery process test verifies that the pending fact survives this stop and is delivered after restart; synchronous SQLite work and host power loss remain outside that timing proof.

Once both services are running, a developer can exercise that path with the small SDK-based client (set `CW_APP_TOKEN` in the environment; configure the platform HTTPS trust store for the service certificate):

```sh
node reference/client.mjs https://source.example https://view.example order-123 [request-key]
```

The CLI prints its generated request key to stderr before submission; pass that key as the optional final argument when rerunning an uncertain operation. The imported `placeAndObserve` function requires the caller to supply a reusable key. The client uses the public `@causalweb/protocol/client` export to parse the returned context and make a bounded constrained observation. It retries only explicit `unsatisfied`/`retryable` outcomes, with a 15-second overall deadline, and prints the confirmed application response. It never treats an ordinary HTTP error or an unconfirmed response as success. This is an application example, not an automatic evidence-refresh or generic retry policy.

## Paired backup and restore exercise

Stop both services and prevent new writes or evidence issuance before creating a backup. Keep them stopped until both database snapshots and the manifest are complete. Do not copy live WAL-mode `.sqlite` files by themselves: the two databases would not form one known cut. From the repository after `npm run build`:

```sh
node reference/backup.mjs create /path/source.sqlite /path/view.sqlite /new/backup-directory
node reference/backup.mjs restore /new/backup-directory /new/restore-directory
```

Both commands require a new destination directory and never overwrite an existing one. Creation uses SQLite's backup API, then checks each database's integrity, expected tables, bound deployment identities, source order, and whether the view's applied/pending facts and frontier agree with the source. The v2 manifest contains SHA-256 checksums and is written last; restore verifies checksums and the pair before and after copying to new paths. Older unbound backups are not accepted automatically. `RESTORED.json` is written last in the restore directory. A local test restores a pending outbox and state-bound view cut, rejects mismatched source/view facts or identities, and rejects a modified backup.

Back up signing keys, verification-key manifest, TLS material, credentials, and configuration separately under appropriate secret controls. The manifest checksum detects accidental changes; it does not authenticate a backup against a malicious writer. Most importantly, restoring an older source backup after any later evidence became externally visible can erase a published stable fact and violate the Prefix Profile. This tool cannot prove that no such evidence exists. If that condition is uncertain, do not restart under the same source-domain identifier; recover the latest authoritative history or perform an explicitly reviewed domain rollover and projection repair. This is a quiescent, same-host exercise, not a continuous or disaster-recovery guarantee.

## Current boundaries

This reference is single principal, single source domain, one host, and one view. Static bearer credentials and key files are operator-managed; the code does not implement tenant provisioning, dynamic authorization, live or zero-downtime key rotation, a public CA, a secret manager, failover, general schema migration beyond the two documented version-one upgrades, continuous backup, or a general event-delivery protocol. Evidence expires after one hour. If an undelivered outbox entry's evidence has expired, the source signs fresh evidence with a new evidence identifier for the same stable fact and position before retrying delivery. A keyed client retry can also obtain fresh evidence for its original fact after expiry. The view deduplicates by stable fact identity and rejects a changed fact. An expired token already held by a client still fails until the application reissues it through the keyed source request.

The database stores positions as canonical decimal text to preserve the Prefix Profile's unsigned 64-bit range. It advances the projection in source order and reads representation data and lineage in one transaction. The reference detects a missing or noncontiguous applied row and reports `unknown` for a constrained read; delivery then stops pending repair. Do not claim Prefix Issuer, Prefix Verifier, or HTTP Server deployment conformance until the remaining failure, security, and operator tests in [the milestone](../PRODUCT_MILESTONE.md) have passed.
