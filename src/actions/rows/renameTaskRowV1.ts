/**
 * `renameTask.v1` registry row.
 *
 * Completed-content type: `chat-message.v1` (the provider returns the
 * suggested display name as plain text).
 * Provider mode: `text`.
 * Resume semantics: `replacementOperation`.
 *
 * Like `commitPushMetadata.v1`, promotion writes the provider's reply to a
 * caller-supplied workflow-file-store artifact instead of applying it
 * directly: the caller (renameTaskWithAI in renameTask.ts) reads the
 * artifact back, enforces the 5–7-word contract (retrying once with a
 * stricter instruction when the reply is too long), and only then patches
 * the task's displayName.
 */
import {
  ProviderTaskActionRowV1,
  TaskActionExecutionContextV1,
  TaskActionInputValidationResultV1,
  TaskActionPromotionCodeV1,
} from "../taskActionRegistryV1";
import { maxResponseBytesCeilingForModeV1 } from "../../types/agentExecutionV1";
import { CompletedContentV1 } from "../../types/aiResultEnvelope";

import { getWorkflowFileStoreV1 } from "../../services/workflowRuntimeServicesV1";

export const RENAME_TASK_ACTION_KEY_V1 = "renameTask.v1";

export interface RenameTaskActionInputV1 {
  readonly prompt: string;
  readonly targetLocator: { readonly rootId: string; readonly relativePath: string };
}

const MAX_PROMPT_LENGTH_V1 = 8 * 1024 * 1024;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** @internal exported for testing */
export function validateRenameTaskInputV1(
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
  const locator = raw.targetLocator;
  if (
    typeof locator !== "object" ||
    locator === null ||
    !isNonEmptyString((locator as Record<string, unknown>).rootId) ||
    !isNonEmptyString((locator as Record<string, unknown>).relativePath)
  ) {
    return {
      ok: false,
      reason: "input \"targetLocator\" must be { rootId: non-empty string, relativePath: non-empty string }",
    };
  }
  const allowedKeys = new Set(["prompt", "targetLocator"]);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, reason: `input has an unknown field: ${key}` };
    }
  }
  const validated: RenameTaskActionInputV1 = {
    prompt: raw.prompt,
    targetLocator: {
      rootId: (locator as { rootId: string }).rootId,
      relativePath: (locator as { relativePath: string }).relativePath,
    },
  };
  return { ok: true, input: validated };
}

function isChatMessageV1(
  content: CompletedContentV1
): content is Extract<CompletedContentV1, { contentType: "chat-message.v1" }> {
  return content.contentType === "chat-message.v1";
}

class RenameTaskPromotionErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenameTaskPromotionErrorV1";
  }
}

async function promoteRenameTaskContentV1(
  content: CompletedContentV1,
  context: TaskActionExecutionContextV1
): Promise<TaskActionPromotionCodeV1> {
  if (!isChatMessageV1(content)) {
    throw new RenameTaskPromotionErrorV1(
      "renameTask.v1 received a non-chat-message completed content"
    );
  }
  const input = context.validatedInput as RenameTaskActionInputV1;
  const fileStore = getWorkflowFileStoreV1();
  const bytes = Buffer.from(content.text, "utf8");
  const result = await fileStore.createFileExclusive(input.targetLocator, bytes);
  if (result.kind !== "ok") {
    throw new RenameTaskPromotionErrorV1(
      `could not write rename suggestion artifact ${input.targetLocator.relativePath}: ${result.kind}${
        "code" in result ? `.${result.code}` : ""
      }`
    );
  }
  return "completed";
}

export function createRenameTaskRowV1(): ProviderTaskActionRowV1 {
  return {
    kind: "provider",
    actionKey: RENAME_TASK_ACTION_KEY_V1,
    // Invoked directly through the coordinator by the Rename Task with AI
    // command (renameTask.ts); no legacy route id exists for it, so the
    // route entry is internal-only like editExecution.v1's.
    routes: ["internal:renameTask.v1"],
    eligibility: { statuses: ["active", "paused"], stages: "anyStage" },
    // No lease: the coordinator lease is pure mutual exclusion, and this row
    // needs none of it. Promotion only exclusive-creates a caller-unique
    // runs/rename-suggestion-*.txt artifact (createFileExclusive can never
    // clobber another writer), and the displayName patch happens in the
    // caller through patchTaskProgressStrictV1, which merges onto
    // freshly-read state under its own journaled lock. Requiring the lease
    // only made Rename Task with AI refuse while any other stage's provider
    // action was running — the caller-side guard in renameTask.ts still
    // blocks it during Task Description generation, the one true conflict.
    requiresTaskOperationLease: false,
    progressLabel: "Naming task…",
    validateInput: validateRenameTaskInputV1,
    loggingPolicy: { channel: "action.renameTask", includeResultMetrics: true },
    providerMode: "text",
    maxResponseBytes: maxResponseBytesCeilingForModeV1("text"),
    permittedResultKinds: ["completed", "cancelled", "failed"],
    completedContentType: "chat-message.v1",
    resumeSemantics: "replacementOperation",
    buildPrompt: (context: TaskActionExecutionContextV1): string =>
      (context.validatedInput as RenameTaskActionInputV1).prompt,
    promoteCompletedContent: promoteRenameTaskContentV1,
  };
}
