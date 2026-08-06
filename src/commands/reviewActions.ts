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
} from "../utils/taskOperations";
import {
  EscalationKind,
  IMPL_REVIEW_STAGES,
  isPlanReviewStage,
  isReviewStage,
  PLAN_FILENAME,
  PLAN_REVIEW_STAGES,
  REVIEW_STAGES,
  STAGE_ARTIFACT_FILENAMES,
  STAGE_DISPLAY_NAMES,
  STAGE_ORDER,
  TaskStage,
} from "../types/taskProgress";
import { TaskProgress } from "../types/taskProgress";
import { deriveTaskBindingV1 } from "../types/taskBindingV1";
import { appendReviewRejection, appendReviewScoreHistory, updateTaskStatus } from "../utils/taskProgressTransforms";
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
  openOrCreateDocument,
  readNonEmptyText,
  resolveCurrentPlanUri,
  safeOpenTextDocument,
  statIfExists,
  writeTextFile,
} from "../utils/fileUtils";
import { generateContextPack, writeContextPack, writeImplReviewContextPack } from "../utils/contextPack";
import { renderPromptTemplate } from "../utils/promptTemplates";
import { writeRunLog } from "../utils/runLog";
import {
  describeTaskActionFailureV1,
  describeTaskActionOutcomeForLogV1,
} from "../utils/taskActionOutcomeTextV1";
import { checkImplementationAvailabilityForModel, resolveEffectiveProvider } from "../runners/runnerRegistry";
import {
  checkEditActionAvailabilityV1,
  checkEditActionHostGateV1,
  checkEditActionProviderPathGateV1,
  runImplementationOrSealedV1,
} from "./runEditActionV1";
import {
  ResolvedStageModel,
  resolveConfiguredReviewStages,
  resolveFreshModelForStage,
  resolveModelForStage,
} from "../utils/modelSelection";
import {
  getCanonicalImplementationUri,
  getLegacyImplementationUri,
  resolveImplementationArtifact,
  materializeCanonicalIfNeeded,
  preparePlanPromotion,
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
import { readChatDocumentIdentityV1 } from "../utils/chatHistoryStore";
import { allocateHex128IdV1 } from "../types/actionCorrelationV1";
import {
  createProductionTaskActionCoordinatorV1,
  getProductionActionConversationOrchestratorV1,
  invokeLifecycleRowV1,
} from "../actions/productionTaskActionRuntimeV1";
import { ActionConversationOrchestratorV1, InteractionRefV1 } from "../actions/actionConversationOrchestratorV1";
import { GENERATE_IMPLEMENTATION_ACTION_KEY_V1 } from "../actions/rows/generateImplementationRowV1";
import { REVIEW_ACTION_KEY_V1, ReviewActionInputV1 } from "../actions/rows/reviewRowV1";
import { APPLY_REVIEW_ACTION_KEY_V1, ApplyReviewActionInputV1 } from "../actions/rows/applyReviewRowV1";
import { NEXT_STAGE_ACTION_KEY_V1 } from "../actions/rows/nextStageRowV1";
import { TaskActionOutcomeV1 } from "../types/taskActionOutcomeV1";
import { ChatInteractionRefV1, ChatInteractionResumeResultV1, ChatViewProvider } from "../views/chatView";
import { TaskInventory } from "../state/taskInventory";
import {
  hasZeroTaskFixableEvidence,
  meetsAutoAdvanceThreshold,
  parseReadiness,
  parseReviewBlockers,
  parseReviewBlockersDetailed,
} from "../utils/reviewReadiness";
import { scheduleAutomationChain, releaseAutomationChain } from "../utils/automationChain";
import { buildVerifiedChecksSection, collectCompletionLintPreview, resolvePublishScopeFolder } from "../utils/completionLint";
import { checkPublishPreflight } from "../utils/publishPreflight";
import { improveReviewScore } from "../utils/reviewScoreLoop";
import {
  blockerIdentities,
  decideReviewRoute,
  degenerateReviewRejectionReason,
  detectBlockerSetStall,
  detectPlateau,
  REVIEW_RUBRIC_BLOCKER_SCORE_CAP,
  roundsWithoutTaskFixableDecrease,
  rubricCapLikelyBlockedAdvance,
  shouldEscalateChurnCeiling,
  shouldTripNoProgressBreaker,
} from "../utils/reviewRouting";
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
      arg: { taskFolderPath },
      taskKey: taskFolderPath,
    },
    parentOperation
  );
  return true;
}

