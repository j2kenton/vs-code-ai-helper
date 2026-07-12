import * as vscode from "vscode";
import {
  migrateStage,
  migrateStatus,
  TaskProgress,
  TaskStage,
  TaskStatus,
  TASK_PROGRESS_FILENAME,
} from "../types/taskProgress";

import { writeAtomic } from "../state/writeAtomic";
import { withTaskLock } from "../state/taskStateStore";
import { beginFinalization, finishFinalization } from "../state/finalizationJournal";
import { migratePersistedState } from "../state/migratePersistedState";

/**
 * Represents an incomplete task with its folder URI and progress.
 *
 * `canonicalId` is the normalized absolute path produced by `taskRoot.ts`
 * (lowercased on Windows). It is the identity key used by `CurrentTaskStore`
 * and `TaskInventory`. When a `TaskWithProgress` is adapted into this shape
 * via `toIncompleteTask`, the canonical ID is preserved so that every render
 * surface (tree nodes, status bar) can match against the stored ID without
 * relying on `folderUri.fsPath` alone. If absent (e.g. tasks constructed
 * directly from URIs in legacy paths), `folderUri.fsPath` is used as the
 * fallback identity.
 */
export interface IncompleteTask {
  folderUri: vscode.Uri;
  folderName: string;
  progress: TaskProgress;
  /** Canonical identity key (normalized absolute path). Present when the task
   *  was sourced from TaskInventory via toIncompleteTask(); may be absent for
   *  legacy in-memory task objects constructed outside the inventory path. */
  canonicalId?: string;
}

/**
 * Read the task progress from a task folder
 * @param taskFolderUri - URI of the task folder
 * @returns The task progress object, or undefined if not found/invalid
 */
export async function readTaskProgress(
  taskFolderUri: vscode.Uri
): Promise<TaskProgress | undefined> {
  const progressFileUri = vscode.Uri.joinPath(
    taskFolderUri,
    TASK_PROGRESS_FILENAME
  );

  try {
    const content = await vscode.workspace.fs.readFile(progressFileUri);
    const json = new TextDecoder().decode(content);
    const progress = migratePersistedState(JSON.parse(json)).data;
    // Migrate stage names written by older versions; the migrated
    // value is persisted the next time the stage changes.
    const rawStage = String(progress.currentStage);
    progress.currentStage = migrateStage(rawStage);
    if (rawStage === "completed") {
      progress.currentStage = "publish";
      if (!progress.completedAt && progress.status !== "completed") {
        if (progress.status === undefined) {
          progress.status = "active";
        }
      } else {
        progress.status = "completed";
      }
    }
    // Migrate/normalize status field (missing -> "active").
    progress.status = migrateStatus(progress.status);
    // Sanitize implReviewFiles: it must be an array of strings or absent.
    if (progress.implReviewFiles !== undefined) {
      if (!Array.isArray(progress.implReviewFiles)) {
        progress.implReviewFiles = undefined;
      } else {
        progress.implReviewFiles = (progress.implReviewFiles as unknown[]).filter(
          (e): e is string => typeof e === "string"
        );
      }
    }
    return progress;
  } catch {
    // File doesn't exist or is invalid
    return undefined;
  }
}

/**
 * Write the task progress to a task folder.
 * Writes the full progress object. Prefer `patchTaskProgress` when only
 * updating specific fields to avoid accidentally discarding unrelated ones.
 * @param taskFolderUri - URI of the task folder
 * @param progress - The task progress to write
 */
export async function writeTaskProgress(
  taskFolderUri: vscode.Uri,
  progress: TaskProgress
): Promise<void> {
  const progressFileUri = vscode.Uri.joinPath(
    taskFolderUri,
    TASK_PROGRESS_FILENAME
  );

  const content = JSON.stringify(progress, null, 2);
  await writeAtomic(progressFileUri, content);
}

