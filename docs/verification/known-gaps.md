# Verification known gaps

Deliberate, recorded gaps in the §11 verification surface for
".ensemble/2026-07-14_task_5 — Implement deferred workflow safety backlog".
Everything else in the plan's Verification Plan sequence is wired as a real
package script (see `scripts/workflowSuites.mjs` + `scripts/runWorkflowSuite.mjs`).

## Deferred: multi-version VS Code host-download matrix

The following scripts from the plan's Verification Plan are **intentionally not
implemented** in this round:

- `verify:lm-host-acquisition`
- `test:vscode-lm:1.93.0`
- `test:vscode-lm:1.100.0`
- `test:vscode-lm:1.110.0`

They specify downloading three pinned VS Code builds via `@vscode/test-electron`
and running the LM-boundary host suite inside each real host, proving that
`vscodeLmCompat.ts` behaves correctly against the actual 1.93 API floor, the
1.100 tool-API floor, and a current host.

### Why deferred

- The pinned-host matrix triples host-download cost (~300 MB+ per version) and
  runs Electron three times per invocation; it is CI infrastructure, not a
  local gate, and there is no CI pipeline in this repository yet.
- The compile-time half of the guarantee is already enforced locally:
  `verify:vscode-1.93-compat` type-checks the production tree against pinned
  `@types/vscode` 1.93 **and** runs the `vscode-lm-compat` unit suite, and
  `verify:vscode-lm-boundary` (AST fence) keeps every raw
  `vscode.lm`/`LanguageModel*` access inside `src/services/vscodeLmCompat.ts`.
- The runtime half is covered at one version: `pnpm run test:host` runs the
  host suite against a single downloaded VS Code build.

### What is NOT proven while this gap is open

- That the runtime probe paths in `vscodeLmCompat.ts` (tool API absent on an
  actual 1.93 host; present on 1.100+) behave as modeled — unit tests exercise
  them only against the `test-stubs/vscode` stub (`version: "1.100.0"`).
- That future host API drift in a newer VS Code build is caught before release.

### Closing trigger

Close this gap (implement the three `test:vscode-lm:*` scripts plus the
`verify:lm-host-acquisition` wrapper, and add them to the Verification Plan
sequence) when **either**:

1. a CI pipeline is introduced for this repository (the matrix belongs there), or
2. `vscodeLmCompat.ts` gains a new host-API dependency or raises either version
   floor (1.93 base / 1.100 tool API) — at that point single-version host
   coverage is no longer honest evidence for the compat contract.

## Full-sequence run record

The most recent full verification-sequence run is recorded in
[test-run-2026-07-18.md](test-run-2026-07-18.md); per-phase checkpoints for this
task ran `pnpm check-types && pnpm run lint && pnpm test:unit` green at every
phase commit.
