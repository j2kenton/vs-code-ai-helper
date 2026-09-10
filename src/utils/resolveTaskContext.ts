import * as vscode from "vscode";
import { TaskInventory, TaskWithProgress } from "../state/taskInventory";
import { CurrentTaskStore } from "./currentTaskStore";
import * as fs from "fs";
import * as path from "path";
import { taskRefFromResolved, TaskRef } from "../types/taskRef";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import { resolveTaskRootCandidates } from "./taskRoot";
import { migrateStatus, TASK_PROGRESS_FILENAME } from "../types/taskProgress";

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
  /**
   * 2026-09-10 review completion blocker ("publish/complete actions" route,
   * narrowed further): `peekTaskFolderPathSynchronouslyV1` is a best-effort
   * SYNCHRONOUS guess, corrected by callers only after this function fully
   * returns. When the persisted current-task pointer is a cache miss that
   * resolves (via this function's own awaited `inventory.refresh()`) to a
   * PAUSED task, while the sole "active" task only becomes visible in the
   * POST-refresh inventory, the peek cannot have guessed that active task —
   * it wasn't discoverable without doing the same real disk I/O this
   * function performs. The result is a real target that has no work
   * admission for the entire span between when this function starts
   * resolving and when the caller's own post-return "compare and
   * reacquire" correction runs.
   *
   * This hook narrows that span close to its architectural minimum: it fires
   * (awaited) immediately AFTER the ownership/workspace path-safety checks
   * below AND the owning-workspace-folder binding have both passed, but
   * before the `allowPaused` gate — so a caller can acquire/upgrade admission
   * for the authoritative target, and reconcile any watchdog-provenance
   * pause on it, before this function's own `allowPaused` check would
   * otherwise reject a transiently-paused resolution outright.
   *
   * 2026-09-10 review architectural blocker fix: this used to fire right
   * after step 3 settled on `resolved`, BEFORE the path-existence,
   * ownership-resolution, and workspace-containment checks that follow. A
   * resolved inventory entry is untrusted input at this point — possibly a
   * stale cache entry for a deleted folder, an unresolved/cross-project
   * owner, or a path outside every open workspace — and the hook's own
   * contract is to call work admission, whose genesis step performs
   * `mkdir(dir, { recursive: true })` on disk. Firing before validation let
   * admission create or touch a directory under a candidate that validation
   * was about to reject. All of those checks below are synchronous
   * (`fs.existsSync`, path comparisons) except the opt-in
   * `promptForOwnershipResolution` rebind flow, which no admission-hook
   * caller in this codebase currently sets — so moving the hook past them
   * costs no meaningful additional span for the callers this hook serves,
   * while ensuring it only ever runs for a candidate this function has
   * already committed to trusting. It does not eliminate the fundamental
   * fact that `inventory.refresh()` must complete before a brand-new
   * candidate is knowable at all — no synchronous peek can do that.
   *
   * 2026-09-10 review architectural blocker fix (narrowed further): the hook
   * still fired before the final `workspaceFolderUri` binding a few lines
   * below — a candidate can pass every ownership/containment check above yet
   * have no matching open workspace folder (e.g. no workspace open, or a
   * multi-root layout where none of the open roots bind it), in which case
   * this function returns `undefined` regardless. That binding check is now
   * computed and validated BEFORE this hook fires, so the hook only ever
   * runs for a candidate this function is actually going to return —
   * eliminating the last window where admission could mutate a directory for
   * a candidate about to be rejected.
   */
  onResolvedCandidate?: (candidate: TaskWithProgress) => Promise<void>;
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
 * Best-effort, synchronous peek at a task's on-disk `status`, for the
 * cold-cache-miss branch of `peekTaskFolderPathSynchronouslyV1` below.
 * `resolveTaskContext`'s awaited `inventory.refresh()` would decode this same
 * file properly; this is a cheap approximation consistent with the existing
 * `fs.existsSync` synchronous check in the same function (and with the
 * `fs.readFileSync`-based best-effort peeks already used for tree-item
 * tooltips in `taskTreeProvider.ts`). Any read/parse failure (file missing,
 * corrupt JSON, mid-write) is indistinguishable here from a task whose
 * `status` field is absent — both default to "active" via `migrateStatus`,
 * matching the real decoder's own default for a missing/invalid status.
 */
function peekTaskStatusSynchronouslyBestEffortV1(taskFolderPath: string): ReturnType<typeof migrateStatus> {
  try {
    const raw = fs.readFileSync(path.join(taskFolderPath, TASK_PROGRESS_FILENAME), "utf8");
    const parsed = JSON.parse(raw) as { status?: unknown };
    return migrateStatus(parsed?.status);
  } catch {
    return migrateStatus(undefined);
  }
}

