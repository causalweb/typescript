---
"@causalweb/sdk": patch
---

Reject IPv6 zone identifiers in URI IP-literals. RFC 9844 obsoletes RFC 6874 and restores RFC 3986's IP-literal grammar; Node's `isIP` alone accepts scoped addresses. This is a breaking validation change for applications using zone-qualified URI identities. Published specification and conformance pins remain unchanged pending compatibility review.
