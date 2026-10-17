# Unreleased observer error contract

The experimental source API now preserves local adapter failures instead of returning an ordinary error response while discarding the cause. No npm package or version tag preceded this change. The protocol wire format, specification pin, shared vectors, and `observe(options): Promise<Response>` return type do not change, but its rejection contract does. Earlier Git consumers must update their server error boundary.

## Keep protocol responses separate from local exceptions

`await observe(options)` returns HTTP responses for ordinary access denial, invalid requirements, indexed causal failures, and confirmed observations. A returned response is not necessarily successful; inspect its HTTP status/causal metadata.

Local adapter/contract failures reject with exported `ObservationError`. It has safe `code`/`phase` metadata and, where present, the original thrown value in the standard non-enumerable `cause` property. It accepts errors thrown synchronously, promise rejections, and non-Error thrown values without replacing the original value.

| Code | Phase | `toResponse()` |
| --- | --- | --- |
| `authorization-unavailable` | `before-read` or `before-response` | Ordinary 503 |
| `read-unavailable` | `read` | Ordinary 503 |
| `snapshot-target-mismatch` | `read` | Ordinary 503 |
| `invalid-representation` | `representation` | Ordinary 500 |
| `invalid-clock` | `before-read` or `before-response` | Ordinary 500 |
| `verification-failed` | `before-read` or `before-response` | Ordinary 500 for an unexpected local validation failure, not a recognized invalid request |

An authorization callback resolving to `false` still produces ordinary 403. A non-boolean JavaScript result is a local authorization contract failure. The clock must return non-negative `bigint` UTC seconds; throwing or returning another type is a local clock failure. The reader must return this SDK's `Snapshot` with an integer status, `Headers`, and `Uint8Array`/`Buffer` representation body. No string/array-to-byte coercion is performed.

## Add a safe host boundary

Catch `ObservationError`, inspect its code/phase, apply the application's own diagnostic redaction, and return `error.toResponse()`. Re-throw unexpected errors to the host's normal safe handler. The [README](README.md) shows this function and the [installed-package consumer](test/consumer/main.ts) exercises the exported class, original cause identity, and safe conversion.

The generated response has an empty body, `Cache-Control: no-store`, and no `Causal-Result` or application payload. This preserves the earlier ordinary 500/503 wire policy when the new host boundary is installed. Do not return `Response.json(error.cause)`, put secrets in a problem response, or rely on a framework's development-mode exception renderer.

The SDK never automatically logs or serializes the cause. Node.js loggers can inspect nested causes, so a non-enumerable property is not a redaction guarantee. These errors are not causal `failed` outcomes and do not authorize an unconstrained retry. The host still owns TLS, response commitment, request cancellation, bounded callback I/O, and durable lineage. There is no new protocol version or framework requirement.
