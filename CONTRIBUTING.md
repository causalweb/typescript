# Contributing

The [specification](https://github.com/causalweb/spec) defines behavior. Normative changes follow its public proposal process; do not silently let JavaScript or TypeScript number/URL behavior redefine the protocol.

Run `npm ci --ignore-scripts`, `npm test`, `node scripts/check-spec.mjs PATH_TO_SPEC`, and `npm audit`. Peer changes also run `node scripts/interop.mjs PATH_TO_PINNED_RUST`. Fixtures remain byte-identical to `SPEC_REVISION`; update source/peer pins and CI together when compatibility changes.

New behavior needs positive and adverse tests, including malformed input, trust boundaries, expiry, stale state, and ordinary access denial. A storage adapter needs a documented source/projection contract and crash-injection evidence before claiming a deployment conformance class.

Use the [Changesets workflow](.changeset/README.md): each PR adds a new changeset, or an explained empty note when no SDK release is needed. Run `npm run changeset`, `npm run release:check`, and `npm run test:release`. CI checks notes relative to the PR base. New release notes belong in `.changeset/`, not handwritten version entries in `CHANGELOG.md`. Version preparation is separate from publishing or protocol maturity.

Use [organization Discussions](https://github.com/orgs/causalweb/discussions) for design and experiments, repository issues for concrete defects, and [SECURITY.md](SECURITY.md) for vulnerabilities. Follow the [community conduct policy](https://github.com/causalweb/.github/blob/main/CODE_OF_CONDUCT.md).

Submit only material you have the right to provide under the [applicable licenses](LICENSE.md), retain third-party notices, and do not contribute production credentials or private test keys. No copyright assignment is requested.
