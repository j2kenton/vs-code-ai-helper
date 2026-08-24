# Notification audit — remaining `vscode.window.showWarningMessage` call sites

Part 11 of "Actionable Hand-offs: one contract, nine surfaces"
(`resources/prompts` unaffected; this file is the artifact evidence the
plan asks for under "Audit remaining raw `vscode.window.showWarningMessage`
call sites in production `src`, classifying each as a decision ... or a
notification").

## Method

`grep -rn "vscode.window.showWarningMessage" src --include=*.ts` excluding
`src/test/**`, read at the call site plus its caller, classified by:

1. **Decision vs. notification**, per the plan's own rule: "if the message
   has buttons that change what happens next, it is a decision, not a
   notification." Every remaining production call site below has
   outcome-changing buttons, so every one is a decision by that rule — the
   codebase has no bare informational `showWarningMessage` left with no
   acted-upon outcome.
2. Whether migrating that decision to a `WorkflowDecisionV1` record (the
   mechanism this task's "The worse case" section built for the two dialogs
   already migrated in Part 9, `reviewActions.ts`'s
   `preImplementationRouting` and `sterileRoundRouting`) is a safe, direct
   swap, or requires an architecture change beyond this round's scope.

## Why "is a decision" is not the same as "should migrate"

The two already-migrated dialogs share a specific shape that makes the swap
safe: they are **advisory and fall through regardless of the answer**. The
calling code does not `await` the decision to learn what to do next — it
posts the record (fire-and-forget, unawaited) and the round it was already
about to run continues exactly as an unanswered notification used to fall
through. `postWorkflowDecisionV1` is built for exactly this: it persists a
record and returns immediately; nothing in the mechanism can block a caller
on a human's answer, by design (that is the hang class Part 9 removed).

Every remaining call site below is the opposite shape: the calling code
**awaits the modal's return value and branches control flow on it** — which
branch runs next, whether a file gets committed, whether a folder gets
deleted, whether the round should keep iterating. Swapping one of these for
a fire-and-forget decision record would not preserve behavior; it would
either (a) silently proceed as if the decision defaulted to one branch
before the user ever answers, or (b) require redesigning the surrounding
function into a pause/resume shape (post the decision, return, and give the
decision's resolution its own resumption path) — a real architectural
change per call site, not a dialog swap. That is the "decision-migration set
much larger than expected" case the plan's own escape valve anticipates;
per the plan, that escape valve is for adding further ordered parts, not for
forcing the redesign through in this round. None of the sites below were
migrated for this reason; each is annotated with which sub-reason applies.

A second, independent disqualifier: `postWorkflowDecisionV1` requires a
`ChatTarget` (`taskCanonicalId` + `taskFolderPath` + `stage` —
`workflowDecisionDispatchV1.ts`), because the record is rendered inside one
task's Chat With AI panel. A call site with no single associated task
(workspace/extension-level dialogs) cannot be expressed as a
`WorkflowDecisionV1` without inventing an untargeted decision concept the
type does not support today.

## Classification

Legend: **Blocking** = caller awaits the return value and branches on it.
**Task-scoped** = a single task backs the dialog (candidate shape for
`WorkflowDecisionV1` if the blocking issue were solved). **Sync-triggered**
= shown synchronously in direct response to the user's own click on the
command that raises it, not by unattended automation.

| # | Site | Trigger | Blocking | Task-scoped | Sync-triggered | Verdict |
|---|---|---|---|---|---|---|
| 1 | `config/settings.ts:327` | Extension activation — workspace/user setting conflict | Yes | No (workspace-wide) | No (activation) | Out of domain: no task, no `ChatTarget`. Settings hygiene, not a workflow hand-off. |
| 2 | `config/settings.ts:877` | User toggles "Automatically implement" on in Settings | Yes | No | Yes | Direct user confirmation of a setting change; not task-scoped. |
| 3 | `extension.ts:991` | Extension activation — interrupted revert recovery | Yes | Arguably (one file, not necessarily one task) | No (activation) | Crash-recovery gate, unrelated to task-stage progression. |
| 4 | `utils/aiConsent.ts:50` | First AI action this session, before any provider launch | Yes | No (workspace-wide, one-time per disclaimer version) | Yes | Legal/compliance consent gate, not a recommendation — different category entirely. |
| 5 | `views/settingsView.ts:619` | Opening the AI Models settings panel | Yes | No (multi-task cleanup) | Yes | Settings hygiene; spans arbitrarily many tasks, not one. |
| 6 | `views/chatView.ts:624` | User clicks "Reset Chat History" | Yes | Yes | Yes | Direct destructive-action confirm on the exact button just clicked. |
| 7 | `commands/commitAndPushTask.ts:1743` | Publish flow, checks failed | Yes | Yes | Yes | Branches Publish Anyway / Fix with AI; blocking control flow. |
| 8 | `commands/commitAndPushTask.ts:1921` | Publish flow, staged+unstaged changes present | Yes | Yes | Yes | Same. |
| 9 | `commands/commitAndPushTask.ts:1971` | Publish flow, only run-artifact changes present | Yes | Yes | Yes | Same. |
| 10 | `commands/commitAndPushTask.ts:2137` | User clicks "Commit & Push" | Yes | Yes | Yes | Direct confirm on the exact action just clicked. |
| 11 | `commands/viewStageChanges.ts:122` | User clicks Revert/Redo on a stage change | Yes | Yes | Yes | Direct confirm on the exact action just clicked. |
| 12 | `commands/runLintingFixes.ts:430` | Publish-stage AI fix run, non-git workspace | Yes | Yes | Yes (invoked from a user-initiated fix run) | Safety confirm before an AI run that can edit files with no git history to revert. |
| 13 | `commands/runLintingFixes.ts:459` | Same flow, unrelated uncommitted changes present | Yes | Yes | Yes | Same. |
| 14 | `commands/reviewActions.ts:6384` | Implementation run, non-git workspace | Yes | Yes | Yes | Same pattern as #12, for the Implementation runner. |
| 15 | `commands/reviewActions.ts:6407` | Implementation run, unrelated uncommitted changes | Yes | Yes | Yes | Same pattern as #13. |
| 16 | `commands/reviewActions.ts:9050` | User clicks "Run Release" | Yes | No (repo/package-level, not task) | Yes | Direct confirm on the exact dangerous action just clicked (runs a real publish script). |
| 17 | `commands/taskCreationRecovery.ts:152` | User clicks "Retry" on a failed task creation | Yes | Yes | Yes | Direct confirm on the exact action just clicked. |
| 18 | `commands/taskCreationRecovery.ts:428` | User clicks "Adopt and Retry" | Yes | Yes | Yes | Same. |
| 19 | `commands/taskCreationRecovery.ts:721` | User clicks "Delete" on an incomplete task folder | Yes | Yes | Yes | Destructive; direct confirm on the exact action just clicked. |
| 20 | `runners/copilotImplementationRunner.ts:685` (fallback raw call now at `:748`) | Mid-automation — implementation round hits its tool-call round limit | Yes | Yes | **No** — can fire unattended, mid-run | **Partially migrated** (second/third addendum below): awaits `implementationRoundLimitReached` via `awaitWorkflowDecisionAnswerV1` when `taskFolderUri`/`stage` are available (threaded from `runnerRegistry.ts:951`); a caller with no task still hits the ORIGINAL raw `vscode.window.showWarningMessage` at line 748 — that line is a genuine, counted, remaining production call site, not a closed item. |
| 21 | `utils/globalAssistantActions.ts:1067` | Global assistant chat turn proposes a consequential, possibly multi-task action | Yes | No (can span many tasks at once) | Yes (inside the same chat turn the user just requested) | Blocking within one interactive chat turn; also not single-task-scoped. |
| 22 | `utils/promptSizeGuard.ts:72` | Any AI run about to send a prompt over the confirm threshold | Yes | Yes (indirectly, via caller) | Mostly (user-initiated command), but reachable from automated rounds too | Already carries What (size)/Why (quota)/action (Proceed / Proceed and don't ask again) — meets this task's five-field bar in miniature. Latent same-class hang risk as the pre-Part-9 dialogs when reached from an unattended chain with the warning still enabled, but that risk is pre-existing and orthogonal to THIS task's fix (evidence-without-guidance); not touched here to avoid scope creep into a separate defect. |
| 23 | `utils/quota.ts:513` | Mid-automation — a run fails with quota exhausted | Yes | Yes | **No** — can fire unattended, mid-run | **Migrated** (second addendum below): now awaits `quotaExhaustedDuringRun` via `awaitWorkflowDecisionAnswerV1`. `handleQuotaFailure` has zero production callers, so this is behaviorally inert today but removes the raw call site. |

## Summary

> **Current state (see "Third addendum" below): 22 sites remain, not 23.**
> `quota.ts:513` was fully migrated (that function has zero production
> callers, so this is a clean removal). `copilotImplementationRunner.ts:685`
> was only PARTIALLY migrated: its task-scoped path now awaits a decision
> record, but its no-task fallback branch (line 748) is still a raw
> `vscode.window.showWarningMessage` call and remains counted below — a
> follow-up review caught the "Second addendum" undercounting this as fully
> resolved (it claimed 21) when the honest count is 22. The counts and
> reasoning in the body below are preserved as the historical record of the
> original audit; do not read them as the current state.

- **23 production call sites** remain (`reviewActions.ts`'s two already-
  migrated dialogs, `preImplementationRouting` and `sterileRoundRouting`,
  are excluded — they are the Part 9 baseline this audit measures against).
- **0 are bare notifications** — every one has outcome-changing buttons, so
  every one is nominally "a decision" per the plan's stated rule.
- **19 are synchronous, blocking confirmations the calling code awaits to
  choose its next branch**, triggered directly by the user's own click on
  the action being confirmed (or, for #1/#3, by extension activation, but
  still gate no task's stage progression). These are not migrated: they are
  not the "buried in an unattended notification stack" failure mode this
  task fixes, several are not task-scoped at all (`WorkflowDecisionV1`
  requires a `ChatTarget`), and converting a blocking confirm into a
  fire-and-forget record would either silently change which branch runs or
  require a genuine control-flow redesign per site.
- **2 (`copilotImplementationRunner.ts:685`, `quota.ts:513`) are genuine
  automation-surfaced decisions** — they can fire unattended, mid-run,
  exactly the shape the two already-migrated dialogs were. They are **not**
  migrated this round because, unlike the two already-migrated dialogs,
  the calling loop's next action depends on the answer (it is not advisory/
  fall-through) — migrating them safely needs the surrounding round loop
  redesigned around posting a decision and resuming from its resolution,
  which is materially more than a dialog swap. This is exactly the case the
  plan's own escape valve names ("If the audit reveals a decision-migration
  set much larger than expected, add further ordered parts to this task
  rather than widening this round") — recorded here as the honest finding,
  without spinning up a new part in this round.
- **1 (`promptSizeGuard.ts:72`)** already meets most of this task's own
  bar (states the size, the reason, the choice, and an opt-out) and is left
  as-is; its own latent automation-hang risk is a separate, pre-existing
  concern outside this task's scope.

## What this means for Part 11's migration checklist item

"Migrate every call site classified as a decision to a `WorkflowDecisionV1`
record" is **not fully executed** by this audit: every site is nominally a
decision. Of the 23 originally found, `quota.ts:513` is now fully migrated
and excluded from the count; `copilotImplementationRunner.ts:685`'s live,
task-scoped path is migrated but its no-task fallback branch (line 748) is
not. The remaining **22** (the 19 direct-confirm sites, the 2 non-task-scoped
sites, and the site #20 fallback branch) are either out of the
`WorkflowDecisionV1` task-scoped shape entirely, or are direct
user-confirmation gates that are not the failure mode this task exists to
fix. This is recorded as a deferred item with reasoning (Batch F, Part 12),
not silently marked done. See the Third addendum below for the corrected
count and why the Second addendum's "21" was wrong.

The prior review of this task (commit `2f1c0fa5...`) disputed the reasoning
above: the plan's own rule ("buttons that change what happens next" = a
decision) is categorical, and reclassifying 19 of 23 sites as "not the
failure mode" is a judgment call the plan did not authorize on its own. That
objection is fair on the plan's literal text. The addendum below records what
a follow-up round actually inspected to test whether full migration, or the
plan's own escape valve ("add further ordered parts"), is achievable — and
why neither was executed unilaterally this round either.

## Addendum (follow-up round, same date): what would actually be required

**`postWorkflowDecisionV1` has no "await the answer" primitive, by design.**
It posts a record and returns immediately (`workflowDecisionDispatchV1.ts`);
`WorkflowDecisionStoreV1` does expose an `onDidChange` event and a `resolve`
method, so a promise-based "wait for this decision to settle" helper *could*
be built on top of it without redesigning the surrounding control flow — for
a caller that already `await`s a modal today, swapping the wait source from
an OS modal to a chat-panel answer does not by itself require persisting or
reconstructing state, because the awaiting call stays alive in-process
exactly as it does today.

That reframes the two automation-surfaced sites as narrower than initially
assessed, but not free:

- **`utils/quota.ts:513` (`handleQuotaFailure`) has zero callers anywhere in
  `src`** (repo-wide grep, confirmed again this round). The function is
  dead code today. Migrating its dialog would satisfy the letter of "no
  production message with outcome-changing buttons remains on raw
  `showWarningMessage`" without touching any live behavior — which is exactly
  the kind of hollow, letter-only fix this task's own "advertised envelopes"
  section (Part 3) exists to warn against, applied to a fix instead of a
  feature. Left unmigrated rather than closed on a technicality; noted here
  as a fact for whoever picks this up, since it changes the risk calculus
  (this one specific site could be migrated freely — no live path exercises
  it either way).
- **`runners/copilotImplementationRunner.ts:685` is live** (the round-limit
  gate inside `runImplementationWithCopilot`, the extension's primary
  implementation loop) **but has no `ChatTarget` to post against.** Its
  signature (`copilotImplementationRunner.ts:561-571`) carries only
  `prompt`/`modelId`/`workspaceUri`/`token`/progress callbacks — no
  `taskFolderUri`, `taskCanonicalId`, or `stage`. Its one production caller,
  `runnerRegistry.ts:951-960`, already holds `options.taskFolderUri` and
  `options.stage` (both are threaded into the sibling `runImplementationWithCli`
  call four lines above) but does not pass them into the Copilot runner. The
  concrete, bounded next step is: add `taskFolderUri`/`taskCanonicalId`/`stage`
  to `runImplementationWithCopilot`'s options, thread them from
  `runnerRegistry.ts:951`, update both call sites in
  `copilotImplementationRunnerHostCapability.test.ts`, then build and wire an
  `awaitWorkflowDecisionAnswerV1`-style helper. That is a real, scoped,
  testable slice — but it is a signature change to the most-executed runtime
  path in the extension, changes behavior in a place with no live E2E
  coverage in this environment (hitting a genuine round-limit requires a real
  multi-round Copilot session), and was not attempted this round for that
  reason: the risk of a subtle regression in that path, shipped unverified,
  outweighs closing one checklist line.

**Why the 19 direct-confirm sites were still not migrated:** independent of
the above, converting a synchronous "are you sure?" modal shown in direct
response to the user's own click (delete a task folder, commit & push, reset
chat history) into an asynchronous chat-panel record changes a working
interaction pattern across 19 separate live user flows. That is a
product-level UX change with real regression surface, not a mechanical
dialog swap, and this round treated committing to it the same way this
task's own instructions treat removing a user-facing product surface:
something to flag for an explicit human-approved scope decision rather than
do unilaterally under review pressure. Nothing was migrated on this side of
the ledger this round either.

**On "add further ordered parts to this task":** the plan's own escape valve
for exactly this situation is to extend the task with more ordered parts
rather than force the work into one round. An implementation round has no
tool to add checklist items to `plan-final.md` (the round's own contract
permits ticking existing boxes only, never adding new ones), so exercising
that escape valve is itself outside what this round can do — it requires a
planning-level pass. Recorded here so the next round (or a human) has both
options with their actual costs: approve the narrower AC8 reading this audit
argues for, or schedule a planning pass that adds a Batch F with the
`ChatTarget`-threading slice above as its first ordered part.

## Second addendum (follow-up round, same date): the ChatTarget-threading slice, executed

The prior addendum's reasoning about `postWorkflowDecisionV1` having no
"await the answer" primitive was correct, but the conclusion that a
promise-based helper "could be built" was verified and then actually built
this round: `awaitWorkflowDecisionAnswerV1`
(`src/utils/workflowDecisionDispatchV1.ts`) posts a `WorkflowDecisionV1`
record and returns a promise that resolves once `WorkflowDecisionStoreV1`
reports the decision has left `"pending"` (via its existing `onDidChange`
event + `get`), letting a caller that already `await`s a modal today swap the
wait source without a pause/resume redesign — the awaiting call stays alive
in-process exactly as it did before.

Both automation-surfaced sites are migrated with this helper:

- **`runners/copilotImplementationRunner.ts`'s round-limit gate** (site #20)
  now takes optional `taskFolderUri`/`stage` and, when both are present,
  awaits an `implementationRoundLimitReached` decision instead of a raw
  modal. `runnerRegistry.ts:951` (the one production caller) was updated to
  thread `options.taskFolderUri`/`options.stage` through — the exact,
  bounded prerequisite slice the first addendum identified. When either is
  absent (a caller with no task, or a test), the function falls back to the
  original `vscode.window.showWarningMessage` unchanged, so no caller loses
  the question outright.
- **`utils/quota.ts`'s `handleQuotaFailure`** (site #23) now awaits a
  `quotaExhaustedDuringRun` decision. This function has zero production
  callers today (confirmed again this round — same dead-code finding as the
  first addendum), so the migration is behaviorally inert in production, but
  it removes the raw call site honestly rather than leaving it as a
  documented exception, and the function is exercised correctly if a future
  caller wires it up.

Neither migration required a control-flow redesign beyond threading two
already-available fields (`taskFolderUri`, `stage`) one call deeper — the
"real, scoped, testable slice" the first addendum described. Both are covered
by real behavioral tests for the shared helper
(`src/test/workflowDecisionAwaitAnswerV1.test.ts`: resolved-via-store,
dismissed-via-store, no-context short-circuit, cancellation-token) plus
source-level tests for the two call sites and the `runnerRegistry.ts`
threading (`src/test/handoffAutomationSurfacedDecisions.test.ts`) and gating
presence (`src/test/workflowDecisionGatingInventoryV1.test.ts`). Full suite
(3642 tests), lint, `check-types`, and `verify:workflow-safety` all pass
after the change.

**Updated summary (superseded by the Third addendum below — see there for the
corrected count): this addendum originally reported 21 production call sites
remaining.** That count was wrong: it treated site #20
(`copilotImplementationRunner.ts`) as fully closed because its live,
task-scoped path was migrated, but the same function's no-task fallback
branch (line 748) still calls `vscode.window.showWarningMessage` directly and
is itself a production call site. The correct count, folding that branch back
in, is 22 — see the Third addendum.

The 19 direct-confirm sites and the 2 non-task-scoped sites (`promptSizeGuard
.ts`, `globalAssistantActions.ts`) are unchanged from the first addendum's
reasoning — converting a synchronous "are you sure?" modal shown in direct
response to the user's own click into an asynchronous chat-panel record is a
product-level UX change across many live flows, not a mechanical dialog swap,
and this task's own instructions require that class of change to go through
an explicit human-approved scope decision rather than be forced through under
review pressure. That decision is now tracked as `plan-final.md`'s Batch F,
Part 12 — the plan's own escape valve, exercised directly in the plan this
round rather than deferred again. The Third addendum folds the site #20
fallback branch into that same Part 12 decision set (it is not task-scoped
either — it exists precisely for callers with no task to attribute the
decision to — so it fits the identical reasoning as the other 21).

## Third addendum (follow-up round, same date): correcting the 21-vs-22 count

A subsequent implementation review caught the error above directly: "There
are 22 such call sites in the current production tree, including the
conditional fallback in `copilotImplementationRunner.ts`." Verified by
re-running `grep -n "vscode\.window\.showWarningMessage(" src --include=*.ts`
excluding `src/test/**`: **22 production call sites**, not 21 — the 19
direct-confirm sites, the 2 non-task-scoped sites, and
`copilotImplementationRunner.ts:748` (the no-`taskFolderUri`/`stage` fallback
inside `runImplementationWithCopilot`'s round-limit gate). `quota.ts` has
zero remaining raw calls (confirmed by the same grep) — that migration really
is complete and stays excluded from the count, as does the fully-migrated
task-scoped branch of site #20 itself.

The mistake in the Second addendum was scoring "site #20" as one migrated
line item because its live, most-frequently-hit branch was migrated, without
separately counting the `else` branch that still runs the original raw call.
A partially migrated call site is not a migrated call site: the plan's own
criterion ("no production message with outcome-changing buttons remains on
raw `showWarningMessage`") is about surviving CALLS, not about functions that
happen to contain a migrated branch alongside an unmigrated one.

**Disposition:** `copilotImplementationRunner.ts:748` is added to
`plan-final.md`'s Batch F Part 12 site list (now 22 sites, not 21) rather
than migrated unilaterally here, for the same reason the other 21 were
deferred to that human decision: it is a fallback specifically for callers
with no task to attribute a `WorkflowDecisionV1` to (the identical
`ChatTarget` disqualifier documented above for `promptSizeGuard.ts` and
`globalAssistantActions.ts`), so closing it the same way those two are closed
is the consistent reading, not a special case. **Current, corrected count:
22 production call sites remain**, none of them closable without either the
Part 12 human decision or (for #20's fallback specifically) a further
signature change with no live coverage in this environment, per the
reasoning the first addendum already gave for the task-scoped branch.

## Human decision (2026-08-24): option (a) approved — AC 8 narrowed

Batch F required presenting the remaining sites to a human with two options.
Presented and answered.

**Decision: (a) — narrow AC 8 to automation-surfaced decisions specifically.**
Direct user-click confirmations and non-task-scoped dialogs (including site
#20's no-task fallback) remain on `vscode.window.showWarningMessage` by design.
No further code changes are required for this batch.

AC 8 updated accordingly in `plan.md` (item 8): "no production message with
outcome-changing buttons remains on raw `showWarningMessage`" becomes "no
automation-surfaced decision remains on raw `showWarningMessage`".

### Reasoning

1. **The failure mode this task exists to fix is specific.** The task's own
   evidence ("The worse case") is a decision the automation raised while
   nobody was watching, buried in a notification stack. A modal the user
   summoned by clicking the very action it confirms is not that failure: it is
   already in front of them, already has their attention, and its answer is
   consumed immediately by the code that raised it.

2. **Migration would degrade those flows.** `WorkflowDecisionV1` is a durable,
   task-scoped chat record. Converting a synchronous "are you sure?" gate into
   one requires the pause/resume redesign this audit's addendum describes, and
   trades an immediate answer for a record the user must go and find.

3. **Decisive, from live evidence 2026-08-23/24:** the `WorkflowDecisionV1`
   renderer currently hardcodes the headline "Decision needed" and ignores the
   record's own `gating` metadata (`chatView.ts:328` and `:1980`, while
   `:1976` already reads `isGating` one line above the title to pick a CSS
   class). A decision declaring `holdsTaskPaused: false`,
   `unblocksProgress: false` and "the scheduled continuation round runs on its
   own regardless of your answer here" is still announced as a warning headed
   "Decision needed". Over ninety minutes the operator was asked three times
   to decide something that needed no decision, and asked why.

   Migrating 21 further sites onto that renderer would manufacture 21 more
   such headlines. **Under present behaviour, migration makes the product
   worse, not better.**

### Consequence and revisit condition

This narrowing is scoped to current renderer behaviour, not asserted as
permanent. Option (b) becomes worth reconsidering once the renderer derives
its headline and severity from `decision.gating` — tracked as item 13 of
workflow 10 (`.ensemble/2026-08-21_task_2`). Until then the remaining sites
stay as they are, by decision rather than by omission.
