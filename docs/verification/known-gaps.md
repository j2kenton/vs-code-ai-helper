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

## Deferred: sealed runs cannot maintain plan progress (checklist echo cannot travel with receipts)

Recorded 2026-08-14, from the 2026-08-10/11 workflow-repair follow-up batch
(item 6). **Decision: DEFER — do not paper over it.**

A sealed implementation run (`TwoPhaseEditResultV1`) returns verified edit
receipts, not prose, so the implementer's checklist echo has no channel to
travel with the receipts: the round's checklist state is never recorded, and
the `checklistProgressUnreliable` latch is the operating mitigation. Closing
the gap properly needs a text channel added to `TwoPhaseEditResultV1` so the
echo can travel with the receipts — a deliberate change to the digest-bound
`SealedPlanRecordV1` protocol, and its own piece of work (digest versioning,
receipt shape migration, and the merge path's treatment of a second
checklist source).

### What is NOT done while this gap is open

Inferring ticks from diffs. Ticks are monotonic and completion-only; having a
model guess which boxes a diff completed reintroduces the false-"done"
failure the 2026-08-10/11 repair removed. Until the protocol change lands,
a sealed round latches `checklistProgressUnreliable`, the completeness gate
stands down, and the human reconciles by ticking the missed items and running
**Ensemble: Mark Plan Checklist Reconciled**.

### Closing trigger

Close this gap when `TwoPhaseEditResultV1` gains a first-class text channel
for the checklist echo, versioned as part of the `SealedPlanRecordV1` digest
contract — not bolted on as an inferred field.

## Deferred: lastMessageFile plumbing removed; the boolean gate stays

Recorded 2026-08-14 (same batch, item 7). **Decision: DELETE the plumbing,
keep the fail-closed gate.** `codex-cli` was the only provider that ever set
`usesLastMessageFile`, and it moved to stdout capture via its `--json` event
stream on 2026-08-11. The plumbing behind the flag — the `lastMessageFile`
parameter of `buildArgs`, the file-read branch in `normalizeCliOutput`, and
the temp-file creation/cleanup in the legacy runner — was exercised only by a
synthetic test definition, so the first real temp-file provider would have
run production code that had never executed. It has been removed. What stays,
untouched, is the contract surface: the `usesLastMessageFile` boolean on
`CliProviderDefinition` and `cliProviderSupportsV1StdoutCapture`, which fails
closed (`providerModeUnavailable`) for any future provider that sets the
flag. Such a provider must reintroduce the plumbing deliberately, with real
coverage, rather than inherit never-executed code. The reasoning also lives
at the flag's declaration in `src/runners/providers.ts`.

## Open: retroactive ticks cannot carry plan items whose text contains " — "

Recorded 2026-08-14, diagnosed while closing the workflow-repair follow-up
batch. `parsePlanItemChecklistLine` (`src/utils/implementationChecklist.ts`)
splits a `## Plan Item Checklist` entry into `<item> — <status> — <evidence>`
on the FIRST ` — ` boundaries, so a plan item whose own text contains an
internal ` — ` is truncated at that em-dash: the next fragment fails the
`done` status check and the retroactive claim is silently dropped. On
`.ensemble/2026-08-11_task_1` this left exactly the 8 em-dash-bearing items
unticked across two rounds of verbatim retroactive entries while every
em-dash-free item ticked — the previous round misattributed the loss to
paraphrased text. Fallback that works today: manual reconciliation (tick the
items in `plan-final.md` directly; ticks are monotonic and completion-only).

Not fixed here because the checklist merge is explicitly out of scope for
that task's plan, and per the recorded design decision this is a live-use
signal for the "tasks blocked by how a document was read" trigger — record
it, don't bolt on another parsing heuristic. A fix would make the status
field, not the first em-dash, the split anchor (e.g. split on the LAST
` — done/deferred/not reached` occurrence or on the retroactive marker), or —
per the design note's preference — record the fact upstream instead of
parsing it out of prose. This fails in the safe direction only: items stay
unticked, the completeness gate holds the task open, nothing is advanced.

## Accepted (revised contract): quota/entitlement ledger keys on a user-declared account label, not auto-detected credential context

