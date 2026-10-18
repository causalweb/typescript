---
"@causalweb/sdk": patch
---

Add an experimental safe Prefix Profile carrier-reduction helper. It retains original verified evidence by index only when a dominant item has the same issuer, subject, audience set, profile version, domain, and commitment semantics, is at least as far in source order, and remains usable through the caller's explicit horizon.
