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

import { getWorkflowFileStoreV1 } from "../../services/workflowRuntimeServicesV1";
import { WorkflowFileRevisionV1 } from "../../services/workflowFileStoreV1";

export const COMMIT_PUSH_METADATA_ACTION_KEY_V1 = "commitPushMetadata.v1";

export interface CommitPushMetadataActionInputV1 {
  readonly prompt: string;
  readonly targetLocator?: { readonly rootId: string; readonly relativePath: string };
  readonly baselineRevision?: WorkflowFileRevisionV1;
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
  if (raw.targetLocator !== undefined) {
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
  }
  if (raw.baselineRevision !== undefined && !isNonEmptyString(raw.baselineRevision)) {
    return { ok: false, reason: "input \"baselineRevision\" must be a non-empty string when present" };
  }
  const allowedKeys = new Set(["prompt", "targetLocator", "baselineRevision"]);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, reason: `input has an unknown field: ${key}` };
    }
  }
  const validated: CommitPushMetadataActionInputV1 = {
    prompt: raw.prompt,
    ...(raw.targetLocator !== undefined
      ? {
          targetLocator: {
            rootId: (raw.targetLocator as { rootId: string }).rootId,
            relativePath: (raw.targetLocator as { relativePath: string }).relativePath,
          },
        }
      : {}),
    ...(raw.baselineRevision !== undefined ? { baselineRevision: raw.baselineRevision } : {}),
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
  context: TaskActionExecutionContextV1
): Promise<TaskActionPromotionCodeV1> {
  if (!isCommitMetadataV1(content)) {
    throw new CommitPushMetadataPromotionErrorV1(
      "commitPushMetadata.v1 received a non-commit-metadata completed content"
    );
  }
  const input = context.validatedInput as CommitPushMetadataActionInputV1;
  if (input.targetLocator) {
    const fileStore = getWorkflowFileStoreV1();
    const jsonText = JSON.stringify({ subject: content.subject, body: content.body });
    const bytes = Buffer.from(jsonText, "utf8");
    const result =
      input.baselineRevision === undefined
        ? await fileStore.createFileExclusive(input.targetLocator, bytes)
        : await fileStore.replaceFileExact(input.targetLocator, bytes, input.baselineRevision);
    if (result.kind !== "ok") {
      throw new CommitPushMetadataPromotionErrorV1(
        `could not write commit metadata artifact ${input.targetLocator.relativePath}: ${result.kind}${
          "code" in result ? `.${result.code}` : ""
        }`
      );
    }
  }
  return "completed";
}

export function createCommitPushMetadataRowV1(): ProviderTaskActionRowV1 {
  return {
    kind: "provider",
    actionKey: COMMIT_PUSH_METADATA_ACTION_KEY_V1,
    // Internal, like editExecution.v1: this row is never invoked directly
    // from a route/command — it runs nested inside commitPush.v1's Git
    // workflow (reviewCommitMessage's AI commit-message generation). The
    // real public route ids (vs-code-ai-helper.commitAndPushTask /
    // completeCommitAndPushTask) belong to commitPush.v1 (commitPushRowV1.ts),
    // which is what those commands now reach first through the coordinator.
    routes: ["internal:commitPushMetadata.v1"],
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
