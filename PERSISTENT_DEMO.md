# Persistent local-service experiment

`test/persistent-projection.test.ts` is a reproducible Node.js experiment, not an SDK storage adapter or deployment profile. Run it with the repository test suite:

```sh
npm ci --ignore-scripts
npm test
```

The test starts a source HTTP service and an observation HTTP service on separate loopback ports. They use separate directories beneath the operating system temporary directory. The source writes a source fact and outbox record before it creates or returns JWS evidence. The projection writes its response data and source frontier in one atomically replaced JSON document. The observation service loads that one document and constructs both the response bytes and lineage mapping from it.

The scenario proves these behaviors for this reference experiment:

- A client receives `Causal-Context` evidence only after the source record exists.
- Before delivery, a constrained projection read returns the protocol's `unsatisfied` outcome. After delivery, the same evidence confirms a response.
- A position-three event delivered before position two remains pending. Delivery of position two applies it and drains the pending event in source order.
- A duplicate does not mutate projection state. A modified signed token is rejected before it can advance the frontier.
- An injected interruption after source commit leaves a durable outbox fact without evidence. After service reconstruction, outbox recovery creates the missing evidence and the projection can account for it.
- Reconstructing both services from their state directories retains the previously confirmed state.

The test uses the exported `Issuer`, `Verifier`, `Snapshot`, `observe`, `fetchObservation`, and Structured Field helpers. It does not hardcode a causal HTTP response.

## Assumptions and boundaries

The experiment serializes source commits and projection deliveries. It relies on Node.js file replacement within a single local filesystem. It does not call `fsync`, prove power-loss durability, persist signing keys, run services in separate operating-system processes, provide TLS or application authentication, model concurrent writers, or validate a database transaction. The fixed test clock and loopback transport are test controls.

It therefore demonstrates the required state-lineage shape and a narrow recovery path. It does not establish a production-grade outbox, filesystem portability, multi-process crash safety, cross-language persistent-service interoperability, or a complete Prefix Issuer/Verifier deployment class. Deployments must supply their own storage transaction, key management, authentication, authorization, recovery, and operational controls described in [SECURITY.md](SECURITY.md).
