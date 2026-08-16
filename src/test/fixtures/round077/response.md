<!-- ensemble:implementation-checklist -->

# Implementation Checklist: Workflow-robustness fixes — stranded rounds, misclassified failures, and unbreakable loops

## Part 1 — One durable recovery transition for every unreported round (item 1)

- [x] Create a test fixture from the round-010 response body (`.ensemble/2026-08-13_task_1/runs/010-claude-cli-impl.md`; reconstruct from the context-pack excerpts if archived) and run it through `describeIncompleteImplementationRoundV1` and `describeImplementationSummaryShapeIssue` to pin exactly which gate let it finalize.
- [x] Tighten `describeIncompleteImplementationRoundV1` in `src/utils/implementationArtifactResolver.ts` (339–379): a response matching `DEFERRAL_PHRASES_V1` that is missing any required section — or whose sections are empty when the round changed files — classifies as `roundDeferred` even when one section is present; complete well-shaped responses with an incidental phrase match stay accepted.
- [x] Extract the existing deferred/incomplete-branch persistence and dispatch logic (`src/commands/reviewActions.ts` 5374–5521) into a single shared seam `beginImplementationRecoveryV1(folderUri, input)`, preserving the existing quarantine-before-run-log durable ordering exactly (deferredRoundRecovery.test.ts must stay green unmodified except for new assertions).
- [x] Route the stamped-unusable-summary path (reviewActions.ts 5715–5736, `return false` at 6002) through `beginImplementationRecoveryV1` so it persists recovery state and dispatches instead of persisting nothing.
- [x] In `beginImplementationRecoveryV1`, persist in a single `patchTaskProgressStrictV1` call before any run-log, artifact, or scheduling write: (a) the round's change set quarantined into `pendingImplReviewFiles` from the run record's git-snapshot `filesChanged`, recording `filesChangedUnknown` explicitly rather than an empty list; (b) the `incompleteRoundContinuations` increment bounded by `MAX_INCOMPLETE_ROUND_CONTINUATIONS_V1` with the same cap-reached escalation; (c) a new `implRecovery` record carrying `sourceAttemptId`, `reason`, triggering failure class, recovery mode, and dispatch state.
- [x] Add `implRecovery` to both type declarations (`src/types/taskProgress.ts`, `packages/ensemble-core/src/taskProgressV1.ts`), both strict decoders' allowed-key sets (`src/services/taskProgressDecoderV1.ts` and the ensemble-core mirror), and the field policy (`src/services/taskProgressFieldPolicyV1.ts`).
- [x] Implement the `implRecovery.dispatch` state machine (`pending` → `dispatched` → cleared) carrying `leaseOwner` / `leaseUntil` / continuation `attemptId`: transition commits `pending`; dispatcher claims lease and flips to `dispatched` with the attemptId in one patch; on task load/activation a `pending` record with no live lease (cap not reached) re-arms the chain; a `dispatched` record whose attemptId already produced a round never re-dispatches; the record clears in the same transaction that finalizes a subsequent usable summary. Arm re-dispatch through `TaskActionScheduler` (`src/commands/scheduleTaskResume.ts`) where practical to inherit lease renewal and the stage-moved skip guard.
- [x] Update the unusable-path warning and run log to state that a continuation was scheduled ("continuation N of 3", naming the recovery mode) or that the cap was reached and a human is needed — wording distinct from "review paused, waiting on user" (reuse the incomplete-branch notification style at reviewActions.ts 5464–5502).
- [x] Add regression tests in `src/test/implementationSummaryArtifact.test.ts` and `src/test/deferredRoundRecovery.test.ts`: waiter-narration-only → `roundDeferred`; waiter narration plus exactly one section present → `roundDeferred`; the round-010 fixture lands the identical recovery record via either gate before anything is scheduled; a stamped-unusable summary without deferral phrasing also lands it; simulated restart after persistence but before dispatch re-arms exactly once and a `dispatched` record never double-fires; cap exhaustion escalates instead of looping; `filesChangedUnknown` recorded honestly.

