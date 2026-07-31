import * as vscode from "vscode";
import { TaskInventory, TaskWithProgress } from "../state/taskInventory";
import { CurrentTaskStore } from "./currentTaskStore";
import * as fs from "fs";
import * as path from "path";
import { taskRefFromResolved, TaskRef } from "../types/taskRef";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import { resolveTaskRootCandidates } from "./taskRoot";

/**
 * Normalize a path for comparison: on Windows, path.resolve/normalize
 * preserve casing while taskRoot.ts's discovery pipeline lowercases
 * canonical paths, so raw string comparisons against workspace folder
 * paths silently fail to match. Lowercase (on Windows only) before
 * comparing so containment/equality checks are case-insensitive there.
 */
function normalizeForCompare(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

function isSameOrUnder(childPath: string, root: string): boolean {
  const child = normalizeForCompare(childPath);
  const normalizedRoot = normalizeForCompare(root);
  return child === normalizedRoot || child.startsWith(normalizedRoot + path.sep);
}

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
   *   - No open folder contains it -> show a picker so the user can bind the
   *     task to its owning workspace, or cancel and fail closed.
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
    (root) => isSameOrUnder(task.taskFolderPath, root)
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
  } else {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "Bind Workspace",
      title: `Select the workspace containing "${task.folderName}"`,
    });
    const candidate = picked?.[0]?.fsPath;
    if (candidate && isSameOrUnder(task.taskFolderPath, candidate)) {
      rebindRoot = path.resolve(candidate);
    }
  }
  if (!rebindRoot) {
    return undefined;
  }

  const patched = await patchTaskProgressStrictV1(vscode.Uri.file(task.taskFolderPath), (current) => ({
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
 *   3. If step 2 came up empty or paused, and there is EXACTLY ONE task in
 *      the inventory whose disk `status` is "active", use that task instead
 *      and resync CurrentTaskStore to it. The persisted pointer is meant to
 *      mirror disk status but can drift (e.g. a task activated through an
 *      older code path, or paused without the pointer being updated); status
 *      is the ground truth. When more than one task is "active" at once — the
 *      invariant is already broken — this step is skipped and resolution
 *      fails closed rather than guessing.
 *
 * Falling back is deliberately narrow (unambiguous only): it must never
 * silently redirect the shortcut to an unrelated task when the situation is
 * actually ambiguous.
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

    // The persisted pointer is a convenience cache of "which task is active"
    // and can drift from the disk `status` field it's supposed to mirror —
    // e.g. a task activated through an older code path that predates
    // CurrentTaskStore, or a task that was paused directly without anything
    // updating the pointer. When the persisted task is missing or paused,
    // prefer an unambiguous actually-active task elsewhere in the inventory
    // rather than blocking the shortcut on staleness the user has no way to
    // see. Only act when there is EXACTLY one such task: more than one means
    // the "single active task" invariant is already broken, and guessing
    // which one the user means would be worse than failing closed.
    if (!resolved || resolved.progress.status === "paused") {
      const activeTasks = inventory.getTasks().filter(
        (t) => t.progress.status === "active"
      );
      const onlyActiveTask = activeTasks.length === 1 ? activeTasks[0] : undefined;
      if (onlyActiveTask) {
        resolved = onlyActiveTask;
        await currentTaskStore.set(onlyActiveTask.canonicalId);
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
    resolved.progress.ownership?.state === "ownership-unresolved" ||
    (persistedOwner && !workspaceRoots.some(root => normalizeForCompare(root) === normalizeForCompare(path.resolve(persistedOwner!))))
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
  // Tasks can live in an external metadata root (a legacy absolute
  // metaResourcesPath), where folder containment says nothing about
  // ownership. Such a task is accepted only when it sits inside its own
  // persisted ownership.metaRoot AND its persisted owner matched an open
  // workspace folder above — cross-project references still fail closed
  // (mirrors the release path's external-meta handling in reviewActions.ts).
  const ownedMetaRoot = resolved.progress.ownership?.metaRoot;
  const insideOwnedMetaRoot =
    !!persistedOwner &&
    !!ownedMetaRoot &&
    isSameOrUnder(resolved.taskFolderPath, path.resolve(ownedMetaRoot));
  const insideConfiguredTaskRoot = resolveTaskRootCandidates().some((candidate) =>
    normalizeForCompare(path.dirname(path.resolve(resolved.taskFolderPath))) ===
    normalizeForCompare(path.resolve(candidate.absolutePath))
  );
  if (
    workspaceRoots.length > 0 &&
    !insideOwnedMetaRoot &&
    !insideConfiguredTaskRoot &&
    !workspaceRoots.some(root => isSameOrUnder(resolved.taskFolderPath, root))
  ) return undefined;

  // Check paused status
  if (!options?.allowPaused && resolved.progress.status === "paused") {
    return undefined;
  }

  const resolvedPersistedOwner = persistedOwner ? normalizeForCompare(path.resolve(persistedOwner)) : undefined;
  const workspaceFolderUri = resolvedPersistedOwner
    ? vscode.workspace.workspaceFolders?.map(folder => folder.uri).find(uri => normalizeForCompare(path.resolve(uri.fsPath)) === resolvedPersistedOwner)
    : resolved.workspaceFolder ?? (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri).find(uri => {
    const root = path.resolve(uri.fsPath);
    return isSameOrUnder(resolved.taskFolderPath, root);
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
