import * as vscode from "vscode";
import { createHash } from "crypto";
import {
  BlockerSupersessionRecordV1,
  IMPL_REVIEW_STAGES,
  STAGE_ARTIFACT_FILENAMES,
  STAGE_DISPLAY_NAMES,
  TaskProgress,
  TaskStage,
  isPlanReviewStage,
  isReviewStage,
} from "../types/taskProgress";
import { appendOwnerDecisionV1 } from "../utils/ownerEvidenceV1";
import type { WorkflowDecisionCommandResultV1, WorkflowDecisionOptionV1, WorkflowDecisionV1 } from "../types/workflowDecisionV1";
import { normalizePath } from "../utils/taskRoot";
import { hasLiveWorkAdmissionBestEffortV1 } from "../state/workAdmissionV1";
import { armDeferredOptionRunV1 } from "../utils/deferredOptionRunV1";
import { taskOperations } from "../utils/taskOperations";
import { withTaskLock } from "../state/taskStateStore";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import { recordPlanItemOwnerDecisionV1 } from "../utils/taskProgressTransforms";
import {
  appendAcceptedNonGoalV1,
  cleanPlanItemTextV1,
  countTopLevelPlanItemsNamedV1,
  getPlanRevisionV1,
  listPlanItemIdsV1,
  normalizeChecklistItemTextV1,
  rewordChecklistItemV1,
  settleChecklistItemV1,
} from "../utils/implementationChecklist";
import { refreshPlanItemSettlementSnapshotV1 } from "./planItemSettlementNoticeV1";
import { getCanonicalImplementationUri } from "../utils/implementationArtifactResolver";
import { readTextIfExists, writeTextFileIfUnchangedV1 } from "../utils/fileUtils";
import { appendChatMessageV1 } from "../utils/chatHistoryStore";
import { logChatStatusToNotificationsV1 } from "../utils/chatStatusLogV1";
import {
  listPendingWorkflowDecisionsForTaskV1,
  postWorkflowDecisionV1,
  PostWorkflowDecisionInputV1,
  withdrawWorkflowDecisionsByKeyV1,
} from "../utils/workflowDecisionDispatchV1";
import { optionAppliesAtStageV1, planFileNameForStageV1 } from "../utils/optionAppliesAtStageV1";
import {
  blockerOwnerIdentityV1,
  findCardCoveringOwnerOnlyBlockersV1,
  ownerBlockerIdentityV1,
} from "../utils/ownerCardCoverageV1";
import { isPlanItemBlockerV1 } from "../utils/blockerWorkListV1";
import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import { OWN_WORDS_TYPE_HINT_V1, takeHandedOverOwnWordsTextV1 } from "../utils/ownWordsAnswerV1";
import { offerActionInChatV1 } from "../utils/chatActionOfferV1";
import { extractBuildNextLinesV1 } from "../utils/automationStopV1";
import {
  decideFollowUpRunV1,
  describeHeldFollowUpRunV1,
  heldWritesRemainingV1,
  noteHeldWriteV1,
  peekOwedRunV1,
  releaseHeldWriteV1,
  rememberOwedRunV1,
  takeOwedRunV1,
} from "../utils/ownerAnswerGroupV1";
import {
  assessDeviationAgainstReviewV1,
  deviationReviewViewTextV1,
  ParsedOwnerDecisionBlockV1,
  parseOwnerDecisionsNeededV1,
  parsePlanDeviationsV1,
  parseReviewBlockersDetailed,
  type ReviewBlocker,
  type PlanDeviationContextV1,
} from "../utils/reviewReadiness";

export const RECORD_OWNER_PLAN_DECISION_COMMAND_V1 = "vs-code-ai-helper.recordOwnerPlanDecisionV1";

const OWNER_DECISIONS_HEADING_RE = /(?:^|\n)##[ \t]+Owner Decisions[ \t]*\n/i;
const MAX_SUPERSESSION_DESCRIPTION_LENGTH = 300;
const PLAN_WRITE_ATTEMPTS = 3;

export interface RecordOwnerPlanDecisionArgV1 {
  readonly taskFolderPath: string;
  readonly stage: TaskStage;
  readonly blockerId: string;
  readonly optionId: string;
  readonly optionLabel: string;
  readonly planAction?: {
    readonly kind: "exclude" | "reword" | "approveDeviation" | "note";
    readonly itemText?: string;
    readonly items?: readonly string[];
    readonly newText?: string;
    /**
     * review1 Step 4: which of several identically worded top-level items a `reword` is about (1-based, plan order).
     * Required when `itemText` names more than one item; a text-only target that is ambiguous is refused.
     */
    readonly itemOccurrence?: number;
    /** review2 Step 38: what an approved deviation did differently (one line); names exactly what was approved. */
    readonly approvedChange?: string;
    /** review2 Step 38: the gap the deviation states it leaves undone. Left open unless `gapAccepted`. */
    readonly statedGap?: string;
    /** review2 Step 38: the owner accepted the stated gap as well as the change. */
    readonly gapAccepted?: true;
  };
  /** The chosen option keeps the plan as written: record the decision, but do not set the blocker aside. */
  readonly rejects?: boolean;
  readonly rawContentHash?: string;
  readonly note?: string;
  /** review1 Step 40: the blocker's own words, recorded with the answer in task.md. */
  readonly blockerText?: string;
  /**
   * review1 Step 40: the owner answers in their own words. The command asks for the text (a clicked-here input), records
   * it in task.md for the review to read, and changes neither the plan nor the blocker's standing: only the review can
   * say whether those words settle it.
   */
  readonly ownWords?: true;
  /**
   * review2 Step 34 ("Settle it with a rule"): after the answer is recorded, exactly one Apply Review follows (not the
   * review the plain own-words answer re-runs). The review's rule is the specification that round implements.
   */
  readonly thenApplyReview?: true;
}

const OWN_WORDS_OPTION_ID_V1 = "ownWords";

export interface OwnerPlanDecisionPlanChangeV1 {
  /** The plan text after the change (unchanged when the plan could not be read). */
  readonly planText: string | undefined;
  /** Checklist items the decision excluded, as they now read. */
  readonly settledItems: readonly string[];
  /** review2 Step 3: the issued id of each entry in `settledItems` (same index; `undefined` when none was found). */
  readonly settledItemIds: readonly (string | undefined)[];
  /**
   * review1 Step 4: items the decision reworded (the old text and the new line as it now reads). A reword settles
   * nothing: the new wording is a new item for the review to check.
   */
  readonly rewordedItems: readonly { readonly previous: string; readonly current: string }[];
}

export interface DeviationApprovalScopeV1 {
  /** What the owner approved, in words ("Approved the change: …"). */
  readonly approved: string;
  /** What stays open and is not approved (the stated gap), when the owner did not accept it. */
  readonly stillOpen?: string;
}

/**
 * review2 Step 38: exactly what an approval of a plan deviation covers. A card that stated a gap approves the change
 * only, unless the owner also accepted the gap. Returns undefined for any other answer (and for an approval whose card
 * recorded no change text), which keep the plain wording.
 */
export function deviationApprovalScopeV1(arg: RecordOwnerPlanDecisionArgV1): DeviationApprovalScopeV1 | undefined {
  const action = arg.planAction;
  if (arg.rejects || action?.kind !== "approveDeviation" || !action.approvedChange) {
    return undefined;
  }
  const change = action.approvedChange.replace(/[.\s]+$/, "");
  if (!action.statedGap) {
    return { approved: `Approved the change: ${change}` };
  }
  const gap = action.statedGap.replace(/[.\s]+$/, "");
  return action.gapAccepted
    ? { approved: `Approved the change: ${change}. Accepted the gap: ${gap}` }
    : { approved: `Approved the change only: ${change}`, stillOpen: gap };
}

/** The text recorded for an approval (task.md's answer, plan-final.md's note): what was approved, and what stays open. */
function deviationApprovalTextV1(scope: DeviationApprovalScopeV1): string {
  return scope.stillOpen !== undefined ? `${scope.approved}. Not approved, still open: ${scope.stillOpen}` : scope.approved;
}

