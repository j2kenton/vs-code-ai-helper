import * as vscode from "vscode";
import {
  EscalationKind,
  IMPL_REVIEW_STAGES,
  IMPLEMENTATION_SUMMARY_FILENAME,
  ImplementationDispatchModeV1,
  isPlanReviewStage,
  RoundOutcomeEntryV1,
  STAGE_ARTIFACT_FILENAMES,
  STAGE_DISPLAY_NAMES,
  STAGE_ORDER,
  TaskProgress,
  TaskStage,
} from "../types/taskProgress";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import { recordEscalation, updateTaskStatus } from "./taskProgressTransforms";
import { NotificationRouter } from "./notificationRouter";
import { isAutoAdvanceEnabled } from "../config/settings";
import { normalizePath } from "./taskRoot";
import {
  getFastForwardRunStateV1,
  isFastForwardRunActiveV1,
  stampFastForwardResumeProvenanceV1,
} from "./activeFastForwardRunsV1";
import { readTextIfExists } from "./fileUtils";
import {
  MANY_UNBUILT_ITEMS_THRESHOLD_V1,
  describeReviewRunSummaryV1,
  summarizeReviewRunV1,
} from "./reviewRunSummaryV1";
import {
  hasNarrowingPrefixV1,
  findNarrowingBlockerV1,
  findPlanStageNarrowingBlockerV1,
  narrowingReasonIsCheckedV1,
} from "./planItemNarrowingV1";
import { taskFixableAreAllUnbuiltWorkV1, isUnbuiltWorkBlockerV1 } from "./reviewRouting";
import {
  APPLY_REVIEW_NO_PROGRESS_ROUNDS_V1,
  applyReviewRoundsClosedNoneV1,
  describeApplyReviewNoProgressV1,
  isVerificationStallV1,
} from "./applyReviewProgressV1";
import { fixRoundSummaryV1 } from "./stageActionWordingV1";
import {
  classifyDeferredPlanScopeV1,
  extractCarriedGatesV1,
  gatesOutsideDeliverableV1,
  summarizeCarriedEvidenceV1,
  partitionCarriedEvidenceBlockersV1,
  type CarriedEvidenceSummaryV1,
  type CarriedGateV1,
  type DeferredPlanScopeV1,
  type ScopedItemListV1,
} from "./deferredPlanScopeV1";
import {
  isTestDependentChecklistItemV1,
  listProvisionalTickedItemsV1,
  normalizeChecklistItemTextV1,
  resolveBlockerPlanReferencesV1,
  resolveExcludedOwnerHandoffV1,
  resolveVerifiedCompleteEntryTextsV1,
} from "./implementationChecklist";
import { getCanonicalImplementationUri } from "./implementationArtifactResolver";
import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import { detectNarrowedBlockerV1, type NarrowedBlockerV1 } from "./blockerRuleNarrowingV1";
import * as path from "path";
import {
  AGENT_CAN_GATHER_RE,
  BlockerResolver,
  isEnvironmentalResolverV1,
  parseOwnerDecisionsNeededV1,
  parseReviewVerifiedCompleteV1,
  ReviewBlocker,
} from "./reviewReadiness";
import { KEEP_ITERATING_SEQUENCE_NOTE_V1 } from "./plateauFixCycleV1";
import { normalizeReviewEvidenceV1 } from "./reviewEvidenceNormalizerV1";
import {
  computePlanItemCountsV1,
  describeOpenAndHandOffsFromCountsV1,
  effectiveReviewProgressV1,
  readPlanItemCountsV1,
} from "./effectiveReviewProgress";
import { PostWorkflowDecisionInputV1, postWorkflowDecisionV1 } from "./workflowDecisionDispatchV1";
import {
  WorkflowDecisionOptionEffectV1,
  WorkflowDecisionOptionV1,
  WorkflowDecisionRecommendationV1,
} from "../types/workflowDecisionV1";
import { QuestionOptionV1, StructuredQuestionV1 } from "../types/structuredQuestionV1";
import { LOCAL_ONLY_INTERACTION_ACTION_KEY_V1 } from "./chatHistoryStore";
import { allocateHex128IdV1 } from "../types/actionCorrelationV1";
import { OWNER_EVIDENCE_ANSWER_MARKER_V1 } from "./ownerEvidenceV1";
import {
  findAllowlistedCommandInTextV1,
  RECORD_OWNER_RUN_COMMAND_V1,
  RUN_OWNER_EVIDENCE_COMMAND_V1,
} from "./ownerEvidenceCommandAllowlistV1";
import {
  buildOwnerEvidenceUpFrontQuestionsV1,
  listUnansweredOwnerEvidenceStepsAfterV1,
  listUnansweredOwnerEvidenceStepsV1,
  ownerEvidenceFormStepsV1,
  ownerEvidenceStepsKeyV1,
} from "./ownerEvidenceUpFrontV1";
import { getExtensionContextV1 } from "./extensionContextV1";
import { openPlanStageArgV1, optionAppliesAtStageV1, planFileNameForStageV1 } from "./optionAppliesAtStageV1";
import { blockerOwnerIdentityV1, hasPendingOwnerDecisionCardV1 } from "./ownerCardCoverageV1";
import {
  EnvironmentalEvidenceBlockerV1,
  EnvironmentalFailureEvidenceV1,
  extractEnvironmentalFailureEvidenceV1,
  formatEnvironmentReportV1,
  formatFailureReportV1,
} from "./environmentalFailureEvidenceV1";
import { resolveReadOnlyDiagnosisAvailabilityV1 } from "./readOnlyDiagnosisAvailabilityV1";
import { parseRecordedCompletionChecksEvidenceV1 } from "./completionLint";
import { reviewInputsChangedSinceV1 } from "./reviewInputsChangedV1";
import { advanceNeedsOpenItemsConfirmationV1, advanceOverOpenItemsLabelV1 } from "./advanceOverOpenItemsV1";
import { describeReviewedLineV1, filesPhraseV1, type ReviewCoverageSummaryV1 } from "./reviewCoverageV1";
import { readReviewCoverageSummaryV1 } from "./reviewCoverageIoV1";

/** Minimal shape this module needs from ChatViewProvider — avoids importing
 * the view layer from a utils module (chatView.ts pulls in webview/vscode UI
 * machinery reviewActions.ts and its callers don't otherwise depend on). */
export interface EscalationChatTarget {
  ask?(
    question: {
      canonicalId: string;
      taskFolderPath: string;
      stage: TaskStage;
      taskName?: string;
      question: string;
    },
    forceOpen?: boolean,
    notify?: { blocking?: boolean; blockedReason?: string }
  ): Promise<void>;
  /**
   * The no-context fallback's bound-answer channel (Part 10 items 13d/13e,
   * 2026-08-30 review blocker: this previously used a separate, app-only
   * `ask()` options-list mechanism instead of the same
   * `StructuredQuestionV1`/`askInteraction` channel every other question in
   * the product uses). Posts a `singleChoice` question with
   * `actionKey: LOCAL_ONLY_INTERACTION_ACTION_KEY_V1` — there is no
   * coordinator operation behind an escalation raised from here, so
   * `chatView.ts` settles it entirely on its own (see that constant's doc
   * comment) — and `optionEffects` carries the same command each option
   * would have run as a `WorkflowDecisionV1` card's option.
   */
  askInteraction(
    question: {
      canonicalId: string;
      taskFolderPath: string;
      stage: TaskStage;
      taskName?: string;
      interactionId: string;
      operationId: string;
      actionKey: string;
      sourceAttemptId: string;
      questions: readonly StructuredQuestionV1[];
      /** Omitted here: no coordinator operation exists to derive it from — `askInteraction` resolves it itself. */
      binding?: { readonly taskBindingId: string; readonly chatDocumentId: string };
      optionEffects?: Readonly<Record<string, WorkflowDecisionOptionEffectV1>>;
    },
    forceOpen?: boolean,
    notify?: { blocking?: boolean; blockedReason?: string }
  ): Promise<void>;
}

let chatTarget: EscalationChatTarget | undefined;

/**
 * Item 7b — the data a "plateau" (review-stuck) escalation needs to build a
 * `WorkflowDecisionV1` instead of a plain chat question naming only the
 * taxonomy of reasons automation can be stuck (environmental, unverifiable,
 * spec-defect, needs-toolchain) rather than the actual blocker. Supplied only
 * by review-stage plateau call sites that have this in hand from the round
 * that just published (`reviewActions.ts`'s `handleReviewRoutingOutcome`) —
 * the implementation-side no-progress breaker (a different phenomenon: zero
 * file changes across rounds, not a review's blocker list) does not have this
 * shape and keeps using the plain chat-question path below.
 */
export interface ReviewPlateauEvidenceV1 {
  /** The just-published review's raw markdown — consulted only for its
   * `<!-- progress: N/M -->` marker (see `normalizeReviewEvidenceV1`). */
  readonly content: string;
  readonly blockers: readonly ReviewBlocker[];
  readonly taskFixableCount: number;
  /**
   * RC2 item 7: how many of `blockers` were reclassified `environmental` this
   * round because they match a removal a prior implementer round declined
   * for lack of owner approval (`reclassifyDeclinedBlockersV1`,
   * reviewReadiness.ts). A positive count here, together with
   * `taskFixableCount === 0`, means EVERY task-fixable blocker was declined
   * rather than genuinely resolved — the plateau card must recommend
   * "Change the plan instead", not "Keep iterating", since iterating again
   * only re-runs the same declined round. Defaults to 0 for call sites that
   * predate this field (no behavior change there).
   */
  readonly declinedBlockerCount?: number;
  /**
   * `TaskProgress.roundOutcomes` for THIS stage, oldest-first, exactly as
   * recorded (item 17's `RoundOutcomeEntryV1.dispatchMode`) — not yet reduced
   * to "last N". Supplied by the caller because it already has the freshly
   * patched `TaskProgress` in hand; {@link recentDispatchModesForStageV1}
   * does the stage-filtering/windowing here so every call site does not have
   * to repeat it. Absent (older call sites, or a caller with no `TaskProgress`
   * handy) simply omits the evidence line below — a plateau escalation must
   * never fail to post for lack of this.
   */
  readonly stageRoundOutcomes?: readonly RoundOutcomeEntryV1[];
}

/** Last `limit` `dispatchMode`s recorded for `stage`, oldest-first, from
 * `TaskProgress.roundOutcomes` — the evidence a plateau escalation needs to
 * tell a DISPATCH plateau (the loop kept choosing Implementation against a
 * blocker only Apply Review can fix — see `detectPlateau`'s doc comment) from
 * a genuine WORK plateau apart. `undefined` entries (rows written before
 * `dispatchMode` existed) render as `"unknown"` rather than being dropped, so
 * the count of rounds shown still matches what actually ran.
 *
 * **Review blocker, 2026-08-26.** A zero-change/gate implementation round is
 * deliberately bookkept under the literal stage `"impl"` regardless of which
 * impl-review stage the task is currently displaying — see the
 * `appendRoundOutcome` call sites in `reviewActions.ts` (`gateStage`/
 * `implBookkeepingStage`), which exist so the fallback-provider breaker and
 * candidate-skip machinery can find a round dispatched while the task sits
 * on a review stage. A plain `entry.stage === stage` filter therefore made
 * every such round invisible to an `impl-high-review`/`impl-low-review`
 * card's "recent dispatch modes" evidence — undercounting exactly the rounds
 * most likely to show a dispatch plateau. For either impl-review stage, also
 * match rows stored under `"impl"`, merged back into the same chronological
 * (not `.slice(-limit)`-per-stage) window.
 *
 * **Review fix, 2026-08-27 (narrowed blocker 2).** A literal-"impl" row now
 * carries `originatingReviewStage` naming which of the two impl-review
 * stages was actually active when it was dispatched (see the comment on
 * `RoundOutcomeEntryV1.originatingReviewStage`). A literal-"impl" row is
 * merged into `stage`'s evidence only when `originatingReviewStage` is
 * either absent (older rows written before this field existed — kept
 * visible rather than silently dropped, matching this function's existing
 * policy of rendering an unknown `dispatchMode` as `"unknown"` instead of
 * excluding the round) or equal to `stage` — never when it names the OTHER
 * impl-review stage. This is what stops an `impl-low-review` plateau card
 * from absorbing a round that ran while the task displayed
 * `impl-high-review`, and vice versa. */
function mergedRecentDispatchEntriesForStageV1(
  roundOutcomes: readonly RoundOutcomeEntryV1[] | undefined,
  stage: TaskStage,
  limit: number
): readonly {
  readonly dispatchMode: ImplementationDispatchModeV1 | undefined;
  /** True when this entry is a literal-"impl" row merged into `stage`'s
   * evidence solely because it predates `originatingReviewStage` (an older
   * row, absent the field) — its true stage cannot be determined, so it is
   * shown in BOTH impl-review stages' evidence rather than either. */
  readonly originAmbiguous: boolean;
}[] {
  const isImplReviewStage = IMPL_REVIEW_STAGES.includes(stage);
  const matchesStage = isImplReviewStage
    ? (entry: RoundOutcomeEntryV1): boolean =>
        entry.stage === stage ||
        (entry.stage === "impl" &&
          (entry.originatingReviewStage === undefined || entry.originatingReviewStage === stage))
    : (entry: RoundOutcomeEntryV1): boolean => entry.stage === stage;
  return (roundOutcomes ?? [])
    .filter(matchesStage)
    .slice(-limit)
    .map((entry) => ({
      dispatchMode: entry.dispatchMode,
      originAmbiguous:
        isImplReviewStage && entry.stage === "impl" && entry.originatingReviewStage === undefined,
    }));
}

export function recentDispatchModesForStageV1(
  roundOutcomes: readonly RoundOutcomeEntryV1[] | undefined,
  stage: TaskStage,
  limit = 5
): readonly (ImplementationDispatchModeV1 | undefined)[] {
  return mergedRecentDispatchEntriesForStageV1(roundOutcomes, stage, limit).map(
    (entry) => entry.dispatchMode
  );
}

/**
 * True when {@link recentDispatchModesForStageV1}'s evidence window for
 * `stage` includes at least one literal-"impl" row recorded before
 * `originatingReviewStage` existed. That row's dispatch mode is merged into
 * BOTH impl-review stages' evidence (see the function above) because which
 * one it actually ran under cannot be determined from the data — a plateau
 * card's reader could otherwise mistake a mixed-origin count for a clean
 * same-stage history. Review blocker, 2026-08-27 (narrowed blocker 2):
 * "existing task history can still appear in both stage-specific evidence
 * windows without any indication that its origin is unknown" — this is the
 * indication; the merge policy itself (kept-visible over silently-excluded)
 * is unchanged and remains the documented, deliberate behavior.
 */
export function recentDispatchModesIncludeAmbiguousOriginV1(
  roundOutcomes: readonly RoundOutcomeEntryV1[] | undefined,
  stage: TaskStage,
  limit = 5
): boolean {
  return mergedRecentDispatchEntriesForStageV1(roundOutcomes, stage, limit).some(
    (entry) => entry.originAmbiguous
  );
}

function nextStageInOrderV1(stage: TaskStage): TaskStage | undefined {
  const index = STAGE_ORDER.indexOf(stage);
  return index === -1 || index === STAGE_ORDER.length - 1 ? undefined : STAGE_ORDER[index + 1];
}

/**
 * Every `decisionKey` an escalation card can be posted under — the generic
 * `buildEscalationDecisionV1` card (`reviewEscalation:<kind>`, one per
 * {@link EscalationKind}), the richer, evidence-led
 * `reviewPlateauEscalation` card `postReviewPlateauDecisionV1` posts for a
 * review-stage plateau with fresh blocker evidence in hand, and
 * `watchdogStalledEscalation` (`scheduleTaskResume.ts`'s
 * `buildStalledTaskEscalationDecisionV1`, v1 fixes item 1 Part 1a step 7) for
 * the stalled-task watchdog's own pause. Every escalation pauses the task as
 * part of raising it (`updateTaskStatus(..., "paused")` above, or —
 * `watchdogStalledEscalation`'s case — `pauseTaskWithReasonForClaimV1`), so
 * resuming the task is always the transition that ends whatever an
 * escalation card was asking — see `resumeTask.ts`'s `resumePausedTask`,
 * which clears `escalation` on resume and withdraws every one of these keys
 * in the same step (Part 11 item 13c, event-driven half).
 */
export const ESCALATION_DECISION_KEYS_V1: readonly string[] = [
  "reviewEscalation:plateau",
  "reviewEscalation:spec-defect",
  "reviewEscalation:environmental",
  "reviewPlateauEscalation",
  "watchdogStalledEscalation",
];

/**
 * Shared "advance" option shape between `buildEscalationDecisionV1` (below)
 * and `postReviewPlateauDecisionV1`'s richer, evidence-led card — both name
 * the same option id, the same label, and the same effect; the only thing
 * that legitimately differs per caller is the consequence text (the plateau
 * card's is evidence-conditioned on whether `nextStage` has already run
 * once). Review blocker (2026-08-30): the two functions used to construct
 * this object independently at each call site, which is exactly the "still
 * independently builds its options" defect the review named — this is the
 * part of that duplication that was genuinely identical and therefore safe
 * to share without altering either card's rendered text.
 *
 * Dispatches `resumeAndSetTaskStage`, not plain `setTaskStage` (review
 * blocker, 2026-08-30): every escalation pauses the task as part of raising
 * it, and `setTaskStage` resolves its target with `{ allowPaused: false }`,
 * so choosing this option against a still-paused task always failed with
 * "The task could not be found" — a real defect confirmed by direct reading
 * of `setTaskStage.ts`'s resolver call, not a hypothetical. Choosing Advance
 * is an unambiguous statement that the user wants to move past the pause, so
 * — per the same "do the whole thing" resolution `keepIterating` already
 * uses — this resumes first.
 */
/**
 * RC2 item 3: the sentence naming how many plan-of-record checklist items
 * are still open and that they will not be built at the destination stage —
 * appended to every "Advance" option's consequence whenever `planItemsOpen`
 * is positive, so the option can stay on the card (per the requirement,
 * "Advance may stay on the card as an option") without reading as though the
 * plan were finished. Empty string when there is nothing open to name.
 */
/**
 * bugs3 Step 7: how many of the plan's open items the task description or the
 * plan itself defers (they are shown as deferred and never hold a stage or
 * recommend Back to Implementation). Best effort: an unreadable plan or task
 * defers nothing.
 */
export async function readDeferredPlanScopeV1(folderUri: vscode.Uri): Promise<DeferredPlanScopeV1 | undefined> {
  try {
    const planText = await readTextIfExists(getCanonicalImplementationUri(folderUri));
    if (planText === undefined) {
      return undefined;
    }
    const taskMd = (await readTextIfExists(vscode.Uri.joinPath(folderUri, "task.md"))) ?? "";
    return classifyDeferredPlanScopeV1({ planText, taskMd });
  } catch {
    return undefined;
  }
}

/**
 * bugs3 Step 7: the owner gates the plan carries at `stage`. At a plan-review
 * stage every gate the plan marks open is carried; at any later stage only a
 * gate the deliverable does not depend on is (a gate whose dependent steps
 * were built or are authorized open work still holds them). The route
 * decision and the escalation card both read this, so they cannot disagree.
 */
export async function carriedGatesForStageV1(
  folderUri: vscode.Uri,
  stage: TaskStage,
  planText: string
): Promise<readonly CarriedGateV1[]> {
  if (isPlanReviewStage(stage)) {
    return extractCarriedGatesV1(planText);
  }
  return gatesOutsideDeliverableV1(
    classifyDeferredPlanScopeV1({
      planText,
      taskMd: (await readTextIfExists(vscode.Uri.joinPath(folderUri, "task.md"))) ?? "",
    })
  );
}

/**
 * bugs3 Step 7: the review's owner-evidence blockers that the plan carries to
 * named later steps, for the route decision at a plan-review stage or Publish
 * (where only a gate the deliverable does not depend on counts). Empty when
 * the plan cannot be read, so an unreadable plan holds the stage as before.
 */
export async function readCarriedGateBlockersV1(
  folderUri: vscode.Uri,
  stage: TaskStage,
  blockers: readonly ReviewBlocker[]
): Promise<readonly ReviewBlocker[]> {
  const atPlanReview = isPlanReviewStage(stage);
  if ((!atPlanReview && stage !== "publish") || blockers.length === 0) {
    return [];
  }
  try {
    const planText = await readTextIfExists(
      atPlanReview
        ? vscode.Uri.joinPath(folderUri, STAGE_ARTIFACT_FILENAMES.plan ?? "plan.md")
        : getCanonicalImplementationUri(folderUri)
    );
    if (planText === undefined) {
      return [];
    }
    const carriedGates = await carriedGatesForStageV1(folderUri, stage, planText);
    return partitionCarriedEvidenceBlockersV1(
      blockers,
      { carriedGates, ...(atPlanReview ? { planText } : {}) },
      (description) =>
        OWNER_EVIDENCE_PREFIX_RE.test(description) || classifyEnvironmentalBlockerV1(description) === "owner-evidence"
    ).carried;
  } catch {
    return [];
  }
}

export async function readDeferredOpenPlanItemCountV1(folderUri: vscode.Uri): Promise<number> {
  return (await readDeferredPlanScopeV1(folderUri))?.counts.deferred ?? 0;
}

/**
 * "What clears this" for blockers that are all owner evidence the plan defers
 * to later steps: the evidence is recorded when those steps run, so the stage
 * advances with the gate carried and the dependent steps stay gated.
 */
function describeCarriedGateClearingV1(summary: CarriedEvidenceSummaryV1, stageName: string): string {
  const steps = [...new Set(summary.gates.flatMap((gate) => gate.dependentSteps))].sort((a, b) => a - b);
  const named = steps.length > 0 ? ` (Step${steps.length === 1 ? "" : "s"} ${steps.join(", ")})` : "";
  const created = [...new Set(summary.gates.map((gate) => gate.createdResource).filter((r): r is string => !!r))];
  if (created.length > 0) {
    return (
      `this evidence is about ${created.join("; ")}, which the plan itself creates${named}, so it cannot exist at ` +
      `${stageName} and no one can gather it yet. Advance with the gate carried forward; the step that creates it ` +
      "records the evidence when it runs"
    );
  }
  return (
    `the plan already marks this owner evidence as an open gate that waits on later steps${named}, so ${stageName} ` +
    "is not held by it and it cannot be gathered yet. Advance with the gate carried forward; the steps that " +
    "depend on it stay gated until you record the evidence in task.md"
  );
}

