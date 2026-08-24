# Hand-off contract conformance pass — Part 11

Part 11 of "Actionable Hand-offs: one contract, nine surfaces": "Run a
conformance pass over the hand-off contract matrix (Part 1) against the Part
5 creation-site inventory, verifying every escalation/decision path renders
its required fields or an explicit unknown; record the checklist as artifact
evidence, with written reasons for any waivers."

The contract and its per-surface required-field matrix live in
`src/types/handoffGuidanceV1.ts` (`HANDOFF_REQUIRED_FIELDS_V1`,
`checkHandoffConformanceV1`). Two surfaces (`decisionRecord`,
`scheduledWork`) render literally through the module's own
`renderRequiredHandoffFieldsV1` in production (`chatView.ts`,
`taskTreeProvider.ts`) — a value/absence mismatch there fails loudly (an
explicit "not recorded" line), so those two are conformant by construction.
The remaining surfaces produce hand-authored prose that must independently
carry the same content; this pass checks each against the matrix by content,
not by call-site grep, and cites where the content lives.

## Decision records (fields 1-7) — `decisionRecord`

Rendered through `renderHandoffFieldLineV1`/`renderRequiredHandoffFieldsV1`
in `chatView.ts:1497-1506` (the `gating` line) and the card body built from
`WorkflowDecisionV1.options`/`recommendation`/`whatHappened`/`whyUserNeeded`
(action/reason/method/acknowledgement are the decision's own fields, not
routed through this renderer, but present — see `workflowDecisionV1.ts`).
Every production creation site supplies `gating` (`assertGatingRequirementV1`
in `workflowDecisionDispatchV1.ts` throws otherwise), confirmed for all 8
creation sites by `src/test/workflowDecisionGatingInventoryV1.test.ts`
(`applyReviewerVerifiedTicks`, `restoreRejectedImplementationRound`,
`reconcilePlanChecklist`, `providerChainExhausted`,
`preImplementationRouting`, `sterileRoundRouting`,
`implementationRoundLimitReached`, `quotaExhaustedDuringRun`). The last two
are posted through `awaitWorkflowDecisionAnswerV1` (Part 11 follow-up: the
two automation-surfaced `showWarningMessage` sites) rather than
`postWorkflowDecisionV1`, but go through the same `assertGatingRequirementV1`
guard and the same store/renderer, so conformance is identical. **Conformant.** A record
created before PART 5 (none currently exist in this codebase's history —
`gating` was added and back-populated in the same task) would render
`renderHandoffFieldLineV1`'s explicit "not recorded — unknown" line rather
than being silently dropped, per `chatView.ts`'s own comment at line 1481.

## Manual-verification checklist items (fields 1-5) — `manualVerificationItem`