/** The chat reply after an approval: what was recorded and, when a stated gap was not approved, what stays open. */
export function deviationApprovalReplyV1(scope: DeviationApprovalScopeV1, blockerId: string, recordedInTask: boolean): string {
  const open =
    scope.stillOpen !== undefined
      ? ` Still open: ${scope.stillOpen.replace(/[.\s]+$/, "")}. It stays a blocker for the next review unless you accept it or it is built.`
      : "";
  return `${scope.approved}.${open} Recorded for ${blockerId} in plan-final.md${recordedInTask ? " and task.md under Owner decisions" : ""}.`;
}

/** The review stages an owner decision is shown to: a round's own stage maps to both implementation reviews. */
function stagesForOwnerDecisionV1(stage: TaskStage): readonly TaskStage[] {
  return isReviewStage(stage) ? [stage] : IMPL_REVIEW_STAGES;
}

/** The line a decision adds under `## Owner Decisions` when it names no checklist item. */
function ownerDecisionSectionLineV1(arg: RecordOwnerPlanDecisionArgV1, decisionNote: string): string {
  return `- ${decisionNote} (${arg.blockerId}${arg.rejects && !arg.ownWords ? "; plan kept as written" : ""})`;
}

function addOwnerDecisionSectionLineV1(planText: string, line: string): string {
  if (planText.includes(line)) {
    return planText;
  }
  const heading = OWNER_DECISIONS_HEADING_RE.exec(planText);
  if (heading) {
    const insertAt = heading.index + heading[0].length;
    return `${planText.slice(0, insertAt)}${line}\n${planText.slice(insertAt)}`;
  }
  return `${planText.replace(/\s*$/, "")}\n\n## Owner Decisions\n\n${line}\n`;
}

/**
 * Applies the plan-final.md half of an owner decision: the named items are excluded (or reworded) with an
 * "Owner decision YYYY-MM-DD" note, or, when no item is named or the owner kept the plan, the decision is
 * written under `## Owner Decisions`. Uses the conditional plan writer, so a concurrent edit is retried rather
 * than overwritten.
 */
export async function applyOwnerPlanDecisionToPlanV1(
  planUri: vscode.Uri,
  arg: RecordOwnerPlanDecisionArgV1,
  decisionNote: string
): Promise<OwnerPlanDecisionPlanChangeV1> {
  const targetItems = arg.rejects
    ? []
    : arg.planAction?.items && arg.planAction.items.length > 0
      ? [...arg.planAction.items]
      : arg.planAction?.itemText
        ? [arg.planAction.itemText]
        : [];
  for (let attempt = 0; attempt < PLAN_WRITE_ATTEMPTS; attempt++) {
    const plan = await readTextIfExists(planUri);
    if (plan === undefined) {
      return { planText: undefined, settledItems: [], settledItemIds: [], rewordedItems: [] };
    }
    let next = plan;
    const settledItems: string[] = [];
    const settledItemIds: (string | undefined)[] = [];
    const rewordedItems: { previous: string; current: string }[] = [];
    for (const itemText of targetItems) {
      if (arg.planAction?.kind === "reword" && arg.planAction.newText) {
        // review1 Step 4: the checklist line of the latest rendering the owner meant: its occurrence when given. A
        // text that names several items and no occurrence is ambiguous, so no line is guessed at (the decision is
        // still noted under `## Owner Decisions`, which changes no item).
        const occurrence = arg.planAction.itemOccurrence;
        if (occurrence === undefined && countTopLevelPlanItemsNamedV1(next, itemText) > 1) {
          continue;
        }
        const reworded = rewordChecklistItemV1(next, itemText, arg.planAction.newText, decisionNote, occurrence ?? 1);
        if (reworded.previousItemText !== undefined) {
          next = reworded.content;
          rewordedItems.push({ previous: reworded.previousItemText, current: `${arg.planAction.newText} — ${decisionNote}` });
        }
        continue;
      }
      // review2 Step 3: the issued id of the copy about to be excluded (the first open top-level item with this
      // text), read before the write, so the owner row is keyed to the item itself.
      const targetKey = normalizeChecklistItemTextV1(cleanPlanItemTextV1(itemText));
      const targetId = listPlanItemIdsV1(next).find(
        (candidate) =>
          !candidate.nested &&
          !candidate.checked &&
          !candidate.excluded &&
          normalizeChecklistItemTextV1(cleanPlanItemTextV1(candidate.itemText)) === targetKey
      )?.itemId;
      const settled = settleChecklistItemV1(next, itemText, "exclude", decisionNote);
      if (settled.settledItemText !== undefined) {
        next = settled.content;
        settledItems.push(settled.settledItemText);
        settledItemIds.push(targetId);
      }
    }
    if (settledItems.length === 0 && rewordedItems.length === 0) {
      next = addOwnerDecisionSectionLineV1(next, ownerDecisionSectionLineV1(arg, decisionNote));
    }
    if (next === plan || (await writeTextFileIfUnchangedV1(planUri, plan, next))) {
      return { planText: next, settledItems, settledItemIds, rewordedItems };
    }
  }
  throw new Error("plan-final.md kept changing while the owner decision was being recorded; choose the option again.");
}

/**
 * review1 Step 40: at a plan-review stage the plan of record is plan.md, which has no checklist for the decision
 * to settle. The decision is written there as an Accepted Non-Goals entry citing the task.md record, so a review
 * that reads both sees one owner decision, not an unsupported claim.
 */
async function recordPlanStageNonGoalV1(arg: RecordOwnerPlanDecisionArgV1, date: string): Promise<void> {
  const planUri = vscode.Uri.joinPath(vscode.Uri.file(arg.taskFolderPath), STAGE_ARTIFACT_FILENAMES.plan ?? "plan.md");
  await recordNonGoalInPlanFileV1(planUri, arg, date);
}

/**
 * review1 Step 40: at a code stage the plan of record is plan-final.md. The answer is cited there as an Accepted
 * Non-Goals entry too (appending under that heading changes no checklist item, so no verification is lost).
 * Deviation approvals are not blockers' non-goals, so they get none.
 */
async function recordCodeStageNonGoalV1(arg: RecordOwnerPlanDecisionArgV1, date: string): Promise<void> {
  await recordNonGoalInPlanFileV1(getCanonicalImplementationUri(vscode.Uri.file(arg.taskFolderPath)), arg, date);
}

async function recordNonGoalInPlanFileV1(planUri: vscode.Uri, arg: RecordOwnerPlanDecisionArgV1, date: string): Promise<void> {
  const citation = `task.md → Owner decisions, ${arg.blockerId}`;
  for (let attempt = 0; attempt < PLAN_WRITE_ATTEMPTS; attempt++) {
    const plan = await readTextIfExists(planUri);
    if (plan === undefined || plan.includes(`(${citation})`)) return;
    const itemText = (arg.blockerText ?? arg.blockerId).replace(/\s+/g, " ").trim().slice(0, 300);
    const next = appendAcceptedNonGoalV1(
      plan,
      [{ itemText, reason: `owner decision ${date}: ${arg.optionLabel} (${citation})` }],
      date,
      `Owner decision (${date})`
    );
    if (next === plan || (await writeTextFileIfUnchangedV1(planUri, plan, next))) return;
  }
}