/** Claim the review attempt immediately before invoking the AI provider. */
export async function claimReviewAttempt(
  folderUri: vscode.Uri,
  reviewAttemptId: string
): Promise<TaskProgress | undefined> {
  return patchTaskProgressStrictV1(folderUri, (current) => {
    if (current.status === "paused") {
      throw new Error("The task was paused while the review was starting.");
    }
    return { ...current, reviewAttemptId };
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
    }
  | undefined;

/**
 * Extract the chained follow-up-review request from a ReviewCommandArg, if
 * present. Only the exact "auto-fast-forward" marker is honored — anything
 * else (including args from UI surfaces) yields undefined.
 */
function chainedFollowUpReviewMode(
  arg: ReviewCommandArg
): "auto-fast-forward" | undefined {
  return arg &&
    typeof arg === "object" &&
    "followUpReviewMode" in arg &&
    arg.followUpReviewMode === "auto-fast-forward"
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
  if ("task" in arg && arg.task) {
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
  if (node?.task) {
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
  const autoPickable =
    soleEligible !== undefined &&
    (!currentTaskId ||
      currentTaskId === (soleEligible.canonicalId ?? normalizePath(soleEligible.folderUri.fsPath)));

  let picked: DiscoveredTaskItem | undefined;
  if (autoPickable) {
    picked = soleEligible;
  } else {
    const items = eligible.map((task) => ({
      label: task.folderName,
      description:
        "corrupt" in task
          ? `[Recovery Required] ${task.reason}`
          : `Stage: ${STAGE_DISPLAY_NAMES[task.progress.currentStage]}`,
      task,
    }));
    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: "Select a task",
      title,
    });
    picked = selected?.task;
  }
  if (!picked) {
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

/** Stages from which a review can be run, mapped to the review it produces */
const REVIEW_TARGETS: Partial<Record<TaskStage, TaskStage>> = {
  plan: "plan-high-review",
  "plan-high-review": "plan-high-review",
  "plan-low-review": "plan-low-review",
  impl: "impl-high-review",
  "impl-high-review": "impl-high-review",
  "impl-low-review": "impl-low-review",
  publish: "publish",
};

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
 * criterion satisfied. Side-effect-free (does not persist to
 * task-progress.json or publish-review.md — that only happens at an actual
 * Publish attempt via runCompletionLint) and never throws: a stale/
 * unresolvable Publish scope or any other failure degrades to an explicit
 * "could not run" note rather than blocking the review that requested it.
 *
 * `token`, when supplied, is the enclosing tracked operation's cancellation
 * token — linked through to every spawned check process so cancelling the
 * review/Fast Forward from the UI actually stops a hung lint/test run
 * instead of leaving it running with no way to recover short of reloading
 * the window. Each check is additionally capped at
 * ensemble.completionCheckTimeoutMs regardless of cancellation.
 */
async function buildVerifiedChecksVariable(
  folderUri: vscode.Uri,
  relevantFiles: readonly string[] | undefined,
  token: vscode.CancellationToken | undefined
): Promise<string> {
  try {
    // includeAiPlanVerification: false — buildVerifiedChecksSection never
    // renders `planItems`, so running that AI-assisted pass here would be a
    // full extra model call (against the Publish-stage model, regardless of
    // which stage is actually under review) discarded on every single
    // review round for output nothing displays.
    const result = await collectCompletionLintPreview(folderUri, relevantFiles, {
      allowScopePrompt: false,
      includeAiPlanVerification: false,
      token,
    });
    return buildVerifiedChecksSection(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Consistent with review-scoring-rubric.md's "## Verified Checks"
    // section ("raise a blocker ... when it reports checks could not be
    // run at all"): the extension host being UNABLE to run checks at all
    // (a stale/unresolvable Publish scope, a scope-resolution failure) is
    // itself missing evidence — a legitimate review-confidence concern, not
    // the "you personally can't reproduce a test run" case the rubric tells
    // reviewers to ignore. Do not tell reviewers to disregard this.
    return (
      "## Verified Checks (ground truth)\n\n" +
      `Verified checks could not be run for this review: ${message}\n\n` +
      "This means no ground-truth evidence is available for this round — treat the absence of verified checks itself as a review-confidence concern, not as neutral."
    );
  }
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
 */
async function handleReviewRoutingOutcome(options: {
  folderUri: vscode.Uri;
  targetStage: TaskStage;
  reviewAttemptId: string;
  content: string;
  score: number | null;
  threshold: number;
}): Promise<{ escalated: boolean }> {
  const { folderUri, targetStage, reviewAttemptId, content, score, threshold } = options;
  try {
    const resilience = getResilienceSettings();
    const blockers = parseReviewBlockers(content);
    const progressBefore = await readTaskProgressAdvisoryV1(folderUri);
    if (!progressBefore) {
      return { escalated: false };
    }
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
      await patchTaskProgressStrictV1(folderUri, (current) =>
        appendReviewRejection(current, {
          stage: targetStage,
          attemptId: reviewAttemptId,
          at: new Date().toISOString(),
          reason: rejectionReason,
        })
      );
      await writeRunLog(
        folderUri,
        "review-guard",
        targetStage,
        `# Rejected Review Round\n\nStatus: rejected (degenerate output)\n\n${rejectionReason}\n\n` +
          `Output length: ${content.length} characters.`
      );
      NotificationRouter.showWarning(rejectionReason);
      return { escalated: false };
    }
    const historyEntry = {
      stage: targetStage,
      score,
      attemptId: reviewAttemptId,
      at: new Date().toISOString(),
      blockerCount: blockers.length,
      taskFixableCount: blockers.filter((b) => b.resolver === "task-fixable").length,
      blockers: blockerIdentities(blockers),
    };
    const updated = await patchTaskProgressStrictV1(folderUri, (current) =>
      appendReviewScoreHistory(current, historyEntry)
    );
    if (!updated) {
      return { escalated: false };
    }

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
      const escalated = await escalateReviewToHuman(
        folderUri,
        targetStage,
        "plateau",
        `${STAGE_DISPLAY_NAMES[targetStage]} has completed ${stagnantRounds} consecutive rounds without ` +
          "reducing the number of task-fixable blockers (churn ceiling, " +
          "ensemble.resilience.churnCeilingRounds). Automated iteration is churning, not converging.",
        reviewAttemptId,
        updated,
        false
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
        true
      );
      return { escalated };
    }
    // decision.route === "escalate"
    const escalated = await escalateReviewToHuman(folderUri, targetStage, "plateau", decision.reason, reviewAttemptId, updated, false);
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
interface ReviewOutcomeContextV1 {
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
async function handleReviewOutcomeV1(
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
async function writeReviewRunLogV1(
  outcome: TaskActionOutcomeV1,
  ctx: ReviewOutcomeContextV1
): Promise<void> {
  try {
    const logUri = await writeRunLog(
      ctx.folderUri,
      "review-v1",
      ctx.targetStage,
      `# Review Run\n\n${describeTaskActionOutcomeForLogV1(
        outcome,
        STAGE_ARTIFACT_FILENAMES[ctx.targetStage]
      )}\n`
    );
    taskOperations.setResultTargetUriForTask(ctx.folderUri.fsPath, logUri);
  } catch {
    // Ignore: the review's own outcome has already been surfaced.
  }
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
        const autoAdvanceThreshold = getAutoAdvanceScoreThreshold();
        const meetsThreshold = meetsAutoAdvanceThreshold(score, autoAdvanceThreshold);
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
        const { escalated } = await handleReviewRoutingOutcome({
          folderUri,
          targetStage,
          reviewAttemptId,
          content,
          score,
          threshold: autoAdvanceThreshold,
        });
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
            if (next === "impl") {
              const promotion = await preparePlanPromotion(folderUri);
              if (!promotion.ready) {
                NotificationRouter.showWarning(
                  "Review score reached the auto-advance threshold, but there is no plan to promote. Advance to Implementation manually once a plan exists."
                );
                return;
              }
              publishArtifact = promotion.publish;
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
              // decided separately, directly from the auto-advance mode: in
              // "auto-fast-forward" mode every other landed-on review stage
              // gets an immediate follow-up review via this same block, so
              // Publish gets the same treatment for consistency. In plain
              // "auto" mode there is no follow-up review, so the entry-owned
              // block below nudges the user to publish manually instead.
              const publishFollowUpReview =
                next === "publish" && getAutoAdvanceMode() === "auto-fast-forward";
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
                const reviewChainScheduled = scheduleAutomationChain(
                  {
                    command: reviewCommand,
                    arg: {
                      taskFolderPath: folderUri.fsPath,
                    },
                    taskKey: folderUri.fsPath,
                    chainId: "auto-review",
                  },
                  operation
                );
                if (next === "publish") {
                  // If the shared "auto-review" chainId drops this dispatch
                  // because another review chain is already pending/running,
                  // the task is silently stuck on Publish with nothing
                  // running — warn with the same Publish Anyway affordance
                  // every sibling skip path uses.
                  void reviewChainScheduled.then((scheduled) => {
                    if (!scheduled) {
                      NotificationRouter.showWarning(
                        `${folderUri.fsPath}: the follow-up Publish review could not be started automatically because another review is already in progress for this task. ` +
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
              if (next === "publish" && !publishFollowUpReview) {
                // Reached only in plain "auto" mode (no follow-up review is
                // dispatched above): nudge the user to publish manually.
                // Commit and Push must only ever run from the user's own
                // button click — never scheduled here.
                const autoAdvancePublishPreflight = await checkPublishPreflight(
                  folderUri,
                  freshProgressForAdvance?.implReviewFiles
                );
                if (autoAdvancePublishPreflight.ok === false) {
                  NotificationRouter.showWarning(
                    `${STAGE_DISPLAY_NAMES[next]} checks failed for ${folderUri.fsPath}: ${autoAdvancePublishPreflight.reason}. ` +
                      "Publish manually once checks pass, or use Publish Anyway from Commit and Push.",
                    undefined,
                    undefined,
                    undefined,
                    {
                      command: "vs-code-ai-helper.commitAndPushTask",
                      title: "Publish Anyway",
                      args: [{ taskFolderPath: folderUri.fsPath }],
                    }
                  );
                } else {
                  NotificationRouter.showWarning(
                    `${STAGE_DISPLAY_NAMES[next]} checks passed for ${folderUri.fsPath}. Publish manually when you're ready.`,
                    undefined,
                    undefined,
                    undefined,
                    {
                      command: "vs-code-ai-helper.commitAndPushTask",
                      title: "Publish",
                      args: [{ taskFolderPath: folderUri.fsPath }],
                    }
                  );
                }
              }
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
  }

  if (isPlanReview) {
    const planUri = await resolveCurrentPlanUri(folderUri);
    const planContent = await readNonEmptyText(planUri);
    if (!planContent) {
      NotificationRouter.showWarning(
        "No plan found (or it is empty). Generate or write a plan first."
      );
      return;
    }
    variables.plan = planContent;
  } else {
    // Implementation reviews need two distinct artifacts:
    //
    //   {{plan}} — the plan the implementation was supposed to follow.
    //     Source: plan.md (resolveCurrentPlanUri), NOT plan-final.md.
    //     Using plan-final.md here would inject implementation notes into
    //     both slots and the reviewer would compare the same text against
    //     itself.
    //
    //   {{implementation}} — the run summary / implementation notes.
    //     Source: plan-final.md (getCanonicalImplementationUri).
    //     executeImplementationRun writes the summary here on completion.
    //
    //   Legacy tasks (implementation.md present, plan-final.md absent):
    //     materializeCanonicalIfNeeded copies implementation.md → plan-final.md
    //     so the canonical path always exists after this point. This mirrors
    //     the same migration used by generateImplementationWithAI and
    //     runImplementationWithAI.

    const planUri = await resolveCurrentPlanUri(folderUri);
    const planContent = await readNonEmptyText(planUri);
    if (!planContent) {
      NotificationRouter.showWarning(
        "No plan found (or it is empty). Generate or write a plan before reviewing implementation."
      );
      return;
    }

    // Read-only: never materialize plan-final.md from legacy implementation.md
    // here. This function only reads content to build a review prompt — a
    // review that is later cancelled, fails, or returns questions must leave
    // the implementation artifact byte-identical. Eagerly writing plan-final.md
    // as a side effect of preparing a prompt was the same defect already fixed
    // in generateImplementationWithAI; the canonical-vs-legacy fallback read
    // mirrors that fix instead of reusing the writing materializeCanonicalIfNeeded.
    let implementationContent = await readNonEmptyText(getCanonicalImplementationUri(folderUri));
    if (!implementationContent) {
      implementationContent = await readNonEmptyText(getLegacyImplementationUri(folderUri));
    }
    if (!implementationContent) {
      NotificationRouter.showWarning(
        "No implementation notes found (plan-final.md is missing or empty). " +
          "Run the implementation step first."
      );
      return;
    }

    variables.plan = planContent;
    variables.implementation = implementationContent;
    variables.verifiedChecks = await buildVerifiedChecksVariable(folderUri, undefined, options.operation?.token);
  }

  let contextPackContent: string;
  if (isPlanReview) {
    const contextPackUri = await writeContextPack(folderUri, workspaceRoot.uri, false);
    contextPackContent = new TextDecoder().decode(
      await vscode.workspace.fs.readFile(contextPackUri)
    );
  } else {
    const taskProgress = await readTaskProgressAdvisoryV1(folderUri);
    const { contextPackUri, isFallback } = await writeImplReviewContextPack(
      folderUri,
      workspaceRoot.uri,
      taskProgress?.implReviewFiles
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
  const claimed = await claimReviewAttempt(folderUri, reviewAttemptId);
  if (!claimed) return;

  assertLegacyAiRouteAllowedV0("review.v1");

  const prompt = await renderPromptTemplate(extensionUri, templateFile, variables);

  const rootId = ensureWorkflowTaskFolderRootV1(folderUri.fsPath);
  const verifiedBindingId = getVerifiedTaskBindingIdV1(rootId);
  if (!verifiedBindingId) {
    throw new Error("Task ownership binding could not be verified.");
  }
  const chatIdentity = await readChatDocumentIdentityV1(folderUri.fsPath, folderUri.fsPath);
  const chatDocumentId = chatIdentity?.documentId ?? allocateHex128IdV1();

  const { modelId } = await resolveFreshModelForStage(folderUri, targetStage);
  if (!modelId) {
    NotificationRouter.showWarning("No model is configured for this stage.");
    return;
  }

  const coordinator = createProductionTaskActionCoordinatorV1({
    workspaceCwd: workspaceRoot.uri.fsPath,
    resolveStagePrimaryModel: () => ({ modelId, stage: targetStage }),
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
  };

  const outcome = await coordinator.executeAction({
    actionKey: REVIEW_ACTION_KEY_V1,
    taskBinding: { taskBindingId: verifiedBindingId, chatDocumentId },
    taskStatus: "active",
    taskStage: currentStage,
    rawInput: validatedInput,
    cancellationToken: options.operation?.token ?? new vscode.CancellationTokenSource().token,
  });

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
  });
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
 * Backs up a review artifact unless its current content is already a
 * "# Review Stale" placeholder. A placeholder is never worth preserving as
 * the "previous version" for View Changes — without this guard, staling the
 * same artifact twice in a row (e.g. two implementation reruns with
 * auto-review off) or publishing a new review over a staled one would
 * overwrite the last real review's backup with the placeholder itself.
 */
async function backupReviewUnlessStale(reviewUri: vscode.Uri): Promise<void> {
  const existing = await readNonEmptyText(reviewUri);
  if (existing !== undefined && !isStaleReviewArtifact(existing)) {
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
        "No plan found (or it is empty). Nothing to apply the review to."
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
      { label: "Apply Review", stage, kind: "apply-review", cancellable: true },
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
  if (initialContent !== undefined && isUnusableAsExistingReview(initialContent)) {
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
    if (!initialContent) {
      NotificationRouter.showWarning(
        "Fast Forward Review: the initial review did not produce usable output. Try running Review manually."
      );
      return;
    }
  }

  const initialScore = parseReadiness(initialContent).score;
  if (initialScore === null) {
    NotificationRouter.showWarning(
      "Fast Forward Review: the current review has no \"Readiness: N/10\" line to use as a " +
        "starting score. Run the review again (or edit it to include one) before fast-forwarding."
    );
    return;
  }
  const baselineScore = initialScore;
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
    } catch {
      // Best-effort: the escalation record itself is already persisted, and
      // failing to re-pause must not mask the run's own outcome/error.
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
            if (!resilience.fastForwardSurvivesEscalation || fresh.escalation?.stage !== targetStage) {
              return "external";
            }
            await patchTaskProgressStrictV1(resolved.folderUri, (current) =>
              current.status === "paused" && current.escalation?.stage === targetStage
                ? updateTaskStatus(current, "active")
                : current
            );
            escalationRiddenThrough = true;
            return "escalation";
          },
          continueThroughEscalation: resilience.fastForwardSurvivesEscalation,
          zeroFixableTerminates: resilience.zeroFixableTerminatesFastForward,
          review: async () => {
            const newContent = await readNonEmptyText(reviewUri);
            if (!newContent || newContent === previousContent) {
              return null;
            }
            previousContent = newContent;
            const detailed = parseReviewBlockersDetailed(newContent);
            return {
              score: parseReadiness(newContent).score,
              taskFixableCount: detailed.blockPresent
                ? detailed.blockers.filter((b) => b.resolver === "task-fixable").length
                : null,
              // Positive evidence only: a parsed (present) blocker block
              // with no task-fixable entry, or an explicit no-blockers
              // statement — never the mere absence of the block.
              zeroFixableEvidence: hasZeroTaskFixableEvidence(newContent),
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
    NotificationRouter.showWarning(
      "Fast Forward Review: automated review iteration escalated during this run (see the escalation " +
        "notification/chat question for the reason). The run was allowed to finish its attempt budget " +
        "instead of stopping, and the task has been returned to paused — review the escalation and " +
        "resume the task once you've decided how to proceed."
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
    NotificationRouter.showInformation(
      `Fast Forward Review: stopped after ${outcome.attempts} attempt(s) — two consecutive reviews ` +
        `reported zero task-fixable blockers (last score ${outcome.score}/10). Nothing fixable remains ` +
        "for further automated iteration."
    );
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
  // Materialize canonical plan-final.md from legacy implementation.md if needed.
  let canonicalUri: vscode.Uri;
  try {
    canonicalUri = await materializeCanonicalIfNeeded(folderUri);
  } catch {
    NotificationRouter.showWarning(
      "No plan-final.md found. Nothing to apply the review to."
    );
    return false;
  }

  const implementationNotes = await readNonEmptyText(canonicalUri);
  if (!implementationNotes) {
    NotificationRouter.showWarning(
      "No plan-final.md found. Nothing to apply the review to."
    );
    return false;
  }

  // Do not make the implementation model infer the approved contract from a
  // review or from its own prior summary. Review generation already uses the
  // current plan artifact; review application must receive that same source.
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
    NotificationRouter.showWarning(
      `No approved plan found (or it is empty). Generate or restore ${planName} before applying an implementation review.`
    );
    return false;
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

  const prompt = await renderPromptTemplate(
    extensionUri,
    "apply-impl-review-code.md",
    {
      contextPack: contextPackContent,
      approvedPlan,
      implementation: implementationNotes,
      review: reviewContent,
    }
  );

  // ── Prompt-size gate ─────────────────────────────────────────────────────
  const sizeCheck = await checkAndConfirmPromptSize(prompt, providerLabel);
  if (sizeCheck === "abort" || sizeCheck === "declined") {
    return false;
  }

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
  await safeOpenTextDocument(
    reviewUri,
    STAGE_ARTIFACT_FILENAMES[stage] ?? "review"
  );
}

/**
 * Whether the artifact for a task's current stage exists and has content.
 */
async function currentStageArtifactExists(
  folderUri: vscode.Uri,
  stage: TaskStage
): Promise<boolean> {
  if (isReviewStage(stage)) {
    return true;
  }
  const name = STAGE_ARTIFACT_FILENAMES[stage];
  if (!name) {
    return true;
  }
  // For implementation stage use the artifact resolver
  if (stage === "impl") {
    const resolved = await resolveImplementationArtifact(folderUri);
    const stat = await statIfExists(resolved.uri);
    return stat !== undefined;
  }
  const content = await readNonEmptyText(
    vscode.Uri.joinPath(folderUri, name)
  );
  return content !== undefined;
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
  publishArtifact?: () => Promise<void>
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

export async function nextStage(
  _extensionUri: vscode.Uri,
  context: vscode.ExtensionContext,
  node?: TaskNodeArg
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
    return;
  }

  // Check artifact existence for non-review stages
  if (
    !(await currentStageArtifactExists(
      resolved.folderUri,
      resolved.progress.currentStage
    ))
  ) {
    const artifactName =
      STAGE_ARTIFACT_FILENAMES[resolved.progress.currentStage];
    NotificationRouter.showWarning(
      `${artifactName ?? "The current stage's artifact"} hasn't been created yet. ` +
        `Write or generate it before advancing.`
    );
    return;
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
      });
      return;
    }
    if (next === "impl") {
      // Merged action: "Implement Actual Work" generates the implementation
      // checklist first when it is absent, then implements — there is no
      // separate checklist command anymore.
      await scheduleAutomationChain({
        command: "vs-code-ai-helper.runImplementationWithAI",
        arg: target,
        taskKey,
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
      const reviewScheduled = await scheduleAutomationChain({ command: publishCommand, arg: target, taskKey, chainId: "auto-review" });
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
    });
  }
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
function describeGenerateImplementationFailureV1(outcome: TaskActionOutcomeV1): string {
  switch (outcome.kind) {
    case "failed":
      return `${outcome.code}${outcome.retryable ? " (retryable)" : ""}`;
    case "malformedResult":
      return `the model's response was malformed (${outcome.code})`;
    case "unavailable":
      return outcome.code;
    case "recoveryRequired":
      return outcome.code;
    case "duplicateRejected":
      return "another operation is already running for this task";
    case "stalePreflight":
      return "a stale preflight plan was rejected";
    case "partialEditBlocked":
      return "a partial edit was blocked";
    default:
      return outcome.kind;
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
        ? `Generating implementation checklist failed: ${describeGenerateImplementationFailureV1(outcome)}. Implement the plan manually instead.`
        : `Generate Implementation failed: ${describeGenerateImplementationFailureV1(outcome)}. Use the manual workflow instead.`
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
    { label: "Generate Implementation", stage: "impl", kind: "generate-implementation", cancellable: true },
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
          "No plan found. Advance to the Implementation stage first."
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
    return { ok: false, reason: describeGenerateImplementationFailureV1(outcome) };
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
export const IMPLEMENTATION_CHECKLIST_MARKER = "<!-- ensemble:implementation-checklist -->";

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
 * In-memory consecutive zero-file-change implementation-round counter per
 * task folder (2c, ensemble.resilience.noProgressBreakerRounds). In-memory
 * on purpose: the breaker exists to stop a single session's automation loop
 * (Fast Forward / auto-review chains) from running to
 * fastForwardMaxIterations while producing no edits — matching Fast
 * Forward's own in-session loop state, not the durable cross-session trail
 * reviewScoreHistory provides.
 */
const zeroChangeImplRoundsByTask = new Map<string, number>();

/**
 * Drop the in-memory zero-change round counter for one task. Called when a
 * task is archived (see archiveTask.ts) so the per-session map does not
 * accumulate entries for tasks that are no longer iterating; a missing entry
 * is equivalent to a zero count, so this is always safe.
 */
export function clearZeroChangeImplRoundCounter(taskFolderPath: string): void {
  zeroChangeImplRoundsByTask.delete(normalizePath(taskFolderPath));
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
      // Copilot-resolved models run the sealed two-phase pipeline
      // (read-only preflight → sealed plan → receipted mutation session);
      // CLI-resolved models run their own direct edit-mode invocation
      // instead, since they cannot join that pipeline (see
      // runImplementationOrSealedV1's header). Provider/model fallback for
      // both paths lives in the coordinator's/runner's ranked selection.
      result = await runImplementationOrSealedV1({
        editActionKey: options.editActionKey ?? "implementation.v1",
        prompt,
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

  const logContent = `# Implementation Run\n\nStatus: ${result.status}\n\nFiles changed:\n${
    result.filesChanged.length > 0
      ? result.filesChanged.map((f) => `- ${f}`).join("\n")
      : "_none recorded_"
  }\n\n${result.summary ?? result.errorMessage ?? ""}`;

  const logUri = await writeRunLog(folderUri, result.runnerId, "impl", logContent);
  // No handle in scope here either — resolve the task's live root operation.
  taskOperations.setResultTargetUriForTask(folderUri.fsPath, logUri);

  if (result.status === "completed") {
    const implementationUri = getCanonicalImplementationUri(folderUri);
    const taskKey = normalizePath(folderUri.fsPath);

    if (!result.filesChangedUnknown && result.filesChanged.length === 0) {
      const resilience = getResilienceSettings();
      const priorProgress = await readTaskProgressAdvisoryV1(folderUri);
      // "Prior rounds already changed the tree": implReviewFiles is the
      // durable record of the last implementation round's real edits.
      const priorRoundsChangedTree = (priorProgress?.implReviewFiles?.length ?? 0) > 0;
      if (!resilience.nothingToFixRoutesToReview || !priorRoundsChangedTree) {
        NotificationRouter.showWarning(
          "Implementation finished, but no workspace files changed. " +
            "Review the implementation run log; the provider may have been blocked from writing files."
        );
        await safeOpenTextDocument(logUri, "implementation run log");
        return false;
      }
      // 2b: the model reported completion, prior rounds already changed the
      // tree, and it found no defect to fix — a correct implementer that
      // declines to fabricate work. Route onward to review/complete instead
      // of recording a spurious failure (observed five times; in every case
      // the model was behaving correctly).
      const zeroChangeRounds = (zeroChangeImplRoundsByTask.get(taskKey) ?? 0) + 1;
      zeroChangeImplRoundsByTask.set(taskKey, zeroChangeRounds);
      NotificationRouter.showInformation(
        "Implementation finished with no file changes — the model reported the current state already " +
          "satisfies the plan. Routing to review instead of recording a failure " +
          "(ensemble.resilience.nothingToFixRoutesToReview)."
      );
      // 2c: N consecutive zero-change rounds while the same blocker persists
      // is a loop producing no edits at all — stop and escalate rather than
      // running to fastForwardMaxIterations.
      if (
        shouldTripNoProgressBreaker({
          zeroChangeRounds,
          breakerRounds: resilience.noProgressBreakerRounds,
          history: priorProgress?.reviewScoreHistory,
        })
      ) {
        const escalated = await escalateReviewToHuman(
          folderUri,
          priorProgress?.currentStage ?? postRunReviewStage,
          "plateau",
          `${zeroChangeRounds} consecutive implementation round(s) changed zero files while the same ` +
            "blocker persisted (no-progress breaker, ensemble.resilience.noProgressBreakerRounds). " +
            "Automated iteration is no longer producing edits.",
          priorProgress?.reviewAttemptId ?? "",
          priorProgress ?? undefined,
          false
        );
        if (escalated) {
          zeroChangeImplRoundsByTask.delete(taskKey);
          return false;
        }
      }
    } else if (!result.filesChangedUnknown) {
      zeroChangeImplRoundsByTask.delete(taskKey);
    }

    const summary = result.summary?.trim();
    if (summary) {
      await writeTextFile(implementationUri, `${summary}\n`);
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
    await patchTaskProgressStrictV1(folderUri, (currentProgress) => {
      const alreadyAtOrPastImplementation =
        currentProgress.currentStage === "impl" ||
        isReviewStage(currentProgress.currentStage);
      const stageUpdated = alreadyAtOrPastImplementation
        ? currentProgress
        : { ...currentProgress, currentStage: "impl" as TaskStage };

      // filesChangedUnknown means THIS run's own change detection failed.
      // Leave implReviewFiles untouched rather than clearing it. A completed
      // zero-change round (reachable only under
      // ensemble.resilience.nothingToFixRoutesToReview) likewise preserves
      // the prior round's list — the review scope must still cover the work
      // those earlier rounds actually landed.
      if (!result!.filesChangedUnknown && result!.filesChanged.length > 0) {
        return { ...stageUpdated, implReviewFiles: result!.filesChanged };
      }
      return stageUpdated;
    });

    if (isReviewStage(postRunReviewStage)) {
      const reviewUri = artifactUri(folderUri, postRunReviewStage);
      if (reviewUri) {
        await markReviewArtifactStale(reviewUri, "workspace files");
      }
    }

    await safeOpenTextDocument(implementationUri, "plan-final.md");

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
    const dispatchReviewChainAfterLockRelease = (command: string): void => {
      void scheduleAutomationChain(
        {
          command,
          arg: { taskFolderPath: folderUri.fsPath },
          taskKey: folderUri.fsPath,
          chainId: "auto-review",
        },
        options.parentOperation
      );
    };
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
                  : "vs-code-ai-helper.runReviewWithAI"
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
            : "vs-code-ai-helper.runReviewWithAI"
        );
      }
    }
    return true;
  } else if (result.status === "cancelled") {
    NotificationRouter.showInformation("Implementation cancelled.");
    return false;
  } else {
    NotificationRouter.showError(
      `Implementation failed: ${result.errorMessage ?? "unknown error"}`
    );
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
  await runTrackedOperation(
    lockKey,
    { label: "Run Implementation", stage: "impl", kind: "run-implementation", cancellable: true },
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
        "No plan-final.md found. Advance to the Implementation stage first."
      );
      return;
    }

    // Merged checklist behavior: on a task's first implementation run, if
    // the implementation checklist hasn't been generated yet (no marker in
    // plan-final.md), generate it first and then implement. Re-runs (which
    // have implReviewFiles from an earlier run, and whose plan-final.md may
    // hold a post-run summary) never regenerate.
    const needsChecklist =
      !planFinalContent.includes(IMPLEMENTATION_CHECKLIST_MARKER) &&
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

    const contextPackContent = await generateContextPack(
      resolved.folderUri,
      workspaceRoot.uri
    );

    const prompt = await renderPromptTemplate(
      extensionUri,
      "run-implementation.md",
      { contextPack: contextPackContent, plan: planFinalContent }
    );

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
      }
    );
    }
  );
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
    vscode.commands.registerCommand(
      "vs-code-ai-helper.nextStage",
      (node?: TaskNodeArg) =>
        nextStage(context.extensionUri, context, node)
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
    { label: "Release", taskName: arg?.task?.folderName ?? path.basename(candidate), kind: "release" },
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
        ? "No plan found (or it is empty). Generate or write a plan first."
        : "No plan found (or it is empty). Generate or write a plan before reviewing implementation.",
    };
  }
  variables.plan = planContent;

  if (!isPlanReview) {
    // Read-only fallback (see the identical rationale in runReviewForFolder):
    // never materialize plan-final.md here as a side effect of rebuilding
    // second-opinion prompt variables.
    let implementationContent = await readNonEmptyText(getCanonicalImplementationUri(folderUri));
    if (!implementationContent) {
      implementationContent = await readNonEmptyText(getLegacyImplementationUri(folderUri));
    }
    if (!implementationContent) {
      return {
        ok: false,
        warning: "No implementation notes found (plan-final.md is missing or empty). Run the implementation step first.",
      };
    }
    variables.implementation = implementationContent;
    variables.verifiedChecks = await buildVerifiedChecksVariable(folderUri, undefined, operationToken);
  }

  const contextPackUri = isPlanReview
    ? await writeContextPack(folderUri, workspaceUri, false)
    : (
        await writeImplReviewContextPack(
          folderUri,
          workspaceUri,
          (await readTaskProgressAdvisoryV1(folderUri))?.implReviewFiles
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
  const claimed = await claimReviewAttempt(taskFolderUri, reviewAttemptId);
  if (!claimed) {
    return { ok: false, reason: "could not claim the review attempt (the task may have been paused)" };
  }

  const outcome = await coordinator.resumeAction({
    interaction: interactionRef,
    taskBinding: { taskBindingId: ref.taskBindingId, chatDocumentId: ref.chatDocumentId },
    taskStatus: ownedTask.progress.status ?? "active",
    taskStage: currentStage,
    resumeIdempotencyId,
    cancellationToken,
  });

  const variablesResult = await buildReviewResumeVariablesV1(
    taskFolderUri,
    workspaceFolderUri,
    targetStage,
    cancellationToken
  );
  if (!variablesResult.ok) {
    NotificationRouter.showWarning(variablesResult.warning);
  }

  await handleReviewOutcomeV1(outcome, {
    extensionUri,
    folderUri: taskFolderUri,
    workspaceUri: workspaceFolderUri,
    currentStage,
    targetStage,
    reviewUri,
    variables: variablesResult.ok ? variablesResult.variables : {},
    reviewAttemptId,
    chatViewProvider,
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
        { label: "Re-running review", stage, kind: "review" },
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
