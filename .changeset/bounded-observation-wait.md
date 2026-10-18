---
"@causalweb/protocol": patch
---

Add a portable `waitForObservation` helper for a lagging view. It requires a caller deadline, retries only validated retryable `unsatisfied` outcomes, and returns terminal failures and ordinary errors without retrying them.