/** Execute the plan-final.md and task-progress updates for an owner decision under the task lock. */
export async function executeOwnerPlanDecisionLockedV1(arg: RecordOwnerPlanDecisionArgV1): Promise<void> {
  const folderUri = vscode.Uri.file(arg.taskFolderPath);
  const today = new Date().toISOString().slice(0, 10);
  // review2 Step 38: an approval names exactly what it covers, and what stays open.
  const approval = deviationApprovalScopeV1(arg);
  const approvalText = approval !== undefined ? deviationApprovalTextV1(approval) : undefined;
  const decisionNote = arg.note ?? `Owner decision ${today}: ${approvalText ?? arg.optionLabel}`;
  const nowIso = new Date().toISOString();

  // review1 Step 40: the answer goes where reviews look for the owner's own words (task.md) before the plan cites it.
  const recordedInTask = await appendOwnerDecisionV1(
    arg.taskFolderPath,
    {
      blockerId: arg.blockerId,
      blockerText: arg.blockerText ?? arg.blockerId,
      answer:
        approvalText ??
        (arg.rejects && !arg.ownWords ? `${arg.optionLabel} (plan kept as written)` : arg.optionLabel),
    },
    today
  ).catch(() => false);
  if (isPlanReviewStage(arg.stage) && !arg.rejects) {
    await recordPlanStageNonGoalV1(arg, today).catch(() => undefined);
  }

  const change = await applyOwnerPlanDecisionToPlanV1(getCanonicalImplementationUri(folderUri), arg, decisionNote);

  if (!isPlanReviewStage(arg.stage) && !arg.rejects && arg.planAction?.kind !== "approveDeviation") {
    await recordCodeStageNonGoalV1(arg, today).catch(() => undefined);
  }

  if (!arg.rejects) {
    // What the reviewer reads in `{{ownerDecisions}}`: the owner's answer, not only the blocker's id.
    const description = `${arg.blockerId}: ${
      approvalText !== undefined
        ? `the owner ${approvalText.charAt(0).toLowerCase()}${approvalText.slice(1)}`
        : `the owner chose "${arg.optionLabel}"`
    }`.slice(0, MAX_SUPERSESSION_DESCRIPTION_LENGTH);
    const revision = change.planText !== undefined ? getPlanRevisionV1(change.planText) : undefined;
    await patchTaskProgressStrictV1(
      folderUri,
      (progress: TaskProgress) => {
        let next = progress;
        if (revision !== undefined) {
          for (const [index, item] of change.settledItems.entries()) {
            const settledId = change.settledItemIds[index];
            next = recordPlanItemOwnerDecisionV1(next, {
              planRevision: revision,
              planText: change.planText,
              itemText: item,
              ...(settledId !== undefined ? { itemId: settledId } : {}),
              at: nowIso,
              formId: `owner-decision:${arg.blockerId}`,
              decision: "exclude",
            });
          }
          // review1 Step 4: a reword is its own decision kind; it settles nothing, so the new wording is
          // checked afresh while every other item keeps its verification.
          for (const item of change.rewordedItems) {
            next = recordPlanItemOwnerDecisionV1(next, {
              planRevision: revision,
              planText: change.planText,
              itemText: item.current,
              at: nowIso,
              formId: `owner-decision:${arg.blockerId}`,
              decision: "reword",
            });
          }
        }
        const stages = stagesForOwnerDecisionV1(arg.stage);
        const kept = (next.blockerSupersessions ?? []).filter(
          (s: BlockerSupersessionRecordV1) =>
            !(stages.includes(s.stage) && s.blockerDescription.startsWith(`${arg.blockerId}:`))
        );
        const added = stages.map(
          (stage): BlockerSupersessionRecordV1 => ({
            stage,
            blockerDescription: description,
            supersededAt: nowIso,
            planRelPath: "plan-final.md",
            source: "chat-confirmed",
          })
        );
        return { ...next, blockerSupersessions: [...kept, ...added] };
      },
      { skipLock: true }
    );
  }

  // review1 Step 8: if the plan write changed an item (a reword), say which item goes back to the review.
  await refreshPlanItemSettlementSnapshotV1(folderUri, arg.stage);

  const taskRecordNote = recordedInTask ? " It is also recorded in task.md under Owner decisions." : "";
  const outcome = `${approval !== undefined
    ? deviationApprovalReplyV1(approval, arg.blockerId, recordedInTask)
    : arg.ownWords
    ? `Recorded your answer for ${arg.blockerId}${recordedInTask ? " in task.md under Owner decisions" : ""}. The plan is unchanged; the review reads your words and decides whether they settle the blocker.`
    : arg.rejects
    ? `Recorded: "${arg.optionLabel}" for ${arg.blockerId}. The plan stays as written, and the next round builds it that way.`
    : change.settledItems.length > 0 || change.rewordedItems.length > 0
      ? `Recorded: "${arg.optionLabel}" for ${arg.blockerId}. ${[
          change.settledItems.length > 0 ? `Excluded ${change.settledItems.length} plan item(s)` : "",
          change.rewordedItems.length > 0
            ? `Reworded ${change.rewordedItems.length} plan item(s) (the review has to re-check ${change.rewordedItems.length === 1 ? "it" : "them"})`
            : "",
        ].filter(Boolean).join("; ")} in plan-final.md with your decision noted; ${
          arg.thenApplyReview === true ? "Apply Review builds it now; the review checks it after." : "the next review will not carry this blocker."
        }`
      : `Recorded: "${arg.optionLabel}" for ${arg.blockerId}. Your decision is noted in plan-final.md; ${
          arg.thenApplyReview === true ? "Apply Review builds it now; the review checks it after." : "the next review will not carry this blocker."
        }`}${taskRecordNote}`;
  await appendChatMessageV1(arg.taskFolderPath, {
    role: "assistant",
    text: outcome,
    stage: arg.stage,
    at: nowIso,
    kind: "outcome",
  }).catch(() => undefined);
  void logChatStatusToNotificationsV1(arg.taskFolderPath, outcome, arg.stage);
}

/** Command handler for recording an owner plan decision. */
export async function recordOwnerPlanDecisionV1(
  originalArg: RecordOwnerPlanDecisionArgV1
): Promise<WorkflowDecisionCommandResultV1> {
  let arg = originalArg;
  if (arg.ownWords === true) {
    // review2 Step 43: the owner types the answer in Chat With AI's message box (no pop-up); the chat send hands the
    // text over just before this command runs. No text means nothing is recorded and the card comes back.
    const text = takeHandedOverOwnWordsTextV1(arg.taskFolderPath, arg.blockerId);
    if (!text) {
      return {
        outcome: "refused",
        message: `No answer was typed, so nothing was recorded. The question is open again. ${OWN_WORDS_TYPE_HINT_V1}`,
        reopenCard: true,
      };
    }
    // Recorded as the owner's words; the blocker's standing and the plan are left to the review.
    arg = { ...arg, optionLabel: text, rejects: true };
  }
  // review1 Step 4: a reword whose text names several identical items, with no occurrence, is refused before anything
  // is recorded, so the answer cannot land on the wrong item (and cost that item's verification).
  const ambiguous = await findAmbiguousRewordTargetV1(arg);
  if (ambiguous !== undefined) {
    return {
      outcome: "refused",
      message:
        `${ambiguous.count} plan items read “${ambiguous.itemText.slice(0, 100)}”, so this answer can't tell which one to reword. ` +
        "Nothing was recorded. The question is open again.",
      reopenCard: true,
    };
  }
  // A round is live: the answer is written, and the review started, when that round ends (see the deferred run below).
  const deferred = hasLiveWorkAdmissionBestEffortV1(arg.taskFolderPath);
  const result = await recordOwnerPlanDecisionRecordOnlyV1(arg);
  if (result.outcome === "done" && !deferred) {
    await followUpAfterOwnerAnswerV1(arg);
  }
  return result;
}

/** What the group-aware follow-up needs from the outside; the defaults are the real ones. */
export interface OwnerFollowUpDepsV1 {
  /** Other pending owner-plan cards (the round's group) at the answered card's stage. */
  readonly openSiblings: (arg: RecordOwnerPlanDecisionArgV1) => number;
  readonly start: (arg: RecordOwnerPlanDecisionArgV1) => Promise<boolean>;
  readonly say: (arg: RecordOwnerPlanDecisionArgV1, text: string) => Promise<void>;
  /** Post the "Run now" card for a held run. */
  readonly offerRunNow: (arg: RecordOwnerPlanDecisionArgV1) => Promise<void>;
  /** True when a review of the stage started after `sinceIso`, so a run owed from then has been overtaken. */
  readonly reviewStartedSince: (arg: RecordOwnerPlanDecisionArgV1, sinceIso: string) => Promise<boolean>;
}

