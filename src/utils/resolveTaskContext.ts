import * as vscode from "vscode";
import { TaskInventory, TaskWithProgress } from "../state/taskInventory";
import { CurrentTaskStore } from "./currentTaskStore";
import * as fs from "fs";
import * as path from "path";
import { taskRefFromResolved, TaskRef } from "../types/taskRef";
import { patchTaskProgress } from "./taskProgressUtils";

export interface ResolvedTaskContext {
  readonly taskRef: TaskRef;
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
  /**
   * When the task's persisted ownership no longer matches any currently
   * open workspace folder, offer to resolve it instead of failing closed:
   *   - Exactly one open folder physically contains the task folder on
   *     disk (e.g. the workspace was renamed/moved) -> rebind silently,
   *     no prompt needed since the match is unambiguous.
   *   - More than one open folder contains it (nested multi-root
   *     workspaces) -> show a folder picker so the user disambiguates.
   *   - No open folder contains it -> nothing to resolve; fails closed
   *     same as when this option is unset.
   * Off by default so the many existing callers keep their current
   * UI-free, fail-closed behavior; only opt in at a genuine user-driven
   * entry point.
   */
  promptForOwnershipResolution?: boolean;
}

/**
 * Recover from a task whose persisted `ownership.workspaceRoot` no longer
 * matches any open workspace folder. Returns the workspace root to rebind
 * ownership to, or undefined if it can't be resolved (or the user cancels
 * a disambiguation prompt). Persists the corrected ownership before
 * returning so the caller doesn't need to.
 */
async function resolveAmbiguousOwnership(
  task: TaskWithProgress,
  workspaceRoots: readonly string[]
): Promise<string | undefined> {
  const containingRoots = workspaceRoots.filter(
    (root) => task.taskFolderPath === root || task.taskFolderPath.startsWith(root + path.sep)
  );

  let rebindRoot: string | undefined;
  if (containingRoots.length === 1) {
    rebindRoot = containingRoots[0];
  } else if (containingRoots.length > 1) {
    const items = containingRoots.map((root) => ({
      label: path.basename(root),
      description: root,
      root,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      title: `Which workspace owns "${task.folderName}"?`,
      placeHolder: "This task's saved workspace no longer matches one open folder — select the owning one",
    });
    rebindRoot = picked?.root;
  }
  if (!rebindRoot) {
    return undefined;
  }

  const patched = await patchTaskProgress(vscode.Uri.file(task.taskFolderPath), (current) => ({
    ...current,
    ownership: {
      metaRoot: current.ownership?.metaRoot ?? path.resolve(task.taskFolderPath, ".."),
      projectRoot: rebindRoot,
      workspaceRoot: rebindRoot,
      boundAt: new Date().toISOString(),
      state: "resolved",
    },
  }));
  return patched ? rebindRoot : undefined;
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

  // A resolved inventory entry is still untrusted input at the command
  // boundary. Refuse operations on missing folders or paths outside a VS Code
  // workspace; this prevents stale/cross-project task references.
  if (!path.isAbsolute(resolved.taskFolderPath) || !fs.existsSync(resolved.taskFolderPath)) return undefined;
  let persistedOwner = resolved.progress.ownership?.workspaceRoot;
  const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map(folder => path.resolve(folder.uri.fsPath));

  if (
    persistedOwner &&
    (!workspaceRoots.includes(path.resolve(persistedOwner)) ||
      resolved.progress.ownership?.state === "ownership-unresolved")
  ) {
    // The persisted owner no longer matches any open workspace folder (the
    // task's ownership is unresolved) or is explicitly marked unresolved. Only
    // attempt recovery when the caller opted in — resolveTaskContext otherwise
    // stays UI-free and fails closed, matching every other resolution step in
    // this function.
    if (!options?.promptForOwnershipResolution) {
      return undefined;
    }
    const rebindRoot = await resolveAmbiguousOwnership(resolved, workspaceRoots);
    if (!rebindRoot) {
      return undefined;
    }
    persistedOwner = rebindRoot;
    resolved = {
      ...resolved,
      progress: {
        ...resolved.progress,
        ownership: {
          ...resolved.progress.ownership!,
          workspaceRoot: rebindRoot,
          projectRoot: rebindRoot,
          state: "resolved",
        },
      },
    };
  }
  if (workspaceRoots.length > 0 && !workspaceRoots.some(root => resolved.taskFolderPath === root || resolved.taskFolderPath.startsWith(root + path.sep))) return undefined;

  // Check paused status
  if (!options?.allowPaused && resolved.progress.status === "paused") {
    return undefined;
  }

  const workspaceFolderUri = persistedOwner
    ? vscode.workspace.workspaceFolders?.map(folder => folder.uri).find(uri => path.resolve(uri.fsPath) === path.resolve(persistedOwner))
    : resolved.workspaceFolder ?? (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri).find(uri => {
    const root = path.resolve(uri.fsPath);
    return resolved.taskFolderPath === root || resolved.taskFolderPath.startsWith(root + path.sep);
  });
  if (!workspaceFolderUri) return undefined;
  const taskRef = taskRefFromResolved({ canonicalId: resolved.canonicalId, taskFolderPath: resolved.taskFolderPath, workspaceFolder: workspaceFolderUri, metaRoot: resolved.progress.ownership?.metaRoot });
  return {
    taskRef,
    canonicalId: resolved.canonicalId,
    taskFolderPath: resolved.taskFolderPath,
    folderName: resolved.folderName,
    sourceScopeKey: resolved.sourceScopeKey,
    workspaceFolder: workspaceFolderUri,
    progress: resolved.progress,
  };
}
