import * as vscode from "vscode";
import * as path from "path";
import * as crypto from "crypto";

import { allowsDirtyWorktreeChanges } from "../config/settings";
import { getConfiguredTaskRoot, normalizePath, resolveTaskRootCandidates, TaskRootCandidate } from "../utils/taskRoot";
import { repairLegacyOwnership } from "../utils/metaResourcesMigration";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import {
  taskOperations,
  runTrackedOperation,
  linkCancellationTokens,
  TaskOperationHandle,
  cancelRunningOperationsForTask,
  hasActiveOperationTargetingStage,
} from "../utils/taskOperations";
import {
  EscalationKind,
  IMPL_REVIEW_STAGES,
  IMPLEMENTATION_SUMMARY_FILENAME,
  isPlanReviewStage,
  isReviewStage,
  MAX_INCOMPLETE_ROUND_CONTINUATIONS_V1,
  MAX_REVIEW_BLOCKER_IDENTITIES,
  PLAN_FILENAME,
  PLAN_REVIEW_STAGES,
  REVIEW_STAGES,
  RUNS_DIRNAME,
  STAGE_ARTIFACT_FILENAMES,
  STAGE_DISPLAY_NAMES,
  STAGE_ORDER,
  TaskStage,
} from "../types/taskProgress";
import {
  BlockerSupersessionRecordV1,
  ImplementationDispatchModeV1,
  ReviewBlockerIdentity,
  ReviewScoreHistoryEntry,
  RoundLedgerEntryV1,
  RoundOutcomeClassificationV1,
  TaskEscalation,
  TaskProgress,
} from "../types/taskProgress";
import { deriveTaskBindingV1 } from "../types/taskBindingV1";
import {
  appendBlockerSupersession,
  appendChecklistChangeProposal,
  appendOverriddenEscalation,
  appendReviewRejection,
  appendReviewScoreHistory,
  clearImplementationTypeCheckFailure,
  clearReviewInvalidatedByRound,
  promotePendingImplReviewFiles,
  recordImplementationTypeCheckFailure,
  resolveRoundV1,
  setZeroChangeImplRounds,
  pauseTaskWithReason,
  updateImplReviewFiles,
  updateLintPayload,
  updateTaskStatus,
  upsertRoundLedgerEntryV1,
} from "../utils/taskProgressTransforms";
import { classifyZeroFileImplRoundV1 } from "../utils/roundOutcomeClassificationV1";
import {
  deriveCurrentDispatchModeV1,
  deriveNextRecoverySourceV1,
  formatRunLogModeHeaderV1,
  shouldContinueAsApplyReviewV1,
} from "../utils/implementationDispatchModeV1";
import { buildPromptManifestV1, writePromptManifestV1 } from "../utils/promptManifestV1";
import {
  attachCoordinatorIdentityToRoundV1,
  claimImplementationRoundLedgerV1,
  consumePendingAutomationRoundIntentV1,
  RoundLedgerTerminalStateV1,
  terminalizeRoundV1,
} from "../utils/roundLedgerV1";
import { shouldTripFallbackProviderBreakerV1 } from "../utils/fallbackProviderBreakerV1";
import {
  computeDegenerateReviewEpisodeModelIdsV1,
  decideDegenerateReviewBackupAdvanceV1,
  DegenerateReviewBackupAdvanceDecisionV1,
} from "../utils/degenerateReviewBackupAdvanceV1";
import { classifyFailure, parseQuotaResetV1, isQuotaResetBeyondThresholdV1 } from "../utils/quota";
import { QuotaParkRecordV1 } from "../types/taskProgress";
import {
  BegunImplementationRecoveryV1,
  beginImplementationRecoveryV1,
  buildImplementationContinuationPromptV1,
  claimImplRecoveryDispatchV1,
  ClaimedImplRecoveryV1,
  escalateClaimedSummaryOnlyIfUnavailableV1,
  owedContinuationSourceV1,
  stripImplementationContinuationNoticeV1,
} from "./implementationRecoveryV1";
import { syncOwedContinuationLedgerBestEffortV1 } from "../state/schedulingIntentV1";
import {
  isSummaryOnlyDispatchAvailableV1,
  runSummaryOnlyContinuationV1,
} from "./implContinuationTextDispatchV1";
import { IncompleteTask } from "../types/incompleteTask";
import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import {
  AUTO_REVIEW_TRANSITIONS,
  computeNextStage,
  StageTransitionResult,
} from "../utils/stageTransition";
import { assertLegacyAiRouteAllowedV0 } from "../services/legacyAiActionSafetyGateV0";
import {
  attributionModelLabel,
  openOrCreateDocument,
  readNonEmptyText,
  readTextIfExists,
  resolveCurrentPlanUri,
  safeOpenTextDocument,
  withAttribution,
  writeTextFile,
  writeTextFileIfUnchangedV1,
} from "../utils/fileUtils";
import {
  ChecklistProgressV1,
  detectChecklistItemSetMutationV1,
  formatChecklistItemGlyphV1,
  hasImplementationChecklistV1,
  IMPLEMENTATION_CHECKLIST_MARKER,
  listUncheckedChecklistItemTextsV1,
  mergeChecklistProgressV1,
} from "../utils/implementationChecklist";
import { generateContextPack, writeContextPack, writeImplReviewContextPack } from "../utils/contextPack";
import { renderPromptTemplate } from "../utils/promptTemplates";
import { writeRunLog } from "../utils/runLog";
import {
  describeTaskActionFailureV1,
  describeTaskActionOutcomeForLogV1,
} from "../utils/taskActionOutcomeTextV1";
import {
  checkImplementationAvailabilityForModel,
  getConfiguredBackupModelsForStage,
  preflightStageChainAvailabilityV1,
  rankedStageChainStoredIdsV1,
  recordActiveFallbackModel,
  resolveEffectiveProvider,
} from "../runners/runnerRegistry";
import {
  checkEditActionAvailabilityV1,
  checkEditActionHostGateV1,
  checkEditActionProviderPathGateV1,
  runImplementationOrSealedV1,
} from "./runEditActionV1";
import {
  describeStageSubstitutesV1,
  ResolvedStageModel,
  resolveConfiguredReviewStages,
  resolveEffectiveStageChainV1,
  resolveFreshModelForStage,
  resolveModelForStage,
} from "../utils/modelSelection";
import {
  attributeImplementationRoundFilesV1,
  buildSyntheticImplementationSummaryV1,
  buildUnusableImplementationSummaryV1,
  describeImplementationSummaryShapeIssue,
  parseReportedFilesChangedV1,
  describeIncompleteImplementationRoundV1,
  IncompleteImplementationRoundV1,
  getCanonicalImplementationUri,
  getImplementationSummaryUri,
  getLegacyImplementationUri,
  isUnusableImplementationSummaryV1,
  PlanOfRecordV1,
  readImplementationReviewContent,
  readPlanOfRecordV1,
  materializeCanonicalIfNeeded,
  preparePlanPromotion,
  applyDeferredPlanRevisionAdoptionV1,
  PlanRevisionAdoptionV1,
} from "../utils/implementationArtifactResolver";
import { ensureAiConsent } from "../utils/aiConsent";
import { checkAndConfirmPromptSize } from "../utils/promptSizeGuard";
import * as cp from "child_process";
import * as fs from "fs";
import { NotificationRouter } from "../utils/notificationRouter";
import {
  backupArtifactBeforeWrite,
  previousVersionUri,
} from "../utils/artifactBackups";
import {
  ensureWorkflowTaskFolderRootV1,
  getVerifiedTaskBindingIdV1,
  getWorkflowFileStoreV1,
} from "../services/workflowRuntimeServicesV1";
import { appendChatMessageV1, readChatDocumentIdentityV1 } from "../utils/chatHistoryStore";
import { goToReviewAndApplyV1 } from "./goToReviewAndApplyV1";
import { allocateHex128IdV1 } from "../types/actionCorrelationV1";
import {
  createProductionTaskActionCoordinatorV1,
  getProductionActionConversationOrchestratorV1,
  invokeLifecycleRowV1,
} from "../actions/productionTaskActionRuntimeV1";
import { ActionConversationOrchestratorV1, InteractionRefV1 } from "../actions/actionConversationOrchestratorV1";
import { GENERATE_IMPLEMENTATION_ACTION_KEY_V1 } from "../actions/rows/generateImplementationRowV1";
import {
  REVIEW_ACTION_KEY_V1,
  ReviewActionInputV1,
  PublishReviewFreshnessGuardV1,
} from "../actions/rows/reviewRowV1";
import { APPLY_REVIEW_ACTION_KEY_V1, ApplyReviewActionInputV1 } from "../actions/rows/applyReviewRowV1";
import { NEXT_STAGE_ACTION_KEY_V1 } from "../actions/rows/nextStageRowV1";
import { outcomeCorrelationV1, ProviderChainExhaustionV1, TaskActionOutcomeV1 } from "../types/taskActionOutcomeV1";
import { WorkflowUnavailableCodeV1 } from "../types/workflowAvailabilityV1";
import { ChatInteractionRefV1, ChatInteractionResumeResultV1, ChatTarget, ChatViewProvider } from "../views/chatView";
import {
  missingCompletionArtifactsV1,
  stageActionRequirementMessageV1,
} from "../utils/stageArtifactRequirementsV1";
import { describeOwedContinuationRefusalV1 } from "../utils/owedContinuationRefusalV1";
import { deriveApplicableVerifiedTicksV1, postApplyReviewerVerifiedTicksDecisionV1 } from "./applyReviewerVerifiedTicks";
import { postChecklistChangeProposedDecisionV1 } from "./planRevisionV1";
import {
  postReconcilePlanChecklistDecisionV1,
  runAutomaticChecklistReconciliationV1,
  AutomaticChecklistReconciliationOutcomeV1,
} from "./reconcilePlanChecklist";
import { postWorkflowDecisionV1, withdrawWorkflowDecisionsByKeyV1 } from "../utils/workflowDecisionDispatchV1";
import { WorkflowDecisionOptionV1, WorkflowDecisionRecommendationV1 } from "../types/workflowDecisionV1";
import { TaskInventory } from "../state/taskInventory";
import {
  hasZeroTaskFixableEvidence,
  isPlanIncomplete,
  meetsAutoAdvanceThreshold,
  readyToAdvanceStage,
  parseReadiness,
  parseReviewBlockers,
  parseReviewBlockersDetailed,
  extractBlockerNamedPathsV1,
  parseReviewedCommitSha,
  parseReviewProgress,
  reconcileProgressWithChecklistV1,
  detectSiblingReviewDisagreement,
  REVIEWED_COMMIT_STAGES,
  REVIEW_TARGETS,
  IN_PROGRESS_REVIEW_PLACEHOLDER_PREFIX_V1,
  markReviewInProgressBannerV1,
  ReviewBlocker,
  splitTaskFixableBlockersByOriginV1,
} from "../utils/reviewReadiness";
import {
  refreshStaleReviewBannerForArtifactV1,
} from "../utils/reviewFreshness";
import {
  effectiveReviewProgressV1,
  readEffectivePlanChecklistProgressV1,
} from "../utils/effectiveReviewProgress";
import { scheduleAutomationChain, releaseAutomationChain } from "../utils/automationChain";
import { SchedulingIntentMetadataV1 } from "../state/schedulingIntentV1";
import {
  buildVerifiedChecksSection,
  collectCompletionLintPreview,
  CompletionLintResult,
  resolvePublishScopeFolder,
  synthesizeMechanicalBlockers,
} from "../utils/completionLint";
import { checkPublishPreflight } from "../utils/publishPreflight";
import {
  derivePlanNonGoalSupersessionsV1,
  filterSupersededBlockersV1,
  formatAcceptedNonGoalsVariableV1,
  formatOwnerDecisionsVariableV1,
  parseAcceptedNonGoalsV1,
  PlanNonGoalSupersessionResultV1,
} from "../utils/reviewEvidenceNormalizerV1";
import {
  checkPublishChecksFreshnessV1,
  describePublishChecksFreshnessFailureV1,
  ensurePublishReviewArtifactExistsV1,
  ensurePublishReviewLegacySectionsImportedV1,
} from "../utils/publishChecksFreshness";
import { improveReviewScore } from "../utils/reviewScoreLoop";
import { countCommitsSinceSha, resolveHeadCommitSha } from "../utils/gitRepoInfo";
import {
  readTaskImplementationBaselineShaV1,
  recordTaskImplementationBaselineShaIfAbsentV1,
} from "../utils/taskImplementationBaselineV1";
import {
  buildChurnEscalationReasonV1,
  chooseAutomaticImplementationDispatchV1,
  classifyChurnLineageV1,
  decidePostReviewActionV1,
  decideReviewRoute,
  degenerateReviewRejectionReason,
  describeTaskFixableBlockersV1,
  IMPL_REVIEW_STAGES_V1,
  detectBlockerSetStall,
  detectPlateau,
  formatPriorBlockerLineageListV1,
  isProviderExhaustionReplyShapeV1,
  latestQualifyingReviewMeetsThresholdV1,
  preferCandidateWithinReadCeilingV1,
  promptCeilingAdvisoryV1,
  resolveBlockerLineageV1,
  REVIEW_RUBRIC_BLOCKER_SCORE_CAP,
  roundsWithoutTaskFixableDecrease,
  rubricCapLikelyBlockedAdvance,
  shouldEscalateChurnCeiling,
  shouldTripNoProgressBreaker,
  STALE_REVIEW_RECONCILIATION_COMMIT_THRESHOLD,
} from "../utils/reviewRouting";
import { detectPlanArtifactDisagreementV1 } from "../utils/planArtifactMismatchV1";
import { buildStandingBlockersNoticeV1 } from "../prompts/standingBlockersNoticeV1";
import { escalateReviewToHuman } from "../utils/reviewEscalation";
import {
  getAutoAdvanceMode,
  getAutoAdvanceScoreThreshold,
  isAutoImplementAfterReviewEnabled,
  getAutoReviewAfterImplementationMode,
  getCompleteAndMoveOnTriggersAIMode,
  getFastForwardMaxIterations,
  getFastForwardStopLevel,
  getResilienceSettings,
  getReviewPlateauRounds,
  isAutoAdvanceEnabled,
  resolveQuotaAccountKeyV1,
  strongestAutoTriggerMode,
  usesAcceptanceThresholdForFastForward,
  completeAndMoveOnTriggersAI,
} from "../config/settings";

/**
 * Compares two absolute filesystem paths for equality, case-insensitively on
 * Windows. Plain `path.resolve(a) === path.resolve(b)` spuriously reports
 * "different workspace" on Windows because `workspaceFolders[].uri.fsPath`,
 * persisted `ownership.workspaceRoot`, and task folder paths can each pick up
 * different casing depending on how the folder was opened vs. how the path
 * was written to disk.
 */
function isSameWorkspacePath(a: string, b: string): boolean {
  const resolvedA = path.resolve(a);
  const resolvedB = path.resolve(b);
  return process.platform === "win32"
    ? resolvedA.toLowerCase() === resolvedB.toLowerCase()
    : resolvedA === resolvedB;
}

/**
 * Select the configured root that directly owns a task folder. Nested
 * metadata-root configurations can both contain a task, so only the deepest
 * direct parent is valid for ownership repair.
 */
export function selectReleaseTaskRootCandidate(
  taskFolderPath: string,
  candidates: readonly TaskRootCandidate[] = resolveTaskRootCandidates()
): TaskRootCandidate | undefined {
  return candidates
    .filter((entry) => isPathWithin(taskFolderPath, entry.absolutePath))
    .sort((a, b) => b.absolutePath.length - a.absolutePath.length)
    .find((entry) => isSameWorkspacePath(path.dirname(taskFolderPath), entry.absolutePath));
}

/**
 * Apply the single shared migration repair rule before release validation.
 * Returning the repaired progress makes callers validate the persisted state
 * in this invocation rather than a stale pre-repair read.
 */
export async function repairReleaseTaskOwnership(
  taskFolderPath: string,
  progress: TaskProgress,
  candidates: readonly TaskRootCandidate[] = resolveTaskRootCandidates()
): Promise<{ rootCandidate?: TaskRootCandidate; repaired: boolean; progress: TaskProgress }> {
  const rootCandidate = selectReleaseTaskRootCandidate(taskFolderPath, candidates);
  if (!rootCandidate) return { repaired: false, progress };
  const result = await repairLegacyOwnership(taskFolderPath, progress, rootCandidate.absolutePath);
  return { rootCandidate, ...result };
}

/**
 * Validate release ownership after applying the shared lazy migration repair.
 * Keeping this command-facing boundary separate makes it explicit that the
 * release command validates the progress returned by a repair, rather than
 * the stale progress it read before the repair was persisted.
 */
export async function validateReleaseTaskOwnership(
  taskFolderPath: string,
  progress: TaskProgress,
  candidates: readonly TaskRootCandidate[] = resolveTaskRootCandidates()
): Promise<{ ok: true; progress: TaskProgress } | { ok: false; message: string }> {
  const repaired = await repairReleaseTaskOwnership(taskFolderPath, progress, candidates);
  if (!repaired.rootCandidate) {
    return {
      ok: false,
      message: `Task folder "${taskFolderPath}" is not inside a configured metadata root. This usually means the task folder was moved manually. Move it back, or re-create the task under the configured root.`,
    };
  }
  const repairedProgress = repaired.progress;
  const metaRoot = repairedProgress.ownership?.metaRoot;
  if (metaRoot && !isPathWithin(taskFolderPath, metaRoot)) {
    return {
      ok: false,
      message: `Task folder "${taskFolderPath}" is not inside its recorded metadata root "${metaRoot}". This usually means the task folder was moved manually. Move it back, or re-create the task under the configured root.`,
    };
  }
  return { ok: true, progress: repairedProgress };
}

/** The plan-review automation gate; manual stage completion never calls it. */
export function shouldScheduleAutomaticImplementation(
  nextStage: TaskStage | undefined,
  autoImplementEnabled: boolean
): boolean {
  return nextStage === "impl" && autoImplementEnabled;
}

/**
 * Schedule the post-review implementation command through the same deferred
 * automation chain used in the review completion path. Keeping this tiny
 * side-effect boundary explicit lets tests assert the real dispatch contract
 * (rather than only re-implementing its predicate).
 */
export function scheduleAutomaticImplementationAfterReview(
  nextStage: TaskStage | undefined,
  autoImplementEnabled: boolean,
  taskFolderPath: string,
  parentOperation: TaskOperationHandle | undefined
): boolean {
  if (!shouldScheduleAutomaticImplementation(nextStage, autoImplementEnabled)) {
    return false;
  }
  void scheduleAutomationChain(
    {
      command: "vs-code-ai-helper.runImplementationWithAI",
      // No human on this path — see ReviewCommandArg.automationDispatch.
      arg: { taskFolderPath, automationDispatch: true },
      taskKey: taskFolderPath,
      // Re-checked at fire time: the review that scheduled this can run for
      // minutes, and the user may disable auto-implement in the meantime.
      stillEnabled: () => isAutoImplementAfterReviewEnabled(),
      intent: {
        trigger: "auto-implement after review completes",
        settingKey: "ensemble.autoImplementAfterReview",
        expectedTiming: "immediately, once this review finishes",
        willRetry: false,
        retryNote: "Not retried automatically if dropped — run Implementation manually.",
      },
    },
    parentOperation
  );
  return true;
}

/**
 * Claim the review attempt immediately before invoking the AI provider —
 * the round's true start. Part 4 architectural fix (2026-08-27 review,
 * narrowed blocker 2: "the replacement still creates an artificial open row
 * inside review completion handling ... outside the start authority"):
 * this is now also where the round's `roundLedger` row is OPENED, in the
 * same transaction as the claim, so the row's `startedAt` is the round's
 * real start time rather than a value re-derived later at whatever point
 * completion handling happens to notice it needs one. Both production call
 * sites (`runReviewForFolder`'s initial dispatch and
 * `resumeReviewInteractionV1`'s fresh resume attempt) already call this
 * function as their first act after resolving `targetStage`, so both are
 * covered without duplicating the open-row logic at each site.
 * `terminalizeRoundV1` (the sole terminal writer) later resolves this same
 * row by `reviewAttemptId` — see `handleReviewRoutingOutcome` and
 * `handleReviewOutcomeV1`'s general safety-net terminalizer.
 *
 * Part 4 review follow-up (2026-08-27, blocker "coordinator-owned lifecycle
 * identity" / "Automated rounds now add an intent-keyed generic row while
 * review rows still use a separate synthetic ID"): when this review round
 * was itself dispatched by `scheduleAutomationChain`, that dispatcher already
 * opened a GENERIC round-ledger row keyed by its own scheduling `intentId`
 * (`openAutomationRoundLedgerRowBestEffortV1`) and staged that `intentId`
 * here via `setPendingAutomationRoundIntentV1`, immediately before invoking
 * this review command. Consuming it below and REUSING that same row (rather
 * than opening a second one keyed by `reviewAttemptId`) collapses the round
 * to one identity: `automationChain.ts`'s settle-point terminalizer and this
 * review's own terminalizer then race to close the ONE row, and
 * `terminalizeRoundV1`'s idempotency guarantees the richer of the two calls
 * always wins regardless of which fires first (see that function's doc
 * comment). A manually-invoked review has nothing pending to consume and
 * keeps opening its own row exactly as before.
 */
export async function claimReviewAttempt(
  folderUri: vscode.Uri,
  reviewAttemptId: string,
  targetStage: TaskStage
): Promise<TaskProgress | undefined> {
  const pendingIntentId = consumePendingAutomationRoundIntentV1(folderUri.fsPath);
  return patchTaskProgressStrictV1(folderUri, (current) => {
    if (current.status === "paused") {
      throw new Error("The task was paused while the review was starting.");
    }
    const resolvedPending = pendingIntentId ? resolveRoundV1(current, pendingIntentId) : undefined;
    // Stale-intent guard (2026-08-27 review follow-up, blocker "the
    // replacement task-key/TTL correlation can attach a later review to a
    // stale, already-terminal round"): `pendingIntentId` is a best-effort
    // side channel (see `setPendingAutomationRoundIntentV1`'s doc comment)
    // that can go unconsumed — the dispatched command was not this review, or
    // a review errored before reaching this function — and then sit in the
    // map, still resolving to a row `automationChain.ts`'s generic settle
    // handler has since terminalized, until its TTL expires or a later
    // same-taskKey dispatch overwrites it. Reusing a row regardless of
    // whether the PRIOR round already ended would silently reopen an
    // already-terminal row under this review's own facts, corrupting the
    // prior round's durable ending and letting one `roundId` serve two
    // unrelated rounds. Only a row still LIVE (`"scheduled"`/`"open"`) is
    // eligible for reuse; a resolved-but-terminal row is treated exactly like
    // no pending intent existed.
    const reused =
      resolvedPending && (resolvedPending.state === "scheduled" || resolvedPending.state === "open")
        ? resolvedPending
        : undefined;
    const openRow: RoundLedgerEntryV1 = reused
      ? {
          ...reused,
          attemptIds: reused.attemptIds.includes(reviewAttemptId)
            ? reused.attemptIds
            : [...reused.attemptIds, reviewAttemptId],
          stage: targetStage,
          mode: "review",
          state: "open",
        }
      : {
          roundId: reviewAttemptId,
          attemptIds: [reviewAttemptId],
          stage: targetStage,
          mode: "review",
          startedAt: new Date().toISOString(),
          state: "open",
          // Only attach `pendingIntentId` when it resolved to nothing at all
          // (a genuinely fresh, not-yet-opened row for THIS dispatch) — never
          // when it resolved to a stale terminal row (`resolvedPending`
          // truthy but not reused above), since that id belongs to a
          // different, already-ended round and must not be attached here.
          ...(pendingIntentId && !resolvedPending ? { intentId: pendingIntentId } : {}),
        };
    return upsertRoundLedgerEntryV1({ ...current, reviewAttemptId }, openRow);
  });
}

/** Returns whether an absolute path is the supplied root or a descendant. */
function isPathWithin(candidate: string, root: string): boolean {
  const normalizedCandidate = path.resolve(candidate);
  const normalizedRoot = path.resolve(root);
  const comparableCandidate = process.platform === "win32"
    ? normalizedCandidate.toLowerCase()
    : normalizedCandidate;
  const comparableRoot = process.platform === "win32"
    ? normalizedRoot.toLowerCase()
    : normalizedRoot;
  return comparableCandidate === comparableRoot ||
    comparableCandidate.startsWith(comparableRoot + path.sep);
}

/**
 * Finds the project workspace for a release operation. A task may be stored
 * outside the project in a configured metadata root, so persisted ownership
 * takes precedence over task-folder containment.
 *
 * @internal exported for release ownership tests
 */
export function resolveReleaseWorkspace<T extends { uri: { fsPath: string } }>(
  taskFolder: string,
  ownership: {
    metaRoot?: string;
    projectRoot?: string;
    workspaceRoot?: string;
  } | undefined,
  workspaceFolders: readonly T[]
): T | undefined {
  if (ownership?.metaRoot && !isPathWithin(taskFolder, ownership.metaRoot)) {
    return undefined;
  }
  const projectRoot = ownership?.projectRoot ?? ownership?.workspaceRoot;
  return projectRoot
    ? workspaceFolders.find(folder => isSameWorkspacePath(folder.uri.fsPath, projectRoot))
    : workspaceFolders.find(folder => isPathWithin(taskFolder, folder.uri.fsPath));
}

/**
 * The optional argument tree-view buttons pass to these commands: the tree
 * node carries the task it was rendered for.
 */
export interface TaskNodeArg {
  task?: IncompleteTask;
}

/**
 * Normalized argument shape accepted by review commands.
 *
 * Commands may be invoked from:
 *   - Tree task-row buttons: `{ task: IncompleteTask }`
 *   - Tree stage-row buttons: `{ task: IncompleteTask }` (same shape)
 *   - Keyboard shortcut router: `{ taskFolderPath: string }`
 *   - Command palette (no arg): undefined
 *
 * Note: `{ canonicalId }` alone is NOT a supported shape. Callers that
 * have only a canonical ID must first resolve it to a `taskFolderPath`
 * (via the task inventory) before invoking a review command. Passing only
 * `{ canonicalId }` without `taskFolderPath` is a caller error.
 *
 * At the type level: `{ canonicalId }` without `taskFolderPath` is not
 * included in this union, so the TypeScript compiler rejects such calls
 * at compile time.
 *
 * At the runtime level: `isMalformedReviewArg` is called at each command
 * entry point to catch stale/untyped callers that pass an unsupported shape
 * (e.g. via `as any` or untyped JS). Such calls show a clear error message
 * and return early instead of silently falling through to a QuickPick where
 * the wrong task could be selected.
 *
 * This union type lets review command handlers accept all shapes and
 * normalize them into a single `resolveTask` call.
 */
type ReviewCommandArg =
  | TaskNodeArg
  | {
      taskFolderPath: string;
      /**
       * Carried only by automation-chain dispatches from "Complete & Move On
       * triggers AI: auto-fast-forward". When the triggered action lands on a
       * review, the follow-up review runs as the Fast Forward loop even when
       * that stage's own auto-review setting is off or plain "auto". Never
       * set by UI surfaces.
       */
      followUpReviewMode?: "auto-fast-forward";
      /**
       * Set ONLY by automation-chain dispatches (`scheduleAutomationChain`),
       * never by a UI surface — same contract as `followUpReviewMode` above.
       *
       * Marks an invocation with no human attached to answer a question.
       * `runImplementationWithAI`'s pre-run routing check posts a
       * `WorkflowDecisionV1` when task-fixable blockers stand — a decision
       * record only a human is there to act on, so an automation dispatch
       * skips posting it entirely rather than adding a decision nobody will
       * ever see.
       */
      automationDispatch?: true;
    }
  | undefined;

/**
 * Whether this invocation came from an automation chain rather than a person.
 * Only the exact literal marker counts; any UI-supplied arg yields false.
 */
function isAutomationDispatchV1(arg: ReviewCommandArg): boolean {
  return (
    arg !== undefined &&
    "automationDispatch" in arg &&
    (arg as { automationDispatch?: unknown }).automationDispatch === true
  );
}

/**
 * Extract the chained follow-up-review request from a ReviewCommandArg, if
 * present. Only the exact "auto-fast-forward" marker is honored — anything
 * else (including args from UI surfaces) yields undefined.
 *
 * The marker is re-validated against the setting that minted it: it was
 * only ever attached while "Complete & Move On triggers AI" was
 * "auto-fast-forward", so if that setting has since been turned off or
 * downgraded, a queued/stale arg must not resurrect the disabled loop.
 */
function chainedFollowUpReviewMode(
  arg: ReviewCommandArg
): "auto-fast-forward" | undefined {
  return arg &&
    typeof arg === "object" &&
    "followUpReviewMode" in arg &&
    arg.followUpReviewMode === "auto-fast-forward" &&
    getCompleteAndMoveOnTriggersAIMode() === "auto-fast-forward"
    ? arg.followUpReviewMode
    : undefined;
}

interface ApplyReviewOptions {
  /** Skip repeated dirty/non-git workspace confirmations for internally chained runs. */
  skipImplementationSafetyCheck?: boolean;
  /** Preserve a stage's active fallback reservation across one internal retry loop. */
  preserveActiveFallback?: boolean;
  /**
   * Replaces skipTaskLock. The parent operation that holds the task operation lock.
   *
   * This is the operation-lifecycle mechanism for composite flows: when a caller
   * (e.g. fastForwardReviewWithAI) passes its own handle here, applyReviewWithAI
   * reuses that single registered operation for every internal attempt instead
   * of registering (and un-registering) a new one per attempt — so the
   * Notifications/status views render exactly one in-progress row for the
   * whole composite action, never one per internal step. See the
   * `options.parentOperation` checks around the `begin`/`end` calls below.
   */
  parentOperation?: TaskOperationHandle;
  /** Routes `applyReview.v1` structured questions into Chat With AI. */
  chatViewProvider?: ChatViewProvider;
}

interface ExecuteImplementationRunOptions {
  /** Skip the pre-run dirty/non-git workspace confirmation. */
  skipPreRunSafetyCheck?: boolean;
  /** Preserve a stage's active fallback reservation across one internal retry loop. */
  preserveActiveFallback?: boolean;
  onBusyDetail?: (detail: string | undefined) => void;
  onWaitingForUser?: (waiting: boolean) => void;
  /**
   * Tracked operation this run executes under. When set, the post-run
   * auto-review registers as a child of it (C1 nesting), so the stage-row
   * spinner moves from the implementation row to the review row while the
   * re-review runs.
   */
  parentOperation?: TaskOperationHandle;
  /**
   * Chained fast-forward request carried from "Complete & Move On triggers
   * AI: auto-fast-forward". When set, a successful implementation run always
   * schedules its follow-up review as the Fast Forward loop — even when
   * auto-advance and the auto-review-after-implementation setting are off or
   * plain "auto".
   */
  followUpReviewMode?: "auto-fast-forward";
  /**
   * Skip the post-run auto-review dispatch entirely. Set by
   * applyImplementationReviewWithAI: that call's own `parentOperation` is a
   * nested child registered just for stage-row UI purposes, not the
   * operation actually holding the task's exclusive lock (Apply Review's own
   * root, or — under Fast Forward — its whole multi-attempt loop). The
   * deferred dispatch below waits for `parentOperation` to end and then
   * tries to reacquire that lock via a fresh command; since the real holder
   * is still running, it is refused as busy and silently dropped, leaving
   * the review stuck on the "Review Stale" placeholder forever. The caller
   * re-reviews inline instead (see applyReviewWithAI), under the lock it
   * already holds.
   */
  suppressAutoReviewDispatch?: boolean;
  /**
   * The §7.8 registry action key this edit run executes as
   * ("implementation.v1" by default; applyImplementationReviewWithAI passes
   * "applyReviewEdit.v1"). Selects the preflight row the sealed two-phase
   * pipeline runs under — see runSealedImplementationV1.
   */
  editActionKey?: string;
  /**
   * Task-local Chat surface for structured preflight questions: when the
   * sealed pipeline's preflight returns questions, the persisted interaction
   * is mirrored here (askInteraction) so it gets the full Answer/Resume
   * lifecycle (plan §5.5 / AC-PREFLIGHT-04).
   */
  chatViewProvider?: ChatViewProvider;
  /**
   * Prompt template name and the raw variables it was rendered from (item
   * 17a's prompt manifest — Part 2 step 7), so the manifest written beside
   * the run log records real per-variable sizes/hashes instead of a single
   * opaque prompt blob. Absent for any caller that has not been updated to
   * supply it; the manifest then falls back to one pseudo-variable
   * covering the whole dispatched prompt.
   */
  templateName?: string;
  templateVariables?: Record<string, string>;
  /**
   * The stable identities of the blockers this round is being dispatched to
   * address — set only for an apply-review dispatch (fresh or a continuation
   * that re-rendered from the review), never for a checklist-driven round
   * (Part 2 step 5: "list the blocker ids handed to it"). Recorded in the run
   * log's `Mode:` header so the automatic loop's dispatch choices stay
   * auditable against what the reviewer actually reported.
   */
  dispatchedBlockerIds?: readonly ReviewBlockerIdentity[];
}

/**
 * Fast-forward review is one user action that can trigger several internal
 * apply/re-review attempts. Only the first attempt is a fresh invocation;
 * later attempts should reuse any fallback activated earlier in the same loop.
 */
export function buildFastForwardApplyReviewOptions(
  attemptNumber: number,
  parentOperation?: TaskOperationHandle,
  chatViewProvider?: ChatViewProvider
): ApplyReviewOptions {
  const preserveActiveFallback = attemptNumber > 1;
  return {
    skipImplementationSafetyCheck: preserveActiveFallback,
    preserveActiveFallback,
    parentOperation,
    chatViewProvider,
  };
}

/**
 * Item 13 (2026-08-18..19 workflow-defects batch): whether Fast Forward's
 * `isPaused` callback may un-pause the task and continue through an
 * escalation it finds mid-run, rather than aborting.
 *
 * A `plateau` escalation means "iteration is not converging" by definition —
 * the one signal where finishing the attempt budget cannot help and only
 * spends money re-confirming a stalemate — so it is NEVER ride-through
 * eligible, regardless of the `fastForwardSurvivesEscalation` setting. Every
 * other kind (spec-defect, environmental, unverifiable,
 * reviewer-disagreement) is the case the setting was written for: a single
 * escalation mid-budget on an otherwise converging run.
 *
 * Pulled out as a pure predicate (rather than left inline in the closure)
 * specifically so this decision is unit-testable without standing up the
 * full Fast Forward provider/notification harness.
 */
export function shouldRideThroughEscalationV1(options: {
  survivesEscalationSetting: boolean;
  escalationStage: TaskStage | undefined;
  escalationKind: EscalationKind | undefined;
  targetStage: TaskStage;
}): boolean {
  return (
    options.survivesEscalationSetting &&
    options.escalationStage === options.targetStage &&
    options.escalationKind !== "plateau"
  );
}

/**
 * Item 13 review finding (2026-08-20): `escalation` is deliberately never
 * cleared when Fast Forward rides through it (it survives for end-of-run
 * reporting), so a later read of `TaskProgress.escalation` inside `isPaused`
 * can still be the SAME record this run already rode through once — e.g. the
 * task was subsequently paused again by hand (a genuine external pause)
 * without a fresh escalation replacing the stale one. Without this check, a
 * later manual/external pause carrying the stale record would be mistaken
 * for the same escalation being ridden through a second time and silently
 * undone.
 *
 * Pulled out as a pure predicate (matching `shouldRideThroughEscalationV1`'s
 * own rationale) so the race this closes is directly unit-testable without
 * standing up the full Fast Forward provider/notification harness.
 */
export function isFreshEscalationForRideThroughV1(
  escalation: TaskEscalation | undefined,
  lastRiddenThroughEscalationAt: string | undefined
): escalation is TaskEscalation {
  return escalation !== undefined && escalation.at !== lastRiddenThroughEscalationAt;
}

/**
 * Item 13 review finding (2026-08-20): the write-time CAS that un-pauses the
 * task for a ride-through previously checked only `status === "paused"` and
 * `escalation.stage === targetStage`. Between the read that decided to ride
 * through and this write, a DIFFERENT escalation on the same stage — most
 * dangerously a `plateau`, which must never ride through — could have been
 * recorded, and the stage-only check would still approve the un-pause,
 * overriding an escalation it never actually inspected. The CAS must
 * re-verify the EXACT escalation (stage, kind, and its own `at`) that was
 * just inspected, not merely that some escalation exists on the same stage.
 *
 * Pulled out as a pure predicate for the same testability reason as
 * `isFreshEscalationForRideThroughV1`.
 */
export function escalationIdentityStillMatchesV1(
  current: Pick<TaskProgress, "status" | "escalation">,
  inspected: TaskEscalation,
  targetStage: TaskStage
): boolean {
  return (
    current.status === "paused" &&
    current.escalation?.stage === targetStage &&
    current.escalation?.kind === inspected.kind &&
    current.escalation?.at === inspected.at
  );
}

/**
 * Detect whether a value that was passed as `ReviewCommandArg` is an
 * unrecognized object shape — i.e. neither `undefined`, nor a well-formed
 * `{ task }` node, nor a `{ taskFolderPath }` path arg.
 *
 * "Well-formed `{ task }`" means the `task` key is present AND its value is
 * a truthy object with a truthy `folderUri` property. Passing `{ task: {} }`
 * or `{ task: { folderUri: undefined } }` is not a valid `TaskNodeArg`
 * because `resolveTask` dereferences `task.folderUri` and passes it straight
 * to `readTaskProgressStrictV1` → `vscode.Uri.joinPath`, which would throw
 * before that function's own `try/catch`. Requiring `task.folderUri` to be truthy here
 * catches those stale/untyped callers before they can cause an unhandled
 * exception.
 *
 * Callers that have only a `canonicalId` (e.g. stale code that pre-dates the
 * `ReviewCommandArg` narrowing) will hit this guard rather than silently
 * falling through to a QuickPick that could re-target the action against a
 * different task.
 *
 * A key being present but its value being falsy/undefined counts as malformed.
 * For example `{ canonicalId: "x", taskFolderPath: undefined }` has the
 * `taskFolderPath` key but the value is undefined, so it is not a valid
 * `{ taskFolderPath: string }` arg and must be caught here rather than
 * falling through normalizeReviewArg to a QuickPick.
 *
 * PRIMITIVE INPUTS: `"x"`, `42`, `true`, etc. are not valid ReviewCommandArg
 * values. This function returns `false` for primitives so that the entry
 * points treat them the same as `undefined` (safe QuickPick fallback) rather
 * than throwing a TypeError in `normalizeReviewArg` where the `in` operator
 * would be applied to a non-object. This matches the `typeof arg !== "object"`
 * early-return below.
 *
 * Returns true when `arg` is a non-null object that either:
 *   (a) carries none of the accepted discriminant keys (`task`, `taskFolderPath`), or
 *   (b) carries one of those keys but with a falsy or structurally invalid
 *       value, AND carries at least one other key (indicating a stale caller
 *       with extra properties trying to look valid).
 *
 * More precisely: returns true when the object is non-empty AND does not
 * satisfy either accepted branch:
 *   - `{ task }` branch: "task" in arg AND arg.task is truthy AND
 *     arg.task has a truthy `folderUri` property
 *   - `{ taskFolderPath }` branch: "taskFolderPath" in arg AND
 *     arg.taskFolderPath is a non-empty string
 */
function isMalformedReviewArg(arg: ReviewCommandArg | Record<string, unknown>): boolean {
  if (arg === undefined || arg === null) {
    return false;
  }
  // Primitives (string, number, boolean) are not valid ReviewCommandArg values.
  // Return false so entry points fall through to the safe QuickPick path via
  // normalizeReviewArg — the `in` operator on a primitive would throw a
  // TypeError, so we must NOT return true here (which would show an error
  // message for an arg the user never consciously passed).
  // The entry points pass the value straight to normalizeReviewArg after this
  // guard, and normalizeReviewArg's `typeof arg !== "object"` check treats
  // primitives as "no arg" (safe QuickPick fallback).
  if (typeof arg !== "object") {
    return false;
  }
  // An empty object is treated as "no arg" by normalizeReviewArg → {} → QuickPick.
  // That is safe, not malformed.
  if (Object.keys(arg).length === 0) {
    return false;
  }
  const rec = arg as Record<string, unknown>;
  // { task } branch is valid only when task is a truthy object with a truthy folderUri.
  // Requiring folderUri prevents { task: {} } and { task: { folderUri: undefined } }
  // from slipping through to resolveTask, which would pass undefined to
  // vscode.Uri.joinPath and throw before the try/catch.
  if ("task" in rec && rec.task && typeof rec.task === "object") {
    const taskObj = rec.task as Record<string, unknown>;
    if (taskObj.folderUri) {
      return false;
    }
  }
  // { taskFolderPath } branch is valid only when the value is a non-empty string
  if ("taskFolderPath" in rec && typeof rec.taskFolderPath === "string" && rec.taskFolderPath.length > 0) {
    return false;
  }
  // Non-empty object that satisfies neither accepted branch — unsupported/malformed shape
  return true;
}

interface ResolvedTask {
  folderUri: vscode.Uri;
  progress: TaskProgress;
}

/**
 * Normalize a ReviewCommandArg into the `TaskNodeArg` shape that the local
 * `resolveTask` function accepts.
 *
 * - `{ task: IncompleteTask }` → passed through unchanged
 * - `{ taskFolderPath }` → re-wrapped with a synthetic IncompleteTask so
 *   `resolveTask` re-reads fresh progress from disk (stale data not used)
 * - `undefined` → `{}` (no-task, triggers the QuickPick fallback)
 * - primitives (string, number, boolean) → `{}` (treated as no-arg; the
 *   `in` operator must never be applied to a non-object, so we guard with
 *   `typeof arg !== "object"` before any property access)
 *
 * Callers must supply `taskFolderPath` (not just `canonicalId`) to resolve a
 * specific task without a picker. The `ReviewCommandArg` type does not include
 * `{ canonicalId }` alone; passing only a `canonicalId` is rejected at compile
 * time. At runtime, `isMalformedReviewArg` (called at command entry points)
 * catches stale callers before `normalizeReviewArg` is reached, so
 * `normalizeReviewArg` never needs to handle that case.
 *
 * @internal exported for testing
 */
export function normalizeReviewArg(arg: ReviewCommandArg): TaskNodeArg {
  // Guard against primitives: the `in` operator throws a TypeError when
  // applied to a non-object (string, number, boolean). Treat primitives as
  // "no arg" — the same as undefined — so callers get the safe QuickPick
  // fallback rather than a crash. isMalformedReviewArg already returns false
  // for primitives so they reach this function; handle them here explicitly.
  if (!arg || typeof arg !== "object") {
    return {};
  }
  // The task branch requires a real folderUri: the keyboard-shortcut router
  // (applyCurrentStageAction) dispatches { canonicalId, taskFolderPath,
  // task: { progress } } — a partial task with no folderUri — which must fall
  // through to the { taskFolderPath } branch below instead of reaching
  // resolveTask, where `node.task.folderUri.fsPath` would throw.
  if ("task" in arg && arg.task && arg.task.folderUri?.fsPath) {
    return arg;
  }
  // Caller passed { taskFolderPath }
  if ("taskFolderPath" in arg && arg.taskFolderPath) {
    // Construct a minimal IncompleteTask so resolveTask can re-read its progress
    return {
      task: {
        folderUri: vscode.Uri.file(arg.taskFolderPath),
        folderName: arg.taskFolderPath.split(/[\\/]/).pop() ?? "",
        progress: {
          taskFolder: arg.taskFolderPath.split(/[\\/]/).pop() ?? "",
          currentStage: "desc" as TaskStage,
          status: "active",
          createdAt: "",
          updatedAt: "",
        },
      },
    };
  }
  return {};
}

/**
 * The stages eligible for the "Generate Implementation" action.
 *
 * Only `"implementation"` is eligible. Tasks at `"plan-low-review"` are NOT
 * eligible — the user must advance to the implementation stage (which promotes
 * plan.md → plan-final.md) before generating implementation notes. Including
 * `"plan-low-review"` would let the command advertise a task as eligible in
 * the QuickPick but then hard-fail immediately because plan-final.md doesn't
 * exist yet.
 *
 * Exported so that tests can import and assert against this constant directly,
 * ensuring suite 16 stays coupled to the production value.
 */
export const GENERATE_IMPL_ELIGIBLE_STAGES: readonly TaskStage[] = [
  "impl",
];

/**
 * Resolve which task a command should act on: the tree node's task when
 * invoked from the view, otherwise a QuickPick over tasks whose current
 * stage is eligible. Progress is always re-read from disk so a stale tree
 * node can't act on outdated stage information.
 */
async function resolveTask(
  node: TaskNodeArg | undefined,
  eligibleStages: readonly TaskStage[],
  title: string,
  context: vscode.ExtensionContext
): Promise<ResolvedTask | undefined> {
  if (node?.task?.folderUri?.fsPath) {
    const folderUri = node.task.folderUri;
    // Strict decode (plan §3.10/§3.12 Text-3 cutover): this is the single
    // most common resolution path shared by every review-family command, so
    // migrating it off the permissive reader closes the largest share of
    // this file's remaining permissive-reader exposure. Unlike the
    // permissive reader's single collapsed `undefined`, an unsupported/
    // invalid document is surfaced as its own recovery message rather than
    // silently treated the same as "no file".
    // expectedTaskFolder activates the decoder's folder-binding mismatch
    // check (taskProgressDecoderV1.ts): the persisted `taskFolder` must equal
    // this progress file's own containing folder's basename, so a copy/move
    // of a task-progress.json into a different folder is caught here rather
    // than silently trusted.
    const strict = await readTaskProgressStrictV1(folderUri, {
      expectedTaskFolder: path.basename(folderUri.fsPath),
    });
    if (!strict.ok) {
      NotificationRouter.showError(
        strict.code === "missing"
          ? `Could not read task progress for ${node.task.folderName}.`
          : `Task progress for ${node.task.folderName} could not be read (${strict.code}) and needs recovery: ${strict.reason}`
      );
      return undefined;
    }
    const progress: TaskProgress = strict.decoded.progress;
    if (!eligibleStages.includes(progress.currentStage)) {
      NotificationRouter.showWarning(
        `${node.task.folderName} is at stage "${
          STAGE_DISPLAY_NAMES[progress.currentStage]
        }", which this action doesn't apply to.`
      );
      return undefined;
    }
    const owner = progress.ownership?.workspaceRoot;
    const owningWorkspace = vscode.workspace.workspaceFolders?.find(folder =>
      owner && isSameWorkspacePath(folder.uri.fsPath, owner)
    );
    if (owner && !owningWorkspace) {
      NotificationRouter.showError("This task belongs to a different workspace and cannot be operated on here.");
      return undefined;
    }
    return { folderUri, progress };
  }

  // Discover tasks across ALL workspace folders rather than inferring the
  // owning workspace from the active editor. The active-editor heuristic can
  // silently redirect a command to a different workspace when the user's focus
  // happens to be on a file in an unrelated workspace, violating the
  // persisted-owner-only rule.
  const allWorkspaceFolders = vscode.workspace.workspaceFolders ?? [];
  if (allWorkspaceFolders.length === 0) {
    NotificationRouter.showError(
      "No workspace folder open. Please open a folder first."
    );
    return undefined;
  }

  const discoveredUris: vscode.Uri[] = [];
  for (const wsFolder of allWorkspaceFolders) {
    const metaFolderUri = vscode.Uri.joinPath(wsFolder.uri, getConfiguredTaskRoot());

    try {
      const entries = await vscode.workspace.fs.readDirectory(metaFolderUri);
      for (const [name, type] of entries) {
        if (type === vscode.FileType.Directory) {
          discoveredUris.push(vscode.Uri.joinPath(metaFolderUri, name));
        }
      }
    } catch {
      // Skip workspace folders where the meta folder doesn't exist.
    }

    try {
      const legacyUri = vscode.Uri.joinPath(wsFolder.uri, "plans");
      if (legacyUri.fsPath !== metaFolderUri.fsPath) {
        const legacyEntries = await vscode.workspace.fs.readDirectory(legacyUri);
        for (const [name, type] of legacyEntries) {
          if (type === vscode.FileType.Directory) {
            discoveredUris.push(vscode.Uri.joinPath(legacyUri, name));
          }
        }
      }
    } catch {
      // Ignore errors reading legacy folder.
    }
  }

  type DiscoveredTaskItem =
    | IncompleteTask
    | {
        folderUri: vscode.Uri;
        folderName: string;
        canonicalId: string;
        corrupt: true;
        code: string;
        reason: string;
      };

  const discoveredTasks: DiscoveredTaskItem[] = [];
  for (const folderUri of discoveredUris) {
    const folderName = path.basename(folderUri.fsPath);
    const strict = await readTaskProgressStrictV1(folderUri, {
      expectedTaskFolder: folderName,
    });
    if (!strict.ok) {
      if (strict.code !== "missing") {
        discoveredTasks.push({
          folderUri,
          folderName,
          canonicalId: normalizePath(folderUri.fsPath),
          corrupt: true,
          code: strict.code,
          reason: strict.reason,
        });
      }
      continue;
    }
    discoveredTasks.push({
      folderUri,
      folderName,
      progress: strict.decoded.progress,
      canonicalId: normalizePath(folderUri.fsPath),
    });
  }

  const eligible = discoveredTasks.filter((task) =>
    "corrupt" in task ? true : eligibleStages.includes(task.progress.currentStage)
  );
  if (eligible.length === 0) {
    NotificationRouter.showInformation(
      discoveredUris.length === 0
        ? "No task folders found. Use 'Start New Task' to create one."
        : "No tasks are at a stage eligible for this action."
    );
    return undefined;
  }

  const soleEligible = eligible.length === 1 ? eligible[0] : undefined;
  const currentTaskId = new CurrentTaskStore(context.workspaceState).get();
  const taskId = (task: DiscoveredTaskItem): string =>
    task.canonicalId ?? normalizePath(task.folderUri.fsPath);
  const autoPickable =
    soleEligible !== undefined && (!currentTaskId || currentTaskId === taskId(soleEligible));
  // wf10 item 20: a caller with no explicit tree node (e.g. a task-scoped
  // stage chat, or a keybinding fired while a task is selected) still has a
  // clear implied task via CurrentTaskStore — it should never fall through
  // to a "Select a task" picker over every task in the workspace just
  // because it isn't the SOLE eligible one. Only genuinely ambiguous
  // invocations (bare command palette with no current task, or a current
  // task that isn't eligible for this action) reach the picker below.
  const currentTaskMatch = currentTaskId
    ? eligible.find((task) => taskId(task) === currentTaskId)
    : undefined;

  let picked: DiscoveredTaskItem | undefined;
  if (currentTaskMatch) {
    picked = currentTaskMatch;
  } else if (autoPickable) {
    picked = soleEligible;
  } else {
    // Genuinely ambiguous: list the current task first (if it exists but
    // wasn't eligible, it won't be in `eligible` at all and this is a no-op)
    // so it is pre-focused — showQuickPick focuses the first item by default
    // (same trick as reopenTask.ts's pickReopenStage).
    const ordered = currentTaskId
      ? [...eligible].sort((a, b) => Number(taskId(a) !== currentTaskId) - Number(taskId(b) !== currentTaskId))
      : eligible;
    const items = ordered.map((task) => ({
      label: "corrupt" in task ? task.folderName : task.progress.displayName ?? task.folderName,
      description:
        "corrupt" in task
          ? `[Recovery Required] ${task.reason}`
          : `Stage: ${STAGE_DISPLAY_NAMES[task.progress.currentStage]}`,
      detail: task.folderName,
      task,
    }));
    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: "Select a task",
      title,
    });
    picked = selected?.task;
  }
  if (!picked) {
    NotificationRouter.showInformation("Task selection cancelled.");
    return undefined;
  }

  if ("corrupt" in picked) {
    NotificationRouter.showError(
      `Task progress for ${picked.folderName} could not be read (${picked.code}) and needs recovery: ${picked.reason}`
    );
    return undefined;
  }

  const strictPicked = await readTaskProgressStrictV1(picked.folderUri, {
    expectedTaskFolder: path.basename(picked.folderUri.fsPath),
  });
  if (!strictPicked.ok) {
    NotificationRouter.showError(
      strictPicked.code === "missing"
        ? `Could not read task progress for ${picked.folderName}.`
        : `Task progress for ${picked.folderName} could not be read (${strictPicked.code}) and needs recovery: ${strictPicked.reason}`
    );
    return undefined;
  }
  const pickedProgress = strictPicked.decoded.progress;
  if (!eligibleStages.includes(pickedProgress.currentStage)) {
    NotificationRouter.showWarning(
      `${picked.folderName} is at stage "${
        STAGE_DISPLAY_NAMES[pickedProgress.currentStage]
      }", which this action doesn't apply to.`
    );
    return undefined;
  }
  return { folderUri: picked.folderUri, progress: pickedProgress };
}

/**
 * Strict-decode read for internal advisory/defensive checks that already
 * tolerate a missing or unreadable progress file by falling back to
 * `undefined` (freshness re-checks, best-effort context, pause polling).
 * Unlike the permissive `readTaskProgress`, this never silently coerces
 * unsupported/legacy field shapes into a plausible-looking `TaskProgress` —
 * an unsupported/invalid document collapses to `undefined` exactly like a
 * missing file, so these call sites keep their existing conservative
 * "no evidence" handling without risking a fabricated value (plan §3.12
 * Text-3 cutover). Callers that must actually distinguish and surface
 * recovery (e.g. a top-level command's stage/status gate) should call
 * `readTaskProgressStrictV1` directly instead, as `resolveTask` and
 * `runRelease` do.
 */
async function readTaskProgressAdvisoryV1(
  folderUri: vscode.Uri
): Promise<TaskProgress | undefined> {
  const strict = await readTaskProgressStrictV1(folderUri, {
    expectedTaskFolder: path.basename(folderUri.fsPath),
  });
  if (strict.ok) {
    return strict.decoded.progress;
  }
  if (strict.code !== "missing") {
    NotificationRouter.showError(
      `Task progress for ${path.basename(folderUri.fsPath)} could not be read (${strict.code}) and needs recovery: ${strict.reason}`
    );
    throw new Error(
      `Task progress recovery required for ${path.basename(folderUri.fsPath)} (${strict.code}): ${strict.reason}`
    );
  }
  return undefined;
}

/**
 * The most recent reviewScoreHistory entry for `targetStage`, read fresh
 * from disk rather than trusting a possibly-stale in-memory `TaskProgress`
 * snapshot. Fast Forward's baseline reviewer lookup needs this: when no
 * review existed yet at the target stage, the caller just ran the initial
 * review, which appends that stage's very first history entry (including
 * the reviewer identity that produced the baseline score) via its own
 * `handleReviewRoutingOutcome` call. A snapshot captured before that run
 * never has the entry, which silently leaves the scale-break check inert
 * against a reviewer substitution on the very first loop iteration.
 * `fallbackProgress` covers the read-failure case (`readTaskProgressAdvisoryV1`
 * returns `undefined` on a missing file) with whatever the caller already
 * has in hand.
 */
export async function resolveBaselineReviewHistoryEntryV1(
  folderUri: vscode.Uri,
  targetStage: TaskStage,
  fallbackProgress: TaskProgress
): Promise<ReviewScoreHistoryEntry | undefined> {
  const history =
    (await readTaskProgressAdvisoryV1(folderUri))?.reviewScoreHistory ??
    fallbackProgress.reviewScoreHistory ??
    [];
  return history.filter((entry) => entry.stage === targetStage).at(-1);
}

function getWorkspaceRoot(): vscode.WorkspaceFolder | undefined {
  const active = vscode.window.activeTextEditor;
  return active
    ? vscode.workspace.getWorkspaceFolder(active.document.uri)
    : vscode.workspace.workspaceFolders?.[0];
}

/**
 * Resolve the workspace folder that owns a resolved task.
 *
 * Prefers the task's persisted `ownership.workspaceRoot` over the
 * active-editor-based `getWorkspaceRoot()` heuristic to satisfy the
 * persisted-owner-only rule: operations on a task should always run against
 * the workspace that created the task, not whichever workspace happens to
 * contain the currently active editor.
 *
 * Falls back to `getWorkspaceRoot()` only when no ownership is persisted
 * (e.g. tasks created before the ownership field was introduced).
 */
function resolveOwnerWorkspace(
  progress: TaskProgress
): vscode.WorkspaceFolder | undefined {
  const persistedRoot = progress.ownership?.workspaceRoot;
  if (persistedRoot) {
    const match = vscode.workspace.workspaceFolders?.find(
      (f) => isSameWorkspacePath(f.uri.fsPath, persistedRoot)
    );
    if (match) {
      return match;
    }
  }
  return getWorkspaceRoot();
}

function artifactUri(
  taskFolderUri: vscode.Uri,
  stage: TaskStage
): vscode.Uri | undefined {
  const name = STAGE_ARTIFACT_FILENAMES[stage];
  return name ? vscode.Uri.joinPath(taskFolderUri, name) : undefined;
}

/**
 * The blockers reported by the newest implementation review of EITHER kind,
 * for the standing-blockers notice appended to an Implementation prompt (see
 * `buildStandingBlockersNoticeV1`).
 *
 * The stage is chosen from `reviewScoreHistory` rather than from file mtimes,
 * so this and `decidePostReviewActionV1` always agree about which review is
 * current — a notice naming one stage's blockers while the routing acted on
 * the other's would be worse than no notice at all.
 *
 * Returns undefined when there is no impl review on record, when its artifact
 * is missing, or when it carries no machine-readable `blockers:` block —
 * every one of which means "nothing reliable to tell the round", not "there
 * are no blockers". Advisory throughout: a failure here must never block an
 * Implementation round from running.
 */
async function readStandingImplBlockersV1(
  taskFolderUri: vscode.Uri
): Promise<{ stage: TaskStage; blockers: readonly ReviewBlocker[] } | undefined> {
  try {
    const history =
      (await readTaskProgressAdvisoryV1(taskFolderUri))?.reviewScoreHistory ?? [];
    const latest = IMPL_REVIEW_STAGES_V1.map((stage) =>
      history.filter((entry) => entry.stage === stage).at(-1)
    )
      .filter((entry): entry is ReviewScoreHistoryEntry => entry !== undefined)
      .reduce<ReviewScoreHistoryEntry | undefined>(
        (best, entry) => (best === undefined || entry.at >= best.at ? entry : best),
        undefined
      );
    if (!latest) {
      return undefined;
    }
    const uri = artifactUri(taskFolderUri, latest.stage);
    const content = uri ? await readTextIfExists(uri) : undefined;
    if (content === undefined) {
      return undefined;
    }
    const evidence = parseReviewBlockersDetailed(content);
    return evidence.blockers.length > 0
      ? { stage: latest.stage, blockers: evidence.blockers }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The stable identities (with `id`, when assigned) of the newest review's
 * blockers for ONE specific stage — the blocker ids an Apply Review round is
 * actually being handed, for the run-log record (Part 2 step 5's still-open
 * requirement: "list the blocker ids handed to it"). Unlike
 * `readStandingImplBlockersV1`, this does not search across every impl-review
 * stage for the newest entry — the caller already knows which review this
 * round is applying, so it asks for that stage precisely. Best-effort: a
 * failure to read history must never block or alter the round itself, only
 * leave the run log's blocker list empty.
 */
async function blockerIdentitiesHandedToApplyReviewV1(
  taskFolderUri: vscode.Uri,
  stage: TaskStage
): Promise<ReviewBlockerIdentity[]> {
  try {
    const history = (await readTaskProgressAdvisoryV1(taskFolderUri))?.reviewScoreHistory ?? [];
    const latest = history.filter((entry) => entry.stage === stage).at(-1);
    return latest?.blockers ?? [];
  } catch {
    return [];
  }
}

/**
 * Check if the workspace is inside a git repository.
 * Returns true when git is available and the path is inside a repo.
 */
export async function isGitWorkspace(cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    cp.execFile(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd, windowsHide: true },
      (err) => resolve(!err)
    );
  });
}

/**
 * Return changed paths that do not belong to the task currently being run.
 * Task metadata and files recorded by earlier implementation runs are related
 * work, so they must not trigger the pre-run warning.
 */
export async function getUnrelatedWorkspaceChanges(
  cwd: string,
  taskFolderUri: vscode.Uri
): Promise<string[]> {
  const progress = await readTaskProgressAdvisoryV1(taskFolderUri);
  const taskRelative = path.relative(cwd, taskFolderUri.fsPath).replace(/\\/g, "/");
  const relatedPaths = new Set(
    (progress?.implReviewFiles ?? []).map((file) => file.replace(/\\/g, "/"))
  );
  return new Promise((resolve) => {
    cp.execFile(
      "git",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { cwd, windowsHide: true },
      (err, stdout) => {
        if (err) { resolve([]); return; }

        const records = stdout.split("\0");
        const changedPaths: string[] = [];
        for (let index = 0; index < records.length; index++) {
          const record = records[index]!;
          if (record.length < 4) continue;
          const status = record.slice(0, 2);
          changedPaths.push(record.slice(3).replace(/\\/g, "/"));
          if ((status.includes("R") || status.includes("C")) && records[index + 1]) {
            changedPaths.push(records[++index]!.replace(/\\/g, "/"));
          }
        }
        resolve(changedPaths.filter((file) =>
          file !== taskRelative &&
          !file.startsWith(`${taskRelative}/`) &&
          !relatedPaths.has(file)
        ));
      }
    );
  });
}

/**
 * Safe stage-advance helper that uses `patchTaskProgress` to avoid
 * overwriting unrelated fields.
 */
async function setStage(
  folderUri: vscode.Uri,
  newStage: TaskStage
): Promise<void> {
  await patchTaskProgressStrictV1(folderUri, (current) => {
    if (current.currentStage === newStage) {
      return current;
    }
    return { ...current, currentStage: newStage };
  });
}

// REVIEW_TARGETS now lives in utils/reviewReadiness.ts (imported above)
// beside the freshness primitives it scopes, so taskTreeProvider.ts can
// translate a taskOperations stage the same way without a views -> commands
// import.

/**
 * THE active-run signal for review status display (Part 2, provider/review/
 * rename/refresh plan): true when a "review"-kind `taskOperations` entry is
 * genuinely live for `targetReviewStage` right now.
 *
 * Deliberately excludes the "fast-forward"-kind root registration
 * (runFastForwardReviewWithAI's own runTrackedOperation call) — that entry's
 * `stage` is whatever pre-review/review stage the task sat at when Fast
 * Forward was invoked, and by itself proves nothing about whether an actual
 * review dispatch is in flight. Fast Forward's iterative apply/re-review
 * cycles each register their OWN nested "review"-kind child operation
 * (applyReviewWithAI/applyReviewEditWithAI's `runApply`), which this DOES
 * see. The one narrow gap is Fast Forward's very first review dispatch when
 * no usable review exists yet at all (it runs directly under the
 * "fast-forward" root, uninstrumented) — accepted per plan (Changes from
 * previous plan, "reviewActions.ts:3805-3807 registration is kind
 * fast-forward, not review, and is not the review signal").
 *
 * The stale-vs-active precedence this backs: a review marked stale (the
 * `# Review Stale` placeholder, or a persisted commit-drift banner) with an
 * active translated run here shows "Review in progress"; with no active run
 * it still shows stale. The translated active-run signal always takes
 * precedence over the stale marker for display purposes.
 */
export function isReviewActivelyRerunningV1(
  taskFolderPath: string,
  targetReviewStage: TaskStage
): boolean {
  return hasActiveOperationTargetingStage(
    taskFolderPath,
    "review",
    targetReviewStage,
    (stage) => REVIEW_TARGETS[stage]
  );
}

const REVIEW_PROMPTS: Partial<Record<TaskStage, string>> = {
  "plan-high-review": "review-plan-high.md",
  "plan-low-review": "review-plan-low.md",
  "impl-high-review": "review-impl-high.md",
  "impl-low-review": "review-impl-low.md",
  "publish": "review-publish.md",
};

const REVIEW_REREVIEW_PROMPTS: Partial<Record<TaskStage, string>> = {
  "plan-high-review": "review-plan-high-rereview.md",
  "plan-low-review": "review-plan-low-rereview.md",
  "impl-high-review": "review-impl-high-rereview.md",
  "impl-low-review": "review-impl-low-rereview.md",
  "publish": "review-publish-rereview.md",
};

// REVIEWED_COMMIT_STAGES (2i) now lives in utils/reviewReadiness.ts beside
// the freshness primitives it scopes, and is imported above.

/** The reconciliation-instruction paragraph each re-review prompt used to
 * hardcode as its opening paragraph — now the DEFAULT `{{reconciliationInstruction}}`
 * value, used whenever the previous review's recorded commit is unknown or
 * still close enough to HEAD to reconcile against directly (2i). */
const DEFAULT_RECONCILIATION_INSTRUCTIONS: Partial<Record<TaskStage, string>> = {
  "impl-low-review":
    "Your first responsibility is to reconcile every blocker from the previous low-level implementation review. Do not silently replace the previous blocker set with a fresh code review. If the previous review used inconsistent headings, treat any issue it described as preventing completion or leaving a required plan item unmet as a previous blocker.",
  "impl-high-review":
    "Your first responsibility is to reconcile every blocker from the previous high-level implementation review. Do not silently replace the previous blocker set with a fresh architectural review. If the previous review used inconsistent headings, treat any issue it described as preventing readiness, leaving required acceptance criteria unmet, or blocking completion as a previous blocker.",
  publish:
    "Reconcile every previous blocker before considering new concerns. If the previous review used inconsistent headings, treat any issue it described as preventing shipping or publish readiness as a previous blocker. Keep newly discovered shipping blockers separate. A blocker must be something that should prevent shipping: a concrete regression, secret or credential, leftover debug/TODO code that affects delivery, incomplete error handling introduced by the change, missing required test evidence, a silently dropped required plan item, or insufficient evidence to establish publish readiness.",
};

/**
 * Decide the `{{reconciliationInstruction}}` text for a re-review (2i): the
 * standard "reconcile against the previous review" instruction, unless the
 * previous review's recorded commit (parseReviewedCommitSha) is far enough
 * behind HEAD that reconciling line-by-line no longer makes sense — in which
 * case swap in an instruction to derive current state from the workspace and
 * treat the previous review as history only. Falls back to the standard
 * instruction whenever staleness cannot be determined (no marker in the
 * previous review, not a git repo, or the recorded commit can't be resolved —
 * e.g. it was rewritten away by a rebase): the conservative default is to
 * reconcile, exactly as every re-review did before this existed.
 *
 * @internal exported for testing
 */
export async function selectReconciliationInstruction(
  targetStage: TaskStage,
  previousReview: string,
  workspaceRootFsPath: string
): Promise<string> {
  const fallback = DEFAULT_RECONCILIATION_INSTRUCTIONS[targetStage] ?? "";
  const previousSha = parseReviewedCommitSha(previousReview);
  if (!previousSha) {
    return fallback;
  }
  const commitsSince = await countCommitsSinceSha(workspaceRootFsPath, previousSha);
  if (commitsSince === undefined || commitsSince < STALE_REVIEW_RECONCILIATION_COMMIT_THRESHOLD) {
    return fallback;
  }
  return (
    `The previous review below was written against a commit ${commitsSince} commits behind the current HEAD. ` +
    "Do not reconcile against it blocker-by-blocker as if it reflects the current state — derive the current " +
    "state from the context pack and the workspace directly, and treat the previous review only as history: " +
    "useful context on what earlier rounds found, not a baseline whose blockers must each be individually " +
    "addressed as resolved/partially resolved/unresolved."
  );
}

/**
 * Qualifier appended to every "N of M plan steps" count surfaced to the user
 * or a reviewer while the task's `checklistProgressUnreliable` latch is set
 * (finding 3): a round landed changes the plan's checklist could not record,
 * so any step count derived from — or reported alongside — that checklist
 * understates what is done. Presenting the number unqualified is what let
 * rounds keep routing on a count the workflow had already marked as
 * untrustworthy. Wording aligned with the task tree tooltip
 * (taskTreeProvider.ts); only `reconcilePlanChecklist` clears the latch.
 *
 * Assumes the checklist itself still has unticked items — true whenever a
 * round under-recorded its own progress. When it does NOT (the checklist
 * reads N/N but the latch is still set — the exact jester-task-3 75/75
 * shape items 6c/11 fixed for the reconcile decision's own text), telling the
 * reader to tick "missed items" that do not exist is the same contradiction;
 * {@link UNVERIFIED_CHECKLIST_COUNT_QUALIFIER_NOTHING_OUTSTANDING_V1} is used
 * instead. Callers pick between the two via
 * {@link resolveChecklistCountQualifierV1}.
 *
 * @internal exported for testing
 */
export const UNVERIFIED_CHECKLIST_COUNT_QUALIFIER_V1 =
  " — count unverified: the plan checklist is not a complete record and needs reconciliation " +
  "(run Ensemble: Mark Plan Checklist Reconciled once the missed items are ticked)";

/**
 * Sibling to {@link UNVERIFIED_CHECKLIST_COUNT_QUALIFIER_V1} for the case
 * where the checklist has nothing unticked but the latch is still set
 * (finding 6c/11): reconciling is still required to clear the gate, but there
 * is nothing to go tick first.
 *
 * @internal exported for testing
 */
export const UNVERIFIED_CHECKLIST_COUNT_QUALIFIER_NOTHING_OUTSTANDING_V1 =
  " — count unverified: the checklist itself shows nothing outstanding, but the latch still requires " +
  "confirmation (run Ensemble: Mark Plan Checklist Reconciled to confirm and restore the gate)";

/**
 * Reads the plan of record directly (bypassing the latch-gated readers, which
 * would return `undefined` for exactly the case this needs to distinguish)
 * to decide which of the two qualifier constants above applies.
 *
 * @internal exported for testing
 */
export async function resolveChecklistCountQualifierV1(
  folderUri: vscode.Uri,
  isUnreliable: boolean
): Promise<string> {
  if (!isUnreliable) {
    return "";
  }
  const plan = await readPlanOfRecordV1(folderUri);
  return (plan.counts?.remaining ?? 0) > 0
    ? UNVERIFIED_CHECKLIST_COUNT_QUALIFIER_V1
    : UNVERIFIED_CHECKLIST_COUNT_QUALIFIER_NOTHING_OUTSTANDING_V1;
}

/**
 * The "high score but plan incomplete" notification, factored out so the
 * unverified-count qualifier's presence is testable without driving the whole
 * review flow.
 *
 * @internal exported for testing
 */
export function buildStayingOnStageNoticeV1(
  score: number | null,
  progress: { complete: number; total: number },
  excludedSuffix: string,
  countUnverified: boolean,
  hasOutstandingChecklistItems: boolean = true
): string {
  // The trailing sentence must agree with the qualifier just appended: when
  // the checklist has nothing outstanding (only the latch is unresolved),
  // "build the rest" contradicts the qualifier's own "shows nothing
  // outstanding" — the exact assembled-output contradiction the review
  // flagged (finding 9/11). Name the actual clearing action instead.
  const stayingClause =
    countUnverified && !hasOutstandingChecklistItems
      ? " Staying on this stage until that is reconciled."
      : " Staying on this stage to build the rest.";
  return (
    `Review scored ${score}/10 with no blocking issues, but ${progress.complete} of ${progress.total} ` +
    `plan steps are implemented${excludedSuffix}` +
    (countUnverified
      ? hasOutstandingChecklistItems
        ? UNVERIFIED_CHECKLIST_COUNT_QUALIFIER_V1
        : UNVERIFIED_CHECKLIST_COUNT_QUALIFIER_NOTHING_OUTSTANDING_V1
      : "") +
    "." +
    stayingClause
  );
}

/**
 * Bounded, human-readable bullet list of a checklist's outstanding items —
 * shared by every surface that used to just say "tick the missed items in
 * plan-final.md" with nothing named (the latch-trip note, the
 * reconciliation-needed note, and the no-progress breaker escalation).
 * Naming the items is what turns that instruction into something an operator
 * can act on without opening a plan they may not have on screen (workflow 3
 * continuation plan, Part 5). Returns "" when there is nothing outstanding to
 * name (no checklist, or nothing unchecked).
 *
 * @internal exported for testing
 */
export function describeOutstandingChecklistItemsV1(
  planOfRecord: string | undefined,
  limit: number = 10
): string {
  if (planOfRecord === undefined) {
    return "";
  }
  const unchecked = listUncheckedChecklistItemTextsV1(planOfRecord, limit);
  if (unchecked.total === 0) {
    return "";
  }
  const glyph = formatChecklistItemGlyphV1({ checked: false, excluded: false });
  const bullets = unchecked.items.map((item) => `- ${glyph} ${item}`).join("\n");
  const more =
    unchecked.total > unchecked.items.length
      ? `\n…and ${unchecked.total - unchecked.items.length} more.`
      : "";
  return `\n${bullets}${more}`;
}

/**
 * wf10 item 11: the three `NotificationRouter.showWarning` fallbacks below
 * (only reached when `postReconcilePlanChecklistDecisionV1` cannot post —
 * no active extension context) all used to say "Tick the missed items in
 * plan-final.md, then run **Ensemble: Mark Plan Checklist Reconciled**"
 * unconditionally. `describeOutstandingChecklistItemsV1` returns `""` when
 * nothing is unticked (e.g. the latch was set by an unrecorded round on an
 * otherwise-complete checklist — jester task 3, 75/75 with the latch still
 * set), so that instruction sent the reader looking for missed items that do
 * not exist — the same contradiction item 6c fixed for the reconcile
 * decision's own "Not yet" option text, here reproduced in its notification
 * fallback. Branches on the SAME `outstandingList` string each call site
 * already computed, so it can never disagree with what that call site just
 * rendered.
 */
function checklistReconcileGuidanceSentenceV1(outstandingList: string): string {
  return outstandingList === ""
    ? "Nothing is unticked to tick — run **Ensemble: Mark Plan Checklist Reconciled** to confirm and " +
        "restore the gate."
    : "Tick the missed items in plan-final.md, then run **Ensemble: Mark Plan Checklist Reconciled** to " +
        "confirm and restore the gate.";
}

/**
 * The exact "is a synthetic edit round exempt from `checklistProgressUnreliable`"
 * decision (plan Part 4, acceptance criterion 5) — pulled out of the
 * post-round `patchTaskProgressStrictV1` callback so it is directly unit
 * testable without constructing a full round.
 *
 * 2026-08-21 NINTH review round (the persisting Part 4 architectural blocker,
 * after the EIGHTH round closed it for tier 2 alone): this function used to
 * read `runAutomaticChecklistReconciliationV1`'s outcome and exempt a
 * synthetic round when the pass either ticked review-verified items with no
 * unresolved overlap ("merged") or affirmatively found nothing to cover
 * ("nothingCovered"). The review held that BOTH exemptions were the same
 * mistake tier 2's auto-tick was: "ticking a box cannot be distinguished
 * from ticking the LAST box, so no automatic check can tell a partial edit
 * from a finished reconciliation" (the module doc comment on
 * `reconcilePlanChecklist`, written for the human-facing decision) applies
 * exactly as much to this function's own automatic exemption — an
 * affirmative "nothing covered" is still this PASS's own conclusion, not a
 * human's. So a synthetic round that may have changed files now ALWAYS
 * latches, full stop; the automatic reconciliation pass no longer has any
 * power to clear it. The pass's output still matters — it drives the round
 * log and the evidence a human sees in the `reconcilePlanChecklist` decision
 * (`gatherReconcileEvidenceV1`) — but it no longer factors into this
 * function's return value at all, and the parameter is removed rather than
 * kept-but-ignored.
 *
 * @internal exported for testing
 */
export function computeSyntheticRoundChecklistLatchV1(input: {
  readonly planChecklistPresent: boolean;
  readonly roundMayHaveChangedFiles: boolean;
  readonly summaryIsSynthetic: boolean;
  readonly summaryIssuePresent: boolean;
  readonly checklistClaimedButUnmerged: boolean;
}): boolean {
  return (
    input.planChecklistPresent &&
    ((input.roundMayHaveChangedFiles && (input.summaryIsSynthetic || input.summaryIssuePresent)) ||
      input.checklistClaimedButUnmerged)
  );
}

/**
 * Renders a round's `## Checklist merge diagnostics` run-log section (plan
 * Part 4, item 2) — pulled out of the round-completion write path so the
 * three merge outcomes it must visibly distinguish (no echo at all
 * (`"no-report"`), an echo that matched no plan item text (`"no-match"`,
 * with the unmatched sample named), and a successful merge — plus the
 * automatic-reconciliation outcome for synthetic rounds) are directly unit
 * testable without constructing a full round.
 *
 * @internal exported for testing
 */
export function buildChecklistMergeDiagnosticsNoteV1(input: {
  readonly mergeKind: "no-report" | "unchanged" | "no-match" | "merged";
  readonly unmatchedSample?: readonly string[];
  readonly latchSet: boolean;
  readonly automaticChecklistReconciliation?: AutomaticChecklistReconciliationOutcomeV1;
}): string {
  const unmatchedNote =
    input.mergeKind === "no-match" && input.unmatchedSample && input.unmatchedSample.length > 0
      ? ` Unmatched claim text: ${input.unmatchedSample.map((text) => `"${text}"`).join(", ")}.`
      : "";
  const reconciliation = input.automaticChecklistReconciliation;
  const describePending = (items: readonly { item: string; evidence: string }[]): string =>
    `${items.length} item(s) have applied-operation evidence pending human attestation (lexical corroboration ` +
    `only — not ticked automatically):\n${items.map((c) => `- ${c.item}`).join("\n")}`;
  const describeReviewVerified = (items: readonly string[]): string =>
    `${items.length} item(s) have review-verified evidence pending explicit human selection (not ticked ` +
    `automatically — see Ensemble: Apply Reviewer-Verified Ticks):\n${items.map((item) => `- ${item}`).join("\n")}`;
  const autoReconcileNote =
    reconciliation === undefined
      ? ""
      : reconciliation.kind === "candidatesFound"
        ? ` Automatic checklist reconciliation: \`candidatesFound\` — ` +
          (reconciliation.reviewVerifiedItems.length > 0
            ? describeReviewVerified(reconciliation.reviewVerifiedItems)
            : "no review-verified candidates.") +
          (reconciliation.pendingOperationEvidenceItems.length > 0
            ? `\n${describePending(reconciliation.pendingOperationEvidenceItems)}`
            : "") +
          (reconciliation.unresolvedOverlap.length > 0
            ? `\nUnresolved overlap — ${reconciliation.unresolvedOverlap.length} other unticked item(s) cannot be ruled unrelated to this round's changes (referencing a file this round changed, or naming no file at all), covered by neither tier:\n${reconciliation.unresolvedOverlap.map((item) => `- ${item}`).join("\n")}`
            : "")
        : reconciliation.kind === "nothingCovered"
          ? " Automatic checklist reconciliation: `nothingCovered` — no implementation review on file names any currently-unticked item as verified complete, and this round's own applied operations do not cover one either."
          : ` Automatic checklist reconciliation: \`unavailable\` — ${reconciliation.reason}`;
  return (
    "\n\n## Checklist merge diagnostics\n\n" +
    `Merge kind: \`${input.mergeKind}\`.${unmatchedNote} Latch (\`checklistProgressUnreliable\`) after this round: ` +
    `${input.latchSet ? "set" : "not set"}.${autoReconcileNote}`
  );
}

/**
 * Build the `{{siblingReviewDisagreement}}` block for the Publish review
 * prompt (2k): when the impl-high and impl-low reviews of the exact commit
 * Publish is about to assess disagree on whether the plan is actually
 * complete, render that contradiction as an explicit block the reviewer must
 * address — rather than letting it sit silently in two separate artifacts
 * that publish would otherwise average into one verdict.
 *
 * Reads the two sibling review artifacts directly (they are prior stages,
 * already written by the time Publish runs) rather than depending on the
 * caller to have them on hand. Returns "" when either artifact is missing or
 * {@link detectSiblingReviewDisagreement} finds no mechanical contradiction —
 * the publish template renders nothing in that case.
 *
 * @internal exported for testing
 */
export async function buildSiblingReviewDisagreementVariable(
  folderUri: vscode.Uri,
  currentReviewedCommitSha: string | undefined
): Promise<string> {
  const implHighUri = artifactUri(folderUri, "impl-high-review");
  const implLowUri = artifactUri(folderUri, "impl-low-review");
  const [implHighReview, implLowReview] = await Promise.all([
    implHighUri ? readNonEmptyText(implHighUri) : Promise.resolve(undefined),
    implLowUri ? readNonEmptyText(implLowUri) : Promise.resolve(undefined),
  ]);
  const disagreement = detectSiblingReviewDisagreement(
    implHighReview,
    implLowReview,
    currentReviewedCommitSha
  );
  if (!disagreement) {
    return "";
  }
  const { implHighProgress, implLowCompletionBlockers } = disagreement;
  // Read only once a disagreement is actually going to render: while the
  // checklist latch is set, the high review's own "N of M ordered steps"
  // claim is derived from a record known to be incomplete, and must not be
  // handed to the Publish reviewer as an authoritative count.
  const advisory = await readTaskProgressAdvisoryV1(folderUri);
  const countQualifier = await resolveChecklistCountQualifierV1(
    folderUri,
    advisory?.checklistProgressUnreliable === true
  );
  const blockerLines = implLowCompletionBlockers
    .map((b) => `- ${b.description}`)
    .join("\n");
  return (
    "## Sibling Review Disagreement (mechanical check)\n\n" +
    `The high-level implementation review reported the plan fully complete ` +
    `(${implHighProgress.complete} of ${implHighProgress.total} ordered steps${countQualifier}) for this exact commit, ` +
    "but the low-level implementation review reported the following completion blocker(s) for the SAME commit:\n\n" +
    `${blockerLines}\n\n` +
    "These two reviews assessed the identical commit and disagree on a factual, checkable claim — whether the " +
    "required plan items actually exist. Do not silently average this into your verdict: derive the current " +
    "state from the context pack and the workspace directly, state explicitly which review's claim is correct, " +
    "and reflect that in your shipping blockers or verdict."
  );
}

export function selectReviewPromptTemplate(
  targetStage: TaskStage,
  currentStage: TaskStage,
  previousReview: string | undefined
): string | undefined {
  if (
    currentStage === targetStage &&
    previousReview !== undefined &&
    !isStaleReviewArtifact(previousReview)
  ) {
    return REVIEW_REREVIEW_PROMPTS[targetStage] ?? REVIEW_PROMPTS[targetStage];
  }
  return REVIEW_PROMPTS[targetStage];
}

async function readPreviousReviewForRereview(
  reviewUri: vscode.Uri
): Promise<string | undefined> {
  const currentReview = await readNonEmptyText(reviewUri);
  if (currentReview !== undefined && !isStaleReviewArtifact(currentReview)) {
    return currentReview;
  }

  const backedUpReview = await readNonEmptyText(previousVersionUri(reviewUri));
  return backedUpReview !== undefined && !isStaleReviewArtifact(backedUpReview)
    ? backedUpReview
    : undefined;
}

// Fast Forward's own internal per-attempt calls into applyReviewWithAI reuse
// the lock it already holds (see ApplyReviewOptions.skipTaskLock) rather than
// re-acquiring — nested acquisition from the same logical operation would
// otherwise deadlock.

/**
 * Run the project's real lint/type-check/test commands (via
 * collectCompletionLintPreview) and render the result as the
 * `{{verifiedChecks}}` block injected into implementation/publish review
 * prompts — see completionLint.ts's buildVerifiedChecksSection for why this
 * exists: a reviewer with no way to confirm "tests pass" otherwise has to
 * either trust the implementer's prose or try to run the suite itself, and
 * if its own sandbox can't run anything it has no way to ever mark that
 * criterion satisfied. Side-effect-free with ONE narrow, explicit exception:
 * when `targetStage` is literally `"publish"`, the computed result is also
 * persisted into task-progress.json's `lintPayload` (marked
 * `source: "review"`) via `persistPublishReviewLintPayload` below — see that
 * function's doc comment for why. It never touches publish-review.md (that
 * artifact is still only written at an actual Publish attempt via
 * runCompletionLint, or by the review's own AI-response handling) and never
 * throws: a stale/unresolvable Publish scope or any other failure degrades
 * to an explicit "could not run" note rather than blocking the review that
 * requested it.
 *
 * `token`, when supplied, is the enclosing tracked operation's cancellation
 * token — linked through to every spawned check process so cancelling the
 * review/Fast Forward from the UI actually stops a hung lint/test run
 * instead of leaving it running with no way to recover short of reloading
 * the window. Each check is additionally capped at
 * ensemble.completionCheckTimeoutMs regardless of cancellation.
 *
 * `includePlanItemVerification` (1c) additionally computes and returns the
 * `{{planItemVerification}}` block for the Publish review prompt — the same
 * Plan Item Verification content upsertCompletionChecksInPublishReview later
 * writes into publish-review.md's Completion Checks section, but delivered
 * as an INPUT to the reviewer before it writes a verdict, not appended to
 * the artifact afterward. Before this, a failed plan item only ever reached
 * publish-review.md after the AI verdict already existed, so nothing
 * reconciled a ❌ item against a simultaneous "no blockers" verdict. Reuses
 * this same collectCompletionLintPreview call (rather than a second one) so
 * requesting it doesn't double the lint/type/test/build commands run for
 * every Publish review round.
 *
 * Also returns `mechanicalBlockers` (step 4 of the fail-closed-parsing fix):
 * blockers synthesized directly from `result.failedChecks` via
 * `synthesizeMechanicalBlockers`, bypassing the reviewer's prose entirely for
 * a fact the extension host already confirmed firsthand. Empty when checks
 * could not be run at all — an unrunnable check is missing evidence, not a
 * known failure, so nothing can be synthesized from it.
 */
/**
 * Publish review freshness gate (plan PART 2, step 7): refuse to build a
 * Publish review prompt unless `publish-review.md` (the single unified
 * Publish-stage artifact — plan item 17, step 20; see the module doc comment
 * on `publishChecksFreshness.ts`'s `publishChecksPath` for why this used to
 * be a separate `publish-checks.md`) carries a valid stamp for the CURRENT
 * verification scope and commit. Every entry point that can
 * start a Publish review — direct review, Fast Forward, automatic review,
 * and resumed review — must call this before it reads/derives any other
 * review content, so a stale or absent Publish Checks run can never be
 * consumed as though it were current. A refusal here is an explicit warning
 * naming the remedy (run Publish Checks), never a silent downgrade to a
 * model-visible note — the review is not started at all.
 *
 * Always passes (`ok: true`, no `guard`) for any stage other than
 * `"publish"`. On a `"publish"` acceptance, also returns a
 * {@link PublishReviewFreshnessGuardV1} captured from THIS SAME accepted
 * stamp, for the caller to carry through the attempt and re-check
 * immediately before promotion (`reviewRowV1.ts`'s
 * `revalidatePublishFreshnessOrThrowV1`) — the entry gate alone only proves
 * freshness at dispatch time, not at the write that follows the (possibly
 * minutes-long) provider call.
 */
async function requirePublishChecksFreshnessOrWarnV1(
  folderUri: vscode.Uri,
  targetStage: TaskStage
): Promise<{ ok: true; guard?: PublishReviewFreshnessGuardV1 } | { ok: false }> {
  if (targetStage !== "publish") {
    return { ok: true };
  }
  // Step 20(a): every Publish review entry point runs through this gate
  // first, so this is the choke point that makes "publish-review.md has not
  // been created yet" unreachable for a task that has actually reached
  // Publish — a no-op once the file exists, whatever wrote it.
  await ensurePublishReviewArtifactExistsV1(folderUri);
  // Step 20(c), both-files case: a task whose publish-review.md already
  // exists (e.g. an older build's stub) but never had legacy
  // publish-checks.md sections imported into it must get that import HERE,
  // before the freshness check below reads publish-review.md's stamp —
  // otherwise a legacy-only stamp can never be reached, because the review
  // write's own lazy import (reviewRowV1.ts's
  // reinjectPublishGroundTruthSectionsV1) only runs AFTER this gate accepts.
  // A no-op once imported, or when there is nothing legacy to import.
  await ensurePublishReviewLegacySectionsImportedV1(folderUri);
  const progress = await readTaskProgressAdvisoryV1(folderUri);
  const { folder: scopeFolder } = resolvePublishScopeFolder(folderUri, progress);
  const currentCommitSha = await resolveHeadCommitSha(scopeFolder);
  const check = await checkPublishChecksFreshnessV1(folderUri, scopeFolder, currentCommitSha);
  if (check.status === "valid") {
    return {
      ok: true,
      guard: {
        taskFolderPath: folderUri.fsPath,
        scopeFolderPath: scopeFolder,
        runId: check.stamp.runId,
        verifiedCommitSha: check.stamp.verifiedCommitSha,
      },
    };
  }
  NotificationRouter.showWarning(
    describePublishChecksFreshnessFailureV1(check),
    undefined,
    undefined,
    undefined,
    {
      command: "vs-code-ai-helper.runPublishChecks",
      title: "Run Publish Checks",
      args: [{ taskFolderPath: folderUri.fsPath }],
    }
  );
  return { ok: false };
}

async function buildVerifiedChecksVariable(
  folderUri: vscode.Uri,
  relevantFiles: readonly string[] | undefined,
  token: vscode.CancellationToken | undefined,
  includePlanItemVerification = false,
  targetStage?: TaskStage,
  // Part 6 item 6: threaded through so buildVerifiedChecksSection can state
  // both identities (the commit this review names vs. the working tree these
  // checks actually ran against) instead of leaving the two unconnected.
  // Absent at the resume-interaction call site, which has no reviewedCommitSha
  // in scope — the disclaimer is simply omitted there, same as before.
  reviewedCommitSha?: string
): Promise<{ verifiedChecks: string; planItemVerification?: string; mechanicalBlockers: ReviewBlocker[] }> {
  try {
    const result = await collectCompletionLintPreview(folderUri, relevantFiles, {
      allowScopePrompt: false,
      includeAiPlanVerification: includePlanItemVerification,
      token,
    });
    if (targetStage === "publish") {
      // Narrow, explicit carve-out from this function's normal
      // side-effect-free contract (see the file-header doc comment above) —
      // ONLY for a Publish-stage review, never for implementation reviews or
      // any scheduling-only caller (e.g. checkPublishPreflight, which never
      // reaches this branch). A Publish-stage review already runs the exact
      // checks a real Publish attempt would; today that result was computed
      // and then discarded, leaving "Apply lint/test fixes"
      // (runLintingFixes.ts) unable to find a report even right after a
      // Publish review just ran and passed those same checks. Best-effort:
      // persistence failing here must never fail or block the review itself.
      await persistPublishReviewLintPayload(folderUri, result);
    }
    return {
      verifiedChecks: buildVerifiedChecksSection(result, reviewedCommitSha),
      // Plan Item Verification is retired (completionLint.ts's
      // collectAiVerifiedPlanItems doc comment) and result.planItems is
      // therefore always undefined now — calling
      // buildPlanItemVerificationSection(undefined) would render "No plan
      // checklist items were found in plan-final.md (nothing to verify)",
      // which is false whenever the plan actually has items; it is simply
      // that nothing verifies them anymore. Omit the section entirely
      // instead of rendering a misleading placeholder.
      planItemVerification: undefined,
      mechanicalBlockers: synthesizeMechanicalBlockers(result),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Consistent with review-scoring-rubric.md's "## Verified Checks"
    // section ("raise a blocker ... when it reports checks could not be
    // run at all"): the extension host being UNABLE to run checks at all
    // (a stale/unresolvable Publish scope, a scope-resolution failure) is
    // itself missing evidence — a legitimate review-confidence concern, not
    // the "you personally can't reproduce a test run" case the rubric tells
    // reviewers to ignore. Do not tell reviewers to disregard this.
    const verifiedChecks =
      "## Verified Checks (ground truth)\n\n" +
      `Verified checks could not be run for this review: ${message}\n\n` +
      "This means no ground-truth evidence is available for this round — treat the absence of verified checks itself as a review-confidence concern, not as neutral.";
    return {
      verifiedChecks,
      // Plan Item Verification is retired — see the comment above.
      planItemVerification: undefined,
      mechanicalBlockers: [],
    };
  }
}

/**
 * Persist a Publish-stage review's already-computed
 * `collectCompletionLintPreview` result into task-progress.json's
 * `lintPayload`, the same shape/field-set `runCompletionLint`
 * (completionLint.ts) writes for a real Publish attempt — reusing that
 * write path is what lets `runLintingFixes.ts` find the report. Marked
 * `source: "review"` (never overwrites a good-faith reader's assumptions
 * about `source: "publish"` results) because this ran with
 * `allowScopePrompt: false`, so it may reflect a stale Publish scope
 * compared to what an actual publish attempt would resolve — see
 * `LintPayload.source` in `types/taskProgress.ts`.
 *
 * Deliberately does NOT touch publish-review.md (unlike `runCompletionLint`,
 * which also calls `upsertCompletionChecksReportV1`): that artifact is
 * written by the review's own AI-response handling, and this function only
 * ever runs as a side effect of building that review's PROMPT, before any
 * response exists.
 *
 * Best-effort and never throws — called from inside
 * `buildVerifiedChecksVariable`, which must keep building the review prompt
 * even if this persistence fails (e.g. a concurrent CAS loss).
 *
 * @internal exported for testing
 */
export async function persistPublishReviewLintPayload(
  folderUri: vscode.Uri,
  result: CompletionLintResult
): Promise<void> {
  try {
    await patchTaskProgressStrictV1(folderUri, (current) =>
      updateLintPayload(current, {
        runAt: result.runAt,
        passed: result.passed,
        summary: result.summary,
        issueCount: result.issueCount,
        failedChecks: result.failedChecks,
        source: "review",
      })
    );
  } catch {
    // Best-effort — see doc comment above.
  }
}

/**
 * In-memory last-computed mechanical-blocker set per task folder + stage.
 * `buildVerifiedChecksVariable` runs once per review round (inside
 * `runReviewForFolder`/Fast Forward's `applyReviewWithAI`/
 * `applyReviewEditWithAI` chain) and its result feeds the prompt, but Fast
 * Forward's `review()` callback (`improveReviewScoreForConcreteArg` below)
 * only ever reads the resulting review ARTIFACT back off disk — it has no
 * other path to the `CompletionLintResult` that round's prompt was built
 * from. This cache closes that gap without threading a new parameter through
 * the whole apply/review call chain. In-memory, per-session, scoped to this
 * run of the extension host, never persisted, safe to be
 * stale-and-overwritten on the next round — unlike the durable
 * `zeroChangeImplRounds` counter (see `clearZeroChangeImplRoundCounter`),
 * which must survive a reload for the no-progress breaker to work.
 */
const mechanicalBlockersByTaskStage = new Map<string, ReviewBlocker[]>();

function mechanicalBlockersCacheKey(folderUri: vscode.Uri, targetStage: TaskStage): string {
  return `${normalizePath(folderUri.fsPath)}::${targetStage}`;
}

function setMechanicalBlockersForStage(
  folderUri: vscode.Uri,
  targetStage: TaskStage,
  blockers: ReviewBlocker[]
): void {
  mechanicalBlockersByTaskStage.set(mechanicalBlockersCacheKey(folderUri, targetStage), blockers);
}

function getMechanicalBlockersForStage(folderUri: vscode.Uri, targetStage: TaskStage): ReviewBlocker[] {
  return mechanicalBlockersByTaskStage.get(mechanicalBlockersCacheKey(folderUri, targetStage)) ?? [];
}

/**
 * The shared "clean round" veto: a mechanically-synthesized task-fixable
 * blocker (an unquarantined failed Verified Check — see
 * `synthesizeMechanicalBlockers`) always overrides the reviewer's own
 * zero-fixable evidence to `false`, regardless of what the reviewer's prose
 * says. Used identically for the pre-loop baseline (the review that already
 * produced `baselineScore`) and every in-loop round in
 * `fastForwardReviewWithAI`, so both share one definition of "zero-fixable"
 * — a failing check quarantined via `isQuarantinedCheckV1` never reaches
 * here (`synthesizeMechanicalBlockers` already filters it out), so a fully
 * quarantined run leaves this veto untouched and defers to the reviewer's
 * own evidence.
 *
 * @internal exported for testing
 */
export function resolveZeroFixableEvidenceV1(
  mechanicalBlockers: readonly ReviewBlocker[],
  reviewContent: string
): boolean {
  const hasMechanicalTaskFixable = mechanicalBlockers.some((b) => b.resolver === "task-fixable");
  return hasMechanicalTaskFixable ? false : hasZeroTaskFixableEvidence(reviewContent);
}

/**
 * Reconcile a plateaued primary review against one second-opinion round.
 * Deliberately never lets the second opinion advance the task on its own —
 * a friendlier fallback model unilaterally clearing work its primary
 * reviewer rejected is exactly the accidental failure mode this whole
 * mechanism replaces (see the task this was built to fix: a quota-triggered
 * fallback reviewer happened to be more lenient and that was the only thing
 * that ever moved the score). Every outcome escalates; the difference is
 * only in how confidently the escalation reason can tell the human what's
 * actually going on.
 *
 * Retired during the Cleanup cohort's disposition of the independent
 * second-opinion mechanism (plan §8, legacyAiActionSafetyGateV0.ts's file
 * header): the mechanism that produced a `{ content, modelId }` second
 * opinion to reconcile no longer runs in production —
 * `handleReviewRoutingOutcome`'s "second-opinion" branch now escalates
 * directly instead of ever calling this. Kept exported and covered directly
 * by reconcileSecondOpinion.test.ts as inert reconciliation logic (the
 * classification rules below are still a useful reference for any future
 * second-opinion mechanism a fresh scope decision might authorize), but it
 * has no live caller.
 *
 * @internal exported for testing
 */
export function reconcileSecondOpinion(
  secondOpinion: { content: string; modelId: string }
): { kind: EscalationKind; reason: string } {
  const second = parseReadiness(secondOpinion.content);
  const secondBlockers = parseReviewBlockers(secondOpinion.content);
  const secondOnlyNonFixable = secondBlockers.length > 0 &&
    secondBlockers.every((b) => b.resolver !== "task-fixable");
  const secondFoundNothingBlocking = secondBlockers.length === 0 && second.score !== null && second.score >= 8;

  if (secondOnlyNonFixable) {
    // The second reviewer independently found the same area of concern but
    // classified it as something no re-implementation can fix — a genuinely
    // useful reclassification signal, even though the primary called it
    // task-fixable.
    // secondOnlyNonFixable guarantees every resolver present is one of
    // environmental/unverifiable/spec-defect (the non-task-fixable members
    // of BlockerResolver) — all three are checked explicitly so an
    // unverifiable-only second opinion is reported as such rather than
    // silently collapsing into "environmental" via a duplicate fallback arm.
    const resolverKinds = new Set(secondBlockers.map((b) => b.resolver));
    const kind: EscalationKind = resolverKinds.has("environmental")
      ? "environmental"
      : resolverKinds.has("spec-defect")
        ? "spec-defect"
        : resolverKinds.has("unverifiable")
          ? "unverifiable"
          : "environmental"; // unreachable given the guarantee above; safe fallback
    return {
      kind,
      reason:
        `A second reviewer (${secondOpinion.modelId}, different from the primary) independently concluded the remaining ` +
        `issue is outside automation's control (scored ${second.label}), despite the primary calling it fixable.`,
    };
  }
  if (secondFoundNothingBlocking) {
    // The second reviewer disagrees outright — it sees nothing wrong.
    return {
      kind: "reviewer-disagreement",
      reason:
        `A second reviewer (${secondOpinion.modelId}, different from the primary) found no blockers and scored this ` +
        `${second.label}, disagreeing with the primary's assessment.`,
    };
  }
  // The second reviewer also reports a real, in-theory-fixable issue —
  // confirmation this is genuinely stuck, not a fluke of one model, but
  // automated iteration still isn't resolving it.
  return {
    kind: "plateau",
    reason:
      `A second reviewer (${secondOpinion.modelId}, different from the primary) independently confirmed a real issue ` +
      `remains (scored ${second.label}) — automated iteration has been unable to resolve it across multiple rounds.`,
  };
}

/**
 * The exit valve this whole mechanism exists for: after a review publishes
 * below the auto-advance threshold, record this round in the durable score
 * history, detect whether the stage has plateaued across rounds (which,
 * unlike Fast Forward's own in-session stall detection, catches the case
 * that actually happened — many separate review invocations across hours,
 * not one exhausted apply/re-review loop), and either let iteration
 * continue, get a deliberate second opinion, or escalate to the human.
 *
 * Does not itself perform stage advancement — the existing score-threshold
 * auto-advance logic in runReviewForFolder still owns that. It DOES,
 * however, report back when it escalated (paused the task this round): the
 * caller must skip its own advance/publish scheduling in that case. Without
 * that, a `meetsThreshold` computed moments earlier could still fire the
 * independent auto-advance block in the same call — advancing (and, via
 * updateTaskProgressStage, silently erasing) an escalation this function
 * just recorded and paused the task for. That contradiction can genuinely
 * occur: `decideReviewRoute` can escalate even when the score meets
 * threshold, if a reported blocker is still task-fixable or a spec-defect —
 * the rubric asks reviewers to keep such scores at 7 or below, but nothing
 * here may assume a reviewer always follows that. Never throws: any failure
 * here is logged as a warning and swallowed rather than risking the review
 * pipeline that already succeeded in publishing (failure returns
 * escalated: false, since nothing was actually paused).
 *
 * @internal exported for testing
 */
export async function handleReviewRoutingOutcome(options: {
  folderUri: vscode.Uri;
  targetStage: TaskStage;
  reviewAttemptId: string;
  content: string;
  score: number | null;
  threshold: number;
  /** Identity of the provider/model that actually produced this review
   * (including any backup-cascade substitution) — recorded on the history
   * entry so cross-reviewer comparisons can be detected. Absent when the
   * caller has no provider attribution to offer. */
  reviewer?: { providerLabel: string; storedModelId: string };
  /** wf10 item 7c / Part 6 step 16: the assembled prompt's length, reported
   * in a degenerate-review rejection's run log alongside the reply's output
   * length. Absent when the caller never assembled a fresh prompt. */
  promptLength?: number;
  /** wf10 item 7c / Part 6 step 16: the resolved provider id this round
   * dispatched to, used for the known-Read-ceiling advisory. */
  providerId?: string;
  /** The coordinator's own identities for the provider call that produced
   * this outcome (`TaskActionOutcomeV1.correlation`), when the caller has
   * them — forwarded to `terminalizeRoundV1` so the round-ledger row opened
   * by `claimReviewAttempt` (keyed on the independently-minted
   * `reviewAttemptId`) also carries the coordinator's `operationId`/
   * `attemptId` once they exist (2026-08-27 review, blocker "review rows
   * never attach the coordinator operation or provider attempt identities"). */
  coordinatorOperationId?: string;
  coordinatorAttemptId?: string;
  /** Every OTHER coordinator `attemptId` this round observed (a primary
   * candidate that failed before a fallback candidate produced the final
   * correlation, an item-14 same-candidate retry, ...) — see
   * `TerminalizeRoundOptionsV1.extraAttemptIds`. */
  coordinatorExtraAttemptIds?: readonly string[];
}): Promise<{ escalated: boolean; degenerateBackupAdvance?: DegenerateReviewBackupAdvanceDecisionV1 }> {
  const {
    folderUri,
    targetStage,
    reviewAttemptId,
    content,
    score,
    threshold,
    reviewer,
    promptLength,
    providerId,
    coordinatorOperationId,
    coordinatorAttemptId,
    coordinatorExtraAttemptIds,
  } = options;
  try {
    const resilience = getResilienceSettings();
    const blockerEvidence = parseReviewBlockersDetailed(content);
    // Merge in blockers synthesized directly from this round's failed
    // Verified Checks (step 4 of the fail-closed-parsing fix) — cached by
    // buildVerifiedChecksVariable moments earlier in this same round, before
    // this review's content was even generated, so a mechanical failure
    // feeds history/routing even if the reviewer's own prose description of
    // it never round-trips through BLOCKER_LINE_RE at all.
    const parsedBlockers = [...blockerEvidence.blockers, ...getMechanicalBlockersForStage(folderUri, targetStage)];
    if (blockerEvidence.malformedLines.length > 0) {
      // A malformed line is UNKNOWN, not clean — never let it look identical
      // to a round that stalled for any other reason. Record what could not
      // be parsed in the run log (the durable record) and tell the user, in
      // the same spirit as the "scored N/10 but M of T steps implemented"
      // notice below. Parsed blockers still feed history/routing as usual —
      // this only blocks the CLEAN-round reading, not the round itself.
      await writeRunLog(
        folderUri,
        "review-guard",
        targetStage,
        `# Unparseable Blocker Lines\n\nStatus: ${parsedBlockers.length} blocker(s) parsed; ` +
          `${blockerEvidence.malformedLines.length} line(s) could not be parsed.\n\n` +
          `## Malformed lines\n\n${blockerEvidence.malformedLines.map((l) => `- ${l}`).join("\n")}`
      );
      NotificationRouter.showWarning(
        `${STAGE_DISPLAY_NAMES[targetStage]} review parsed ${parsedBlockers.length} blocker(s), but ` +
          `${blockerEvidence.malformedLines.length} blocker line(s) could not be read and were not counted. ` +
          "Check the review-guard run log."
      );
    }
    const progressBefore = await readTaskProgressAdvisoryV1(folderUri);
    if (!progressBefore) {
      return { escalated: false };
    }
    // Review-flagged (2026-08-25, new architectural blocker): `parsedBlockers`
    // is THIS round's own fresh finding — the newest evidence that exists for
    // this stage. A prior `TaskProgress.blockerSupersessions` entry recorded
    // against an older, stale review artifact must never suppress it: doing
    // so here previously hid a genuinely-still-live blocker from
    // `reviewScoreHistory` and every downstream router permanently, since a
    // filtered blocker was never even persisted for a later round to notice
    // had reappeared. `filterSupersededBlockersV1` is deliberately NOT called
    // here — see its doc comment (`reviewAsOfMs` undefined = never filter).
    // A supersession can only ever suppress a STALE, previously-persisted
    // review artifact a decision surface reads later (`reconcilePlanChecklist.ts`),
    // never this round's own live output.
    //
    // wf10 continuation item 18: a `"plan-non-goal"` supersession is exactly
    // the opposite kind of fact — a standing decision about the blocker's
    // SUBJECT (the plan of record declares it out of scope), not a statement
    // about a stale artifact — so it is correct, and required, to apply it to
    // THIS round's own fresh blockers below. Scoped to the impl review
    // stages: `plan-final.md`'s `## Accepted Non-Goals` section is the impl
    // plan of record, with no equivalent for a plan review (which reviews
    // `plan.md`, before promotion to `plan-final.md`).
    let planNonGoalResult: PlanNonGoalSupersessionResultV1 | undefined;
    if (IMPL_REVIEW_STAGES_V1.includes(targetStage)) {
      try {
        const planFinalContent = (await readPlanOfRecordV1(folderUri)).text;
        if (planFinalContent) {
          planNonGoalResult = derivePlanNonGoalSupersessionsV1(
            targetStage,
            parsedBlockers,
            planFinalContent,
            progressBefore.blockerSupersessions,
            new Date().toISOString()
          );
        }
      } catch {
        // Best-effort only — a read failure here must never block the round
        // from recording its review normally with the unfiltered blockers.
      }
    }
    const blockers = planNonGoalResult?.effectiveBlockers ?? parsedBlockers;
    // 2d: a round with no parseable `Readiness: N/10` line is a failure
    // wearing a review's clothes — a provider error, truncation, or
    // degenerate output. It must NOT be appended to reviewScoreHistory:
    // detectPlateau reads exactly that history, so a phantom scoreless
    // round (or, historically, a 0/10 from a failed call) permanently
    // depresses the "prior best" and can manufacture a false plateau
    // rounds later. Record it as a failed attempt — with its reason
    // durably persisted in task-progress.json's reviewRejections trail,
    // plus a run log and a notification — instead.
    const rejectionReason = degenerateReviewRejectionReason({
      rejectDegenerateReviews: resilience.rejectDegenerateReviews,
      score,
      stage: targetStage,
      attemptId: reviewAttemptId,
    });
    if (rejectionReason !== null) {
      const degenerateModelId = reviewer?.storedModelId;
      // Bugfix (2026-08-27 review, "the compatibility classification and
      // ledger terminalization remain separate non-atomic writes"): the
      // `reviewRejections` trail entry, the `roundOutcomes` compatibility
      // classification, AND the round-ledger terminal state now land in ONE
      // `patchTaskProgressStrictV1` transaction via `terminalizeRoundV1`'s
      // `extraPatch`/`roundOutcomeClassification` options — previously these
      // were two separate patches (this one, then a second inside
      // `terminalizeRoundV1` below), so a failure of either write could leave
      // the ledger and the compatibility record disagreeing about whether,
      // or how, this round ended. `terminalizeRoundV1` is still the sole
      // writer of the terminal ledger state and the `roundOutcomes` entry;
      // `extraPatch` only adds the rejection-trail write to that same
      // transaction, it does not duplicate either write.
      await terminalizeRoundV1(
        reviewAttemptId,
        "rejected",
        { rejectionReason },
        {
          taskFolderUri: folderUri,
          ...(coordinatorOperationId ? { operationId: coordinatorOperationId } : {}),
          ...(coordinatorAttemptId ? { attemptId: coordinatorAttemptId } : {}),
          ...(coordinatorExtraAttemptIds?.length ? { extraAttemptIds: coordinatorExtraAttemptIds } : {}),
          extraPatch: (current) =>
            appendReviewRejection(current, {
              stage: targetStage,
              attemptId: reviewAttemptId,
              at: new Date().toISOString(),
              reason: rejectionReason,
            }),
          roundOutcomeClassification: {
            classification: "rejected-degenerate",
            attemptId: reviewAttemptId,
            ...(degenerateModelId ? { modelId: degenerateModelId } : {}),
          },
        }
      );
      const persistedRejection = await readTaskProgressAdvisoryV1(folderUri);
      // wf10 item 7c / Part 6 step 16: report the diagnosable cause, not just
      // the symptom. `Output length` alone (the old report) is exactly what
      // read as "degenerate output" and pointed at the model when the
      // actionable fact was prompt size — the assembled prompt size and a
      // named-remedy advisory when a known provider Read-ceiling is
      // exceeded turn this into something the user can act on directly.
      // Separately, a reply matching the provider-exhaustion shape (the
      // model correctly answering a budget-handler question Ensemble never
      // asked, after running out of read/tool budget) is classified
      // distinctly from genuine malformed output — same recorded outcome
      // (`rejected-degenerate`, same backup-advance handling) but a
      // different diagnosis in the report.
      const isExhaustionShape = isProviderExhaustionReplyShapeV1(content);
      const ceilingAdvisory = promptCeilingAdvisoryV1(promptLength, providerId);
      const diagnosticLines = [
        `Output length: ${content.length} characters.`,
        promptLength !== undefined ? `Assembled prompt size: ${promptLength} bytes.` : undefined,
        isExhaustionShape
          ? "Shape: this reply matches a provider-side read/tool-budget EXHAUSTION REPORT, not malformed " +
            "output — the model answered a budget-handler question about its blocker and what it needs, " +
            "after exhausting its read/tool budget on this prompt. The remedy is prompt size, not model quality."
          : undefined,
        ceilingAdvisory,
      ].filter((line): line is string => line !== undefined);
      await writeRunLog(
        folderUri,
        "review-guard",
        targetStage,
        `# Rejected Review Round\n\nStatus: rejected (degenerate output)\n` +
          // wf10 item 4 / Part 4 completion-blocker fix: the fixed-vocabulary
          // classification, not just the free-text status line, so the run
          // log itself carries the same token persisted to `roundOutcomes`.
          `Round outcome: rejected-degenerate\n\n${rejectionReason}\n\n${diagnosticLines.join("\n")}`
      );
      // Note (2026-08-27 review, "Rejected degenerate reviews are recorded
      // as completed"): this branch returns without ever going through the
      // outcome-completion path, so the only other closer on this path —
      // `terminalizeUnclosedReviewRoundV1`'s safety net in
      // `handleReviewOutcomeV1`'s `finally` — would otherwise map the
      // coordinator's `outcome.kind === "completed"` (the provider call
      // itself succeeded; only the CONTENT was judged degenerate here) to
      // ledger state `"completed"`, contradicting the `rejected-degenerate`
      // classification recorded above. The row `claimReviewAttempt` opened
      // at this round's real start was already terminalized as `"rejected"`
      // above, atomically with the rejection trail and `roundOutcomes`
      // entry; `terminalizeRoundV1` is idempotent, so that later safety net
      // simply no-ops against this already-terminal row.
      // wf10 item 7d / Part 5 step 15: a completed-but-unparseable round is a
      // candidate failure for backup-selection purposes, invisible to
      // switch-to-backup's own runner-level failure handling (the runner
      // succeeded; only the parser found nothing usable) — decide whether
      // the stage's next configured backup should be tried, offered as a
      // manual retry, or reported exhausted. The caller (routeReviewOutcomeV1)
      // owns actually dispatching the automatic case; this function only
      // decides and reports, matching its existing "never throws, never
      // dispatches" contract.
      const chain = resolveEffectiveStageChainV1(targetStage);
      // wf10 review fix (Part 5 step 15): a successfully scored review for
      // this stage never appends a `roundOutcomes` entry (only
      // `rejected-degenerate` rounds do), so the episode scan below cannot
      // rely on `roundOutcomes` alone to notice a real score happened in
      // between — pass the newest `reviewScoreHistory` timestamp for this
      // stage so the scan stops there instead of walking into an older
      // episode's rejections. `progressBefore` is read before this round's
      // own patch, so it already reflects every score published by a PRIOR
      // round.
      const latestScoredReviewAt = [...(progressBefore.reviewScoreHistory ?? [])]
        .filter((entry) => entry.stage === targetStage)
        .map((entry) => entry.at)
        .sort()
        .at(-1);
      const episodeTriedModelIds = computeDegenerateReviewEpisodeModelIdsV1(
        persistedRejection?.roundOutcomes,
        targetStage,
        latestScoredReviewAt
      );
      const degenerateBackupAdvance = decideDegenerateReviewBackupAdvanceV1({
        chainBackups: getConfiguredBackupModelsForStage(targetStage, degenerateModelId),
        strategy: chain.strategy,
        currentModelId: degenerateModelId,
        episodeTriedModelIds,
      });
      if (degenerateBackupAdvance.kind === "manual") {
        NotificationRouter.showWarning(
          `${rejectionReason} A configured backup (${attributionModelLabel(degenerateBackupAdvance.nextModelId) ?? degenerateBackupAdvance.nextModelId}) has not been tried this episode.`,
          undefined,
          undefined,
          undefined,
          {
            command: "vs-code-ai-helper.retryReviewWithBackupV1",
            title: `Retry with ${attributionModelLabel(degenerateBackupAdvance.nextModelId) ?? degenerateBackupAdvance.nextModelId}`,
            args: [{ taskFolderPath: folderUri.fsPath, stage: targetStage, modelId: degenerateBackupAdvance.nextModelId }],
          }
        );
      } else if (degenerateBackupAdvance.kind === "exhausted") {
        // wf10 review fix (Part 5 step 15): with every configured backup
        // already tried this episode, there is no "next model" to name — but
        // the round may still have been a one-off flake, and the user had no
        // one-click way to just try again. Offer a retry with the SAME model
        // that just produced degenerate output, via the exact same manual
        // affordance the "manual" branch above uses (recordActiveFallbackModel
        // + preserveActiveFallback re-dispatch), rather than leaving this
        // warning as a dead end.
        NotificationRouter.showWarning(
          `${rejectionReason} Every configured backup for this stage has also failed to produce a parseable review this episode.`,
          undefined,
          undefined,
          undefined,
          degenerateModelId
            ? {
                command: "vs-code-ai-helper.retryReviewWithBackupV1",
                title: `Retry with ${attributionModelLabel(degenerateModelId) ?? degenerateModelId}`,
                args: [{ taskFolderPath: folderUri.fsPath, stage: targetStage, modelId: degenerateModelId }],
              }
            : undefined
        );
      } else {
        NotificationRouter.showWarning(rejectionReason);
      }
      return { escalated: false, degenerateBackupAdvance };
    }
    // Part 10: resolve this round's blockers against the PRIOR round's ID'd
    // list for this same stage, so a reviewer's declared `[same:<id>]` /
    // `[narrowed:<id>]` citation carries its id forward instead of minting a
    // fresh, unlinkable one every round — see resolveBlockerLineageV1's doc
    // comment for the first-round/unknown-citation edge cases.
    const priorEntryForStage = [...(progressBefore.reviewScoreHistory ?? [])]
      .reverse()
      .find((entry) => entry.stage === targetStage);
    // wf10 continuation item 18 (review blocker, 2026-08-26: "lacks
    // lineage-bound challenge identities"): identities for blockers this
    // round EXCLUDED for matching an Accepted Non-Goals entry. These never
    // appear in `blockers` (they are not outstanding), so they have no place
    // in next round's prior-list citation — but a challenged blocker CAN
    // still carry its own `[same:<id>]`/`[narrowed:<id>]` citation, and doing
    // so is exactly how a standing `[same:…]` blocker (the case this feature
    // exists for — a frozen blocker the plan just declared out of scope) is
    // recognized as the identical issue across rounds rather than a fresh
    // unlinkable one every time. wf10 continuation review fix (2026-08-27):
    // when the SAME blocker was already challenged in the prior round, its
    // id lives in the prior entry's `supersededBlockers`, not `blockers` —
    // so the citation lookup must include both lists, matching the same
    // merge used to build `{{priorBlockerLineageList}}` above, or a
    // repeatedly-challenged blocker would mint a fresh, unlinkable id every
    // round it is re-raised. Reuse `resolveBlockerLineageV1` itself, seeded
    // with a distinct attemptId namespace (`-ng` suffix) so an
    // UNCITED/first-seen challenge still gets a fresh id that can never
    // collide with a same-round citable one, while a cited challenge carries
    // the real lineage id forward. Capped identically to
    // `resolveBlockerLineageV1`'s own slice so a pathological match count can
    // never fail the strict decoder's bound on write — sliced once so
    // `supersededBlockers` and `reviewerChallengedNonGoal` below stay
    // index-aligned.
    const challengedMatches = (planNonGoalResult?.challenged ?? []).slice(0, MAX_REVIEW_BLOCKER_IDENTITIES);
    const priorBlockersAndSuperseded = [
      ...(priorEntryForStage?.blockers ?? []),
      ...(priorEntryForStage?.supersededBlockers ?? []),
    ];
    const challengedIdentities = resolveBlockerLineageV1(
      challengedMatches.map((match) => match.blocker),
      priorBlockersAndSuperseded,
      `${reviewAttemptId}-ng`
    );
    const historyEntry = {
      stage: targetStage,
      score,
      attemptId: reviewAttemptId,
      at: new Date().toISOString(),
      blockerCount: blockers.length,
      taskFixableCount: blockers.filter((b) => b.resolver === "task-fixable").length,
      blockers: resolveBlockerLineageV1(blockers, priorEntryForStage?.blockers, reviewAttemptId),
      ...(reviewer ? { reviewer } : {}),
      ...(challengedIdentities.length > 0 ? { supersededBlockers: challengedIdentities } : {}),
      ...(challengedMatches.length > 0
        ? {
            reviewerChallengedNonGoal: challengedMatches.map((match, index) => ({
              blockerId: challengedIdentities[index]!.id,
              nonGoalHeading: match.nonGoalHeading,
            })),
          }
        : {}),
    };
    // wf10 continuation item 18 / Part 4 architectural fix (2026-08-27
    // review, narrowed blocker 2: "the replacement still creates an
    // artificial open row inside review completion handling ... outside the
    // start authority"): the row for THIS round already exists — opened by
    // `claimReviewAttempt` at the round's real start, before the provider was
    // even dispatched (see that function's doc comment) — so this function
    // never creates a row of its own; it only ever terminalizes the one
    // already open. `terminalizeRoundV1` is the plan's SOLE writer of a
    // terminal round-ledger state and its chat outcome message, and is called
    // unconditionally below for every review round that reaches this point,
    // not only a non-goal-challenge — a plain completed review with no
    // challenge previously left its start-opened row open forever (nothing
    // else in this call path closed it).
    const reviewerChallengedNonGoalHeadings = historyEntry.reviewerChallengedNonGoal?.length
      ? historyEntry.reviewerChallengedNonGoal.map((c) => c.nonGoalHeading)
      : undefined;
    const updated = await patchTaskProgressStrictV1(folderUri, (current) => {
      let withHistory = appendReviewScoreHistory(current, historyEntry);
      // wf10 continuation item 18: persist every newly-derived plan-non-goal
      // supersession alongside the history entry it was derived for, so a
      // later reconciliation/reconcile read sees the SAME decision this
      // round already applied — never a round that filtered blockers from
      // its own history entry while leaving no durable trace of why.
      for (const supersession of planNonGoalResult?.newSupersessions ?? []) {
        withHistory = appendBlockerSupersession(withHistory, supersession);
      }
      // A real (non-degenerate) review round just published for this stage —
      // that is replacement review-tracking state, so an incomplete-round
      // invalidation marker for the same stage is now redundant and may be
      // cleared. Only while nothing is still quarantined: a review that ran
      // while `pendingImplReviewFiles` exist has not seen the unreported
      // round's edits, so the marker must survive it.
      return withHistory.reviewInvalidatedByRound?.stage === targetStage &&
        (withHistory.pendingImplReviewFiles?.length ?? 0) === 0
        ? clearReviewInvalidatedByRound(withHistory)
        : withHistory;
    });
    if (!updated) {
      return { escalated: false };
    }
    // Part 11 item 13c (event-driven half, "a fresh review landing"): a
    // `sterileRoundRouting`/`preImplementationRouting` card recommends
    // "Go to Review & Apply" from a snapshot of `decidePostReviewActionV1`
    // taken when the round that posted it finished. This review round just
    // published a new `reviewScoreHistory` entry — the exact input that
    // recommendation was computed from — so any such card for this task is
    // now describing a situation that may have already changed. Withdraw
    // eagerly here rather than leaving `hasPendingDecision` true until the
    // chat panel's render-time safety net (`withdrawStaleDecisionsV1`) next
    // re-derives it; that predicate remains the fail-closed net beneath this.
    await withdrawWorkflowDecisionsByKeyV1(
      { taskFolderPath: folderUri.fsPath, canonicalId: normalizePath(folderUri.fsPath) },
      "sterileRoundRouting",
      "a new review has landed for this stage, superseding the routing recommendation this card was based on"
    );
    await withdrawWorkflowDecisionsByKeyV1(
      { taskFolderPath: folderUri.fsPath, canonicalId: normalizePath(folderUri.fsPath) },
      "preImplementationRouting",
      "a new review has landed for this stage, superseding the routing recommendation this card was based on"
    );
    // wf10 continuation item 18: "when a review re-raises a blocker the plan
    // declares out of scope, say so" — the run log above already records it,
    // but a run log is not somewhere the user is looking. `terminalizeRoundV1`
    // closes the row opened by `claimReviewAttempt` and writes the chat
    // "kind: outcome" message itself (via `formatRoundOutcomeMessageV1`,
    // which renders `outcome.reviewerChallengedNonGoal` when present), so
    // every completed review's outcome — challenged or not — reaches the
    // transcript through the same canonical path every other round's outcome
    // does, rather than a bespoke message built here. Idempotent: a resumed/
    // rerun path that already terminalized this `reviewAttemptId` (unlikely,
    // since each resume mints its own fresh attempt id) would simply no-op.
    // Bugfix (2026-08-27 review, "The review ledger counts mechanically
    // generated task-fixable blockers as reviewer blockers"): `blockers`
    // merges the reviewer's own `<!-- blockers:start -->` findings with
    // `getMechanicalBlockersForStage`'s synthesized ones (see `parsedBlockers`
    // above) — a single `.length` over that merged list attributed every
    // mechanical blocker to the reviewer and never recorded a mechanical
    // count at all. `splitTaskFixableBlockersByOriginV1` is the one place
    // this split is computed (item 12's `origin` field).
    const blockerSplit = splitTaskFixableBlockersByOriginV1(blockers);
    await terminalizeRoundV1(
      reviewAttemptId,
      "completed",
      {
        ...(typeof score === "number" ? { score } : {}),
        reviewerBlockers: blockerSplit.reviewerBlockers,
        mechanicalBlockers: blockerSplit.mechanicalBlockers,
        ...(reviewerChallengedNonGoalHeadings ? { reviewerChallengedNonGoal: reviewerChallengedNonGoalHeadings } : {}),
      },
      {
        taskFolderUri: folderUri,
        ...(coordinatorOperationId ? { operationId: coordinatorOperationId } : {}),
        ...(coordinatorAttemptId ? { attemptId: coordinatorAttemptId } : {}),
        ...(coordinatorExtraAttemptIds?.length ? { extraAttemptIds: coordinatorExtraAttemptIds } : {}),
      }
    );

    // Churn ceiling: an unconditional stop after N configurable rounds
    // without a DECREASE in task-fixable blockers — independent of both the
    // score and the blocker-churn signal below, so a loop that keeps
    // completing rounds while the amount of fixable work never falls is
    // stopped well before fastForwardMaxIterations burns out.
    if (
      shouldEscalateChurnCeiling({
        history: updated.reviewScoreHistory ?? [],
        stage: targetStage,
        taskFixableCount: historyEntry.taskFixableCount,
        churnCeilingRounds: resilience.churnCeilingRounds,
      })
    ) {
      const stagnantRounds = roundsWithoutTaskFixableDecrease(
        updated.reviewScoreHistory ?? [],
        targetStage
      );
      // Part 10: the flat churn count alone can't distinguish "the same
      // blocker, unchanged" (true churn) from "narrowing" (real progress the
      // count can't see) or "a different blocker each round" (an unstable
      // requirement) — only the reviewer's own declared lineage can. When
      // any round in the window lacks it, say so honestly instead of
      // guessing from prose.
      const lineageDiagnosis = classifyChurnLineageV1(
        updated.reviewScoreHistory ?? [],
        targetStage,
        stagnantRounds
      );
      // The leading sentence must follow the diagnosis rather than
      // unconditionally asserting churn — see buildChurnEscalationReasonV1's
      // doc comment for why this matters (the plan's "The worse case").
      let reason = buildChurnEscalationReasonV1(
        STAGE_DISPLAY_NAMES[targetStage],
        stagnantRounds,
        lineageDiagnosis
      );
      // Surface a plan.md vs plan-final.md disagreement on the blocked
      // requirement as its own distinct cause — only from a direct textual
      // comparison, never inferred.
      try {
        const planContentForMismatch = await readNonEmptyText(await resolveCurrentPlanUri(folderUri));
        const planFinalForMismatch = (await readPlanOfRecordV1(folderUri)).text;
        if (planContentForMismatch && planFinalForMismatch) {
          for (const blocker of blockers) {
            if (blocker.resolver !== "task-fixable") {
              continue;
            }
            const mismatch = detectPlanArtifactDisagreementV1(
              blocker.description,
              planContentForMismatch,
              planFinalForMismatch
            );
            if (mismatch) {
              reason += ` ${mismatch}`;
              break;
            }
          }
        }
      } catch {
        // Best-effort enrichment only — never block the escalation itself.
      }
      const escalated = await escalateReviewToHuman(
        folderUri,
        targetStage,
        "plateau",
        reason,
        reviewAttemptId,
        updated,
        false,
        undefined,
        { content, blockers, taskFixableCount: historyEntry.taskFixableCount, stageRoundOutcomes: updated.roundOutcomes }
      );
      return { escalated };
    }

    const plateauWindow = getReviewPlateauRounds();
    // 2f (flagged): the blocker set is the progress signal — shrinking or
    // changing contents means real work landed regardless of what the score
    // did; an unchanged (matched substantively, not byte-for-byte) or
    // growing set is the stall. The legacy score high-water-mark test
    // remains the default until the flag is enabled.
    const plateaued = resilience.blockerSetPlateau
      ? detectBlockerSetStall(updated.reviewScoreHistory ?? [], targetStage, plateauWindow)
      : detectPlateau(updated.reviewScoreHistory ?? [], targetStage, plateauWindow);
    // A second opinion has already been "tried this plateau" once any round
    // in the current unbroken run of plateaued rounds recorded one. Latches
    // on `secondOpinionAttempted`, not `kind`: every kind a second-opinion
    // attempt can actually produce (environmental/spec-defect on agreement,
    // reviewer-disagreement, or plateau when no candidate model was
    // available) must count, or a resumed task that plateaus again gets a
    // redundant second-opinion round instead of escalating directly.
    const secondOpinionTriedThisPlateau =
      progressBefore.escalation?.stage === targetStage &&
      progressBefore.escalation.secondOpinionAttempted === true;

    const decision = decideReviewRoute({
      score,
      threshold,
      blockers,
      plateaued,
      secondOpinionTriedThisPlateau,
    });

    if (decision.route === "advance" || decision.route === "iterate") {
      return { escalated: false };
    }
    if (decision.route === "advance-with-note") {
      NotificationRouter.showInformation(
        `${STAGE_DISPLAY_NAMES[targetStage]} review scored ${score}/10 — ${decision.reason}`
      );
      return { escalated: false };
    }
    if (decision.route === "second-opinion") {
      // The independent second-opinion mechanism itself is retired (Cleanup
      // cohort disposition — see legacyAiActionSafetyGateV0.ts's file header
      // and reconcileSecondOpinion's doc comment below): there is no
      // coordinator-migrated replacement, so this escalates directly instead
      // of announcing an attempt that can never actually run and then
      // silently discovering that.
      const escalated = await escalateReviewToHuman(
        folderUri,
        targetStage,
        "plateau",
        `${STAGE_DISPLAY_NAMES[targetStage]} review has plateaued at ${score}/10. Independent second-opinion review is not available in this build, so this escalates directly.`,
        reviewAttemptId,
        updated,
        true,
        undefined,
        { content, blockers, taskFixableCount: historyEntry.taskFixableCount, stageRoundOutcomes: updated.roundOutcomes }
      );
      return { escalated };
    }
    // decision.route === "escalate"
    const escalated = await escalateReviewToHuman(
      folderUri,
      targetStage,
      "plateau",
      decision.reason,
      reviewAttemptId,
      updated,
      false,
      undefined,
      { content, blockers, taskFixableCount: historyEntry.taskFixableCount, stageRoundOutcomes: updated.roundOutcomes }
    );
    return { escalated };
  } catch (error) {
    NotificationRouter.showWarning(
      `Review routing check failed (the review itself still published successfully): ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return { escalated: false };
  }
}

/**
 * Core review logic for a known task folder: build variables, run the AI
 * review for the given stage, and advance the task to the review stage.
 * Called by runReviewWithAI (user-invoked) and by nextStage for auto-triggered reviews.
 *
 * Review commands are stage-neutral: they do NOT change currentStage.
 * Stage advancement is handled by nextStage/setTaskStage exclusively.
 *
 * No overwrite confirmation is shown (user has already triggered this deliberately).
 *
 * NOTE: Consent is checked at the entry-point level (runReviewWithAI,
 * applyReviewWithAI, etc.) — not here — so internal chaining (nextStage →
 * runReviewForFolder) does not re-prompt.
 *
 * The prompt-size gate IS applied here (via runAiToFile) since this is
 * where the final prompt string is assembled.
 *
 * Model resolution: review generation always uses the review-stage model
 * (logStage == executionStage). Only apply flows override executionStage
 * to target the execution-stage model instead.
 *
 * Variable sourcing for implementation reviews:
 *   - `{{plan}}` is read from the current plan artifact (plan.md via
 *     resolveCurrentPlanUri) — this is the plan the implementation was
 *     supposed to follow.
 *   - `{{implementation}}` is read from plan-final.md (the canonical
 *     implementation-stage artifact) — after an implementation run,
 *     executeImplementationRun writes the run summary back here. The two
 *     variables therefore always carry distinct content.
 *
 *   Legacy tasks that still have only `implementation.md` are handled with a
 *   read-only canonical-then-legacy fallback read — plan-final.md is never
 *   materialized here as a side effect of preparing a review prompt, so a
 *   review that is cancelled, fails, or returns questions leaves the
 *   implementation artifact byte-identical. (generateImplementationWithAI
 *   uses the same read-only fallback for the same reason; only the
 *   edit-capable, still-gated applyImplementationReviewWithAI path uses the
 *   writing `materializeCanonicalIfNeeded`.)
 */
/** Context {@link handleReviewOutcomeV1} needs to route a `review.v1` outcome
 * (from either the initial run or an explicit Chat Resume) through stage
 * advancement, score-based auto-advance/escalation, and follow-up dispatch. */
export interface ReviewOutcomeContextV1 {
  extensionUri: vscode.Uri;
  folderUri: vscode.Uri;
  workspaceUri: vscode.Uri;
  currentStage: TaskStage;
  targetStage: TaskStage;
  reviewUri: vscode.Uri;
  variables: Record<string, string>;
  reviewAttemptId: string;
  operation?: TaskOperationHandle;
  chatViewProvider?: ChatViewProvider;
  /** wf10 item 7d / Part 5 step 15: the stored model id THIS round actually
   * ran with — needed to decide whether a degenerate rejection should
   * automatically advance to the stage's next configured backup. Absent
   * only for callers that genuinely never resolved one (resumed/legacy
   * paths), in which case the backup-advance decision degrades to
   * "exhausted" rather than guessing. */
  modelId?: string;
  /** wf10 item 7c / Part 6 step 16: the assembled prompt's length (the exact
   * string dispatched to the provider), reported alongside the reply's
   * output length in a degenerate-review rejection's run log so the report
   * states the diagnosable cause rather than only the symptom. Absent for
   * callers that never assembled a fresh prompt this round (e.g. resumed
   * paths reading back an in-flight operation's result). */
  promptLength?: number;
  /** wf10 item 7c / Part 6 step 16: the resolved provider id THIS round
   * dispatched to (e.g. "kimi-cli"), used to look up a known Read-tool
   * ceiling for the prompt-size advisory. Absent when not resolvable. */
  providerId?: string;
  /** 2026-08-27 review, blocker "review rows... omit earlier retry-attempt
   * identities": every coordinator `attemptId` this round's `onPromptAssembled`
   * callback observed, beyond the final one carried on `outcome.correlation`
   * — a primary candidate that failed before a fallback candidate or an
   * item-14 same-candidate retry produced the outcome. Forwarded to
   * `terminalizeRoundV1`'s `extraAttemptIds` so the round-ledger row is
   * findable by any attempt it actually made, not only the last. */
  extraCoordinatorAttemptIds?: readonly string[];
}

/**
 * Shared `review.v1` outcome handler: stage advancement, score-based
 * auto-advance/escalation/second-opinion routing, follow-up review/
 * implementation dispatch, Chat question routing, and Publish nudges.
 *
 * Used by BOTH the initial run (runReviewForFolder, immediately after
 * `coordinator.executeAction`) and explicit Chat Resume
 * (resumeReviewInteractionV1, immediately after `coordinator.resumeAction`) —
 * a resumed review that completes must reach the exact same routing/
 * escalation/follow-up logic as an initial review that completes, not a bare
 * same-stage no-op advance.
 */
/**
 * Exported (in addition to its two production call sites, `runReviewForFolder`
 * and `resumeReviewInteractionV1`) so a test can drive a REALISTIC "completed"
 * outcome straight into the real routing/escalation/dispatch chain without
 * hand-building any of `routeReviewOutcomeV1`'s internal decisions.
 *
 * wf10 Part 5 step 15 review fix: a degenerate (no parseable `Readiness:
 * N/10`) outcome can only ever reach this function's "completed" branch via
 * the RESUME path (`coordinator.resumeAction`, via `executeResume`) — the
 * initial-dispatch path (`coordinator.executeAction`) rejects null-score
 * content at the row's own `validateCompletedContent` content-contract check
 * (reviewRowV1.ts) BEFORE it can ever settle as "completed", retrying the
 * next candidate or returning `contentContractFailed` instead. So a test
 * exercising the degenerate-rejection-then-automatic-backup-dispatch
 * behavior this function's "completed" branch performs must call this
 * function directly with a synthetic-but-realistic outcome (what Resume can
 * legitimately produce), not attempt to walk it through the initial
 * dispatch's coordinator loop, which structurally cannot produce this shape.
 */
export async function handleReviewOutcomeV1(
  outcome: TaskActionOutcomeV1,
  ctx: ReviewOutcomeContextV1
): Promise<void> {
  // The run log lives in `finally` so it is genuinely unconditional. The
  // routing body below has several early returns (a stage transition that
  // throws or fails to persist, a missing Chat record, ...) — an earlier
  // version of this fix put the log after the branch chain, where every one
  // of those paths skipped it and silently reproduced the very
  // no-artifact-to-inspect problem the log exists to end.
  try {
    await routeReviewOutcomeV1(outcome, ctx);
  } finally {
    await writeReviewRunLogV1(outcome, ctx);
    await terminalizeUnclosedReviewRoundV1(outcome, ctx);
  }
}

/**
 * Safety-net closer for the row `claimReviewAttempt` opened at this round's
 * real start (Part 4 architectural fix, 2026-08-27 review, narrowed blocker
 * 2). `routeReviewOutcomeV1`'s "completed" branch already terminalizes an
 * ordinary review through `handleReviewRoutingOutcome` — but several paths
 * never reach it: every non-"completed" outcome (failed/cancelled/
 * unavailable/questions/...), and a "completed" outcome whose stage
 * transition or persistence itself failed before `handleReviewRoutingOutcome`
 * was ever called. Left alone, any of those leaves the round's start-opened
 * row `"open"` forever — worse than before this fix, which never opened a
 * row for these paths at all. `terminalizeRoundV1` is idempotent, so calling
 * it here unconditionally, after `routeReviewOutcomeV1` has already run, is
 * always safe: a no-op for a row already terminal, and the actual close for
 * every row `routeReviewOutcomeV1` left open. Best-effort like
 * `writeReviewRunLogV1` beside it — a failure here must never mask the
 * review's own already-surfaced outcome.
 */
async function terminalizeUnclosedReviewRoundV1(
  outcome: TaskActionOutcomeV1,
  ctx: ReviewOutcomeContextV1
): Promise<void> {
  try {
    const correlation = outcomeCorrelationV1(outcome);
    await terminalizeRoundV1(
      ctx.reviewAttemptId,
      terminalStateForUnclosedReviewOutcomeV1(outcome),
      undefined,
      {
        taskFolderUri: ctx.folderUri,
        ...(correlation ? { operationId: correlation.operationId, attemptId: correlation.attemptId } : {}),
        ...(ctx.extraCoordinatorAttemptIds?.length
          ? { extraAttemptIds: ctx.extraCoordinatorAttemptIds }
          : {}),
      }
    );
  } catch {
    // Ignore: this is a best-effort ledger close, never the review's own
    // outcome — `writeReviewRunLogV1` beside it already recorded the durable
    // diagnostic artifact for this round.
  }
}

/** @internal exported for testing */
export function terminalStateForUnclosedReviewOutcomeV1(
  outcome: TaskActionOutcomeV1
): RoundLedgerTerminalStateV1 {
  switch (outcome.kind) {
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    default:
      // "questions", "failed", "malformedResult", "unavailable",
      // "recoveryRequired", "stalePreflight", "partialEditBlocked" — none of
      // these produced a usable review artifact for this round, and each
      // resume mints its own fresh `reviewAttemptId` (see
      // `resumeReviewInteractionV1`), so nothing later revisits THIS row —
      // it must close here rather than linger open. Mirrors how a
      // "questions" outcome is treated for an edit-capable round
      // (`runEditActionV1.ts`'s `runSealedImplementationV1`) — a failure of
      // this round, not a pause.
      return "failed";
  }
}

/**
 * Best-effort diagnostic artifact for one settled review, written for EVERY
 * outcome. Reviews on the legacy path wrote a run log per run; the V1
 * coordinator migration dropped it, which is why a failed review left
 * nothing on disk to inspect afterwards.
 *
 * Sanitized by construction: describeTaskActionOutcomeForLogV1 emits only
 * the closed outcome contract's kinds/codes/ids, never provider text (plan
 * §2.2). A logging failure must never fail an otherwise fine review, so
 * everything here is swallowed.
 */
/** @internal exported for testing (the chain-exhaustion enrichment) */
export async function writeReviewRunLogV1(
  outcome: TaskActionOutcomeV1,
  ctx: ReviewOutcomeContextV1
): Promise<void> {
  try {
    // A stage whose whole provider chain was exhausted gets an ENRICHED run
    // record naming the chain and per-candidate reasons — never the bare
    // 60-byte `Status: unavailable (providerModeUnavailable)` that made
    // round 018 of "more workflow bugs" (2026-08-13) indistinguishable from
    // a round still thinking. The evidence is the registry's own closed
    // diagnostic strings (stage, ranked stored ids, skip/failure reasons),
    // so the §2.2 no-provider-text rule still holds; the per-candidate lines
    // use the same provider-attribution format successful rounds record.
    const exhaustion =
      outcome.kind === "unavailable" ? outcome.chainExhaustion : undefined;
    // workflow 3 continuation, third item: `candidatesExhausted` (every
    // candidate was reserved, invoked, and failed) is the opposite condition
    // from `providerModeUnavailable` (nothing was ever reserved) — "no
    // provider could be acquired" is only true of the second.
    const exhaustionHeadline =
      outcome.kind === "unavailable" && outcome.code === "candidatesExhausted"
        ? `Every configured model was tried and failed for ${exhaustion?.stage ?? ctx.targetStage}.`
        : `No provider could be acquired for ${exhaustion?.stage ?? ctx.targetStage}.`;
    const exhaustionSection = exhaustion
      ? `\n## Provider chain exhausted\n\n` +
        `${exhaustionHeadline} ` +
        `The resolved chain, in ranked order:\n\n` +
        (exhaustion.candidates.length > 0
          ? exhaustion.candidates
              .map(
                (candidate) =>
                  `- ${candidate.providerLabel} (${
                    attributionModelLabel(candidate.storedModelId) ?? candidate.storedModelId
                  }) — ${candidate.reason}`
              )
              .join("\n")
          : "_no candidates are configured for this stage_") +
        "\n\nThe task has been paused with this reason; fix provider availability or the stage's model configuration, then resume.\n"
      : "";
    // wf10 continuation item 12, Part 1 step 4: the durable per-review record
    // (this run log) must show the same reviewer/mechanical split every other
    // blocker-count surface shows — otherwise this is the one place left
    // where a mechanically-synthesized blocker is indistinguishable from one
    // the reviewer actually raised. Read back the historyEntry THIS outcome
    // just published (matched by attemptId, not "the newest for this stage")
    // so a resumed/rerun review can never attribute a stale round's blockers
    // to this one.
    let blockerSection = "";
    if (outcome.kind === "completed") {
      try {
        const progressForLog = await readTaskProgressAdvisoryV1(ctx.folderUri);
        const publishedEntry = [...(progressForLog?.reviewScoreHistory ?? [])]
          .reverse()
          .find((entry) => entry.stage === ctx.targetStage && entry.attemptId === ctx.reviewAttemptId);
        if (publishedEntry) {
          blockerSection = `\nBlockers: ${describeTaskFixableBlockersV1(
            publishedEntry.taskFixableCount,
            publishedEntry.blockers
          )}\n`;
          // wf10 continuation item 18 (review blocker, 2026-08-26: "the
          // required ledger outcome"): the plan asks for a ledger outcome
          // line recording this, but Part 4's `roundLedger` does not exist
          // yet — this run log IS the durable per-round record today, so it
          // carries the line the ledger will eventually carry, in the exact
          // wording plan step 11 specifies, so "did the reviewer see the
          // decision?" has a durable answer even when it disagreed with it.
          if (publishedEntry.reviewerChallengedNonGoal?.length) {
            blockerSection +=
              "\n" +
              publishedEntry.reviewerChallengedNonGoal
                .map(
                  (c) =>
                    `the reviewer re-raised a blocker the plan declares out of scope: ${c.nonGoalHeading}` +
                    (c.blockerId ? ` (blocker id: ${c.blockerId})` : "")
                )
                .join("\n") +
              "\n";
          }
        }
      } catch {
        // Best-effort enrichment only — the bare outcome line above already
        // makes this run log a usable record without it.
      }
    }
    const logUri = await writeRunLog(
      ctx.folderUri,
      "review-v1",
      ctx.targetStage,
      `# Review Run\n\n${describeTaskActionOutcomeForLogV1(
        outcome,
        STAGE_ARTIFACT_FILENAMES[ctx.targetStage]
      )}\n${blockerSection}${exhaustionSection}`
    );
    taskOperations.setResultTargetUriForTask(ctx.folderUri.fsPath, logUri);
  } catch {
    // Ignore: the review's own outcome has already been surfaced.
  }
}

/**
 * After a review completes, offer the operator a decision when it named plan
 * items as verified-complete that plan-final.md still shows unticked — the
 * "Apply N reviewer-verified ticks" one-click path (workflow 3 continuation
 * plan, Part 5). Plan review stages carry no implementation checklist at all,
 * so this is a no-op for them. Best-effort: a read failure here must never
 * break the review-completion flow it's attached to.
 *
 * Reuses `applyReviewerVerifiedTicks`'s own derivation
 * (`deriveApplicableVerifiedTicksV1`) to decide SILENTLY whether there is
 * anything to offer — posting unconditionally would show its own "nothing to
 * apply" notice after every review, which is exactly the noise this function
 * exists to avoid. Only when something is actually applicable does it post
 * the `WorkflowDecisionV1` (case 2 — module header,
 * applyReviewerVerifiedTicks.ts), via `postApplyReviewerVerifiedTicksDecisionV1`
 * directly rather than `vscode.commands.executeCommand` — this write path has
 * no `TaskInventory` to resolve through, and a unit-test harness stubbing
 * only the write path would not have the command registered anyway.
 */
async function notifyReviewerVerifiedTicksV1(
  folderUri: vscode.Uri,
  targetStage: TaskStage
): Promise<void> {
  if (isPlanReviewStage(targetStage)) {
    return;
  }
  const derived = await deriveApplicableVerifiedTicksV1(folderUri, targetStage);
  if (derived.kind !== "ok") {
    return;
  }
  const posted = await postApplyReviewerVerifiedTicksDecisionV1(folderUri, folderUri.fsPath, folderUri.fsPath, targetStage);
  if (posted.kind === "noContext") {
    // Case-1 sweep (workflow decisions task, PART 4 step 12): this used to
    // fall back to the pre-migration notification — a truncated "…and N
    // more" preview ending in the rhetorical "Apply the reviewer's ticks?"
    // with no button to answer it, since the decision that would have
    // carried the action failed to post. Matches the plain informational
    // fallback every sibling decision uses (reconcilePlanChecklist.ts,
    // applyReviewerVerifiedTicks.ts, implementationRecoveryV1.ts,
    // pauseTaskForExhaustedChainV1) when there is no active extension
    // context to post a WorkflowDecisionV1 into.
    const { reviewFilename, applicable } = derived.derivation;
    NotificationRouter.showWarning(
      `${reviewFilename} named ${applicable.length} plan item(s) as verified complete that are still unticked ` +
        "in plan-final.md. Could not post the reviewer-verified-ticks decision to Chat With AI " +
        "(no active extension context); run \"Apply Reviewer-Verified Ticks\" once the extension is active."
    );
  }
}

/**
 * wf10 item 7d / Part 5 step 15: dispatch (or, when dispatch genuinely
 * cannot run, report) an automatic degenerate-review backup advance.
 * Extracted from `routeReviewOutcomeV1`'s inline "advance" branch so this
 * decision is unit-testable with injected dependencies — a prior round's
 * test could only assert the call expression existed in source, never that
 * it actually ran (review finding, Part 5 step 15).
 *
 * Review fix: the inline version silently did nothing when
 * `getWorkspaceFolder` could not resolve a `vscode.WorkspaceFolder` for the
 * task's workspace — the chain the user configured just stopped, with no
 * warning and no retry affordance, unlike the sibling "manual"/"exhausted"
 * branches which always offer one. This now falls back to the same
 * one-click "Retry with <model>" notification those branches use.
 */
export async function dispatchDegenerateReviewBackupAdvanceV1(
  input: {
    folderUri: vscode.Uri;
    workspaceUri: vscode.Uri;
    extensionUri: vscode.Uri;
    targetStage: TaskStage;
    currentStage: TaskStage;
    nextModelId: string;
    operation?: TaskOperationHandle;
    chatViewProvider?: ChatViewProvider;
  },
  deps: {
    recordActiveFallbackModel: typeof recordActiveFallbackModel;
    getWorkspaceFolder: (uri: vscode.Uri) => vscode.WorkspaceFolder | undefined;
    runReviewForFolder: typeof runReviewForFolder;
    showWarning: typeof NotificationRouter.showWarning;
  } = {
    recordActiveFallbackModel,
    getWorkspaceFolder: (uri) => vscode.workspace.getWorkspaceFolder(uri),
    runReviewForFolder,
    showWarning: (...args) => NotificationRouter.showWarning(...args),
  }
): Promise<{ dispatched: boolean }> {
  await deps.recordActiveFallbackModel(input.folderUri, input.targetStage, input.nextModelId);
  const workspaceFolder = deps.getWorkspaceFolder(input.workspaceUri);
  if (!workspaceFolder) {
    deps.showWarning(
      "A configured backup was selected to automatically retry a degenerate review, but the task's " +
        "workspace folder could not be resolved to dispatch it.",
      undefined,
      undefined,
      undefined,
      {
        command: "vs-code-ai-helper.retryReviewWithBackupV1",
        title: `Retry with ${attributionModelLabel(input.nextModelId) ?? input.nextModelId}`,
        args: [{ taskFolderPath: input.folderUri.fsPath, stage: input.targetStage, modelId: input.nextModelId }],
      }
    );
    return { dispatched: false };
  }
  await deps.runReviewForFolder(input.extensionUri, input.folderUri, workspaceFolder, input.currentStage, true, {
    preserveActiveFallback: true,
    operation: input.operation,
    chatViewProvider: input.chatViewProvider,
  });
  return { dispatched: true };
}

async function routeReviewOutcomeV1(
  outcome: TaskActionOutcomeV1,
  ctx: ReviewOutcomeContextV1
): Promise<void> {
  const {
    folderUri,
    currentStage,
    targetStage,
    reviewUri,
    reviewAttemptId,
    operation,
    chatViewProvider,
    promptLength,
    providerId,
  } = ctx;
  if (outcome.kind === "completed") {
    let transitionToTarget: StageTransitionResult | undefined;
    try {
      if (currentStage === targetStage) {
        // Re-review in place (regenerating a review while the task is
        // already on its own review stage) is not a stage "advance" —
        // nextStage.v1 only accepts a strictly-forward targetStage (§3.11),
        // and this call site never passes an expectedReviewAttemptId or
        // publishArtifact for the row to enforce anyway. Mirrors legacy
        // `advanceStage`'s same-stage short circuit as a plain no-op.
        transitionToTarget = { persisted: true, newStage: targetStage, shouldAutoReview: false };
      } else {
        const freshProgressForTransition = await readTaskProgressAdvisoryV1(folderUri);
        transitionToTarget = await advanceStageViaNextStageRowV1(
          folderUri,
          {
            ownership: freshProgressForTransition?.ownership,
            taskFolder: freshProgressForTransition?.taskFolder ?? path.basename(folderUri.fsPath),
          },
          freshProgressForTransition?.status,
          currentStage,
          targetStage,
          false,
          false
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      NotificationRouter.showWarning(`Review was generated but stage could not advance: ${message}`);
      return;
    }
    if (transitionToTarget?.persisted) {
      await safeOpenTextDocument(reviewUri, STAGE_ARTIFACT_FILENAMES[targetStage]);
      try {
        const contentBytes = await vscode.workspace.fs.readFile(reviewUri);
        const content = new TextDecoder().decode(contentBytes);
        const score = parseReadiness(content).score;
        await notifyReviewerVerifiedTicksV1(folderUri, targetStage);
        const autoAdvanceThreshold = getAutoAdvanceScoreThreshold();
        // A high score no longer implies the plan is finished. Before the
        // progress marker existed, the review prompts capped a mid-plan
        // score below the threshold, so "score >= threshold" doubled as an
        // accidental completeness gate. Removing that cap (correctly — it
        // made a clean staged task unable to ever advance) freed the score
        // to measure QUALITY, which means a flawless partial plan can score
        // 8.5 at 13 of 25 steps and silently auto-advance out of the
        // implementation stage with 12 steps unbuilt — observed live.
        // Completeness now has to be checked explicitly, here as well as in
        // reviewScoreLoop.ts's two termination paths.
        // The reviewer picks its own denominator, so its marker alone cannot
        // be trusted to mean "the plan is finished" — the plan of record's
        // checklist is the authority on what remains.
        //
        // Implementation-side stages only. A task rolled back from
        // implementation to a plan review keeps its half-finished
        // plan-final.md, and a plan review emits no progress marker of its
        // own — so reconciling here would substitute the implementation's
        // outstanding count into the plan stage, block its auto-advance, and
        // let Fast Forward grind into no-progress escalation, when returning
        // to implementation is precisely what would tick those items off.
        // The same effective-progress computation the Tasks tree renders
        // (effectiveReviewProgress.ts): raw marker for plan-review stages,
        // checklist-reconciled otherwise — strict here, so a corrupt
        // progress file still throws and notifies instead of advancing on
        // state that could not be read.
        const progress = await effectiveReviewProgressV1(folderUri, targetStage, content, "strict");
        const planIncomplete = isPlanIncomplete(progress);
        const meetsThreshold = readyToAdvanceStage(score, autoAdvanceThreshold, progress);
        // Records this round in the durable score history and decides
        // whether to keep quietly iterating, get a deliberate second
        // opinion, or escalate to the human. `escalated` is true only for
        // the second two — in that case this round just paused the task, so
        // the publish-nudge/auto-advance blocks below (which independently
        // re-derive "should this land" from the score alone) must not run:
        // decideReviewRoute can escalate even when `meetsThreshold` is true
        // (e.g. a reported blocker is still task-fixable despite the
        // score), and advancing the stage right after would, via
        // updateTaskProgressStage, silently erase the escalation this same
        // call just recorded and paused the task for.
        const { escalated, degenerateBackupAdvance } = await handleReviewRoutingOutcome({
          folderUri,
          targetStage,
          reviewAttemptId,
          content,
          score,
          threshold: autoAdvanceThreshold,
          reviewer: outcome.provider,
          promptLength,
          providerId,
          coordinatorOperationId: outcome.correlation.operationId,
          coordinatorAttemptId: outcome.correlation.attemptId,
          ...(ctx.extraCoordinatorAttemptIds?.length
            ? { coordinatorExtraAttemptIds: ctx.extraCoordinatorAttemptIds }
            : {}),
        });
        // wf10 item 7d / Part 5 step 15: an "advance" verdict means the stage
        // is configured for switch-to-backup and an untried backup exists —
        // dispatch it now, reusing the exact same sticky-fallback state
        // (fallbackActive/fallbackModelId) and preserveActiveFallback flag
        // runImplementationForModel's own cascade uses, so runReviewForFolder
        // resolves THIS model (resolveModelForStage, not
        // resolveFreshModelForStage's "always reset to primary") instead of
        // re-trying the same candidate that just produced degenerate output.
        // Returns immediately: a fresh review round is about to run and will
        // route its OWN outcome through this exact function again once it
        // completes; letting the rest of THIS (null-score, degenerate)
        // outcome's routing continue past this point would race the
        // recursive call's write to the same reviewUri for no benefit.
        if (!escalated && degenerateBackupAdvance?.kind === "advance") {
          await dispatchDegenerateReviewBackupAdvanceV1({
            folderUri,
            workspaceUri: ctx.workspaceUri,
            extensionUri: ctx.extensionUri,
            targetStage,
            currentStage,
            nextModelId: degenerateBackupAdvance.nextModelId,
            operation,
            chatViewProvider,
          });
          return;
        }
        // Publish has no further stage to auto-advance into (see the `next`
        // block below), so this is the only notification a Publish review
        // produces. Commit and Push must only ever run from the user's own
        // button click — never scheduled here — so this always just nudges
        // toward the manual action, regardless of how the review was
        // triggered.
        if (!escalated && targetStage === "publish") {
          if (meetsThreshold) {
            NotificationRouter.showWarning(
              `Review score ${score}/10 reached the auto-advance threshold. Publish manually when you're ready.`,
              undefined,
              undefined,
              undefined,
              {
                command: "vs-code-ai-helper.commitAndPushTask",
                title: "Publish",
                args: [{ taskFolderPath: folderUri.fsPath }],
              }
            );
          } else {
            NotificationRouter.showWarning(
              `Publish review scored ${score}/10, below the auto-advance threshold for ${folderUri.fsPath}. ` +
                "Publish manually once you're satisfied, or use Publish Anyway from Commit and Push.",
              undefined,
              undefined,
              undefined,
              {
                command: "vs-code-ai-helper.commitAndPushTask",
                title: "Publish Anyway",
                args: [{ taskFolderPath: folderUri.fsPath }],
              }
            );
          }
        }
        // Say WHY a high-scoring round is not advancing. Without this the
        // task looks silently stuck at a good score — indistinguishable from
        // the failure mode this whole signal exists to remove — when in fact
        // it is correctly still building the plan.
        // isAutoAdvanceEnabled(): with auto-advance off, staying on the stage
        // is simply what always happens, so announcing it as though the plan
        // held something back would be noise describing normal behavior.
        if (
          !escalated &&
          isAutoAdvanceEnabled() &&
          planIncomplete &&
          meetsAutoAdvanceThreshold(score, autoAdvanceThreshold)
        ) {
          // Names the operator-action/optional steps folded into `progress`'s
          // now-fixed denominator as settled-without-doing, so "X of Y
          // implemented" doesn't read as though the plan holds MORE
          // outstanding work than it actually does. Read lazily here — this
          // notice is the only consumer of the exclusion count, so the
          // advance path above no longer pays for it.
          const planChecklistProgress = isPlanReviewStage(targetStage)
            ? undefined
            : await readPlanChecklistProgressV1(folderUri);
          const excludedSuffix =
            planChecklistProgress && planChecklistProgress.excluded > 0
              ? ` (${planChecklistProgress.excluded} additional step(s) marked excluded from this count)`
              : "";
          // While the checklist latch is set, readPlanChecklistProgressV1
          // above returned undefined (the completeness gate is stood down),
          // so the count below is the review's own self-reported marker —
          // qualified as unverified rather than presented as a live measure
          // of remaining work (finding 3).
          const checklistCountUnverified =
            !isPlanReviewStage(targetStage) &&
            (await readTaskProgressAdvisoryV1(folderUri))?.checklistProgressUnreliable === true;
          // The `progress` reconciled above falls back to the review's own
          // raw marker while the latch is set (readEffectivePlanChecklistProgressV1
          // stands the checklist down), so `progress.complete < progress.total`
          // here reflects the REVIEW's self-reported claim, not the checklist's
          // actual state — the two can disagree (checklist fully ticked, review
          // marker stale). Read the raw checklist directly so the qualifier
          // never tells the reader to go tick items that do not exist (finding
          // 6c/11).
          const hasOutstandingChecklistItems = checklistCountUnverified
            ? ((await readPlanOfRecordV1(folderUri)).counts?.remaining ?? 0) > 0
            : true;
          NotificationRouter.showInformation(
            buildStayingOnStageNoticeV1(
              score,
              progress,
              excludedSuffix,
              checklistCountUnverified,
              hasOutstandingChecklistItems
            )
          );
        }
        if (!escalated && isAutoAdvanceEnabled() && meetsThreshold) {
          NotificationRouter.showInformation(`Review score ${score}/10 reached the auto-advance threshold. Auto-advancing stage...`);
          const configuredStages = await resolveConfiguredReviewStages(folderUri);
          const next = computeNextStage(targetStage, configuredStages);
          if (next) {
            // Advancing into "impl" must promote plan.md -> plan-final.md,
            // mirroring nextStage's manual handling below. The write itself
            // is deferred into advanceStageViaNextStageRowV1's publishArtifact
            // (nextStage.v1's beforeWrite side channel) so it only lands
            // atomically with — and only when — this review attempt actually
            // wins the CAS. Writing it eagerly here would let a stale attempt
            // that loses the race still materialize plan-final.md for a
            // transition that never happens.
            let publishArtifact: (() => Promise<void>) | undefined;
            // Set only when publishArtifact's deferred publish() call finds a
            // plan revision in flight — applied AFTER the transition below
            // has released its lock (see applyDeferredPlanRevisionAdoptionV1's
            // doc comment for why it cannot be written any earlier).
            let deferredPlanRevisionAdoption: PlanRevisionAdoptionV1 | undefined;
            if (next === "impl") {
              const promotion = await preparePlanPromotion(folderUri);
              if (!promotion.ready) {
                NotificationRouter.showWarning(
                  "Review score reached the auto-advance threshold, but there is no plan to promote. Advance to Implementation manually once a plan exists."
                );
                return;
              }
              // This closure runs as advanceStageViaNextStageRowV1's
              // beforeWrite side effect below — i.e. while nextStage.v1's own
              // patchTaskProgressStrictV1 call already holds withTaskLock for
              // this task folder. A plan-revision publish that needs its own
              // durable adoption write must defer it (never write
              // task-progress.json here — see finalizePlanRevisionBestEffortV1's
              // doc comment for why that would deadlock or silently clobber
              // the outer write's own stale-snapshot-derived write).
              const publish = promotion.publish;
              publishArtifact = publish
                ? async () => {
                    deferredPlanRevisionAdoption = await publish({ deferAdoptionWrite: true });
                  }
                : undefined;
            }
            // Re-check pause status immediately before advancing: the AI
            // review call above can run for minutes, during which the user
            // may pause the task specifically to stop automation. Passing a
            // stale/hardcoded "not paused" here would let shouldAutoReview
            // fire anyway even though the task is now paused.
            const freshProgressForAdvance = await readTaskProgressAdvisoryV1(folderUri);
            const isPausedForAdvance = freshProgressForAdvance?.status === "paused";
            const transition = await advanceStageViaNextStageRowV1(
              folderUri,
              {
                ownership: freshProgressForAdvance?.ownership,
                taskFolder: freshProgressForAdvance?.taskFolder ?? path.basename(folderUri.fsPath),
              },
              freshProgressForAdvance?.status,
              targetStage,
              next,
              isPausedForAdvance,
              true,
              reviewAttemptId,
              publishArtifact
            );
            if (transition?.persisted) {
              NotificationRouter.showInformation(`Review accepted. Advanced to ${STAGE_DISPLAY_NAMES[next]}.`);
              if (deferredPlanRevisionAdoption) {
                // Safe now: advanceStageViaNextStageRowV1's own
                // patchTaskProgressStrictV1 call has returned, so its
                // withTaskLock hold on this task folder has been released —
                // this is a separate, sequential, normally-locked write, not
                // nested inside the transition above.
                await applyDeferredPlanRevisionAdoptionV1(folderUri, deferredPlanRevisionAdoption);
              }
              // Auto-advancing into Implementation must also start the
              // implementation itself (which generates the checklist first
              // when absent). runImplementationWithAI claims the task's
              // exclusive operation lock, which this review still holds — so
              // the chain scheduler defers it until this root operation has
              // ended successfully.
              const automaticImplementationScheduled = scheduleAutomaticImplementationAfterReview(
                next,
                isAutoImplementAfterReviewEnabled(),
                folderUri.fsPath,
                operation
              );
              if (!automaticImplementationScheduled && next === "impl") {
                NotificationRouter.showInformation(
                  "Implementation is ready to start manually. Enable Automatically implement after review to run it automatically."
                );
              }
              // Auto-advancing into another review stage must itself kick off
              // that stage's review — otherwise the task silently sits on a
              // freshly-entered review stage with nothing running, which is
              // indistinguishable from auto-advance being broken. This
              // mirrors nextStage's own Step 4 (manual "Complete Stage & Move
              // On" auto-review dispatch) for the auto-advance path.
              //
              // AUTO_REVIEW_TRANSITIONS deliberately excludes any pair ending
              // on Publish (its doc comment: only a review-stage destination
              // reached FROM its immediately preceding non-review stage
              // qualifies — impl-low-review is itself a review stage, so
              // transition.shouldAutoReview is always false when landing on
              // Publish). Publish's follow-up-review dispatch is therefore
              // decided separately, directly from the auto-advance mode.
              // wf10 item 14 / Part 7 step 17: the Publish review dispatch is
              // unconditional under EITHER "auto" or "auto-fast-forward" — we
              // are only inside this branch at all when isAutoAdvanceEnabled()
              // is true, i.e. the mode is one of those two, so this is always
              // true once next === "publish". "auto" dispatches a single pass
              // (runReviewWithAI below); "auto-fast-forward" dispatches the
              // review+fix loop (fastForwardReviewWithAI), same as every other
              // landed-on review stage gets via this same block.
              const publishFollowUpReview = next === "publish";
              if (transition.shouldAutoReview || publishFollowUpReview) {
                // Deferred, never inline: the caller's tracked operation still
                // holds this task's exclusive lock, so the follow-up review is
                // scheduled through the single automation dispatcher and only
                // dispatches after that root operation ends successfully. The
                // command claims the lock itself and applies the same
                // eligibility guards as the UI button; the shared "auto-review"
                // chainId drops it if another review chain is already pending.
                const reviewCommand = getAutoAdvanceMode() === "auto-fast-forward"
                  ? "vs-code-ai-helper.fastForwardReviewWithAI"
                  : "vs-code-ai-helper.runReviewWithAI";
                // This review may itself have been dispatched under the same
                // "auto-review" chainId (e.g. nextStage's Step 4, or this
                // same handoff one stage earlier) and that outer dispatch's
                // guard slot has not settled yet — we are still inside its
                // call stack. Without releasing it first, claiming
                // "auto-review" again for the follow-up below sees its own
                // not-yet-settled predecessor as a duplicate and silently
                // drops the follow-up, leaving the task parked on the new
                // review stage with nothing running.
                //
                // Only release when we can PROVE any currently-held claim is
                // our own ancestor's bookkeeping, never a genuinely separate
                // pending chain: taskOperations enforces one exclusive root
                // operation per task, so if we are that task's current live
                // root operation, nothing else can be concurrently executing
                // a conflicting review — and a still-pending "auto-review"
                // claim can only be deferred waiting on an operation handle
                // it was given, which (`operation` being locally scoped,
                // never published anywhere else) only our own ancestor call
                // chain could have obtained. Leave a claim alone whenever
                // this can't be established (e.g. invoked directly/manually
                // with no operation handle) — the existing duplicate-chain
                // guard must keep protecting a genuinely separate pending
                // chain in that case.
                if (
                  operation &&
                  taskOperations.rootOperationIdFor(folderUri.fsPath) === operation.id
                ) {
                  releaseAutomationChain(folderUri.fsPath, "auto-review");
                }
                // wf10 item 14 / Part 7 step 17: `next === "publish"` marks
                // the ONE currentStage write this branch can produce whose
                // dispatch must not depend on how the rest of this round's
                // root operation (e.g. a chained Fast-Forward loop still
                // running further attempts, or its post-loop reporting)
                // subsequently concludes — the stage transition to Publish
                // has already landed on disk by the time we get here.
                // `dispatchEvenIfRootFails` makes the deferred dispatch fire
                // on ANY terminal root state, not only "succeeded", so a
                // root that later fails/is cancelled/is interrupted can no
                // longer silently strand Publish with its review never
                // dispatched. Every other landed-on review stage (the
                // `else` branch below) keeps the original "succeeded"-only
                // gate: those really are a continuation of this round's own
                // work, not a verification owed to an already-committed
                // transition.
                let dropReason: "duplicate-chain" | "automation-disabled" | "root-operation-unsuccessful" | undefined;
                const reviewChainScheduled = scheduleAutomationChain(
                  {
                    command: reviewCommand,
                    arg: {
                      taskFolderPath: folderUri.fsPath,
                    },
                    taskKey: folderUri.fsPath,
                    chainId: "auto-review",
                    // Dropped at fire time if auto-advance was turned off
                    // while this chain waited for the root operation to end.
                    //
                    // wf10 item 14 / Part 7 step 17 (review completion
                    // blocker, 2026-08-24): for `next === "publish"` this
                    // must NOT re-read isAutoAdvanceEnabled() at fire time.
                    // The stage transition to Publish has already committed
                    // to disk above (`transition?.persisted`) while auto-
                    // advance was on — the review is now an owed
                    // verification of a landed transition, not a
                    // continuation contingent on the setting staying on.
                    // Toggling the setting off afterward must not cancel it,
                    // the same way dispatchEvenIfRootFails already stops a
                    // root-operation failure from cancelling it. A plain
                    // review-to-review handoff (the non-publish branch) is
                    // still a genuine continuation of this round's own work,
                    // so it keeps the live recheck.
                    stillEnabled: next === "publish" ? () => true : () => isAutoAdvanceEnabled(),
                    dispatchEvenIfRootFails: next === "publish",
                    onDropped: (reason) => {
                      dropReason = reason;
                    },
                    intent: {
                      trigger: "auto-review after advancing to the next stage",
                      settingKey: "ensemble.autoAdvanceEnabled",
                      expectedTiming: "once this stage's operation lock releases",
                      willRetry: false,
                      retryNote: "Not retried automatically if dropped — run the review manually.",
                    },
                  },
                  operation
                );
                if (next === "publish") {
                  // Of the three drop reasons, only "duplicate-chain" can
                  // still occur here (wf10 item 2 / Part 7 step 17): the
                  // `stillEnabled` override above makes "automation-disabled"
                  // unreachable for Publish (turning auto-advance off after
                  // the transition already committed must not cancel the
                  // owed review), and `dispatchEvenIfRootFails` makes
                  // "root-operation-unsuccessful" unreachable too. Both are
                  // still handled below, defensively, in case that ever
                  // changes.
                  void reviewChainScheduled.then((scheduled) => {
                    if (!scheduled) {
                      const reasonText =
                        dropReason === "automation-disabled"
                          ? "auto-advance was turned off before the review could start"
                          : "another review is already in progress for this task";
                      NotificationRouter.showWarning(
                        `${folderUri.fsPath}: the follow-up Publish review could not be started automatically because ${reasonText}. ` +
                          "Run the review manually once it finishes, or use Publish Anyway from Commit and Push.",
                        undefined,
                        undefined,
                        undefined,
                        {
                          command: "vs-code-ai-helper.commitAndPushTask",
                          title: "Publish Anyway",
                          args: [{ taskFolderPath: folderUri.fsPath }],
                        }
                      );
                    }
                  });
                } else {
                  // A plain review-to-review handoff (e.g. plan-high-review ->
                  // plan-low-review) — still warn if it was dropped, or the
                  // task is silently left parked on the new review stage
                  // with nothing running and no way for the user to notice.
                  void reviewChainScheduled.then((scheduled) => {
                    if (!scheduled) {
                      NotificationRouter.showWarning(
                        `Auto-advance reached ${STAGE_DISPLAY_NAMES[next]} for ${folderUri.fsPath}, but its review could not be started automatically because another review is already in progress for this task. Run the review manually.`
                      );
                    }
                  });
                }
              }
              // wf10 item 14 / Part 7 step 17: previously this branch nudged
              // the user to publish manually whenever `next === "publish"` in
              // plain "auto" mode (publishFollowUpReview was gated to
              // "auto-fast-forward" only). Publish dispatch is now
              // unconditional across both auto-advance modes (above), so that
              // manual-nudge path is unreachable here and has been removed —
              // if the automatic dispatch itself cannot run, the drop-reason
              // warning with the "Publish Anyway" affordance above already
              // covers it.
            }
          }
          // Publish has no further stage for computeNextStage to return, so
          // `next` is always falsy here when targetStage is "publish" — the
          // Publish-review nudge for that case runs above (the `!escalated
          // && targetStage === "publish"` block), independent of
          // isAutoAdvanceEnabled().
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const isPublishReview = targetStage === "publish";
        NotificationRouter.showWarning(
          `Review was published, but auto-advancing past the score threshold failed: ${message}. ` +
            "Advance the stage manually." +
            (isPublishReview ? " Publish manually once you're satisfied, or use Publish Anyway from Commit and Push." : ""),
          undefined,
          undefined,
          undefined,
          isPublishReview
            ? {
                command: "vs-code-ai-helper.commitAndPushTask",
                title: "Publish Anyway",
                args: [{ taskFolderPath: folderUri.fsPath }],
              }
            : undefined
        );
      }
    } else {
      // Defensive only: both branches above that set transitionToTarget
      // either produce persisted:true or throw (caught above), so this is
      // never actually reached today — kept so a falling-through silent
      // failure is never left with no indication the review artifact/stage
      // transition failed to persist.
      NotificationRouter.showWarning(
        `The review for ${folderUri.fsPath} was generated but could not be recorded. Try running the review again.`
      );
    }
  } else if (outcome.kind === "questions") {
    if (chatViewProvider) {
      const orchestrator = getProductionActionConversationOrchestratorV1();
      const record = await orchestrator.getRecord({
        operationId: outcome.correlation.operationId,
        interactionId: outcome.interactionId,
        taskBindingId: outcome.correlation.taskBindingId,
        chatDocumentId: outcome.correlation.chatDocumentId,
        sourceAttemptId: outcome.correlation.attemptId,
      });
      if (record) {
        await chatViewProvider.askInteraction({
          canonicalId: folderUri.fsPath,
          taskFolderPath: folderUri.fsPath,
          stage: record.stage,
          interactionId: record.interactionId,
          operationId: record.correlation.operationId,
          actionKey: record.correlation.actionKey,
          sourceAttemptId: record.correlation.attemptId,
          // safe: this call site only loads a record already known (via a
          // "questions" outcome or an existing unresolved interaction) to
          // carry posted questions — never invocationPending.
          questions: record.questions!,
          binding: {
            taskBindingId: record.correlation.taskBindingId,
            chatDocumentId: record.correlation.chatDocumentId,
          },
        });
      }
    }
  } else if (outcome.kind === "unavailable" && outcome.chainExhaustion !== undefined) {
    // The stage's ENTIRE provider chain was exhausted (finding 4): a hard
    // failure, never silence. The stage owner — this handler, which
    // dispatched the round — marks the task paused with a reason naming the
    // exhausted chain and bumps updatedAt, so the task stops presenting as
    // "active and busy" while nothing can possibly run. The enriched run
    // record (per-candidate reasons) is written by writeReviewRunLogV1 in
    // the caller's finally block.
    //
    // Checked BEFORE the Publish special case below: every review stage —
    // Publish included — pauses on an exhausted chain. The generic Publish
    // branch used to capture every non-completed outcome first, so a
    // Publish-stage exhaustion produced only the Publish Anyway nudge while
    // the task stayed "active" with nothing able to run.
    await pauseTaskForExhaustedChainV1(folderUri, targetStage, outcome.chainExhaustion, outcome.code);
  } else if (targetStage === "publish") {
    // The Publish review failed, was cancelled, or was stalled. Give the
    // user a one-click path to publish anyway instead of only a dead-end
    // error.
    NotificationRouter.showWarning(
      `${folderUri.fsPath}: the Publish review did not complete successfully. ` +
        "Publish manually once you're satisfied, or use Publish Anyway from Commit and Push.",
      undefined,
      undefined,
      undefined,
      {
        command: "vs-code-ai-helper.commitAndPushTask",
        title: "Publish Anyway",
        args: [{ taskFolderPath: folderUri.fsPath }],
      }
    );
  } else if (outcome.kind === "cancelled") {
    NotificationRouter.showInformation(
      `${STAGE_DISPLAY_NAMES[targetStage]} cancelled.`
    );
  } else {
    // Every remaining outcome (failed, malformedResult, unavailable,
    // recoveryRequired, duplicateRejected, stalePreflight,
    // partialEditBlocked) is a real failure the user must be told about.
    //
    // This branch previously did not exist: only "completed", "questions",
    // and the Publish-stage special case above were handled, so a failed
    // review on ANY other review stage fell through the whole chain and
    // this function returned having shown nothing at all. Combined with the
    // run log below (also absent before) and the no-op progress terminator
    // in productionTaskActionRuntimeV1.ts, that is what made a failed review
    // present as a stuck "Running review…" row with no error, no artifact,
    // and no explanation anywhere except a console.log the user never sees.
    // Names the settlement inline rather than pointing at the run log for
    // "the prompt": the log records the sanitized outcome only. The rendered
    // prompt is deliberately NOT written here — it embeds the full context
    // pack, and this handler receives no prompt to log anyway (unlike
    // generatePlanWithAI, which has ctx.prompt in scope).
    NotificationRouter.showError(
      `${STAGE_DISPLAY_NAMES[targetStage]} failed: ${describeTaskActionFailureV1(outcome)}. ` +
        "The run log under runs/ records this settlement."
    );
  }
}

/**
 * Pause a task whose stage cannot acquire ANY provider (finding 4): the
 * durable state must say WHY nothing is running — `status: "paused"` plus a
 * `pausedReason` naming the stage and the exhausted chain, with `updatedAt`
 * bumped — instead of the task sitting "active" while its only record is a
 * run file nobody is watching. Shared by the runtime exhaustion path
 * (routeReviewOutcomeV1) and the dispatch-site pre-flight, so both produce
 * identical durable state.
 *
 * **Classification: case 3** (module header, workflowDecisionV1.ts) —
 * several valid options exist (retry now, adjust the provider chain, wait for
 * a known quota/entitlement reset, or stay paused) and none is automatically
 * correct: the recommendation below is derived from the parked
 * `quotaParkRecord` and how far off its reset is, but the system cannot know
 * WHY a given provider is unavailable beyond that classification, so this
 * posts a `WorkflowDecisionV1` rather than acting unprompted.
 *
 * @internal exported for testing
 */
export async function pauseTaskForExhaustedChainV1(
  folderUri: vscode.Uri,
  stage: TaskStage,
  exhaustion: ProviderChainExhaustionV1,
  /**
   * `candidatesExhausted` (every candidate was reserved, invoked, and
   * failed) vs. `providerModeUnavailable` (nothing was ever reserved) —
   * workflow 3 continuation, third item. Optional and defaults to the
   * "no provider available" wording for callers (and existing tests) that
   * have not been threaded through with the distinguishing code yet.
   */
  code?: WorkflowUnavailableCodeV1
): Promise<void> {
  const stageName = exhaustion.stage ?? stage;
  const chain =
    exhaustion.candidates.length > 0
      ? exhaustion.candidates.map((candidate) => candidate.providerLabel).join(" → ")
      : "no candidates configured";
  // Review completion blocker: a chain exhausted because every ranked
  // candidate hit a quota or model-entitlement block previously paused the
  // task with only the human-readable `reason` text — no `quotaParkRecord`,
  // so the settings quota view and a later notification had no durable
  // "when might this resume" state to read, unlike the withheld-backup path
  // in runnerRegistry.ts which already records one. Scan the ranked
  // candidates (same order they were attempted) for the first one whose
  // recorded skip/failure reason classifies as quota/entitlement, and park
  // the same shape of record for it. Computed BEFORE `reason` below (moved up
  // from its former position after `reason`) so a monthly/hard billing-limit
  // block — e.g. Copilot's "You've reached your monthly credit limit" or a
  // devpass premium-tier weekly ceiling, both matched by classifyFailure's
  // "credit limit"/"usage limit" markers — can be named plainly instead of
  // folding into the same generic "tried and failed" sentence every other
  // candidatesExhausted cause used (item 3b/companion finding, 2026-08-17/18:
  // several rounds of real spend were spent before the cause was legible).
  const quotaCandidate = exhaustion.candidates
    .map((candidate) => ({ candidate, classified: classifyFailure({ errorMessage: candidate.reason }) }))
    .find(
      ({ classified }) =>
        classified.failureKind === "quota" || classified.failureKind === "model-entitlement"
    );
  const quotaParkRecord: QuotaParkRecordV1 | undefined = quotaCandidate
    ? {
        modelId: quotaCandidate.candidate.storedModelId,
        providerId: quotaCandidate.candidate.runnerId,
        accountKey: resolveQuotaAccountKeyV1(quotaCandidate.candidate.storedModelId),
        failureKind: quotaCandidate.classified.failureKind as "quota" | "model-entitlement",
        resetAt: parseQuotaResetV1(quotaCandidate.candidate.reason, new Date()),
        observedAt: new Date().toISOString(),
      }
    : undefined;
  const reason =
    code === "candidatesExhausted" && quotaCandidate !== undefined
      ? `Every configured model for ${stageName} was tried, but the chain was blocked by a ` +
        `${quotaCandidate.classified.failureKind === "quota" ? "quota/credit-limit" : "model-entitlement"} restriction on ` +
        `${quotaCandidate.candidate.providerLabel} — this is a provider account limit, not a transport or code ` +
        `fault (${quotaCandidate.candidate.reason}). See the run log for the remaining per-candidate reasons.`
      : code === "candidatesExhausted"
        ? `Every configured model for ${stageName} was tried and failed — ` +
          `the resolved chain was exhausted (${chain}). ` +
          "See the run log for per-candidate reasons."
        : `No configured provider for ${stageName} is available — ` +
          `the resolved chain was exhausted (${chain}). ` +
          "See the run log for per-candidate reasons.";
  await patchTaskProgressStrictV1(folderUri, (current) =>
    pauseTaskWithReason(current, reason, quotaParkRecord)
  );
  // Review completion blocker: this path parked the task with a durable
  // quotaParkRecord (including resetAt when known) but never offered the
  // same "Rerun after reset" action the withheld-backup cascade offers in
  // runnerRegistry.ts — so a chain-exhaustion park was NOT actually a timed,
  // actionable recovery, only the generic "fix it yourself" text below.
  // Gated to a near reset the same way the cascade path is: a far reset
  // (beyond ensemble.resilience.quotaResetNearThresholdHours) should advise
  // switching the stage's model instead of implying a scheduled rerun is
  // useful before the window actually reopens.
  const resetIsFar =
    quotaParkRecord?.resetAt !== undefined && isQuotaResetBeyondThresholdV1(quotaParkRecord.resetAt);
  // Workflow 3 continuation, first item (Part 6 step 4): mirrors the same
  // stage-impact enumeration the withheld-backup cascade in runnerRegistry.ts
  // already carries — a chain exhaustion caused by a long quota/entitlement
  // outage is just as likely to silently affect every OTHER stage primary'd
  // to the same blocked provider account, and this path previously never
  // said so.
  const affectedStageDescriptions =
    resetIsFar && quotaParkRecord
      ? describeStageSubstitutesV1(quotaParkRecord.modelId, stage)
      : [];

  const options: WorkflowDecisionOptionV1[] = [
    {
      optionId: "retry",
      label: "Retry now",
      consequence:
        "Unpauses the task. This does not automatically rerun the stage — trigger it again yourself once " +
        "you believe the provider chain can succeed.",
      effect: { kind: "command", command: "vs-code-ai-helper.resumeTask", args: [{ taskFolderPath: folderUri.fsPath }] },
    },
    {
      optionId: "adjustSettings",
      label: "Adjust provider settings",
      consequence: `Opens Settings focused on ${STAGE_DISPLAY_NAMES[stage]}'s model/backup configuration so you can switch providers or models.`,
      effect: { kind: "command", command: "vs-code-ai-helper.setStageBackupModel", args: [{ stage }] },
    },
    ...(quotaParkRecord?.resetAt !== undefined
      ? [
          {
            optionId: "wait",
            label: "Wait for reset",
            consequence:
              `Schedules an automatic rerun shortly after the ${quotaParkRecord.failureKind} resets at ` +
              `${quotaParkRecord.resetAt}. The task stays paused until then.`,
            effect: {
              kind: "command" as const,
              command: "vs-code-ai-helper.scheduleQuotaResumeV1",
              args: [{ taskFolderPath: folderUri.fsPath, resetAtIso: quotaParkRecord.resetAt }],
            },
          },
        ]
      : []),
    {
      optionId: "stay",
      label: "Leave paused",
      consequence: "Does nothing. The task stays paused until you choose one of the other options.",
      effect: { kind: "doNothing" },
    },
  ];

  const recommendation: WorkflowDecisionRecommendationV1 =
    quotaParkRecord?.resetAt !== undefined && !resetIsFar
      ? {
          kind: "option",
          optionId: "wait",
          reasoning: `The ${quotaParkRecord.failureKind} is known to reset at ${quotaParkRecord.resetAt}, so waiting is likely to succeed without changing anything.`,
        }
      : quotaParkRecord !== undefined
        ? {
            kind: "option",
            optionId: "adjustSettings",
            reasoning:
              quotaParkRecord.resetAt !== undefined
                ? `The ${quotaParkRecord.failureKind} reset is far enough off that switching providers is more likely to unblock the task than waiting.`
                : `The ${quotaParkRecord.failureKind} block has no known reset time, so switching providers is more likely to unblock the task than waiting.`,
          }
        : {
            kind: "none",
            reasoning:
              "The chain was exhausted for reasons other than a known quota/entitlement block, so there is no " +
              "clear signal to prefer retrying, adjusting settings, or waiting.",
          };

  const target: ChatTarget = { canonicalId: folderUri.fsPath, taskFolderPath: folderUri.fsPath, stage };
  const decision = await postWorkflowDecisionV1(
    {
      decisionKey: "providerChainExhausted",
      taskCanonicalId: folderUri.fsPath,
      stage,
      whatHappened: `${reason} The task has been paused.` + (affectedStageDescriptions.length > 0 ? ` This also affects: ${affectedStageDescriptions.join("; ")}.` : ""),
      whyUserNeeded:
        "The system cannot fix an exhausted provider chain on its own — you may already know why it failed " +
        "(a known outage, a misconfigured model) in a way the code cannot detect.",
      options,
      recommendation,
      gating: {
        holdsTaskPaused: true,
        unblocksProgress: true,
        detail:
          "This decision is what is holding the task paused. \"Retry now\" resumes the task immediately (it " +
          "still will not rerun the stage for you). \"Adjust provider settings\" opens Settings but does not " +
          "resume the task by itself — pick Retry or Wait for reset afterward." +
          (quotaParkRecord?.resetAt !== undefined
            ? ` "Wait for reset" keeps the task paused but schedules an automatic retry at ${quotaParkRecord.resetAt}.`
            : "") +
          " \"Leave paused\" does nothing and the task stays paused until you choose one of the other options.",
      },
    },
    target
  );
  if (!decision) {
    NotificationRouter.showWarning(`⚠️ ${reason} The task has been paused; fix provider availability or the stage's model configuration, then resume.`);
  }
}

export async function runReviewForFolder(
  extensionUri: vscode.Uri,
  folderUri: vscode.Uri,
  workspaceRoot: vscode.WorkspaceFolder,
  currentStage: TaskStage,
  _skipOverwriteConfirmation: boolean,  // kept for API compat, always skipped now
  options: {
    preserveActiveFallback?: boolean;
    /**
     * The tracked operation this review runs under. The auto-advance tail
     * below registers its follow-up review as a CHILD of it — claiming a new
     * exclusive lock there while the caller still holds this one would refuse
     * itself and surface a spurious "Review is already in progress" warning
     * instead of starting the next stage's review (the reported auto-advance
     * defect).
     */
    operation?: TaskOperationHandle;
    /** Routes `review.v1` structured questions into Chat With AI. */
    chatViewProvider?: ChatViewProvider;
  } = {}
): Promise<void> {
  const targetStage = REVIEW_TARGETS[currentStage];
  const reviewUri = targetStage && artifactUri(folderUri, targetStage);
  if (!targetStage || !reviewUri) {
    return;
  }

  const variables: Record<string, string> = {};
  const isPlanReview = isPlanReviewStage(targetStage);
  // Captured (publish stage only) when the entry-point freshness gate below
  // accepts a stamp, and carried all the way to the CAS write so
  // `promoteReviewContentV1` can re-check it immediately before promotion.
  let publishFreshnessGuard: PublishReviewFreshnessGuardV1 | undefined;
  const previousReview =
    currentStage === targetStage
      ? await readPreviousReviewForRereview(reviewUri)
      : undefined;
  const templateFile = selectReviewPromptTemplate(
    targetStage,
    currentStage,
    previousReview
  );
  if (!templateFile) {
    return;
  }
  if (previousReview !== undefined) {
    variables.previousReview = previousReview;
    // Part 10: give this re-review the prior round's ID'd blocker list so it
    // can declare lineage (`[same:<id>]` / `[narrowed:<id>]` / `[new]`)
    // against something concrete, rather than inventing ids or citing
    // nothing. Read once here (not just inside the impl-review branch below)
    // so plan re-reviews get it too.
    const priorHistoryForLineage = (await readTaskProgressAdvisoryV1(folderUri))?.reviewScoreHistory;
    const priorEntryForLineage = [...(priorHistoryForLineage ?? [])]
      .reverse()
      .find((entry) => entry.stage === targetStage);
    // wf10 continuation item 18 (review blocker, 2026-08-27): include the
    // prior round's SUPERSEDED (plan-non-goal-challenged) blockers alongside
    // its outstanding ones. A challenged blocker never appears in `blockers`
    // (it isn't outstanding), so without this the reviewer has no id to cite
    // if it re-raises the same issue next round — every re-raise would mint
    // a fresh, unlinkable id even though the underlying blocker is identical.
    variables.priorBlockerLineageList = formatPriorBlockerLineageListV1([
      ...(priorEntryForLineage?.blockers ?? []),
      ...(priorEntryForLineage?.supersededBlockers ?? []),
    ]);
  }

  // 2i: stamp the commit this review actually assesses, and — for a
  // re-review — decide whether the previous review is still close enough to
  // HEAD to reconcile against directly or has gone stale enough that the
  // reviewer should derive current state from the workspace instead. Scoped
  // to implementation/publish review stages (REVIEWED_COMMIT_STAGES); plan
  // reviews don't use either variable so this is a harmless no-op for them.
  if (REVIEWED_COMMIT_STAGES.has(targetStage)) {
    const headSha = await resolveHeadCommitSha(workspaceRoot.uri.fsPath);
    variables.reviewedCommitSha = headSha ?? "unknown";
    if (previousReview !== undefined) {
      // The previous review is about to be reconciled against — or superseded.
      // If its recorded commit has fallen behind HEAD, its on-disk copy must
      // carry the stale banner (review freshness follow-up): when the re-review
      // succeeds the fresh artifact replaces it banner-free, and when it fails
      // the old review remains, now correctly marked. Reuses the HEAD resolved
      // above — no extra git call. Best-effort: a courtesy marker must never
      // block the re-review itself.
      //
      // Gated on the translated active-run signal: this run's own
      // taskOperations entry is already registered by the caller at this
      // point, so this heals nothing while a rerun of this same review stage
      // is genuinely in flight — the post-claim marking below will shortly
      // overwrite the banner to its in-progress form anyway, and healing it
      // to stale here first would let a mid-run `viewReview` open see the
      // very "stale" wording this whole feature exists to replace.
      if (!isReviewActivelyRerunningV1(folderUri.fsPath, targetStage)) {
        try {
          await refreshStaleReviewBannerForArtifactV1(reviewUri, headSha);
        } catch {
          // Marker only — proceed with the review regardless.
        }
      }
      variables.reconciliationInstruction = await selectReconciliationInstruction(
        targetStage,
        previousReview,
        workspaceRoot.uri.fsPath
      );
    }
  }

  if (isPlanReview) {
    const planUri = await resolveCurrentPlanUri(folderUri);
    const planContent = await readNonEmptyText(planUri);
    if (!planContent) {
      NotificationRouter.showWarning(
        stageActionRequirementMessageV1("reviewPlan", 0)
      );
      return;
    }
    variables.plan = planContent;
  } else {
    const freshnessGate = await requirePublishChecksFreshnessOrWarnV1(folderUri, targetStage);
    if (!freshnessGate.ok) {
      return;
    }
    publishFreshnessGuard = freshnessGate.guard;
    // Implementation reviews need two distinct artifacts:
    //
    //   {{plan}} — the plan the implementation was supposed to follow.
    //     Source: plan.md (resolveCurrentPlanUri), NOT plan-final.md.
    //     Using plan-final.md here would inject implementation notes into
    //     both slots and the reviewer would compare the same text against
    //     itself.
    //
    //   {{implementation}} — the run summary / implementation notes.
    //     Source: impl-summary.md, then plan-final.md, then implementation.md
    //     (readImplementationReviewContent). executeImplementationRun writes
    //     each completed run's summary to impl-summary.md; it no longer writes
    //     over plan-final.md, which is the plan of record.
    //
    //     The plan-final.md step is not only a legacy path: a task whose
    //     implementation ran before the summary split had its run summary
    //     written there, and a task that has only been promoted (no run yet)
    //     has its checklist there. Both are better {{implementation}} content
    //     than nothing, and both still differ from {{plan}}.

    const planUri = await resolveCurrentPlanUri(folderUri);
    const planContent = await readNonEmptyText(planUri);
    if (!planContent) {
      NotificationRouter.showWarning(
        stageActionRequirementMessageV1("reviewImplementation", 0)
      );
      return;
    }

    // Read-only: never materialize any implementation artifact here. This
    // function only reads content to build a review prompt — a review that is
    // later cancelled, fails, or returns questions must leave every
    // implementation artifact byte-identical. Eagerly writing plan-final.md as
    // a side effect of preparing a prompt was the same defect already fixed in
    // generateImplementationWithAI; this ordered fallback read mirrors that fix
    // instead of reusing the writing materializeCanonicalIfNeeded.
    const implementationContent = await readImplementationReviewContent(folderUri);
    if (!implementationContent) {
      NotificationRouter.showWarning(
        stageActionRequirementMessageV1("reviewImplementation", 1)
      );
      return;
    }
    // The last round changed files but returned nothing reviewable. Every
    // review entry point refuses here — not just the automated follow-up the
    // run itself declined to dispatch — because the alternative is reviewing
    // an earlier round's notes against a tree they no longer describe.
    if (isUnusableImplementationSummaryV1(implementationContent)) {
      NotificationRouter.showWarning(
        "The last implementation round did not produce usable implementation notes, so there is " +
          `nothing to review it against (see ${IMPLEMENTATION_SUMMARY_FILENAME} and the run log). ` +
          "Run the implementation step again to produce them."
      );
      return;
    }

    variables.plan = planContent;
    variables.implementation = implementationContent;
    // wf10 continuation item 18: `{{plan}}` above is `plan.md`, not
    // `plan-final.md` (see the comment block above this branch) — a plan's
    // `## Accepted Non-Goals` section, added to `plan-final.md` AFTER
    // promotion, never reaches the reviewer through `{{plan}}` or (unless
    // `impl-summary.md` is absent) `{{implementation}}`. These two variables
    // are the explicit channel: read `plan-final.md` directly rather than
    // relying on either fallback chain to happen to carry it.
    if (IMPL_REVIEW_STAGES_V1.includes(targetStage)) {
      try {
        const planFinalContent = (await readPlanOfRecordV1(folderUri)).text;
        variables.acceptedNonGoals = formatAcceptedNonGoalsVariableV1(
          planFinalContent ? parseAcceptedNonGoalsV1(planFinalContent) : []
        );
      } catch {
        variables.acceptedNonGoals = formatAcceptedNonGoalsVariableV1([]);
      }
      try {
        const currentProgress = await readTaskProgressAdvisoryV1(folderUri);
        variables.ownerDecisions = formatOwnerDecisionsVariableV1(
          targetStage,
          currentProgress?.blockerSupersessions
        );
      } catch {
        variables.ownerDecisions = formatOwnerDecisionsVariableV1(targetStage, undefined);
      }
    }
    const checks = await buildVerifiedChecksVariable(
      folderUri,
      undefined,
      options.operation?.token,
      targetStage === "publish",
      targetStage,
      variables.reviewedCommitSha
    );
    variables.verifiedChecks = checks.verifiedChecks;
    if (checks.planItemVerification !== undefined) {
      variables.planItemVerification = checks.planItemVerification;
    }
    setMechanicalBlockersForStage(folderUri, targetStage, checks.mechanicalBlockers);
    if (targetStage === "publish") {
      variables.siblingReviewDisagreement = await buildSiblingReviewDisagreementVariable(
        folderUri,
        variables.reviewedCommitSha
      );
    }
  }

  let contextPackContent: string;
  if (isPlanReview) {
    const contextPackUri = await writeContextPack(folderUri, workspaceRoot.uri, false);
    contextPackContent = new TextDecoder().decode(
      await vscode.workspace.fs.readFile(contextPackUri)
    );
  } else {
    const taskProgress = await readTaskProgressAdvisoryV1(folderUri);
    // Item 15 fix 4: prioritise files a standing blocker on the review being
    // re-run actually names, so the pack's size caps (which spend budget in
    // list order — applyContentCaps) truncate or omit them last rather than
    // an arbitrary casualty of `implReviewFiles` ordering.
    const priorityRelPaths =
      previousReview !== undefined
        ? extractBlockerNamedPathsV1(parseReviewBlockers(previousReview))
        : undefined;
    // Anchor changed-region excerpts to the commit the PREVIOUS round of
    // this same review actually assessed (2i's marker), not just the latest
    // commit touching each file — see computeChangedLineRangesForFileV1's
    // doc comment for why that distinction matters across multi-commit tasks.
    // A re-review anchors to the PREVIOUS round of this same review's own
    // marker (2i). A task's first review (or a review whose previous round
    // predates the 2i marker) has none — fall back to the commit snapshotted
    // before this task's first implementation round ran (see
    // taskImplementationBaselineV1.ts), so the excerpt still covers every
    // committed round since the task began rather than just the latest
    // commit touching each file.
    const baselineSha =
      (previousReview !== undefined ? parseReviewedCommitSha(previousReview) : undefined) ??
      (await readTaskImplementationBaselineShaV1(folderUri));
    const { contextPackUri, isFallback } = await writeImplReviewContextPack(
      folderUri,
      workspaceRoot.uri,
      taskProgress?.implReviewFiles,
      priorityRelPaths,
      baselineSha
    );
    if (isFallback) {
      NotificationRouter.showWarning(
        "No tracked implementation file set found for this task. " +
          "The review will be based on currently open editors. " +
          "For best results, open the files you changed before running the review."
      );
    }
    contextPackContent = new TextDecoder().decode(
      await vscode.workspace.fs.readFile(contextPackUri)
    );
  }
  variables.contextPack = contextPackContent;

  // Claim the stage before starting the provider call. The token is checked
  // again by the transition CAS, so a late result can never advance a newer
  // run — passed through to runAiToFile as reviewAttemptId as well, which
  // additionally re-checks it between content-validation backup retries so a
  // superseded attempt stops spending quota on backups well before it would
  // eventually lose that final CAS anyway.
  const reviewAttemptId = crypto.randomUUID();
  const claimed = await claimReviewAttempt(folderUri, reviewAttemptId, targetStage);
  if (!claimed) return;

  // Part 2 (review status messaging): mark the artifact "in progress" now
  // that this attempt has genuinely won the claim, and before the provider
  // call — see beginInProgressReviewMarkingV1's doc comment. Reverted in the
  // `finally` below on every non-success exit (refusal, failure, thrown
  // error, cancellation), gated on this attempt still being current so a
  // late failure from a superseded attempt can never clobber a newer one's
  // marking or its completed review.
  const inProgressMarking = await beginInProgressReviewMarkingV1(reviewUri);
  let reviewSucceeded = false;
  try {
    assertLegacyAiRouteAllowedV0("review.v1");

    const prompt = await renderPromptTemplate(extensionUri, templateFile, variables);
    // wf10 review fix (Part 6 step 16): `promptCeilingAdvisoryV1` compares
    // this against provider Read-tool ceilings that are themselves measured
    // in bytes (see its own doc comment) — `prompt.length` is a JS UTF-16
    // code-unit count, not a byte count, and silently under-reports for any
    // prompt containing multi-byte UTF-8 content (non-ASCII plan/review
    // text, emoji, etc.), which would let an over-ceiling prompt pass the
    // advisory unflagged. Same convention as cliAgentRunner.ts's own
    // `promptBytes`.
    const promptByteLength = Buffer.byteLength(prompt, "utf8");

    const rootId = ensureWorkflowTaskFolderRootV1(folderUri.fsPath);
    const verifiedBindingId = getVerifiedTaskBindingIdV1(rootId);
    if (!verifiedBindingId) {
      throw new Error("Task ownership binding could not be verified.");
    }
    const chatIdentity = await readChatDocumentIdentityV1(folderUri.fsPath, folderUri.fsPath);
    const chatDocumentId = chatIdentity?.documentId ?? allocateHex128IdV1();

    // wf10 item 7d / Part 5 step 15: `preserveActiveFallback` (set only by
    // the automatic degenerate-review backup-advance re-dispatch just above,
    // and by applyImplementationReviewWithAI's own follow-up review) must
    // resolve THIS stage's sticky fallback candidate (`resolveModelForStage`,
    // which honors `fallbackActive`/`fallbackModelId`) rather than
    // `resolveFreshModelForStage`'s "always reset to primary" — otherwise the
    // model just recorded as the active fallback a moment ago would be
    // discarded immediately and this call would simply retry the same
    // primary the cascade is trying to get away from. Every other caller
    // (a user-invoked fresh review) is unaffected: it never sets this flag,
    // so it keeps retrying the primary first, exactly as before.
    const { modelId } = options.preserveActiveFallback
      ? await resolveModelForStage(folderUri, targetStage)
      : await resolveFreshModelForStage(folderUri, targetStage);
    if (!modelId) {
      NotificationRouter.showWarning("No model is configured for this stage.");
      // 2026-08-27 review, blocker "review rows never attach the coordinator
      // operation or provider attempt identities": this early return happens
      // BEFORE `coordinator.executeAction` is ever called, so `handleReviewOutcomeV1`
      // (and its `terminalizeUnclosedReviewRoundV1` safety net) never runs —
      // left alone, the row `claimReviewAttempt` opened above would stay
      // "open" until the still-unbuilt reconciliation sweep exists at all.
      // No coordinator correlation exists yet either, so this closes the row
      // under its own `reviewAttemptId` alone.
      await terminalizeRoundV1(reviewAttemptId, "failed", undefined, { taskFolderUri: folderUri });
      return;
    }

    // wf10 item 7c / Part 6 step 16: resolve which provider this round will
    // actually dispatch to, so a degenerate rejection's run log can name a
    // known Read-tool ceiling if exceeded, and so an oversized prompt gets a
    // dispatch-time advisory before burning the round on a provider known to
    // truncate it silently. Advisory only — never blocks dispatch, since the
    // ceiling is token-based/variable and this prompt is measured in bytes.
    const dispatchProviderId = (() => {
      try {
        const effective = resolveEffectiveProvider(modelId);
        return effective.kind === "cli" ? effective.def.id : undefined;
      } catch {
        return undefined;
      }
    })();
    const dispatchCeilingAdvisory = promptCeilingAdvisoryV1(promptByteLength, dispatchProviderId);
    // The advisory alone was not enough (jester, 2026-08-28): it fired
    // correctly before dispatch, was shown as a warning, and the round ran on
    // the over-ceiling provider regardless — producing a 154-byte degenerate
    // review that was rejected AND overwrote the stage's previous accepted
    // one. Not refusing is right (the ceiling is token-based and variable),
    // but when the configured chain already offers a candidate the prompt
    // fits, preferring it costs nothing: the skipped candidate keeps its
    // place for every future round whose prompt is within its ceiling.
    const ceilingPreferredModelId =
      dispatchCeilingAdvisory === undefined
        ? undefined
        : preferCandidateWithinReadCeilingV1(
            rankedStageChainStoredIdsV1(targetStage, modelId),
            promptByteLength,
            (storedModelId) => {
              try {
                const effective = resolveEffectiveProvider(storedModelId);
                return effective.kind === "cli" ? effective.def.id : undefined;
              } catch {
                return undefined;
              }
            }
          );
    // What this round actually dispatches to. Only ever differs from the
    // stage's configured primary when that primary's known ceiling is
    // exceeded AND a configured backup's is not; the stored configuration is
    // never written to.
    const dispatchModelId = ceilingPreferredModelId ?? modelId;
    options.operation?.setModel?.(dispatchModelId);
    if (dispatchCeilingAdvisory !== undefined) {
      NotificationRouter.showWarning(
        `${STAGE_DISPLAY_NAMES[targetStage]}: ${dispatchCeilingAdvisory}` +
          (ceilingPreferredModelId !== undefined
            ? ` Using ${attributionModelLabel(ceilingPreferredModelId) ?? ceilingPreferredModelId} for this round instead.`
            : "")
      );
    }

    // Pre-flight the stage's resolved provider chain BEFORE burning a round
    // (finding 4's second fix): an unavailable-provider stall is predictable —
    // the chain is known ahead of time — so a chain whose every candidate
    // fails a safely probeable availability check reports "no configured
    // provider for <stage> is available" here, producing the same paused
    // outcome and enriched run record the runtime exhaustion path writes,
    // without dispatching anything. Probe timeouts fail open to dispatch; a
    // probe-available/invoke-fail candidate still reaches the runtime
    // exhaustion path as the backstop.
    const chainPreflight = await preflightStageChainAvailabilityV1(targetStage, {
      modelId,
    });
    if (chainPreflight.kind === "exhausted") {
      await handleReviewOutcomeV1(
        {
          kind: "unavailable",
          code: "providerModeUnavailable",
          chainExhaustion: chainPreflight.exhaustion,
        },
        {
          extensionUri,
          folderUri,
          workspaceUri: workspaceRoot.uri,
          currentStage,
          targetStage,
          reviewUri,
          variables,
          reviewAttemptId,
          operation: options.operation,
          chatViewProvider: options.chatViewProvider,
          modelId,
          promptLength: promptByteLength,
          providerId: dispatchProviderId,
        }
      );
      return;
    }

    const coordinator = createProductionTaskActionCoordinatorV1({
      workspaceCwd: workspaceRoot.uri.fsPath,
      resolveStagePrimaryModel: () => ({ modelId: dispatchModelId, stage: targetStage }),
    });

    const relativePath = path.relative(folderUri.fsPath, reviewUri.fsPath) || STAGE_ARTIFACT_FILENAMES[targetStage] || "review.md";
    const targetLocator = { rootId, relativePath };
    const reviewFileStore = getWorkflowFileStoreV1();
    const reviewStatResult = await reviewFileStore.stat(targetLocator);
    const reviewBaselineRevision =
      reviewStatResult.kind === "ok" && reviewStatResult.value.kind === "file"
        ? reviewStatResult.value.revision
        : undefined;
    const validatedInput: ReviewActionInputV1 = {
      prompt,
      targetLocator,
      ...(reviewBaselineRevision !== undefined ? { baselineRevision: reviewBaselineRevision } : {}),
      ...(publishFreshnessGuard !== undefined ? { publishFreshnessGuard } : {}),
    };

    // 2026-08-27 review, blocker "review rows... omit earlier retry-attempt
    // identities": collect EVERY coordinator attempt this round makes (a
    // primary candidate that fails before a fallback candidate succeeds, an
    // item-14 same-candidate retry), not just the final one carried on
    // `outcome.correlation` — see `ReviewOutcomeContextV1.extraCoordinatorAttemptIds`.
    const observedCoordinatorAttemptIds: string[] = [];
    const outcome = await coordinator.executeAction({
      actionKey: REVIEW_ACTION_KEY_V1,
      taskBinding: { taskBindingId: verifiedBindingId, chatDocumentId },
      taskStatus: "active",
      taskStage: currentStage,
      rawInput: validatedInput,
      cancellationToken: options.operation?.token ?? new vscode.CancellationTokenSource().token,
      // 2026-08-28 review, blocker "coordinator allocation sites still do not
      // synchronously attach durable round identities before pre-prompt
      // failures can return": an attempt that fails BEFORE reaching
      // `onPromptAssembled` (every candidate exhausted, `candidateUnavailable`)
      // previously left NO record of itself anywhere on this round, not even
      // at termination — `onAttemptAllocated` fires for every attempt this
      // coordinator allocates, assembly-eligible or not, strictly before any
      // such failure branch can return.
      //
      // The callback is awaited by the coordinator. Identity therefore lands
      // before an allocation can take a pre-prompt failure branch or invoke a
      // provider; unlike the old fire-and-forget hook, it cannot later race a
      // user pause written while the provider is running.
      onAttemptAllocated: async (info) => {
        observedCoordinatorAttemptIds.push(info.attemptId);
        await attachCoordinatorIdentityToRoundV1({
          roundId: reviewAttemptId,
          operationId: info.operationId,
          attemptId: info.attemptId,
          taskFolderUri: folderUri,
        });
      },
      onPromptAssembled: (info) => {
        observedCoordinatorAttemptIds.push(info.attemptId);
      },
    });
    // "completed" is the only outcome that overwrites reviewUri with fresh
    // content (via the coordinator's own write) — every other kind
    // (questions, cancelled, failed, unavailable, ...) leaves the in-progress
    // marking on disk with nothing further coming, so the `finally` below
    // must revert it.
    reviewSucceeded = outcome.kind === "completed";

    await handleReviewOutcomeV1(outcome, {
      extensionUri,
      folderUri,
      workspaceUri: workspaceRoot.uri,
      currentStage,
      targetStage,
      reviewUri,
      variables,
      reviewAttemptId,
      operation: options.operation,
      chatViewProvider: options.chatViewProvider,
      modelId,
      promptLength: promptByteLength,
      providerId: dispatchProviderId,
      ...(observedCoordinatorAttemptIds.length
        ? { extraCoordinatorAttemptIds: observedCoordinatorAttemptIds }
        : {}),
    });
  } finally {
    if (!reviewSucceeded) {
      await revertInProgressReviewMarkingV1(folderUri, reviewUri, reviewAttemptId, inProgressMarking);
    }
  }
}

/**
 * All initial-review and re-review prompts require a leading
 * `Readiness: N/10` line. A response missing it is a strong signal the
 * provider didn't actually perform the review — e.g. it replied with a
 * clarifying question about the prompt file instead of reviewing it, which
 * still exits 0 with non-empty output and would otherwise be
 * indistinguishable from a real review.
 */
function validateReviewOutput(content: string): { valid: boolean; reason: string } {
  const { score } = parseReadiness(content);
  if (score === null) {
    return { valid: false, reason: 'response has no "Readiness: N/10" line' };
  }
  return { valid: true, reason: "" };
}

function isStaleReviewArtifact(content: string): boolean {
  return content.trimStart().startsWith("# Review Stale");
}

/** The transient placeholder `beginInProgressReviewMarkingV1` writes over a
 * `# Review Stale` placeholder while a rerun of that same review stage is
 * genuinely in flight (see `isReviewActivelyRerunningV1`).
 * @internal exported for testing */
export function isInProgressReviewArtifact(content: string): boolean {
  return content.trimStart().startsWith(IN_PROGRESS_REVIEW_PLACEHOLDER_PREFIX_V1);
}

/**
 * True when `content` (already known non-empty) is NOT a usable existing
 * review and Fast Forward Review must treat the stage as if no review has
 * run yet — i.e. run the initial review rather than trying to read a
 * baseline score out of it.
 *
 * Two cases:
 *  - A "# Review Stale" placeholder (written when the reviewed artifact
 *    changed after the review) — has no score and describes an outdated
 *    state.
 *  - Content with no "Readiness: N/10" line at all. Most commonly this is
 *    publish-review.md holding only a Completion Checks section merged in by
 *    a prior `runCompletionLint` persist (e.g. an earlier manual publish
 *    attempt, or "Fix with AI" — see completionLint.ts), with no review body
 *    yet written. Without this check, that checks-only content read as "a
 *    review already exists but is unusable" and Fast Forward refused
 *    outright instead of running the initial review it was just asked to
 *    kick off.
 *
 * @internal exported for testing
 */
export function isUnusableAsExistingReview(content: string): boolean {
  return isStaleReviewArtifact(content) || parseReadiness(content).score === null;
}

/**
 * Fast Forward Review's "no usable review to start from" message, tailored
 * to name the actual cause when it is the common one: a prior implementation
 * round was rejected by the summary shape gate (impl-summary.md still holds
 * IMPLEMENTATION_SUMMARY_UNUSABLE_MARKER_V1), so runReviewForFolder's own
 * dispatch is refused — there are no real implementation notes to review
 * against — and the review artifact is left as the stale placeholder
 * markReviewArtifactStale wrote. "Run the review again" is not a workable
 * next step in that state, so the generic wording is replaced with the real
 * cause and the real recovery: rerun the implementation, or (once a usable
 * summary exists) use "Apply Review Changes".
 *
 * Falls back to the generic message for every other way a review can fail to
 * produce usable output (provider error, empty response, etc.), where
 * "try running Review manually" remains the right next step.
 *
 * @internal exported for testing
 */
export async function describeUnusableReviewBlockV1(folderUri: vscode.Uri): Promise<string> {
  const summary = await readTextIfExists(getImplementationSummaryUri(folderUri));
  if (summary !== undefined && isUnusableImplementationSummaryV1(summary)) {
    return (
      "Fast Forward Review: a prior implementation round was rejected and left no usable " +
      "implementation summary, so review could not run and there is nothing to fast-forward from. " +
      'Rerun the implementation, or use "Apply Review Changes" once a usable summary exists, before ' +
      "fast-forwarding."
    );
  }
  return (
    "Fast Forward Review: the initial review did not produce usable output. Try running Review manually."
  );
}

/**
 * Backs up a review artifact unless its current content is already a
 * "# Review Stale" placeholder. A placeholder is never worth preserving as
 * the "previous version" for View Changes — without this guard, staling the
 * same artifact twice in a row (e.g. two implementation reruns with
 * auto-review off) or publishing a new review over a staled one would
 * overwrite the last real review's backup with the placeholder itself.
 *
 * @internal exported for testing
 */
export async function backupReviewUnlessStale(reviewUri: vscode.Uri): Promise<void> {
  const existing = await readNonEmptyText(reviewUri);
  // The in-progress placeholder is excluded for the same reason as the stale
  // one: it can never be worth preserving as the "previous version" — if a
  // workspace change stales this same artifact WHILE a rerun is writing the
  // in-progress placeholder, backing it up would clobber the last REAL
  // review's backup with a transient marker that describes nothing.
  if (
    existing !== undefined &&
    !isStaleReviewArtifact(existing) &&
    !isInProgressReviewArtifact(existing)
  ) {
    await backupArtifactBeforeWrite(reviewUri);
  }
}

async function markReviewArtifactStale(
  reviewUri: vscode.Uri,
  changedArtifact: string
): Promise<void> {
  // Snapshot the real review content as the "previous version" before it's
  // clobbered by the placeholder below — otherwise the placeholder itself
  // would become the backup once the next review publishes. skipBackup is
  // required here: writeTextFile's own unconditional backup would otherwise
  // immediately re-read the (still on-disk, not-yet-overwritten) content and
  // redo the backup — which is harmless on the first staling but clobbers
  // the guard above on a second consecutive staling, since by then the
  // on-disk content is already the placeholder.
  await backupReviewUnlessStale(reviewUri);
  const staleNotice = [
    "# Review Stale",
    "",
    `This review was generated before ${changedArtifact} was updated.`,
    "",
    "Run Review with AI again to evaluate the current artifact.",
    "",
  ].join("\n");
  await writeTextFile(reviewUri, staleNotice, { skipBackup: true });
}

/** Result of {@link beginInProgressReviewMarkingV1}.
 * @internal exported for testing */
export interface InProgressReviewMarkingV1 {
  /** True when the artifact was rewritten and must be reverted on any
   * non-success exit (see the run-token-guarded revert below). */
  readonly rewrote: boolean;
  /** The exact prior bytes, captured before the rewrite — restored verbatim
   * on revert rather than reconstructed, so revert can never drift from
   * whatever was actually on disk (a real stale placeholder, a review body
   * with a stale banner, or anything else). Only meaningful when
   * `rewrote` is true. */
  readonly priorContent?: string;
}

/**
 * Part 2 (review status messaging): mark a review artifact "in progress"
 * immediately after this attempt has claimed the review (post-claim, so this
 * never runs for an attempt that lost the claim race) and before the
 * provider call — the two surfaces a rerun can leave stale-looking:
 *
 *  - A `# Review Stale` content placeholder is replaced wholesale with the
 *    `# Review in progress` placeholder (no rerun instruction — one is
 *    already running).
 *  - A real review body carrying the commit-drift stale banner
 *    (`upsertStaleReviewBanner`) has ONLY that banner line swapped for its
 *    in-progress form (`markReviewInProgressBannerV1`); the body is never
 *    touched.
 *  - Anything else (a current review with no stale marker at all, being
 *    re-reviewed by choice) is left untouched — there is nothing to mark.
 *
 * Callers MUST revert on every non-success exit (refusal, failure, thrown
 * error, cancellation) using the returned `priorContent`, gated on this
 * attempt still being the task's current `reviewAttemptId` — see
 * runReviewForFolder's use, immediately after `claimReviewAttempt`.
 *
 * @internal exported for testing
 */
export async function beginInProgressReviewMarkingV1(
  reviewUri: vscode.Uri
): Promise<InProgressReviewMarkingV1> {
  const current = await readTextIfExists(reviewUri);
  if (current === undefined) {
    return { rewrote: false };
  }
  if (isStaleReviewArtifact(current)) {
    const inProgressNotice = [
      IN_PROGRESS_REVIEW_PLACEHOLDER_PREFIX_V1,
      "",
      "This review is being re-evaluated against the current artifact.",
      "",
    ].join("\n");
    await writeTextFile(reviewUri, inProgressNotice, { skipBackup: true });
    return { rewrote: true, priorContent: current };
  }
  const withInProgressBanner = markReviewInProgressBannerV1(current);
  if (withInProgressBanner === current) {
    return { rewrote: false };
  }
  await writeTextFile(reviewUri, withInProgressBanner, { skipBackup: true });
  return { rewrote: true, priorContent: current };
}

/**
 * Undoes {@link beginInProgressReviewMarkingV1}'s rewrite, restoring the
 * exact prior bytes — but ONLY when `reviewAttemptId` is still the task's
 * current one (the run-token guard). A late failure/cancellation from an
 * older, already-superseded attempt must never clobber whatever a NEWER
 * attempt has since written (its own in-progress marking, or a completed
 * review). A no-op when `marking.rewrote` is false (nothing to undo) or the
 * revert write itself fails (best-effort — the caller's real outcome must
 * never be masked by a courtesy marker's own I/O failure).
 *
 * @internal exported for testing
 */
export async function revertInProgressReviewMarkingV1(
  folderUri: vscode.Uri,
  reviewUri: vscode.Uri,
  reviewAttemptId: string,
  marking: InProgressReviewMarkingV1
): Promise<void> {
  if (!marking.rewrote || marking.priorContent === undefined) {
    return;
  }
  try {
    const latest = await readTaskProgressAdvisoryV1(folderUri);
    if (latest?.reviewAttemptId !== reviewAttemptId) {
      return;
    }
    await writeTextFile(reviewUri, marking.priorContent, { skipBackup: true });
  } catch {
    // Best-effort marker only — see doc comment above.
  }
}

/**
 * Undoes a rejected implementation round: restores impl-summary.md and the
 * round's review artifact from their `_prev` backups
 * (`previousVersionUri` — see artifactBackups.ts), returning the task to
 * exactly its pre-rejection state. The two durable writes a rejection makes
 * (executeImplementationRun's summary-shape gate, above) each already
 * preserve the good prior version as `<name>_prev.md` before stamping/staling
 * the current one — impl-summary.md via `writeTextFile`'s own backup, and the
 * review via `markReviewArtifactStale`'s explicit `backupReviewUnlessStale` —
 * so recovery is exactly "copy each `_prev` file back over its current one".
 *
 * Reads each `_prev` file's bytes and writes them with the raw
 * `vscode.workspace.fs` API rather than `writeTextFile`: `writeTextFile`
 * would back up the CURRENT (still-stamped) content into `_prev` before
 * writing, clobbering the very backup this function is restoring from.
 *
 * Guarded on the current summary actually being the rejection stamp — a
 * stale action button (the user already reran the implementation, or is
 * looking at a different round's notification) must not silently overwrite a
 * newer, usable summary with an older one.
 *
 * `stage` is the review stage the rejected round belonged to
 * (executeImplementationRun's `postRunReviewStage`), used to locate that
 * stage's review artifact; a plan-only task (no review stage yet) restores
 * just the summary.
 */
export async function restoreRejectedImplementationRoundV1(
  taskFolderPath: string,
  stage: TaskStage
): Promise<void> {
  const folderUri = vscode.Uri.file(taskFolderPath);
  const summaryUri = getImplementationSummaryUri(folderUri);

  const currentSummary = await readTextIfExists(summaryUri);
  if (currentSummary === undefined || !isUnusableImplementationSummaryV1(currentSummary)) {
    NotificationRouter.showInformation(
      "Nothing to restore — the current implementation summary is not a rejected-round stamp " +
        "(it may already have been restored, or a later round already replaced it)."
    );
    return;
  }

  const restoreTargets: Array<{ current: vscode.Uri; label: string }> = [
    { current: summaryUri, label: "implementation summary" },
  ];
  const reviewUri = isReviewStage(stage) ? artifactUri(folderUri, stage) : undefined;
  if (reviewUri) {
    restoreTargets.push({ current: reviewUri, label: "review" });
  }

  const restored: string[] = [];
  const missing: string[] = [];
  for (const { current, label } of restoreTargets) {
    try {
      const backupContents = await vscode.workspace.fs.readFile(previousVersionUri(current));
      await vscode.workspace.fs.writeFile(current, backupContents);
      restored.push(label);
    } catch {
      missing.push(label);
    }
  }

  if (restored.length === 0) {
    NotificationRouter.showWarning(
      "Could not restore the prior round: no backup (_prev) file was found for the implementation " +
        "summary" + (reviewUri ? " or review" : "") + "."
    );
    return;
  }

  NotificationRouter.showInformation(
    `Restored the prior ${restored.join(" and ")} — the task is back to its pre-rejection state.` +
      (missing.length > 0 ? ` (No backup was found for the ${missing.join(" and ")}.)` : "")
  );
}

/**
 * Run (or re-run) the review for the task's current position in the
 * workflow. Labeled "Review" in the UI.
 *
 * Requires first-use consent before any AI action runs.
 */
export async function runReviewWithAI(
  extensionUri: vscode.Uri,
  context: vscode.ExtensionContext,
  arg?: ReviewCommandArg,
  chatViewProvider?: ChatViewProvider
): Promise<void> {
  assertLegacyAiRouteAllowedV0("review.v1");
  // ── Pre-flight workspace guard ────────────────────────────────────────────
  // Fail fast if no workspace is open at all; the ownership-aware resolution
  // (resolveOwnerWorkspace) happens after task resolution below.
  if ((vscode.workspace.workspaceFolders ?? []).length === 0) {
    NotificationRouter.showError(
      "No workspace folder open. Please open a folder first."
    );
    return;
  }

  // ── Malformed-arg guard ───────────────────────────────────────────────────
  // Catch stale or untyped callers that pass an unsupported arg shape (e.g.
  // { canonicalId } without taskFolderPath, or { taskFolderPath: undefined },
  // or { task: {} } without folderUri, via `as any` or untyped JS).
  // Primitives ("x", 42, true) are NOT caught as malformed — they fall through
  // to normalizeReviewArg which treats non-object/falsy values as "no arg"
  // (safe QuickPick fallback). Only structured objects with wrong shapes are
  // rejected here to avoid showing an error for args the user never intended.
  if (isMalformedReviewArg(arg as ReviewCommandArg | Record<string, unknown>)) {
    NotificationRouter.showError(
      "Review: unsupported argument shape. " +
        "Use { taskFolderPath } to target a specific task, or invoke without an argument to pick from a list."
    );
    return;
  }

  // ── Consent gate ─────────────────────────────────────────────────────────
  const consented = await ensureAiConsent(context);
  if (!consented) {
    return;
  }

  const resolved = await resolveTask(
    normalizeReviewArg(arg),
    Object.keys(REVIEW_TARGETS) as TaskStage[],
    "Review with AI",
    context
  );
  if (!resolved) {
    return;
  }
  if (resolved.progress.status === "paused") {
    NotificationRouter.showInformation("This task is paused. Resume it before running a review.");
    return;
  }

  // Prefer the task's persisted ownership.workspaceRoot over the active-editor
  // workspace so the context pack is generated from the correct workspace.
  const workspaceRoot = resolveOwnerWorkspace(resolved.progress);
  if (!workspaceRoot) {
    NotificationRouter.showError(
      "Could not determine the owning workspace for this task. Please open the workspace that created it."
    );
    return;
  }
  const lockKey = resolved.folderUri.fsPath;
  await runTrackedOperation(
    lockKey,
    {
      label: "Review",
      stage: resolved.progress.currentStage,
      taskName: resolved.progress.displayName,
      kind: "review",
      cancellable: true,
    },
    (op) =>
      runReviewForFolder(
        extensionUri,
        resolved.folderUri,
        workspaceRoot,
        resolved.progress.currentStage,
        true,
        { operation: op, chatViewProvider }
      )
  );
}

/**
 * Apply the current review: for plan review stages the AI rewrites the plan
 * in place; for implementation review stages it re-runs the AI
 * implementation against the codebase to address the review's findings.
 * The stage does not change — re-run the review or move to the next stage explicitly.
 *
 * Model resolution:
 *   - Plan review apply uses the `plan` model (not the review-stage model).
 *   - Implementation review apply uses the `implementation` model (not the review-stage model).
 *   - Review generation (runReviewForFolder) is not affected and continues to
 *     use the review-stage model.
 *
 * Requires first-use consent before any AI action runs.
 */
export async function applyReviewWithAI(
  extensionUri: vscode.Uri,
  context: vscode.ExtensionContext,
  arg?: ReviewCommandArg,
  options: ApplyReviewOptions = {}
): Promise<void> {
  assertLegacyAiRouteAllowedV0("applyReview.v1");

  const targetStage =
    arg && typeof arg === "object" && "task" in arg && arg.task && typeof arg.task === "object" && "progress" in arg.task && arg.task.progress && typeof arg.task.progress === "object" && "currentStage" in arg.task.progress
      ? (arg.task.progress as { currentStage?: string }).currentStage
      : undefined;

  if (targetStage && IMPL_REVIEW_STAGES.includes(targetStage as TaskStage)) {
    assertLegacyAiRouteAllowedV0("applyReviewEdit.v1");
    NotificationRouter.showWarning(
      "Apply Review with AI is only for plan review stages. For implementation review stages, use Apply Review Edit with AI."
    );
    return;
  }

  // ── Malformed-arg guard ───────────────────────────────────────────────────
  // Catch stale or untyped callers that pass an unsupported arg shape (e.g.
  // { canonicalId } without taskFolderPath, or { taskFolderPath: undefined },
  // or { task: {} } without folderUri, via `as any` or untyped JS). Pure
  // shape check on `arg` itself — no I/O — so it belongs before any read.
  // Primitives ("x", 42, true) fall through to normalizeReviewArg safely.
  if (isMalformedReviewArg(arg as ReviewCommandArg | Record<string, unknown>)) {
    NotificationRouter.showError(
      "Apply Review: unsupported argument shape. " +
        "Use { taskFolderPath } to target a specific task, or invoke without an argument to pick from a list."
    );
    return;
  }

  const node = normalizeReviewArg(arg);

  const taskFolderUri = node.task?.folderUri;
  if (taskFolderUri) {
    const strictCheck = await readTaskProgressStrictV1(taskFolderUri, {
      expectedTaskFolder: path.basename(taskFolderUri.fsPath),
    });
    if (strictCheck.ok && IMPL_REVIEW_STAGES.includes(strictCheck.decoded.progress.currentStage)) {
      assertLegacyAiRouteAllowedV0("applyReviewEdit.v1");
      NotificationRouter.showWarning(
        "Apply Review with AI is only for plan review stages. For implementation review stages, use Apply Review Edit with AI."
      );
      return;
    }
  }

  const resolved = await resolveTask(
    node,
    PLAN_REVIEW_STAGES,
    "Apply Review with AI",
    context
  );
  if (!resolved) {
    return;
  }
  if (resolved.progress.status === "paused") {
    NotificationRouter.showInformation("This task is paused. Resume it before applying a review.");
    return;
  }

  // ── Consent gate ─────────────────────────────────────────────────────────
  const consented = await ensureAiConsent(context);
  if (!consented) {
    return;
  }

  // Prefer the task's persisted ownership.workspaceRoot over the active-editor
  // workspace so context packs and AI runs target the correct workspace.
  const workspaceRoot = resolveOwnerWorkspace(resolved.progress);
  if (!workspaceRoot) {
    NotificationRouter.showError(
      "Could not determine the owning workspace for this task. Please open the workspace that created it."
    );
    return;
  }

  const lockKey = resolved.folderUri.fsPath;
  const stage = resolved.progress.currentStage;
  const runApply = async (op: TaskOperationHandle): Promise<void> => {
    const reviewUri = artifactUri(resolved.folderUri, stage);
    const reviewContent = reviewUri && (await readNonEmptyText(reviewUri));
    if (!reviewContent) {
      NotificationRouter.showWarning(
        "No review found (or it is empty). Run the review before applying it."
      );
      return;
    }
    if (isStaleReviewArtifact(reviewContent)) {
      NotificationRouter.showWarning(
        "The review is stale. Run the review again before applying it."
      );
      return;
    }
    const reviewValidation = validateReviewOutput(reviewContent);
    if (!reviewValidation.valid) {
      NotificationRouter.showWarning(
        `The review content is invalid (${reviewValidation.reason}). Run the review again before applying it.`
      );
      return;
    }



    const variables: Record<string, string> = {
      review: reviewContent,
    };

    const currentPlanUri = await resolveCurrentPlanUri(resolved.folderUri);
    const planContent = await readNonEmptyText(currentPlanUri);
    if (!planContent) {
      NotificationRouter.showWarning(
        stageActionRequirementMessageV1("applyReviewPlan", 0)
      );
      return;
    }
    variables.plan = planContent;
    const contextPackUri = await writeContextPack(
      resolved.folderUri,
      workspaceRoot.uri
    );
    variables.contextPack = new TextDecoder().decode(
      await vscode.workspace.fs.readFile(contextPackUri)
    );
    assertLegacyAiRouteAllowedV0("applyReview.v1");

    const prompt = await renderPromptTemplate(extensionUri, "apply-review.md", variables);

    const rootId = ensureWorkflowTaskFolderRootV1(resolved.folderUri.fsPath);
    const verifiedBindingId = getVerifiedTaskBindingIdV1(rootId);
    if (!verifiedBindingId) {
      throw new Error("Task ownership binding could not be verified.");
    }
    const chatIdentity = await readChatDocumentIdentityV1(resolved.folderUri.fsPath, resolved.folderUri.fsPath);
    const chatDocumentId = chatIdentity?.documentId ?? allocateHex128IdV1();

    const { modelId } = await resolveFreshModelForStage(resolved.folderUri, "plan");
    if (!modelId) {
      NotificationRouter.showWarning("No model is configured for plan stage.");
      return;
    }

    const coordinator = createProductionTaskActionCoordinatorV1({
      workspaceCwd: workspaceRoot.uri.fsPath,
      resolveStagePrimaryModel: () => ({ modelId, stage: "plan" }),
    });

    const targetLocator = { rootId, relativePath: PLAN_FILENAME };
    const applyReviewFileStore = getWorkflowFileStoreV1();
    const applyReviewStatResult = await applyReviewFileStore.stat(targetLocator);
    const applyReviewBaselineRevision =
      applyReviewStatResult.kind === "ok" && applyReviewStatResult.value.kind === "file"
        ? applyReviewStatResult.value.revision
        : undefined;
    const validatedInput: ApplyReviewActionInputV1 = {
      prompt,
      targetLocator,
      ...(applyReviewBaselineRevision !== undefined ? { baselineRevision: applyReviewBaselineRevision } : {}),
    };

    const outcome = await coordinator.executeAction({
      actionKey: APPLY_REVIEW_ACTION_KEY_V1,
      taskBinding: { taskBindingId: verifiedBindingId, chatDocumentId },
      taskStatus: "active",
      taskStage: stage,
      rawInput: validatedInput,
      cancellationToken: op.token ?? new vscode.CancellationTokenSource().token,
    });

    if (outcome.kind === "completed") {
      if (reviewUri) {
        await markReviewArtifactStale(reviewUri, PLAN_FILENAME);
      }
      await safeOpenTextDocument(vscode.Uri.joinPath(resolved.folderUri, PLAN_FILENAME), PLAN_FILENAME);
      // Re-review after applying (no confirmation, no stage change)
      await runTrackedOperation(
        lockKey,
        { parent: op, label: "Re-running review", stage, kind: "review" },
        // See the impl-review branch above: anchor the deferred auto-advance
        // dispatch to the exclusive root (`op`), not this re-review's own
        // child handle, or the follow-up command fires while the root
        // (e.g. Fast Forward's loop) is still holding the lock and is
        // silently refused as busy.
        () =>
          runReviewForFolder(
            extensionUri,
            resolved.folderUri,
            workspaceRoot,
            stage,
            true,
            {
              preserveActiveFallback: options.preserveActiveFallback,
              operation: op,
              chatViewProvider: options.chatViewProvider,
            }
          )
      );
    } else if (outcome.kind === "questions") {
      if (options.chatViewProvider) {
        const orchestrator = getProductionActionConversationOrchestratorV1();
        const record = await orchestrator.getRecord({
          operationId: outcome.correlation.operationId,
          interactionId: outcome.interactionId,
          taskBindingId: outcome.correlation.taskBindingId,
          chatDocumentId: outcome.correlation.chatDocumentId,
          sourceAttemptId: outcome.correlation.attemptId,
        });
        if (record) {
          await options.chatViewProvider.askInteraction({
            canonicalId: resolved.folderUri.fsPath,
            taskFolderPath: resolved.folderUri.fsPath,
            stage: record.stage,
            interactionId: record.interactionId,
            operationId: record.correlation.operationId,
            actionKey: record.correlation.actionKey,
            sourceAttemptId: record.correlation.attemptId,
            // safe: see the other askInteraction call sites' comment.
            questions: record.questions!,
            binding: {
              taskBindingId: record.correlation.taskBindingId,
              chatDocumentId: record.correlation.chatDocumentId,
            },
          });
        }
      }
    }
  };

  if (options.parentOperation) {
    // A composite caller (fast-forward) already registered the tracked
    // operation; run under its handle so the whole composite renders exactly
    // one Notifications row and internal attempts nest as its children.
    await runApply(options.parentOperation);
  } else {
    await runTrackedOperation(
      lockKey,
      { label: "Apply Review", stage, taskName: resolved.progress.displayName, kind: "apply-review", cancellable: true },
      runApply
    );
  }
}

/**
 * Fast Forward Review: repeats the exact apply-then-re-review cycle that the
 * "Apply Review" button runs once, up to MAX_REVIEW_ATTEMPTS times, stopping
 * as soon as an attempt's readiness score improves by at least 1 over the
 * score the review had when this command started.
 *
 * Deliberately calls the same applyReviewWithAI path for each attempt rather
 * than re-implementing apply logic, so this can never diverge from what the
 * regular "Apply Review" button does per attempt. The fast-forward-specific
 * overrides are: attempts after the first skip the implementation pre-run
 * dirty/non-git confirmation, and internal retries preserve any fallback
 * already activated earlier in the same click so they do not keep re-hitting
 * a failed primary. Progress between attempts is inferred by re-reading
 * the review artifact from disk (rather than threading a success signal
 * through applyReviewWithAI's internals, which branch differently for plan
 * vs. implementation reviews): if an attempt leaves the review file
 * byte-identical to before, that attempt produced nothing to compare
 * (blocked by a guard, or the run failed before writing), and the loop
 * stops immediately rather than silently repeating the same failure up to
 * 5 times.
 *
 * Requires first-use consent before any AI action runs (same as Apply Review).
 */
/**
 * §7.5 routing pre-check for Fast Forward: a cheap, ZERO-I/O determination of
 * whether THIS invocation's apply loop will reach the edit-capable branch
 * (impl review) or stay on the text-only branch (plan review), using only an
 * already-known `arg.task.progress.currentStage` already sitting in memory.
 * Returns `true`/`false` only when the target is knowable from the supplied
 * arg without any read; `undefined` whenever it isn't — a bare QuickPick
 * invocation (no task arg), a `{ taskFolderPath }`-only arg, or any other
 * shape that doesn't already carry `task.progress`. §7.5 forbids reading
 * task-progress.json just to answer this routing question (that read would
 * itself run before the host/provider gate below), so an `undefined` result
 * defers entirely to the per-task gate further down in
 * fastForwardReviewWithAI, which runs once resolveTask's read — needed
 * regardless, to pick the target task at all — has made the stage known,
 * still before any review-artifact read. Safe to call before
 * `isMalformedReviewArg` has run: every branch here defensively type-narrows
 * or falls through to `undefined` rather than throwing on an unrecognized
 * shape.
 *
 * Exported so other zero-I/O command wrappers with their own already-known
 * task/progress (e.g. `fastForwardCurrentTaskReview.ts`'s keyboard-shortcut
 * router, which peeks the current task from the in-memory inventory before
 * doing its own heavier `resolveTaskContext` read) can reuse this exact
 * routing decision instead of re-deriving `REVIEW_TARGETS`/`IMPL_REVIEW_STAGES`
 * logic.
 */
export function fastForwardTargetsImplReviewV1(
  arg: ReviewCommandArg | undefined
): boolean | undefined {
  if (
    arg &&
    typeof arg === "object" &&
    "task" in arg &&
    arg.task &&
    typeof arg.task === "object" &&
    "progress" in arg.task &&
    arg.task.progress &&
    typeof arg.task.progress === "object" &&
    "currentStage" in arg.task.progress
  ) {
    const stage = (arg.task.progress as { currentStage?: TaskStage }).currentStage;
    const knownTargetStage = stage ? REVIEW_TARGETS[stage] : undefined;
    if (knownTargetStage) {
      return IMPL_REVIEW_STAGES.includes(knownTargetStage);
    }
  }
  return undefined;
}

/**
 * §7.5/AC-HOST-03 companion peek for the `{ taskFolderPath }` shape, which
 * `fastForwardTargetsImplReviewV1` above cannot resolve (it only reads an
 * already-supplied `arg.task.progress`, never touching disk). Unlike a bare
 * (no-arg) invocation — which is genuinely ambiguous until `resolveTask`
 * discovers and filters every eligible task across every workspace folder —
 * `{ taskFolderPath }` already names exactly one concrete task folder, so its
 * category is knowable from a single targeted read: the same
 * `readTaskProgressStrictV1` call `resolveTask`'s `node.task` branch performs
 * for a task node. Doing that one read here lets the caller enforce the
 * already-computed host/provider gate before the workspace-folder guard, the
 * malformed-arg guard, and `ensureAiConsent`'s modal all run — instead of
 * only after, as `resolveTask` would otherwise leave it for this shape.
 *
 * Returns `undefined` — never a notification, never a thrown error — for any
 * read failure (missing file, corrupt/unsupported progress, folder-binding
 * mismatch) or a stage with no review target, so the caller always falls
 * through to the existing `resolveTask` call, which performs the
 * authoritative read and shows the real recovery/error message. This peek
 * exists only to move enforcement of an already-decidable gate earlier; it
 * never substitutes for or duplicates normal error reporting.
 *
 * Exported so `fastForwardCurrentTaskReview.ts`'s keyboard-shortcut router
 * can reuse it for its own cache-miss case: when the persisted current-task
 * pointer names an id that isn't in the in-memory `TaskInventory` snapshot
 * (a stale cache, not genuine ambiguity), the pointer is still a concrete
 * folder path, so this same targeted read resolves its category instead of
 * falling straight through to the heavier `resolveTaskContext` call.
 */
export async function peekFastForwardTargetsImplReviewFromPathV1(
  taskFolderPath: string
): Promise<boolean | undefined> {
  const folderUri = vscode.Uri.file(taskFolderPath);
  const strict = await readTaskProgressStrictV1(folderUri, {
    expectedTaskFolder: path.basename(folderUri.fsPath),
  });
  if (!strict.ok) {
    return undefined;
  }
  const knownTargetStage = REVIEW_TARGETS[strict.decoded.progress.currentStage];
  return knownTargetStage ? IMPL_REVIEW_STAGES.includes(knownTargetStage) : undefined;
}

export async function fastForwardReviewWithAI(
  extensionUri: vscode.Uri,
  context: vscode.ExtensionContext,
  arg?: ReviewCommandArg,
  chatViewProvider?: ChatViewProvider
): Promise<void> {
  assertLegacyAiRouteAllowedV0("fastForward.v1");
  // §7.5 provider-path gate (AC-HOST-03): task/model-INDEPENDENT — it never
  // touches TaskInventory, current-task state, or any per-task file — but
  // it is NOT zero-I/O: it resolves the impl stage's WINNING candidate via
  // checkImplementationAvailabilityForModel (a CLI existence probe, or a
  // Copilot model-list probe, to correctly fall through a down CLI primary
  // to a configured backup) and, only when that candidate is Copilot,
  // additionally probes the host API shape (see checkEditActionProviderPathGateV1's
  // own header in runEditActionV1.ts). Calling it here, unconditionally, is
  // the first thing this function does after the legacy-route gate —
  // strictly before ANY task or source read, including an in-memory
  // TaskInventory lookup.
  //
  // Fast Forward's apply loop only reaches the edit-capable branch
  // (applyReviewEditWithAI's edit branch) when the target review is an
  // implementation review (IMPL_REVIEW_STAGES) — plan-review fast-forwarding
  // stays on the text-only applyReview.v1 route and must keep working on a
  // host/provider that can't run edits (e.g. the 1.93 baseline). But this
  // invocation's category is not always knowable without a read (a bare
  // QuickPick call, a `{ taskFolderPath }` arg, or an ambiguous shape all
  // require `resolveTask`'s read — or the targeted peek below — to learn the
  // stage). AC-HOST-03 requires the unavailable result to precede ANY
  // task/source read, so the gate below is enforced whenever zero-I/O data
  // has NOT already proven the target is plan-review-only (`=== false`):
  // that covers the known-impl-review case (enforced immediately, as
  // before), and also the "don't know yet" case (`undefined`) — for that
  // case the gate now runs BEFORE the `{ taskFolderPath }` peek's disk read
  // below and before the workspace-folder guard, the malformed-arg guard,
  // `ensureAiConsent`'s modal, and `resolveTask`'s own read for a bare or
  // ambiguous invocation. Only an invocation zero-I/O already proves is
  // plan-review-only (`fastForwardTargetsImplReviewV1(arg) === false`) skips
  // this gate, since it can never reach the edit-capable branch.
  // Declared outside the block below so the IMPL_REVIEW_STAGES branch further
  // down can reuse this exact result instead of probing a second time. NOT
  // guaranteed assigned by the time that branch runs: `resolveTask` below
  // always re-reads progress from disk, so a stale caller-supplied
  // `arg.task.progress` that made `knownTargetsImplReview === false` here can
  // still land on an implementation-review targetStage there — that branch
  // computes the gate on demand when this stays undefined (see its comment).
  let earlyProviderPathGate: Awaited<ReturnType<typeof checkEditActionProviderPathGateV1>> | undefined;
  let knownTargetsImplReview = fastForwardTargetsImplReviewV1(arg);
  if (knownTargetsImplReview !== false) {
    // The gate itself now does real I/O (a CLI existence probe or Copilot
    // model-list probe, to resolve the winning candidate through a possible
    // backup — see checkEditActionProviderPathGateV1's header), so it is
    // called here, inside this branch, rather than unconditionally above —
    // a plan-review-only invocation (knownTargetsImplReview === false) never
    // needs it and must not pay for it.
    earlyProviderPathGate = await checkEditActionProviderPathGateV1("impl");
    if (!earlyProviderPathGate.ok) {
      NotificationRouter.showWarning(earlyProviderPathGate.reason);
      return;
    }
  }
  if (knownTargetsImplReview === undefined && arg && typeof arg === "object") {
    // §7.5/AC-HOST-03: `fastForwardTargetsImplReviewV1` only resolves a
    // caller-supplied `arg.task.progress` (zero-I/O). A `{ taskFolderPath }`
    // arg — the keyboard-shortcut/automation shape — names exactly one
    // concrete task folder, so unlike a genuinely ambiguous bare invocation
    // its category IS knowable from a single targeted read. This read only
    // runs once the gate above has already passed (or the target was
    // already proven plan-review-only, which can't reach this branch), so it
    // can never precede an enforced unavailability result.
    const rec = arg as Record<string, unknown>;
    if (!("task" in rec) && typeof rec.taskFolderPath === "string" && rec.taskFolderPath.length > 0) {
      knownTargetsImplReview = await peekFastForwardTargetsImplReviewFromPathV1(rec.taskFolderPath);
    }
  }
  if ((vscode.workspace.workspaceFolders ?? []).length === 0) {
    NotificationRouter.showError(
      "No workspace folder open. Please open a folder first."
    );
    return;
  }

  if (isMalformedReviewArg(arg as ReviewCommandArg | Record<string, unknown>)) {
    NotificationRouter.showError(
      "Fast Forward Review: unsupported argument shape. " +
        "Use { taskFolderPath } to target a specific task, or invoke without an argument to pick from a list."
    );
    return;
  }

  const consented = await ensureAiConsent(context);
  if (!consented) {
    return;
  }

  // Same eligibility as runReviewWithAI: review stages plus the pre-review
  // stages (plan, impl, publish) that map to the review they produce. This
  // lets automation dispatch the fast-forward loop right after a plan or
  // implementation run, while the task still sits on the pre-review stage —
  // the initial review below advances it onto the review stage itself.
  const resolved = await resolveTask(
    normalizeReviewArg(arg),
    Object.keys(REVIEW_TARGETS) as TaskStage[],
    "Fast Forward Review with AI",
    context
  );
  if (!resolved) {
    return;
  }
  if (resolved.progress.status === "paused") {
    NotificationRouter.showInformation("This task is paused. Resume it before fast-forwarding.");
    return;
  }

  const lockKey = resolved.folderUri.fsPath;
  await runTrackedOperation(
    lockKey,
    {
      label: "Fast Forward Review",
      stage: resolved.progress.currentStage,
      taskName: resolved.progress.displayName,
      kind: "fast-forward",
      cancellable: true,
    },
    async (op) => {
  const stage = resolved.progress.currentStage;
  // At a review stage this is the stage itself; at a pre-review stage (plan,
  // impl) it is the review that stage produces — the loop below always
  // operates on the target review's artifact.
  const targetStage = REVIEW_TARGETS[stage];
  const reviewUri = targetStage && artifactUri(resolved.folderUri, targetStage);
  if (!targetStage || !reviewUri) {
    NotificationRouter.showWarning(
      "Fast Forward Review: this stage does not have a review artifact."
    );
    return;
  }

  // ── §7.5 full availability gate, BEFORE any review artifact read ────────
  // Fast Forward's apply loop only reaches the sealed edit pipeline
  // (applyReviewEditWithAI's edit branch) when targetStage is an
  // implementation-review stage; plan-review fast-forwarding stays on the
  // text-only applyReview.v1 route and must not be blocked by the
  // Copilot-only edit requirement. This block ALWAYS runs for an
  // edit-eligible target, even when the coarse gate above already cleared
  // (or already rejected) it before resolveTask, because only here is the
  // resolved task's owning workspace known (the root-binding half of
  // checkEditActionAvailabilityV1 cannot run any earlier). Gate here —
  // before the review-content read below and before the initial-review run
  // further down — mirroring runImplementationWithAI's placement.
  if (IMPL_REVIEW_STAGES.includes(targetStage)) {
    // Enforce the coarse provider-path result computed at the very top of
    // fastForwardReviewWithAI — before resolveTask's read — FIRST, so a
    // bare/path-only/ambiguous invocation whose target only became known to
    // be an implementation review just now (via resolveTask, not via a
    // cache) still rejects without the further resolveOwnerWorkspace /
    // resolveFreshModelForStage reads below.
    // Codex review finding (P2): earlyProviderPathGate is NOT always assigned
    // here. `knownTargetsImplReview` can be `false` from a caller-supplied
    // `arg.task.progress` that says the target is a plan review (skipping the
    // gate above entirely, by design — a genuinely plan-review-only
    // invocation must never pay for it), yet `resolveTask` above always
    // re-reads progress from disk rather than trusting that cached snapshot.
    // If the task advanced to an implementation-review stage between when
    // the caller's cached arg was captured and this fresh read, targetStage
    // lands here anyway with earlyProviderPathGate still undefined — compute
    // it now instead of asserting a guarantee that stale cached input can
    // violate.
    const providerPathGate = earlyProviderPathGate ?? (await checkEditActionProviderPathGateV1("impl"));
    if (!providerPathGate.ok) {
      NotificationRouter.showWarning(providerPathGate.reason);
      return;
    }
    const editWorkspaceRoot = resolveOwnerWorkspace(resolved.progress);
    if (!editWorkspaceRoot) {
      NotificationRouter.showError(
        "Could not determine the owning workspace for this task. Please open the workspace that created it."
      );
      return;
    }
    const gateModel = await resolveFreshModelForStage(resolved.folderUri, "impl");
    const editAvailability = await checkEditActionAvailabilityV1({
      workspaceFsPath: editWorkspaceRoot.uri.fsPath,
      stageModelId: gateModel.modelId,
      stage: "impl",
    });
    if (!editAvailability.ok) {
      NotificationRouter.showWarning(editAvailability.reason);
      return;
    }
  }

  let initialContent = await readNonEmptyText(reviewUri);
  if (
    initialContent !== undefined &&
    (isUnusableAsExistingReview(initialContent) ||
      // An incomplete implementation round invalidated this review via the
      // durable marker WITHOUT staling the artifact's content (the content is
      // deliberately preserved) — it must not be treated as a current
      // baseline. Refusing it here routes into the same fresh-review path a
      // stale placeholder takes.
      resolved.progress.reviewInvalidatedByRound?.stage === targetStage)
  ) {
    initialContent = undefined;
  }
  if (!initialContent) {
    // No review has been run yet at this stage — run the initial review
    // first, then continue straight into the normal fast-forward loop
    // rather than telling the user to click Review separately first.
    const workspaceRoot = resolveOwnerWorkspace(resolved.progress);
    if (!workspaceRoot) {
      NotificationRouter.showError(
        "Could not determine the owning workspace for this task. Please open the workspace that created it."
      );
      return;
    }
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: `Running initial ${STAGE_DISPLAY_NAMES[targetStage] ?? "review"} before fast-forwarding...`,
        cancellable: false,
      },
      () => runReviewForFolder(extensionUri, resolved.folderUri, workspaceRoot, stage, true, { operation: op, chatViewProvider })
    );
    initialContent = await readNonEmptyText(reviewUri);
    // Same unusable check as the pre-dispatch read above (line ~3209) — the
    // review just dispatched by runReviewForFolder can be refused outright
    // (e.g. impl-summary.md is still the rejected-round stamp, so there are
    // no real implementation notes to review against), in which case
    // reviewUri is untouched and this re-read picks the SAME stale
    // placeholder back up. Without this check that placeholder read as "a
    // review exists" and fell through to the parseReadiness check below,
    // which produced a "no Readiness line, run the review again" message —
    // wrong, because running the review again is exactly what cannot work in
    // this state. Applying the same recognition here closes that gap.
    if (initialContent !== undefined && isUnusableAsExistingReview(initialContent)) {
      initialContent = undefined;
    }
    if (!initialContent) {
      NotificationRouter.showWarning(await describeUnusableReviewBlockV1(resolved.folderUri));
      return;
    }
  }

  const initialScore = parseReadiness(initialContent).score;
  if (initialScore === null) {
    NotificationRouter.showWarning(await describeUnusableReviewBlockV1(resolved.folderUri));
    return;
  }
  const baselineScore = initialScore;
  // Evidence from the review that already produced baselineScore — lets
  // improveReviewScore recognize a finished task before running a single
  // apply()/review() cycle (10: Fast Forward must be able to succeed from a
  // 10/10 baseline). Computed the same way review()'s callback below
  // computes it for each in-loop round, so the pre-loop and in-loop
  // evidence share one definition of "zero-fixable" and "plan incomplete".
  const initialMechanicalBlockers = getMechanicalBlockersForStage(resolved.folderUri, targetStage);
  const initialProgress = isPlanReviewStage(targetStage)
    ? parseReviewProgress(initialContent)
    : reconcileProgressWithChecklistV1(
        parseReviewProgress(initialContent),
        await readPlanChecklistProgressV1(resolved.folderUri)
      );
  const preLoopEvidence = {
    zeroFixableEvidence: resolveZeroFixableEvidenceV1(initialMechanicalBlockers, initialContent),
    planIncomplete: isPlanIncomplete(initialProgress),
  };
  // Reviewer identity + task-fixable count already on record for this stage's
  // most recent review round (the one that produced baselineScore), so the
  // in-loop scale-break check has something to compare a reviewer change
  // against. Absent for a task with no prior history entry (e.g. this
  // stage's very first review), which leaves the check inert for the whole
  // run — identical to today's behavior. Reads fresh from disk (see
  // resolveBaselineReviewHistoryEntryV1's doc comment): `resolved.progress`
  // is a snapshot from BEFORE the block above possibly ran the initial
  // review, so trusting it here would miss the very entry that review just
  // appended.
  const baselineHistoryEntry = await resolveBaselineReviewHistoryEntryV1(
    resolved.folderUri,
    targetStage,
    resolved.progress
  );
  const maxAttempts = getFastForwardMaxIterations();
  // The acceptance-threshold option uses the user's configured acceptance
  // threshold; it is not synonymous with a perfect 10/10 score.
  const configuredStopLevel = usesAcceptanceThresholdForFastForward()
    ? getAutoAdvanceScoreThreshold()
    : getFastForwardStopLevel();

  // Concrete, already-resolved task node so every attempt targets this same
  // task without resolveTask re-prompting (it already resolved the task once
  // above). Deliberately `{ task }` rather than `{ taskFolderPath }` (plan
  // §1.3): applyReviewWithAI's early gate check trusts an `arg.task`'s
  // already-known `progress.currentStage` to fire the applyReviewEdit.v1
  // gate BEFORE it performs any read of its own, whereas a `{ taskFolderPath
  // }` arg is deliberately re-wrapped with an untrustworthy placeholder stage
  // and must fall through to a fresh resolveTask read first. Fast Forward
  // already holds real, just-read progress here (apply review never changes
  // stage — the loop re-reviews without advancing), so passing it through
  // lets the edit-eligible case (impl-review targets) gate before any read
  // instead of after resolveTask's read inside applyReviewWithAI.
  const concreteArg: ReviewCommandArg = {
    task: {
      folderUri: resolved.folderUri,
      folderName: path.basename(resolved.folderUri.fsPath),
      progress: resolved.progress,
    },
  };

  let previousContent = initialContent;
  let attemptNumber = 0;
  const resilience = getResilienceSettings();

  // Set once isPaused has ridden through this run's own escalation (2a):
  // that un-pauses the task so the remaining attempts can run, which means
  // the run must RE-ASSERT the pause on every exit path — normal completion,
  // cancellation, or a thrown failure. Without that, a run that dies after
  // riding through leaves the task active with an escalation record and no
  // pause, and the escalation the user still has to act on loses the very
  // stop it was raised to cause.
  let escalationRiddenThrough = false;
  // Item 13 (2026-08-18..19 workflow-defects batch): each DISTINCT escalation
  // this run rides through (a fresh `paused` + `escalation` pair — the SAME
  // escalation is never re-appended, since isPaused only re-enters the
  // ride-through branch once the task is paused again with a new one), so
  // the end-of-run summary can name every re-fire as overridden-not-acted-on
  // instead of the operator inferring it from raw progress transitions.
  const riddenThroughEscalations: TaskEscalation[] = [];
  // Review finding (2026-08-20): `escalation` is deliberately never cleared
  // when it is ridden through (it survives for end-of-run reporting), so a
  // later read of `fresh.escalation` inside `isPaused` can still be the SAME
  // record this run already rode through once — e.g. the task was
  // subsequently paused again by hand (a genuine external pause) without a
  // fresh escalation replacing the stale one. Comparing against the last
  // ridden-through escalation's own `at` lets that case be told apart from a
  // real new escalation: a match means nothing new fired, so the pause must
  // be honored as external instead of being un-paused a second time as if it
  // were still "the same escalation being approved."
  let lastRiddenThroughEscalationAt: string | undefined;
  const reassertDeferredEscalationPause = async (): Promise<void> => {
    if (!escalationRiddenThrough) {
      return;
    }
    try {
      await patchTaskProgressStrictV1(resolved.folderUri, (current) =>
        current.status === "active" && current.escalation?.stage === targetStage
          ? updateTaskStatus(current, "paused")
          : current
      );
    } catch (error) {
      // Best-effort: the escalation record itself is already persisted, and
      // failing to re-pause must not mask the run's own outcome/error. Still
      // surface it — silently swallowing this would leave the task active
      // with an escalation record and no pause, with no trace of why.
      const message = error instanceof Error ? error.message : String(error);
      NotificationRouter.showWarning(
        `Escalation for ${STAGE_DISPLAY_NAMES[targetStage] ?? "review"} could not re-pause the task: ${message}`
      );
    }
  };

  let outcome: Awaited<ReturnType<typeof improveReviewScore>>;
  try {
    outcome = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: `Fast-forwarding ${STAGE_DISPLAY_NAMES[targetStage] ?? "review"}...`,
        cancellable: true,
      },
      (progress, token) => {
        // Cancelling from either surface — the native progress toast or the
        // Notifications-section cancel button (the operation's own token) —
        // must stop the loop.
        const linked = linkCancellationTokens(token, op.token);
        return improveReviewScore({
          context,
          stage: targetStage,
          baselineScore,
          maxAttempts,
          stopAtScore: configuredStopLevel,
          token: linked.token,
          apply: async () => {
            attemptNumber += 1;
            progress.report({
              message: `Attempt ${attemptNumber} of ${maxAttempts}...`,
            });
            // Iteration progress on the root operation's Notifications row.
            op.report(`iteration ${attemptNumber}/${maxAttempts}`);
            // Route by the review target's own kind (live dogfooding finding,
            // 2026-08-06): this callback previously called applyReviewWithAI
            // unconditionally, but that handler's first gate REFUSES
            // implementation-review stages outright (warning + return, zero
            // edits) — so Fast Forward on an impl-review target warned once
            // per attempt, applied nothing, review() then read unchanged
            // content, and the loop reported "stalled": structurally unable
            // to ever progress. Impl-review targets go to the edit-capable
            // applyReviewEditWithAI (identical signature; its own chained
            // re-review refreshes the artifact exactly like the plan path's,
            // which is what review() below reads), matching every other
            // dispatch surface (tree button, applyHighLevel/
            // applyLowLevelReviewChanges).
            const applyForTarget = IMPL_REVIEW_STAGES.includes(targetStage)
              ? applyReviewEditWithAI
              : applyReviewWithAI;
            await applyForTarget(
              extensionUri,
              context,
              concreteArg,
              buildFastForwardApplyReviewOptions(attemptNumber, op, chatViewProvider)
            );
          },
          // Escalation (see handleReviewRoutingOutcome) can now fire inside
          // Fast Forward and pause the task mid-loop. Without this check,
          // the next attempt's applyReviewWithAI silently no-ops on the
          // paused guard, review() then sees unchanged content and returns
          // null, and the loop reports "stalled" — blaming the provider for
          // a deliberate escalation it has no way to see otherwise.
          //
          // 2a (flagged): the pause SOURCE matters. An escalation this run's
          // own review just raised must not silently reduce an explicitly
          // requested multi-attempt run to a single round — the user already
          // answered "keep going" by clicking Fast Forward. With the flag
          // on, such a pause is classified "escalation", the task is
          // un-paused so the remaining attempts can actually run (the
          // escalation record itself is preserved for end-of-run reporting),
          // and the loop continues. Pauses from any OTHER source (manual,
          // another window, a different stage's escalation) still abort —
          // that is isPaused's original purpose.
          isPaused: async () => {
            const fresh = await readTaskProgressAdvisoryV1(resolved.folderUri);
            if (fresh?.status !== "paused") {
              return false;
            }
            const escalation = fresh.escalation;
            if (
              !isFreshEscalationForRideThroughV1(escalation, lastRiddenThroughEscalationAt) ||
              !shouldRideThroughEscalationV1({
                survivesEscalationSetting: resilience.fastForwardSurvivesEscalation,
                escalationStage: escalation?.stage,
                escalationKind: escalation?.kind,
                targetStage,
              })
            ) {
              return "external";
            }
            // Review finding (2026-08-20): the write-time CAS previously
            // checked only status + stage, so a DIFFERENT escalation on the
            // same stage — e.g. a `plateau`, which must never ride through —
            // recorded between the read above and this write would still be
            // un-paused. The CAS now re-verifies the exact escalation
            // (stage, kind, AND its own `at`) that was just inspected, and
            // durably records the override (`overriddenEscalations`) in the
            // SAME transaction as the un-pause, so a crash between deciding
            // and reporting can never leave the override unrecorded.
            //
            // Second review finding (2026-08-20): checking only
            // `patched?.status === "active"` afterward cannot prove OUR
            // mutation ran — the decline branch also returns a value (the
            // unmodified `current`), and if that task's status happened to
            // already read "active" for an unrelated reason (a manual resume
            // racing this same check, or a stale read), the decline would be
            // misreported as a successful ride-through. `mutationApplied` is
            // an explicit receipt set ONLY inside the true branch, so success
            // requires both "our branch actually ran" AND "the write landed",
            // not an inference from the resulting status alone.
            let mutationApplied = false;
            const patched = await patchTaskProgressStrictV1(resolved.folderUri, (current) => {
              if (!escalationIdentityStillMatchesV1(current, escalation, targetStage)) {
                return current;
              }
              mutationApplied = true;
              return appendOverriddenEscalation(updateTaskStatus(current, "active"), escalation);
            });
            // The identity CAS above can decline — a fresher/different
            // escalation replaced the inspected one between the read and the
            // write. Nothing was actually ridden through in that case, so
            // the pause must still abort the run rather than be reported as
            // overridden.
            if (!mutationApplied || patched?.status !== "active") {
              return "external";
            }
            escalationRiddenThrough = true;
            lastRiddenThroughEscalationAt = escalation.at;
            riddenThroughEscalations.push(escalation);
            // Item 13 fix 2: the escalation's own notification/chat question
            // (escalateReviewToHuman, raised moments earlier from inside the
            // review round this same attempt just ran) already told the
            // operator "the task has been paused — resume it once you've
            // decided how to proceed." That claim is now false the instant
            // this un-pause lands, so a corrective, honestly-worded follow-up
            // is posted immediately rather than leaving the stale claim as
            // the last word until end-of-run.
            NotificationRouter.showWarning(
              `Fast Forward Review: a ${escalation.kind} escalation was raised on ` +
                `${STAGE_DISPLAY_NAMES[targetStage] ?? targetStage} but is being ridden through — ` +
                `continuing to the end of the current attempt budget (attempt ${attemptNumber} of ` +
                `${maxAttempts}) instead of stopping now. The escalation is still recorded and will be ` +
                "re-asserted as a pause once this run finishes."
            );
            // Item 13 fix 3 (review finding, 2026-08-20): the durable
            // `overriddenEscalations` field written above had no reader —
            // only visible by opening task-progress.json directly. A run
            // log entry is the artifact a user actually inspects after the
            // fact (see writeReviewRunLogV1's own "best-effort diagnostic
            // artifact" precedent), so every override is now also recorded
            // there, explicitly marked when it is a RE-FIRE (the same or a
            // later escalation overridden more than once in this run) so
            // that is visible as such rather than reading as a single
            // occurrence finally acted on.
            void writeRunLog(
              resolved.folderUri,
              "fast-forward-escalation-override",
              targetStage,
              `# Escalation overridden (Fast Forward ride-through)\n\n` +
                `A ${escalation.kind} escalation on ${STAGE_DISPLAY_NAMES[targetStage] ?? targetStage} was ` +
                "overridden — not acted on — so this Fast Forward run could continue to the end of its attempt " +
                "budget, instead of stopping for the pause it raised.\n\n" +
                `- Raised at: ${escalation.at}\n` +
                `- Reason: ${escalation.reason}\n` +
                `- Overridden during attempt ${attemptNumber} of ${maxAttempts}\n` +
                (riddenThroughEscalations.length > 1
                  ? `- This is override #${riddenThroughEscalations.length} for this run — a previous ` +
                    "escalation on this stage was already overridden earlier in the same run; see the earlier " +
                    "run log(s) and the task's durable `overriddenEscalations` record for the full sequence.\n"
                  : "")
            ).catch(() => {
              // Best-effort: a run-log write failure must not abort the
              // ride-through decision that already durably persisted above.
            });
            return "escalation";
          },
          continueThroughEscalation: resilience.fastForwardSurvivesEscalation,
          zeroFixableTerminates: resilience.zeroFixableTerminatesFastForward,
          preLoopEvidence,
          baselineReviewer: baselineHistoryEntry?.reviewer,
          baselineTaskFixableCount: baselineHistoryEntry?.taskFixableCount,
          review: async () => {
            const newContent = await readNonEmptyText(reviewUri);
            if (!newContent || newContent === previousContent) {
              return null;
            }
            previousContent = newContent;
            const detailed = parseReviewBlockersDetailed(newContent);
            // Mechanical blockers (step 4 of the fail-closed-parsing fix),
            // cached by buildVerifiedChecksVariable when this round's prompt
            // was assembled: a failed Verified Check must count toward
            // taskFixableCount, and must veto zeroFixableEvidence, exactly
            // like a parsed reviewer blocker — a model-authored blocker line
            // that happens to fail to parse must never be the ONLY thing
            // standing between "checks are failing" and "clean round".
            const mechanicalBlockers = getMechanicalBlockersForStage(resolved.folderUri, targetStage);
            return {
              score: parseReadiness(newContent).score,
              taskFixableCount: detailed.blockPresent
                ? detailed.blockers.filter((b) => b.resolver === "task-fixable").length + mechanicalBlockers.length
                : mechanicalBlockers.length > 0
                  ? mechanicalBlockers.length
                  : null,
              // Positive evidence only: a parsed (present) blocker block
              // with no task-fixable entry, or an explicit no-blockers
              // statement — never the mere absence of the block. A
              // mechanically-synthesized task-fixable blocker overrides that
              // to false regardless of what the reviewer's own block says —
              // a Verified Check that is still failing is never a clean
              // round, no matter how the reviewer described it.
              zeroFixableEvidence: resolveZeroFixableEvidenceV1(mechanicalBlockers, newContent),
              // "Clean so far" vs "clean and finished" — null when the review
              // emitted no marker, which preserves the pre-marker behavior.
              // Reconciled against the plan of record's checklist for the same
              // reason as the advancement gate: a narrowed denominator would
              // otherwise terminate this loop early, reporting success with
              // most of the plan unbuilt. Skipped for plan reviews for the
              // same reason as there — a rolled-back task's leftover
              // implementation checklist is not that stage's progress.
              progress: isPlanReviewStage(targetStage)
                ? parseReviewProgress(newContent)
                : reconcileProgressWithChecklistV1(
                    parseReviewProgress(newContent),
                    await readPlanChecklistProgressV1(resolved.folderUri)
                  ),
              // apply() already ran handleReviewRoutingOutcome for this same
              // round (via applyReviewWithAI/applyReviewEditWithAI), which
              // appended this round's own reviewScoreHistory entry — including
              // its resolved reviewer identity — before review() runs. Read it
              // back rather than re-deriving it, so the scale-break check
              // below compares against the SAME identity the durable history
              // records for this round.
              reviewer: (await readTaskProgressAdvisoryV1(resolved.folderUri))?.reviewScoreHistory?.filter(
                (entry) => entry.stage === targetStage
              ).at(-1)?.reviewer,
            };
          },
        }).finally(() => linked.dispose());
      }
    );
  } catch (error) {
    // The run is over (cancelled or failed) — if it rode through its own
    // escalation, the pause that escalation asserted must come back now.
    await reassertDeferredEscalationPause();
    if (error instanceof vscode.CancellationError) {
      if (targetStage === "publish") {
        NotificationRouter.showWarning(
          `Fast Forward Review cancelled after ${attemptNumber} attempt(s). ` +
            "Publish manually once you're satisfied, or use Publish Anyway from Commit and Push.",
          undefined,
          undefined,
          undefined,
          {
            command: "vs-code-ai-helper.commitAndPushTask",
            title: "Publish Anyway",
            args: [{ taskFolderPath: resolved.folderUri.fsPath }],
          }
        );
      } else {
        NotificationRouter.showInformation(
          `Fast Forward Review cancelled after ${attemptNumber} attempt(s).`
        );
      }
      return;
    }
    if (targetStage === "publish") {
      // Any other failure (provider error, apply-review failure, etc.) also
      // prevents publishing — give the same one-click way to publish anyway
      // rather than only the generic operation-failed notification the
      // tracked-operation wrapper will also emit once this rethrows.
      const message = error instanceof Error ? error.message : String(error);
      NotificationRouter.showWarning(
        `Fast Forward Review failed after ${attemptNumber} attempt(s): ${message} ` +
          "Publish manually once you're satisfied, or use Publish Anyway from Commit and Push.",
        undefined,
        undefined,
        undefined,
        {
          command: "vs-code-ai-helper.commitAndPushTask",
          title: "Publish Anyway",
          args: [{ taskFolderPath: resolved.folderUri.fsPath }],
        }
      );
    }
    throw error;
  }

  // The run finished — if it rode through its own escalation, re-assert the
  // pause that escalation originally asserted before reporting the outcome.
  await reassertDeferredEscalationPause();
  if (outcome.escalationDeferred) {
    // 2a: an escalation fired during the run but (per
    // ensemble.resilience.fastForwardSurvivesEscalation) did not abort it.
    // The escalation's own notification/chat question already carried the
    // reason; this re-surfaces it at end of run so finishing the attempt
    // budget never buries a signal the user must still act on.
    //
    // Item 13 fix 3: name every DISTINCT escalation this run overrode rather
    // than a single undifferentiated "an escalation fired" — a ceiling that
    // re-fires more than once in one run (observed: churn ceiling firing at
    // 5 rounds, then again at 6, with no prior record of the first override)
    // must be visible as re-fired-and-overridden, not mistaken for a single
    // occurrence that was finally acted on.
    const overriddenList = riddenThroughEscalations
      .map((escalation, index) => `${index + 1}. [${escalation.kind}, ${escalation.at}] ${escalation.reason}`)
      .join("\n");
    NotificationRouter.showWarning(
      `Fast Forward Review: automated review iteration escalated ${riddenThroughEscalations.length} time(s) ` +
        "during this run and was overridden — not acted on — each time so the run could finish its attempt " +
        "budget. The task has been returned to paused — review the escalation(s) below and resume the task " +
        `once you've decided how to proceed.${overriddenList.length > 0 ? `\n\n${overriddenList}` : ""}`
    );
  }
  if (outcome.improved) {
    NotificationRouter.showInformation(
      `Fast Forward Review: score improved to ${outcome.score}/10 after ${outcome.attempts} attempt(s).`
    );
  } else if (outcome.zeroFixableSuccess) {
    // 2h: two consecutive reviews each carried positive evidence of zero
    // task-fixable blockers — terminal success regardless of score movement.
    // Without this stop, "no blockers found, ready to proceed" rounds whose
    // number failed to move +0.1 burned the remaining attempts (observed:
    // 37 zero-blocker rounds across one task, none of which stopped it).
    // The observation is stage-scoped, so the conclusion must be too. An
    // implementation task has TWO review stages, and a clean run on one says
    // nothing about the other: observed 2026-08-19, this stopped announcing
    // "nothing fixable remains" from an `impl-high-review` 9/10 while the
    // task's own `impl-low-review` stood at 5/10 with three task-fixable
    // blockers — which read to the user as the task being finished, when the
    // sibling stage had unresolved work and a matching Apply Review action
    // waiting for it.
    const siblingImplStage: TaskStage | undefined =
      targetStage === "impl-low-review"
        ? "impl-high-review"
        : targetStage === "impl-high-review"
          ? "impl-low-review"
          : undefined;
    // Read fresh rather than trusting `resolved.progress`: that snapshot
    // predates every round this Fast Forward run just completed.
    const siblingRead = siblingImplStage
      ? await readTaskProgressStrictV1(resolved.folderUri, {
          expectedTaskFolder: path.basename(resolved.folderUri.fsPath),
        })
      : undefined;
    const siblingHistoryEntry =
      siblingRead?.ok === true
        ? (siblingRead.decoded.progress.reviewScoreHistory ?? [])
            .filter((entry) => entry.stage === siblingImplStage)
            .at(-1)
        : undefined;
    const siblingBlockers = siblingHistoryEntry?.taskFixableCount ?? 0;
    const stageName = STAGE_DISPLAY_NAMES[targetStage];
    if (siblingImplStage && siblingBlockers > 0) {
      NotificationRouter.showWarning(
        `Fast Forward Review: stopped after ${outcome.attempts} attempt(s) — two consecutive ` +
          `${stageName} rounds found nothing left to fix (last score ${outcome.score}/10). ` +
          `The task is NOT finished, though: the ${STAGE_DISPLAY_NAMES[siblingImplStage]} still lists ` +
          `${describeTaskFixableBlockersV1(siblingBlockers, siblingHistoryEntry?.blockers)}. ` +
          "Use Apply Review to fix those.",
        undefined,
        undefined,
        undefined,
        {
          // The task is at the stage Fast Forward targeted, so the SIBLING
          // stage's apply command is out of stage — move first. Resumes the
          // task first if it has since been paused (review blocker
          // 2026-08-30, item 14) rather than the plain goToReviewAndApply,
          // which fails with a confusing "task could not be found" on a
          // paused task.
          command: "vs-code-ai-helper.resumeIfPausedThenGoToReviewAndApply",
          title: "Go to Review & Apply",
          args: [
            {
              taskFolderPath: resolved.folderUri.fsPath,
              reviewStage: siblingImplStage,
            },
          ],
        }
      );
    } else {
      NotificationRouter.showInformation(
        `Fast Forward Review: stopped after ${outcome.attempts} attempt(s) — two consecutive ` +
          `${stageName} rounds reported zero task-fixable blockers (last score ${outcome.score}/10). ` +
          `Nothing fixable remains in ${stageName} for further automated iteration.`
      );
    }
  } else if (outcome.paused) {
    // The escalation that paused the task already showed its own
    // notification (and chat question) with the actual reason — this just
    // frames the Fast Forward stop correctly instead of falling through to
    // "stalled", which would misattribute a deliberate pause to the provider.
    // showWarning, not showInformation: only showWarning carries an action
    // button, and this also matches the severity of both the escalation's
    // own notification and every sibling branch below. Still offers Publish
    // Anyway for the publish stage, matching those siblings: a user who
    // decides the escalation is acceptable must have the same one-click
    // recovery, not have to find Commit and Push manually.
    NotificationRouter.showWarning(
      `Fast Forward Review stopped after ${outcome.attempts} attempt(s): the task was paused for review — ` +
        "see the notification above for why, and resume the task once you've decided how to proceed." +
        (targetStage === "publish" ? " Publish manually once you're satisfied, or use Publish Anyway from Commit and Push." : ""),
      undefined,
      undefined,
      undefined,
      targetStage === "publish"
        ? {
            command: "vs-code-ai-helper.commitAndPushTask",
            title: "Publish Anyway",
            args: [{ taskFolderPath: resolved.folderUri.fsPath }],
          }
        : undefined
    );
  } else if (outcome.stalled) {
    NotificationRouter.showWarning(
      `Fast Forward Review stopped after ${outcome.attempts} attempt(s): the review did not change. ` +
        "Check the run log — the provider may have failed or been blocked." +
        (targetStage === "publish" ? " Publish manually once you're satisfied, or use Publish Anyway from Commit and Push." : ""),
      undefined,
      undefined,
      undefined,
      targetStage === "publish"
        ? {
            command: "vs-code-ai-helper.commitAndPushTask",
            title: "Publish Anyway",
            args: [{ taskFolderPath: resolved.folderUri.fsPath }],
          }
        : undefined
    );
  } else {
    // A best score already at or below the rubric's blocker cap, while the
    // configured stop level asks for something higher, means "attempts
    // exhausted" is not the real story: the rubric asks reviewers to keep
    // the score at 7 or below whenever any blocker is reported, so a stop
    // level above 7 cannot be reached for as long as any blocker keeps
    // getting reported, no matter how many attempts remain. Naming that
    // here turns a wasted 20-attempt run into an actionable next step
    // instead of a generic "try again" warning.
    //
    // Which SETTING actually produced configuredStopLevel depends on
    // usesAcceptanceThresholdForFastForward (see its assignment above) —
    // telling the user to touch fastForwardStopLevel when this run was
    // actually gated by autoAdvanceScoreThreshold (or vice versa) would send
    // them to edit a setting that has no effect on this outcome at all.
    const explainRubricCap = rubricCapLikelyBlockedAdvance(outcome.score, configuredStopLevel);
    const stopLevelSettingName = usesAcceptanceThresholdForFastForward()
      ? "autoAdvanceScoreThreshold"
      : "fastForwardStopLevel";
    NotificationRouter.showWarning(
      `Fast Forward Review: target not reached after ${maxAttempts} attempts (best score ${
        outcome.score ?? "—"
      }/10).` +
        (explainRubricCap
          ? ` The review rubric normally keeps the score at ${REVIEW_RUBRIC_BLOCKER_SCORE_CAP} or below whenever any blocker is reported, so a configured ${stopLevelSettingName} of ${configuredStopLevel} cannot be reached while blockers remain — lower ${stopLevelSettingName} to ${REVIEW_RUBRIC_BLOCKER_SCORE_CAP} or resolve the outstanding blockers directly.`
          : "") +
        (targetStage === "publish" ? " Publish manually once you're satisfied, or use Publish Anyway from Commit and Push." : ""),
      undefined,
      undefined,
      undefined,
      targetStage === "publish"
        ? {
            command: "vs-code-ai-helper.commitAndPushTask",
            title: "Publish Anyway",
            args: [{ taskFolderPath: resolved.folderUri.fsPath }],
          }
        : undefined
    );
  }
    }
  );
}

/**
 * Apply an implementation review by re-running the AI implementation
 * runner against the review's findings.
 *
 * Uses the `implementation` model for execution, not the review-stage model.
 *
 * The implementation runner needs two distinct task artifacts:
 * - plan.md is the approved contract the code must follow.
 * - plan-final.md is the previous implementation summary, useful as history
 *   but never an authority to waive a plan requirement.
 *
 * Legacy tasks (implementation.md present, plan-final.md absent) are handled
 * via materializeCanonicalIfNeeded, which copies implementation.md →
 * plan-final.md before reading the canonical content. This mirrors the same
 * migration path used by generateImplementationWithAI and runImplementationWithAI.
 */
/**
 * Assemble the apply-review prompt (context pack + approved plan +
 * implementation notes + review content) rendered from
 * `apply-impl-review-code.md`. Extracted from `applyImplementationReviewWithAI`
 * so a recovery continuation whose SOURCE round was dispatched as Apply
 * Review (item 17b) can render from the identical template and review
 * content instead of silently reverting to a checklist-driven
 * `run-implementation.md` continuation — the exact regression the plan
 * warns "a bug to fix, not a toggle to offer" in a different context, but
 * the same class of silent mode loss.
 */
async function buildApplyReviewPromptPartsV1(
  extensionUri: vscode.Uri,
  folderUri: vscode.Uri,
  contextPackContent: string,
  reviewContent: string
): Promise<{ prompt: string; templateVariables: Record<string, string> } | { error: string }> {
  let canonicalUri: vscode.Uri;
  try {
    canonicalUri = await materializeCanonicalIfNeeded(folderUri);
  } catch {
    return { error: stageActionRequirementMessageV1("applyReviewImplementation", 0) };
  }

  const planOfRecordNotes = await readNonEmptyText(canonicalUri);
  if (!planOfRecordNotes) {
    return { error: stageActionRequirementMessageV1("applyReviewImplementation", 0) };
  }

  const latestSummary = await readNonEmptyText(getImplementationSummaryUri(folderUri));
  const implementationNotes =
    latestSummary && !isUnusableImplementationSummaryV1(latestSummary)
      ? `${planOfRecordNotes}\n\n---\n\n## Latest implementation round summary\n\n${latestSummary}`
      : planOfRecordNotes;

  let approvedPlan: string | undefined;
  let planName = "plan.md";
  try {
    const approvedPlanUri = await resolveCurrentPlanUri(folderUri);
    planName = path.basename(approvedPlanUri.fsPath);
    approvedPlan = await readNonEmptyText(approvedPlanUri);
  } catch {
    // Handled by !approvedPlan guard below
  }

  if (!approvedPlan) {
    return {
      error: `No approved plan found (or it is empty). Generate or restore ${planName} before applying an implementation review.`,
    };
  }

  const templateVariables = {
    contextPack: contextPackContent,
    approvedPlan,
    implementation: implementationNotes,
    review: reviewContent,
  };
  const prompt = await renderPromptTemplate(
    extensionUri,
    "apply-impl-review-code.md",
    templateVariables
  );

  return { prompt, templateVariables };
}

async function applyImplementationReviewWithAI(
  extensionUri: vscode.Uri,
  folderUri: vscode.Uri,
  workspaceRoot: vscode.WorkspaceFolder,
  stage: TaskStage,
  reviewContent: string,
  // Resolved by the caller (applyReviewEditWithAI) BEFORE its full §7.5
  // availability gate and before any review/plan/plan-final artifact read —
  // passed through rather than re-resolved here so the model the gate
  // checked is exactly the model this run uses.
  model: ResolvedStageModel,
  options: ApplyReviewOptions & ExecuteImplementationRunOptions
): Promise<boolean> {
  // Edit-capable sibling of the "applyReview.v1" text route, MIGRATED by
  // §7.8: it runs through runImplementationOrSealedV1 with editActionKey
  // "applyReviewEdit.v1" (the sealed two-phase pipeline for a
  // Copilot-resolved model, or a direct edit-mode invocation for a
  // CLI-resolved one). The assertion is kept under its own route id so
  // re-gating "applyReview.v1" for plan-review stages never implicitly
  // toggles implementation-review edit runs.
  assertLegacyAiRouteAllowedV0("applyReviewEdit.v1");
  // §7.5 host gate (AC-HOST-03): the full provider/root availability gate
  // already ran in the caller before any read; this cheap host-only check is
  // kept as defense-in-depth for any other caller reaching this function
  // directly, before the plan-final materialization and review-content reads
  // below. Only applies to a Copilot-resolved model — the already-resolved
  // `model` here may be CLI-backed, which never touches the LM tool API this
  // gate exists to prove usable.
  let usesCopilotModel: boolean;
  try {
    usesCopilotModel = resolveEffectiveProvider(model.modelId).kind === "copilot";
  } catch {
    usesCopilotModel = false;
  }
  if (usesCopilotModel) {
    const hostGate = checkEditActionHostGateV1();
    if (!hostGate.ok) {
      NotificationRouter.showWarning(hostGate.reason);
      return false;
    }
  }
  // The `implementation` stage's model was already resolved by the caller
  // (before its full §7.5 gate) — re-check liveness only, since availability
  // can change while the reads above ran.
  const { availability, providerLabel } =
    await checkImplementationAvailabilityForModel(model.modelId, "impl");
  if (!availability.available) {
    NotificationRouter.showWarning(
      `${providerLabel} is unavailable: ${availability.reason ?? "unknown reason"}. Address the review manually instead.`
    );
    return false;
  }

  const contextPackContent = await generateContextPack(folderUri, workspaceRoot.uri);

  // {{implementation}} carries BOTH the plan of record and the latest
  // implementation summary, because this prompt needs both and they now live
  // in different files. apply-impl-review-code.md tells the round to echo the
  // plan's checklist back (so plan progress keeps accumulating), which
  // requires the plan of record — but before the split, plan-final.md also
  // held the last round's summary, so the round could see its Files Changed /
  // Verification / remaining blockers. Swapping wholesale to impl-summary.md
  // would restore that evidence and lose the checklist; appending keeps both,
  // checklist first so the echo instruction reads naturally. A summary
  // stamped unusable is omitted rather than presented as notes — there is
  // nothing reviewable in a rejection stamp.
  const parts = await buildApplyReviewPromptPartsV1(
    extensionUri,
    folderUri,
    contextPackContent,
    reviewContent
  );
  if ("error" in parts) {
    NotificationRouter.showWarning(parts.error);
    return false;
  }
  const prompt = parts.prompt;

  // ── Prompt-size gate ─────────────────────────────────────────────────────
  const sizeCheck = await checkAndConfirmPromptSize(prompt, providerLabel);
  if (sizeCheck === "abort" || sizeCheck === "declined") {
    return false;
  }

  const dispatchedBlockerIds = await blockerIdentitiesHandedToApplyReviewV1(folderUri, stage);

  // suppressAutoReviewDispatch: the caller (applyReviewWithAI) re-reviews
  // inline under the lock it already holds — see that option's doc comment
  // for why the deferred dispatch here would otherwise be refused as busy.
  return executeImplementationRun(
    extensionUri,
    folderUri,
    workspaceRoot,
    prompt,
    model.modelId,
    `Applying implementation review with ${providerLabel}...`,
    stage,
    {
      ...options,
      suppressAutoReviewDispatch: true,
      editActionKey: "applyReviewEdit.v1",
      onBusyDetail: options.parentOperation ? (d) => options.parentOperation!.report(d) : undefined,
      onWaitingForUser: options.parentOperation
        ? (w) => options.parentOperation!.setWaitingForUser(w)
        : undefined,
      templateName: "apply-impl-review-code.md",
      templateVariables: parts.templateVariables,
      dispatchedBlockerIds,
    }
  );
}

/**
 * Open the review artifact for the task's current review stage.
 */
export async function viewReview(
  context: vscode.ExtensionContext,
  arg?: ReviewCommandArg
): Promise<void> {
  // ── Malformed-arg guard ───────────────────────────────────────────────────
  // Primitives ("x", 42, true) fall through to normalizeReviewArg safely.
  if (isMalformedReviewArg(arg as ReviewCommandArg | Record<string, unknown>)) {
    NotificationRouter.showError(
      "View Review: unsupported argument shape. " +
        "Use { taskFolderPath } to target a specific task, or invoke without an argument to pick from a list."
    );
    return;
  }

  const resolved = await resolveTask(
    normalizeReviewArg(arg),
    REVIEW_STAGES,
    "View Review",
    context
  );
  if (!resolved) {
    return;
  }
  const stage = resolved.progress.currentStage;
  const reviewUri = artifactUri(resolved.folderUri, stage);
  if (!reviewUri) {
    return;
  }
  const content = await readNonEmptyText(reviewUri);
  if (!content) {
    const choice = await vscode.window.showInformationMessage(
      `No ${STAGE_ARTIFACT_FILENAMES[stage]} yet for this task.`,
      "Review with AI",
      "Create Manually"
    );
    if (choice === "Review with AI") {
      await vscode.commands.executeCommand(
        "vs-code-ai-helper.runReviewWithAI",
        arg
      );
    } else if (choice === "Create Manually") {
      await openOrCreateDocument(reviewUri);
    }
    return;
  }
  // Review freshness: if the recorded reviewed-commit is no longer HEAD, the
  // artifact must say so under its Readiness line, not only in a trailing
  // HTML comment an operator never scrolls to. The upsert is a no-op for
  // plan reviews (no marker), placeholders, and current reviews. Best-effort:
  // opening the review must never fail over a courtesy marker.
  //
  // Gated on the translated active-run signal so opening the artifact WHILE
  // a rerun of this same review stage is genuinely in flight can never heal
  // its in-progress banner back to stale — the exact "recreate the
  // complaint on the banner surface" bug this gate exists to prevent.
  try {
    if (!isReviewActivelyRerunningV1(resolved.folderUri.fsPath, stage)) {
      const headSha = await resolveHeadCommitSha(resolved.folderUri.fsPath);
      await refreshStaleReviewBannerForArtifactV1(reviewUri, headSha);
    }
  } catch {
    // Marker only — open the artifact regardless.
  }
  await safeOpenTextDocument(
    reviewUri,
    STAGE_ARTIFACT_FILENAMES[stage] ?? "review"
  );
}

/**
 * Advance a task to the next stage in the workflow.
 * Auto-triggers review when advancing into a review stage from its
 * immediately preceding non-review stage (plan -> plan-high-review, or
 * implementation -> impl-high-review).
 * No confirmation dialogs.
 *
 * Uses the shared `advanceStage` helper to guarantee persist-first ordering
 * and exactly-once auto-review dispatch per successful transition.
 *
 * When advancing to "completed", runs in strict lifecycle order:
 *   1. persist completion (advanceStage)
 *   2. refresh inventory (via progress-file watcher, or caller)
 *   3. show completion message
 *   4. (future: persist lint payload)
 *   5. show final info
 */
/**
 * Persist a forward stage transition through the `nextStage.v1` registry row
 * (plan §6.6) — typed coordinator delegation, including a configured-review-
 * stage skip (`next` may be beyond the literal `STAGE_ORDER` successor; the
 * row's `targetStage` input carries it through the same field-policy
 * transition rather than a synthetic intermediate hop). Throws (mirroring
 * `advanceStage`'s CAS-mismatch throw) on any non-`completed` outcome, so
 * callers can share one catch block with other transition kinds still on the
 * legacy path (manual stage jumps, resets, reopen, recovery).
 *
 * Used both by manual "Complete Stage & Move On" and by every review-
 * triggered forward transition (a review's own stage-advance, and score-based
 * auto-advance after a review or an implementation run) — see
 * `nextStageRowV1.ts`'s header for why a same-stage re-review confirmation is
 * handled by the caller instead of going through this helper.
 *
 * @param status  The task's persisted status, read fresh by the caller
 *   immediately before calling (mirrors `advanceStage`'s own no-staleness
 *   contract) — used only for the coordinator's eligibility pre-check;
 *   the row's own field policy independently re-validates `active` inside
 *   the lock.
 * @param currentStage  The stage the caller observed as current immediately
 *   before this call — the row's `expectedSourceStage` CAS.
 * @param expectedReviewAttemptId  Optional CAS against the freshly re-read
 *   progress's `reviewAttemptId` (mirrors `advanceStage`'s parameter of the
 *   same name) — rejects a stale review attempt that lost the race to a
 *   newer one on the same stage.
 * @param publishArtifact  Optional side effect (e.g. renaming a staged plan
 *   into `plan-final.md`) run atomically with the row's CAS check/write via
 *   `nextStage.v1`'s `beforeWrite` side channel — see that field's header.
 */
async function advanceStageViaNextStageRowV1(
  folderUri: vscode.Uri,
  binding: Pick<TaskProgress, "ownership" | "taskFolder">,
  status: TaskProgress["status"] | undefined,
  currentStage: TaskStage,
  next: TaskStage,
  isPaused: boolean,
  optIn: boolean,
  expectedReviewAttemptId?: string,
  publishArtifact?: () => Promise<void>,
  artifactOverride?: "user"
): Promise<StageTransitionResult> {
  // Plan §3.9: the task-binding identity is the digest derived from this
  // task's persisted ownership + taskFolder EXACTLY AS PERSISTED (never a
  // re-normalized filesystem path) — the same derivation every provider row
  // (generatePlan.v1, draft.v1, ...) uses for the same task via
  // verifyTaskFolderOwnershipBindingV1, so leases and audit records key on
  // one identity per task regardless of which action touches it. An
  // underivable binding (missing/unresolved ownership) throws below exactly
  // like every other non-`completed` outcome this function already throws on.
  const derivedBinding = deriveTaskBindingV1(binding);
  if (!derivedBinding.ok) {
    throw new Error("taskBindingUnavailable");
  }
  const taskBindingId = derivedBinding.binding.bindingId;
  const outcome: TaskActionOutcomeV1 = await invokeLifecycleRowV1({
    actionKey: NEXT_STAGE_ACTION_KEY_V1,
    taskFolderPath: folderUri.fsPath,
    taskBindingId,
    chatDocumentIdentitySeed: folderUri.fsPath,
    workspaceCwd: path.dirname(folderUri.fsPath),
    taskStatus: status ?? "active",
    taskStage: currentStage,
    rawInput: {
      taskFolderPath: folderUri.fsPath,
      expectedSourceStage: currentStage,
      // Passed explicitly (rather than relying on the row's own default
      // STAGE_ORDER successor) so a configured-review-stage skip lands
      // directly on `next` — see this function's header.
      targetStage: next,
      ...(expectedReviewAttemptId !== undefined ? { expectedReviewAttemptId } : {}),
      ...(artifactOverride === "user" ? { artifactOverride } : {}),
    },
    beforeWrite: publishArtifact ? async (): Promise<void> => { await publishArtifact(); } : undefined,
  });
  if (outcome.kind !== "completed") {
    throw new Error(outcome.kind === "failed" ? outcome.code : outcome.kind);
  }
  const shouldAutoReview =
    optIn && !isPaused && isReviewStage(next) && AUTO_REVIEW_TRANSITIONS[currentStage] === next;
  return { persisted: true, newStage: next, shouldAutoReview };
}

/**
 * wf10 item 19 / Step 28 (review blocker a96160ec-…-2, third narrowing,
 * resolved 2026-08-25): the two pre-existing consumers of
 * `blockerSupersessions` — `readStageArtifactsForChat` (chatWithStage.ts) and
 * `computePlanReviewBlockerSupersessionEvidenceV1` (reconcilePlanChecklist.ts)
 * — are both informational; neither is consulted by the transition itself,
 * so a manual "Complete Stage & Move On" could silently advance past a
 * blocker the artifacts still list as outstanding. This reads the CURRENT
 * plan-review stage's own review artifact fresh and returns whatever
 * blockers `filterSupersededBlockersV1` says remain outstanding — the same
 * set a human reading the review would see as unresolved. Scoped to
 * `PLAN_REVIEW_STAGES` only, matching `blockerSupersessions`'s own
 * documented scope (it is never recorded against any other stage kind).
 */
async function getOutstandingPlanReviewBlockersForAdvanceV1(
  folderUri: vscode.Uri,
  stage: TaskStage,
  blockerSupersessions: readonly BlockerSupersessionRecordV1[] | undefined
): Promise<ReviewBlocker[]> {
  if (!PLAN_REVIEW_STAGES.includes(stage)) {
    return [];
  }
  const filename = STAGE_ARTIFACT_FILENAMES[stage];
  if (!filename) {
    return [];
  }
  const reviewUri = vscode.Uri.joinPath(folderUri, filename);
  const content = await readTextIfExists(reviewUri);
  if (!content?.trim()) {
    return [];
  }
  const blockers = parseReviewBlockers(content);
  if (blockers.length === 0) {
    return [];
  }
  let mtimeMs: number | undefined;
  try {
    mtimeMs = (await vscode.workspace.fs.stat(reviewUri)).mtime;
  } catch {
    mtimeMs = undefined;
  }
  return filterSupersededBlockersV1(stage, blockers, blockerSupersessions, mtimeMs);
}

export async function nextStage(
  _extensionUri: vscode.Uri,
  context: vscode.ExtensionContext,
  node?: TaskNodeArg,
  /**
   * Set only by the "Complete Anyway" notification action
   * (`vs-code-ai-helper.completeStageAnywayV1`) dispatched from the warning
   * below. Never a requirement to advance (plan Part 14's own wording: "a
   * full re-review remains an offered stronger option, never a
   * requirement") — this is the one-click override, not a hard block.
   */
  bypassBlockerGate = false,
  artifactOverride = false
): Promise<void> {
  // Publish is the final executable stage: its review is generated here and
  // completion/release remain explicit actions. There is no stage after it.
  const advanceable = STAGE_ORDER;
  const resolved = await resolveTask(node, advanceable, "Next Stage", context);
  if (!resolved) {
    return;
  }

  // "Complete Stage & Move On" must abort whatever the current stage was
  // still running FIRST — before resolving configured review stages (which
  // can itself be slow), before the artifact-existence check below (which
  // can itself return early), before any transition work (including the
  // plan-promotion write), and before (when enabled) the next stage's own
  // automation kicks off. Otherwise a still-running process for the
  // outgoing stage either keeps running after this click returns early, or
  // races the plan-promotion write / the incoming stage's own automation,
  // instead of being handed off cleanly.
  const cancelResult = await cancelRunningOperationsForTask(resolved.folderUri.fsPath);
  if (!cancelResult.ok) {
    NotificationRouter.showError(
      `Could not advance ${resolved.progress.taskFolder}: ${cancelResult.reason}`
    );
    return;
  }

  const configuredStages = await resolveConfiguredReviewStages(resolved.folderUri);
  const next = computeNextStage(resolved.progress.currentStage, configuredStages);
  if (!next) {
    NotificationRouter.showInformation(
      resolved.progress.currentStage === "publish"
        ? `${resolved.progress.taskFolder} is already at the last stage (Publish). Use "Mark Task Done" to finish it.`
        : `${resolved.progress.taskFolder} has no next stage to advance to — only unconfigured review stages remain.`
    );
    return;
  }

  // Check artifact existence for non-review stages
  const missingCompletionArtifacts = await missingCompletionArtifactsV1(
    resolved.folderUri,
    resolved.progress.currentStage
  );
  if (missingCompletionArtifacts.length > 0 && !artifactOverride) {
    const artifactName = missingCompletionArtifacts.join(", ");
    NotificationRouter.showWarning(
      `${artifactName} hasn't been created yet. Write or generate it before advancing, ` +
        "or explicitly complete this stage anyway.",
      undefined,
      undefined,
      undefined,
      {
        command: "vs-code-ai-helper.completeStageAnywayV1",
        title: "Complete Anyway",
        args: [{ taskFolderPath: resolved.folderUri.fsPath, artifactOverride: "user" }],
      }
    );
    return;
  }

  // wf10 item 19 / Step 28: a plan-review stage whose latest review still
  // lists a blocker no confirmed plan.md edit has superseded gets a warning
  // rather than a silent advance — the whole point of a recorded
  // supersession is that the artifacts agree before advice to advance is
  // acted on (see readStageArtifactsForChat's and
  // buildSoleBlockerReconcileGuidanceV1's doc comments, and this file's own
  // `getOutstandingPlanReviewBlockersForAdvanceV1`). This is a warn-and-
  // confirm, not a hard refusal: "Complete Anyway" is one click away, so a
  // human who verified the blocker some other way (or disagrees with it) is
  // never stranded — matching the "Publish Anyway" affordance already used
  // for every sibling skip path in this same command.
  if (!bypassBlockerGate) {
    const outstandingBlockers = await getOutstandingPlanReviewBlockersForAdvanceV1(
      resolved.folderUri,
      resolved.progress.currentStage,
      resolved.progress.blockerSupersessions
    );
    if (outstandingBlockers.length > 0) {
      const blockerList = outstandingBlockers.map((b) => `- ${b.description}`).join("\n");
      NotificationRouter.showWarning(
        `${resolved.progress.taskFolder}: ${STAGE_DISPLAY_NAMES[resolved.progress.currentStage]}'s review still ` +
          `lists ${outstandingBlockers.length} blocker(s) not recorded as resolved:\n${blockerList}\n\n` +
          "If you resolved this in stage chat, confirm the plan.md edit there so it's recorded. Otherwise, " +
          "advance anyway if you've verified it some other way — a full re-review is a stronger option but not required.",
        undefined,
        undefined,
        undefined,
        {
          command: "vs-code-ai-helper.completeStageAnywayV1",
          title: "Complete Anyway",
          args: [{ taskFolderPath: resolved.folderUri.fsPath }],
        }
      );
      return;
    }
  }

  // Special handling for advancing into "implementation" stage:
  // copy the current plan to plan-final.md if not already there. Shared with
  // the score-based auto-advance path above so neither entry point into
  // "impl" can skip the promotion (see preparePlanPromotion). This manual
  // transition isn't racing another review attempt's CAS, so the write can
  // run immediately rather than being deferred into advanceStage.
  if (next === "impl") {
    const promotion = await preparePlanPromotion(resolved.folderUri);
    if (!promotion.ready) {
      NotificationRouter.showWarning(
        "No plan to promote. Write or generate a plan first."
      );
      return;
    }
    if (promotion.publish) {
      await promotion.publish();
    }
  }

  // ── Step 1: Persist stage transition ───────────────────────────────────
  // "Complete Stage & Move On" always delegates to the nextStage.v1
  // registry row (plan §6.6's typed coordinator delegation), including a
  // configured-review-stage skip — see advanceStageViaNextStageRowV1's
  // header. The legacy advanceStage helper remains in use for other
  // transition kinds (manual "Set Task Stage" jumps, resets, reopen,
  // recovery).
  let transitionResult: StageTransitionResult | undefined;
  try {
    transitionResult = await advanceStageViaNextStageRowV1(
      resolved.folderUri,
      resolved.progress,
      resolved.progress.status,
      resolved.progress.currentStage,
      next,
      resolved.progress.status === "paused",
      // Completing a stage may start work in its destination only when
      // the workspace explicitly enables that behavior. Manual stage
      // selection deliberately does not use this path.
      completeAndMoveOnTriggersAI()
      ,
      undefined,
      undefined,
      artifactOverride ? "user" : undefined
    );
  } catch (error) {
    // Both paths throw (rather than resolving falsy) on a rejected
    // transition — e.g. an auto-advance already moved this task off the
    // expected source stage while this manual "Complete Stage & Move On"
    // was in flight. Report it like any other failed transition instead of
    // an unhandled rejection.
    const message = error instanceof Error ? error.message : String(error);
    NotificationRouter.showWarning(
      `Could not advance ${resolved.progress.taskFolder}: ${message}`
    );
    return;
  }

  if (!transitionResult?.persisted) {
    NotificationRouter.showError(
      `Could not persist stage advance for ${resolved.progress.taskFolder}. Please try again.`
    );
    return;
  }

  // ── Step 2: Show stage-advance message ───────────────────────────────
  NotificationRouter.showInformation(
    `${resolved.progress.taskFolder} advanced to: ${STAGE_DISPLAY_NAMES[next]}`
  );

  // ── Step 3: Post-completion lifecycle (when advancing to "completed") ──────
  // Strict ordering:
  //   persistence already done (Step 1)
  //   refresh inventory — triggered automatically by the progress-file watcher
  //     in extension.ts; we do not need to call inventory.refresh() here since
  //     patchTaskProgress writes task-progress.json, which the watcher picks up.
  //   post-completion helper actions — (no-op in this stage; future: open PR draft)
  //   compute lint result — checkPublishPreflight below runs immediately on
  //     the transition to Publish, in its default side-effect-free mode (it
  //     does not persist anything; this is a scheduling decision, not a
  //     publish attempt), and its result feeds the entry-owned publish nudge
  //     in Step 3b below. It is deliberately NOT computed (or consulted) for
  //     the review-owned path: when a Publish review is about to be
  //     dispatched, that review's own outcome (score + the recheck
  //     commitAndPushTask does when the user actually clicks Publish) is
  //     what matters, not a snapshot taken before the review — and possibly
  //     before a Fast Forward repair loop — has run.
  //   refresh final rendered state — inventory watcher handles this
  let publishPreflight: Awaited<ReturnType<typeof checkPublishPreflight>> | undefined;
  if (next === "publish" && !completeAndMoveOnTriggersAI()) {
    publishPreflight = await checkPublishPreflight(resolved.folderUri, resolved.progress.implReviewFiles);
  }

  // A completion-driven transition is intentionally different from manually
  // selecting a stage: persist the destination first, then start its primary
  // AI action when the workspace setting allows it.
  // All trigger-AI follow-ups route through the shared automation dispatcher
  // (scheduleAutomationChain) so they pass the per-task duplicate-chain
  // guard; nextStage holds no operation lock here, so dispatch is immediate.
  if (completeAndMoveOnTriggersAI()) {
    const taskKey = resolved.folderUri.fsPath;
    // "auto-fast-forward" must follow the triggered action all the way to its
    // review: Plan and Implementation are not themselves reviews, so the
    // fast-forward request rides along on the dispatched command's arg and is
    // honored when that command's successful run schedules its follow-up
    // review — independent of the stage's own auto-review setting.
    const followUpReviewMode =
      getCompleteAndMoveOnTriggersAIMode() === "auto-fast-forward"
        ? ("auto-fast-forward" as const)
        : undefined;
    const target = {
      taskFolderPath: resolved.folderUri.fsPath,
      followUpReviewMode,
    };
    if (next === "plan") {
      await scheduleAutomationChain({
        command: "vs-code-ai-helper.generatePlanWithAI",
        arg: target,
        taskKey,
        stillEnabled: () => completeAndMoveOnTriggersAI(),
        intent: {
          trigger: "Complete & Move On triggers AI: generate the plan for the next stage",
          settingKey: "ensemble.completeAndMoveOnTriggersAI",
          expectedTiming: "immediately — this stage transition dispatches it now",
          willRetry: false,
          retryNote: "Not retried automatically if dropped — generate the plan manually.",
        },
      });
      return;
    }
    if (next === "impl") {
      // Merged action: "Implement Actual Work" generates the implementation
      // checklist first when it is absent, then implements — there is no
      // separate checklist command anymore.
      await scheduleAutomationChain({
        command: "vs-code-ai-helper.runImplementationWithAI",
        // No human on this path — see ReviewCommandArg.automationDispatch.
        arg: { ...target, automationDispatch: true },
        taskKey,
        stillEnabled: () => completeAndMoveOnTriggersAI(),
        intent: {
          trigger: "Complete & Move On triggers AI: run implementation for the next stage",
          settingKey: "ensemble.completeAndMoveOnTriggersAI",
          expectedTiming: "immediately — this stage transition dispatches it now",
          willRetry: false,
          retryNote: "Not retried automatically if dropped — run Implementation manually.",
        },
      });
      return;
    }
    if (next === "publish") {
      // Publish is also a destination-stage action. No preflight is computed
      // here — the dispatched Publish review (and, for "auto-fast-forward",
      // its repair loop) surfaces its own "Publish manually" nudge once it
      // completes; commitAndPushTask rechecks preflight itself when the user
      // actually clicks Publish. "auto-fast-forward" runs the review + fixes
      // loop where applicable — Publish lands on a review, so it applies here.
      const publishCommand = getCompleteAndMoveOnTriggersAIMode() === "auto-fast-forward"
        ? "vs-code-ai-helper.fastForwardReviewWithAI"
        : "vs-code-ai-helper.runReviewWithAI";
      const reviewScheduled = await scheduleAutomationChain({
        command: publishCommand,
        arg: target,
        intent: {
          trigger: "Complete & Move On triggers AI: run the Publish review",
          settingKey: "ensemble.completeAndMoveOnTriggersAI",
          expectedTiming: "immediately — this stage transition dispatches it now",
          willRetry: false,
          retryNote: "Not retried automatically if dropped — run the review manually.",
        },
        taskKey,
        chainId: "auto-review",
        stillEnabled: () => completeAndMoveOnTriggersAI(),
      });
      if (!reviewScheduled) {
        // Dropped by the shared "auto-review" duplicate-chain guard — some
        // other review chain for this task is already pending or running.
        // Do NOT fall through to Step 3b: no review or check actually ran
        // for this landing, so nudging to publish here would be the same
        // false promise the preflight gate exists to prevent. Warn like
        // every sibling skip path instead of leaving the task silently
        // stuck on Publish with nothing running.
        NotificationRouter.showWarning(
          `${resolved.progress.taskFolder}: a Publish review could not be started automatically because another review is already in progress for this task. ` +
            "Run the review manually once it finishes, or use Publish Anyway from Commit and Push.",
          undefined,
          undefined,
          undefined,
          {
            command: "vs-code-ai-helper.commitAndPushTask",
            title: "Publish Anyway",
            args: [{ taskFolderPath: resolved.folderUri.fsPath }],
          }
        );
      }
      return;
    }
  }

  // ── Step 3b: Entry-owned publish nudge ────────────────────────────────
  // Reached here only when "Complete & Move On triggers AI" is off — no
  // Publish review will be dispatched (the triggersAI block above always
  // returns before this point), so nothing else will tell the user their
  // task is ready to publish. Commit and Push must only ever run from the
  // user's own button click, so this only nudges — never schedules it.
  // Gated on the checkPublishPreflight result captured in Step 3 above.
  if (next === "publish") {
    if (publishPreflight?.ok === false) {
      NotificationRouter.showWarning(
        `${resolved.progress.taskFolder} checks failed: ${publishPreflight.reason}. Publish manually once checks pass, or use Publish Anyway from Commit and Push.`,
        undefined,
        undefined,
        undefined,
        {
          command: "vs-code-ai-helper.commitAndPushTask",
          title: "Publish Anyway",
          args: [{ taskFolderPath: resolved.folderUri.fsPath }],
        }
      );
    } else {
      // Commit and Push must only ever run from the user's own button
      // click — never scheduled here, even once checks pass. Nudge toward
      // the manual action instead.
      NotificationRouter.showWarning(
        `${resolved.progress.taskFolder} passed its Publish checks. Publish manually when you're ready.`,
        undefined,
        undefined,
        undefined,
        {
          command: "vs-code-ai-helper.commitAndPushTask",
          title: "Publish",
          args: [{ taskFolderPath: resolved.folderUri.fsPath }],
        }
      );
    }
    return;
  }

  // ── Step 4: Auto-trigger review when eligible ────────────────────────
  // transitionResult.shouldAutoReview is already computed by advanceStage
  // using exactly-once semantics tied to the persistence result.
  if (transitionResult.shouldAutoReview) {
    // Deferred, never inline: nextStage holds no operation lock here, so the
    // dispatcher runs the review command immediately — but the chain still
    // flows through the single guarded dispatch point, so a review chain
    // already pending or running for this task drops this one. The command
    // resolves the freshly persisted stage, claims the exclusive lock, and
    // applies the same eligibility guards as the UI button.
    const reviewCommand = getCompleteAndMoveOnTriggersAIMode() === "auto-fast-forward"
      ? "vs-code-ai-helper.fastForwardReviewWithAI"
      : "vs-code-ai-helper.runReviewWithAI";
    // §7.5 (AC-HOST-03): this dispatch already knows the freshly persisted
    // destination stage (`next`, === `transitionResult.newStage`) — it was
    // JUST written by advanceStageViaNextStageRowV1 above, in this same
    // call. Passing it through as `task.progress.currentStage` (instead of
    // a bare `taskFolderPath`) lets fastForwardReviewWithAI's zero-I/O
    // routing pre-check (fastForwardTargetsImplReviewV1) decide — and, when
    // the target is an implementation review, enforce the host/provider
    // edit-availability gate — BEFORE its own resolveTask call re-reads
    // task-progress.json, instead of only after. `next` can genuinely be an
    // implementation-review stage here (AUTO_REVIEW_TRANSITIONS maps
    // "impl" -> "impl-high-review" and "impl-high-review" ->
    // "impl-low-review"), unlike the trigger-AI "publish" dispatch above
    // (REVIEW_TARGETS["publish"] is never in IMPL_REVIEW_STAGES, so that one
    // never needs the gate at all). The rest of `resolved.progress` is
    // stale-but-unused: resolveTask never trusts a caller-supplied
    // `task.progress` for anything but this routing hint — it always
    // re-reads the authoritative document itself.
    await scheduleAutomationChain({
      command: reviewCommand,
      arg: {
        task: {
          folderUri: resolved.folderUri,
          folderName: resolved.progress.taskFolder,
          progress: { ...resolved.progress, currentStage: next },
        },
      },
      taskKey: resolved.folderUri.fsPath,
      chainId: "auto-review",
      stillEnabled: () => completeAndMoveOnTriggersAI(),
      intent: {
        trigger: "Complete & Move On triggers AI: review after advancing to the next stage",
        settingKey: "ensemble.completeAndMoveOnTriggersAI",
        expectedTiming: "immediately — this stage transition dispatches it now",
        willRetry: false,
        retryNote: "Not retried automatically if dropped — run the review manually.",
      },
    });
  }
}

interface GenerateImplementationOutcomeContextV1 {
  readonly folderUri: vscode.Uri;
  readonly implementationUri: vscode.Uri;
  readonly chatViewProvider?: ChatViewProvider;
  readonly orchestrator: ActionConversationOrchestratorV1;
  readonly prompt: string;
  readonly canonicalId: string;
  readonly taskName?: string;
  /**
   * Skip the standalone-command completion UI (stage set/editor open/"plan-final.md
   * generated." toast) for embedded invocations — Run Implementation's own
   * first-run checklist sub-step re-reads the promoted content itself and
   * continues straight into its own run, so the standalone command's UI
   * would be a confusing extra document-open/toast in the middle of that.
   */
  readonly suppressCompletionUiV1?: boolean;
}

async function handleGenerateImplementationOutcomeV1(
  outcome: TaskActionOutcomeV1,
  ctx: GenerateImplementationOutcomeContextV1
): Promise<{ succeeded: boolean }> {
  let succeeded = false;

  if (outcome.kind === "completed") {
    if (!ctx.suppressCompletionUiV1) {
      await setStage(ctx.folderUri, "impl");
      await safeOpenTextDocument(ctx.implementationUri, "plan-final.md");
      NotificationRouter.showInformation("plan-final.md generated.");
    }
    succeeded = true;
  } else if (outcome.kind === "questions") {
    if (ctx.chatViewProvider) {
      const record = await ctx.orchestrator.getRecord({
        operationId: outcome.correlation.operationId,
        interactionId: outcome.interactionId,
        taskBindingId: outcome.correlation.taskBindingId,
        chatDocumentId: outcome.correlation.chatDocumentId,
        sourceAttemptId: outcome.correlation.attemptId,
      });
      if (record) {
        await ctx.chatViewProvider.askInteraction({
          canonicalId: ctx.canonicalId,
          taskFolderPath: ctx.folderUri.fsPath,
          stage: record.stage,
          taskName: ctx.taskName,
          interactionId: record.interactionId,
          operationId: record.correlation.operationId,
          actionKey: record.correlation.actionKey,
          sourceAttemptId: record.correlation.attemptId,
          // safe: see the other askInteraction call sites' comment.
          questions: record.questions!,
          binding: {
            taskBindingId: record.correlation.taskBindingId,
            chatDocumentId: record.correlation.chatDocumentId,
          },
        });
      }
    }
  } else if (outcome.kind === "cancelled") {
    NotificationRouter.showInformation(
      ctx.suppressCompletionUiV1
        ? "Generating implementation checklist cancelled."
        : "Generate Implementation cancelled."
    );
  } else {
    NotificationRouter.showError(
      ctx.suppressCompletionUiV1
        ? `Generating implementation checklist failed: ${describeTaskActionFailureV1(outcome)}. Implement the plan manually instead.`
        : `Generate Implementation failed: ${describeTaskActionFailureV1(outcome)}. Use the manual workflow instead.`
    );
  }

  return { succeeded };
}

interface GenerateImplementationInvocationParamsV1 {
  readonly folderUri: vscode.Uri;
  readonly workspaceUri: vscode.Uri;
  readonly progress: TaskProgress;
  readonly prompt: string;
  readonly targetUri: vscode.Uri;
  readonly modelId: string;
  readonly cancellationToken: vscode.CancellationToken;
}

/**
 * Coordinator invocation shared by every `generateImplementation.v1` call
 * site — the standalone "Generate Implementation" command and Run
 * Implementation's own first-run checklist sub-step. The latter used to call
 * the legacy uncorrelated `runAiToFile` helper directly, which the shared
 * runner/provider boundary (`assertNoUnauthorizedV1CorrelationV0` in
 * `legacyAiActionSafetyGateV0.ts`) now unconditionally rejects; routing both
 * call sites through the same coordinator invocation is what keeps the
 * checklist step inside `MIGRATED_ACTION_KEYS_V0`'s protection instead of
 * reaching for a legacy `outputFile` write.
 */
async function invokeGenerateImplementationActionV1(
  params: GenerateImplementationInvocationParamsV1
): Promise<{ outcome: TaskActionOutcomeV1; orchestrator: ActionConversationOrchestratorV1 }> {
  const orchestrator = getProductionActionConversationOrchestratorV1();
  const rootId = ensureWorkflowTaskFolderRootV1(params.folderUri.fsPath);
  const verifiedBindingId = getVerifiedTaskBindingIdV1(rootId);
  if (!verifiedBindingId) {
    return {
      outcome: { kind: "failed", code: "taskBindingUnverified", retryable: false },
      orchestrator,
    };
  }

  const chatIdentity = await readChatDocumentIdentityV1(
    params.folderUri.fsPath,
    params.folderUri.fsPath
  );
  const chatDocumentId = chatIdentity?.documentId ?? allocateHex128IdV1();

  const relativePath = path.relative(params.folderUri.fsPath, params.targetUri.fsPath) || "plan-final.md";
  const targetLocator = { rootId, relativePath };
  const fileStore = getWorkflowFileStoreV1();
  const statResult = await fileStore.stat(targetLocator);
  const baselineRevision =
    statResult.kind === "ok" && statResult.value.kind === "file" ? statResult.value.revision : undefined;

  const coordinator = createProductionTaskActionCoordinatorV1({
    workspaceCwd: params.workspaceUri.fsPath,
    resolveStagePrimaryModel: () => ({ modelId: params.modelId, stage: "impl" as TaskStage }),
  });

  const outcome = await coordinator.executeAction({
    actionKey: GENERATE_IMPLEMENTATION_ACTION_KEY_V1,
    taskBinding: { taskBindingId: verifiedBindingId, chatDocumentId },
    taskStatus: params.progress.status ?? "active",
    taskStage: params.progress.currentStage,
    rawInput: {
      prompt: params.prompt,
      targetLocator,
      ...(baselineRevision !== undefined ? { baselineRevision } : {}),
    },
    cancellationToken: params.cancellationToken,
  });

  return { outcome, orchestrator };
}

/**
 * Generate the implementation notes in `plan-final.md` (the canonical
 * implementation-stage artifact) using AI.
 *
 * This is the "Generate Implementation" action for the merged Implementation
 * stage. It reads the current contents of `plan-final.md` as context (the
 * promoted plan snapshot written when advancing to the implementation stage,
 * or materialized from legacy `implementation.md` when upgrading an older
 * task folder) and overwrites `plan-final.md` with the AI-generated
 * implementation notes, which are then used as the prompt for the AI
 * implementation run.
 *
 * Eligible stages: only `"implementation"` (see `GENERATE_IMPL_ELIGIBLE_STAGES`).
 * Tasks at `"plan-low-review"` are NOT eligible — the user must first advance
 * to the implementation stage (which promotes plan.md → plan-final.md) before
 * generating implementation notes. Allowing plan-low-review here would let the
 * command advertise the task as eligible in the QuickPick but then hard-fail
 * immediately because plan-final.md doesn't exist yet.
 *
 * Legacy task folders that still have only `implementation.md` are handled
 * transparently: `materializeCanonicalIfNeeded` copies `implementation.md`
 * to `plan-final.md` before the generation starts, matching the same
 * migration path used by `runImplementationWithAI`.
 *
 * Requires first-use consent before any AI action runs.
 */
export async function generateImplementationWithAI(
  extensionUri: vscode.Uri,
  context: vscode.ExtensionContext,
  chatViewProviderOrArg?: ChatViewProvider | ReviewCommandArg,
  explicitArg?: ReviewCommandArg
): Promise<boolean | undefined> {
  assertLegacyAiRouteAllowedV0("generateImplementation.v1");

  let chatViewProvider: ChatViewProvider | undefined;
  let arg: ReviewCommandArg | undefined;

  if (
    chatViewProviderOrArg &&
    typeof chatViewProviderOrArg === "object" &&
    ("askInteraction" in chatViewProviderOrArg || "viewType" in chatViewProviderOrArg)
  ) {
    chatViewProvider = chatViewProviderOrArg as ChatViewProvider;
    arg = explicitArg;
  } else {
    arg = chatViewProviderOrArg as ReviewCommandArg;
  }

  // ── Workspace guard ───────────────────────────────────────────────────────
  if ((vscode.workspace.workspaceFolders ?? []).length === 0) {
    NotificationRouter.showError(
      "No workspace folder open. Please open a folder first."
    );
    return;
  }

  // ── Consent gate ─────────────────────────────────────────────────────────
  const consented = await ensureAiConsent(context);
  if (!consented) {
    return;
  }

  if (isMalformedReviewArg(arg as ReviewCommandArg | Record<string, unknown>)) {
    NotificationRouter.showError(
      "Generate Implementation: unsupported argument shape. " +
        "Use { taskFolderPath } to target a specific task, or invoke without an argument to pick from a list."
    );
    return;
  }

  const resolved = await resolveTask(
    normalizeReviewArg(arg),
    GENERATE_IMPL_ELIGIBLE_STAGES,
    "Generate Implementation with AI",
    context
  );
  if (!resolved) {
    return;
  }
  if (resolved.progress.status === "paused") {
    NotificationRouter.showInformation("This task is paused. Resume it before generating implementation notes.");
    return;
  }

  const lockKey = resolved.folderUri.fsPath;
  const opResult = await runTrackedOperation(
    lockKey,
    { label: "Generate Implementation", stage: "impl", taskName: resolved.progress.displayName, kind: "generate-implementation", cancellable: true },
    async (op) => {
      const implementationUri = getCanonicalImplementationUri(resolved.folderUri);
      let planFinalContent = await readNonEmptyText(implementationUri);
      if (!planFinalContent) {
        const legacyUri = getLegacyImplementationUri(resolved.folderUri);
        planFinalContent = await readNonEmptyText(legacyUri);
      }
      if (!planFinalContent) {
        const planUri = await resolveCurrentPlanUri(resolved.folderUri);
        planFinalContent = await readNonEmptyText(planUri);
      }
      if (!planFinalContent) {
        NotificationRouter.showWarning(
          stageActionRequirementMessageV1("generateImplementationChecklist", 0)
        );
        return;
      }

      const workspaceRoot = resolveOwnerWorkspace(resolved.progress);
      if (!workspaceRoot) {
        NotificationRouter.showError(
          "Could not determine the owning workspace for this task. Please open the workspace that created it."
        );
        return;
      }

      const contextPackContent = await generateContextPack(
        resolved.folderUri,
        workspaceRoot.uri
      );

      const prompt = await renderPromptTemplate(
        extensionUri,
        "create-implementation.md",
        { contextPack: contextPackContent, plan: planFinalContent }
      );

      const model = await resolveFreshModelForStage(resolved.folderUri, "impl");
      if (!model.modelId) {
        NotificationRouter.showError("No model configured for Implementation stage.");
        return;
      }
      const { availability, providerLabel } = await checkImplementationAvailabilityForModel(
        model.modelId,
        "impl"
      );
      if (!availability.available) {
        NotificationRouter.showError(
          `${providerLabel} is unavailable: ${availability.reason ?? "unknown reason"}`
        );
        return;
      }

      const sizeCheck = await checkAndConfirmPromptSize(prompt, providerLabel);
      if (sizeCheck === "abort" || sizeCheck === "declined") {
        return;
      }

      const cancellationToken = op?.token ?? new vscode.CancellationTokenSource().token;
      const { outcome, orchestrator } = await invokeGenerateImplementationActionV1({
        folderUri: resolved.folderUri,
        workspaceUri: workspaceRoot.uri,
        progress: resolved.progress,
        prompt,
        targetUri: implementationUri,
        modelId: model.modelId,
        cancellationToken,
      });

      const handleRes = await handleGenerateImplementationOutcomeV1(outcome, {
        folderUri: resolved.folderUri,
        implementationUri,
        chatViewProvider,
        orchestrator,
        prompt,
        canonicalId: resolved.folderUri.fsPath,
        taskName: resolved.progress.displayName,
      });
      return handleRes.succeeded;
    }
  );

  return opResult || undefined;
}

/**
 * Drive an explicit Chat Resume of a `generateImplementation.v1` structured-question
 * interaction (plan §5.5 / §6.1 / §6.4).
 */
export async function resumeGenerateImplementationInteractionV1(
  inventory: TaskInventory,
  chatViewProvider: ChatViewProvider,
  ref: ChatInteractionRefV1,
  resumeIdempotencyId: string,
  cancellationToken: vscode.CancellationToken
): Promise<ChatInteractionResumeResultV1> {
  const ownedTask = inventory.getTaskByBindingId(ref.taskBindingId);
  if (!ownedTask) {
    return { ok: false, reason: "the task that asked this question could not be found" };
  }
  const taskFolderUri = vscode.Uri.file(ownedTask.taskFolderPath);
  const workspaceFolderUri = ownedTask.workspaceFolder;
  if (!workspaceFolderUri) {
    return { ok: false, reason: "the task has no owning workspace" };
  }

  const model = await resolveFreshModelForStage(taskFolderUri, "impl");
  if (!model.modelId) {
    return { ok: false, reason: "no model is configured for the Implementation stage" };
  }
  const { availability, providerLabel } = await checkImplementationAvailabilityForModel(
    model.modelId,
    "impl"
  );
  if (!availability.available) {
    return {
      ok: false,
      reason: `${providerLabel} is unavailable: ${availability.reason ?? "unknown reason"}`,
    };
  }

  const modelId = model.modelId;
  const coordinator = createProductionTaskActionCoordinatorV1({
    workspaceCwd: workspaceFolderUri.fsPath,
    resolveStagePrimaryModel: () => ({ modelId, stage: "impl" as TaskStage }),
  });
  const orchestrator = getProductionActionConversationOrchestratorV1();

  const interactionRef: InteractionRefV1 = {
    operationId: ref.operationId,
    interactionId: ref.interactionId,
    taskBindingId: ref.taskBindingId,
    chatDocumentId: ref.chatDocumentId,
    sourceAttemptId: ref.sourceAttemptId,
  };

  const before = await orchestrator.loadInteraction(interactionRef);
  let prompt = "(prompt unavailable)";
  if (before.kind === "ok") {
    try {
      const snapshot = JSON.parse(before.record.inputSnapshot.canonicalJson) as { prompt?: unknown };
      if (typeof snapshot.prompt === "string") {
        prompt = snapshot.prompt;
      }
    } catch {
      // Best-effort for the run log only.
    }
  }

  const outcome = await coordinator.resumeAction({
    interaction: interactionRef,
    taskBinding: { taskBindingId: ref.taskBindingId, chatDocumentId: ref.chatDocumentId },
    taskStatus: ownedTask.progress.status ?? "active",
    taskStage: ownedTask.progress.currentStage,
    resumeIdempotencyId,
    cancellationToken,
  });

  const implementationUri = getCanonicalImplementationUri(taskFolderUri);
  await handleGenerateImplementationOutcomeV1(outcome, {
    folderUri: taskFolderUri,
    implementationUri,
    chatViewProvider,
    orchestrator,
    prompt,
    canonicalId: ownedTask.canonicalId ?? ownedTask.taskFolderPath,
    taskName: ownedTask.progress.displayName,
  });

  const after = await orchestrator.loadInteraction(interactionRef);
  const settlement =
    after.kind === "ok" &&
    after.record.state === "settled" &&
    (after.record.settlement === "resumed" || after.record.settlement === "supersededByReplacementOperation")
      ? after.record.settlement
      : undefined;

  if (settlement === undefined) {
    return { ok: false, reason: describeTaskActionFailureV1(outcome) };
  }
  return { ok: true, settlement };
}

/**
 * Stages from which the AI implementation runner can be invoked.
 */
const IMPLEMENTATION_ELIGIBLE_STAGES: readonly TaskStage[] = [
  "impl",
  "impl-high-review",
  "impl-low-review",
];

/**
 * Marker stamped at the top of plan-final.md once the implementation
 * checklist has been generated for a task. "Implement Actual Work" checks
 * for it and generates the checklist first when it is absent (the merged
 * generate-then-implement behavior); post-run summaries overwrite the file,
 * so the marker check is additionally limited to first runs (no
 * implReviewFiles yet) to avoid regenerating over an existing run's output.
 */
export { IMPLEMENTATION_CHECKLIST_MARKER };

/**
 * The plan of record's checklist state, for reconciling against a review's
 * self-reported progress marker (see reconcileProgressWithChecklistV1).
 * `undefined` whenever there is nothing authoritative to reconcile against:
 * no plan-final.md, or one that never had a checklist generated.
 *
 * @internal exported for testing (the checklistProgressUnreliable stand-down)
 */
export async function readPlanChecklistProgressV1(
  folderUri: vscode.Uri
): Promise<ChecklistProgressV1 | undefined> {
  // The read itself now lives in effectiveReviewProgress.ts, shared with the
  // Tasks tree's stage rows; the strict policy preserves this gate's
  // throw-and-notify behavior on a corrupt progress file.
  return readEffectivePlanChecklistProgressV1(folderUri, "strict");
}

/**
 * Shared core of an implementation run.
 *
 * ⚠ SAFETY: Before launching, warns the user if:
 *   - the workspace is not a git repo (changes cannot be tracked/reverted)
 *   - the workspace has uncommitted changes (recommend committing first)
 *
 * The prompt-size gate (high-context confirm + hard ceiling) is applied
 * before the pre-run safety checks, so the user sees the size warning
 * before the git-state warnings.
 *
 * NOTE: When called from applyImplementationReviewWithAI, the size gate
 * has already been applied on the assembled prompt before this function
 * is reached, so it is not double-applied. This function does NOT apply
 * the size gate for the path coming from applyImplementationReviewWithAI;
 * it IS applied for paths coming directly from runImplementationWithAI
 * (where the prompt is assembled here).
 */
/**
 * Durable consecutive zero-file-change implementation-round counter, backed
 * by `TaskProgress.zeroChangeImplRounds` (2c,
 * ensemble.resilience.noProgressBreakerRounds). Previously an in-memory-only
 * `Map`, which reset on every window reload — the counter could accumulate
 * fresh zero-change rounds after a reload without ever tripping the breaker,
 * even past the configured threshold (report 11). Persisting it means the
 * count survives reloads and survives across rounds within a stage; it is
 * cleared on any file-changing round, on a stage transition (see
 * taskProgressFieldPolicyV1's `zeroChangeImplRounds` row), and on archive.
 */
export async function clearZeroChangeImplRoundCounter(taskFolderPath: string): Promise<void> {
  const folderUri = vscode.Uri.file(taskFolderPath);
  await patchTaskProgressStrictV1(folderUri, (current) =>
    setZeroChangeImplRounds(current, undefined)
  );
}

/**
 * wf10 item 4 / Part 4 completion-blocker fix: the implementation run log is
 * written (line ~6924, below) before this round's outcome classification is
 * even computed, so its `Status:` line can only ever say `completed` — never
 * the fixed-vocabulary token also persisted to `TaskProgress.roundOutcomes`.
 * Appends that token as a distinguishing note, using the same
 * read-then-append idiom this function already uses for every other
 * post-hoc log annotation (the reconcile/diagnostics/unattributed-files
 * notes further below) rather than restructuring the log write itself.
 */
async function appendRoundOutcomeLogNoteV1(
  logUri: vscode.Uri,
  classification: RoundOutcomeClassificationV1
): Promise<void> {
  const existingLog = await readTextIfExists(logUri);
  if (existingLog === undefined) {
    return;
  }
  await writeTextFile(
    logUri,
    `${existingLog}\n\n## Round Outcome\n\nClassification: \`${classification}\`\n`,
    { skipBackup: true }
  );
}

async function executeImplementationRun(
  _extensionUri: vscode.Uri,
  folderUri: vscode.Uri,
  workspaceRoot: vscode.WorkspaceFolder,
  prompt: string,
  modelId: string | undefined,
  progressTitle: string,
  postRunReviewStage: TaskStage = "impl",
  options: ExecuteImplementationRunOptions
): Promise<boolean> {
  const cwd = workspaceRoot.uri.fsPath;
  // Allocated once, before dispatch, so the run log and the prompt manifest
  // (Part 2 step 7) can be correlated by this id rather than by parsing the
  // run log's incrementing-counter filename. Not a coordinator
  // attemptId/operationId — this dispatch path never reaches the coordinator
  // — see promptManifestV1.ts's doc comment (review blocker, 2026-08-26).
  const promptRoundId = allocateHex128IdV1();

  // Snapshot HEAD as this task's implementation baseline, first round only
  // (workflow findings round 8, item 1: a task's first implementation review
  // has no `<!-- reviewed-commit -->` marker to anchor to — see
  // taskImplementationBaselineV1.ts). Must run before any edit below.
  await recordTaskImplementationBaselineShaIfAbsentV1(folderUri, cwd);

  // Pre-run safety checks for agentic file-editing runs
  if (!options.skipPreRunSafetyCheck) {
    const isGit = await isGitWorkspace(cwd);
    if (!isGit) {
      // Non-git workspace: changes cannot be tracked or reverted
      const proceed = await vscode.window.showWarningMessage(
        "⚠️ This workspace is not tracked by git.\n\n" +
          "The AI implementation run will edit files in your workspace, " +
          "but there is no git history to track or revert those changes. " +
          "You will not be able to see exactly what was changed or undo it via git.\n\n" +
          "Back up your workspace before proceeding.",
        { modal: true },
        "Proceed Anyway",
      );
      if (proceed !== "Proceed Anyway") {
        NotificationRouter.showInformation("Implementation run cancelled.");
        return false;
      }
    } else {
      // Git workspace: unrelated changes can be overwritten or mixed into an
      // implementation run. Changes already associated with this task are
      // expected, so do not make users repeatedly approve their own work.
      const unrelatedChanges = await getUnrelatedWorkspaceChanges(cwd, folderUri);
      if (unrelatedChanges.length > 0 && !allowsDirtyWorktreeChanges()) {
        const preview = unrelatedChanges.slice(0, 5).map((file) => `• ${file}`).join("\n");
        const more = unrelatedChanges.length > 5
          ? `\n• … and ${unrelatedChanges.length - 5} more`
          : "";
        const proceed = await vscode.window.showWarningMessage(
          "⚠️ Your workspace has unrelated uncommitted changes.\n\n" +
            "The AI implementation run may edit workspace files. Commit, stash, " +
            "or review these unrelated changes first:\n\n" + preview + more,
          { modal: false },
          "Proceed",
          "Cancel",
        );
        if (proceed !== "Proceed") {
          NotificationRouter.showInformation("Implementation run cancelled.");
          return false;
        }
      }
    }
  }

  // A pending recovery continuation (implRecovery, Part 1) is claimed by the
  // round that actually starts: `pending` → `dispatched` with a fresh
  // continuation attemptId, in one patch. After this point a lingering
  // `dispatched` record always means a round started and died — which the
  // scheduler surfaces but never re-fires — while a `pending` one means the
  // continuation never started and is safe to re-arm exactly once.
  //
  // The claim also captures WHAT this round is running as (the record's
  // persisted recovery mode) and the pre-round boundary — the inputs to the
  // post-run delta gate (Part 2): `summary-only` permits no edits at all,
  // `inspect-and-complete` bounds them to the quarantined plus
  // previously-reviewed scope.
  const claimedAtStart = await claimImplRecoveryDispatchV1(folderUri);
  // A claimed `summary-only` record's no-edit guarantee is enforceable only
  // when THIS round's actually-resolved model can dispatch in text mode with
  // edit permissions genuinely withheld. The transition-time probe
  // (`beginImplementationRecoveryV1`) checked the stage chain's PRIMARY; a
  // sticky fallback, or a live settings change between transition and claim,
  // can resolve this round against a different model that no longer
  // qualifies. Escalating HERE — before any dispatch decision — and
  // rebuilding the prompt to match closes the fallthrough where an
  // unenforceable `summary-only` claim would otherwise reach the ordinary
  // edit path still carrying its no-edits mandate (review blocker,
  // 2026-08-14).
  const escalatedRecord = await escalateClaimedSummaryOnlyIfUnavailableV1(
    folderUri,
    claimedAtStart.record,
    modelId
  );
  const claimedRecovery: ClaimedImplRecoveryV1 = { ...claimedAtStart, record: escalatedRecord };
  // What THIS round is running as (item 17a) — a checklist-driven
  // Implementation round, a review-driven Apply Review round, or a recovery
  // continuation of either. Recorded in the run log and on the round-outcome
  // entry so the automatic loop's dispatch choices become auditable after the
  // fact (previously indistinguishable: both wrote the same
  // `# Implementation Run` header).
  const currentDispatchMode: ImplementationDispatchModeV1 = deriveCurrentDispatchModeV1(
    claimedRecovery.record !== undefined,
    options.editActionKey
  );
  // Part 4 architectural fix (2026-08-27 review follow-up, blocker
  // "recovery linkage selects the first task-wide live row rather than
  // resolving the actual source identity"): claim THIS round's own
  // `roundLedger` row at start, mirroring `claimReviewAttempt`'s review-round
  // pattern, so every later consumer — a recovery transition this round may
  // trigger, and the completion-accounting terminalizers below — resolves
  // against this round's own identity rather than "whichever row is
  // currently live for this task". A continuation round already had its row
  // opened/linked by `claimImplRecoveryDispatchV1` under its own `attemptId`
  // moments earlier; reusing that id here is a no-op (see
  // `claimImplementationRoundLedgerV1`'s doc comment) rather than opening a
  // second row for the same round. A fresh (non-continuation) round claims
  // under its own `promptRoundId`.
  const implRoundId = (
    await claimImplementationRoundLedgerV1(
      folderUri,
      claimedRecovery.record?.attemptId ?? promptRoundId,
      postRunReviewStage,
      currentDispatchMode
    )
  ).roundId;
  // What a NEW recovery (if this round needs one) should record as ITS
  // source — propagated from a continuation's own source so a continuation
  // of a continuation of an apply-review round still resolves to
  // "apply-review", never collapsing to "continuation" (which describes only
  // the round that just ran, not what a further continuation should render
  // from). Keyed on `options.editActionKey` alone (see that function's doc
  // comment) rather than the claimed record's own `sourceDispatchMode`, so a
  // continuation whose apply-review re-render failed and fell through to
  // run-implementation.md is correctly recorded as checklist-driven, never
  // as apply-review ancestry it did not actually run under this round.
  const nextRecoverySource = deriveNextRecoverySourceV1(
    options.editActionKey,
    postRunReviewStage,
    claimedRecovery.record?.sourceReviewStage
  );
  const nextRecoverySourceDispatchMode = nextRecoverySource.sourceDispatchMode;
  const nextRecoverySourceReviewStage = nextRecoverySource.sourceReviewStage;
  // Checklist-mutation guard snapshot (wf "make the stage chat a record of
  // work" Part 6 / item 5: "a round never mutates the checklist"). Read
  // BEFORE dispatch, mirroring the baseline-SHA capture's own "must run
  // before any edit" placement, so a round that directly edits
  // plan-final.md's item list (an edit-mode round with file-write access)
  // can be detected against what the plan actually read at round start —
  // see detectChecklistItemSetMutationV1's doc comment.
  const preRoundPlan = await readPlanOfRecordV1(folderUri);
  const preRoundChecklistText = preRoundPlan.hasChecklist ? preRoundPlan.text : undefined;
  const wasEscalatedFromSummaryOnly =
    claimedAtStart.record?.mode === "summary-only" && escalatedRecord?.mode !== "summary-only";
  const dispatchPrompt = wasEscalatedFromSummaryOnly
    ? buildImplementationContinuationPromptV1(stripImplementationContinuationNoticeV1(prompt), {
        mode: escalatedRecord?.mode,
        pendingFiles: claimedRecovery.priorPendingFiles,
        reviewedFiles: claimedRecovery.priorImplReviewFiles,
      })
    : prompt;

  let result: Awaited<ReturnType<typeof runImplementationOrSealedV1>> | undefined;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: progressTitle,
      cancellable: true,
    },
    async (progress, token) => {
      NotificationRouter.emitProgressSummary(
        progressTitle,
        taskOperations.rootOperationIdFor(folderUri.fsPath)
      );
      // Honor the tracked operation's cancellation token (Notifications-
      // section cancel button) alongside the native progress token.
      const linked = linkCancellationTokens(
        token,
        taskOperations.tokenFor(folderUri.fsPath)
      );
      try {
      // A claimed summary-only continuation dispatches in TEXT mode — edit
      // permissions actually withheld (Part 2 item 4), never an edit run
      // carrying only a no-edits instruction. The re-probe against the model
      // THIS run resolved already happened above (escalateClaimedSummaryOnly-
      // IfUnavailableV1): by the time this branch runs, `claimedRecovery.record`
      // reads `summary-only` only when that probe passed, so this check is a
      // belt-and-braces re-assertion, not the escalation point itself. If the
      // record was escalated, this branch is skipped and the edit dispatch
      // below runs with `dispatchPrompt`'s rebuilt inspect-and-complete
      // mandate and the delta-boundary gate (Part 2 step 3) still armed.
      if (
        claimedRecovery.record?.mode === "summary-only" &&
        isSummaryOnlyDispatchAvailableV1(modelId)
      ) {
        result = await runSummaryOnlyContinuationV1({
          taskFolderUri: folderUri,
          workspaceUri: workspaceRoot.uri,
          prompt: dispatchPrompt,
          modelId,
          taskStage: postRunReviewStage,
          token: linked.token,
          onProgress: (message) => progress.report({ message }),
        });
        return;
      }
      // Copilot-resolved models run the sealed two-phase pipeline
      // (read-only preflight → sealed plan → receipted mutation session);
      // CLI-resolved models run their own direct edit-mode invocation
      // instead, since they cannot join that pipeline (see
      // runImplementationOrSealedV1's header). Provider/model fallback for
      // both paths lives in the coordinator's/runner's ranked selection.
      // `dispatchPrompt` carries the rebuilt inspect-and-complete mandate
      // when this round was escalated off an unenforceable summary-only
      // claim; otherwise it is `prompt` unchanged.
      result = await runImplementationOrSealedV1({
        editActionKey: options.editActionKey ?? "implementation.v1",
        prompt: dispatchPrompt,
        modelId,
        workspaceUri: workspaceRoot.uri,
        token: linked.token,
        onProgress: (message) => progress.report({ message }),
        // `modelId` is always resolved from the "impl" stage (see the two
        // callers of executeImplementationRun) — quota/fallback bookkeeping
        // must use that same stage, not postRunReviewStage (which may be a
        // review stage used only to pick which review to auto-run below).
        stage: "impl",
        // Registry-row stage eligibility checks against the task's ACTUAL
        // current stage: both callers pass postRunReviewStage = the current
        // review stage when at review, "impl" otherwise.
        taskStage: postRunReviewStage,
        taskFolderUri: folderUri,
        // Part 4 architectural fix (2026-08-27 review follow-up): give the
        // sealed Copilot pipeline this round's own round-ledger row identity
        // so its coordinator attempts attach to it at allocation time, the
        // same as a review round — see `RunSealedImplementationOptionsV1.roundId`.
        roundId: implRoundId,
        // Structured preflight questions get their full Chat lifecycle
        // (mirror → Answer → Resume via extension.ts's dispatcher).
        onQuestions: async (questionsOutcome) => {
          const provider = options.chatViewProvider;
          if (!provider) {
            return;
          }
          const orchestrator = getProductionActionConversationOrchestratorV1();
          const record = await orchestrator.getRecord({
            operationId: questionsOutcome.correlation.operationId,
            interactionId: questionsOutcome.interactionId,
            taskBindingId: questionsOutcome.correlation.taskBindingId,
            chatDocumentId: questionsOutcome.correlation.chatDocumentId,
            sourceAttemptId: questionsOutcome.correlation.attemptId,
          });
          if (record) {
            await provider.askInteraction({
              canonicalId: folderUri.fsPath,
              taskFolderPath: folderUri.fsPath,
              stage: record.stage,
              interactionId: record.interactionId,
              operationId: record.correlation.operationId,
              actionKey: record.correlation.actionKey,
              sourceAttemptId: record.correlation.attemptId,
              // safe: loaded via a "questions" outcome, so questions are
              // posted — never invocationPending.
              questions: record.questions!,
              binding: {
                taskBindingId: record.correlation.taskBindingId,
                chatDocumentId: record.correlation.chatDocumentId,
              },
            });
          }
        },
      });
      } finally {
        linked.dispose();
      }
    }
  );

  if (!result) {
    return false;
  }

  // 2026-08-28 review fix, blocker "coordinator allocation sites still do not
  // synchronously attach durable round identities before pre-prompt failures
  // can return": the sealed pipeline's `allocatedAttemptIds` (every
  // coordinator attempt allocated, assembly-eligible or not — see
  // `AllocatedAttemptIdsV1`) union `assembledPromptAttempts`'s ids, forwarded
  // to `terminalizeRoundV1` below exactly like the review-round path's
  // `observedCoordinatorAttemptIds`/`extraCoordinatorAttemptIds`, so a
  // pre-assembly-failed attempt is recorded on this round's ledger row at its
  // terminal write even though nothing attached it to disk while live. A
  // CLI-resolved dispatch never sets either field (no coordinator involved),
  // so this is empty there, matching prior behavior exactly.
  const implExtraAttemptIds = Array.from(
    new Set([...(result.assembledPromptAttempts?.map((a) => a.attemptId) ?? []), ...(result.allocatedAttemptIds ?? [])])
  );

  const implProviderLine = result.providerLabel
    ? `Provider: ${result.providerLabel}${
        result.storedModelId && attributionModelLabel(result.storedModelId)
          ? ` (${attributionModelLabel(result.storedModelId)})`
          : ""
      }\n\n`
    : "";

  // Deferred/cut-short detection AND summary-shape validation run BEFORE the
  // run log is written, so the durable record of a detected round says
  // `Status: incomplete (...)` — never `Status: completed` — and so BOTH
  // failure classes can persist their recovery transition ahead of every
  // other write. A round that ends its turn promising a follow-up the
  // workflow cannot deliver is not a completed round, and recording it as
  // one is what left a task sitting "active" for 3.5 hours with its previous
  // good summary destroyed (2026-08-13, round 014). The plan of record is
  // read once here and reused by the summary write/merge below, so the gate
  // and the merge can never disagree about which document they check against.
  const summary = result.summary?.trim() ?? "";
  // "May have changed": unknown counts, because the tree's real state is not
  // provably clean. "Known files" is the stricter form the shape gate's
  // empty-section rule keys on.
  const roundMayHaveChangedFiles =
    result.filesChangedUnknown === true || result.filesChanged.length > 0;
  const roundChangedKnownFiles =
    !result.filesChangedUnknown && result.filesChanged.length > 0;
  let plan: PlanOfRecordV1 | undefined;
  let planChecklist: string | undefined;
  // Tracks the checklist text actually on disk as the function proceeds —
  // starts equal to `planChecklist` (this round's pre-merge read) and is
  // updated to the merge's written content the moment a merge lands (below),
  // so any message built AFTER that point that enumerates outstanding items
  // (the reconciliation-needed note) names what is really still unticked
  // rather than a round-stale snapshot. Messages built BEFORE the merge-write
  // runs (the zero-file-change branch) can keep using `planChecklist`
  // directly — the two are still identical at that point in the function.
  let effectivePlanChecklist: string | undefined;
  let incompleteRound: IncompleteImplementationRoundV1 | undefined;
  let summaryIssue: string | undefined;
  // Post-run delta gate, first half (Part 2 step 3): a `summary-only`
  // continuation's premise is "no edits". Any delta — or an unenumerable one,
  // which cannot prove the tree clean — violates the mode: the round's report
  // is NOT accepted as a summary-only report regardless of its shape, its
  // delta is quarantined (never banked), and the recovery transition below
  // escalates the mode to `inspect-and-complete` under the same continuation
  // cap. Checked before the shape gates so a well-formed summary cannot
  // narrate over edits it was forbidden to make.
  const summaryOnlyViolation =
    result.status === "completed" &&
    claimedRecovery.record?.mode === "summary-only" &&
    roundMayHaveChangedFiles;
  // Checklist-mutation guard (Part 6 / item 5): set when this round's own
  // edit changed plan-final.md's item SET (not merely tick state) relative to
  // `preRoundChecklistText`. Consulted by the run-log write and the
  // decision-post below; `planChecklist` is reset to the pre-round text the
  // moment this is detected, so every downstream read (the ordinary
  // tick-merge included) operates on the reverted content — a round's
  // genuinely reported ticks still land, via that same merge, once the item
  // set itself is back to what it was at dispatch.
  let checklistMutation: ReturnType<typeof detectChecklistItemSetMutationV1> | undefined;
  if (result.status === "completed") {
    plan = await readPlanOfRecordV1(folderUri);
    planChecklist = plan.hasChecklist ? plan.text : undefined;
    if (
      preRoundChecklistText !== undefined &&
      planChecklist !== undefined &&
      planChecklist !== preRoundChecklistText
    ) {
      checklistMutation = detectChecklistItemSetMutationV1(preRoundChecklistText, planChecklist);
      if (checklistMutation !== undefined) {
        await writeTextFile(getCanonicalImplementationUri(folderUri), preRoundChecklistText);
        planChecklist = preRoundChecklistText;
      }
    }
    effectivePlanChecklist = planChecklist;
    if (summaryOnlyViolation) {
      summaryIssue =
        "this summary-only continuation was not permitted to edit files, but it " +
        (result.filesChangedUnknown
          ? "left the tree state unenumerable"
          : `changed ${result.filesChanged.length} file(s)`) +
        " — its report was rejected and the delta quarantined";
    } else if (!result.summaryIsSynthetic) {
      // The gate enforces the contract run-implementation.md imposes on a
      // model. A runner-synthesized summary never went through that prompt
      // (the sealed edit pipeline reports "Applied N sealed edit step(s)…"),
      // so holding it to that shape stamped every successful Copilot run
      // unusable and refused to advance — disabling that execution path
      // entirely, on success.
      const expectations = {
        planChecklist,
        roundChangedFiles: roundChangedKnownFiles,
      };
      incompleteRound = describeIncompleteImplementationRoundV1(summary, expectations);
      if (!incompleteRound) {
        summaryIssue = describeImplementationSummaryShapeIssue(summary, expectations);
      }
    }
  }

  // Checklist-merge outcome, computed ONCE here (pure/read-only — nothing is
  // written yet) so both the zero-change routing decision below and the
  // merge-write block further down read the identical result and can never
  // disagree about what this round actually reported. A round that changed
  // no files but DID land new ticks (`kind === "merged"`) made real progress
  // and must not count toward the no-progress streak; a round that changed
  // no files and reported checklist claims that never merged (`"no-match"`,
  // e.g. paraphrased retroactive-tick text — see
  // `hasContradictoryNoChecklistChangeClaimV1`) is exactly as sterile as one
  // that reported nothing at all, and must still count.
  const checklistMergeResult =
    planChecklist !== undefined && summaryIssue === undefined
      ? mergeChecklistProgressV1(planChecklist, summary)
      : undefined;
  const checklistAdvanced = checklistMergeResult?.kind === "merged";
  const checklistClaimedButUnmerged = checklistMergeResult?.kind === "no-match";

  // The ONE durable recovery transition (Part 1): a detected incomplete
  // round, and equally a completed round whose summary will be stamped
  // unusable, both persist — in a single strict patch, before the run log or
  // any other write — the quarantined delta, the bounded continuation
  // counter, the review-invalid marker, and the `implRecovery` dispatch
  // record. If the log were written first and the process died before the
  // patch landed, the durable state would say "handled" while the round's
  // edits sat in no set at all; persisting first means a crash at any later
  // point can only lose REPORTING, never the round's edits or the owed
  // continuation. A zero-change rejected summary lands the SAME transition:
  // it has no delta to quarantine, but the round still owes a usable report,
  // and exempting it left the task parked at "active" with an unusable stamp
  // and nothing scheduled — the exact stall the transition exists to end
  // (review blocker, 2026-08-14).
  // Part 7: a failed round whose process was externally killed (wall-clock
  // or inactivity watchdog — see CliExecResult.timeoutReason /
  // ImplementationRunResult.timedOut) is neither a completed round with an
  // unusable summary nor a plain provider error: the process may have been
  // killed mid-edit, so it owes the same recovery transition as a detected
  // incomplete round, routed with terminatedExternally: true and its own
  // `externallyTerminated` trigger so the mode selector (Part 2) never
  // picks summary-only for it, and the run log records the true cause
  // distinctly from a provider-reported deferred/cut-short round.
  const timedOutRound = result.status === "failed" && result.timedOut === true;
  let recovery: BegunImplementationRecoveryV1 | undefined;
  if (incompleteRound || summaryIssue !== undefined || timedOutRound) {
    recovery = await beginImplementationRecoveryV1(folderUri, {
      trigger: incompleteRound
        ? incompleteRound.kind
        : timedOutRound
          ? "externallyTerminated"
          : "summaryRejected",
      reason:
        incompleteRound?.reason ??
        summaryIssue ??
        result.errorMessage ??
        `${result.timeoutReason === "inactivity" ? "produced no output and was" : "timed out and was"} stopped before returning a final response`,
      // Every summary-gate path is a NORMAL termination — the provider
      // returned a final response, however unusable. Externally-killed
      // rounds (timeout, inactivity kill) enter the transition here with
      // this flag true; the mode itself is selected from evidence inside
      // the transition (Part 2) — known non-empty delta routes to
      // inspect-and-complete, filesChangedUnknown routes to unconstrained.
      terminatedExternally: timedOutRound,
      ...(summaryOnlyViolation ? { escalatedFromSummaryOnly: true } : {}),
      filesChanged: result.filesChanged,
      filesChangedUnknown: result.filesChangedUnknown === true,
      postRunReviewStage,
      parentOperation: options.parentOperation,
      ...(incompleteRound === undefined ? { offerRestoreOption: true } : {}),
      sourceDispatchMode: nextRecoverySourceDispatchMode,
      ...(nextRecoverySourceReviewStage ? { sourceReviewStage: nextRecoverySourceReviewStage } : {}),
      sourceRoundIdHint: implRoundId,
    });
  }
  const quarantinedPaths = recovery?.quarantinedPaths ?? [];

  // Prompt manifest (item 17a/18, Part 2 step 7) — written to `runs/` now,
  // as soon as this round's result (and any captured coordinator attempts)
  // is known, rather than after the run log is written (review blocker,
  // 2026-08-27, third pass: "Step 7... still waits until after the run log
  // is written to persist the captures"). `writePromptManifestV1` now names
  // files purely from `promptRoundId`/`attemptId` (see promptManifestV1.ts's
  // doc comment), so this needs nothing the run log produces and can run
  // this much earlier — still after the recovery transition above, which is
  // deliberately the first write of any kind after a round settles (see its
  // own comment), but well before the run log, the checklist merge, and
  // every banking/blocker step below. A write failure is recorded as a
  // durable note folded into the run log's OWN content further down
  // (`manifestFailureNote`) rather than a second write against an
  // already-written file, so a reader who finds the manifest missing can
  // tell "it was never attempted" apart from "it was attempted and failed".
  let manifestFailureNote: string | undefined;
  try {
    // See PromptManifestV1.promptCaptureComplete: a direct CLI dispatch
    // (runnerId !== "copilot-lm") sends dispatchPrompt verbatim, so capture
    // is complete. A Copilot-resolved round runs through the sealed
    // pipeline, which prepends/appends content this dispatch path never
    // built itself — but the coordinator retains that exact text and hands
    // it back on `result.assembledPrompt`/`result.assembledPromptAttempts`
    // (see `AssembledPromptCaptureV1`/`AssembledPromptAttemptsV1` in
    // runEditActionV1.ts). Write ONE manifest+prompt pair PER captured
    // attempt, not one per round, so a round that fell back from a failing
    // primary candidate to a working secondary retains BOTH attempts'
    // prompts on disk instead of losing the primary's to overwrite — EVERY
    // attempt (including the last) is named by its own `attemptId`; there is
    // no longer an unsuffixed "last attempt" special case. Only fall back to
    // the pre-coordinator template (and the honest `promptCaptureComplete:
    // false`) when no attempt was captured at all (e.g. `initialCandidate`
    // reuse before this was wired, a best-effort capture failure, or a
    // CLI-resolved dispatch that never reaches the coordinator).
    const runsDirUri = vscode.Uri.joinPath(folderUri, RUNS_DIRNAME);
    const capturedAttempts = result.assembledPromptAttempts ?? (
      result.assembledPrompt !== undefined ? [result.assembledPrompt] : []
    );
    if (capturedAttempts.length > 0) {
      for (const attempt of capturedAttempts) {
        const manifest = buildPromptManifestV1(
          options.templateName ?? "run-implementation.md",
          options.templateVariables ?? { prompt: dispatchPrompt },
          attempt.prompt,
          true,
          promptRoundId,
          attempt.attemptId
        );
        await writePromptManifestV1(runsDirUri, manifest, attempt.prompt);
      }
    } else {
      const promptCaptureComplete = result.runnerId !== "copilot-lm";
      const manifest = buildPromptManifestV1(
        options.templateName ?? "run-implementation.md",
        options.templateVariables ?? { prompt: dispatchPrompt },
        dispatchPrompt,
        promptCaptureComplete,
        promptRoundId
      );
      await writePromptManifestV1(runsDirUri, manifest, dispatchPrompt);
    }
  } catch (manifestError) {
    manifestFailureNote = `\n\n## Prompt manifest\n\nFailed to write the prompt observability manifest for this round: ${
      manifestError instanceof Error ? manifestError.message : String(manifestError)
    }\n`;
  }

  // Post-run delta gate, second half (Part 2 step 3): an
  // `inspect-and-complete` continuation is bounded to the quarantined plus
  // previously-reviewed scope. Files it changed OUTSIDE that boundary are
  // kept — the gate is a backstop, not a sandbox — but named in the run log
  // as unreviewed scope, so the prior review's score is never read as
  // covering them. (They still enter the NEXT review's scope through the
  // ordinary attribution/banking below, which is exactly what "unreviewed
  // scope requiring a fresh review" means.)
  const inspectBoundaryViolations =
    result.status === "completed" &&
    claimedRecovery.record?.mode === "inspect-and-complete" &&
    !result.filesChangedUnknown
      ? result.filesChanged.filter(
          (file) =>
            !claimedRecovery.priorImplReviewFiles.includes(file) &&
            !claimedRecovery.priorPendingFiles.includes(file)
        )
      : [];

  // Keyed on `nextRecoverySourceDispatchMode`/`nextRecoverySourceReviewStage`
  // — themselves derived from `options.editActionKey` alone, never from the
  // claimed record's stale `sourceDispatchMode` — so a continuation whose
  // apply-review re-render failed and fell through to the checklist-driven
  // template is recorded honestly as `continuation` here, not misreported as
  // apply-review ancestry it did not actually run under (review blocker,
  // 2026-08-26). `formatRunLogModeHeaderV1` also carries the blocker ids this
  // apply-review round was actually handed (Part 2 step 5), empty for a
  // checklist-driven round.
  const modeAndBlockerHeader = formatRunLogModeHeaderV1(
    currentDispatchMode,
    nextRecoverySourceDispatchMode,
    nextRecoverySourceReviewStage,
    options.dispatchedBlockerIds
  );

  const logContent = `# Implementation Run\n\nRound ID: ${promptRoundId}\n\n${modeAndBlockerHeader}Status: ${
    incompleteRound ? `incomplete (${incompleteRound.kind})` : result.status
  }\n\n${implProviderLine}Files changed:\n${
    result.filesChanged.length > 0
      ? result.filesChanged.map((f) => `- ${f}`).join("\n")
      : "_none recorded_"
  }\n\n${result.summary ?? result.errorMessage ?? ""}${
    incompleteRound && recovery
      ? `\n\n## Incomplete round\n\nThis round was recorded incomplete: ${incompleteRound.reason}.\n\n` +
        `Recovery record: \`${recovery.sourceAttemptId}\` (${
          recovery.capReached
            ? "continuation budget exhausted — human decision needed"
            : `continuation ${recovery.continuations} of ${MAX_INCOMPLETE_ROUND_CONTINUATIONS_V1}, ${recovery.mode}`
        }).\n\n` +
        `Its workspace delta was quarantined into \`pendingImplReviewFiles\` (not banked as review scope):\n${
          quarantinedPaths.length > 0
            ? quarantinedPaths.map((f) => `- ${f}`).join("\n")
            : "_none recorded_"
        }\n`
      : ""
  }${
    timedOutRound && recovery
      ? `\n\n## Externally terminated — recovery scheduled\n\nThis round did not return a final response (${
          result.timeoutReason === "inactivity" ? "inactivity watchdog" : "wall-clock timeout"
        }): ${recovery.sourceAttemptId ? recovery.sourceAttemptId : ""}.\n\n` +
        `Recovery record: \`${recovery.sourceAttemptId}\` (${
          recovery.capReached
            ? "continuation budget exhausted — human decision needed"
            : `continuation ${recovery.continuations} of ${MAX_INCOMPLETE_ROUND_CONTINUATIONS_V1}, ${recovery.mode}`
        }).\n\n` +
        `Its workspace delta was quarantined into \`pendingImplReviewFiles\` (not banked as review scope):\n${
          quarantinedPaths.length > 0
            ? quarantinedPaths.map((f) => `- ${f}`).join("\n")
            : result.filesChangedUnknown
              ? "_unknown — the change set could not be enumerated_"
              : "_none recorded_"
        }\n`
      : ""
  }${
    !incompleteRound && !timedOutRound && recovery
      ? `\n\n## Unusable summary — recovery scheduled\n\nThis round completed, but ${summaryIssue}.\n\n` +
        `Recovery record: \`${recovery.sourceAttemptId}\` (${
          recovery.capReached
            ? "continuation budget exhausted — human decision needed"
            : `continuation ${recovery.continuations} of ${MAX_INCOMPLETE_ROUND_CONTINUATIONS_V1}, ${recovery.mode}`
        }).\n\n` +
        `Its workspace delta was quarantined into \`pendingImplReviewFiles\` until a round reports properly:\n${
          quarantinedPaths.length > 0
            ? quarantinedPaths.map((f) => `- ${f}`).join("\n")
            : result.filesChangedUnknown
              ? "_unknown — the change set could not be enumerated_"
              : "_none recorded_"
        }\n`
      : ""
  }${
    inspectBoundaryViolations.length > 0
      ? `\n\n## Out-of-boundary changes (inspect-and-complete)\n\nThis continuation ran under the inspect-and-complete mandate — bounded to the quarantined plus previously-reviewed files — but changed these paths outside that boundary. They are kept, and recorded as unreviewed scope for the next review; the prior review's score does not cover them:\n${inspectBoundaryViolations.map((file) => `- ${file}`).join("\n")}\n`
      : ""
  }${
    result.typeCheckFailed
      ? `\n\n## Type-check failure (2g)\n\nThe project no longer type-checks after this round's edits:\n\n\`\`\`\n${result.typeCheckOutput ?? ""}\n\`\`\`\n`
      : ""
  }${
    checklistMutation !== undefined
      ? `\n\n## Checklist change discarded (Part 6 guard)\n\nThis round's edit to plan-final.md changed the checklist item set (${checklistMutation.kind}). A round never mutates the checklist — discovered work and needed decisions surface as blockers and decisions instead. The item set was reverted to what it read at dispatch; any ticks this round genuinely reported were still re-merged against the reverted set.\n\n` +
        (checklistMutation.addedItems.length > 0
          ? `Proposed additions (discarded):\n${checklistMutation.addedItems.map((item) => `- ${item}`).join("\n")}\n\n`
          : "") +
        (checklistMutation.removedItems.length > 0
          ? `Dropped items (restored):\n${checklistMutation.removedItems.map((item) => `- ${item}`).join("\n")}\n`
          : "")
      : ""
  }${manifestFailureNote ?? ""}`;

  const logUri = await writeRunLog(folderUri, result.runnerId, "impl", logContent);
  // No handle in scope here either — resolve the task's live root operation.
  taskOperations.setResultTargetUriForTask(folderUri.fsPath, logUri);

  if (checklistMutation !== undefined) {
    // Durable trace (Part 6 / item 5) — the run log above already carries the
    // discarded delta; this is what a stage gate or panel reads back without
    // re-parsing run logs.
    const checklistMutationAt = new Date().toISOString();
    const patchedForMutation = await patchTaskProgressStrictV1(folderUri, (current) =>
      appendChecklistChangeProposal(current, {
        at: checklistMutationAt,
        roundId: implRoundId,
        stage: postRunReviewStage,
        kind: checklistMutation.kind,
        proposedItems: checklistMutation.addedItems,
        removedItems: checklistMutation.removedItems,
        status: "pending",
      })
    );
    NotificationRouter.showWarning(
      "⚠️ This round tried to change plan-final.md's checklist item set (not just tick state). A round " +
        "never mutates the checklist — the item set was reverted to what it read at the start of this " +
        "round, and any ticks it genuinely reported were still recorded against the reverted set. See the " +
        "run log for what was discarded."
    );
    // Both options this decision offers are now real commands
    // (planRevisionV1.ts), so — unlike when this block was first written —
    // posting it no longer offers an option the system already knows does
    // nothing (item 10 of this same workflow-defects investigation).
    await postChecklistChangeProposedDecisionV1(
      folderUri.fsPath,
      folderUri.fsPath,
      postRunReviewStage,
      {
        at: checklistMutationAt,
        kind: checklistMutation.kind,
        proposedItems: checklistMutation.addedItems,
        removedItems: checklistMutation.removedItems,
      },
      patchedForMutation?.displayName
    );
  }

  if (result.status === "completed") {
    const summaryUri = getImplementationSummaryUri(folderUri);

    if (incompleteRound && recovery) {
      // A detected deferred/cut-short round is recorded INCOMPLETE and
      // recovered through an explicit continuation — never banked as a
      // completed round and then blamed on a malformed summary. The durable
      // recovery transition (quarantine, counter, `implRecovery` record)
      // already persisted ABOVE, before the run log was written, so the
      // round's edits can never be discarded even if everything from the log
      // write onward fails.
      //
      // Deliberately preserved, in contrast to the rejected-summary path:
      //  - impl-summary.md / impl-summary_prev.md keep the previous good
      //    summary (no `implementation-summary-unusable` replacement) — the
      //    detected round produced no report to replace them with;
      //  - the stage's review artifact keeps its content (no
      //    markReviewArtifactStale placeholder); the durable
      //    `reviewInvalidatedByRound` marker records instead that it no
      //    longer describes the workspace.
      await recovery.finishDispatch();
      await safeOpenTextDocument(logUri, "implementation run log");
      return false;
    }

    // The zero-change routing below is premised on a round that REPORTED
    // properly ("the model reported completion... and found no defect to
    // fix"). A rejected summary is not that round: it owes a continuation via
    // the recovery transition above, and letting it return early here left
    // the pending dispatch unscheduled (and its stamp unwritten) for exactly
    // the zero-change case (review blocker, 2026-08-14).
    //
    // An ACCEPTED summary-only continuation is not that round either, from
    // the other direction: changing zero files is its MANDATE, not a "model
    // found nothing to fix" observation — its progress is the report itself
    // (summary write, checklist ticks, quarantine promotion below). Counting
    // it as a zero-change round would advance the no-progress breaker on a
    // round that did exactly its job, and the early return here would skip
    // the promotion that clears the recovery record.
    const acceptedSummaryOnlyReport =
      !summaryIssue && claimedRecovery.record?.mode === "summary-only";
    if (
      !summaryIssue &&
      !acceptedSummaryOnlyReport &&
      !result.filesChangedUnknown &&
      result.filesChanged.length === 0
    ) {
      const resilience = getResilienceSettings();
      const priorProgress = await readTaskProgressAdvisoryV1(folderUri);
      // "Prior rounds already changed the tree": implReviewFiles is the
      // durable record of the last implementation round's real edits.
      const priorRoundsChangedTree = (priorProgress?.implReviewFiles?.length ?? 0) > 0;
      // Item 4 (2026-08-17..19 workflow-defects batch): `priorRoundsChangedTree`
      // alone cannot tell "the model correctly found nothing left to fix" from
      // "a provider silently produced nothing" while real plan work remains.
      // The missing evidence is the plan checklist itself, already computed a
      // few lines below for the under-recording latch — hoisted here so the
      // gate can consult it too. `!checklistAdvanced` excludes a round that
      // itself just landed real ticks (that is progress, not sterility);
      // `!checklistClaimedButUnmerged` excludes a round whose `## Plan Item
      // Checklist` claim failed to match — that shape already has its own
      // dedicated, unconditional latch further below (`checklistStateUnrecorded`)
      // which fires regardless of review status and posts a reconcile
      // decision; refusing it here first would only replace that specific,
      // actionable outcome with a generic "provider may be blocked" warning.
      // `remainingChecklistProgress.remaining > 0` is the plan's own claim
      // that work remains; `latestReviewClearsStage` is the SAME
      // zero-blocker/at-threshold signal `checklistUnderrecordingConfirmedByReview`
      // trusts below — deliberately reused, not reinvented, so this gate
      // stands down on exactly the evidence that latch stands up on.
      //
      // Routed through the shared latch-aware reader (`readPlanChecklistProgressV1`,
      // which wraps `readEffectivePlanChecklistProgressV1` under the "strict"
      // policy — see :6316) instead of a local duplicate of its stand-down
      // condition. Review finding, wf10 item 1 (2026-08-24): a hand-rolled
      // `!priorProgress?.checklistProgressUnreliable` guard reproduced only
      // the latch bit, not the reader's full authority/unreadable-state
      // contract — every OTHER completeness check in this file goes through
      // this same wrapper, and this consumer must not be the one place that
      // drifts from it. Deadlock this closes: a latch set by an EARLIER
      // round, `remaining > 0` on the stale count, and
      // `latestReviewClearsStage` false because the newest review scored
      // below threshold WITH blockers — none of which the user can change
      // from the implementation stage, so the gate refused forever
      // (2026-08-21, jester task 3: latch true, "21 unticked item(s)" fired
      // three times).
      const remainingChecklistProgress = await readPlanChecklistProgressV1(folderUri);
      const latestReviewClearsStage = latestQualifyingReviewMeetsThresholdV1({
        history: priorProgress?.reviewScoreHistory,
        stage: priorProgress?.currentStage ?? postRunReviewStage,
        threshold: getAutoAdvanceScoreThreshold(),
        requireZeroBlockers: true,
      });
      // `!checklistClaimedButUnmerged` excludes a round whose `## Plan Item
      // Checklist` claim failed to match from THIS gate specifically — not
      // from refusal altogether (review finding, 2026-08-20; see below). Such
      // a round still needs the streak/no-progress-breaker machinery in the
      // 2b block just past this gate to run (a repeated claimed-but-unmerged
      // round must still be able to escalate to a human eventually, exactly
      // like any other sterile round), so it is deliberately let through
      // HERE — `checklistClaimedButUnmergedWithoutClearingReview` below
      // refuses it for real once that accounting has had a chance to run.
      const uncheckedItemsWithoutClearingReview =
        !checklistAdvanced &&
        !checklistClaimedButUnmerged &&
        remainingChecklistProgress !== undefined &&
        remainingChecklistProgress.remaining > 0 &&
        !latestReviewClearsStage;
      // Review finding (2026-08-20): a claimed-but-unmerged round with real
      // unticked work and no clearing review must ALSO be refused — the
      // dedicated `checklistStateUnrecorded` latch further below records the
      // under-recording, but only sets a flag; on its own it never stopped
      // this round from auto-advancing into review as a false "nothing to
      // fix" completion (exactly the shape `uncheckedItemsWithoutClearingReview`
      // exists to catch for every OTHER round). Computed now, consulted once
      // the streak/no-progress-breaker accounting below has run.
      const checklistClaimedButUnmergedWithoutClearingReview =
        checklistClaimedButUnmerged &&
        remainingChecklistProgress !== undefined &&
        remainingChecklistProgress.remaining > 0 &&
        !latestReviewClearsStage;
      if (
        !resilience.nothingToFixRoutesToReview ||
        !priorRoundsChangedTree ||
        uncheckedItemsWithoutClearingReview
      ) {
        // wf10 item 4 / Part 4: this is exactly the "Status: completed" +
        // zero files + (unticked items or no established evidence of a
        // justified no-op) shape that was previously indistinguishable from
        // a genuine no-op — record it durably as `provider-failure-empty`
        // rather than only as a transient notification.
        const gateClassification = classifyZeroFileImplRoundV1({
          checklistAdvanced,
          warnedAsZeroFileFailure: true,
        });
        // `gateStage` (the task's actual current stage — possibly a review
        // stage such as "impl-high-review" when this round was launched from
        // Apply Review/Fast Forward) is kept ONLY for `escalateReviewToHuman`'s
        // stage-CAS match and for the human-facing stage name in the
        // escalation/warning text below. It must never key implementation
        // round-outcome bookkeeping: `runImplementationOrSealedV1` always
        // resolves its model/quota/fallback chain from stage "impl" (see the
        // comment on its own `stage: "impl"` argument above), and
        // `recordActiveFallbackModel`/`candidateHasRecentZeroFileFailuresV1`
        // (runnerRegistry.ts) read/write `fallbackActive`/`roundOutcomes`
        // under that same literal "impl" — a round-outcome entry or
        // `fallbackActive` read keyed to `gateStage` instead is invisible to
        // both, so the Part 5 breaker/candidate-skip machinery can never see
        // an implementation round dispatched while the task sits on a review
        // stage (review fix, Part 5 steps 13-14).
        const gateStage = priorProgress?.currentStage ?? postRunReviewStage;
        const implBookkeepingStage: TaskStage = "impl";
        const gateFallbackActive = priorProgress?.fallbackActive?.[implBookkeepingStage] === true;
        // The round-outcome entry must name the candidate that ACTUALLY ran,
        // not the stage's requested/primary model: `runImplementationOrSealedV1`
        // can internally cascade from primary to a backup and still return
        // `status: "completed"`, in which case `result.storedModelId` is the
        // backup that produced this result while `modelId` (this function's
        // parameter) remains the primary that was requested. Attributing a
        // zero-file round to the wrong candidate would let the breaker/skip
        // logic blame (or exonerate) the wrong provider path (review fix,
        // Part 5 steps 13-14).
        const gateActualModelId = result.storedModelId ?? modelId;
        // wf10 review fix (Part 5 steps 13-14, narrowed blocker 1): candidate
        // identity is the full provider path, not `modelId` alone —
        // `result.runnerId` is the runner that actually produced `result`
        // (e.g. "claude-cli", or "copilot-lm" for every Copilot dispatch,
        // which is routed exclusively through the sealed pipeline here).
        const gateActualProviderId = result.runnerId;
        // Part 4 (item 1): this round already reached this branch because it
        // FINISHED — providing an unusable/empty result, not owing a
        // recovery continuation (that path is handled by
        // `beginImplementationRecoveryV1` above and never reaches here) — so
        // its ledger state is "completed" regardless of `gateClassification`
        // describing the OUTCOME as unproductive.
        const gateTerminalization = await terminalizeRoundV1(
          implRoundId,
          "completed",
          { filesChanged: [] },
          {
            taskFolderUri: folderUri,
            ...(implExtraAttemptIds.length ? { extraAttemptIds: implExtraAttemptIds } : {}),
            roundOutcomeClassification: {
              classification: gateClassification,
              stage: implBookkeepingStage,
              attemptId: implRoundId,
              ...(gateActualModelId ? { modelId: gateActualModelId } : {}),
              ...(gateActualProviderId ? { providerId: gateActualProviderId } : {}),
              dispatchMode: currentDispatchMode,
              // Review fix, Step 11 narrowed blocker 2: record which review
              // stage was actually active so a plateau card for one impl-review
              // stage cannot absorb a round dispatched while the task was at
              // the other. Omitted when `gateStage` is itself "impl" (no review
              // stage was active) or matches something outside the impl-review
              // pair (nothing to disambiguate).
              ...(IMPL_REVIEW_STAGES.includes(gateStage) ? { originatingReviewStage: gateStage } : {}),
            },
          }
        );
        const persistedGateRounds = gateTerminalization.ok ? gateTerminalization.progress : undefined;
        await appendRoundOutcomeLogNoteV1(logUri, gateClassification);
        // wf10 item 3 / item 6b / Part 5 step 13: a fallback provider that has
        // now produced `fallbackProviderBreakerRounds` consecutive zero-file
        // rounds is a known-broken path — stop and name it instead of letting
        // the user rerun into the same wall (the exact wf9/jester shape: both
        // stalled tasks kept re-dispatching to a sealed Copilot preflight
        // fallback that produced zero edits, round after round). Takes
        // priority over the generic warning below — item 9's "the last thing
        // the user reads wins" rule means these two must never both show for
        // the same round (a specific, actionable diagnosis followed by a
        // generic "may have been blocked" reads as a downgrade, not an
        // addition).
        if (
          gateClassification === "provider-failure-empty" &&
          shouldTripFallbackProviderBreakerV1({
            roundOutcomes: persistedGateRounds?.roundOutcomes,
            stage: implBookkeepingStage,
            modelId: gateActualModelId,
            providerId: gateActualProviderId,
            fallbackActive: gateFallbackActive,
            breakerRounds: resilience.fallbackProviderBreakerRounds,
          })
        ) {
          const fallbackLabel = gateActualModelId
            ? (attributionModelLabel(gateActualModelId) ?? gateActualModelId)
            : "the fallback model";
          await escalateReviewToHuman(
            folderUri,
            gateStage,
            "environmental",
            `The active fallback provider for ${STAGE_DISPLAY_NAMES[gateStage]} (${fallbackLabel}) has now ` +
              `produced ${resilience.fallbackProviderBreakerRounds} consecutive rounds that changed zero files ` +
              "while the plan checklist still has unticked items — it is not producing edits. Switch this " +
              "stage's model in AI Models rather than rerunning: the fallback is not going to start writing " +
              "files by being tried again.",
            priorProgress?.reviewAttemptId,
            persistedGateRounds ?? priorProgress ?? undefined
          );
        } else {
          NotificationRouter.showWarning(
            uncheckedItemsWithoutClearingReview
              ? "Implementation reported nothing to fix, but the plan checklist still has " +
                  `${remainingChecklistProgress?.remaining} unticked item(s) and no review has cleared this ` +
                  "stage yet. Run this stage's review next: if it clears (meets the auto-advance threshold " +
                  "with zero blockers), the checklist under-recording latch engages automatically on the " +
                  "following round and **Ensemble: Mark Plan Checklist Reconciled** becomes available; if it " +
                  "does not clear, its blockers name the work that is actually still outstanding."
              : "Implementation finished, but no workspace files changed. " +
                  "Review the implementation run log; the provider may have been blocked from writing files.",
            undefined,
            undefined,
            undefined,
            uncheckedItemsWithoutClearingReview
              ? {
                  command: "vs-code-ai-helper.runReviewWithAI",
                  title: "Run Review",
                  args: [{ taskFolderPath: folderUri.fsPath }]
                }
              : undefined
          );
        }
        await safeOpenTextDocument(logUri, "implementation run log");
        return false;
      }
      // 2b: the model reported completion, prior rounds already changed the
      // tree, and it found no defect to fix — a correct implementer that
      // declines to fabricate work. Route onward to review/complete instead
      // of recording a spurious failure (observed five times; in every case
      // the model was behaving correctly).
      //
      // The streak is about STERILE rounds — no file delta AND no checklist
      // delta — not file delta alone (Part 3 generalization). A round that
      // changed no files but DID land new checklist ticks (`checklistAdvanced`)
      // made real, durable progress and resets the streak exactly like a round
      // that changed files; one that changed no files and merged none — which
      // includes claimed-but-unmerged retroactive claims, "no-match" — is
      // exactly as sterile as one that reported nothing, and still counts.
      const zeroChangeRounds = checklistAdvanced
        ? 0
        : (priorProgress?.zeroChangeImplRounds ?? 0) + 1;
      // Part 3 (workflow 3 continuation, second item): a sterile round can
      // loop forever when the checklist's own counts are wrong rather than
      // the plan being unfinished — this round changed nothing and landed no
      // ticks, but the most recent review for this stage already scored the
      // work at or above the auto-advance threshold with zero blockers. That
      // combination proves the plan's remaining count is under-recording
      // (the exact condition `checklistProgressUnreliable` exists to stand
      // the completeness gate down for), so this latches on the FIRST
      // sterile round it holds for — well before the no-progress breaker
      // below would otherwise grind to a pause waiting on a human.
      // `requireZeroBlockers: true` is deliberately stricter than the
      // breaker's own qualifying check just below it: a review WITH
      // blockers still names real, unresolved work and must not stand the
      // gate down.
      const checklistUnderrecordingConfirmedByReview =
        !checklistAdvanced &&
        remainingChecklistProgress !== undefined &&
        remainingChecklistProgress.remaining > 0 &&
        latestReviewClearsStage;
      const newlyLatchingChecklistUnreliable =
        checklistUnderrecordingConfirmedByReview && !priorProgress?.checklistProgressUnreliable;
      const zeroChangeClassification = classifyZeroFileImplRoundV1({
        checklistAdvanced,
        warnedAsZeroFileFailure: checklistClaimedButUnmergedWithoutClearingReview,
      });
      const zeroChangeBookkeepingStage: TaskStage = "impl";
      const zeroChangeActualModelId = result.storedModelId ?? modelId;
      // wf10 review fix (Part 5 steps 13-14, narrowed blocker 1): same
      // full-provider-path identity fix as the gate block above.
      const zeroChangeActualProviderId = result.runnerId;
      // Same bookkeeping-vs-display split, and same actual-vs-requested
      // candidate fix, as the gate block above (review fix, Part 5 steps
      // 13-14): the round-outcome entry and the breaker read below must key
      // on literal "impl" (where `runImplementationOrSealedV1` actually
      // resolves its model/quota/fallback chain) and on the candidate that
      // actually produced `result`, not on the task's current review stage or
      // the originally-requested model. Same formula as `zeroChangeStage`
      // below (computed once here since it is needed before that point too).
      const zeroChangeOriginatingStage = priorProgress?.currentStage ?? postRunReviewStage;
      // Part 4 (item 1): this branch is reached only once the gate above has
      // already ruled out the NAMED `uncheckedItemsWithoutClearingReview`
      // shape of `provider-failure-empty` — but `checklistClaimedButUnmerged`
      // rounds are deliberately let past that gate too, and this round
      // FINISHED regardless of classification, so its ledger state is
      // "completed" here too (see the gate block's own comment above).
      const zeroChangeTerminalization = await terminalizeRoundV1(
        implRoundId,
        "completed",
        { filesChanged: [] },
        {
          taskFolderUri: folderUri,
          ...(implExtraAttemptIds.length ? { extraAttemptIds: implExtraAttemptIds } : {}),
          extraPatch: (current) => {
            const withStreak = setZeroChangeImplRounds(
              current,
              zeroChangeRounds > 0 ? zeroChangeRounds : undefined
            );
            return checklistUnderrecordingConfirmedByReview && !current.checklistProgressUnreliable
              ? { ...withStreak, checklistProgressUnreliable: true, updatedAt: new Date().toISOString() }
              : withStreak;
          },
          roundOutcomeClassification: {
            classification: zeroChangeClassification,
            stage: zeroChangeBookkeepingStage,
            attemptId: implRoundId,
            ...(zeroChangeActualModelId ? { modelId: zeroChangeActualModelId } : {}),
            ...(zeroChangeActualProviderId ? { providerId: zeroChangeActualProviderId } : {}),
            dispatchMode: currentDispatchMode,
            ...(IMPL_REVIEW_STAGES.includes(zeroChangeOriginatingStage)
              ? { originatingReviewStage: zeroChangeOriginatingStage }
              : {}),
          },
        }
      );
      const persistedRounds = zeroChangeTerminalization.ok ? zeroChangeTerminalization.progress : undefined;
      await appendRoundOutcomeLogNoteV1(logUri, zeroChangeClassification);
      // wf10 item 3 / Part 5 step 13: the same fallback-provider circuit
      // breaker as the earlier gate — this branch reaches
      // `provider-failure-empty` through a different path
      // (`checklistClaimedButUnmergedWithoutClearingReview`), which the gate
      // above deliberately lets past it (see the comment at that patch), so
      // it needs its own check here rather than relying solely on the
      // broader task-wide no-progress breaker further below to eventually
      // catch a fallback provider stuck on this exact shape.
      // `zeroChangeStage` (the task's actual current stage) is kept only for
      // `escalateReviewToHuman`'s stage-CAS match and the human-facing text.
      const zeroChangeStage = priorProgress?.currentStage ?? postRunReviewStage;
      if (
        zeroChangeClassification === "provider-failure-empty" &&
        shouldTripFallbackProviderBreakerV1({
          roundOutcomes: persistedRounds?.roundOutcomes,
          stage: zeroChangeBookkeepingStage,
          modelId: zeroChangeActualModelId,
          providerId: zeroChangeActualProviderId,
          fallbackActive: priorProgress?.fallbackActive?.[zeroChangeBookkeepingStage] === true,
          breakerRounds: resilience.fallbackProviderBreakerRounds,
        })
      ) {
        const fallbackLabel = zeroChangeActualModelId
          ? (attributionModelLabel(zeroChangeActualModelId) ?? zeroChangeActualModelId)
          : "the fallback model";
        const fallbackBreakerEscalated = await escalateReviewToHuman(
          folderUri,
          zeroChangeStage,
          "environmental",
          `The active fallback provider for ${STAGE_DISPLAY_NAMES[zeroChangeStage]} (${fallbackLabel}) has now ` +
            `produced ${resilience.fallbackProviderBreakerRounds} consecutive rounds that changed zero files ` +
            "while real plan work remains unmerged — it is not producing edits. Switch this stage's model in " +
            "AI Models rather than rerunning: the fallback is not going to start writing files by being tried again.",
          priorProgress?.reviewAttemptId,
          persistedRounds ?? priorProgress ?? undefined,
          false,
          (current) => setZeroChangeImplRounds(current, undefined)
        );
        if (fallbackBreakerEscalated) {
          return false;
        }
      }
      if (newlyLatchingChecklistUnreliable) {
        const outstandingList = describeOutstandingChecklistItemsV1(planChecklist);
        const reconcileNote =
          "\n\n## Checklist counts stood down (under-recording)\n\n" +
          "This round changed no files and landed no checklist ticks, but the most recent " +
          `${priorProgress?.currentStage ?? postRunReviewStage} review already scored the work at or ` +
          "above the auto-advance threshold with zero blockers — the plan's remaining count " +
          `(${remainingChecklistProgress?.remaining} of ${remainingChecklistProgress?.total}) is therefore ` +
          "treated as under-recording rather than real unfinished work. `checklistProgressUnreliable` is now " +
          "set: completeness is not gating advancement until the checklist is reconciled. Tick the missed " +
          `items in plan-final.md, then run **Ensemble: Mark Plan Checklist Reconciled** to confirm and ` +
          `restore the gate.${outstandingList}`;
        const existingLog = await readTextIfExists(logUri);
        if (existingLog !== undefined) {
          await writeTextFile(logUri, `${existingLog}${reconcileNote}\n`, { skipBackup: true });
        }
        // Posts the same explained WorkflowDecisionV1 (case 4 —
        // reconcilePlanChecklist.ts's doc comment) that command posts,
        // called directly (rather than via `vscode.commands.executeCommand`)
        // because this write path has no `TaskInventory`/`CurrentTaskStore`
        // to resolve through and a unit-test harness stubbing only the write
        // path would not have the command registered anyway.
        const reconcilePosted = persistedRounds
          ? await postReconcilePlanChecklistDecisionV1(
              folderUri,
              folderUri.fsPath,
              folderUri.fsPath,
              persistedRounds,
              checklistMergeResult
            )
          : { kind: "noContext" as const };
        if (reconcilePosted.kind !== "posted") {
          // No activating extension context (or nothing to reconcile yet) —
          // still tell the operator the counts are being stood down rather
          // than surfacing nothing at all.
          NotificationRouter.showWarning(
            "⚠️ The plan checklist still shows unfinished items, but the most recent review already scored " +
              "this stage at full marks with zero blockers — the checklist's counts are treated as " +
              "under-recording, not real unfinished work, and completeness is no longer gating advancement. " +
              `${checklistReconcileGuidanceSentenceV1(outstandingList)}${outstandingList}`,
            undefined,
            undefined,
            undefined,
            {
              command: "vs-code-ai-helper.reconcilePlanChecklist",
              title: "Mark Plan Checklist Reconciled",
              args: [{ taskFolderPath: folderUri.fsPath }],
            }
          );
        }
      }
      // A sterile round is only evidence that "the current state satisfies the
      // plan" when there is no standing blocker. When the newest impl review
      // DOES still report task-fixable work, this round changed nothing
      // because Implementation is rendered with the plan checklist and not
      // with the review — it never saw the blockers, and its checklist had
      // nothing actionable left. Announcing that as a clean "already
      // satisfies the plan" is what let this loop silently: the round settles
      // completed, routes to review, the review reports the same blockers,
      // and the next round is answered by the same blind action.
      //
      // Neither existing safety valve catches this shape. The
      // `checklistProgressUnreliable` latch and the no-progress breaker both
      // require the latest review to MEET the auto-advance threshold — a
      // 5/10 review carrying blockers qualifies for neither — so the stall
      // runs until the churn ceiling fires on the review side, rounds later.
      const sterileRoundDecision = decidePostReviewActionV1({
        history: priorProgress?.reviewScoreHistory,
        stages: IMPL_REVIEW_STAGES_V1,
        hasUntickedChecklistItems: (remainingChecklistProgress?.remaining ?? 0) > 0,
        continuationOwed: (persistedRounds ?? priorProgress)?.implRecovery !== undefined,
        pendingImplReviewFilesCount:
          (persistedRounds ?? priorProgress)?.pendingImplReviewFiles?.length ?? 0,
      });
      if (sterileRoundDecision.action === "apply-review" || sterileRoundDecision.action === "both") {
        // Migrated off the single-action-button `NotificationRouter.showWarning`
        // notification onto a `WorkflowDecisionV1` record (task "Actionable
        // Hand-offs", "The worse case", fix part 2) — a message with a button
        // that changes what happens next is a decision, not a notification,
        // and this one decides from the same routing `preImplementationRouting`
        // does (this round just ran at `impl`, where every apply command
        // refuses — see goToReviewAndApplyV1).
        //
        // wf10 item 6: `"both"` means a task-fixable blocker AND unticked
        // checklist items coexist (decidePostReviewActionV1's doc comment) —
        // included here alongside `"apply-review"` so this branch is reached
        // whenever a blocker stands, rather than falling to the `else` below,
        // which asserts "the current state already satisfies the plan" — false
        // whenever the checklist is not actually complete.
        const targetReviewStage: TaskStage =
          sterileRoundDecision.reviewStage === "impl-high-review"
            ? "impl-high-review"
            : "impl-low-review";
        const sterileStage = priorProgress?.currentStage ?? postRunReviewStage;
        const target: ChatTarget = {
          canonicalId: folderUri.fsPath,
          taskFolderPath: folderUri.fsPath,
          stage: sterileStage,
          taskName: priorProgress?.displayName,
        };
        const sterileBothValid = sterileRoundDecision.action === "both";
        const sterileWhyUserNeeded = sterileBothValid
          ? "This round found nothing to fix, but the plan checklist still has unticked items — only Apply " +
            "Review can fix what the newest review still reports; running Implementation again is not " +
            "guaranteed to touch the remaining checklist work either, since this same round already reported " +
            "nothing to do."
          : "Implementation only reads the plan checklist, so running it again will give the same " +
            "result — only Apply Review can fix what the newest review still reports.";
        const sterileDecisionPosted = await postWorkflowDecisionV1(
          {
            decisionKey: "sterileRoundRouting",
            taskCanonicalId: folderUri.fsPath,
            stage: sterileStage,
            whatHappened: `Implementation changed no files. ${sterileRoundDecision.reason}`,
            whyUserNeeded: sterileWhyUserNeeded,
            options: [
              {
                optionId: "goToReviewAndApply",
                label: "Go to Review & Apply",
                consequence:
                  `Moves the task to ${STAGE_DISPLAY_NAMES[targetReviewStage]} and opens Apply Review, ` +
                  "which can fix the blockers Implementation cannot see.",
                effect: {
                  kind: "command",
                  // Resumes the task first if it has since been paused
                  // (review blocker 2026-08-30, item 14) rather than the
                  // plain goToReviewAndApply, which fails with a confusing
                  // "task could not be found" on a paused task.
                  command: "vs-code-ai-helper.resumeIfPausedThenGoToReviewAndApply",
                  args: [{ taskFolderPath: folderUri.fsPath, reviewStage: targetReviewStage }],
                },
              },
              {
                optionId: "notNow",
                label: "Not now",
                consequence:
                  "Does nothing. Review the implementation run log and use Apply Review yourself when ready.",
                effect: { kind: "doNothing" },
              },
            ],
            recommendation: {
              kind: "option",
              optionId: "goToReviewAndApply",
              reasoning: sterileBothValid
                ? "Apply Review can fix what the newest review still reports. Running Implementation again " +
                  "is also valid — the plan checklist still has unticked items — but this same round already " +
                  "found nothing actionable there, so Apply Review is recommended first."
                : "Apply Review is the only action that can fix what the newest review still reports; " +
                  "running Implementation again will give the same (unchanged) result.",
            },
            gating: {
              holdsTaskPaused: false,
              unblocksProgress: false,
              detail:
                "This does not pause the task itself — it only offers a shortcut to the review stage, " +
                "resuming first if the task happens to be paused by the time you click it. " +
                "\"Not now\" does nothing further; you can still run Apply Review manually at any time.",
            },
          },
          target
        );
        if (!sterileDecisionPosted) {
          NotificationRouter.showWarning(
            `Implementation changed no files. ${sterileRoundDecision.reason} ` +
              (sterileBothValid
                ? "The plan checklist still has unticked items, so running Implementation again is also " +
                  "valid — but Go to Review & Apply can fix what the newest review reports right now."
                : "Running Implementation again will give the same result — use Go to Review & Apply instead."),
            undefined,
            undefined,
            undefined,
            {
              command: "vs-code-ai-helper.resumeIfPausedThenGoToReviewAndApply",
              title: "Go to Review & Apply",
              args: [{ taskFolderPath: folderUri.fsPath, reviewStage: targetReviewStage }]
            }
          );
        }
      } else {
        NotificationRouter.showInformation(
          "Implementation finished with no file changes — the model reported the current state already " +
            "satisfies the plan. Routing to review instead of recording a failure " +
            "(ensemble.resilience.nothingToFixRoutesToReview)."
        );
      }
      // 2c: N consecutive zero-change rounds is a loop producing no edits at
      // all — stop and escalate rather than running to
      // fastForwardMaxIterations. The counter itself (not the blocker
      // situation) is now the trigger — see shouldTripNoProgressBreaker.
      if (
        shouldTripNoProgressBreaker({
          zeroChangeRounds,
          breakerRounds: resilience.noProgressBreakerRounds,
          history: priorProgress?.reviewScoreHistory,
          // Review finding (2026-08-14): the breaker exists for a PASSING
          // review looping back to impl forever, not sterile rounds against
          // real unresolved work — gate the trip on the most recent review
          // for this same stage meeting the auto-advance threshold.
          qualifyingStage: priorProgress?.currentStage ?? postRunReviewStage,
          qualifyingThreshold: getAutoAdvanceScoreThreshold(),
        })
      ) {
        const escalated = await escalateReviewToHuman(
          folderUri,
          priorProgress?.currentStage ?? postRunReviewStage,
          "plateau",
          `${zeroChangeRounds} consecutive implementation round(s) changed zero files and made no ` +
            "checklist progress (no-progress breaker, ensemble.resilience.noProgressBreakerRounds). " +
            "Automated iteration is no longer producing edits." +
            (checklistClaimedButUnmerged
              ? " The latest round reported plan-item completions that did not match any item in the " +
                "plan of record — if that work is genuinely done, run Reconcile Plan Checklist to " +
                "confirm it by hand."
              : "") +
            // Names what remains instead of leaving the human to search the
            // plan for it — the same enumeration every other "tick the missed
            // items" surface now carries (workflow 3 continuation, Part 5).
            (remainingChecklistProgress && remainingChecklistProgress.remaining > 0
              ? ` The plan checklist still lists ${remainingChecklistProgress.remaining} unfinished ` +
                `item(s):${describeOutstandingChecklistItemsV1(planChecklist)}`
              : ""),
          // NOT coerced to "": the attempt CAS expects the value read from
          // the state persisted moments ago, and for an implementation-stage
          // task that value is legitimately ABSENT (the impl transition
          // clears reviewAttemptId, taskProgressFieldPolicyV1) — the same
          // reasoning implementationRecoveryV1.ts's cap-exhaustion escalation
          // already applies. Coercing to "" made this CAS unsatisfiable
          // (current.reviewAttemptId reads undefined, never "") on exactly
          // the implementation-stage task the no-progress breaker exists for,
          // so the escalation could never actually apply (found while adding
          // end-to-end coverage for the qualifying-review gate, 2026-08-14).
          priorProgress?.reviewAttemptId,
          persistedRounds ?? priorProgress ?? undefined,
          false,
          // Review finding (2026-08-14): when the diagnosed cause is claimed
          // -but-unmerged checklist progress, the latch and its
          // reconcilePlanChecklist remedy must land in the SAME transaction
          // that pauses the task and records the escalation — a crash or
          // write failure between two separate patches could otherwise leave
          // the task paused with the reconciliation remedy still inert (the
          // exact prior-blocker state). `extraMutation` folds both the
          // streak clear and the latch into escalateReviewToHuman's own
          // patchTaskProgressStrictV1 call, applied only once its CAS guards
          // have already decided to apply.
          (current) => {
            const cleared = setZeroChangeImplRounds(current, undefined);
            return checklistClaimedButUnmerged
              ? { ...cleared, checklistProgressUnreliable: true }
              : cleared;
          }
        );
        if (escalated) {
          return false;
        }
      }
      // Review finding (2026-08-20): the round-level accounting above
      // (streak increment, latch-if-a-review-already-cleared, the
      // no-progress-breaker's chance to escalate) has now run exactly as it
      // would for any other sterile round. If this was a claimed-but-unmerged
      // round with real unticked plan work and no review has cleared the
      // stage, it must still be refused instead of falling through to
      // auto-advance as a false "nothing to fix" completion — recording the
      // reconciliation need now (rather than only via `checklistStateUnrecorded`
      // further below, which would otherwise be the first and only latch, and
      // would fire too late to stop the advance that already happened).
      if (checklistClaimedButUnmergedWithoutClearingReview) {
        const outstandingList = describeOutstandingChecklistItemsV1(planChecklist);
        const latchedProgress = await patchTaskProgressStrictV1(folderUri, (current) =>
          current.checklistProgressUnreliable
            ? undefined
            : { ...current, checklistProgressUnreliable: true, updatedAt: new Date().toISOString() }
        );
        const existingLog = await readTextIfExists(logUri);
        if (existingLog !== undefined) {
          const reconcileNote =
            "\n\n## Checklist reconciliation needed\n\n" +
            "This round reported plan-item completions that did not match any item in the plan of " +
            "record (checklistClaimedButUnmerged), the plan checklist still has unticked items, and no " +
            "review has cleared this stage yet — so this round was refused rather than routed onward. " +
            "`checklistProgressUnreliable` is now set: completeness is not gating advancement until the " +
            "checklist is reconciled. Tick the missed items in plan-final.md, then run **Ensemble: Mark " +
            `Plan Checklist Reconciled** to confirm and restore the gate.${outstandingList}`;
          // skipBackup: appends to the just-written log; a `_prev` sibling in
          // runs/ would read as a second run.
          await writeTextFile(logUri, `${existingLog}${reconcileNote}\n`, { skipBackup: true });
        }
        const reconcilePosted = latchedProgress
          ? await postReconcilePlanChecklistDecisionV1(
              folderUri,
              folderUri.fsPath,
              folderUri.fsPath,
              latchedProgress,
              checklistMergeResult
            )
          : { kind: "noContext" as const };
        if (reconcilePosted.kind !== "posted") {
          NotificationRouter.showWarning(
            "Implementation reported nothing to fix, but its plan-item completions did not match the " +
              "plan of record and unticked items remain with no review clearing this stage. The checklist " +
              "is treated as under-recording — tick the missed items in plan-final.md, then run " +
              `**Ensemble: Mark Plan Checklist Reconciled** to confirm and restore the gate.${outstandingList}`,
            undefined,
            undefined,
            undefined,
            {
              command: "vs-code-ai-helper.reconcilePlanChecklist",
              title: "Mark Plan Checklist Reconciled",
              args: [{ taskFolderPath: folderUri.fsPath }],
            }
          );
        }
        await safeOpenTextDocument(logUri, "implementation run log");
        return false;
      }
    } else if (!result.filesChangedUnknown && result.filesChanged.length > 0) {
      // A round that landed real edits breaks any zero-change streak,
      // rejected summary or not. A REJECTED zero-change round touches the
      // counter in neither direction: it skipped the increment branch above
      // (its report is unusable, so "nothing to fix" was never established),
      // and it produced no edits that would justify clearing the streak.
      if (summaryIssue === undefined) {
        await terminalizeRoundV1(
          implRoundId,
          "completed",
          { filesChanged: [...result.filesChanged] },
          {
            taskFolderUri: folderUri,
            ...(implExtraAttemptIds.length ? { extraAttemptIds: implExtraAttemptIds } : {}),
            extraPatch: (current) => setZeroChangeImplRounds(current, undefined),
            roundOutcomeClassification: {
              classification: "edits-produced",
              attemptId: implRoundId,
              ...(modelId ? { modelId } : {}),
              dispatchMode: currentDispatchMode,
            },
          }
        );
        await appendRoundOutcomeLogNoteV1(logUri, "edits-produced");
      } else {
        // wf10 item 4 / Part 4: only a genuinely clean completion earns
        // `edits-produced` here — a round whose summary was rejected
        // (`summaryIssue` set) is already tracked by the recovery
        // transition (`implRecovery`), which is a distinct, richer
        // representation this taxonomy must not duplicate (see the
        // persistence-boundary note on `TaskProgress.roundOutcomes`).
        await patchTaskProgressStrictV1(folderUri, (current) =>
          setZeroChangeImplRounds(current, undefined)
        );
      }
    } else if (summaryIssue === undefined) {
      // wf10 item 4 / Part 4 completion-blocker fix: two completed-round
      // shapes previously reached this point with NO roundOutcomes entry at
      // all — an accepted summary-only continuation (changing zero files is
      // its mandate, not a finding) and a completed round whose change set
      // could not be enumerated (`filesChangedUnknown`). Both are genuine
      // completions, not provider failures, so they earn the same
      // classification a justified zero-file round does: `edits-produced`
      // if this round itself landed checklist ticks, `genuine-no-op`
      // otherwise. A rejected summary (`summaryIssue` set) stays excluded
      // here too — already tracked by the richer `implRecovery`
      // representation (see the comment above).
      const noEditsClassification = classifyZeroFileImplRoundV1({
        checklistAdvanced,
        warnedAsZeroFileFailure: false,
      });
      await terminalizeRoundV1(
        implRoundId,
        "completed",
        result.filesChangedUnknown ? { filesChangedUnknown: true } : { filesChanged: [...result.filesChanged] },
        {
          taskFolderUri: folderUri,
          ...(implExtraAttemptIds.length ? { extraAttemptIds: implExtraAttemptIds } : {}),
          roundOutcomeClassification: {
            classification: noEditsClassification,
            attemptId: implRoundId,
            ...(modelId ? { modelId } : {}),
            dispatchMode: currentDispatchMode,
          },
        }
      );
      await appendRoundOutcomeLogNoteV1(logUri, noEditsClassification);
    }

    // The run summary is written to impl-summary.md and NEVER over
    // plan-final.md. plan-final.md is the implementation plan of record — the
    // promoted plan, then the `<!-- ensemble:implementation-checklist -->`
    // checklist — and three separate consumers read it as durable state:
    // completionLint's collectAiVerifiedPlanItems (which returns undefined,
    // rendering NO Plan Item Verification section at all, once the `- [ ]`
    // lines are gone), publishScopeCheck's path extraction, and
    // {{implementation}} itself. Overwriting it with a run's free-text summary
    // destroyed all three at once (observed live 2026-08-10).
    //
    // Validated before it is written, and validated even when it will not be:
    // a completed run whose final text does not follow the summary contract
    // both implementation prompts mandate is not a reviewable round. The
    // failure that motivated this shipped a "tests are still running in the
    // background, I'll report back" message as the implementation notes; the
    // only guard was non-empty, so both reviewers scored a status message.
    //
    // `summary`, the plan of record, and `summaryIssue` were all computed
    // ONCE above, before the run log was written — the recovery transition
    // for a rejected summary must persist ahead of every other write, and a
    // second read here could disagree with the one the gate used. A plan
    // carrying a checklist must get its checklist back with updated boxes:
    // that echo is the only thing that advances plan progress, so the merge
    // below reuses the same read the gate validated against.
    const planOfRecordUri = getCanonicalImplementationUri(folderUri);
    // Filled in below, only for a runner-synthesized round with a plan
    // checklist — read by the run log write to record the evidence found,
    // and by the reconcile-decision post to surface it for explicit human
    // selection (workflow 8, item 2 / plan Part 4). Never used to exempt the
    // round from checklistProgressUnreliable — see
    // `computeSyntheticRoundChecklistLatchV1`'s doc comment.
    let automaticChecklistReconciliation: AutomaticChecklistReconciliationOutcomeV1 | undefined;

    // Attribution (finding 2): the git snapshot diff spans the round's
    // wall-clock window, not its authorship — edits made BY HAND in the same
    // workspace while a round runs land in the diff and used to be banked
    // verbatim into implReviewFiles (round 015 of "more workflow bugs"
    // self-reported 2 files; the workflow banked 8, adopting the user's own
    // concurrent Claude Code session as review scope). Review scope comes
    // from the intersection of the snapshot with the round's own
    // `## Files Changed` report; snapshot-only paths are excluded from
    // banking and recorded in the run log as unattributed workspace changes.
    // Only a runner-synthesized summary banks the snapshot delta as-is: its
    // `filesChanged` is already authoritative tool-call receipts (the sealed
    // pipeline), not a wall-clock diff. A MODEL-AUTHORED response with no
    // parseable `## Files Changed` section attributes NOTHING — with no
    // self-report to intersect against there is no evidence tying the
    // snapshot's paths to the round, and banking them anyway would let a
    // malformed-but-not-incomplete response adopt concurrent hand edits into
    // review scope (the exact leak this attribution exists to close). Those
    // paths are surfaced in the run log as unattributed instead, and the
    // round's real edits re-enter scope when a later round reports properly.
    const { attributed: attributedFilesChanged, unattributed: unattributedFilesChanged } =
      result.summaryIsSynthetic || result.filesChangedUnknown
        ? { attributed: [...result.filesChanged], unattributed: [] as string[] }
        : attributeImplementationRoundFilesV1(
            result.filesChanged,
            parseReportedFilesChangedV1(summary, { planChecklist })
          );

    if (!summaryIssue) {
      // Signed with the reservation actually invoked (never the requested
      // primary) — same helper and header format review artifacts use
      // (reviewRowV1.ts), so impl-summary.md is indistinguishable in format
      // regardless of which path wrote it.
      // A runner-authored summary is recorded AS runner-authored, so later
      // stages can tell that this round could not report checklist progress
      // instead of reading the plan's frozen counts as current.
      const summaryText = result.summaryIsSynthetic
        ? buildSyntheticImplementationSummaryV1(summary, result.filesChanged)
        : summary;
      const signedSummary = result.providerLabel
        ? withAttribution(
            summaryText,
            result.providerLabel,
            result.storedModelId ? attributionModelLabel(result.storedModelId) : undefined
          )
        : summaryText;
      await writeTextFile(summaryUri, `${signedSummary}\n`);

      // Carry this round's checkbox progress back into the plan of record.
      // The reproduced checklist in the summary is the only persistent record
      // of how much of the plan remains (run-implementation.md), and the next
      // round reads plan-final.md — not the summary — as its Final Plan. It
      // used to arrive there because the summary REPLACED plan-final.md, which
      // is the same coupling that destroyed the checklist when a provider
      // returned a status message. Merging ticks instead keeps the progress
      // record without ever letting a run overwrite the plan.
      if (planChecklist !== undefined) {
        // Reuses the SAME result the zero-change routing decision above
        // already computed (checklistAdvanced/checklistClaimedButUnmerged) —
        // never recomputed, so the two can never disagree about what this
        // round reported.
        const mergeResult = checklistMergeResult ?? mergeChecklistProgressV1(planChecklist, summary);
        if (mergeResult.kind === "merged") {
          // Revision-conditional (review-flagged 2026-08-25, task-fixable
          // blocker `739cfbbb-…-1`, narrowed a seventh time): this was the
          // third remaining in-process writer of `plan-final.md` that
          // bypassed `writeTextFileIfUnchangedV1`. Unlike the two decision-
          // confirmation writers (`applyReviewerVerifiedTicksConfirmedV1`,
          // `applyReconciliationReviewVerifiedTicksV1`), `checklistMergeResult`
          // is reused by several routing decisions made earlier in this same
          // function (see the comment above), so this cannot simply re-read
          // and recompute the merge immediately before writing without
          // risking those earlier decisions disagreeing with what actually
          // gets written. `planChecklist` — the exact text the merge was
          // computed against — is passed as the expected content instead: a
          // concurrent writer or editor save that lands between that read and
          // this write is still detected and refused rather than silently
          // overwritten; only the earlier-computed routing messages remain
          // based on the read at the time they were built, same as before.
          const written = await writeTextFileIfUnchangedV1(planOfRecordUri, planChecklist, mergeResult.content);
          if (!written) {
            NotificationRouter.showWarning(
              "⚠️ plan-final.md changed while this round's checklist progress was being merged, so nothing was " +
                "written — its ticks were not lost, but this round's progress could not be recorded. Re-run " +
                "reconciliation once the concurrent change settles."
            );
          } else {
            effectivePlanChecklist = mergeResult.content;
            // Part 11 item 13c (event-driven half): an `applyReviewerVerifiedTicks`
            // card is only defensible while `deriveApplicableVerifiedTicksV1`
            // still finds unapplied reviewer-verified ticks against the
            // CURRENT plan-final.md (chatView.ts's render-time safety net
            // predicate). This round's own merge just changed plan-final.md's
            // tick state, so any such card for this task may already be
            // stale — withdraw here rather than waiting for the next render.
            await withdrawWorkflowDecisionsByKeyV1(
              { taskFolderPath: folderUri.fsPath, canonicalId: normalizePath(folderUri.fsPath) },
              "applyReviewerVerifiedTicks",
              "plan-final.md's checklist ticks changed this round, superseding the pending tick-application card"
            );
            // Retroactive ticks (RETROACTIVE_TICK_MARKER_V1) mark items this
            // round verified as already complete rather than built itself —
            // recorded in the run log, next to the rest of the round's
            // evidence, so the claim is auditable rather than indistinguishable
            // from an ordinary this-round tick.
            if (mergeResult.retroactiveTicks && mergeResult.retroactiveTicks.length > 0) {
              const existingLog = await readTextIfExists(logUri);
              if (existingLog !== undefined) {
                const retroSection =
                  "\n\n## Retroactive plan ticks\n\n" +
                  "Items ticked this round via a retroactive claim (verified complete from an " +
                  "earlier round, not built this round):\n\n" +
                  mergeResult.retroactiveTicks
                    .map((tick) => `- ${tick.itemText} — ${tick.evidence}`)
                    .join("\n");
                await writeTextFile(logUri, `${existingLog}${retroSection}\n`);
              }
            }
          }
        } else if (mergeResult.kind === "no-match") {
          // The round reported ticked items, but none matched any item in the
          // plan of record — a silent no-op here would be indistinguishable
          // from a round that genuinely made no progress. Surfaced rather than
          // swallowed so a corrupted or reworded echo is visible instead of
          // quietly stalling the plan.
          NotificationRouter.showWarning(
            "⚠️ The implementation round reported checklist progress that did not match any " +
              "item in the plan of record, so no boxes were ticked. Unmatched: " +
              mergeResult.unmatchedSample.map((text) => `"${text}"`).join(", ")
          );
        }
        // "unchanged" / "no-report" behave as the old undefined case did: no
        // write, no warning.
      }

      // Bounded automatic checklist reconciliation evidence-gathering
      // (workflow 8, item 2 / plan Part 4): a runner-synthesized round has no
      // echo to merge above — the sealed edit pipeline returns tool-call
      // receipts, not prose — so its checklist state is otherwise ALWAYS
      // "unrecorded" and latches checklistProgressUnreliable below, even when
      // an implementation review already on file verified the exact plan
      // items this round's edits complete. Gather that evidence once, from
      // hard evidence only (never from this round's own diff or intent — see
      // `runAutomaticChecklistReconciliationV1`'s doc comment) — but 2026-08-21
      // NINTH review round: NEVER write it. plan-final.md is untouched here;
      // the evidence is surfaced to the operator via
      // `postReconcilePlanChecklistDecisionV1` below, and only an explicit
      // selection there (`applyReconciliationReviewVerifiedTicksV1`) can turn
      // it into a tick. Never run for a model-authored round: those either
      // echo the checklist themselves (merged/no-match/unchanged above) or
      // are a rejected summary, a different failure class this part does not
      // touch.
      if (planChecklist !== undefined && result.summaryIsSynthetic) {
        automaticChecklistReconciliation = await runAutomaticChecklistReconciliationV1(
          folderUri,
          attributedFilesChanged,
          // Only the sealed pipeline ever sets this (see
          // ImplementationRunResult.appliedOperations's own doc comment); a
          // model-authored round never reaches this branch at all
          // (`result.summaryIsSynthetic` gates it), so this is never a stale
          // carry-over from a different round's shape.
          result.appliedOperations
        );
      }
    } else {
      // Stamped HERE, next to the write it replaces, rather than beside the
      // warning further down: a round can fail its type-check AND return a
      // malformed summary, and the type-check gate returns first. Stamping at
      // the warning meant that combination left no marker at all, so a later
      // manual Review or Fast Forward would evaluate an older summary — or the
      // plan, via the fallback — against a tree this round has since broken.
      //
      // Skipped when a stamp is already there. The warning tells the user to
      // rerun, so consecutive rejected rounds are the normal recovery path —
      // and re-stamping would back the FIRST stamp over impl-summary_prev.md,
      // destroying the last usable summary the stamp itself promises is
      // preserved. Nothing is lost by not rewriting: the marker is identical
      // in effect, and each round's full response is in its own run log.
      const existingSummary = await readTextIfExists(summaryUri);
      if (!existingSummary || !isUnusableImplementationSummaryV1(existingSummary)) {
        // The stamp states what happens next (continuation scheduled, or the
        // budget exhausted) so it is distinguishable from a plain "review
        // paused, waiting on user" state — see beginImplementationRecoveryV1.
        const recoveryLine = recovery
          ? recovery.capReached
            ? "Automated recovery has stopped: the continuation budget is exhausted, so the task needs a human decision."
            : `A continuation implementation round (${recovery.continuations} of ${MAX_INCOMPLETE_ROUND_CONTINUATIONS_V1}, ${recovery.mode}) has been scheduled to produce them.`
          : undefined;
        await writeTextFile(
          summaryUri,
          `${buildUnusableImplementationSummaryV1(summaryIssue, path.basename(logUri.fsPath), roundMayHaveChangedFiles, recoveryLine)}\n`
        );
      }
    }

    // Post-run: show changed files or warn if tracking was unavailable
    if (result.filesChangedUnknown) {
      NotificationRouter.showWarning(
        "⚠️ The AI implementation run completed, but the list of changed files " +
          "could not be determined (the workspace may not be a git repository). " +
          "Review your workspace manually to see what was changed."
      );
    } else if (result.filesChanged.length > 0) {
      NotificationRouter.showInformation(
        `Implementation complete. ${result.filesChanged.length} file(s) changed: ` +
          result.filesChanged.slice(0, 5).join(", ") +
          (result.filesChanged.length > 5 ? ` … and ${result.filesChanged.length - 5} more` : "")
      );
    }

    // Use patchTaskProgressStrictV1 to avoid overwriting unrelated fields.
    const persistedAfterRun = await patchTaskProgressStrictV1(folderUri, (currentProgress) => {
      const alreadyAtOrPastImplementation =
        currentProgress.currentStage === "impl" ||
        isReviewStage(currentProgress.currentStage);
      const stageBase = alreadyAtOrPastImplementation
        ? currentProgress
        : { ...currentProgress, currentStage: "impl" as TaskStage };
      // (2g) Record a failing post-round type-check so it surfaces even if
      // the user isn't watching this run's notifications; clear a
      // previously-recorded one once a later round's type-check passes (or
      // is skipped) again, so a stale failure never lingers past the round
      // that fixed it.
      const stageUpdated = result!.typeCheckFailed
        ? recordImplementationTypeCheckFailure(stageBase, {
            at: new Date().toISOString(),
            output: result!.typeCheckOutput ?? "",
          })
        : clearImplementationTypeCheckFailure(stageBase);

      // filesChangedUnknown means THIS run's own change detection failed.
      // Leave implReviewFiles untouched rather than clearing it. A completed
      // zero-change round (reachable only under
      // ensemble.resilience.nothingToFixRoutesToReview) likewise preserves
      // the prior round's list — the review scope must still cover the work
      // those earlier rounds actually landed.
      //
      // Live dogfooding failure (2026-08-06): this used to persist
      // result.filesChanged verbatim, so an implementation round that
      // regenerated this repo's own generated workflow-safety inventories —
      // a routine side effect of any source edit here, not the model doing
      // extra work — wrote those generated JSON paths into implReviewFiles.
      // The NEXT round's review then had its context pack built almost
      // entirely from an 8K-truncated fragment of a machine-written file
      // (once inflating the prompt past the chat-transaction size cap; once
      // leaving the review with nothing reviewable at all, pointed only at
      // "workflow-production-source-live-v1.json"). isMachineMaintainedArtifactPathV1
      // is the same generated-inventories/lockfiles/minified-bundle
      // classifier contextPack.ts already uses to exclude these paths'
      // CONTENTS from the pack; filtering them here stops them from ever
      // being recorded as review scope in the first place. If every changed
      // file was machine-maintained, treat it exactly like a zero-change
      // round — keep the prior list rather than persisting an empty one.
      //
      // ACCUMULATES across rounds (updateImplReviewFiles unions with the
      // existing list) rather than replacing. This write used to overwrite,
      // which was harmless while a task was one implementation round — but a
      // plan now legitimately spans many rounds, and replacing left the
      // final reviewer looking at only the LAST round's slice while being
      // asked to verify every plan step. Observed live 2026-08-07: after the
      // 25-step plan finished, impl-low-review could see 9 files, could not
      // source-verify ~20 of 25 items, and raised a review-confidence
      // blocker no implementation round could ever clear — three zero-change
      // rounds later the no-progress breaker escalated. The union helper
      // also applies the machine-maintained filter and keeps newest-first
      // ordering, so a context-pack budget trims the oldest (already
      // reviewed) files rather than the current round's work.
      // Any round that changed the tree without its checklist state being
      // recorded leaves the plan's counts permanently short — no later round
      // can tick items on its behalf. Two ways that happens, and both must
      // latch, not just the first:
      //   - runner-authored (the sealed pipeline returns receipts, not prose,
      //     so there is no echo to merge);
      //   - a rejected summary, where the merge is skipped entirely because
      //     the response never passed validation.
      // A merge that ran and ticked nothing is NOT this case: an echo that
      // reports no completions is an accurate record of a round that finished
      // no items, and flagging it would disable the gate on healthy tasks.
      // "Might have changed the tree", not "provably did": when change
      // tracking is unavailable (no git repo) filesChangedUnknown is true and
      // the paths cannot be enumerated, but a CLI round may well have edited
      // files. Requiring an enumerated change set left the latch unset purely
      // because we could not list what moved, so a later valid round made the
      // permanently under-counting checklist authoritative again — with no
      // warning and no reconciliation action offered. Only a round KNOWN to
      // have changed nothing is exempt.
      const roundMayHaveChangedFiles =
        result!.filesChangedUnknown === true || result!.filesChanged.length > 0;
      // Third way the plan's counts fall permanently short (Part 3,
      // 2026-08-14): a round that DID claim checklist progress — a
      // retroactive-tick claim, or an echoed tick — but whose claim matched
      // no item in the plan of record (`checklistClaimedButUnmerged`, merge
      // kind "no-match"). Unlike "unchanged"/"no-report" above, this is not
      // an accurate record of a round that finished nothing: the round
      // BELIEVES it recorded progress, so a later round has no reason to
      // revisit the same claim, and the plan's counts stay short exactly the
      // same way an unrecorded runner-authored round's would. Independent of
      // `roundMayHaveChangedFiles` — a verification-only round that changed
      // no files is precisely the shape this was observed in (round 013,
      // task "1.9").
      // A synthetic round ALWAYS latches the "unrecorded" half (2026-08-21
      // NINTH review round — see `computeSyntheticRoundChecklistLatchV1`'s
      // own doc comment): the automatic reconciliation pass above gathers
      // evidence for a human to act on, but it never exempts the round
      // itself, regardless of what it found (plan Part 4: "never
      // auto-exempt"). Only an explicit human attestation
      // (`reconcilePlanChecklistConfirmedV1`) clears this latch.
      const checklistStateUnrecorded = computeSyntheticRoundChecklistLatchV1({
        planChecklistPresent: planChecklist !== undefined,
        roundMayHaveChangedFiles,
        summaryIsSynthetic: result!.summaryIsSynthetic === true,
        summaryIssuePresent: summaryIssue !== undefined,
        checklistClaimedButUnmerged,
      });
      // updatedAt is bumped with the latch. patchTaskProgressStrictV1 does not
      // set it (only creation does), and the updateImplReviewFiles branch below
      // — which would have — is skipped when the change set is unknown. Without
      // the bump, reconcilePlanChecklist's race check cannot see the very round
      // that warranted the latch, and would clear it.
      const stageRecorded = checklistStateUnrecorded
        ? {
            ...stageUpdated,
            checklistProgressUnreliable: true,
            updatedAt: new Date().toISOString(),
          }
        : stageUpdated;

      // A successful round (usable summary, or the sealed runner's synthetic
      // one) promotes any quarantined incomplete-round delta into review
      // scope — unioned with this round's own changed files below — and
      // clears the pending set plus the continuation counter. A REJECTED
      // round (summaryIssue) does neither: promotion requires a round that
      // actually reported, so the quarantine survives until one does — and
      // its OWN delta stays quarantined too. The recovery transition put the
      // round's snapshot delta into pendingImplReviewFiles before the run log
      // was written; banking the attributed subset here as well would mark
      // unreported edits as reviewed scope while the same paths sit in
      // quarantine awaiting a usable report (review blocker, 2026-08-14).
      const promotedBase =
        summaryIssue === undefined
          ? promotePendingImplReviewFiles(stageRecorded)
          : stageRecorded;

      // Only the round's ATTRIBUTED delta is banked (finding 2) — never the
      // raw snapshot diff, which absorbs concurrent hand edits. When change
      // tracking was unavailable (filesChangedUnknown) nothing is banked at
      // all: a full dirty scan of the workspace is scope, not attribution.
      if (
        summaryIssue === undefined &&
        !result!.filesChangedUnknown &&
        attributedFilesChanged.length > 0
      ) {
        return updateImplReviewFiles(promotedBase, attributedFilesChanged);
      }
      return promotedBase;
    });

    // PART 6.5 (review-flagged 2026-08-23): `promotePendingImplReviewFiles`
    // above clears `implRecovery` unconditionally whenever this round
    // produced a usable summary (`summaryIssue === undefined`), and otherwise
    // leaves it untouched — either way `persistedAfterRun.implRecovery` (once
    // the CAS above has actually resolved) is the ground truth. Push it into
    // the scheduling-intent ledger right after the CAS resolves, never from
    // inside the callback, which may re-run on a retry.
    await syncOwedContinuationLedgerBestEffortV1(
      folderUri.fsPath,
      owedContinuationSourceV1(persistedAfterRun?.implRecovery, persistedAfterRun?.pendingImplReviewFiles ?? [])
    );

    // Part 11 item 13c (event-driven half): a "Keep this round's changes" /
    // "Revert this round's changes" card is only defensible while
    // `implRecovery` is still set AND `pendingImplReviewFiles` is non-empty
    // (the same condition chatView.ts's render-time safety net re-derives).
    // `promotePendingImplReviewFiles` above just cleared both the instant a
    // usable summary landed — withdraw the stale card here rather than
    // leaving `hasPendingDecision` true until the chat panel next renders.
    if (
      persistedAfterRun !== undefined &&
      (persistedAfterRun.implRecovery === undefined ||
        (persistedAfterRun.pendingImplReviewFiles ?? []).length === 0)
    ) {
      await withdrawWorkflowDecisionsByKeyV1(
        { taskFolderPath: folderUri.fsPath, canonicalId: normalizePath(folderUri.fsPath) },
        "restoreRejectedImplementationRound",
        "the round's quarantined changes have already been resolved (reviewed, continued, or restored)"
      );
    }

    // Visibility for the excluded remainder (finding 2's acceptance
    // criterion): paths that changed in the workspace during the round
    // without the round claiming them are recorded in the run file rather
    // than silently adopted — or silently dropped.
    if (unattributedFilesChanged.length > 0) {
      const existingLog = await readTextIfExists(logUri);
      if (existingLog !== undefined) {
        const unattributedSection =
          "\n\n## Unattributed workspace changes\n\n" +
          "These paths changed in the workspace during this round but are not in the " +
          "round's own `## Files Changed` report, so they were EXCLUDED from review scope " +
          "(they are most likely edits made by hand in the same workspace while the round ran):\n\n" +
          unattributedFilesChanged.map((file) => `- ${file}`).join("\n");
        // skipBackup: this append preserves every byte of the just-written
        // log, and a `_prev` sibling in runs/ would read as a second run.
        await writeTextFile(logUri, `${existingLog}${unattributedSection}\n`, {
          skipBackup: true,
        });
      }
    }

    // Review finding (2026-08-16): three production rounds (074, 077, 079)
    // presented inputs that deterministically return `mergeChecklistProgressV1`
    // kind "no-match" under a replay of the current build, yet the durable
    // record shows no `checklistProgressUnreliable` latch and no
    // reconciliation note for any of them — while the code path itself is
    // pinned correct by tests and by direct trace. The leading unverified
    // hypothesis is a stale extension-host bundle (rounds ran against a build
    // predating this latch). Rather than re-assert "not a live defect" from
    // inference, this line is written UNCONDITIONALLY for every round that has
    // a plan checklist, so the merge kind actually computed and the latch
    // decision actually persisted are both in the run record — the next
    // occurrence (if there is one) is self-diagnosing from the run log alone
    // instead of requiring a hand replay of durable inputs against the source.
    if (planChecklist !== undefined) {
      const existingLog = await readTextIfExists(logUri);
      if (existingLog !== undefined) {
        const diagnosticsNote = buildChecklistMergeDiagnosticsNoteV1({
          mergeKind: checklistMergeResult?.kind ?? "no-report",
          // Distinguishes "no-report" (no echo at all) from "no-match" (an
          // echo was produced but matched no plan item text) beyond the kind
          // string alone — the sample of what did not match is what actually
          // lets a reader tell a corrupted/reworded echo from a round that
          // said nothing (plan Part 4, item 2).
          unmatchedSample:
            checklistMergeResult?.kind === "no-match" ? checklistMergeResult.unmatchedSample : undefined,
          latchSet: persistedAfterRun?.checklistProgressUnreliable === true,
          // The automatic reconciliation pass (only ever run for a synthetic
          // round — see the call site) is recorded here too, marked
          // evidence-derived, so a reader can tell "no echo, and nothing
          // reconciled it" from "no echo, but review evidence already covered
          // it" without re-deriving either from the round's raw files.
          automaticChecklistReconciliation,
        });
        // skipBackup: appends to the just-written log; a `_prev` sibling in
        // runs/ would read as a second run.
        await writeTextFile(logUri, `${existingLog}${diagnosticsNote}\n`, {
          skipBackup: true,
        });
      }
    }

    // Finding 3: while `checklistProgressUnreliable` is set the loop keeps
    // running (the completeness gate above stands itself down whenever
    // `priorProgress.checklistProgressUnreliable` is set — see
    // `remainingChecklistProgress`'s latch check — and every OTHER
    // completeness check in this file stands down the same way via
    // `readPlanChecklistProgressV1`/`readEffectivePlanChecklistProgressV1`),
    // but never silently — every round that
    // completes under the latch records the condition in its own run file and
    // re-surfaces the ONE action that can clear it. Nothing reconciles
    // automatically: no round knows what the unrecorded round did, so the
    // repair is deliberately a human confirmation (reconcilePlanChecklist).
    // Without this, the only standing trace was the task tooltip — invisible
    // while rounds appear to be progressing normally.
    if (persistedAfterRun?.checklistProgressUnreliable) {
      // Reads the checklist text AS IT STANDS after this round's own
      // merge-write (if any) — never the round-stale `planChecklist` — so a
      // round that both landed a merge AND still completes under an
      // already-set latch names what is truly outstanding right now.
      const outstandingList = describeOutstandingChecklistItemsV1(effectivePlanChecklist);
      const existingLog = await readTextIfExists(logUri);
      if (existingLog !== undefined) {
        const reconcileNote =
          "\n\n## Checklist reconciliation needed\n\n" +
          "This task's plan checklist is not a complete record (checklistProgressUnreliable): a round " +
          "landed changes its checklist state could not record, so the plan's step counts are unverified " +
          `and completeness is not gating advancement. ${checklistReconcileGuidanceSentenceV1(outstandingList)}` +
          outstandingList;
        // skipBackup: appends to the just-written log; a `_prev` sibling in
        // runs/ would read as a second run.
        await writeTextFile(logUri, `${existingLog}${reconcileNote}\n`, {
          skipBackup: true,
        });
      }
      // Posts the same explained WorkflowDecisionV1 (case 4) the command
      // posts, called directly for the same reason as the sibling call site
      // above. `post`'s supersede-on-repost means re-posting every round the
      // latch stays set replaces the prior pending decision rather than
      // accumulating duplicates, matching the prior behavior of re-showing
      // the notification every such round.
      const pendingOperationEvidenceForDecision =
        automaticChecklistReconciliation?.kind === "candidatesFound"
          ? automaticChecklistReconciliation.pendingOperationEvidenceItems
          : undefined;
      const reconcilePosted = persistedAfterRun
        ? await postReconcilePlanChecklistDecisionV1(
            folderUri,
            folderUri.fsPath,
            folderUri.fsPath,
            persistedAfterRun,
            checklistMergeResult,
            pendingOperationEvidenceForDecision
          )
        : { kind: "noContext" as const };
      if (reconcilePosted.kind !== "posted") {
        NotificationRouter.showWarning(
          "⚠️ The plan checklist is not a complete record for this task — its step counts are unverified " +
            "until reconciled, and completeness is not gating advancement. " +
            `${checklistReconcileGuidanceSentenceV1(outstandingList)}${outstandingList}`,
          undefined,
          undefined,
          undefined,
          {
            command: "vs-code-ai-helper.reconcilePlanChecklist",
            title: "Mark Plan Checklist Reconciled",
            args: [{ taskFolderPath: folderUri.fsPath }],
          }
        );
      }
    }

    // Any existing review artifact describes the tree as it was BEFORE this
    // round's edits, so it is stale the moment those edits land — regardless
    // of whether this run goes on to dispatch a review. Both gates below
    // return early, and leaving a pre-edit review looking current is exactly
    // how a later manual Review or stage advance ends up scoring evidence
    // that no longer matches the workspace. Staling first makes the early
    // returns safe; isUnusableAsExistingReview then refuses the placeholder.
    if (isReviewStage(postRunReviewStage)) {
      const reviewUri = artifactUri(folderUri, postRunReviewStage);
      if (reviewUri) {
        await markReviewArtifactStale(reviewUri, "workspace files");
        // Ordering invariant for the incomplete-round marker: the stale stamp
        // just written IS the replacement review-tracking state ("a fresh
        // review is required" is now durable on the artifact itself), so the
        // `reviewInvalidatedByRound` marker may be cleared only NOW — never
        // before. Every persisted state therefore has either the marker set
        // or review-tracking state already showing a fresh review is needed.
        await patchTaskProgressStrictV1(folderUri, (current) =>
          current.reviewInvalidatedByRound?.stage === postRunReviewStage
            ? clearReviewInvalidatedByRound(current)
            : current
        );
      }
    }

    // (2g) A round that leaves the tree non-compiling must never be handed
    // to a reviewer as if it were reviewable. The edits and the failure are
    // already durably recorded above (implReviewFiles +
    // implementationTypeCheckFailure), so a human can inspect and fix the
    // build, or the next implementation round can retry — but auto-advance
    // and any review dispatch below must not run against a broken build.
    if (result.typeCheckFailed) {
      NotificationRouter.showWarning(
        "⚠️ Implementation finished, but the project no longer type-checks. " +
          (roundMayHaveChangedFiles
            ? "The round's edits were kept and recorded for review, but automated review has been "
            : "This round changed no files, so there is nothing new recorded for review, but automated review has been ") +
          "paused until the build is fixed — see the implementation run log for the type-check output."
      );
      // A round can fail its type-check AND return a rejected summary, and
      // this gate returns first. The rejected summary's recovery transition
      // still owes its dispatch — without it the stamp written above claims a
      // continuation "has been scheduled" while the durable record sits
      // `pending` under a live lease, unscheduled until the lease expires
      // (review blocker, 2026-08-14). The continuation is an IMPLEMENTATION
      // round, so scheduling it is compatible with this gate's contract:
      // review stays paused; the next round inherits (and can fix) the
      // broken build.
      if (recovery) {
        await recovery.finishDispatch();
      }
      await safeOpenTextDocument(logUri, "implementation run log");
      return false;
    }

    // Same contract as the type-check gate directly above, and placed after
    // the same durable recording for the same reason: a round whose final
    // response does not follow the mandated summary shape has still edited the
    // tree, so its files must be recorded — but it must not be handed onward
    // as a reviewable round. {{implementation}} would otherwise carry whatever
    // the provider happened to say last, and a reviewer cannot tell a status
    // message from implementation notes. The full response is already durably
    // captured in the run log, so nothing is lost by declining to promote it.
    if (summaryIssue) {
      // The rejection stamp was already written above, before the type-check
      // gate, so every review entry point refuses this round regardless of
      // which gate returns first. EVERY rejected summary — zero-change
      // included — began the recovery transition before the run log was
      // written, so `recovery` is always set here; finishDispatch schedules
      // the continuation (or escalates at the cap) instead of parking the
      // task at "active" with nothing scheduled, which is exactly how round
      // 010 of "workflow 2" stranded its task.
      if (recovery) {
        await recovery.finishDispatch();
      }
      await safeOpenTextDocument(logUri, "implementation run log");
      return false;
    }

    await safeOpenTextDocument(summaryUri, IMPLEMENTATION_SUMMARY_FILENAME);

    // Auto-advance: a completed implementation proceeds to High-Level Code
    // Review when auto-advance is enabled, and (via AUTO_REVIEW_TRANSITIONS)
    // starts that review. Runs before the legacy auto-review-in-place setting
    // below; when it fires, the legacy path is skipped to avoid a duplicate.
    let autoAdvancedToHighReview = false;
    // Deferred, never inline: both follow-up shapes (a single review pass, or
    // the "auto-fast-forward" review + fixes loop) are commands that acquire
    // the task's exclusive lock themselves, so while this run's parent
    // operation still holds that lock the chain scheduler defers the dispatch
    // until the root operation ends successfully. Both share the
    // "auto-review" chainId so they can never duplicate each other.
    const dispatchReviewChainAfterLockRelease = (
      command: string,
      stillEnabled: () => boolean,
      intent: SchedulingIntentMetadataV1
    ): void => {
      void scheduleAutomationChain(
        {
          command,
          arg: { taskFolderPath: folderUri.fsPath },
          taskKey: folderUri.fsPath,
          chainId: "auto-review",
          // Re-checked immediately before dispatch: the root operation can
          // hold the lock for minutes, and the user may turn the automation
          // off in the meantime — the queued chain must then drop.
          stillEnabled,
          intent,
        },
        options.parentOperation
      );
    };
    // Chained "auto-fast-forward" marker re-validated at fire time against
    // the setting that minted it (see chainedFollowUpReviewMode).
    const fireTimeFollowUpMode = (): "auto-fast-forward" | undefined =>
      options.followUpReviewMode === "auto-fast-forward" &&
      getCompleteAndMoveOnTriggersAIMode() === "auto-fast-forward"
        ? options.followUpReviewMode
        : undefined;
    if (isAutoAdvanceEnabled()) {
      try {
        const freshProgress = await readTaskProgressAdvisoryV1(folderUri);
        if (freshProgress?.currentStage === "impl" && freshProgress.status !== "paused") {
          const transition = await advanceStageViaNextStageRowV1(
            folderUri,
            freshProgress,
            freshProgress.status,
            "impl",
            "impl-high-review",
            false,
            true
          );
          if (transition?.persisted) {
            autoAdvancedToHighReview = true;
            NotificationRouter.showInformation(
              `Implementation complete. Advanced to ${STAGE_DISPLAY_NAMES["impl-high-review"]}.`
            );
            if (transition.shouldAutoReview) {
              dispatchReviewChainAfterLockRelease(
                strongestAutoTriggerMode(
                  getAutoAdvanceMode(),
                  options.followUpReviewMode
                ) === "auto-fast-forward"
                  ? "vs-code-ai-helper.fastForwardReviewWithAI"
                  : "vs-code-ai-helper.runReviewWithAI",
                () =>
                  strongestAutoTriggerMode(getAutoAdvanceMode(), fireTimeFollowUpMode()) !== "off",
                {
                  trigger: "auto-advance review after implementation completes",
                  settingKey: "ensemble.autoAdvanceEnabled",
                  expectedTiming: "once this round's operation lock releases",
                  willRetry: false,
                  retryNote: "Not retried automatically if dropped — run the review manually.",
                }
              );
            }
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        NotificationRouter.showWarning(
          `Implementation completed, but auto-advancing to review failed: ${message}. Advance the stage manually.`
        );
      }
    }

    // Optional: a completed implementation starts its review when enabled in
    // Settings, or when this run carries a chained fast-forward request from
    // "Complete & Move On triggers AI: auto-fast-forward" — the chained
    // request must fire even with the standalone setting off, and must never
    // be downgraded to a single review pass by a weaker standalone setting.
    if (!autoAdvancedToHighReview && !options.suppressAutoReviewDispatch) {
      const reviewMode = strongestAutoTriggerMode(
        getAutoReviewAfterImplementationMode(),
        options.followUpReviewMode
      );
      if (reviewMode !== "off") {
        dispatchReviewChainAfterLockRelease(
          reviewMode === "auto-fast-forward"
            ? "vs-code-ai-helper.fastForwardReviewWithAI"
            : "vs-code-ai-helper.runReviewWithAI",
          () =>
            strongestAutoTriggerMode(
              getAutoReviewAfterImplementationMode(),
              fireTimeFollowUpMode()
            ) !== "off",
          {
            trigger: "auto-review after implementation completes",
            settingKey: "ensemble.autoReviewAfterImplementation",
            expectedTiming: "once this round's operation lock releases",
            willRetry: false,
            retryNote: "Not retried automatically if dropped — run the review manually.",
          }
        );
      }
    }
    return true;
  } else if (result.status === "cancelled") {
    NotificationRouter.showInformation("Implementation cancelled.");
    // wf10 item 4 / Part 4: a cancelled round reaches completion accounting
    // (it is not a runner-level failure) and must be recorded as such rather
    // than left indistinguishable from an unreported round. `logUri` was
    // written unconditionally above (line ~7125) before this branch, so the
    // run log's `Status:` line reads `cancelled` with no distinguishing
    // classification unless this note is appended too — same idiom as every
    // other outcome branch in this function.
    await terminalizeRoundV1(
      implRoundId,
      "cancelled",
      result.filesChangedUnknown ? { filesChangedUnknown: true } : { filesChanged: [...result.filesChanged] },
      {
        taskFolderUri: folderUri,
        ...(implExtraAttemptIds.length ? { extraAttemptIds: implExtraAttemptIds } : {}),
        roundOutcomeClassification: {
          classification: "cancelled",
          attemptId: implRoundId,
          dispatchMode: currentDispatchMode,
        },
      }
    );
    await appendRoundOutcomeLogNoteV1(logUri, "cancelled");
    return false;
  } else {
    // Part 7: an externally-terminated round (wall-clock/inactivity
    // watchdog) owes the SAME recovery continuation as a detected
    // incomplete round — `recovery` was begun above, before the run log
    // write, so its quarantine/counter/`implRecovery` record are already
    // durable. finishDispatch() (notify + schedule-or-escalate) runs AFTER
    // the run log write, same ordering as every other recovery call site.
    if (result.timedOut === true && recovery) {
      await recovery.finishDispatch();
    } else {
      NotificationRouter.showError(
        `Implementation failed: ${result.errorMessage ?? "unknown error"}`
      );
    }
    return false;
  }
}

/**
 * Run the implementation: use AI with tool-calling to make actual code changes.
 *
 * Reads from `plan-final.md` (the canonical implementation-stage artifact).
 * Uses the `implementation` stage model for execution.
 * No overwrite confirmation shown.
 *
 * Requires first-use consent before any AI action runs.
 */
export async function runImplementationWithAI(
  extensionUri: vscode.Uri,
  context: vscode.ExtensionContext,
  arg?: ReviewCommandArg,
  chatViewProvider?: ChatViewProvider
): Promise<void> {
  // Post-§7.8 route gate: "implementation.v1" is MIGRATED (Copilot-resolved
  // models run the sealed two-phase pipeline via runSealedImplementationV1;
  // CLI-resolved models run their own direct edit-mode invocation — see
  // runImplementationOrSealedV1), so this assertion passes and exists to
  // fail closed if the key is ever re-gated.
  assertLegacyAiRouteAllowedV0("implementation.v1");
  // §7.5's task/model-INDEPENDENT provider-path check (AC-HOST-03): first
  // real check, before consent, task resolution, or ANY task/source read —
  // still before any task/source read (Implementation always resolves
  // against the impl stage's model — see checkEditActionProviderPathGateV1's
  // header). It subsumes the host/LM-tool-API floor for a Copilot-resolved
  // model and skips it entirely for a CLI-resolved one. The exact per-task/
  // stage capability (workspace root included) is revalidated by
  // checkEditActionAvailabilityV1 below, once resolveTask makes it known.
  const providerPathGate = await checkEditActionProviderPathGateV1("impl");
  if (!providerPathGate.ok) {
    NotificationRouter.showWarning(providerPathGate.reason);
    return;
  }
  // ── Workspace guard ───────────────────────────────────────────────────────
  if ((vscode.workspace.workspaceFolders ?? []).length === 0) {
    NotificationRouter.showError(
      "No workspace folder open. Please open a folder first."
    );
    return;
  }

  // ── Consent gate ─────────────────────────────────────────────────────────
  const consented = await ensureAiConsent(context);
  if (!consented) {
    return;
  }

  // Keyboard and coordinator callers target a specific path. Normalize it
  // before resolving so an action for the current task can never fall back to
  // a QuickPick containing another eligible implementation task.
  if (isMalformedReviewArg(arg as ReviewCommandArg | Record<string, unknown>)) {
    NotificationRouter.showError(
      "Run Implementation: unsupported argument shape. " +
        "Use { taskFolderPath } to target a specific task, or invoke without an argument to pick from a list."
    );
    return;
  }

  const resolved = await resolveTask(
    normalizeReviewArg(arg),
    IMPLEMENTATION_ELIGIBLE_STAGES,
    "Run Implementation with AI",
    context
  );
  if (!resolved) {
    return;
  }
  if (resolved.progress.status === "paused") {
    NotificationRouter.showInformation("This task is paused. Resume it before running implementation.");
    return;
  }

  // Chained fast-forward request from "Complete & Move On triggers AI:
  // auto-fast-forward" — the post-run follow-up review must run as the Fast
  // Forward loop even when the standalone review settings are off.
  const followUpReviewMode = chainedFollowUpReviewMode(arg);

  // ── §7.5 full availability gate, BEFORE any artifact read ────────────────
  // The remaining (task/model-dependent) halves of the gate run as soon as
  // the owning workspace and stage model are knowable — ahead of
  // materializeCanonicalIfNeeded, plan-final reads, checklist generation,
  // and context-pack collection below.
  const workspaceRoot = resolveOwnerWorkspace(resolved.progress);
  if (!workspaceRoot) {
    NotificationRouter.showError(
      "Could not determine the owning workspace for this task. Please open the workspace that created it."
    );
    return;
  }
  const model = await resolveFreshModelForStage(resolved.folderUri, "impl");
  const editAvailability = await checkEditActionAvailabilityV1({
    workspaceFsPath: workspaceRoot.uri.fsPath,
    stageModelId: model.modelId,
    stage: "impl",
  });
  if (!editAvailability.ok) {
    NotificationRouter.showWarning(editAvailability.reason);
    return;
  }

  const lockKey = resolved.folderUri.fsPath;
  // Set by the automation-redirect branch below (review blocker, 2026-08-26:
  // "the automatic Apply Review redirect cannot safely execute from inside
  // the live Implementation root operation"). `goToReviewAndApplyV1` moves
  // the task's stage, which calls `cancelRunningOperationsForTask` and then
  // POLLS for this task's live operations to reach zero — but this very
  // "Run Implementation" operation is one of them, and it cannot reach zero
  // until the `runTrackedOperation` callback below returns. Calling it from
  // inside the callback was a guaranteed self-wait (observed: the redirect
  // announces itself, then blocks ~15s, then `goToReviewAndApplyV1` gives up
  // and the redirect never dispatches). The fix: the callback only RECORDS
  // the redirect and returns (ending the operation normally), and the actual
  // redirect runs here, after `runTrackedOperation` has resolved and the
  // operation has genuinely ended.
  let redirectAfterOperationV1: { reviewStage: TaskStage; reason: string } | undefined;
  await runTrackedOperation(
    lockKey,
    { label: "Run Implementation", stage: "impl", taskName: resolved.progress.displayName, kind: "run-implementation", cancellable: true },
    async (op) => {
    // Materialize canonical plan-final.md from legacy implementation.md if needed
    let canonicalUri: vscode.Uri;
    try {
      canonicalUri = await materializeCanonicalIfNeeded(resolved.folderUri);
    } catch (error) {
      NotificationRouter.showError(
        error instanceof Error ? error.message : String(error)
      );
      return;
    }

    let planFinalContent = await readNonEmptyText(canonicalUri);
    if (!planFinalContent) {
      NotificationRouter.showWarning(
        stageActionRequirementMessageV1("runImplementation", 0)
      );
      return;
    }

    // Merged checklist behavior: on a task's first implementation run, if
    // the implementation checklist hasn't been generated yet (no marker in
    // plan-final.md), generate it first and then implement. Re-runs (which
    // have implReviewFiles from an earlier run, and whose plan-final.md may
    // hold a post-run summary) never regenerate.
    const needsChecklist =
      !hasImplementationChecklistV1(planFinalContent) &&
      resolved.progress.currentStage === "impl" &&
      (resolved.progress.implReviewFiles?.length ?? 0) === 0;
    if (needsChecklist) {
      const checklistWorkspace = resolveOwnerWorkspace(resolved.progress);
      if (!checklistWorkspace) {
        NotificationRouter.showError(
          "Could not determine the owning workspace for this task. Please open the workspace that created it."
        );
        return;
      }
      const checklistContextPack = await generateContextPack(
        resolved.folderUri,
        checklistWorkspace.uri
      );
      const checklistPrompt = await renderPromptTemplate(
        extensionUri,
        "create-implementation.md",
        { contextPack: checklistContextPack, plan: planFinalContent }
      );
      const checklistModel = await resolveFreshModelForStage(resolved.folderUri, "impl");
      if (!checklistModel.modelId) {
        NotificationRouter.showWarning(
          "No model is configured for impl. Open Ensemble Settings and choose a primary model before continuing.",
          undefined,
          undefined,
          undefined,
          { command: "vs-code-ai-helper.openSettings", title: "Open Settings" }
        );
        return;
      }
      const { availability: checklistAvailability, providerLabel: checklistProviderLabel } =
        await checkImplementationAvailabilityForModel(checklistModel.modelId, "impl");
      if (!checklistAvailability.available) {
        NotificationRouter.showWarning(
          `${checklistProviderLabel} is unavailable: ${checklistAvailability.reason ?? "unknown reason"}. Implement the plan manually instead.`
        );
        return;
      }
      const checklistSizeCheck = await checkAndConfirmPromptSize(checklistPrompt, checklistProviderLabel);
      if (checklistSizeCheck === "abort" || checklistSizeCheck === "declined") {
        return;
      }
      // Narrowed to a plain string outside the closure below: TS does not
      // carry the `checklistModel.modelId` truthiness check across into a
      // nested async arrow function, since the property could theoretically
      // change between the check and the (later) closure body.
      const checklistModelId: string = checklistModel.modelId;

      // Post-§7.8, "generateImplementation.v1" is MIGRATED: route through the
      // same coordinator invocation the standalone "Generate Implementation"
      // command uses (invokeGenerateImplementationActionV1) rather than the
      // legacy uncorrelated runAiToFile/outputFile path, which the shared
      // runner/provider boundary now rejects unconditionally.
      const generated = await runTrackedOperation(
        resolved.folderUri.fsPath,
        { parent: op, label: "Generating implementation checklist", stage: "impl", kind: "generate-implementation" },
        async (checklistOp) => {
          const { outcome, orchestrator } = await invokeGenerateImplementationActionV1({
            folderUri: resolved.folderUri,
            workspaceUri: checklistWorkspace.uri,
            progress: resolved.progress,
            prompt: checklistPrompt,
            targetUri: canonicalUri,
            modelId: checklistModelId,
            cancellationToken: checklistOp.token ?? new vscode.CancellationTokenSource().token,
          });
          const handleRes = await handleGenerateImplementationOutcomeV1(outcome, {
            folderUri: resolved.folderUri,
            implementationUri: canonicalUri,
            chatViewProvider,
            orchestrator,
            prompt: checklistPrompt,
            canonicalId: resolved.folderUri.fsPath,
            taskName: resolved.progress.displayName,
            suppressCompletionUiV1: true,
          });
          return handleRes.succeeded;
        }
      );
      if (!generated) {
        // Generation failed, returned questions (routed to Chat — see
        // handleGenerateImplementationOutcomeV1), or was cancelled;
        // implementing straight from the raw promoted plan would silently
        // skip the checklist step.
        return;
      }
      planFinalContent = (await readNonEmptyText(canonicalUri)) ?? planFinalContent;
    }

    // The implementation model + owning workspace were resolved (and the
    // §7.5 gate passed) before this tracked operation began; this is only
    // the provider-liveness check, which can change while the checklist
    // generation above runs.
    const { availability, providerLabel } =
      await checkImplementationAvailabilityForModel(model.modelId, "impl");
    if (!availability.available) {
      NotificationRouter.showWarning(
        `${providerLabel} is unavailable: ${availability.reason ?? "unknown reason"}. Implement the plan manually instead.`
      );
      return;
    }
    op.setModel?.(model.modelId);

    // The routing check on the path users actually take. The tree view's
    // Implementation button invokes THIS command directly — only the
    // Ctrl+Shift+Alt+I shortcut goes through applyCurrentStageAction — so a
    // check that lived only there would never fire for most runs.
    //
    // Asked, not auto-substituted: the user explicitly chose Implementation
    // here, unlike the generic stage action, and silently running a different
    // command on an explicit request is its own kind of opaque. Non-modal so
    // it cannot block an unattended chain; defaulting to proceeding keeps
    // every existing automated caller behaving exactly as before.
    const preRunDecision = decidePostReviewActionV1({
      history: resolved.progress.reviewScoreHistory,
      stages: IMPL_REVIEW_STAGES_V1,
      hasUntickedChecklistItems:
        ((await readPlanOfRecordV1(resolved.folderUri)).counts?.remaining ?? 0) > 0,
      continuationOwed: resolved.progress.implRecovery !== undefined,
      pendingImplReviewFilesCount: resolved.progress.pendingImplReviewFiles?.length ?? 0,
    });
    // Advisory only — never gates this run. The pre-migration dialog already
    // defaulted to proceeding whenever it was not answered with "Go to
    // Review & Apply" (comment above: "defaulting to proceeding keeps every
    // existing automated caller behaving exactly as before"); replacing an
    // awaited blocking notification with an asynchronously-resolved decision
    // record must not turn that default-proceed behavior into a default-stop
    // one — the record is posted so the choice is visible and actionable in
    // Chat, and this round runs immediately after, exactly as an unanswered
    // dialog used to fall through. Automation dispatches skip the post
    // entirely: no human is there to act on it.
    if (
      (preRunDecision.action === "apply-review" || preRunDecision.action === "both") &&
      !isAutomationDispatchV1(arg)
    ) {
      // One sentence of what is wrong, one of what to do. Explaining the
      // mechanism accurately while leaving the user with no idea which button
      // to press is the same "big red button" problem this routing exists to
      // remove, just moved into the message.
      //
      // The button moves the stage FIRST. Apply Review is a review-stage
      // action: `applyLowLevelReviewChanges` refuses unless the task is at a
      // *-low-review stage, and `applyReviewEditWithAI` resolves against
      // IMPL_REVIEW_STAGES, which excludes `impl`. Dispatching it straight
      // from here therefore did nothing but warn "Task is not at a Low-Level
      // Review stage" — offering an action that could not run, from the one
      // stage it could not run at. `kind: "jump"` matches a manual stage
      // change and deliberately does not auto-trigger a fresh review.
      const targetReviewStage: TaskStage =
        preRunDecision.reviewStage === "impl-high-review"
          ? "impl-high-review"
          : "impl-low-review";
      // Migrated off `vscode.window.showWarningMessage` (task "Actionable
      // Hand-offs", "The worse case", fix part 2): the raw notification
      // blocked awaiting an answer inside this tracked operation, which is
      // why an automation dispatch needed its own bypass marker above to
      // avoid hanging forever on a question nobody was there to answer. A
      // `WorkflowDecisionV1` is posted and resolved asynchronously — this
      // function does not await it, so the operation's lock is never held on
      // a human answer.
      const target: ChatTarget = {
        canonicalId: resolved.folderUri.fsPath,
        taskFolderPath: resolved.folderUri.fsPath,
        stage: resolved.progress.currentStage,
        taskName: resolved.progress.displayName,
      };
      // wf10 item 6 (2026-08-24): `preRunDecision.action === "both"` means a
      // task-fixable blocker AND unticked checklist items coexist
      // (decidePostReviewActionV1's doc comment) — Implementation genuinely
      // can still land real, queued checklist work in that case, so the
      // "will most likely change nothing" claim below is only true when the
      // checklist is ALSO complete (`action === "apply-review"`). Observed
      // 2026-08-21: a task with 1 task-fixable blocker and 77 unticked
      // checklist items was told here that Implementation would most likely
      // change nothing; the newest review's own progress marker showed 76 of
      // those steps still queued and actionable, and the user correctly
      // overrode the recommendation.
      const bothValid = preRunDecision.action === "both";
      const whatHappenedSuffix = bothValid
        ? " Implementation is running now anyway — it can still make progress on the unticked checklist " +
          "items, but will not fix the problems the review found."
        : " Implementation is running now anyway — it will most likely change nothing.";
      const whyUserNeeded = bothValid
        ? "Both actions are valid here: Implementation can still land real, queued checklist work, but only " +
          "Apply Review can fix what the newest review found — this lets you choose which to prioritize " +
          "instead of assuming one makes the other pointless."
        : "Implementation only reads the plan checklist, so it cannot fix what the newest review still " +
          "reports — this offers a shortcut to the review stage instead of leaving you to notice, after " +
          "the round finishes having changed nothing, that Apply Review was the action you needed.";
      const letItRunConsequence = bothValid
        ? "Does nothing further. Implementation keeps running as already started, and can still make " +
          "progress on the unticked checklist items — it just will not fix the problems the newest review found."
        : "Does nothing further. Implementation keeps running as already started, and will most " +
          "likely change nothing while the standing blockers remain.";
      const recommendationReasoning = bothValid
        ? "Apply Review can fix problems Implementation cannot see; Implementation can still make progress " +
          "on the checklist in the meantime, so this fixes the review's findings first rather than leaving " +
          "them to compound."
        : "Apply Review is the only action that can fix what the newest review still reports; " +
          "Implementation is structurally blind to it and will most likely change nothing.";
      const fallbackNoticeSuffix = bothValid
        ? " Implementation can still make progress on the checklist, but will not fix what the review found."
        : " Running Implementation now will most likely change nothing.";
      const decision = await postWorkflowDecisionV1(
        {
          decisionKey: "preImplementationRouting",
          taskCanonicalId: resolved.folderUri.fsPath,
          stage: resolved.progress.currentStage,
          whatHappened: `${preRunDecision.reason}${whatHappenedSuffix}`,
          whyUserNeeded,
          options: [
            {
              optionId: "goToReviewAndApply",
              label: "Go to Review & Apply",
              consequence:
                `Moves the task to ${STAGE_DISPLAY_NAMES[targetReviewStage]} and opens Apply Review, which ` +
                "can fix the blockers Implementation cannot see (Implementation only reads the plan checklist). " +
                "Moving stages first requests the Implementation round already running to cancel — a task " +
                "never has two automations running against it at once — so this also stops the current run.",
              effect: {
                kind: "command",
                // Resumes the task first if it has since been paused
                // (review blocker 2026-08-30, item 14) rather than the
                // plain goToReviewAndApply, which fails with a confusing
                // "task could not be found" on a paused task.
                command: "vs-code-ai-helper.resumeIfPausedThenGoToReviewAndApply",
                args: [{ taskFolderPath: resolved.folderUri.fsPath, reviewStage: targetReviewStage }],
              },
            },
            {
              optionId: "letItRun",
              // Part 11 item 13b's audit target verbatim: "Let Implementation
              // Run" named the mechanism (the Implementation round already in
              // flight) rather than the outcome for the user.
              label: "Keep running Implementation",
              consequence: letItRunConsequence,
              effect: { kind: "doNothing" },
            },
          ],
          recommendation: {
            kind: "option",
            optionId: "goToReviewAndApply",
            reasoning: recommendationReasoning,
          },
          gating: {
            holdsTaskPaused: false,
            unblocksProgress: false,
            detail:
              "This does not pause the task itself. \"Go to Review & Apply\" requests the Implementation " +
              "round already running to cancel first, since moving stages always stops whatever the outgoing " +
              "stage was doing, and resumes the task first if it happens to be paused by the time you click " +
              "it; \"Keep running Implementation\" leaves the current run going untouched.",
          },
        },
        target
      );
      if (!decision) {
        // No activating extension context to post through (e.g. a unit-test
        // harness stubbing only the write path) — fall back to the direct
        // notification so the choice is not lost entirely.
        NotificationRouter.showWarning(`${preRunDecision.reason}${fallbackNoticeSuffix}`);
      }
      // Falls through to run Implementation — see the comment above this
      // block for why this must not gate the current run.
    }

    // wf10 continuation item 17: on the AUTOMATIC path there is no human to
    // read the decision card above, so — unlike the manual branch, which
    // always falls through to Implementation once the card is posted — an
    // automation dispatch that `chooseAutomaticImplementationDispatchV1`
    // says should redirect must actually redirect, not run Implementation
    // and change nothing. This is what closes the loop observed on wf10: ten
    // consecutive automatic Implementation rounds against a blocker frozen
    // at score 6 because Implementation only reads the plan checklist and
    // was never told about the review's blockers.
    if (isAutomationDispatchV1(arg)) {
      const autoDispatch = chooseAutomaticImplementationDispatchV1({
        decision: preRunDecision,
        isAutomationDispatch: true,
        continuationOwed: resolved.progress.implRecovery !== undefined,
      });
      if (autoDispatch.kind === "redirect-apply-review") {
        try {
          await appendChatMessageV1(resolved.folderUri.fsPath, {
            role: "assistant",
            text:
              `_Automation redirected: an unattended Implementation dispatch was routed to ` +
              `${STAGE_DISPLAY_NAMES[autoDispatch.reviewStage]} → Apply Review instead, since ` +
              `Implementation cannot fix what that review found. ${autoDispatch.reason}_`,
            stage: resolved.progress.currentStage,
            at: new Date().toISOString(),
          });
        } catch {
          // Best-effort record only — the redirect itself must still happen
          // even when the chat write fails.
        }
        // Do NOT dispatch the redirect here — see `redirectAfterOperationV1`'s
        // declaration comment above. Recording it and returning ends this
        // operation cleanly; the actual `goToReviewAndApplyV1` call runs once
        // `runTrackedOperation` has resolved, below.
        redirectAfterOperationV1 = {
          reviewStage: autoDispatch.reviewStage,
          reason: autoDispatch.reason,
        };
        return;
      }
    }

    const contextPackContent = await generateContextPack(
      resolved.folderUri,
      workspaceRoot.uri
    );

    // Continuation of a failed/unreported round: a prior round changed the
    // quarantined files but ended without a usable report (deferred, cut
    // short, rejected, or — via Part 7 — killed externally). The freshest
    // progress read wins — the quarantine and the `implRecovery` record may
    // have been written after `resolved.progress` was snapshotted at command
    // entry. The record's persisted MODE (Part 2) selects the mandate:
    // `summary-only` (report the combined diff, no edits),
    // `inspect-and-complete` (verify/finish the quarantined files inside the
    // reviewed boundary), or the unconstrained notice. Read here, BEFORE the
    // template is chosen: a continuation whose SOURCE round was dispatched as
    // Apply Review (item 17b) must re-render from apply-impl-review-code.md
    // with the original review content — never silently revert to a
    // checklist-driven run-implementation.md continuation.
    const freshForContinuation = await readTaskProgressAdvisoryV1(resolved.folderUri);
    const pendingFiles =
      freshForContinuation?.pendingImplReviewFiles ??
      resolved.progress.pendingImplReviewFiles ??
      [];
    const recoveryRecord =
      freshForContinuation?.implRecovery ?? resolved.progress.implRecovery;
    const reviewedFiles =
      freshForContinuation?.implReviewFiles ?? resolved.progress.implReviewFiles ?? [];

    let sourceReviewPrompt: string | undefined;
    let sourceReviewStageForRun: TaskStage | undefined;
    let dispatchedTemplateName = "run-implementation.md";
    let dispatchedTemplateVariables: Record<string, string> = {
      contextPack: contextPackContent,
      plan: planFinalContent,
    };
    let dispatchedBlockerIds: readonly ReviewBlockerIdentity[] | undefined;
    const applyReviewContinuationStage = shouldContinueAsApplyReviewV1(recoveryRecord);
    if (applyReviewContinuationStage) {
      const sourceReviewUri = artifactUri(resolved.folderUri, applyReviewContinuationStage);
      const sourceReviewContent = sourceReviewUri && (await readNonEmptyText(sourceReviewUri));
      let reconstructionError: string | undefined;
      if (sourceReviewContent) {
        const parts = await buildApplyReviewPromptPartsV1(
          extensionUri,
          resolved.folderUri,
          contextPackContent,
          sourceReviewContent
        );
        if ("prompt" in parts) {
          sourceReviewPrompt = parts.prompt;
          sourceReviewStageForRun = applyReviewContinuationStage;
          dispatchedTemplateName = "apply-impl-review-code.md";
          dispatchedTemplateVariables = parts.templateVariables;
          dispatchedBlockerIds = await blockerIdentitiesHandedToApplyReviewV1(
            resolved.folderUri,
            applyReviewContinuationStage
          );
        } else {
          reconstructionError = parts.error;
        }
      } else {
        reconstructionError =
          `The ${STAGE_DISPLAY_NAMES[applyReviewContinuationStage]} review artifact is missing or ` +
          "empty, so this continuation cannot be re-rendered as Apply Review.";
      }
      if (!sourceReviewPrompt) {
        // Review blocker 2026-08-26 (fail-closed correction): a continuation
        // whose source round was Apply Review must never silently downgrade
        // to checklist-driven Implementation, honest run-log reporting
        // notwithstanding — that IS the mode loss the plan forbids, not a
        // narrower version of it. Refuse the round instead of running it
        // under the wrong mandate. Nothing has been claimed or mutated yet
        // (this runs before any `patchTaskProgressStrictV1` call in this
        // function), so `implRecovery` and `pendingImplReviewFiles` are left
        // exactly as they were — the continuation stays owed, and a retry
        // once the missing artifact is restored can still complete it as
        // Apply Review.
        NotificationRouter.showWarning(
          `Apply Review continuation could not be reconstructed: ${reconstructionError ?? "unknown reason"} ` +
            "The pending changes remain quarantined; restore the missing artifact and retry."
        );
        return;
      }
    }

    const basePrompt = await (async () => {
      if (sourceReviewPrompt !== undefined) {
        return sourceReviewPrompt;
      }
      const templatePrompt = await renderPromptTemplate(
        extensionUri,
        "run-implementation.md",
        { contextPack: contextPackContent, plan: planFinalContent }
      );

      // The hedge behind decidePostReviewActionV1's routing (see
      // standingBlockersNoticeV1). `run-implementation.md` is rendered with the
      // plan and NOT the review, so a round that reaches here with blockers
      // outstanding — a directly-invoked command, a chain predating the routing,
      // a recovery continuation whose source was not apply-review — would
      // otherwise spend itself on a checklist with nothing actionable left and
      // report "nothing to do", while the reviewer keeps reporting the same
      // defects. Reads the newest impl review artifact of either kind, matching
      // the routing's own stage selection.
      const standingBlockers = await readStandingImplBlockersV1(resolved.folderUri);
      return standingBlockers
        ? buildStandingBlockersNoticeV1(templatePrompt, {
            blockers: standingBlockers.blockers,
            reviewStageName: STAGE_DISPLAY_NAMES[standingBlockers.stage],
          })
        : templatePrompt;
    })();

    const prompt = buildImplementationContinuationPromptV1(basePrompt, {
      mode: recoveryRecord?.mode,
      pendingFiles,
      reviewedFiles,
    });

    // ── Prompt-size gate (applied before executeImplementationRun) ────────────
    const sizeCheck = await checkAndConfirmPromptSize(prompt, providerLabel);
    if (sizeCheck === "abort" || sizeCheck === "declined") {
      return;
    }

    const postRunReviewStage = isReviewStage(resolved.progress.currentStage)
      ? resolved.progress.currentStage
      : "impl";

    await executeImplementationRun(
      extensionUri,
      resolved.folderUri,
      workspaceRoot,
      prompt,
      model.modelId,
      `Running implementation with ${providerLabel} (uses your ${providerLabel} quota)...`,
      postRunReviewStage,
      {
        onBusyDetail: (d) => op.report(d),
        onWaitingForUser: (w) => op.setWaitingForUser(w),
        parentOperation: op,
        followUpReviewMode,
        chatViewProvider,
        templateName: dispatchedTemplateName,
        templateVariables: dispatchedTemplateVariables,
        ...(sourceReviewStageForRun ? { editActionKey: "applyReviewEdit.v1" } : {}),
        ...(dispatchedBlockerIds ? { dispatchedBlockerIds } : {}),
      }
    );
    }
  );

  // Runs only after the "Run Implementation" operation above has genuinely
  // ended — see `redirectAfterOperationV1`'s declaration comment. The stage
  // transition inside `goToReviewAndApplyV1` no longer has to wait on (and
  // cancel) the operation that is dispatching it.
  if (redirectAfterOperationV1) {
    const dispatched = await goToReviewAndApplyV1({
      taskFolderPath: resolved.folderUri.fsPath,
      reviewStage: redirectAfterOperationV1.reviewStage,
    });
    if (!dispatched) {
      // `goToReviewAndApplyV1` already reports the specific cause (stage
      // transition failure, verification mismatch) via its own
      // notification/`setTaskStage` path; this is unattended automation, so
      // there is no human present to act on a second notification here — but
      // the failure must still be visible in the durable record rather than
      // silently dropped, since this is exactly the loop the redirect exists
      // to break.
      try {
        await appendChatMessageV1(resolved.folderUri.fsPath, {
          role: "assistant",
          text:
            `_Automation redirect failed: could not move the task to ` +
            `${STAGE_DISPLAY_NAMES[redirectAfterOperationV1.reviewStage]} to dispatch Apply Review. ` +
            "No round ran this cycle — retry from the tree, or check whether another operation is still live._",
          stage: resolved.progress.currentStage,
          at: new Date().toISOString(),
        });
      } catch {
        // Best-effort record only.
      }
    }
  }
}

/**
 * Genuinely separate edit-root entry point for Apply Review (plan §1.3 /
 * AC-ROUTE-01). The shared `applyReviewWithAI` above must still dynamically
 * discover a `{ taskFolderPath }` or no-arg dispatch's stage before it knows
 * whether it is on the text or edit branch — this command's mere existence
 * already proves edit intent, since every caller (the impl-review-only tree
 * menu binding; the keyboard-shortcut routers, once THEY resolve an
 * impl-review stage) invokes it specifically because the target is
 * edit-capable. The gate therefore runs unconditionally as the literal first
 * statement, before any argument normalization or read whatsoever —
 * stronger than the shared entry point can offer its own dynamically
 * discovered dispatch shapes, and satisfies AC-ROUTE-01's "gate before every
 * read" contract with no dependency on stage discovery.
 *
 * Delegates to the same underlying implementation as the text route
 * (`applyReviewWithAI`, whose own internal `isPlanReviewStage` check remains
 * as a defense-in-depth safety net for any caller that reaches it directly,
 * e.g. a stale custom keybinding) — sharing behavior is not the architectural
 * problem the plan flags; one dynamic PUBLIC COMMAND identity for both
 * branches is. Post-§7.8, `applyReviewEdit.v1` is MIGRATED: the edit branch
 * runs the sealed two-phase pipeline via runSealedImplementationV1 for a
 * Copilot-resolved model, or its own direct edit-mode invocation for a
 * CLI-resolved one — see runImplementationOrSealedV1.
 */
export async function applyReviewEditWithAI(
  extensionUri: vscode.Uri,
  context: vscode.ExtensionContext,
  arg?: ReviewCommandArg,
  options: ApplyReviewOptions = {}
): Promise<void> {
  assertLegacyAiRouteAllowedV0("applyReviewEdit.v1");
  // §7.5's task/model-INDEPENDENT provider-path check (AC-HOST-03): before
  // any task/source read (the edit branch always resolves against the impl
  // stage's model — see checkEditActionProviderPathGateV1's header). It
  // subsumes the host/LM-tool-API floor for a Copilot-resolved model and
  // skips it entirely for a CLI-resolved one. The exact per-task/stage
  // capability (workspace root included) is revalidated by
  // checkEditActionAvailabilityV1 below, once resolveTask makes it known.
  const providerPathGate = await checkEditActionProviderPathGateV1("impl");
  if (!providerPathGate.ok) {
    NotificationRouter.showWarning(providerPathGate.reason);
    return;
  }

  if (isMalformedReviewArg(arg as ReviewCommandArg | Record<string, unknown>)) {
    NotificationRouter.showError(
      "Apply Review: unsupported argument shape. " +
        "Use { taskFolderPath } to target a specific task, or invoke without an argument to pick from a list."
    );
    return;
  }

  const node = normalizeReviewArg(arg);

  const resolved = await resolveTask(
    node,
    IMPL_REVIEW_STAGES,
    "Apply Review Edit with AI",
    context
  );
  if (!resolved) {
    return;
  }
  if (resolved.progress.status === "paused") {
    NotificationRouter.showInformation("This task is paused. Resume it before applying a review.");
    return;
  }

  const consented = await ensureAiConsent(context);
  if (!consented) {
    return;
  }

  const workspaceRoot = resolveOwnerWorkspace(resolved.progress);
  if (!workspaceRoot) {
    NotificationRouter.showError(
      "Could not determine the owning workspace for this task. Please open the workspace that created it."
    );
    return;
  }

  // ── §7.5 full availability gate, BEFORE any review/plan artifact read ────
  // Mirrors runImplementationWithAI's placement: the remaining (task/model-
  // dependent) half of the gate runs as soon as the owning workspace and
  // stage model are knowable, ahead of the review-content read below and
  // everything applyImplementationReviewWithAI reads/materializes. The
  // resolved model is threaded through to applyImplementationReviewWithAI so
  // the model this gate checked is exactly the model the run uses.
  const stage = resolved.progress.currentStage;
  const model = options.preserveActiveFallback
    ? await resolveModelForStage(resolved.folderUri, "impl")
    : await resolveFreshModelForStage(resolved.folderUri, "impl");
  const editAvailability = await checkEditActionAvailabilityV1({
    workspaceFsPath: workspaceRoot.uri.fsPath,
    stageModelId: model.modelId,
    stage: "impl",
  });
  if (!editAvailability.ok) {
    NotificationRouter.showWarning(editAvailability.reason);
    return;
  }

  const lockKey = resolved.folderUri.fsPath;
  const runApply = async (op: TaskOperationHandle): Promise<void> => {
    const reviewUri = artifactUri(resolved.folderUri, stage);
    const reviewContent = reviewUri && (await readNonEmptyText(reviewUri));
    if (!reviewContent) {
      NotificationRouter.showWarning(
        "No review found (or it is empty). Run the review before applying it."
      );
      return;
    }
    if (isStaleReviewArtifact(reviewContent)) {
      NotificationRouter.showWarning(
        "The review is stale. Run the review again before applying it."
      );
      return;
    }
    // An incomplete implementation round can invalidate this stage's review
    // via the durable `reviewInvalidatedByRound` marker WITHOUT staling the
    // artifact's content (the content is deliberately preserved for
    // reference). The marker, not the artifact, is the source of truth for
    // currency — applying the preserved review would drive an edit round
    // from findings about a tree that no longer exists, while the unreported
    // round's edits sit unreviewed in `pendingImplReviewFiles`. Read fresh
    // rather than trusting `resolved.progress`: the marker may have been
    // persisted after that snapshot was taken at command entry.
    const progressForApply = await readTaskProgressAdvisoryV1(resolved.folderUri);
    if (progressForApply?.reviewInvalidatedByRound?.stage === stage) {
      // When the invalidation is caused by a STILL-owed continuation, the
      // plain "run the review again" line hides the actual blocker (a
      // continuation round is queued or already claimed, and re-running the
      // review will hit the same refusal) — route through the refusal
      // explainer instead, which names the lease, the quarantined files, and
      // whether retrying can help at all (task "Actionable Hand-offs",
      // "Also in scope: when an action refuses, say what is blocking it and
      // when it clears"). A cleared/absent `implRecovery` (the round was
      // already claimed and completed, or never quarantined anything) falls
      // back to the plain message unchanged.
      const message = progressForApply.implRecovery
        ? describeOwedContinuationRefusalV1(
            progressForApply.implRecovery,
            progressForApply.pendingImplReviewFiles ?? [],
            progressForApply.incompleteRoundContinuations ?? 0
          )
        : "An implementation round changed the workspace after this review was written " +
          "(the round ended without a usable report), so the review no longer describes " +
          "the tree. Run the review again before applying it.";
      NotificationRouter.showWarning(message);
      if (progressForApply.implRecovery) {
        try {
          await writeRunLog(
            resolved.folderUri,
            "declined",
            stage,
            `# Action Declined\n\nStatus: declined (owed continuation)\n\n${message}`
          );
        } catch {
          // Courtesy history record only — the refusal above already ran.
        }
      }
      return;
    }
    const reviewValidation = validateReviewOutput(reviewContent);
    if (!reviewValidation.valid) {
      NotificationRouter.showWarning(
        `The review content is invalid (${reviewValidation.reason}). Run the review again before applying it.`
      );
      return;
    }

    assertLegacyAiRouteAllowedV0("applyReviewEdit.v1");

    const implementSucceeded = await runTrackedOperation(
      lockKey,
      { parent: op, label: "Applying implementation review", stage: "impl", kind: "run-implementation" },
      (child) =>
        applyImplementationReviewWithAI(
          extensionUri,
          resolved.folderUri,
          workspaceRoot,
          stage,
          reviewContent,
          model,
          {
            skipPreRunSafetyCheck: options.skipImplementationSafetyCheck,
            preserveActiveFallback: options.preserveActiveFallback,
            parentOperation: child,
            // Without this, executeImplementationRun's onQuestions callback
            // sees an undefined provider and silently skips askInteraction,
            // leaving a posted preflight question with no task-local Chat
            // mirror (plan §7.5/AC-PREFLIGHT-04) — see this file's
            // ExecuteImplementationRunOptions.chatViewProvider doc comment.
            chatViewProvider: options.chatViewProvider,
          }
        )
    );
    if (implementSucceeded) {
      await runTrackedOperation(
        lockKey,
        { parent: op, label: "Re-running review", stage, kind: "review" },
        () =>
          runReviewForFolder(
            extensionUri,
            resolved.folderUri,
            workspaceRoot,
            stage,
            true,
            {
              preserveActiveFallback: options.preserveActiveFallback,
              operation: op,
              chatViewProvider: options.chatViewProvider,
            }
          )
      );
    }
  };

  if (options.parentOperation) {
    // A composite caller (Fast Forward) already registered the exclusive
    // tracked operation on this task; run under its handle so the whole
    // composite renders exactly one Notifications row and the internal
    // apply/re-review steps nest as its children. Without this branch the
    // runTrackedOperation below would try to register a SECOND exclusive
    // root on the same key while the composite still holds it, be refused
    // by taskOperations.begin, and silently no-op every Fast Forward
    // attempt with a "task busy" warning — mirrors applyReviewWithAI's
    // identical branch, which is what let the plan path compose all along.
    await runApply(options.parentOperation);
    return;
  }
  await runTrackedOperation(
    lockKey,
    {
      label: "Apply Review",
      stage,
      taskName: resolved.progress.displayName,
      kind: "apply-review",
      cancellable: true,
    },
    runApply
  );
}

/**
 * Register all review/stage action commands
 */
export function registerReviewActionCommands(
  context: vscode.ExtensionContext,
  chatViewProvider?: ChatViewProvider
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "vs-code-ai-helper.generateImplementationWithAI",
      (arg?: ReviewCommandArg) =>
        generateImplementationWithAI(context.extensionUri, context, chatViewProvider, arg)
    ),
    vscode.commands.registerCommand(
      "vs-code-ai-helper.runReviewWithAI",
      (arg?: ReviewCommandArg) => runReviewWithAI(context.extensionUri, context, arg, chatViewProvider)
    ),
    vscode.commands.registerCommand(
      "vs-code-ai-helper.applyReviewWithAI",
      (arg?: ReviewCommandArg) =>
        applyReviewWithAI(context.extensionUri, context, arg, { chatViewProvider })
    ),
    vscode.commands.registerCommand(
      "vs-code-ai-helper.applyReviewEditWithAI",
      (arg?: ReviewCommandArg) =>
        applyReviewEditWithAI(context.extensionUri, context, arg, { chatViewProvider })
    ),
    vscode.commands.registerCommand(
      "vs-code-ai-helper.fastForwardReviewWithAI",
      (arg?: ReviewCommandArg) =>
        fastForwardReviewWithAI(context.extensionUri, context, arg, chatViewProvider)
    ),
    vscode.commands.registerCommand(
      "vs-code-ai-helper.viewReview",
      (arg?: ReviewCommandArg) => viewReview(context, arg)
    ),
    // Item 13c / 10: registered as a contributed command ("Discard Last
    // Round") so it is reachable independent of the decision card that used
    // to be its only entry point (`WorkflowDecisionOptionEffectV1`'s
    // `args: [folderUri.fsPath, stage]`) — a user wanting to discard a
    // round's edits is a standing intention, not something that should only
    // be reachable while a report-format failure happens to have raised a
    // card for it. Accepts EITHER that original two-positional-string shape
    // (still used by `implementationRecoveryV1.ts`'s decision option) or a
    // task-row context-menu invocation, which VS Code passes as a single
    // `{ task: IncompleteTask }`-shaped node instead.
    vscode.commands.registerCommand(
      "vs-code-ai-helper.restoreRejectedImplementationRound",
      (arg: string | TaskNodeArg | undefined, stage?: TaskStage) => {
        if (typeof arg === "string") {
          if (!stage) {
            NotificationRouter.showWarning("Could not discard the last round: no stage was supplied.");
            return undefined;
          }
          return restoreRejectedImplementationRoundV1(arg, stage);
        }
        const task = arg?.task;
        if (!task) {
          NotificationRouter.showWarning("Select a task first.");
          return undefined;
        }
        return restoreRejectedImplementationRoundV1(task.folderUri.fsPath, task.progress.currentStage);
      }
    ),
    vscode.commands.registerCommand(
      "vs-code-ai-helper.nextStage",
      (node?: TaskNodeArg) =>
        nextStage(context.extensionUri, context, node)
    ),
    // wf10 item 19 / Step 28: the "Complete Anyway" override on the
    // blocker-gate warning in `nextStage`. `{ taskFolderPath }` is
    // normalized to the same `TaskNodeArg` shape `resolveTask` already
    // accepts from every other notification-button command in this file
    // (see `normalizeReviewArg`'s doc comment), so this targets the exact
    // task the warning was about rather than re-prompting a picker.
    vscode.commands.registerCommand(
      "vs-code-ai-helper.completeStageAnywayV1",
      (arg?: { taskFolderPath: string; artifactOverride?: "user" }) =>
        nextStage(
          context.extensionUri,
          context,
          normalizeReviewArg(arg),
          true,
          arg?.artifactOverride === "user"
        )
    ),
    // The standalone "Generate Implementation Checklist" command was merged
    // into "Implement Actual Work": runImplementationWithAI generates the
    // checklist automatically when it is absent, then implements.
    vscode.commands.registerCommand(
      "vs-code-ai-helper.runImplementationWithAI",
      (arg?: ReviewCommandArg) =>
        runImplementationWithAI(context.extensionUri, context, arg, chatViewProvider)
    ),
    vscode.commands.registerCommand(
      "vs-code-ai-helper.release",
      (arg?: TaskNodeArg) => runRelease(context, arg)
    ),
    vscode.commands.registerCommand(
      "vs-code-ai-helper.chooseReleaseTarget",
      async () => {
        const folders = vscode.workspace.workspaceFolders ?? [];
        if (folders.length === 0) {
          NotificationRouter.showWarning("Open a workspace before choosing a release target.");
          return;
        }
        let folder = folders[0];
        if (folders.length > 1) {
          const picked = await vscode.window.showWorkspaceFolderPick({
            placeHolder: "Workspace folder whose release target to change",
          });
          if (!picked) { return; }
          folder = folders.find((f) => f.uri.toString() === picked.uri.toString());
        }
        if (!folder) { return; }
        const chosen = await resolveReleaseTargetPackageJson(context, folder.uri.fsPath, true);
        if (chosen) {
          NotificationRouter.showInformation(
            `Release target set to ${path.relative(folder.uri.fsPath, chosen) || "package.json"}.`
          );
        }
      }
    )
  );
}

/**
 * Whether a package.json `scripts.release` value is safe to display in the
 * confirmation prompt before delegating execution to the package manager's
 * own `<manager> run release` (never the script text itself — see
 * runRelease below). Rejects shell metacharacters (`;`, `&`, `|`, backticks,
 * `$()`, redirects, quotes, newlines) so a malicious/compromised
 * package.json can't smuggle a misleading confirmation prompt past the user
 * — e.g. a script string engineered to look benign when truncated in a
 * dialog but that would behave differently if it were ever concatenated
 * into a shell command elsewhere.
 *
 * @internal exported for testing
 */
export function isSafeReleaseScript(script: unknown): script is string {
  // Separator is [ \t] (space/tab) only, not \s — \s also matches \r and \n,
  // which would let a script smuggle embedded newlines into the confirmation
  // modal (e.g. text engineered to look like a different dialog once wrapped).
  return (
    typeof script === "string" &&
    /^[a-zA-Z0-9@_./:+%=-]+(?:[ \t]+[a-zA-Z0-9@_./:+%=-]+)*$/.test(script)
  );
}

/** Sentinel used to end the Release tracked operation as `failed` after the
 * failure has already been surfaced to the user. */
class ReleaseRunFailure extends Error {}

/** Name of the required release script in the target package.json. */
export const RELEASE_SCRIPT_NAME = "ensemble:release";

/**
 * Error shown when the `ensemble:release` script (or, after one hop of
 * indirection resolution, the script it points to) fails isSafeReleaseScript
 * / cannot be safely resolved. Documents both accepted forms: a plain safe
 * command, or a one-line pass-through to another script.
 */
const RELEASE_UNSAFE_SCRIPT_MESSAGE =
  `Release requires a safe package.json "${RELEASE_SCRIPT_NAME}" script: a single command with no shell ` +
  `chaining, pipes, redirects, or quotes (e.g. "${RELEASE_SCRIPT_NAME}": "node scripts/release.js"), or a ` +
  `one-line "npm run <script>" / "pnpm run <script>" / "yarn <script>" that points to another script. That ` +
  `referenced script may itself chain multiple steps with "&&" (e.g. "${RELEASE_SCRIPT_NAME}": "npm run release" ` +
  `with "release": "npm run type-check && npm run lint && npm run test:all && npm run build"), but no other ` +
  `shell operators.`;

/**
 * Matches an `ensemble:release` value that is *exactly* a one-line
 * pass-through to another script — "npm run <name>", "pnpm run <name>", or
 * "yarn <name>" — with nothing else chained or appended alongside it (e.g.
 * "npm run release && rm -rf ." does not match). Capture group 1 or 2 holds
 * the target script's name.
 * @internal exported for testing
 */
export const RELEASE_INDIRECTION_PATTERN =
  /^(?:npm|pnpm)[ \t]+run[ \t]+([a-zA-Z0-9@_./:+%=-]+)$|^yarn[ \t]+([a-zA-Z0-9@_./:+%=-]+)$/;

/**
 * Resolve one hop of `ensemble:release` indirection so the safety check (and
 * the release confirmation dialog) covers the script that actually ends up
 * running, not just an innocuous-looking pass-through call to it. Running
 * `<manager> run ensemble:release` only ever directly executes the literal
 * text of the `ensemble:release` script — but when that text is itself
 * `npm run <name>`, the package manager resolves `<name>` at run time, so
 * without this the confirmation dialog could show a harmless one-liner while
 * the script it actually triggers does something entirely different.
 *
 * Only ever follows a single hop: the resolved target's own value is never
 * itself re-resolved, so this cannot loop on a cycle. A target that names
 * `ensemble:release` again (a self-reference) or that does not exist
 * resolves to an `undefined` value, which callers must treat as unsafe.
 *
 * @internal exported for testing
 */
export function resolveReleaseScript(
  script: string,
  scripts: Record<string, unknown> | undefined
): { name: string; value: unknown } {
  const match = RELEASE_INDIRECTION_PATTERN.exec(script);
  const targetName = match?.[1] ?? match?.[2];
  if (!targetName) {
    // Not an indirection — the script's own text is what runs.
    return { name: RELEASE_SCRIPT_NAME, value: script };
  }
  if (targetName === RELEASE_SCRIPT_NAME) {
    // Self-reference — never follow it back to "ensemble:release" itself.
    return { name: targetName, value: undefined };
  }
  return { name: targetName, value: scripts?.[targetName] };
}

/**
 * Whether a package.json script value is safe for the *resolved* target of
 * an `ensemble:release` indirection (e.g. the "release" script that
 * `"ensemble:release": "npm run release"` points to). Unlike
 * isSafeReleaseScript, this allows "&&" so a legitimate multi-step release
 * pipeline (`"npm run type-check && npm run lint && npm run test:all && npm
 * run build"`) can be expressed as the pass-through target — the accepted
 * way to chain commands here, since the top-level `ensemble:release` script
 * itself must stay a single command or a one-line pass-through. Every other
 * shell metacharacter isSafeReleaseScript guards against (pipes,
 * backgrounding, redirects, command substitution, quotes, newlines) is still
 * rejected: the value is split on "&&" and each resulting segment must pass
 * isSafeReleaseScript on its own.
 *
 * @internal exported for testing
 */
export function isSafeReleaseIndirectionTarget(script: unknown): script is string {
  if (typeof script !== "string" || script.trim().length === 0) return false;
  if (/[\r\n]/.test(script)) return false;
  return script.split(/[ \t]*&&[ \t]*/).every((segment) => isSafeReleaseScript(segment));
}

function releaseTargetStateKey(workspaceRoot: string): string {
  const normalized = path.resolve(workspaceRoot);
  return `ensemble.releaseTarget:${process.platform === "win32" ? normalized.toLowerCase() : normalized}`;
}

/**
 * Order the release-target QuickPick so the package.json inside the current
 * task's Publish verification scope (when one is known) is listed — and
 * therefore highlighted — first: the pick defaults to the task's Publish
 * scope while the stored release target stays fully independent of it.
 * Remaining entries keep the shortest-path-first order.
 * @internal exported for testing
 */
export function orderReleaseTargetItems<T extends { label: string; description?: string }>(
  items: T[],
  workspaceRoot: string,
  publishScopeFolder: string | undefined
): T[] {
  const sorted = [...items].sort((a, b) => a.label.length - b.label.length);
  if (!publishScopeFolder) {
    return sorted;
  }
  const scope = path.resolve(publishScopeFolder);
  const index = sorted.findIndex(
    (item) => path.resolve(workspaceRoot, path.dirname(item.label)) === scope
  );
  const match = sorted[index];
  if (index < 0 || match === undefined) {
    return sorted;
  }
  sorted.splice(index, 1);
  match.description = "current task's Publish scope";
  return [match, ...sorted];
}

/**
 * Resolve the release-target package.json for a workspace folder: the
 * explicit workspace-relative package.json path persisted per folder (so a
 * folder with several releasable packages is unambiguous). When unset — or
 * when the persisted path no longer exists — the user picks from the
 * detected package.json files (defaulting to the one in
 * `publishScopeFolder`, the calling task's Publish verification scope, when
 * given) and the choice is stored. `forcePrompt` is the "change release
 * target" path: always re-prompts, defaulting nothing away.
 */
async function resolveReleaseTargetPackageJson(
  context: vscode.ExtensionContext,
  workspaceRoot: string,
  forcePrompt = false,
  publishScopeFolder?: string
): Promise<string | undefined> {
  const key = releaseTargetStateKey(workspaceRoot);
  const stored = context.workspaceState.get<string>(key);
  if (stored && !forcePrompt) {
    const absolute = path.join(workspaceRoot, stored);
    if (fs.existsSync(absolute)) {
      return absolute;
    }
    // Persisted-but-invalid path: re-prompt rather than silently falling back.
  }

  const uris = await vscode.workspace.findFiles(
    new vscode.RelativePattern(workspaceRoot, "**/package.json"),
    "**/node_modules/**",
    50
  );
  if (uris.length === 0) {
    NotificationRouter.showError("No package.json was found in this workspace.");
    return undefined;
  }
  const items = orderReleaseTargetItems(
    uris.map((uri) => ({
      label: path.relative(workspaceRoot, uri.fsPath) || "package.json",
      uri,
    })),
    workspaceRoot,
    publishScopeFolder
  );
  const picked = await vscode.window.showQuickPick(items, {
    title: "Select the package.json to release",
    placeHolder: `The chosen file must define a "${RELEASE_SCRIPT_NAME}" script; the choice is remembered for this workspace folder`,
  });
  if (!picked) {
    return undefined;
  }
  await context.workspaceState.update(key, path.relative(workspaceRoot, picked.uri.fsPath));
  return picked.uri.fsPath;
}

async function runRelease(context: vscode.ExtensionContext, arg?: TaskNodeArg): Promise<void> {
  const candidate = arg?.task?.folderUri.fsPath;
  if (!candidate) {
    NotificationRouter.showWarning("Release is available only from a task's Publish stage.");
    return;
  }
  // Strict decode (plan §3.10/§3.12 Text-3 cutover): this is a top-level
  // command gate, not a best-effort freshness check, so an unsupported/
  // invalid document must surface as its own recovery message rather than
  // collapsing into the same "resume the task" warning a merely-missing file
  // gets.
  const candidateUri = vscode.Uri.file(candidate);
  const strictRelease = await readTaskProgressStrictV1(candidateUri, {
    expectedTaskFolder: path.basename(candidateUri.fsPath),
  });
  if (!strictRelease.ok) {
    NotificationRouter.showWarning(
      strictRelease.code === "missing"
        ? "Release requires an active task at the Publish stage. Resume the task first if it is paused."
        : `Task progress could not be read (${strictRelease.code}) and needs recovery: ${strictRelease.reason}`
    );
    return;
  }
  let progress: TaskProgress = strictRelease.decoded.progress;
  if (progress.currentStage !== "publish" || progress.status === "paused") {
    NotificationRouter.showWarning("Release requires an active task at the Publish stage. Resume the task first if it is paused.");
    return;
  }
  // Tasks can live in an external metadata root, so task-folder containment
  // is not a valid way to find their project. Prefer the persisted project
  // binding and only use containment for legacy tasks without ownership.
  const ownershipValidation = await validateReleaseTaskOwnership(candidate, progress);
  if (!ownershipValidation.ok) {
    NotificationRouter.showError(ownershipValidation.message);
    return;
  }
  progress = ownershipValidation.progress;
  const persistedOwner = progress.ownership?.projectRoot ?? progress.ownership?.workspaceRoot;
  const owner = resolveReleaseWorkspace(
    candidate,
    progress.ownership,
    vscode.workspace.workspaceFolders ?? []
  );
  if (persistedOwner && !owner) {
    NotificationRouter.showError("This task belongs to a different workspace and cannot be released here.");
    return;
  }
  const root = owner?.uri.fsPath;
  if (!root) { NotificationRouter.showWarning("Open a workspace before releasing."); return; }

  await runTrackedOperation(
    candidate,
    { label: "Release", taskName: arg?.task?.progress?.displayName ?? arg?.task?.folderName ?? path.basename(candidate), kind: "release" },
    async () => {
    // The release target is the explicit, per-workspace-folder persisted
    // package.json path (see resolveReleaseTargetPackageJson) — it may be a
    // nested package and can differ from any task's Publish verification
    // scope. A persisted-but-invalid path re-prompts, defaulting the pick to
    // this task's Publish scope without ever storing it as the target.
    const packageJsonPath = await resolveReleaseTargetPackageJson(
      context,
      root,
      false,
      resolvePublishScopeFolder(vscode.Uri.file(candidate), progress).folder
    );
    if (!packageJsonPath) { return; }
    const packageDir = path.dirname(packageJsonPath);

    let pkg: { scripts?: Record<string, unknown> };
    try {
      const parsed: unknown = JSON.parse(await fs.promises.readFile(packageJsonPath, "utf8"));
      if (!parsed || typeof parsed !== "object") throw new Error("package.json is not an object");
      pkg = parsed as { scripts?: Record<string, unknown> };
    }
    catch { NotificationRouter.showError("No valid package.json was found at the selected release target."); return; }
    const script = pkg.scripts?.[RELEASE_SCRIPT_NAME];
    if (script === undefined) {
      NotificationRouter.showWarning(
        `Release requires a "${RELEASE_SCRIPT_NAME}" script in ${path.relative(root, packageJsonPath) || "package.json"}. ` +
          `Add one, e.g. "${RELEASE_SCRIPT_NAME}": "npm run release", then try again.`
      );
      return;
    }
    if (!isSafeReleaseScript(script)) { NotificationRouter.showWarning(RELEASE_UNSAFE_SCRIPT_MESSAGE); return; }
    // "ensemble:release" may be a one-line pass-through to another script
    // (e.g. "npm run release"); resolve that single hop so the confirmation
    // dialog below covers the script that actually runs, not just the
    // pass-through call to it. See resolveReleaseScript. The resolved target
    // is allowed to chain multiple commands with "&&" (a legitimate
    // multi-step release pipeline) even though the top-level
    // "ensemble:release" script may not — see isSafeReleaseIndirectionTarget.
    const resolved = resolveReleaseScript(script, pkg.scripts);
    const isIndirect = resolved.name !== RELEASE_SCRIPT_NAME;
    const targetIsSafe = isIndirect
      ? isSafeReleaseIndirectionTarget(resolved.value)
      : isSafeReleaseScript(resolved.value);
    if (!targetIsSafe) { NotificationRouter.showWarning(RELEASE_UNSAFE_SCRIPT_MESSAGE); return; }
    const effectiveScript = resolved.value as string;
    if (!vscode.workspace.isTrusted) { NotificationRouter.showWarning("Release requires a trusted workspace."); return; }
    const manager = fs.existsSync(path.join(packageDir, "pnpm-lock.yaml")) || fs.existsSync(`${root}/pnpm-lock.yaml`)
      ? "pnpm"
      : fs.existsSync(path.join(packageDir, "yarn.lock")) || fs.existsSync(`${root}/yarn.lock`)
        ? "yarn"
        : fs.existsSync(path.join(packageDir, "bun.lockb")) || fs.existsSync(`${root}/bun.lockb`)
          ? "bun"
          : "npm";
    const scriptHash = crypto.createHash("sha256").update(effectiveScript).digest("hex");
    const commandText = `${manager} run ${RELEASE_SCRIPT_NAME}`;
    const scriptLabel = isIndirect ? `${RELEASE_SCRIPT_NAME} → ${resolved.name}` : RELEASE_SCRIPT_NAME;
    // Same safeguard as before the move to a terminal: the user reviews the
    // project-defined script body (and its hash) before anything runs, and a
    // post-confirmation script change cancels the release. When
    // "ensemble:release" is a one-line indirection, the reviewed script is
    // the resolved target's body — what will actually run — not the
    // pass-through text.
    const confirmation = await vscode.window.showWarningMessage(`Run release?\n\nCommand: ${commandText}\nWorking directory: ${packageDir}\nPackage manager: ${manager}\nScript (${scriptLabel}): ${effectiveScript}\nSHA-256: ${scriptHash}`, { modal: true }, "Run Release");
    if (confirmation !== "Run Release") return;
    // Re-read immediately before launching so a package.json edit cannot
    // change the reviewed release command between confirmation and
    // execution — both the "ensemble:release" text itself and, if it is an
    // indirection, the resolved target script it points to.
    const currentPackage = JSON.parse(await fs.promises.readFile(packageJsonPath, "utf8")) as { scripts?: Record<string, unknown> };
    const currentEffective = isIndirect ? currentPackage.scripts?.[resolved.name] : currentPackage.scripts?.[RELEASE_SCRIPT_NAME];
    if (currentPackage.scripts?.[RELEASE_SCRIPT_NAME] !== script || currentEffective !== effectiveScript) { NotificationRouter.showError("The release script changed after confirmation; release was cancelled."); return; }
    await fs.promises.writeFile(path.join(candidate, "release-operation.json"), JSON.stringify({ command: commandText, cwd: packageDir, packageManager: manager, script: effectiveScript, scriptSha256: scriptHash, startedAt: new Date().toISOString() }, null, 2), "utf8");
    // Run in a visible IDE terminal so interactive version prompts work.
    // The extension only reports that the release was STARTED — it does not
    // observe the terminal and never claims the release succeeded; the
    // outcome is visible in the terminal itself.
    try {
      const terminal = vscode.window.createTerminal({ name: "Ensemble Release", cwd: packageDir });
      terminal.show();
      terminal.sendText(commandText, true);
    } catch (error) {
      const message = `Release failed to start: ${error instanceof Error ? error.message : String(error)}`;
      NotificationRouter.showError(message);
      // Thrown so the tracked operation records a `failed` terminal state;
      // swallowed just below — the failure was already reported above.
      throw new ReleaseRunFailure(message);
    }
    NotificationRouter.showInformation(
      `Release started in the "Ensemble Release" terminal (${commandText}). Follow its prompts there.`
    );
    }
  ).catch(error => {
    if (!(error instanceof ReleaseRunFailure)) { throw error; }
  });
}

/**
 * Drive an explicit Chat Resume of a `review.v1` structured-question interaction.
 */
/**
 * Read-only rebuild of the `variables` a `review.v1` prompt was built from,
 * for use by an explicit Chat Resume. The coordinator itself replays the
 * ORIGINAL prompt from the persisted interaction transaction's input
 * snapshot — this is only needed so a completed Resume can feed
 * {@link handleReviewOutcomeV1}'s escalation/second-opinion routing (which
 * may render a fresh independent-model prompt from these same variables),
 * mirroring the read/prep logic in runReviewForFolder minus the
 * previousReview/template-selection concerns that only affect which
 * template the (already-resumed) primary call rendered.
 */
async function buildReviewResumeVariablesV1(
  folderUri: vscode.Uri,
  workspaceUri: vscode.Uri,
  targetStage: TaskStage,
  operationToken: vscode.CancellationToken | undefined
): Promise<{ ok: true; variables: Record<string, string> } | { ok: false; warning: string }> {
  const variables: Record<string, string> = {};
  const isPlanReview = isPlanReviewStage(targetStage);

  const planUri = await resolveCurrentPlanUri(folderUri);
  const planContent = await readNonEmptyText(planUri);
  if (!planContent) {
    return {
      ok: false,
      warning: isPlanReview
        ? stageActionRequirementMessageV1("reviewPlan", 0)
        : stageActionRequirementMessageV1("reviewImplementation", 0),
    };
  }
  variables.plan = planContent;

  if (!isPlanReview) {
    // Publish freshness gate (plan PART 2, step 7): a resumed review must be
    // refused exactly like a fresh one when Publish Checks are absent or
    // stale — resuming is still "building a Publish review prompt", just via
    // a different entry point. No-op for non-publish targetStage.
    if (targetStage === "publish") {
      const progress = await readTaskProgressAdvisoryV1(folderUri);
      const { folder: scopeFolder } = resolvePublishScopeFolder(folderUri, progress);
      const currentCommitSha = await resolveHeadCommitSha(scopeFolder);
      const freshnessCheck = await checkPublishChecksFreshnessV1(folderUri, scopeFolder, currentCommitSha);
      if (freshnessCheck.status !== "valid") {
        return { ok: false, warning: describePublishChecksFreshnessFailureV1(freshnessCheck) };
      }
    }
    // Same resolver and same order as runReviewForFolder — a resumed review
    // (and any second opinion routed off it) must see the SAME
    // {{implementation}} the original review saw. Reading plan-final.md
    // directly here handed the second prompt the checklist plan while the
    // first got impl-summary.md, so the two could reconcile against different
    // documents. Read-only by the same rationale: never materialize an
    // artifact as a side effect of rebuilding prompt variables.
    const implementationContent = await readImplementationReviewContent(folderUri);
    if (!implementationContent) {
      return {
        ok: false,
        warning: stageActionRequirementMessageV1("reviewImplementation", 1),
      };
    }
    if (isUnusableImplementationSummaryV1(implementationContent)) {
      return {
        ok: false,
        warning:
          "The last implementation round did not produce usable implementation notes, so there is " +
          "nothing to review it against. Run the implementation step again to produce them.",
      };
    }
    variables.implementation = implementationContent;
    const checks = await buildVerifiedChecksVariable(
      folderUri,
      undefined,
      operationToken,
      targetStage === "publish",
      targetStage
    );
    variables.verifiedChecks = checks.verifiedChecks;
    if (checks.planItemVerification !== undefined) {
      variables.planItemVerification = checks.planItemVerification;
    }
    setMechanicalBlockersForStage(folderUri, targetStage, checks.mechanicalBlockers);
  }

  let resumeBaselineSha: string | undefined;
  if (!isPlanReview) {
    const targetReviewUri = artifactUri(folderUri, targetStage);
    const previousReviewForBaseline = targetReviewUri
      ? await readPreviousReviewForRereview(targetReviewUri)
      : undefined;
    resumeBaselineSha =
      (previousReviewForBaseline !== undefined
        ? parseReviewedCommitSha(previousReviewForBaseline)
        : undefined) ?? (await readTaskImplementationBaselineShaV1(folderUri));
  }
  const contextPackUri = isPlanReview
    ? await writeContextPack(folderUri, workspaceUri, false)
    : (
        await writeImplReviewContextPack(
          folderUri,
          workspaceUri,
          (await readTaskProgressAdvisoryV1(folderUri))?.implReviewFiles,
          undefined,
          resumeBaselineSha
        )
      ).contextPackUri;
  variables.contextPack = new TextDecoder().decode(await vscode.workspace.fs.readFile(contextPackUri));

  return { ok: true, variables };
}

export async function resumeReviewInteractionV1(
  extensionUri: vscode.Uri,
  inventory: TaskInventory,
  chatViewProvider: ChatViewProvider,
  ref: ChatInteractionRefV1,
  resumeIdempotencyId: string,
  cancellationToken: vscode.CancellationToken
): Promise<ChatInteractionResumeResultV1> {
  const ownedTask = inventory.getTaskByBindingId(ref.taskBindingId);
  if (!ownedTask) {
    return { ok: false, reason: "the task that asked this question could not be found" };
  }
  const taskFolderUri = vscode.Uri.file(ownedTask.taskFolderPath);
  const workspaceFolderUri = ownedTask.workspaceFolder;
  if (!workspaceFolderUri) {
    return { ok: false, reason: "the task has no owning workspace" };
  }

  const currentStage = ownedTask.progress.currentStage;
  const targetStage = REVIEW_TARGETS[currentStage];
  const reviewUri = targetStage && artifactUri(taskFolderUri, targetStage);
  if (!targetStage || !reviewUri) {
    return { ok: false, reason: "this task is no longer at a stage a review can be resumed from" };
  }

  // Model resolution must key off targetStage (the review being produced),
  // not currentStage (the underlying task stage the review was launched
  // from) — this mirrors the initial call in runReviewForFolder, which
  // resolves the model for targetStage, not currentStage.
  const model = await resolveFreshModelForStage(taskFolderUri, targetStage);
  if (!model.modelId) {
    return { ok: false, reason: "no model is configured for this stage" };
  }
  const modelId = model.modelId;
  const coordinator = createProductionTaskActionCoordinatorV1({
    workspaceCwd: workspaceFolderUri.fsPath,
    resolveStagePrimaryModel: () => ({ modelId, stage: targetStage }),
  });
  const orchestrator = getProductionActionConversationOrchestratorV1();

  const interactionRef: InteractionRefV1 = {
    operationId: ref.operationId,
    interactionId: ref.interactionId,
    taskBindingId: ref.taskBindingId,
    chatDocumentId: ref.chatDocumentId,
    sourceAttemptId: ref.sourceAttemptId,
  };

  // A fresh attempt for this resume's own score-history/escalation
  // bookkeeping (see the identical claim before the initial call in
  // runReviewForFolder) — distinct from the coordinator's own fresh
  // provider attemptId for the resumed operation.
  const reviewAttemptId = crypto.randomUUID();
  const claimed = await claimReviewAttempt(taskFolderUri, reviewAttemptId, targetStage);
  if (!claimed) {
    return { ok: false, reason: "could not claim the review attempt (the task may have been paused)" };
  }

  // Preflight BEFORE resuming, and fail closed. An interaction can sit waiting
  // on questions while a later implementation round changes the tree and
  // stamps its summary unusable; resuming first meant the provider answered
  // against its original, now-stale prompt and the outcome still went through
  // handleReviewOutcomeV1 — which can advance the stage. A warning after the
  // fact does not undo that. Checking first turns it into a refusal.
  const variablesResult = await buildReviewResumeVariablesV1(
    taskFolderUri,
    workspaceFolderUri,
    targetStage,
    cancellationToken
  );
  if (!variablesResult.ok) {
    NotificationRouter.showWarning(variablesResult.warning);
    // 2026-08-27 review, same blocker as the "no configured model" early
    // return in `runReviewForFolder`: this happens before `coordinator.resumeAction`
    // is ever called, so `handleReviewOutcomeV1`'s safety net never runs and
    // the row `claimReviewAttempt` opened above would otherwise stay "open"
    // until the still-unbuilt reconciliation sweep exists at all.
    await terminalizeRoundV1(reviewAttemptId, "failed", undefined, { taskFolderUri: taskFolderUri });
    return { ok: false, reason: variablesResult.warning };
  }

  // 2026-08-27 review, blocker "lifecycle identity", fourth pass: "Resume
  // execution calls `runProviderRow` without an attempt observer, so
  // fallback/retry attempts during a resumed review are also absent" — mirror
  // `runReviewForFolder`'s `observedCoordinatorAttemptIds` collection here now
  // that `TaskActionResumeRequestV1.onPromptAssembled` exists.
  const observedCoordinatorAttemptIds: string[] = [];
  const outcome = await coordinator.resumeAction({
    interaction: interactionRef,
    taskBinding: { taskBindingId: ref.taskBindingId, chatDocumentId: ref.chatDocumentId },
    taskStatus: ownedTask.progress.status ?? "active",
    taskStage: currentStage,
    resumeIdempotencyId,
    cancellationToken,
    // See `runReviewForFolder`'s matching `onAttemptAllocated` comment: an
    // in-memory-only (zero-I/O) collection of every attempt id, including one
    // that fails before `onPromptAssembled` ever fires for it, reaching disk
    // only through the same already-proven `extraCoordinatorAttemptIds` →
    // `terminalizeRoundV1` forwarding every id here already takes — AND (see
    // that same call site's 2026-08-28 review fix) durably attached to the
    // round ledger before the provider can run.
    onAttemptAllocated: async (info) => {
      observedCoordinatorAttemptIds.push(info.attemptId);
      await attachCoordinatorIdentityToRoundV1({
        roundId: reviewAttemptId,
        operationId: info.operationId,
        attemptId: info.attemptId,
        taskFolderUri,
      });
    },
    onPromptAssembled: (info) => {
      observedCoordinatorAttemptIds.push(info.attemptId);
    },
  });

  await handleReviewOutcomeV1(outcome, {
    extensionUri,
    folderUri: taskFolderUri,
    workspaceUri: workspaceFolderUri,
    currentStage,
    targetStage,
    reviewUri,
    variables: variablesResult.variables,
    reviewAttemptId,
    chatViewProvider,
    modelId,
    ...(observedCoordinatorAttemptIds.length
      ? { extraCoordinatorAttemptIds: observedCoordinatorAttemptIds }
      : {}),
  });

  const after = await orchestrator.loadInteraction(interactionRef);
  const settlement =
    after.kind === "ok" &&
    after.record.state === "settled" &&
    (after.record.settlement === "resumed" || after.record.settlement === "supersededByReplacementOperation")
      ? after.record.settlement
      : undefined;

  if (settlement === undefined) {
    return { ok: false, reason: "Resume failed to settle the interaction" };
  }
  return { ok: true, settlement };
}

/**
 * Drive an explicit Chat Resume of an `applyReview.v1` structured-question interaction.
 */
export async function resumeApplyReviewInteractionV1(
  extensionUri: vscode.Uri,
  inventory: TaskInventory,
  chatViewProvider: ChatViewProvider,
  ref: ChatInteractionRefV1,
  resumeIdempotencyId: string,
  cancellationToken: vscode.CancellationToken
): Promise<ChatInteractionResumeResultV1> {
  const ownedTask = inventory.getTaskByBindingId(ref.taskBindingId);
  if (!ownedTask) {
    return { ok: false, reason: "the task that asked this question could not be found" };
  }
  const taskFolderUri = vscode.Uri.file(ownedTask.taskFolderPath);
  const workspaceFolderUri = ownedTask.workspaceFolder;
  if (!workspaceFolderUri) {
    return { ok: false, reason: "the task has no owning workspace" };
  }

  const model = await resolveFreshModelForStage(taskFolderUri, "plan");
  if (!model.modelId) {
    return { ok: false, reason: "no model is configured for plan stage" };
  }
  const modelId = model.modelId;
  const coordinator = createProductionTaskActionCoordinatorV1({
    workspaceCwd: workspaceFolderUri.fsPath,
    resolveStagePrimaryModel: () => ({ modelId, stage: "plan" }),
  });
  const orchestrator = getProductionActionConversationOrchestratorV1();

  const interactionRef: InteractionRefV1 = {
    operationId: ref.operationId,
    interactionId: ref.interactionId,
    taskBindingId: ref.taskBindingId,
    chatDocumentId: ref.chatDocumentId,
    sourceAttemptId: ref.sourceAttemptId,
  };

  const outcome = await coordinator.resumeAction({
    interaction: interactionRef,
    taskBinding: { taskBindingId: ref.taskBindingId, chatDocumentId: ref.chatDocumentId },
    taskStatus: ownedTask.progress.status ?? "active",
    taskStage: ownedTask.progress.currentStage,
    resumeIdempotencyId,
    cancellationToken,
  });

  if (outcome.kind === "completed") {
    // Mirror the initial applyReviewWithAI completion path exactly: mark the
    // just-applied-to review stale, open the updated plan, and re-run the
    // review — Resume must not silently skip the re-review follow-up that
    // the original synchronous flow always performs.
    const stage = ownedTask.progress.currentStage;
    const reviewUri = artifactUri(taskFolderUri, stage);
    if (reviewUri) {
      await markReviewArtifactStale(reviewUri, PLAN_FILENAME);
    }
    const currentPlanUri = vscode.Uri.joinPath(taskFolderUri, PLAN_FILENAME);
    await safeOpenTextDocument(currentPlanUri, PLAN_FILENAME);
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(workspaceFolderUri);
    if (workspaceFolder) {
      await runTrackedOperation(
        taskFolderUri.fsPath,
        { label: "Re-running review", stage, taskName: ownedTask.progress.displayName, kind: "review" },
        (op) =>
          runReviewForFolder(
            extensionUri,
            taskFolderUri,
            workspaceFolder,
            stage,
            true,
            { operation: op, chatViewProvider }
          )
      );
    }
  } else if (outcome.kind === "questions") {
    const record = await orchestrator.getRecord(interactionRef);
    if (record) {
      await chatViewProvider.askInteraction({
        canonicalId: ownedTask.canonicalId ?? ownedTask.taskFolderPath,
        taskFolderPath: ownedTask.taskFolderPath,
        stage: record.stage,
        taskName: ownedTask.progress.displayName,
        interactionId: record.interactionId,
        operationId: record.correlation.operationId,
        actionKey: record.correlation.actionKey,
        sourceAttemptId: record.correlation.attemptId,
        // safe: see the other askInteraction call sites' comment.
        questions: record.questions!,
        binding: {
          taskBindingId: record.correlation.taskBindingId,
          chatDocumentId: record.correlation.chatDocumentId,
        },
      });
    }
  }

  const after = await orchestrator.loadInteraction(interactionRef);
  const settlement =
    after.kind === "ok" &&
    after.record.state === "settled" &&
    (after.record.settlement === "resumed" || after.record.settlement === "supersededByReplacementOperation")
      ? after.record.settlement
      : undefined;

  if (settlement === undefined) {
    return { ok: false, reason: "Resume failed to settle the interaction" };
  }
  return { ok: true, settlement };
}