function openOwnerPlanSiblingsV1(arg: RecordOwnerPlanDecisionArgV1): number {
  const own = `${OWNER_PLAN_DECISION_KEY_PREFIX_V1}${arg.blockerId}`;
  return listPendingWorkflowDecisionsForTaskV1(normalizePath(arg.taskFolderPath)).filter(
    (card) =>
      card.stage === arg.stage && card.decisionKey.startsWith(OWNER_PLAN_DECISION_KEY_PREFIX_V1) && card.decisionKey !== own
  ).length;
}

const DEFAULT_FOLLOW_UP_DEPS_V1: OwnerFollowUpDepsV1 = {
  openSiblings: openOwnerPlanSiblingsV1,
  start: (arg) => startReReviewAfterOwnerDecisionV1(arg),
  say: async (arg, text) => {
    await appendChatMessageV1(arg.taskFolderPath, {
      role: "assistant",
      text,
      stage: arg.stage,
      at: new Date().toISOString(),
      kind: "outcome",
    }).catch(() => undefined);
  },
  offerRunNow: async (arg) => {
    await offerActionInChatV1({
      taskFolderPath: arg.taskFolderPath,
      actionLabel: "Run now",
      command:
        arg.thenApplyReview === true ? "vs-code-ai-helper.resumeAndApplyCurrentStageAction" : "vs-code-ai-helper.resumeAndRerunReview",
      args:
        arg.thenApplyReview === true
          ? [{ taskFolderPath: arg.taskFolderPath }]
          : [{ taskFolderPath: arg.taskFolderPath }, { skipUnchangedTreeGuardV1: true }],
      noticeText: "Decisions from this round are still open, so the review your answer starts is waiting for them.",
      actionConsequence: "Starts the review now. Decisions still open are not read by it.",
      optional: true,
      doNothingOption: { label: "Keep waiting", consequence: "Does nothing. The review starts once the other decisions are answered." },
      recommend: { target: "none", reasoning: "Waiting lets the review read every answer; running now is your call." },
    }).catch(() => undefined);
  },
  reviewStartedSince: async (arg, sinceIso) => {
    const read = await readTaskProgressStrictV1(vscode.Uri.file(arg.taskFolderPath)).catch(() => undefined);
    const history = read?.ok ? (read.decoded.progress.reviewScoreHistory ?? []) : [];
    const latest = history.filter((entry) => entry.stage === arg.stage).at(-1);
    return latest !== undefined && latest.at > sinceIso;
  },
};

/**
 * review2 Step 41: after an answer is recorded (and written), start the run it promises unless the round's other
 * decisions are still open. The run is then held, the chat says how many are open and offers "Run now"; the last
 * answer of the group starts it, so the run reads every answer and no earlier run reads half of them.
 */
export async function followUpAfterOwnerAnswerV1(
  arg: RecordOwnerPlanDecisionArgV1,
  deps: OwnerFollowUpDepsV1 = DEFAULT_FOLLOW_UP_DEPS_V1
): Promise<boolean> {
  const canonicalId = normalizePath(arg.taskFolderPath);
  const startsRun = !((arg.rejects === true && arg.ownWords !== true) || arg.planAction?.kind === "approveDeviation");
  const owed = peekOwedRunV1(canonicalId) as { readonly arg: RecordOwnerPlanDecisionArgV1; readonly at: string } | undefined;
  const decision = decideFollowUpRunV1({
    startsRun,
    openSiblings: deps.openSiblings(arg),
    heldWritesRemaining: heldWritesRemainingV1(canonicalId, arg.blockerId),
    owedFromEarlier: owed !== undefined,
  });
  // bugs7 review: the strongest outstanding requirement of the answer group wins. An earlier answer that owes an
  // Apply Review is not dropped because the last answer only needs a re-review.
  const owedNeedsApply = owed?.arg.thenApplyReview === true;
  switch (decision.action) {
    case "start":
      takeOwedRunV1(canonicalId);
      return deps.start(owedNeedsApply && arg.thenApplyReview !== true ? { ...arg, thenApplyReview: true } : arg);
    case "start-owed": {
      const run = takeOwedRunV1(canonicalId) as { readonly arg: RecordOwnerPlanDecisionArgV1; readonly at: string };
      // "Run now" (or any review) already ran since the answer was held: nothing is owed any more.
      if (await deps.reviewStartedSince(run.arg, run.at)) return false;
      return deps.start(run.arg);
    }
    case "hold":
      rememberOwedRunV1(canonicalId, {
        arg: owedNeedsApply && arg.thenApplyReview !== true ? { ...arg, thenApplyReview: true } : arg,
        at: new Date().toISOString(),
      });
      await deps.say(arg, describeHeldFollowUpRunV1(decision.open));
      await deps.offerRunNow(arg);
      return false;
    case "none":
      return false;
  }
}

/** The reword target `arg` names when it matches several top-level items and gives no occurrence; otherwise undefined. */
export async function findAmbiguousRewordTargetV1(
  arg: RecordOwnerPlanDecisionArgV1
): Promise<{ readonly itemText: string; readonly count: number } | undefined> {
  const action = arg.planAction;
  if (arg.rejects || action?.kind !== "reword" || !action.newText || action.itemOccurrence !== undefined) {
    return undefined;
  }
  const targets = action.items && action.items.length > 0 ? action.items : action.itemText ? [action.itemText] : [];
  if (targets.length === 0) {
    return undefined;
  }
  const plan = await readTextIfExists(getCanonicalImplementationUri(vscode.Uri.file(arg.taskFolderPath)));
  if (plan === undefined) {
    return undefined;
  }
  for (const itemText of targets) {
    const count = countTopLevelPlanItemsNamedV1(plan, itemText);
    if (count > 1) {
      return { itemText, count };
    }
  }
  return undefined;
}

/**
 * review1 Step 40: after an answer that settles or explains a blocker, the stage's review runs again through the
 * single resume-and-review path (Step 41), so the owner does not have to find and press "Keep iterating". An answer
 * that keeps the plan as written (a rejection) and a plan-deviation approval start nothing: the next round builds, or
 * the work continues, as it was. Best effort: a refused start is reported by that command itself.
 */
export async function startReReviewAfterOwnerDecisionV1(
  arg: RecordOwnerPlanDecisionArgV1,
  executeCommand: (command: string, ...args: unknown[]) => PromiseLike<unknown> = (command, ...args) =>
    vscode.commands.executeCommand(command, ...args)
): Promise<boolean> {
  if ((arg.rejects === true && arg.ownWords !== true) || arg.planAction?.kind === "approveDeviation") {
    return false;
  }
  try {
    if (arg.thenApplyReview === true) {
      // One Apply Review, no re-review: the next review (which follows that round in the usual way) judges the fix
      // against the recorded rule.
      const started = await executeCommand("vs-code-ai-helper.resumeAndApplyCurrentStageAction", {
        taskFolderPath: arg.taskFolderPath,
      });
      return started === true;
    }
    const started = await executeCommand(
      "vs-code-ai-helper.resumeAndRerunReview",
      { taskFolderPath: arg.taskFolderPath },
      {
        // Only task.md and the plan changed, not the code, so the unchanged-tree guard would refuse the review.
        skipUnchangedTreeGuardV1: true,
        onDispatchingV1: () => {
          const text = `Saved; checking it now with ${STAGE_DISPLAY_NAMES[arg.stage]}.`;
          void appendChatMessageV1(arg.taskFolderPath, {
            role: "assistant",
            text,
            stage: arg.stage,
            at: new Date().toISOString(),
            kind: "outcome",
          }).catch(() => undefined);
        },
      }
    );
    return started === true;
  } catch {
    return false;
  }
}

