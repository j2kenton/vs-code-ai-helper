import * as vscode from "vscode";
import {
  TaskProgress,
  TaskStage,
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
    return JSON.parse(json) as TaskProgress;
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
 * @param stage - The initial stage (defaults to "created")
 * @returns A new TaskProgress object
 */
export function createTaskProgress(
  taskFolder: string,
  stage: TaskStage = "created"
): TaskProgress {
  const now = new Date().toISOString();
  return {
    taskFolder,
    currentStage: stage,
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
 * Find all incomplete tasks in the meta folder
 * @param metaFolderUri - URI of the meta resources folder
 * @returns Array of incomplete tasks, sorted by most recent first
 */
export async function findIncompleteTasks(
  metaFolderUri: vscode.Uri
): Promise<IncompleteTask[]> {
  const incompleteTasks: IncompleteTask[] = [];

  try {
    const entries = await vscode.workspace.fs.readDirectory(metaFolderUri);

    for (const [name, type] of entries) {
      if (type === vscode.FileType.Directory) {
        const folderUri = vscode.Uri.joinPath(metaFolderUri, name);
        const progress = await readTaskProgress(folderUri);

        if (progress && progress.currentStage !== "completed") {
          incompleteTasks.push({
            folderUri,
            folderName: name,
            progress,
          });
        }
      }
    }

    // Sort by updatedAt descending (most recent first)
    incompleteTasks.sort((a, b) => {
      return (
        new Date(b.progress.updatedAt).getTime() -
        new Date(a.progress.updatedAt).getTime()
      );
    });
  } catch {
    // Directory might not exist or be inaccessible
  }

  return incompleteTasks;
}
