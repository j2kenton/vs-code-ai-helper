# Workflow-production-source fixture provenance

Every fixture here must record the digest rule it pins. The provenance gate
(the shared scripts/lib/fixtureProvenance.mjs walk, run from
scripts/resolveProductionSourceUniverse.mjs on every verify and generate
invocation) matches this table against the tree bidirectionally: a fixture
with no row, a row naming no fixture, and any entry that is not a top-level
`*.json` file are all failures. When adding a fixture, record below exactly
which verification consumes it.

| Fixture | Digest rule it pins |
|---|---|
| `eol-digest-fixture-v1.json` | Base64 digest-portability vectors (base64 so git EOL settings cannot rewrite them). `text.*`: the same text in its LF and CRLF single-EOL forms must both canonicalize to `text.canonicalSha256`, genuinely mutated text must not, and the tolerant pre-gate matcher must accept the recorded historical raw digests (`lfRawSha256`/`crlfRawSha256`) from either representation — consumed by `verifyEolDigestPortabilityFixture` in scripts/resolveProductionSourceUniverse.mjs. `binary.*`: NUL-bearing bytes with embedded CRLF must hash verbatim to `binary.rawSha256`, never line-ending-normalized. `universe.*`: the same minimal production-source-universe JSON in its LF and CRLF serializations must flow through `parseUniverseTsFiles` to the identical `universeSha256` (`universe.canonicalSha256`) with identical file lists, while the one-digest-byte mutation must not — consumed by `verifyUniverseDigestPortabilityFixture` in scripts/lib/inventoryUniverse.mjs on every route and path-consumer inventory run. |