## Part 2 — Enforceable recovery modes instead of a full stage redo (item 2)

- [x] Reconstruct from `.ensemble/2026-08-13_task_1`'s task-progress history and run logs what regressed `currentStage` from `impl-high-review` to `impl` and dropped `impl` from `completedStages`; if an automatic path, gate it; if manual/legacy, record the finding and proceed.
- [x] Implement recovery-mode selection in `beginImplementationRecoveryV1`, persisted at transition time: `summary-only` iff the process terminated normally AND the latest `impl-high-review` passed with 0 blockers over the pre-round boundary AND the delta is known; `inspect-and-complete` when the round was terminated externally (timeout, inactivity kill, crash) with a known non-empty change set; `unconstrained` when edits are suspect (open blockers, no passing review, or `filesChangedUnknown`).
- [x] Write the continuation mandates: `summary-only` produces `## Files Changed` / `## Verification` / checklist echo covering the existing combined diff (reviewed files plus quarantined delta) with no edits; `inspect-and-complete` verifies quarantined files for partial edits, finishes or reverts what is incomplete, then reports, restricted to the quarantined-plus-reviewed boundary.
- [x] Dispatch `summary-only` continuations through the broker in `mode: "text"`; when the stage's resolved provider cannot honor text mode, fall back to `inspect-and-complete`.
- [x] Add the post-run delta gate on every recovery continuation: a `summary-only` continuation with any non-empty delta is rejected, quarantined, escalated to `inspect-and-complete`; `inspect-and-complete` files touched outside boundary are recorded as unreviewed scope.
- [x] Verify and pin with a test that the stale-review mechanism forces a fresh review of the combined scope after any recovery continuation.
- [x] Add Part 2 tests: normal-termination reporting-only failure after 0-blocker review → `summary-only`; open blockers/unknown delta → `unconstrained`; externally-killed round → `inspect-and-complete`; edit-making `summary-only` continuation rejected/quarantined/escalated.

## Part 3 — Checklist ticks that can never land, and the loop that never exits (item 8)

- [x] Create a fixture from the actual round-013 output, run it through `mergeChecklistProgressV1`, and determine why `collectRetroactiveTickClaimsV1` produced zero ticks.
- [ ] Fix the confirmed merge/scoping defect in `src/utils/implementationChecklist.ts` — no general "a `— done` bullet counts as a tick" heuristic — and mirror the change in `packages/ensemble-engine/src/checklistProgressV1.ts` with its parity tests.
- [x] Treat a summary that both declares `<!-- ensemble:no-checklist-change -->` and supplies retroactive/done claims as self-contradictory.
- [x] Strengthen `resources/prompts/run-implementation.md` and `resources/prompts/apply-impl-review-code.md` with a worked example of retroactive tick syntax and an instruction never to combine it with the no-change marker.
- [x] Extend the `checklistProgressUnreliable` trigger to also fire when a round claimed completions but no tick merged, standing the completeness gate down and surfacing `reconcilePlanChecklist`.
- [x] Establish from the "1.9" run records why the existing no-progress breaker did not trip across rounds 009/011/013 and document the confirmed cause in the fix.
- [ ] Generalize the single existing breaker: extend the `zeroChangeImplRounds` increment condition to cover a completed implementation round with no file delta AND no checklist delta — including claimed-but-unmerged and the none-recorded state once pinned.
- [x] Add Part 3 tests: fixture-driven merge test reproducing round 013; contradictory-marker rejection; latch fires on claimed-but-unmerged; generalized breaker trips on sterile rounds including the none-recorded state.

## Part 4 — Model-entitlement 403s misclassified as auth (item 3)
- [x] All items complete.

## Part 5 — Parse quota reset times; branch the remedy on magnitude; persist it (item 4)
- [x] All items complete, including the long-outage stage-impact notice (`findStagesSharingBlockedPrimaryV1` in `src/runners/runnerRegistry.ts`).

