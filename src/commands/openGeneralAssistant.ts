import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { ChatViewProvider } from "../views/chatView";
import { resolveTaskRootForCreation } from "../utils/taskRoot";
import { resolveFreshModelForStage } from "../utils/modelSelection";
import { checkRunnerAvailabilityForModel } from "../runners/runnerRegistry";
import { ensureAiConsent } from "../utils/aiConsent";
import { checkAndConfirmPromptSize } from "../utils/promptSizeGuard";
import { runTrackedOperation } from "../utils/taskOperations";
import { GLOBAL_ASSISTANT_OPERATIONS } from "../utils/globalAssistantActions";
import { NotificationRouter } from "../utils/notificationRouter";
import { assertLegacyAiRouteAllowedV0 } from "../services/legacyAiActionSafetyGateV0";
import { ensureWorkflowNonTaskStorageRootV1 } from "../services/workflowRuntimeServicesV1";
import {
  GLOBAL_ASSISTANT_CANONICAL_ID,
  localTaskBindingId,
  readChatDocumentIdentityV1,
} from "../utils/chatHistoryStore";
import { allocateHex128IdV1 } from "../types/actionCorrelationV1";
import {
  admitAndContinueWithMalformedResultRetryV1,
  createProductionTaskActionCoordinatorV1,
} from "../actions/productionTaskActionRuntimeV1";
import {
  GLOBAL_ASSISTANT_SEND_ACTION_KEY_V1,
  GlobalAssistantSendActionInputV1,
  validateGlobalAssistantSendInputV1,
} from "../actions/rows/globalAssistantSendRowV1";

export { GLOBAL_ASSISTANT_CANONICAL_ID };
const GLOBAL_ASSISTANT_DIRNAME = "global-assistant";

/**
 * The global assistant is scoped to the task section, not to any task or
 * stage: it answers cross-task questions and may perform authorized
 * task-section-level actions through the allowlisted operation registry in
 * globalAssistantActions.ts. Its chat history lives in its own dedicated
 * folder under the task root — never inside any task — and it uses the AI
 * model currently configured for the Task Description stage (surfaced in
 * the chat label).
 */
async function resolveGlobalAssistantFolder(): Promise<vscode.Uri | undefined> {
  try {
    const root = await resolveTaskRootForCreation();
    const folder = vscode.Uri.joinPath(vscode.Uri.file(root), GLOBAL_ASSISTANT_DIRNAME);
    await vscode.workspace.fs.createDirectory(folder);
    return folder;
  } catch {
    return undefined;
  }
}

/**
 * The chat target describing the global assistant, or undefined when no
 * workspace folder is open yet. Also used by the Chat With AI panel as its
 * default target when the user hasn't picked a stage conversation.
 */
export async function resolveGlobalAssistantTarget(): Promise<
  | {
      canonicalId: string;
      taskFolderPath: string;
      stage: "desc";
      taskName: string;
      kind: "global";
    }
  | undefined
> {
  const folder = await resolveGlobalAssistantFolder();
  if (!folder) {
    return undefined;
  }
  return {
    canonicalId: GLOBAL_ASSISTANT_CANONICAL_ID,
    taskFolderPath: folder.fsPath,
    stage: "desc",
    taskName: "Global Assistant",
    kind: "global",
  };
}

/**
 * Opening the assistant always (re)selects the global conversation — even if
 * the user was previously chatting with a stage — and reveals the chat panel.
 */
export async function openGeneralAssistant(
  chatViewProvider: ChatViewProvider
): Promise<void> {
  const target = await resolveGlobalAssistantTarget();
  if (!target) {
    NotificationRouter.showWarning(
      "Open a workspace folder before opening the Global Assistant."
    );
    return;
  }
  await chatViewProvider.open(target);
}

/** Chat never invokes tools or edits code — the runner is the same text-only
 * planning/review runner used to answer questions (CLI providers run in
 * `mode: "text"`, native edit permissions withheld). The response may
 * propose at most one allowlisted cross-task operation (see
 * GLOBAL_ASSISTANT_OPERATIONS) via `[[ACTION:<id> <json payload>]]`; the
 * proposal is executed through the shared typed action executor
 * (executeProposedAction), so the confirmation gate, state-accurate outcome
 * verification, and audit logging are identical regardless of which UI
 * surface triggered it — the model never executes anything itself, and
 * unlisted ids are rejected. */