/** A titled bullet list of carried (deferred or gated) items, or "" when there are none. */
function describeCarriedItemsV1(title: string, list: ScopedItemListV1 | undefined): string {
  if (!list || list.total === 0) {
    return "";
  }
  const bullets = list.items.map((item) => `- ${item}`).join("\n");
  const more = list.total > list.items.length ? `\n- …and ${list.total - list.items.length} more` : "";
  return `\n\n${title} — ${list.total}:\n\n${bullets}${more}`;
}

function describeOpenPlanItemsNoteV1(planItemsOpen: number | undefined, nextStageName: string): string {
  if (!planItemsOpen || planItemsOpen <= 0) {
    return "";
  }
  const plural = planItemsOpen === 1 ? "item is" : "items are";
  return ` ${planItemsOpen} plan ${plural} still open and will not be built at ${nextStageName}.`;
}

/**
 * review1 Step 57: the "accept it as environmental" move keeps the labelled override ("Move on, leaving N plan items
 * open") when it leaves High-Level Code Review with plan items open; otherwise it keeps its own label. The
 * environmental acceptance is still named in the consequence text.
 */
function withEnvironmentalAcceptLabelV1(
  option: WorkflowDecisionOptionV1,
  nextStage: TaskStage,
  planItemsOpen: number | undefined
): WorkflowDecisionOptionV1 {
  const isOverride = option.label !== `Advance to ${STAGE_DISPLAY_NAMES[nextStage]}`;
  return isOverride && planItemsOpen !== undefined && planItemsOpen > 0
    ? { ...option, consequence: `Accepts the environmental failure as well. ${option.consequence}` }
    : { ...option, label: "Accept it as environmental and continue" };
}

export function buildAdvanceOptionV1(
  nextStage: TaskStage,
  taskFolderPath: string,
  consequence: string,
  expectedSourceStage: TaskStage,
  planItemsOpen?: number
): WorkflowDecisionOptionV1 {
  // Item 14 / Part 3 Step 3: captured NOW, at card-build time, not re-derived
  // when the option is later chosen — by then the Fast Forward call stack
  // that may have raised this very card is long gone (see
  // activeFastForwardRunsV1.ts's doc comment). Baked into the option's own
  // args so `resumeAndSetTaskStageV1` knows, without guessing, whether
  // choosing "Advance" should continue fast-forwarding at the new stage or
  // just dispatch that stage's own default action.
  const resumeFastForward = isFastForwardRunActiveV1(taskFolderPath);
  const nextStageName = STAGE_DISPLAY_NAMES[nextStage];
  // 2026-09-2x review completion blocker: the ordinary (no Fast Forward to
  // continue) branch used to stop at the caller's stage-move-only prose,
  // naming no follow-up at all — the exact "moves the task to X" shape the
  // plan's own requirement forbids ("names what will run", not merely where
  // the task lands). `resumeAndSetTaskStageV1` dispatches
  // `loadResumeActionPlanV1`'s resolved action once the move lands, and — on
  // a `blocked`/`resume-only` result — dispatches nothing and hands the task
  // to the human instead (its own fix, same round). This sentence has to
  // stay true for BOTH outcomes without knowing which one will apply — the
  // resolution itself needs a fresh read of the destination stage's state,
  // which this synchronous builder has no access to (Part 3 Step 6's own,
  // still-open job) — so it names what decides the outcome instead of
  // guessing one, per the plan's own fallback ("or state what determines
  // it, rather than describing the dispatch mechanism").
  const ordinaryConsequence =
    `${consequence} Then dispatches ${nextStageName}'s own next action automatically — starting its review, or ` +
    "applying an existing review's findings — unless that stage's next step is yours, in which case nothing is " +
    "dispatched and it simply waits there for you.";
  const openItemsNote = describeOpenPlanItemsNoteV1(planItemsOpen, nextStageName);
  return {
    optionId: "advance",
    // review1 Step 57: while plan items are open, the move out of High-Level Code Review is offered only as the
    // labelled override, and choosing it asks the same pop-up as Complete Stage & Move On.
    label:
      planItemsOpen !== undefined &&
      planItemsOpen > 0 &&
      advanceNeedsOpenItemsConfirmationV1(expectedSourceStage, nextStage)
        ? advanceOverOpenItemsLabelV1(planItemsOpen)
        : `Advance to ${nextStageName}`,
    consequence:
      (resumeFastForward
        ? `${consequence} Continues fast-forwarding at ${nextStageName}.`
        : ordinaryConsequence) + openItemsNote,
    // Item 14: chosen during an interrupted Fast Forward run, this continues
    // fast-forwarding at the new stage rather than merely moving the field.
    resumeKind: "continue",
    effect: {
      kind: "command",
      command: "vs-code-ai-helper.resumeAndSetTaskStage",
      // Review blocker (2026-09-23, narrowed
      // c2453680-fe42-461b-9652-1f87445cb9d3-0): `expectedSourceStage` is the
      // stage this card was raised against (captured NOW, for the same
      // "don't re-derive it later" reason as `resumeFastForward` above). A
      // card answered after the task has since moved past ITS OWN
      // destination (not merely reached it) must not be treated as a fresh,
      // legitimate jump — `resumeAndSetTaskStageV1` uses this to refuse a
      // stale click rather than moving the task backward to `nextStage`.
      args: [{ taskFolderPath, stage: nextStage, resumeFastForward, expectedSourceStage }],
    },
  };
}

/**
 * RC2 item 3: the option a plateau or environmental-advance card offers
 * INSTEAD of Advance while the plan of record still has open checklist
 * items and nothing here is task-fixable — the requirement's "recommend the
 * action that builds the next items instead (Implementation, or Fast
 * Forward)". Always moves to Implementation (`impl`), regardless of the
 * stage the card was raised from: an impl-review plateau with open items
 * means the checklist still needs building, and Implementation is where
 * that happens. `resumeFastForward` is captured now, at card-build time,
 * like {@link buildAdvanceOptionV1}; at `impl` it makes
 * `resumeAndSetTaskStageV1` start the Implementation round itself (Fast
 * Forward Review refuses at Implementation), and the owner's
 * `autoReviewAfterImplementation` setting carries the run on.
 */
function buildBuildRemainingOptionV1(
  taskFolderPath: string,
  planItemsOpen: number,
  expectedSourceStage: TaskStage
): WorkflowDecisionOptionV1 {
  const resumeFastForward = isFastForwardRunActiveV1(taskFolderPath);
  const plural = planItemsOpen === 1 ? "item" : "items";
  const verb = planItemsOpen === 1 ? "is" : "are";
  return {
    optionId: "buildRemaining",
    label: `Build the ${planItemsOpen} open plan ${plural}`,
    resumeKind: "continue",
    consequence: resumeFastForward
      ? `Resumes the task, moves it to Implementation, and starts an Implementation round there; the review ` +
        `follows per your auto-review setting — ${planItemsOpen} ` +
        `plan ${plural} ${verb} still open.`
      : `Resumes the task, moves it to Implementation, and dispatches its next action there — ${planItemsOpen} ` +
        `plan ${plural} ${verb} still open.`,
    effect: {
      kind: "command",
      command: "vs-code-ai-helper.resumeAndSetTaskStage",
      args: [{ taskFolderPath, stage: "impl" as TaskStage, resumeFastForward, expectedSourceStage }],
    },
  };
}

/**
 * Shared "reconsiderRequirement" option shape — same rationale as
 * {@link buildAdvanceOptionV1}: both callers open plan-final.md's Accepted
 * Non-Goals section for the same reason (the requirement itself, not the
 * implementation, may need to change) and differ only in how specifically
 * the consequence text can name evidence for that (the plateau card knows
 * whether a `spec-defect`-classified blocker is actually present this round).
 */
function buildReconsiderRequirementOptionV1(
  taskFolderPath: string,
  consequence: string,
  stage?: TaskStage
): WorkflowDecisionOptionV1 {
  // review1 Step 38: at a plan stage plan-final.md does not exist; the plan the owner edits is plan.md.
  const planFile = planFileNameForStageV1(stage);
  return {
    optionId: "reconsiderRequirement",
    label: "Change the plan instead",
    consequence: planFile === "plan.md" ? consequence.replace(/plan-final\.md/g, "plan.md") : consequence,
    // The user edits Accepted Non-Goals themselves; Ensemble dispatches nothing.
    resumeKind: "unpause",
    effect: {
      kind: "command",
      command: "vs-code-ai-helper.openPlanNonGoals",
      args: [{ taskFolderPath, ...openPlanStageArgV1(stage) }],
    },
  };
}

/**
 * RC2 item 12: the plateau card's own "Keep iterating" option — pulled out
 * of {@link buildEscalationDecisionV1}'s plateau branch because it now has
 * two genuinely different shapes rather than one label ternary. When this
 * plateau interrupted a genuinely still-running Fast Forward loop (queried
 * live, at card-build time, exactly like {@link buildAdvanceOptionV1}'s own
 * `resumeFastForward` check — see `activeFastForwardRunsV1.ts`'s doc comment
 * for why this can't be re-derived later), the option resumes FAST FORWARD
 * itself from Apply Review, carrying the run's own live iteration counters
 * so the resumed loop continues the SAME attempt budget instead of starting
 * a fresh one. Outside Fast Forward, this is unchanged from before: a single
 * Apply Review + re-review cycle, now saying so explicitly in its own
 * consequence text per the requirement ("say in the option's text that it
 * runs one Apply Review and one re-review").
 */
function buildPlateauKeepIteratingOptionV1(
  taskFolderPath: string,
  stageName: string,
  taskFixableCount: number,
  blockersCount: number,
  stage?: TaskStage
): WorkflowDecisionOptionV1 {
  // bugs3 Step 4: what the fix round does depends on the stage — at a plan
  // stage it revises plan.md and edits no code.
  const fixClause = fixRoundSummaryV1(stage).labelClause;
  const fastForwardState = getFastForwardRunStateV1(taskFolderPath);
  if (fastForwardState) {
    return {
      optionId: "keepIterating",
      resumeKind: "continue",
      label:
        `Keep iterating: resume Fast Forward (iteration ${fastForwardState.attemptNumber} of ` +
        `${fastForwardState.maxAttempts}) from Apply Review`,
      consequence:
        `Resumes the task and continues Fast Forward from Apply Review (a round that ${fixClause}) against the ` +
        `${taskFixableCount} task-fixable ${taskFixableCount === 1 ? "blocker" : "blockers"}, then re-reviews ${stageName} ` +
        `after each round, at iteration ${fastForwardState.attemptNumber} of ${fastForwardState.maxAttempts} — it keeps ` +
        `iterating through the remaining attempt budget this run already committed to, rather than running just one ` +
        `more round. ${KEEP_ITERATING_SEQUENCE_NOTE_V1}`,
      effect: {
        kind: "command",
        command: "vs-code-ai-helper.resumeAndApplyCurrentStageAction",
        args: [
          {
            taskFolderPath,
            resumeFastForwardV1: {
              attemptNumber: fastForwardState.attemptNumber,
              maxAttempts: fastForwardState.maxAttempts,
              ...stampFastForwardResumeProvenanceV1(taskFolderPath, stage),
            },
          },
        ],
      },
    };
  }
  return {
    optionId: "keepIterating",
    // Resumes and dispatches Apply Review: continues the process.
    resumeKind: "continue",
    // v1 fixes 2, item 25: name the action, not just "Keep iterating".
    label:
      taskFixableCount > 0
        ? `Keep iterating: run Apply Review on the ${taskFixableCount} task-fixable ` +
          `${taskFixableCount === 1 ? "blocker" : "blockers"}`
        : "Keep iterating: run Apply Review",
    consequence:
      taskFixableCount > 0
        ? `Resumes the task and runs Apply Review against the ${taskFixableCount} task-fixable ` +
          `${taskFixableCount === 1 ? "blocker" : "blockers"} — a round that ${fixClause}, to address ` +
          `${taskFixableCount === 1 ? "it" : "them"}, then re-reviews ${stageName} for a fresh verdict. This runs ` +
          `one Apply Review and one re-review. ${KEEP_ITERATING_SEQUENCE_NOTE_V1}`
        : `Resumes the task and runs Apply Review — nothing to act on: 0 of the ${blockersCount} ` +
          "remaining blocker(s) are task-fixable, so this will most likely reproduce the same verdict. This runs " +
          "one Apply Review and one re-review.",
    // A1 (1.0.0 gate, Part C): NOT resumeAndRerunReviewV1 — a prior
    // revision of this option re-ran the REVIEW, which against an
    // unchanged tree reproduces the identical verdict by construction, so
    // "another round has real work to act on" (this option's own
    // rationale) was never actually true. resumeAndApplyCurrentStageActionV1
    // resumes AND dispatches Apply Review (edits the workspace against
    // these blockers, then re-reviews inline) — genuine work before the
    // next verdict, matching the text above.
    effect: {
      kind: "command" as const,
      command: "vs-code-ai-helper.resumeAndApplyCurrentStageAction",
      args: [{ taskFolderPath }],
    },
  };
}

/**
 * The precomputed, evidence-derived pieces `postReviewPlateauDecisionV1`
 * gathers (blocker text, progress marker, next-stage state, the clearing
 * note, recent dispatch modes) — everything that function's async I/O
 * (`readTextIfExists`, `normalizeReviewEvidenceV1`, `recentDispatchModesForStageV1`)
 * produces that {@link buildEscalationDecisionV1} needs to build the SAME
 * rich `reviewPlateauEscalation` card it used to build inline. Kept as a
 * plain data bag (not the raw `ReviewPlateauEvidenceV1`) so the builder stays
 * synchronous and does not need `folderUri`/plan-file access itself.
 */
export interface EscalationPlateauContextV1 {
  readonly blockersCount: number;
  readonly primaryBlockerDescription?: string;
  /**
   * Every blocker's own description, verbatim, in the same order as
   * `normalized.blockers` — 1.0.0 gate, Part 4 / Step 14 (B4), review finding
   * 2026-09-06: the card used to quote only `primaryBlockerDescription` and
   * summarize the rest as "and N more", which is not the concrete evidence
   * the requirement calls for. Empty when `blockersCount === 0`.
   */
  readonly allBlockerDescriptions: readonly string[];
  /**
   * review1 Step 50: the descriptions of the `needs-toolchain` blockers: commands the stage cannot run and the
   * owner runs outside the task. Each gets an "I ran it — record the result" option.
   */
  readonly needsToolchainBlockers?: readonly string[];
  /**
   * review1 Step 50: the stable identity (`blockerOwnerIdentityV1`, the lineage id when the review declared one) of
   * each entry of `needsToolchainBlockers`, same order. The owner's record is bound to it, so a reworded re-raise
   * still finds the record.
   */
  readonly needsToolchainBlockerIdentities?: readonly string[];
  /**
   * review1 Step 58: true when task.md, plan.md or plan-final.md changed since the review (Step 27's digest). The
   * card then offers "I've made changes — re-check" beside Keep iterating.
   */
  readonly reviewInputsChanged?: boolean;
  /** Appended immediately after the quoted blocker description; empty string when not narrowed. */
  readonly narrowedNote: string;
  readonly progressNote: string;
  readonly taskFixableCount: number;
  readonly hasSpecDefect: boolean;
  /**
   * RC2 item 7, Step 29: true when EVERY task-fixable blocker this round had
   * was reclassified `environmental` because it matches a removal a prior
   * implementer round already declined (see
   * `ReviewPlateauEvidenceV1.declinedBlockerCount`). Overrides the
   * recommendation to "Change the plan instead" ahead of the normal
   * `taskFixableCount > 0` check — recommending "Keep iterating" would only
   * dispatch the same round that already declined this exact blocker.
   */
  readonly hasDeclinedBlocker: boolean;
  /**
   * 1.0.0 gate, Part 4 / Step 14 (B4), review finding 2026-09-06: the
   * `escalate` route (reviewRouting.ts's `onlyNonFixableRemain`, or a
   * plateau that still carries a non-task-fixable blocker) can pause the
   * task with an environmental/unverifiable/spec-defect/needs-toolchain
   * blocker on record — the SAME kind of blocker `postEnvironmentalAdvanceNoticeV1`
   * warns about on the `advance-with-note` route. Without this, only the
   * threshold-met path told the user the blocker would gate Publish and
   * offered the "Publish Anyway" exit; the paused route left both out.
   */
  readonly hasNonFixableBlocker: boolean;
  readonly nextStageHasRun: boolean;
  readonly clearingNote: string;
  readonly dispatchModeEvidence: readonly { label: string; detail: string }[];
  /**
   * RC2 item 3: how many plan-of-record checklist items are still open,
   * from the same checklist-reconciled `effectiveReviewProgressV1` value
   * `progressNote` above is already rendered from — never the review's own
   * raw, self-chosen denominator. A plateau with real work still open must
   * never recommend (or let the user casually pick) "Advance" as though the
   * plan were finished; see `buildEscalationDecisionV1`'s plateau branch.
   */
  readonly planItemsOpen: number;
  /**
   * RC7 item 1: at least one blocker remains and every one clears only
   * through an owner decision (a narrowing, or owner evidence). The card
   * then never recommends Advance.
   */
  readonly allBlockersNeedOwnerDecision?: boolean;
  /**
   * bugs3 Step 7: every remaining blocker is owner evidence the plan already
   * defers to named later steps (a carried gate). The recommended option is
   * then the one that lets the task move — advance, gate carried forward —
   * not "Leave it paused".
   */
  readonly allBlockersCarriedGates?: boolean;
  /**
   * RC7 item 3: every reviewer-raised task-fixable blocker is a
   * `[completion]` blocker naming plan work that is still unbuilt
   * (`taskFixableAreAllUnbuiltWorkV1`).
   */
  readonly taskFixableAllUnbuiltWork?: boolean;
  /**
   * bugs4 item 18: a task-fixable blocker names unbuilt plan work (possibly beside a genuine
   * landed-work defect), so `taskFixableAllUnbuiltWork` is false but unbuilt work is still part of
   * the reason the stage is open.
   */
  readonly taskFixableIncludesUnbuiltWork?: boolean;
  /**
   * bugs5 Step 22: how many distinct open plan items the task-fixable unbuilt-work blockers name. At
   * {@link MANY_UNBUILT_ITEMS_THRESHOLD_V1} or more the card recommends Implementation, which builds
   * them all in one round, rather than an Apply Review per item.
   */
  readonly unbuiltItemsNamedCount?: number;
  /** bugs5 Step 22: one line on how far the run has got (rounds run, score range, settled items). */
  readonly runProgressNote?: string;
  /**
   * bugs4 items 18/21: how many of the most recent consecutive Apply Review rounds closed none of
   * the open plan items (`applyReviewRoundsClosedNoneV1`). Absent when not measured.
   */
  readonly applyReviewRoundsClosedNone?: number;
  /** Plan items ticked by a model but not yet verified; with a flat count this is a verification stall. */
  readonly provisionalTicks?: number;
  /**
   * bugs4 item 53: the latest review's own `## Verified Complete` block names every provisional
   * ticked item as built. A model tick alone is a claim, not evidence, so "nothing left to build"
   * needs this reviewer assertion; without it the open items are treated as possibly unbuilt.
   */
  readonly reviewAffirmsOpenItemsBuilt?: boolean;
  /** The specific open plan items (`Step N` or item text) that qualified
   * `taskFixableAllUnbuiltWork`; named in the recommendation's reason. */
  readonly unbuiltWorkReferences?: readonly string[];
  /** Deferrable, excluded owner checks offered the post-install move-on route. */
  readonly ownerChecksOwed?: readonly string[];
  /**
   * review2 Steps 18-19: how much of the change a review has read, from the per-file coverage record. Shown as
   * "Reviewed: N of M changed files"; when files are unreviewed the card offers "Review the remaining N files".
   */
  readonly coverage?: ReviewCoverageSummaryV1;
  /**
   * review2 Step 33: a blocker whose fixes have each closed part of it (see `detectNarrowedBlockerV1`). The card says
   * the rule may be missing and offers "Settle it with a rule".
   */
  readonly narrowedBlockerRule?: NarrowedBlockerV1;
  /**
   * RC4 item 3: set when a blocker asks the owner to narrow a plan item
   * (`findNarrowingBlockerV1`). Adds the item, the round's reason and its
   * evidence to the card, plus the "Accept this narrowing" / "Keep the item
   * open" options.
   */
  readonly narrowing?: {
    readonly itemText: string;
    readonly blockerDescription: string;
    readonly reason: string;
    readonly reasonSource: string;
    readonly evidence: string;
    readonly evidenceSource: string;
  };
}

/**
 * RC1 item 11: the one sentence that states how many remaining blockers
 * automation can still act on versus how many need the user — shared by
 * `whatHappened` and `whyUserNeeded` so they cannot disagree with each other
 * or with the "keep iterating" recommendation. Only called with a
 * `fixable > 0`; the `== 0` case keeps its existing sentences.
 * @internal exported for testing
 */
export function describeFixableSplitV1(fixable: number, total: number): string {
  const plural = total === 1 ? "blocker" : "blockers";
  return fixable >= total
    ? `Automation can still act on ${total === 1 ? "the" : "all"} ${total} ${plural}, but it stopped iterating.`
    : `Automation can still act on ${fixable} of the ${total} ${plural}; the other ${total - fixable} need you.`;
}

/**
 * bugs4 item 53: true only when the review's own `## Verified Complete` block names every one of
 * `itemTexts` (and there is at least one). A model tick is a claim; this is the reviewer's
 * assertion that the work is built, so it is the only thing that lets a card say "nothing left
 * to build".
 */
export function reviewNamesAllItemsBuiltV1(
  reviewContent: string,
  itemTexts: readonly string[],
  planText?: string
): boolean {
  if (itemTexts.length === 0) return false;
  // review1 (owner decision 2026-11-05): an entry citing an issued `[item:<id>]` (or a `Step N` naming one item)
  // names that item; with the plan text available it is read as the item's own text.
  const entries = parseReviewVerifiedCompleteV1(reviewContent).entries;
  const named = new Set(
    (planText ? resolveVerifiedCompleteEntryTextsV1(planText, entries).entries : entries).map((entry) =>
      normalizeChecklistItemTextV1(entry.text)
    )
  );
  return itemTexts.every((text) => named.has(normalizeChecklistItemTextV1(text)));
}