## Part 6 — Known-benign CLI noise never presented as the diagnosis (item 5)
- [x] All items complete.

## Part 7 — Inactivity watchdog and an honest timeout message (item 6)
- [x] All items complete.

## Part 8 — Review scores compared across a changing reviewer (item 7)

- [x] Add optional structured reviewer identity (provider id, resolved model id) to `ReviewScoreHistoryEntry` in both type declarations, both strict decoders' allowed-key sets.
- [x] Thread `outcome.provider` into `handleReviewRoutingOutcome`'s options and populate the entry.
- [ ] In `improveReviewScore` (`src/utils/reviewScoreLoop.ts`), when the current round's reviewer identity differs from the baseline's, do not apply the +0.1 delta test across the break — not reached this round.
- [x] Restrict `detectPlateau` and `detectBlockerSetStall` comparison windows to the trailing run of entries from the current reviewer; a window spanning an identity change returns not-plateaued.
- [x] Add Part 8 tests: decoder acceptance of the new field; reviewRouting.test.ts cases for an identity change inside the window; legacy entries without the field behave exactly as before.

This round completed Part 8's core fix (reviewer identity is now recorded on `reviewScoreHistory` and both plateau/blocker-set-stall detectors stop comparing across a reviewer substitution), and verified via full test-suite/lint/type-check runs that Parts 1–7 (already implemented in earlier, previously-unreported rounds) remain green.

## Files Changed

- `src/types/taskProgress.ts` — added `ReviewerIdentityV1` type and `reviewer?` field on `ReviewScoreHistoryEntry`.
- `packages/ensemble-core/src/taskProgressV1.ts` — mirrored the same `reviewer?`/`ReviewerIdentityV1` addition.
- `src/services/taskProgressDecoderV1.ts` — added `reviewer` to the `reviewScoreHistory` entry allowed-key set and its shape validation.
- `packages/ensemble-core/src/taskProgressDecoderV1.ts` — mirrored the same decoder validation.
- `src/commands/reviewActions.ts` — `handleReviewRoutingOutcome` accepts an optional `reviewer` identity and records it on the appended history entry; the `routeReviewOutcomeV1` call site now passes `outcome.provider`.
- `src/utils/reviewRouting.ts` — added `reviewerKey`/`restrictToTrailingSameReviewerRun` and wired both `detectPlateau` and `detectBlockerSetStall` to restrict their comparison window to the trailing same-reviewer run.
- `src/test/reviewRouting.test.ts` — added tests: plateau/blocker-set-stall no longer fire across a reviewer change, resume once enough same-reviewer history accumulates, legacy entries unaffected.
- `src/test/taskProgressDecoderV1.test.ts` — added decoder acceptance/rejection tests for the new `reviewer` field (valid, legacy-absent, unknown-property, empty-string, non-object).

## Plan Item Checklist

