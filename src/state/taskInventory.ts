import * as path from "path";
import * as vscode from "vscode";
import { discoverAllTasks, DiscoveredTask } from "../utils/taskRoot";
import { readTaskProgress } from "../utils/taskProgressUtils";
import { TaskProgress } from "../types/taskProgress";

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
   * Refresh the task inventory by discovering all tasks and loading their progress.
   */
  async refresh(): Promise<void> {
    const discovered = await discoverAllTasks();

    // Load progress for visible tasks
    const withProgress: TaskWithProgress[] = [];

    for (const task of discovered) {
      try {
        const progress = await readTaskProgress(vscode.Uri.file(task.taskFolderPath));
        if (!progress) {
          continue;
        }

        withProgress.push({
          ...task,
          progress,
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