/**
 * bugs4 item 47: what the no-progress breaker card needs to agree with the gate
 * and the review instead of recommending more of the rounds that just changed
 * nothing. `planItemsOpen` is the gate's own open count.
 */
export interface BreakerCardContextV1 {
  readonly zeroChangeRounds: number;
  readonly planItemsOpen: number;
  /** The latest review's Verified Complete block names every ticked item the gate holds provisional. */
  readonly reviewAffirmsOpenItemsBuilt: boolean;
  /** Open items with no tick at all (neither a model claim nor an owner decision). */
  readonly unclaimedOpenItems: number;
  /**
   * The gate's own count, worded once for every card: "N open, of which M are owner hand-offs;
   * T ticked, V verified by review, …". Absent when the plan has no countable checklist.
   */
  readonly gateCountNote?: string;
}

/**
 * The breaker's recommendation. Iteration has just been shown to produce no edits, so "Keep
 * iterating" and "Back to Implementation" are never recommended. A review that met the pass mark
 * recommends advancing unless an open item is genuinely buildable (no claim, and not affirmed
 * built by the review); then it needs the owner.
 */
export function recommendForBreakerCardV1(
  breaker: BreakerCardContextV1,
  nextStageName: string | undefined
): WorkflowDecisionRecommendationV1 {
  const genuinelyBuildable = breaker.unclaimedOpenItems > 0 && !breaker.reviewAffirmsOpenItemsBuilt;
  if (nextStageName !== undefined && !genuinelyBuildable) {
    return {
      kind: "option",
      optionId: "advance",
      reasoning:
        `${breaker.zeroChangeRounds} implementation ${breaker.zeroChangeRounds === 1 ? "round" : "rounds"} in a row ` +
        `changed no files, so another one would not either. The latest review met the pass mark` +
        (breaker.planItemsOpen > 0
          ? `, and the ${breaker.planItemsOpen} open plan ${breaker.planItemsOpen === 1 ? "item is" : "items are"} ` +
            "already built and waiting only for verification"
          : "") +
        `, so advancing to ${nextStageName} is the way on.`,
    };
  }
  return {
    kind: "option",
    optionId: "handleMyself",
    reasoning:
      `${breaker.zeroChangeRounds} implementation ${breaker.zeroChangeRounds === 1 ? "round" : "rounds"} in a row ` +
      `changed no files, and ${breaker.unclaimedOpenItems} open plan ${breaker.unclaimedOpenItems === 1 ? "item has" : "items have"} ` +
      "no tick and no review confirmation that they are built. More automated rounds will not edit anything; " +
      "this needs your decision about those items.",
  };
}

function buildBreakerVerifiedTicksOptionV1(taskFolderPath: string): WorkflowDecisionOptionV1 {
  return {
    optionId: "applyReviewerVerifiedTicks",
    label: "Apply Reviewer-Verified Ticks",
    resumeKind: "unpause",
    consequence:
      "Records the items the latest review named as verified complete in plan-final.md, so the gate counts them. " +
      "The task stays paused; choose Advance afterwards.",
    effect: {
      kind: "command",
      command: "vs-code-ai-helper.applyReviewerVerifiedTicks",
      args: [{ taskFolderPath }],
    },
  };
}

/**
 * review1 Step 48: reads the recorded Verified Checks (the stage's review file, then publish-review.md) for the
 * failing check and the environment, and builds the environmental-failure card. Undefined when the latest review
 * recorded no environmental blocker, so an environmental stop with no blocker behind it keeps the generic card.
 */
async function buildEnvironmentalFailureCardForStageV1(
  folderUri: vscode.Uri,
  stage: TaskStage,
  reason: string,
  taskName: string | undefined,
  blockers: readonly EnvironmentalEvidenceBlockerV1[],
  planItemsOpen: number
): Promise<PostWorkflowDecisionInputV1 | undefined> {
  try {
    if (!blockers.some((b) => b.resolver === "environmental" || b.resolver === "environmental-fixable")) {
      return undefined;
    }
    let recorded: ReturnType<typeof parseRecordedCompletionChecksEvidenceV1>;
    for (const fileName of [STAGE_ARTIFACT_FILENAMES[stage], STAGE_ARTIFACT_FILENAMES.publish]) {
      if (!fileName) continue;
      const content = await readTextIfExists(vscode.Uri.joinPath(folderUri, fileName));
      const parsed = content ? parseRecordedCompletionChecksEvidenceV1(content) : undefined;
      if (parsed && (parsed.failedChecks?.length ?? 0) > 0) {
        recorded = parsed;
        break;
      }
      recorded ??= parsed?.verificationEnvironment ? parsed : undefined;
    }
    const evidence = extractEnvironmentalFailureEvidenceV1({
      blockers,
      failedChecks: recorded?.failedChecks?.map((check) => ({
        command: check.command,
        exitCode: check.exitCode,
        output: check.output,
      })),
      environment: recorded?.verificationEnvironment,
    });
    const readOnly = resolveReadOnlyDiagnosisAvailabilityV1();
    return buildEnvironmentalFailureDecisionV1({
      stage,
      reason,
      target: { canonicalId: normalizePath(folderUri.fsPath), taskFolderPath: folderUri.fsPath, taskName },
      evidence,
      planItemsOpen,
      ...(readOnly.available ? {} : { investigateUnavailableReason: readOnly.reason }),
    });
  } catch {
    return undefined;
  }
}

/**
 * review1 Step 48: the card for the first review whose only blockers are ones no in-plan round can clear
 * (`environmental` / `environmental-fixable`). It names the broken check and shows Ensemble's own environment for
 * the run, and offers: "Investigate it for me" (a read-only diagnostic round, Step 49; recommended when a bounded
 * code change may resolve it), "I'll look at it myself", and "Accept it as environmental and continue".
 */
export function buildEnvironmentalFailureDecisionV1(input: {
  readonly stage: TaskStage;
  readonly reason: string;
  readonly target: { canonicalId: string; taskFolderPath: string; taskName?: string };
  readonly evidence: EnvironmentalFailureEvidenceV1;
  readonly planItemsOpen?: number;
  /**
   * Set when no model in Implementation's chain can run in the provider's enforced read-only mode (owner decision
   * 2026-11-05). "Investigate it for me" is then shown disabled with this reason, and never recommended.
   */
  readonly investigateUnavailableReason?: string;
}): PostWorkflowDecisionInputV1 {
  const { stage, reason, target, evidence } = input;
  const investigateBlockedBy = input.investigateUnavailableReason;
  const stageName = STAGE_DISPLAY_NAMES[stage];
  const nextStage = nextStageInOrderV1(stage);
  const failureReport = formatFailureReportV1(evidence);
  const environmentReport = formatEnvironmentReportV1(evidence.environment);
  const canInvestigate = IMPL_REVIEW_STAGES.includes(stage);

  const investigate: WorkflowDecisionOptionV1 = {
    optionId: "investigateFailure",
    label: "Investigate it for me",
    resumeKind: "continue",
    consequence:
      investigateBlockedBy !== undefined
        ? `Not available: ${investigateBlockedBy}.`
        : "Resumes the task and runs one diagnostic round that reads the failure and the code and explains it. It runs " +
          "in the provider's enforced read-only mode, so it cannot change any of your files, and it cannot run tests " +
          "itself: it works from the failure output above. Ensemble saves its findings to evidence/diagnosis-<n>.md. " +
          "You then choose whether a separate round applies the fix it suggests.",
    ...(investigateBlockedBy !== undefined ? { disabled: true } : {}),
    effect: {
      kind: "command",
      command: "vs-code-ai-helper.resumeAndApplyCurrentStageAction",
      args: [{ taskFolderPath: target.taskFolderPath, investigate: { failure: failureReport, environmentReport } }],
      recordedNext: "A diagnostic round is investigating the failure; it runs read-only and Ensemble saves its diagnosis.",
    },
  };
  const lookMyself: WorkflowDecisionOptionV1 = {
    optionId: "lookMyself",
    label: "I'll look at it myself",
    resumeKind: "unpause",
    consequence:
      "Leaves the task paused and dispatches nothing. Resume it, or choose Keep iterating, once you've dealt with the failure.",
    effect: { kind: "doNothing", recordedNext: "The task stays paused while you look at the failure." },
  };
  const accept: WorkflowDecisionOptionV1 | undefined = nextStage
    ? withEnvironmentalAcceptLabelV1(
        buildAdvanceOptionV1(
          nextStage,
          target.taskFolderPath,
          `Accepts that this failure is environmental and moves the task to ${STAGE_DISPLAY_NAMES[nextStage]}. ` +
            "It stays on record and will gate Publish until it is fixed or you publish over it.",
          stage,
          input.planItemsOpen
        ),
        nextStage,
        input.planItemsOpen
      )
    : undefined;

  const options: WorkflowDecisionOptionV1[] = [
    ...(canInvestigate ? [investigate] : []),
    lookMyself,
    ...(accept ? [accept] : []),
  ];
  const recommendation: WorkflowDecisionRecommendationV1 =
    canInvestigate && evidence.fixable && investigateBlockedBy === undefined
      ? {
          kind: "option",
          optionId: "investigateFailure",
          reasoning:
            "The reviewer marked this fixable by a bounded code change outside the plan, and a diagnosis is the " +
            "smallest step that finds out which. It runs read-only, so it changes none of your files.",
        }
      : {
          kind: "none",
          reasoning:
            "This is marked as something no code change resolves, so whether to look at it, accept it or investigate " +
            "anyway is your judgement.",
        };

  return {
    decisionKey: "reviewEscalation:environmental",
    taskCanonicalId: target.canonicalId,
    stage,
    whatHappened: `${stageName} found a failing check that no implementation round can clear: ${reason}`,
    whyUserNeeded:
      "Automation has nothing it can dispatch against this, so another round would only repeat the stall. " +
      "It needs your decision on how to proceed.",
    options,
    recommendation,
    evidence: [
      { label: "The failing check", detail: failureReport },
      { label: "Ensemble's own environment for that run", detail: environmentReport },
    ],
    gating: {
      holdsTaskPaused: true,
      unblocksProgress: true,
      detail: "This decision is holding the task paused until you choose how to proceed.",
    },
  };
}

/**
 * The bounded, durable escalation shape every `EscalationKind` posts through
 * — the plain generic card (no `plateauContext`) for implementation-side and
 * environmental escalations, and the same rich, evidence-led
 * `reviewPlateauEscalation` card `postReviewPlateauDecisionV1` used to build
 * inline (`plateauContext` supplied) for a review-stage plateau with fresh
 * blocker evidence in hand. Review blocker (2026-08-30): the two used to
 * independently construct their options/recommendation/gating; this is the
 * single place both now go through, so a future card cannot silently drift
 * from the other's option ids, effects, or gating shape.
 */
