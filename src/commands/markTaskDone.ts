import * as vscode from "vscode";
import { TaskInventory, TaskWithProgress } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { advanceStage } from "../utils/stageTransition";
import { STAGE_DISPLAY_NAMES, STAGE_ORDER } from "../types/taskProgress";
import { IncompleteTask } from "../utils/taskProgressUtils";
import { runCompletionLint } from "../utils/completionLint";

/**
 * Accepted argument shapes for markTaskDone.
 * - Tree-view task node passes { task: IncompleteTask }
 * - Resolver-aware callers pass { canonicalId?, taskFolderPath? }
 */
type MarkTaskDoneArg =
  | { task?: IncompleteTask }
  | { canonicalId?: string; taskFolderPath?: string };

/**
 * Normalize a command argument into the shape resolveTaskContext expects.
 */
function normalizeArg(node: MarkTaskDoneArg | undefined): {
  canonicalId?: string;
  taskFolderPath?: string;
} | undefined {
  if (!node) {
    return undefined;
  }

  if ("task" in node && node.task) {
    return { taskFolderPath: node.task.folderUri.fsPath };
  }

  const n = node as { canonicalId?: string; taskFolderPath?: string };
  const hasExplicit = !!(n.canonicalId || n.taskFolderPath);
  return hasExplicit
    ? { canonicalId: n.canonicalId, taskFolderPath: n.taskFolderPath }
    : undefined;
}

/**
 * Whether a task is lifecycle-eligible for the "Mark Done" command.
 *
 * A task is eligible only when:
 *   - It is not paused, AND
 *   - Its current stage is the last non-completed stage (impl-low-review).
 *
 * This prevents the command from appearing on tasks that still have pending
 * review or implementation stages.
 */
export function isMarkTaskDoneEligible(
  progress: TaskWithProgress["progress"]
): boolean {
  if (progress.status === "paused") {
    return false;
  }
  const lastNonCompleted = STAGE_ORDER[STAGE_ORDER.length - 2]; // "impl-low-review"
  return progress.currentStage === lastNonCompleted;
}

/**
 * Select the next active task deterministically after completing the current
 * task. Priority order:
 *   1. The first active (non-paused, non-completed) task in inventory order
 *      (most recently updated first) that is NOT the just-completed task.
 *   2. If none exists, clear the current task store so no task is selected.
 *
 * Returns the canonicalId of the selected task, or undefined if none was found.
 */
export function selectNextTask(
  inventory: TaskInventory,
  completedCanonicalId: string
): string | undefined {
  const tasks = inventory.getTasks();
  const next = tasks.find(
    (t) =>
      t.canonicalId !== completedCanonicalId &&
      t.progress.currentStage !== "completed" &&
      t.progress.status !== "paused"
  );
  return next?.canonicalId;
}

/**
 * Mark the current task as Done and then deterministically select the next
 * active task.
 *
 * This is a dedicated completion command, separate from `nextStage`. It only
 * acts on tasks at `impl-low-review` (the last non-completed stage), refusing
 * to act on tasks that still have work remaining.
 *
 * Completion lifecycle ordering (strict):
 *   1. Persist completion via advanceStage → patchTaskProgress.
 *   2. Refresh inventory so the completed task's new stage is reflected.
 *   3. Select the next active task in CurrentTaskStore.
 *   4. Show completion info message.
 *   5. (Lint payload is persisted separately by runLintingFixes; not here.)
 */
export async function markTaskDone(
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore,
  explicitArg?: MarkTaskDoneArg
): Promise<void> {
  const resolverArg = normalizeArg(explicitArg);
  const hasExplicitArg = resolverArg !== undefined;

  // ── Step 0: Resolve the task ─────────────────────────────────────────────
  const resolvedTask = await resolveTaskContext(
    inventory,
    resolverArg,
    { allowPaused: false },
    currentTaskStore
  );

  if (!resolvedTask) {
    if (hasExplicitArg) {
      void vscode.window.showErrorMessage(
        "The task could not be found. It may have been deleted or moved. " +
          "Please refresh the Tasks panel and try again."
      );
    } else {
      void vscode.window.showInformationMessage(
        "No active task found. Select a task first using the Tasks panel."
      );
    }
    return;
  }

  // ── Lifecycle eligibility check ──────────────────────────────────────────
  if (!isMarkTaskDoneEligible(resolvedTask.progress)) {
    const currentStageName =
      STAGE_DISPLAY_NAMES[resolvedTask.progress.currentStage];
    void vscode.window.showWarningMessage(
      `"Mark Task Done" is only available when the task is at the final ` +
        `review stage (${STAGE_DISPLAY_NAMES["impl-low-review"]}). ` +
        `Current stage: ${currentStageName}.`
    );
    return;
  }

  // ── Step 1: Persist completion ───────────────────────────────────────────
  const taskFolderUri = vscode.Uri.file(resolvedTask.taskFolderPath);
  const transitionResult = await advanceStage(
    taskFolderUri,
    resolvedTask.progress.currentStage,
    "completed",
    false, // not paused — eligibility check above ensures this
    false  // no auto-review on completion
  );

  if (!transitionResult?.persisted) {
    void vscode.window.showErrorMessage(
      `Could not persist completion for ${resolvedTask.folderName}. Please try again.`
    );
    return;
  }

  // ── Step 2: Refresh inventory ────────────────────────────────────────────
  await inventory.refresh();

  // Completion lint is part of the transition, so completed tasks never
  // silently remain in an unknown lint state.
  const lintResult = await runCompletionLint(taskFolderUri);
  await inventory.refresh();

  // ── Step 3: Select next active task deterministically ────────────────────
  const nextCanonicalId = selectNextTask(inventory, resolvedTask.canonicalId);
  if (nextCanonicalId) {
    await currentTaskStore.set(nextCanonicalId);
  } else {
    await currentTaskStore.clear();
  }

  // ── Step 4: Show completion message ──────────────────────────────────────
  void vscode.window.showInformationMessage(
    nextCanonicalId
      ? `${resolvedTask.folderName} marked as done (${lintResult.passed ? "lint passed" : "lint issues found"}). Next task selected.`
      : `${resolvedTask.folderName} marked as done (${lintResult.passed ? "lint passed" : "lint issues found"}). No remaining active tasks.`
  );
}

/**
 * Register the markTaskDone command.
 */
export function registerMarkTaskDoneCommand(
  context: vscode.ExtensionContext,
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore
): void {
  const disposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.markTaskDone",
    (arg?: MarkTaskDoneArg) => markTaskDone(inventory, currentTaskStore, arg)
  );
  context.subscriptions.push(disposable);
}
