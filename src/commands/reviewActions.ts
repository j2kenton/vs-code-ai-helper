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
} from "../utils/taskOperations";
import {
  EscalationKind,
  isPlanReviewStage,
  isReviewStage,
  PLAN_FILENAME,
  REVIEW_STAGES,
  STAGE_ARTIFACT_FILENAMES,
  STAGE_DISPLAY_NAMES,
  STAGE_ORDER,
  TaskStage,
} from "../types/taskProgress";
import { TaskProgress } from "../types/taskProgress";
import {
  appendReviewScoreHistory,
  findAllTasks,
  IncompleteTask,
  patchTaskProgress,
  readTaskProgress,
  updateImplReviewFiles,
  updateTaskProgressStage,
} from "../utils/taskProgressUtils";
import {
  advanceStage,
  computeNextStage,
} from "../utils/stageTransition";
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
  backupModelsForStage,
  checkImplementationAvailabilityForModel,
  recordActiveFallbackModel,
  resolveRunnerForModel,
  runImplementationForModel,
} from "../runners/runnerRegistry";
import { normalizeQualifiedModelId, qualifiedRanModelId } from "../runners/providers";
import { getQuotaObservation, recordQuotaObservation } from "../utils/quota";
import {
  resolveConfiguredReviewStages,
  resolveFreshModelForStage,
  resolveModelForStage,
} from "../utils/modelSelection";
import {
  getCanonicalImplementationUri,
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
import { meetsAutoAdvanceThreshold, parseReadiness, parseReviewBlockers } from "../utils/reviewReadiness";
import { scheduleAutomationChain, releaseAutomationChain } from "../utils/automationChain";
import { buildVerifiedChecksSection, collectCompletionLintPreview, resolvePublishScopeFolder } from "../utils/completionLint";
import { checkPublishPreflight } from "../utils/publishPreflight";
import { improveReviewScore } from "../utils/reviewScoreLoop";
import {
  decideReviewRoute,
  detectPlateau,
  REVIEW_RUBRIC_BLOCKER_SCORE_CAP,
  rubricCapLikelyBlockedAdvance,
} from "../utils/reviewRouting";
import { escalateReviewToHuman } from "../utils/reviewEscalation";
import { getConfiguredBackupModelsForStage } from "../runners/runnerRegistry";
import {
  getAutoAdvanceMode,
  getAutoAdvanceScoreThreshold,
  isAutoImplementAfterReviewEnabled,
  getAutoReviewAfterImplementationMode,
  getCompleteAndMoveOnTriggersAIMode,
  getFastForwardMaxIterations,
  getFastForwardStopLevel,
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
  return patchTaskProgress(folderUri, (current) => {
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
      /**
       * Carried only by automation-chain dispatches that landed on the
       * Publish stage through an auto-publish-eligible transition (see
       * AUTO_PUBLISH_ELIGIBLE_KINDS). When set, a Publish review (including
       * every re-review inside a Fast Forward loop) that clears the
       * auto-advance score threshold schedules the publish command
       * (commit and push) itself. Never set by UI surfaces.
       */
      autoPublishOnSuccess?: boolean;
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

/**
 * Extract the chained auto-publish-on-success request from a
 * ReviewCommandArg, if present. Defaults to false for any arg shape that
 * doesn't explicitly carry it (including all UI-triggered invocations).
 */
function chainedAutoPublishOnSuccess(arg: ReviewCommandArg): boolean {
  return !!(
    arg &&
    typeof arg === "object" &&
    "autoPublishOnSuccess" in arg &&
    arg.autoPublishOnSuccess
  );
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
  /**
   * Skip runReviewForFolder's own review-owned auto-publish dispatch (the
   * "auto-publish" scheduleAutomationChain calls gated on
   * `transition.shouldAutoPublish` / `options.autoPublishOnSuccess`).
   * Threaded alongside ExecuteImplementationRunOptions.suppressAutoReviewDispatch
   * for the same reason: a caller that owns a multi-attempt loop over several
   * internal re-review passes (e.g. a future Fast Forward step that wants to
   * defer publish scheduling until the whole loop — not just one internal
   * attempt — has settled) can suppress the per-attempt dispatch and decide
   * when to schedule it itself. Not currently set by any call site; this is
   * the plumbing for that case, off (undefined) everywhere today, so it
   * changes no existing dispatch behavior.
   */
  suppressAutoPublishDispatch?: boolean;
}

interface ExecuteImplementationRunOptions {
  /** Skip the pre-run dirty/non-git workspace confirmation. */
  skipPreRunSafetyCheck?: boolean;
  /** Preserve a stage's active fallback reservation across one internal retry loop. */
  preserveActiveFallback?: boolean;
  onBusyDetail?: (detail: string | undefined) => void;
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
}

/**
 * Fast-forward review is one user action that can trigger several internal
 * apply/re-review attempts. Only the first attempt is a fresh invocation;
 * later attempts should reuse any fallback activated earlier in the same loop.
 */
export function buildFastForwardApplyReviewOptions(
  attemptNumber: number,
  parentOperation?: TaskOperationHandle
): ApplyReviewOptions {
  const preserveActiveFallback = attemptNumber > 1;
  return {
    skipImplementationSafetyCheck: preserveActiveFallback,
    preserveActiveFallback,
    parentOperation,
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
 * to `readTaskProgress` → `vscode.Uri.joinPath`, which would throw before
 * the function's `try/catch`. Requiring `task.folderUri` to be truthy here
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
  progress: NonNullable<Awaited<ReturnType<typeof readTaskProgress>>>;
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
    const progress = await readTaskProgress(folderUri);
    if (!progress) {
      NotificationRouter.showError(
        `Could not read task progress for ${node.task.folderName}.`
      );
      return undefined;
    }
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

  const combinedTasks: IncompleteTask[] = [];
  for (const wsFolder of allWorkspaceFolders) {
    // Attempt to discover tasks using the configured path, or the default meta root.
    const metaFolderUri = vscode.Uri.joinPath(wsFolder.uri, getConfiguredTaskRoot());

    try {
      const wsTasks = await findAllTasks(metaFolderUri);
      combinedTasks.push(...wsTasks);
    } catch {
      // Skip workspace folders where the meta folder doesn't exist
    }

    // Also check legacy plans/ folder if different
    try {
      const legacyUri = vscode.Uri.joinPath(wsFolder.uri, "plans");
      if (legacyUri.fsPath !== metaFolderUri.fsPath) {
        const legacyTasks = await findAllTasks(legacyUri);
        combinedTasks.push(...legacyTasks);
      }
    } catch {
      // Ignore errors reading legacy folder
    }
  }

  const eligible = combinedTasks.filter((task) =>
    eligibleStages.includes(task.progress.currentStage)
  );
  if (eligible.length === 0) {
    NotificationRouter.showInformation(
      combinedTasks.length === 0
        ? "No task folders found. Use 'Start New Task' to create one."
        : "No tasks are at a stage eligible for this action."
    );
    return undefined;
  }

  // A no-arg invocation (keyboard shortcut, command palette, an auto-advance
  // chain that doesn't thread a folder through) has no explicit target. When
  // exactly one task is eligible, auto-picking it is safe only if it's also
  // the task the user is actually working on — otherwise a generic shortcut
  // can silently run against an unrelated task that just happens to be the
  // sole one sitting at an eligible stage right now, with no confirmation.
  // Cross-check against the persisted current-task pointer; fall through to
  // the picker (even for a single item) on any mismatch, so the user
  // explicitly confirms rather than the command guessing for them.
  const soleEligible = eligible.length === 1 ? eligible[0] : undefined;
  const currentTaskId = new CurrentTaskStore(context.workspaceState).get();
  const autoPickable =
    soleEligible !== undefined &&
    (!currentTaskId ||
      currentTaskId === (soleEligible.canonicalId ?? normalizePath(soleEligible.folderUri.fsPath)));

  let picked: IncompleteTask | undefined;
  if (autoPickable) {
    picked = soleEligible;
  } else {
    const items = eligible.map((task) => ({
      label: task.folderName,
      description: `Stage: ${STAGE_DISPLAY_NAMES[task.progress.currentStage]}`,
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
  return { folderUri: picked.folderUri, progress: picked.progress };
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
  progress: NonNullable<Awaited<ReturnType<typeof readTaskProgress>>>
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
async function isGitWorkspace(cwd: string): Promise<boolean> {
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
async function getUnrelatedWorkspaceChanges(
  cwd: string,
  taskFolderUri: vscode.Uri
): Promise<string[]> {
  const progress = await readTaskProgress(taskFolderUri).catch(() => undefined);
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
 * Shared boilerplate for every AI command: availability check, progress
 * notification, prompt render, run, run log, result handling. Returns true
 * when the run completed successfully.
 *
 * `logStage` controls which stage label is used for run logs and progress
 * messages. `executionStage`, when provided, controls which model is resolved
 * for the run — this lets plan-review apply log under the review stage while
 * executing with the `plan` model, and implementation-review apply log under
 * the review stage while executing with the `implementation` model.
 *
 * Applies the prompt-size gate (high-context confirm + hard ceiling) before
 * launching the provider process. The prompt is built here so its size is
 * measured on the exact string that will be sent.
 *
 * `validateOutput`, when provided, is run against the CLI's response before
 * it is accepted as a success. A provider process can exit 0 with non-empty
 * text that never actually performed the requested task (e.g. a model that
 * responds with a clarifying question instead of writing the review) —
 * `runner.run` has no way to tell that apart from a real answer, so this is
 * the only place callers who care about a specific output shape can reject
 * it. On failed validation the response is discarded (written only to a
 * staged temp file that gets deleted, never to `outputFileUri`), the
 * promoted artifact is left exactly as it was before this call, other
 * configured backup models are retried in turn (see the retry loop below),
 * and the run is reported as not completed only once every candidate has
 * failed validation.
 */
async function runAiToFile(options: {
  extensionUri: vscode.Uri;
  taskFolderUri: vscode.Uri;
  workspaceUri: vscode.Uri;
  /** Stage used for run-log labels and progress messages. */
  logStage: TaskStage;
  /**
   * Stage used for model resolution. When absent, falls back to `logStage`.
   * Use this to separate "what stage label shows in the log" from "which
   * model is selected for execution".
   */
  executionStage?: TaskStage;
  templateFile: string;
  variables: Record<string, string>;
  outputFileUri: vscode.Uri;
  /** e.g. "Running Plan: High-Level Review" — provider name is appended. */
  progressAction: string;
  outputLabel: string;
  /**
   * Optional shape check for the CLI's response. Returns a human-readable
   * `reason` when invalid so it can be surfaced in the error message.
   */
  validateOutput?: (content: string) => { valid: boolean; reason: string };
  /** Defer publication until the caller has completed its CAS/state checks. */
  promoteOutput?: boolean;
  onValidatedOutput?: (content: string) => void;
  /** Preserve a stage's active fallback reservation across one internal retry loop. */
  preserveActiveFallback?: boolean;
  /**
   * The review-attempt token this call claimed via claimReviewAttempt,
   * checked between backup candidates in the retry loop below: a newer
   * attempt claiming the stage always wins the final CAS at advanceStage
   * regardless (a late result can never itself corrupt anything), but
   * without this check an older, already-superseded attempt would keep
   * burning full agentic CLI runs against every remaining configured
   * backup — real quota spent on an artifact that can never be published —
   * before that final CAS ever gets a chance to reject it. Absent for
   * callers with no review-attempt concept (e.g. plan generation), which
   * skip the check entirely.
   */
  reviewAttemptId?: string;
}): Promise<boolean> {
  const modelStage = options.executionStage ?? options.logStage;
  const model = options.preserveActiveFallback
    ? await resolveModelForStage(options.taskFolderUri, modelStage)
    : await resolveFreshModelForStage(options.taskFolderUri, modelStage);
  if (!model.modelId) {
    NotificationRouter.showWarning(
      `No model is configured for ${modelStage}. Open Ensemble Settings and choose a primary model before continuing.`,
      undefined,
      undefined,
      undefined,
      { command: "vs-code-ai-helper.openSettings", title: "Open Settings" }
    );
    return false;
  }
  // Snapshot the retry set before any async prompt rendering or confirmation.
  // The runner captures the same settings synchronously just below, and this
  // snapshot is then used for both quota disclosure and content retries, so a
  // settings edit while the primary is running cannot silently expand fan-out.
  const configuredBackupModels = backupModelsForStage(modelStage, model.modelId);
  const { runner, providerLabel, nativeModelId } = resolveRunnerForModel(
    model.modelId,
    modelStage,
    options.taskFolderUri,
    options.reviewAttemptId
  );
  // Build the prompt here so we can apply the size gate before launching.
  const prompt = await renderPromptTemplate(
    options.extensionUri,
    options.templateFile,
    options.variables
  );

  // ── Prompt-size gate ─────────────────────────────────────────────────────
  // Every stage-aware runner can retry this prompt against configured backups
  // on quota or availability failure. Callers that validate content can also
  // use that same list for a content-validation retry below, but candidates
  // are de-duplicated so the list remains the maximum fan-out to disclose.
  const configuredBackupCount = configuredBackupModels.length;
  const sizeCheck = await checkAndConfirmPromptSize(prompt, providerLabel, configuredBackupCount);
  if (sizeCheck === "abort" || sizeCheck === "declined") {
    return false;
  }

  let completed = false;
  // Providers write their response to the requested path.  Isolate that
  // write until the response has passed validation and this run still owns
  // the stage; otherwise a stale concurrent review can clobber the accepted
  // artifact before its CAS is rejected.
  const stagedOutputUri = options.validateOutput
    ? vscode.Uri.joinPath(vscode.Uri.file(path.dirname(options.outputFileUri.fsPath)), `.${path.basename(options.outputFileUri.fsPath)}.${crypto.randomUUID()}.tmp`)
    : options.outputFileUri;
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      // Deliberately does not name a provider: VS Code's Window progress
      // title is fixed for the whole withProgress call and has no API to
      // revise it later, but a backup retry below can switch which provider
      // is actually running. Naming it here would keep showing the primary
      // (and its quota) for however long a backup then runs — the provider
      // + quota attribution instead lives in progress.report's `message`,
      // which IS updated per-candidate (see below and the backup retry). No
      // trailing "..." here either: ProgressLocation.Window renders title
      // and message joined as "title: message", and the message (below)
      // always supplies its own "..." — a second one on the title would
      // double up mid-sentence.
      title: options.progressAction,
      cancellable: true,
    },
    async (progress, token) => {
      NotificationRouter.emitProgressSummary(
        `${options.progressAction} with ${providerLabel}...`,
        taskOperations.rootOperationIdFor(options.taskFolderUri.fsPath)
      );
      progress.report({ message: `Waiting for ${providerLabel} response (uses your ${providerLabel} quota)...` });

      // The run — and every backup retry attempt below — must also honor the
      // tracked operation's cancellation token (the Notifications-section
      // cancel button), not just the native progress token. One link covers
      // the whole function so a cancel raised between attempts is seen by
      // the retry loop's own guard, not only by whichever run() call happens
      // to be in flight at the time.
      const linked = linkCancellationTokens(
        token,
        taskOperations.tokenFor(options.taskFolderUri.fsPath)
      );
      try {
        // Captured immediately before the primary run — see the retry
        // loop's quota-observation skip below, which uses this (not a fixed
        // time window) to tell "this backup was burned by MY OWN cascade,
        // during this very call" from "this is a stale observation left
        // over from earlier in the session."
        const primaryRunStartedAt = Date.now();
        const result: Awaited<ReturnType<typeof runner.run>> = await runner.run(
          {
            taskFolderUri: options.taskFolderUri,
            workspaceUri: options.workspaceUri,
            stage: options.logStage,
            prompt,
            outputFile: stagedOutputUri,
            modelId: nativeModelId,
          },
          linked.token
        );

        const runLogUri = await writeRunLog(
          options.taskFolderUri,
          runner.id,
          options.logStage,
          `# Prompt\n\n${prompt}\n\n# Result\n\nStatus: ${result.status}\n\n${
            result.summary ?? result.errorMessage ?? ""
          }`
        );
        // This call site never receives the operation handle — resolve the
        // task's live root operation directly (mirrors taskOperations.tokenFor
        // above, used for the same reason).
        taskOperations.setResultTargetUriForTask(options.taskFolderUri.fsPath, runLogUri);

        if (result.status === "cancelled") {
          NotificationRouter.showInformation(
            `${options.outputLabel} generation cancelled.`
          );
          return;
        }

        if (result.status !== "completed") {
          // A genuine provider/transport failure. resolveRunnerForModel's own
          // runner already cascaded through the stage's quota/unavailable-
          // triggered backups (when configured) before returning this, so
          // there is nothing more to retry here — report it as-is.
          NotificationRouter.showError(
            `${options.outputLabel} generation failed: ${
              result.errorMessage ?? "unknown error"
            }.`
          );
          return;
        }

        let newContent = new TextDecoder().decode(
          await vscode.workspace.fs.readFile(stagedOutputUri)
        );
        let validation = options.validateOutput?.(newContent);
        let acceptedProviderLabel = providerLabel;
        let acceptedSummary = result.summary;
        // Tracks whichever candidate `validation` currently describes —
        // distinct from acceptedProviderLabel, which only ever names the
        // provider of content that actually validated. Without this, a final
        // failure message after every backup was also rejected would keep
        // naming the primary provider while quoting the last backup's
        // rejection reason.
        let lastTriedProviderLabel = providerLabel;

        // Content-shape validation (e.g. a review missing its required
        // "Readiness: N/10" line) is invisible to resolveRunnerForModel's own
        // quota/unavailable cascade above: that wrapper only reacts to
        // CliExecResult.status/failureKind, so a model that exits cleanly
        // with unusable content — a response truncated mid-stream by a
        // rate-limited free-tier model, or a clarifying question instead of
        // a review (verified live: opencode's "kimi-k3" backup model has
        // done both) — is never handed off to a backup there. Retry across
        // the stage's OTHER configured backups here, one at a time, gated on
        // the SAME "switch-to-backup" strategy the quota cascade honors —
        // a user who opted into "pause-and-resume"/"alert-and-wait" for this
        // stage has explicitly opted OUT of an automatic provider swap here
        // too, so backupModelsForStage (not the second-opinion mechanism's
        // strategy-agnostic getConfiguredBackupModelsForStage) is the right
        // source list. Each candidate is resolved without a `stage` argument
        // (mirrors runSecondOpinionReview) so it is not wrapped in its own
        // nested cascade. Only fires when the caller validates content at
        // all — the plan-rewrite call (no validateOutput) is unaffected and
        // keeps its original single-attempt behavior.
        let cancelledDuringRetry = false;
        let supersededDuringRetry = false;
        if (validation && !validation.valid) {
          // Exclude whichever model actually produced this content, not just
          // the configured primary: resolveRunnerForModel's own cascade may
          // have already silently substituted a backup before returning
          // here, and retrying that same backup a second time would waste a
          // whole attempt confirming what is already known. Normalized so a
          // "(CLI default)" entry (native id undefined) and a legacy-aliased
          // entry both compare equal to their canonical form — see
          // qualifiedRanModelId.
          const ranModelId = qualifiedRanModelId(result);
          const alreadyTriedModelIds = new Set(
            [model.modelId, ranModelId]
              .filter((id): id is string => id !== undefined)
              .map((id) => normalizeQualifiedModelId(id))
          );
          // True when the model that actually produced `result` differs from
          // the primary model this call requested — i.e. resolveRunnerForModel's
          // OWN quota/unavailable cascade (inside the `runner.run()` call
          // above) already silently substituted a backup and, per its own
          // bookkeeping (runnerRegistry.ts's runBackups), already called
          // recordActiveFallbackModel for it — BEFORE this retry loop, which
          // only reacts to content shape, ever ran. In that case this exact
          // call already legitimately owns the stage's fallback reservation
          // for its own primary attempt. The atomic persistence below may
          // therefore replace that call's known-bad active model once this
          // loop finds a response that actually validates.
          const primaryCascadeAlreadySubstitutedBackup =
            ranModelId !== undefined &&
            ranModelId !== normalizeQualifiedModelId(model.modelId);
          for (const backupModelId of configuredBackupModels) {
            if (linked.token.isCancellationRequested) {
              cancelledDuringRetry = true;
              break;
            }
            // Each candidate here is a full agentic CLI run (routinely
            // minutes long), so re-check between them whether a newer review
            // attempt has already claimed this stage — the final CAS at
            // advanceStage would reject this run's result anyway once it
            // finishes, but only after every remaining backup below had
            // already been spent chasing an artifact that can never be
            // published. Skipped entirely for callers with no review-attempt
            // concept (reviewAttemptId absent). Only a SUCCESSFUL read
            // naming a different attempt counts as supersession —
            // readTaskProgress returns undefined on any read/parse failure
            // (plausible mid-retry-sequence, e.g. racing a concurrent
            // patchTaskProgress read-modify-write on Windows), which is
            // missing evidence, not proof a newer attempt exists; treating
            // it as supersession would abandon every remaining backup and
            // tell the user a newer attempt started when none did.
            if (options.reviewAttemptId) {
              const currentProgress = await readTaskProgress(options.taskFolderUri);
              if (currentProgress && currentProgress.reviewAttemptId !== options.reviewAttemptId) {
                supersededDuringRetry = true;
                break;
              }
            }
            if (alreadyTriedModelIds.has(normalizeQualifiedModelId(backupModelId))) {
              continue;
            }
            // resolveRunnerForModel's OWN quota/unavailable cascade (above,
            // for the primary) may have already walked past — and burned —
            // one or more of these same backups before landing on the
            // content-invalid result being retried here; recordQuotaObservation
            // recorded each of those moments ago. Skip anything known
            // exhausted/unavailable from THAT observation rather than
            // re-spending it. Gated on it having been recorded DURING this
            // very call (at/after primaryRunStartedAt, captured immediately
            // before the primary run() above), not on a fixed time window:
            // quota.ts's observations are explicitly "a live signal, not a
            // persisted ledger" with no expiry of their own, so an
            // observation left over from earlier in the same extension-host
            // session (a quota window that reset hours ago) must not
            // permanently disqualify a backup. A fixed window doesn't work
            // either — the cascade's own runs (recorded here as the primary
            // `result`) are full agentic CLI calls that can easily run
            // longer than any reasonable window, ageing a moments-ago
            // observation out before this loop ever reaches it. Anchoring to
            // this call's own start time instead means the check is exactly
            // "did MY OWN cascade, earlier in THIS call, already burn this
            // backup" — true regardless of how long anything since has run.
            const observation = getQuotaObservation(modelStage, backupModelId);
            if (
              observation &&
              new Date(observation.observedAt).getTime() >= primaryRunStartedAt &&
              (observation.state === "exhausted" || observation.state === "unavailable")
            ) {
              continue;
            }

            let backup: ReturnType<typeof resolveRunnerForModel>;
            let backupResult: Awaited<ReturnType<typeof runner.run>>;
            try {
              backup = resolveRunnerForModel(backupModelId, undefined, options.taskFolderUri);
              const backupAvailability = await backup.runner.isAvailable();
              if (!backupAvailability.available) {
                continue;
              }
              progress.report({ message: `Retrying with ${backup.providerLabel} (backup, uses your ${backup.providerLabel} quota)...` });
              NotificationRouter.emitProgressSummary(
                `${options.progressAction} with ${backup.providerLabel} (backup)...`,
                taskOperations.rootOperationIdFor(options.taskFolderUri.fsPath)
              );
              backupResult = await backup.runner.run(
                {
                  taskFolderUri: options.taskFolderUri,
                  workspaceUri: options.workspaceUri,
                  stage: options.logStage,
                  prompt,
                  outputFile: stagedOutputUri,
                  modelId: backup.nativeModelId,
                },
                linked.token
              );
            } catch {
              // A flaky candidate — resolveRunnerForModel/isAvailable/run
              // itself throwing — must not abort the whole retry sequence,
              // same rationale as runSecondOpinionReview's identical guard.
              continue;
            }

            // A newer review can claim the stage while this full backup run
            // is in flight. Re-check before accepting its result or updating
            // fallback routing state: advanceStage's final CAS protects the
            // review artifact, but it cannot undo an earlier fallback-state
            // write made by this superseded attempt.
            if (options.reviewAttemptId) {
              const currentProgress = await readTaskProgress(options.taskFolderUri);
              if (currentProgress && currentProgress.reviewAttemptId !== options.reviewAttemptId) {
                supersededDuringRetry = true;
                break;
              }
            }

            // Once run() has actually returned, everything below is
            // bookkeeping around an already-obtained result. writeRunLog and
            // setResultTargetUriForTask are real I/O (can throw, e.g. a
            // transient file-lock error) and are best-effort only — wrapped
            // so a logging hiccup can never propagate out of this loop and
            // abort a run that may already hold a validated response.
            try {
              const backupLogUri = await writeRunLog(
                options.taskFolderUri,
                backup.runner.id,
                options.logStage,
                `# Prompt\n\n${prompt}\n\n# Result\n\nStatus: ${backupResult.status}\n\n${
                  backupResult.summary ?? backupResult.errorMessage ?? ""
                }`
              );
              taskOperations.setResultTargetUriForTask(options.taskFolderUri.fsPath, backupLogUri);
            } catch {
              // Best-effort — see comment above.
            }

            if (backupResult.status === "cancelled") {
              // Terminal, same as the primary path above — do not spend
              // further backups once the user has actually cancelled, and
              // report it as a cancellation rather than a validation
              // failure (see cancelledDuringRetry below). Recorded as neither
              // a quota nor a temporary-unavailable observation below (a
              // cancellation never actually observed the provider's quota
              // state) — checked before recordQuotaObservation so a
              // cancelled run can't be misrecorded as "ok" and overwrite a
              // genuine recent "exhausted"/"unavailable" observation for
              // this same backup.
              cancelledDuringRetry = true;
              break;
            }
            recordQuotaObservation(modelStage, backupModelId, backupResult.failureKind, backupResult.errorMessage);
            if (backupResult.status !== "completed") {
              continue;
            }

            let backupContent: string;
            try {
              backupContent = new TextDecoder().decode(
                await vscode.workspace.fs.readFile(stagedOutputUri)
              );
            } catch {
              // The staged file vanished or is unreadable despite a
              // "completed" status — a flaky candidate, try the next one.
              continue;
            }
            const backupValidation = options.validateOutput?.(backupContent);
            lastTriedProviderLabel = backup.providerLabel;
            if (backupValidation && !backupValidation.valid) {
              validation = backupValidation;
              continue;
            }
            newContent = backupContent;
            validation = backupValidation;
            acceptedProviderLabel = backup.providerLabel;
            acceptedSummary = backupResult.summary;
            // Persist the validated route in one locked compare-and-set. The
            // review-attempt check must be inside that same state mutation:
            // a separate read above cannot prevent a newer attempt claiming
            // the stage between the read and this write. A reservation may be
            // replaced when this call's own cascade created it, or when this
            // preserved iteration started from that exact active model;
            // otherwise the existing reservation still wins. Either way,
            // routing persistence remains best-effort and never discards the
            // validated review itself.
            try {
              await recordActiveFallbackModel(
                options.taskFolderUri,
                modelStage,
                backupModelId,
                {
                  expectedReviewAttemptId: options.reviewAttemptId,
                  requireUnreserved: !primaryCascadeAlreadySubstitutedBackup,
                  // A preserved Fast Forward route is this attempt's actual
                  // starting model, not an unrelated reservation. If that
                  // model produced invalid content, atomically replace it
                  // with the backup that just validated. The registry still
                  // rejects the write if the active route changed to a
                  // different named model while this backup was running.
                  replaceActiveModelId: options.preserveActiveFallback
                    ? model.modelId
                    : undefined,
                }
              );
            } catch {
              // Best-effort — see comment above.
            }
            break;
          }
        }

        if (cancelledDuringRetry) {
          NotificationRouter.showInformation(
            `${options.outputLabel} generation cancelled.`
          );
        } else if (supersededDuringRetry) {
          NotificationRouter.showInformation(
            `${options.outputLabel} generation stopped: a newer review attempt for this stage has already started.`
          );
        } else if (validation && !validation.valid) {
          NotificationRouter.showError(
            `${options.outputLabel} generation from ${lastTriedProviderLabel} did not produce a valid result ` +
              `(${validation.reason}). The provider may not have followed the instructions — try again.`
          );
        } else {
          options.onValidatedOutput?.(newContent);
          if (options.promoteOutput !== false && stagedOutputUri.fsPath !== options.outputFileUri.fsPath) {
            await writeTextFile(options.outputFileUri, newContent);
          }
          completed = true;
          if (options.promoteOutput !== false) {
            await safeOpenTextDocument(options.outputFileUri, options.outputLabel);
          }
          NotificationRouter.showInformation(
            `${options.outputLabel} generated with ${acceptedProviderLabel} (${
              acceptedSummary ?? ""
            })`
          );
        }
      } finally {
        linked.dispose();
        if (stagedOutputUri.fsPath !== options.outputFileUri.fsPath) {
          try { await vscode.workspace.fs.delete(stagedOutputUri, { useTrash: false }); } catch { /* best effort */ }
        }
      }
    }
  );
  return completed;
}

/**
 * Safe stage-advance helper that uses `patchTaskProgress` to avoid
 * overwriting unrelated fields.
 */
async function setStage(
  folderUri: vscode.Uri,
  newStage: TaskStage
): Promise<void> {
  await patchTaskProgress(folderUri, (current) => {
    if (current.currentStage === newStage) {
      return current;
    }
    return updateTaskProgressStage(current, newStage);
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
 * Run one review round against a model different from the stage's primary —
 * the deliberate second-opinion mechanism (see decideReviewRoute's
 * "second-opinion" route). Mirrors runAiPlanVerification's pattern in
 * completionLint.ts: resolve a runner directly and execute to a scratch
 * output file, rather than going through runAiToFile/the promoted-artifact
 * machinery, since this must never touch the promoted review artifact or
 * its CAS/backup bookkeeping — it is purely diagnostic input to a routing
 * decision, never itself published.
 *
 * Deliberately always uses the INITIAL review template (REVIEW_PROMPTS),
 * never whatever re-review template the primary round used, and strips
 * `previousReview` out of the rendered variables. By the time a plateau can
 * even be detected the primary is almost always mid re-review — reusing its
 * template/variables would hand the second opinion the previous review and
 * explicit instructions to "reconcile every blocker from the previous
 * review," steering it to agree rather than form the independent verdict
 * this mechanism exists to get. Everything else (context pack, plan,
 * implementation, verifiedChecks) is still shared, since the second opinion
 * should judge the same code, just without being anchored to the primary's
 * own prior conclusions.
 *
 * Tries each configured backup in order and returns the first one that
 * actually produces parseable output; returns undefined if none are
 * available or none complete successfully (callers treat that as "no second
 * opinion could be obtained" and escalate on the primary review alone), or
 * if the enclosing operation is cancelled while a candidate is being tried.
 */
async function runSecondOpinionReview(
  extensionUri: vscode.Uri,
  folderUri: vscode.Uri,
  workspaceUri: vscode.Uri,
  targetStage: TaskStage,
  variables: Record<string, string>,
  outerToken: vscode.CancellationToken | undefined
): Promise<{ content: string; modelId: string } | undefined> {
  const initialTemplateFile = REVIEW_PROMPTS[targetStage];
  if (!initialTemplateFile) {
    return undefined;
  }
  const { previousReview: _previousReview, ...independentVariables } = variables;
  const primary = await resolveModelForStage(folderUri, targetStage);
  // getConfiguredBackupModelsForStage, not backupModelsForStage: the latter
  // only returns anything when strategy === "switch-to-backup" — the quota-
  // fallback opt-in. A user configuring backups under "pause-and-resume" or
  // "alert-and-wait" (i.e. explicitly opting OUT of automatic quota
  // switch-over) still has models genuinely configured and available for a
  // deliberate second opinion, which is a different question from "should a
  // quota failure silently switch providers".
  const candidates = getConfiguredBackupModelsForStage(targetStage, primary.modelId);
  const prompt = await renderPromptTemplate(extensionUri, initialTemplateFile, independentVariables);
  for (const candidateModelId of candidates) {
    if (outerToken?.isCancellationRequested) {
      return undefined;
    }
    let resolved: ReturnType<typeof resolveRunnerForModel>;
    try {
      // No `stage` argument: resolveRunnerForModel only adds its own
      // backup-fallback wrapping when given one. This candidate was already
      // chosen from the stage's backup list above — wrapping it in another
      // layer of automatic fallback could let the run silently execute
      // against one of ITS backups instead, so the modelId reported back
      // to the caller (and shown in the escalation reason) would name a
      // model that never actually ran.
      resolved = resolveRunnerForModel(candidateModelId, undefined, folderUri);
    } catch {
      continue;
    }
    let availability: Awaited<ReturnType<typeof resolved.runner.isAvailable>>;
    try {
      availability = await resolved.runner.isAvailable();
    } catch {
      // A throwing isAvailable() (a runner bug, a network error checking
      // auth status) must not escape this loop: it would propagate up
      // through handleReviewRoutingOutcome's own try/catch and abandon the
      // ENTIRE escalation for this round — including the direct-escalate
      // path this second-opinion attempt was itself already a step inside
      // of — leaving nothing recorded and the plateau silently unresolved.
      // Treat a flaky candidate as unavailable and try the next one.
      continue;
    }
    if (!availability.available) {
      continue;
    }
    const outputFile = vscode.Uri.file(
      path.join(folderUri.fsPath, `.second-opinion.${crypto.randomUUID()}.tmp.md`)
    );
    // Linked to the enclosing operation's token (when it has one) so
    // cancelling the review/Fast Forward from the UI actually stops this
    // AI call instead of leaving it running orphaned while still holding
    // the task's exclusive operation lock.
    const linked = linkCancellationTokens(outerToken);
    try {
      const result = await resolved.runner.run(
        {
          taskFolderUri: folderUri,
          workspaceUri,
          stage: targetStage,
          prompt,
          outputFile,
          modelId: resolved.nativeModelId,
        },
        linked.token
      );
      if (result.status !== "completed") {
        continue;
      }
      let output = "";
      try {
        output = new TextDecoder().decode(await vscode.workspace.fs.readFile(outputFile));
      } catch {
        continue;
      }
      if (!output.trim() || parseReadiness(output).score === null) {
        continue;
      }
      return { content: output, modelId: candidateModelId };
    } catch {
      // A throwing run() (network failure, runner crash) must not escape
      // this loop for the same reason a throwing isAvailable() must not —
      // see above. Try the next candidate instead of abandoning the whole
      // escalation this attempt was itself already a step inside of.
      //
      // Cancellation does NOT reach this catch: AgentRunner.run()'s
      // contract (agentRunner.ts) reports it as a resolved
      // `{ status: "cancelled" }`, never a thrown CancellationError — both
      // concrete runners (CliAgentRunner, CopilotLanguageModelRunner) honor
      // this. That result already falls through the `result.status !==
      // "completed"` check above into `continue`, and is caught for real by
      // the `outerToken?.isCancellationRequested` check at the top of this
      // loop on the next iteration. An earlier version of this catch had a
      // `CancellationError`-specific branch here; it could never fire.
      continue;
    } finally {
      linked.dispose();
      try {
        await vscode.workspace.fs.delete(outputFile);
      } catch {
        // Already absent (run failed before writing) — nothing to clean up.
      }
    }
  }
  return undefined;
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
 * Only takes the second opinion — a `primaryBlockers` parameter existed in
 * an earlier version, but this function's only call site is reached solely
 * when the primary review has at least one task-fixable blocker (that's
 * exactly what routes to "second-opinion" rather than a direct "escalate" —
 * see decideReviewRoute), so "primary reports only non-fixable blockers"
 * can never be true here. A predicate keyed on that was dead code.
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
  extensionUri: vscode.Uri;
  folderUri: vscode.Uri;
  workspaceUri: vscode.Uri;
  targetStage: TaskStage;
  variables: Record<string, string>;
  reviewAttemptId: string;
  content: string;
  score: number | null;
  threshold: number;
  /** The enclosing tracked operation's cancellation token, when it has one
   * (registered `cancellable: true`) — linked into the second-opinion AI
   * call so cancelling the review/Fast Forward from the UI actually stops
   * it instead of leaving it running orphaned while still holding the
   * task's exclusive operation lock. */
  cancellationToken: vscode.CancellationToken | undefined;
}): Promise<{ escalated: boolean }> {
  const { extensionUri, folderUri, workspaceUri, targetStage, variables, reviewAttemptId, content, score, threshold, cancellationToken } = options;
  try {
    const blockers = parseReviewBlockers(content);
    const progressBefore = await readTaskProgress(folderUri);
    if (!progressBefore) {
      return { escalated: false };
    }
    const historyEntry = {
      stage: targetStage,
      score,
      attemptId: reviewAttemptId,
      at: new Date().toISOString(),
      blockerCount: blockers.length,
      taskFixableCount: blockers.filter((b) => b.resolver === "task-fixable").length,
    };
    const updated = await patchTaskProgress(folderUri, (current) =>
      appendReviewScoreHistory(current, historyEntry)
    );
    if (!updated) {
      return { escalated: false };
    }

    const plateauWindow = getReviewPlateauRounds();
    const plateaued = detectPlateau(updated.reviewScoreHistory ?? [], targetStage, plateauWindow);
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
      NotificationRouter.showInformation(
        `${STAGE_DISPLAY_NAMES[targetStage]} review has plateaued at ${score}/10 — getting an independent second opinion before escalating.`
      );
      const secondOpinion = await runSecondOpinionReview(extensionUri, folderUri, workspaceUri, targetStage, variables, cancellationToken);
      if (!secondOpinion) {
        const escalated = await escalateReviewToHuman(
          folderUri,
          targetStage,
          "plateau",
          `${decision.reason} No alternate model was available to get a second opinion.`,
          reviewAttemptId,
          updated,
          true
        );
        return { escalated };
      }
      const reconciled = reconcileSecondOpinion(secondOpinion);
      const escalated = await escalateReviewToHuman(folderUri, targetStage, reconciled.kind, reconciled.reason, reviewAttemptId, updated, true);
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
 *   Legacy tasks that still have only `implementation.md` are handled via
 *   `materializeCanonicalIfNeeded`: the legacy file is copied to plan-final.md
 *   before the review starts, so subsequent reads always see the canonical
 *   path. This mirrors the same migration path used by generateImplementationWithAI
 *   and runImplementationWithAI.
 */
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
    /**
     * When set, a Publish review (targetStage "publish", which has no
     * further stage to auto-advance into) that clears the auto-advance score
     * threshold schedules the publish command (commit and push) itself —
     * the review-owned auto-publish path. See AUTO_PUBLISH_ELIGIBLE_KINDS.
     */
    autoPublishOnSuccess?: boolean;
    /** See ApplyReviewOptions.suppressAutoPublishDispatch. */
    suppressAutoPublishDispatch?: boolean;
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

    // Materialize canonical plan-final.md from legacy implementation.md if needed.
    let canonicalImplUri: vscode.Uri;
    try {
      canonicalImplUri = await materializeCanonicalIfNeeded(folderUri);
    } catch {
      NotificationRouter.showWarning(
        "No implementation notes found (plan-final.md is missing or empty). " +
          "Run the implementation step first."
      );
      return;
    }

    const implementationContent = await readNonEmptyText(canonicalImplUri);
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
    const taskProgress = await readTaskProgress(folderUri);
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

  // Review generation uses the review-stage model (no executionStage override).
  // Only apply flows separate logStage from executionStage.
  let generatedReviewContent: string | undefined;
  const reviewWritten = await runAiToFile({
    extensionUri,
    taskFolderUri: folderUri,
    workspaceUri: workspaceRoot.uri,
    logStage: targetStage,
    templateFile,
    variables,
    outputFileUri: reviewUri,
    progressAction: `Reviewing ${STAGE_DISPLAY_NAMES[targetStage]}`,
    outputLabel: STAGE_ARTIFACT_FILENAMES[targetStage] ?? "review",
    validateOutput: validateReviewOutput,
    promoteOutput: false,
    onValidatedOutput: (content) => { generatedReviewContent = content; },
    preserveActiveFallback: options.preserveActiveFallback,
    reviewAttemptId,
  });

  if (reviewWritten) {
    // Stage the artifact first. A unique temporary file prevents a stale
    // review from touching the accepted artifact while it is competing for
    // the attempt CAS. The rename itself is passed as advanceStage's
    // publishArtifact side effect, so it runs atomically with the CAS check
    // under the task lock: a newer review attempt can only claim and publish
    // strictly before or after this attempt's whole CAS+publish, never in
    // between. Doing the rename here, unlocked and after the fact, allowed a
    // slower stale attempt to pass its own CAS and then clobber a faster
    // attempt's already-published artifact.
    const stagedReviewUri = vscode.Uri.file(`${reviewUri.fsPath}.attempt-${reviewAttemptId}.tmp`);
    await vscode.workspace.fs.writeFile(stagedReviewUri, new TextEncoder().encode(generatedReviewContent ?? ""));
    let transitionToTarget: Awaited<ReturnType<typeof advanceStage>>;
    try {
      transitionToTarget = await advanceStage(
        folderUri,
        currentStage,
        targetStage,
        false,
        "review-run",
        false,
        reviewAttemptId,
        async () => {
          await backupReviewUnlessStale(reviewUri);
          await vscode.workspace.fs.rename(stagedReviewUri, reviewUri, { overwrite: true });
        }
      );
    } catch (error) {
      // A stale/rejected CAS (a newer attempt already owns the stage) or a
      // rename failure both throw before progress is ever written, so there
      // is nothing to revert — just discard this attempt's orphaned staged
      // file and tell the user, instead of leaving the failure silent.
      await vscode.workspace.fs.delete(stagedReviewUri).then(
        () => undefined,
        () => undefined
      );
      const message = error instanceof Error ? error.message : String(error);
      const wantedAutoPublish =
        targetStage === "publish" &&
        !!options.autoPublishOnSuccess &&
        !options.suppressAutoPublishDispatch;
      NotificationRouter.showWarning(
        `Review was generated but not published: ${message}` +
          (wantedAutoPublish ? " Publish manually once you're satisfied." : ""),
        undefined,
        undefined,
        undefined,
        wantedAutoPublish
          ? {
              command: "vs-code-ai-helper.commitAndPushTask",
              title: "Publish Anyway",
              args: [{ taskFolderPath: folderUri.fsPath }],
            }
          : undefined
      );
      return;
    }
    if (transitionToTarget?.persisted && generatedReviewContent !== undefined) {
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
        // the auto-publish/auto-advance blocks below (which independently
        // re-derive "should this land" from the score alone) must not run:
        // decideReviewRoute can escalate even when `meetsThreshold` is true
        // (e.g. a reported blocker is still task-fixable despite the
        // score), and advancing the stage right after would, via
        // updateTaskProgressStage, silently erase the escalation this same
        // call just recorded and paused the task for.
        const { escalated } = await handleReviewRoutingOutcome({
          extensionUri,
          folderUri,
          workspaceUri: workspaceRoot.uri,
          targetStage,
          variables,
          reviewAttemptId,
          content,
          score,
          threshold: autoAdvanceThreshold,
          cancellationToken: options.operation?.token,
        });
        // Review-owned auto-publish is intentionally independent of the
        // general "auto-advance stage" setting below: this Publish review was
        // dispatched specifically because autoPublishOnSuccess was requested
        // (triggers-AI-on direct entry, or a configured follow-up Publish
        // review after auto-advancing into Publish), so a passing score must
        // schedule publishing regardless of whether the unrelated
        // stage-auto-advance toggle happens to be on or off. commitAndPushTask
        // still shows its own confirmation dialogs, so this never silently
        // commits or pushes.
        if (
          !escalated &&
          targetStage === "publish" &&
          options.autoPublishOnSuccess &&
          !options.suppressAutoPublishDispatch
        ) {
          if (meetsThreshold) {
            NotificationRouter.showInformation(`Review score ${score}/10 reached the auto-advance threshold. Scheduling publish...`);
            void scheduleAutomationChain(
              {
                command: "vs-code-ai-helper.commitAndPushTask",
                arg: { taskFolderPath: folderUri.fsPath },
                taskKey: folderUri.fsPath,
                chainId: "auto-publish",
              },
              options.operation
            );
          } else {
            // Review-owned auto-publish was requested but the score fell
            // below the auto-advance threshold — do not schedule publishing,
            // but still give the user a one-click way to publish anyway
            // instead of leaving them to rediscover Commit and Push.
            NotificationRouter.showWarning(
              `Auto-publish skipped for ${folderUri.fsPath}: Publish review scored ${score}/10, below the auto-advance threshold. ` +
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
            // is deferred into advanceStage's publishArtifact hook so it
            // only lands atomically with — and only when — this review
            // attempt actually wins the CAS. Writing it eagerly here would
            // let a stale attempt that loses the race still materialize
            // plan-final.md for a transition that never happens.
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
            // and shouldAutoPublish fire anyway even though the task is now
            // paused.
            const freshProgressForAdvance = await readTaskProgress(folderUri);
            const isPausedForAdvance = freshProgressForAdvance?.status === "paused";
            const transition = await advanceStage(folderUri, targetStage, next, isPausedForAdvance, "auto-advance", true, reviewAttemptId, publishArtifact);
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
                options.operation
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
              // Publish). Publish's follow-up-review ownership is therefore
              // decided separately, directly from the auto-advance mode: in
              // "auto-fast-forward" mode every other landed-on review stage
              // gets an immediate follow-up review via this same block, so
              // Publish gets the same treatment for consistency — that
              // review owns auto-publish (threaded autoPublishOnSuccess,
              // scheduling the chain itself once its score clears the
              // threshold). In plain "auto" mode there is no follow-up
              // review, so this entry point owns scheduling the publish
              // chain directly, exactly as before.
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
                // suppressAutoPublishDispatch tells THIS run not to dispatch
                // auto-publish itself; it must not leak past that into a
                // downstream review claiming ownership on this run's behalf,
                // even though ReviewCommandArg (the dispatched command's own
                // arg shape) has no field to carry the suppression further —
                // scoping it here is what actually keeps the suppress signal
                // honored for the follow-up this call controls.
                const followUpOwnsAutoPublish =
                  publishFollowUpReview && !options.suppressAutoPublishDispatch;
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
                // it was given, which (options.operation being locally
                // scoped, never published anywhere else) only our own
                // ancestor call chain could have obtained. Leave a claim
                // alone whenever this can't be established (e.g. invoked
                // directly/manually with no operation handle) — the existing
                // duplicate-chain guard must keep protecting a genuinely
                // separate pending chain in that case.
                if (
                  options.operation &&
                  taskOperations.rootOperationIdFor(folderUri.fsPath) === options.operation.id
                ) {
                  releaseAutomationChain(folderUri.fsPath, "auto-review");
                }
                const reviewChainScheduled = scheduleAutomationChain(
                  {
                    command: reviewCommand,
                    arg: {
                      taskFolderPath: folderUri.fsPath,
                      autoPublishOnSuccess: followUpOwnsAutoPublish
                        ? transition.shouldAutoPublish
                        : undefined,
                    },
                    taskKey: folderUri.fsPath,
                    chainId: "auto-review",
                  },
                  options.operation
                );
                if (followUpOwnsAutoPublish && transition.shouldAutoPublish) {
                  // This follow-up review is the sole owner of auto-publish for
                  // this landing (the entry-owned fallback below is gated on
                  // !publishFollowUpReview specifically to avoid double-owning
                  // it). If the shared "auto-review" chainId drops this dispatch
                  // because another review chain is already pending/running,
                  // neither the review nor the publish it would have scheduled
                  // ever happens — warn instead of leaving the task silently
                  // stuck on Publish with nothing running, matching every
                  // sibling skip path's Publish Anyway affordance.
                  void reviewChainScheduled.then((scheduled) => {
                    if (!scheduled) {
                      NotificationRouter.showWarning(
                        `Auto-publish skipped for ${folderUri.fsPath}: the follow-up Publish review could not be started automatically because another review is already in progress for this task. ` +
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
                  // No auto-publish ownership riding on this dispatch (a
                  // plain review-to-review handoff, e.g. plan-high-review ->
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
              if (
                next === "publish" &&
                transition.shouldAutoPublish &&
                !publishFollowUpReview &&
                !options.suppressAutoPublishDispatch
              ) {
                // Same gate as the entry-owned paths (setTaskStage.ts,
                // nextStage's own Step 3 above): auto-advancing straight onto
                // Publish must not schedule the publish chain before
                // completion checks have even run once for this landing.
                // commitAndPushTask still has its own gate/modal, but
                // scheduling unconditionally here was a false promise that
                // checks had passed — surface the failure and let the user
                // publish manually instead of silently skipping the schedule.
                // relevantFiles must match every other scheduling-decision
                // call site (setTaskStage.ts, nextStage's Step 3, and this
                // command's own execution-time recheck) — otherwise this gate
                // and the recheck can disagree on identical state.
                const autoAdvancePublishPreflight = await checkPublishPreflight(
                  folderUri,
                  freshProgressForAdvance?.implReviewFiles
                );
                if (autoAdvancePublishPreflight.ok === false) {
                  NotificationRouter.showWarning(
                    `Auto-publish skipped for ${STAGE_DISPLAY_NAMES[next]}: ${autoAdvancePublishPreflight.reason}. ` +
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
                  void scheduleAutomationChain(
                    {
                      command: "vs-code-ai-helper.commitAndPushTask",
                      arg: { taskFolderPath: folderUri.fsPath },
                      taskKey: folderUri.fsPath,
                      chainId: "auto-publish",
                    },
                    options.operation
                  );
                }
              }
            }
          }
          // Publish has no further stage for computeNextStage to return, so
          // `next` is always falsy here when targetStage is "publish" — the
          // review-owned auto-publish schedule for that case runs above,
          // independent of isAutoAdvanceEnabled().
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Same condition as the CAS/rename-failure catch above: only offer
        // Publish Anyway when this review run was actually the one meant to
        // own auto-publish — otherwise the button would be a non sequitur
        // for a plan/impl review that has nothing to do with Publish.
        const wantedAutoPublish =
          targetStage === "publish" &&
          !!options.autoPublishOnSuccess &&
          !options.suppressAutoPublishDispatch;
        NotificationRouter.showWarning(
          `Review was published, but auto-advancing past the score threshold failed: ${message}. ` +
            "Advance the stage manually." +
            (wantedAutoPublish ? " Publish manually once you're satisfied, or use Publish Anyway from Commit and Push." : ""),
          undefined,
          undefined,
          undefined,
          wantedAutoPublish
            ? {
                command: "vs-code-ai-helper.commitAndPushTask",
                title: "Publish Anyway",
                args: [{ taskFolderPath: folderUri.fsPath }],
              }
            : undefined
        );
      }
    } else {
      // advanceStage can resolve undefined without throwing — distinct from
      // the stale-CAS/rename-failure case above (which throws and is already
      // handled by the surrounding catch) — when patchTaskProgress could not
      // read task-progress.json at write time. Falling through silently here
      // left the user with no indication the review artifact/stage
      // transition failed to persist.
      NotificationRouter.showWarning(
        `The review for ${folderUri.fsPath} was generated but could not be recorded. Try running the review again.`
      );
    }
  } else if (targetStage === "publish" && options.autoPublishOnSuccess && !options.suppressAutoPublishDispatch) {
    // The Publish review failed, was cancelled, or was stalled (runAiToFile
    // already surfaced the specific error/cancellation message). Because
    // this review was dispatched specifically to own auto-publish, its
    // failure must not leave the task silently stuck — give the user a
    // one-click path to publish anyway instead of only a dead-end error.
    NotificationRouter.showWarning(
      `Auto-publish skipped for ${folderUri.fsPath}: the Publish review did not complete successfully. ` +
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
  arg?: ReviewCommandArg
): Promise<void> {
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
        { operation: op, autoPublishOnSuccess: chainedAutoPublishOnSuccess(arg) }
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
  // ── Pre-flight workspace guard ────────────────────────────────────────────
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
  // Primitives ("x", 42, true) fall through to normalizeReviewArg safely.
  if (isMalformedReviewArg(arg as ReviewCommandArg | Record<string, unknown>)) {
    NotificationRouter.showError(
      "Apply Review: unsupported argument shape. " +
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
    REVIEW_STAGES,
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

    const isPlanReview = isPlanReviewStage(stage);

    if (!isPlanReview) {
      // Child operation (C1 nesting): while the fix is being implemented the
      // stage-row spinner sits on the Implementation row, not the review row.
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
            {
              skipPreRunSafetyCheck: options.skipImplementationSafetyCheck,
              preserveActiveFallback: options.preserveActiveFallback,
              parentOperation: child,
            }
          )
      );
      if (implementSucceeded) {
        // Re-review after applying (no confirmation, no stage change).
        // Deliberately inline here, nested under `op` (which already holds
        // the task's exclusive lock — C1 children never contend for it),
        // rather than left to executeImplementationRun's own post-run
        // auto-review dispatch: that dispatch is deferred until its
        // (nested-child) parentOperation ends and then reacquires the lock
        // through a fresh command — but this operation, or under Fast
        // Forward its whole multi-attempt loop, is still holding that lock,
        // so the dispatch is refused as busy and silently dropped, leaving
        // the review stuck on the "Review Stale" placeholder. Mirrors the
        // plan-review branch above.
        await runTrackedOperation(
          lockKey,
          { parent: op, label: "Re-running review", stage, kind: "review" },
          // Deferred auto-advance dispatch inside runReviewForFolder waits for
          // `operation` to end before dispatching the next stage's command.
          // That must be the exclusive root (`op`), not this re-review's own
          // child handle — the child ends almost immediately (children never
          // hold the lock), while under Fast Forward the root keeps running
          // for further attempts. Anchoring to the child let the follow-up
          // dispatch fire while the root still held the exclusive lock, so it
          // was refused as busy and silently dropped.
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
                autoPublishOnSuccess: chainedAutoPublishOnSuccess(arg),
                suppressAutoPublishDispatch: options.suppressAutoPublishDispatch,
              }
            )
        );
      }
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
    // Always write to the canonical plan.md
    const outputFileUri = vscode.Uri.joinPath(resolved.folderUri, PLAN_FILENAME);
    const templateFile = "apply-review.md";
    const outputLabel = PLAN_FILENAME;

    // No overwrite confirmation — user triggered this deliberately.
    // Log under the review stage label but execute with the `plan` model so
    // the plan-rewrite uses plan-stage model configuration, not the review model.
    // Child operation (C1 nesting): the spinner sits on the Plan row while the
    // plan is being rewritten, then moves back to the review row below.
    const applySucceeded = await runTrackedOperation(
      lockKey,
      { parent: op, label: `Applying review to ${outputLabel}`, stage: "plan", kind: "apply-review" },
      () =>
        runAiToFile({
          extensionUri,
          taskFolderUri: resolved.folderUri,
          workspaceUri: workspaceRoot.uri,
          logStage: stage,          // review stage — for run logs and progress labels
          executionStage: "plan",   // plan model — for actual AI model resolution
          templateFile,
          variables,
          outputFileUri,
          progressAction: `Applying review to ${outputLabel}`,
          outputLabel,
          preserveActiveFallback: options.preserveActiveFallback,
        })
    );

    if (applySucceeded) {
      if (reviewUri) {
        await markReviewArtifactStale(reviewUri, PLAN_FILENAME);
      }
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
              autoPublishOnSuccess: chainedAutoPublishOnSuccess(arg),
              suppressAutoPublishDispatch: options.suppressAutoPublishDispatch,
            }
          )
      );
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
export async function fastForwardReviewWithAI(
  extensionUri: vscode.Uri,
  context: vscode.ExtensionContext,
  arg?: ReviewCommandArg
): Promise<void> {
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
      () => runReviewForFolder(extensionUri, resolved.folderUri, workspaceRoot, stage, true, { operation: op, autoPublishOnSuccess: chainedAutoPublishOnSuccess(arg) })
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

  // Concrete taskFolderPath so every attempt targets this same task without
  // resolveTask re-prompting (it already resolved the task once above).
  const concreteArg: ReviewCommandArg = {
    taskFolderPath: resolved.folderUri.fsPath,
    autoPublishOnSuccess: chainedAutoPublishOnSuccess(arg),
  };

  let previousContent = initialContent;
  let attemptNumber = 0;

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
            await applyReviewWithAI(
              extensionUri,
              context,
              concreteArg,
              buildFastForwardApplyReviewOptions(attemptNumber, op)
            );
          },
          // Escalation (see handleReviewRoutingOutcome) can now fire inside
          // Fast Forward and pause the task mid-loop. Without this check,
          // the next attempt's applyReviewWithAI silently no-ops on the
          // paused guard, review() then sees unchanged content and returns
          // null, and the loop reports "stalled" — blaming the provider for
          // a deliberate escalation it has no way to see otherwise.
          isPaused: async () => (await readTaskProgress(resolved.folderUri))?.status === "paused",
          review: async () => {
            const newContent = await readNonEmptyText(reviewUri);
            if (!newContent || newContent === previousContent) {
              return null;
            }
            previousContent = newContent;
            return parseReadiness(newContent).score;
          },
        }).finally(() => linked.dispose());
      }
    );
  } catch (error) {
    if (error instanceof vscode.CancellationError) {
      if (targetStage === "publish" && chainedAutoPublishOnSuccess(arg)) {
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
    if (targetStage === "publish" && chainedAutoPublishOnSuccess(arg)) {
      // Any other failure (provider error, apply-review failure, etc.) also
      // forfeits the scheduled auto-publish — give the same one-click way to
      // publish anyway rather than only the generic operation-failed
      // notification the tracked-operation wrapper will also emit once this
      // rethrows.
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

  if (outcome.improved) {
    NotificationRouter.showInformation(
      `Fast Forward Review: score improved to ${outcome.score}/10 after ${outcome.attempts} attempt(s).`
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
  options: ApplyReviewOptions & ExecuteImplementationRunOptions = {}
): Promise<boolean> {
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

  // Use the `implementation` stage's model, not the review stage's model.
  const model = options.preserveActiveFallback
    ? await resolveModelForStage(folderUri, "impl")
    : await resolveFreshModelForStage(folderUri, "impl");

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
      onBusyDetail: options.parentOperation ? (d) => options.parentOperation!.report(d) : undefined,
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

  // ── Step 1: Persist stage transition using shared helper ──────────────────
  let transitionResult: Awaited<ReturnType<typeof advanceStage>>;
  try {
    transitionResult = await advanceStage(
      resolved.folderUri,
      resolved.progress.currentStage,
      next,
      resolved.progress.status === "paused",
      "complete-and-move-on",
      // Completing a stage may start work in its destination only when the
      // workspace explicitly enables that behavior.  Manual stage selection
      // deliberately does not use this path.
      completeAndMoveOnTriggersAI()
    );
  } catch (error) {
    // advanceStage throws (rather than resolving falsy) when its
    // compare-and-set is rejected — e.g. an auto-advance already moved this
    // task off the expected source stage under the lock while this manual
    // "Complete Stage & Move On" was in flight. Report it like any other
    // failed transition instead of an unhandled rejection.
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
  //     publish attempt), and its result gates entry-owned auto-publish in
  //     Step 3b below — previously that result was collected but never
  //     consulted, so auto-publish was scheduled even when checks had just
  //     failed. It is deliberately NOT computed (or consulted) for the
  //     review-owned path: when a Publish review is about to be dispatched,
  //     ownership of the auto-publish decision belongs to that review's
  //     outcome (score + execution-time recheck in commitAndPushTask), not to
  //     a snapshot taken before the review — and possibly before a
  //     Fast Forward repair loop — has run. Gating the review dispatch on a
  //     pre-review snapshot would let stale/repairable failures permanently
  //     suppress auto-publish even after the review fixes them.
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
      // Threaded through to the dispatched Publish review so that once its
      // score clears the auto-advance threshold, the review itself schedules
      // the publish command (review-owned auto-publish path). Harmless on
      // the plan/impl branches below, which don't read this field.
      // Intentionally not gated on any pre-review preflight snapshot: the
      // review's own outcome (score threshold) plus commitAndPushTask's
      // execution-time recheck are what actually decide whether publishing
      // proceeds, so a Fast Forward repair that fixes a failing check can
      // still result in the review completing publish.
      autoPublishOnSuccess: transitionResult.shouldAutoPublish,
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
      // its repair loop) owns the auto-publish decision; commitAndPushTask
      // rechecks preflight itself once the review actually schedules
      // publishing. "auto-fast-forward" runs the review + fixes loop where
      // applicable — Publish lands on a review, so it applies here.
      const publishCommand = getCompleteAndMoveOnTriggersAIMode() === "auto-fast-forward"
        ? "vs-code-ai-helper.fastForwardReviewWithAI"
        : "vs-code-ai-helper.runReviewWithAI";
      const reviewScheduled = await scheduleAutomationChain({ command: publishCommand, arg: target, taskKey, chainId: "auto-review" });
      if (!reviewScheduled) {
        // Dropped by the shared "auto-review" duplicate-chain guard — some
        // other review chain for this task is already pending or running.
        // Do NOT fall through to Step 3b's entry-owned auto-publish: no
        // review or check actually ran for this landing, so scheduling
        // publish here would be the same false promise the preflight gate
        // exists to prevent. Warn like every sibling skip path instead of
        // leaving the task silently stuck on Publish with nothing running.
        NotificationRouter.showWarning(
          `Auto-publish skipped for ${resolved.progress.taskFolder}: a Publish review could not be started automatically because another review is already in progress for this task. ` +
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

  // ── Step 3b: Entry-owned auto-publish ────────────────────────────────
  // Reached here only when "Complete & Move On triggers AI" is off — no
  // Publish review will be dispatched (the triggersAI block above always
  // returns before this point), so nothing else will decide to run the
  // publish command. commitAndPushTask still shows its own confirmation
  // dialogs, so this never silently commits or pushes. Gated on the
  // checkPublishPreflight result captured in Step 3 above.
  if (next === "publish" && transitionResult.shouldAutoPublish) {
    if (publishPreflight?.ok === false) {
      NotificationRouter.showWarning(
        `Auto-publish skipped for ${resolved.progress.taskFolder}: ${publishPreflight.reason}. Publish manually once checks pass, or use Publish Anyway from Commit and Push.`,
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
      await scheduleAutomationChain({
        command: "vs-code-ai-helper.commitAndPushTask",
        arg: { taskFolderPath: resolved.folderUri.fsPath },
        taskKey: resolved.folderUri.fsPath,
        chainId: "auto-publish",
      });
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
    await scheduleAutomationChain({
      command: reviewCommand,
      arg: { taskFolderPath: resolved.folderUri.fsPath },
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
export async function generateImplementationWithAI(
  extensionUri: vscode.Uri,
  context: vscode.ExtensionContext,
  arg?: ReviewCommandArg
): Promise<void> {
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

  // Only "implementation" stage is eligible (see GENERATE_IMPL_ELIGIBLE_STAGES).
  // plan-low-review is excluded because plan-final.md (which this command reads)
  // is only written when the task advances INTO the implementation stage via
  // nextStage. A plan-low-review task that has not yet been advanced will always
  // fail the plan-final.md existence check below, so advertising it in the
  // QuickPick would be misleading.
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
  await runTrackedOperation(
    lockKey,
    { label: "Generate Implementation", stage: "impl", kind: "generate-implementation", cancellable: true },
    async () => {
    // Materialize canonical plan-final.md from legacy implementation.md if needed.
    // This mirrors the same migration path used by runImplementationWithAI so
    // that both implementation-stage entry points handle legacy task folders
    // consistently.
    let planFinalUri: vscode.Uri;
    try {
      planFinalUri = await materializeCanonicalIfNeeded(resolved.folderUri);
    } catch (error) {
      NotificationRouter.showError(
        error instanceof Error ? error.message : String(error)
      );
      return;
    }

    const planFinalContent = await readNonEmptyText(planFinalUri);
    if (!planFinalContent) {
      NotificationRouter.showWarning(
        "No plan-final.md found. Advance to the Implementation stage first."
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

    // Output goes to plan-final.md — the canonical artifact for the implementation stage.
    const implementationUri = planFinalUri;
    // (prompt-size gate is inside runAiToFile)
    const succeeded = await runAiToFile({
      extensionUri,
      taskFolderUri: resolved.folderUri,
      workspaceUri: workspaceRoot.uri,
      logStage: "impl",
      templateFile: "create-implementation.md",
      variables: { contextPack: contextPackContent, plan: planFinalContent },
      outputFileUri: implementationUri,
      progressAction: "Generating implementation",
      outputLabel: "plan-final.md",
    });

    if (succeeded) {
      const generatedContent = await readNonEmptyText(implementationUri);
      if (generatedContent && !generatedContent.includes(IMPLEMENTATION_CHECKLIST_MARKER)) {
        await writeTextFile(
          implementationUri,
          `${IMPLEMENTATION_CHECKLIST_MARKER}\n\n${generatedContent}`
        );
      }
      await setStage(resolved.folderUri, "impl");
    }
    }
  );
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
async function executeImplementationRun(
  _extensionUri: vscode.Uri,
  folderUri: vscode.Uri,
  workspaceRoot: vscode.WorkspaceFolder,
  prompt: string,
  modelId: string | undefined,
  progressTitle: string,
  postRunReviewStage: TaskStage = "impl",
  options: ExecuteImplementationRunOptions = {}
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

  let result: Awaited<ReturnType<typeof runImplementationForModel>> | undefined;

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
      result = await runImplementationForModel({
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
        taskFolderUri: folderUri,
        onBusyDetail: options.onBusyDetail,
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

    if (!result.filesChangedUnknown && result.filesChanged.length === 0) {
      NotificationRouter.showWarning(
        "Implementation finished, but no workspace files changed. " +
          "Review the implementation run log; the provider may have been blocked from writing files."
      );
      await safeOpenTextDocument(logUri, "implementation run log");
      return false;
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

    // Use patchTaskProgress to avoid overwriting unrelated fields.
    await patchTaskProgress(folderUri, (currentProgress) => {
      const alreadyAtOrPastImplementation =
        currentProgress.currentStage === "impl" ||
        isReviewStage(currentProgress.currentStage);
      const stageUpdated = alreadyAtOrPastImplementation
        ? currentProgress
        : updateTaskProgressStage(currentProgress, "impl");

      // filesChangedUnknown means THIS run's own change detection failed.
      // Leave implReviewFiles untouched rather than clearing it.
      if (!result!.filesChangedUnknown) {
        return updateImplReviewFiles(stageUpdated, result!.filesChanged);
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
        const freshProgress = await readTaskProgress(folderUri);
        if (freshProgress?.currentStage === "impl" && freshProgress.status !== "paused") {
          const transition = await advanceStage(
            folderUri,
            "impl",
            "impl-high-review",
            false,
            "auto-advance"
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
  arg?: ReviewCommandArg
): Promise<void> {
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
      const generated = await runTrackedOperation(
        resolved.folderUri.fsPath,
        { parent: op, label: "Generating implementation checklist", stage: "impl", kind: "generate-implementation" },
        () =>
          runAiToFile({
            extensionUri,
            taskFolderUri: resolved.folderUri,
            workspaceUri: checklistWorkspace.uri,
            logStage: "impl",
            templateFile: "create-implementation.md",
            variables: { contextPack: checklistContextPack, plan: planFinalContent! },
            outputFileUri: canonicalUri,
            progressAction: "Generating implementation checklist",
            outputLabel: "plan-final.md",
          })
      );
      if (!generated) {
        // Generation failed or was cancelled; implementing straight from the
        // raw promoted plan would silently skip the checklist step.
        return;
      }
      const generatedContent = await readNonEmptyText(canonicalUri);
      if (generatedContent && !generatedContent.includes(IMPLEMENTATION_CHECKLIST_MARKER)) {
        await writeTextFile(
          canonicalUri,
          `${IMPLEMENTATION_CHECKLIST_MARKER}\n\n${generatedContent}`
        );
      }
      planFinalContent = (await readNonEmptyText(canonicalUri)) ?? planFinalContent;
    }

    // Resolve implementation model for execution
    const model = await resolveFreshModelForStage(resolved.folderUri, "impl");

    const { availability, providerLabel } =
      await checkImplementationAvailabilityForModel(model.modelId, "impl");
    if (!availability.available) {
      NotificationRouter.showWarning(
        `${providerLabel} is unavailable: ${availability.reason ?? "unknown reason"}. Implement the plan manually instead.`
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
      { onBusyDetail: (d) => op.report(d), parentOperation: op, followUpReviewMode }
    );
    }
  );
}

/**
 * Register all review/stage action commands
 */
export function registerReviewActionCommands(
  context: vscode.ExtensionContext
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "vs-code-ai-helper.runReviewWithAI",
      (arg?: ReviewCommandArg) => runReviewWithAI(context.extensionUri, context, arg)
    ),
    vscode.commands.registerCommand(
      "vs-code-ai-helper.applyReviewWithAI",
      (arg?: ReviewCommandArg) => applyReviewWithAI(context.extensionUri, context, arg)
    ),
    vscode.commands.registerCommand(
      "vs-code-ai-helper.fastForwardReviewWithAI",
      (arg?: ReviewCommandArg) => fastForwardReviewWithAI(context.extensionUri, context, arg)
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
        runImplementationWithAI(context.extensionUri, context, arg)
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
  let progress = candidate ? await readTaskProgress(vscode.Uri.file(candidate)) : undefined;
  if (!progress || progress.currentStage !== "publish" || progress.status === "paused") {
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