export function buildEscalationDecisionV1(
  kind: EscalationKind,
  stage: TaskStage,
  reason: string,
  target: { canonicalId: string; taskFolderPath: string; taskName?: string },
  plateauContext?: EscalationPlateauContextV1,
  /**
   * RC2 item 3: the generic (no `plateauContext`) card's own plan-open-items
   * count, for its "Advance" option's consequence note — this branch never
   * recommends Advance already (its recommendation is always
   * switchStageModel/reconsiderRequirement/keepIterating), so only the
   * consequence text needs the open-items note, not a routing change.
   */
  genericPlanItemsOpen?: number,
  /** bugs4 item 47: set when the no-progress breaker raised this card. */
  breakerContext?: BreakerCardContextV1
): PostWorkflowDecisionInputV1 {
  const stageName = STAGE_DISPLAY_NAMES[stage];
  const nextStage = nextStageInOrderV1(stage);
  const nextStageName = nextStage ? STAGE_DISPLAY_NAMES[nextStage] : undefined;

  if (plateauContext) {
    const {
      blockersCount,
      primaryBlockerDescription,
      allBlockerDescriptions,
      needsToolchainBlockers = [],
      needsToolchainBlockerIdentities,
      reviewInputsChanged,
      narrowedNote,
      progressNote,
      taskFixableCount,
      hasSpecDefect,
      hasDeclinedBlocker,
      hasNonFixableBlocker,
      nextStageHasRun,
      clearingNote,
      dispatchModeEvidence,
      planItemsOpen,
      narrowing,
      allBlockersNeedOwnerDecision = false,
      allBlockersCarriedGates = false,
      taskFixableAllUnbuiltWork = false,
      taskFixableIncludesUnbuiltWork = false,
      unbuiltItemsNamedCount = 0,
      runProgressNote,
      applyReviewRoundsClosedNone = 0,
      provisionalTicks = 0,
      reviewAffirmsOpenItemsBuilt = false,
      unbuiltWorkReferences = [],
      ownerChecksOwed = [],
      coverage,
      narrowedBlockerRule,
    } = plateauContext;
    // review2 Step 19: files no review has read at their current content.
    const unreviewedCount = coverage ? coverage.changedCount - coverage.reviewedCount : 0;
    // bugs4 item 18: unbuilt work is among the task-fixable blockers and recent Apply Reviews closed
    // no open item, so another Apply Review is not the step that moves this task. Specific defects
    // are carried into the Implementation round's guidance or left to the review that follows.
    const applyReviewNotMoving =
      planItemsOpen > 0 &&
      taskFixableCount > 0 &&
      taskFixableIncludesUnbuiltWork &&
      applyReviewRoundsClosedNone >= APPLY_REVIEW_NO_PROGRESS_ROUNDS_V1;
    // bugs4 item 21/53: every open item carries a model claim, no blocker names unbuilt work, AND
    // the review itself named each of those items as built, so the gap is verification.
    // Implementation cannot close it, so it is not recommended. A model tick alone never
    // qualifies: it is a claim, and the reviewer's verification requirement is not loosened.
    const nothingLeftToBuild =
      planItemsOpen > 0 &&
      provisionalTicks >= planItemsOpen &&
      !taskFixableIncludesUnbuiltWork &&
      reviewAffirmsOpenItemsBuilt;
    const verificationStall = isVerificationStallV1({
      provisional: provisionalTicks,
      roundsClosedNone: applyReviewRoundsClosedNone,
    });
    const options: WorkflowDecisionOptionV1[] = [
      ...(nextStage
        ? [
            buildAdvanceOptionV1(
              nextStage,
              target.taskFolderPath,
              nextStageHasRun
                ? `Moves the task to ${nextStageName}, which has already run once for this task — this accepts the ` +
                  "current state as good enough to proceed rather than re-reviewing it here."
                : `Moves the task to ${nextStageName}, which hasn't run yet and covers different ground — it will ` +
                  `not necessarily re-find this same blocker the way another ${stageName} round would.`,
              stage,
              planItemsOpen
            ),
          ]
        : []),
      // RC2 item 3: offered whenever the plan of record still has open
      // checklist items, regardless of whether anything remaining is
      // task-fixable — this is the "build the next items" alternative to
      // Advance the requirement calls for.
      ...(planItemsOpen > 0 ? [buildBuildRemainingOptionV1(target.taskFolderPath, planItemsOpen, stage)] : []),
      buildPlateauKeepIteratingOptionV1(target.taskFolderPath, stageName, taskFixableCount, blockersCount, stage),
      ...(coverage && unreviewedCount > 0 && IMPL_REVIEW_STAGES.includes(stage)
        ? [buildReviewRemainingOptionV1(target.taskFolderPath, stage, coverage)]
        : []),
      ...(narrowedBlockerRule ? [buildSettleWithRuleOptionV1(target.taskFolderPath, stage, narrowedBlockerRule)] : []),
      // review1 Step 58: offered only when the review's inputs (task.md, plan.md, plan-final.md) changed since the
      // review, i.e. the owner made a change the review has not seen.
      ...(reviewInputsChanged === true
        ? [
            {
              optionId: "recheckAfterMyChanges",
              label: "I've made changes — re-check",
              resumeKind: "continue" as const,
              consequence:
                `Resumes the task and re-runs ${stageName}'s review only, because task.md, plan.md or plan-final.md ` +
                "changed after the last review. It runs no Apply Review and edits no code; the new verdict says whether " +
                "your change settled the blockers.",
              effect: {
                kind: "command" as const,
                command: "vs-code-ai-helper.resumeAndRerunReview",
                args: [{ taskFolderPath: target.taskFolderPath }],
              },
            },
          ]
        : []),
      {
        optionId: "handleMyself",
        label: "Leave it paused — I'll fix it",
        resumeKind: "unpause",
        consequence:
          "Leaves the task paused, exactly like \"Change the plan instead\" below — nothing is dispatched. " +
          "Choose this if you disagree the blocker is outside automation's control, or want to make a fix (or a " +
          "decision only you can make) yourself before resuming.",
        effect: { kind: "doNothing" },
      },
      buildReconsiderRequirementOptionV1(
        target.taskFolderPath,
        hasSpecDefect
          ? "Leaves the task paused and opens plan-final.md's Accepted Non-Goals section — nothing else is " +
            "dispatched. At least one remaining blocker here is classified spec-defect — check the plan's " +
            "non-goals and prior decisions; it may be asking for something no implementation can satisfy as " +
            "written. Once you've updated the plan, resume the task (or choose Keep Iterating) to continue."
          : "Leaves the task paused and opens plan-final.md's Accepted Non-Goals section — nothing else is " +
            "dispatched. No remaining blocker this round is classified spec-defect, so there is no specific " +
            "evidence the requirement itself is unsound in this instance — pick this only if you have reason to " +
            "believe otherwise despite that. Once you've updated the plan, resume the task (or choose Keep " +
            "Iterating) to continue.",
        stage
      ),
      ...(ownerChecksOwed.length > 0
        ? [{
            optionId: "checkAfterInstall",
            label: "I'll check after install — move on",
            resumeKind: "continue" as const,
            consequence:
              `Advances to ${nextStageName ?? "the next stage"}. These owner checks remain owed: ${ownerChecksOwed.join("; ")}. ` +
              "After installing this build, perform each check and record its result under Owner evidence in task.md.",
            effect: {
              kind: "command" as const,
              command: "vs-code-ai-helper.nextStage",
              args: [{ taskFolderPath: target.taskFolderPath }],
            },
          }]
        : []),
      // 1.0.0 gate, Part 4 / Step 14 (B4), review finding 2026-09-06: the
      // paused `escalate` route previously omitted the "publish over it"
      // exit entirely, even when a non-task-fixable blocker on record here
      // is the exact same kind that will gate Publish later — leaving the
      // owner to discover the override for the first time in a modal at
      // publish time. Only offered when such a blocker is actually present.
      ...(hasNonFixableBlocker && optionAppliesAtStageV1("publishAnyway", stage)
        ? [buildPublishAnywayOptionV1(target.taskFolderPath)]
        : []),
      ...(narrowing
        ? [
            {
              optionId: "acceptNarrowing",
              label: "Accept this narrowing",
              resumeKind: "continue" as const,
              consequence:
                `Records the owner decision under Accepted Non-Goals in ${isPlanReviewStage(stage) ? "plan.md" : "plan-final.md"}, resumes the task and runs ` +
                `${stageName} again against the same workspace with that decision on record (the review's input ` +
                "changed, so its verdict can differ); the blocker is treated as settled from then on.",
              effect: {
                kind: "command" as const,
                command: "vs-code-ai-helper.acceptPlanItemNarrowingV1",
                args: [
                  {
                    taskFolderPath: target.taskFolderPath,
                    stage,
                    itemText: narrowing.itemText,
                    reason: narrowing.reason,
                    blockerDescription: narrowing.blockerDescription,
                  },
                ],
              },
            },
            {
              optionId: "keepItemOpen",
              label: "Keep the item open",
              resumeKind: "unpause" as const,
              consequence:
                "Leaves the plan and the task paused as they are; the item stays outstanding. Resume the task or " +
                "choose Keep iterating when ready.",
              effect: { kind: "doNothing" as const },
            },
          ]
        : []),
      // review1 Step 50: a command the stage cannot run is run by the owner; recording the result is how the
      // blocker can ever be met on the record.
      ...needsToolchainBlockers.slice(0, 2).map((desc, index): WorkflowDecisionOptionV1 => {
        const shortName = desc.replace(/\s+/g, " ").trim().slice(0, 48);
        return {
          optionId: index === 0 ? "recordOwnerRun" : `recordOwnerRun${index + 1}`,
          label:
            needsToolchainBlockers.length > 1
              ? `I ran it — record the result: ${shortName}${desc.length > shortName.length ? "…" : ""}`
              : "I ran it — record the result",
          resumeKind: "continue",
          consequence:
            `Asks for the command you ran, its exit code and the end of its output for "${shortName}${desc.length > shortName.length ? "…" : ""}", ` +
            "saves them under Owner evidence in task.md as your own run bound to this blocker, then resumes the task and re-runs the review. " +
            "The review may still disagree, but it has to cite your record.",
          effect: {
            kind: "command",
            command: RECORD_OWNER_RUN_COMMAND_V1,
            args: [
              {
                taskFolderPath: target.taskFolderPath,
                stage,
                blocker: desc,
                blockerLineageId: needsToolchainBlockerIdentities?.[index] ?? blockerOwnerIdentityV1({ description: desc }),
              },
            ],
          },
        };
      }),
      ...(() => {
        const gatherable = allBlockerDescriptions?.filter((desc) => AGENT_CAN_GATHER_RE.test(desc)) ?? [];
        return gatherable.map((desc, index) => {
          const cost = AGENT_CAN_GATHER_RE.exec(desc)?.[1]?.trim() ?? "low cost";
          // With several gather options on one card, a short name of the blocker tells the buttons apart.
          const shortName = desc.replace(/\s+/g, " ").trim().slice(0, 48);
          // Option ids must be unique on a card: the first keeps the plain id, later ones are numbered.
          return {
            optionId: index === 0 ? "aiGatherEvidence" : `aiGatherEvidence${index + 1}`,
            label:
              gatherable.length > 1
                ? `Let the AI gather it: ${shortName}${desc.length > shortName.length ? "…" : ""} (about ${cost})`
                : `Let the AI gather it (about ${cost})`,
            resumeKind: "continue" as const,
            consequence:
              `Resumes the task and runs an Apply Review whose work is only this blocker: "${desc}". ` +
              "The review's other blockers are left alone this round.",
            effect: {
              kind: "command" as const,
              command: "vs-code-ai-helper.resumeAndApplyCurrentStageAction",
              args: [{ taskFolderPath: target.taskFolderPath, focusBlocker: desc }],
            },
          };
        });
      })(),
    ];

    // 2026-09-04 review follow-up (completion blocker, new): this label
    // states HOW MANY of the remaining blockers are task-fixable, so it must
    // be built from `taskFixableCount` (the same value the option consequence
    // text above and `postReviewPlateauDecisionV1`'s "what clears this"
    // evidence already use) — not `blockersCount`, which is the TOTAL. Using
    // the total here reproduces the exact "3 of 4" vs "4" contradiction Part
    // C, Step 9 exists to eliminate: one derivation per fact, rendered
    // everywhere.
    const taskFixableCountLabel = `${taskFixableCount} of the ${blockersCount} remaining ` +
      `${blockersCount === 1 ? "blocker" : "blockers"}`;
    const recommendation: WorkflowDecisionRecommendationV1 =
      // review2 Step 19: a stage with changed files no review has read recommends reading them. A spec defect or a
      // narrowing is a decision for the owner first, so those keep their own recommendation.
      unreviewedCount > 0 && !hasSpecDefect && !narrowing && IMPL_REVIEW_STAGES.includes(stage)
      ? {
          kind: "option",
          optionId: "reviewRemaining",
          reasoning:
            `${coverage ? describeReviewedLineV1(coverage) : "Some changed files"}; ${unreviewedCount} ` +
            `${unreviewedCount === 1 ? "file has" : "files have"} not been read by any review at its current ` +
            "content, so a verdict here says nothing about them.",
        }
      : hasSpecDefect
      ? {
          kind: "option",
          optionId: "reconsiderRequirement",
          reasoning:
            "A remaining blocker this round is classified spec-defect — that is exactly the shape where the " +
            "requirement, not the implementation, is what needs to change.",
        }
      : // RC2 item 7, Step 29: every task-fixable blocker this round had was
        // already declined by a prior implementer round for lack of owner
        // approval — "Keep iterating" would only dispatch the same round
        // that already refused it. This is checked ahead of `planItemsOpen`
        // too: a declined removal needs a human decision regardless of how
        // much of the plan is otherwise open.
        hasDeclinedBlocker
        ? {
            kind: "option",
            optionId: "reconsiderRequirement",
            reasoning:
              "The remaining blocker here matches a removal the last implementation round already declined, " +
              "citing rule 7 — no owner approval is recorded in the task's own Task Description. Another round " +
              "will decline it again; this needs a human decision, not more automated iteration.",
          }
        : // bugs3 Step 7: every remaining blocker is owner evidence the plan
          // defers to named later steps. The evidence cannot exist yet, so
          // "Leave it paused" can never clear it; advance with the gate carried.
          allBlockersCarriedGates && nextStage && taskFixableCount === 0
        ? {
            kind: "option",
            optionId: "advance",
            reasoning:
              "Every remaining blocker is owner evidence the plan already defers to later steps it names, and " +
              "that evidence cannot exist at this stage — pausing to gather it cannot clear it. Advance with the " +
              "gate carried forward; the steps that depend on it stay gated until the evidence is recorded.",
          }
        : // RC7 item 1: every remaining blocker clears only through an owner
          // decision, so Advance would skip the decision and the same blocker
          // would block Publish later.
          allBlockersNeedOwnerDecision
        ? {
            kind: "option",
            // review1 Step 38: "Leave it paused" does nothing, so it is never recommended while an option that
            // records the decision exists. "Change the plan instead" opens the file the decision is written in
            // (Accepted Non-Goals); a narrowing the owner can accept in one click comes first.
            //
            // review1 Step 38 (owner, 2026-11-05; bugs6 item 19): "Accept this narrowing" is recommended only when
            // the narrowing's reason is checked (a reason on file with evidence). A narrowing the round left no
            // reason for is a request nobody has backed, so the plan is kept and the work goes on, matching the
            // owner-decision card for the same blocker.
            optionId:
              narrowing && narrowingReasonIsCheckedV1(narrowing)
                ? "acceptNarrowing"
                : // At a plan stage "Keep iterating" would dispatch an implementation round; the plan-stage way on is
                  // changing the plan (which opens plan.md), so that is what is recommended there.
                  narrowing &&
                  !isPlanReviewStage(stage) &&
                  options.some((option) => option.optionId === "keepIterating")
                ? "keepIterating"
                : "reconsiderRequirement",
            reasoning:
              narrowing && !narrowingReasonIsCheckedV1(narrowing)
                ? "The narrowing has no reason or evidence on file, so there is nothing to accept yet. Keep the plan " +
                  "as written and let the next round either build the item or file the reason and evidence for " +
                  "leaving part of it out."
                : "Every remaining blocker clears only through an owner decision, so advancing would skip the " +
                  "decision and the same blocker would block Publish later.",
          }
        : // RC7 item 3: open plan items and only unbuilt-work completion
          // blockers — another review-driven round cannot build them.
          planItemsOpen > 0 && taskFixableCount > 0 && taskFixableAllUnbuiltWork
        ? {
            kind: "option",
            optionId: "buildRemaining",
            reasoning:
              `${planItemsOpen} plan ${planItemsOpen === 1 ? "item is" : "items are"} still open and the ` +
              `remaining ${taskFixableCount === 1 ? "blocker is" : "blockers are"} unbuilt work` +
              (unbuiltWorkReferences.length > 0
                ? ` (it says ${unbuiltWorkReferences.join(", ")} ${unbuiltWorkReferences.length === 1 ? "is" : "are"} ` +
                  `not done, and ${unbuiltWorkReferences.length === 1 ? "that item is" : "those items are"} still open)`
                : "") +
              ", which Implementation builds and another review round does not.",
          }
        : // bugs5 Step 22: the grouped blocker names many unbuilt items. An Apply Review builds one or two
          // per round; Implementation builds them all in one.
          planItemsOpen > 0 &&
          taskFixableCount > 0 &&
          taskFixableIncludesUnbuiltWork &&
          unbuiltItemsNamedCount >= MANY_UNBUILT_ITEMS_THRESHOLD_V1
        ? {
            kind: "option",
            optionId: "buildRemaining",
            reasoning:
              `The blocker names ${unbuiltItemsNamedCount} unbuilt plan items. An Apply Review builds one or two ` +
              "per round, while Implementation builds them all in one round.",
          }
        : applyReviewNotMoving
        ? {
            kind: "option",
            optionId: "buildRemaining",
            reasoning:
              `${describeApplyReviewNoProgressV1(planItemsOpen, applyReviewRoundsClosedNone)}. Unbuilt plan ` +
              "work is among the blockers, which Implementation builds and another Apply Review does not.",
          }
        : taskFixableCount > 0
        ? {
            kind: "option",
            optionId: "keepIterating",
            reasoning: `${taskFixableCountLabel} are still task-fixable, so another round has real work to do.`,
          }
        : // bugs4 item 53: nothing is left to build; the open items wait for verification, which a build
          // round does not provide.
          nothingLeftToBuild && nextStage
        ? {
            kind: "option",
            optionId: "advance",
            reasoning:
              `All ${planItemsOpen} open plan ${planItemsOpen === 1 ? "item is" : "items are"} already built and ` +
              `ticked, waiting only for verification, and no blocker names unbuilt work. An Implementation round ` +
              `has nothing to build here, so advancing to ${nextStageName} is the way on.`,
          }
        : // RC2 item 3: with open plan items and nothing task-fixable here,
          // recommend building them rather than Advance or "leave it paused" —
          // advancing (or merely waiting) would leave those items unbuilt
          // behind a stage that treats implementation as done.
          planItemsOpen > 0
          ? {
              kind: "option",
              optionId: "buildRemaining",
              reasoning:
                `Every remaining blocker is non-task-fixable, but ${planItemsOpen} plan ` +
                `${planItemsOpen === 1 ? "item is" : "items are"} still open — advancing would leave ` +
                `${planItemsOpen === 1 ? "it" : "them"} unbuilt behind a stage that treats implementation as done.`,
            }
          : nextStage && !nextStageHasRun
          ? {
              kind: "option",
              optionId: "advance",
              reasoning:
                `Every remaining blocker is non-task-fixable and ${nextStageName} hasn't run yet — further ` +
                `${stageName} rounds will most likely re-find this same blocker, while ${nextStageName} covers ` +
                "different ground.",
            }
          : {
              kind: "option",
              optionId: "handleMyself",
              reasoning:
                `Every remaining blocker is non-task-fixable${nextStage ? ` and ${nextStageName} has already run` : ""}` +
                ", so this needs a human decision or action, not more automated iteration.",
            };

    return {
      decisionKey: "reviewPlateauEscalation",
      taskCanonicalId: target.canonicalId,
      stage,
      whatHappened:
        // RC1 item 11: "can't progress on its own" is only true when nothing
        // remaining is task-fixable; otherwise it contradicts the recommended
        // "keep iterating" option, so the opening states the real split.
        (taskFixableCount > 0
          ? `${stageName} paused for your decision. ${describeFixableSplitV1(taskFixableCount, blockersCount)} `
          : `${stageName} can't progress on its own. `) +
        (primaryBlockerDescription !== undefined
          ? `${blockersCount === 1 ? "One blocker remains" : `${blockersCount} blockers remain`}` +
            `, verbatim:\n\n${allBlockerDescriptions.map((d) => `"${d}"`).join("\n\n")}${narrowedNote}`
          : reason),
      whyUserNeeded:
        (taskFixableCount > 0
          ? `${describeFixableSplitV1(taskFixableCount, blockersCount)} ${progressNote}`
          : `Automation has done what it can here — ${progressNote} ${taskFixableCount} of the ` +
            `${blockersCount} remaining blocker(s) are task-fixable.`) +
        (hasNonFixableBlocker
          ? narrowing
            ? // A narrowing is the owner's to settle on this card, which is different from a blocker no one can
              // act on, so it is not described as outside automation's control.
              " A remaining blocker here is a narrowing only you can approve — the same issue will also block " +
              "Publish later until you accept it or the item is built."
            : " A remaining blocker here is outside automation's control — the same issue will also block Publish " +
              "later, until it clears or you choose \"I'll publish over it\" below to override it there."
          : "") +
        (hasDeclinedBlocker
          ? " The last implementation round already declined this same removal as needing a human decision — " +
            "no owner approval is recorded in the task's own Task Description, so another round will decline it " +
            "again."
          : ""),
      options,
      recommendation,
      evidence: [
        { label: "What clears this", detail: clearingNote },
        ...(coverage ? [{ label: "Review coverage", detail: describeReviewedLineV1(coverage) }] : []),
        ...(narrowedBlockerRule
          ? [
              {
                label: "Pattern",
                detail: `Two fixes have each closed part of this; the rule may be missing: ${narrowedBlockerRule.description.slice(0, 200)}`,
              },
            ]
          : []),
        ...(verificationStall
          ? [
              {
                label: "Kind of stall",
                detail:
                  `Verification stall: ${provisionalTicks} ticked ${provisionalTicks === 1 ? "item has" : "items have"} ` +
                  `only a model claim, and the last ${applyReviewRoundsClosedNone} Apply Review rounds verified or ` +
                  "settled none. More of the same rounds will not move this count; a review that names the items " +
                  "it confirmed, a passing test report, or your own decision will.",
              },
            ]
          : []),
        ...(applyReviewNotMoving
          ? [
              {
                label: "Progress",
                detail: describeApplyReviewNoProgressV1(planItemsOpen, applyReviewRoundsClosedNone),
              },
            ]
          : []),
        ...(runProgressNote ? [{ label: "How far this run has got", detail: runProgressNote }] : []),
        ...(narrowing
          ? [
              { label: "Plan item", detail: narrowing.itemText },
              { label: "The round's reason", detail: `${narrowing.reason} (${narrowing.reasonSource})` },
              { label: "The round's evidence", detail: `${narrowing.evidence} (${narrowing.evidenceSource})` },
            ]
          : []),
        ...dispatchModeEvidence,
      ],
      gating: {
        holdsTaskPaused: true,
        unblocksProgress: true,
        detail:
          "This decision is what is holding the task paused — resolving it with \"Advance\" or \"Keep iterating\" " +
          "resumes or advances the task immediately; \"Leave it paused — I'll fix it\" and \"Change the plan " +
          "instead\" both leave it paused and dispatch nothing.",
      },
    };
  }

  const environmental = kind === "environmental";
  const keepIterating: WorkflowDecisionOptionV1 = environmental
    ? {
        // Pre-1.0.0 fixes register, item 14 / Part 3: this variant only opens
        // AI Models for the user to pick a model — the user performs the
        // adjustment, and nothing resumes or dispatches automatically. That
        // is the "unpause" shape, not "continue" (which must resume the
        // interrupted process). Review finding, 2026-09-23: this used to
        // reuse the `keepIterating` optionId, but the plan's Step 2 inventory
        // classifies EVERY `keepIterating` literal in this file as
        // "continue" with no carve-out, so an "unpause" option under that
        // same id contradicted the plan of record even though the behaviour
        // itself is correct (this branch's semantics are the same as
        // `adjustSettings`/`switch`, both "unpause"). Given its own distinct
        // id instead, so it is no longer covered by that inventory line.
        optionId: "switchStageModel",
        label: "Switch this stage's model",
        resumeKind: "unpause",
        consequence:
          "Opens AI Models so you can select a working model for this stage. Nothing resumes automatically — " +
          "once you've switched, resume this task (or press this again) to try it.",
        effect: { kind: "command", command: "vs-code-ai-helper.openAiModels" },
      }
    : {
        optionId: "keepIterating",
        resumeKind: "continue",
        // v1 fixes 2, item 25: the button names the action it dispatches
        // rather than a bare "Keep iterating".
        label: IMPL_REVIEW_STAGES.includes(stage)
          ? "Keep iterating: run Apply Review"
          : "Keep iterating: run the next implementation round",
        // A1 (1.0.0 gate, Part C): the review-stage branch previously read
        // "reruns ${stageName}" and dispatched resumeAndRerunReview — against
        // an unchanged tree that reproduces the same verdict by construction.
        // Apply Review edits the workspace against the stage's own findings
        // first, so this now names the actual work, matching the plateau-
        // context card's own wording above.
        consequence: IMPL_REVIEW_STAGES.includes(stage)
          ? `Resumes the task and runs Apply Review against ${stageName}'s findings, then re-reviews. ` +
            "If the review is out of date it re-runs the review first instead."
          : "Resumes the task and dispatches its owed continuation or next implementation action.",
        effect: {
          kind: "command",
          // Not plain resumeTask: that only clears the pause, leaving
          // nothing running until some other trigger (auto-advance, a
          // scheduling sweep) happens to pick the task back up — on a
          // manually-answered plateau card that can silently strand the
          // task active-but-idle. resumeAndApplyCurrentStageActionV1 (review
          // stages) and resumeAndDispatchImplementationV1 (everywhere else)
          // both resume AND dispatch genuine work, never just a re-review of
          // an unchanged tree.
          command: IMPL_REVIEW_STAGES.includes(stage)
            ? "vs-code-ai-helper.resumeAndApplyCurrentStageAction"
            : "vs-code-ai-helper.resumeAndDispatchImplementation",
          args: [{ taskFolderPath: target.taskFolderPath }],
        },
      };
  const options: WorkflowDecisionOptionV1[] = [
    ...(nextStage
      ? [
          buildAdvanceOptionV1(
            nextStage,
            target.taskFolderPath,
            `Accepts the current state and moves the task to ${STAGE_DISPLAY_NAMES[nextStage]}.`,
            stage,
            genericPlanItemsOpen
          ),
        ]
      : []),
    keepIterating,
    ...(breakerContext?.reviewAffirmsOpenItemsBuilt && breakerContext.planItemsOpen > 0
      ? [buildBreakerVerifiedTicksOptionV1(target.taskFolderPath)]
      : []),
    {
      optionId: "handleMyself",
      label: "Leave it paused — I'll fix it",
      resumeKind: "unpause",
      consequence: `Leaves the task paused and opens ${planFileNameForStageV1(stage)} so you can review the plan and make the needed change yourself.`,
      effect: {
        kind: "command",
        command: "vs-code-ai-helper.openPlanFinal",
        args: [{ taskFolderPath: target.taskFolderPath, ...openPlanStageArgV1(stage) }],
      },
    },
    buildReconsiderRequirementOptionV1(
      target.taskFolderPath,
      "Opens plan-final.md's Accepted Non-Goals section. The task stays paused while you review it — " +
        "resume it (or choose Keep Iterating) once you've made the change.",
      stage
    ),
  ];
  const recommendation: WorkflowDecisionRecommendationV1 = breakerContext
    ? recommendForBreakerCardV1(breakerContext, nextStageName)
    : environmental
    ? {
        kind: "option",
        optionId: "switchStageModel",
        reasoning: "This is an environmental failure, so changing this stage's model is the action available in Ensemble.",
      }
    : kind === "spec-defect"
      ? {
          kind: "option",
          optionId: "reconsiderRequirement",
          reasoning: "The reported issue is in the requirement rather than a change the implementation can make.",
        }
      : {
          kind: "option",
          optionId: "keepIterating",
          reasoning: "The task is paused and this is the action that returns it to a runnable state.",
        };
  return {
    decisionKey: `reviewEscalation:${kind}`,
    taskCanonicalId: target.canonicalId,
    stage,
    whatHappened: `${stageName} needs your decision: ${reason}`,
    whyUserNeeded: "Automation paused this task and cannot choose how to proceed on your behalf.",
    options,
    recommendation,
    ...(breakerContext?.gateCountNote
      ? { evidence: [{ label: "Plan checklist (the gate's count)", detail: breakerContext.gateCountNote }] }
      : {}),
    gating: {
      holdsTaskPaused: true,
      unblocksProgress: true,
      detail: "This decision is holding the task paused until you choose how to proceed.",
    },
  };
}

/**
 * 1.0.0 gate, Part 4 / Step 14 (B4): when `decideReviewRoute` returns
 * `advance-with-note` — the score met threshold, but every remaining blocker
 * is environmental or unverifiable (`onlyEnvironmentalRemain`,
 * `reviewRouting.ts`) — this used to be a single informational toast naming
 * only the category, e.g. "only known-environmental blockers remain". That
 * told the user nothing they could act on and never mentioned that the SAME
 * issue will later gate Publish: the owner's real complaint ("why didn't
 * Ensemble handle it?") came from discovering this for the first time at
 * publish time, with the audit-trailed "Publish Anyway" override
 * (`commitAndPushTask.ts`) hidden behind a blocking modal nobody had been
 * told existed.
 *
 * This posts a non-blocking chat decision INSTEAD of that toast, at the
 * moment the blocker is first seen, naming the failure concretely (the
 * blocker's own description, exactly as the reviewer or mechanical check
 * wrote it — never just its category), the consequence (it will block
 * Publish until it clears or is overridden there), and all three exits named
 * in Part 4: advance anyway (fix, 2026-09-2x review: an earlier revision's
 * doc comment claimed the stage transition had already happened
 * synchronously before this card could be answered — it had not.
 * `handleReviewRoutingOutcome`'s `advance-with-note` branch, which is the
 * only caller, returns immediately after posting this notice, well before
 * the later `isAutoAdvanceEnabled() && meetsThreshold` block in the same
 * function that performs the real transition — so with auto-advance off, or
 * that later transition refused, the task never moved and choosing this
 * option ran only the CURRENT stage's action forever. This option now
 * performs the transition itself, through the same Step-3 advance path
 * `buildAdvanceOptionV1` uses — `resumeAndSetTaskStage`, which runs
 * `enterStageV1` and then dispatches the destination stage's next action —
 * so "advance anyway" always genuinely advances; see the pre-1.0.0 fixes
 * register, item 14 / Part 3 Step 4), fix it yourself (opens plan-final.md),
 * and "I'll publish over it" (runs Publish Checks now if the task has reached
 * Publish, so the existing audited override is one click away instead of a
 * surprise later; gracefully tells the user it isn't available yet otherwise,
 * via `runPublishChecks`'s own stage guard).
 *
 * Deliberately non-blocking (`holdsTaskPaused: false`): this notice does not
 * pause the task — the review round that raised it already left the task
 * active — so it must never read as something that needs answering before
 * progress continues, only as advance warning of what to expect at Publish
 * if the blocker is not cleared first. Returns whether the decision was
 * actually posted (no extension context available is the one expected
 * failure mode, as with every other `postWorkflowDecisionV1` call site); the
 * caller falls back to a plain informational toast when this returns false,
 * so the notice is never silently dropped.
 */
/**
 * B4's third exit ("Publish over it with an audit trail"), shared by every
 * card that offers it, so the wiring can never drift between call sites —
 * one derivation, per Part C Step 9. Dispatches the SAME
 * `vs-code-ai-helper.commitAndPushTask` command every other "Publish Anyway"
 * affordance in the product already uses (see the Step 3/3b publish nudges
 * in reviewActions.ts) — never `runPublishChecks`, which is an unrelated
 * lint/type/test/plan-verification check with no path into the actual
 * audited override.
 *
 * Review finding, 2026-09-06: an earlier revision wired this option to
 * `runPublishChecks` instead. That command only runs its (unrelated) checks
 * when the task has already reached Publish, and even then never reaches
 * `runCommitPushCompletionChecksV1`'s "Publish Anyway" modal — the actual
 * mechanism that writes the audit trail into `publish-review.md`. The
 * option was therefore advice to run more, unrelated steps later, not the
 * promised exit. `commitAndPushTask` is the real path: eligible, it runs
 * the full commit/push flow and reaches the audited override if its own
 * checks fail; ineligible (task not yet completed/at Publish), it reports
 * that accurately via its own stage-eligibility message instead of silently
 * doing nothing.
 */
/**
 * review2 Step 19: "Review the remaining N files". Until batched review exists (Part 6) it adds the unreviewed files
 * to the review's scope and runs one review through the partial-scope path; the label and record stay when Part 6
 * makes it batched.
 */