/**
 * Best-effort, SYNCHRONOUS mirror of `resolveTaskContext`'s two cheapest
 * resolution steps — an explicit canonicalId/taskFolderPath, or (with no
 * explicit target) the persisted current-task pointer — using only in-memory
 * reads (`inventory.getTaskById`/`getVisibleTaskForSuppressedId`,
 * `currentTaskStore.get()`), never `inventory.refresh()`, which performs real
 * I/O.
 *
 * 2026-09-09 review completion blocker ("publish/complete actions" route):
 * `runPublishChecks`/`commitAndPushTask`/`completeCommitAndPushTask` can only
 * acquire work admission before their first awaited setup step
 * (`TaskCreationStartupReconcilerV1.waitUntilReady()`) when a folder path is
 * known synchronously from the command argument — but a canonicalId-only or
 * true no-arg invocation (the keyboard shortcut acting on "the current task")
 * carries no folder path at all, only a canonicalId or nothing. This function
 * closes that gap for the dominant case (the target task is already present
 * in the live inventory cache) AND for a genuine cold-cache miss: every
 * `canonicalId` in this codebase is constructed FROM a task's folder path
 * (`taskRoot.ts`'s discovery pass sets `canonicalId: normalizePath(taskFolderPath)`;
 * every other construction site — draftTaskWithAI.ts, commitAndPushTask.ts,
 * etc. — likewise derives it from an already-known `taskFolderPath` or
 * `folderUri.fsPath`), so an inventory miss on a canonicalId/persisted-id
 * lookup can still fall back to using that id AS the folder path guess,
 * rather than admitting nothing at all. On Windows this guess may be
 * lower-cased/case-normalized relative to the real on-disk casing (Windows
 * filesystem I/O is case-insensitive, so this never fails to find the real
 * admission directory on disk), and it may differ in exact string form from
 * what `resolveTaskContext` authoritatively returns — the caller's existing
 * "compare and reacquire on mismatch" correction handles both.
 *
 * The id-as-path fallback is gated on `fs.existsSync`, a cheap synchronous
 * check consistent with this function staying I/O-free of anything blocking:
 * a stale persisted/explicit id can point at a task that was genuinely
 * DELETED, not merely absent from the in-memory cache, and work admission's
 * own `mkdir(dir, { recursive: true })` genesis step would otherwise
 * resurrect that deleted folder on disk just to hold an admission marker
 * nothing will ever consume.
 *
 * 2026-09-10 review completion blocker ("publish/complete actions" route,
 * narrowed): the no-persisted-pointer / stale-pointer / paused-pointer case
 * was entirely unmirrored — this function returned `undefined` whenever the
 * persisted current-task pointer was absent, could not be found in the
 * in-memory inventory, or resolved to a PAUSED task, even though
 * `resolveTaskContext`'s own step 3 (below) unambiguously redirects exactly
 * those cases to the sole "active" task in the inventory when there is
 * precisely one. That left the actual authoritative target — the task
 * `resolveTaskContext` goes on to select — completely unprotected during
 * `TaskCreationStartupReconcilerV1.waitUntilReady()` and `resolveTaskContext`
 * itself, the two awaited setup steps between this peek and late admission.
 * Mirrored here using the same in-memory-only reads (`inventory.getTasks()`),
 * matching resolution order exactly:
 *   1. persisted pointer resolves to a non-paused task -> that task (unchanged
 *      dominant case)
 *   2. otherwise (pointer absent, cache-miss, OR resolves to a PAUSED task) ->
 *      the unique "active"-status task in the inventory, if there is exactly
 *      one (mirrors `resolveTaskContext`'s unambiguous-only fallback)
 *   3. otherwise, if the pointer resolved to a paused task -> that paused
 *      task's folder (mirrors `resolved` staying the paused task when no
 *      `onlyActiveTask` override applies; needed because some callers, e.g.
 *      Publish checks, pass `allowPaused: true`)
 *   4. otherwise, if a pointer was set but not found in the inventory at all
 *      -> the existing id-as-path existence-gated guess (genuine cold-cache
 *      miss vs. a deleted task, same as the explicit-arg branch above)
 *   5. otherwise -> `undefined`
 *
 * 2026-09-10 review, second pass — narrowed again: step 2's cache-miss
 * branch fell straight to the cached "sole active task" fallback WITHOUT
 * first checking whether the pointer itself still exists on disk. But
 * `resolveTaskContext`'s step 2 runs `inventory.refresh()` on exactly that
 * cache miss and retries the persisted id BEFORE it ever reaches its own
 * step-3 active-task fallback — so a persisted id that refresh would find
 * and that turns out to be non-paused is used DIRECTLY, and the resolver's
 * active-task fallback (built from the POST-refresh inventory) is never even
 * consulted. A cold-cache persisted task B, alongside a different task A that
 * is the sole "active" entry in the STALE pre-refresh cache, therefore
 * resolves to B — while the old code here guessed A, leaving B (the actual
 * authoritative target) unprotected through the two awaited setup steps this
 * peek exists to cover. Fixed by checking disk existence — and, best-effort,
 * on-disk status via `peekTaskStatusSynchronouslyBestEffortV1` — for a
 * cache-missed pointer BEFORE the active-task fallback: a pointer found on
 * disk and not paused wins immediately, exactly mirroring what refresh would
 * do; a pointer found on disk but paused (or with unreadable status treated
 * as paused-or-not per that helper) still falls through to the active-task
 * fallback first, matching the resolver's own paused-redirect step, with the
 * on-disk pointer itself as the final fallback if no unambiguous active task
 * exists — the same outcome as the pre-existing `persistedFound` paused case.
 */
