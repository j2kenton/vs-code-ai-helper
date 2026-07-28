import * as path from "path";
import * as vscode from "vscode";
import { discoverAllTasks, DiscoveredTask } from "../utils/taskRoot";
import { readTaskProgress } from "../utils/taskProgressUtils";
import { TaskProgress } from "../types/taskProgress";
import { repairLegacyOwnership } from "../utils/metaResourcesMigration";
import { LegacyCreatingStartupGateV0 } from "./legacyCreatingStartupGateV0";
import { deriveTaskBindingV1 } from "../types/taskBindingV1";

/**
 * A task with its progress metadata loaded
 */
export interface TaskWithProgress extends DiscoveredTask {
  progress: TaskProgress;
}

/**
 * Parse a task folder name into its canonical ordering key: the creation
 * date plus the per-day task number (e.g. `2026-07-08_task_12` →
 * `{ date: "2026-07-08", num: 12 }`). Returns undefined for names that do
 * not follow the generated convention.
 *
 * @internal exported for testing
 */
export function parseTaskOrderKey(
  folderName: string
): { date: string; num: number } | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})_.*?(\d+)\s*$/.exec(folderName);
  const date = match?.[1];
  const num = match?.[2];
  if (!date || !num) {
    return undefined;
  }
  return { date, num: Number.parseInt(num, 10) };
}

/**
 * Ordering rule for the task list: strictly newest-to-oldest by the task's
 * ID (creation date, then task number). Status and activity never
 * participate, so completing/pausing a task can never reshuffle the list.
 * Non-conventional folder names fall back to a numeric-aware name compare
 * and sort after conventional ones.
 *
 * @internal exported for testing
 */
export function compareTasksNewestFirst(a: string, b: string): number {
  const keyA = parseTaskOrderKey(a);
  const keyB = parseTaskOrderKey(b);
  if (keyA && keyB) {
    if (keyA.date !== keyB.date) {
      return keyB.date.localeCompare(keyA.date);
    }
    if (keyA.num !== keyB.num) {
      return keyB.num - keyA.num;
    }
    return b.localeCompare(a, undefined, { numeric: true });
  }
  if (keyA) return -1;
  if (keyB) return 1;
  return b.localeCompare(a, undefined, { numeric: true });
}

/**
 * Centralized task inventory that manages discovery, duplicate suppression,
 * and provides lookup by canonical ID or path.
 */
export class TaskInventory {
  private visibleTasks: TaskWithProgress[] = [];
  private taskByCanonicalId = new Map<string, TaskWithProgress>();
  private suppressionAliasMap = new Map<string, string>();
  private readonly _onDidChange = new vscode.EventEmitter<void>();

  readonly onDidChange = this._onDidChange.event;

  // Must match the normalization in taskRoot.ts's normalizePath, since
  // canonicalId (used as the map key) is produced there. path.normalize
  // preserves platform-native separators (backslashes on Windows), so
  // this cannot use a forward-slash replacement or lookups will never
  // match the stored keys.
  private static normalizePath(p: string): string {
    const normalized = path.normalize(p);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  }

  /**
   * True while a refresh() call is in flight. Mirrored to the
   * `vs-code-ai-helper.isLoadingTasks` context key so the tasks view's
   * "Loading tasks…" welcome content can distinguish "still discovering
   * tasks" from "discovery finished and found nothing".
   */
  private loading = false;

  /**
   * True once refresh() has completed (successfully or not) at least once.
   * Mirrored to `vs-code-ai-helper.tasksInitialized`. Kept separate from
   * TaskTreeProvider's onDidLoadTasks event, which can fire against a
   * still-empty inventory before the first refresh() resolves — using that
   * event to drive tasksInitialized let the tasks view flash its "No tasks
   * yet" empty state before the real (async) load had finished.
   */
  private loadedOnce = false;

  /** Whether a refresh() is currently in flight. */
  isLoading(): boolean {
    return this.loading;
  }

  /** Whether refresh() has completed at least once since construction. */
  hasLoadedOnce(): boolean {
    return this.loadedOnce;
  }

