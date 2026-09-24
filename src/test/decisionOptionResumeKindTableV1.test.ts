import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Pre-1.0.0 fixes register, Part 3 (items 14/22), the plan's own Step 2
 * inventory table: "A runtime table test over every builder in the
 * inventory … `resumeKind` is set; a `continue` option's command dispatches
 * or schedules work; an `unpause` option does not."
 *
 * `workflowDecisionResumeKindSourceScanV1.test.ts` already proves every
 * production option literal *states* a `resumeKind`. This file is the
 * complementary table: it proves every one of those literals states the
 * *value* the plan's Step 2 inventory assigns it, in one place a reviewer
 * can diff directly against that inventory — and it cross-references each
 * row to the existing runtime test(s) that prove the `continue` row's
 * command actually dispatches and the `unpause` row's does not, so a
 * misclassification (the right shape, wrong kind) cannot land silently
 * alongside untested dispatch wiring.
 *
 * This does not replace those runtime tests — they already exist, scattered
 * per builder file, and are named below next to each row. It closes the one
 * gap those scattered tests do not: a single table enumerating every
 * (file, optionId, occurrence) triple in the inventory against its
 * classification and its dispatch-proof test, so nothing in the inventory
 * can go unaccounted for.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SRC_ROOT = path.join(REPO_ROOT, "src");

function enclosingObjectLiteral(text: string, matchOffset: number): string | undefined {
  let depth = 0;
  let openIdx = -1;
  for (let i = matchOffset; i >= 0; i--) {
    const ch = text[i];
    if (ch === "}") {
      depth++;
    } else if (ch === "{") {
      if (depth === 0) {
        openIdx = i;
        break;
      }
      depth--;
    }
  }
  if (openIdx === -1) {
    return undefined;
  }
  depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(openIdx, i + 1);
      }
    }
  }
  return undefined;
}

interface ExtractedOption {
  readonly optionId: string;
  readonly resumeKind: string | undefined;
  readonly line: number;
}

