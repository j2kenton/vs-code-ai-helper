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
import { registerOpenAndStartNewTaskCommand } from "./commands/openAndStartNewTask";
import { registerReReviewCurrentTaskCommand } from "./commands/reReviewCurrentTask";
import { registerPauseTaskCommand } from "./commands/pauseTask";
import { registerApplyHighLevelReviewChangesCommand } from "./commands/applyHighLevelReviewChanges";
import { registerApplyLowLevelReviewChangesCommand } from "./commands/applyLowLevelReviewChanges";
import { registerCommitAndPushTaskCommand } from "./commands/commitAndPushTask";
import {
  refreshMetaResourcesGitIgnoreContext,
  registerToggleMetaResourcesGitIgnoreCommand,
} from "./commands/toggleMetaResourcesGitIgnore";
import { registerChatWithStageCommand } from "./commands/chatWithStage";
import { registerOpenGeneralAssistantCommand } from "./commands/openGeneralAssistant";
import { registerRunLintingFixesCommand } from "./commands/runLintingFixes";
import { registerScheduleTaskResumeCommand } from "./commands/scheduleTaskResume";
import { registerMarkTaskDoneCommand } from "./commands/markTaskDone";
import { TaskTreeProvider, TASKS_VIEW_ID, TaskNode } from "./views/taskTreeProvider";
import { TaskStatusBar } from "./views/taskStatusBar";
import { TaskInventory } from "./state/taskInventory";
import { CurrentTaskStore } from "./utils/currentTaskStore";
import { TASK_PROGRESS_FILENAME } from "./types/taskProgress";
import { warmCliModelCache } from "./utils/modelSelection";
import { StatusTreeProvider } from "./views/statusView";
import { initNotificationRouter, deactivateNotificationRouter } from "./utils/notificationRouter";

/**
 * FileDecorationProvider for the synthetic `current-task:` URI scheme.
 * Renders a blue arrow badge on the current task row in the tree.
 */
class CurrentTaskDecorationProvider implements vscode.FileDecorationProvider {
  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<
    vscode.Uri | vscode.Uri[] | undefined
  >();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme === "current-task") {
      return {
        badge: "▶",
        color: new vscode.ThemeColor("charts.blue"),
      };
    }
    return undefined;
  }

  /**
   * Notify VS Code that decorations for the current-task scheme have changed.
   */
  notifyChanged(): void {
    this._onDidChangeFileDecorations.fire(undefined);
  }
}

/**
 * This method is called when your extension is activated.
 */