function buildReviewRemainingOptionV1(
  taskFolderPath: string,
  stage: TaskStage,
  coverage: ReviewCoverageSummaryV1
): WorkflowDecisionOptionV1 {
  const count = coverage.changedCount - coverage.reviewedCount;
  return {
    optionId: "reviewRemaining",
    label: `Review the remaining ${filesPhraseV1(count)}`,
    resumeKind: "continue",
    consequence:
      `Adds the ${filesPhraseV1(count)} no review has read at their current content to ${STAGE_DISPLAY_NAMES[stage]}'s ` +
      "scope and runs the review. Its verdict then covers them.",
    effect: {
      kind: "command",
      command: "vs-code-ai-helper.resolvePartialReviewScopeV1",
      args: [{ taskFolderPath, stage, action: "addAndRereview", missingFiles: [...coverage.unreviewed], hash: "" }],
    },
  };
}

/**
 * review2 Step 34: "Settle it with a rule". The answer goes through the own-words entry point (recorded in task.md under
 * Owner decisions, naming the blocker), and exactly one Apply Review follows it (`thenApplyReview`), which treats the
 * rule as the specification for that blocker. The next review judges the fix against it.
 */
function buildSettleWithRuleOptionV1(
  taskFolderPath: string,
  stage: TaskStage,
  narrowed: NarrowedBlockerV1
): WorkflowDecisionOptionV1 {
  const subject = narrowed.description.slice(0, 120);
  return {
    optionId: "settleWithRule",
    label: "Settle it with a rule",
    resumeKind: "continue",
    consequence:
      `${narrowed.fixes} fixes have each closed part of "${subject}${narrowed.description.length > 120 ? "…" : ""}", so the ` +
      "rule may be missing. Type the rule in the message box below; it is recorded in task.md under Owner decisions naming this " +
      "blocker, then runs exactly one Apply Review that treats your rule as the specification. The next review judges the " +
      "fix against it.",
    effect: {
      kind: "command",
      command: "vs-code-ai-helper.recordOwnerPlanDecisionV1",
      args: [
        {
          taskFolderPath,
          stage,
          blockerId: narrowed.blockerId,
          optionId: "settleWithRule",
          optionLabel: "Settle it with a rule",
          ownWords: true,
          thenApplyReview: true,
          blockerText: narrowed.description,
        },
      ],
    },
  };
}

function buildPublishAnywayOptionV1(taskFolderPath: string): WorkflowDecisionOptionV1 {
  return {
    optionId: "publishAnyway",
    label: "I'll publish over it",
    resumeKind: "continue",
    consequence:
      "Opens Commit and Push for this task. If it's ready to publish and this same issue fails its checks " +
      "there, choose \"Publish Anyway\" to record the override in publish-review.md with an audit trail. If " +
      "the task hasn't reached Publish yet, this tells you so instead of running anything.",
    effect: {
      kind: "command",
      command: "vs-code-ai-helper.commitAndPushTask",
      args: [{ taskFolderPath }],
    },
  };
}

export async function postEnvironmentalAdvanceNoticeV1(
  folderUri: vscode.Uri,
  stage: TaskStage,
  blockers: readonly ReviewBlocker[],
  target: { canonicalId: string; taskFolderPath: string; taskName?: string }
): Promise<boolean> {
  const nonFixable = blockers.filter((b) => b.resolver !== "task-fixable");
  if (nonFixable.length === 0) {
    return false;
  }
  const stageName = STAGE_DISPLAY_NAMES[stage];
  const nextStage = nextStageInOrderV1(stage);
  const nextStageName = nextStage ? STAGE_DISPLAY_NAMES[nextStage] : undefined;
  // RC2 item 3: same rule as the plateau card — never recommend Advance (or
  // let it read as though the plan were finished) while the plan of record
  // still has open checklist items. Review fix (2026-09-28, completion
  // blocker): a plan-review-stage task is NOT guaranteed to have no
  // checklist yet — a task rolled back from Implementation to a plan review
  // keeps its half-finished plan-final.md on disk (see the matching guard
  // and comment on `postReviewPlateauDecisionV1`'s own `planItemsOpen`,
  // above, and the identical rationale in reviewActions.ts beside
  // `effectiveReviewProgressV1`'s call). Without this guard, that stale
  // checklist could recommend "Build the N open plan items", whose effect
  // jumps straight to `impl` — skipping an ordered review stage (e.g. Plan
  // Low-Level Review) between here and there. A plan-review stage's checklist
  // count is therefore always read as 0, exactly like the plateau branch.
  const planItemsOpen = isPlanReviewStage(stage)
    ? 0
    : Math.max(
        0,
        ((await readPlanItemCountsV1(folderUri, { mode: "display" }))?.gate.remaining ?? 0) -
          (await readDeferredOpenPlanItemCountV1(folderUri))
      );
  // 1.0.0 gate, Part 4 / Step 14 (B4), review finding 2026-09-06: quote every
  // non-fixable blocker verbatim, not just the first with "(and N more of
  // the same kind)" — a summarized count is not the "command, file,
  // assertion, provider output" evidence the requirement calls for, and each
  // blocker's own description (now enriched with output evidence for
  // mechanical blockers — see synthesizeMechanicalBlockers) is the actual
  // evidence a reader needs to act on it.
  const quotedBlockers = nonFixable.map((b) => `"${b.description}"`).join("\n\n");

  // Item 14 / Part 3 Step 3–4 (review fix, 2026-09-2x): this notice fires
  // BEFORE any transition — see the doc comment above — so "advance anyway"
  // has to perform the move itself. `resumeFastForward` is captured now, at
  // card-build time, for the same reason `buildAdvanceOptionV1` captures it
  // then rather than re-deriving it when the option is chosen (see that
  // function's own comment). Only meaningful when there is a next stage to
  // advance into.
  const resumeFastForward = nextStage ? isFastForwardRunActiveV1(target.taskFolderPath) : false;

  const options: WorkflowDecisionOptionV1[] = [
    {
      optionId: "acknowledgeAdvance",
      label: "Continue — advance anyway",
      resumeKind: "continue",
      consequence:
        (nextStage
          ? `${stageName} met its score threshold. Choosing this closes the notice, advances the task to ` +
            `${nextStageName}, and then tries to keep it moving by running ${nextStageName}'s own next action.`
          : `${stageName} met its score threshold, but there is no later stage to advance to. Choosing this ` +
            `closes the notice and tries to keep the task moving by running ${stageName}'s own next action now.`) +
        describeOpenPlanItemsNoteV1(planItemsOpen, nextStageName ?? stageName),
      effect: nextStage
        ? {
            kind: "command",
            command: "vs-code-ai-helper.resumeAndSetTaskStage",
            // See buildAdvanceOptionV1's matching comment: `expectedSourceStage`
            // is `stage` here — the stage whose score threshold this notice
            // fired against — so a stale click that outlived a further
            // transition cannot move the task backward to `nextStage`.
            args: [
              {
                taskFolderPath: target.taskFolderPath,
                stage: nextStage,
                resumeFastForward,
                expectedSourceStage: stage,
              },
            ],
          }
        : {
            kind: "command",
            command: "vs-code-ai-helper.resumeAndApplyCurrentStageAction",
            args: [{ taskFolderPath: target.taskFolderPath }],
          },
    },
    // RC2 item 3: offered whenever the plan of record still has open
    // checklist items, so the user has a "build the rest" exit alongside
    // "advance anyway" instead of only being told the count in prose.
    ...(planItemsOpen > 0 ? [buildBuildRemainingOptionV1(target.taskFolderPath, planItemsOpen, stage)] : []),
    {
      optionId: "handleMyself",
      label: "Fix it yourself first",
      resumeKind: "unpause",
      consequence: `Opens ${planFileNameForStageV1(stage)} so you can address the blocker before it reaches Publish.`,
      effect: {
        kind: "command",
        command: "vs-code-ai-helper.openPlanFinal",
        args: [{ taskFolderPath: target.taskFolderPath, ...openPlanStageArgV1(stage) }],
      },
    },
    // review1 Step 38: "publish over it" only exists once there is code to publish.
    ...(optionAppliesAtStageV1("publishAnyway", stage) ? [buildPublishAnywayOptionV1(target.taskFolderPath)] : []),
  ];

  // Review fix (2026-09-23, narrowed blocker c2453680-fe42-461b-9652-1f87445cb9d3-0):
  // this card is posted from the SAME score/threshold this stage's own
  // auto-advance check (`isAutoAdvanceEnabled() && meetsThreshold` in
  // `routeReviewOutcomeV1`, reviewActions.ts) re-derives independently a few
  // lines later in the very same round — so with auto-advance on, the task
  // can (and often does) advance out of `stageName` on its own before, or
  // moments after, this notice is even read. An unconditional "stays until
  // you choose" is then false. The caller withdraws this card the instant
  // that happens (see the withdrawal beside the auto-advance transition in
  // reviewActions.ts), so the two texts below only need to be honest about
  // the possibility, not track the outcome themselves.
  //
  // Review fix (2026-09-28, completion blocker): at an implementation-side
  // stage (not a plan review), that same re-derivation reconciles its score
  // against the checklist (`effectiveReviewProgressV1`'s "checklist-reconciled
  // otherwise" branch — see reviewActions.ts beside its own `progress`/
  // `meetsThreshold` derivation), so with `planItemsOpen > 0` the real gate
  // cannot fire no matter what auto-advance is set to. Saying "may move on
  // its own" there was false reassurance directly contradicting the
  // `buildRemaining` recommendation just above. Harmless at a plan-review
  // stage, where `planItemsOpen` is always 0 (see above) and the real gate
  // never reconciles against this stale checklist anyway.
  const autoAdvanceMayPreempt = isAutoAdvanceEnabled() && nextStage !== undefined && planItemsOpen === 0;
  const decisionInput: PostWorkflowDecisionInputV1 = {
    decisionKey: "environmentalAdvanceNotice",
    taskCanonicalId: target.canonicalId,
    stage,
    whatHappened:
      `${stageName} met its score threshold, but ${nonFixable.length === 1 ? "a blocker remains" : `${nonFixable.length} blockers remain`} ` +
      `that no further automated round can fix — here ${nonFixable.length === 1 ? "it is" : "they are"}, verbatim:\n\n${quotedBlockers}`,
    whyUserNeeded: autoAdvanceMayPreempt
      ? `Auto-advance is on, so the task may move off ${stageName} on its own before you answer — if it does, this ` +
        "notice is withdrawn automatically and needs no answer. Until then, advancing yourself moves it forward " +
        "with this blocker still outstanding, which will block Publish later, until it clears or you override it " +
        "there — this is the moment to see the exits, not a surprise at publish time."
      : `The task stays on ${stageName} until you choose. Advancing moves it forward with this blocker still ` +
        "outstanding, which will block Publish later, until it clears or you override it there — this is the " +
        "moment to see the exits, not a surprise at publish time.",
    options,
    // RC2 item 3: never recommend Advance while the plan has open items —
    // recommend building them instead.
    recommendation:
      planItemsOpen > 0
        ? {
            kind: "option",
            optionId: "buildRemaining",
            reasoning:
              `${stageName} already met its score threshold, but ${planItemsOpen} plan ` +
              `${planItemsOpen === 1 ? "item is" : "items are"} still open — advancing would leave ` +
              `${planItemsOpen === 1 ? "it" : "them"} unbuilt behind a stage that treats implementation as done.`,
          }
        : {
            kind: "option",
            optionId: "acknowledgeAdvance",
            reasoning:
              `${stageName} already met its score threshold; the remaining blocker(s) are outside automation's ` +
              "control, so advancing now and dealing with Publish's own audited override later is the same choice " +
              "you would otherwise face at that gate.",
          },
    gating: {
      holdsTaskPaused: false,
      unblocksProgress: false,
      detail: autoAdvanceMayPreempt
        ? "This does not pause the task, and nothing here is required before proceeding — auto-advance may move " +
          `${stageName} on its own, in which case this notice is withdrawn automatically.`
        : "This does not pause the task, and nothing here is required before proceeding — the task simply " +
          `stays on ${stageName} until you pick an option.`,
    },
  };
  const posted = await postWorkflowDecisionV1(decisionInput, {
    canonicalId: target.canonicalId,
    taskFolderPath: target.taskFolderPath,
    stage,
    taskName: target.taskName,
  });
  if (posted) {
    const ownerEvidenceBlocker = nonFixable.find(({ description, resolver }) =>
      (isEnvironmentalResolverV1(resolver) || resolver === "needs-toolchain") &&
      OWNER_EVIDENCE_PREFIX_RE.test(description)
    );
    if (ownerEvidenceBlocker) {
      await postOwnerEvidenceQuestionV1(
        folderUri,
        stage,
        ownerEvidenceBlocker.description,
        target.taskName,
        blockerOwnerIdentityV1(ownerEvidenceBlocker)
      );
    }
  }
  return posted !== undefined;
}

/**
 * Post-1.0 fixes, item 9: a plan checklist item that only asks for a check to
 * be run or confirmed (a verification item) rather than for code to be built.
 * Used to decide which exit a latched-review card recommends: moving on is
 * reasonable when every open item is of this kind, building is not.
 */
const VERIFICATION_ITEM_RE =
  /^(?:step\s+\d+\s*[:—–-]\s*|\d+\.\s*)?(?:\*\*[^*]+\*\*\s*)?(?:verify|confirm|check\s+(?:that|whether)|manually|run\s+(?:the\s+)?(?:full\s+|unit\s+|targeted\s+)?(?:tests?|suite|lint|type[- ]?check|check-types|verify)|owner\s+check|inspect\s+(?:the\s+)?(?:effective|live))\b|verified by publish checks/i;

export function isVerificationChecklistItemV1(itemText: string): boolean {
  return VERIFICATION_ITEM_RE.test(itemText.trim());
}

/**
 * review2 Step 7 (bugs6 item 26): which exit the latched clean-review card recommends. "Back to Implementation" is
 * recommended only when a round can act on the open items: the review did not say nothing is left to build, and at
 * least one open item is build work (not a verification item, and not waiting on test evidence an editing round
 * cannot produce). Otherwise the way on is to settle the items or move on, and the reason says why.
 */
export function latchedOpenItemsRecommendationV1(
  open: { readonly items: readonly string[]; readonly total: number },
  reviewSaysNothingLeftToBuild: boolean
): { readonly kind: "option"; readonly optionId: "moveOn" | "backToImplementation"; readonly reasoning: string } {
  const complete = open.items.length > 0 && open.items.length === open.total;
  if (complete && open.items.every(isVerificationChecklistItemV1)) {
    return { kind: "option", optionId: "moveOn", reasoning: "Every open item is a verification item, which a build round cannot complete." };
  }
  if (complete && open.items.every((item) => isVerificationChecklistItemV1(item) || isTestDependentChecklistItemV1(item))) {
    return {
      kind: "option",
      optionId: "moveOn",
      reasoning:
        "Every open item is a verification item or waits on test evidence; an Implementation round cannot produce either. " +
        "Settle them from the open-items card (tick, exclude, or record a test run) or move on.",
    };
  }
  if (reviewSaysNothingLeftToBuild) {
    return {
      kind: "option",
      optionId: "moveOn",
      reasoning:
        "The review is clean and names no plan step still to build, so another Implementation round would have nothing to act on. " +
        "The open items need your tick or evidence: settle them from the open-items card, or move on.",
    };
  }
  return { kind: "option", optionId: "backToImplementation", reasoning: "At least one open item asks for work to be built, and the review did not say otherwise." };
}

/**
 * Post-1.0 fixes, item 9: the card a latched (`checklistProgressUnreliable`),
 * clean review posts INSTEAD of advancing silently while plan items are still
 * open after the reviewer-verified ticks were applied.
 *
 * `Move on` is the RC8 path unchanged — `resumeAndSetTaskStage` moves to the
 * next stage and dispatches its next action (the follow-up review), and
 * continues a Fast Forward run (`resumeFastForward`, captured now). `Back to
 * Implementation` returns the task there. Move on is recommended only when
 * every open item is a verification item.
 */
export async function postLatchedOpenItemsDecisionV1(
  stage: TaskStage,
  nextStage: TaskStage,
  open: { readonly items: readonly string[]; readonly total: number },
  target: { canonicalId: string; taskFolderPath: string; taskName?: string },
  /**
   * bugs3 Step 7: work the task description or the plan defers, or gates
   * behind an open owner gate. Listed apart from the open items, never counted
   * in them, and never a reason to recommend Back to Implementation.
   */
  carried?: { readonly deferred: ScopedItemListV1; readonly gated: ScopedItemListV1 },
  /** bugs4 item 30: the plan's "N open, of which M are owner hand-offs" line. */
  openSummary?: string,
  /** review2 Step 7: the review is clean and names no plan step still to build, so a round has nothing to act on. */
  reviewSaysNothingLeftToBuild?: boolean
): Promise<boolean> {
  const stageName = STAGE_DISPLAY_NAMES[stage];
  const nextStageName = STAGE_DISPLAY_NAMES[nextStage];
  const resumeFastForward = isFastForwardRunActiveV1(target.taskFolderPath);
  const noun = open.total === 1 ? "plan item is" : "plan items are";
  const listed = open.items.map((item) => `- ${item}`).join("\n");
  const more = open.total > open.items.length ? `\n- …and ${open.total - open.items.length} more` : "";
  const carriedSections = [
    describeCarriedItemsV1("Deferred by the task or plan (not counted as open)", carried?.deferred),
    describeCarriedItemsV1("Waiting on an owner gate the plan carries (not counted as open)", carried?.gated),
  ]
    .filter((section) => section !== "")
    .join("");
  const options: WorkflowDecisionOptionV1[] = [
    {
      optionId: "moveOn",
      label: "Move on",
      resumeKind: "continue",
      consequence:
        `Advances to ${nextStageName} and dispatches its next action${resumeFastForward ? ", continuing Fast Forward" : ""}, ` +
        `exactly as a clean review does. ${open.total} ${noun} still open and will not be built there.`,
      effect: {
        kind: "command",
        command: "vs-code-ai-helper.resumeAndSetTaskStage",
        args: [{ taskFolderPath: target.taskFolderPath, stage: nextStage, resumeFastForward, expectedSourceStage: stage }],
      },
    },
    {
      optionId: "backToImplementation",
      label: "Back to Implementation",
      resumeKind: "continue",
      consequence: `Moves the task back to Implementation and dispatches its next action there — ${open.total} ${noun} still open.`,
      effect: {
        kind: "command",
        command: "vs-code-ai-helper.resumeAndSetTaskStage",
        args: [{ taskFolderPath: target.taskFolderPath, stage: "impl" as TaskStage, resumeFastForward, expectedSourceStage: stage }],
      },
    },
  ];
  const posted = await postWorkflowDecisionV1(
    {
      decisionKey: "latchedCleanReviewOpenItems",
      taskCanonicalId: target.canonicalId,
      stage,
      whatHappened:
        // review2 Step 16: one word for the checklist's state across adjacent cards ("unreliable"), the one the
        // latch-cleared line and the idle card use, so two cards a second apart never read as a contradiction.
        `${stageName} is clean, but this task's plan checklist is flagged unreliable and ${open.total} ${noun} still open${openSummary ? ` (plan-wide: ${openSummary})` : ""}:\n\n` +
        `${listed}${more}${carriedSections}`,
      whyUserNeeded:
        "A clean review no longer holds the stage while the checklist is flagged unreliable, but moving on with plan items " +
        "still open should be your decision, not the default.",
      options,
      recommendation: latchedOpenItemsRecommendationV1(open, reviewSaysNothingLeftToBuild === true),
      gating: {
        holdsTaskPaused: false,
        unblocksProgress: true,
        detail: `The task stays on ${stageName} until you choose; a Fast Forward run waits here.`,
      },
    },
    { canonicalId: target.canonicalId, taskFolderPath: target.taskFolderPath, stage, taskName: target.taskName }
  );
  return posted !== undefined;
}

/**
 * Post-1.0 fixes, item 10: the review's verdict or next-work text names plan
 * steps still to be built, but it carries no `[completion]` blocker. The stage
 * is held, and this card says why.
 */
export async function postUnbuiltStepsHoldDecisionV1(
  stage: TaskStage,
  nextStage: TaskStage | undefined,
  sentence: string,
  target: { canonicalId: string; taskFolderPath: string; taskName?: string }
): Promise<boolean> {
  const stageName = STAGE_DISPLAY_NAMES[stage];
  const resumeFastForward = isFastForwardRunActiveV1(target.taskFolderPath);
  const options: WorkflowDecisionOptionV1[] = [
    {
      optionId: "backToImplementation",
      label: "Back to Implementation",
      resumeKind: "continue",
      consequence: "Moves the task back to Implementation and dispatches its next action there, to build the steps the review names.",
      effect: {
        kind: "command",
        command: "vs-code-ai-helper.resumeAndSetTaskStage",
        args: [{ taskFolderPath: target.taskFolderPath, stage: "impl" as TaskStage, resumeFastForward, expectedSourceStage: stage }],
      },
    },
    ...(nextStage
      ? [
          {
            optionId: "moveOn",
            label: `Move on to ${STAGE_DISPLAY_NAMES[nextStage]} anyway`,
            resumeKind: "continue" as const,
            consequence: `Advances with the named steps unbuilt and dispatches ${STAGE_DISPLAY_NAMES[nextStage]}'s next action.`,
            effect: {
              kind: "command" as const,
              command: "vs-code-ai-helper.resumeAndSetTaskStage",
              args: [{ taskFolderPath: target.taskFolderPath, stage: nextStage, resumeFastForward, expectedSourceStage: stage }],
            },
          },
        ]
      : []),
  ];
  const posted = await postWorkflowDecisionV1(
    {
      decisionKey: "reviewNamesUnbuiltSteps",
      taskCanonicalId: target.canonicalId,
      stage,
      whatHappened:
        `${stageName} scored above the threshold and lists no completion blocker, but its own text says plan steps ` +
        `are still to be built: "${sentence}" A review that says work remains cannot also be ready, so the stage was not advanced.`,
      whyUserNeeded: "Advancing on unfinished work should be your decision, not the default.",
      options,
      recommendation: {
        kind: "option",
        optionId: "backToImplementation",
        reasoning: "The review itself says the named steps are not built yet.",
      },
      gating: {
        holdsTaskPaused: false,
        unblocksProgress: true,
        detail: `The task stays on ${stageName} until you choose.`,
      },
    },
    { canonicalId: target.canonicalId, taskFolderPath: target.taskFolderPath, stage, taskName: target.taskName }
  );
  return posted !== undefined;
}

