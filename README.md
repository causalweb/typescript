# Causal Web for TypeScript

An independent experimental Causal Web implementation for Node.js 24 and newer. It implements its own evidence validation, prefix evaluation, and HTTP behavior. It does not call Rust, load a Rust binary, or use a shared protocol engine.

The [specification](https://github.com/causalweb/spec) remains authoritative. This source preview follows draft `0.1.1-experimental` and vector revision `0.1.3`, with the exact commit in [SPEC_REVISION](SPEC_REVISION). There is no npm release yet; the package is deliberately private. The package name in `package.json` does not claim registry availability or ownership.

## Run it

```sh
git clone https://github.com/causalweb/typescript.git
cd typescript
npm ci --ignore-scripts
npm test
npm run test:package
```

The package check builds a real `.tgz`, installs it with its runtime dependency into a temporary application outside this repository, compiles with strict Node-only types, and runs [the consumer example](test/consumer/main.ts). Negative type tests check that callers cannot substitute a JavaScript `number` for a position or an unauthenticated object/string for verified evidence. This is package-consumption evidence, not a registry release or storage-durability test.

The tests exercise all shared fixtures, strict trust/encoding checks, and real loopback HTTP. They include a [persistent local-service experiment](PERSISTENT_DEMO.md): a source HTTP service writes an outbox before returning evidence, a projection service writes representation bytes and frontier in one document, and constrained reads move from `unsatisfied` to confirmed after propagation. It covers delayed, out-of-order, duplicate, forged, interrupted, and recovered events. A separate POSIX-only [cross-runtime experiment](CROSS_RUNTIME_DEMO.md) runs a TypeScript source process and a Rust observer process over loopback HTTP. Neither experiment is a production adapter or full deployment conformance.

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

For causal failures, the helper consumes and validates the bounded problem body and returns it as `result.problem`; `response.body` is then consumed and its reader lock is released. Confirmed response bodies remain available and belong to the caller, who must consume or cancel them. Do not turn an error into an unconstrained retry without an explicit caller decision.

### Node HTTP observer bridge

`handleNodeObservation` is an experimental adapter for an explicit `node:http` route. It reads `IncomingMessage.rawHeaders`, rather than Node's normalized header object, so repeated `Causal-Require` field lines remain distinct before Structured Fields parsing. A request without that field returns `false` and the host keeps normal routing ownership.

```ts
import { handleNodeObservation } from "@causalweb/protocol";

const handled = await handleNodeObservation(request, response, {
  target: "/orders/42",
  designatedObservation: true,
  verifier,
  subject: authenticatedUser.id,
  authorize: () => authenticatedUserMayReadOrder(),
  clock: () => BigInt(Math.floor(Date.now() / 1000)),
  read: () => readOneImmutableOrderSnapshotWithTrustedLineage(),
  onLocalError: error => logger.error({ code: error.code, phase: error.phase }),
});
if (!handled) routeOrdinaryRequest(request, response);
```

The adapter writes every causal response itself. It preserves separate `Set-Cookie` fields, returns safe marker-free ordinary errors for local adapter failures, and does not invoke a normal route after handling a causal request. It cannot make a mutable read into a snapshot: `read` must bind representation bytes and trusted lineage to the same immutable state cut. It also does not supply cancellation, TLS, authorization, or a database transaction.

### Fastify 5 adapter

The optional `@causalweb/protocol/fastify` entry point is tested with Fastify `5.12.7`; applications install a compatible Fastify 5 themselves. It calls `reply.hijack()` only for a causal request, then delegates to the Node bridge using `request.raw` and `reply.raw`. Do not mix it with Fastify response headers or `reply.send()` on that path.

```ts
import { handleFastifyObservation } from "@causalweb/protocol/fastify";

app.get("/orders/42", async (request, reply) => {
  if (await handleFastifyObservation(request, reply, observerOptions)) return reply;
  return reply.send(await ordinaryOrderResponse());
});
```

The integration has only loopback test evidence. It is not a Fastify core contribution, an upstream endorsement, a durable projection adapter, or an assurance that application hooks enforce authorization around a causal response.

### NestJS 12 on Express

The same Node bridge is exercised through a NestJS `12.1.3` application using its Express platform. Nest's `@Res()` selects library-specific response handling: the controller owns the entire response and must not return a competing framework payload after a causal request has been written.

```ts
@Get("orders/42")
async view(@Req() request: Request, @Res() response: Response): Promise<void> {
  if (await handleNodeObservation(request, response, observerOptions)) return;
  response.json(await ordinaryOrderResponse());
}
```

This is compatibility evidence for the Node bridge, not a Nest module, interceptor, decorator package, or a claim that all Nest middleware, guards, or response-mapping features apply to the raw causal path. The [Nest controller guidance](https://docs.nestjs.com/controllers) similarly assigns response ownership to handlers using `@Res()`.

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

## Use the source package in an application

Build and pack from this checkout:

```sh
npm ci --ignore-scripts
npm run build
npm pack --ignore-scripts
```

Install the generated tarball in an existing Node.js 24 ESM application with `npm install /absolute/path/to/the-generated.tgz`, then import from `@causalweb/protocol`. Do not import `dist/src` internals from the installed package. TypeScript applications need their usual TypeScript compiler and Node.js type definitions; the package check verifies them without the DOM library. The complete consumer example covers issuer/verifier setup, a bound snapshot, stale and confirmed responses, and authorization denial. Its source facts are synthetic and must be replaced by an actual storage adapter before use with real guarantees.

`observe` returns ordinary 403 when `authorize` resolves to `false`; it rechecks authorization after reading. Exceptions and invalid adapter results now reject with `ObservationError` instead of silently discarding their causes. Handle this before writing HTTP:

```ts
import { observe, ObservationError, type ObservationOptions } from "@causalweb/protocol";

async function handleObservation(options: ObservationOptions): Promise<Response> {
  try {
    return await observe(options);
  } catch (error) {
    if (!(error instanceof ObservationError)) throw error;
    // This application logs only safe metadata; its logger/redaction policy owns causes.
    console.error({ code: error.code, phase: error.phase });
    return error.toResponse();
  }
}
```

The original cause is available as `error.cause` and may contain secrets. Do not serialize it or log it without redaction. `toResponse()` constructs an empty `no-store` 503 for authorization/read/target failures, or 500 for clock, verification, and invalid-representation failures. It never includes a cause, application data, or causal marker. Indexed causal `failed` outcomes remain ordinary returned protocol responses, not these local exceptions. The SDK installs no process-wide logger, HTTP server error handler, or adapter timeout. Bound/cancel application I/O in the host. See [MIGRATION.md](MIGRATION.md) for this breaking change to the unreleased error contract.

Builds remove only the generated `dist` directory before compilation so deleted or renamed modules do not remain in the package. Issuer configuration and key references use ECMAScript private fields and frozen instances; this prevents accidental mutation/enumeration, not compromise of the Node.js process. Snapshot representations require integer status, `Headers`, and `Uint8Array`/`Buffer` body values. A JavaScript string or array is rejected, never silently coerced into different confirmed bytes. The wire revision is unchanged.

Code/tooling: `Apache-2.0 OR MIT`; documentation: `CC-BY-4.0`. See [LICENSE.md](LICENSE.md).
