# Workflow-route fixture provenance

Every fixture here must record the extraction rule it pins. These files are
parsed only by the route-scan extractor's TS AST walk
(scripts/lib/workflowRouteScan.mjs) — never compiled by any tsconfig — and
the self-test in scripts/generateWorkflowRoutes.mjs re-parses them on every
verify and generate invocation, so an extractor regression fails the whole
inventory run before any real route evidence is trusted. The provenance gate
(the shared scripts/lib/fixtureProvenance.mjs walk, run from the same
script) matches this table against the tree bidirectionally: a fixture with
no row, a row naming no fixture, and any entry that is not a top-level
`*.fixture.ts` file are all failures. When adding a fixture, record below
exactly which self-test assertion consumes it.

| Fixture | Extraction rule it pins |
|---|---|
| `literalRoutes.fixture.ts` | Positive surface for `scanSourceFileForRoutes`: exactly one literal command registration (`vs-code-ai-helper.fixture.alpha`) with zero unresolved registrations, one internal literal `executeCommand` edge (`vs-code-ai-helper.beta`; the `setContext` call excluded), one dynamic dispatch (`someCommand`), one webview `onDidReceiveMessage` root, one throwing gate call (`draft.v1`), one literal command-property binding (`vs-code-ai-helper.gamma`), one provider-boundary call (`resolveRunnerForModel`; the type-position `typeof` reference must NOT count), and exactly two legacy `outputFile` destinations (one property assignment plus one shorthand; the interface member and the differently named `outputFilePath` must NOT count). |
| `computedRegistration.fixture.ts` | Negative fail-closed case: a `registerCommand` call whose command ID is computed (`prefix + ".computed"`) must be reported as an UNRESOLVED registration (plan §1.2's "unresolved computed command IDs" rule), never as a concrete route row. |