export function peekTaskFolderPathSynchronouslyV1(
  inventory: TaskInventory,
  explicitTask?: { canonicalId?: string; taskFolderPath?: string },
  currentTaskStore?: CurrentTaskStore
): string | undefined {
  if (explicitTask?.taskFolderPath) {
    return explicitTask.taskFolderPath;
  }
  if (explicitTask?.canonicalId) {
    const found =
      inventory.getTaskById(explicitTask.canonicalId) ??
      inventory.getVisibleTaskForSuppressedId(explicitTask.canonicalId);
    if (found) {
      return found.taskFolderPath;
    }
    return fs.existsSync(explicitTask.canonicalId) ? explicitTask.canonicalId : undefined;
  }
  if (!explicitTask && currentTaskStore) {
    const persistedId = currentTaskStore.get();
    const persistedFound = persistedId
      ? inventory.getTaskById(persistedId) ?? inventory.getVisibleTaskForSuppressedId(persistedId)
      : undefined;

    if (persistedFound && persistedFound.progress.status !== "paused") {
      return persistedFound.taskFolderPath;
    }

    // Cache-missed pointer that still exists on disk: this is exactly what
    // `resolveTaskContext`'s awaited `inventory.refresh()` would find and use
    // DIRECTLY if non-paused, before its own active-task fallback is ever
    // consulted. Check it here, before the active-task fallback below, so
    // this peek does not admit the wrong task when a stale cached "sole
    // active" entry differs from the persisted pointer refresh would surface.
    let diskPersistedPath: string | undefined;
    if (!persistedFound && persistedId && fs.existsSync(persistedId)) {
      diskPersistedPath = persistedId;
      if (peekTaskStatusSynchronouslyBestEffortV1(persistedId) !== "paused") {
        return diskPersistedPath;
      }
    }

    // Mirror `resolveTaskContext` step 3: an absent/cache-missed/paused
    // pointer falls back to the sole "active" task, when unambiguous.
    const activeTasks = inventory.getTasks().filter((t) => t.progress.status === "active");
    if (activeTasks.length === 1 && activeTasks[0]) {
      return activeTasks[0].taskFolderPath;
    }

    if (persistedFound) {
      // Found but paused, and no unambiguous active alternative: this is
      // what `resolved` remains in `resolveTaskContext` (no override).
      return persistedFound.taskFolderPath;
    }
    if (diskPersistedPath) {
      // On disk but paused (or the id was never found at all above), and no
      // unambiguous active alternative: same outcome as the `persistedFound`
      // paused case just above, mirroring what `resolveTaskContext` would do
      // once its own refresh resolves this same task.
      return diskPersistedPath;
    }
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

  // Resolve and validate the owning workspace folder BEFORE firing the
  // admission hook below (2026-09-10 review architectural blocker, narrowed
  // further: the hook used to fire here, before this check — a candidate
  // that passes every check above can still have no matching open workspace
  // folder, e.g. no workspace open at all, and the hook's own contract is to
  // call work admission, whose genesis step touches disk under
  // `resolved.taskFolderPath`. Firing before this final binding check let
  // admission mutate a directory for a candidate this function was about to
  // reject). This computation does not depend on `allowPaused`, so moving it
  // up costs nothing.
  const resolvedPersistedOwner = persistedOwner ? normalizeForCompare(path.resolve(persistedOwner)) : undefined;
  const workspaceFolderUri = resolvedPersistedOwner
    ? vscode.workspace.workspaceFolders?.map(folder => folder.uri).find(uri => normalizeForCompare(path.resolve(uri.fsPath)) === resolvedPersistedOwner)
    : resolved.workspaceFolder ?? (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri).find(uri => {
    const root = path.resolve(uri.fsPath);
    return isSameOrUnder(resolved.taskFolderPath, root);
  });
  if (!workspaceFolderUri) return undefined;

  // Fire the admission hook (see `ResolveTaskOptions.onResolvedCandidate`) now
  // — `resolved` has passed every path-existence, ownership-resolution,
  // workspace-containment, AND workspace-folder-binding check above, so it is
  // no longer untrusted input: this is the earliest point at which acquiring
  // work admission (whose genesis step touches disk under
  // `resolved.taskFolderPath`) is safe to do for it. Still fires before the
  // `allowPaused` gate below, so a caller can reconcile a watchdog-provenance
  // pause before that gate would otherwise reject a transiently-paused
  // resolution outright.
  if (options?.onResolvedCandidate) {
    await options.onResolvedCandidate(resolved);
  }

  // Check paused status
  if (!options?.allowPaused && resolved.progress.status === "paused") {
    return undefined;
  }

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