async function recordOwnerPlanDecisionRecordOnlyV1(
  arg: RecordOwnerPlanDecisionArgV1
): Promise<WorkflowDecisionCommandResultV1> {
  if (hasLiveWorkAdmissionBestEffortV1(arg.taskFolderPath)) {
    // A round is open: a write to plan-final.md now would be a foreign write to it. Carry the answer out
    // as soon as the task is free.
    armDeferredOptionRunV1({
      key: `owner-plan-decision:${normalizePath(arg.taskFolderPath)}:${arg.blockerId}`,
      isTaskBusy: () => hasLiveWorkAdmissionBestEffortV1(arg.taskFolderPath),
      subscribeToTaskFree: (listener) => taskOperations.onDidEnd(() => listener()),
      carryOut: async () => {
        await withTaskLock(arg.taskFolderPath, () => executeOwnerPlanDecisionLockedV1(arg));
        releaseHeldWriteV1(normalizePath(arg.taskFolderPath), arg.blockerId);
        await followUpAfterOwnerAnswerV1(arg);
        return { kind: "done" };
      },
      report: () => Promise.resolve(),
    });

    noteHeldWriteV1(normalizePath(arg.taskFolderPath), arg.blockerId);
    const heldText = `Your choice "${arg.optionLabel}" for ${arg.blockerId} is recorded. It is written to plan-final.md as soon as the running round ends.`;
    await appendChatMessageV1(arg.taskFolderPath, {
      role: "assistant",
      text: heldText,
      stage: arg.stage,
      at: new Date().toISOString(),
      kind: "outcome",
    }).catch(() => undefined);
    void logChatStatusToNotificationsV1(arg.taskFolderPath, heldText, arg.stage);

    return { outcome: "done" };
  }

  await withTaskLock(arg.taskFolderPath, () => executeOwnerPlanDecisionLockedV1(arg));
  return { outcome: "done" };
}

export function registerOwnerPlanDecisionCommandV1(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      RECORD_OWNER_PLAN_DECISION_COMMAND_V1,
      async (arg: RecordOwnerPlanDecisionArgV1) => recordOwnerPlanDecisionV1(arg)
    )
  );
}

/**
 * A round (Apply Review) applies an answer that says so (`Needs a code change: yes`), or, when the review gave no such
 * line, whose option, problem or details say one round applies it ("one round rewords …", "the next round should …").
 * An answer that edits the plan, keeps it as written or approves a deviation needs no code round.
 */
const ROUND_APPLIES_ANSWER_RE =
  /\b(?:one|a|the next|an apply review)\s+(?:apply review\s+)?rounds?\s+(?:rewords?|builds?|applies|changes?|edits?|fixes?|implements?)\b|\bthe next round should\b|\bBuild next\b/i;

export function ownerOptionNeedsCodeChangeV1(
  option: ParsedOwnerDecisionBlockV1["options"][number],
  block: Pick<ParsedOwnerDecisionBlockV1, "problem" | "technicalDetails"> &
    Partial<Pick<ParsedOwnerDecisionBlockV1, "recommendation" | "options">>,
  /** The review's own "Build next" / "the next round should" text; it speaks for the recommended option. */
  reviewNextText?: string
): boolean {
  if (option.needsCodeChange !== undefined) return option.needsCodeChange;
  if (option.rejects || option.planAction !== undefined) return false;
  const own = [option.label, option.consequence, block.problem, block.technicalDetails ?? ""];
  const isRecommended = block.recommendation !== undefined && block.recommendation.optionId === option.id;
  if (block.recommendation !== undefined && isRecommended) own.push(block.recommendation.reason);
  const reviewSpeaksForOption =
    reviewNextText !== undefined &&
    (isRecommended ||
      (block.recommendation === undefined && (block.options ?? []).filter((o) => !o.rejects && o.planAction === undefined).length <= 1));
  if (reviewSpeaksForOption) own.push(reviewNextText);
  return ROUND_APPLIES_ANSWER_RE.test(own.join(" "));
}

