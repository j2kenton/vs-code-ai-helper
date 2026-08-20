/**
 * `chatSend.v1` registry row (plan §6.5, "Migrate remaining text actions").
 *
 * Target: task-local Chat (`<task-folder>/chat-v1.json`).
 * Completed-content type: `chat-message.v1`.
 * Provider mode: `text`.
 */
import * as path from "path";
import {
  ProviderTaskActionRowV1,
  TaskActionExecutionContextV1,
  TaskActionInputValidationResultV1,
  TaskActionPromotionCodeV1,
} from "../taskActionRegistryV1";
import { maxResponseBytesCeilingForModeV1 } from "../../types/agentExecutionV1";
import { CompletedContentV1 } from "../../types/aiResultEnvelope";

import { readChatHistory, writeChatHistory, describeWorkflowStoreFailureV1 } from "../../utils/chatHistoryStore";
import { TaskStage } from "../../types/taskProgress";
import {
  FileUpdateEnvelope,
  planFileUpdate,
  splitFileUpdateEnvelopes,
} from "../../utils/chatFileUpdateEnvelope";
import {
  ensureWorkflowTaskFolderRootV1,
  getWorkflowFileStoreV1,
} from "../../services/workflowRuntimeServicesV1";
import { WorkflowFileLocatorV1 } from "../../services/workflowFileStoreV1";

export const CHAT_SEND_ACTION_KEY_V1 = "chatSend.v1";

export interface ChatSendActionInputV1 {
  readonly prompt: string;
  readonly taskFolderPath?: string;
  readonly canonicalId?: string;
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
  if (raw.taskFolderPath !== undefined && !isNonEmptyString(raw.taskFolderPath)) {
    return { ok: false, reason: "input \"taskFolderPath\" must be a non-empty string when present" };
  }
  if (raw.canonicalId !== undefined && !isNonEmptyString(raw.canonicalId)) {
    return { ok: false, reason: "input \"canonicalId\" must be a non-empty string when present" };
  }
  const allowedKeys = new Set(["prompt", "taskFolderPath", "canonicalId"]);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, reason: `input has an unknown field: ${key}` };
    }
  }
  const validated: ChatSendActionInputV1 = {
    prompt: raw.prompt,
    ...(raw.taskFolderPath !== undefined ? { taskFolderPath: raw.taskFolderPath } : {}),
    ...(raw.canonicalId !== undefined ? { canonicalId: raw.canonicalId } : {}),
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

/**
 * Applies the C4 chat-edit envelope (item 21, 2026-08-17..19 workflow-defects
 * batch): a response may propose the full replacement content of exactly one
 * markdown file inside this task's own folder. Returns an italic outcome
 * note to append to the displayed reply — file written, or why it was
 * refused — or `undefined` when the response carried no envelope at all.
 * Never throws: a write failure is a soft, chat-visible refusal, not a
 * promotion error, since the assistant's own text answer is still valid on
 * its own regardless of whether the file update landed.
 */
async function applyChatFileUpdateEnvelopesV1(
  taskFolderPath: string,
  updates: readonly FileUpdateEnvelope[]
): Promise<string | undefined> {
  const plan = planFileUpdate(taskFolderPath, updates);
  if (plan.action === "none") return undefined;
  if (plan.action === "reject") return plan.note;

  const rootId = ensureWorkflowTaskFolderRootV1(taskFolderPath);
  const relativePath = path.relative(taskFolderPath, plan.targetPath).split(path.sep).join("/");
  const locator: WorkflowFileLocatorV1 = { rootId, relativePath };
  const fileStore = getWorkflowFileStoreV1();
  const bytes = Buffer.from(plan.content, "utf8");

  const stat = await fileStore.stat(locator);
  if (stat.kind !== "ok") {
    return `_Could not update \`${plan.relPath}\`: ${describeWorkflowStoreFailureV1(stat)}._`;
  }
  if (stat.value.kind === "directory") {
    return `_Could not update \`${plan.relPath}\`: the target is a directory, not a file._`;
  }
  const result =
    stat.value.kind === "file" && stat.value.revision !== undefined
      ? await fileStore.replaceFileExact(locator, bytes, stat.value.revision)
      : await fileStore.createFileExclusive(locator, bytes);
  if (result.kind !== "ok") {
    return `_Could not update \`${plan.relPath}\`: ${describeWorkflowStoreFailureV1(result)}._`;
  }
  return `_Updated \`${plan.relPath}\`._`;
}

async function promoteChatSendContentV1(
  content: CompletedContentV1,
  context: TaskActionExecutionContextV1
): Promise<TaskActionPromotionCodeV1> {
  if (!isChatMessageV1(content)) {
    throw new ChatSendPromotionErrorV1("chatSend.v1 received a non-chat-message completed content");
  }
  const input = context.validatedInput as ChatSendActionInputV1;
  // The envelope must never survive into the displayed/persisted text,
  // whether or not it is applied — strip it unconditionally before anything
  // else touches content.text.
  const { text: strippedText, updates } = splitFileUpdateEnvelopes(content.text);
  if (input.taskFolderPath) {
    let finalText = strippedText;
    const outcomeNote = await applyChatFileUpdateEnvelopesV1(input.taskFolderPath, updates);
    if (outcomeNote) {
      finalText = finalText.length > 0 ? `${finalText}\n\n${outcomeNote}` : outcomeNote;
    }
    const canonicalId = input.canonicalId ?? input.taskFolderPath;
    const history = await readChatHistory(input.taskFolderPath, canonicalId);
    history.push({
      role: "assistant",
      text: finalText,
      stage: (context.stage as TaskStage) ?? "desc",
      at: new Date().toISOString(),
    });
    await writeChatHistory(input.taskFolderPath, history, canonicalId);
  }
  return "completed";
}

export function createChatSendRowV1(): ProviderTaskActionRowV1 {
  return {
    kind: "provider",
    actionKey: CHAT_SEND_ACTION_KEY_V1,
    routes: ["vs-code-ai-helper.chatWithStage"],
    eligibility: { statuses: ["active", "paused"], stages: "anyStage" },
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
