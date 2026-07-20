import * as vscode from "vscode";
import { recoverTaskCreations, registerStartNewTaskCommand } from "./commands/startNewTask";
import { registerResumeTaskCommand } from "./commands/resumeTask";
import { registerGeneratePlanWithAICommand } from "./commands/generatePlanWithAI";
import { registerReviewActionCommands } from "./commands/reviewActions";
import { registerSetTaskStageCommand } from "./commands/setTaskStage";
import { registerViewArtifactCommands } from "./commands/viewArtifacts";
import { registerDraftTaskWithAICommand } from "./commands/draftTaskWithAI";
import { registerApplyCurrentStageActionCommand } from "./commands/applyCurrentStageAction";
import { registerOpenAndStartNewTaskCommand } from "./commands/openAndStartNewTask";
import { registerReviewCurrentTaskCommand } from "./commands/reviewCurrentTask";
import { registerFastForwardCurrentTaskReviewCommand } from "./commands/fastForwardCurrentTaskReview";
import { registerPauseTaskCommand } from "./commands/pauseTask";
import { registerArchiveTaskCommands } from "./commands/archiveTask";
import { registerPinTaskCommands } from "./commands/pinTask";
import { registerApplyHighLevelReviewChangesCommand } from "./commands/applyHighLevelReviewChanges";
import { registerApplyLowLevelReviewChangesCommand } from "./commands/applyLowLevelReviewChanges";
import { registerCommitAndPushTaskCommand } from "./commands/commitAndPushTask";
import { recoverRevertJournals } from "./utils/artifactRevertJournal";
import {
  ensureAutomaticMetaGitIgnore,
} from "./commands/toggleMetaResourcesGitIgnore";
import {
  maybeOfferMetaResourcesMigration,
  registerMetaResourcesMigrationCommand,
} from "./utils/metaResourcesMigration";
import { registerChoosePublishScopeCommand } from "./commands/choosePublishScope";
import { registerChatWithStageCommand } from "./commands/chatWithStage";
import {
  registerOpenGeneralAssistantCommand,
  resolveGlobalAssistantTarget,
} from "./commands/openGeneralAssistant";
import { registerRunLintingFixesCommand } from "./commands/runLintingFixes";
import { registerRunPublishChecksCommand } from "./commands/runPublishChecks";
import { registerScheduleTaskResumeCommand } from "./commands/scheduleTaskResume";
import { registerMarkTaskDoneCommand } from "./commands/markTaskDone";
import { registerViewStageChangesCommands } from "./commands/viewStageChanges";
import { registerRenameTaskCommands } from "./commands/renameTask";
import { registerConfigureStepModelsCommand } from "./commands/configureStepModels";
import { TaskTreeProvider, TASKS_VIEW_ID, TaskNode, StageNode, EmptyTasksNode } from "./views/taskTreeProvider";
import { TaskStatusBar } from "./views/taskStatusBar";
import { SettingsViewProvider } from "./views/settingsView";
import { ChatViewProvider } from "./views/chatView";
import { TaskInventory } from "./state/taskInventory";
import { CurrentTaskStore } from "./utils/currentTaskStore";
import { TASK_PROGRESS_FILENAME } from "./types/taskProgress";
import { warmCliModelCache } from "./utils/modelSelection";
import { StatusTreeProvider, STATUS_VIEW_ID } from "./views/statusView";
import { initNotificationRouter, deactivateNotificationRouter, NotificationRouter } from "./utils/notificationRouter";
import { installOperationNotificationBridge } from "./utils/operationNotificationBridge";
import { ENSEMBLE_NOTIFICATION_SCHEME, NotificationContentProvider } from "./utils/notificationContentProvider";
import { ViewProgressBinder } from "./utils/viewProgressBinder";
import { taskOperations } from "./utils/taskOperations";
import { cleanupOrphanedTempFiles } from "./state/writeAtomic";
import { resolveTaskRootCandidates } from "./utils/taskRoot";
import { finishFinalization, recoverFinalizationTree } from "./state/finalizationJournal";
import { PendingOperationsStore } from "./state/pendingOperationsStore";
import { recoverActivationCheckpoint } from "./state/taskActivationCoordinator";
import { readTaskProgress } from "./utils/taskProgressUtils";
import { installAutoImplementConfirmation, migrateEnabledProvidersForExistingModels, migrateSettingsNamespace, migrateSettingsScope } from "./config/settings";

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
  // Scope migration must resolve before the provider migration, which
  // inspects enabledProviders' post-migration state to decide whether it
  // still needs to run.
  void migrateSettingsNamespace(context)
    .then(() => migrateSettingsScope())
    .catch(error => console.error("Settings scope migration failed", error))
    .then(() => migrateEnabledProvidersForExistingModels())
    .catch(error => console.error("Provider settings migration failed", error));
  context.subscriptions.push(installAutoImplementConfirmation(context));
  void vscode.commands.executeCommand("setContext", "vs-code-ai-helper.tasksInitialized", false);
  // Recover interrupted operations before commands become available. They are
  // retained for reconciliation rather than silently discarded.
  const pendingOperations = new PendingOperationsStore(context.workspaceState);
  for (const operation of pendingOperations.recoverable()) {
    void pendingOperations.update(operation.id, "needs-reconciliation");
  }

  // Create a single shared CurrentTaskStore backed by workspaceState so the
  // current-task selection survives reloads without being shared globally.
  // Constructed before the startup recovery block below because activation
  // checkpoint recovery needs to update it.
  const currentTaskStore = new CurrentTaskStore(context.workspaceState);

  // Perform startup cleanup of orphaned temp files
  try {
    const candidates = resolveTaskRootCandidates();
    const rootPaths = candidates.map((c) => c.absolutePath);
    void cleanupOrphanedTempFiles(rootPaths);
    for (const root of rootPaths) {
      void recoverTaskCreations(root).catch(err =>
        console.error("Task creation recovery failed", err)
      );
      void recoverFinalizationTree(root).then(async journals => {
        for (const journal of journals) {
          // The journaled write itself is atomic (writeAtomic rename), so a
          // crash mid-write leaves task-progress.json either fully old or
          // fully new — never partial. The only actually-interrupted step is
          // clearing the journal marker, so verifying the file still reads
          // back as valid progress is sufficient to reconcile automatically
          // instead of leaving a stale journal that would re-warn forever.
          const progress = await readTaskProgress(vscode.Uri.file(journal.taskFolder));
          if (progress) {
            await finishFinalization(journal.taskFolder);
          } else {
            void vscode.window.showWarningMessage(`Could not verify an interrupted ${journal.operation} for task ${journal.taskFolder}. Please check its files manually.`);
          }
        }
      }).catch(err => console.error("Finalization recovery failed", err));
      void recoverActivationCheckpoint(root, currentTaskStore).then(summary => {
        if (summary) void vscode.window.showWarningMessage(summary);
      }).catch(err => console.error("Activation checkpoint recovery failed", err));
    }
  } catch (err) {
    console.error("Startup temp file cleanup failed", err);
  }

  // Create a single shared TaskInventory instance. All commands and the tree
  // provider use this same instance so discovery results are always consistent.
  const inventory = new TaskInventory();

  // Register the current-task decoration provider
  const decorationProvider = new CurrentTaskDecorationProvider();
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(decorationProvider)
  );

  const settingsViewProvider = new SettingsViewProvider(context.extensionUri);
  const chatViewProvider = new ChatViewProvider(context.workspaceState);
  context.subscriptions.push(chatViewProvider);
  // With no stage conversation selected, the Chat With AI panel defaults to
  // the global assistant instead of a "select a task first" blocked state.
  chatViewProvider.setDefaultTargetFactory(resolveGlobalAssistantTarget);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SettingsViewProvider.viewType,
      settingsViewProvider
    )
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatViewProvider)
  );
  registerConfigureStepModelsCommand(context, settingsViewProvider);

  // Register commands — pass the shared inventory, currentTaskStore, and
  // context to every command that needs them.
  registerStartNewTaskCommand(context, inventory, currentTaskStore);
  registerResumeTaskCommand(context, inventory, currentTaskStore);
  // AI commands receive the full context so they can call ensureAiConsent
  registerGeneratePlanWithAICommand(context, inventory);
  registerReviewActionCommands(context);
  registerSetTaskStageCommand(context, inventory, currentTaskStore);
  // The extension-level Settings button (beside the overflow menu) opens
  // native VS Code Settings scoped to this extension; the AI Models webview
  // has its own focus command used by the missing-model guard.
  context.subscriptions.push(vscode.commands.registerCommand(
    "vs-code-ai-helper.openSettings",
    () => vscode.commands.executeCommand("workbench.action.openSettings", "@ext:j2kenton.vs-code-ai-helper")
  ));
  context.subscriptions.push(vscode.commands.registerCommand(
    "vs-code-ai-helper.openAiModels",
    () => vscode.commands.executeCommand("vs-code-ai-helper.settingsView.focus")
  ));
  registerViewArtifactCommands(context);
  registerDraftTaskWithAICommand(context, inventory, chatViewProvider);
  registerApplyCurrentStageActionCommand(context, inventory, currentTaskStore);
  registerOpenAndStartNewTaskCommand(context, inventory, currentTaskStore);
  registerReviewCurrentTaskCommand(context, inventory, currentTaskStore);
  registerFastForwardCurrentTaskReviewCommand(context, inventory, currentTaskStore);
  registerPauseTaskCommand(context, inventory, currentTaskStore);
  registerArchiveTaskCommands(context, inventory, currentTaskStore);
  registerPinTaskCommands(context, inventory);
  registerApplyHighLevelReviewChangesCommand(context, inventory);
  registerApplyLowLevelReviewChangesCommand(context, inventory);
  registerCommitAndPushTaskCommand(context, inventory, currentTaskStore);
  registerMetaResourcesMigrationCommand(context, inventory, currentTaskStore);
  registerChoosePublishScopeCommand(context, inventory);
  registerChatWithStageCommand(context, inventory, chatViewProvider, currentTaskStore);
  registerRunLintingFixesCommand(context, inventory);
  registerRunPublishChecksCommand(context, inventory);
  const taskActionScheduler = registerScheduleTaskResumeCommand(context, inventory);
  registerMarkTaskDoneCommand(context, inventory, currentTaskStore);
  registerViewStageChangesCommands(context, inventory);
  registerRenameTaskCommands(context, inventory);

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
  const taskTreeProvider = new TaskTreeProvider(inventory, currentTaskStore, context.workspaceState);
  context.subscriptions.push(taskTreeProvider);
  const tasksTreeView = vscode.window.createTreeView(TASKS_VIEW_ID, {
    treeDataProvider: taskTreeProvider,
    // The view-title bar already contributes explicit Expand All Tasks /
    // Collapse All Tasks buttons; VS Code's built-in trailing collapse-all
    // button would be a duplicate.
    showCollapseAll: false,
  });

  // Initialize status view and notification router
  const statusTreeProvider = new StatusTreeProvider(context.workspaceState);
  context.subscriptions.push(statusTreeProvider);
  initNotificationRouter(statusTreeProvider);
  // Central operation → terminal-entry bridge (contract C1): every root
  // operation's end is recorded as a persistent Notifications entry from the
  // registry's own lifecycle event, so the in-progress row never just
  // vanishes and no command has to remember to post its own message.
  context.subscriptions.push(installOperationNotificationBridge());
  // Read-only fallback document for Notifications rows with no known
  // click-to-open target (D11) — registered once, for the lifetime of the
  // extension, so every ensemble-notification: URI it hands out resolves.
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      ENSEMBLE_NOTIFICATION_SCHEME,
      new NotificationContentProvider()
    )
  );
  context.subscriptions.push(vscode.commands.registerCommand(
    "vs-code-ai-helper.clearNotifications",
    () => statusTreeProvider.clear()
  ));
  context.subscriptions.push(vscode.commands.registerCommand(
    "vs-code-ai-helper.filterNotifications",
    () => statusTreeProvider.chooseLevelFilter()
  ));
  // Inline cancel button on cancellable running-operation rows in the
  // Notifications view. Cancellation is a request: it fires the operation's
  // token (cascading to running children) and the row shows "cancelling…"
  // until the run observes the token and ends.
  context.subscriptions.push(vscode.commands.registerCommand(
    "vs-code-ai-helper.cancelOperation",
    (node?: { id?: string; sourceOperationId?: string }) => {
      const operationId = typeof node?.id === "string" ? node.id : node?.sourceOperationId;
      if (typeof operationId !== "string") return;
      if (!taskOperations.cancelOperation(operationId)) {
        NotificationRouter.showInformation(
          "This operation can no longer be cancelled (it may have just finished)."
        );
      }
    }
  ));
  // Inline "act on this" button on notification rows that carry a concrete
  // follow-up (e.g. "Publish Anyway" after auto-publish was skipped). Kept
  // separate from the row's own click command so clicking the row still
  // navigates to the notification's full text/target (D11) and this
  // dedicated action never gets silently dropped by that navigation.
  context.subscriptions.push(vscode.commands.registerCommand(
    "vs-code-ai-helper.runNotificationAction",
    (node?: unknown) => {
      if (!node) return;
      statusTreeProvider.runAction(node as Parameters<StatusTreeProvider["runAction"]>[0]);
    }
  ));
  registerOpenGeneralAssistantCommand(context, inventory, currentTaskStore, chatViewProvider);

  const statusTreeView = vscode.window.createTreeView(STATUS_VIEW_ID, {
    treeDataProvider: statusTreeProvider,
    showCollapseAll: false,
  });

  const progressBinder = new ViewProgressBinder(taskOperations);
  context.subscriptions.push(progressBinder);

  const taskStatusBar = new TaskStatusBar(currentTaskStore);
  const tasksLoadedListener = taskTreeProvider.onDidLoadTasks((tasks) => {
    void vscode.commands.executeCommand("setContext", "vs-code-ai-helper.tasksInitialized", true);
    const currentTaskCanonicalId = currentTaskStore.get();
    const currentTaskStage = currentTaskCanonicalId
      ? inventory.getTaskById(currentTaskCanonicalId)?.progress.currentStage
      : undefined;
    void vscode.commands.executeCommand(
      "setContext",
      "vs-code-ai-helper.currentTaskStage",
      currentTaskStage
    );
    taskStatusBar.update(tasks, currentTaskCanonicalId);
  });

  const refreshCommand = vscode.commands.registerCommand(
    "vs-code-ai-helper.refreshTasksView",
    () => taskTreeProvider.refresh()
  );
  const expandAllCommand = vscode.commands.registerCommand(
    "vs-code-ai-helper.expandAllTasks",
    async () => {
      await taskTreeProvider.expandAll(tasksTreeView);
      void vscode.commands.executeCommand(
        "setContext",
        "vs-code-ai-helper.taskListAllExpanded",
        true
      );
    }
  );
  const collapseAllCommand = vscode.commands.registerCommand(
    "vs-code-ai-helper.collapseAllTasks",
    () => {
      taskTreeProvider.collapseAll();
      void vscode.commands.executeCommand(
        "setContext",
        "vs-code-ai-helper.taskListAllExpanded",
        false
      );
    }
  );
  void vscode.commands.executeCommand(
    "setContext",
    "vs-code-ai-helper.taskListAllExpanded",
    false
  );
  context.subscriptions.push(vscode.commands.registerCommand(
    "vs-code-ai-helper.filterTasksByStatus",
    () => taskTreeProvider.chooseStatusFilter()
  ));
  context.subscriptions.push(vscode.commands.registerCommand(
    "vs-code-ai-helper.resetTaskStatusFilter",
    () => taskTreeProvider.resetStatusFilter()
  ));
  // Bound as the click command for stage rows whose artifact doesn't exist
  // on disk yet (e.g. an auto-triggered review is still generating it) so
  // clicking gives feedback instead of silently doing nothing — see
  // StageNode in taskTreeProvider.ts.
  context.subscriptions.push(vscode.commands.registerCommand(
    "vs-code-ai-helper.stageArtifactNotReady",
    (message?: string) => {
      NotificationRouter.showInformation(
        message ?? "This stage's artifact has not been created yet."
      );
    }
  ));
  const statusBarMenuCommand = vscode.commands.registerCommand(
    "vs-code-ai-helper.statusBarMenu",
    () => taskStatusBar.showMenu()
  );

  // Refresh inventory and tree whenever any task's progress file changes
  const progressWatcher = vscode.workspace.createFileSystemWatcher(
    `**/${TASK_PROGRESS_FILENAME}`
  );
  const onProgressChange = (): void => {
    void inventory.refresh().then(async () => {
      await taskActionScheduler.armAll();
      taskTreeProvider.refresh();
    });
  };
  progressWatcher.onDidCreate(onProgressChange);
  progressWatcher.onDidChange(onProgressChange);
  progressWatcher.onDidDelete(onProgressChange);

  // A crashed window can leave a lease behind. Periodically retrying the
  // persisted schedules lets this window claim an expired lease even when no
  // task-progress file change happens after the crash.
  const schedulerRecoveryTimer = setInterval(() => {
    void taskActionScheduler.armAll();
  }, 5 * 60 * 1000);

  // Refresh when the meta resources folder setting changes
  const configListener = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("vs-code-ai-helper.metaResourcesPath")) {
      void inventory.refresh().then(async () => {
        await taskActionScheduler.armAll();
        taskTreeProvider.refresh();
      });
    }
  });

  // Repaint decorations when the current task changes
  const currentTaskListener = currentTaskStore.onDidChange(() => {
    decorationProvider.notifyChanged();
    const currentTaskCanonicalId = currentTaskStore.get();
    const currentTaskStage = currentTaskCanonicalId
      ? inventory.getTaskById(currentTaskCanonicalId)?.progress.currentStage
      : undefined;
    void vscode.commands.executeCommand(
      "setContext",
      "vs-code-ai-helper.currentTaskStage",
      currentTaskStage
    );
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
    { dispose: () => clearInterval(schedulerRecoveryTimer) },
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
  // Schedules are persisted in task-progress.json. The inventory must be
  // populated before arming them or activation would miss every schedule.
  void inventory.refresh().then(async () => {
    await taskActionScheduler.armAll();
    taskTreeProvider.refresh();
    // Git-ignore handling for Ensemble resources is automatic (no settings
    // UI); a legacy/custom resource folder additionally gets a one-time
    // offer to move to the fixed `.ensemble` location.
    if (inventory.getTasks().length > 0) {
      void ensureAutomaticMetaGitIgnore(context)
        .catch(err => console.error("Automatic meta .gitignore maintenance failed", err));
    }
    void maybeOfferMetaResourcesMigration(context, inventory, currentTaskStore)
      .catch(err => console.error("Meta resources migration offer failed", err));
  });
  void warmCliModelCache();

  // Activation-time recovery for the one durable mid-flight artifact: an
  // interrupted revert swap (journal beside the artifact). A commit-message
  // review needs no recovery — its modal preview/confirmation is the
  // session, closing it (or reloading the window) cancels with nothing
  // committed.
  // Runs after initNotificationRouter (above) so status routing is live.
  void recoverRevertJournals(async (prompt) => {
    const name = prompt.artifactPath.split(/[\\/]/).pop() ?? prompt.artifactPath;
    const detail = prompt.artifactDiverged
      ? `${name} was changed after the revert was interrupted; completing the revert would overwrite those changes.`
      : prompt.backupDiverged
        ? `The previous-version backup of ${name} was changed after the revert was interrupted; completing the revert would overwrite that backup.`
        : `An interrupted revert of ${name} was found from a previous session.`;
    const choice = await vscode.window.showWarningMessage(
      `${detail} Complete the revert, or keep the file as it is now?`,
      { modal: true },
      "Complete Revert",
      "Keep Current File"
    );
    if (choice === "Complete Revert") return "restore";
    if (choice === "Keep Current File") return "keep";
    return "defer"; // Dismissed — ask again on a later activation.
  }).then((recovered) => {
    if (recovered > 0) {
      NotificationRouter.showInformation(
        `Recovered ${recovered} interrupted stage-revert operation(s) from a previous session.`
      );
    }
  }).catch((err) => console.error("Revert-journal recovery failed", err));

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
  treeView: vscode.TreeView<TaskNode | StageNode | EmptyTasksNode>,
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
