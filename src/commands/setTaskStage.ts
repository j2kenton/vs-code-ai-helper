import * as vscode from "vscode";
import {
  STAGE_DISPLAY_NAMES,
  STAGE_ORDER,
  TaskStage,
} from "../types/taskProgress";
import { IncompleteTask } from "../utils/taskProgressUtils";
import { TaskInventory } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { advanceStage } from "../utils/stageTransition";
import { NotificationRouter } from "../utils/notificationRouter";
import { runCompletionLint } from "../utils/completionLint";

/**
 * Accepted argument shapes for setTaskStage.
 * - Tree-view stage node passes { task: IncompleteTask, stage: TaskStage }
 * - Resolver-aware callers pass { canonicalId?, taskFolderPath?, stage? }
 */
type SetTaskStageArg =
  | { task?: IncompleteTask; stage?: TaskStage }
  | { canonicalId?: string; taskFolderPath?: string; stage?: TaskStage };

/**
 * Normalize a command argument into the shape resolveTaskContext expects,
 * plus the requested target stage.
 *
 * Also returns whether the caller supplied an explicit task identifier so
 * the command can distinguish "explicit task that failed to resolve" from
 * "no task context supplied at all".
 */
function normalizeArg(node: SetTaskStageArg | undefined): {
  resolverArg: { canonicalId?: string; taskFolderPath?: string } | undefined;
  stage: TaskStage | undefined;
  hasExplicitTask: boolean;
} {
  if (!node) {
    return { resolverArg: undefined, stage: undefined, hasExplicitTask: false };
  }

  if ("task" in node && node.task) {
    return {
      resolverArg: { taskFolderPath: node.task.folderUri.fsPath },
      stage: node.stage,
      hasExplicitTask: true,
    };
  }

  const n = node as {
    canonicalId?: string;
    taskFolderPath?: string;
    stage?: TaskStage;
  };
  const hasExplicit = !!(n.canonicalId || n.taskFolderPath);
  return {
    resolverArg: hasExplicit
      ? { canonicalId: n.canonicalId, taskFolderPath: n.taskFolderPath }
      : undefined,
    stage: n.stage,
    hasExplicitTask: hasExplicit,
  };
}

/**
 * Let the user jump a task's tracked stage backward or forward, overriding
 * the stage the workflow last auto-advanced it to. No confirmation dialog.
 *
 * When invoked from the tasks tree view, the tree node passes a task/stage
 * pair or canonicalId/taskFolderPath so the task picker is skipped.
 *
 * After a successful stage change the task is persisted as the current task
 * in CurrentTaskStore so the keyboard shortcut router and status bar reflect
 * it immediately — CurrentTaskStore is the single source of truth for all
 * surfaces (tree, status bar, task actions).
 *
 * @param triggerAutoReview - when true (Move on to next stage), advancing into
 *   a review stage auto-triggers the corresponding review AI run.
 *   Default: false (manual set-stage-as-current does not auto-trigger review).
 */
