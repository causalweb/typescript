---
"@causalweb/protocol": patch
---

Add a reproducible persistent local-service experiment using the public Node.js API. It verifies stale rejection, delayed and out-of-order propagation, idempotent duplicate delivery, forged-evidence rejection, logical service reconstruction, and a narrow source-outbox recovery path. The experiment is test-only and documents its filesystem, process, concurrency, and key-management limits. It does not add a storage adapter or a production conformance claim.