export function buildGlobalAssistantPrompt(
  taskSummary: string,
  conversation: string,
  message: string
): string {
  const operations = GLOBAL_ASSISTANT_OPERATIONS.map(
    (op) => `- ${op.id}: ${op.description}`
  ).join("\n");
  return (
    "You are the Ensemble Global Assistant: the workspace-level assistant for the Ensemble task manager. " +
    "You help with anything about the user's tasks — answering questions about them, and performing task-lifecycle " +
    "actions on one task, several tasks, or all of them (creating tasks, completing them, pausing/resuming, " +
    "archiving and unarchiving, pinning, repairing stuck state).\n\n" +
    "Be proactive and useful: when the user asks for something an operation below can do, propose that operation " +
    "rather than saying you cannot help. When they ask for something outside the registry (for example editing code, " +
    "or running a specific stage's AI action), explain the closest thing you CAN do and which button in the Tasks " +
    "panel covers the rest.\n\n" +
    "You may propose at most one action per response, chosen ONLY from this registry (anything else is rejected without executing):\n" +
    `${operations}\n\n` +
    'To propose an action, include exactly one envelope of the form [[ACTION:<operationId> <json payload>]] (omit the payload when the operation takes none). ' +
    "The user confirms consequential actions before they run. Never claim an action has already been performed. " +
    "For a request that spans several tasks with no bulk operation available, propose the action for the first task and say you'll continue with the rest one at a time.\n\n" +
    `Current tasks in this workspace:\n${taskSummary}\n\n` +
    `Conversation so far:\n${conversation.slice(-12000)}\n\n` +
    `User message:\n${message}`
  );
}

/**
 * Send a message to the global assistant. Reaches a provider through
 * `globalAssistantSend.v1`'s coordinator row (globalAssistantSendRowV1.ts)
 * — the same V1-correlated runner boundary every other AI action uses —
 * rather than a direct `resolveRunnerForModel(...).runner.run(...)` call:
 * the shared boundary (`assertNoUnauthorizedV1CorrelationV0` in
 * runnerRegistry.ts) unconditionally rejects an uncorrelated invocation, so
 * the assistant needs a real `actionKey` to reach a model at all. The
 * coordinator also gives it primary→backup model fallback for free, using
 * the Task Description stage's configured backups (via
 * `resolveStagePrimaryModel`) — the same stage its primary model is borrowed
 * from (see its chat label).
 */
