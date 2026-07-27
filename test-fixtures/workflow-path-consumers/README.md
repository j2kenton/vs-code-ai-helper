# Workflow-path-consumer fixture provenance

Every fixture here must record the extraction rule it pins. These files are
parsed only by the path-consumer extractor's TS AST walk
(scripts/lib/workflowPathConsumerScan.mjs) — never compiled by any tsconfig
— and the self-test in scripts/generateWorkflowPathConsumers.mjs re-parses
them on every verify and generate invocation, so the extractor can neither
under- nor over-match silently before any real consumer evidence is trusted.
The provenance gate (the shared scripts/lib/fixtureProvenance.mjs walk, run
from the same script) matches this table against the tree bidirectionally: a
fixture with no row, a row naming no fixture, and any entry that is not a
top-level `*.fixture.ts` file are all failures. When adding a fixture,
record below exactly which self-test assertion consumes it.

| Fixture | Extraction rule it pins |
|---|---|
| `fsConsumer.fixture.ts` | Positive surface for `extractPathConsumerCallSites`: exactly three call sites with exactly the signal kinds `import:fs` (the `fs.existsSync` call under an `fs` namespace import), `import:child_process` (the `spawn` call under a `node:child_process` import), and `workspace.fs` (the `vscode.workspace.fs.readFile` access) — each carrying a compiler-derived `L<n>-L<n>` span and an enclosing symbol. |
| `clean.fixture.ts` | Negative over-match guard: a non-fs `.fs` property name plus a `node:path` import must yield ZERO call sites, so the extractor cannot silently over-match on unrelated `.fs` property names or non-filesystem imports. |
