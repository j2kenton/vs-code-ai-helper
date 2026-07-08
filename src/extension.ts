import * as vscode from "vscode";
import {
  registerSelectMetaFolderCommand,
} from "./commands/selectMetaFolder";
import { registerStartNewTaskCommand } from "./commands/startNewTask";
import { registerResumeTaskCommand } from "./commands/resumeTask";
import { registerGeneratePlanWithAICommand } from "./commands/generatePlanWithAI";
import { registerReviewActionCommands } from "./commands/reviewActions";
import { registerSetTaskStageCommand } from "./commands/setTaskStage";
import { registerConfigureStepModelsCommand } from "./commands/configureStepModels";
import { registerViewArtifactCommands } from "./commands/viewArtifacts";
import { registerDraftTaskWithAICommand } from "./commands/draftTaskWithAI";
import { registerApplyCurrentStageActionCommand } from "./commands/applyCurrentStageAction";
import { registerPauseTaskCommand } from "./commands/pauseTask";
import { registerApplyHighLevelReviewChangesCommand } from "./commands/applyHighLevelReviewChanges";
import { registerApplyLowLevelReviewChangesCommand } from "./commands/applyLowLevelReviewChanges";
import { registerCommitAndPushTaskCommand } from "./commands/commitAndPushTask";
import { registerToggleMetaResourcesGitIgnoreCommand } from "./commands/toggleMetaResourcesGitIgnore";
import { registerChatWithStageCommand } from "./commands/chatWithStage";
import { registerOpenGeneralAssistantCommand } from "./commands/openGeneralAssistant";
import { registerRunLintingFixesCommand } from "./commands/runLintingFixes";
import { registerScheduleTaskResumeCommand } from "./commands/scheduleTaskResume";
import { TaskTreeProvider, TASKS_VIEW_ID } from "./views/taskTreeProvider";
import { TaskStatusBar } from "./views/taskStatusBar";
import { TaskInventory } from "./state/taskInventory";
import { CurrentTaskStore } from "./utils/currentTaskStore";
import { TASK_PROGRESS_FILENAME } from "./types/taskProgress";

/**
 * This method is called when your extension is activated.
 */
export function activate(context: vscode.ExtensionContext): void {
  console.log("VS Code AI Helper is now active!");

  // Create a single shared TaskInventory instance. All commands and the tree
  // provider use this same instance so discovery results are always consistent.
  const inventory = new TaskInventory();

  // Create a single shared CurrentTaskStore backed by workspaceState so the
  // current-task selection survives reloads without being shared globally.
  const currentTaskStore = new CurrentTaskStore(context.workspaceState);

  // Register commands — pass the shared inventory, currentTaskStore, and
  // context to every command that needs them.
  registerSelectMetaFolderCommand(context);
  registerStartNewTaskCommand(context, inventory, currentTaskStore);
  registerResumeTaskCommand(context, inventory, currentTaskStore);
  // AI commands receive the full context so they can call ensureAiConsent
  registerGeneratePlanWithAICommand(context);
  registerReviewActionCommands(context);
  registerSetTaskStageCommand(context, inventory, currentTaskStore);
  registerConfigureStepModelsCommand(context);
  registerViewArtifactCommands(context);
  registerDraftTaskWithAICommand(context, inventory);
  registerApplyCurrentStageActionCommand(context, inventory, currentTaskStore);
  registerPauseTaskCommand(context, inventory, currentTaskStore);
  registerApplyHighLevelReviewChangesCommand(context, inventory);
  registerApplyLowLevelReviewChangesCommand(context, inventory);
  registerCommitAndPushTaskCommand(context, inventory);
  registerToggleMetaResourcesGitIgnoreCommand(context);
  registerChatWithStageCommand(context, inventory);
  registerOpenGeneralAssistantCommand(context);
  registerRunLintingFixesCommand(context, inventory);
  registerScheduleTaskResumeCommand(context, inventory);

  // Register the hello world command (keeping for backward compat)
  const helloWorldDisposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.helloWorld",
    () => {
      void vscode.window.showInformationMessage(
        "Hello from VS Code AI Helper!"
      );
    }
  );
  context.subscriptions.push(helloWorldDisposable);

  // Register the viewDisclaimer command — opens the packaged DISCLAIMER.md
  // in the markdown preview so users can read it inside VS Code at any time.
  // This command is also wired into the first-use consent modal's
  // "View Disclaimer" button.
  const viewDisclaimerDisposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.viewDisclaimer",
    () => {
      const disclaimerUri = vscode.Uri.joinPath(
        context.extensionUri,
        "DISCLAIMER.md"
      );
      void vscode.commands.executeCommand(
        "markdown.showPreview",
        disclaimerUri
      );
    }
  );
  context.subscriptions.push(viewDisclaimerDisposable);

  // Tasks tree view + status bar: persistent visibility of workflow progress
  const taskTreeProvider = new TaskTreeProvider(inventory, currentTaskStore);
  const tasksTreeView = vscode.window.createTreeView(TASKS_VIEW_ID, {
    treeDataProvider: taskTreeProvider,
    showCollapseAll: false,
  });

  const taskStatusBar = new TaskStatusBar();
  const tasksLoadedListener = taskTreeProvider.onDidLoadTasks((tasks) => {
    taskStatusBar.update(tasks);
  });

  const refreshCommand = vscode.commands.registerCommand(
    "vs-code-ai-helper.refreshTasksView",
    () => taskTreeProvider.refresh()
  );
  const expandAllCommand = vscode.commands.registerCommand(
    "vs-code-ai-helper.expandAllTasks",
    () => taskTreeProvider.expandAll(tasksTreeView)
  );
  const collapseAllCommand = vscode.commands.registerCommand(
    "vs-code-ai-helper.collapseAllTasks",
    () => taskTreeProvider.collapseAll()
  );

  // Refresh inventory and tree whenever any task's progress file changes
  const progressWatcher = vscode.workspace.createFileSystemWatcher(
    `**/${TASK_PROGRESS_FILENAME}`
  );
  const onProgressChange = (): void => {
    void inventory.refresh().then(() => taskTreeProvider.refresh());
  };
  progressWatcher.onDidCreate(onProgressChange);
  progressWatcher.onDidChange(onProgressChange);
  progressWatcher.onDidDelete(onProgressChange);

  // Refresh when the meta resources folder setting changes
  const configListener = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("vs-code-ai-helper.metaResourcesPath")) {
      void inventory.refresh().then(() => taskTreeProvider.refresh());
    }
  });

  context.subscriptions.push(
    tasksTreeView,
    taskStatusBar,
    tasksLoadedListener,
    refreshCommand,
    expandAllCommand,
    collapseAllCommand,
    progressWatcher,
    configListener
  );

  // Populate the inventory and status bar immediately (silent — no folder creation)
  void inventory.refresh().then(() => taskTreeProvider.refresh());

  // NOTE: The initial "using plans" popup has been intentionally removed.
  // Discovery is silent; no folder is created until a task is actually made.
}

/**
 * This method is called when your extension is deactivated.
 */
export function deactivate(): void {
  // Cleanup code here
}
