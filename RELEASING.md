# Release gates

No npm package or GitHub release has been published. `private: true` prevents accidental registry publication. The configured package name is not a claim of registry ownership or availability.

New release notes use [Changesets](.changeset/README.md). Prepare versions on a review branch with `npm run version:prepare`; it generates experimental version/changelog updates and refreshes npm lock metadata. Run `npm run release:check` and `npm run test:release` before review. These commands do not publish or tag. Stable-exit intent and enabling publication require a separate reviewed policy/approval change; they are not routine version preparation.

Before a source preview or package release:

1. Pin specification/vector and peer revisions, document compatibility and unclaimed classes, and resolve known critical/high correctness or security defects.
2. Verify clean-checkout Linux/Windows tests, shared-fixture provenance, bidirectional peer checks, current dependency advisories, and package contents on the exact release commit.
3. Update changelog, source API migration notes, limitations, security channel, and installation instructions. Run `npm run test:package`, not just a dry run: install the actual tarball in an isolated application, compile the exported types, and run the consumer, including its safe local-error boundary. Inspect package contents; built exports/types, migration notes, and required licenses must be included, while tests, private keys, tokens, and local workspaces must be excluded. Never serialize local cause-chain diagnostics into HTTP.
4. Confirm actual registry scope ownership, package-name availability, maintainer approval, and secure publishing credentials. Do not reserve names with placeholders or put tokens in repository configuration.
5. Prepare an immutable annotated tag, preferably signed with an actual maintainer identity, package integrity checksums, and provenance where supported. Record unavailable signing rather than fabricating it.

Stable package semantics do not promote the protocol. Stable specification release requires the [organization evidence register](https://github.com/causalweb/spec/blob/main/ROADMAP.md), including real persistent services, failure recovery, substantive external review, an external integration/pilot, and a recorded maintainer decision.
