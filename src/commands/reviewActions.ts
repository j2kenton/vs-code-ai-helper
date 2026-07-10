import * as vscode from "vscode";
import {
  getMetaResourcesPath,
  hasValidMetaResourcesPath,
} from "../config/settings";
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
import { resolveModelForStage } from "../utils/modelSelection";
import {
  getCanonicalImplementationUri,
  resolveImplementationArtifact,
  materializeCanonicalIfNeeded,
} from "../utils/implementationArtifactResolver";
import { ensureAiConsent } from "../utils/aiConsent";
import { checkAndConfirmPromptSize } from "../utils/promptSizeGuard";
import * as cp from "child_process";
import { NotificationRouter } from "../utils/notificationRouter";
import { parseReadiness } from "../utils/reviewReadiness";
import { runCompletionLint } from "../utils/completionLint";
import { improveReviewScore, MAX_REVIEW_ATTEMPTS } from "../utils/reviewScoreLoop";

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
          currentStage: "task-description" as TaskStage,
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
  "implementation",
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
    return { folderUri, progress };
  }

  // Fall back to discovering tasks from the configured meta folder
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceRoot) {
    void vscode.window.showErrorMessage(
      "No workspace folder open. Please open a folder first."
    );
    return undefined;
  }

  // Attempt to discover tasks using the configured path, or .helper/plans default
  let metaFolderUri: vscode.Uri;
  if (hasValidMetaResourcesPath()) {
    metaFolderUri = vscode.Uri.joinPath(workspaceRoot.uri, getMetaResourcesPath());
  } else {
    metaFolderUri = vscode.Uri.joinPath(workspaceRoot.uri, ".helper/plans");
  }

  const allTasks = await findAllTasks(metaFolderUri);

  // Also check legacy plans/ folder if different
  let legacyTasks: IncompleteTask[] = [];
  try {
    const legacyUri = vscode.Uri.joinPath(workspaceRoot.uri, "plans");
    if (legacyUri.fsPath !== metaFolderUri.fsPath) {
      legacyTasks = await findAllTasks(legacyUri);
    }
  } catch {
    // Ignore errors reading legacy folder
  }

  const combinedTasks = [...allTasks, ...legacyTasks];

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
  return vscode.workspace.workspaceFolders?.[0];
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
 * Check if the workspace has uncommitted changes (dirty state).
 * Returns true when git reports any modified/untracked files.
 */
