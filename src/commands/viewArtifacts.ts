import * as vscode from "vscode";
import {
  getMetaResourcesPath,
  hasValidMetaResourcesPath,
} from "../config/settings";
import { TASK_FILENAME } from "../types/taskProgress";
import { findAllTasks, IncompleteTask } from "../utils/taskProgressUtils";
import { resolveCurrentPlanUri, statIfExists } from "../utils/fileUtils";
import {
  prepareArtifactPicker,
  type ArtifactPickerOptions,
} from "../utils/artifactPicker";

interface ViewTaskArg {
  task?: IncompleteTask;
}

interface ViewPlanArg {
  task?: IncompleteTask;
}

/**
 * View task.md for a selected task, or the task passed from tree context.
 */
export async function viewTask(arg?: ViewTaskArg): Promise<void> {
  if (!hasValidMetaResourcesPath()) {
    void vscode.window.showErrorMessage(
      "No meta resources folder configured. Please set one first."
    );
    return;
  }

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceRoot) {
    void vscode.window.showErrorMessage(
      "No workspace folder open. Please open a folder first."
    );
    return;
  }

  const metaFolderUri = vscode.Uri.joinPath(
    workspaceRoot.uri,
    getMetaResourcesPath()
  );

  // If invoked from tree with a specific task, open directly
  if (arg?.task) {
    const taskUri = vscode.Uri.joinPath(arg.task.folderUri, TASK_FILENAME);
    const doc = await vscode.workspace.openTextDocument(taskUri);
    await vscode.window.showTextDocument(doc);
    return;
  }

  const tasks = await findAllTasks(metaFolderUri);

  // Prepare picker using artifactPicker helper (no filtering for viewTask)
  const hasPlanMap = new Map<string, boolean>();
  const pickerOptions: ArtifactPickerOptions = {
    tasks,
    hasPlanMap,
    mode: 'viewTask',
  };
  const { items, emptyMessage } = prepareArtifactPicker(pickerOptions);

  if (emptyMessage) {
    void vscode.window.showInformationMessage(emptyMessage);
    return;
  }

  const selected = await vscode.window.showQuickPick(items, {
    title: "View Task",
    placeHolder: "Select a task to view",
  });

  if (!selected) {
    return;
  }

  const taskUri = vscode.Uri.joinPath(selected.task.folderUri, TASK_FILENAME);
  const doc = await vscode.workspace.openTextDocument(taskUri);
  await vscode.window.showTextDocument(doc);
}

/**
 * View plan for a selected task, or the task passed from tree context.
 * Only shows tasks that have an existing plan.
 */
export async function viewPlan(arg?: ViewPlanArg): Promise<void> {
  if (!hasValidMetaResourcesPath()) {
    void vscode.window.showErrorMessage(
      "No meta resources folder configured. Please set one first."
    );
    return;
  }

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceRoot) {
    void vscode.window.showErrorMessage(
      "No workspace folder open. Please open a folder first."
    );
    return;
  }

  const metaFolderUri = vscode.Uri.joinPath(
    workspaceRoot.uri,
    getMetaResourcesPath()
  );

  // If invoked from tree with a specific task, open directly
  if (arg?.task) {
    try {
      const planUri = await resolveCurrentPlanUri(arg.task.folderUri);
      if (!(await statIfExists(planUri))) {
        void vscode.window.showInformationMessage(
          `No plan found for ${arg.task.folderName}.`
        );
        return;
      }
      const doc = await vscode.workspace.openTextDocument(planUri);
      await vscode.window.showTextDocument(doc);
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Failed to resolve plan: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return;
  }

  const tasks = await findAllTasks(metaFolderUri);

  // Build hasPlanMap by checking each task's plan existence in parallel
  const hasPlanResults = await Promise.all(
    tasks.map(async (task) => {
      try {
        const planUri = await resolveCurrentPlanUri(task.folderUri);
        const exists = (await statIfExists(planUri)) !== undefined;
        return { key: task.folderUri.toString(), exists };
      } catch (error) {
        // If resolveCurrentPlanUri fails, treat as no plan available
        console.warn(`Failed to resolve plan for ${task.folderName}:`, error);
        return { key: task.folderUri.toString(), exists: false };
      }
    })
  );
  const hasPlanMap = new Map<string, boolean>();
  for (const { key, exists } of hasPlanResults) {
    hasPlanMap.set(key, exists);
  }

  const pickerOptions: ArtifactPickerOptions = {
    tasks,
    hasPlanMap,
    mode: 'viewPlan',
  };
  const { items, emptyMessage } = prepareArtifactPicker(pickerOptions);

  if (emptyMessage) {
    void vscode.window.showInformationMessage(emptyMessage);
    return;
  }

  const selected = await vscode.window.showQuickPick(items, {
    title: "View Plan",
    placeHolder: "Select a task to view its plan",
  });

  if (!selected) {
    return;
  }

  try {
    const planUri = await resolveCurrentPlanUri(selected.task.folderUri);
    const doc = await vscode.workspace.openTextDocument(planUri);
    await vscode.window.showTextDocument(doc);
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Failed to resolve plan: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Register artifact viewing commands.
 */
export function registerViewArtifactCommands(
  context: vscode.ExtensionContext
): void {
  const viewTaskDisposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.viewTask",
    (arg?: ViewTaskArg) => viewTask(arg)
  );
  context.subscriptions.push(viewTaskDisposable);

  const viewPlanDisposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.viewPlan",
    (arg?: ViewPlanArg) => viewPlan(arg)
  );
  context.subscriptions.push(viewPlanDisposable);
}