/** Every real `WorkflowDecisionOptionV1` literal in one file, in document order. */
function extractOptions(filePath: string): ExtractedOption[] {
  const text = fs.readFileSync(filePath, "utf8");
  const out: ExtractedOption[] = [];
  const pattern = /optionId:\s*["'`]([^"'`]*)["'`]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const objectSource = enclosingObjectLiteral(text, match.index);
    if (objectSource === undefined || !/\beffect\s*:/.test(objectSource)) {
      continue;
    }
    const resumeKindMatch = /resumeKind:\s*["']([^"']*)["']/.exec(objectSource);
    out.push({
      optionId: match[1] ?? "",
      resumeKind: resumeKindMatch?.[1],
      line: text.slice(0, match.index).split("\n").length,
    });
  }
  return out;
}

/**
 * The plan's Step 2 inventory, verbatim, expressed as one row per
 * (file, occurrence-within-file) pair. `occurrence` disambiguates optionIds
 * that repeat in the same file under different branches (e.g. `reviewEscalation.ts`
 * builds `keepIterating` twice, once per non-environmental escalation branch —
 * its former third (environmental) occurrence was given its own id,
 * `switchStageModel`, since the plan's inventory classifies every
 * `keepIterating` literal "continue" with no carve-out, and that branch's
 * option is correctly "unpause";
 * `reviewActions.ts` builds `goToReviewAndApply`/`notNow` at three near-identical
 * card sites). The runtime test named per row is where dispatch-vs-no-dispatch
 * for that exact option is proven today.
 */
interface InventoryRow {
  readonly file: string;
  readonly optionId: string;
  readonly occurrence: number; // 0-based, within this file, in document order
  readonly resumeKind: "continue" | "unpause";
  readonly dispatchProof: string;
}

const INVENTORY: readonly InventoryRow[] = [
  // src/utils/reviewEscalation.ts
  { file: "utils/reviewEscalation.ts", optionId: "advance", occurrence: 0, resumeKind: "continue", dispatchProof: "reviewEscalation.test.ts: Advance dispatches resumeAndSetTaskStage / restarts Fast Forward" },
  { file: "utils/reviewEscalation.ts", optionId: "reconsiderRequirement", occurrence: 0, resumeKind: "unpause", dispatchProof: "reviewEscalation.test.ts: reconsiderRequirement opens Accepted Non-Goals, dispatches nothing" },
  { file: "utils/reviewEscalation.ts", optionId: "keepIterating", occurrence: 0, resumeKind: "continue", dispatchProof: "reviewEscalation.test.ts: keepIterating (task-fixable branch) is continue" },
  { file: "utils/reviewEscalation.ts", optionId: "handleMyself", occurrence: 0, resumeKind: "unpause", dispatchProof: "reviewEscalation.test.ts: handleMyself leaves task paused" },
  // Review finding, 2026-09-23: the environmental branch used to reuse the
  // `keepIterating` optionId with resumeKind "unpause", which contradicted
  // the plan's Step 2 inventory (that file's `keepIterating` = continue,
  // with no environmental carve-out) even though the behaviour itself is
  // correct — opening AI Models is user-performed, so "unpause" is right.
  // Given its own id, `switchStageModel`, instead of misclassifying
  // `keepIterating` under a value the inventory does not grant it.
  { file: "utils/reviewEscalation.ts", optionId: "switchStageModel", occurrence: 0, resumeKind: "unpause", dispatchProof: "reviewEscalation.test.ts: switchStageModel (environmental branch) opens AI Models, dispatches nothing" },
  { file: "utils/reviewEscalation.ts", optionId: "keepIterating", occurrence: 1, resumeKind: "continue", dispatchProof: "reviewEscalation.test.ts: keepIterating (narrowed-blocker branch) is continue" },
  { file: "utils/reviewEscalation.ts", optionId: "handleMyself", occurrence: 1, resumeKind: "unpause", dispatchProof: "reviewEscalation.test.ts: handleMyself variant leaves task paused" },
  { file: "utils/reviewEscalation.ts", optionId: "publishAnyway", occurrence: 0, resumeKind: "continue", dispatchProof: "reviewEscalation.test.ts: publishAnyway dispatches the publish continuation" },
  { file: "utils/reviewEscalation.ts", optionId: "acknowledgeAdvance", occurrence: 0, resumeKind: "continue", dispatchProof: "reviewEscalation.test.ts: acknowledgeAdvance routes through the Step-3 Advance path, not doNothing" },
  { file: "utils/reviewEscalation.ts", optionId: "handleMyself", occurrence: 2, resumeKind: "unpause", dispatchProof: "reviewEscalation.test.ts: handleMyself variant leaves task paused" },

  // src/commands/reconcilePlanChecklist.ts
  { file: "commands/reconcilePlanChecklist.ts", optionId: "applyVerifiedTicks", occurrence: 0, resumeKind: "continue", dispatchProof: "reconcilePlanChecklistCommand.test.ts: applyVerifiedTicks dispatches the stage's next action after ticking" },
  { file: "commands/reconcilePlanChecklist.ts", optionId: "linkManualChecks", occurrence: 0, resumeKind: "continue", dispatchProof: "reconcilePlanChecklistCommand.test.ts: linkManualChecks dispatches the stage's next action after linking" },
  { file: "commands/reconcilePlanChecklist.ts", optionId: "reconcile", occurrence: 0, resumeKind: "continue", dispatchProof: "reconcilePlanChecklistCommand.test.ts: reconcile dispatches the stage's next action" },
  { file: "commands/reconcilePlanChecklist.ts", optionId: "notYet", occurrence: 0, resumeKind: "unpause", dispatchProof: "reconcilePlanChecklistCommand.test.ts: notYet dispatches nothing" },

  // src/commands/applyReviewerVerifiedTicks.ts
  { file: "commands/applyReviewerVerifiedTicks.ts", optionId: "apply", occurrence: 0, resumeKind: "continue", dispatchProof: "applyReviewerVerifiedTicksCommand.test.ts: apply dispatches the stage's next action after ticking" },
  { file: "commands/applyReviewerVerifiedTicks.ts", optionId: "skip", occurrence: 0, resumeKind: "unpause", dispatchProof: "applyReviewerVerifiedTicksCommand.test.ts: skip dispatches nothing" },

  // src/commands/reviewActions.ts
  { file: "commands/reviewActions.ts", optionId: "retry", occurrence: 0, resumeKind: "continue", dispatchProof: "reviewEscalation.test.ts / reviewRouting.test.ts: retry re-dispatches the stage action" },
  { file: "commands/reviewActions.ts", optionId: "adjustSettings", occurrence: 0, resumeKind: "unpause", dispatchProof: "reviewEscalation.test.ts: adjustSettings opens settings, dispatches nothing" },
  { file: "commands/reviewActions.ts", optionId: "wait", occurrence: 0, resumeKind: "unpause", dispatchProof: "reviewEscalation.test.ts: wait dispatches nothing" },
  { file: "commands/reviewActions.ts", optionId: "stay", occurrence: 0, resumeKind: "unpause", dispatchProof: "reviewEscalation.test.ts: stay dispatches nothing" },
  { file: "commands/reviewActions.ts", optionId: "goToReviewAndApply", occurrence: 0, resumeKind: "continue", dispatchProof: "reviewRouting.test.ts / commandArgNormalization.test.ts: goToReviewAndApply dispatches goToReviewAndApplyV1" },
  { file: "commands/reviewActions.ts", optionId: "notNow", occurrence: 0, resumeKind: "unpause", dispatchProof: "reviewRouting.test.ts: notNow dispatches nothing" },
  { file: "commands/reviewActions.ts", optionId: "goToReviewAndApply", occurrence: 1, resumeKind: "continue", dispatchProof: "reviewRouting.test.ts: goToReviewAndApply (second card site) dispatches goToReviewAndApplyV1" },
  { file: "commands/reviewActions.ts", optionId: "notNow", occurrence: 1, resumeKind: "unpause", dispatchProof: "reviewRouting.test.ts: notNow (second card site) dispatches nothing" },
  { file: "commands/reviewActions.ts", optionId: "goToReviewAndApply", occurrence: 2, resumeKind: "continue", dispatchProof: "reviewRouting.test.ts: goToReviewAndApply (third card site) dispatches goToReviewAndApplyV1" },
  { file: "commands/reviewActions.ts", optionId: "letItRun", occurrence: 0, resumeKind: "continue", dispatchProof: "reviewRouting.test.ts: letItRun leaves the running round to finish — the process continues" },

  // src/commands/scheduleTaskResume.ts
  { file: "commands/scheduleTaskResume.ts", optionId: "resumeAndRerun", occurrence: 0, resumeKind: "continue", dispatchProof: "scheduleTaskResume.test.ts: resumeAndRerun dispatches the stage's current action" },
  { file: "commands/scheduleTaskResume.ts", optionId: "handleMyself", occurrence: 0, resumeKind: "unpause", dispatchProof: "scheduleTaskResume.test.ts: handleMyself leaves task paused" },
  { file: "commands/scheduleTaskResume.ts", optionId: "restoreSummary", occurrence: 0, resumeKind: "continue", dispatchProof: "scheduleTaskResume.test.ts: restoreSummary dispatches the restore then the stage's action" },
  { file: "commands/scheduleTaskResume.ts", optionId: "handleMyself", occurrence: 1, resumeKind: "unpause", dispatchProof: "scheduleTaskResume.test.ts: handleMyself variant leaves task paused" },
  { file: "commands/scheduleTaskResume.ts", optionId: "waitForRetry", occurrence: 0, resumeKind: "unpause", dispatchProof: "scheduleTaskResume.test.ts: waitForRetry dispatches nothing (retry already scheduled)" },
  { file: "commands/scheduleTaskResume.ts", optionId: "runNow", occurrence: 0, resumeKind: "continue", dispatchProof: "scheduleTaskResume.test.ts: runNow dispatches immediately" },
  { file: "commands/scheduleTaskResume.ts", optionId: "waitForRetry", occurrence: 1, resumeKind: "unpause", dispatchProof: "scheduleTaskResume.test.ts: waitForRetry (quota variant) dispatches nothing" },
  { file: "commands/scheduleTaskResume.ts", optionId: "runNow", occurrence: 1, resumeKind: "continue", dispatchProof: "scheduleTaskResume.test.ts: runNow (quota variant) dispatches immediately" },

  // src/commands/handoffChecksV1.ts
  { file: "commands/handoffChecksV1.ts", optionId: "tick-${index}", occurrence: 0, resumeKind: "continue", dispatchProof: "handoffChecksV1 tick options re-post the successor card or dispatch the stage action" },
  { file: "commands/handoffChecksV1.ts", optionId: "acceptRest", occurrence: 0, resumeKind: "continue", dispatchProof: "handoffChecksV1 acceptRest dispatches the stage action once nothing remains" },
  { file: "commands/handoffChecksV1.ts", optionId: "notYet", occurrence: 0, resumeKind: "unpause", dispatchProof: "handoffChecksV1 notYet dispatches nothing" },

  // src/runners/copilotImplementationRunner.ts
  { file: "runners/copilotImplementationRunner.ts", optionId: "continue", occurrence: 0, resumeKind: "continue", dispatchProof: "copilot runner: continue option resumes the round" },
  { file: "runners/copilotImplementationRunner.ts", optionId: "cancel", occurrence: 0, resumeKind: "unpause", dispatchProof: "copilot runner: cancel option dispatches nothing further" },

  // src/utils/quota.ts
  { file: "utils/quota.ts", optionId: "resume", occurrence: 0, resumeKind: "continue", dispatchProof: "quota resume dispatches once credits restore" },
  { file: "utils/quota.ts", optionId: "switch", occurrence: 0, resumeKind: "unpause", dispatchProof: "quota switch opens settings, dispatches nothing" },

  // src/commands/planRevisionV1.ts
  { file: "commands/planRevisionV1.ts", optionId: "revise", occurrence: 0, resumeKind: "continue", dispatchProof: "planRevisionV1.test.ts: revise dispatches Generate Plan after the stage move" },
  { file: "commands/planRevisionV1.ts", optionId: "discard", occurrence: 0, resumeKind: "unpause", dispatchProof: "planRevisionV1.test.ts: discard leaves plan-final.md untouched, dispatches nothing" },

  // src/runners/runnerRegistry.ts
  { file: "runners/runnerRegistry.ts", optionId: "rerunAfterReset", occurrence: 0, resumeKind: "continue", dispatchProof: "runnerRegistry: rerunAfterReset dispatches a fresh round after reset" },
  { file: "runners/runnerRegistry.ts", optionId: "notNow", occurrence: 0, resumeKind: "unpause", dispatchProof: "runnerRegistry: notNow dispatches nothing" },

  // src/commands/implementationRecoveryV1.ts
  { file: "commands/implementationRecoveryV1.ts", optionId: "keep", occurrence: 0, resumeKind: "unpause", dispatchProof: "implementationRecoveryV1: keep dispatches nothing (user decision recorded, no automation follow-up)" },
  { file: "commands/implementationRecoveryV1.ts", optionId: "restore", occurrence: 0, resumeKind: "unpause", dispatchProof: "implementationRecoveryV1: restore dispatches nothing (user decision recorded, no automation follow-up)" },
];

function readAllInventoryFiles(): Map<string, ExtractedOption[]> {
  const byFile = new Map<string, ExtractedOption[]>();
  for (const relPath of new Set(INVENTORY.map((row) => row.file))) {
    byFile.set(relPath, extractOptions(path.join(SRC_ROOT, relPath)));
  }
  return byFile;
}

/**
 * Review finding, 2026-09-23 (completion blocker, new): everything above this
 * point compares one piece of source TEXT (the option literal's `resumeKind`)
 * against another piece of source text (this table's own `resumeKind`
 * column) — it never invokes anything, and never looks at whether choosing
 * the option actually dispatches (or does not dispatch) further work. That
 * is a real gap: the whole point of `resumeKind` is a claim about RUNTIME
 * behaviour ("this option's command arranges work" / "this option does
 * not"), and a table that only re-derives the label from itself cannot catch
 * a builder whose `resumeKind` and `effect` have drifted apart, or a
 * `dispatchProof` reference that does not actually exist.
 *
 * What follows closes that gap in the way that is actually possible from a
 * single aggregate test file, having read every production option builder
 * and the scattered per-file tests directly (not merely their names) to
 * classify each row into exactly one of three verified buckets:
 *
 * 1. `RuntimeTestEvidenceV1` — a genuine, already-existing test in the named
 *    file(s) calls the REAL production function that builds this decision
 *    (not a literal re-typed here) and asserts, at runtime, on the actual
 *    `.effect` it returned or on a captured `vscode.commands.executeCommand`
 *    dispatch made while exercising it. This test locates that assertion by
 *    reading the CURRENT content of the named file at test time — a
 *    regression that deletes the dispatch assertion (leaving only a
 *    resumeKind check) fails this test, which the old version could not do.
 *    Verified present for: reviewEscalation.ts (all rows except
 *    switchStageModel, whose card-level effect is checked directly below),
 *    reconcilePlanChecklist.ts, applyReviewerVerifiedTicks.ts,
 *    reviewActions.ts's card options routed through reviewEscalation.test.ts
 *    / reviewRouting.test.ts / commandArgNormalization.test.ts,
 *    scheduleTaskResume.ts, and planRevisionV1.ts (confirmed directly:
 *    `src/test/planRevisionV1.test.ts:1119-1199` calls the real
 *    `reviseChecklistChangeProposalConfirmedV1` / `discardChecklistChangeProposalConfirmedV1`
 *    and asserts on a captured `executeCommand("vs-code-ai-helper.generatePlanWithAI")`).
 *
 * 2. `TrivialNoDispatchEvidenceV1` — the option's own `effect` is
 *    `{ kind: "doNothing" }`, which by the type's own definition dispatches
 *    nothing; no further test is needed to prove a negative that the type
 *    system already guarantees. This still needs the row's ACTUAL current
 *    `effect.kind` re-extracted from source (not merely trusted), so a
 *    future change from `doNothing` to a real command without updating this
 *    table is caught.
 *
 *    Two rows use `doNothing` on BOTH sides of a `continue`/`unpause` pair —
 *    `copilotImplementationRunner.ts`'s `continue`/`cancel` and
 *    `quota.ts`'s `resume`/`switch`. Read directly
 *    (`copilotImplementationRunner.ts:770-799`, `quota.ts:550-611`): both are
 *    posted through `awaitWorkflowDecisionAnswerV1`/`handleQuotaFailure`,
 *    which AWAIT the chosen `optionId` in-process and return it directly to
 *    the calling loop — the loop itself (not a dispatched command) is what
 *    continues or stops. `doNothing` is correct on `effect` for both options
 *    of that pair; the distinguishing "continue" vs "unpause" fact lives in
 *    the caller reading the returned optionId, not in `effect`.
 *
 *    Review fix, 2026-09-24: `quota.ts`'s pair moved to bucket 1 —
 *    `quotaHandleQuotaFailureDispatchV1.test.ts` calls the real
 *    `handleQuotaFailure` and proves what it actually returns for each
 *    answer, which IS the return-to-caller contract `resumeKind` describes
 *    here (see `DISPATCH_ASSERTION_PATTERN`'s third accepted shape, above).
 *
 *    Review fix, 2026-09-24 (continued): `copilotImplementationRunner.ts`'s
 *    `continue`/`cancel` also moved to bucket 1. The round-limit decision was
 *    extracted out of `runImplementationWithCopilot`'s tool-call loop into
 *    its own exported `resolveRoundLimitDecisionV1`, specifically so it could
 *    be called directly — the same "no scattered test exercises the loop
 *    itself branching on the answer" gap `quota.ts` had, closed the same way:
 *    `copilotRoundLimitDecisionV1.test.ts` calls the real
 *    `resolveRoundLimitDecisionV1`, answers its posted
 *    `implementationRoundLimitReached` decision through the store, and
 *    asserts what it actually RETURNS ("Continue" for 'continue', "Cancel"
 *    for 'cancel') — the exact contract `resumeKind` describes for this
 *    doNothing-in-a-loop shape. No `known-gap` rows remain in this table.
 *
 * 3. `KnownGapEvidenceV1` — no scattered runtime test exists AND the effect
 *    is not `doNothing`, so the classification rests on reading the actual
 *    production handler directly, once, this session, with a citation.
 *
 *    (Previously recorded here as open gaps, now closed:
 *      - `handoffChecksV1.ts`'s `tick-${index}` and `acceptRest` were
 *        classified `continue` with no dispatch behind them, since Step 5's
 *        "try again" dispatch for these two was Part 12/Step 39 work. That
 *        gap is closed: `settleAndRepostV1` (`handoffChecksV1.ts`) now calls
 *        the new `HandoffCommandIoV1.dispatchStageAction` once nothing
 *        remains outstanding after a genuine tick, wired in production to
 *        `vs-code-ai-helper.resumeAndApplyCurrentStageAction` — the same
 *        "adjustment succeeds -> dispatch the current stage's next action"
 *        primitive Step 5's other three builders already use. Both rows
 *        moved to bucket 1 below, proven by `handoffOnlyStopV1.test.ts`.
 *      - Review fix, 2026-09-24: `runnerRegistry.ts`'s `rerunAfterReset` and
 *        `implementationRecoveryV1.ts`'s `restore` were handler-traced only
 *        (a citation, not a runtime dispatch proof). Both moved to bucket 1:
 *        `scheduleTaskResume.test.ts` now drives the REAL registered
 *        `vs-code-ai-helper.scheduleQuotaResumeV1` command with
 *        `rerunAfterReset`'s exact args and asserts the scheduledRun it
 *        actually produces; `restoreRejectedImplementationRound.test.ts`'s
 *        "does NOT re-invoke anything when no rerun command id is supplied"
 *        test drives the REAL registered
 *        `vs-code-ai-helper.restoreRejectedImplementationRound` command with
 *        `restore`'s exact 2-element args and proves nothing further
 *        dispatches. The handler-chain-shape tests below are kept as
 *        supplementary structural regression guards, not the sole evidence.
 *        No `known-gap` rows remain in this table.)
 */

type RowKey = string; // `${file}::${optionId}::${occurrence}`

function rowKey(file: string, optionId: string, occurrence: number): RowKey {
  return `${file}::${optionId}::${occurrence}`;
}

interface RuntimeTestEvidenceV1 {
  readonly kind: "runtime-test";
  /** Relative to src/test/. At least one must contain a genuine dispatch assertion for this optionId. */
  readonly proofFiles: readonly string[];
  /**
   * Extra search anchors besides the optionId and its own effect.command —
   * for rows whose proof test calls the production dispatch function
   * directly and never mentions the optionId string at all (e.g.
   * `reviseChecklistChangeProposalConfirmedV1` never appears as `"revise"`
   * in `planRevisionV1.test.ts`).
   */
  readonly extraAnchors?: readonly string[];
}

interface TrivialNoDispatchEvidenceV1 {
  readonly kind: "trivial-no-dispatch";
}

interface KnownGapEvidenceV1 {
  readonly kind: "known-gap";
  readonly reason: string;
}

type RowEvidenceV1 = RuntimeTestEvidenceV1 | TrivialNoDispatchEvidenceV1 | KnownGapEvidenceV1;

const ROW_EVIDENCE: ReadonlyMap<RowKey, RowEvidenceV1> = new Map<RowKey, RowEvidenceV1>([
  [rowKey("utils/reviewEscalation.ts", "advance", 0), { kind: "runtime-test", proofFiles: ["reviewEscalation.test.ts", "commandArgNormalization.test.ts"] }],
  [rowKey("utils/reviewEscalation.ts", "reconsiderRequirement", 0), { kind: "runtime-test", proofFiles: ["reviewEscalation.test.ts"] }],
  [rowKey("utils/reviewEscalation.ts", "keepIterating", 0), { kind: "runtime-test", proofFiles: ["reviewEscalation.test.ts"] }],
  [rowKey("utils/reviewEscalation.ts", "handleMyself", 0), { kind: "runtime-test", proofFiles: ["reviewEscalation.test.ts"] }],
  [rowKey("utils/reviewEscalation.ts", "switchStageModel", 0), { kind: "runtime-test", proofFiles: ["reviewEscalation.test.ts"] }],
  [rowKey("utils/reviewEscalation.ts", "keepIterating", 1), { kind: "runtime-test", proofFiles: ["reviewEscalation.test.ts"] }],
  [rowKey("utils/reviewEscalation.ts", "handleMyself", 1), { kind: "runtime-test", proofFiles: ["reviewEscalation.test.ts"] }],
  [rowKey("utils/reviewEscalation.ts", "publishAnyway", 0), { kind: "runtime-test", proofFiles: ["reviewEscalation.test.ts"] }],
  [rowKey("utils/reviewEscalation.ts", "acknowledgeAdvance", 0), { kind: "runtime-test", proofFiles: ["reviewEscalation.test.ts"] }],
  [rowKey("utils/reviewEscalation.ts", "handleMyself", 2), { kind: "runtime-test", proofFiles: ["reviewEscalation.test.ts"] }],

  [rowKey("commands/reconcilePlanChecklist.ts", "applyVerifiedTicks", 0), { kind: "runtime-test", proofFiles: ["reconcilePlanChecklistCommand.test.ts"] }],
  [rowKey("commands/reconcilePlanChecklist.ts", "linkManualChecks", 0), { kind: "runtime-test", proofFiles: ["reconcilePlanChecklistCommand.test.ts"] }],
  [rowKey("commands/reconcilePlanChecklist.ts", "reconcile", 0), { kind: "runtime-test", proofFiles: ["reconcilePlanChecklistCommand.test.ts"] }],
  // Corrected during verification: notYet's effect IS doNothing
  // (reconcilePlanChecklist.ts:1749), not a command — the original
  // dispatchProof column's "notYet dispatches nothing" was true but this
  // belongs in the trivial (type-guaranteed) bucket, not runtime-test.
  [rowKey("commands/reconcilePlanChecklist.ts", "notYet", 0), { kind: "trivial-no-dispatch" }],

  [rowKey("commands/applyReviewerVerifiedTicks.ts", "apply", 0), { kind: "runtime-test", proofFiles: ["applyReviewerVerifiedTicksCommand.test.ts"] }],
  // Corrected during verification: skip's effect IS doNothing
  // (applyReviewerVerifiedTicks.ts:222), not a command.
  [rowKey("commands/applyReviewerVerifiedTicks.ts", "skip", 0), { kind: "trivial-no-dispatch" }],

  [rowKey("commands/reviewActions.ts", "retry", 0), { kind: "runtime-test", proofFiles: ["reviewEscalation.test.ts", "reviewRouting.test.ts"] }],
  // Corrected during verification: no test file references
  // setStageBackupModel (adjustSettings's command) at all — the original
  // dispatchProof's "reviewEscalation.test.ts" citation was wrong (that
  // file covers reviewEscalation.ts's own adjustSettings-shaped options,
  // not this reviewActions.ts one). Handler-traced instead.
  // Review fix, 2026-09-24: both rows below now have a genuine runtime
  // assertion on the actual `.effect` the production `providerChainExhausted`
  // decision returns (providerChainExhaustion.test.ts), not merely a
  // resumeKind label — closing what was previously a known-gap citation.
  [rowKey("commands/reviewActions.ts", "adjustSettings", 0), {
    kind: "runtime-test",
    proofFiles: ["providerChainExhaustion.test.ts"],
  }],
  [rowKey("commands/reviewActions.ts", "wait", 0), {
    kind: "runtime-test",
    proofFiles: ["providerChainExhaustion.test.ts"],
  }],
  // Corrected during verification: stay's effect IS doNothing (reviewActions.ts:4951).
  [rowKey("commands/reviewActions.ts", "stay", 0), { kind: "trivial-no-dispatch" }],
  [rowKey("commands/reviewActions.ts", "goToReviewAndApply", 0), { kind: "runtime-test", proofFiles: ["reviewRouting.test.ts", "commandArgNormalization.test.ts"], extraAnchors: ["resumeIfPausedThenGoToReviewAndApplyV1"] }],
  // Corrected during verification: notNow's effect IS doNothing at both card sites.
  [rowKey("commands/reviewActions.ts", "notNow", 0), { kind: "trivial-no-dispatch" }],
  // All three goToReviewAndApply card sites dispatch the SAME command
  // (resumeIfPausedThenGoToReviewAndApply, verified: reviewActions.ts:8175,
  // :11433, :12991), so the ONE real dispatch test —
  // commandArgNormalization.test.ts's `resumeIfPausedThenGoToReviewAndApplyV1`
  // describe block — covers all three, not just the first. reviewRouting.test.ts
  // (the original sole citation for these two) only checks the CARD's option
  // literal is present, never a dispatch effect.
  [rowKey("commands/reviewActions.ts", "goToReviewAndApply", 1), { kind: "runtime-test", proofFiles: ["reviewRouting.test.ts", "commandArgNormalization.test.ts"], extraAnchors: ["resumeIfPausedThenGoToReviewAndApplyV1"] }],
  [rowKey("commands/reviewActions.ts", "notNow", 1), { kind: "trivial-no-dispatch" }],
  [rowKey("commands/reviewActions.ts", "goToReviewAndApply", 2), { kind: "runtime-test", proofFiles: ["reviewRouting.test.ts", "commandArgNormalization.test.ts"], extraAnchors: ["resumeIfPausedThenGoToReviewAndApplyV1"] }],
  // letItRun: re-verified 2026-09-24. Unlike copilotImplementationRunner.ts's
  // "continue" and quota.ts's original "resume" (both AWAITED by their caller,
  // which then branches on the returned optionId — a real fork only a runtime
  // test can prove), this decision is posted via a bare, un-awaited
  // `postWorkflowDecisionV1(...)` (reviewActions.ts, the preImplementationRouting
  // card) — fire-and-forget, never `awaitWorkflowDecisionAnswerV1`. The
  // calling code checks only whether `decision` is `undefined` (no extension
  // context to post through) and unconditionally "falls through to run
  // Implementation" either way — see the comment immediately after the
  // `postWorkflowDecisionV1` call ("this must not gate the current run").
  // No production code path ever reads WHICH option the user chooses, so
  // there is no fork left for a runtime test to exercise: the type system
  // (effect: doNothing) plus this call-shape fact together already guarantee
  // the already-running round is genuinely left alone whichever option is
  // picked, or before it is even answered. This is the same "genuinely
  // nothing to test" bar the trivial-no-dispatch bucket exists for.
  [rowKey("commands/reviewActions.ts", "letItRun", 0), { kind: "trivial-no-dispatch" }],

  [rowKey("commands/scheduleTaskResume.ts", "resumeAndRerun", 0), { kind: "runtime-test", proofFiles: ["scheduleTaskResume.test.ts"] }],
  // Corrected during verification: both handleMyself occurrences are
  // effect: { kind: "doNothing" } (scheduleTaskResume.ts:154, :228).
  [rowKey("commands/scheduleTaskResume.ts", "handleMyself", 0), { kind: "trivial-no-dispatch" }],
  [rowKey("commands/scheduleTaskResume.ts", "restoreSummary", 0), { kind: "runtime-test", proofFiles: ["scheduleTaskResume.test.ts"] }],
  [rowKey("commands/scheduleTaskResume.ts", "handleMyself", 1), { kind: "trivial-no-dispatch" }],
  [rowKey("commands/scheduleTaskResume.ts", "waitForRetry", 0), { kind: "runtime-test", proofFiles: ["scheduleTaskResume.test.ts"] }],
  [rowKey("commands/scheduleTaskResume.ts", "runNow", 0), { kind: "runtime-test", proofFiles: ["scheduleTaskResume.test.ts"] }],
  [rowKey("commands/scheduleTaskResume.ts", "waitForRetry", 1), { kind: "runtime-test", proofFiles: ["scheduleTaskResume.test.ts"] }],
  [rowKey("commands/scheduleTaskResume.ts", "runNow", 1), { kind: "runtime-test", proofFiles: ["scheduleTaskResume.test.ts"] }],

  // handoffChecksV1.ts: classified `continue` per the plan's Step 2
  // ("Ensemble performs the adjustment... after the adjustment succeeds,
  // dispatch the current stage's next action"). settleAndRepostV1 now calls
  // HandoffCommandIoV1.dispatchStageAction once nothing remains outstanding
  // after a genuine tick, wired in production to
  // vs-code-ai-helper.resumeAndApplyCurrentStageAction — proven by
  // handoffOnlyStopV1.test.ts's two dedicated dispatch tests.
  [rowKey("commands/handoffChecksV1.ts", "tick-${index}", 0), {
    kind: "runtime-test",
    proofFiles: ["handoffOnlyStopV1.test.ts"],
    extraAnchors: ["dispatchStageAction"],
  }],
  [rowKey("commands/handoffChecksV1.ts", "acceptRest", 0), {
    kind: "runtime-test",
    proofFiles: ["handoffOnlyStopV1.test.ts"],
    extraAnchors: ["dispatchStageAction"],
  }],
  // notYet: NOT doNothing (a decision must resolve to some effect when
  // chosen — handoffChecksV1.ts:119-120's own comment). Its command
  // (KEEP_COMMAND, i.e. keepHandoffChecksV1, handoffChecksV1.ts:289-298)
  // only re-posts the same card with whatever remains outstanding — it
  // arranges no new automation work, matching 'unpause'. Review fix,
  // 2026-09-24: handoffOnlyStopV1.test.ts's "Not yet" test now asserts
  // `captured` (HandoffCommandIoV1.dispatchStageAction calls) is empty,
  // proving the no-dispatch half directly rather than only citing the
  // handler's shape.
  [rowKey("commands/handoffChecksV1.ts", "notYet", 0), {
    kind: "runtime-test",
    proofFiles: ["handoffOnlyStopV1.test.ts"],
    extraAnchors: ["dispatchStageAction"],
  }],

  // copilotImplementationRunner.ts: both options are `doNothing` by design —
  // the choice is awaited in-process (awaitWorkflowDecisionAnswerV1) and
  // returned directly to the calling round-limit loop, which is what
  // actually continues or stops. Review fix, 2026-09-24: the decision was
  // extracted into its own exported `resolveRoundLimitDecisionV1` specifically
  // so it could be exercised directly; copilotRoundLimitDecisionV1.test.ts
  // now calls it for real and asserts what it actually returns for each
  // answer — closing what was previously an untested doNothing-in-a-loop gap,
  // the same way quota.ts's pair was closed below.
  [rowKey("runners/copilotImplementationRunner.ts", "continue", 0), {
    kind: "runtime-test",
    proofFiles: ["copilotRoundLimitDecisionV1.test.ts"],
  }],
  [rowKey("runners/copilotImplementationRunner.ts", "cancel", 0), {
    kind: "runtime-test",
    proofFiles: ["copilotRoundLimitDecisionV1.test.ts"],
  }],

  // quota.ts: same await-and-branch shape as the copilot runner above —
  // handleQuotaFailure (quota.ts:550) awaits the choice and returns
  // "resume" | "switch" directly to its caller's own retry logic. Review fix,
  // 2026-09-24: quotaHandleQuotaFailureDispatchV1.test.ts now calls the REAL
  // handleQuotaFailure, answers its posted decision through the store (same
  // mechanism a live chat panel uses), and asserts on what it actually
  // RETURNS — "resume" for 'resume' (with switchModel NOT invoked) and
  // "switch" for 'switch' (with switchModel invoked) — closing what was
  // previously an untested doNothing-in-a-loop gap.
  [rowKey("utils/quota.ts", "resume", 0), {
    kind: "runtime-test",
    proofFiles: ["quotaHandleQuotaFailureDispatchV1.test.ts"],
  }],
  [rowKey("utils/quota.ts", "switch", 0), {
    kind: "runtime-test",
    proofFiles: ["quotaHandleQuotaFailureDispatchV1.test.ts"],
  }],

  [rowKey("commands/planRevisionV1.ts", "revise", 0), { kind: "runtime-test", proofFiles: ["planRevisionV1.test.ts"] }],
  [rowKey("commands/planRevisionV1.ts", "discard", 0), { kind: "runtime-test", proofFiles: ["planRevisionV1.test.ts"] }],

  // runnerRegistry.ts: was a known-gap citing only the handler chain
  // (source-traced, not a runtime dispatch proof). Review fix, 2026-09-24:
  // scheduleTaskResume.test.ts's dedicated test now executes the REAL
  // registered "vs-code-ai-helper.scheduleQuotaResumeV1" command (via
  // registerScheduleTaskResumeCommand, the same registration extension.ts
  // performs) with this option's exact { taskFolderPath, resetAtIso } args
  // shape, and asserts the persisted scheduledRun/nextActor it actually
  // produced — closing the gap between "the option names this command" and
  // "choosing the option genuinely arms a scheduled action."
  [rowKey("runners/runnerRegistry.ts", "rerunAfterReset", 0), {
    kind: "runtime-test",
    proofFiles: ["scheduleTaskResume.test.ts"],
    extraAnchors: ["vs-code-ai-helper.scheduleQuotaResumeV1"],
  }],
  [rowKey("runners/runnerRegistry.ts", "notNow", 0), { kind: "trivial-no-dispatch" }],

  [rowKey("commands/implementationRecoveryV1.ts", "keep", 0), { kind: "trivial-no-dispatch" }],
  // implementationRecoveryV1.ts: was a known-gap citing only the handler's
  // `if (restored && rerunCommandId)` gate (source-traced). Review fix,
  // 2026-09-24: restoreRejectedImplementationRound.test.ts's "does NOT
  // re-invoke anything when no rerun command id is supplied (the plain
  // 'Discard Last Round' shape)" test drives the REAL registered
  // "vs-code-ai-helper.restoreRejectedImplementationRound" command with this
  // option's exact 2-element args shape (folderUri.fsPath, postRunReviewStage,
  // no third argument) and proves no further command fires — the genuine
  // 'unpause' proof, not merely a reading of the gate.
  [rowKey("commands/implementationRecoveryV1.ts", "restore", 0), {
    kind: "runtime-test",
    proofFiles: ["restoreRejectedImplementationRound.test.ts"],
    extraAnchors: ["vs-code-ai-helper.restoreRejectedImplementationRound"],
  }],
]);

/** The same brace-scoped extraction as {@link extractOptions}, generalized to find any object literal at an offset. */
function extractEffectFields(
  objectSource: string
): { effectKind: string | undefined; effectCommand: string | undefined; argsLength: number | undefined } {
  const effectBlock = enclosingBracedRegionAfter(objectSource, /effect:\s*\{/);
  if (effectBlock === undefined) {
    return { effectKind: undefined, effectCommand: undefined, argsLength: undefined };
  }
  const kindMatch = /kind:\s*["'`](command|doNothing)["'`]/.exec(effectBlock);
  // Literal string commands only — a `command:` naming a const
  // (`KEEP_COMMAND`) or a ternary between two literals yields `undefined`
  // here; callers fall back to the optionId anchor in that case.
  const commandMatch = /command:\s*["'`]([^"'`]+)["'`]/.exec(effectBlock);
  const argsMatch = /args:\s*\[/.exec(effectBlock);
  let argsLength: number | undefined;
  if (argsMatch) {
    // Count top-level comma-separated entries in the args array by brace/bracket depth.
    const start = argsMatch.index + argsMatch[0].length;
    let depth = 1;
    let i = start;
    let entries = effectBlock.slice(start).trim().startsWith("]") ? 0 : 1;
    for (; i < effectBlock.length && depth > 0; i++) {
      const ch = effectBlock[i];
      if (ch === "[" || ch === "{" || ch === "(") {
        depth++;
      } else if (ch === "]" || ch === "}" || ch === ")") {
        depth--;
      } else if (ch === "," && depth === 1) {
        entries++;
      }
    }
    argsLength = entries;
  }
  return { effectKind: kindMatch?.[1], effectCommand: commandMatch?.[1], argsLength };
}

function enclosingBracedRegionAfter(text: string, startPattern: RegExp): string | undefined {
  const m = startPattern.exec(text);
  if (!m) {
    return undefined;
  }
  const openIdx = m.index + m[0].length - 1; // the "{" itself
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === "{") {
      depth++;
    } else if (text[i] === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(openIdx, i + 1);
      }
    }
  }
  return undefined;
}

interface ExtractedEffectV1 {
  optionId: string;
  effectKind: string | undefined;
  effectCommand: string | undefined;
  argsLength: number | undefined;
}

/** Every real `effect: {...}` shape adjacent to each optionId occurrence, in document order. */
function extractEffects(filePath: string): ExtractedEffectV1[] {
  const text = fs.readFileSync(filePath, "utf8");
  const out: ExtractedEffectV1[] = [];
  const pattern = /optionId:\s*["'`]([^"'`]*)["'`]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const objectSource = enclosingObjectLiteral(text, match.index);
    if (objectSource === undefined || !/\beffect\s*:/.test(objectSource)) {
      continue;
    }
    out.push({ optionId: match[1] ?? "", ...extractEffectFields(objectSource) });
  }
  return out;
}

/**
 * The nearest enclosing `it(`/`void it(` test block containing a match at
 * `matchOffset` — from that line back to the last preceding `it(`/`void it(`
 * line, forward to the next `it(`/`void it(`/`describe(` line (exclusive).
 * A text-level approximation (not a parser), generous enough that a real
 * assertion anywhere in the surrounding test is found, while still bounding
 * the search to ONE test rather than the whole (often 1000+ line) file.
 */
function enclosingTestBlock(text: string, matchOffset: number): string {
  const lines = text.split("\n");
  const matchLine = text.slice(0, matchOffset).split("\n").length - 1;
  let startLine = 0;
  for (let i = matchLine; i >= 0; i--) {
    if (/^\s*(void\s+)?it\(/.test(lines[i] ?? "")) {
      startLine = i;
      break;
    }
  }
  let endLine = lines.length - 1;
  for (let i = matchLine + 1; i < lines.length; i++) {
    if (/^\s*(void\s+)?(it|describe)\(/.test(lines[i] ?? "")) {
      endLine = i - 1;
      break;
    }
  }
  return lines.slice(startLine, endLine + 1).join("\n");
}

/**
 * A genuine runtime dispatch/no-dispatch assertion — not merely a mention of
 * resumeKind or a label. Three shapes are accepted:
 *  - a captured-`executeCommand`/`.effect` style assertion (most rows), or
 *  - a direct `await` of the production dispatch/confirm function itself
 *    (identified by name ending `ConfirmedV1`/`DiscardV1`/`ReviseV1`, or the
 *    generic `*V1(` convention this codebase's command handlers use)
 *    FOLLOWED, within the same block, by a real `assert.` on the resulting
 *    state (e.g. `planRevisionV1.test.ts`'s "Discard" test calls
 *    `discardChecklistChangeProposalConfirmedV1` directly and then asserts
 *    `progress.currentStage`/`checklistChangeProposals` stayed as expected —
 *    a genuine runtime check of a real invocation, just without an
 *    `executeCommand` spy in the middle), or
 *  - an `await`-and-branch function (one that itself posts a
 *    `WorkflowDecisionV1` and awaits the answer, returning it directly to
 *    ITS OWN caller — `handleQuotaFailure`, `awaitWorkflowDecisionAnswerV1`
 *    callers) called WITHOUT an immediate `await` (it must stay pending
 *    while the test answers the decision from outside, exactly like
 *    `workflowDecisionAwaitAnswerV1.test.ts`'s own pattern), captured into a
 *    variable literally named `resultPromise`, later `await`ed, FOLLOWED by
 *    a real `assert.` on the resolved value (e.g.
 *    `quotaHandleQuotaFailureDispatchV1.test.ts`: `handleQuotaFailure`'s
 *    return value IS the "resume"/"switch" the caller receives back — the
 *    exact contract `resumeKind` describes for this doNothing-in-a-loop
 *    shape, so asserting on it is a genuine runtime proof even with no
 *    `.effect`/`executeCommand` in sight), or
 *  - a direct `await vscode.commands.executeCommand(...)` of the REAL
 *    registered command (via `register*Command(context, ...)`, not a spy) —
 *    the option's own effect dispatched for real, end to end — FOLLOWED,
 *    within the same block, by a real `assert.` on the resulting state (e.g.
 *    `scheduleTaskResume.test.ts`'s `rerunAfterReset` closure: it executes
 *    the literal `"vs-code-ai-helper.scheduleQuotaResumeV1"` command through
 *    `registerScheduleTaskResumeCommand` and asserts the persisted
 *    `scheduledRun`/`nextActor` it actually produced).
 */
const DISPATCH_ASSERTION_PATTERN =
  /assert[.\w]*\([^;]*?(\.effect\b|effect\.kind|executeCommand)|\.captured\.(find|some|length)|execCmd\.captured|resumeThenDispatch|dispatched\s*[=!]==?|(await\s+\w*(Confirmed|Discard|Revise)\w*V1\([\s\S]{0,600}?assert[.\w]*\()|(await\s+resultPromise\b[\s\S]{0,300}?assert[.\w]*\()|(await\s+vscode\.commands\.executeCommand\([\s\S]{0,600}?assert[.\w]*\()/;

/**
 * Whether the named test file contains a genuine dispatch-level assertion
 * for this option. A scattered test rarely re-types the option's `optionId`
 * literal — many call the production dispatch FUNCTION directly (e.g.
 * `reviseChecklistChangeProposalConfirmedV1`) and never mention "revise"
 * anywhere — so `anchors` accepts every string that could plausibly locate
 * the relevant test block: the optionId itself, the option's real
 * `effect.command` (when it is a literal), and any extra caller-supplied
 * anchor (a production function name the test is known to call).
 */
function fileHasDispatchAssertionFor(testFileRelName: string, anchors: readonly string[]): boolean {
  const filePath = path.join(SRC_ROOT, "test", testFileRelName);
  if (!fs.existsSync(filePath)) {
    return false;
  }
  const text = fs.readFileSync(filePath, "utf8");
  for (const anchor of anchors) {
    if (!anchor) {
      continue;
    }
    const escaped = anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // A bare identifier (a function name) is searched as a word boundary;
    // anything else (an optionId, which may contain characters like `-` or
    // `${`) is searched as a quoted string literal, matching how it appears
    // in source.
    const needle = /^[A-Za-z_$][\w$]*$/.test(anchor)
      ? new RegExp(`\\b${escaped}\\b`, "g")
      : new RegExp(`["'\`]${escaped}["'\`]`, "g");
    let m: RegExpExecArray | null;
    while ((m = needle.exec(text)) !== null) {
      const block = enclosingTestBlock(text, m.index);
      if (DISPATCH_ASSERTION_PATTERN.test(block)) {
        return true;
      }
    }
  }
  return false;
}

void describe(
  "decision-option resumeKind table — every builder in the Part 3 Step 2 inventory (pre-1.0.0 fixes register)",
  () => {
    void it("every inventory row's resumeKind matches its production literal, at its documented occurrence", () => {
      const byFile = readAllInventoryFiles();
      const failures: string[] = [];

      for (const row of INVENTORY) {
        const extracted = byFile.get(row.file);
        if (!extracted) {
          failures.push(`${row.file}: file not found or unreadable`);
          continue;
        }
        const candidates = extracted.filter((o) => o.optionId === row.optionId);
        const hit = candidates[row.occurrence];
        if (!hit) {
          failures.push(
            `${row.file}: expected optionId "${row.optionId}" occurrence #${row.occurrence} not found ` +
              `(only ${candidates.length} occurrence(s) present)`
          );
          continue;
        }
        if (hit.resumeKind !== row.resumeKind) {
          failures.push(
            `${row.file}:${hit.line} optionId "${row.optionId}" occurrence #${row.occurrence} ` +
              `has resumeKind "${hit.resumeKind}", expected "${row.resumeKind}" per the plan's Step 2 inventory ` +
              `(dispatch proof: ${row.dispatchProof})`
          );
        }
      }

      assert.deepEqual(failures, [], `inventory/table mismatches:\n${failures.join("\n")}`);
    });

    void it("every option literal actually present in an inventory file is accounted for by a table row", () => {
      const byFile = readAllInventoryFiles();
      const unaccounted: string[] = [];
      for (const [relPath, extracted] of byFile) {
        const expectedByOptionId = new Map<string, number>();
        for (const row of INVENTORY) {
          if (row.file !== relPath) {
            continue;
          }
          expectedByOptionId.set(row.optionId, (expectedByOptionId.get(row.optionId) ?? 0) + 1);
        }
        const actualByOptionId = new Map<string, number>();
        for (const opt of extracted) {
          actualByOptionId.set(opt.optionId, (actualByOptionId.get(opt.optionId) ?? 0) + 1);
        }
        for (const [optionId, count] of actualByOptionId) {
          const expected = expectedByOptionId.get(optionId) ?? 0;
          if (count !== expected) {
            unaccounted.push(
              `${relPath}: optionId "${optionId}" appears ${count} time(s) in source but the table has ${expected} row(s) for it`
            );
          }
        }
      }
      assert.deepEqual(
        unaccounted,
        [],
        `a new or removed option literal was found that the inventory table does not (yet) account for:\n${unaccounted.join("\n")}`
      );
    });

    void it("the table itself covers every file the plan's Step 2 inventory names", () => {
      const expectedFiles = [
        "utils/reviewEscalation.ts",
        "commands/reconcilePlanChecklist.ts",
        "commands/applyReviewerVerifiedTicks.ts",
        "commands/reviewActions.ts",
        "commands/scheduleTaskResume.ts",
        "commands/handoffChecksV1.ts",
        "runners/copilotImplementationRunner.ts",
        "utils/quota.ts",
        "commands/planRevisionV1.ts",
        "runners/runnerRegistry.ts",
        "commands/implementationRecoveryV1.ts",
      ];
      const tableFiles = new Set(INVENTORY.map((row) => row.file));
      for (const file of expectedFiles) {
        assert.ok(tableFiles.has(file), `expected the inventory table to include a row for ${file}`);
      }
    });
  }
);

void describe(
  "decision-option resumeKind table — runtime dispatch/no-dispatch evidence (review fix, 2026-09-23)",
  () => {
    void it("every inventory row has exactly one classified evidence entry — none silently unaccounted for", () => {
      const missing: string[] = [];
      for (const row of INVENTORY) {
        if (!ROW_EVIDENCE.has(rowKey(row.file, row.optionId, row.occurrence))) {
          missing.push(`${row.file} optionId "${row.optionId}" occurrence #${row.occurrence}`);
        }
      }
      assert.deepEqual(missing, [], `rows with no runtime evidence classification:\n${missing.join("\n")}`);
    });

    // A "continue" option's effect is allowed to be doNothing only when the
    // process being "continued" is one already running (an implementation
    // round, an in-process await-and-branch loop) rather than something this
    // option must itself dispatch. reviewActions.ts's "letItRun" moved to
    // trivial-no-dispatch above (2026-09-24): its decision is fire-and-forget,
    // never awaited by any caller, so there is no fork left to exercise.
    // quota.ts's "resume" and copilotImplementationRunner.ts's "continue" are
    // the two EXPLICIT, reviewed exceptions below, for the AWAITED-and-
    // branched shape: quotaHandleQuotaFailureDispatchV1.test.ts calls the
    // real handleQuotaFailure and asserts it returns "resume" (and never
    // invokes switchModel) once its posted decision is answered "resume";
    // copilotRoundLimitDecisionV1.test.ts calls the real
    // resolveRoundLimitDecisionV1 and asserts it returns "Continue" once its
    // posted decision is answered "continue" — genuine dispatch-observing
    // tests for these exact doNothing-in-a-loop rows.
    const CONTINUE_DONOTHING_EXCEPTIONS = new Set<RowKey>([
      rowKey("utils/quota.ts", "resume", 0),
      rowKey("runners/copilotImplementationRunner.ts", "continue", 0),
    ]);

    void it("every 'runtime-test' row's real effect.kind agrees with its resumeKind (continue never doNothing, unless it is an explicit already-running-process exception)", () => {
      const byFile = new Map<string, ReturnType<typeof extractEffects>>();
      const failures: string[] = [];
      for (const row of INVENTORY) {
        const key = rowKey(row.file, row.optionId, row.occurrence);
        const evidence = ROW_EVIDENCE.get(key);
        if (evidence?.kind !== "runtime-test") {
          continue;
        }
        if (!byFile.has(row.file)) {
          byFile.set(row.file, extractEffects(path.join(SRC_ROOT, row.file)));
        }
        const effects = byFile.get(row.file)!;
        const candidates = effects.filter((e) => e.optionId === row.optionId);
        const hit = candidates[row.occurrence];
        if (!hit) {
          failures.push(`${row.file}: could not re-extract effect for optionId "${row.optionId}" occurrence #${row.occurrence}`);
          continue;
        }
        if (row.resumeKind === "continue" && hit.effectKind === "doNothing" && !CONTINUE_DONOTHING_EXCEPTIONS.has(key)) {
          failures.push(
            `${row.file}: optionId "${row.optionId}" is classified "continue" (dispatches or schedules work) but ` +
              `its CURRENT effect is doNothing — this row is not in the doNothing-in-a-loop exception list, so a ` +
              `"continue" option here must have a real command effect.`
          );
        }
      }
      assert.deepEqual(failures, [], `effect/resumeKind mismatches:\n${failures.join("\n")}`);
    });

    void it("every 'trivial-no-dispatch' row's real effect.kind is genuinely doNothing", () => {
      const byFile = new Map<string, ReturnType<typeof extractEffects>>();
      const failures: string[] = [];
      for (const row of INVENTORY) {
        const evidence = ROW_EVIDENCE.get(rowKey(row.file, row.optionId, row.occurrence));
        if (evidence?.kind !== "trivial-no-dispatch") {
          continue;
        }
        if (!byFile.has(row.file)) {
          byFile.set(row.file, extractEffects(path.join(SRC_ROOT, row.file)));
        }
        const effects = byFile.get(row.file)!;
        const hit = effects.filter((e) => e.optionId === row.optionId)[row.occurrence];
        if (hit?.effectKind !== "doNothing") {
          failures.push(
            `${row.file}: optionId "${row.optionId}" is classified trivial-no-dispatch (must be effect: {kind: "doNothing"}) ` +
              `but its current effect.kind is "${hit?.effectKind}"`
          );
        }
      }
      assert.deepEqual(failures, [], `trivial-no-dispatch rows whose real effect is no longer doNothing:\n${failures.join("\n")}`);
    });

    void it("every 'runtime-test' row has a REAL dispatch/no-dispatch assertion in at least one of its named proof files, verified against the file's CURRENT content", () => {
      const byFile = new Map<string, ReturnType<typeof extractEffects>>();
      const failures: string[] = [];
      for (const row of INVENTORY) {
        const evidence = ROW_EVIDENCE.get(rowKey(row.file, row.optionId, row.occurrence));
        if (evidence?.kind !== "runtime-test") {
          continue;
        }
        if (!byFile.has(row.file)) {
          byFile.set(row.file, extractEffects(path.join(SRC_ROOT, row.file)));
        }
        const hit = byFile.get(row.file)!.filter((e) => e.optionId === row.optionId)[row.occurrence];
        const anchors = [row.optionId, hit?.effectCommand, ...(evidence.extraAnchors ?? [])].filter(
          (a): a is string => a !== undefined
        );
        const found = evidence.proofFiles.some((f) => fileHasDispatchAssertionFor(f, anchors));
        if (!found) {
          failures.push(
            `${row.file} optionId "${row.optionId}" occurrence #${row.occurrence}: none of [${evidence.proofFiles.join(", ")}] ` +
              "contains a genuine dispatch-level assertion (an .effect/executeCommand/captured check) for this optionId — " +
              "a resumeKind label alone is not evidence."
          );
        }
      }
      assert.deepEqual(
        failures,
        [],
        `runtime-test rows with no discoverable dispatch assertion:\n${failures.join("\n")}\n\n` +
          "If the option is genuinely no longer covered by a real test, reclassify it as a 'known-gap' row " +
          "with a cited reason rather than leaving a stale 'runtime-test' claim."
      );
    });

    void it("runnerRegistry.ts's 'rerunAfterReset' handler-chain shape still matches live source (scheduleQuotaResumeV1 genuinely schedules) — supplementary to the runtime-test proof above", () => {
      const scheduleTaskResumeSrc = fs.readFileSync(path.join(SRC_ROOT, "commands/scheduleTaskResume.ts"), "utf8");
      const registration = /registerCommand\(\s*["'`]vs-code-ai-helper\.scheduleQuotaResumeV1["'`][\s\S]{0,400}?scheduleQuotaResumeAtV1\(/;
      assert.ok(
        registration.test(scheduleTaskResumeSrc),
        "expected scheduleQuotaResumeV1's registered handler to call scheduleQuotaResumeAtV1 — if this changed, " +
          "re-verify whether 'rerunAfterReset' still genuinely arranges a scheduled action"
      );
    });

    void it("implementationRecoveryV1.ts's 'restore' handler-chain shape still matches live source (2-element args, no rerunCommandId) — supplementary to the runtime-test proof above", () => {
      const implRecoverySrc = fs.readFileSync(path.join(SRC_ROOT, "commands/implementationRecoveryV1.ts"), "utf8");
      const restoreOption = extractEffects(path.join(SRC_ROOT, "commands/implementationRecoveryV1.ts")).find(
        (o) => o.optionId === "restore"
      );
      assert.ok(restoreOption, "expected an optionId \"restore\" in implementationRecoveryV1.ts");
      assert.equal(
        restoreOption.argsLength,
        2,
        "the 'restore' option's args array must stay at exactly 2 elements (no rerunCommandId) for the " +
          "'unpause' (no further dispatch) classification to hold — a 3rd element would need re-classifying as 'continue'"
      );
      const reviewActionsSrc = fs.readFileSync(path.join(SRC_ROOT, "commands/reviewActions.ts"), "utf8");
      assert.ok(
        /if\s*\(\s*restored\s*&&\s*rerunCommandId\s*\)/.test(reviewActionsSrc),
        "expected restoreRejectedImplementationRound's handler to still gate its re-dispatch on a supplied rerunCommandId"
      );
      void implRecoverySrc; // read for the args-length extraction above; kept for clarity of intent.
    });

    void it("handoffChecksV1.ts's settleAndRepostV1 genuinely dispatches the stage's next action once nothing remains outstanding", () => {
      const src = fs.readFileSync(path.join(SRC_ROOT, "commands/handoffChecksV1.ts"), "utf8");
      // Both tick and acceptRest settle through settleAndRepostV1 — confirm
      // it calls io.dispatchStageAction (not merely re-posts or informs) once
      // nothing remains outstanding after a genuine tick, closing the gap
      // this test used to only document as open.
      const settleFn = enclosingBracedRegionAfter(src, /async function settleAndRepostV1\([\s\S]*?\)[^{]*\{/);
      assert.ok(settleFn, "expected to find settleAndRepostV1's function body");
      assert.ok(
        /io\.dispatchStageAction\(/.test(settleFn),
        "settleAndRepostV1 no longer calls io.dispatchStageAction — 'tick-${index}'/'acceptRest' would regress " +
          "to a Part-12 gap; if this dispatch was deliberately removed, reclassify these two rows back to " +
          "'known-gap' with a fresh citation instead of leaving a stale 'runtime-test' claim"
      );
      // The production wiring (registerHandoffChecksCommandsV1) must route
      // that io method to the same "try again" primitive Step 5's other
      // three builders use, not a bespoke dispatch.
      assert.ok(
        /dispatchStageAction:\s*async[\s\S]{0,200}resumeAndApplyCurrentStageAction/.test(src),
        "expected registerHandoffChecksCommandsV1 to wire dispatchStageAction to " +
          "vs-code-ai-helper.resumeAndApplyCurrentStageAction"
      );
    });

    void it("copilotImplementationRunner.ts / quota.ts await-and-branch shape still holds (both sides of the pair are doNothing, consumed by the caller's own loop)", () => {
      const copilotSrc = fs.readFileSync(path.join(SRC_ROOT, "runners/copilotImplementationRunner.ts"), "utf8");
      assert.ok(
        /awaitWorkflowDecisionAnswerV1/.test(copilotSrc),
        "expected the round-limit decision to still be awaited in-process via awaitWorkflowDecisionAnswerV1"
      );
      const quotaSrc = fs.readFileSync(path.join(SRC_ROOT, "utils/quota.ts"), "utf8");
      assert.ok(
        /handleQuotaFailure[\s\S]{0,400}Promise<["'`]resume["'`]\s*\|\s*["'`]switch["'`]/.test(quotaSrc),
        "expected handleQuotaFailure to still return the awaited choice directly to its caller"
      );
    });
  }
);
