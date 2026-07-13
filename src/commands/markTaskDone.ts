import * as vscode from "vscode";
import { TaskInventory, TaskWithProgress } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { STAGE_DISPLAY_NAMES } from "../types/taskProgress";
import { IncompleteTask, patchTaskProgress } from "../utils/taskProgressUtils";
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
 * Whether a task is lifecycle-eligible for the "Complete and Move On to Next
 * Task" command.
 *
 * A task is eligible only when:
 *   - It is not paused, AND
 *   - It has already reached the Publish stage ("completed").
 *
 * Reaching Publish (via `nextStage` from impl-low-review) does not itself
 * select the next task — that only happens once this command runs, so the
 * user gets a chance to fix lint issues / commit / push on the Publish row
 * first.
 */
export function isMarkTaskDoneEligible(
  progress: TaskWithProgress["progress"]
): boolean {
  if (progress.status === "paused") {
    return false;
  }
  return progress.currentStage === "publish";
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
      t.progress.currentStage !== "publish" &&
      t.progress.status !== "paused"
  );
  return next?.canonicalId;
}

/**
 * Complete a task that has already reached the Publish stage and
 * deterministically select the next active task.
 *
 * This is a dedicated completion command, separate from `nextStage`. The
 * transition into Publish ("completed") happens earlier, via the normal
 * `nextStage` advance from impl-low-review — reaching Publish does not by
 * itself select the next task, so the user gets a chance to fix lint issues,
 * commit, and push on the Publish row first. This command only performs the
 * final "move on" step.
 *
 * Ordering (strict):
 *   1. Re-run completion lint for a fresh read (picks up any fixes made
 *      while on the Publish row).
 *   2. Verify the Publish review has a strict 10/10 score.
 *   3. Refresh inventory.
 *   4. Select the next active task in CurrentTaskStore.
 *   5. Show completion info message.
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
      `"Complete and Move On to Next Task" is only available once the task ` +
        `has reached ${STAGE_DISPLAY_NAMES["publish"]}. ` +
        `Current stage: ${currentStageName}.`
    );
    return;
  }

  // ── Step 1: Re-run completion lint for a fresh, final read ───────────────
  const taskFolderUri = vscode.Uri.file(resolvedTask.taskFolderPath);
  const lintResult = await runCompletionLint(taskFolderUri, resolvedTask.progress.implReviewFiles);
  if (!lintResult.passed) {
    void vscode.window.showWarningMessage(
      `Cannot complete ${resolvedTask.folderName}: completion checks are still failing. Fix the reported issues and try again.`
    );
    return;
  }

  // Completion is an explicit user action. Reaching Publish alone never
  // changes lifecycle status, but this command is the durable terminal edge.
  await patchTaskProgress(taskFolderUri, (current) => ({
    ...current,
    status: "completed",
    completedAt: new Date().toISOString(),
    // A completed task must never retain an actionable timer. Besides being
    // misleading, that state makes tree context validation reject the task.
    scheduledRun: undefined,
    scheduledResumeTime: undefined,
  }));
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
      ? `${resolvedTask.folderName} complete (lint passed). Next task selected.`
      : `${resolvedTask.folderName} complete (lint passed). No remaining active tasks.`
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
