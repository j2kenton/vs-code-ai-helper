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
 * Centralized task inventory that manages discovery, duplicate suppression,
 * and provides lookup by canonical ID or path.
 */
export class TaskInventory {
  private visibleTasks: TaskWithProgress[] = [];
  private taskByCanonicalId = new Map<string, TaskWithProgress>();
  private suppressionAliasMap = new Map<string, string>();
  private readonly _onDidChange = new vscode.EventEmitter<void>();

  readonly onDidChange = this._onDidChange.event;

  private static normalizePath(p: string): string {
    const normalized = p.replace(/\\/g, "/");
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

    // Sort by updatedAt descending
    withProgress.sort((a, b) => {
      return (
        new Date(b.progress.updatedAt).getTime() -
        new Date(a.progress.updatedAt).getTime()
      );
    });

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
