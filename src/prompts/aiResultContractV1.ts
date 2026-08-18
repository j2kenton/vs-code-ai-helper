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
  // Literal rather than elliptical: `"operations":[...]` told the model
  // nothing about the operation shape, and the same ellipsis style on the
  // questions contract is what produced a live contentSchemaMismatch. The
  // identifiers below come from the session preamble; the example is a
  // structurally valid plan if the placeholders are substituted.
  "preflight-plan.v1":
    '{"contentType":"preflight-plan.v1","schemaVersion":1,' +
    '"requestDigest":"<requestDigest from the preamble>",' +
    '"rootBindingId":"<rootBindingId from the preamble>",' +
    // The example shows patchFile deliberately: it is the operation that
    // should be reached for by default. replaceFile requires emitting the
    // COMPLETE new file, which is impossible above roughly 40 KB of content
    // for most models once base64 inflation is counted.
    '"operations":[{"stepId":"step-1","kind":"patchFile",' +
    '"rootId":"<rootId from the preamble>","relativePath":"src/example.ts",' +
    '"targetObservationId":"<observationId returned when you read that path>",' +
    '"parentChain":[{"kind":"observed","observationId":"<observationId for src>"}],' +
    '"findBase64":"<base64 of the exact existing text to replace>",' +
    '"replacementBase64":"<base64 of the new text>"}]}',
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
    // A literal shape per kind, matching how CONTENT_TYPE_SHAPE_HINTS_V1
    // specifies completed content. This used to read
    // `{"questionId","kind",...,"prompt","required",...}` — four named fields
    // and an ellipsis — while the decoder ALSO required `allowBlank` and
    // `maxLength` on text questions. A model that asked a clarifying question
    // sent exactly the four documented fields and had its whole envelope
    // rejected. Those two are now supplied by the app and must not appear
    // here (owner decision, 2026-08-16): a model decides what to ask, not how
    // the answer box behaves.
    lines.push(
      // Every example is a VALID payload if copied verbatim. An earlier
      // revision showed a single-entry `options` array while the decoder
      // requires MIN_OPTIONS_V1 = 2, and paired `"maxSelections":2` with it,
      // which also trips `maxSelections > options.length`. A model copying
      // the shape faithfully would have been rejected — recreating, one level
      // down, the exact "obeyed the contract it was given" failure this block
      // exists to remove. Keep both option arrays at two entries, with
      // DISTINCT optionId placeholders: two identical `<stable-id>` entries
      // trip the duplicate-optionId rejection, the same trap one level down.
      '- For "kind": "questions", "questions" must be an array of 1-16 objects, each exactly one of:',
      '    {"questionId":"<stable-id>","kind":"text","prompt":"<the question>","required":true}',
      '    {"questionId":"<stable-id>","kind":"singleChoice","prompt":"<the question>","required":true,' +
        '"options":[{"optionId":"<stable-id-1>","label":"<shown to the user>"},' +
        '{"optionId":"<stable-id-2>","label":"<shown to the user>"}]}',
      '    {"questionId":"<stable-id>","kind":"multipleChoice","prompt":"<the question>","required":true,' +
        '"options":[{"optionId":"<stable-id-1>","label":"<shown to the user>"},' +
        '{"optionId":"<stable-id-2>","label":"<shown to the user>"}],"minSelections":1,"maxSelections":2}',
      '  "options" must have 2-32 entries; "maxSelections" must not exceed the number of options.',
      '  "helpText" is the only optional field. Send NO other fields — answer-box behaviour is not yours to set.',
      "  Ask questions ONLY when you cannot complete the action without an answer; never write " +
        "questions into artifact content."
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
  // Closing reminder (2026-08-06/07 live incidents: four separate reviews on
  // the "workflow" task did substantively correct work but never emitted the
  // frame at all — each recovered response showed the model narrating its
  // own verification process, "let me check X", "let me verify Y", right up
  // to its final answer, with the frame simply never appearing). Restating
  // the requirement as the last substantive instruction in the whole prompt
  // bundle — one line above the closing "=== END ..." marker, itself always
  // appended last — puts it where a model composing its final answer is most
  // likely to still have it in view, and names the observed failure mode
  // directly instead of only stating the positive rule once at the top.
  lines.push(
    "",
    "REMINDER: your reply must begin with <<<ENSEMBLE_AI_RESULT_V1>>> and contain " +
      "nothing else. Investigate, verify, and reason as much as you need to first — " +
      "but once you are ready to answer, your final output is ONLY the frame above, " +
      "with no exploratory notes (\"let me check...\", \"let me verify...\") before or " +
      "after it, even if your process involved a lot of that."
  );
  lines.push("=== END ENSEMBLE RESULT CONTRACT ===");
  return lines.join("\n");
}
