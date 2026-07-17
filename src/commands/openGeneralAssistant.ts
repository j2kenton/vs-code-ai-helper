import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { ChatViewProvider } from "../views/chatView";
import { RUNS_DIRNAME } from "../types/taskProgress";
import { resolveTaskRootForCreation } from "../utils/taskRoot";
import { resolveFreshModelForStage } from "../utils/modelSelection";
import {
  checkRunnerAvailabilityForModel,
  resolveRunnerForModel,
} from "../runners/runnerRegistry";
import { ensureAiConsent } from "../utils/aiConsent";
import { checkAndConfirmPromptSize } from "../utils/promptSizeGuard";
import { runTrackedOperation } from "../utils/taskOperations";
import {
  executeProposedAction,
  GLOBAL_ASSISTANT_OPERATIONS,
  parseProposedAction,
  stripActionEnvelopes,
} from "../utils/globalAssistantActions";
import { PendingOperationsStore } from "../state/pendingOperationsStore";

/** Stable identity for the global assistant's own, fully separate history. */
export const GLOBAL_ASSISTANT_CANONICAL_ID = "global-assistant";
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

export async function openGeneralAssistant(
  chatViewProvider: ChatViewProvider
): Promise<void> {
  const folder = await resolveGlobalAssistantFolder();
  if (!folder) {
    void vscode.window.showWarningMessage(
      "Open a workspace folder before opening the Global Assistant."
    );
    return;
  }
  await chatViewProvider.open({
    canonicalId: GLOBAL_ASSISTANT_CANONICAL_ID,
    taskFolderPath: folder.fsPath,
    stage: "desc",
    taskName: "Global Assistant",
    kind: "global",
  });
}

/** Exported for testing: the prompt names only registry operations. */
export function buildGlobalAssistantPrompt(
  taskSummary: string,
  conversation: string,
  message: string
): string {
  const operations = GLOBAL_ASSISTANT_OPERATIONS.map(
    (op) => `- ${op.id}: ${op.description}`
  ).join("\n");
  return (
    "You are the Ensemble Global Assistant: a task-section-level assistant for cross-task questions and actions. " +
    "You are not attached to any single task or stage.\n\n" +
    "You may propose at most one action per response, chosen ONLY from this registry (anything else is rejected without executing):\n" +
    `${operations}\n\n` +
    'To propose an action, include exactly one envelope of the form [[ACTION:<operationId> <json payload>]] (omit the payload when the operation takes none). ' +
    "The user confirms consequential actions before they run. Never claim an action has already been performed.\n\n" +
    `Current tasks in this workspace:\n${taskSummary}\n\n` +
    `Conversation so far:\n${conversation.slice(-12000)}\n\n` +
    `User message:\n${message}`
  );
}

async function globalAssistantSend(
  context: vscode.ExtensionContext,
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore,
  chatViewProvider: ChatViewProvider,
  arg?: { message?: string }
): Promise<void> {
  const message = arg?.message?.trim();
  if (!message) {
    return;
  }
  const folder = await resolveGlobalAssistantFolder();
  if (!folder) {
    void vscode.window.showWarningMessage(
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
          void vscode.window.showWarningMessage(
            "The Global Assistant uses the model configured for the Task Description stage, and none is set. Configure one in AI Models."
          );
          void vscode.commands.executeCommand("vs-code-ai-helper.openAiModels");
          return;
        }
        const { runner, nativeModelId } = resolveRunnerForModel(modelId, "desc", folder);
        const { availability, providerLabel } = await checkRunnerAvailabilityForModel(modelId, "desc");
        if (!availability.available) {
          throw new Error(availability.reason ?? `${providerLabel} is unavailable.`);
        }

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
          await chatViewProvider.transcript(identity.taskFolderPath, identity.canonicalId)
        )
          .slice(-20)
          .map((entry) => `${entry.role.toUpperCase()}: ${entry.text}`)
          .join("\n");
        const prompt = buildGlobalAssistantPrompt(taskSummary, conversation, message);
        const sizeCheck = await checkAndConfirmPromptSize(prompt, providerLabel);
        if (sizeCheck === "abort" || sizeCheck === "declined") {
          return;
        }

        const runsUri = vscode.Uri.joinPath(folder, RUNS_DIRNAME);
        await vscode.workspace.fs.createDirectory(runsUri);
        const outputFile = vscode.Uri.joinPath(runsUri, `chat-${Date.now()}.md`);
        const result = await runner.run(
          {
            taskFolderUri: folder,
            workspaceUri: workspaceFolder.uri,
            stage: "desc",
            prompt,
            outputFile,
            modelId: nativeModelId,
          },
          op.token!
        );
        if (result.status === "cancelled") {
          await chatViewProvider.append("assistant", "Global Assistant request was cancelled.", "desc", identity);
          return;
        }
        if (result.status !== "completed") {
          throw new Error(result.errorMessage ?? "The Global Assistant did not respond.");
        }
        const rawResponse = new TextDecoder()
          .decode(await vscode.workspace.fs.readFile(outputFile))
          .trim();
        const displayed = stripActionEnvelopes(rawResponse);
        if (displayed) {
          await chatViewProvider.append("assistant", displayed, "desc", identity);
        }
        const proposal = parseProposedAction(rawResponse);
        if (proposal) {
          const outcome = await executeProposedAction(
            {
              inventory,
              currentTaskStore,
              assistantFolderUri: folder,
              pendingOperations: new PendingOperationsStore(context.workspaceState),
            },
            proposal
          );
          await chatViewProvider.append("assistant", outcome, "desc", identity);
        } else if (!displayed) {
          await chatViewProvider.append("assistant", "The Global Assistant did not return an answer.", "desc", identity);
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
  currentTaskStore: CurrentTaskStore,
  chatViewProvider: ChatViewProvider
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("vs-code-ai-helper.openGeneralAssistant", () =>
      openGeneralAssistant(chatViewProvider)
    ),
    vscode.commands.registerCommand(
      "vs-code-ai-helper.globalAssistantSend",
      (arg?: { message?: string }) =>
        globalAssistantSend(context, inventory, currentTaskStore, chatViewProvider, arg)
    )
  );
}
