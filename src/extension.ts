import * as vscode from "vscode";
import * as path from "path";
import { resolveEnsembleHostRoleV1, VIEWER_HOST_REFUSAL_MESSAGE_V1 } from "./state/hostRoleV1";
import { allocateHostRelayIdV1, createHostRelayV1, HOST_RELAY_DIRNAME_V1, HostRelayRequestV1 } from "./services/hostRelayV1";
import { consumeSendAcceptedV1 } from "./commands/chatWithStage";
import {
  configureViewerCommandForwarderV1,
  decodeRelayedCommandArgV1,
  RELAYABLE_COMMAND_IDS_V1,
  type ViewerForwardResultV1,
} from "./services/viewerForwardingV1";
import {
  createMirroredDecisionsMementoV1,
  HOST_DECISIONS_MIRROR_FILENAME_V1,
  liveMirroredDecisionsV1,
  readRunnerDecisionsSnapshotV1,
  writeRunnerDecisionsSnapshotV1,
} from "./services/hostDecisionMirrorV1";
import { runUnattendedV1 } from "./state/unattendedExecutionV1";
import {
  describeAbandonedOperationV1,
  findAbandonedOperationsV1,
} from "./state/abandonedOperationReaperV1";
import {
  notifyWorkflowDecisionsChangedV1,
  WORKFLOW_DECISIONS_STORAGE_KEY_V1,
  WorkflowDecisionStoreV1,
} from "./state/workflowDecisionStoreV1";
import {
  describeRunnerActivityV1,
  HOST_OPERATIONS_MIRROR_FILENAME_V1,
  isRunnerReportingV1,
  liveMirroredOperationsV1,
  readRunnerOperationsSnapshotV1,
  runnerActivationIdV1,
  RUNNER_OPERATIONS_STALE_MS_V1,
  RUNNER_OPERATIONS_HEARTBEAT_MS_V1,
  writeRunnerOperationsSnapshotV1,
} from "./services/hostOperationsMirrorV1";
import {
  appendMirroredNotificationV1,
  createNotificationMirrorTailV1,
  HOST_NOTIFICATION_MIRROR_FILENAME_V1,
} from "./services/hostNotificationMirrorV1";
import { notifyChatHistoryChangedExternallyV1, settleChatInteraction } from "./utils/chatHistoryStore";
import {
  acquireWorkAdmissionV1,
  authorizeWorkAdmissionHandoffV1,
  describeWorkAdmissionRefusalV1,
  revokeWorkAdmissionHandoffV1,
  WORK_ADMISSION_HEARTBEAT_INTERVAL_MS_V1,
  workAdmissionRenewalAgeMsV1,
} from "./state/workAdmissionV1";
import { CHAT_HISTORY_FILENAME } from "./utils/chatHistoryConstants";
// Side-effect only: registers `effectivePauseStatusV1.ts`'s pause-revocation
// cleanup hook with `workAdmissionV1.ts` (2026-09-11 review completion
// blocker `dceb2646...-2`). No other production module reaches this file yet
// (plan step 13's full consumer audit is separate, later work), so without
// this import the hook is never registered and a completed revocation
// barrier never cleans up the stale `task-progress.json` pause fields it left
// behind — see both modules' doc comments for the full wiring rationale.
import "./state/effectivePauseStatusV1";
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
import { registerOpenRetainedPromptCommand } from "./commands/openRetainedPromptV1";
import { registerOpenPlanNonGoalsCommand } from "./commands/openPlanNonGoalsV1";
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
import { registerGoToReviewAndApplyCommandV1 } from "./commands/goToReviewAndApplyV1";
import { registerRetryReviewWithBackupCommandV1 } from "./commands/retryReviewWithBackupV1";
import { registerOpenAndStartNewTaskCommand } from "./commands/openAndStartNewTask";
import { registerReviewCurrentTaskCommand } from "./commands/reviewCurrentTask";
import { registerFastForwardCurrentTaskReviewCommand } from "./commands/fastForwardCurrentTaskReview";
import { registerRecoverLastAiResponseCommand } from "./commands/recoverLastAiResponse";
import { registerPauseTaskCommand } from "./commands/pauseTask";
import { registerArchiveTaskCommands } from "./commands/archiveTask";
import { registerPinTaskCommands } from "./commands/pinTask";
import { registerReconcilePlanChecklistCommands } from "./commands/reconcilePlanChecklist";
import { registerApplyReviewerVerifiedTicksCommands } from "./commands/applyReviewerVerifiedTicks";
import { registerPlanRevisionCommandsV1 } from "./commands/planRevisionV1";
import { registerTaskCreationRecoveryCommands, resumeStrandedTaskDeletionsV1 } from "./commands/taskCreationRecovery";
import { registerApplyHighLevelReviewChangesCommand } from "./commands/applyHighLevelReviewChanges";
import { registerApplyLowLevelReviewChangesCommand } from "./commands/applyLowLevelReviewChanges";
import { registerCommitAndPushTaskCommand } from "./commands/commitAndPushTask";
import { recoverRevertJournals } from "./utils/artifactRevertJournal";
import { registerConditionalWriteSaveGuardV1 } from "./utils/fileUtils";
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
import {
  ChatViewProvider,
  ChatInteractionResumeResultV1,
  ChatInteractionServiceResultV1,
  ChatInteractionServicesV1,
  ChatTarget,
} from "./views/chatView";
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
import { configureHostIdentityRootV1 } from "./state/hostIdentityV1";
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
import type { OperationKind } from "./utils/operationTaxonomy";
import { STAGE_DISPLAY_NAMES, type TaskStage } from "./types/taskProgress";
import { cleanupOrphanedTempFiles } from "./state/writeAtomic";
import { normalizePath, resolveTaskRootCandidates } from "./utils/taskRoot";
import { finishFinalization, recoverFinalizationTree } from "./state/finalizationJournal";
import { PendingOperationsStore } from "./state/pendingOperationsStore";
import { recoverActivationCheckpoint } from "./state/taskActivationCoordinator";
import { readTaskProgressStrictV1 } from "./services/taskProgressReaderV1";
import { IncompleteTask } from "./types/incompleteTask";
import { getModelSettings, installAutoImplementConfirmation, migrateEnabledProvidersForExistingModels, migrateSettingsNamespace, migrateSettingsScope } from "./config/settings";
import { setExtensionContextV1 } from "./utils/extensionContextV1";
import {
  configureWorkflowDecisionStateV1,
  dismissOrphanedAwaitedDecisionsV1,
} from "./utils/workflowDecisionDispatchV1";
import { setInertTrailingObserverV1 } from "./types/aiResultEnvelope";
import { setLmToolSessionObserverV1, setLmToolSessionRequestIssuedObserverV1 } from "./services/languageModelToolSessionV1";
import { setReadToolCallObserverV1 } from "./services/readToolSessionHandlerV1";

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
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log("Ensemble is now active!");
  setExtensionContextV1(context);
  // Cloud runner/viewer split (hostRoleV1.ts): resolved once, here, and
  // fixed for this host's lifetime. A VIEWER activates every view and
  // command but runs no AI and no automation: the sections below that
  // schedule, recover or execute work are skipped for it, and the provider
  // boundaries refuse it as a backstop.
  const hostRole = resolveEnsembleHostRoleV1();
  const viewerHost = hostRole === "viewer";
  void vscode.commands.executeCommand("setContext", "vs-code-ai-helper.hostRole", hostRole);
  console.log(`Ensemble host role: ${hostRole}`);

  // The envelope parser recovers a complete payload followed by surplus
  // closing braces (three of four observed providers miscount them at the end
  // of a long escaped Markdown string, discarding 9-13KB of finished work over
  // one character). That tolerance must never be silent: an unreported
  // leniency would hide a genuinely new malformation behind a known one. This
  // is the production sink the parser's seam exists for — sanitized by
  // construction, since the reported value can only be whitespace and closing
  // brackets, never payload content.
  setInertTrailingObserverV1((inertTrailing) => {
    console.warn(
      "[ensemble:aiResult] recovered a payload with surplus trailing closers",
      // Real bytes, not .length: the inert set's `\s` matches Unicode
      // whitespace, whose code-unit and UTF-8 lengths differ.
      JSON.stringify({ inertTrailing, byteLength: Buffer.byteLength(inertTrailing, "utf8") })
    );
  });

  // A Copilot tool session can run up to MAX_TOOL_ROUNDS_V1 rounds emitting
  // nothing observable, which on 2026-08-17 made a working run
  // indistinguishable from a wedged one and got it cancelled. Tool NAMES and
  // byte counts only — never tool arguments or result content, which carry
  // workspace file data (§2.2).
  setLmToolSessionObserverV1((round) => {
    console.info(
      "[ensemble:toolSession] round",
      JSON.stringify({
        round: `${round.round}/${round.maxRounds}`,
        tools: round.toolNames,
        roundResultBytes: round.roundResultBytes,
        totalResultBytes: round.totalResultBytes,
      })
    );
  });

  // Workflow-6 Item 18 fix 2: the pre-request boundary. Fix 1's per-round
  // deadline (languageModelToolSessionV1.ts) already turns a hang into a
  // reported failure; this line is what lets a later investigation tell
  // "never reached the provider" (absent) from "the provider accepted the
  // request and then never answered" (present, with no round-completion or
  // timeout line following it) — the diagnosis fix 1 alone does not give.
  setLmToolSessionRequestIssuedObserverV1((event) => {
    console.info(
      "[ensemble:toolSession] sendRequest issued",
      JSON.stringify({ round: `${event.round}/${event.maxRounds}` })
    );
  });

  // Item 3b-2 (2026-08-17..19 workflow-defects batch): a sanitized read-
  // session transcript — tool name plus target path only, never content —
  // logged live as each call happens rather than batched at session end, so
  // a session that later hits a pre-response transport failure (a billing
  // limit, a dropped connection) still leaves a record of what it read
  // instead of nothing at all.
  setReadToolCallObserverV1((event) => {
    console.info(
      "[ensemble:toolSession] read",
      JSON.stringify({
        tool: event.tool,
        relativePath: event.relativePath,
        ...(event.startLine !== undefined ? { startLine: event.startLine } : {}),
        ...(event.endLine !== undefined ? { endLine: event.endLine } : {}),
      })
    );
  });

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
  // A viewer's chat and tree read the RUNNER's pending decisions
  // (hostDecisionMirrorV1.ts); every other workspaceState key stays its own.
  const viewerDecisions = viewerHost
    ? createMirroredDecisionsMementoV1(context.workspaceState, WORKFLOW_DECISIONS_STORAGE_KEY_V1)
    : undefined;
  const decisionsState = viewerDecisions?.memento ?? context.workspaceState;
  // Decisions raised by code running HERE must reach the same store the views
  // read, or the panel and tree never learn about them (the change signal is
  // keyed by Memento identity).
  configureWorkflowDecisionStateV1(decisionsState);
  const chatViewProvider = new ChatViewProvider(decisionsState);
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
  // v1 fixes item 1 (Part 1a): work admission's race-safe per-install host
  // identity (hostIdentityV1.ts) is wired from the same per-install,
  // per-profile directory as the workflow private-storage root above — never
  // task-scoped, so it is stable across every window/task this install ever
  // touches. `vscode.env.machineId` is also passed through: it is VS Code's
  // own globally-unique per-machine id, and hostIdentityV1's persistent-
  // failure fallback needs it to tell apart two machines that could otherwise
  // report an identical `globalStorageUri.fsPath` (e.g. containers built from
  // the same image) — see that module's `deterministicFallbackHostIdV1` doc
  // comment (2026-09-08 review, third pass).
  configureHostIdentityRootV1(context.globalStorageUri.fsPath, vscode.env.machineId);
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
  const runnerInteractionServices: ChatInteractionServicesV1 = {
    submitAnswers: async (ref, rawAnswers, answerIdempotencyId) => {
      const submitted = await chatConversationOrchestrator.submitAnswers(ref, rawAnswers, answerIdempotencyId);
      return submitted.ok ? { ok: true } : { ok: false, reason: submitted.reason };
    },
    cancel: async (ref) => runChatConversationAction(() => chatConversationOrchestrator.cancel(ref)),
    // Chat With AI hides (never deletes) the conversation of a task whose
    // lifecycle status is completed/archived — resolved live from the shared
    // inventory so resume/reopen surfaces the history again immediately.
    getTaskStatus: (canonicalId) => inventory.getTaskById(canonicalId)?.progress.status,
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
    resume: async (ref, resumeIdempotencyId, admissionHandoffTokenV1) => {
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
            context,
            inventory,
            currentTaskStore,
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
          //
          // `admissionHandoffTokenV1` (2026-09-09 review completion blocker):
          // forwarded from chatView.ts's resumeInteraction, which acquired
          // durable work admission for this task before ITS OWN first
          // await — i.e. before the `loadInteraction` call just above too.
          // Threading it through lets this handler adopt that SAME marker
          // instead of racing its own genesis, closing the setup-phase
          // watchdog-pause race across the whole chatView.ts → extension.ts →
          // handler boundary, not just inside the handler itself.
          return await resumeEditPreflightInteractionV1(
            inventory,
            chatViewProvider,
            ref,
            actionKey,
            resumeIdempotencyId,
            cancellation.token,
            admissionHandoffTokenV1
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
  };

  // ── Cloud runner/viewer relay (hostRelayV1.ts) ─────────────────────────
  // Both hosts share the workspace's task root, so `.ensemble/relay-v1/` is
  // the queue: a viewer's Answer/Cancel/Resume and "Run on Runner…" become
  // request files the runner claims and executes.
  // Viewer: the actions a user starts from a tree button or keybinding are
  // refused by the route gate; this is how they start them on the runner.
  // Every entry takes a `{ taskFolderPath, canonicalId }` argument and shows
  // no modal a runner could not answer (Commit and Push confirms with one, so
  // it is not here).
  const RUN_ON_RUNNER_ACTIONS_V1: ReadonlyArray<{ readonly label: string; readonly command: string }> = [
    { label: "Draft with AI", command: "vs-code-ai-helper.draftTaskWithAI" },
    { label: "Generate Plan with AI", command: "vs-code-ai-helper.generatePlanWithAI" },
    { label: "Apply Current Stage Action", command: "vs-code-ai-helper.applyCurrentStageAction" },
    { label: "Review Current Task", command: "vs-code-ai-helper.reviewCurrentTask" },
    { label: "Fast-Forward Review", command: "vs-code-ai-helper.fastForwardCurrentTaskReview" },
    { label: "Run Implementation with AI", command: "vs-code-ai-helper.runImplementationWithAI" },
    { label: "Next Stage", command: "vs-code-ai-helper.nextStage" },
    { label: "Run Publish Checks", command: "vs-code-ai-helper.runPublishChecks" },
  ];
  /**
   * What a relayed action is called when a viewer reports on it. Every id in
   * `RELAYABLE_COMMAND_IDS_V1` needs one: without it the progress toast read
   * "Running on the runner: vs-code-ai-helper.renameTaskWithAI" (review,
   * 2026-09-17). The picker above is the subset a user can start by hand.
   */
  const RELAYED_ACTION_LABELS_V1: Readonly<Record<string, string>> = {
    ...Object.fromEntries(RUN_ON_RUNNER_ACTIONS_V1.map((action) => [action.command, action.label])),
    "vs-code-ai-helper.generateImplementationWithAI": "Generate Implementation with AI",
    "vs-code-ai-helper.runReviewWithAI": "Run Review with AI",
    "vs-code-ai-helper.applyReviewWithAI": "Apply Review with AI",
    "vs-code-ai-helper.applyReviewEditWithAI": "Apply Review Edit with AI",
    "vs-code-ai-helper.fastForwardReviewWithAI": "Fast-Forward Review",
    "vs-code-ai-helper.applyHighLevelReviewChanges": "Apply High-Level Review Changes",
    "vs-code-ai-helper.applyLowLevelReviewChanges": "Apply Low-Level Review Changes",
    "vs-code-ai-helper.runLintingFixes": "Fix Linting & Code Errors",
    "vs-code-ai-helper.renameTaskWithAI": "Rename Task with AI",
    "vs-code-ai-helper.chatWithStage": "Chat reply",
  };
  const RELAYED_ACTION_TIMEOUT_MS_V1 = 30 * 60 * 1000;
  const relayRoot = resolveTaskRootCandidates()[0]?.absolutePath;
  const relayDirPath = relayRoot !== undefined ? path.join(relayRoot, HOST_RELAY_DIRNAME_V1) : undefined;
  const hostRelay =
    relayRoot !== undefined ? createHostRelayV1({ dir: path.join(relayRoot, HOST_RELAY_DIRNAME_V1) }) : undefined;
  const relayUnavailable = { ok: false as const, reason: "no workspace folder — nothing to relay to the runner" };
  /**
   * Why the runner cannot be sent work right now, or undefined when it is
   * reporting normally. The runner heartbeats its operations snapshot even
   * while idle, so this is a liveness check: without it, pressing an action
   * in a viewer while the runner's VS Code was down showed "Running on the
   * runner: …" for the full 30-minute relay wait before failing (review,
   * 2026-09-17).
   */
  async function describeRunnerNotReportingV1(): Promise<string | undefined> {
    if (relayDirPath === undefined) {
      return relayUnavailable.reason;
    }
    const snapshot = await readRunnerOperationsSnapshotV1(relayDirPath);
    if (isRunnerReportingV1(snapshot, Date.now())) {
      return undefined;
    }
    return snapshot === undefined
      ? "the runner has never reported here — is the runner VS Code running on the box?"
      : `the runner has not reported for ${Math.round((Date.now() - snapshot.writtenAt) / 60000)} min — is the runner VS Code running on the box?`;
  }
  async function relayInteraction<T extends { readonly ok: boolean }>(
    request: Omit<Extract<HostRelayRequestV1, { kind: "interaction" }>, "id" | "createdAt" | "kind" | "timeoutMs">,
    timeoutMs: number
  ): Promise<T | typeof relayUnavailable | { readonly ok: false; readonly reason: string }> {
    if (hostRelay === undefined) {
      return relayUnavailable;
    }
    try {
      const response = await hostRelay.send({ kind: "interaction", ...request }, { timeoutMs });
      if (!response.ok) {
        return { ok: false, reason: response.reason ?? "the runner refused the request" };
      }
      return response.result as T;
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }
  const viewerInteractionServices: ChatInteractionServicesV1 = {
    submitAnswers: (ref, rawAnswers, answerIdempotencyId) =>
      relayInteraction<ChatInteractionServiceResultV1>(
        { op: "submitAnswers", ref, rawAnswers, idempotencyId: answerIdempotencyId },
        5 * 60 * 1000
      ),
    cancel: (ref) =>
      relayInteraction<ChatInteractionServiceResultV1>(
        { op: "cancel", ref, idempotencyId: allocateHostRelayIdV1() },
        5 * 60 * 1000
      ),
    // A Resume runs the whole continuation (an edit-preflight resume runs the
    // edit session): the wait is as long as a relayed action's.
    resume: (ref, resumeIdempotencyId) =>
      relayInteraction<ChatInteractionResumeResultV1>(
        { op: "resume", ref, idempotencyId: resumeIdempotencyId },
        RELAYED_ACTION_TIMEOUT_MS_V1
      ),
    getTaskStatus: (canonicalId) => inventory.getTaskById(canonicalId)?.progress.status,
    validateSend: (target, text) =>
      runnerInteractionServices.validateSend?.(target, text) ?? Promise.resolve({ ok: true }),
    // The decision is the runner's: it resolves it and runs the chosen
    // option's effect there, exactly as a click on the runner would — except
    // for effects that belong where the user is, which come back to be run
    // here (VIEWER_DECISION_EFFECT_COMMANDS_V1).
    resolveWorkflowDecision: async (decisionId, optionId) => {
      if (hostRelay === undefined) {
        NotificationRouter.showWarning(relayUnavailable.reason);
        return { ok: false, message: relayUnavailable.reason };
      }
      const notReporting = await describeRunnerNotReportingV1();
      if (notReporting !== undefined) {
        NotificationRouter.showWarning(`Your answer was not sent: ${notReporting}`);
        return { ok: false, message: notReporting };
      }
      try {
        const response = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "Sending your decision to the runner…" },
          () =>
            hostRelay.send(
              { kind: "resolveDecision", decisionId, optionId },
              { timeoutMs: RELAYED_ACTION_TIMEOUT_MS_V1 }
            )
        );
        if (!response.ok) {
          const reason = response.reason ?? "unknown reason";
          NotificationRouter.showWarning(`The runner could not apply your decision: ${reason}`);
          return { ok: false, message: reason };
        }
        // The runner hands back an effect that belongs in this window.
        const outcome = (response.result ?? {}) as {
          ok?: boolean;
          message?: string;
          viewerEffect?: { command: string; args?: readonly unknown[] };
        };
        if (outcome.ok === false && outcome.message) {
          NotificationRouter.showWarning(`The runner could not apply your decision: ${outcome.message}`);
        }
        return {
          ok: outcome.ok !== false,
          ...(outcome.message ? { message: outcome.message } : {}),
          ...(outcome.viewerEffect ? { viewerEffect: outcome.viewerEffect } : {}),
        };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        NotificationRouter.showWarning(`Could not reach the runner: ${reason}`);
        return { ok: false, message: reason };
      }
    },
  };
  if (viewerHost && viewerDecisions !== undefined) {
    // A decision this window raised itself is still answered here; only the
    // runner's mirrored ones are relayed (hostDecisionMirrorV1.ts).
    chatViewProvider.configureRemoteDecisionPredicateV1((decisionId) => viewerDecisions.isMirrored(decisionId));
  }
  chatViewProvider.setInteractionServices(viewerHost ? viewerInteractionServices : runnerInteractionServices);

  if (hostRole === "runner" && hostRelay !== undefined && relayRoot !== undefined) {
    const relayedResume = async (
      request: Extract<HostRelayRequestV1, { kind: "interaction" }>
    ): Promise<ChatInteractionResumeResultV1> => {
      // What chatView.resumeInteraction does around a standalone Resume, done
      // HERE because the viewer skipped it: admission for the task before any
      // provider work (the watchdog and scheduled fires must see it), a
      // single-use handoff token for the handler, and the mirror settled by
      // the host that ran the continuation — so it is settled even when the
      // viewer's wait for the answer times out.
      const task = inventory.getTaskByBindingId(request.ref.taskBindingId);
      if (task === undefined) {
        return { ok: false, reason: "the runner does not know this task" };
      }
      const admission = await acquireWorkAdmissionV1({
        taskFolderPath: task.taskFolderPath,
        purpose: "admission",
        commandId: "relayResumeInteractionV1",
      });
      if (admission.outcome !== "acquired") {
        return { ok: false, reason: describeWorkAdmissionRefusalV1(admission) };
      }
      const heartbeat = setInterval(() => void admission.handle.heartbeat(), WORK_ADMISSION_HEARTBEAT_INTERVAL_MS_V1);
      const handoffToken = authorizeWorkAdmissionHandoffV1(task.taskFolderPath);
      try {
        const result = await runnerInteractionServices.resume!(request.ref, request.idempotencyId, handoffToken);
        if (result.ok) {
          await settleChatInteraction(task.taskFolderPath, task.canonicalId, request.ref.interactionId, result.settlement);
        }
        return result;
      } finally {
        revokeWorkAdmissionHandoffV1(task.taskFolderPath);
        clearInterval(heartbeat);
        await admission.handle.release();
      }
    };
    const runRelayed = async (request: HostRelayRequestV1): Promise<unknown> => {
      const deadlineMs = request.timeoutMs ?? RELAYED_ACTION_TIMEOUT_MS_V1;
      const work = (async (): Promise<unknown> => {
        if (request.kind === "interaction") {
          if (request.op === "submitAnswers") {
            return runnerInteractionServices.submitAnswers(request.ref, request.rawAnswers, request.idempotencyId);
          }
          if (request.op === "cancel") {
            return runnerInteractionServices.cancel(request.ref);
          }
          return relayedResume(request);
        }
        if (request.kind === "resolveDecision") {
          if (typeof request.decisionId !== "string" || typeof request.optionId !== "string") {
            throw new Error("the decision request is malformed");
          }
          return runUnattendedV1(() =>
            chatViewProvider.resolveWorkflowDecisionForRelayV1(request.decisionId, request.optionId)
          );
        }
        if (request.kind === "cancelOperation") {
          // A viewer's Stop button on a row it mirrors from this runner. The
          // activation must be ours: operation ids restart at op-1 every time
          // this extension host starts, so a Stop pressed on a row a viewer
          // read from a PREVIOUS runner would otherwise cancel whatever that
          // id names now (review, 2026-09-17).
          // An absent activation means the viewer read a snapshot from a build
          // that did not publish one; only a MISMATCH is a stale row.
          if (request.activationId !== undefined && request.activationId !== runnerActivationIdV1) {
            throw new Error("that operation belonged to an earlier run of the runner — reload the window to refresh what it is doing");
          }
          if (!taskOperations.cancelOperation(request.operationId)) {
            throw new Error("the operation can no longer be cancelled (it may have just finished)");
          }
          return undefined;
        }
        // Only the actions a viewer offers may be relayed: anything that can
        // write the relay directory (a CLI coding agent running in this
        // workspace, say) must not get arbitrary command execution here.
        if (!RELAYABLE_COMMAND_IDS_V1.has(request.command)) {
          throw new Error(`"${request.command}" cannot be run through the relay`);
        }
        // The task comes with the request, both as this host's current task
        // and as the command's own argument — a bare invocation of most of
        // these commands opens a task picker nobody here can answer.
        const taskFolderPath = request.taskFolderPath !== undefined ? normalizePath(request.taskFolderPath) : undefined;
        if (taskFolderPath !== undefined) {
          await currentTaskStore.set(taskFolderPath);
        }
        // Only the fields a relayed command is DEFINED to carry cross the
        // boundary, decoded one by one (review, 2026-09-17): spreading the
        // request's argument let a relay writer set internal fields the
        // commands trust for provenance — `automationDispatch: true` alone
        // turns an Implementation run into an automatic advance-and-apply.
        // Everything else about the invocation comes from the request's own
        // validated task path.
        const relayedArg = decodeRelayedCommandArgV1(request.command, request.args?.[0]);
        const taskArg =
          taskFolderPath !== undefined ? { ...relayedArg, taskFolderPath, canonicalId: taskFolderPath } : undefined;
        const result: unknown = await runUnattendedV1(async () =>
          vscode.commands.executeCommand(request.command, taskArg)
        );
        if (result === false) {
          throw new Error("the runner declined the action (see the Notifications view)");
        }
        // A chat send reports its refusals by notification and returns normally,
        // so "did the user's message reach chat-v1.json" is the only honest
        // success signal (consumeSendAcceptedV1). Without this the viewer
        // reported a refused send as sent and dropped the typed text
        // (verification review, 2026-09-17).
        if (request.command === "vs-code-ai-helper.chatWithStage" && typeof relayedArg.message === "string") {
          if (taskFolderPath === undefined || !consumeSendAcceptedV1(taskFolderPath, relayedArg.message)) {
            throw new Error("the runner did not accept the message (see the Notifications view for why)");
          }
        }
        return result;
      })();
      // A command that stalls on a prompt nobody can answer must not hold the
      // viewer, or this relay lane, forever.
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("the runner did not finish within the wait; it may still be running")), deadlineMs);
      });
      try {
        return await Promise.race([work, timeout]);
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }
    };
    /**
     * Sweeps are NOT serialized against each other (verification review,
     * 2026-09-17). A sweep lasts as long as the work it claimed — a relayed
     * Implementation round can run for half an hour — and decisions are
     * normally raised DURING such a round, so holding the next sweep behind it
     * meant the answer to the question the round was waiting on sat unclaimed
     * until the relay gave up and told the user the runner was down. Claims
     * are exclusive file creates (hostRelayV1.ts), so concurrent sweeps cannot
     * double-run a request; each simply picks up whatever is still unclaimed.
     */
    const drainRelay = (): void => {
      void hostRelay
        .drain(runRelayed)
        .catch((error: unknown) => console.error("Ensemble runner relay failed", error));
    };
    const relayWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(relayRoot, `${HOST_RELAY_DIRNAME_V1}/req-*.json`)
    );
    relayWatcher.onDidCreate(drainRelay);
    // The watcher can miss a create (or the request can predate this
    // activation): a periodic sweep is the safety net.
    const relayTimer = setInterval(drainRelay, 10 * 1000);
    context.subscriptions.push(relayWatcher, { dispose: () => clearInterval(relayTimer) });
    drainRelay();
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("vs-code-ai-helper.runOnRunner", async () => {
      if (!viewerHost) {
        NotificationRouter.showInformation("This window runs the workflow itself — actions run here directly.");
        return;
      }
      const currentTaskCanonicalId = currentTaskStore.get();
      if (currentTaskCanonicalId === undefined) {
        NotificationRouter.showWarning("Select a task first — the action runs on the runner for the current task.");
        return;
      }
      const picked = await vscode.window.showQuickPick(
        RUN_ON_RUNNER_ACTIONS_V1.map((action) => ({ label: action.label, command: action.command })),
        { placeHolder: "Run on the runner for the current task" }
      );
      if (picked === undefined) {
        return;
      }
      await forwardCommandToRunner(picked.command, currentTaskCanonicalId);
    })
  );

  /**
   * A viewer's action buttons, tree rows and shortcuts land here
   * (viewerForwardingV1.ts): the same action, for the same task, on the
   * runner. Never rejects — a rejection from a command handler is what
   * produced VS Code's raw "Error running command" toast.
   */
  async function forwardCommandToRunner(
    commandId: string,
    taskFolderPath: string | undefined,
    commandArg?: Readonly<Record<string, unknown>>
  ): Promise<ViewerForwardResultV1> {
    const task = taskFolderPath ?? currentTaskStore.get();
    const label = RELAYED_ACTION_LABELS_V1[commandId] ?? commandId;
    if (hostRelay === undefined) {
      NotificationRouter.showWarning("No workspace folder is open — there is no runner to send this to.");
      return { ok: false };
    }
    if (task === undefined) {
      NotificationRouter.showWarning("Select a task first — the action runs on the runner for that task.");
      return { ok: false };
    }
    // Do not claim to be running something on a runner that is not there.
    const notReporting = await describeRunnerNotReportingV1();
    if (notReporting !== undefined) {
      NotificationRouter.showWarning(`${label} was not started: ${notReporting}`);
      return { ok: false };
    }
    try {
      const response = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Running on the runner: ${label}` },
        () =>
          hostRelay.send(
            {
              kind: "command",
              command: commandId,
              taskFolderPath: task,
              ...(commandArg !== undefined ? { args: [commandArg] } : {}),
            },
            { timeoutMs: RELAYED_ACTION_TIMEOUT_MS_V1 }
          )
      );
      if (!response.ok) {
        NotificationRouter.showWarning(`The runner could not run ${label}: ${response.reason ?? "unknown reason"}`);
        return { ok: false };
      }
      return { ok: true };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      NotificationRouter.showWarning(`${label}: could not reach the runner — ${reason}`);
      // "took this but has not finished" means the work may still be running:
      // the caller must not offer it back as if nothing happened.
      return { ok: false, indeterminate: /has not finished/.test(reason) };
    }
  }
  configureViewerCommandForwarderV1(viewerHost ? forwardCommandToRunner : undefined);

  // Chat documents are written by the OTHER host too (the runner posting a
  // question a viewer must show, a viewer's answer the runner must see): the
  // in-process change emitter does not cover that, a file watcher does.
  const chatWatcher = vscode.workspace.createFileSystemWatcher(`**/${CHAT_HISTORY_FILENAME}`);
  const onChatFileChange = (uri: vscode.Uri): void => {
    const taskFolderPath = normalizePath(path.dirname(uri.fsPath));
    notifyChatHistoryChangedExternallyV1(taskFolderPath, taskFolderPath);
  };
  chatWatcher.onDidCreate(onChatFileChange);
  chatWatcher.onDidChange(onChatFileChange);
  context.subscriptions.push(chatWatcher);

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
  const taskTreeProvider = new TaskTreeProvider(inventory, currentTaskStore, decisionsState);
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
  // Cloud runner/viewer split (hostNotificationMirrorV1.ts): the runner also
  // appends every notification to the shared mirror file, and a viewer shows
  // those entries in its own Notifications view — otherwise a forwarded
  // action the runner refused looked like it silently did nothing.
  const relayDir = relayDirPath;
  if (hostRole === "runner" && relayDir !== undefined) {
    initNotificationRouter({
      addEntry: (message, level, filePath, resultTargetUri, sourceOperationId, actionCommand) => {
        statusTreeProvider.addEntry(message, level, filePath, resultTargetUri, sourceOperationId, actionCommand);
        void appendMirroredNotificationV1(relayDir, {
          at: new Date().toISOString(),
          level,
          message,
          ...(filePath !== undefined ? { filePath } : {}),
          ...(resultTargetUri !== undefined ? { resultTargetUri } : {}),
          ...(actionCommand !== undefined ? { actionCommand } : {}),
        });
      },
    });
  } else {
    initNotificationRouter(statusTreeProvider);
  }
  if (viewerHost && relayDir !== undefined) {
    void createNotificationMirrorTailV1(relayDir, (entries) => {
      for (const entry of entries) {
        statusTreeProvider.addEntry(
          `Runner: ${entry.message}`,
          entry.level,
          entry.filePath,
          entry.resultTargetUri,
          undefined,
          entry.actionCommand !== undefined
            ? { ...entry.actionCommand, args: entry.actionCommand.args !== undefined ? [...entry.actionCommand.args] : undefined }
            : undefined
        );
      }
      // A warning or error from the runner is what the user is waiting to
      // hear about: bring the Notifications view forward for it.
      if (entries.some((entry) => entry.level !== "info")) {
        void vscode.commands.executeCommand(`${STATUS_VIEW_ID}.focus`);
      }
    }).then((tail) => {
      const mirrorWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(relayDir, HOST_NOTIFICATION_MIRROR_FILENAME_V1)
      );
      mirrorWatcher.onDidCreate(() => void tail.poll());
      mirrorWatcher.onDidChange(() => void tail.poll());
      const mirrorTimer = setInterval(() => void tail.poll(), 5 * 1000);
      context.subscriptions.push(mirrorWatcher, { dispose: () => clearInterval(mirrorTimer) });
    });
  }
  const statusTreeView = vscode.window.createTreeView(STATUS_VIEW_ID, {
    treeDataProvider: statusTreeProvider,
    showCollapseAll: false,
  });
  void vscode.commands.executeCommand("setContext", "vs-code-ai-helper.statusViewInitialized", true);

  // --- End of view-provider registrations; the rest of activation (settings
  // migrations, startup recovery, and command registration) can now run
  // without risking the "no data provider" window above.

  // Onboarding: the tasksView welcome content links to AI Models until at
  // least one stage has a configured model. getModelSettings() already
  // resolves ensemble.*-over-legacy precedence and folds in the older
  // primary-only setting, so a single read here is enough.
  const refreshModelsConfiguredContext = (): void => {
    const anyModelConfigured = Object.values(getModelSettings()).some((entry) => !!entry?.primary);
    void vscode.commands.executeCommand(
      "setContext",
      "vs-code-ai-helper.modelsConfigured",
      anyModelConfigured
    );
  };
  refreshModelsConfiguredContext();
  const modelsConfiguredListener = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("ensemble") || event.affectsConfiguration("vs-code-ai-helper")) {
      refreshModelsConfiguredContext();
    }
  });
  context.subscriptions.push(modelsConfiguredListener);

  // Closes the "editor save lands mid-write" vector on
  // writeTextFileIfUnchangedV1 (fileUtils.ts) — review-flagged 2026-08-25,
  // task-fixable blocker `739cfbbb-…-1`. While a conditional write is
  // in-flight for a uri, a concurrent editor save for the SAME uri now
  // defers until the write resolves instead of racing it. A no-op for every
  // document without an in-flight conditional write.
  context.subscriptions.push(registerConditionalWriteSaveGuardV1());

  // Scope migration must resolve before the provider migration, which
  // inspects enabledProviders' post-migration state to decide whether it
  // still needs to run.
  void migrateSettingsNamespace(context)
    .then(() => migrateSettingsScope())
    .catch(error => console.error("Settings scope migration failed", error))
    .then(() => migrateEnabledProvidersForExistingModels())
    .catch(error => console.error("Provider settings migration failed", error))
    .then(() => refreshModelsConfiguredContext());
  if (!viewerHost) {
    context.subscriptions.push(installAutoImplementConfirmation(context));
  }
  // Recover interrupted operations before commands become available. They are
  // retained for reconciliation rather than silently discarded.
  const pendingOperations = new PendingOperationsStore(context.workspaceState);
  for (const operation of pendingOperations.recoverable()) {
    void pendingOperations.update(operation.id, "needs-reconciliation");
  }

  // A `WorkflowDecisionV1` posted by `awaitWorkflowDecisionAnswerV1` (task
  // "Actionable Hand-offs" review, architectural blocker) can only ever be
  // settled by the in-process `Promise` that posted it. If this activation
  // is a restart (window reload, crash, update) that happened while one was
  // still pending, that promise — and the round it was gating — is gone;
  // left alone the record would keep presenting as an answerable gate for
  // work that no longer exists. This is `await`ed (not fire-and-forget) so
  // it genuinely runs before commands become available: `activate` is
  // `async`, and VS Code does not treat the extension as activated — or
  // dispatch any command against it — until the promise this function
  // returns has settled, which only happens once every statement below,
  // including this one, has completed. This mirrors the cancellation-time
  // dismiss the helper itself does for the in-session case.
  await dismissOrphanedAwaitedDecisionsV1(context.workspaceState).catch((err) =>
    console.error("Orphaned workflow-decision sweep failed", err)
  );

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
    // A viewer repairs nothing: the sweeps below mutate task state the
    // runner owns. It still runs the read-only classification (last line).
    if (!viewerHost) {
      void cleanupOrphanedTempFiles(rootPaths);
    }
    // Plan §4.1 startup step 1 ("Resume verified Safe Delete
    // journals/tombstones"), ahead of step 4's classification below: a
    // deletion journal stuck at `folderRemoved` (crash between physically
    // removing the folder and recording `externalStateResolved`) is
    // invisible to `TaskCreationStartupReconcilerV1`'s own scan, which only
    // walks folders that still exist.
    const mutatingRoots = viewerHost ? [] : rootPaths;
    const strandedDeletionSweeps = mutatingRoots.map((root) =>
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
    const finalizationRecoveries = mutatingRoots.map((root) =>
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
    const checkpointRecoveries = mutatingRoots.map((root) =>
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
  registerOpenRetainedPromptCommand(context);
  registerOpenPlanNonGoalsCommand(context);
  registerDraftTaskWithAICommand(context, inventory, chatViewProvider);
  registerApplyCurrentStageActionCommand(context, inventory, currentTaskStore);
  registerGoToReviewAndApplyCommandV1(context);
  registerRetryReviewWithBackupCommandV1(context);
  registerOpenAndStartNewTaskCommand(context, inventory, currentTaskStore);
  registerReviewCurrentTaskCommand(context, inventory, currentTaskStore);
  registerFastForwardCurrentTaskReviewCommand(context, inventory, currentTaskStore);
  registerRecoverLastAiResponseCommand(context);
  registerPauseTaskCommand(context, inventory, currentTaskStore);
  registerArchiveTaskCommands(context, inventory, currentTaskStore);
  registerPinTaskCommands(context, inventory);
  registerReconcilePlanChecklistCommands(context, inventory, currentTaskStore);
  registerApplyReviewerVerifiedTicksCommands(context, inventory, currentTaskStore);
  registerPlanRevisionCommandsV1(context, inventory, currentTaskStore);
  registerTaskCreationRecoveryCommands(context, inventory, currentTaskStore);
  registerApplyHighLevelReviewChangesCommand(context, inventory);
  registerApplyLowLevelReviewChangesCommand(context, inventory);
  registerCommitAndPushTaskCommand(context, inventory, currentTaskStore, chatViewProvider);
  registerMetaResourcesMigrationCommand(context, inventory, currentTaskStore);
  registerChoosePublishScopeCommand(context, inventory);
  registerChatWithStageCommand(context, inventory, chatViewProvider, currentTaskStore);
  registerRunLintingFixesCommand(context, inventory, chatViewProvider);
  registerRunPublishChecksCommand(context, inventory, currentTaskStore);
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
  // The single "Review decision in Chat" action a pending WorkflowDecisionV1's
  // announcing notification (notifyPendingWorkflowDecision) and a task-tree
  // pending-decision affordance both route through: open Chat With AI on the
  // decision's task/stage, where the explained choice itself renders. Never
  // the decision surface itself — see chatView.ts's module header.
  context.subscriptions.push(
    vscode.commands.registerCommand("vs-code-ai-helper.openWorkflowDecision", (target: ChatTarget) =>
      chatViewProvider.open(target)
    )
  );
  // The task-tree "Review Pending Decision" affordance (taskTreeProvider.ts
  // PART 3): VS Code invokes a view/item/context command with the TreeItem
  // itself as its argument, not a ChatTarget, so this wrapper derives the
  // target from the TaskNode's task and its most-recently-posted pending
  // decision (`TaskNode.pendingDecision`) — routed to that decision's own
  // stage, since decisions render stage-scoped in Chat With AI.
  context.subscriptions.push(
    vscode.commands.registerCommand("vs-code-ai-helper.viewPendingTaskDecision", (node?: TaskNode) => {
      const decision = node?.pendingDecision;
      if (!node || !decision) return;
      const target: ChatTarget = {
        canonicalId: node.task.canonicalId ?? node.task.folderUri.fsPath,
        taskFolderPath: node.task.folderUri.fsPath,
        stage: decision.stage,
        taskName: node.task.progress.displayName,
      };
      return chatViewProvider.open(target);
    })
  );

  // ── Rounds that stopped without saying so (abandonedOperationReaperV1.ts) ──
  // A provider that exits without unwinding its round leaves an operation the
  // whole UI keeps reporting as running — for seven hours, on 2026-09-17, with
  // Stop unable to clear it. A viewer runs no work, so it reaps nothing; it
  // sees the runner's own reaping through the operations mirror.
  if (!viewerHost) {
    const reapAbandonedOperations = (): void => {
      for (const abandoned of findAbandonedOperationsV1(taskOperations.getAll(), (taskPath) =>
        workAdmissionRenewalAgeMsV1(taskPath)
      )) {
        if (taskOperations.endAbandonedOperation(abandoned.id)) {
          NotificationRouter.showWarning(describeAbandonedOperationV1(abandoned));
        }
      }
    };
    const reaperTimer = setInterval(reapAbandonedOperations, 2 * 60 * 1000);
    context.subscriptions.push({ dispose: () => clearInterval(reaperTimer) });
  }

  const progressBinder = new ViewProgressBinder(taskOperations);
  context.subscriptions.push(progressBinder);

  // ── Runner activity, visible in viewers (hostOperationsMirrorV1.ts) ─────
  if (hostRole === "runner" && relayDir !== undefined) {
    let writeTimer: NodeJS.Timeout | undefined;
    const writeSnapshot = (): void => {
      writeTimer = undefined;
      const operations = taskOperations
        .getAll()
        .filter((op) => op.state === "running")
        .filter((op) => !taskOperations.isMirroredOperation(op.id))
        .map((op) => ({
          id: op.id,
          key: op.key,
          label: op.label,
          taskName: op.taskName,
          startedAt: op.startedAt,
          waitingForUser: op.waitingForUser,
          exclusive: op.exclusive,
          cancellable: op.cancellable,
          ...(op.parentId !== undefined ? { parentId: op.parentId } : {}),
          ...(op.stage !== undefined ? { stage: op.stage } : {}),
          ...(op.kind !== undefined ? { kind: op.kind } : {}),
          ...(op.detail !== undefined ? { detail: op.detail } : {}),
          ...(op.modelId !== undefined ? { modelId: op.modelId } : {}),
          ...(op.activity !== undefined ? { activity: op.activity } : {}),
          ...(op.activityStartedAt !== undefined ? { activityStartedAt: op.activityStartedAt } : {}),
          ...(op.resultTargetUri !== undefined ? { resultTargetUri: op.resultTargetUri } : {}),
        }));
      void writeRunnerOperationsSnapshotV1(relayDir, {
        writtenAt: Date.now(),
        operations,
        activationId: runnerActivationIdV1,
      });
    };
    // Debounced: activity reports can arrive many times a second.
    const scheduleSnapshot = (): void => {
      if (writeTimer === undefined) {
        writeTimer = setTimeout(writeSnapshot, 500);
      }
    };
    // Pending decisions, for viewers (hostDecisionMirrorV1.ts). Re-written on
    // the heartbeat too: an in-process orphan mark changes what is pending
    // without a store write.
    const decisionStore = new WorkflowDecisionStoreV1(context.workspaceState);
    let lastDecisionsSignature: string | undefined;
    const writeDecisions = (): void => {
      const pending = decisionStore.listPending();
      const signature = JSON.stringify(pending);
      // The signature is only remembered once the write actually LANDED, and
      // a heartbeat rewrites it regardless, so a failed or superseded write
      // cannot leave a viewer showing a settled question forever (review,
      // 2026-09-17). Writes are serialized in hostMirrorWriteV1.ts.
      void writeRunnerDecisionsSnapshotV1(relayDir, pending).then((written) => {
        if (written) {
          lastDecisionsSignature = signature;
        }
      });
    };
    const writeDecisionsIfChanged = (): void => {
      if (JSON.stringify(decisionStore.listPending()) !== lastDecisionsSignature) {
        writeDecisions();
      }
    };
    const decisionsListener = decisionStore.onDidChange(writeDecisionsIfChanged);
    // Unconditional on the heartbeat: it also refreshes `writtenAt`, which is
    // how a viewer knows these decisions are still answerable at all.
    const decisionsHeartbeat = setInterval(writeDecisions, RUNNER_OPERATIONS_HEARTBEAT_MS_V1);
    writeDecisions();
    context.subscriptions.push(decisionsListener, { dispose: () => clearInterval(decisionsHeartbeat) });
    const operationsListener = taskOperations.onDidChange(scheduleSnapshot);
    // The heartbeat is what lets a viewer tell "still running" from "the
    // runner stopped writing".
    const heartbeat = setInterval(writeSnapshot, RUNNER_OPERATIONS_HEARTBEAT_MS_V1);
    writeSnapshot();
    context.subscriptions.push(operationsListener, {
      dispose: () => {
        clearInterval(heartbeat);
        if (writeTimer !== undefined) {
          clearTimeout(writeTimer);
        }
        // A clean shutdown publishes "nothing is running" so viewers stop
        // showing this runner's work as live for the whole stale window — and
        // names whatever was still running, because an empty snapshot with a
        // fresh timestamp otherwise reads exactly like the work completing.
        const abandoned = taskOperations
          .getAll()
          .filter((op) => op.parentId === undefined && op.state === "running" && !taskOperations.isMirroredOperation(op.id))
          .map((op) => ({ label: op.label, taskName: op.taskName }));
        void writeRunnerOperationsSnapshotV1(relayDir, {
          writtenAt: Date.now(),
          operations: [],
          activationId: runnerActivationIdV1,
          ...(abandoned.length > 0 ? { stoppedWhileRunning: abandoned } : {}),
        });
      },
    });
  }
  if (viewerHost && relayDir !== undefined) {
    // The runner's operations go into this window's own registry, so the
    // stage-row spinners, the Notifications rows, the progress bar and the
    // badges all render them exactly as they render a local run.
    let runnerActivationSeenV1: string | undefined;
    taskOperations.configureMirroredOperationCancel((operationId) => {
      void hostRelay
        ?.send(
          { kind: "cancelOperation", operationId, ...(runnerActivationSeenV1 ? { activationId: runnerActivationSeenV1 } : {}) },
          { timeoutMs: 60 * 1000 }
        )
        .then((response) => {
          if (!response.ok) {
            NotificationRouter.showWarning(`The runner could not cancel the operation: ${response.reason ?? "unknown reason"}`);
          }
        })
        .catch((error: unknown) => {
          NotificationRouter.showWarning(
            `Could not reach the runner: ${error instanceof Error ? error.message : String(error)}`
          );
        });
    });
    const runnerStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    runnerStatus.command = `${STATUS_VIEW_ID}.focus`;
    let mirroredRootsShownV1: readonly { label: string; taskName: string }[] = [];
    let lastAbandonedWarnedAtV1: number | undefined;
    const refreshRunnerStatus = async (): Promise<void> => {
      const snapshot = await readRunnerOperationsSnapshotV1(relayDir);
      const now = Date.now();
      runnerActivationSeenV1 = snapshot?.activationId;
      const live = liveMirroredOperationsV1(snapshot, now);
      // The runner going silent mid-work must not look like the work
      // finishing: dropping the rows is visually identical to a clean
      // completion, which had users going to look for output that was never
      // produced (review, 2026-09-17). Say it once, per root that vanished.
      const abandoned =
        snapshot?.stoppedWhileRunning !== undefined && snapshot.writtenAt !== lastAbandonedWarnedAtV1
          ? snapshot.stoppedWhileRunning
          : undefined;
      if (abandoned !== undefined) {
        // The runner said so itself as it stopped (a reload, a restart).
        lastAbandonedWarnedAtV1 = snapshot!.writtenAt;
        for (const root of abandoned) {
          NotificationRouter.showWarning(
            `${root.label} — "${root.taskName}": the runner stopped while this was running, so its outcome is unknown. Check the runner VS Code on the box.`
          );
        }
      } else if (live.length === 0 && mirroredRootsShownV1.length > 0 && !isRunnerReportingV1(snapshot, now)) {
        // It went silent without saying anything (crash, container rebuild).
        for (const root of mirroredRootsShownV1) {
          NotificationRouter.showWarning(
            `${root.label} — "${root.taskName}": the runner stopped reporting while this was running, so its outcome is unknown. Check the runner VS Code on the box.`
          );
        }
      }
      mirroredRootsShownV1 = live
        .filter((op) => op.parentId === undefined)
        .map((op) => ({ label: op.label, taskName: op.taskName }));
      taskOperations.setMirroredOperations(
        live.map((op) => ({
          ...op,
          stage: op.stage as TaskStage | undefined,
          kind: op.kind as OperationKind | undefined,
          exclusive: op.exclusive ?? op.parentId === undefined,
          cancellable: op.cancellable ?? false,
          state: "running" as const,
        }))
      );
      // Only what the registry cannot say: the runner went silent.
      const view = describeRunnerActivityV1(snapshot, now);
      if (view.kind === "stale") {
        runnerStatus.text = "$(warning) Runner not responding";
        runnerStatus.tooltip = `The runner stopped reporting ${Math.round(view.sinceMs / 60000)} min ago while work was listed as running. Is the runner VS Code on the box up?`;
        runnerStatus.show();
      } else {
        runnerStatus.hide();
      }
    };
    const operationsWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(relayDir, HOST_OPERATIONS_MIRROR_FILENAME_V1)
    );
    operationsWatcher.onDidCreate(() => void refreshRunnerStatus());
    operationsWatcher.onDidChange(() => void refreshRunnerStatus());
    const refreshRunnerDecisions = async (): Promise<void> => {
      const snapshot = await readRunnerDecisionsSnapshotV1(relayDir, (stage) =>
        Object.prototype.hasOwnProperty.call(STAGE_DISPLAY_NAMES, stage)
      );
      // A decision is only answerable while the runner is there to take the
      // answer, so a stale snapshot shows nothing rather than a card that
      // waits out the relay timeout when pressed.
      const live = liveMirroredDecisionsV1(snapshot, Date.now(), RUNNER_OPERATIONS_STALE_MS_V1);
      if (viewerDecisions?.setDecisions(live)) {
        notifyWorkflowDecisionsChangedV1(decisionsState);
      }
    };
    const decisionsWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(relayDir, HOST_DECISIONS_MIRROR_FILENAME_V1)
    );
    decisionsWatcher.onDidCreate(() => void refreshRunnerDecisions());
    decisionsWatcher.onDidChange(() => void refreshRunnerDecisions());
    context.subscriptions.push(decisionsWatcher);
    const operationsTimer = setInterval(() => {
      void refreshRunnerStatus();
      void refreshRunnerDecisions();
    }, 10 * 1000);
    void refreshRunnerStatus();
    void refreshRunnerDecisions();
    context.subscriptions.push(runnerStatus, operationsWatcher, {
      dispose: () => {
        clearInterval(operationsTimer);
        taskOperations.setMirroredOperations([]);
        taskOperations.configureMirroredOperationCancel(undefined);
      },
    });
  }

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
    // A full filesystem rescan (added/removed/modified task folders and
    // files), not just a tree repaint: inventory.refresh() re-runs
    // discoverAllTasks() and fires onDidChange, which the tree already
    // subscribes to (taskTreeProvider.ts's constructor), so no separate
    // taskTreeProvider.refresh() call is needed here. Never touches
    // taskOperations, so a running implementation/review/publish is
    // untouched.
    () => inventory.refresh()
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
  // A viewer only re-reads: arming schedules here would let it claim
  // scheduled-run leases and dispatch owed continuations the runner owns.
  const armSchedulesUnlessViewer = async (): Promise<void> => {
    if (!viewerHost) {
      await taskActionScheduler.armAll();
    }
  };
  const onProgressChange = (): void => {
    void startupGateReady.then(() => inventory.refresh()).then(async () => {
      await armSchedulesUnlessViewer();
      taskTreeProvider.refresh();
    });
  };
  progressWatcher.onDidCreate(onProgressChange);
  progressWatcher.onDidChange(onProgressChange);
  progressWatcher.onDidDelete(onProgressChange);

  // A crashed window can leave a lease behind. Periodically retrying the
  // persisted schedules lets this window claim an expired lease even when no
  // task-progress file change happens after the crash.
  const schedulerRecoveryTimer = viewerHost
    ? undefined
    : setInterval(() => {
        void taskActionScheduler.armAll();
      }, 5 * 60 * 1000);

  // Refresh when the meta resources folder setting changes. Also gated on
  // startupGateReady — see onProgressChange above for why.
  const configListener = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("vs-code-ai-helper.metaResourcesPath")) {
      void startupGateReady.then(() => inventory.refresh()).then(async () => {
        await armSchedulesUnlessViewer();
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
    { dispose: () => { if (schedulerRecoveryTimer !== undefined) clearInterval(schedulerRecoveryTimer); } },
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
    await armSchedulesUnlessViewer();
    taskTreeProvider.refresh();
    if (viewerHost) {
      return;
    }
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
  if (viewerHost) {
    // Nothing below runs AI, but the revert-journal prompt repairs artifacts
    // the runner owns and the model-cache warm-up probes every CLI: neither
    // belongs in a window that only watches.
    console.log(`Ensemble viewer: ${VIEWER_HOST_REFUSAL_MESSAGE_V1}`);
    return;
  }
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