/**
 * Safe partial-update helper for `task-progress.json`.
 *
 * Reads the full current progress, applies the provided update (either a
 * partial object merged with spread, or an update callback), preserves all
 * unrelated fields, runs the same normalization/sanitization used for reads,
 * and writes the merged result back.
 *
 * Use this instead of `writeTaskProgress` when you only want to change
 * specific fields (e.g. stage, status, implReviewFiles) without risk of
 * overwriting other fields that another code path may have written concurrently.
 *
 * If the progress file doesn't exist or is unreadable, the update is NOT
 * applied and the function returns undefined. Callers that must ensure the
 * progress file exists should call `writeTaskProgress` first.
 *
 * @param taskFolderUri - URI of the task folder
 * @param update - Partial fields to merge in, or a callback `(current) => patched`
 * @param skipLock - Skip acquiring the task lock (caller already holds an
 *   equivalent lock, e.g. task activation holding the shared meta-root lock).
 * @param beforeWrite - Optional side effect run after `update` has validated/
 *   computed the patched value but before it is persisted, still inside the
 *   same lease as the CAS check. Use this to publish a file artifact (e.g.
 *   rename a staged review into place) atomically with the progress write so
 *   a superseded caller's `update` throwing prevents both the write AND the
 *   side effect, and a caller that passes CAS can't have its publish step
 *   raced by a newer claim that starts only after the lease is released.
 * @returns The persisted TaskProgress if successful, or undefined if the
 *          progress file could not be read.
 */
export async function patchTaskProgress(
  taskFolderUri: vscode.Uri,
  update: Partial<TaskProgress> | ((current: TaskProgress) => TaskProgress),
  skipLock = false,
  beforeWrite?: (patched: TaskProgress) => Promise<void>
): Promise<TaskProgress | undefined> {
  const operation = async () => {
    // Read and write under the same lease. Reading before acquiring the lock
    // allowed concurrent commands to serialize stale snapshots and lose updates.
    const current = await readTaskProgress(taskFolderUri);
    if (!current) return undefined;

    let patched: TaskProgress;
    if (typeof update === "function") patched = update(current);
    else patched = { ...current, ...update };

  // Re-apply normalization/sanitization so writes always produce clean data.
  const rawStage = String(patched.currentStage);
  patched.currentStage = migrateStage(rawStage);
  if (rawStage === "completed") {
    patched.currentStage = "publish";
    if (!patched.completedAt && patched.status !== "completed") {
      if (patched.status === undefined) {
        patched.status = "active";
      }
    } else {
      patched.status = "completed";
    }
  }
  patched.status = migrateStatus(patched.status);
  if (patched.implReviewFiles !== undefined) {
    if (!Array.isArray(patched.implReviewFiles)) {
      patched.implReviewFiles = undefined;
    } else {
      patched.implReviewFiles = (patched.implReviewFiles as unknown[]).filter(
        (e): e is string => typeof e === "string"
      );
    }
  }

    // `update` above already threw for a stale/rejected CAS, so reaching
    // here means this caller owns the transition. Run the side effect before
    // persisting so a concurrent claim can only observe it fully applied or
    // not at all — never interleaved with this write.
    if (beforeWrite) await beforeWrite(patched);

  // All read-modify-write progress mutations share the same lease. This is
  // the CAS boundary used by commands and prevents two operations from
  // silently overwriting each other's stage or status changes.
    await beginFinalization(taskFolderUri.fsPath, taskFolderUri.fsPath, "task-progress mutation");
    // Keep the intent journal on failure. Startup recovery needs the record
    // to reconcile an interrupted mutation instead of losing the evidence.
    await writeTaskProgress(taskFolderUri, patched);
    await finishFinalization(taskFolderUri.fsPath);
    return patched;
  };
  return skipLock ? operation() : withTaskLock(taskFolderUri.fsPath, operation);
}

/**
 * Create a new task progress object
 * @param taskFolder - The task folder name
 * @param stage - The initial stage (defaults to "task-description")
 * @returns A new TaskProgress object
 */
