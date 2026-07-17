import * as vscode from "vscode";
import { TaskInventory, TaskWithProgress } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { STAGE_DISPLAY_NAMES } from "../types/taskProgress";
import { IncompleteTask, patchTaskProgress } from "../utils/taskProgressUtils";
import { NotificationRouter } from "../utils/notificationRouter";
import { runTrackedOperation } from "../utils/taskOperations";

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
 *   - It is not already completed (re-running this on an already-completed
 *     task would re-stamp `completedAt` and re-run "select next task" —
 *     re-completing is Resume/reopen's job, not this command's), AND
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
  if (
    progress.status === "paused" ||
    progress.status === "completed" ||
    progress.status === "archived"
  ) {
    return false;
  }
  return progress.currentStage === "publish";
}

/**
 * Select the next active task deterministically after completing the current
 * task. Priority order:
 *   1. The first active (non-paused, non-completed, non-archived) task in
 *      inventory order (most recently updated first) that is NOT the
 *      just-completed task.
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
      t.progress.status !== "paused" &&
      t.progress.status !== "completed" &&
      // An archived task is parked: it must never silently become the
      // current task — resuming it is an explicit user action.
      t.progress.status !== "archived"
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
 * Completion is deliberately UNGATED (C3): it never runs completion checks,
 * never prompts, and never refuses a Publish-stage task. The completion-check
 * flow (run checks, offer "Fix with AI", record a "Publish Anyway"-style
 * override in publish-review.md) belongs to the publishing commands
 * (commitAndPushTask / runLintingFixes), not to task completion — the user
 * may complete a task whenever they want.
 *
 * Ordering (strict):
 *   1. Persist completion (status + completedAt + completedStages).
 *   2. Refresh inventory.
 *   3. Select the next active task in CurrentTaskStore.
 *   4. Record the completion in the Notifications section.
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
      `"Complete Task" is only available once the task ` +
        `has reached ${STAGE_DISPLAY_NAMES["publish"]}. ` +
        `Current stage: ${currentStageName}.`
    );
    return;
  }

  const taskFolderUri = vscode.Uri.file(resolvedTask.taskFolderPath);

  // ── Step 1: Acquire the task lock and complete — no checks, no prompts ───
  // Task-level: completing a task is not scoped to one stage, so it spins the
  // task row rather than a stage row. This is an instant mutation (taxonomy),
  // so the lock is held only for the persistence writes below.
  const lockKey = taskFolderUri.fsPath;
  await runTrackedOperation(
    lockKey,
    { label: "Complete Task", taskName: resolvedTask.folderName, kind: "complete-task" },
    async () => {
    // Completion is an explicit user action. Reaching Publish alone never
    // changes lifecycle status, but this command is the durable terminal edge.
    await patchTaskProgress(taskFolderUri, (current) => ({
      ...current,
      status: "completed",
      completedAt: new Date().toISOString(),
      // Publish is the final stage. Record it explicitly so its row retains a
      // completion tick after the task moves to the completed lifecycle state.
      completedStages: Array.from(new Set([...(current.completedStages ?? []), "publish"])),
      // A completed task must never retain an actionable timer. Besides being
      // misleading, that state makes tree context validation reject the task.
      scheduledRun: undefined,
      scheduledResumeTime: undefined,
    }));
    await inventory.refresh();

    // ── Step 2: Select next active task deterministically ──────────────────
    const nextCanonicalId = selectNextTask(inventory, resolvedTask.canonicalId);
    if (nextCanonicalId) {
      await currentTaskStore.set(nextCanonicalId);
    } else {
      await currentTaskStore.clear();
    }

    // ── Step 3: Record the completion in the Notifications section ──────────
    // (taxonomy: instant-mutation → terminal entry there, no duplicate native
    // IDE toast for a success the Notifications section already records).
    NotificationRouter.showInformation(
      nextCanonicalId
        ? `${resolvedTask.folderName} complete. Next task selected.`
        : `${resolvedTask.folderName} complete. No remaining active tasks.`
    );
    }
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
