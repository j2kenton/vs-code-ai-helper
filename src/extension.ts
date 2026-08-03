import * as vscode from "vscode";
import { registerStartNewTaskCommand } from "./commands/startNewTask";
import { TaskCreationStartupReconcilerV1 } from "./state/taskCreationStartupReconcilerV1";
import { registerResumeTaskCommand } from "./commands/resumeTask";
import {
  registerGeneratePlanWithAICommand,
  resumeGeneratePlanInteractionV1,
} from "./commands/generatePlanWithAI";
import { GENERATE_PLAN_ACTION_KEY_V1 } from "./actions/rows/generatePlanRowV1";
import { DRAFT_ACTION_KEY_V1 } from "./actions/rows/draftRowV1";
import { GENERATE_IMPLEMENTATION_ACTION_KEY_V1 } from "./actions/rows/generateImplementationRowV1";
import { REVIEW_ACTION_KEY_V1 } from "./actions/rows/reviewRowV1";
import { APPLY_REVIEW_ACTION_KEY_V1 } from "./actions/rows/applyReviewRowV1";
import { CHAT_SEND_ACTION_KEY_V1 } from "./actions/rows/chatSendRowV1";
import { COMMIT_PUSH_METADATA_ACTION_KEY_V1 } from "./actions/rows/commitPushMetadataRowV1";
import {
  registerReviewActionCommands,
  resumeGenerateImplementationInteractionV1,
  resumeReviewInteractionV1,
  resumeApplyReviewInteractionV1,
} from "./commands/reviewActions";
import { registerSetTaskStageCommand } from "./commands/setTaskStage";
import { registerViewArtifactCommands } from "./commands/viewArtifacts";
import {
  registerDraftTaskWithAICommand,
  resumeDraftInteractionV1,
} from "./commands/draftTaskWithAI";
import { resumeChatSendInteractionV1, validateChatSendV1 } from "./commands/chatWithStage";
import { resumeCommitPushMetadataInteractionV1 } from "./commands/commitAndPushTask";
import {
  isEditPreflightActionKeyV1,
  resumeEditPreflightInteractionV1,
} from "./commands/runEditActionV1";
import { registerApplyCurrentStageActionCommand } from "./commands/applyCurrentStageAction";
import { registerOpenAndStartNewTaskCommand } from "./commands/openAndStartNewTask";
import { registerReviewCurrentTaskCommand } from "./commands/reviewCurrentTask";
import { registerFastForwardCurrentTaskReviewCommand } from "./commands/fastForwardCurrentTaskReview";
import { registerPauseTaskCommand } from "./commands/pauseTask";
import { registerArchiveTaskCommands } from "./commands/archiveTask";
import { registerPinTaskCommands } from "./commands/pinTask";
import { registerTaskCreationRecoveryCommands, resumeStrandedTaskDeletionsV1 } from "./commands/taskCreationRecovery";
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
import { setGlobalAssistantRuntimeDepsV1 } from "./utils/globalAssistantActions";
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
import { ChatViewProvider, ChatInteractionServiceResultV1 } from "./views/chatView";
import {
  createChatInteractionTransactionStoreV1,
} from "./services/chatInteractionTransactionStoreV1";
import { ActionConversationErrorV1, createActionConversationOrchestratorV1 } from "./actions/actionConversationOrchestratorV1";
import {
  configureWorkflowPrivateStorageRootV1,
  getWorkflowFileStoreV1,
  getWorkflowPathRegistryV1,
  setChatInteractionTransactionStoreV1,
} from "./services/workflowRuntimeServicesV1";
import { TaskInventory } from "./state/taskInventory";
import { CurrentTaskStore } from "./utils/currentTaskStore";
import { TASK_PROGRESS_FILENAME, TaskStatus } from "./types/taskProgress";
import { warmCliModelCache } from "./utils/modelSelection";
import { StatusTreeProvider, STATUS_VIEW_ID } from "./views/statusView";
import { initNotificationRouter, deactivateNotificationRouter, NotificationRouter } from "./utils/notificationRouter";
import { initReviewEscalationChat } from "./utils/reviewEscalation";
import { installOperationNotificationBridge } from "./utils/operationNotificationBridge";
import { ENSEMBLE_NOTIFICATION_SCHEME, NotificationContentProvider } from "./utils/notificationContentProvider";
import { ViewProgressBinder } from "./utils/viewProgressBinder";
import { taskOperations } from "./utils/taskOperations";
import { cleanupOrphanedTempFiles } from "./state/writeAtomic";
import { resolveTaskRootCandidates } from "./utils/taskRoot";
import { finishFinalization, recoverFinalizationTree } from "./state/finalizationJournal";
import { PendingOperationsStore } from "./state/pendingOperationsStore";
import { recoverActivationCheckpoint } from "./state/taskActivationCoordinator";
import { readTaskProgressStrictV1 } from "./services/taskProgressReaderV1";
import { IncompleteTask } from "./types/incompleteTask";
import { installAutoImplementConfirmation, migrateEnabledProvidersForExistingModels, migrateSettingsNamespace, migrateSettingsScope } from "./config/settings";

