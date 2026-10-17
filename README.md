# Causal Web for TypeScript

An independent experimental Causal Web implementation for Node.js 24 and newer. It implements its own evidence validation, prefix evaluation, and HTTP behavior. It does not call Rust, load a Rust binary, or use a shared protocol engine.

The [specification](https://github.com/causalweb/spec) remains authoritative. This source preview follows draft `0.1.1-experimental` and vector revision `0.1.2`, with the exact commit in [SPEC_REVISION](SPEC_REVISION). There is no npm release yet; the package is deliberately private. The package name in `package.json` does not claim registry availability or ownership.

## Run it

```sh
git clone https://github.com/causalweb/typescript.git
cd typescript
npm ci --ignore-scripts
npm test
```

The tests exercise all shared fixtures, strict trust/encoding checks, and real loopback HTTP. The HTTP test rejects a stale snapshot, advances test lineage, and confirms the same dependency. It also checks unaware origins, redirects, malformed outcomes, cancellation, and response-size limits. Its lineage is synthetic: it is not a durable multi-service demonstration.

To check fixture provenance against an available `spec` checkout:

```sh
node scripts/check-spec.mjs ../spec
```

The script reads the exact pinned commit even if the checkout's branch has advanced. For cross-implementation checks, use a clean Rust checkout at the commit in [RUST_REVISION](RUST_REVISION):

```sh
npm run build
node scripts/interop.mjs ../rust
```

That development-only command checks both protocol engines against each other's signed evidence and HTTP field strings, including stale, expired, forged, and cross-tenant cases. Rust is a test peer, not a dependency of this package. The check does not establish durable storage correctness or production interoperability.

## Integrate an observation

After obtaining evidence from an operation that actually committed, a Node.js application can use the built package directly from this checkout:

```ts
import { fetchObservation } from "./dist/src/index.js";

const result = await fetchObservation(viewUrl, evidenceFromCommittedOperations, {
  request: { headers: { Authorization: authorizationHeader } },
  authenticated: response => applicationAcceptsAuthentication(response),
});

if (result.kind === "confirmed") {
  // Preserve HTTP semantics: a confirmed 404/410 still means application absence.
  useConfirmedObservation(result.response);
} else if (result.kind === "causal-failure") {
  handleDependencyOutcomes(result.problem.outcomes);
} else {
  handleOrdinaryHttpError(result.response);
}
```

The application supplies its existing authentication check; evidence does not grant access. The helper sends `no-cache, no-store`, never follows redirects, imposes a ten-second exchange deadline, and permits earlier cancellation through `request.signal`. It rejects plaintext transport except literal loopback (`127.0.0.1` or `::1`) for protected local development. Integrations using another administratively protected channel can use the lower-level field/confirmation helpers with an explicitly reviewed transport.

For causal failures, the helper consumes and validates the bounded problem body and returns it as `result.problem`; `response.body` is then consumed. Confirmed response bodies remain available. Do not turn an error into an unconstrained retry without an explicit caller decision.

## Producer and observer responsibilities

| API | Provides | Does not establish |
| --- | --- | --- |
| `Issuer.issueCommitted` | ES256 evidence with a collision-resistant generated identifier unless one is supplied | Source commitment, outbox durability, stable position allocation, or history recovery. |
| `Verifier.verify` | Bounded canonical JWS/JSON processing, exact issuer/domain authority, audience, subject, version, lifetime, and expiry policy | Projection relevance or applied state. Keys are configured locally, never fetched from evidence. |
| `Snapshot.evaluate` | Six outcomes from bound per-component lineage; bottom differs from unknown and position zero | Whether an adapter's lineage claim is truthful or crash-safe. |
| `observe` | Validation before reads, current authorization/expiry rechecks, all-dependency enforcement, ordered failures and cache fields | TLS termination, CORS/CSRF, source delivery, storage transactions, route designation, or transport cancellation. |

Use `bigint` for positions, NumericDates, lifetime, skew, and the UTC clock. The implementation validates incoming decimal number spellings exactly instead of rounding through `JSON.parse`. Default request limits are 16 items, 16,384 combined field bytes, 8,192 token bytes, 8,192 decoded bytes, and JSON depth 32. Lifetime and skew are mandatory explicit trust settings. Problem responses are limited to 65,536 bytes.

Observers make one attempt and advertise `max_wait_seconds: 0`. `Prefer: wait` is ignored. No carrier reduction is performed: evidence order, duplicate indices, and independent domains are preserved.

Read [CONFORMANCE.md](CONFORMANCE.md), [SECURITY.md](SECURITY.md), and [RELEASING.md](RELEASING.md) before deployment. The Node.js implementation is not yet a browser/WebCrypto package. Discussion belongs in [Causal Web Discussions](https://github.com/orgs/causalweb/discussions).

Code/tooling: `Apache-2.0 OR MIT`; documentation: `CC-BY-4.0`. See [LICENSE.md](LICENSE.md).
