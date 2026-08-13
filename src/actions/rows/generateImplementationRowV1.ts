/**
 * `generateImplementation.v1` registry row (plan §6.4, "Migrate Generate
 * Implementation from its real source").
 *
 * Target artifact: registered task-local implementation notes artifact
 * (e.g. `<task-folder>/implementation-1.md`).
 * Completed-content type: `markdown-artifact.v1`.
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
import { getWorkflowFileStoreV1 } from "../../services/workflowRuntimeServicesV1";
import { WorkflowFileRevisionV1 } from "../../services/workflowFileStoreV1";
import { attributionModelLabel, withAttribution } from "../../utils/fileUtils";
import {
  hasImplementationChecklistV1,
  IMPLEMENTATION_CHECKLIST_MARKER,
} from "../../utils/implementationChecklist";

export const GENERATE_IMPLEMENTATION_ACTION_KEY_V1 = "generateImplementation.v1";

export interface GenerateImplementationActionInputV1 {
  readonly prompt: string;
  readonly targetLocator: { readonly rootId: string; readonly relativePath: string };
  readonly baselineRevision?: WorkflowFileRevisionV1;
}

const MAX_PROMPT_LENGTH_V1 = 8 * 1024 * 1024;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** @internal exported for testing */
export function validateGenerateImplementationInputV1(
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
  if (raw.baselineRevision !== undefined && !isNonEmptyString(raw.baselineRevision)) {
    return { ok: false, reason: "input \"baselineRevision\" must be a non-empty string when present" };
  }
  const allowedKeys = new Set(["prompt", "targetLocator", "baselineRevision"]);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, reason: `input has an unknown field: ${key}` };
    }
  }
  const validated: GenerateImplementationActionInputV1 = {
    prompt: raw.prompt,
    targetLocator: {
      rootId: (locator as { rootId: string }).rootId,
      relativePath: (locator as { relativePath: string }).relativePath,
    },
    ...(raw.baselineRevision !== undefined ? { baselineRevision: raw.baselineRevision } : {}),
  };
  return { ok: true, input: validated };
}

function isMarkdownArtifactV1(
  content: CompletedContentV1
): content is Extract<CompletedContentV1, { contentType: "markdown-artifact.v1" }> {
  return content.contentType === "markdown-artifact.v1";
}

class GenerateImplementationPromotionErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerateImplementationPromotionErrorV1";
  }
}

async function promoteGenerateImplementationContentV1(
  content: CompletedContentV1,
  context: TaskActionExecutionContextV1
): Promise<TaskActionPromotionCodeV1> {
  if (!isMarkdownArtifactV1(content)) {
    throw new GenerateImplementationPromotionErrorV1(
      "generateImplementation.v1 received a non-markdown-artifact completed content"
    );
  }
  const input = context.validatedInput as GenerateImplementationActionInputV1;
  const fileStore = getWorkflowFileStoreV1();
  // 2026-08-12 field report item 1 (checklist tick corruption) traced: this
  // path writes `content.markdown` to disk with no transformation of its own
  // (see the plain `Buffer.from(markdown, "utf8")` below) — identical in
  // shape to `generatePlanRowV1.ts`'s `promoteGeneratePlanContentV1`, whose
  // output is not corrupted. `content.markdown` itself is `raw.markdown`
  // from `parseAiResultEnvelopeV1`'s `markdown-artifact.v1` decode
  // (`aiResultEnvelope.ts`), which is a plain field read off the already
  // `JSON.parse`d envelope body — `JSON.parse` unescapes `\"` to `"` as part
  // of ordinary string decoding, so a `\"` surviving as literal backslash+
  // quote characters in `content.markdown` at this point cannot originate
  // from our own frame parsing OR this write path. It has to already be
  // present, as literal text, inside the JSON string value the provider put
  // in its response body — i.e. the model over-escaped quotes in the
  // markdown it authored, as if that markdown would itself be re-embedded in
  // JSON, which the transport frame does not require. No corresponding
  // corruption exists in `plan.md` from the same provider/task, which is
  // additional evidence this is a content-generation quality issue on
  // specific rounds, not a defect in our parse-then-write pipeline. See
  // `generateImplementationRowV1.test.ts`'s "does not escape or otherwise
  // transform quoted markdown" for the regression proving this write path's
  // own innocence; survival of the corruption once written is handled
  // downstream by `normalizeChecklistItemTextV1`'s unescaping (step 2).
  let markdown = content.markdown;
  // Shared definition, not a substring test: a generated checklist that merely
  // QUOTES the marker (this repo's own plans do, when the work is about this
  // mechanism) would otherwise be left without a real standalone marker line —
  // and everything downstream would then read the task as having no checklist
  // at all, silently disabling plan-completeness tracking for it.
  if (!hasImplementationChecklistV1(markdown)) {
    markdown = `${IMPLEMENTATION_CHECKLIST_MARKER}\n\n${markdown}`;
  }
  // Signed with the reservation actually claimed/invoked, same helper and
  // header format as review artifacts (reviewRowV1.ts) — header goes above
  // the checklist marker; .includes() still finds the marker either way.
  if (context.provider) {
    markdown = withAttribution(
      markdown,
      context.provider.providerLabel,
      attributionModelLabel(context.provider.storedModelId)
    );
  }
  const bytes = Buffer.from(markdown, "utf8");
  const result =
    input.baselineRevision === undefined
      ? await fileStore.createFileExclusive(input.targetLocator, bytes)
      : await fileStore.replaceFileExact(input.targetLocator, bytes, input.baselineRevision);
  if (result.kind !== "ok") {
    throw new GenerateImplementationPromotionErrorV1(
      `could not write implementation artifact ${input.targetLocator.relativePath}: ${result.kind}${
        "code" in result ? `.${result.code}` : ""
      }`
    );
  }
  return "completed";
}

export function createGenerateImplementationRowV1(): ProviderTaskActionRowV1 {
  return {
    kind: "provider",
    actionKey: GENERATE_IMPLEMENTATION_ACTION_KEY_V1,
    routes: ["vs-code-ai-helper.generateImplementationWithAI"],
    eligibility: { statuses: ["active"], stages: ["impl"] },
    requiresTaskOperationLease: true,
    progressLabel: "Generating implementation notes…",
    validateInput: validateGenerateImplementationInputV1,
    loggingPolicy: { channel: "action.generateImplementation", includeResultMetrics: true },
    providerMode: "text",
    maxResponseBytes: maxResponseBytesCeilingForModeV1("text"),
    permittedResultKinds: ["completed", "questions", "cancelled", "failed"],
    completedContentType: "markdown-artifact.v1",
    resumeSemantics: "sameOperation",
    buildPrompt: (context: TaskActionExecutionContextV1): string =>
      (context.validatedInput as GenerateImplementationActionInputV1).prompt,
    promoteCompletedContent: promoteGenerateImplementationContentV1,
  };
}
