import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const spec = process.argv[2];
const proposalSpec = process.argv[3];
assert.ok(
  spec,
  "usage: node scripts/check-spec.mjs PATH_TO_SPEC_CHECKOUT [PATH_TO_URI_PROPOSAL_CHECKOUT]",
);
const revision = readFileSync("SPEC_REVISION", "utf8").trim();
assert.match(revision, /^[0-9a-f]{40}$/);
for (const name of [
  "jws-evidence.json",
  "prefix-evaluation.json",
  "http-outcomes.json",
  "evidence-validation.json",
]) {
  const pinned = execFileSync("git", ["-C", spec, "show", `${revision}:test-vectors/${name}`]);
  assert.deepEqual(
    readFileSync(`test/vectors/${name}`),
    pinned,
    `${name} differs from pinned specification`,
  );
}
console.log("four fixture files match the exact specification commit");
if (proposalSpec) {
  const proposalRevision = "b5a216510708553f7ac763d02ec12755df78d7f1";
  const proposal = execFileSync("git", [
    "-C",
    proposalSpec,
    "show",
    `${proposalRevision}:test-vectors/uri-identities.json`,
  ]);
  assert.deepEqual(
    readFileSync("test/vectors/uri-identities.json"),
    proposal,
    "URI fixture differs from the unreleased specification proposal",
  );
  console.log("URI fixture matches the unreleased specification proposal commit");
}