Authored per-task by the model that writes the plan (Part 2's design: the
guidance is domain content, not hard-coded). `resources/prompts/create-plan.md`
and `create-implementation.md` require the five-field shape (verified by
`src/test/handoffGuidancePromptContract.test.ts`, per the Part 2 checklist).
Production rendering: `listOutstandingManualVerificationItemsV1`
(`src/utils/implementationChecklist.ts:888+`) sorts HIGH before LOW using
`parseChecklistItemPriorityV1`, which matches the literal
`renderHandoffFieldLineV1` impact-field format (`"Priority: HIGH — <cost of
failure>"`), so authored text and the render format share one vocabulary.
**Conformant for plans generated after Part 2.** Older plans with no priority
marker sort as originally ordered (`checklistItemPriorityRank`'s middle rank)
— an explicit, documented non-migration of pre-existing content, not a
silent gap.

## Refusals — continuation lease (fields 1, 2, 4, 5, 7) — `actionRefusal`

`describeOwedContinuationRefusalV1` (`src/utils/owedContinuationRefusalV1.ts`)
returns one string carrying: the blocker in plain terms (1/2 — "A
continuation round is owed for this task (...)"), the clearing condition and
wall-clock time (4/`clearingSignal` — `leaseClause` + `retryClause` +
`remedyClause`, including the do-not-retry line), and the quarantined file
list (5/`collateral` — `filesClause`). Acknowledgement (7) is the separate
"declined" run-log entry `showTaskBusyWarning` writes
(`src/utils/taskOperations.ts:816-827`) whenever this explainer fires — a
history entry distinguishable from both a failure and a silent gap, per Part
8's requirement. **Conformant**, verified by
`src/test/owedContinuationRefusalV1.test.ts`.

## Stage prerequisites (fields 1, 2, 4, 5, 7) — `stagePrerequisite`

`stageActionRequirementMessageV1` (`src/utils/stageArtifactRequirementsV1.ts`)
drives 11 call sites in `reviewActions.ts` (lines 3298, 3333, 3348, 4091,
5224, 5232, 6119, 8085, 9113-9114, 9144) that previously hard-coded ad hoc
"No plan found" text. Names the missing artifact and which stage produces it (1/2),
states what to do (2), and the map is the single source for both pre-flight
display and refusal text (Part 7's own conformance test). Acknowledgement
(7): the refusal itself IS the acknowledgement — the message is returned
synchronously to the exact command the user just invoked, so there is no
separate "did this register" question the way there is for an asynchronous
decision. **Conformant**, verified by
`src/test/stageArtifactRequirementsV1.test.ts`.

## Routing recommendations (fields 1, 2, "must see the gating state") — `routingRecommendation`

`decidePostReviewActionV1` (`src/utils/reviewRouting.ts:918+`) returns
`{ action, reason }` — 1/2 directly. The gating-state input requirement
("must see the state that actually gates the action, not a subset of it") is
enforced by the function's own signature: `continuationOwed` and
`pendingImplReviewFilesCount` are read BEFORE the review-history branch and
unconditionally win ("Fix, part 1" from the plan's "The worse case"),
confirmed by `reviewRouting.test.ts`'s owed-continuation-precedence coverage.
Both call sites (`reviewActions.ts` pre-Implementation dialog and no-files-
changed dialog) now pass `continuationOwed`/`pendingImplReviewFilesCount`
through from `resolved.progress`. **Conformant.**

## Advertised envelope outcomes (field 7, +2 on refusal) — `envelopeOutcome`

`splitStageActionEnvelopes` is wired in `chatWithStage.ts` (Part 3); its
outcome line — applied/refused per envelope — is rendered separately from
the transcript text, with a reason attached on refusal (verified by
`src/test/stageChatActions.test.ts`'s dispatch-path coverage: applied,
refused, malformed-payload cases) and no envelope text (recognized or not)
survives into the displayed chat, per the class-guard test comparing the
prompt's advertised envelope set against the wired/consumed set.
**Conformant.**

## Chat pending posture (fields 4, 6) — `chatPendingState`

Derived from persisted state plus the in-flight registry
(`src/views/chatView.ts`), covered by settled-never-awaiting,
pending-requires-inflight, and message-count-parity tests in
`chatViewWorkflowDecision.test.ts` (Part 4 checklist). **Conformant.**

## Scheduled background work (fields 2, 4, 6) — `scheduledWork`

Rendered literally through `renderRequiredHandoffFieldsV1("scheduledWork",
...)` in both `chatView.ts:1569/1576` (chat header) and
`taskTreeProvider.ts:323` (tree tooltip) — the one surface with two
independent production call sites both going through the shared renderer.
Posture derivation requires the per-task coverage marker and positive
evidence on every clause before rendering `waitingForYou`
(`deriveSchedulingPostureV1`, `schedulingIntentV1.ts`), and both call sites
now handle a derivation failure by rendering the contract's `unknown` line
rather than leaving the field unset (the 2026-08-23 review-flagged fix
visible in `chatView.ts:1572-1579`'s `catch` block). **Conformant.**

## Churn escalations (fields 1, 2, 4, "plus an evidence-backed cause") — `churnEscalation`

`buildChurnEscalationReasonV1` (`src/utils/reviewRouting.ts:381+`) derives
its leading clause from `classifyChurnLineageV1`'s declared-lineage
diagnosis (the evidence-backed cause), never asserting "churning" for a
narrowing/shifting/insufficient-evidence window (fields 1/2 — action implied
by the diagnosis-specific guidance, reason = the built sentence). The
"requirement may be wrong" option (Part 10's first-class escalation choice)
is wired into the actual paused-task question in
`src/utils/reviewEscalation.ts:150-161` ("reconsider the requirement itself
— check the plan's non-goals and prior decisions"). Field 4 (clearing
signal): `blockedReason` states "The task has been paused — resume it once
you've decided how to proceed." **Conformant**, verified by
`src/test/reviewBlockerLineageV1.test.ts`'s
`buildChurnEscalationReasonV1`/`classifyChurnLineageV1` coverage (this
round's continuation work — see the round's `## Files Changed` section).

## Waivers

None. Every surface in the nine-surface matrix has a production rendering
path that carries its required fields as real content, verified either by
the shared renderer's own fail-loud behavior (`decisionRecord`,
`scheduledWork`) or by a dedicated test file asserting the content is
present (every other surface, cited above). No surface was found rendering
a required field silently absent in a live production path during this
pass.

## What this pass does NOT prove

This is a targeted content check against the nine surfaces the plan names,
not an exhaustive line-by-line audit of every call site that could ever
reach these renderers (e.g. every possible malformed/partial `TaskProgress`
shape feeding `chatView.ts`'s scheduling-posture derivation). The unit tests
cited above are the durable proof; this document is the traceability map
from the plan's matrix to where that proof lives.
