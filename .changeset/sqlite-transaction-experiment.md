---
"@causalweb/protocol": patch
---

Add a reproducible SQLite transaction experiment using the public Node.js protocol API. It verifies atomic source fact/outbox commitment, a projection response and frontier selected from one transactional cut, stale rejection before delivery, ordered propagation, rollback, forged-evidence rejection, and close/reopen recovery. It is test-only and does not add a production database adapter or deployment claim.
