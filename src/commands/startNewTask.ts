import * as vscode from "vscode";
import {
  getMetaResourcesPath,
  hasValidMetaResourcesPath,
} from "../config/settings";
import { TaskProgress } from "../types/taskProgress";
import {
  createTaskProgress,
  updateTaskProgressStage,
  writeTaskProgress,
} from "../utils/taskProgressUtils";

/**
 * Format a date as YYYY-MM-DD
 */
function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Get the next task number for a given date by checking existing folders
 */
async function getNextTaskNumber(
  metaFolderUri: vscode.Uri,
  dateStr: string
): Promise<number> {
  const pattern = new RegExp(`^${dateStr}_task_(\\d+)$`);
  let maxTaskNumber = 0;

  try {
    const entries = await vscode.workspace.fs.readDirectory(metaFolderUri);

    for (const [name, type] of entries) {
      if (type === vscode.FileType.Directory) {
        const match = pattern.exec(name);
        if (match && match[1]) {
          const taskNum = parseInt(match[1], 10);
          if (taskNum > maxTaskNumber) {
            maxTaskNumber = taskNum;
          }
        }
      }
    }
  } catch {
    // Directory might not exist yet or be empty, start with task 1
  }

  return maxTaskNumber + 1;
}

/**
 * Creates a new task folder in the meta resources directory.
 * Folder format: YYYY-MM-DD_task_X where X is incremented for each task on the same day.
 * Returns the created folder path, or undefined if cancelled/failed.
 */
