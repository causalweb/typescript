---
"@causalweb/sdk": patch
---

Reject constrained `HEAD` requests and `Connection` headers that nominate a causal field before sending them. Protocol version 0.1 cannot carry the required per-item failure body on `HEAD`, and causal fields must remain end-to-end.
