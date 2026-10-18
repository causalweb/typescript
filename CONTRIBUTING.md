# Contributing

The [specification](https://github.com/causalweb/spec) defines behavior. Normative changes follow its public proposal process; do not silently let JavaScript or TypeScript number/URL behavior redefine the protocol.

Source ownership is explicit: `src/protocol/` implements evidence, parsing, prefix evaluation, limits, and errors; `src/server/` handles HTTP observations and Node/Fastify integration; `src/client/` is the portable Fetch and header client. `src/index.ts` is the public Node entry, while the package's `/client` entry stays free of Node imports. Keep application storage and delivery examples under `examples/orders/src/`, not inside the protocol engine. Only declared package exports are supported imports.

Run `npm ci --ignore-scripts`, `npm test`, `node scripts/check-spec.mjs PATH_TO_SPEC`, and `npm audit`. Peer changes also run `node scripts/interop.mjs PATH_TO_PINNED_RUST`. Fixtures remain byte-identical to `SPEC_REVISION`; update source/peer pins and CI together when compatibility changes.

Run `npm run check` for the pinned Biome formatter/linter and import-order checks. Warnings fail the check. `npm run format` applies formatting only; review lint fixes separately. `npm run format:check` and `npm run lint` are available for focused checks. CI runs the combined check on Linux and Windows; `npm test` separately runs the strict TypeScript compiler and behavior tests. Vendored vectors, generated lockfiles/build output, and nested checkouts are excluded from formatting. Do not normalize fixture bytes or suppress a rule to conceal a trust-boundary defect.

New behavior needs positive and adverse tests, including malformed input, trust boundaries, expiry, stale state, and ordinary access denial. A storage adapter needs a documented source/projection contract and crash-injection evidence before claiming a deployment conformance class.

Use the [Changesets workflow](.changeset/README.md): each PR adds a new changeset, or an explained empty note when no SDK release is needed. Run `npm run changeset`, `npm run release:check`, and `npm run test:release`. CI checks notes relative to the PR base. New release notes belong in `.changeset/`, not handwritten version entries in `CHANGELOG.md`. Version preparation is separate from publishing or protocol maturity.

Use [organization Discussions](https://github.com/orgs/causalweb/discussions) for design and experiments, repository issues for concrete defects, and [SECURITY.md](SECURITY.md) for vulnerabilities. Follow the [community conduct policy](https://github.com/causalweb/.github/blob/main/CODE_OF_CONDUCT.md).

Submit only material you have the right to provide under the [applicable licenses](LICENSE.md), retain third-party notices, and do not contribute production credentials or private test keys. No copyright assignment is requested.