async function hasUncommittedChanges(cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    cp.execFile(
      "git",
      ["status", "--porcelain"],
      { cwd, windowsHide: true },
      (err, stdout) => {
        if (err) { resolve(false); return; }
        resolve(stdout.trim().length > 0);
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
}): Promise<boolean> {
  const modelStage = options.executionStage ?? options.logStage;
  const model = await resolveModelForStage(options.taskFolderUri, modelStage);
  const { runner, providerLabel, nativeModelId } = await resolveRunnerForModel(
    model.modelId
  );
  const availability = await runner.isAvailable();
  if (!availability.available) {
    NotificationRouter.showWarning(
      `${providerLabel} is unavailable: ${
        availability.reason ?? "unknown reason"
      }. Write ${options.outputLabel} manually instead.`
    );
    return false;
  }

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
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
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
          outputFile: options.outputFileUri,
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
          options.outputFileUri
        );
        const newContent = new TextDecoder().decode(newContentBytes);
        const validation = options.validateOutput?.(newContent);

        if (validation && !validation.valid) {
          // Revert instead of leaving the invalid response in place — an
          // exit-0 CLI result is not proof the task was actually performed.
          await writeTextFile(options.outputFileUri, previousContent ?? "");
          void vscode.window.showErrorMessage(
            `${options.outputLabel} generation from ${providerLabel} did not produce a valid result ` +
              `(${validation.reason}). The provider may not have followed the instructions — try again.`
          );
        } else {
          completed = true;
          const doc = await vscode.workspace.openTextDocument(
            options.outputFileUri
          );
          await vscode.window.showTextDocument(doc);
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
  implementation: "impl-high-review",
  "impl-high-review": "impl-high-review",
  "impl-low-review": "impl-low-review",
};

const REVIEW_PROMPTS: Partial<Record<TaskStage, string>> = {
  "plan-high-review": "review-plan-high.md",
  "plan-low-review": "review-plan-low.md",
  "impl-high-review": "review-impl-high.md",
  "impl-low-review": "review-impl-low.md",
};

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
  _skipOverwriteConfirmation: boolean  // kept for API compat, always skipped now
): Promise<void> {
  const targetStage = REVIEW_TARGETS[currentStage];
  const templateFile = targetStage && REVIEW_PROMPTS[targetStage];
  const reviewUri = targetStage && artifactUri(folderUri, targetStage);
  if (!targetStage || !templateFile || !reviewUri) {
    return;
  }

  const variables: Record<string, string> = {};
  const isPlanReview = isPlanReviewStage(targetStage);

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

  // Review generation uses the review-stage model (no executionStage override).
  // Only apply flows separate logStage from executionStage.
  await runAiToFile({
    extensionUri,
    taskFolderUri: folderUri,
    workspaceUri: workspaceRoot.uri,
    logStage: targetStage,
    templateFile,
    variables,
    outputFileUri: reviewUri,
    progressAction: `Re-reviewing ${STAGE_DISPLAY_NAMES[targetStage]}`,
    outputLabel: STAGE_ARTIFACT_FILENAMES[targetStage] ?? "review",
    validateOutput: validateReviewOutput,
  });
  // Note: we do NOT call setStage here.
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

/**
 * Run (or re-run) the review for the task's current position in the
 * workflow. Labeled "Re-review" in the UI.
 *
 * Requires first-use consent before any AI action runs.
 */
export async function runReviewWithAI(
  extensionUri: vscode.Uri,
  context: vscode.ExtensionContext,
  arg?: ReviewCommandArg
): Promise<void> {
  // ── Workspace guard ───────────────────────────────────────────────────────
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
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
      "Re-review: unsupported argument shape. " +
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
    "Re-review with AI"
  );
  if (!resolved) {
    return;
  }
  await runReviewForFolder(
    extensionUri,
    resolved.folderUri,
    workspaceRoot,
    resolved.progress.currentStage,
    true
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
  arg?: ReviewCommandArg
): Promise<void> {
  // ── Workspace guard ───────────────────────────────────────────────────────
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
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

  const stage = resolved.progress.currentStage;
  const reviewUri = artifactUri(resolved.folderUri, stage);
  const reviewContent = reviewUri && (await readNonEmptyText(reviewUri));
  if (!reviewContent) {
    NotificationRouter.showWarning(
      "No review found (or it is empty). Run the review before applying it."
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
      reviewContent
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
  });

  if (applySucceeded) {
    // Re-review after applying (no confirmation, no stage change)
    await runReviewForFolder(extensionUri, resolved.folderUri, workspaceRoot, stage, true);
  }
}

/**
 * Fast Forward Review: repeats the exact apply-then-re-review cycle that the
 * "Apply Review" button runs once, up to MAX_REVIEW_ATTEMPTS times, stopping
 * as soon as an attempt's readiness score improves by at least 1 over the
 * score the review had when this command started.
 *
 * Deliberately calls the unmodified applyReviewWithAI for each attempt
 * rather than re-implementing apply logic, so this can never diverge from
 * what the regular "Apply Review" button does per attempt — it only adds
 * the surrounding loop. Progress between attempts is inferred by re-reading
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
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
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

  const stage = resolved.progress.currentStage;
  const reviewUri = artifactUri(resolved.folderUri, stage);
  const initialContent = reviewUri && (await readNonEmptyText(reviewUri));
  if (!reviewUri || !initialContent) {
    NotificationRouter.showWarning(
      "No review found (or it is empty). Run the review before fast-forwarding."
    );
    return;
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

  // Concrete taskFolderPath so every attempt targets this same task without
  // resolveTask re-prompting (it already resolved the task once above).
  const concreteArg: ReviewCommandArg = { taskFolderPath: resolved.folderUri.fsPath };

  let previousContent = initialContent;
  let attemptNumber = 0;

  let outcome: Awaited<ReturnType<typeof improveReviewScore>>;
  try {
    outcome = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Fast-forwarding ${STAGE_DISPLAY_NAMES[stage] ?? "review"}...`,
        cancellable: true,
      },
      (progress, token) =>
        improveReviewScore({
          context,
          stage,
          baselineScore,
          token,
          apply: async () => {
            attemptNumber += 1;
            progress.report({
              message: `Attempt ${attemptNumber} of ${MAX_REVIEW_ATTEMPTS}...`,
            });
            await applyReviewWithAI(extensionUri, context, concreteArg);
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
      `Fast Forward Review: no improvement after ${MAX_REVIEW_ATTEMPTS} attempts (best score ${
        outcome.score ?? "—"
      }/10).`
    );
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
  reviewContent: string
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
  const model = await resolveModelForStage(folderUri, "implementation");

  const { availability, providerLabel } =
    await checkImplementationAvailabilityForModel(model.modelId);
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
    stage
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
      "Re-review with AI",
      "Create Manually"
    );
    if (choice === "Re-review with AI") {
      await vscode.commands.executeCommand(
        "vs-code-ai-helper.runReviewWithAI",
        arg
      );
    } else if (choice === "Create Manually") {
      await openOrCreateDocument(reviewUri);
    }
    return;
  }
  const doc = await vscode.workspace.openTextDocument(reviewUri);
  await vscode.window.showTextDocument(doc);
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
  if (stage === "implementation") {
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
  const advanceable = STAGE_ORDER.filter((stage) => stage !== "completed");
  const resolved = await resolveTask(node, advanceable, "Next Stage");
  if (!resolved) {
    return;
  }

  const next = computeNextStage(resolved.progress.currentStage);
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
  // copy the current plan to plan-final.md if not already there
  if (next === "implementation") {
    const resolved2 = await resolveImplementationArtifact(resolved.folderUri);
    if (!resolved2.isCanonical) {
      // Plan-final.md doesn't exist yet — copy current plan
      const currentPlanUri = await resolveCurrentPlanUri(resolved.folderUri);
      const planContent = await readNonEmptyText(currentPlanUri);
      if (!planContent) {
        NotificationRouter.showWarning(
          "No plan to promote. Write or generate a plan first."
        );
        return;
      }
      const canonicalUri = vscode.Uri.joinPath(resolved.folderUri, "plan-final.md");
      await vscode.workspace.fs.writeFile(
        canonicalUri,
        new TextEncoder().encode(planContent)
      );
    }
  }

  // ── Step 1: Persist stage transition using shared helper ──────────────────
  const transitionResult = await advanceStage(
    resolved.folderUri,
    resolved.progress.currentStage,
    next,
    resolved.progress.status === "paused",
    true // triggerAutoReview opt-in
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
  if (next === "completed") {
    await runCompletionLint(resolved.folderUri);
    return;
  }

  // ── Step 4: Auto-trigger review when eligible ────────────────────────
  // transitionResult.shouldAutoReview is already computed by advanceStage
  // using exactly-once semantics tied to the persistence result.
  if (transitionResult.shouldAutoReview) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      return;
    }
    // Re-read progress to get the newly persisted stage
    const freshProgress = await readTaskProgress(resolved.folderUri);
    if (freshProgress) {
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
  node?: TaskNodeArg
): Promise<void> {
  // ── Workspace guard ───────────────────────────────────────────────────────
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
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
  const resolved = await resolveTask(
    node,
    GENERATE_IMPL_ELIGIBLE_STAGES,
    "Generate Implementation with AI"
  );
  if (!resolved) {
    return;
  }

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
    logStage: "implementation",
    templateFile: "create-implementation.md",
    variables: { contextPack: contextPackContent, plan: planFinalContent },
    outputFileUri: implementationUri,
    progressAction: "Generating implementation",
    outputLabel: "plan-final.md",
  });

  if (succeeded) {
    await setStage(resolved.folderUri, "implementation");
  }
}

/**
 * Stages from which the AI implementation runner can be invoked.
 */
const IMPLEMENTATION_ELIGIBLE_STAGES: readonly TaskStage[] = [
  "implementation",
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
  postRunReviewStage: TaskStage = "implementation"
): Promise<void> {
  const cwd = workspaceRoot.uri.fsPath;

  // Pre-run safety checks for agentic file-editing runs
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
    // Git workspace: warn if there are uncommitted changes
    const dirty = await hasUncommittedChanges(cwd);
    if (dirty) {
      const proceed = await vscode.window.showWarningMessage(
        "⚠️ Your workspace has uncommitted changes.\n\n" +
          "The AI implementation run will edit workspace files. " +
          "For best results, commit your current changes first so you can " +
          "clearly see what the AI changed and revert if needed.",
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

  let result: Awaited<ReturnType<typeof runImplementationForModel>> | undefined;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
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

  const logUri = await writeRunLog(folderUri, result.runnerId, "implementation", logContent);

  if (result.status === "completed") {
    const implementationUri = getCanonicalImplementationUri(folderUri);

    if (!result.filesChangedUnknown && result.filesChanged.length === 0) {
      NotificationRouter.showWarning(
        "Implementation finished, but no workspace files changed. " +
          "Review the implementation run log; the provider may have been blocked from writing files."
      );
      const logDoc = await vscode.workspace.openTextDocument(logUri);
      await vscode.window.showTextDocument(logDoc);
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
        currentProgress.currentStage === "implementation" ||
        isReviewStage(currentProgress.currentStage);
      const stageUpdated = alreadyAtOrPastImplementation
        ? currentProgress
        : updateTaskProgressStage(currentProgress, "implementation");

      // filesChangedUnknown means THIS run's own change detection failed.
      // Leave implReviewFiles untouched rather than clearing it.
      if (!result!.filesChangedUnknown) {
        return updateImplReviewFiles(stageUpdated, result!.filesChanged);
      }
      return stageUpdated;
    });

    const doc = await vscode.workspace.openTextDocument(implementationUri);
    await vscode.window.showTextDocument(doc);
    // Auto-review after implementation run — bypass consent (already obtained)
    await runReviewForFolder(extensionUri, folderUri, workspaceRoot, postRunReviewStage, true);
  } else if (result.status === "cancelled") {
    NotificationRouter.showInformation("Implementation cancelled.");
  } else {
    void vscode.window.showErrorMessage(
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
  node?: TaskNodeArg
): Promise<void> {
  // ── Workspace guard ───────────────────────────────────────────────────────
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
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

  const resolved = await resolveTask(
    node,
    IMPLEMENTATION_ELIGIBLE_STAGES,
    "Run Implementation with AI"
  );
  if (!resolved) {
    return;
  }

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
  const model = await resolveModelForStage(resolved.folderUri, "implementation");

  const { availability, providerLabel } =
    await checkImplementationAvailabilityForModel(model.modelId);
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
    : "implementation";

  await executeImplementationRun(
    extensionUri,
    resolved.folderUri,
    workspaceRoot,
    prompt,
    model.modelId,
    `Running implementation with ${providerLabel} (uses your ${providerLabel} quota)...`,
    postRunReviewStage
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
      (arg?: ReviewCommandArg) => viewReview(arg)
    ),
    vscode.commands.registerCommand(
      "vs-code-ai-helper.nextStage",
      (node?: TaskNodeArg) =>
        nextStage(context.extensionUri, node)
    ),
    vscode.commands.registerCommand(
      "vs-code-ai-helper.generateImplementationWithAI",
      (node?: TaskNodeArg) =>
        generateImplementationWithAI(context.extensionUri, context, node)
    ),
    vscode.commands.registerCommand(
      "vs-code-ai-helper.runImplementationWithAI",
      (node?: TaskNodeArg) =>
        runImplementationWithAI(context.extensionUri, context, node)
    )
  );
}
