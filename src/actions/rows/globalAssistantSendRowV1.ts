/**
 * `globalAssistantSend.v1` registry row.
 *
 * Target: the Global Assistant's own non-task Chat folder
 * (`ensureWorkflowNonTaskStorageRootV1`), never a task folder.
 * Completed-content type: `chat-message.v1` (same shape `chatSend.v1` uses —
 * this IS a chat message, just not one scoped to a task/stage).
 * Provider mode: `text`.
 *
 * Unlike `chatSend.v1`, promotion also decodes the model's response as a
 * possible `[[ACTION:<operationId> <payload>]]` proposal (the Global
 * Assistant's allowlisted cross-task operation protocol,
 * `utils/globalAssistantActions.ts`): the envelope is stripped before the
 * answer is shown, and a recognized proposal is executed and its outcome
 * appended as a second assistant message — mirroring the pre-retirement
 * `globalAssistantSend` command, just running through the coordinator's
 * safe, V1-correlated runner boundary instead of an uncorrelated direct
 * `AgentRunner.run` call.
 */
import * as vscode from "vscode";
import {
  ProviderTaskActionRowV1,
  TaskActionExecutionContextV1,
  TaskActionInputValidationResultV1,
  TaskActionPromotionCodeV1,
} from "../taskActionRegistryV1";
import { maxResponseBytesCeilingForModeV1 } from "../../types/agentExecutionV1";
import { CompletedContentV1 } from "../../types/aiResultEnvelope";

import { appendChatMessageV1 } from "../../utils/chatHistoryStore";
import {
  executeProposedAction,
  getGlobalAssistantRuntimeDepsV1,
  parseProposedAction,
  stripActionEnvelopes,
} from "../../utils/globalAssistantActions";
import { PendingOperationsStore } from "../../state/pendingOperationsStore";

export const GLOBAL_ASSISTANT_SEND_ACTION_KEY_V1 = "globalAssistantSend.v1";

export interface GlobalAssistantSendActionInputV1 {
  readonly prompt: string;
  readonly taskFolderPath: string;
  readonly canonicalId: string;
}

const MAX_PROMPT_LENGTH_V1 = 8 * 1024 * 1024;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** @internal exported for testing */
export function validateGlobalAssistantSendInputV1(
  rawInput: unknown
): TaskActionInputValidationResultV1 {
  if (typeof rawInput !== "object" || rawInput === null) {
    return { ok: false, reason: "input is not an object" };
  }
  const raw = rawInput as Record<string, unknown>;
  if (!isNonEmptyString(raw.prompt)) {
    return { ok: false, reason: "input is missing a non-empty \"prompt\" string" };
  }
  if (Buffer.byteLength(raw.prompt, "utf8") > MAX_PROMPT_LENGTH_V1) {
    return { ok: false, reason: "input \"prompt\" exceeds the maximum length" };
  }
  if (!isNonEmptyString(raw.taskFolderPath)) {
    return { ok: false, reason: "input is missing a non-empty \"taskFolderPath\" string" };
  }
  if (!isNonEmptyString(raw.canonicalId)) {
    return { ok: false, reason: "input is missing a non-empty \"canonicalId\" string" };
  }
  const allowedKeys = new Set(["prompt", "taskFolderPath", "canonicalId"]);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, reason: `input has an unknown field: ${key}` };
    }
  }
  const validated: GlobalAssistantSendActionInputV1 = {
    prompt: raw.prompt,
    taskFolderPath: raw.taskFolderPath,
    canonicalId: raw.canonicalId,
  };
  return { ok: true, input: validated };
}

function isChatMessageV1(
  content: CompletedContentV1
): content is Extract<CompletedContentV1, { contentType: "chat-message.v1" }> {
  return content.contentType === "chat-message.v1";
}

class GlobalAssistantSendPromotionErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GlobalAssistantSendPromotionErrorV1";
  }
}

async function appendGlobalAssistantMessageV1(
  taskFolderPath: string,
  canonicalId: string,
  text: string
): Promise<void> {
  // Review-flagged (2026-08-23): a caller-computed read-then-full-write
  // (readChatHistory + writeChatHistory) silently discards any message a
  // concurrent writer appends in between. `appendChatMessageV1` re-reads and
  // appends onto the CURRENT document inside the shared per-document queue.
  await appendChatMessageV1(taskFolderPath, { role: "assistant", text, stage: "desc", at: new Date().toISOString() }, canonicalId);
}

async function promoteGlobalAssistantSendContentV1(
  content: CompletedContentV1,
  context: TaskActionExecutionContextV1
): Promise<TaskActionPromotionCodeV1> {
  if (!isChatMessageV1(content)) {
    throw new GlobalAssistantSendPromotionErrorV1(
      "globalAssistantSend.v1 received a non-chat-message completed content"
    );
  }
  const input = context.validatedInput as GlobalAssistantSendActionInputV1;
  const rawText = content.text;
  const displayed = stripActionEnvelopes(rawText);
  const proposal = parseProposedAction(rawText);

  if (displayed) {
    await appendGlobalAssistantMessageV1(input.taskFolderPath, input.canonicalId, displayed);
  }

  if (proposal) {
    const deps = getGlobalAssistantRuntimeDepsV1();
    const outcomeText = deps
      ? await executeProposedAction(
          {
            inventory: deps.inventory,
            currentTaskStore: deps.currentTaskStore,
            assistantFolderUri: vscode.Uri.file(input.taskFolderPath),
            pendingOperations: new PendingOperationsStore(deps.workspaceState),
          },
          proposal
        )
      : `_The proposed "${proposal.operationId}" action could not be executed in this context._`;
    await appendGlobalAssistantMessageV1(input.taskFolderPath, input.canonicalId, outcomeText);
  } else if (!displayed) {
    await appendGlobalAssistantMessageV1(
      input.taskFolderPath,
      input.canonicalId,
      "The Global Assistant did not return an answer."
    );
  }

  return "completed";
}

export function createGlobalAssistantSendRowV1(): ProviderTaskActionRowV1 {
  return {
    kind: "provider",
    actionKey: GLOBAL_ASSISTANT_SEND_ACTION_KEY_V1,
    routes: ["vs-code-ai-helper.globalAssistantSend"],
    eligibility: { statuses: ["active"], stages: "anyStage" },
    requiresTaskOperationLease: true,
    progressLabel: "Global Assistant thinking…",
    validateInput: validateGlobalAssistantSendInputV1,
    loggingPolicy: { channel: "action.globalAssistantSend", includeResultMetrics: true },
    providerMode: "text",
    maxResponseBytes: maxResponseBytesCeilingForModeV1("text"),
    permittedResultKinds: ["completed", "cancelled", "failed"],
    completedContentType: "chat-message.v1",
    resumeSemantics: "sameOperation",
    buildPrompt: (context: TaskActionExecutionContextV1): string =>
      (context.validatedInput as GlobalAssistantSendActionInputV1).prompt,
    promoteCompletedContent: promoteGlobalAssistantSendContentV1,
  };
}
