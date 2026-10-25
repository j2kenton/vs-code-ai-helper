import * as vscode from "vscode";
import { getConfiguredTaskRoot } from "../utils/taskRoot";
import { TASK_FILENAME } from "../types/taskProgress";
import { findAllTasksStrictV1 } from "../services/taskProgressDiscoveryV1";
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
import { formatNotificationTaskLabelV1 } from "../utils/notificationTaskContextV1";
import { askChatChoiceV1 } from "../utils/chatChoiceV1";
import { resolveGlobalChatTargetV1 } from "../utils/globalChatTargetV1";

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

  const tasks = (await findAllTasksStrictV1(metaFolderUri)).tasks;

  // Prepare picker using artifactPicker helper (no filtering for viewTask)
  const hasPlanMap = new Map<string, boolean>();
  const pickerOptions: ArtifactPickerOptions<vscode.Uri> = {
    // wf10 item 21: carry displayName through so the picker label is never
    // just the unrecognizable folder id.
    tasks: tasks.map((task) => ({ ...task, displayName: task.progress.displayName })),
    hasPlanMap,
    mode: 'viewTask',
  };
  const { items, emptyMessage } = prepareArtifactPicker(pickerOptions);

  if (emptyMessage) {
    NotificationRouter.showInformation(emptyMessage);
    return;
  }

  const target = await resolveGlobalChatTargetV1();
  if (!target) {
    NotificationRouter.showError(
      "No workspace folder open. Please open a folder first."
    );
    return;
  }
  const chosen = await askChatChoiceV1({
    decisionKey: "viewTaskArtifact",
    target,
    whatHappened: "Choose which task's task.md to open.",
    whyUserNeeded: "More than one task exists in this workspace.",
    options: items.map((item, index) => ({
      optionId: `task-${index}`,
      label: item.label,
      description: item.description,
    })),
    detail: "Answering opens the chosen task.md.",
  });
  const selectedIndex = chosen === undefined ? -1 : items.findIndex((_item, index) => `task-${index}` === chosen);
  const selected = selectedIndex >= 0 ? items[selectedIndex] : undefined;
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
        `${formatNotificationTaskLabelV1(arg.task.progress.displayName, arg.task.folderName)}: failed to resolve plan: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return;
  }

  const tasks = (await findAllTasksStrictV1(metaFolderUri)).tasks;

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
    // wf10 item 21: carry displayName through so the picker label is never
    // just the unrecognizable folder id.
    tasks: tasks.map((task) => ({ ...task, displayName: task.progress.displayName })),
    hasPlanMap,
    mode: 'viewPlan',
  };
  const { items, emptyMessage } = prepareArtifactPicker(pickerOptions);

  if (emptyMessage) {
    NotificationRouter.showInformation(emptyMessage);
    return;
  }

  const target = await resolveGlobalChatTargetV1();
  if (!target) {
    NotificationRouter.showError(
      "No workspace folder open. Please open a folder first."
    );
    return;
  }
  const chosen = await askChatChoiceV1({
    decisionKey: "viewPlanArtifact",
    target,
    whatHappened: "Choose which task's plan.md to open.",
    whyUserNeeded: "More than one task with a plan exists in this workspace.",
    options: items.map((item, index) => ({
      optionId: `task-${index}`,
      label: item.label,
      description: item.description,
    })),
    detail: "Answering opens the chosen task's plan.md.",
  });
  const selectedIndex = chosen === undefined ? -1 : items.findIndex((_item, index) => `task-${index}` === chosen);
  const selected = selectedIndex >= 0 ? items[selectedIndex] : undefined;
  if (!selected) {
    return;
  }

  try {
    const planUri = await resolveCurrentPlanUri(selected.task.folderUri);
    await safeOpenTextDocument(planUri, "plan.md");
  } catch (error) {
    NotificationRouter.showError(
      `${formatNotificationTaskLabelV1(selected.task.displayName, selected.task.folderName)}: failed to resolve plan: ${error instanceof Error ? error.message : String(error)}`
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
