import { createHash } from "crypto";
import * as vscode from "vscode";

import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import {
  IMPL_REVIEW_STAGES,
  IMPLEMENTATION_SUMMARY_FILENAME,
  STAGE_ARTIFACT_FILENAMES,
  type TaskStage,
} from "../types/taskProgress";
import { readPartialScopeHoldV1 } from "./partialScopeDecisionV1";
import {
  AUTOMATION_STOPPED_DECISION_KEY_V1,
  buildAutomationStoppedCardInputV1,
  extractBuildNextLinesV1,
  type AutomationStopEndingV1,
  type AutomationStopFactsV1,
} from "../utils/automationStopV1";
import { endFastForwardRunChainV1 } from "../utils/activeFastForwardRunsV1";
import { buildBlockerWorkListV1, reviewSeparationFromHistoryV1 } from "../utils/blockerWorkListV1";
import { readPlanItemCountsV1 } from "../utils/effectiveReviewProgress";
import { readTextIfExists } from "../utils/fileUtils";
import { getCanonicalImplementationUri, readPlanOfRecordV1 } from "../utils/implementationArtifactResolver";
import { getPlanRevisionV1, parseDeclinedBlockersV1 } from "../utils/implementationChecklist";
import { selectRepeatedRejectionV1 } from "../utils/reportContractRejectionsV1";
import { getReviewPlateauRounds } from "../config/settings";
import { previousVersionUri } from "../utils/artifactBackups";
import { computeWorkingTreeFingerprintV1, resolveHeadCommitSha } from "../utils/gitRepoInfo";
import {
  hasArtifactChangeStaleBannerV1,
  isReviewDispatchAgainstUnchangedTreeV1,
  parseReviewBlockersDetailed,
  REVIEWED_COMMIT_STAGES,
} from "../utils/reviewReadiness";
import { reviewInputsChangedSinceV1 } from "../utils/reviewInputsChangedV1";
import { detectTestsRefusedV1 } from "../utils/testsRefusedV1";
import { normalizePath } from "../utils/taskRoot";
import { isFailingTestsBlockerV1 } from "../utils/testFailuresV1";
import {
  listPendingWorkflowDecisionsForTaskV1,
  listWorkflowDecisionsForTaskV1,
  postWorkflowDecisionV1,
} from "../utils/workflowDecisionDispatchV1";
import { latestOwnerAnswerAtV1 } from "../utils/ownerAnswerTimeV1";

/**
 * review1 Step 29: gather where a task stands from what is on disk (review artifact, plan counts, sorted blockers,
 * report-contract rejections) and describe it as the facts the stop card is built from.
 */