/** The review's own statement of the next round's work, when it makes one (its "Build next" lines, or "the next round should …"). */
export function reviewNextRoundTextV1(reviewText: string | undefined): string | undefined {
  if (!reviewText) return undefined;
  const sentence = /\bthe next round should\b[^\n]*/i.exec(reviewText)?.[0];
  const lines = extractBuildNextLinesV1(reviewText);
  const parts = [sentence, lines.length > 0 ? `Build next ${lines.join(" ")}` : undefined].filter((p): p is string => p !== undefined);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/** What the chat says an answer starts, in words that are true: a round that applies it, or only a review. */
export function describeOwnerAnswerNextV1(
  option: ParsedOwnerDecisionBlockV1["options"][number],
  block: Pick<ParsedOwnerDecisionBlockV1, "problem" | "technicalDetails"> &
    Partial<Pick<ParsedOwnerDecisionBlockV1, "recommendation" | "options">>,
  stageName: string,
  reviewNextText?: string
): string {
  if (option.planAction?.kind === "approveDeviation") return "the deviation is recorded and the work carries on";
  if (option.rejects) return "the plan stays as written, and the next round builds it that way";
  return ownerOptionNeedsCodeChangeV1(option, block, reviewNextText)
    ? `applying now: Apply Review builds it, then ${stageName} checks it`
    : `checking it now with ${stageName}`;
}

/**
 * bugs5 Step 23: Post a workflow decision card for a single parsed owner-decision block. The card is
 * keyed on the blocker id and carries a hash of the block's content, so the same block is not raised
 * again unless its content changes.
 */
export async function postOwnerPlanDecisionCardV1(options: {
  taskFolderPath: string;
  stage: TaskStage;
  block: ParsedOwnerDecisionBlockV1;
  taskDisplayName?: string;
  /** review1 Step 37: identities of the blockers this card asks about (see `attributeBlockersToDecisionBlocksV1`). */
  blockerIdentities?: readonly string[];
  /** review2 Step 41: what the round reported about the same step or plan item; its card is folded into this one. */
  foldedRoundReports?: readonly string[];
  /** The review's text: its "Build next" / "the next round should" line says whether a round applies an answer. */
  reviewText?: string;
}): Promise<WorkflowDecisionV1 | undefined> {
  const { taskFolderPath, stage, block } = options;
  const canonicalId = normalizePath(taskFolderPath);
  const reviewNextText = reviewNextRoundTextV1(options.reviewText);

  // review1 Step 42: a block can carry no recommendation on purpose (a deviation the review has not checked).
  const recommended =
    block.recommendation ??
    (block.noRecommendationReason !== undefined
      ? undefined
      : { optionId: block.options[0]?.id ?? "approve", reason: "Recommended option." });

  const cardInput: PostWorkflowDecisionInputV1 = {
    decisionKey: `ownerPlanDecision:${block.id}`,
    taskCanonicalId: canonicalId,
    stage,
    ...(options.blockerIdentities !== undefined && options.blockerIdentities.length > 0
      ? { blockerIdentities: options.blockerIdentities }
      : {}),
    whatHappened: block.problem,
    whyUserNeeded: block.planPurpose,
    suppressWhileAnswered: {
      conditionFingerprint: block.rawContentHash,
      answeredOptionIds: [...block.options.map((o) => o.id), OWN_WORDS_OPTION_ID_V1],
    },
    // Technical detail is labelled "Details", which the chat card renders behind a collapsed toggle.
    evidence: [
      ...(block.technicalDetails ? [{ label: "Details", detail: block.technicalDetails }] : []),
      ...(options.foldedRoundReports ?? []).map((report) => ({ label: "Details", detail: `What the round reported: ${report}` })),
    ],
    options: [
      ...block.options.map((opt) => ({
        optionId: opt.id,
        label: opt.label,
        // review1 Step 8: a reword changes the item's wording, so the review has to check the new text; say which
        // item that sends back before the owner chooses.
        consequence:
          opt.planAction?.kind === "reword" && opt.planAction.itemText
            ? `${opt.consequence} This rewords “${opt.planAction.itemText.slice(0, 100)}”${
                opt.planAction.itemOccurrence !== undefined ? ` (occurrence ${opt.planAction.itemOccurrence})` : ""
              }, so the review has to re-check that 1 item; every other item keeps its verification.`
            : opt.consequence,
        // review1 Step 40: an answer that settles the blocker re-runs the stage's review (the command starts it);
        // keeping the plan as written, or approving a deviation, starts nothing.
        resumeKind: opt.rejects || opt.planAction?.kind === "approveDeviation" ? ("unpause" as const) : ("continue" as const),
        // bugs7 item 3: "applying now" is only said when something applies the answer. An answer that needs a code
        // change runs Apply Review (then the review); any other answer only starts the review ("checking it now").
        recordedNext: describeOwnerAnswerNextV1(opt, block, STAGE_DISPLAY_NAMES[stage] ?? stage, reviewNextText),
        effect: {
          kind: "command" as const,
          command: RECORD_OWNER_PLAN_DECISION_COMMAND_V1,
          args: [
            {
              taskFolderPath,
              stage,
              blockerId: block.id,
              optionId: opt.id,
              optionLabel: opt.label,
              planAction: opt.planAction,
              ...(opt.rejects ? { rejects: true } : {}),
              ...(ownerOptionNeedsCodeChangeV1(opt, block, reviewNextText) ? { thenApplyReview: true as const } : {}),
              rawContentHash: block.rawContentHash,
              blockerText: block.problem,
            } satisfies RecordOwnerPlanDecisionArgV1,
          ],
        },
      })),
      {
        optionId: OWN_WORDS_OPTION_ID_V1,
        label: "Answer in my own words…",
        consequence:
          "Type your answer in the message box below. It is recorded in task.md under Owner decisions, and the review runs " +
          "again to read it. The plan is not changed and the blocker is not set aside; the review decides whether your words settle it.",
        resumeKind: "continue" as const,
        // Only a review starts, never a round that applies anything: the chat must not say "applying now".
        recordedNext: `your words are saved, then ${STAGE_DISPLAY_NAMES[stage] ?? stage} checks them`,
        effect: {
          kind: "command" as const,
          command: RECORD_OWNER_PLAN_DECISION_COMMAND_V1,
          args: [
            {
              taskFolderPath,
              stage,
              blockerId: block.id,
              optionId: OWN_WORDS_OPTION_ID_V1,
              optionLabel: "Answer in my own words",
              ownWords: true,
              rawContentHash: block.rawContentHash,
              blockerText: block.problem,
            } satisfies RecordOwnerPlanDecisionArgV1,
          ],
        },
      },
    ],
    recommendation: recommended
      ? { kind: "option", optionId: recommended.optionId, reasoning: recommended.reason }
      : { kind: "none", reasoning: block.noRecommendationReason ?? "The choice is yours." },
    gating: {
      holdsTaskPaused: true,
      unblocksProgress: true,
      detail: `Waiting for your decision: ${block.id}`,
    },
  };

  return postWorkflowDecisionV1(cardInput, { canonicalId, taskFolderPath, stage });
}

/**
 * bugs5 Step 22: Fast Forward has stopped because every blocker holding the score needs the owner, but the
 * review wrote no `## Owner decisions needed` block to build a card from. Raise one card naming those blockers
 * in plain words, so the stop is a question the owner can act on, not only a chat line. Posted once per set of
 * blockers (the decision key carries a hash of their text).
 */
export async function postOwnerOnlyBlockersCardV1(options: {
  taskFolderPath: string;
  stage: TaskStage;
  blockerDescriptions: readonly string[];
  /** Lineage ids (or undefined) for each description, in the same order; identities fall back to the text hash. */
  blockerLineageIds?: readonly (string | undefined)[];
  /**
   * review1 Step 39: true when other blockers still have work a round can do, so Fast Forward carries on with those
   * and this card only takes the standing ones off its hands (the wording must not say Fast Forward stopped).
   */
  continuesWithOtherWork?: boolean;
  /**
   * review2 Step 42: how many fix rounds the task has run so far. A card Fast Forward carries past remembers "Not now"
   * for this blocker set until a new round has run (the count changes), so the same card is not raised again at once.
   */
  fixRoundsRun?: number;
  /**
   * bugs7 item 4: the work the review itself named for a round ("Build Step 12's rewording") when a listed blocker is
   * task-fixable. The card then offers Apply Review for it, recommended, and never recommends ticking or excluding an
   * item that one round can build. Absent for a blocker only the owner can settle.
   */
  buildNext?: readonly string[];
}): Promise<WorkflowDecisionV1 | undefined> {
  const { taskFolderPath, stage, blockerDescriptions } = options;
  if (blockerDescriptions.length === 0) {
    return undefined;
  }
  const buildNext = (options.buildNext ?? []).filter((line) => line.trim() !== "");
  const roundCanBuild = buildNext.length > 0;
  const canonicalId = normalizePath(taskFolderPath);
  // review1 Step 37: one card per owner-only blocker. An owner-decision card or the plateau card for this stage
  // already asks the owner; say so in the chat stop line instead of posting a second, different question.
  const blockerIdentities = blockerDescriptions.map((description, index) =>
    ownerBlockerIdentityV1(description, options.blockerLineageIds?.[index])
  );
  const covering = findCardCoveringOwnerOnlyBlockersV1(canonicalId, stage, blockerIdentities);
  if (covering) {
    return covering;
  }
  const fingerprint = createHash("sha256").update(blockerDescriptions.join("\n")).digest("hex").slice(0, 16);
  // review1 Step 38: "Tick or Exclude…" acts on plan-final.md's checklist, which does not exist at a plan stage.
  // There the way on is to record the decision in plan.md, so that is what the card offers and recommends.
  // review2 Step 42: a tick or exclude is offered only when a listed blocker is about a plan item. Otherwise (a
  // failing check, a defect) the owner's own words are the way on, so the review reads them.
  const aboutPlanItem = blockerDescriptions.some((description) => isPlanItemBlockerV1({ description }));
  const canSettleItem = optionAppliesAtStageV1("settleChecklistItem", stage);
  const offersTick = canSettleItem && aboutPlanItem;
  const offersOwnWords = canSettleItem && !aboutPlanItem;
  const planFile = planFileNameForStageV1(stage);
  const forwardOptionId = roundCanBuild
    ? "applyReviewToBuild"
    : offersTick
      ? "settleItem"
      : offersOwnWords
        ? OWN_WORDS_OPTION_ID_V1
        : "changePlan";
  const applyReviewOption: WorkflowDecisionOptionV1 = {
    optionId: "applyReviewToBuild",
    label: `Apply Review: ${buildNext[0] ?? "build what the review names"}`.slice(0, 120),
    consequence:
      `Runs one Apply Review round for what the review asked for (${buildNext.join(" ").slice(0, 300)}), then re-reviews. ` +
      "Nothing is ticked or excluded for you.",
    resumeKind: "continue",
    effect: { kind: "command", command: "vs-code-ai-helper.resumeAndApplyCurrentStageAction", args: [{ taskFolderPath }] },
    recordedNext: "an Apply Review round runs, then the review",
  };
  const cardInput: PostWorkflowDecisionInputV1 = {
    decisionKey: `ownerOnlyBlockers:${fingerprint}`,
    taskCanonicalId: canonicalId,
    stage,
    blockerIdentities,
    whatHappened: options.continuesWithOtherWork
      ? `${blockerDescriptions.length === 1 ? "One blocker" : `${blockerDescriptions.length} blockers`} ` +
        "can only be settled by you, or have stood unchanged across reviews, so another Apply Review round on " +
        `${blockerDescriptions.length === 1 ? "it" : "them"} alone would not help. Fast Forward carries on with the blockers a round can still work on.`
      : roundCanBuild
        ? `Fast Forward stopped, but the review names work one Apply Review round can do: ${buildNext.join(" ").slice(0, 400)}`
        : `Fast Forward stopped. ${blockerDescriptions.length === 1 ? "The one thing" : `All ${blockerDescriptions.length} things`} ` +
          "holding this review's score can only be settled by you, so another Apply Review round would not help.",
    whyUserNeeded:
      "These are decisions or evidence that only you can give: " +
      blockerDescriptions.map((d) => `“${d}”`).join("; "),
    evidence: [],
    options: [
      ...(roundCanBuild ? [applyReviewOption] : []),
      offersOwnWords
        ? {
            optionId: OWN_WORDS_OPTION_ID_V1,
            label: "Answer in my own words…",
            consequence:
              "Records your answer in task.md under Owner decisions and re-runs the review to read it. " +
              "The plan is not changed and the blocker is not set aside; the review decides whether your words settle it.",
            resumeKind: "continue" as const,
            recordedNext: `your words are saved, then ${STAGE_DISPLAY_NAMES[stage] ?? stage} checks them`,
            effect: {
              kind: "command" as const,
              command: RECORD_OWNER_PLAN_DECISION_COMMAND_V1,
              args: [
                {
                  taskFolderPath,
                  stage,
                  blockerId: blockerIdentities[0] ?? fingerprint,
                  optionId: OWN_WORDS_OPTION_ID_V1,
                  optionLabel: "Answer in my own words",
                  ownWords: true,
                  rawContentHash: fingerprint,
                  blockerText: blockerDescriptions.join("; ").slice(0, 600),
                } satisfies RecordOwnerPlanDecisionArgV1,
              ],
            },
          }
        : offersTick
        ? {
            optionId: "settleItem",
            label: "Tick or Exclude a Checklist Item…",
            consequence:
              "Opens the form to tick an item you have checked yourself, or exclude one you have decided not to build, " +
              "with a dated note the next review can read. Fast Forward does not restart by itself; run the review again afterwards.",
            resumeKind: "unpause" as const,
            effect: {
              kind: "command" as const,
              command: "vs-code-ai-helper.settleChecklistItem",
              args: [{ canonicalId, taskFolderPath }],
            },
          }
        : {
            optionId: "changePlan",
            label: "Change the plan instead",
            consequence:
              `Opens ${planFile} at its Accepted Non-Goals section so you can record your decision there. ` +
              "Fast Forward does not restart by itself; run the review again afterwards.",
            resumeKind: "unpause" as const,
            effect: {
              kind: "command" as const,
              command: "vs-code-ai-helper.openPlanNonGoals",
              args: [{ taskFolderPath, stage }],
            },
          },
      {
        optionId: "notNow",
        label: "Not now",
        consequence: "Does nothing. The task stays as it is until you settle these.",
        resumeKind: "unpause",
        effect: { kind: "doNothing" },
      },
    ],
    recommendation: {
      kind: "option",
      optionId: forwardOptionId,
      reasoning: roundCanBuild
        ? "The review named exactly what one round should build, so Apply Review is the step that moves it. Ticking or excluding would settle it without building it."
        : "Only your answer changes the score; running another Apply Review against these would repeat the same result.",
    },
    // review2 Step 42: a card Fast Forward carries past never holds Fast Forward, so it is a notice with buttons, not
    // a "Decision needed". "Not now" on it is remembered until another round has run (the fingerprint carries the
    // round count), so the same card does not come straight back.
    ...(options.continuesWithOtherWork
      ? {
          gating: {
            holdsTaskPaused: false,
            unblocksProgress: false,
            detail: "Optional: Fast Forward carries on without it.",
          },
          suppressWhileAnswered: {
            conditionFingerprint: `${fingerprint}:rounds=${options.fixRoundsRun ?? 0}`,
            answeredOptionIds: ["notNow"],
          },
        }
      : {
          gating: {
            holdsTaskPaused: false,
            unblocksProgress: true,
            detail: "the next review round",
          },
        }),
  };
  return postWorkflowDecisionV1(cardInput, { canonicalId, taskFolderPath, stage });
}

const OWNER_PLAN_DECISION_KEY_PREFIX_V1 = "ownerPlanDecision:";
const PLAN_DEVIATION_KEY_PREFIX_V1 = `${OWNER_PLAN_DECISION_KEY_PREFIX_V1}plan-deviation-`;

/** The step numbers a piece of card text names ("Step 34", "Steps 19/22" names 19). */
function stepNumbersNamedV1(text: string): ReadonlySet<number> {
  const steps = new Set<number>();
  for (const match of text.matchAll(/\bsteps?\s+(\d+)(?!\d)/gi)) {
    steps.add(Number(match[1]));
  }
  return steps;
}

function pendingOwnerPlanCardsV1(
  canonicalId: string,
  stage: TaskStage,
  kind: "deviation" | "review"
): readonly WorkflowDecisionV1[] {
  return listPendingWorkflowDecisionsForTaskV1(canonicalId).filter(
    (card) =>
      card.stage === stage &&
      card.decisionKey.startsWith(OWNER_PLAN_DECISION_KEY_PREFIX_V1) &&
      card.decisionKey.startsWith(PLAN_DEVIATION_KEY_PREFIX_V1) === (kind === "deviation")
  );
}

/** review2 Step 41: the plan-item ids (`[item:<id>]`) a piece of card text names. */
function itemIdsNamedV1(text: string): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const match of text.matchAll(/\[item:([0-9a-f]+)\]/gi)) {
    ids.add(match[1]!.toLowerCase());
  }
  return ids;
}