async function globalAssistantSend(
  context: vscode.ExtensionContext,
  inventory: TaskInventory,
  chatViewProvider: ChatViewProvider,
  arg?: { message?: string }
): Promise<void> {
  assertLegacyAiRouteAllowedV0("globalAssistantSend.v1");
  const message = arg?.message?.trim();
  if (!message) {
    return;
  }
  const folder = await resolveGlobalAssistantFolder();
  if (!folder) {
    NotificationRouter.showWarning(
      "Open a workspace folder before using the Global Assistant."
    );
    return;
  }
  const identity = {
    canonicalId: GLOBAL_ASSISTANT_CANONICAL_ID,
    taskFolderPath: folder.fsPath,
  };
  if (!(await ensureAiConsent(context))) {
    return;
  }

  try {
    await runTrackedOperation(
      folder.fsPath,
      {
        label: "Global Assistant",
        taskName: "Global Assistant",
        exclusive: false,
        kind: "chat-send",
        cancellable: true,
      },
      async (op) => {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
          throw new Error("No workspace folder is open.");
        }
        // The global assistant uses the model currently configured for the
        // Task Description stage (as stated in its chat label).
        const { modelId } = await resolveFreshModelForStage(folder, "desc");
        if (!modelId) {
          NotificationRouter.showWarning(
            "The Global Assistant uses the model configured for the Task Description stage, and none is set. Configure one in AI Models."
          );
          void vscode.commands.executeCommand("vs-code-ai-helper.openAiModels");
          return;
        }
        const { availability: available, providerLabel } = await checkRunnerAvailabilityForModel(
          modelId,
          "desc"
        );
        if (!available.available) throw new Error(available.reason ?? `${providerLabel} is unavailable.`);

        // Registration side-effect matters (the file store resolves against
        // it); the non-task root carries no ownership binding to read back —
        // its coordinator binding is the same local digest stand-in
        // chatHistoryStore.ts already uses as this conversation's default.
        ensureWorkflowNonTaskStorageRootV1(folder.fsPath);
        const taskBindingId = localTaskBindingId(GLOBAL_ASSISTANT_CANONICAL_ID);
        const chatIdentity = await readChatDocumentIdentityV1(folder.fsPath, GLOBAL_ASSISTANT_CANONICAL_ID);
        const chatDocumentId = chatIdentity?.documentId ?? allocateHex128IdV1();

        const tasks = inventory.getTasks();
        const taskSummary =
          tasks.length === 0
            ? "(no tasks)"
            : tasks
                .map(
                  (t) =>
                    `- ${t.progress.displayName ?? t.folderName} (folder: ${t.folderName}; status: ${t.progress.status ?? "active"}; stage: ${t.progress.currentStage})`
                )
                .join("\n");
        const conversation = (
          await chatViewProvider.transcript(identity.taskFolderPath, identity.canonicalId, "desc")
        )
          .slice(-20)
          .map((entry) => `${entry.role.toUpperCase()}: ${entry.text}`)
          .join("\n");
        const prompt = buildGlobalAssistantPrompt(taskSummary, conversation, message);
        const sizeCheck = await checkAndConfirmPromptSize(prompt, providerLabel);
        if (sizeCheck === "abort" || sizeCheck === "declined") {
          return;
        }

        const validatedInput: GlobalAssistantSendActionInputV1 = {
          prompt,
          taskFolderPath: folder.fsPath,
          canonicalId: GLOBAL_ASSISTANT_CANONICAL_ID,
        };
        const inputValidation = validateGlobalAssistantSendInputV1(validatedInput);
        if (!inputValidation.ok) {
          NotificationRouter.showError(`Unable to send: ${inputValidation.reason}`);
          return;
        }

        const coordinator = createProductionTaskActionCoordinatorV1({
          workspaceCwd: workspaceFolder.uri.fsPath,
          resolveStagePrimaryModel: () => ({ modelId, stage: "desc" }),
        });

        // Unlike chatSend.v1, the user's message is already persisted by the
        // time this command runs — chatView.ts's Send handler appends it
        // itself for the "global" target before dispatching here (the
        // global assistant has no task/stage-existence precondition to
        // validate first, unlike chatWithStage's append-after-validation
        // ordering) — so there is no preInvocationHook to persist it here.
        // No caller-owned side effect between admission and continuation
        // means a malformed provider response can be retried via
        // admitAndContinueWithMalformedResultRetryV1 with nothing to guard.
        const outcome = await admitAndContinueWithMalformedResultRetryV1(coordinator, {
          actionKey: GLOBAL_ASSISTANT_SEND_ACTION_KEY_V1,
          taskBinding: { taskBindingId, chatDocumentId },
          taskStatus: "active",
          taskStage: "desc",
          rawInput: validatedInput,
          cancellationToken: op.token!,
        });

        if (outcome.kind === "completed") {
          // Completed content has already been written to chat-v1.json by
          // globalAssistantSendRowV1.ts's promoteCompletedContent. Refresh
          // the chat view's transcript.
          await chatViewProvider.open({
            canonicalId: GLOBAL_ASSISTANT_CANONICAL_ID,
            taskFolderPath: folder.fsPath,
            stage: "desc",
            taskName: "Global Assistant",
            kind: "global",
          });
        } else if (outcome.kind === "cancelled") {
          await chatViewProvider.append("assistant", "Global Assistant request was cancelled.", "desc", identity);
        } else {
          const code = "code" in outcome ? outcome.code : outcome.kind;
          await chatViewProvider.append("assistant", `Unable to respond: ${code}`, "desc", identity);
        }
      }
    );
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    await chatViewProvider.append("assistant", `Unable to respond: ${text}`, "desc", identity);
  }
}

export function registerOpenGeneralAssistantCommand(
  context: vscode.ExtensionContext,
  inventory: TaskInventory,
  chatViewProvider: ChatViewProvider
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("vs-code-ai-helper.openGeneralAssistant", () =>
      openGeneralAssistant(chatViewProvider)
    ),
    vscode.commands.registerCommand(
      "vs-code-ai-helper.globalAssistantSend",
      (arg?: { message?: string }) => globalAssistantSend(context, inventory, chatViewProvider, arg)
    )
  );
}
