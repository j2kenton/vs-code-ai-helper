# Verification known gaps

Deliberate, recorded gaps in the §11 verification surface for
".ensemble/2026-07-14_task_5 — Implement deferred workflow safety backlog".
Everything else in the plan's Verification Plan sequence is wired as a real
package script (see `scripts/workflowSuites.mjs` + `scripts/runWorkflowSuite.mjs`).

## Open: the control-plane server has no engine run host (leaks paid sandboxes)

`packages/ensemble-control-plane/src/serveV1.ts` composes the handler WITHOUT
`runs`, because an engine run host needs a `providerRunnerFor` and that is a
separate composition problem. The omission was cheap when task creation only
wrote a record. It no longer is.

`POST /v1/tasks` with the default `task-owned-ephemeral` lifecycle calls
`createSandbox()` against the user's provider, because that binding names no
sandbox and E2B offers no dashboard where one could be pre-created. With no run
host that sandbox can never be used or reclaimed: the task stays
`status: "creating"` forever, source acquisition never runs, and
`teardownTaskSandboxV1` — the only thing that honours `destroy-on-completion` —
has no production caller.

### How this is contained

- **Task-owned bindings are refused** when the handler has no `runs`
  (`422 sandboxBindingInvalid`, naming the reason). Allocating a paid resource
  that provably cannot be used is not a defensible default, so the store-only
  composition declines rather than billing the user for nothing.
- **`user-managed-persistent` is unaffected** and is the working path against
  `serveV1.ts`: it allocates nothing, and the user already owns the workspace.
- **`ENSEMBLE_ALLOW_UNMANAGED_SANDBOXES=1`** opts back in for integration
  smokes that exercise binding custody and reachability. The server logs a
  warning at boot, and every task created that way leaves a sandbox to destroy
  by hand.
- **A failure after allocation releases the sandbox** (`releaseCreatedSandbox`
  in `controlPlaneServerV1.ts`), covering both an unreachable binding and a
  failed `store.createTask` — the window where the id exists nowhere but the
  request's stack frame.

### What is NOT proven while this gap is open

That a task-owned sandbox is ever torn down on completion: no production caller
of `teardownTaskSandboxV1` exists, so `destroy-on-completion` is currently a
recorded intention rather than an enforced policy.

### Closing trigger

Close this gap when the run host is wired into `serveV1.ts`. At that point
`teardownTaskSandboxV1` gains its production caller, the refusal above can be
lifted, and the cleanup policy becomes real.

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