export async function startNewTask(): Promise<string | undefined> {
  // Check if meta resources path is configured
  if (!hasValidMetaResourcesPath()) {
    const selection = await vscode.window.showErrorMessage(
      "No meta resources folder configured. Please set one first.",
      "Select Folder"
    );

    if (selection === "Select Folder") {
      await vscode.commands.executeCommand(
        "vs-code-ai-helper.selectMetaFolder"
      );
    }
    return undefined;
  }

  const metaPath = getMetaResourcesPath();
  const workspaceFolders = vscode.workspace.workspaceFolders;

  if (!workspaceFolders || workspaceFolders.length === 0) {
    void vscode.window.showErrorMessage(
      "No workspace folder open. Please open a folder first."
    );
    return undefined;
  }

  const workspaceRoot = workspaceFolders[0];
  if (!workspaceRoot) {
    return undefined;
  }

  // Resolve the meta folder URI (could be relative or absolute)
  const metaFolderUri = vscode.Uri.joinPath(workspaceRoot.uri, metaPath);

  // Get current date from system clock
  const now = new Date();
  const dateStr = formatDate(now);

  // Find the next task number
  const taskNumber = await getNextTaskNumber(metaFolderUri, dateStr);

  // Create the task folder name
  const taskFolderName = `${dateStr}_task_${taskNumber}`;
  const taskFolderUri = vscode.Uri.joinPath(metaFolderUri, taskFolderName);

  try {
    await vscode.workspace.fs.createDirectory(taskFolderUri);

    // Initialize task progress tracking
    let progress: TaskProgress = createTaskProgress(taskFolderName, "created");
    await writeTaskProgress(taskFolderUri, progress);

    void vscode.window.showInformationMessage(
      `Created new task folder: ${taskFolderName}`
    );

    // Helper to copy file content
    const copyFile = async (
      sourceUri: vscode.Uri,
      destUri: vscode.Uri
    ): Promise<void> => {
      const content = await vscode.workspace.fs.readFile(sourceUri);
      await vscode.workspace.fs.writeFile(destUri, content);
    };

    // Helper to create empty file, open it, and copy path to clipboard
    const createAndOpenFile = async (fileUri: vscode.Uri): Promise<void> => {
      await vscode.workspace.fs.writeFile(fileUri, new Uint8Array());
      const doc = await vscode.workspace.openTextDocument(fileUri);
      await vscode.window.showTextDocument(doc);

      // Copy relative path to clipboard and notify user
      const relativePath = vscode.workspace.asRelativePath(fileUri);
      await vscode.env.clipboard.writeText(relativePath);
      void vscode.window.showInformationMessage(
        `Copied to clipboard: ${relativePath}`
      );
    };

    const planFileUri = vscode.Uri.joinPath(taskFolderUri, "plan.md");
    const planReviewFileUri = vscode.Uri.joinPath(
      taskFolderUri,
      "plan-review.md"
    );
    const planUpdatedFileUri = vscode.Uri.joinPath(
      taskFolderUri,
      "plan-updated.md"
    );
    const planUpdatedReviewFileUri = vscode.Uri.joinPath(
      taskFolderUri,
      "plan-updated-review.md"
    );
    const planFinalFileUri = vscode.Uri.joinPath(
      taskFolderUri,
      "plan-final.md"
    );

    // Step 2: Prompt for plan.md
    const createPlan = await vscode.window.showQuickPick(
      ["Create plan.md", "Quit"],
      {
        placeHolder: "Would you like to create an initial plan?",
        title: "Task Planning",
      }
    );

    // Treat cancel or "Quit" as a pause — keep current progress so it can be resumed later
    if (createPlan !== "Create plan.md") {
      return taskFolderName;
    }

    await createAndOpenFile(planFileUri);

    // Update progress to "plan" stage
    progress = updateTaskProgressStage(progress, "plan");
    await writeTaskProgress(taskFolderUri, progress);

    // Step 3: Prompt for plan-review.md
    const createReview = await vscode.window.showQuickPick(
      ["Create plan-review.md", "Skip"],
      {
        placeHolder: "Would you like to create a plan review?",
        title: "Plan Review",
      }
    );

    // Cancelled: leave task at current stage
    if (!createReview) {
      return taskFolderName;
    }

    if (createReview !== "Create plan-review.md") {
      await copyFile(planFileUri, planFinalFileUri);
      const doc = await vscode.workspace.openTextDocument(planFinalFileUri);
      await vscode.window.showTextDocument(doc);

      // Mark as completed
      progress = updateTaskProgressStage(progress, "completed");
      await writeTaskProgress(taskFolderUri, progress);

      return taskFolderName;
    }

    await createAndOpenFile(planReviewFileUri);

    // Update progress to "plan-review" stage
    progress = updateTaskProgressStage(progress, "plan-review");
    await writeTaskProgress(taskFolderUri, progress);

    // Step 4: Prompt for plan-updated.md
    const createUpdated = await vscode.window.showQuickPick(
      ["Create plan-updated.md", "Dismiss review"],
      {
        placeHolder: "Would you like to create an updated plan?",
        title: "Plan Update",
      }
    );

    // Cancelled: leave task at current stage
    if (!createUpdated) {
      return taskFolderName;
    }

    if (createUpdated !== "Create plan-updated.md") {
      await copyFile(planFileUri, planFinalFileUri);
      const doc = await vscode.workspace.openTextDocument(planFinalFileUri);
      await vscode.window.showTextDocument(doc);

      // Mark as completed
      progress = updateTaskProgressStage(progress, "completed");
      await writeTaskProgress(taskFolderUri, progress);

      return taskFolderName;
    }

    await createAndOpenFile(planUpdatedFileUri);

    // Update progress to "plan-updated" stage
    progress = updateTaskProgressStage(progress, "plan-updated");
    await writeTaskProgress(taskFolderUri, progress);

    // Step 5: Prompt for plan-updated-review.md
    const createUpdatedReview = await vscode.window.showQuickPick(
      ["Create plan-updated-review.md", "Skip"],
      {
        placeHolder: "Would you like to create an updated plan review?",
        title: "Updated Plan Review",
      }
    );

    // Cancelled: leave task at current stage
    if (!createUpdatedReview) {
      return taskFolderName;
    }

    if (createUpdatedReview !== "Create plan-updated-review.md") {
      await copyFile(planUpdatedFileUri, planFinalFileUri);
      const doc = await vscode.workspace.openTextDocument(planFinalFileUri);
      await vscode.window.showTextDocument(doc);

      // Mark as completed
      progress = updateTaskProgressStage(progress, "completed");
      await writeTaskProgress(taskFolderUri, progress);

      return taskFolderName;
    }

    await createAndOpenFile(planUpdatedReviewFileUri);

    // Update progress to "plan-updated-review" stage
    progress = updateTaskProgressStage(progress, "plan-updated-review");
    await writeTaskProgress(taskFolderUri, progress);

    // Step 6: Prompt for plan-final.md
    const createFinal = await vscode.window.showQuickPick(
      ["Create plan-final.md", "Dismiss re-review"],
      {
        placeHolder: "Would you like to create the final plan?",
        title: "Final Plan",
      }
    );

    // Cancelled: leave task at current stage
    if (!createFinal) {
      return taskFolderName;
    }

    if (createFinal === "Create plan-final.md") {
      await createAndOpenFile(planFinalFileUri);

      // Update progress to "plan-final" stage
      progress = updateTaskProgressStage(progress, "plan-final");
      await writeTaskProgress(taskFolderUri, progress);
    } else {
      await copyFile(planUpdatedFileUri, planFinalFileUri);
      const doc = await vscode.workspace.openTextDocument(planFinalFileUri);
      await vscode.window.showTextDocument(doc);
    }

    // Mark as completed
    progress = updateTaskProgressStage(progress, "completed");
    await writeTaskProgress(taskFolderUri, progress);

    return taskFolderName;
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    void vscode.window.showErrorMessage(
      `Failed to create task folder: ${errorMessage}`
    );
    return undefined;
  }
}

/**
 * Register the startNewTask command
 */
export function registerStartNewTaskCommand(
  context: vscode.ExtensionContext
): void {
  const disposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.startNewTask",
    startNewTask
  );

  context.subscriptions.push(disposable);
}
