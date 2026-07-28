/**
 * `chatSend.v1` registry row (plan §6.5, "Migrate remaining text actions").
 *
 * Target: task-local Chat (`<task-folder>/chat-v1.json`).
 * Completed-content type: `chat-message.v1`.
 * Provider mode: `text`.
 */
import {
  ProviderTaskActionRowV1,
  TaskActionExecutionContextV1,
  TaskActionInputValidationResultV1,
  TaskActionPromotionCodeV1,
} from "../taskActionRegistryV1";
import { maxResponseBytesCeilingForModeV1 } from "../../types/agentExecutionV1";
import { CompletedContentV1 } from "../../types/aiResultEnvelope";

export const CHAT_SEND_ACTION_KEY_V1 = "chatSend.v1";

export interface ChatSendActionInputV1 {
  readonly prompt: string;
}

const MAX_PROMPT_LENGTH_V1 = 8 * 1024 * 1024;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** @internal exported for testing */
export function validateChatSendInputV1(
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
  const allowedKeys = new Set(["prompt"]);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, reason: `input has an unknown field: ${key}` };
    }
  }
  const validated: ChatSendActionInputV1 = {
    prompt: raw.prompt,
  };
  return { ok: true, input: validated };
}

function isChatMessageV1(
  content: CompletedContentV1
): content is Extract<CompletedContentV1, { contentType: "chat-message.v1" }> {
  return content.contentType === "chat-message.v1";
}

class ChatSendPromotionErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatSendPromotionErrorV1";
  }
}

function promoteChatSendContentV1(
  content: CompletedContentV1,
  _context: TaskActionExecutionContextV1
): Promise<TaskActionPromotionCodeV1> {
  if (!isChatMessageV1(content)) {
    throw new ChatSendPromotionErrorV1("chatSend.v1 received a non-chat-message completed content");
  }
  // Chat message promotion is handled directly by the orchestrator/Chat store.
  return Promise.resolve("completed");
}

export function createChatSendRowV1(): ProviderTaskActionRowV1 {
  return {
    kind: "provider",
    actionKey: CHAT_SEND_ACTION_KEY_V1,
    routes: ["vs-code-ai-helper.chatWithStage"],
    eligibility: { statuses: ["active"], stages: "anyStage" },
    requiresTaskOperationLease: true,
    progressLabel: "Responding to AI…",
    validateInput: validateChatSendInputV1,
    loggingPolicy: { channel: "action.chatSend", includeResultMetrics: true },
    providerMode: "text",
    maxResponseBytes: maxResponseBytesCeilingForModeV1("text"),
    permittedResultKinds: ["completed", "questions", "cancelled", "failed"],
    completedContentType: "chat-message.v1",
    resumeSemantics: "sameOperation",
    buildPrompt: (context: TaskActionExecutionContextV1): string =>
      (context.validatedInput as ChatSendActionInputV1).prompt,
    promoteCompletedContent: promoteChatSendContentV1,
  };
}