/**
 * A backtick-quoted span inside a blocker's own description that looks like a
 * runnable command (starts with a recognized CLI verb) — e.g. a reviewer
 * writing `` `npm run check-competition-template-status` `` as part of the
 * blocker text. When present, naming it is strictly more useful than the
 * generic "no command in this product can run it" line, and — per the
 * review-narrowed blocker this exists to fix — that generic line is not even
 * true for a blocker that names its own remedy command.
 */
const COMMAND_LIKE_PREFIX_RE =
  /^(npm|npx|yarn|pnpm|node|git|python|python3|bash|sh|make|cargo|go|curl|vs-code-ai-helper\.)\b/i;

function extractNamedCommandV1(description: string): string | undefined {
  const spanRe = /`([^`]+)`/g;
  let match: RegExpExecArray | null;
  while ((match = spanRe.exec(description)) !== null) {
    const candidate = match[1]?.trim();
    if (candidate && COMMAND_LIKE_PREFIX_RE.test(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * RC3 item 3 review fix: a command is attached only when the BLOCKER'S OWN
 * description names it — never one found elsewhere in the review round's
 * markdown or in the approved plan. The earlier cross-document scanning
 * (matching a backtick-quoted command on some other line against the
 * blocker's vocabulary) attached commands that had nothing to do with this
 * specific blocker (the RC2 "Step 49 started before Step 48/G2" blocker was
 * given the plan's unrelated "Round check: lint, …" command this way). This
 * is now a thin alias for `extractNamedCommandV1` kept so call sites read as
 * "the command this blocker correlates with", which today can only ever be
 * a command the blocker itself quotes.
 */
function extractCorrelatedCommandV1(description: string): string | undefined {
  return extractNamedCommandV1(description);
}

/**
 * Sub-classifies an `environmental` blocker's actual clearing action from its
 * OWN description text, instead of assuming every environmental blocker is
 * an infra/sandbox/OS fix. Review-narrowed blocker `57e9485f-…-1`: that
 * blanket assumption is false for the plan's own observed cases — an owner
 * approving a policy (`[architectural] [environmental] the owner must
 * approve a complete tie policy…`) and a third-party status still pending
 * (`"Both submitted v3 templates remain PENDING at Meta"`) are both
 * classified `environmental` (no further automated round can move either
 * one) but neither is an infrastructure/sandbox/OS defect, and both DO have
 * a concrete human action, just not a code fix.
 *
 * RC3 item 3 review fix: a blocker about plan ORDER (a step started before a
 * predecessor it depends on) or about a step no round can complete (a human
 * gate, a hand-off, a measurement) is also an owner decision, not a code fix
 * — recognised explicitly here so the RC2 "Round 3.2 Step 49 was started
 * before the required Step 48/G2 predecessor completed" blocker lands in the
 * same bucket. Anything else this classifier cannot place is ALSO now an
 * owner decision by default, not the old blanket "infrastructure, sandbox,
 * or OS-level fix" guess — that guess was routinely wrong (it sent the owner
 * to unrelated infra work for a plan-ordering conflict only a human can
 * resolve), and the product has no way to tell a genuine infra defect apart
 * from an unclassified one without guessing.
 */
const PLAN_ORDER_BLOCKER_RE =
  /\bstarted before\b[\s\S]*\bpredecessor\b|\bpredecessor\b[\s\S]*\bstarted before\b|\bout of order\b|\bdepends on step \d+/i;
const ROUND_CANNOT_COMPLETE_RE = /\b(human gate|hand[- ]?off|a measurement)\b/i;

/** RC4 item 4: the literal prefix plan/impl reviews use for evidence only the owner can gather. */
export const OWNER_EVIDENCE_PREFIX_RE = /^\W*owner evidence needed\b/i;

export type EnvironmentalBlockerKindV1 = "owner-decision" | "external-status" | "owner-evidence" | "agent-gatherable";

export function classifyEnvironmentalBlockerV1(description: string): EnvironmentalBlockerKindV1 {
  if (AGENT_CAN_GATHER_RE.test(description)) {
    return "agent-gatherable";
  }
  if (OWNER_EVIDENCE_PREFIX_RE.test(description)) {
    return "owner-evidence";
  }
  if (PLAN_ORDER_BLOCKER_RE.test(description) || ROUND_CANNOT_COMPLETE_RE.test(description)) {
    return "owner-decision";
  }
  const EXTERNAL_STATUS_RE = /\b(pending|awaiting|third[- ]?party|external (service|system|review|api))\b/i;
  if (EXTERNAL_STATUS_RE.test(description)) {
    return "external-status";
  }
  return "owner-decision";
}

/**
 * bugs5 Step 22: determine whether a blocker requires an owner decision.
 */
export function isOwnerDecisionBlockerV1(
  blockerOrDesc: string | (Pick<ReviewBlocker, "description"> & { resolver?: string; category?: string }),
  ownerDecisionBlocks?: readonly { readonly id: string; readonly planPurpose?: string }[]
): boolean {
  const desc = typeof blockerOrDesc === "string" ? blockerOrDesc : blockerOrDesc.description ?? "";
  if (AGENT_CAN_GATHER_RE.test(desc)) {
    return false;
  }
  if (hasNarrowingPrefixV1(desc)) {
    return true;
  }
  if (OWNER_EVIDENCE_PREFIX_RE.test(desc)) {
    return true;
  }
  if (
    /^\W*(?:owner decision (?:needed|required)|needs (?:an? )?owner decision|owner approval (?:needed|required)|needs (?:an? )?owner approval)\b/i.test(
      desc
    )
  ) {
    return true;
  }
  if (ownerDecisionBlocks && ownerDecisionBlocks.length > 0) {
    const descLower = desc.toLowerCase();
    if (
      ownerDecisionBlocks.some(
        (b) =>
          descLower.includes(b.id.toLowerCase()) ||
          (b.planPurpose && descLower.includes(b.planPurpose.toLowerCase()))
      )
    ) {
      return true;
    }
  }
  // A blocker a round can clear is never owner-only, whatever words its text happens to contain.
  if (typeof blockerOrDesc !== "string" && blockerOrDesc.resolver === "task-fixable") {
    return false;
  }
  return PLAN_ORDER_BLOCKER_RE.test(desc) || ROUND_CANNOT_COMPLETE_RE.test(desc);
}

/** Resolve the deliberately narrow post-install move-on case. */
export function resolveDeferrableOwnerChecksV1(
  stage: TaskStage,
  blockers: readonly { readonly description: string; readonly resolver: string }[],
  planOfRecord: string
): readonly string[] | undefined {
  if (!IMPL_REVIEW_STAGES.includes(stage) && stage !== "publish") {
    return undefined;
  }
  if (blockers.length === 0) {
    return undefined;
  }
  const matches = blockers.map(({ description, resolver }) => ({
    description,
    resolver,
    handoff: resolveExcludedOwnerHandoffV1(description, planOfRecord),
  }));
  if (!matches.every(({ description, resolver, handoff }) =>
    (isEnvironmentalResolverV1(resolver) || resolver === "needs-toolchain") &&
    classifyEnvironmentalBlockerV1(description) === "owner-evidence" &&
    handoff !== undefined && !handoff.isPrerequisite
  )) {
    return undefined;
  }
  return matches.map(({ handoff }) => handoff!.itemText.slice(0, 320));
}

/**
 * Item 7b, review-narrowed blocker `-1`: the plateau escalation's "what
 * clears this" line used to name the union of every reason a blocker can be
 * non-task-fixable ("a human decision, an external system, or a toolchain
 * step") regardless of which one actually applies. `BlockerResolver`
 * (reviewReadiness.ts) already classifies each blocker into exactly one of
 * these — this derives the concrete clearing action from THAT classification
 * AND the blocker's own description text (not the resolver class alone,
 * which the review found conflates an owner-approval or third-party-status
 * case with a generic infra/sandbox/OS fix), naming an inline command only
 * when the blocker's OWN description quotes one (RC3 item 3 — a command
 * found only elsewhere in the review or in the plan is never attached, since
 * it may have nothing to do with this specific blocker).
 */
function describeResolverClearingActionV1(
  resolver: BlockerResolver,
  description: string,
  stageName: string,
  narrowingOffered = true
): string {
  const namedCommand = extractCorrelatedCommandV1(description);
  // RC4 item 3: a narrowing is an owner decision answered on the card itself.
  // RC7 item 1: only when the card really offers the two options; otherwise
  // say how to record the decision instead of naming options that are absent.
  if ((isEnvironmentalResolverV1(resolver) || resolver === "task-fixable") && hasNarrowingPrefixV1(description)) {
    return narrowingOffered
      ? 'an owner decision on the plan item named above — choose "Accept this narrowing" or ' +
          '"Keep the item open" on this card'
      : "an owner decision on the plan item this blocker names — answer it on the owner-decision card in this " +
          "chat; the answer is recorded in task.md under Owner decisions and in the plan's Accepted Non-Goals, " +
          `and ${stageName} re-reviews it`;
  }
  // RC4 item 4: a blocker filed with the literal "Owner evidence needed"
  // prefix names evidence rounds cannot gather. It is an owner decision
  // whichever resolver the reviewer used (needs-toolchain is the defensive
  // case), and the record goes in task.md directly — never the stage chat,
  // whose file write is confirmed by a modal.
  if ((isEnvironmentalResolverV1(resolver) || resolver === "needs-toolchain") && classifyEnvironmentalBlockerV1(description) === "owner-evidence") {
    // Owner evidence is typically a live provider CLI probe (`claude --model …`),
    // which the generic command-prefix list does not recognise, so the first
    // backtick-quoted span in the blocker is offered instead.
    const evidenceCommand = namedCommand ?? /`([^`]+)`/.exec(description)?.[1]?.trim();
    return (
      "evidence only you can gather (the concrete check is named above; do it after installing this build when it requires the installed product, or now when it does not; rounds cannot fetch pages or run live provider CLIs) — " +
      (evidenceCommand ? `run \`${evidenceCommand}\` to gather it, then ` : "gather it, then ") +
      "paste it into the Owner evidence answer field in Chat (or edit this task's task.md by hand), " +
      `and submitting it will save the answer and have ${stageName} re-verify.`
    );
  }
  switch (resolver) {
    case "environmental-fixable":
    case "environmental": {
      const kind = classifyEnvironmentalBlockerV1(description);
      if (kind === "external-status") {
        return (
          "a status change at an external system this task does not control — " +
          (namedCommand
            ? `run \`${namedCommand}\` to check current status, then `
            : "check its current status yourself, then ") +
          `use "Keep iterating" to have ${stageName} re-verify once it changes.`
        );
      }
      return (
        "an owner decision on the point described above — " +
        (namedCommand ? `run \`${namedCommand}\` to gather what you need, then ` : "") +
        "state it in this task's stage chat (it can record " +
        `the decision into the plan for you), then use "Keep iterating" to have ${stageName} re-verify.`
      );
    }
    case "unverifiable":
      return (
        "evidence the reviewer could not confirm within its own limits — supply what it says it could not see " +
        (namedCommand ? `(run \`${namedCommand}\`, gather the missing log, etc.) ` : "(run the missing check, gather the missing log, etc.) ") +
        `yourself, then use "Keep iterating" to have ${stageName} re-verify.`
      );
    case "spec-defect":
      return (
        'a change to the requirement itself, not the implementation — see "Change the plan instead" ' +
        "below; the acceptance criterion as written may not be satisfiable."
      );
    case "needs-toolchain":
      return (
        "running the project's own build/codegen/toolchain step from outside this task " +
        (namedCommand ? `(run \`${namedCommand}\`)` : "(e.g. a build or generator command)") +
        ` — the implementation stage cannot run it; do that yourself, then use "Keep iterating" to have ` +
        `${stageName} re-verify.`
      );
    case "task-fixable":
      return `another implementation round — use "Keep iterating" below.`;
    case "unknown":
      return (
        "a decision on what kind of blocker this is — the review wrote the line without saying who can resolve it. " +
        `Read it above; if building the named plan steps clears it, use "Keep iterating" to have ${stageName} re-verify.`
      );
  }
}

/**
 * One sentence (leading space included; empty when there are no blockers)
 * stating where the remaining blockers stand relative to earlier rounds, from
 * the `[new]` / `[same:…]` / `[narrowed:…]` lineage marker the reviewer already
 * declares in the artifact (v1 fixes 2, item 5). A blocker with no declared
 * lineage is reported as such rather than guessed at. Narrowed blockers are
 * called out as progress: a score that did not move beside a narrowed blocker
 * is a shrinking problem, not a repeated one.
 *
 * @internal exported for testing
 */
export function describeBlockerLineageV1(blockers: readonly ReviewBlocker[]): string {
  if (blockers.length === 0) {
    return "";
  }
  const refs = (kind: "narrowed" | "same"): string =>
    blockers
      .flatMap((b) => (b.lineage?.kind === kind ? [`\`[${kind}:${b.lineage.refId}]\``] : []))
      .join(", ");
  const count = (kind: "new" | "narrowed" | "same"): number => blockers.filter((b) => b.lineage?.kind === kind).length;
  const narrowed = count("narrowed");
  const same = count("same");
  const fresh = count("new");
  const undeclared = blockers.filter((b) => b.lineage === undefined).length;
  const plural = (n: number): string => (n === 1 ? "blocker" : "blockers");
  const parts: string[] = [];
  if (narrowed > 0) {
    parts.push(
      `${narrowed} ${plural(narrowed)} narrowed from an earlier round (declared ${refs("narrowed")}) — ` +
        `iteration IS making progress on ${narrowed === 1 ? "it" : "them"}, ${narrowed === 1 ? "it has" : "they have"} ` +
        "simply not cleared yet"
    );
  }
  if (same > 0) {
    parts.push(
      `${same} ${plural(same)} unchanged from an earlier round (declared ${refs("same")}) — the last round did not ` +
        `move ${same === 1 ? "it" : "them"}`
    );
  }
  if (fresh > 0) {
    parts.push(`${fresh} ${plural(fresh)} newly raised this round`);
  }
  if (undeclared > 0) {
    parts.push(`${undeclared} ${plural(undeclared)} with no lineage declared by the reviewer`);
  }
  return ` Lineage: ${parts.join("; ")}.`;
}

/**
 * Build and post the `reviewPlateauEscalation` decision (item 7b's target
 * shape): quote the blocker verbatim rather than its category taxonomy, show
 * the evidence automation is done (taskFixableCount, the progress marker),
 * recommend exactly one option with the reason it wins here, explain why each
 * rejected option is wrong in THIS instance, name what would clear the
 * blocker, and cite any `[narrowed:…]` lineage instead of implying no
 * iteration has made progress. Modeled on jester's
 * `check-competition-template-status.ts`, per the task's own worked example.
 *
 * Returns whether the decision was actually posted (no extension context
 * available is the one expected failure mode, mirroring every other
 * `postWorkflowDecisionV1` call site) — the caller falls back to the plain
 * chat-question path when this returns false, so an escalation is never
 * silently dropped just because this richer surface could not be posted.
 */