export function activate(context: vscode.ExtensionContext): void {
  console.log("Ensemble is now active!");

  // Create a single shared TaskInventory instance. All commands and the tree
  // provider use this same instance so discovery results are always consistent.
  const inventory = new TaskInventory();

  // Create a single shared CurrentTaskStore backed by workspaceState so the
  // current-task selection survives reloads without being shared globally.
  const currentTaskStore = new CurrentTaskStore(context.workspaceState);

  // Register the current-task decoration provider
  const decorationProvider = new CurrentTaskDecorationProvider();
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(decorationProvider)
  );

  // Register commands — pass the shared inventory, currentTaskStore, and
  // context to every command that needs them.
  registerSelectMetaFolderCommand(context);
  registerStartNewTaskCommand(context, inventory, currentTaskStore);
  registerResumeTaskCommand(context, inventory, currentTaskStore);
  // AI commands receive the full context so they can call ensureAiConsent
  registerGeneratePlanWithAICommand(context, inventory);
  registerReviewActionCommands(context);
  registerSetTaskStageCommand(context, inventory, currentTaskStore);
  registerConfigureStepModelsCommand(context);
  registerViewArtifactCommands(context);
  registerDraftTaskWithAICommand(context, inventory);
  registerApplyCurrentStageActionCommand(context, inventory, currentTaskStore);
  registerOpenAndStartNewTaskCommand(context, inventory, currentTaskStore);
  registerReReviewCurrentTaskCommand(context, inventory, currentTaskStore);
  registerPauseTaskCommand(context, inventory, currentTaskStore);
  registerApplyHighLevelReviewChangesCommand(context, inventory);
  registerApplyLowLevelReviewChangesCommand(context, inventory);
  registerCommitAndPushTaskCommand(context, inventory, currentTaskStore);
  registerToggleMetaResourcesGitIgnoreCommand(context, inventory, currentTaskStore);
  registerChatWithStageCommand(context, inventory);
  registerOpenGeneralAssistantCommand(context);
  registerRunLintingFixesCommand(context, inventory);
  registerScheduleTaskResumeCommand(context, inventory);
  registerMarkTaskDoneCommand(context, inventory, currentTaskStore);

  // Register the hello world command (keeping for backward compat)
  const helloWorldDisposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.helloWorld",
    () => {
      void vscode.window.showInformationMessage(
        "Hello from Ensemble!"
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

  // Initialize status view and notification router
  const statusTreeProvider = new StatusTreeProvider();
  initNotificationRouter(statusTreeProvider);

  const statusTreeView = vscode.window.createTreeView("vs-code-ai-helper.statusView", {
    treeDataProvider: statusTreeProvider,
    showCollapseAll: false,
  });

  const taskStatusBar = new TaskStatusBar(currentTaskStore);
  const tasksLoadedListener = taskTreeProvider.onDidLoadTasks((tasks) => {
    const currentTaskCanonicalId = currentTaskStore.get();
    taskStatusBar.update(tasks, currentTaskCanonicalId);
    void refreshMetaResourcesGitIgnoreContext(inventory, currentTaskStore);
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
  const statusBarMenuCommand = vscode.commands.registerCommand(
    "vs-code-ai-helper.statusBarMenu",
    () => taskStatusBar.showMenu()
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

  // Repaint decorations when the current task changes
  const currentTaskListener = currentTaskStore.onDidChange(() => {
    decorationProvider.notifyChanged();
    void refreshMetaResourcesGitIgnoreContext(inventory, currentTaskStore);
    // Reveal the newly-current task in the tree. We wait for the provider to
    // finish its next render cycle (triggered by its own onDidChange sub above)
    // before calling reveal, so the node is guaranteed to exist in the tree.
    void revealCurrentTask(tasksTreeView, taskTreeProvider, currentTaskStore);
  });

  // Track tree expand/collapse events so state survives refresh
  const onExpandListener = tasksTreeView.onDidExpandElement((event) => {
    if (event.element instanceof TaskNode) {
      taskTreeProvider.notifyExpanded(event.element.task);
    }
  });
  const onCollapseListener = tasksTreeView.onDidCollapseElement((event) => {
    if (event.element instanceof TaskNode) {
      taskTreeProvider.notifyCollapsed(event.element.task);
    }
  });

  context.subscriptions.push(
    tasksTreeView,
    statusTreeView,
    taskStatusBar,
    tasksLoadedListener,
    refreshCommand,
    expandAllCommand,
    collapseAllCommand,
    statusBarMenuCommand,
    progressWatcher,
    configListener,
    currentTaskListener,
    onExpandListener,
    onCollapseListener,
    {
      dispose: () => {
        deactivateNotificationRouter();
      }
    }
  );

  // Populate the inventory and status bar immediately (silent — no folder creation)
  void inventory.refresh().then(() => taskTreeProvider.refresh());
  void warmCliModelCache();

  // NOTE: The initial "using plans" popup has been intentionally removed.
  // Discovery is silent; no folder is created until a task is actually made.
}

/**
 * Reveal the current task node in the tree view after the provider has
 * finished re-rendering.
 *
 * The provider fires `onDidChangeTreeData` synchronously when the current
 * task changes. VS Code's tree widget re-renders asynchronously on the next
 * event-loop turn. We therefore wait for the provider's `onDidLoadTasks`
 * event — which fires at the end of `loadTasks()`, after new nodes have been
 * built and cached — before attempting the reveal. This avoids the race
 * where `getTaskNodesForReveal()` returns the pre-refresh node list.
 */
async function revealCurrentTask(
  treeView: vscode.TreeView<TaskNode>,
  provider: TaskTreeProvider,
  store: CurrentTaskStore
): Promise<void> {
  const canonicalId = store.get();
  if (!canonicalId) {
    return;
  }

  // Wait for the provider to complete its next load cycle so the node for
  // the new current task exists in the rendered node cache.
  await new Promise<void>((resolve) => {
    const sub = provider.onDidLoadTasks(() => {
      sub.dispose();
      resolve();
    });
  });

  const node = provider.getTaskNodeById(canonicalId);
  if (!node) {
    return;
  }

  try {
    await treeView.reveal(node, {
      expand: true,
      focus: false,
      select: false,
    });
  } catch {
    // Reveal can fail if the view is not visible — ignore silently.
  }
}

/**
 * This method is called when your extension is deactivated.
 */
export function deactivate(): void {
  // Cleanup code here
}
