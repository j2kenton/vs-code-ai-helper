import * as vscode from "vscode";
import * as path from "path";
import * as crypto from "crypto";

import {
  allowsDirtyWorktreeChanges,
  getMetaResourcesPath,
} from "../config/settings";
import {
  taskOperations,
  showTaskBusyWarning,
  TaskOperationHandle,
} from "../utils/taskOperations";
import {
  isPlanReviewStage,
  isReviewStage,
  PLAN_FILENAME,
  REVIEW_STAGES,
  STAGE_ARTIFACT_FILENAMES,
  STAGE_DISPLAY_NAMES,
  STAGE_ORDER,
  TaskStage,
} from "../types/taskProgress";
import {
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
  checkImplementationAvailabilityForModel,
  resolveRunnerForModel,
  runImplementationForModel,
} from "../runners/runnerRegistry";
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
import { parseReadiness } from "../utils/reviewReadiness";
import { runCompletionLint } from "../utils/completionLint";
import { improveReviewScore } from "../utils/reviewScoreLoop";
import {
  getAutoAdvanceScoreThreshold,
  getFastForwardMaxIterations,
  getFastForwardStopLevel,
  isAutoAdvanceEnabled,
  shouldAutoReviewAfterImplementation,
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
  | { taskFolderPath: string }
  | undefined;

interface ApplyReviewOptions {
  /** Skip repeated dirty/non-git workspace confirmations for internally chained runs. */
  skipImplementationSafetyCheck?: boolean;
  /** Preserve a stage's active fallback reservation across one internal retry loop. */
  preserveActiveFallback?: boolean;
  /**
   * Replaces skipTaskLock. The parent operation that holds the task operation lock.
   */
  parentOperation?: TaskOperationHandle;
}

interface ExecuteImplementationRunOptions {
  /** Skip the pre-run dirty/non-git workspace confirmation. */
  skipPreRunSafetyCheck?: boolean;
  /** Preserve a stage's active fallback reservation across one internal retry loop. */
  preserveActiveFallback?: boolean;
  onBusyDetail?: (detail: string | undefined) => void;
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
  title: string
): Promise<ResolvedTask | undefined> {
  if (node?.task) {
    const folderUri = node.task.folderUri;
    const progress = await readTaskProgress(folderUri);
    if (!progress) {
      void vscode.window.showErrorMessage(
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
      void vscode.window.showErrorMessage("This task belongs to a different workspace and cannot be operated on here.");
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
    void vscode.window.showErrorMessage(
      "No workspace folder open. Please open a folder first."
    );
    return undefined;
  }

  const combinedTasks: IncompleteTask[] = [];
  for (const wsFolder of allWorkspaceFolders) {
    // Attempt to discover tasks using the configured path, or the default meta root.
    const metaFolderUri = vscode.Uri.joinPath(wsFolder.uri, getMetaResourcesPath());

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

  let picked: IncompleteTask | undefined;
  if (eligible.length === 1) {
    picked = eligible[0];
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
 * it. On failed validation the file is reverted to its pre-run content
 * (or left empty if there was none) instead of keeping the invalid response,
 * and the run is reported as not completed.
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
}): Promise<boolean> {
  const modelStage = options.executionStage ?? options.logStage;
  const model = options.preserveActiveFallback
    ? await resolveModelForStage(options.taskFolderUri, modelStage)
    : await resolveFreshModelForStage(options.taskFolderUri, modelStage);
  if (!model.modelId) {
    const openSettings = await vscode.window.showWarningMessage(
      `No model is configured for ${modelStage}. Open Ensemble Settings and choose a primary model before continuing.`,
      { modal: true },
      "Open Settings"
    );
    if (openSettings === "Open Settings") {
      await vscode.commands.executeCommand("vs-code-ai-helper.openSettings");
    }
    return false;
  }
  const { runner, providerLabel, nativeModelId } = resolveRunnerForModel(
    model.modelId, modelStage, options.taskFolderUri
  );
  // Build the prompt here so we can apply the size gate before launching.
  const prompt = await renderPromptTemplate(
    options.extensionUri,
    options.templateFile,
    options.variables
  );

  // ── Prompt-size gate ─────────────────────────────────────────────────────
  const sizeCheck = await checkAndConfirmPromptSize(prompt, providerLabel);
  if (sizeCheck === "abort" || sizeCheck === "declined") {
    return false;
  }

  // Snapshot pre-run content so a response that fails validation can be
  // reverted instead of clobbering a previously valid file.
  const previousContent = options.validateOutput
    ? (await readNonEmptyText(options.outputFileUri)) ?? ""
    : undefined;

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
      title: `${options.progressAction} with ${providerLabel} (uses your ${providerLabel} quota)...`,
      cancellable: true,
    },
    async (progress, token) => {
      NotificationRouter.emitProgressSummary(`${options.progressAction} with ${providerLabel}...`);
      progress.report({ message: `Waiting for ${providerLabel} response...` });

      const result = await runner.run(
        {
          taskFolderUri: options.taskFolderUri,
          workspaceUri: options.workspaceUri,
          stage: options.logStage,
          prompt,
          outputFile: stagedOutputUri,
          modelId: nativeModelId,
        },
        token
      );

      await writeRunLog(
        options.taskFolderUri,
        runner.id,
        options.logStage,
        `# Prompt\n\n${prompt}\n\n# Result\n\nStatus: ${result.status}\n\n${
          result.summary ?? result.errorMessage ?? ""
        }`
      );

      if (result.status === "completed") {
        const newContentBytes = await vscode.workspace.fs.readFile(
          stagedOutputUri
        );
        const newContent = new TextDecoder().decode(newContentBytes);
        const validation = options.validateOutput?.(newContent);

        if (validation && !validation.valid) {
          // Revert instead of leaving the invalid response in place — an
          // exit-0 CLI result is not proof the task was actually performed.
          await writeTextFile(stagedOutputUri, previousContent ?? "");
          void vscode.window.showErrorMessage(
            `${options.outputLabel} generation from ${providerLabel} did not produce a valid result ` +
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
            `${options.outputLabel} generated with ${providerLabel} (${
              result.summary ?? ""
            })`
          );
        }
      } else if (result.status === "cancelled") {
        NotificationRouter.showInformation(
          `${options.outputLabel} generation cancelled.`
        );
      } else {
        void vscode.window.showErrorMessage(
          `${options.outputLabel} generation failed: ${
            result.errorMessage ?? "unknown error"
          }.`
        );
      }
      if (stagedOutputUri.fsPath !== options.outputFileUri.fsPath) {
        try { await vscode.workspace.fs.delete(stagedOutputUri, { useTrash: false }); } catch { /* best effort */ }
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

export function selectReviewPromptTemplate(
  targetStage: TaskStage,
  currentStage: TaskStage,
  previousReview: string | undefined
): string | undefined {
  if (
    targetStage === "plan-high-review" &&
    currentStage === targetStage &&
    previousReview !== undefined &&
    !isStaleReviewArtifact(previousReview)
  ) {
    return "review-plan-high-rereview.md";
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
  options: { preserveActiveFallback?: boolean } = {}
): Promise<void> {
  const targetStage = REVIEW_TARGETS[currentStage];
  const reviewUri = targetStage && artifactUri(folderUri, targetStage);
  if (!targetStage || !reviewUri) {
    return;
  }

  const variables: Record<string, string> = {};
  const isPlanReview = isPlanReviewStage(targetStage);
  const previousReview =
    targetStage === "plan-high-review" && currentStage === targetStage
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
  // again by the transition CAS, so a late result cannot advance a newer run.
  const reviewAttemptId = crypto.randomUUID();
  const claimed = await patchTaskProgress(folderUri, (current) => {
    if (current.status === "paused") {
      throw new Error("The task was paused while the review was starting.");
    }
    return { ...current, reviewAttemptId };
  });
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
      NotificationRouter.showWarning(`Review was generated but not published: ${message}`);
      return;
    }
    if (transitionToTarget?.persisted && generatedReviewContent !== undefined) {
      try {
        const contentBytes = await vscode.workspace.fs.readFile(reviewUri);
        const content = new TextDecoder().decode(contentBytes);
        const score = parseReadiness(content).score;
        const autoAdvanceThreshold = getAutoAdvanceScoreThreshold();
        if (isAutoAdvanceEnabled() && score !== null && score >= autoAdvanceThreshold) {
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
            const transition = await advanceStage(folderUri, targetStage, next, false, false, reviewAttemptId, publishArtifact);
            if (transition?.persisted) {
              NotificationRouter.showInformation(`Review accepted. Advanced to ${STAGE_DISPLAY_NAMES[next]}.`);
            }
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        NotificationRouter.showWarning(
          `Review was published, but auto-advancing past the perfect score failed: ${message}. ` +
            "Advance the stage manually."
        );
      }
    }
  }
}

/**
 * Review prompts (review-plan-high.md, review-plan-low.md, review-impl-high.md,
 * review-impl-low.md) all require a leading `Readiness: N/10` line. A response
 * missing it is a strong signal the provider didn't actually perform the
 * review — e.g. it replied with a clarifying question about the prompt file
 * instead of reviewing it, which still exits 0 with non-empty output and
 * would otherwise be indistinguishable from a real review.
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
    void vscode.window.showErrorMessage(
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
    void vscode.window.showErrorMessage(
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
    "Review with AI"
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
    void vscode.window.showErrorMessage(
      "Could not determine the owning workspace for this task. Please open the workspace that created it."
    );
    return;
  }
  const lockKey = resolved.folderUri.fsPath;
  const op = taskOperations.begin(lockKey, { label: "Review", stage: resolved.progress.currentStage });
  if (!op) {
    showTaskBusyWarning(lockKey);
    return;
  }
  try {
    await runReviewForFolder(
      extensionUri,
      resolved.folderUri,
      workspaceRoot,
      resolved.progress.currentStage,
      true
    );
  } finally {
    taskOperations.end(op);
  }
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
    void vscode.window.showErrorMessage(
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
    void vscode.window.showErrorMessage(
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
    "Apply Review with AI"
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
    void vscode.window.showErrorMessage(
      "Could not determine the owning workspace for this task. Please open the workspace that created it."
    );
    return;
  }

  const lockKey = resolved.folderUri.fsPath;
  const op = options.parentOperation ?? taskOperations.begin(lockKey, { label: "Apply Review", stage: resolved.progress.currentStage });
  if (!op) {
    showTaskBusyWarning(lockKey);
    return;
  }
  try {
    const stage = resolved.progress.currentStage;
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
      await applyImplementationReviewWithAI(
        extensionUri,
        resolved.folderUri,
        workspaceRoot,
        stage,
        reviewContent,
        {
          skipPreRunSafetyCheck: options.skipImplementationSafetyCheck,
          preserveActiveFallback: options.preserveActiveFallback,
        }
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
    // Always write to the canonical plan.md
    const outputFileUri = vscode.Uri.joinPath(resolved.folderUri, PLAN_FILENAME);
    const templateFile = "apply-review.md";
    const outputLabel = PLAN_FILENAME;

    // No overwrite confirmation — user triggered this deliberately.
    // Log under the review stage label but execute with the `plan` model so
    // the plan-rewrite uses plan-stage model configuration, not the review model.
    const applySucceeded = await runAiToFile({
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
    });

    if (applySucceeded) {
      if (reviewUri) {
        await markReviewArtifactStale(reviewUri, PLAN_FILENAME);
      }
      // Re-review after applying (no confirmation, no stage change)
      await runReviewForFolder(
        extensionUri,
        resolved.folderUri,
        workspaceRoot,
        stage,
        true,
        { preserveActiveFallback: options.preserveActiveFallback }
      );
    }
  } finally {
    if (!options.parentOperation) {
      taskOperations.end(op);
    }
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
    void vscode.window.showErrorMessage(
      "No workspace folder open. Please open a folder first."
    );
    return;
  }

  if (isMalformedReviewArg(arg as ReviewCommandArg | Record<string, unknown>)) {
    void vscode.window.showErrorMessage(
      "Fast Forward Review: unsupported argument shape. " +
        "Use { taskFolderPath } to target a specific task, or invoke without an argument to pick from a list."
    );
    return;
  }

  const consented = await ensureAiConsent(context);
  if (!consented) {
    return;
  }

  const resolved = await resolveTask(
    normalizeReviewArg(arg),
    REVIEW_STAGES,
    "Fast Forward Review with AI"
  );
  if (!resolved) {
    return;
  }
  if (resolved.progress.status === "paused") {
    NotificationRouter.showInformation("This task is paused. Resume it before fast-forwarding.");
    return;
  }

  const lockKey = resolved.folderUri.fsPath;
  const op = taskOperations.begin(lockKey, { label: "Fast Forward Review", stage: resolved.progress.currentStage });
  if (!op) {
    showTaskBusyWarning(lockKey);
    return;
  }
  try {
  const stage = resolved.progress.currentStage;
  const reviewUri = artifactUri(resolved.folderUri, stage);
  if (!reviewUri) {
    NotificationRouter.showWarning(
      "Fast Forward Review: this stage does not have a review artifact."
    );
    return;
  }

  let initialContent = await readNonEmptyText(reviewUri);
  if (!initialContent) {
    // No review has been run yet at this stage — run the initial review
    // first, then continue straight into the normal fast-forward loop
    // rather than telling the user to click Review separately first.
    const workspaceRoot = resolveOwnerWorkspace(resolved.progress);
    if (!workspaceRoot) {
      void vscode.window.showErrorMessage(
        "Could not determine the owning workspace for this task. Please open the workspace that created it."
      );
      return;
    }
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: `Running initial ${STAGE_DISPLAY_NAMES[stage] ?? "review"} before fast-forwarding...`,
        cancellable: false,
      },
      () => runReviewForFolder(extensionUri, resolved.folderUri, workspaceRoot, stage, true)
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
  const concreteArg: ReviewCommandArg = { taskFolderPath: resolved.folderUri.fsPath };

  let previousContent = initialContent;
  let attemptNumber = 0;

  let outcome: Awaited<ReturnType<typeof improveReviewScore>>;
  try {
    outcome = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: `Fast-forwarding ${STAGE_DISPLAY_NAMES[stage] ?? "review"}...`,
        cancellable: true,
      },
      (progress, token) =>
        improveReviewScore({
          context,
          stage,
          baselineScore,
          maxAttempts,
          stopAtScore: configuredStopLevel,
          token,
          apply: async () => {
            attemptNumber += 1;
            progress.report({
              message: `Attempt ${attemptNumber} of ${maxAttempts}...`,
            });
            await applyReviewWithAI(
              extensionUri,
              context,
              concreteArg,
              buildFastForwardApplyReviewOptions(attemptNumber, op)
            );
          },
          review: async () => {
            const newContent = await readNonEmptyText(reviewUri);
            if (!newContent || newContent === previousContent) {
              return null;
            }
            previousContent = newContent;
            return parseReadiness(newContent).score;
          },
        })
    );
  } catch (error) {
    if (error instanceof vscode.CancellationError) {
      NotificationRouter.showInformation(
        `Fast Forward Review cancelled after ${attemptNumber} attempt(s).`
      );
      return;
    }
    throw error;
  }

  if (outcome.improved) {
    NotificationRouter.showInformation(
      `Fast Forward Review: score improved to ${outcome.score}/10 after ${outcome.attempts} attempt(s).`
    );
  } else if (outcome.stalled) {
    NotificationRouter.showWarning(
      `Fast Forward Review stopped after ${outcome.attempts} attempt(s): the review did not change. ` +
        "Check the run log — the provider may have failed or been blocked."
    );
  } else {
    NotificationRouter.showWarning(
      `Fast Forward Review: target not reached after ${maxAttempts} attempts (best score ${
        outcome.score ?? "—"
      }/10).`
    );
  }
  } finally {
    taskOperations.end(op);
  }
}

/**
 * Apply an implementation review by re-running the AI implementation
 * runner against the review's findings.
 *
 * Uses the `implementation` model for execution, not the review-stage model.
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
): Promise<void> {
  // Materialize canonical plan-final.md from legacy implementation.md if needed.
  let canonicalUri: vscode.Uri;
  try {
    canonicalUri = await materializeCanonicalIfNeeded(folderUri);
  } catch {
    NotificationRouter.showWarning(
      "No plan-final.md found. Nothing to apply the review to."
    );
    return;
  }

  const planFinalContent = await readNonEmptyText(canonicalUri);
  if (!planFinalContent) {
    NotificationRouter.showWarning(
      "No plan-final.md found. Nothing to apply the review to."
    );
    return;
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
    return;
  }

  const contextPackContent = await generateContextPack(folderUri, workspaceRoot.uri);

  const prompt = await renderPromptTemplate(
    extensionUri,
    "apply-impl-review-code.md",
    {
      contextPack: contextPackContent,
      plan: planFinalContent,
      review: reviewContent,
    }
  );

  // ── Prompt-size gate ─────────────────────────────────────────────────────
  const sizeCheck = await checkAndConfirmPromptSize(prompt, providerLabel);
  if (sizeCheck === "abort" || sizeCheck === "declined") {
    return;
  }

  await executeImplementationRun(
    extensionUri,
    folderUri,
    workspaceRoot,
    prompt,
    model.modelId,
    `Applying implementation review with ${providerLabel}...`,
    stage,
    {
      ...options,
      onBusyDetail: options.parentOperation ? (d) => options.parentOperation!.report(d) : undefined,
    }
  );
}

/**
 * Open the review artifact for the task's current review stage.
 */
export async function viewReview(arg?: ReviewCommandArg): Promise<void> {
  // ── Malformed-arg guard ───────────────────────────────────────────────────
  // Primitives ("x", 42, true) fall through to normalizeReviewArg safely.
  if (isMalformedReviewArg(arg as ReviewCommandArg | Record<string, unknown>)) {
    void vscode.window.showErrorMessage(
      "View Review: unsupported argument shape. " +
        "Use { taskFolderPath } to target a specific task, or invoke without an argument to pick from a list."
    );
    return;
  }

  const resolved = await resolveTask(
    normalizeReviewArg(arg),
    REVIEW_STAGES,
    "View Review"
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
  extensionUri: vscode.Uri,
  node?: TaskNodeArg
): Promise<void> {
  // Publish is the final executable stage: its review is generated here and
  // completion/release remain explicit actions. There is no stage after it.
  const advanceable = STAGE_ORDER;
  const resolved = await resolveTask(node, advanceable, "Next Stage");
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
  const transitionResult = await advanceStage(
    resolved.folderUri,
    resolved.progress.currentStage,
    next,
    resolved.progress.status === "paused",
    // Completing a stage may start work in its destination only when the
    // workspace explicitly enables that behavior.  Manual stage selection
    // deliberately does not use this path.
    completeAndMoveOnTriggersAI()
  );

  if (!transitionResult?.persisted) {
    void vscode.window.showErrorMessage(
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
  //   persist lint payload — deferred until runLintingFixes is called explicitly
  //   refresh final rendered state — inventory watcher handles this
  if (next === "publish") {
    await runCompletionLint(resolved.folderUri, resolved.progress.implReviewFiles);
  }

  // A completion-driven transition is intentionally different from manually
  // selecting a stage: persist the destination first, then start its primary
  // AI action when the workspace setting allows it.
  if (completeAndMoveOnTriggersAI()) {
    const target = { taskFolderPath: resolved.folderUri.fsPath };
    if (next === "plan") {
      await vscode.commands.executeCommand("vs-code-ai-helper.generatePlanWithAI", target);
      return;
    }
    if (next === "impl") {
      await vscode.commands.executeCommand("vs-code-ai-helper.generateImplementationWithAI", target);
      return;
    }
    if (next === "publish") {
      // Publish is also a destination-stage action.  Lint collection above is
      // supplementary; it must not prevent the requested Publish review.
      await vscode.commands.executeCommand("vs-code-ai-helper.runReviewWithAI", target);
      return;
    }
  }

  // ── Step 4: Auto-trigger review when eligible ────────────────────────
  // transitionResult.shouldAutoReview is already computed by advanceStage
  // using exactly-once semantics tied to the persistence result.
  if (transitionResult.shouldAutoReview) {
    // Re-read progress to get the newly persisted stage and fresh ownership
    const freshProgress = await readTaskProgress(resolved.folderUri);
    if (freshProgress) {
      // Prefer the task's persisted ownership.workspaceRoot over the active-editor
      // workspace so the context pack is generated from the correct workspace.
      const workspaceRoot = resolveOwnerWorkspace(freshProgress);
      if (workspaceRoot) {
        // Bypass the consent gate for auto-triggered reviews — consent was
        // already given by the user action that triggered nextStage.
        await runReviewForFolder(
          extensionUri,
          resolved.folderUri,
          workspaceRoot,
          freshProgress.currentStage,
          true
        );
      }
    }
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
    void vscode.window.showErrorMessage(
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
    void vscode.window.showErrorMessage(
      "Generate Implementation: unsupported argument shape. " +
        "Use { taskFolderPath } to target a specific task, or invoke without an argument to pick from a list."
    );
    return;
  }

  const resolved = await resolveTask(
    normalizeReviewArg(arg),
    GENERATE_IMPL_ELIGIBLE_STAGES,
    "Generate Implementation with AI"
  );
  if (!resolved) {
    return;
  }
  if (resolved.progress.status === "paused") {
    NotificationRouter.showInformation("This task is paused. Resume it before generating implementation notes.");
    return;
  }

  const lockKey = resolved.folderUri.fsPath;
  const op = taskOperations.begin(lockKey, { label: "Generate Implementation", stage: "impl" });
  if (!op) {
    showTaskBusyWarning(lockKey);
    return;
  }
  try {
    // Materialize canonical plan-final.md from legacy implementation.md if needed.
    // This mirrors the same migration path used by runImplementationWithAI so
    // that both implementation-stage entry points handle legacy task folders
    // consistently.
    let planFinalUri: vscode.Uri;
    try {
      planFinalUri = await materializeCanonicalIfNeeded(resolved.folderUri);
    } catch (error) {
      void vscode.window.showErrorMessage(
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
      void vscode.window.showErrorMessage(
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
      await setStage(resolved.folderUri, "impl");
    }
  } finally {
    taskOperations.end(op);
  }
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
  extensionUri: vscode.Uri,
  folderUri: vscode.Uri,
  workspaceRoot: vscode.WorkspaceFolder,
  prompt: string,
  modelId: string | undefined,
  progressTitle: string,
  postRunReviewStage: TaskStage = "impl",
  options: ExecuteImplementationRunOptions = {}
): Promise<void> {
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
        return;
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
          return;
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
      NotificationRouter.emitProgressSummary(progressTitle);
      result = await runImplementationForModel({
        prompt,
        modelId,
        workspaceUri: workspaceRoot.uri,
        token,
        onProgress: (message) => progress.report({ message }),
        // `modelId` is always resolved from the "impl" stage (see the two
        // callers of executeImplementationRun) — quota/fallback bookkeeping
        // must use that same stage, not postRunReviewStage (which may be a
        // review stage used only to pick which review to auto-run below).
        stage: "impl",
        taskFolderUri: folderUri,
        onBusyDetail: options.onBusyDetail,
      });
    }
  );

  if (!result) {
    return;
  }

  const logContent = `# Implementation Run\n\nStatus: ${result.status}\n\nFiles changed:\n${
    result.filesChanged.length > 0
      ? result.filesChanged.map((f) => `- ${f}`).join("\n")
      : "_none recorded_"
  }\n\n${result.summary ?? result.errorMessage ?? ""}`;

  const logUri = await writeRunLog(folderUri, result.runnerId, "impl", logContent);

  if (result.status === "completed") {
    const implementationUri = getCanonicalImplementationUri(folderUri);

    if (!result.filesChangedUnknown && result.filesChanged.length === 0) {
      NotificationRouter.showWarning(
        "Implementation finished, but no workspace files changed. " +
          "Review the implementation run log; the provider may have been blocked from writing files."
      );
      await safeOpenTextDocument(logUri, "implementation run log");
      return;
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
    // Optional: a completed implementation only starts review when enabled in Settings.
    if (shouldAutoReviewAfterImplementation()) {
      await runReviewForFolder(
        extensionUri,
        folderUri,
        workspaceRoot,
        postRunReviewStage,
        true,
        { preserveActiveFallback: options.preserveActiveFallback }
      );
    }
  } else if (result.status === "cancelled") {
    NotificationRouter.showInformation("Implementation cancelled.");
  } else {
    NotificationRouter.showError(
      `Implementation failed: ${result.errorMessage ?? "unknown error"}`
    );
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
    void vscode.window.showErrorMessage(
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
    void vscode.window.showErrorMessage(
      "Run Implementation: unsupported argument shape. " +
        "Use { taskFolderPath } to target a specific task, or invoke without an argument to pick from a list."
    );
    return;
  }

  const resolved = await resolveTask(
    normalizeReviewArg(arg),
    IMPLEMENTATION_ELIGIBLE_STAGES,
    "Run Implementation with AI"
  );
  if (!resolved) {
    return;
  }
  if (resolved.progress.status === "paused") {
    NotificationRouter.showInformation("This task is paused. Resume it before running implementation.");
    return;
  }

  const lockKey = resolved.folderUri.fsPath;
  const op = taskOperations.begin(lockKey, { label: "Run Implementation", stage: "impl" });
  if (!op) {
    showTaskBusyWarning(lockKey);
    return;
  }
  try {
    // Materialize canonical plan-final.md from legacy implementation.md if needed
    let canonicalUri: vscode.Uri;
    try {
      canonicalUri = await materializeCanonicalIfNeeded(resolved.folderUri);
    } catch (error) {
      void vscode.window.showErrorMessage(
        error instanceof Error ? error.message : String(error)
      );
      return;
    }

    const planFinalContent = await readNonEmptyText(canonicalUri);
    if (!planFinalContent) {
      NotificationRouter.showWarning(
        "No plan-final.md found. Advance to the Implementation stage first."
      );
      return;
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
      void vscode.window.showErrorMessage(
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
      { onBusyDetail: (d) => op.report(d) }
    );
  } finally {
    taskOperations.end(op);
  }
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
      (arg?: ReviewCommandArg) => viewReview(arg)
    ),
    vscode.commands.registerCommand(
      "vs-code-ai-helper.nextStage",
      (node?: TaskNodeArg) =>
        nextStage(context.extensionUri, node)
    ),
    vscode.commands.registerCommand(
      "vs-code-ai-helper.generateImplementationWithAI",
      (arg?: ReviewCommandArg) =>
        generateImplementationWithAI(context.extensionUri, context, arg)
    ),
    vscode.commands.registerCommand(
      "vs-code-ai-helper.runImplementationWithAI",
      (arg?: ReviewCommandArg) =>
        runImplementationWithAI(context.extensionUri, context, arg)
    ),
    vscode.commands.registerCommand("vs-code-ai-helper.release", runRelease)
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

async function runRelease(arg?: TaskNodeArg): Promise<void> {
  const candidate = arg?.task?.folderUri.fsPath;
  if (!candidate) {
    void vscode.window.showWarningMessage("Release is available only from a task's Publish stage.");
    return;
  }
  const progress = candidate ? await readTaskProgress(vscode.Uri.file(candidate)) : undefined;
  if (!progress || progress.currentStage !== "publish" || progress.status === "paused") {
    void vscode.window.showWarningMessage("Release requires an active task at the Publish stage.");
    return;
  }
  // Tasks can live in an external metadata root, so task-folder containment
  // is not a valid way to find their project. Prefer the persisted project
  // binding and only use containment for legacy tasks without ownership.
  const persistedOwner = progress.ownership?.projectRoot ?? progress.ownership?.workspaceRoot;
  const metaRoot = progress.ownership?.metaRoot;
  if (metaRoot && !isPathWithin(candidate, metaRoot)) {
    void vscode.window.showErrorMessage("This task is outside its configured metadata root and cannot be released.");
    return;
  }
  const owner = resolveReleaseWorkspace(
    candidate,
    progress.ownership,
    vscode.workspace.workspaceFolders ?? []
  );
  if (persistedOwner && !owner) {
    void vscode.window.showErrorMessage("This task belongs to a different workspace and cannot be released here.");
    return;
  }
  const root = owner?.uri.fsPath;
  if (!root) { void vscode.window.showWarningMessage("Open a workspace before releasing."); return; }

  const op = taskOperations.begin(candidate, { label: "Release", taskName: arg?.task?.folderName ?? path.basename(candidate) });
  if (!op) {
    showTaskBusyWarning(candidate);
    return;
  }
  try {
    let pkg: { scripts?: Record<string, unknown> };
    try {
      const parsed: unknown = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(`${root}/package.json`))).toString("utf8"));
      if (!parsed || typeof parsed !== "object") throw new Error("package.json is not an object");
      pkg = parsed as { scripts?: Record<string, unknown> };
    }
    catch { void vscode.window.showErrorMessage("No valid package.json was found."); return; }
    const script = pkg.scripts?.release;
    if (!isSafeReleaseScript(script)) { void vscode.window.showErrorMessage("Release requires a safe package.json release script."); return; }
    if (!vscode.workspace.isTrusted) { void vscode.window.showErrorMessage("Release requires a trusted workspace."); return; }
    const manager = fs.existsSync(`${root}/pnpm-lock.yaml`) ? "pnpm" : fs.existsSync(`${root}/yarn.lock`) ? "yarn" : fs.existsSync(`${root}/bun.lockb`) ? "bun" : "npm";
    const scriptHash = crypto.createHash("sha256").update(script).digest("hex");
    const commandText = `${manager} run release`;
    const confirmation = await vscode.window.showWarningMessage(`Run release?\n\nCommand: ${commandText}\nWorking directory: ${root}\nPackage manager: ${manager}\nScript: ${script}\nSHA-256: ${scriptHash}`, { modal: true }, "Run Release");
    if (confirmation !== "Run Release") return;
    // Re-read immediately before spawning so a package.json edit cannot change
    // the reviewed release command between confirmation and execution.
    const currentPackage = JSON.parse(await fs.promises.readFile(`${root}/package.json`, "utf8")) as { scripts?: Record<string, unknown> };
    if (currentPackage.scripts?.release !== script) { void vscode.window.showErrorMessage("The release script changed after confirmation; release was cancelled."); return; }
    await fs.promises.writeFile(path.join(candidate, "release-operation.json"), JSON.stringify({ command: commandText, cwd: root, packageManager: manager, script, scriptSha256: scriptHash, startedAt: new Date().toISOString() }, null, 2), "utf8");
    // Delegate to the package manager's own "run release" — never the script
    // text itself — so the release regex above is a display sanity check, not
    // the security boundary. `args` are fixed literals (never user input), so
    // `shell: true` on Windows is safe here and is Node's own documented,
    // security-patched way to launch a manager that may be a .cmd/.bat shim
    // (pnpm/yarn/npm) or a native .exe (bun) without hand-rolling a cmd.exe
    // wrapper — the previous manual `cmd.exe /d /s /c "<manager>.cmd run
    // release"` reimplementation both duplicated that patched escaping logic
    // and broke bun releases on Windows (bun ships bun.exe, not bun.cmd).
    const args = ["run", "release"];
    // Pin the manager resolved after confirmation. Do not use a shell: PATH
    // shadowing or a changed shim must not silently change the executable.
    let managerPath: string;
    try {
      const locator = process.platform === "win32" ? "where.exe" : "which";
      managerPath = (cp.execFileSync(locator, [manager], { cwd: root, windowsHide: true })
        .toString("utf8").split(/\r?\n/).map(value => value.trim()).find(Boolean)) ?? "";
      if (!managerPath || !path.isAbsolute(managerPath)) throw new Error("package manager was not resolved to an absolute path");
    } catch (error) {
      void vscode.window.showErrorMessage(`Release cancelled: could not resolve ${manager} safely (${error instanceof Error ? error.message : String(error)}).`);
      return;
    }
    const resolvedBeforeSpawn = managerPath;
    await new Promise<void>(resolve => {
      const child = cp.spawn(resolvedBeforeSpawn, args, { cwd: root, shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(resolvedBeforeSpawn), windowsHide: true });
      child.on("close", code => { if (code === 0) NotificationRouter.showInformation("Release completed."); else void vscode.window.showErrorMessage(`Release failed (exit ${code ?? 1}).`); resolve(); });
      child.on("error", e => { void vscode.window.showErrorMessage(`Release failed: ${e.message}`); resolve(); });
    });
  } finally {
    taskOperations.end(op);
  }
}