export async function setTaskStage(
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore,
  node?: SetTaskStageArg,
  triggerAutoReview = false
): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceRoot) {
    void vscode.window.showErrorMessage(
      "No workspace folder open. Please open a folder first."
    );
    return;
  }

  const { resolverArg, stage: requestedStage, hasExplicitTask } =
    normalizeArg(node);

  // Resolve via shared inventory-backed resolver, with persisted current-task
  // support so the command works correctly from both tree-item invocation and
  // command-palette invocation.
  const resolvedTask = await resolveTaskContext(
    inventory,
    resolverArg,
    { allowPaused: true },
    currentTaskStore
  );

  if (!resolvedTask) {
    // If the caller supplied an explicit task identifier (tree
    // node, canonical ID, or folder path) but resolution failed, that means
    // the referenced task no longer exists or is no longer discoverable.
    // Silently falling through to a task picker would redirect the action
    // onto an unrelated task — exactly the wrong behaviour the resolver fix
    // was designed to prevent. Fail clearly for explicit-task callers.
    if (hasExplicitTask) {
      void vscode.window.showErrorMessage(
        "The task could not be found. It may have been deleted or moved. " +
          "Please refresh the Tasks panel and try again."
      );
      return;
    }

    // No explicit task was supplied (e.g. command-palette invocation with no
    // active task). Fall back to a quick pick over all known tasks.
    const allTasks = inventory.getTasks();
    if (allTasks.length === 0) {
      NotificationRouter.showInformation(
        "No task folders found. Use 'Start New Task' to create one."
      );
      return;
    }

    const taskItems = allTasks.map((task) => ({
      label: task.folderName,
      description: `Stage: ${STAGE_DISPLAY_NAMES[task.progress.currentStage]}`,
      detail: `Last updated: ${new Date(
        task.progress.updatedAt
      ).toLocaleString()}`,
      task,
    }));

    const selectedTaskItem =
      taskItems.length === 1
        ? taskItems[0]
        : await vscode.window.showQuickPick(taskItems, {
            placeHolder: "Select a task",
            title: "Set Task Stage",
          });

    if (!selectedTaskItem) {
      return;
    }

    // Re-enter with an explicit canonical ID so the resolver path is taken on
    // the recursive call. The hasExplicitTask guard above ensures that if this
    // new lookup also fails (very unlikely after a fresh pick), it will report
    // an error rather than looping.
    return setTaskStage(
      inventory,
      currentTaskStore,
      {
        canonicalId: selectedTaskItem.task.canonicalId,
        stage: requestedStage,
      },
      triggerAutoReview
    );
  }

  const task = resolvedTask;
  let newStage: TaskStage | undefined = requestedStage;

  if (!newStage) {
    const stageItems = STAGE_ORDER.filter(
      (stage) => stage !== task.progress.currentStage
    ).map((stage) => ({
      label: STAGE_DISPLAY_NAMES[stage],
      stage,
    }));

    const selectedStageItem = await vscode.window.showQuickPick(stageItems, {
      placeHolder: "Select the stage this task should be on",
      title: `Set Stage: ${task.folderName}`,
    });

    if (!selectedStageItem) {
      return;
    }
    newStage = selectedStageItem.stage;
  }

  if (newStage === task.progress.currentStage) {
    return;
  }

  // Persist the destination stage using the shared advanceStage helper.
  // This centralizes auto-review eligibility, transition sequencing, and persistence.
  const taskFolderUri = vscode.Uri.file(task.taskFolderPath);
  const transitionResult = await advanceStage(
    taskFolderUri,
    task.progress.currentStage,
    newStage,
    task.progress.status === "paused",
    triggerAutoReview
  );

  if (!transitionResult?.persisted) {
    void vscode.window.showErrorMessage(
      `Could not read or update task progress for ${task.folderName}.`
    );
    return;
  }

  // Refresh the inventory so the new stage is visible immediately
  await inventory.refresh();

  if (newStage === "publish") {
    await runCompletionLint(taskFolderUri);
    await inventory.refresh();
  }

  NotificationRouter.showInformation(
    `${task.folderName} set to stage: ${STAGE_DISPLAY_NAMES[newStage]}`
  );

  // Persist this task as the current task so the keyboard shortcut router and
  // status bar reflect the operated-on task immediately — CurrentTaskStore is
  // the single source of truth for all surfaces (tree, status bar, task
  // actions). This write mirrors the same write in startNewTask and
  // resumeTask, completing the "single persisted source of truth" contract.
  await currentTaskStore.set(task.canonicalId);

  // Auto-trigger review after stage is persisted, if eligible.
  // Use taskFolderPath so normalizeReviewArg in reviewActions can construct a
  // synthetic IncompleteTask for resolveTask to re-read fresh progress from
  // disk. Passing only canonicalId would fall through to the QuickPick
  // because normalizeReviewArg cannot construct a folderUri from a canonicalId.
  if (transitionResult.shouldAutoReview) {
    await vscode.commands.executeCommand("vs-code-ai-helper.runReviewWithAI", {
      taskFolderPath: task.taskFolderPath,
    });
  }
}

/**
 * Register the setTaskStage command(s).
 *
 * Two command IDs share the same underlying handler: `setTaskStage` (task-row
 * button, opens a quick-pick over all stages) and `setStageAsCurrent`
 * (stage-row button, marks that specific stage current with no picker). They
 * are split into distinct command IDs purely so each can carry its own icon
 * in package.json — sharing one command made both buttons render identically
 * and indistinguishably from "Move on to Next Stage".
 */
export function registerSetTaskStageCommand(
  context: vscode.ExtensionContext,
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore
): void {
  // When called from either tree view button, no auto-review — the user is
  // manually navigating stages.
  const handler = (node?: SetTaskStageArg): Promise<void> =>
    setTaskStage(inventory, currentTaskStore, node, false);

  const disposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.setTaskStage",
    handler
  );
  const stageDisposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.setStageAsCurrent",
    handler
  );

  context.subscriptions.push(disposable, stageDisposable);
}
