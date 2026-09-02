import * as vscode from "vscode";
import { STAGE_DISPLAY_NAMES } from "../types/taskProgress";
import { IncompleteTask } from "../types/incompleteTask";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { taskOperations } from "../utils/taskOperations";
import { describeOwedContinuationRowIndicatorV1 } from "./taskTreeProvider";
import { getExtensionContextV1 } from "../utils/extensionContextV1";
import {
  SchedulingIntentStoreV1,
  SchedulingPostureV1,
  deriveOwedContinuationRecordV1,
  deriveSchedulingPostureV1,
  describeSchedulingPostureShortLabelV1,
  describeSchedulingPostureV1,
} from "../state/schedulingIntentV1";
import { renderRequiredHandoffFieldsV1 } from "../types/handoffGuidanceV1";

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

    if (taskToShow && isCompleted && (taskToShow.progress.completedWithMissingArtifacts?.length ?? 0) > 0) {
      const missing = taskToShow.progress.completedWithMissingArtifacts!
        .map((entry) => `${STAGE_DISPLAY_NAMES[entry.stage]}: ${entry.artifact}`)
        .join(", ");
      this.item.text = `$(warning) ${taskToShow.folderName}: completed with missing artifact`;
      this.item.tooltip = new vscode.MarkdownString(
        [
          `**Ensemble — completed with missing required artifact(s)**`,
          "",
          `Task: \`${taskToShow.folderName}\``,
          `Missing when explicitly completed: ${missing}`,
          "",
          `_Click to open Ensemble menu_`,
        ].join("\n")
      );
      this.item.show();
      return;
    }

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
    // posture ledger.
    const quarantinedFiles = taskToShow.progress.pendingImplReviewFiles ?? [];
    const quarantinedFilesLine =
      owedIndicator && quarantinedFiles.length > 0
        ? `$(files) ${quarantinedFiles.length} file(s) quarantined behind it: ${quarantinedFiles.join(", ")}`
        : undefined;

    // General scheduling posture (task item 11's five-value vocabulary:
    // running / scheduled / owed-but-will-not-retry / waiting-for-you /
    // unknown) — the same shared contract the task-tree tooltip's own "What
    // happens next" line uses (`TaskTreeProvider.computeSchedulingPosture` +
    // `describeSchedulingPostureV1`), so the status bar stops being a
    // verification blind spot for state the tree already renders (wf10 H4,
    // this task's item 11 hand-off). `owedIndicator` above already covers the
    // owed-continuation case with lease-time precision the ledger read below
    // cannot beat, so this is computed only when it adds new information —
    // i.e. whenever the owed row indicator is absent.
    //
    // 2026-09-02 review, completion blocker ("only the owed-continuation
    // posture reaches visible `item.text`; the other four postures are
    // tooltip-only and untested"): `shortLabel` now goes into the VISIBLE
    // text, not only the tooltip — the exact "a tooltip is not a surface for
    // state the user must act on" rule item 11 already established for the
    // tree row (nobody hovers to find out whether something is alive). The
    // full sentence (`detail`) stays in the tooltip for elaboration.
    const posture = owedIndicator ? undefined : this.derivePostureFields(taskToShow);

    // Text: Checklist, folderName, stage display name, status, posture
    this.item.text =
      `${icon} ${taskToShow.folderName}: ${STAGE_DISPLAY_NAMES[stage]}${isPaused ? " [paused]" : ""}` +
      `${owedIndicator ? ` — ${owedIndicator.description}` : ""}` +
      `${posture ? ` — ${posture.shortLabel}` : ""}`;
    this.item.tooltip = new vscode.MarkdownString(
      [
        `**Ensemble — ${statusLabel} task**`,
        "",
        `Task: \`${taskToShow.folderName}\``,
        `Stage: **${STAGE_DISPLAY_NAMES[stage]}**`,
        ...(owedIndicator ? [`$(watch) ${owedIndicator.description}`] : []),
        ...(quarantinedFilesLine ? [quarantinedFilesLine] : []),
        ...(posture ? [`$(watch) **What happens next** — ${posture.detail}`] : []),
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
   * Read-only derivation of `SchedulingPostureV1` for `task`, as both a
   * status-bar-length `shortLabel` (visible text) and the full "What happens
   * next" sentence (`detail`, tooltip only) — or `undefined` when no
   * scheduling-intent store is reachable (no active `vscode.ExtensionContext`
   * — e.g. under unit tests that stub `vscode.window`/`vscode.workspace`
   * without activating the extension).
   *
   * Deliberately does NOT await the ledger self-heal write
   * (`SchedulingIntentStoreV1.recordOwedContinuation`) the way
   * `TaskTreeProvider.computeSchedulingPosture` does — `update()` must stay
   * synchronous (it runs from a plain `taskOperations.onDidChange`
   * callback with no async caller to await it). The write is instead fired
   * best-effort, matching every other fire-and-forget ledger writer in
   * `schedulingIntentV1.ts`'s own documented "escape hatch" pattern for
   * callers with no natural async entry point: a render before the first
   * self-heal lands may under-report (read `unknown`/stale instead of the
   * freshly-owed fact), and self-corrects on the next update.
   */
  private derivePostureFields(
    task: IncompleteTask
  ): { shortLabel: string; detail: string } | undefined {
    const context = getExtensionContextV1();
    if (!context) {
      return undefined;
    }
    const taskId = task.canonicalId ?? task.folderUri.fsPath;
    const store = new SchedulingIntentStoreV1(context.workspaceState);
    const owedSource = task.progress.implRecovery
      ? {
          reason: task.progress.implRecovery.reason,
          at: task.progress.implRecovery.at,
          leaseUntil: task.progress.implRecovery.leaseUntil,
          quarantinedFiles: task.progress.pendingImplReviewFiles ?? [],
          dispatch: task.progress.implRecovery.dispatch,
        }
      : undefined;
    store.recordOwedContinuation(taskId, owedSource).then(undefined, () => {
      // Best-effort self-heal only — never blocks or fails this render.
    });
    const posture: SchedulingPostureV1 = deriveSchedulingPostureV1({
      entries: store.listForTask(taskId),
      owedContinuation: deriveOwedContinuationRecordV1(taskId, store.getOwedContinuation(taskId)),
      hasCoverage: store.hasCoverage(taskId),
      inFlight: taskOperations.rootOperationIdFor(taskId) !== undefined,
    });
    const rendered = renderRequiredHandoffFieldsV1("scheduledWork", describeSchedulingPostureV1(posture));
    return {
      shortLabel: describeSchedulingPostureShortLabelV1(posture),
      detail: rendered.map((line) => line.text).join(" "),
    };
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