  /**
   * Refresh the task inventory by discovering all tasks and loading their progress.
   */
  async refresh(): Promise<void> {
    this.loading = true;
    void vscode.commands.executeCommand("setContext", "vs-code-ai-helper.isLoadingTasks", true);
    try {
      // Self-gate on the activation-order barrier (plan §1.4): the first
      // inventory publication must observe the startup gate's completed
      // read-only classification of legacy `creating` folders. extension.ts
      // also chains its refresh triggers on startupGateReady, but enforcing
      // the barrier here means a future refresh() caller that forgets that
      // chain still cannot publish inventory ahead of the classification
      // pass. Resolves immediately outside activation.
      await LegacyCreatingStartupGateV0.waitUntilReady();
      const discovered = await discoverAllTasks();

      // Load progress for visible tasks
      const withProgress: TaskWithProgress[] = [];

      for (const task of discovered) {
        try {
          const progress = await readTaskProgress(vscode.Uri.file(task.taskFolderPath));
          if (!progress) {
            continue;
          }

          const repaired = await repairLegacyOwnership(
            task.taskFolderPath,
            progress,
            task.resolvedTaskRootPath ?? path.dirname(task.taskFolderPath)
          );
          withProgress.push({
            ...task,
            progress: repaired.progress,
          });
        } catch {
          // Task folder exists but no valid progress file, skip
        }
      }

      // Keep a stable ID/date order, newest first. Status and activity must
      // not reshuffle tasks, which made paused tasks appear to move
      // unexpectedly.
      withProgress.sort((a, b) => compareTasksNewestFirst(a.folderName, b.folderName));

      this.visibleTasks = withProgress;

      // Rebuild lookup maps
      this.taskByCanonicalId.clear();
      for (const task of withProgress) {
        this.taskByCanonicalId.set(task.canonicalId, task);
      }

      // Suppression alias map is not currently implemented because
      // duplicate suppression happens in taskRoot.ts before we get here.
      // For now, clear it.
      this.suppressionAliasMap.clear();

      this._onDidChange.fire();
    } finally {
      // Runs on both the success path above and on a thrown error, so a
      // failed discovery still clears the loading state instead of leaving
      // the tasks view stuck on "Loading tasks…" forever. tasksInitialized
      // is intentionally monotonic (never reset back to false by a later
      // refresh) — once real data has been shown, subsequent background
      // refreshes must not make the tasks view flash back to a loading/empty
      // welcome state.
      this.loading = false;
      this.loadedOnce = true;
      void vscode.commands.executeCommand("setContext", "vs-code-ai-helper.isLoadingTasks", false);
      void vscode.commands.executeCommand("setContext", "vs-code-ai-helper.tasksInitialized", true);
    }
  }

  /**
   * Get all visible tasks
   */
  getTasks(): readonly TaskWithProgress[] {
    return this.visibleTasks;
  }

  /**
   * Get a task by its canonical ID
   */
  getTaskById(canonicalId: string): TaskWithProgress | undefined {
    return this.taskByCanonicalId.get(canonicalId);
  }

  /**
   * Get a task by its absolute path
   */
  getTaskByPath(absolutePath: string): TaskWithProgress | undefined {
    return this.taskByCanonicalId.get(TaskInventory.normalizePath(absolutePath));
  }

  /**
   * Get a task by its ownership-derived `TaskBindingV1.bindingId` (plan
   * §3.9). Used where only the digest identity is available — never a raw
   * path — such as reconstructing a Chat interaction's owning task from its
   * durable transaction's `taskBindingId` (plan §3.1) for an explicit Resume.
   * `O(n)` over currently visible tasks; fine for the rare Resume path, not
   * meant for hot lookups.
   */
  getTaskByBindingId(taskBindingId: string): TaskWithProgress | undefined {
    for (const task of this.visibleTasks) {
      const derived = deriveTaskBindingV1(task.progress);
      if (derived.ok && derived.binding.bindingId === taskBindingId) {
        return task;
      }
    }
    return undefined;
  }

  /**
   * Get the visible task for a suppressed canonical ID (if any)
   */
  getVisibleTaskForSuppressedId(
    suppressedId: string
  ): TaskWithProgress | undefined {
    const keptId = this.suppressionAliasMap.get(suppressedId);
    if (keptId) {
      return this.taskByCanonicalId.get(keptId);
    }
    return undefined;
  }

  /**
   * Get the visible task for a suppressed path (if any)
   */
  getVisibleTaskForSuppressedPath(
    suppressedPath: string
  ): TaskWithProgress | undefined {
    return this.getVisibleTaskForSuppressedId(
      TaskInventory.normalizePath(suppressedPath)
    );
  }
}
