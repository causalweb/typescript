---
"@causalweb/sdk": minor
---

Rename the unreleased package to `@causalweb/sdk` and organize its implementation into protocol, server, and portable client modules. Public operations and wire behavior remain unchanged; existing source-checkout consumers must update direct internal file imports to the new folders. Storage durability, recovery, delivery, and authorization remain application responsibilities.
