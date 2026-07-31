import * as vscode from "vscode";
import { getConfiguredTaskRoot } from "../utils/taskRoot";
import { TASK_FILENAME } from "../types/taskProgress";
import { findAllTasks } from "../utils/taskProgressUtils";
import { IncompleteTask } from "../types/incompleteTask";
import {
  resolveCurrentPlanUri,
  safeOpenTextDocument,
  statIfExists,
} from "../utils/fileUtils";
import {
  prepareArtifactPicker,
  type ArtifactPickerOptions,
} from "../utils/artifactPicker";
import { NotificationRouter } from "../utils/notificationRouter";

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
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceRoot) {
    NotificationRouter.showError(
      "No workspace folder open. Please open a folder first."
    );
    return;
  }

  const metaFolderUri = vscode.Uri.joinPath(
    workspaceRoot.uri,
    getConfiguredTaskRoot()
  );

  // If invoked from tree with a specific task, open directly
  if (arg?.task) {
    const taskUri = vscode.Uri.joinPath(arg.task.folderUri, TASK_FILENAME);
    await safeOpenTextDocument(taskUri, TASK_FILENAME);
    return;
  }

  const tasks = await findAllTasks(metaFolderUri);

  // Prepare picker using artifactPicker helper (no filtering for viewTask)
  const hasPlanMap = new Map<string, boolean>();
  const pickerOptions: ArtifactPickerOptions<vscode.Uri> = {
    tasks,
    hasPlanMap,
    mode: 'viewTask',
  };
  const { items, emptyMessage } = prepareArtifactPicker(pickerOptions);

  if (emptyMessage) {
    NotificationRouter.showInformation(emptyMessage);
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
  await safeOpenTextDocument(taskUri, TASK_FILENAME);
}

/**
 * View plan for a selected task, or the task passed from tree context.
 * Only shows tasks that have an existing plan.
 */
export async function viewPlan(arg?: ViewPlanArg): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceRoot) {
    NotificationRouter.showError(
      "No workspace folder open. Please open a folder first."
    );
    return;
  }

  const metaFolderUri = vscode.Uri.joinPath(
    workspaceRoot.uri,
    getConfiguredTaskRoot()
  );

  // If invoked from tree with a specific task, open directly
  if (arg?.task) {
    try {
      const planUri = await resolveCurrentPlanUri(arg.task.folderUri);
      if (!(await statIfExists(planUri))) {
        NotificationRouter.showWarning(
          `No plan found for ${arg.task.folderName}.`
        );
        return;
      }
      await safeOpenTextDocument(planUri, "plan.md");
    } catch (error) {
      NotificationRouter.showError(
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

  const pickerOptions: ArtifactPickerOptions<vscode.Uri> = {
    tasks,
    hasPlanMap,
    mode: 'viewPlan',
  };
  const { items, emptyMessage } = prepareArtifactPicker(pickerOptions);

  if (emptyMessage) {
    NotificationRouter.showInformation(emptyMessage);
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
    await safeOpenTextDocument(planUri, "plan.md");
  } catch (error) {
    NotificationRouter.showError(
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
