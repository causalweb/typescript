---
"@causalweb/protocol": patch
---

Reject fragment-bearing issuer, profile, and domain URI identities in the experimental TypeScript implementation, and exercise the specification draft's three complete signed URI cases in the consumer. This is a breaking validation change for applications using literal `#` identifiers; `%23` remains valid and exact. Published specification and conformance pins remain unchanged pending compatibility review.
