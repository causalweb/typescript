# External developer walkthrough and pilot

Status: invitation material only. No external walkthrough or pilot result is recorded here. The package is private and experimental. Use a CI preview artifact from an exact workflow run, or arrange an exact source revision with the maintainer. Do not use production data.

After a TypeScript PR's Linux and Windows checks pass, open that commit's `TypeScript checks` workflow run and download the `typescript-preview-<run SHA>` artifact. It contains the exact `.tgz` installed by the Linux package-consumer test, plus `SHA256SUMS` and `SOURCE_COMMIT`. Extract it, run `sha256sum -c SHA256SUMS` in that directory (or compare `Get-FileHash <archive.tgz> -Algorithm SHA256` with the recorded digest on Windows), and record the workflow URL and source commit. Artifacts expire after 30 days. The archive is a source preview, not an npm publication or a deployment endorsement.

## Walkthrough: can another developer use the SDK?

An evaluator who did not write this implementation should work without live author assistance. Record the exact TypeScript and specification revisions, Node.js version, operating system, and SHA-256 of any supplied `.tgz`. From a fresh checkout, run `npm ci --ignore-scripts`, `npm run demo`, `npm test`, and `npm run test:package`. The demo uses disposable keys, credentials, databases, and a test-only localhost certificate. It is not a deployment.

In a separate application directory, install the supplied package archive and implement one application write followed by a constrained observation using public package exports. Do not copy evidence parsing, delivery-proof construction, or observer HTTP parsing from `reference/`. Use an application request key that survives an uncertain write response. Obtain `Causal-Context` only from a write response authenticated by the application, carry it to the read, and check the result with `fetchObservation` or `waitForObservation` for a `GET` read. Record the application code needed, setup time, commands, failures, and any instruction that required a guess. A project-authored package consumer is a regression test, not this walkthrough.

The evaluator should observe an authenticated stale result before the view catches up, a confirmed result afterward, and ordinary access denial when application credentials are absent. Report whether those outcomes were visible and whether the SDK prevented an unaware success. Do not claim the walkthrough passed if a maintainer supplied missing implementation steps during the attempt; record that intervention instead.

## Persistent pilot: does one real integration survive recovery?

A separate external integration or pilot must use an application-owned committed fact and a state-bound view on persistent storage. The order reference at `reference/README.md` in the source checkout is an example, not a substitute for the evaluator's integration. Document the chosen deployment class, source transaction and outbox boundary, view transaction and frontier boundary, TLS and key ownership, subject authorization, request-key retention, process restart, key rotation, and paired backup/restore plan. Test with disposable, non-sensitive data. Do not run a destructive failure exercise against live data.

At minimum, retain evidence of a committed write, a stale constrained read, authenticated delivery, a confirmed read, a retry after an uncertain write response that does not create another fact, and a restart with the same frontier. If the pilot cannot exercise a case, mark it untested. A local project-authored demo, a passing conformance runner, or a walkthrough alone does not satisfy this pilot gate.

## Return a reviewable record

Provide the revisions and artifact checksum, a link or patch for the separate application, redacted commands and outputs for each attempted case, the observed result and expected result, setup time, application code size, points of confusion, and any maintainer assistance. Name the reviewer or organization only with their consent. Keep bearer tokens, private keys, live evidence, personal data, and deployment addresses out of public reports. Send exploitable trust-boundary findings through [private security reporting](SECURITY.md); use a public issue or proposal for non-sensitive usability and protocol findings.

Maintainers should link the returned record from the [release-readiness register](https://github.com/causalweb/spec/blob/main/ROADMAP.md) only after checking the artifact identity, application independence, test coverage, and unresolved failures. A result with missing evidence remains an open gate, not an endorsement or a stable-release decision.
