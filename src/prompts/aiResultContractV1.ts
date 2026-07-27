/**
 * AI result-contract prompt fragment (plan §3.8, `src/prompts/aiResultContractV1.ts`).
 *
 * The coordinator appends exactly this fragment to every provider prompt so
 * that the model knows the single acceptable output shape: one
 * `<<<ENSEMBLE_AI_RESULT_V1>>>` frame holding one line of strict JSON that
 * echoes the invocation's full correlation tuple (plan §3.5). The fragment
 * is deterministic — same inputs, same bytes — because the prompt-contract
 * identity/version and prompt-input digest are recorded in Chat interaction
 * transactions (plan §5.5) and must be reproducible on Resume.
 *
 * This module contains NO task, artifact, Chat, or source content; the
 * action-specific prompt is the registry row's `buildPrompt` output. It is
 * a pure text builder with no side effects and no VS Code imports.
 */
import { ActionCorrelationV1 } from "../types/actionCorrelationV1";
import { CompletedContentV1 } from "../types/aiResultEnvelope";

/** Stable identity/version of this prompt contract, recorded in Chat transactions (plan §5.5). */
export const AI_RESULT_CONTRACT_ID_V1 = "ensemble.aiResultContract.v1";
export const AI_RESULT_CONTRACT_VERSION_V1 = 1;

/** Envelope kinds a registry row may permit a provider to return (plan §3.5). */
export type PermittedEnvelopeKindV1 = "completed" | "questions" | "cancelled" | "failed";

/** The closed set of completed-content type names (plan §3.5's `CompletedContentV1`). */
export type CompletedContentTypeNameV1 = CompletedContentV1["contentType"];

export interface AiResultContractPromptInputV1 {
  readonly correlation: ActionCorrelationV1;
  readonly permittedResultKinds: readonly PermittedEnvelopeKindV1[];
  /** The single completed-content type this action accepts, or "none" when "completed" is not permitted. */
  readonly completedContentType: CompletedContentTypeNameV1 | "none";
  readonly maxResponseBytes: number;
}

export class AiResultContractPromptErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiResultContractPromptErrorV1";
  }
}

/** Fixed-key-order JSON for the correlation echo, so the fragment is byte-deterministic. */
function correlationJson(correlation: ActionCorrelationV1): string {
  return JSON.stringify({
    actionKey: correlation.actionKey,
    operationId: correlation.operationId,
    attemptId: correlation.attemptId,
    taskBindingId: correlation.taskBindingId,
    chatDocumentId: correlation.chatDocumentId,
  });
}

const CONTENT_TYPE_SHAPE_HINTS_V1: Readonly<Record<CompletedContentTypeNameV1, string>> = {
  "markdown-artifact.v1":
    '{"contentType":"markdown-artifact.v1","schemaVersion":1,"markdown":"<the complete artifact as Markdown>"}',
  "chat-message.v1":
    '{"contentType":"chat-message.v1","schemaVersion":1,"text":"<the assistant chat message>"}',
  "commit-metadata.v1":
    '{"contentType":"commit-metadata.v1","schemaVersion":1,"subject":"<Conventional-Commits subject, at most 72 characters>","body":"<optional body>"}',
  "preflight-plan.v1":
    '{"contentType":"preflight-plan.v1","schemaVersion":1,"requestDigest":"...","rootBindingId":"...","operations":[...]}',
  "edit-execution.v1":
    '{"contentType":"edit-execution.v1","schemaVersion":1,"executionId":"...","planId":"...","planDigest":"...","receiptIds":[...]}',
};

/**
 * Build the deterministic result-contract fragment for one provider attempt.
 * The permitted kinds and completed-content type are validated at registry
 * construction (`taskActionRegistryV1.ts`); this builder re-asserts the two
 * invariants that would make the emitted instructions self-contradictory.
 */
export function buildAiResultContractPromptV1(input: AiResultContractPromptInputV1): string {
  if (input.permittedResultKinds.length === 0) {
    throw new AiResultContractPromptErrorV1(
      "Cannot build a result-contract prompt with no permitted result kinds."
    );
  }
  const permitsCompleted = input.permittedResultKinds.includes("completed");
  if (permitsCompleted && input.completedContentType === "none") {
    throw new AiResultContractPromptErrorV1(
      'A row that permits "completed" results must declare exactly one completed-content type.'
    );
  }
  if (!permitsCompleted && input.completedContentType !== "none") {
    throw new AiResultContractPromptErrorV1(
      'A row that does not permit "completed" results must declare completedContentType "none".'
    );
  }

  const lines: string[] = [
    "=== ENSEMBLE RESULT CONTRACT (" + AI_RESULT_CONTRACT_ID_V1 + ") ===",
    "Your ENTIRE response must be exactly one result frame and nothing else:",
    "",
    "<<<ENSEMBLE_AI_RESULT_V1>>>",
    "<one single line of strict JSON>",
    "<<<END_ENSEMBLE_AI_RESULT_V1>>>",
    "",
    "Rules:",
    "- No text, code fences, or commentary before or after the frame.",
    "- The JSON must be a single line: no embedded line breaks, comments, trailing commas, or duplicate keys.",
    "- The JSON object must contain exactly: \"version\": 1, \"correlation\", \"kind\", and the kind-specific fields.",
    '- "correlation" must be exactly this object (echo it verbatim): ' +
      correlationJson(input.correlation),
    '- "kind" must be one of: ' +
      input.permittedResultKinds.map((k) => JSON.stringify(k)).join(", ") +
      ".",
    `- The total response must be smaller than ${input.maxResponseBytes} bytes of UTF-8.`,
  ];

  if (permitsCompleted && input.completedContentType !== "none") {
    lines.push(
      '- For "kind": "completed", "content" must have this exact shape: ' +
        CONTENT_TYPE_SHAPE_HINTS_V1[input.completedContentType]
    );
  }
  if (input.permittedResultKinds.includes("questions")) {
    lines.push(
      '- For "kind": "questions", "questions" must be an array of 1-16 structured questions, each ' +
        '{"questionId","kind"("text"|"singleChoice"|"multipleChoice"),"prompt","required",...} per the ' +
        "Ensemble structured-question schema. Ask questions ONLY when you cannot complete the action " +
        "without an answer; never write questions into artifact content."
    );
  }
  if (input.permittedResultKinds.includes("cancelled")) {
    lines.push(
      '- For "kind": "cancelled", optionally include "reason": "provider" or "user".'
    );
  }
  if (input.permittedResultKinds.includes("failed")) {
    lines.push(
      '- For "kind": "failed", include "code" (short stable identifier), "message" (at most 8 KiB), ' +
        'and boolean "retryable".'
    );
  }
  lines.push("=== END ENSEMBLE RESULT CONTRACT ===");
  return lines.join("\n");
}
