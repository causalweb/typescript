---
"@causalweb/sdk": patch
---

Expose the verified evidence issuance time as an exact bigint so application delivery envelopes can bind it to signed evidence. The order reference now rejects a correctly signed delivery envelope whose `issuedAt` disagrees with the enclosed evidence.
