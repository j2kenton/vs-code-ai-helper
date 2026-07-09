import * as vscode from "vscode";
import { STAGE_DISPLAY_NAMES, STAGE_ORDER } from "../types/taskProgress";
import { IncompleteTask } from "../utils/taskProgressUtils";

/**
 * Status bar item that shows the persisted current task from CurrentTaskStore.
 *
 * The bar is only shown when `currentTaskCanonicalId` resolves to a live task.
 * It never fabricates a "current task" by heuristic — CurrentTaskStore is the
 * single persisted source of truth, and when the store is empty the bar stays
 * hidden. This keeps the status bar consistent with the tree badge, the task
 * action router, and reveal behaviour.
 *
 * When the stored ID is stale (task deleted), the bar also hides so all
 * surfaces remain in sync.
 *
 * Matching priority for resolving the stored canonical ID against the task
 * list:
 *   1. `task.canonicalId` — the normalized absolute path produced by
 *      taskRoot.ts (lowercased on Windows) and persisted by CurrentTaskStore.
 *      This is the authoritative comparison; it handles Windows case
 *      differences between the stored ID and `folderUri.fsPath`.
 *   2. `task.folderUri.fsPath` — fallback for legacy IncompleteTask objects
 *      that were not sourced through TaskInventory and therefore lack a
 *      canonicalId field.
 */
export class TaskStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
  }

  /**
   * Update the status bar from the latest task list and current-task canonical ID.
   *
   * Shows the matching task when `currentTaskCanonicalId` is set and still
   * present in `tasks`. Hides in every other case (no ID stored, or stored ID
   * is stale).
   */
  update(
    tasks: IncompleteTask[],
    currentTaskCanonicalId: string | undefined
  ): void {
    // No current task persisted → hide and return immediately.
    if (!currentTaskCanonicalId) {
      this.item.hide();
      return;
    }

    // Find the task matching the stored canonical ID.
    // Prefer task.canonicalId (the normalized key stored by CurrentTaskStore)
    // over task.folderUri.fsPath to handle Windows case normalization.
    const taskToShow = tasks.find(
      (t) =>
        (t.canonicalId !== undefined && t.canonicalId === currentTaskCanonicalId) ||
        t.folderUri.fsPath === currentTaskCanonicalId
    );

    // Stored ID is stale (task was deleted or moved) → hide.
    if (!taskToShow) {
      this.item.hide();
      return;
    }

    const stage = taskToShow.progress.currentStage;
    const stepNumber = STAGE_ORDER.indexOf(stage) + 1;
    const totalSteps = STAGE_ORDER.length;

    this.item.text = `$(checklist) ${taskToShow.folderName}: ${STAGE_DISPLAY_NAMES[stage]} (${stepNumber}/${totalSteps})`;
    this.item.command = {
      command: "vs-code-ai-helper.resumeTask",
      title: "Resume Task",
      arguments: [{ task: taskToShow }],
    };
    this.item.tooltip = new vscode.MarkdownString(
      [
        `**Ensemble — active task**`,
        "",
        `Task: \`${taskToShow.folderName}\``,
        `Stage: **${STAGE_DISPLAY_NAMES[stage]}** (step ${stepNumber} of ${totalSteps})`,
        `Last updated: ${new Date(
          taskToShow.progress.updatedAt
        ).toLocaleString()}`,
        "",
        "_Click to resume this task_",
      ].join("\n")
    );
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
