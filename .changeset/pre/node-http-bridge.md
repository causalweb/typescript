---
"@causalweb/sdk": minor
---

Add experimental Node HTTP and Fastify 5 observer adapters. The Node bridge
preserves repeated received `Causal-Require` field lines, routes ordinary
requests back to the host, and converts local observer failures into
marker-free ordinary errors. The Fastify adapter is an optional peer entry
point. Neither adapter is a new protocol profile or a durable projection
integration. Add loopback compatibility coverage for NestJS 12 on Express;
it uses the Node bridge rather than a Nest-specific package.
