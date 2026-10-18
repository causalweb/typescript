---
---

Require an application request key for reference-service writes and bind it atomically to the committed source fact. Matching retries recover the same position, including after restart or evidence expiry; conflicting retries fail without a causal marker. This is a breaking reference HTTP contract and an atomic source-schema migration to version 2, not a Causal Web wire or published SDK API change. Old unkeyed writes cannot be retroactively mapped, and old binaries fail closed after migration.
