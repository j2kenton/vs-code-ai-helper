import * as vscode from "vscode";
import { STAGE_DISPLAY_NAMES, STAGE_ORDER } from "../types/taskProgress";
import { IncompleteTask } from "../utils/taskProgressUtils";

/**
 * Status bar item that always shows the most recently updated active task
 * and its current workflow stage. Clicking it runs "Resume Task".
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
   * Update the status bar from the latest task list. Hides the item when
   * there is no active (non-completed) task.
   */
  update(tasks: IncompleteTask[]): void {
    const active = tasks.find(
      (task) => task.progress.currentStage !== "completed"
    );

    if (!active) {
      this.item.hide();
      return;
    }

    const stage = active.progress.currentStage;
    const stepNumber = STAGE_ORDER.indexOf(stage) + 1;
    const totalSteps = STAGE_ORDER.length;

    this.item.text = `$(checklist) ${active.folderName}: ${STAGE_DISPLAY_NAMES[stage]} (${stepNumber}/${totalSteps})`;
    this.item.command = {
      command: "vs-code-ai-helper.resumeTask",
      title: "Resume Task",
      arguments: [{ task: active }],
    };
    this.item.tooltip = new vscode.MarkdownString(
      [
        `**Ensemble — active task**`,
        "",
        `Task: \`${active.folderName}\``,
        `Stage: **${STAGE_DISPLAY_NAMES[stage]}** (step ${stepNumber} of ${totalSteps})`,
        `Last updated: ${new Date(
          active.progress.updatedAt
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
