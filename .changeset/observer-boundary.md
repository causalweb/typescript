---
"@causalweb/protocol": minor
---

Preserve local observer failures as `ObservationError` with the original cause and safe code/phase metadata. Hosts must handle rejection and call `toResponse()` instead of relying on the earlier silently constructed 500/503 response. See `MIGRATION.md` before updating a Git-based integration.

Reject malformed JavaScript representation bodies rather than coercing strings or arrays into confirmed bytes. Keep indexed causal outcomes distinct from adapter failures. Verify the public error contract using real HTTP and an installed-package consumer. No protocol wire revision or production-readiness claim changes.