/** The step numbers and plan-item ids a card's text names; the review's card and the round's card match on either. */
export interface NamedPlanReferencesV1 {
  readonly steps: ReadonlySet<number>;
  readonly itemIds: ReadonlySet<string>;
}

export function namedPlanReferencesV1(text: string): NamedPlanReferencesV1 {
  return { steps: stepNumbersNamedV1(text), itemIds: itemIdsNamedV1(text) };
}

/** True when `card` names a step or a plan-item id that `references` names too. */
function cardNamesAnyReferenceV1(card: WorkflowDecisionV1, references: NamedPlanReferencesV1): boolean {
  if (references.steps.size === 0 && references.itemIds.size === 0) return false;
  const named = namedPlanReferencesV1(`${card.whatHappened}\n${card.whyUserNeeded}`);
  for (const step of named.steps) if (references.steps.has(step)) return true;
  for (const id of named.itemIds) if (references.itemIds.has(id)) return true;
  return false;
}

/** review1 Step 42: withdraw pending cards of one kind whose key the latest report no longer contains. */
async function withdrawOwnerPlanCardsNoLongerReportedV1(
  taskFolderPath: string,
  stage: TaskStage,
  kind: "deviation" | "review",
  currentKeys: ReadonlySet<string>,
  reason: string
): Promise<void> {
  const canonicalId = normalizePath(taskFolderPath);
  for (const card of pendingOwnerPlanCardsV1(canonicalId, stage, kind)) {
    if (!currentKeys.has(card.decisionKey)) {
      await withdrawWorkflowDecisionsByKeyV1({ taskFolderPath, canonicalId }, card.decisionKey, reason);
    }
  }
}

/**
 * bugs5 Step 23: Parse `## Owner decisions needed` blocks from review content and raise a card for each.
 * review1 Step 42: cards for blocks the review no longer reports are withdrawn, and a round's plan-deviation
 * card that this review raises a decision about is folded into that one card.
 */
/**
 * review1 Step 37: which blockers each owner-decision card asks about. A blocker whose text names the block's id
 * or plan purpose belongs to that block. A blocker that no block names (a reviewer rarely repeats the id) is
 * paired with a block that no blocker names, in order; extra blockers stay unattributed, so a card about one
 * blocker never hides a different owner-only blocker's own card. Task-fixable blockers are never attributed.
 */
