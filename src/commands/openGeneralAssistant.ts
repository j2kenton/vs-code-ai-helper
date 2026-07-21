import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { ChatViewProvider } from "../views/chatView";
import { RUNS_DIRNAME } from "../types/taskProgress";
import { AgentRunResult } from "../types/agentRunner";
import { resolveTaskRootForCreation } from "../utils/taskRoot";
import { resolveFreshModelForStage } from "../utils/modelSelection";
import {
  getConfiguredBackupModelsForStage,
  isAuthenticationFailure,
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
import { stripAttributionHeaders } from "../utils/fileUtils";
import { NotificationRouter } from "../utils/notificationRouter";

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
 * Run the global assistant's prompt against its primary model, falling
 * through the user's configured backup models on quota/temporary-
 * unavailability failures — mirroring stage-specific calls.
 *
 * Stage-specific runs get this fallback for free from
 * `resolveRunnerForModel(modelId, stage, taskFolderUri)`: its wrapped
 * runner reserves the switch-over in `taskFolderUri`'s `task-progress.json`
 * (see `reserveFallback` in runnerRegistry.ts) before trying any backup.
 * The global assistant's folder is not a task and has no
 * `task-progress.json`, so that reservation write silently no-ops
 * (`patchTaskProgress` returns undefined when there's nothing to read) and
 * the wrapped runner's fallback branch never runs — every quota failure on
 * the primary model surfaced directly as a hard failure, with configured
 * backups never attempted. Walk the candidate chain explicitly instead,
 * resolving each candidate with `resolveRunnerForModel(candidate, undefined,
 * folder)` (no `stage` argument, so no nested reservation-gated wrapping) —
 * the same pattern `runSecondOpinionReview` in reviewActions.ts already
 * uses for backup iteration outside the normal stage-reservation flow.
 *
 * Backup list choice: the global assistant isn't tied to a particular
 * stage, but it already borrows the Task Description stage's primary model
 * (see its chat label) — so its backups are taken from that same stage's
 * configuration via `getConfiguredBackupModelsForStage("desc", ...)`, not
 * gated on that stage's fallback *strategy* (a user who chose
 * "pause-and-resume" or "alert-and-wait" for Task Description still has
 * models configured and available; only the automatic quota-switch opt-in
 * is stage-specific, and the global assistant was never wired into that
 * per-stage opt-in to begin with). This choice can be revisited if a
 * different backup source is wanted.
 */
async function runGlobalAssistantWithFallback(
  folder: vscode.Uri,
  workspaceUri: vscode.Uri,
  primaryModelId: string,
  prompt: string,
  runsUri: vscode.Uri,
  token: vscode.CancellationToken
): Promise<{ result: AgentRunResult; outputFile?: vscode.Uri; providerLabel: string }> {
  const candidateModelIds = [
    primaryModelId,
    ...getConfiguredBackupModelsForStage("desc", primaryModelId),
  ];

  let lastResult: AgentRunResult = {
    runnerId: "none",
    status: "failed",
    failureKind: "generic",
    errorMessage: "No model is configured for the Global Assistant.",
  };
  let lastProviderLabel = "";

  for (const candidateModelId of candidateModelIds) {
    let resolved: ReturnType<typeof resolveRunnerForModel>;
    try {
      resolved = resolveRunnerForModel(candidateModelId, undefined, folder);
    } catch {
      continue;
    }
    lastProviderLabel = resolved.providerLabel;

    let availability: Awaited<ReturnType<typeof resolved.runner.isAvailable>>;
    try {
      availability = await resolved.runner.isAvailable();
    } catch {
      continue;
    }
    const authFailure = isAuthenticationFailure(availability.reason);
    if (!availability.available && !authFailure) {
      lastResult = {
        runnerId: resolved.runner.id,
        status: "failed",
        failureKind: "temporarily-unavailable",
        errorMessage: availability.reason ?? `${resolved.providerLabel} is unavailable.`,
      };
      continue;
    }

    const outputFile = vscode.Uri.joinPath(
      runsUri,
      `chat-${Date.now()}-${candidateModelId.replace(/[^a-z0-9]+/gi, "-")}.md`
    );
    const result = await resolved.runner.run(
      {
        taskFolderUri: folder,
        workspaceUri,
        stage: "desc",
        prompt,
        outputFile,
        modelId: resolved.nativeModelId,
      },
      token
    );
    lastResult = result;
    if (result.status === "cancelled" || result.status === "completed") {
      return { result, outputFile, providerLabel: resolved.providerLabel };
    }
    // Never spend a backup on an authentication/config failure, and stop
    // trying further candidates on any failure that isn't quota/temporary —
    // matching resolveRunnerForModel's own fallback gating.
    if (authFailure || (result.failureKind !== "quota" && result.failureKind !== "temporarily-unavailable")) {
      return { result, providerLabel: resolved.providerLabel };
    }
    // Quota/temporary failure: fall through to the next candidate.
  }

  return { result: lastResult, providerLabel: lastProviderLabel };
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
        // Provider label used only for the size-confirmation prompt text —
        // the actual model attempted (and any backup fallback) is resolved
        // fresh inside runGlobalAssistantWithFallback below.
        const { providerLabel } = resolveRunnerForModel(modelId, undefined, folder);
        const sizeCheck = await checkAndConfirmPromptSize(prompt, providerLabel);
        if (sizeCheck === "abort" || sizeCheck === "declined") {
          return;
        }

        const runsUri = vscode.Uri.joinPath(folder, RUNS_DIRNAME);
        await vscode.workspace.fs.createDirectory(runsUri);
        const { result, outputFile } = await runGlobalAssistantWithFallback(
          folder,
          workspaceFolder.uri,
          modelId,
          prompt,
          runsUri,
          op.token!
        );
        if (result.status === "cancelled") {
          await chatViewProvider.append("assistant", "Global Assistant request was cancelled.", "desc", identity);
          return;
        }
        if (result.status !== "completed" || !outputFile) {
          throw new Error(result.errorMessage ?? "The Global Assistant did not respond.");
        }
        const rawResponse = stripAttributionHeaders(
          new TextDecoder()
            .decode(await vscode.workspace.fs.readFile(outputFile))
            .trim()
        );
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