/**
 * Run an orchestrator call that throws `ActionConversationErrorV1` on
 * rejection (Cancel/Resume) and map it onto the webview-facing
 * `ChatInteractionServiceResultV1` (plan §5.4/§6.1) — the only translation
 * `ChatInteractionServicesV1`'s consumer (chatView.ts) needs. Routing through
 * `actionConversationOrchestratorV1` (rather than calling the durable
 * transaction store directly) is what makes Answer/Cancel actually validate
 * the full interaction reference — operation, interaction id, AND the
 * caller-asserted task/document binding chatView.ts derives server-side —
 * against the persisted transaction's own recorded identity, not only the
 * operation id.
 */
async function runChatConversationAction(action: () => Promise<void>): Promise<ChatInteractionServiceResultV1> {
  try {
    await action();
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof ActionConversationErrorV1 || error instanceof Error ? error.message : String(error),
    };
  }
}

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

  // --- View provider registrations come first, before any other activation
  // work below (migrations, recovery scans, the command-registration flood,
  // etc.). activate() is synchronous, so every line that runs before a given
  // registerWebviewViewProvider/createTreeView call adds to the real window
  // where VS Code has already rendered that view's container but no provider
  // is registered for it yet — which VS Code surfaces as "There is no data
  // provider registered that can provide view data." Registration itself is
  // cheap and synchronous; each provider's actual (possibly async) data
  // loading happens later, inside resolveWebviewView/getChildren, once VS
  // Code calls it — so moving registration up front does not change when
  // data actually appears, only how early the container stops looking broken.
  // Only each provider's minimal, side-effect-free constructor dependencies
  // (workspaceState, extensionUri, and the shared inventory/currentTaskStore
  // below) are pulled forward with it.

  // Create a single shared CurrentTaskStore backed by workspaceState so the
  // current-task selection survives reloads without being shared globally.
  const currentTaskStore = new CurrentTaskStore(context.workspaceState);

  // Create a single shared TaskInventory instance. All commands and the tree
  // provider use this same instance so discovery results are always consistent.
  const inventory = new TaskInventory();

  const settingsViewProvider = new SettingsViewProvider(context.extensionUri);
  const chatViewProvider = new ChatViewProvider(context.workspaceState);
  context.subscriptions.push(chatViewProvider);
  // With no stage conversation selected, the Chat With AI panel defaults to
  // the global assistant instead of a "select a task first" blocked state.
  chatViewProvider.setDefaultTargetFactory(resolveGlobalAssistantTarget);
  // globalAssistantSendRowV1.ts's promoteCompletedContent runs from the
  // process-lifetime action registry singleton, not a per-call closure, so
  // it reads inventory/currentTaskStore/workspaceState from here instead.
  setGlobalAssistantRuntimeDepsV1({ inventory, currentTaskStore, workspaceState: context.workspaceState });

  // Wire the shared workflow runtime's private-storage root and the durable
  // Chat interaction transaction store (plan §2.1/§5.5) so the structured
  // Answer/Cancel controls in Chat With AI persist through the durable store
  // before the display mirror changes (plan §5.5), instead of only ever
  // touching the mirror. `context.globalStorageUri`'s directory is not
  // guaranteed to exist yet — VS Code does not create it automatically — so
  // it is created (idempotently) before anything is provisioned under it.
  // Resume dispatches by the interaction's recorded actionKey (plan §6.1):
  // today generatePlan.v1 (plan §6.2) and draft.v1 (plan §6.3) have migrated
  // onto the coordinator, so those are the only keys this routes to a real
  // handler — any other (not-yet-migrated) actionKey still surfaces the
  // "not available yet" message via the fallback branch below.
  void vscode.workspace.fs.createDirectory(context.globalStorageUri).then(
    () => undefined,
    (err: unknown) => console.error("Could not create the extension's global storage directory", err)
  );
  const workflowPrivateStorageRootId = configureWorkflowPrivateStorageRootV1(context.globalStorageUri.fsPath);
  const chatInteractionTransactionStore = createChatInteractionTransactionStoreV1({
    registry: getWorkflowPathRegistryV1(),
    fileStore: getWorkflowFileStoreV1(),
    privateRootId: workflowPrivateStorageRootId,
  });
  setChatInteractionTransactionStoreV1(chatInteractionTransactionStore);
  // Answer/Cancel route through the conversation orchestrator, not the raw
  // transaction store directly: the orchestrator validates the FULL
  // interaction reference (operation id, interaction id, and — since
  // chatView.ts now derives and supplies them server-side — the recorded
  // taskBindingId/chatDocumentId) against the persisted transaction before
  // any mutation, closing the "reference names the right interaction but the
  // wrong task/document" gap for these two production-wired controls.
  const chatConversationOrchestrator = createActionConversationOrchestratorV1({
    transactionStore: chatInteractionTransactionStore,
  });
  chatViewProvider.setInteractionServices({
    submitAnswers: async (ref, rawAnswers, answerIdempotencyId) => {
      const submitted = await chatConversationOrchestrator.submitAnswers(ref, rawAnswers, answerIdempotencyId);
      return submitted.ok ? { ok: true } : { ok: false, reason: submitted.reason };
    },
    cancel: async (ref) => runChatConversationAction(() => chatConversationOrchestrator.cancel(ref)),
    validateSend: async (target, _text) => {
      if (target.kind === "global") {
        return { ok: true };
      }
      const validated = await validateChatSendV1(
        inventory,
        { canonicalId: target.canonicalId, taskFolderPath: target.taskFolderPath },
        target.stage
      );
      return validated.ok ? { ok: true } : { ok: false, reason: validated.reason };
    },
    resume: async (ref, resumeIdempotencyId) => {
      const loaded = await chatConversationOrchestrator.loadInteraction(ref);
      if (loaded.kind !== "ok") {
        return {
          ok: false,
          reason: loaded.kind === "storageUnavailable" ? "workflow storage is unavailable" : loaded.reason,
        };
      }
      const actionKey = loaded.record.correlation.actionKey;
      const cancellation = new vscode.CancellationTokenSource();
      try {
        if (actionKey === GENERATE_PLAN_ACTION_KEY_V1) {
          return await resumeGeneratePlanInteractionV1(
            inventory,
            chatViewProvider,
            ref,
            resumeIdempotencyId,
            cancellation.token
          );
        }
        if (actionKey === DRAFT_ACTION_KEY_V1) {
          return await resumeDraftInteractionV1(
            inventory,
            chatViewProvider,
            ref,
            resumeIdempotencyId,
            cancellation.token
          );
        }
        if (actionKey === GENERATE_IMPLEMENTATION_ACTION_KEY_V1) {
          return await resumeGenerateImplementationInteractionV1(
            inventory,
            chatViewProvider,
            ref,
            resumeIdempotencyId,
            cancellation.token
          );
        }
        if (actionKey === REVIEW_ACTION_KEY_V1) {
          return await resumeReviewInteractionV1(
            context.extensionUri,
            inventory,
            chatViewProvider,
            ref,
            resumeIdempotencyId,
            cancellation.token
          );
        }
        if (actionKey === APPLY_REVIEW_ACTION_KEY_V1) {
          return await resumeApplyReviewInteractionV1(
            context.extensionUri,
            inventory,
            chatViewProvider,
            ref,
            resumeIdempotencyId,
            cancellation.token
          );
        }
        if (actionKey === CHAT_SEND_ACTION_KEY_V1) {
          return await resumeChatSendInteractionV1(
            inventory,
            chatViewProvider,
            ref,
            resumeIdempotencyId,
            cancellation.token
          );
        }
        if (actionKey === COMMIT_PUSH_METADATA_ACTION_KEY_V1) {
          // Not threaded through `cancellation.token`: Resume here starts a
          // fresh, linked public Commit and Push operation (plan §10.2
          // point 5), which owns its own tracked-operation cancellation
          // token rather than reusing this Chat-scoped one.
          return await resumeCommitPushMetadataInteractionV1(
            inventory,
            chatViewProvider,
            ref,
            resumeIdempotencyId,
            currentTaskStore,
            context
          );
        }
        if (isEditPreflightActionKeyV1(actionKey)) {
          // The four edit-capable preflight actions (implementation.v1,
          // fastForward.v1, applyReviewEdit.v1, lint.v1) share sameOperation
          // Resume semantics: a fresh preflight attempt with a fresh
          // observation baseline, continuing into the sealed edit session
          // when a plan seals (plan §7.3 / AC-PREFLIGHT-04).
          return await resumeEditPreflightInteractionV1(
            inventory,
            chatViewProvider,
            ref,
            actionKey,
            resumeIdempotencyId,
            cancellation.token
          );
        }
        return {
          ok: false,
          reason: "Resume isn't available yet for this question — the action that asked it hasn't been migrated to the new Resume flow.",
        };
      } finally {
        cancellation.dispose();
      }
    },
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SettingsViewProvider.viewType,
      settingsViewProvider
    )
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatViewProvider, {
      // Keeps the chat webview's DOM/script state alive while it's hidden
      // (e.g. the user switches to another view and back), instead of
      // discarding and re-resolving it from scratch every time it's shown.
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  void vscode.commands.executeCommand("setContext", "vs-code-ai-helper.tasksInitialized", false);
  // Tasks tree view: persistent visibility of workflow progress.
  const taskTreeProvider = new TaskTreeProvider(inventory, currentTaskStore, context.workspaceState);
  context.subscriptions.push(taskTreeProvider);
  const tasksTreeView = vscode.window.createTreeView(TASKS_VIEW_ID, {
    treeDataProvider: taskTreeProvider,
    // The view-title bar already contributes explicit Expand All Tasks /
    // Collapse All Tasks buttons; VS Code's built-in trailing collapse-all
    // button would be a duplicate.
    showCollapseAll: false,
  });

  // Status/Notifications tree view + router. StatusTreeProvider loads its
  // (small, Memento-backed) entries synchronously in its constructor, so
  // registering it here means it never has a real "loading" gap once
  // created — only the pre-registration gap this reordering closes.
  void vscode.commands.executeCommand("setContext", "vs-code-ai-helper.statusViewInitialized", false);
  const statusTreeProvider = new StatusTreeProvider(context.workspaceState);
  context.subscriptions.push(statusTreeProvider);
  initNotificationRouter(statusTreeProvider);
  const statusTreeView = vscode.window.createTreeView(STATUS_VIEW_ID, {
    treeDataProvider: statusTreeProvider,
    showCollapseAll: false,
  });
  void vscode.commands.executeCommand("setContext", "vs-code-ai-helper.statusViewInitialized", true);

  // --- End of view-provider registrations; the rest of activation (settings
  // migrations, startup recovery, and command registration) can now run
  // without risking the "no data provider" window above.

  // Scope migration must resolve before the provider migration, which
  // inspects enabledProviders' post-migration state to decide whether it
  // still needs to run.
  void migrateSettingsNamespace(context)
    .then(() => migrateSettingsScope())
    .catch(error => console.error("Settings scope migration failed", error))
    .then(() => migrateEnabledProvidersForExistingModels())
    .catch(error => console.error("Provider settings migration failed", error));
  context.subscriptions.push(installAutoImplementConfirmation(context));
  // Recover interrupted operations before commands become available. They are
  // retained for reconciliation rather than silently discarded.
  const pendingOperations = new PendingOperationsStore(context.workspaceState);
  for (const operation of pendingOperations.recoverable()) {
    void pendingOperations.update(operation.id, "needs-reconciliation");
  }

  // Read-only classification of legacy `creating` folders, published as a
  // barrier that both the first task-inventory publication (below) and every
  // creation/recovery command body (see TaskCreationStartupReconcilerV1's doc
  // comment, and startNewTask's use of waitUntilReady/getClassifiedFootprints)
  // must await before their first read. This replaces the old fire-and-forget
  // recoverTaskCreations call, which raced both of those.
  let startupGateReady: Promise<void> = Promise.resolve();

  // Perform startup cleanup of orphaned temp files
  try {
    const candidates = resolveTaskRootCandidates();
    const rootPaths = candidates.map((c) => c.absolutePath);
    void cleanupOrphanedTempFiles(rootPaths);
    // Plan §4.1 startup step 1 ("Resume verified Safe Delete
    // journals/tombstones"), ahead of step 4's classification below: a
    // deletion journal stuck at `folderRemoved` (crash between physically
    // removing the folder and recording `externalStateResolved`) is
    // invisible to `TaskCreationStartupReconcilerV1`'s own scan, which only
    // walks folders that still exist.
    const strandedDeletionSweeps = rootPaths.map((root) =>
      resumeStrandedTaskDeletionsV1(root, currentTaskStore, inventory).catch((err) =>
        console.error("Stranded task-deletion sweep failed", err)
      )
    );
    // Finalization-journal and activation-checkpoint recovery are startup
    // reconciliation too: both can mutate lifecycle/checkpoint state that
    // inventory publication and command reads must not observe mid-repair.
    // The plan's activation-order contract ("reconciliation completes before
    // inventory publication and command reads"; AC-CREATE-STARTUP-03: no
    // fire-and-forget reconciliation remains anywhere in activation) folds
    // them into `startupGateReady` alongside the stranded-deletion sweeps,
    // ahead of `beginClassification` — never run detached.
    const finalizationRecoveries = rootPaths.map((root) =>
      recoverFinalizationTree(root).then(async journals => {
        for (const journal of journals) {
          // The journaled write itself is atomic (writeAtomic rename), so a
          // crash mid-write leaves task-progress.json either fully old or
          // fully new — never partial. The only actually-interrupted step is
          // clearing the journal marker, so verifying the file still reads
          // back as valid progress is sufficient to reconcile automatically
          // instead of leaving a stale journal that would re-warn forever.
          const progressResult = await readTaskProgressStrictV1(vscode.Uri.file(journal.taskFolder));
          if (progressResult.ok) {
            await finishFinalization(journal.taskFolder);
          } else {
            // Strict cutover (plan §3.12): a corrupt progress file now warns
            // with the decoder's specific reason instead of being
            // indistinguishable from a missing one.
            NotificationRouter.showWarning(`Could not verify an interrupted ${journal.operation} for task ${journal.taskFolder} (${progressResult.reason}). Please check its files manually.`);
          }
        }
      }).catch(err => console.error("Finalization recovery failed", err))
    );
    const checkpointRecoveries = rootPaths.map((root) =>
      recoverActivationCheckpoint(root, currentTaskStore).then(summary => {
        if (summary) NotificationRouter.showWarning(summary);
      }).catch(err => console.error("Activation checkpoint recovery failed", err))
    );
    startupGateReady = Promise.all([
      ...strandedDeletionSweeps,
      ...finalizationRecoveries,
      ...checkpointRecoveries,
    ]).then(() =>
      TaskCreationStartupReconcilerV1.beginClassification(rootPaths, context.extensionUri)
    );
  } catch (err) {
    console.error("Startup temp file cleanup failed", err);
  }

  // Register the current-task decoration provider
  const decorationProvider = new CurrentTaskDecorationProvider();
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(decorationProvider)
  );

  registerConfigureStepModelsCommand(context, settingsViewProvider);

  // Register commands — pass the shared inventory, currentTaskStore, and
  // context to every command that needs them.
  registerStartNewTaskCommand(context, inventory, currentTaskStore);
  registerResumeTaskCommand(context, inventory, currentTaskStore);
  // AI commands receive the full context so they can call ensureAiConsent
  registerGeneratePlanWithAICommand(context, inventory, chatViewProvider);
  registerReviewActionCommands(context, chatViewProvider);
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
  registerTaskCreationRecoveryCommands(context, inventory, currentTaskStore);
  registerApplyHighLevelReviewChangesCommand(context, inventory);
  registerApplyLowLevelReviewChangesCommand(context, inventory);
  registerCommitAndPushTaskCommand(context, inventory, currentTaskStore, chatViewProvider);
  registerMetaResourcesMigrationCommand(context, inventory, currentTaskStore);
  registerChoosePublishScopeCommand(context, inventory);
  registerChatWithStageCommand(context, inventory, chatViewProvider, currentTaskStore);
  registerRunLintingFixesCommand(context, inventory, chatViewProvider);
  registerRunPublishChecksCommand(context, inventory);
  const taskActionScheduler = registerScheduleTaskResumeCommand(context, inventory);
  registerMarkTaskDoneCommand(context, inventory, currentTaskStore);
  registerViewStageChangesCommands(context, inventory);
  registerRenameTaskCommands(context, inventory);

  // Register the hello world command (keeping for backward compat)
  const helloWorldDisposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.helloWorld",
    () => {
      NotificationRouter.showInformation(
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

  // taskTreeProvider/tasksTreeView and statusTreeProvider/statusTreeView were
  // already constructed and registered above, alongside the other view
  // providers; the rest of the status-view wiring continues here.
  // Lets stuck review iteration (reviewEscalation.ts) post its "what should
  // I do?" question straight into Chat With AI, mirroring how
  // draftTaskWithAI surfaces blocking open questions there.
  initReviewEscalationChat(chatViewProvider);
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
  registerOpenGeneralAssistantCommand(context, inventory, chatViewProvider);
  context.subscriptions.push(
    vscode.commands.registerCommand("vs-code-ai-helper.openChatData", () =>
      chatViewProvider.openChatDataForCurrentTarget()
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("vs-code-ai-helper.resetChatHistory", () =>
      chatViewProvider.resetHistoryForCurrentTarget()
    )
  );

  const progressBinder = new ViewProgressBinder(taskOperations);
  context.subscriptions.push(progressBinder);

  const taskStatusBar = new TaskStatusBar(currentTaskStore);
  // Mirrors Source Control's changed-file-count overlay on its activity-bar
  // icon: when nothing is running, the Tasks view badge shows the count of
  // active + paused tasks (there is no separate "resumed" status — a
  // resumed task is just "active"). "creating" is excluded too: a task
  // still being created isn't yet something the user needs to act on.
  // While real background work is running, the
  // native progress spinner (ViewProgressBinder, above) already occupies
  // that same icon, so the badge steps aside rather than visually competing
  // with it — recomputed on every task-list reload and on every
  // taskOperations change (work starting/stopping).
  let lastLoadedTasks: readonly IncompleteTask[] = [];
  const ACTIVE_TASK_BADGE_STATUSES: ReadonlySet<TaskStatus> = new Set(["active", "paused"]);
  const refreshTaskCountBadge = (): void => {
    if (taskOperations.hasAnyRunning()) {
      tasksTreeView.badge = undefined;
      return;
    }
    const count = lastLoadedTasks.filter((t) => ACTIVE_TASK_BADGE_STATUSES.has(t.progress.status ?? "active")).length;
    tasksTreeView.badge = count > 0
      ? { value: count, tooltip: `${count} active task${count === 1 ? "" : "s"}` }
      : undefined;
  };
  const badgeOperationsListener = taskOperations.onDidChange(refreshTaskCountBadge);
  const tasksLoadedListener = taskTreeProvider.onDidLoadTasks((tasks) => {
    // tasksInitialized/isLoadingTasks are now set authoritatively by
    // TaskInventory.refresh() (see taskInventory.ts) rather than here: this
    // event also fires from render-triggered loadTasks() calls that read a
    // still-empty inventory before the first refresh() resolves, which used
    // to flip tasksInitialized to true prematurely and made the tasks view
    // briefly show its "No tasks yet" empty state on every activation.
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
    lastLoadedTasks = tasks;
    refreshTaskCountBadge();
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
      NotificationRouter.showWarning(
        message ?? "This stage's artifact has not been created yet."
      );
    }
  ));
  const statusBarMenuCommand = vscode.commands.registerCommand(
    "vs-code-ai-helper.statusBarMenu",
    () => taskStatusBar.showMenu()
  );

  // Refresh inventory and tree whenever any task's progress file changes.
  // Awaits startupGateReady first (like the first refresh below) so a
  // watcher event firing during activation — e.g. another window finishing a
  // write to task-progress.json — can never publish inventory ahead of the
  // read-only creating-folder classification pass. (inventory.refresh() also
  // awaits the same barrier internally as defense-in-depth; these explicit
  // chains stay as the visible, test-asserted ordering contract.)
  const progressWatcher = vscode.workspace.createFileSystemWatcher(
    `**/${TASK_PROGRESS_FILENAME}`
  );
  const onProgressChange = (): void => {
    void startupGateReady.then(() => inventory.refresh()).then(async () => {
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

  // Refresh when the meta resources folder setting changes. Also gated on
  // startupGateReady — see onProgressChange above for why.
  const configListener = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("vs-code-ai-helper.metaResourcesPath")) {
      void startupGateReady.then(() => inventory.refresh()).then(async () => {
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
    badgeOperationsListener,
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
  // Awaiting startupGateReady first means the first inventory publication can
  // never race the legacy-creating classification pass above.
  void startupGateReady.then(() => inventory.refresh()).then(async () => {
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
