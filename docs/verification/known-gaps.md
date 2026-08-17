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

## Closed: retroactive ticks cannot carry plan items whose text contains " — "

Recorded 2026-08-14, diagnosed while closing the workflow-repair follow-up
batch; fixed 2026-08-16 as part of the "workflow 3 continuation" plan's Part 4.
`parsePlanItemChecklistLine` (`src/utils/implementationChecklist.ts`) used to
split a `## Plan Item Checklist` entry into `<item> — <status> — <evidence>`
on the FIRST ` — ` boundary, so a plan item whose own text contained an
internal ` — ` was truncated at that em-dash: the next fragment failed the
`done` status check and the retroactive claim was silently dropped. On
`.ensemble/2026-08-11_task_1` this left exactly the 8 em-dash-bearing items
unticked across two rounds of verbatim retroactive entries while every
em-dash-free item ticked — a prior round misattributed the loss to paraphrased
text.

**Fix.** `parsePlanItemChecklistLine` now takes the plan of record's item keys
and tries the LONGEST prefix of the line — split on ` — `, most segments
first — that normalizes to a real plan item, shrinking one segment at a time
until one matches; the item's own embedded dash is absorbed into its text
instead of bleeding into the status field. A line whose item matches nothing
falls back to the original naive split, preserving `no-match` for a genuinely
unmatched/foreign/paraphrased claim (so the em-dash fix does not mask that
separate failure mode). Covered by
`src/test/implementationSummaryArtifact.test.ts` ("Part 4: asserted
completions land without a file diff") and mirrored in
`packages/ensemble-engine/src/checklistProgressV1.ts`
(`checklistParity.test.ts`).

Same batch also closed two related gaps in the same mechanism: a claim's
`done` status no longer requires the `<!-- ensemble:retroactive -->` marker
(bare prose is accepted, since models emit it unprompted in practice), and a
round may claim an entire plan Part in one line (`Part N — done this round
(X/Y), evidence: ...`) rather than enumerating every item.

## Closed: a prose-only Plan Item Checklist claim (no checkbox echo) was rejected before the merge could ever run

Discovered and fixed 2026-08-16, same "workflow 3 continuation" plan, Part 8
(the end-to-end self-recovery proof). Every item above closed the MERGE
engine's handling of prose claims and verified it with direct calls to
`mergeChecklistProgressV1` — but nothing had verified those claims could
reach the merge engine in the first place through the real
round-completion pipeline (`reviewActions.ts`).

`describeImplementationSummaryShapeIssue`'s `checklistEchoPresent` check
only recognized a `- [x]`/`- [ ]` checkbox echo
(`echoesPlanChecklist`/`collectChecklistItemKeysV1`) or the
`<!-- ensemble:no-checklist-change -->` marker as satisfying the response
shape contract. Round 073 of "workflow 3" itself — the fixture this same
plan's Part 4 uses as its canonical example — reported ONLY a prose
`## Plan Item Checklist` claim with no checkbox echo at all. Replaying that
exact shape through `describeImplementationSummaryShapeIssue` (not just
`mergeChecklistProgressV1` directly) showed it was rejected as "missing …
the plan's implementation checklist, echoed with updated checkbox state" —
so in production this round's report would have been refused before
`mergeChecklistProgressV1` ever ran, and its real, verified completions
would never have landed. Every existing Part 4 test called the merge
function directly, which bypasses the shape gate entirely, so this gap had
no test coverage pointing at it.

**Fix.** `hasPlanItemChecklistClaimV1` (`src/utils/implementationChecklist.ts`)
recognizes a syntactically well-formed claim — item-level or PART-level,
under the response's own `## Plan Item Checklist` section — as satisfying
the echo requirement on its own, REGARDLESS of whether the claim goes on to
resolve against a real plan item; resolution is deliberately left to
`mergeChecklistProgressV1`, so a claim that fails to match still reaches the
merge and is reported/latched as `checklistClaimedButUnmerged` rather than
causing the whole round to be refused as a malformed summary. Wired into
`describeImplementationSummaryShapeIssue` via
`src/utils/implementationArtifactResolver.ts`. Covered end-to-end (through
the real `runHarnessed` round-completion pipeline, not a direct merge call)
by `src/test/deferredRoundRecovery.test.ts` ("a prose-only Plan Item
Checklist claim reaches advance-eligibility with zero file changes (Part
4/8, end to end)") and by a shape-gate-only probe in
`src/test/implementationSummaryArtifact.test.ts` ("a prose-only Plan Item
Checklist claim (no checkbox echo at all) satisfies the shape gate's echo
requirement on its own").

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

## Deferred: Copilot `desc` (Draft with AI) live-reproduction pending

Recorded 2026-08-16, workflow 3 continuation, fifth item. On
`revamp-1/.ensemble/2026-08-15_task_1`, Draft with AI failed with
`contentSchemaMismatch` on GitHub Copilot for BOTH the "auto" model and the
concrete "gpt-5.6-terra" model. The envelope itself parsed cleanly
(`version`, `correlation`, `kind: "completed"` all valid); only
`decodeCompletedContentV1(value.content)` rejected the content — a genuine
provider-response decode failure, distinct from the malformed-response
preservation gap this same batch closed in Part 1.

**Decision: DEFER the live reproduction; discharged instead by code
comparison, a hardened prompt, and a reconstructed decode fixture** (the
plan's explicitly sanctioned fallback route, Part 7 step 2). No Copilot LM
API entitlement is reachable from the environment that implemented this fix
(a CLI coding agent, not a running VS Code extension host), and the raw
rejected payload from the 2026-08-15 incident lives in a different
repository's task history (`revamp-1`), not this one — there is no local
spool or run record to reconstruct it from.

**What was verified instead, by reading code, not by guessing:**
`draft.v1` (`src/actions/rows/draftRowV1.ts`) and `generatePlan.v1`
(`src/actions/rows/generatePlanRowV1.ts`) build a byte-identical AI result
contract for the same `completedContentType` (`buildAiResultContractPromptV1`
— same `permittedResultKinds`, same content-shape hint), and
`generatePlan.v1` succeeds on the same provider/model where `draft.v1` fails.
The one substantive difference in what the model is told is
`draft-task-with-ai.md`'s closing instruction, which (prior to this fix) read
"ask them instead of guessing" with no pointer to the structured `"questions"`
result kind the contract fragment defines — inviting a model to try to
surface a clarifying question inside its `"completed"` answer instead of
switching envelope kind, which is exactly the shape that trips
`decodeCompletedContentV1`'s unknown-field / missing-field checks.

**Fix applied (prompt-induced route).** `resources/prompts/draft-task-with-ai.md`
now explicitly names the `"questions"` result kind and states that the
completed content must contain only the goal line and the three required
subsections — closing the ambiguity between the action-specific prompt's
informal "ask them" wording and the contract fragment's mechanical
definition of how to do so.

**Discharge evidence.** `src/test/aiResultEnvelope.test.ts`
("reconstructed fixture for the 2026-08-15 Copilot draft.v1 desc failure")
exercises the two most likely failure shapes given the finding above — an
extra field riding alongside `markdown`, and a missing `markdown` field — and
names the exact failing check for each (`markdown-artifact.v1 has unknown
field: ...` / `markdown-artifact.v1 is missing a string "markdown" field`).
This is a reconstructed fixture, not a proof that either shape is the
literal payload Copilot returned.

### What is NOT proven while this gap is open

That the reconstructed fixture matches the actual bytes Copilot returned on
2026-08-15, or that the prompt hardening above is sufficient by itself to
prevent a recurrence. The `impl` failure on the same task
(`providerModeUnavailable` reported for an invoked-and-failed chain) is a
separate, already-diagnosed defect, fixed in this batch's Part 2
(`candidatesExhausted` vs. `providerModeUnavailable`), not part of this gap.

### Closing trigger

Close this gap when Draft with AI is reproduced against a live Copilot
entitlement (either model) and the preserved raw response (now durably
spooled — see Part 1's `settleEnvelope` preservation fix) is compared against
the reconstructed fixtures above.

## Accepted: GitHub Copilot's "auto" model no longer leads the model list

Recorded 2026-08-16, workflow 3 continuation, sixth item (Part 7 step 4's
flagged decision). **DECISION: reorder only; do not add an auto→concrete
malformed-retry.**

`getAvailableCopilotModels` (`src/utils/modelSelection.ts`) used to move an
"auto" model to the FRONT of the list ("so it reads as the default choice").
Because "auto" delegates to whichever concrete model VS Code's Copilot
extension picks for the request, it is the choice least likely to honour
Ensemble's output contract — and it was the model in play on the
`contentSchemaMismatch` above. `getAvailableCopilotModels` now moves "auto"
to the END of the list instead (concrete, exercised models lead), and
`normalizeCopilotModelName` labels it `"Auto (provider-chosen)"` in the
settings picker rather than removing it — a user who wants provider-chosen
routing can still select it deliberately.

**The other half of the sixth item — advancing once from "auto" to a
concrete Copilot model on a `contentSchemaMismatch`, using the
`malformedResultPreFallback` mechanism — was NOT built.** The plan flagged
both halves as an explicit, droppable product decision ("either half can be
dropped without affecting other parts"). Two reasons this half was dropped:

1. **Field evidence undercuts it.** The 2026-08-15 incident this fix
   responds to failed identically on "auto" AND on the concrete
   "gpt-5.6-terra" model. A model-switch retry would not have prevented that
   specific incident — the cause is prompt-induced (see the gap above), not
   auto-model-specific.
2. **Real architectural cost for unproven benefit.** The existing
   malformed-advance mechanism (`taskActionCoordinatorV1.ts`, `willAdvanceV1`)
   already advances to the next RANKED candidate from
   `rankedStageChainStoredIdsV1` (`runnerRegistry.ts`) — the stage's
   configured backups, resolved synchronously. Injecting a synthetic
   "first concrete Copilot model" candidate when none is configured would
   require threading Copilot's async `vscode.lm.selectChatModels()`
   discovery into that synchronous ranked-chain build, a genuine (not
   cosmetic) change to selection's candidate-resolution contract, for a
   remedy the evidence above suggests would not have helped the one
   incident motivating it.

### What is NOT proven while this gap is open

That a `contentSchemaMismatch` on Copilot "auto" with no backup configured
ever gets a same-provider retry before the operation reports failure. Today
it behaves exactly as any other unconfigured-backup stage does: the
malformed result is reported once the malformed-retry budget or ranked
chain is exhausted.

### Closing trigger

Revisit if a future incident shows a `contentSchemaMismatch` that is
genuinely `"auto"`-specific (a concrete Copilot model succeeding where
`"auto"` fails under the same prompt) — that would be the evidence this
decision currently lacks.

## Accepted (out of this plan's scope, recorded per review request): `ensemble.resilience.inactivityTimeoutMinutes` default changed 15 → 0

Flagged as a non-blocking, unrecorded deviation by the last several reviews
of this task ("workflow 3 continuation"): `package.json` and
`src/config/settings.ts`'s `RESILIENCE_DEFAULTS.inactivityTimeoutMinutes`
changed the CLI-run inactivity watchdog's default from `15` to `0` (off) in
the working tree, and no part of this plan's eight parts names that setting.
Recording it here — rather than reverting it blind or leaving it
undocumented — is the review's own suggested resolution route ("record or
split... before publish").

**The change is not accidental scope creep; it is evidence-driven and
already fully justified where it lives in code** (`src/config/settings.ts`,
the `RESILIENCE_DEFAULTS` comment and the `readInactivityTimeoutMinutes`
docstring, plus the `package.json` setting description, all three updated
together): the watchdog measures output silence and infers a wedged
process, but an agentic CLI reading or editing a large file legitimately
produces no output for long stretches while working correctly. Shipped
enabled at 15 minutes on 2026-08-16, it fired 6 times in one afternoon —
every firing killed a healthy round that had simply gone quiet while
editing a 7,865-line file, and it caught zero genuinely wedged processes.
For scale, the flat 60-minute wall-clock cap (which this watchdog is
distinct from, and which remains unconditionally active regardless of this
setting) fired only 9 times across 3,320 runs in the same window. A false
positive here destroys a round's edits (quarantined, never banked) and
burns recovery budget; a false negative costs at most the gap between this
value and the wall clock. That asymmetry is why the default is now biased
hard against firing, rather than a value tuned to fire often.

### What is NOT proven while this gap is open

That this task's own review/publish gate has explicitly signed off on
shipping a changed default for an existing, already-released setting,
distinct from evaluating whether the change itself is well-reasoned (it
is, per the evidence above). No part of the eight-part plan lists this
setting, so nothing in this task's own acceptance criteria covers it.

### Closing trigger

Close (or replace with a decision note) once a human reviewing this task
for publish either explicitly accepts shipping the new default of `0` as
part of this task, or splits this specific change into its own separately
reviewed commit rather than folding it into this task's diff.

## Full-sequence run record

The most recent full verification-sequence run is recorded in
[test-run-2026-07-18.md](test-run-2026-07-18.md); per-phase checkpoints for this
task ran `pnpm check-types && pnpm run lint && pnpm test:unit` green at every
phase commit.
