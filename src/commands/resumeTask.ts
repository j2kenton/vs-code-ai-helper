import * as vscode from "vscode";
import {
  getMetaResourcesPath,
  hasValidMetaResourcesPath,
} from "../config/settings";
import {
  TaskProgress,
  TaskStage,
  STAGE_DISPLAY_NAMES,
} from "../types/taskProgress";
import {
  findIncompleteTasks,
  IncompleteTask,
  updateTaskProgressStage,
  writeTaskProgress,
} from "../utils/taskProgressUtils";

/**
 * Resume an incomplete task from where the user left off.
 * Returns the task folder name if resumed, undefined if cancelled/failed.
 */
export async function resumeTask(): Promise<string | undefined> {
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

  // Resolve the meta folder URI
  const metaFolderUri = vscode.Uri.joinPath(workspaceRoot.uri, metaPath);

  // Find incomplete tasks
  const incompleteTasks = await findIncompleteTasks(metaFolderUri);

  if (incompleteTasks.length === 0) {
    void vscode.window.showInformationMessage(
      "No incomplete tasks found. Use 'Start New Task' to create one."
    );
    return undefined;
  }

  // Let user select which task to resume
  let selectedTask: IncompleteTask;

  if (incompleteTasks.length === 1) {
    const task = incompleteTasks[0];
    if (!task) {
      return undefined;
    }
    selectedTask = task;
  } else {
    // Multiple incomplete tasks - show picker
    const items = incompleteTasks.map((task) => ({
      label: task.folderName,
      description: `Stage: ${STAGE_DISPLAY_NAMES[task.progress.currentStage]}`,
      detail: `Last updated: ${new Date(
        task.progress.updatedAt
      ).toLocaleString()}`,
      task,
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: "Select a task to resume",
      title: "Resume Task",
    });

    if (!selected) {
      return undefined;
    }

    selectedTask = selected.task;
  }

  void vscode.window.showInformationMessage(
    `Resuming task: ${selectedTask.folderName} (${
      STAGE_DISPLAY_NAMES[selectedTask.progress.currentStage]
    })`
  );

  // Resume from the current stage
  return await resumeFromStage(selectedTask.folderUri, selectedTask.progress);
}

/**
 * Get the stage index for workflow progression
 */
function getStageIndex(stage: TaskStage): number {
  const stages: TaskStage[] = [
    "created",
    "plan",
    "plan-review",
    "plan-updated",
    "plan-updated-review",
    "plan-final",
    "completed",
  ];
  return stages.indexOf(stage);
}

/**
 * Resume a task from its current stage
 */
async function resumeFromStage(
  taskFolderUri: vscode.Uri,
  progress: TaskProgress
): Promise<string | undefined> {
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
    // Check if file already exists
    try {
      await vscode.workspace.fs.stat(fileUri);
      // File exists, just open it
      const doc = await vscode.workspace.openTextDocument(fileUri);
      await vscode.window.showTextDocument(doc);
    } catch {
      // File doesn't exist, create it
      await vscode.workspace.fs.writeFile(fileUri, new Uint8Array());
      const doc = await vscode.workspace.openTextDocument(fileUri);
      await vscode.window.showTextDocument(doc);
    }

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
  const planFinalFileUri = vscode.Uri.joinPath(taskFolderUri, "plan-final.md");

  let currentProgress = progress;
  const currentStageIndex = getStageIndex(currentProgress.currentStage);

  try {
    // Step 1: Handle "created" stage - prompt for plan.md
    if (currentStageIndex <= getStageIndex("created")) {
      const createPlan = await vscode.window.showQuickPick(
        ["Create plan.md", "Quit"],
        {
          placeHolder: "Would you like to create an initial plan?",
          title: "Task Planning",
        }
      );

      if (createPlan !== "Create plan.md") {
        return currentProgress.taskFolder;
      }

      await createAndOpenFile(planFileUri);
      currentProgress = updateTaskProgressStage(currentProgress, "plan");
      await writeTaskProgress(taskFolderUri, currentProgress);
    }

    // Step 2: Handle "plan" stage - prompt for plan-review.md
    if (getStageIndex(currentProgress.currentStage) <= getStageIndex("plan")) {
      const createReview = await vscode.window.showQuickPick(
        ["Create plan-review.md", "Skip"],
        {
          placeHolder: "Would you like to create a plan review?",
          title: "Plan Review",
        }
      );

      if (createReview !== "Create plan-review.md") {
        await copyFile(planFileUri, planFinalFileUri);
        const doc = await vscode.workspace.openTextDocument(planFinalFileUri);
        await vscode.window.showTextDocument(doc);
        currentProgress = updateTaskProgressStage(currentProgress, "completed");
        await writeTaskProgress(taskFolderUri, currentProgress);
        return currentProgress.taskFolder;
      }

      await createAndOpenFile(planReviewFileUri);
      currentProgress = updateTaskProgressStage(currentProgress, "plan-review");
      await writeTaskProgress(taskFolderUri, currentProgress);
    }

    // Step 3: Handle "plan-review" stage - prompt for plan-updated.md
    if (
      getStageIndex(currentProgress.currentStage) <=
      getStageIndex("plan-review")
    ) {
      const createUpdated = await vscode.window.showQuickPick(
        ["Create plan-updated.md", "Dismiss review"],
        {
          placeHolder: "Would you like to create an updated plan?",
          title: "Plan Update",
        }
      );

      if (createUpdated !== "Create plan-updated.md") {
        await copyFile(planFileUri, planFinalFileUri);
        const doc = await vscode.workspace.openTextDocument(planFinalFileUri);
        await vscode.window.showTextDocument(doc);
        currentProgress = updateTaskProgressStage(currentProgress, "completed");
        await writeTaskProgress(taskFolderUri, currentProgress);
        return currentProgress.taskFolder;
      }

      await createAndOpenFile(planUpdatedFileUri);
      currentProgress = updateTaskProgressStage(
        currentProgress,
        "plan-updated"
      );
      await writeTaskProgress(taskFolderUri, currentProgress);
    }

    // Step 4: Handle "plan-updated" stage - prompt for plan-updated-review.md
    if (
      getStageIndex(currentProgress.currentStage) <=
      getStageIndex("plan-updated")
    ) {
      const createUpdatedReview = await vscode.window.showQuickPick(
        ["Create plan-updated-review.md", "Skip"],
        {
          placeHolder: "Would you like to create an updated plan review?",
          title: "Updated Plan Review",
        }
      );

      if (createUpdatedReview !== "Create plan-updated-review.md") {
        await copyFile(planUpdatedFileUri, planFinalFileUri);
        const doc = await vscode.workspace.openTextDocument(planFinalFileUri);
        await vscode.window.showTextDocument(doc);
        currentProgress = updateTaskProgressStage(currentProgress, "completed");
        await writeTaskProgress(taskFolderUri, currentProgress);
        return currentProgress.taskFolder;
      }

      await createAndOpenFile(planUpdatedReviewFileUri);
      currentProgress = updateTaskProgressStage(
        currentProgress,
        "plan-updated-review"
      );
      await writeTaskProgress(taskFolderUri, currentProgress);
    }

    // Step 5: Handle "plan-updated-review" stage - prompt for plan-final.md
    if (
      getStageIndex(currentProgress.currentStage) <=
      getStageIndex("plan-updated-review")
    ) {
      const createFinal = await vscode.window.showQuickPick(
        ["Create plan-final.md", "Dismiss re-review"],
        {
          placeHolder: "Would you like to create the final plan?",
          title: "Final Plan",
        }
      );

      if (createFinal === "Create plan-final.md") {
        await createAndOpenFile(planFinalFileUri);
        currentProgress = updateTaskProgressStage(
          currentProgress,
          "plan-final"
        );
        await writeTaskProgress(taskFolderUri, currentProgress);
      } else {
        await copyFile(planUpdatedFileUri, planFinalFileUri);
        const doc = await vscode.workspace.openTextDocument(planFinalFileUri);
        await vscode.window.showTextDocument(doc);
      }

      // Mark as completed
      currentProgress = updateTaskProgressStage(currentProgress, "completed");
      await writeTaskProgress(taskFolderUri, currentProgress);
    }

    // Handle "plan-final" stage - just mark as completed
    if (currentProgress.currentStage === "plan-final") {
      currentProgress = updateTaskProgressStage(currentProgress, "completed");
      await writeTaskProgress(taskFolderUri, currentProgress);
      void vscode.window.showInformationMessage(
        `Task ${currentProgress.taskFolder} marked as completed.`
      );
    }

    // Handle "completed" stage - nothing to do
    if (progress.currentStage === "completed") {
      void vscode.window.showInformationMessage(
        `Task ${currentProgress.taskFolder} is already completed.`
      );
    }

    return currentProgress.taskFolder;
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    void vscode.window.showErrorMessage(
      `Failed to resume task: ${errorMessage}`
    );
    return undefined;
  }
}

/**
 * Register the resumeTask command
 */
export function registerResumeTaskCommand(
  context: vscode.ExtensionContext
): void {
  const disposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.resumeTask",
    resumeTask
  );

  context.subscriptions.push(disposable);
}
