import * as vscode from "vscode";
import {
  migrateStage,
  migrateStatus,
  TaskProgress,
  TaskStage,
  TASK_PROGRESS_FILENAME,
} from "../types/taskProgress";

import { writeAtomic } from "../state/writeAtomic";
import { withTaskLock } from "../state/taskStateStore";
import { beginFinalization, finishFinalization } from "../state/finalizationJournal";
import { migratePersistedState } from "../state/migratePersistedState";
// The IncompleteTask shape and the pure in-memory transformers moved to
// types/incompleteTask.ts and utils/taskProgressTransforms.ts (plan §3.12):
// neither reads nor writes disk, so type-only and helper-only consumers no
// longer import this permissive module (or hold a fence-roster row) for them.
import { IncompleteTask } from "../types/incompleteTask";

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
      // Only infer a status when none is recorded: legacy files with the
      // "completed" stage and a completedAt are completed; an explicit
      // status (active/paused/archived) always wins — completion is never
      // inferred from completedAt alone (it survives resume as history).
      if (progress.status === undefined) {
        progress.status = progress.completedAt ? "completed" : "active";
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
    // Mirrors readTaskProgress: an explicit status always wins; completedAt
    // is historical metadata and never re-flips a resumed task to completed.
    if (patched.status === undefined) {
      patched.status = patched.completedAt ? "completed" : "active";
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

    const unchanged = JSON.stringify(patched) === JSON.stringify(current);

    // `update` above already threw for a stale/rejected CAS, so reaching
    // here means this caller owns the transition. Run the side effect before
    // persisting so a concurrent claim can only observe it fully applied or
    // not at all — never interleaved with this write.
    if (beforeWrite) await beforeWrite(patched);

    // Callers use an unchanged return value to decline a compare-and-swap
    // update (for example, when another window owns a scheduler lease).
    // Do not turn that into a journal entry and file write: besides avoiding
    // needless I/O, task-progress.json is watched and such writes would
    // otherwise continuously re-trigger the scheduler inventory refresh.
    //
    // A validated no-op CAS may still have a side effect, though. Same-stage
    // review refreshes publish their staged review artifact this way after the
    // reviewAttemptId check succeeds, while leaving task-progress.json as-is.
    if (unchanged) return current;

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