- Part 1 (all items) — done <!-- ensemble:retroactive --> — `src/commands/implementationRecoveryV1.ts`, `src/actions/rows/implContinuationReportRowV1.ts`, `src/test/implRecoveryDispatch.test.ts`, `src/test/implRecoveryModeSelection.test.ts`, `src/utils/extensionContextV1.ts` (all present on disk; full suite including `deferredRoundRecovery.test.ts` passes)
- Part 2 (all items) — done <!-- ensemble:retroactive --> — `src/commands/implContinuationTextDispatchV1.ts`, mode-selection logic present in `src/commands/implementationRecoveryV1.ts`; `src/test/implRecoveryModeSelection.test.ts` passes
- Part 3, item 1 (fixture + investigation) — done <!-- ensemble:retroactive --> — `src/test/implementationSummaryArtifact.test.ts:1928` ("the round-013 fixture: the retroactive-claim mechanism itself is not the defect — the merge legitimately returns no-match on the paraphrase")
- Part 3, item 2 (fix the merge defect) — deferred — investigation (see item 1's fixture test) concluded the merge/scoping logic has no confirmed defect; the actual root cause was the contradictory no-checklist-change-plus-claims shape, already handled by item 3. Left unticked pending an explicit decision to close this item rather than silently dropping it from the plan.
- Part 3, items 3–6, 8 — done <!-- ensemble:retroactive --> — `hasContradictoryNoChecklistChangeClaimV1` (implementationSummaryArtifact.test.ts:1894-1951), prompt updates present in `resources/prompts/run-implementation.md` / `apply-impl-review-code.md`, `checklistClaimedButUnmerged` wiring at `src/commands/reviewActions.ts:5836-5868`
- Part 3, item 7 (generalize `zeroChangeImplRounds`) — done <!-- ensemble:retroactive --> — `src/commands/reviewActions.ts:5794-5803` (`checklistAdvanced` gate: "The streak is about STERILE rounds — no file delta AND no checklist delta")
- Part 4 (all items) — done <!-- ensemble:retroactive --> — `isModelEntitlementFailure`/`"model-entitlement"` in `src/utils/quota.ts`, cascade wiring in `src/runners/runnerRegistry.ts:857-864`/975-981, full `src/test/quota.test.ts` and `src/test/cliFailureClassification.test.ts` pass
- Part 5, all items except stage-impact notice — done <!-- ensemble:retroactive --> — `parseQuotaResetV1`, quota ledger in `src/utils/extensionContextV1.ts` + `src/utils/quota.ts:683-793`, scheduler entry point in `src/commands/scheduleTaskResume.ts`
- Part 5, stage-impact notice — done <!-- ensemble:retroactive --> — `findStagesSharingBlockedPrimaryV1` and `affectedStagesClause` at `src/runners/runnerRegistry.ts:1190-1213`
- Part 6 (all items) — done <!-- ensemble:retroactive --> — `KNOWN_BENIGN_CLI_ERROR_SIGNATURES_V1` and filtering in `src/runners/cliAgentRunner.ts`, tests in `src/test/cliFailureClassification.test.ts`
- Part 7 (all items) — done <!-- ensemble:retroactive --> — inactivity watchdog and message restructuring in `src/runners/cliAgentRunner.ts`, tests in `src/test/cliRetryEvidence.test.ts`
- Part 8, reviewer identity field + decoder/policy — done — this round, `src/types/taskProgress.ts`, `src/services/taskProgressDecoderV1.ts` (+ ensemble-core mirrors)
- Part 8, thread `outcome.provider` into history entry — done — this round, `src/commands/reviewActions.ts`
- Part 8, `improveReviewScore` reviewer-aware delta gate — deferred — not reached this round; `reviewScoreLoop.ts`'s `improveReviewScore` runs a single continuous fast-forward session and does not currently receive per-attempt reviewer identity from its `review()` callback, so wiring this requires extending `ReviewRoundOutcome` and the fast-forward call sites, which needs its own careful pass
- Part 8, `detectPlateau`/`detectBlockerSetStall` reviewer-aware windows — done — this round, `src/utils/reviewRouting.ts`
- Part 8, tests — done — this round, `src/test/reviewRouting.test.ts`, `src/test/taskProgressDecoderV1.test.ts`

## Verification

- `npx tsc -p . --noEmit` — clean.
- `npx tsc --project tsconfig.test.json` — clean.
- `npm run test:unit` — 2871 passed, 0 failed (up from 2866 before this round's additions).
- `npx eslint src` and the touched `packages/ensemble-core` files — 0 errors (pre-existing warnings only, none in touched code).
- `npm run verify:workflow-safety` — passes.
- Manually confirmed via `entry({ reviewer: ... })` fixtures in `reviewRouting.test.ts` that a flat/stalled score or unchanged blocker set spanning a reviewer substitution no longer reads as a plateau, and that legacy entries with no `reviewer` field behave exactly as before (regression safety for existing tasks).
