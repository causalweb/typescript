# Conformance and implementation evidence

Status: experimental source preview. Passing tests below does not certify a deployed source or view, an npm release, or the protocol as stable.

The SDK implements draft `0.1.1-experimental` at the exact commit in [SPEC_REVISION](SPEC_REVISION), with shared vector revision `0.1.4`. [CONFORMANCE_REVISION](CONFORMANCE_REVISION) pins the language-neutral runner. [RUST_REVISION](RUST_REVISION) pins a development-only peer, not a runtime dependency. The release workflow runs against those exact commits; this working tree is not itself a published conformance report.

## Tested behavior

| Runner profile | Cases | What it exercises |
| --- | ---: | --- |
| `evidence-verification-v1` | 32 | Signed evidence, common claims, trust, and malformed encodings |
| `prefix-evaluation-v1` | 17 | Bound frontiers, exclusions, unknown lineage, failure, and exact positions |
| `context-reduction-v1` | 3 | Optional carrier reduction without losing incomparable evidence |
| `http-client-confirmation-v1` | 11 | Requirement fields, causal confirmation, and ordinary HTTP outcomes |
| `http-redirect-agent-v1` | 1 | No unsafe cross-origin evidence forwarding |
| `http-observer-v1` | 15 | Fixed-cut observer outcomes and authorization checkpoints |
| `http-transport-server-v1` | 7 | Raw loopback HTTP/1.1 field handling and response serialization |

The runner invokes the SDK through development-only adapters in `scripts/`; its profiles cover selected requirements, not every conformance-class obligation. The observer uses synthetic fixed-cut snapshots; the transport server is loopback-only. Neither proves application storage, proxy, TLS, cancellation, or deployment behavior. `npm test` also exercises the vendored shared fixtures, adverse parsing/trust cases, and public Node, Fastify, and portable Fetch APIs. `npm run test:package` installs the actual tarball into an isolated consumer and tests its exports and types.

Two separately pinned proposal profiles are **not normative conformance claims**:

| Proposal profile | Cases or steps | Boundary |
| --- | ---: | --- |
| `uri-identities-draft-v1` | 4 | Fragment-free RFC 3986 identities and exact issuer matching; proposal commit `b5a216510708553f7ac763d02ec12755df78d7f1` |
| `terminal-failure-draft-v1` | 20 | View-owned durable decisions, resolution, partitioning, and contract isolation; proposal commit `501a5fd6e5289748c482e34711c8e90b42f60aff` |

The TypeScript preview enforces the fragment-free rule and includes its signed fixtures, but the rule is not yet pinned in the normative SDK spec revision or interoperable with the historical Rust peer. Terminal-failure tests use a disposable SQLite view and a fresh adapter process per step. They do not establish OS-level operator authentication, external cutover, concurrent incident diagnosis, or power-loss durability.

## Application example and limits

The source checkout's order example (`examples/orders/README.md`) uses the SDK with separate SQLite source and view databases, HTTPS processes, a recoverable outbox, authenticated delivery, and representation/frontier updates in one transaction. Its fault model (`examples/orders/FAULT_MODEL.md`) links process-interruption, retry, identity, key-rotation, failure-decision, and paired-backup tests to their exact limits. The demo and package-consumer check exercise a stale `412` followed by a confirmed `200` through the installed SDK client.

This example is not a reusable storage adapter or a certified deployment. Its local process-kill tests do not prove host or power-loss recovery, multi-host operation, a continuous backup, or an external operator's correct decision. The SDK cannot establish that an application committed the claimed fact, bound lineage to the returned representation, or enforced authentication and authorization; integrators must supply and test those boundaries.

No independent security or protocol review, external developer pilot, complete conformance-class report, browser deployment certification, or stable-version interoperability is recorded. A push or passing CI run does not close those gates. See [release gates](RELEASING.md), [security policy](SECURITY.md), and [pilot instructions](PILOT.md).
