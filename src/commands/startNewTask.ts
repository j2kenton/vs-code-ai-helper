import * as vscode from "vscode";
import {
  getMetaResourcesPath,
  hasValidMetaResourcesPath,
  isModelSelectionPromptShown,
  setModelSelectionPromptShown,
} from "../config/settings";
import { TASK_FILENAME } from "../types/taskProgress";
import {
  createTaskProgress,
  writeTaskProgress,
} from "../utils/taskProgressUtils";
import { openOrCreateDocument } from "../utils/fileUtils";

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
 * Creates a new task folder (YYYY-MM-DD_task_X) with progress tracking and
 * opens task.md for the user to describe the work. From there the Tasks
 * view / Resume Task offer the per-stage actions — there is no forced
 * wizard walking every stage up front.
 * Returns the created folder name, or undefined if cancelled/failed.
 */
export async function startNewTask(): Promise<string | undefined> {
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

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceRoot) {
    void vscode.window.showErrorMessage(
      "No workspace folder open. Please open a folder first."
    );
    return undefined;
  }

  const metaFolderUri = vscode.Uri.joinPath(
    workspaceRoot.uri,
    getMetaResourcesPath()
  );

  const dateStr = formatDate(new Date());
  const taskNumber = await getNextTaskNumber(metaFolderUri, dateStr);
  const taskFolderName = `${dateStr}_task_${taskNumber}`;
  const taskFolderUri = vscode.Uri.joinPath(metaFolderUri, taskFolderName);

  try {
    await vscode.workspace.fs.createDirectory(taskFolderUri);
    await writeTaskProgress(
      taskFolderUri,
      createTaskProgress(taskFolderName, "created")
    );

    const taskFileUri = vscode.Uri.joinPath(taskFolderUri, TASK_FILENAME);
    await openOrCreateDocument(taskFileUri);

    if (!isModelSelectionPromptShown()) {
      await setModelSelectionPromptShown();
      const modelChoice = await vscode.window.showInformationMessage(
        "Choose Copilot models per workflow step now? You can save selections for just this task or as workspace defaults.",
        "Configure Models",
        "Skip"
      );

      if (modelChoice === "Configure Models") {
        await vscode.commands.executeCommand(
          "vs-code-ai-helper.configureStepModels",
          { taskFolderUri }
        );
      }
    }

    const relativePath = vscode.workspace.asRelativePath(taskFileUri);
    await vscode.env.clipboard.writeText(relativePath);

    const choice = await vscode.window.showInformationMessage(
      `Created ${taskFolderName}. Describe the task in ${TASK_FILENAME}, then generate a plan.`,
      "Generate Plan with AI",
      "Later"
    );
    if (choice === "Generate Plan with AI") {
      await vscode.commands.executeCommand(
        "vs-code-ai-helper.generatePlanWithAI",
        taskFolderUri
      );
    }

    return taskFolderName;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(
      `Failed to create task folder: ${message}`
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
