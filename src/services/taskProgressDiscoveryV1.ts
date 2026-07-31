/**
 * Strict task discovery over a meta folder (plan §3.12 step 3, Read cohort).
 *
 * The V1 counterpart of the permissive `findAllTasks`/`findIncompleteTasks`
 * (utils/taskProgressUtils.ts): each direct child directory's
 * `task-progress.json` is STRICTLY decoded — a missing file still means "not
 * a task folder" (skipped, exactly like the permissive scan), but an
 * invalid/unknown-version document now surfaces as an explicit recovery
 * entry instead of a silently omitted task (§3.12 step 4). Lives under
 * `services/taskProgress*` so the permissive-reader import fence covers it
 * from birth (scripts/verifyProgressReaderFence.mjs).
 */
import * as vscode from "vscode";
import { IncompleteTask } from "../types/incompleteTask";
import { readTaskProgressStrictV1 } from "./taskProgressReaderV1";

/** One folder whose progress exists but did not strictly decode. */
export interface TaskProgressRecoveryEntryV1 {
  readonly folderName: string;
  readonly taskFolderPath: string;
  /** The decoder's recovery code (never "missing" — missing is not a task). */
  readonly code: string;
  readonly reason: string;
}

export interface TaskProgressDiscoveryResultV1 {
  /** Strictly decoded tasks, sorted by `updatedAt` descending. */
  readonly tasks: IncompleteTask[];
  readonly recovery: TaskProgressRecoveryEntryV1[];
}

/**
 * Find all tasks in the meta folder, regardless of stage (including
 * completed tasks), through the strict decoder.
 */
export async function findAllTasksStrictV1(
  metaFolderUri: vscode.Uri
): Promise<TaskProgressDiscoveryResultV1> {
  const tasks: IncompleteTask[] = [];
  const recovery: TaskProgressRecoveryEntryV1[] = [];

  try {
    const entries = await vscode.workspace.fs.readDirectory(metaFolderUri);

    for (const [name, type] of entries) {
      if (type !== vscode.FileType.Directory) {
        continue;
      }
      const folderUri = vscode.Uri.joinPath(metaFolderUri, name);
      const result = await readTaskProgressStrictV1(folderUri, { expectedTaskFolder: name });
      if (!result.ok) {
        if (result.code !== "missing") {
          recovery.push({
            folderName: name,
            taskFolderPath: folderUri.fsPath,
            code: result.code,
            reason: result.reason,
          });
        }
        continue;
      }
      tasks.push({
        folderUri,
        folderName: name,
        progress: result.decoded.progress,
        // No canonicalId here — these tasks come from a direct directory
        // scan rather than through TaskInventory, so no normalized
        // canonical ID is available. Matching falls back to fsPath.
      });
    }

    // Sort by updatedAt descending (most recent first)
    tasks.sort(
      (a, b) =>
        new Date(b.progress.updatedAt).getTime() - new Date(a.progress.updatedAt).getTime()
    );
  } catch {
    // Directory might not exist or be inaccessible
  }

  return { tasks, recovery };
}

/** Find all non-completed tasks in the meta folder through the strict decoder. */
export async function findIncompleteTasksStrictV1(
  metaFolderUri: vscode.Uri
): Promise<TaskProgressDiscoveryResultV1> {
  const all = await findAllTasksStrictV1(metaFolderUri);
  return {
    tasks: all.tasks.filter((task) => task.progress.status !== "completed"),
    recovery: all.recovery,
  };
}