export function attributeBlockersToDecisionBlocksV1(
  blockers: readonly ReviewBlocker[],
  blocks: readonly ParsedOwnerDecisionBlockV1[]
): ReadonlyMap<string, readonly string[]> {
  const result = new Map<string, string[]>(blocks.map((block) => [block.id, []]));
  const unmatched: ReviewBlocker[] = [];
  for (const blocker of blockers) {
    if (blocker.resolver === "task-fixable") continue;
    const text = blocker.description.toLowerCase();
    const named = blocks.find(
      (block) => text.includes(block.id.toLowerCase()) || (block.planPurpose !== "" && text.includes(block.planPurpose.toLowerCase()))
    );
    if (named) {
      result.get(named.id)?.push(blockerOwnerIdentityV1(blocker));
    } else {
      unmatched.push(blocker);
    }
  }
  const blocksNamedByNoBlocker = blocks.filter((block) => result.get(block.id)?.length === 0);
  blocksNamedByNoBlocker.forEach((block, index) => {
    const blocker = unmatched[index];
    if (blocker) result.get(block.id)?.push(blockerOwnerIdentityV1(blocker));
  });
  return result;
}

export async function raiseOwnerDecisionCardsFromReviewV1(
  taskFolderPath: string,
  stage: TaskStage,
  reviewContent: string
): Promise<readonly WorkflowDecisionV1[]> {
  const posted: WorkflowDecisionV1[] = [];
  const blocks = parseOwnerDecisionsNeededV1(reviewContent);
  const identitiesByBlock = attributeBlockersToDecisionBlocksV1(
    parseReviewBlockersDetailed(reviewContent).blockers,
    blocks
  );
  await withdrawOwnerPlanCardsNoLongerReportedV1(
    taskFolderPath,
    stage,
    "review",
    new Set(blocks.map((block) => `${OWNER_PLAN_DECISION_KEY_PREFIX_V1}${block.id}`)),
    "the latest review no longer asks for this decision"
  ).catch(() => undefined);
  const canonicalId = normalizePath(taskFolderPath);
  for (const block of blocks) {
    // review2 Step 41: the round's card about the same step or plan item is folded into this one: it is withdrawn
    // once this card is up, and its body (what the round reported) is carried on this card.
    const references = namedPlanReferencesV1(`${block.problem}\n${block.planPurpose}\n${block.rawContent}`);
    const folded = pendingOwnerPlanCardsV1(canonicalId, stage, "deviation").filter((card) =>
      cardNamesAnyReferenceV1(card, references)
    );
    const decision = await postOwnerPlanDecisionCardV1({
      taskFolderPath,
      stage,
      block,
      blockerIdentities: identitiesByBlock.get(block.id) ?? [],
      foldedRoundReports: folded.map((card) => card.whatHappened),
      reviewText: reviewContent,
    });
    if (decision) {
      posted.push(decision);
      // The review's card carries the review's options; the round's own card about the same step is folded in.
      for (const deviationCard of folded) {
        await withdrawWorkflowDecisionsByKeyV1(
          { taskFolderPath, canonicalId },
          deviationCard.decisionKey,
          "the review raised a decision about the same step or plan item, so this one is answered there"
        ).catch(() => undefined);
      }
    }
  }
  return posted;
}

/**
 * bugs6 item 44: after a review, each open deviation card of the stage is re-checked against the review's
 * "Material plan deviations" section and blockers. A deviation the review calls "not a departure" or "meets the
 * plan" gets "Approve (the review found it meets the plan)" with the review's sentence quoted; one the review holds
 * as a blocker gets Reject. The card is refreshed in place (same key, nothing announced), never raised again. With no
 * confident match the card is left as it is. Returns the number of cards updated.
 */
export async function refreshPlanDeviationCardsFromReviewV1(
  taskFolderPath: string,
  stage: TaskStage,
  reviewContent: string,
  planOfRecord?: string
): Promise<number> {
  const canonicalId = normalizePath(taskFolderPath);
  let updated = 0;
  for (const card of pendingOwnerPlanCardsV1(canonicalId, stage, "deviation")) {
    const verdict = assessDeviationAgainstReviewV1(card.whatHappened, reviewContent, planOfRecord);
    if (verdict === undefined) continue;
    const optionId = verdict.kind === "meets" ? "approve-deviation" : "reject-deviation";
    if (!card.options.some((option) => option.optionId === optionId)) continue;
    const reasoning =
      verdict.kind === "meets"
        ? `Approve (the review found it meets the plan): “${verdict.sentence.length > 240 ? `${verdict.sentence.slice(0, 237)}…` : verdict.sentence}”`
        : `The latest review holds this step as a blocker: ${verdict.blocker.length > 240 ? `${verdict.blocker.slice(0, 237)}…` : verdict.blocker} Rejecting keeps the plan as written.`;
    const view = deviationReviewViewTextV1(verdict);
    const whatHappened = DEVIATION_REVIEW_VIEW_RE.test(card.whatHappened)
      ? card.whatHappened.replace(DEVIATION_REVIEW_VIEW_RE, view)
      : `${card.whatHappened}${view}`;
    if (
      whatHappened === card.whatHappened &&
      card.recommendation.kind === "option" &&
      card.recommendation.optionId === optionId &&
      card.recommendation.reasoning === reasoning
    ) {
      continue;
    }
    const effectArgs = card.options.flatMap((option) =>
      option.effect.kind === "command" ? [option.effect.args?.[0]] : []
    )[0] as { rawContentHash?: string } | undefined;
    const rawContentHash = effectArgs?.rawContentHash;
    await postWorkflowDecisionV1(
      {
        decisionKey: card.decisionKey,
        taskCanonicalId: card.taskCanonicalId,
        stage: card.stage,
        whatHappened,
        whyUserNeeded: card.whyUserNeeded,
        options: card.options,
        recommendation: { kind: "option", optionId, reasoning },
        ...(card.evidence ? { evidence: card.evidence } : {}),
        ...(card.gating ? { gating: card.gating } : {}),
        ...(card.blockerIdentities ? { blockerIdentities: card.blockerIdentities } : {}),
        ...(rawContentHash !== undefined
          ? {
              suppressWhileAnswered: {
                conditionFingerprint: rawContentHash,
                answeredOptionIds: [...card.options.map((o) => o.optionId)],
              },
            }
          : {}),
        quietRepost: true,
      },
      { canonicalId, taskFolderPath, stage }
    ).then((posted) => {
      if (posted) updated += 1;
    });
  }
  return updated;
}

/** The sentence a deviation card carries about what the latest review said (any of the three wordings). */
const DEVIATION_REVIEW_VIEW_RE =
  / The latest review (?:has not verified it\.|already verified it\.|found it meets the plan: “[^”]*”|holds this as a blocker:[^\n]*)/;

/**
 * bugs5 Step 23: Parse the `## Plan deviations` section of a round's summary and raise a card for each.
 * review1 Step 42: one card per top-level deviation; cards for deviations the latest round no longer reports are
 * withdrawn; a deviation a pending review decision already covers (same step) raises no second card.
 */
export async function raisePlanDeviationCardsV1(
  taskFolderPath: string,
  stage: TaskStage,
  summaryContent: string,
  context?: PlanDeviationContextV1
): Promise<readonly WorkflowDecisionV1[]> {
  const posted: WorkflowDecisionV1[] = [];
  const deviations = parsePlanDeviationsV1(summaryContent, context);
  await withdrawOwnerPlanCardsNoLongerReportedV1(
    taskFolderPath,
    stage,
    "deviation",
    new Set(deviations.map((deviation) => `${OWNER_PLAN_DECISION_KEY_PREFIX_V1}${deviation.id}`)),
    "the latest round no longer reports this plan deviation"
  ).catch(() => undefined);
  const canonicalId = normalizePath(taskFolderPath);
  const reviewCards = pendingOwnerPlanCardsV1(canonicalId, stage, "review");
  for (const deviation of deviations) {
    const references = namedPlanReferencesV1(`${deviation.planPurpose}\n${deviation.rawContent}`);
    if (reviewCards.some((card) => cardNamesAnyReferenceV1(card, references))) {
      continue;
    }
    const decision = await postOwnerPlanDecisionCardV1({ taskFolderPath, stage, block: deviation });
    if (decision) {
      posted.push(decision);
    }
  }
  return posted;
}