export function createTaskProgress(
  taskFolder: string,
  stage: TaskStage = "desc"
): TaskProgress {
  const now = new Date().toISOString();
  return {
    taskFolder,
    currentStage: stage,
    status: "creating",
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Update the task progress stage
 * @param progress - The existing progress object
 * @param newStage - The new stage to set
 * @returns Updated TaskProgress object
 */
export function updateTaskProgressStage(
  progress: TaskProgress,
  newStage: TaskStage
): TaskProgress {
  const fallbackActive = { ...progress.fallbackActive };
  delete fallbackActive[newStage];
  return {
    ...progress,
    currentStage: newStage,
    fallbackActive,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Update task status (active/paused)
 */
export function updateTaskStatus(
  progress: TaskProgress,
  status: TaskStatus
): TaskProgress {
  return {
    ...progress,
    status,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Record the workspace-relative paths changed by an AI implementation run,
 * so implementation reviews can use them as the review scope instead of
 * relying on open editors.
 *
 * Unions `files` with any previously tracked set rather than replacing it.
 * A task can have several implementation runs in sequence (e.g. an initial
 * run followed by review-driven follow-up runs); a later run's before/after
 * git snapshot legitimately diffs to empty when it only re-confirms files an
 * earlier run already finalized. Overwriting the tracked set with that empty
 * diff would silently discard the earlier runs' files from the review scope.
 * Use `clearImplReviewFiles` for the one case where discarding the set is
 * actually intended: an explicit "start over" action, not a routine re-run.
 */
export function updateImplReviewFiles(
  progress: TaskProgress,
  files: string[]
): TaskProgress {
  const existing = progress.implReviewFiles ?? [];
  const union = new Set([...existing, ...files]);
  return {
    ...progress,
    implReviewFiles: [...union].sort(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Clear any previously tracked changed-file set.
 */
export function clearImplReviewFiles(progress: TaskProgress): TaskProgress {
  const { implReviewFiles: _unused, ...rest } = progress;
  return {
    ...rest,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Persist a lint-state payload for a completed task.
 * Replaces any previously stored lint result.
 */
export function updateLintPayload(
  progress: TaskProgress,
  payload: import("../types/taskProgress").LintPayload
): TaskProgress {
  return {
    ...progress,
    lintPayload: payload,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Remove the persisted lint payload (e.g. when re-running lint after
 * code changes so the stale result is no longer shown as current).
 */
export function clearLintPayload(progress: TaskProgress): TaskProgress {
  const { lintPayload: _unused, ...rest } = progress;
  return {
    ...rest,
    updatedAt: new Date().toISOString(),
  };
}


/**
 * Find all incomplete tasks in the meta folder
 * @param metaFolderUri - URI of the meta resources folder
 * @returns Array of incomplete tasks, sorted by most recent first
 */
export async function findIncompleteTasks(
  metaFolderUri: vscode.Uri
): Promise<IncompleteTask[]> {
  const allTasks = await findAllTasks(metaFolderUri);
  return allTasks.filter((task) => task.progress.status !== "completed");
}

/**
 * Find all tasks in the meta folder, regardless of stage (including completed
 * tasks). Used by flows that need to let the user pick any task, such as
 * jumping the stage backward or forward.
 * @param metaFolderUri - URI of the meta resources folder
 * @returns Array of tasks, sorted by most recent first
 */
export async function findAllTasks(
  metaFolderUri: vscode.Uri
): Promise<IncompleteTask[]> {
  const tasks: IncompleteTask[] = [];

  try {
    const entries = await vscode.workspace.fs.readDirectory(metaFolderUri);

    for (const [name, type] of entries) {
      if (type === vscode.FileType.Directory) {
        const folderUri = vscode.Uri.joinPath(metaFolderUri, name);
        const progress = await readTaskProgress(folderUri);

        if (progress) {
          tasks.push({
            folderUri,
            folderName: name,
            progress,
            // No canonicalId here — these tasks come from a direct directory
            // scan rather than through TaskInventory, so no normalized
            // canonical ID is available. Matching falls back to fsPath.
          });
        }
      }
    }

    // Sort by updatedAt descending (most recent first)
    tasks.sort((a, b) => {
      return (
        new Date(b.progress.updatedAt).getTime() -
        new Date(a.progress.updatedAt).getTime()
      );
    });
  } catch {
    // Directory might not exist or be inaccessible
  }

  return tasks;
}
