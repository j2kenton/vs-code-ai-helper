import * as vscode from "vscode";
import {
  getMetaResourcesPath,
  isPromptDismissed,
  dismissPrompt,
  hasValidMetaResourcesPath,
} from "./config/settings";
import {
  selectMetaFolder,
  registerSelectMetaFolderCommand,
} from "./commands/selectMetaFolder";
import { registerStartNewTaskCommand } from "./commands/startNewTask";
import { registerResumeTaskCommand } from "./commands/resumeTask";
import { registerGeneratePlanWithAICommand } from "./commands/generatePlanWithAI";
import { registerReviewPlanWithAICommand } from "./commands/reviewPlanWithAI";
import { registerUpdatePlanWithAICommand } from "./commands/updatePlanWithAI";
import { registerReviewUpdatedPlanWithAICommand } from "./commands/reviewUpdatedPlanWithAI";
import { registerSetTaskStageCommand } from "./commands/setTaskStage";
import { TaskTreeProvider, TASKS_VIEW_ID } from "./views/taskTreeProvider";
import { TaskStatusBar } from "./views/taskStatusBar";
import { TASK_PROGRESS_FILENAME } from "./types/taskProgress";

/**
 * Button labels for the prompts
 */
const BUTTON_OK = "OK";
const BUTTON_CHANGE = "Change";
const BUTTON_DISMISS = "Dismiss";
const BUTTON_SELECT_FOLDER = "Select Folder";

/**
 * Handle the activation prompt flow based on current configuration state
 */
async function handleActivationPrompt(): Promise<void> {
  // If prompt was previously dismissed, stay silent
  if (isPromptDismissed()) {
    console.log("AI Helper: Prompt dismissed, extension inactive");
    return;
  }

  if (hasValidMetaResourcesPath()) {
    // Path exists - show info with option to change or dismiss
    const currentPath = getMetaResourcesPath();
    const selection = await vscode.window.showInformationMessage(
      `AI Helper using: ${currentPath}`,
      BUTTON_OK,
      BUTTON_CHANGE,
      BUTTON_DISMISS
    );

    if (selection === BUTTON_CHANGE) {
      await selectMetaFolder();
    } else if (selection === BUTTON_DISMISS) {
      await dismissPrompt();
      void vscode.window.showInformationMessage(
        "AI Helper has been dismissed. Reinstall to re-enable."
      );
    }
    // OK or close - continue with current path
  } else {
    // No path configured - prompt to select or dismiss
    const selection = await vscode.window.showInformationMessage(
      "Configure a folder to store AI Helper meta resources (logs, docs, tracking)",
      BUTTON_SELECT_FOLDER,
      BUTTON_DISMISS
    );

    if (selection === BUTTON_SELECT_FOLDER) {
      await selectMetaFolder();
    } else if (selection === BUTTON_DISMISS) {
      await dismissPrompt();
      void vscode.window.showInformationMessage(
        "AI Helper has been dismissed. Reinstall to re-enable."
      );
    }
    // Close without selection - will prompt again next activation
  }
}

/**
 * This method is called when your extension is activated.
 * Your extension is activated the very first time the command is executed.
 */
export function activate(context: vscode.ExtensionContext): void {
  console.log("VS Code AI Helper is now active!");

  // Register commands
  registerSelectMetaFolderCommand(context);
  registerStartNewTaskCommand(context);
  registerResumeTaskCommand(context);
  registerGeneratePlanWithAICommand(context);
  registerReviewPlanWithAICommand(context);
  registerUpdatePlanWithAICommand(context);
  registerReviewUpdatedPlanWithAICommand(context);
  registerSetTaskStageCommand(context);

  // Register the hello world command (keeping for now)
  const helloWorldDisposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.helloWorld",
    () => {
      void vscode.window.showInformationMessage(
        "Hello from VS Code AI Helper!"
      );
    }
  );
  context.subscriptions.push(helloWorldDisposable);

  // Tasks tree view + status bar: persistent visibility of workflow progress
  const taskTreeProvider = new TaskTreeProvider();
  const tasksTreeView = vscode.window.createTreeView(TASKS_VIEW_ID, {
    treeDataProvider: taskTreeProvider,
    showCollapseAll: true,
  });

  const taskStatusBar = new TaskStatusBar();
  const tasksLoadedListener = taskTreeProvider.onDidLoadTasks((tasks) => {
    taskStatusBar.update(tasks);
  });

  const refreshCommand = vscode.commands.registerCommand(
    "vs-code-ai-helper.refreshTasksView",
    () => taskTreeProvider.refresh()
  );

  // Auto-refresh whenever any task's progress file changes
  const progressWatcher = vscode.workspace.createFileSystemWatcher(
    `**/${TASK_PROGRESS_FILENAME}`
  );
  progressWatcher.onDidCreate(() => taskTreeProvider.refresh());
  progressWatcher.onDidChange(() => taskTreeProvider.refresh());
  progressWatcher.onDidDelete(() => taskTreeProvider.refresh());

  // Refresh when the meta resources folder setting changes
  const configListener = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("vs-code-ai-helper.metaResourcesPath")) {
      taskTreeProvider.refresh();
    }
  });

  context.subscriptions.push(
    tasksTreeView,
    taskStatusBar,
    tasksLoadedListener,
    refreshCommand,
    progressWatcher,
    configListener
  );

  // Populate the status bar immediately, without waiting for the tree view
  // to be shown or for a change event to occur
  taskTreeProvider.refresh();

  // Handle activation prompt flow
  void handleActivationPrompt();
}

/**
 * This method is called when your extension is deactivated.
 */
export function deactivate(): void {
  // Cleanup code here
}
