# Release notes with Changesets

Changesets 3.0.3 tracks SDK changes, calculates versions, and generates release changelogs. It does not define protocol behavior. The SDK remains private and in `experimental` prerelease mode; there is no automatic publication or tag workflow.

For every pull request, add a note:

```sh
npm ci --ignore-scripts
npm run changeset
npm run changeset:status
npm run release:check
```

Select `@causalweb/protocol`. Describe observable changes, compatibility/migration, and relevant limitations. Use patch for compatible fixes and minor for breaking experimental `0.x` APIs or new capabilities; never select major merely to signal that a draft is complete. Changesets prerelease arithmetic determines the final number. The note must not imply that a passing test constitutes an external audit or stable protocol approval.

For documentation/tooling-only changes that do not warrant an SDK release, use `npm run changeset -- --empty -m "Explain why no SDK release is needed"`. Commit the generated note with the change. CI compares new notes to the PR base; an existing note from an earlier PR does not satisfy that check.

Maintainers prepare versions on a review branch with `npm run version:prepare`. It checks private/prerelease policy, runs Changesets, refreshes npm lock metadata offline, and adds an empty changeset for the preparation-only PR. Changesets retains consumed prerelease notes under `.changeset/pre`. Review all generated version/changelog/lock changes. `npm run test:release` rehearses this in an isolated temporary Git repository, not this checkout.

Do not run `changeset pre exit`, `changeset publish`, or `changeset git-tag` as part of ordinary contribution work. Publication, signing, registry ownership, and maturity decisions still follow [RELEASING.md](../RELEASING.md). Private-package tagging is disabled. Bypassing the version-preparation wrapper skips project checks and is not an approved release path.

References: [Changesets configuration](https://changesets.dev/guide/config), [prereleases](https://changesets.dev/guide/prereleases).
