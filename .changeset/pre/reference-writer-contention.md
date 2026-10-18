---
---

Bound the reference source's SQLite writer-lock wait at two seconds and verify that two child processes preserve keyed deduplication and ordered positions through a short lock collision. This is an application-reference reliability change, not an SDK API or protocol wire change.
