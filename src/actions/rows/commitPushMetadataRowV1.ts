/**
 * `commitPushMetadata.v1` registry row (plan §6.5 & §10.2).
 *
 * Completed-content type: `commit-metadata.v1`.
 * Provider mode: `text`.
 * Resume semantics: `replacementOperation` (plan §3.1 / §10.2).
 */
import {
  ProviderTaskActionRowV1,
  TaskActionExecutionContextV1,
  TaskActionInputValidationResultV1,
  TaskActionPromotionCodeV1,
} from "../taskActionRegistryV1";
import { maxResponseBytesCeilingForModeV1 } from "../../types/agentExecutionV1";
import { CompletedContentV1 } from "../../types/aiResultEnvelope";

export const COMMIT_PUSH_METADATA_ACTION_KEY_V1 = "commitPushMetadata.v1";

export interface CommitPushMetadataActionInputV1 {
  readonly prompt: string;
}

const MAX_PROMPT_LENGTH_V1 = 8 * 1024 * 1024;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** @internal exported for testing */
export function validateCommitPushMetadataInputV1(
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
  const validated: CommitPushMetadataActionInputV1 = {
    prompt: raw.prompt,
  };
  return { ok: true, input: validated };
}

function isCommitMetadataV1(
  content: CompletedContentV1
): content is Extract<CompletedContentV1, { contentType: "commit-metadata.v1" }> {
  return content.contentType === "commit-metadata.v1";
}

class CommitPushMetadataPromotionErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommitPushMetadataPromotionErrorV1";
  }
}

async function promoteCommitPushMetadataContentV1(
  content: CompletedContentV1,
  _context: TaskActionExecutionContextV1
): Promise<TaskActionPromotionCodeV1> {
  if (!isCommitMetadataV1(content)) {
    throw new CommitPushMetadataPromotionErrorV1(
      "commitPushMetadata.v1 received a non-commit-metadata completed content"
    );
  }
  // Commit metadata promotion is handled by the caller/commit flow.
  return "completed";
}

export function createCommitPushMetadataRowV1(): ProviderTaskActionRowV1 {
  return {
    kind: "provider",
    actionKey: COMMIT_PUSH_METADATA_ACTION_KEY_V1,
    routes: ["vs-code-ai-helper.commitAndPushTask", "vs-code-ai-helper.completeCommitAndPushTask"],
    eligibility: { statuses: ["active"], stages: ["publish"] },
    requiresTaskOperationLease: true,
    progressLabel: "Generating commit metadata…",
    validateInput: validateCommitPushMetadataInputV1,
    loggingPolicy: { channel: "action.commitPushMetadata", includeResultMetrics: true },
    providerMode: "text",
    maxResponseBytes: maxResponseBytesCeilingForModeV1("text"),
    permittedResultKinds: ["completed", "questions", "cancelled", "failed"],
    completedContentType: "commit-metadata.v1",
    // Commit/Push metadata Resume starts a fresh linked operation because its
    // process-global token was released (plan §3.1 / §10.2).
    resumeSemantics: "replacementOperation",
    buildPrompt: (context: TaskActionExecutionContextV1): string =>
      (context.validatedInput as CommitPushMetadataActionInputV1).prompt,
    promoteCompletedContent: promoteCommitPushMetadataContentV1,
  };
}
