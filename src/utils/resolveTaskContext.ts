import * as vscode from "vscode";
import { TaskInventory, TaskWithProgress } from "../state/taskInventory";
import { CurrentTaskStore } from "./currentTaskStore";

export interface ResolvedTaskContext {
  /** Canonical task ID (normalized absolute path) */
  canonicalId: string;
  /** Absolute task folder path */
  taskFolderPath: string;
  /** Task folder name */
  folderName: string;
  /** Source scope key */
  sourceScopeKey: string;
  /** Owning workspace folder, if applicable */
  workspaceFolder?: vscode.Uri;
  /** Current task progress */
  progress: TaskWithProgress["progress"];
}

export interface ResolveTaskOptions {
  /** Allow resolving paused tasks */
  allowPaused?: boolean;
}

/**
 * Attempt to look up a task from the inventory by canonical ID or path,
 * also checking the suppression alias map.
 */
function lookupInInventory(
  inventory: TaskInventory,
  canonicalId?: string,
  taskFolderPath?: string
): TaskWithProgress | undefined {
  if (canonicalId) {
    return (
      inventory.getTaskById(canonicalId) ??
      inventory.getVisibleTaskForSuppressedId(canonicalId)
    );
  }
  if (taskFolderPath) {
    return (
      inventory.getTaskByPath(taskFolderPath) ??
      inventory.getVisibleTaskForSuppressedPath(taskFolderPath)
    );
  }
  return undefined;
}

/**
 * Shared command-side task resolver. Resolves the target task from explicit
 * arguments or the persisted current task, or fails consistently.
 *
 * Resolution order:
 *   1. Explicit tree-item / canonical-id / path argument — always resolved
 *      against the live inventory. If the inventory does not contain the
 *      requested task after one refresh, resolution FAILS. Stale / deleted
 *      task objects are never returned.
 *   2. Persisted current-task canonical ID from CurrentTaskStore. If the
 *      persisted ID no longer resolves after one refresh, resolution FAILS.
 *
 * There is intentionally NO last-resort "first active task" fallback.
 * Falling back silently would cause the shortcut to act on an unrelated task
 * when the user has not yet set a current task or after a task is deleted.
 *
 * If a lookup misses the current inventory snapshot, one on-demand refresh
 * is performed before the final failure.
 */
export async function resolveTaskContext(
  inventory: TaskInventory,
  explicitTask?: TaskWithProgress | { canonicalId?: string; taskFolderPath?: string },
  options?: ResolveTaskOptions,
  currentTaskStore?: CurrentTaskStore
): Promise<ResolvedTaskContext | undefined> {
  let resolved: TaskWithProgress | undefined;

  // ----------------------------------------------------------------
  // Step 1: Resolve from explicit argument
  // ----------------------------------------------------------------
  if (explicitTask) {
    if ("progress" in explicitTask) {
      // The caller passed a full TaskWithProgress object (e.g. from a tree
      // item). We MUST verify it still exists in the live inventory rather
      // than returning stale path/progress data. The canonical ID is the
      // key — if the inventory no longer knows about it, the task was
      // deleted or is no longer discoverable.
      resolved =
        inventory.getTaskById(explicitTask.canonicalId) ??
        inventory.getVisibleTaskForSuppressedId(explicitTask.canonicalId);
    } else {
      resolved = lookupInInventory(
        inventory,
        explicitTask.canonicalId,
        explicitTask.taskFolderPath
      );
    }

    // If explicit arg still misses, refresh once and retry.
    // Do NOT fall back to the stale explicitTask object on continued miss.
    if (!resolved) {
      await inventory.refresh();
      if ("progress" in explicitTask) {
        resolved =
          inventory.getTaskById(explicitTask.canonicalId) ??
          inventory.getVisibleTaskForSuppressedId(explicitTask.canonicalId);
      } else {
        resolved = lookupInInventory(
          inventory,
          explicitTask.canonicalId,
          explicitTask.taskFolderPath
        );
      }
    }

    // If the explicit argument still can't be resolved after a refresh,
    // fail clearly rather than silently falling through to the persisted
    // current task or any other heuristic.
    if (!resolved) {
      return undefined;
    }
  }

  // ----------------------------------------------------------------
  // Step 2: Persisted current-task canonical ID
  // ----------------------------------------------------------------
  if (!resolved && currentTaskStore) {
    const persistedId = currentTaskStore.get();
    if (persistedId) {
      resolved =
        inventory.getTaskById(persistedId) ??
        inventory.getVisibleTaskForSuppressedId(persistedId);

      // On miss, refresh once and retry
      if (!resolved) {
        await inventory.refresh();
        resolved =
          inventory.getTaskById(persistedId) ??
          inventory.getVisibleTaskForSuppressedId(persistedId);
      }

      // If the persisted canonical ID still can't be resolved (task deleted,
      // moved, or never existed), clear the persisted state so the extension
      // does not start from a stale ID after window reload or later command
      // flows. This keeps CurrentTaskStore in sync across all surfaces (tree,
      // status bar, task actions).
      if (!resolved) {
        await currentTaskStore.clear();
      }
    }
  }

  // ----------------------------------------------------------------
  // No fallback heuristics — if nothing resolved, return undefined.
  // Callers show their own "no active task" message.
  // ----------------------------------------------------------------
  if (!resolved) {
    return undefined;
  }

  // Check paused status
  if (!options?.allowPaused && resolved.progress.status === "paused") {
    return undefined;
  }

  return {
    canonicalId: resolved.canonicalId,
    taskFolderPath: resolved.taskFolderPath,
    folderName: resolved.folderName,
    sourceScopeKey: resolved.sourceScopeKey,
    workspaceFolder: resolved.workspaceFolder,
    progress: resolved.progress,
  };
}
