import * as vscode from "vscode";
import {
  migrateStage,
  migrateStatus,
  TaskProgress,
  TaskStage,
  TaskStatus,
  TASK_PROGRESS_FILENAME,
} from "../types/taskProgress";

/**
 * Represents an incomplete task with its folder URI and progress
 */
export interface IncompleteTask {
  folderUri: vscode.Uri;
  folderName: string;
  progress: TaskProgress;
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
    const progress = JSON.parse(json) as TaskProgress;
    // Migrate stage names written by older versions; the migrated
    // value is persisted the next time the stage changes.
    progress.currentStage = migrateStage(String(progress.currentStage));
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
 * Write the task progress to a task folder
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
  await vscode.workspace.fs.writeFile(
    progressFileUri,
    new TextEncoder().encode(content)
  );
}

/**
 * Create a new task progress object
 * @param taskFolder - The task folder name
 * @param stage - The initial stage (defaults to "task-description")
 * @returns A new TaskProgress object
 */
export function createTaskProgress(
  taskFolder: string,
  stage: TaskStage = "task-description"
): TaskProgress {
  const now = new Date().toISOString();
  return {
    taskFolder,
    currentStage: stage,
    status: "active",
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
  return {
    ...progress,
    currentStage: newStage,
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
 * Record the workspace-relative paths changed by the most recent AI
 * implementation run so implementation reviews can use them as the review
 * scope instead of relying on open editors.
 */
export function updateImplReviewFiles(
  progress: TaskProgress,
  files: string[]
): TaskProgress {
  return {
    ...progress,
    implReviewFiles: files,
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
 * Find all incomplete tasks in the meta folder
 * @param metaFolderUri - URI of the meta resources folder
 * @returns Array of incomplete tasks, sorted by most recent first
 */
export async function findIncompleteTasks(
  metaFolderUri: vscode.Uri
): Promise<IncompleteTask[]> {
  const allTasks = await findAllTasks(metaFolderUri);
  return allTasks.filter((task) => task.progress.currentStage !== "completed");
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