export async function gatherAutomationStopFactsV1(input: {
  readonly folderUri: vscode.Uri;
  readonly stage: TaskStage;
  readonly ending: AutomationStopEndingV1;
  readonly stopReason: string;
  readonly fastForwardWasRunning?: boolean;
}): Promise<AutomationStopFactsV1 | undefined> {
  const { folderUri, stage } = input;
  const read = await readTaskProgressStrictV1(folderUri).catch(() => undefined);
  if (!read || !read.ok) return undefined;
  const progress = read.decoded.progress;
  const reviewName = STAGE_ARTIFACT_FILENAMES[stage];
  const reviewText = reviewName ? await readTextIfExists(vscode.Uri.joinPath(folderUri, reviewName)).catch(() => undefined) : undefined;
  const planText = await readTextIfExists(getCanonicalImplementationUri(folderUri)).catch(() => undefined);
  const summaryText = await readTextIfExists(vscode.Uri.joinPath(folderUri, IMPLEMENTATION_SUMMARY_FILENAME)).catch(() => undefined);
  const history = (progress.reviewScoreHistory ?? []).filter((entry) => entry.stage === stage);
  const latest = history.at(-1);
  const previous = history.at(-2);

  const blockers = reviewText
    ? parseReviewBlockersDetailed(reviewText, [
        ...(latest?.blockers ?? []),
        ...(previous?.blockers ?? []),
        ...(previous?.supersededBlockers ?? []),
      ]).blockers
    : [];
  const list = buildBlockerWorkListV1({
    blockers,
    ...(planText !== undefined ? { planOfRecord: planText } : {}),
    priorReviewBlockers: history.slice(0, -1).map((entry) => entry.blockers ?? []),
    priorReviewAts: history.slice(0, -1).map((entry) => entry.at),
    ownerAnswerAtOf: (blocker) =>
      latestOwnerAnswerAtV1(
        listWorkflowDecisionsForTaskV1(normalizePath(folderUri.fsPath)),
        blocker.description,
        blocker.lineage !== undefined && blocker.lineage.kind !== "new" ? blocker.lineage.refId : undefined
      ),
    reviewSeparatedByFixRound: reviewSeparationFromHistoryV1(history),
    plateauRounds: getReviewPlateauRounds(),
    declined: summaryText ? parseDeclinedBlockersV1(summaryText) : [],
  });
  const { counts, gateComplete, countUnavailable } = await readGateStateV1(folderUri);
  const dismissedDependencies: string[] = [];
  const refused = summaryText ? detectTestsRefusedV1(summaryText) : undefined;
  if (refused && counts && counts.provisional > 0) {
    dismissedDependencies.push(
      `the provider refused the test command${refused.commands.length === 1 ? "" : "s"} ${refused.commands
        .slice(0, 2)
        .map((command) => `\`${command}\``)
        .join(", ")}, so ${counts.provisional} built plan item${counts.provisional === 1 ? " stays" : "s stay"} unchecked.`
    );
  }
  const repeated = selectRepeatedRejectionV1(progress.reportContractRejections);
  const failingTestsBlockers = blockers.filter((blocker) => isFailingTestsBlockerV1(blocker.description ?? "")).length;
  // review2 Step 23: an open partial-scope hold would stop Fast Forward at its start, so it is never recommended.
  const startHold = IMPL_REVIEW_STAGES.includes(stage)
    ? await readPartialScopeHoldV1(folderUri.fsPath, stage, reviewText).catch(() => undefined)
    : undefined;
  const stateFingerprint = createHash("sha256")
    .update(
      [
        stage,
        input.ending,
        reviewText === undefined ? "no-review" : createHash("sha256").update(reviewText).digest("hex"),
        planText === undefined ? "no-plan" : getPlanRevisionV1(planText),
        counts ? `${counts.total}/${counts.settled}/${counts.open}/${counts.provisional}` : "no-counts",
      ].join("|")
    )
    .digest("hex")
    .slice(0, 16);
  return {
    taskFolderPath: folderUri.fsPath,
    stage,
    ending: input.ending,
    stopReason: input.stopReason,
    stateFingerprint,
    score: latest?.score ?? null,
    previousScore: previous?.score ?? null,
    blockers: {
      fixFirst: list.fixFirst.length,
      buildToClear: list.buildToClear.length,
      notThisRound: list.notThisRound.length,
      unstated: list.notThisRound.filter((item) => item.kind === "unstated").length,
    },
    ...(counts ? { planItems: { total: counts.total, settled: counts.settled, open: counts.open, provisional: counts.provisional } } : {}),
    buildNext: extractBuildNextLinesV1(reviewText),
    dismissedDependencies,
    reviewClean: reviewText !== undefined && blockers.length === 0,
    gateComplete,
    ...(countUnavailable ? { planCountUnavailable: true } : {}),
    fastForwardWasRunning: input.fastForwardWasRunning === true,
    ...(failingTestsBlockers > 0 ? { failingTestsBlockers } : {}),
    ...(repeated ? { repeatedRejection: repeated } : {}),
    ...(startHold !== undefined ? { startHold } : {}),
  };
}

/**
 * review1 Step 32: two separate facts about the stage's latest review. `reviewClean` is the review alone (0
 * blockers): a clean review never gets Apply Review recommended by the lost-round card. `gateComplete` is Step 5's
 * gate (nothing open or provisional): with a clean review as well, Apply Review has nothing to act on.
 */
export async function readReviewCleanFactsV1(
  folderUri: vscode.Uri,
  stage: TaskStage
): Promise<{ readonly reviewClean: boolean; readonly gateComplete: boolean }> {
  const reviewName = STAGE_ARTIFACT_FILENAMES[stage];
  const reviewText = reviewName
    ? await readTextIfExists(vscode.Uri.joinPath(folderUri, reviewName)).catch(() => undefined)
    : undefined;
  const reviewClean = reviewText !== undefined && parseReviewBlockersDetailed(reviewText).blockers.length === 0;
  const { gateComplete } = await readGateStateV1(folderUri);
  return { reviewClean, gateComplete };
}

/**
 * review1 Step 29: the completeness gate with its unknown state kept apart. A plan that is readable and has no
 * countable checklist has nothing to gate (complete). A plan or progress file that cannot be read says nothing
 * about the work, so it is never read as complete: the gate is incomplete and `countUnavailable` is set.
 */
async function readGateStateV1(folderUri: vscode.Uri): Promise<{
  readonly counts: Awaited<ReturnType<typeof readPlanItemCountsV1>>;
  readonly gateComplete: boolean;
  readonly countUnavailable: boolean;
}> {
  const counts = await readPlanItemCountsV1(folderUri, { policy: "lenient", mode: "gate" }).catch(() => undefined);
  if (counts) {
    return { counts, gateComplete: counts.open === 0 && counts.provisional === 0, countUnavailable: false };
  }
  const plan = await readPlanOfRecordV1(folderUri).catch(() => undefined);
  if (plan && plan.text !== undefined && !plan.hasChecklist) {
    return { counts: undefined, gateComplete: true, countUnavailable: false };
  }
  return { counts: undefined, gateComplete: false, countUnavailable: true };
}

/**
 * review1 Step 29: raise the one "automation stopped" card for a task. One decision key per task, so each new card
 * replaces the last. Posts nothing when the stage is actually done (a clean review and a complete gate: the
 * "<Stage> is done" card of Step 31 covers that) or when the owner cancelled.
 */
export async function postAutomationStoppedCardV1(input: {
  readonly folderUri: vscode.Uri;
  readonly stage: TaskStage;
  readonly ending: AutomationStopEndingV1;
  readonly stopReason: string;
  readonly displayName?: string;
  readonly fastForwardWasRunning?: boolean;
  /** True when the owner cancelled the run: a cancel is the owner's own stop, never a card. */
  readonly ownerCancelled?: boolean;
}): Promise<{ readonly posted: boolean }> {
  // review1 Step 54: an automation end (or the owner's cancel) ends the run an "and keep going" answer was given
  // in, whether or not a card follows.
  endFastForwardRunChainV1(input.folderUri.fsPath);
  if (input.ownerCancelled === true) return { posted: false };
  try {
    const facts = await gatherAutomationStopFactsV1(input);
    if (!facts) return { posted: false };
    const stageIsReady = facts.gateComplete && facts.reviewClean;
    // A stop card is for work left; the "<Stage> is done" card (Step 31) is for exactly the opposite.
    if (input.ending === "stage-ready" ? !stageIsReady : stageIsReady) return { posted: false };
    const built = buildAutomationStoppedCardInputV1(facts);
    // bugs7 item 6: one card per state. The card carries the fingerprint of the state it describes (stage, ending,
    // review content, plan revision, settled counts) as its identity; an open card with the same key, stage and
    // identity is already the card for it, whichever caller (and whichever wording) raised it. Raising it again put
    // two "is done" cards in the chat a second apart.
    const card =
      facts.stateFingerprint !== undefined
        ? { ...built, suppressWhileAnswered: { conditionFingerprint: facts.stateFingerprint, answeredOptionIds: [] as string[] } }
        : built;
    // The posting path may add options of its own (a countdown's "Wait for me"), so the open card is matched by the
    // state fingerprint at the front of its identity, never by its option list.
    const identityPrefix = facts.stateFingerprint !== undefined ? `${facts.stateFingerprint}|` : undefined;
    const alreadyOpen =
      identityPrefix !== undefined &&
      listPendingWorkflowDecisionsForTaskV1(normalizePath(input.folderUri.fsPath)).some(
        (open) => open.decisionKey === card.decisionKey && open.stage === card.stage && (open.identity ?? "").startsWith(identityPrefix)
      );
    if (alreadyOpen) return { posted: false };
    const posted = await postWorkflowDecisionV1(card, {
      canonicalId: normalizePath(input.folderUri.fsPath),
      taskFolderPath: input.folderUri.fsPath,
      stage: input.stage,
      taskName: input.displayName,
    });
    return { posted: posted !== undefined };
  } catch {
    // The stop itself was already reported by the caller's own line; the card is the courtesy that follows it.
    return { posted: false };
  }
}

/**
 * review1 Step 31: after the owner's own action (a card answered, a plan item ticked or excluded, a test run
 * recorded) re-check the stage. When the review on record is current and clean and the gate is complete, say so at
 * once with a "<Stage> is done" card that recommends moving on, instead of leaving the owner to work it out
 * (bugs6 item 9, 2026-11-03: the last ticks added nothing to the chat). Posts nothing in any other state.
 */
export interface StageReadyWorkspaceIdentityV1 {
  readonly headSha: string | undefined;
  readonly treeFingerprint: string | undefined;
}

/** The live commit and working-tree fingerprint, with the review artifact (an output, not an input) left out. */
async function readWorkspaceIdentityForReadyCardV1(
  workspaceRoot: string,
  reviewUri: vscode.Uri
): Promise<StageReadyWorkspaceIdentityV1> {
  const [headSha, treeFingerprint] = await Promise.all([
    resolveHeadCommitSha(workspaceRoot),
    computeWorkingTreeFingerprintV1(workspaceRoot, {
      excludeAbsolutePaths: [reviewUri.fsPath, previousVersionUri(reviewUri).fsPath],
    }),
  ]);
  return { headSha, treeFingerprint };
}

/**
 * review1 Step 31: true only when the review on record describes the code as it is now. A code review's own
 * `reviewed-commit` and `reviewed-tree-fingerprint` stamps must both be known and match the live workspace; a stamp
 * that is missing or a workspace that cannot be fingerprinted is "cannot tell", which must never read as current,
 * because the "<Stage> is done" card recommends moving on. Plan reviews carry no stamps and are not code reviews.
 */
export function reviewDescribesCurrentWorkspaceV1(
  stage: TaskStage,
  reviewText: string,
  identity: StageReadyWorkspaceIdentityV1
): boolean {
  if (!REVIEWED_COMMIT_STAGES.has(stage)) return true;
  return isReviewDispatchAgainstUnchangedTreeV1(reviewText, identity.headSha, identity.treeFingerprint);
}

/** bugs7 item 6: calls that arrive while one for the same task is running are the same state; they share its result. */
const stageReadyInFlightV1 = new Map<string, Promise<{ readonly posted: boolean }>>();
const stageReadyReaderIdsV1 = new WeakMap<object, number>();
let stageReadyReaderCounterV1 = 0;

export function postStageReadyCardIfReadyV1(
  taskFolderPath: string,
  whatTheOwnerDid: string,
  deps: {
    readonly readWorkspaceIdentity?: (workspaceRoot: string, reviewUri: vscode.Uri) => Promise<StageReadyWorkspaceIdentityV1>;
  } = {}
): Promise<{ readonly posted: boolean }> {
  // Calls collapse only when they read the workspace the same way (the real reader, or the same injected one).
  const reader = deps.readWorkspaceIdentity;
  let readerId = 0;
  if (reader !== undefined) {
    readerId = stageReadyReaderIdsV1.get(reader) ?? ++stageReadyReaderCounterV1;
    stageReadyReaderIdsV1.set(reader, readerId);
  }
  const key = `${normalizePath(taskFolderPath)}|${readerId}`;
  const running = stageReadyInFlightV1.get(key);
  if (running !== undefined) return running;
  const run = postStageReadyCardIfReadyCoreV1(taskFolderPath, whatTheOwnerDid, deps).finally(() => {
    stageReadyInFlightV1.delete(key);
  });
  stageReadyInFlightV1.set(key, run);
  return run;
}

async function postStageReadyCardIfReadyCoreV1(
  taskFolderPath: string,
  whatTheOwnerDid: string,
  deps: {
    readonly readWorkspaceIdentity?: (workspaceRoot: string, reviewUri: vscode.Uri) => Promise<StageReadyWorkspaceIdentityV1>;
  }
): Promise<{ readonly posted: boolean }> {
  try {
    const folderUri = vscode.Uri.file(taskFolderPath);
    const read = await readTaskProgressStrictV1(folderUri);
    if (!read.ok) return { posted: false };
    const progress = read.decoded.progress;
    if (progress.status !== "active") return { posted: false };
    const stage = progress.currentStage;
    const reviewName = STAGE_ARTIFACT_FILENAMES[stage];
    if (!reviewName) return { posted: false };
    const reviewUri = vscode.Uri.joinPath(folderUri, reviewName);
    const reviewText = await readTextIfExists(reviewUri).catch(() => undefined);
    // Only a review that is still current counts: a stale banner, or changed plan or task description, means
    // the verdict on record no longer describes the work.
    if (reviewText === undefined || hasArtifactChangeStaleBannerV1(reviewText)) return { posted: false };
    if ((await reviewInputsChangedSinceV1(taskFolderPath, reviewUri.fsPath)).changed) return { posted: false };
    // The task and plan text are only part of what the review looked at: a source file changed by hand since the
    // review leaves them untouched, so the code identity has to match too (a changed or unknowable tree posts nothing).
    if (REVIEWED_COMMIT_STAGES.has(stage)) {
      const workspaceRoot = progress.ownership?.workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceRoot) return { posted: false };
      const identity = await (deps.readWorkspaceIdentity ?? readWorkspaceIdentityForReadyCardV1)(workspaceRoot, reviewUri);
      if (!reviewDescribesCurrentWorkspaceV1(stage, reviewText, identity)) return { posted: false };
    }
    return await postAutomationStoppedCardV1({
      folderUri,
      stage,
      ending: "stage-ready",
      stopReason: `${whatTheOwnerDid}, every plan item is now settled and the latest review is clean`,
      ...(progress.displayName !== undefined ? { displayName: progress.displayName } : {}),
    });
  } catch {
    return { posted: false };
  }
}

export { AUTOMATION_STOPPED_DECISION_KEY_V1 };
