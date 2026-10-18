# Causal Web SDK for TypeScript

`@causalweb/sdk` helps TypeScript applications issue evidence after a committed write, serve observations bound to trusted state lineage, and read those observations from another service. The server APIs run on Node.js 24 and newer. The `@causalweb/sdk/client` entry uses portable Fetch APIs for browser-capable runtimes; it carries opaque evidence but does not issue or verify it.

The [wire specification](https://github.com/causalweb/spec) remains the interoperability contract, not the product developers install. This SDK follows draft `0.1.1-experimental` and vector revision `0.1.4`, with the exact commit in [SPEC_REVISION](SPEC_REVISION). It has no npm release yet; the package remains private, and its name does not claim registry availability or ownership.

## Implement the protocol

The SDK exposes the interoperable operations directly: `Issuer.issueCommitted` signs a fact **after** the application commits it; `Verifier.verify` checks an evidence token against configured trust; `Snapshot.evaluate` checks evidence against lineage bound to one state cut; `observe` and `handleNodeObservation` enforce an HTTP observation; and `fetchObservation` or `waitForObservation` carries evidence and checks the response. These are protocol building blocks, not a storage or service framework. The source checkout's `examples/orders/README.md` demonstrates a complete SQLite source/view integration.

For a source route, the application's durable write comes first:

```ts
import { contextHeaders } from "@causalweb/sdk";

const fact = await sourceStore.commitWithOutbox(input, requestKey);
const now = BigInt(Math.floor(Date.now() / 1000));
const evidence = issuer.issueCommitted({
  subject: user.id,
  audiences: [audience],
  domain,
  position: fact.position,
  issuedAt: now,
  expiresAt: now + 300n,
}, now);
response.writeHead(201, Object.fromEntries(contextHeaders([evidence])));
response.end(JSON.stringify(fact.value));
```

`issuer` is an `Issuer` configured with the source's signing key and domain. The store must return a stable position only after its fact and recovery record commit; `requestKey` lets the application recover the same write if its response is lost. The observer and portable-client examples below show the other two roles.

Application code still owns durable positions, commit/outbox recovery, authenticated delivery, atomic projection and lineage updates, authorization, and the immutable state cut used for each response. The SDK cannot infer those facts from a database handle.

## Try the local demo

```sh
git clone https://github.com/causalweb/typescript.git
cd typescript
npm ci --ignore-scripts
npm run demo
```

The demo starts separate HTTPS source and view processes with temporary SQLite databases. It shows a stale constrained read, recovers authenticated delivery, and confirms the read through the SDK client. It uses a test-only localhost certificate and disposable keys and credentials, then removes its temporary data. It is not a deployment recipe; the npm tarball contains the SDK but not this example service. In the source checkout, read `examples/orders/README.md` for persistent storage and operator-supplied certificates.

## Verify the source and package

```sh
npm test
npm run test:package
```

The package check builds a real `.tgz`, installs it with its runtime dependency into a temporary application outside this repository, compiles strict Node and portable-client consumers, and runs the consumers in the source checkout's `test/consumer/`. It also runs the source-checkout order client at `examples/orders/bin/client.mjs` from that temporary application against the example's two SQLite/HTTPS processes. The quickstart first observes one committed order as stale before delivery resumes; the copied client then writes another order and confirms it through the installed SDK client. Negative type tests check that callers cannot substitute a JavaScript `number` for a position or an unauthenticated object/string for verified evidence. This is package-consumption and local process evidence, not a registry release, external developer result, or power-loss durability test.

The SDK's published JavaScript is built with tsdown in unbundle mode so its existing ESM entry points and relative modules remain intact. TypeScript still checks the source, emits declarations, and compiles decorator-based integration tests; the package check exercises the resulting tarball.

The tests exercise all shared fixtures, strict trust/encoding checks, real loopback HTTP, source and view recovery with separate SQLite databases, and a POSIX-only cross-runtime peer exchange. In the source checkout, `examples/orders/README.md` documents the example service's operational assumptions. These tests do not establish a production adapter or full deployment conformance.

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

After installing the preview archive, a Node.js application can pass evidence from an operation that actually committed to the public client entry:

```ts
import { fetchObservation } from "@causalweb/sdk/client";

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

If a view may lag behind a committed operation, `waitForObservation` handles that one safe polling case:

```ts
import { waitForObservation } from "@causalweb/sdk/client";

const result = await waitForObservation(viewUrl, evidenceTokens, {
  request: { headers: { Authorization: authorizationHeader } },
  authenticated: response => applicationAcceptsAuthentication(response),
  signal: AbortSignal.timeout(15_000),
});
```

It accepts only `GET`, retries only when every validated outcome is `unsatisfied` and retryable, waits 250 ms between attempts, and cancels each rejected response body. It returns confirmations, ordinary errors, and other causal failures without retrying them. Supply a timed signal to bound the whole wait; aborting it rejects the call. It does not retry a write or authenticate evidence from the source. The protocol permits explicitly designated read-only `POST` observations, but this polling helper does not retry them automatically; use `fetchObservation` and an application-specific retry policy. Keep the application's request key for a separate write retry after an uncertain write response.

### Node HTTP observer bridge

`handleNodeObservation` is an experimental adapter for an explicit `node:http` route. It reads `IncomingMessage.rawHeaders`, rather than Node's normalized header object, so repeated `Causal-Require` field lines remain distinct before Structured Fields parsing. A request without that field returns `false` and the host keeps normal routing ownership.

```ts
import { handleNodeObservation } from "@causalweb/sdk";

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

The optional `@causalweb/sdk/fastify` entry point is tested with Fastify `5.12.7`; applications install a compatible Fastify 5 themselves. It calls `reply.hijack()` only for a causal request, then delegates to the Node bridge using `request.raw` and `reply.raw`. Do not mix it with Fastify response headers or `reply.send()` on that path.

```ts
import { handleFastifyObservation } from "@causalweb/sdk/fastify";

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
| `Verifier.verify` | Bounded canonical JWS/JSON processing, exact issuer/domain authority, audience, subject, version, lifetime, expiry policy, and exact `bigint` issuance/expiry times for application binding | Projection relevance or applied state. Keys are configured locally, never fetched from evidence. |
| `Snapshot.evaluate` | Six outcomes from bound per-component lineage; bottom differs from unknown and position zero | Whether an adapter's lineage claim is truthful or crash-safe. |
| `observe` | Validation before reads, current authorization/expiry rechecks, all-dependency enforcement, ordered failures and cache fields | TLS termination, CORS/CSRF, source delivery, storage transactions, route designation, or transport cancellation. |

Use `bigint` for positions, NumericDates, lifetime, skew, and the UTC clock. The implementation validates incoming decimal number spellings exactly instead of rounding through `JSON.parse`. Default request limits are 16 items, 16,384 combined field bytes, 8,192 token bytes, 8,192 decoded bytes, and JSON depth 32. Lifetime and skew are mandatory explicit trust settings. Problem responses are limited to 65,536 bytes.

Observers make one attempt and advertise `max_wait_seconds: 0`. `Prefer: wait` is ignored. A carrier can opt into the Prefix Profile's safe reduction rule with `retainedContextIndices` only after it has verified each evidence item under current policy. The helper returns indices into the original ordered compact-token list; it never rewrites or synthesizes evidence and retains every item it cannot safely omit. Observation evaluation itself preserves request order and duplicate indices.

Read [CONFORMANCE.md](CONFORMANCE.md), [SECURITY.md](SECURITY.md), and [RELEASING.md](RELEASING.md) before deployment. The issuer, verifier, observer, and server adapters are Node.js code; `@causalweb/sdk/client` is a portable Fetch client entry, not a browser/WebCrypto issuer or verifier. Discussion belongs in [Causal Web Discussions](https://github.com/orgs/causalweb/discussions).

An external evaluator can use the [walkthrough and pilot protocol](PILOT.md) to record an independent integration attempt. No external result is claimed yet.

### Portable Fetch client

Use the client entry where Fetch, `Headers`, `Response`, `URL`, and abort signals are available. It preserves Causal Web request/response checks without importing Node cryptography or server adapters.

```ts
import { fetchObservation } from "@causalweb/sdk/client";

const result = await fetchObservation("https://view.example/orders/42", evidenceTokens, {
  authenticated: async (response) => response.headers.has("x-authenticated-view"),
});
```

The browser or host application must obtain evidence over an authenticated channel, protect it from inappropriate script/log exposure, and decide whether a response is authenticated. This client does not validate the evidence signature, discover keys, bypass CORS, follow redirects, or turn an ordinary read into a causal observation. It permits plaintext only for literal loopback testing and uses one bounded ten-second request attempt.

## Use the source package in an application

Build and pack from this checkout:

```sh
npm ci --ignore-scripts
npm run build
npm pack --ignore-scripts
```

Install the generated tarball in an existing Node.js 24 ESM application with `npm install /absolute/path/to/the-generated.tgz`, then import from `@causalweb/sdk`. Do not import `dist/src` internals from the installed package. TypeScript applications need their usual TypeScript compiler and Node.js type definitions; the package check verifies them without the DOM library. The complete consumer example covers issuer/verifier setup, a bound snapshot, stale and confirmed responses, and authorization denial. Its source facts are synthetic and must be replaced by an actual storage adapter before use with real guarantees.

`observe` returns ordinary 403 when `authorize` resolves to `false`; it rechecks authorization after reading. Exceptions and invalid adapter results now reject with `ObservationError` instead of silently discarding their causes. Handle this before writing HTTP:

```ts
import { observe, ObservationError, type ObservationOptions } from "@causalweb/sdk";

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
