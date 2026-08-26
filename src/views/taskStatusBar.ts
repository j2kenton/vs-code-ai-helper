import * as vscode from "vscode";
import { STAGE_DISPLAY_NAMES } from "../types/taskProgress";
import { IncompleteTask } from "../types/incompleteTask";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { taskOperations } from "../utils/taskOperations";
import { describeOwedContinuationRowIndicatorV1 } from "./taskTreeProvider";

/**
 * Status bar item that shows the persisted current task from CurrentTaskStore.
 *
 * The bar is always visible. When there is no active non-completed task, it
 * displays a neutral state. Clicking the status bar opens a menu of context-sensitive
 * actions, including "New task...", "Resume shown task" (if paused), or "Open shown task".
 *
 * Matching priority for resolving the stored canonical ID against the task
 * list:
 *   1. `task.canonicalId` — the normalized absolute path produced by
 *      taskRoot.ts (lowercased on Windows) and persisted by CurrentTaskStore.
 *      This is the authoritative comparison.
 *   2. `task.folderUri.fsPath` — fallback for legacy IncompleteTask objects
 *      that lack a canonicalId field.
 */
export class TaskStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private lastTasks: IncompleteTask[] = [];
  private lastCurrentTaskId: string | undefined = undefined;
  private readonly onDidChangeSub: vscode.Disposable;

  constructor(private readonly currentTaskStore: CurrentTaskStore) {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.item.command = "vs-code-ai-helper.statusBarMenu";
    this.onDidChangeSub = taskOperations.onDidChange(() => {
      this.update(this.lastTasks, this.lastCurrentTaskId);
    });
  }

  /**
   * Update the status bar from the latest task list and current-task canonical ID.
   *
   * If a matching active non-completed task exists, displays the progress.
   * Otherwise, shows a neutral state.
   */
  update(
    tasks: IncompleteTask[],
    currentTaskCanonicalId: string | undefined
  ): void {
    this.lastTasks = tasks;
    this.lastCurrentTaskId = currentTaskCanonicalId;

    // Find the task matching the stored canonical ID.
    const taskToShow = tasks.find(
      (t) =>
        (t.canonicalId !== undefined && t.canonicalId === currentTaskCanonicalId) ||
        t.folderUri.fsPath === currentTaskCanonicalId
    );

    // Stored ID is stale (task was deleted or moved) -> clear and set to undefined.
    if (currentTaskCanonicalId && !taskToShow) {
      void this.currentTaskStore.clear();
      this.lastCurrentTaskId = undefined;
    }

    const isCompleted = taskToShow?.progress.status === "completed";
    const hasActiveNonCompleted = taskToShow && !isCompleted;
    const isRunning = taskOperations.hasAny();
    const icon = isRunning ? "$(sync~spin)" : "$(checklist)";

    if (!hasActiveNonCompleted) {
      // Neutral state when no active non-completed task exists
      this.item.text = `${icon} Ensemble: No active task`;
      this.item.tooltip = new vscode.MarkdownString(
        [
          `**Ensemble**`,
          "",
          `No active task.`,
          "",
          `_Click to open Ensemble menu_`,
        ].join("\n")
      );
      this.item.show();
      return;
    }

    const stage = taskToShow.progress.currentStage;
    const isPaused = taskToShow.progress.status === "paused";
    const statusLabel = isPaused ? "paused" : "active";

    // Passive-case standing indicator (wf10 item 11's passive complement):
    // when the shown task carries an owed continuation and nothing is
    // running for it, the bar otherwise reads identically to a task with
    // nothing owed for the length of the lease. Checked against THIS task's
    // own operations specifically (not the global `isRunning`, which is true
    // whenever ANY task has a live operation) — a running continuation
    // already reads as "in progress" via the spinner icon above.
    const thisTaskHasLiveOperation =
      taskOperations.getTaskOperations(taskToShow.canonicalId ?? taskToShow.folderUri.fsPath).length > 0;
    const owedIndicator =
      !isPaused && !thisTaskHasLiveOperation
        ? describeOwedContinuationRowIndicatorV1(
            taskToShow.progress.implRecovery,
            taskToShow.progress.incompleteRoundContinuations ?? 0
          )
        : undefined;

    // Quarantined files behind the owed continuation, if any — mirrors the
    // tree tooltip's "What happens next" line (`describeSchedulingPostureV1`'s
    // `owedWillNotRetry` case), which already names these via the scheduling
    // posture ledger. The status bar has no ledger access, so this reads
    // `pendingImplReviewFiles` directly rather than pulling in that mechanism.
    const quarantinedFiles = taskToShow.progress.pendingImplReviewFiles ?? [];
    const quarantinedFilesLine =
      owedIndicator && quarantinedFiles.length > 0
        ? `$(files) ${quarantinedFiles.length} file(s) quarantined behind it: ${quarantinedFiles.join(", ")}`
        : undefined;

    // Text: Checklist, folderName, stage display name, status
    this.item.text = `${icon} ${taskToShow.folderName}: ${STAGE_DISPLAY_NAMES[stage]}${isPaused ? " [paused]" : ""}${owedIndicator ? ` — ${owedIndicator.description}` : ""}`;
    this.item.tooltip = new vscode.MarkdownString(
      [
        `**Ensemble — ${statusLabel} task**`,
        "",
        `Task: \`${taskToShow.folderName}\``,
        `Stage: **${STAGE_DISPLAY_NAMES[stage]}**`,
        ...(owedIndicator ? [`$(watch) ${owedIndicator.description}`] : []),
        ...(quarantinedFilesLine ? [quarantinedFilesLine] : []),
        `Last updated: ${new Date(
          taskToShow.progress.updatedAt
        ).toLocaleString()}`,
        "",
        `_Click to open Ensemble menu_`,
      ].join("\n")
    );
    this.item.show();
  }

  /**
   * Display a quick pick menu of context-sensitive actions.
   */
  async showMenu(): Promise<void> {
    const taskToShow = this.lastTasks.find(
      (t) =>
        (t.canonicalId !== undefined && t.canonicalId === this.lastCurrentTaskId) ||
        t.folderUri.fsPath === this.lastCurrentTaskId
    );

    interface ActionQuickPickItem extends vscode.QuickPickItem {
      command: string;
      arg?: unknown;
    }

    const items: ActionQuickPickItem[] = [];

    if (taskToShow) {
      if (taskToShow.progress.status === "paused") {
        items.push({
          label: `$(debug-continue) Resume shown task`,
          description: taskToShow.folderName,
          detail: `Resume the paused task and set to active`,
          command: "vs-code-ai-helper.resumeTask",
          arg: { task: taskToShow },
        });
      } else {
        items.push({
          label: `$(file-text) Open shown task`,
          description: taskToShow.folderName,
          detail: `Open task.md in editor`,
          command: "vs-code-ai-helper.viewTask",
          arg: { task: taskToShow },
        });
      }
    }

    items.push({
      label: `$(add) New task...`,
      detail: `Create a new task folder with optional description`,
      command: "vs-code-ai-helper.startNewTask",
    });

    const selected = await vscode.window.showQuickPick(items, {
      title: "Ensemble Actions",
      placeHolder: "Select an action to perform",
    });

    if (selected) {
      void vscode.commands.executeCommand(selected.command, selected.arg);
    }
  }

  dispose(): void {
    this.onDidChangeSub.dispose();
    this.item.dispose();
  }
}