async function postReviewPlateauDecisionV1(
  folderUri: vscode.Uri,
  stage: TaskStage,
  reason: string,
  evidence: ReviewPlateauEvidenceV1,
  target: { canonicalId: string; taskFolderPath: string; stage: TaskStage; taskName?: string }
): Promise<boolean> {
  const stageName = STAGE_DISPLAY_NAMES[stage];
  // Review-flagged (2026-08-25, new architectural blocker): `evidence.blockers`
  // is always THIS round's own just-published finding (see
  // `ReviewPlateauEvidenceV1`'s doc comment) — the newest evidence that
  // exists for this stage. An OLDER `TaskProgress.blockerSupersessions` entry
  // records that some earlier, now-stale review artifact was resolved via
  // chat; it must never suppress a fresh round independently re-finding the
  // identically-worded blocker, since doing so previously let a genuinely
  // still-live blocker vanish from both this decision and
  // `reviewScoreHistory` permanently (the caller never persists a blocker
  // this function filtered out). `filterSupersededBlockersV1` is therefore
  // not called here — see its doc comment on why fresh review content is
  // never filtered by a supersession.
  const normalized = normalizeReviewEvidenceV1(evidence.content, evidence.blockers);
  let ownerChecksOwed: string[] = [];
  if (IMPL_REVIEW_STAGES.includes(stage) || stage === "publish") {
    const planText = await readTextIfExists(getCanonicalImplementationUri(folderUri));
    const progressRead = await readTaskProgressStrictV1(folderUri, {
      expectedTaskFolder: path.basename(target.taskFolderPath),
    });
    if (planText && progressRead.ok) {
      const history = progressRead.decoded.progress.reviewScoreHistory ?? [];
      const supersededDescriptions = new Set(
        (progressRead.decoded.progress.blockerSupersessions ?? []).map((entry) => entry.blockerDescription.trim())
      );
      // Historical review rows are snapshots, not a live blocker set. Only
      // the newest recorded round for this stage can describe blockers that
      // remain current; unioning every older round lets a resolved task-fixable
      // blocker veto the owner-check move-on option forever.
      const latestStageReview = history
        .filter((entry) => entry.stage === stage)
        .reduce<(typeof history)[number] | undefined>(
          (latest, entry) => !latest || entry.at > latest.at ? entry : latest,
          undefined
        );
      const recordedBlockers = [
        ...(normalized.blockers.length > 0 ? [] : latestStageReview?.blockers ?? [])
          .filter((blocker) => !blocker.description || !supersededDescriptions.has(blocker.description.trim()))
          .flatMap((blocker) => blocker.description
            ? [{ description: blocker.description, resolver: blocker.resolver }]
            : []),
        ...normalized.blockers.map((blocker) => ({ description: blocker.description, resolver: blocker.resolver })),
      ].filter((blocker, index, all) =>
        all.findIndex((candidate) => candidate.description === blocker.description) === index
      );
      ownerChecksOwed = [...(resolveDeferrableOwnerChecksV1(stage, recordedBlockers, planText) ?? [])];
    }
  }
  const primaryBlocker = normalized.blockers[0];
  // v1 fixes 2, item 5: state every remaining blocker's lineage (new / narrowed
  // / unchanged) in the card's own summary — an unchanged score with a
  // narrowed blocker is progress, and must not read as a repeat.
  const narrowedNote = describeBlockerLineageV1(normalized.blockers);
  // A3 (2026-09-06): render the checklist-reconciled figure here, never
  // `normalized.progress`'s raw, self-reported marker — a reviewer that
  // invents its own denominator (46 vs plan-final.md's real 127) produced a
  // frozen "13 of 46 plan steps verified" beside a live, correct "49/127
  // items settled" elsewhere on the same screen. `effectiveReviewProgressV1`
  // is the single reconciled source every other progress display already
  // reads from (see its own doc comment); this call site was the one place
  // still bypassing it in favor of the unreconciled marker.
  const effectiveProgress = await effectiveReviewProgressV1(folderUri, stage, evidence.content, "lenient");
  const progressNote =
    effectiveProgress !== null
      ? `${effectiveProgress.complete} of ${effectiveProgress.total} plan steps verified.`
      : "No plan-progress marker was reported for this round.";
  // RC2 item 3: only meaningful for a checklist-reconciled stage —
  // `effectiveReviewProgressV1` passes a plan-review stage's raw,
  // self-reported marker through unreconciled (see that function's doc
  // comment), which is not the implementation plan's checklist and must
  // never be read as "N implementation items still open".
  const planItemsOpen =
    !isPlanReviewStage(stage) && effectiveProgress !== null
      ? Math.max(
          0,
          effectiveProgress.total - effectiveProgress.complete - (await readDeferredOpenPlanItemCountV1(folderUri))
        )
      : 0;

  const nextStage = nextStageInOrderV1(stage);
  let nextStageHasRun = false;
  if (nextStage) {
    const filename = STAGE_ARTIFACT_FILENAMES[nextStage];
    if (filename) {
      const nextContent = await readTextIfExists(vscode.Uri.joinPath(folderUri, filename));
      nextStageHasRun = nextContent !== undefined && nextContent.trim().length > 0;
    }
  }
  const hasSpecDefect = normalized.blockers.some((b) => b.resolver === "spec-defect");
  // RC2 item 7, Step 29: every task-fixable blocker this round had was
  // reclassified because it matches a removal a prior implementer round
  // declined — recommending "Keep iterating" here would just re-run the
  // exact round that already declined it. `evidence.declinedBlockerCount`
  // only ever counts blockers reclassified OUT of task-fixable, so this can
  // be true only when `taskFixableCount === 0` — a genuinely separate
  // task-fixable blocker (unrelated to any decline) keeps `taskFixableCount`
  // positive and the normal "Keep iterating" recommendation applies instead.
  const hasDeclinedBlocker =
    evidence.taskFixableCount === 0 && (evidence.declinedBlockerCount ?? 0) > 0;
  // 1.0.0 gate, Part 4 / Step 14 (B4): same "non-task-fixable" definition
  // `postEnvironmentalAdvanceNoticeV1` uses (everything but `task-fixable` —
  // environmental, unverifiable, spec-defect, needs-toolchain), so the
  // Publish-consequence note and "publish over it" exit appear here under
  // the identical condition, not a narrower one.
  const hasNonFixableBlocker = normalized.blockers.some((b) => b.resolver !== "task-fixable");
  // Item 7b rule 5, "name what would clear the blocker, with the command if
  // one exists": when something is task-fixable, the clearing action IS
  // re-running the review (which "Keep iterating" now genuinely does — see
  // resumeAndRerunReviewV1's doc comment); when nothing is, no command in
  // this product can clear it, only an action outside the task.
  // 2026-09-04 review follow-up (completion blocker, new): this must describe
  // the SAME dispatch sequence as the "keepIterating" option's own consequence
  // text above (`buildEscalationDecisionV1`'s plateau branch) — Apply Review
  // edits the workspace against the task-fixable blockers FIRST, then
  // re-reviews. A prior revision said only "re-runs {stageName}", reading as
  // a review-only dispatch — the exact "review starts against an unchanged
  // tree" misdescription Part C, Step 4 exists to eliminate.
  // RC4 item 3: best effort, never fails the escalation.
  let narrowing: EscalationPlateauContextV1["narrowing"];
  try {
    if (isPlanReviewStage(stage)) {
      // RC7 item 1: no plan-final.md or implementation summary exists yet;
      // the item comes from plan.md, the reason and evidence from the review.
      const planMd = await readTextIfExists(
        vscode.Uri.joinPath(folderUri, STAGE_ARTIFACT_FILENAMES.plan ?? "plan.md")
      );
      const reviewFileName = STAGE_ARTIFACT_FILENAMES[stage] ?? "the plan review";
      const foundAtPlan = findPlanStageNarrowingBlockerV1(
        normalized.blockers,
        planMd,
        evidence.content,
        reviewFileName
      );
      if (foundAtPlan) {
        narrowing = {
          itemText: foundAtPlan.itemText,
          blockerDescription: foundAtPlan.blocker,
          reason: foundAtPlan.reason,
          reasonSource: foundAtPlan.reasonSource,
          evidence: foundAtPlan.evidence,
          evidenceSource: foundAtPlan.evidenceSource,
        };
      }
    } else {
    const planFinal = await readTextIfExists(getCanonicalImplementationUri(folderUri));
    // Not `STAGE_ARTIFACT_FILENAMES.impl`: that is the plan of record, not the round's summary.
    const implSummary = await readTextIfExists(vscode.Uri.joinPath(folderUri, IMPLEMENTATION_SUMMARY_FILENAME));
    let proposals: TaskProgress["checklistChangeProposals"];
    const read = await readTaskProgressStrictV1(folderUri, { expectedTaskFolder: path.basename(target.taskFolderPath) });
    if (read.ok) {
      proposals = read.decoded.progress.checklistChangeProposals;
    }
    const found = findNarrowingBlockerV1(normalized.blockers, planFinal, proposals, implSummary);
    if (found) {
      narrowing = {
        itemText: found.itemText,
        blockerDescription: found.blocker,
        reason: found.reason,
        reasonSource: found.reasonSource,
        evidence: found.evidence,
        evidenceSource: found.evidenceSource,
      };
    }
    }
  } catch {
    narrowing = undefined;
  }
  // RC7 item 1 & bugs5 Step 22: every remaining blocker is a narrowing, owner decision or owner evidence.
  const ownerDecisionBlocks = parseOwnerDecisionsNeededV1(evidence.content);
  const allBlockersNeedOwnerDecision =
    normalized.blockers.length > 0 &&
    normalized.blockers.every((b) => isOwnerDecisionBlockerV1(b, ownerDecisionBlocks));
  // bugs3 Step 7: owner evidence the plan itself defers to named later steps
  // is a carried gate, not a hold on this stage — and when it depends on a
  // resource the plan will create, pausing for the owner to gather it cannot
  // help. Everything else (evidence the plan needs to be written, any other
  // blocker) keeps the normal owner-decision recommendation.
  let carriedEvidence: CarriedEvidenceSummaryV1 = { allCarried: false, gates: [] };
  try {
    const planTextForGates = await readTextIfExists(
      isPlanReviewStage(stage)
        ? vscode.Uri.joinPath(folderUri, STAGE_ARTIFACT_FILENAMES.plan ?? "plan.md")
        : getCanonicalImplementationUri(folderUri)
    );
    if (planTextForGates !== undefined) {
      carriedEvidence = summarizeCarriedEvidenceV1(
        normalized.blockers,
        {
          carriedGates: await carriedGatesForStageV1(folderUri, stage, planTextForGates),
          ...(isPlanReviewStage(stage) ? { planText: planTextForGates } : {}),
        },
        (description) =>
          OWNER_EVIDENCE_PREFIX_RE.test(description) || classifyEnvironmentalBlockerV1(description) === "owner-evidence"
      );
    }
  } catch {
    carriedEvidence = { allCarried: false, gates: [] };
  }
  // RC7 item 3: open plan items and only unbuilt-work completion blockers.
  const planOfRecordText = isPlanReviewStage(stage)
    ? undefined
    : await readTextIfExists(getCanonicalImplementationUri(folderUri));
  const taskFixableAllUnbuiltWork =
    planItemsOpen > 0 &&
    evidence.taskFixableCount > 0 &&
    taskFixableAreAllUnbuiltWorkV1(normalized.blockers, planOfRecordText);
  const unbuiltWorkReferences =
    taskFixableAllUnbuiltWork && planOfRecordText !== undefined
      ? [
          ...new Set(
            normalized.blockers
              .filter((b) => b.resolver === "task-fixable" && b.origin !== "mechanical")
              .flatMap((b) =>
                resolveBlockerPlanReferencesV1(b.description, planOfRecordText)
                  .filter((r) => r.kind !== "part" && r.open > 0)
                  .map((r) => r.reference)
              )
          ),
        ]
      : [];
  // bugs4 items 18/21: unbuilt work among the blockers, and whether recent Apply Reviews moved anything.
  const taskFixableIncludesUnbuiltWork =
    planItemsOpen > 0 &&
    planOfRecordText !== undefined &&
    normalized.blockers.some(
      (b) =>
        b.resolver === "task-fixable" &&
        b.origin !== "mechanical" &&
        b.category === "completion" &&
        isUnbuiltWorkBlockerV1(b.description ?? "", planOfRecordText)
    );
  // bugs5 Step 22: the distinct open items the unbuilt-work blockers name, and how far the run has got.
  const unbuiltItemsNamedCount =
    taskFixableIncludesUnbuiltWork && planOfRecordText !== undefined
      ? new Set(
          normalized.blockers
            .filter((b) => b.resolver === "task-fixable" && b.origin !== "mechanical" && b.category === "completion")
            .flatMap((b) =>
              resolveBlockerPlanReferencesV1(b.description ?? "", planOfRecordText)
                .filter((r) => r.kind !== "part" && r.open > 0)
                .map((r) => r.reference)
            )
        ).size
      : 0;
  let runProgressNote: string | undefined;
  try {
    const runRead = await readTaskProgressStrictV1(folderUri, {
      expectedTaskFolder: path.basename(target.taskFolderPath),
    });
    const runSummary = runRead.ok ? summarizeReviewRunV1(runRead.decoded.progress.reviewScoreHistory ?? [], stage) : undefined;
    runProgressNote = runSummary ? describeReviewRunSummaryV1(runSummary) : undefined;
  } catch {
    runProgressNote = undefined;
  }
  // review2 Steps 18-19: how much of the change a review has read, for "Reviewed: N of M changed files".
  let coverage: ReviewCoverageSummaryV1 | undefined;
  if (IMPL_REVIEW_STAGES.includes(stage)) {
    try {
      const coverageRead = await readTaskProgressStrictV1(folderUri, {
        expectedTaskFolder: path.basename(target.taskFolderPath),
      });
      const coverageRoot = vscode.workspace.getWorkspaceFolder(folderUri)?.uri.fsPath;
      coverage =
        coverageRead.ok && coverageRoot !== undefined
          ? await readReviewCoverageSummaryV1(coverageRoot, coverageRead.decoded.progress)
          : undefined;
    } catch {
      coverage = undefined;
    }
  }
  let applyReviewRoundsClosedNone = 0;
  let provisionalTicks = 0;
  let reviewAffirmsOpenItemsBuilt = false;
  let narrowedBlockerRule: NarrowedBlockerV1 | undefined;
  try {
    const progressForMotion = await readTaskProgressStrictV1(folderUri, {
      expectedTaskFolder: path.basename(target.taskFolderPath),
    });
    if (progressForMotion.ok && !isPlanReviewStage(stage)) {
      const motion = progressForMotion.decoded.progress;
      // review2 Step 33: a blocker whose fixes keep closing one path and missing the next may need a rule the plan never stated.
      narrowedBlockerRule = detectNarrowedBlockerV1({
        stage,
        history: motion.reviewScoreHistory ?? [],
        ledger: motion.roundLedger,
      });
      applyReviewRoundsClosedNone = applyReviewRoundsClosedNoneV1({
        stage,
        ledger: motion.roundLedger,
        roundOutcomes: motion.roundOutcomes,
        planItemEvidence: motion.planItemEvidence,
        ownerDecisions: motion.planItemOwnerDecisions,
      });
      if (planOfRecordText !== undefined) {
        // review1 Step 5: the shared plan-item counts.
        provisionalTicks = computePlanItemCountsV1({ planText: planOfRecordText, progress: motion })?.provisional ?? 0;
        // bugs4 item 53: only the reviewer's own Verified Complete block can say "built".
        const provisionalItems = listProvisionalTickedItemsV1(
          planOfRecordText,
          motion.planItemEvidence ?? [],
          motion.planItemOwnerDecisions ?? []
        );
        reviewAffirmsOpenItemsBuilt = reviewNamesAllItemsBuiltV1(
          evidence.content,
          provisionalItems.map((item) => item.text),
          planOfRecordText
        );
      }
    }
  } catch {
    applyReviewRoundsClosedNone = 0;
  }
  const ownerDecisionClearing = carriedEvidence.allCarried
    ? describeCarriedGateClearingV1(carriedEvidence, stageName)
    : allBlockersNeedOwnerDecision
    ? [
        ...new Set(
          normalized.blockers.map((b) =>
            describeResolverClearingActionV1(b.resolver, b.description, stageName, narrowing !== undefined)
          )
        ),
      ].join("; and ")
    : undefined;
  const clearingNote =
    ownerDecisionClearing !== undefined
      ? `Clears via: ${ownerDecisionClearing}`
      : taskFixableAllUnbuiltWork
        ? `Clears via: choose "Build the ${planItemsOpen} open plan ${planItemsOpen === 1 ? "item" : "items"}" ` +
          `below — the remaining ${evidence.taskFixableCount === 1 ? "blocker is" : "blockers are"} work not yet ` +
          `built, which Implementation does and another ${stageName} round does not.`
    : taskFixableIncludesUnbuiltWork && applyReviewRoundsClosedNone >= APPLY_REVIEW_NO_PROGRESS_ROUNDS_V1
      ? `Clears via: choose "Build the ${planItemsOpen} open plan ${planItemsOpen === 1 ? "item" : "items"}" ` +
        `below. ${describeApplyReviewNoProgressV1(planItemsOpen, applyReviewRoundsClosedNone)}, so another ` +
        `Apply Review will not close them; any specific defect is left to the review that follows.`
    : evidence.taskFixableCount > 0
      ? `Clears via: choose "Keep iterating" below — it resumes the task and runs Apply Review against the ` +
        `${evidence.taskFixableCount} task-fixable ${evidence.taskFixableCount === 1 ? "blocker" : "blockers"}, ` +
        `editing the workspace to address ${evidence.taskFixableCount === 1 ? "it" : "them"}, then re-reviews ` +
        `${stageName} for a fresh verdict.`
      : primaryBlocker
        ? `Clears via: ${describeResolverClearingActionV1(primaryBlocker.resolver, primaryBlocker.description, stageName, narrowing !== undefined)}`
        : "Clears via: an action outside this task — no command in this product can resolve it. Once done, " +
          `"Keep iterating" resumes the task and re-runs ${stageName} to confirm.`;

  // Item 18 / review blocker (2026-08-26): a frozen `taskFixableCount` while
  // every recent round dispatched as `implementation` is a DISPATCH plateau
  // (Implementation only reads the checklist, so it structurally cannot move
  // the count — see `detectPlateau`'s doc comment), not evidence the problem
  // itself resists every action tried. Surfacing the modes lets the human
  // reading this card tell the two apart at a glance instead of having to
  // dig through run logs.
  const recentModes = recentDispatchModesForStageV1(evidence.stageRoundOutcomes, stage);
  // Review blocker, 2026-08-27 (narrowed blocker 2, second half): flag when
  // this window includes a legacy round whose true impl-review stage is
  // unknown — see `recentDispatchModesIncludeAmbiguousOriginV1`'s doc
  // comment. Without this, a mixed-origin count read as a clean same-stage
  // history with no indication otherwise.
  const hasAmbiguousOriginModes = recentDispatchModesIncludeAmbiguousOriginV1(
    evidence.stageRoundOutcomes,
    stage
  );
  const dispatchModeEvidence =
    recentModes.length > 0
      ? [
          {
            label: "Recent dispatch modes (oldest → newest)",
            detail:
              recentModes.map((mode) => mode ?? "unknown").join(", ") +
              (hasAmbiguousOriginModes
                ? " — includes round(s) recorded before per-stage attribution existed; their true impl-review stage is unknown, so they are shown here and in the other impl-review stage's evidence alike"
                : ""),
          },
        ]
      : [];

  // The full option/recommendation/gating construction lives in the shared
  // `buildEscalationDecisionV1` (review blocker, 2026-08-30) — this function's
  // remaining job is exactly the async evidence-gathering above, which the
  // synchronous builder cannot do itself (it has no `folderUri`).
  // review1 Step 37: one card per owner-only blocker. When the owner-decision card for this stage is already
  // waiting and every blocker is an owner decision, it IS the question; a second plateau card would ask the same
  // thing with different options.
  if (
    allBlockersNeedOwnerDecision &&
    hasPendingOwnerDecisionCardV1(target.canonicalId, stage, normalized.blockers.map(blockerOwnerIdentityV1))
  ) {
    return true;
  }
  // review1 Step 58: has the owner changed the review's inputs since it ran? Only then is "I've made changes —
  // re-check" an honest option.
  const plateauReviewArtifactName = STAGE_ARTIFACT_FILENAMES[stage];
  const reviewInputsChanged = plateauReviewArtifactName
    ? (
        await reviewInputsChangedSinceV1(folderUri.fsPath, path.join(folderUri.fsPath, plateauReviewArtifactName)).catch(() => ({
          changed: false,
        }))
      ).changed
    : false;
  const decision = await postWorkflowDecisionV1(
    {
    ...buildEscalationDecisionV1("plateau", stage, reason, target, {
      blockersCount: normalized.blockers.length,
      primaryBlockerDescription: primaryBlocker?.description,
      allBlockerDescriptions: normalized.blockers.map((b) => b.description),
      needsToolchainBlockers: normalized.blockers.filter((b) => b.resolver === "needs-toolchain").map((b) => b.description),
      needsToolchainBlockerIdentities: normalized.blockers
        .filter((b) => b.resolver === "needs-toolchain")
        .map((b) => blockerOwnerIdentityV1(b)),
      reviewInputsChanged,
      narrowedNote,
      progressNote,
      taskFixableCount: evidence.taskFixableCount,
      hasSpecDefect,
      hasDeclinedBlocker,
      hasNonFixableBlocker,
      nextStageHasRun,
      clearingNote,
      dispatchModeEvidence,
      planItemsOpen,
      allBlockersNeedOwnerDecision,
      allBlockersCarriedGates: carriedEvidence.allCarried,
      taskFixableAllUnbuiltWork,
      taskFixableIncludesUnbuiltWork,
      unbuiltItemsNamedCount,
      ...(runProgressNote ? { runProgressNote } : {}),
      applyReviewRoundsClosedNone,
      provisionalTicks,
      reviewAffirmsOpenItemsBuilt,
      unbuiltWorkReferences,
      ownerChecksOwed,
      ...(coverage ? { coverage } : {}),
      ...(narrowedBlockerRule ? { narrowedBlockerRule } : {}),
      ...(narrowing ? { narrowing } : {}),
    }),
    // review1 Step 37: which blockers this card asks about, so the Fast Forward stop card can tell it covers them.
    blockerIdentities: normalized.blockers.map(blockerOwnerIdentityV1),
    },
    target
  );
  return decision !== undefined;
}

/** Wire the Chat With AI provider so escalations can post a real question
 * there, not just a notification. Call once from extension.ts, mirroring
 * initNotificationRouter's singleton pattern. */
export function initReviewEscalationChat(provider: EscalationChatTarget): void {
  chatTarget = provider;
}

/** Test-only reset for the module-level `chatTarget` singleton, mirroring
 * `extensionContextV1.ts`'s `__extensionContextV1TestOnly` — lets a test that
 * wires a mock target (to reach the no-context fallback branch, which
 * requires a chat target WITHOUT an activating extension context) restore
 * the unset default afterward instead of leaking a stub into later tests in
 * the same process. */
export const __reviewEscalationChatTestOnly = {
  reset(): void {
    chatTarget = undefined;
  },
};

/**
 * Stop automated review iteration for this task and hand the decision to
 * the human: pause the task (the existing per-command paused guards then
 * starve the automation chain naturally — see stageTransition.ts and every
 * review command's entry check), record why, and surface it through every
 * channel a user might notice it from — Chat With AI (if wired), a
 * Notifications warning with a one-click way back in, and (via the
 * persisted `escalation` field) the task tree's stage description.
 *
 * Never throws: escalation is a best-effort notification path layered on
 * top of the existing review pipeline, and a failure here must not prevent
 * the review that triggered it from having already published successfully.
 *
 * Returns whether the pause/escalation record actually applied. Any of the
 * three write guards below (terminal-status, stage CAS, attempt CAS) can
 * silently decline the write — callers MUST check this before treating the
 * round as escalated: a declined write means no pause, no recorded reason,
 * no notification, and no chat question, so a caller that assumed success
 * anyway would suppress its own auto-advance/auto-publish dispatch for a
 * round that produced no visible outcome at all — a review that publishes,
 * records nothing, says nothing, and advances nothing.
 *
 * `extraMutation`, when supplied, is folded into the SAME
 * `patchTaskProgressStrictV1` transaction as the pause/escalation write —
 * applied only once the three CAS guards above have already decided to
 * apply (never on a declined write, and never as a separate patch a crash
 * could land between). Use this for state that must be durably true the
 * instant the task is paused for this reason (e.g. a remedy latch the
 * escalation reason names) rather than issuing a second
 * `patchTaskProgressStrictV1` call after this one returns.
 */