Recorded 2026-08-16, from the workflow-robustness batch (`.ensemble/2026-08-13_task_1`
+ jester-run items 3–4), Part 5 ("Parse quota reset times; branch the remedy on
magnitude; persist it").

**DECISION — 2026-08-16, Jonathan Kenton (plan owner): OPTION 1 ACCEPTED.**
The shipped user-declared-label fallback is hereby the revised contract for
acceptance criterion 5. Two credentials behind one provider id share
quota/entitlement state unless the operator declares which is active via
`ensemble.providerAccountLabels`. This is an explicit product decision, not an
inferred one, and it supersedes criterion 5's literal "actual
account/credential context" wording.

**Why accepted:** the investigation (re-confirmed twice, detailed below) shows
automatic credential detection is not reachable from inside this task — no
integrated provider CLI exposes which login answered an invocation, and every
CLI is spawned from one extension-host process under one environment, so no
environment or config-path signal can separate two credentials without the
operator reconfiguring between runs. That is not meaningfully different from
declaring a label. Holding 51 of 52 completed steps open against work that
depends on a third-party CLI change was judged the worse outcome.

**The obligation this creates — it is real, not a formality.** Anyone running
two credentials behind one provider MUST set `ensemble.providerAccountLabels`,
or one credential's quota/entitlement observation will be attributed to both.
This is not hypothetical: on 2026-08-15 this workspace ran `claude-cli` on a
personal subscription alongside `devpass-cli` serving `claude-sonnet-5` — two
credentials, one of which hit a session limit. That is exactly the
cross-contamination case. Treat the label as required configuration whenever a
provider has more than one account, not as an optional refinement.

**Scope of this decision:** it approves the reduction for acceptance criterion
5 only. It does not close the underlying gap — see "Closing trigger" below,
which remains open should a provider ever expose an automatic signal.

An earlier version of this entry stated "Decision: DEFER" — that was the
implementation unilaterally recording its own preferred outcome, which a review
of this batch correctly rejected: an implementation round cannot approve a
reduction of its own plan's acceptance criterion. The finding and the two
options it presented are retained below as the record behind this decision.

The plan's acceptance criterion 5 calls for the persistent quota/entitlement
outage record to be keyed on "provider + actual account/credential context +
model" so that two credentials sharing one CLI provider (e.g. two `claude-cli`
logins in separate OS profiles, or a personal vs. work subscription) never
cross-contaminate each other's quota or entitlement state. Re-confirmed during
this round's investigation: no CLI provider integrated today
(`src/runners/providers.ts`) exposes *which* logged-in credential answered a
given invocation (no `whoami`-style structured field, no account id in normal
output), and because Ensemble always spawns provider CLIs from one VS Code
extension host process under one OS environment (`sanitizedCliEnv()` /
`def.buildEnv?.(model)` in `src/runners/cliAgentRunner.ts`), even an
environment-variable or config-directory-path signal (e.g. a per-profile
`CLAUDE_CONFIG_DIR`) cannot distinguish two credentials unless the user
manually reconfigures the environment between runs — which is not
meaningfully different from declaring a label directly. Building "actual
credential context" detection is therefore not a bug fix reachable inside this
task; it would be new per-provider integration work with no existing hook to
build it against, contingent on a provider CLI someday exposing this.

### The two options that were presented — for the record

1. **Accept the shipped fallback as the revised contract for acceptance
   criterion 5.** Two credentials behind the same provider id share
   quota/entitlement state unless the user declares which is active via
   `ensemble.providerAccountLabels` (see below) — an explicit, recorded
   product decision, not an inferred one. ← **CHOSEN, 2026-08-16 (see the
   decision at the top of this section).**
2. **Reject the fallback and keep acceptance criterion 5 open** until a
   provider CLI exposes an automatic signal (see "Closing trigger" below),
   accepting that Part 5 stays incomplete against the plan as written.
   *Not chosen.*

With option 1 accepted, Part 5 is complete against the revised criterion. The
gap entry stays open as documentation of the residual limitation and its
closing trigger, not as a blocker.

### What ships instead

`resolveQuotaAccountKeyV1` (`src/config/settings.ts:725-729`) keys on the
resolved `ProviderAccountId` (`providerAccountIdForModelId`), refined by an
optional user-declared label from the `ensemble.providerAccountLabels`
setting (`src/config/settings.ts:674-712`, exposed at `package.json:856-860`).
Unset — the default — reproduces exactly the bare-`ProviderAccountId` keying
that predates this batch. A user who runs two credentials behind the same
provider id declares which one is active; the quota ledger, task-park
identity, and entitlement classification (`src/utils/quota.ts`,
`src/runners/runnerRegistry.ts`) then key on `providerId + accountLabel +
modelId` instead of silently sharing state.

### What is NOT proven while this gap is open

That two credentials behind the same provider id are ever distinguished
*automatically*. Without a user-declared label, a quota/entitlement
observation for one credential is attributed to both. This degrades to
today's pre-batch behavior (shared state per provider id) rather than
introducing a new failure mode.

### Closing trigger

Close this gap if a provider integration later exposes a way to identify the
answering credential (a CLI flag, an account field in structured output, a
config file read) — wire that into `providerAccountIdForModelId` or a
provider-specific probe feeding `resolveQuotaAccountKeyV1`, rather than adding
a second parallel identity mechanism.

## Full-sequence run record

The most recent full verification-sequence run is recorded in
[test-run-2026-07-18.md](test-run-2026-07-18.md); per-phase checkpoints for this
task ran `pnpm check-types && pnpm run lint && pnpm test:unit` green at every
phase commit.