export async function escalateReviewToHuman(
  folderUri: vscode.Uri,
  stage: TaskStage,
  kind: EscalationKind,
  reason: string,
  reviewAttemptId: string | undefined,
  progressHint?: Pick<TaskProgress, "displayName">,
  secondOpinionAttempted = false,
  extraMutation?: (current: TaskProgress) => TaskProgress,
  /**
   * Item 7b: when `kind === "plateau"` and the caller has this in hand (a
   * review-stage plateau, not the implementation-side no-progress breaker —
   * see {@link ReviewPlateauEvidenceV1}'s doc comment), post the
   * `reviewPlateauEscalation` `WorkflowDecisionV1` instead of the plain chat
   * question below. Falls through to the plain question when omitted (every
   * non-plateau kind, and any plateau call site not yet supplying it) or when
   * posting the decision itself fails (no extension context available) — an
   * escalation must never go silent just because the richer surface could
   * not be posted.
   */
  reviewPlateauEvidence?: ReviewPlateauEvidenceV1,
  /** bugs4 item 47: the no-progress breaker raised this escalation after N rounds that changed no files. */
  breakerZeroChangeRounds?: number
): Promise<boolean> {
  try {
    let applied = false;
    await patchTaskProgressStrictV1(folderUri, (current) => {
      // Terminal-status guard: a task the user has already completed or
      // archived must never be forced back to "paused" by an escalation
      // decision that was computed against an earlier, now-stale snapshot
      // (this callback can run well after the review round that triggered
      // it, e.g. after a second-opinion AI call). Idempotent on an
      // already-paused task — recording the (possibly updated) reason is
      // still useful there.
      if (current.status === "completed" || current.status === "archived") {
        return current;
      }
      // Stage CAS: only apply when the task is still on the stage this
      // escalation is about. If it has already advanced (or been reverted
      // to a different stage) since the review round that decided to
      // escalate, pausing it now — with a reason naming a stage it isn't on
      // anymore — would be confusing and would incorrectly halt progress
      // that has already legitimately moved on.
      if (current.currentStage !== stage) {
        return current;
      }
      // Attempt CAS: only apply when this is still the attempt that most
      // recently claimed the stage. claimReviewAttempt (reviewActions.ts)
      // overwrites `reviewAttemptId` at the START of every review round —
      // same stage or not — so a same-stage, cross-window race is
      // distinguishable from "nothing else happened": if window B started
      // a newer round on this same stage (e.g. while window A's escalation
      // was still mid-flight through its own second-opinion AI call),
      // `reviewAttemptId` has already moved on even though `currentStage`
      // hasn't. Applying window A's stale escalation in that case would
      // pause the task out from under window B's independent, still-live
      // attempt. The expected value is whatever the caller just read from
      // persisted state — including `undefined` for an implementation-stage
      // task, where the field is legitimately absent (the impl transition
      // clears it; see taskProgressFieldPolicyV1). An escalation computed
      // against an absent id therefore applies only while the id is STILL
      // absent: if a review round has claimed the stage since, the write
      // declines exactly as it does for a mismatched string. Callers that
      // read no persisted state at all should keep passing "" (which can
      // never match), not `undefined` — an unread expectation is not an
      // expectation of absence.
      if (current.reviewAttemptId !== reviewAttemptId) {
        return current;
      }
      applied = true;
      const paused = updateTaskStatus(
        recordEscalation(current, { stage, kind, reason, at: new Date().toISOString(), secondOpinionAttempted }),
        "paused"
      );
      return extraMutation ? extraMutation(paused) : paused;
    });
    if (!applied) {
      return false;
    }

    // Item 7b: a review-stage plateau with real evidence in hand gets the
    // WorkflowDecisionV1 rebuild (quoted blocker, taskFixableCount, progress
    // marker, a single ranked recommendation) instead of the plain chat
    // question below. Falls through on posting failure (no extension
    // context) rather than doubling up or going silent.
    if (kind === "plateau" && reviewPlateauEvidence) {
      const posted = await postReviewPlateauDecisionV1(
        folderUri,
        stage,
        reason,
        reviewPlateauEvidence,
        {
          canonicalId: normalizePath(folderUri.fsPath),
          taskFolderPath: folderUri.fsPath,
          stage,
          taskName: progressHint?.displayName,
        }
      );
      if (posted) {
        const ownerEvidenceBlocker = reviewPlateauEvidence.blockers.find(({ description, resolver }) =>
          (isEnvironmentalResolverV1(resolver) || resolver === "needs-toolchain") &&
          OWNER_EVIDENCE_PREFIX_RE.test(description)
        );
        if (ownerEvidenceBlocker) {
          await postOwnerEvidenceQuestionV1(
            folderUri,
            stage,
            ownerEvidenceBlocker.description,
            progressHint?.displayName,
            blockerOwnerIdentityV1(ownerEvidenceBlocker)
          );
        }
        return true;
      }
    }

    // Every escalation with an extension context gets a durable decision
    // card. The specialized review-plateau card above remains the richer
    // path when fresh blocker evidence exists; this covers the two
    // implementation-side plateau callers and all environmental/spec-defect
    // callers that previously fell straight through to an unbound prose
    // question. Captured in its own variable (rather than built inline
    // inside the postWorkflowDecisionV1 call) so the no-context fallback
    // below can reuse the SAME options/labels rather than re-deriving a
    // second, potentially drifting enumeration of the same four choices.
    // RC2 item 3: same "never recommend Advance while the plan has unsettled
    // items" rule, applied to this generic card's Advance option — lenient
    // and lightweight (a display-only read, never throws) since this whole
    // function is a best-effort notification path that must never fail the
    // review round that triggered it.
    const genericPlanItemsOpen = !isPlanReviewStage(stage)
      ? Math.max(
          0,
          ((await readPlanItemCountsV1(folderUri, { mode: "display" }))?.gate.remaining ?? 0) -
            (await readDeferredOpenPlanItemCountV1(folderUri))
        )
      : 0;
    const breakerContext =
      breakerZeroChangeRounds !== undefined
        ? await readBreakerCardContextV1(folderUri, stage, breakerZeroChangeRounds, genericPlanItemsOpen)
        : undefined;
    // review1 Step 37: an environmental stop for a stage whose owner-decision card is already waiting is the same
    // question; the owner-decision card is the one to answer.
    // Only when that card asks about every blocker the latest review for this stage recorded: a card about one
    // blocker never hides the environmental stop for a different one.
    if (kind === "environmental") {
      const recordedProgress = await readTaskProgressStrictV1(folderUri, {
        expectedTaskFolder: path.basename(folderUri.fsPath),
      });
      const recordedHistory = recordedProgress.ok ? recordedProgress.decoded.progress.reviewScoreHistory ?? [] : [];
      const latestForStage = recordedHistory
        .filter((entry) => entry.stage === stage)
        .reduce<(typeof recordedHistory)[number] | undefined>(
          (latest, entry) => (!latest || entry.at > latest.at ? entry : latest),
          undefined
        );
      const recordedIdentities = (latestForStage?.blockers ?? []).map(blockerOwnerIdentityV1);
      if (hasPendingOwnerDecisionCardV1(normalizePath(folderUri.fsPath), stage, recordedIdentities)) {
        return true;
      }
      // review1 Step 48: a stop on blockers no in-plan round can clear names the broken check and Ensemble's own
      // environment for that run, and offers to investigate it. It replaces the generic four-option card.
      const environmentalCard = await buildEnvironmentalFailureCardForStageV1(
        folderUri,
        stage,
        reason,
        progressHint?.displayName,
        (latestForStage?.blockers ?? []) as readonly EnvironmentalEvidenceBlockerV1[],
        genericPlanItemsOpen
      );
      if (environmentalCard !== undefined) {
        const posted = await postWorkflowDecisionV1(environmentalCard, {
          canonicalId: normalizePath(folderUri.fsPath),
          taskFolderPath: folderUri.fsPath,
          stage,
          taskName: progressHint?.displayName,
        });
        if (posted !== undefined) {
          return true;
        }
      }
    }
    const genericDecisionInput = buildEscalationDecisionV1(
      kind,
      stage,
      reason,
      {
        canonicalId: normalizePath(folderUri.fsPath),
        taskFolderPath: folderUri.fsPath,
        taskName: progressHint?.displayName,
      },
      undefined,
      genericPlanItemsOpen,
      breakerContext
    );
    const genericDecision = await postWorkflowDecisionV1(genericDecisionInput, {
      canonicalId: normalizePath(folderUri.fsPath),
      taskFolderPath: folderUri.fsPath,
      stage,
      taskName: progressHint?.displayName,
    });
    if (genericDecision !== undefined) {
      if (OWNER_EVIDENCE_PREFIX_RE.test(reason)) await postOwnerEvidenceQuestionV1(folderUri, stage, reason.trim(), progressHint?.displayName);
      return true;
    }

    const stageName = STAGE_DISPLAY_NAMES[stage];
    // Genuinely blocking (not just "here's a question, work continues"): the
    // task is paused above and automated review iteration will not resume on
    // its own — error level, not warning, per the "can't proceed without
    // user feedback" contract for hard-blocked automation.
    //
    // Item 13 (2026-08-18..20 workflow-defects batch): a `plateau` escalation
    // is NEVER ridden through (shouldRideThroughEscalationV1 excludes it
    // unconditionally — see reviewActions.ts), so for that kind the pause is
    // certain and the unqualified claim below is accurate. Every OTHER kind
    // CAN be ridden through by a Fast Forward run configured to continue
    // through escalations (ensemble.resilience.fastForwardSurvivesEscalation)
    // — this function has no visibility into whether such a run is what
    // triggered it, so it cannot know in advance whether the pause it just
    // wrote will still hold a moment later. Claiming an unconditional pause
    // for those kinds was misleading: the pause could be undone within
    // seconds by the very automation the message tells the user has stopped.
    // Both the chat question text and blockedReason below state the real,
    // conditional truth instead of a claim that isPaused's ride-through
    // branch may falsify immediately.
    // Bound-answer fallback (Part 10 items 13d/13e, 2026-08-30 review
    // blocker): reached only when NO extension context is available at all
    // (postWorkflowDecisionV1's own best-effort no-op — see its doc comment),
    // which in production cannot happen once activate() has run
    // (setExtensionContextV1 and initReviewEscalationChat are both called
    // from there, in that order, and nothing ever clears it — see
    // extensionContextV1.ts). Reachable today only from a harness that wires
    // a chat target without an activating context. Even here the four
    // choices are never concatenated into prose: they are posted as a real
    // `StructuredQuestionV1` `singleChoice` interaction through
    // `askInteraction` — the SAME bound-questionId channel every other
    // question in the product uses, not a separate app-only mechanism — with
    // `actionKey: LOCAL_ONLY_INTERACTION_ACTION_KEY_V1` since there is no
    // coordinator operation behind this escalation (see that constant's doc
    // comment for how it settles).
    const promptText =
      kind === "plateau"
        ? `Automated review iteration is stuck on ${stageName} and paused the task: ${reason}\n\n` +
          "Choose how to proceed below."
        : `Automated review iteration is stuck on ${stageName} and paused the task: ${reason}\n\n` +
          "If a Fast Forward run is active with 'survive escalation' enabled, it may continue iterating to the " +
          "end of its current attempt budget before this pause takes effect (you'll see a follow-up notification " +
          "if so). Once the pause holds, choose how to proceed below.";
    const options: QuestionOptionV1[] = genericDecisionInput.options.map((option) => ({
      optionId: option.optionId,
      label: option.label,
      description: option.consequence,
    }));
    const optionEffects: Record<string, WorkflowDecisionOptionEffectV1> = Object.fromEntries(
      genericDecisionInput.options.map((option) => [option.optionId, option.effect])
    );
    const interactionQuestion: StructuredQuestionV1 = {
      questionId: allocateHex128IdV1(),
      kind: "singleChoice",
      prompt: promptText,
      required: true,
      options,
    };

    const blockedReason =
      kind === "plateau"
        ? `${stageName} is stuck: ${reason} The task has been paused — resume it once you've decided how to proceed.`
        : `${stageName} is stuck: ${reason} The task has been paused. If a Fast Forward run is active with ` +
          "'survive escalation' enabled, it may continue iterating to the end of its current attempt budget " +
          "before this pause takes effect (you'll see a follow-up notification if so) — otherwise, resume it " +
          "once you've decided how to proceed.";
    const canonicalId = normalizePath(folderUri.fsPath);
    if (chatTarget) {
      // No coordinator operation exists behind this escalation, so there is
      // no pre-derived binding to supply — `askInteraction` resolves the
      // task's Chat document identity itself (`resolveOrPrepareChatDocumentIdentityV1`)
      // when `binding` is omitted.
      //
      // "vs-code-ai-helper.postStageQuestion" pointed at a free-text
      // StageChatQuestion, which this structured interaction is not — omitted
      // here exactly as `askInteraction`'s own notification path omits it for
      // every other structured question (there is no generic "reopen this
      // interaction" command; the notification's own "Open Chat" affordance
      // still opens the panel via `forceOpen: true` below at escalation time).
      await chatTarget.askInteraction(
        {
          canonicalId,
          taskFolderPath: folderUri.fsPath,
          stage,
          taskName: progressHint?.displayName,
          interactionId: allocateHex128IdV1(),
          operationId: allocateHex128IdV1(),
          actionKey: LOCAL_ONLY_INTERACTION_ACTION_KEY_V1,
          sourceAttemptId: allocateHex128IdV1(),
          questions: [interactionQuestion],
          optionEffects,
        },
        true,
        { blocking: true, blockedReason }
      );
    } else {
      // No chat surface wired up (e.g. escalation running outside a full
      // extension host) — fall back to a standalone notification so the
      // escalation is still never silent.
      NotificationRouter.showError(
        `Can't proceed without user feedback — ${progressHint?.displayName ?? folderUri.fsPath}: ${blockedReason}`
      );
    }
    return true;
  } catch (error) {
    const taskLabel = progressHint?.displayName ?? folderUri.fsPath;
    NotificationRouter.showWarning(
      `${taskLabel}: ${STAGE_DISPLAY_NAMES[stage]} needs your input (${reason}), but recording the escalation failed: ` +
        (error instanceof Error ? error.message : String(error))
    );
    // Whether the patchTaskProgress write itself landed before throwing is
    // not knowable from here. Report false (not escalated) rather than
    // guess true: the caller's fallback is to let its own independent
    // threshold-based advance/publish logic run, which is always safe,
    // whereas wrongly suppressing it because of an assumed-but-unconfirmed
    // pause would strand the round with no visible outcome at all.
    return false;
  }
}

/**
 * Gathers the breaker card's evidence from the task's own files, best-effort: any unreadable
 * input leaves the conservative answer (nothing affirmed built, every open item unclaimed).
 */
async function readBreakerCardContextV1(
  folderUri: vscode.Uri,
  stage: TaskStage,
  zeroChangeRounds: number,
  planItemsOpen: number
): Promise<BreakerCardContextV1> {
  let reviewAffirmsOpenItemsBuilt = false;
  let provisional = 0;
  let gateCountNote: string | undefined;
  try {
    const planText = await readTextIfExists(getCanonicalImplementationUri(folderUri));
    const read = await readTaskProgressStrictV1(folderUri, { expectedTaskFolder: path.basename(folderUri.fsPath) });
    if (planText !== undefined && read.ok) {
      const motion = read.decoded.progress;
      const counts = computePlanItemCountsV1({ planText, progress: motion });
      provisional = counts?.provisional ?? 0;
      if (counts) {
        // review1 Step 5: the wording of the gap is unchanged; the figures come from the shared counts.
        const ticked = counts.verified + counts.provisional + counts.ownerSettled;
        const gapParts = [`${ticked} ticked`, `${counts.verified} verified by review`];
        if (counts.ownerSettled > 0) gapParts.push(`${counts.ownerSettled} settled by you`);
        if (counts.provisional > 0) gapParts.push(`${counts.provisional} awaiting review verification`);
        gateCountNote = `${describeOpenAndHandOffsFromCountsV1(counts) ?? `${planItemsOpen} open`}; ${gapParts.join(", ")}.`;
      }
      const filename = STAGE_ARTIFACT_FILENAMES[stage];
      const reviewText = filename ? await readTextIfExists(vscode.Uri.joinPath(folderUri, filename)) : undefined;
      if (reviewText !== undefined) {
        reviewAffirmsOpenItemsBuilt = reviewNamesAllItemsBuiltV1(
          reviewText,
          listProvisionalTickedItemsV1(planText, motion.planItemEvidence ?? [], motion.planItemOwnerDecisions ?? []).map(
            (item) => item.text
          ),
          planText
        );
      }
    }
  } catch {
    reviewAffirmsOpenItemsBuilt = false;
    provisional = 0;
  }
  return {
    zeroChangeRounds,
    planItemsOpen,
    reviewAffirmsOpenItemsBuilt,
    unclaimedOpenItems: Math.max(0, planItemsOpen - provisional),
    ...(gateCountNote !== undefined ? { gateCountNote } : {}),
  };
}

const OWNER_EVIDENCE_UP_FRONT_ASKED_KEY_V1 = "ensemble.ownerEvidenceUpFrontAsked.v1";

/**
 * review1 Step 44: before Implementation, one chat question listing the plan's "Owner evidence:" steps the owner
 * has not answered in task.md. Never blocks the round (Implementation goes on), asks each distinct set of steps
 * once per task, and posts nothing when every step is answered or the chat is not available. Returns whether a
 * question was posted.
 */
export async function postOwnerEvidenceUpFrontQuestionV1(options: {
  readonly folderUri: vscode.Uri;
  readonly stage: TaskStage;
  readonly planText: string;
  readonly taskMd: string;
  readonly taskName?: string;
  /**
   * Set when continuing a form that had no room for every step: only the unanswered steps after this one (the
   * last field the previous form showed) are asked.
   */
  readonly afterEvidence?: string;
  /** Test seam: where the asked-once record lives; defaults to the extension's workspace state. */
  readonly memento?: { get<T>(key: string): T | undefined; update(key: string, value: unknown): Thenable<void> | Promise<void> };
}): Promise<boolean> {
  const unanswered =
    options.afterEvidence === undefined
      ? listUnansweredOwnerEvidenceStepsV1(options.planText, options.taskMd)
      : listUnansweredOwnerEvidenceStepsAfterV1(options.planText, options.taskMd, options.afterEvidence);
  const steps = ownerEvidenceFormStepsV1(unanswered);
  if (steps.length === 0 || !chatTarget) {
    return false;
  }
  const canonicalId = normalizePath(options.folderUri.fsPath);
  const memento = options.memento ?? getExtensionContextV1()?.workspaceState;
  const asked = memento?.get<Record<string, string>>(OWNER_EVIDENCE_UP_FRONT_ASKED_KEY_V1) ?? {};
  const key = ownerEvidenceStepsKeyV1(steps);
  if (asked[canonicalId] === key) {
    return false;
  }
  // Owner decision 2026-11-04: one field for each step. The chat settles this form by writing every answered
  // field under `## Owner evidence` in task.md (chatView.ts); no coordinator operation sits behind it.
  await chatTarget.askInteraction(
    {
      canonicalId,
      taskFolderPath: options.folderUri.fsPath,
      stage: options.stage,
      taskName: options.taskName,
      interactionId: allocateHex128IdV1(),
      operationId: allocateHex128IdV1(),
      actionKey: LOCAL_ONLY_INTERACTION_ACTION_KEY_V1,
      sourceAttemptId: allocateHex128IdV1(),
      questions: buildOwnerEvidenceUpFrontQuestionsV1(steps),
    },
    false,
    { blocking: false }
  );
  await memento?.update(OWNER_EVIDENCE_UP_FRONT_ASKED_KEY_V1, { ...asked, [canonicalId]: key });
  return true;
}

/**
 * review1 Step 44: a form holds at most 16 fields, so after one is submitted, the steps it had no room for are
 * asked in the next form. `lastShownEvidence` is the evidence text of the last field the submitted form showed.
 * Reads the plan and task.md fresh, so answers just saved are taken into account. Returns whether a further form
 * was posted.
 */
export async function postRemainingOwnerEvidenceStepsV1(options: {
  readonly folderUri: vscode.Uri;
  readonly stage: TaskStage;
  readonly lastShownEvidence: string;
  readonly taskName?: string;
}): Promise<boolean> {
  const planText = await readTextIfExists(getCanonicalImplementationUri(options.folderUri));
  if (!planText) {
    return false;
  }
  const taskMd = (await readTextIfExists(vscode.Uri.joinPath(options.folderUri, "task.md"))) ?? "";
  return postOwnerEvidenceUpFrontQuestionV1({
    folderUri: options.folderUri,
    stage: options.stage,
    planText,
    taskMd,
    taskName: options.taskName,
    afterEvidence: options.lastShownEvidence,
  });
}

/**
 * review1 Step 45: when an owner-evidence request quotes a command on the read-only allowlist, the offer to run it.
 * The prompt shows the exact command; choosing "Run it for me" is the owner's confirmation, in the chat, and is
 * the only thing that runs it. A request that quotes nothing on the allowlist gets no offer.
 */
export function buildRunItForMeOfferV1(
  taskFolderPath: string,
  stage: TaskStage,
  blocker: string
): { readonly question: StructuredQuestionV1; readonly optionEffects: Record<string, WorkflowDecisionOptionEffectV1> } | undefined {
  const command = findAllowlistedCommandInTextV1(blocker);
  if (!command) {
    return undefined;
  }
  const runId = allocateHex128IdV1();
  const pasteId = allocateHex128IdV1();
  return {
    question: {
      questionId: allocateHex128IdV1(),
      kind: "singleChoice",
      prompt:
        `Ensemble can run this read-only command for you: \`${command.display}\`\n\n` +
        "It runs in your workspace with a 60 second limit, and nothing runs until you choose below. Anything that " +
        "looks like a secret is removed from the output before it is saved under `## Owner evidence`.",
      required: true,
      options: [
        {
          optionId: runId,
          label: `Run it for me: ${command.display}`,
          description: "Runs this one command, saves its exit status and output as your evidence, and re-runs the review.",
        },
        {
          optionId: pasteId,
          label: "I'll paste it myself",
          description: "Runs nothing. Answer the question above with what you find.",
        },
      ],
    },
    optionEffects: {
      [runId]: {
        kind: "command",
        command: RUN_OWNER_EVIDENCE_COMMAND_V1,
        args: [{ taskFolderPath, stage, blocker, commandLine: command.display }],
        recordedNext: `runs \`${command.display}\`, saves the result under Owner evidence and re-runs the review`,
      },
      [pasteId]: { kind: "doNothing", recordedNext: "runs nothing; paste the evidence into the question above" },
    },
  };
}

/**
 * review1 Step 50: the "I ran it — record the result" choice for a blocker whose evidence is a command the owner
 * runs outside the task. The effect opens the record prompts (command, exit code, output tail), writes the run under
 * `## Owner evidence` bound to the blocker's lineage id, and re-runs the review.
 */
export function buildRecordOwnerRunOptionV1(
  taskFolderPath: string,
  stage: TaskStage,
  blocker: string,
  /** The blocker's stable lineage identity (`blockerOwnerIdentityV1`); absent only when the caller has the text alone. */
  blockerLineageId?: string
): { readonly option: QuestionOptionV1; readonly effect: WorkflowDecisionOptionEffectV1 } {
  const optionId = allocateHex128IdV1();
  return {
    option: {
      optionId,
      label: "I ran it — record the result",
      description:
        "Asks for the command, its exit code and the end of its output, saves them under Owner evidence as your own " +
        "run, bound to this blocker, and re-runs the review. A review may still disagree, but it has to cite your record.",
    },
    effect: {
      kind: "command",
      command: RECORD_OWNER_RUN_COMMAND_V1,
      args: [{ taskFolderPath, stage, blocker, blockerLineageId: blockerLineageId ?? blockerOwnerIdentityV1({ description: blocker }) }],
      recordedNext: "asks what you ran and how it ended, saves it under Owner evidence and re-runs the review",
    },
  };
}

/**
 * The offer an owner-evidence request carries: "Run it for me" when it quotes an allowlisted command, and always
 * "I ran it — record the result" (review1 Step 50). Never undefined.
 */
export function buildOwnerEvidenceActionsOfferV1(
  taskFolderPath: string,
  stage: TaskStage,
  blocker: string,
  blockerLineageId?: string
): { readonly question: StructuredQuestionV1; readonly optionEffects: Record<string, WorkflowDecisionOptionEffectV1> } {
  const record = buildRecordOwnerRunOptionV1(taskFolderPath, stage, blocker, blockerLineageId);
  const run = buildRunItForMeOfferV1(taskFolderPath, stage, blocker);
  if (run && run.question.kind === "singleChoice") {
    // Between "Run it for me" and "I'll paste it myself".
    const options = [...run.question.options];
    options.splice(options.length - 1, 0, record.option);
    return {
      question: { ...run.question, options },
      optionEffects: { ...run.optionEffects, [record.option.optionId]: record.effect },
    };
  }
  const pasteId = allocateHex128IdV1();
  return {
    question: {
      questionId: allocateHex128IdV1(),
      kind: "singleChoice",
      prompt:
        "If you ran the command this blocker asks for outside the task, you can record the result here instead of " +
        "pasting it into the question above.",
      required: true,
      options: [
        record.option,
        { optionId: pasteId, label: "I'll paste it myself", description: "Records nothing. Answer the question above with what you find." },
      ],
    },
    optionEffects: {
      [record.option.optionId]: record.effect,
      [pasteId]: { kind: "doNothing", recordedNext: "records nothing; paste the evidence into the question above" },
    },
  };
}

async function postOwnerEvidenceQuestionV1(
  folderUri: vscode.Uri,
  stage: TaskStage,
  blocker: string,
  taskName?: string,
  blockerLineageId?: string
): Promise<void> {
  await postOwnerEvidenceQuestionTextV1(folderUri, stage, blocker, taskName);
  const offer = buildOwnerEvidenceActionsOfferV1(folderUri.fsPath, stage, blocker, blockerLineageId);
  if (offer && chatTarget) {
    await chatTarget.askInteraction(
      {
        canonicalId: normalizePath(folderUri.fsPath),
        taskFolderPath: folderUri.fsPath,
        stage,
        taskName,
        interactionId: allocateHex128IdV1(),
        operationId: allocateHex128IdV1(),
        actionKey: LOCAL_ONLY_INTERACTION_ACTION_KEY_V1,
        sourceAttemptId: allocateHex128IdV1(),
        questions: [offer.question],
        optionEffects: offer.optionEffects,
      },
      false,
      { blocking: false }
    );
  }
}

async function postOwnerEvidenceQuestionTextV1(
  folderUri: vscode.Uri,
  stage: TaskStage,
  blocker: string,
  taskName?: string
): Promise<void> {
  await chatTarget?.ask?.(
    {
      canonicalId: normalizePath(folderUri.fsPath),
      taskFolderPath: folderUri.fsPath,
      stage,
      taskName,
      question:
        `Owner evidence needed — ${OWNER_EVIDENCE_ANSWER_MARKER_V1}\n` +
        "Paste the output, or type what you found. Submitting saves it under `## Owner evidence` in this task's task.md and re-runs this stage's review. You can also edit task.md by hand.\n\n" +
        `Blocker: ${blocker}`,
    },
    true,
    { blocking: true, blockedReason: `${STAGE_DISPLAY_NAMES[stage]} is waiting for owner evidence.` }
  );
}
