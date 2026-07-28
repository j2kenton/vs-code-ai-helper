/**
 * `generatePlan.v1` registry row (plan §6.2, "Implement Generate Plan
 * first") — the FIRST action actually migrated onto the coordinator built in
 * steps 5-8. Target artifact: `<task-folder>/plan.md`, completed-content type
 * `markdown-artifact.v1`, revision-checked coordinator replacement.
 *
 * The row itself is fully synchronous (`validateInput`/`buildPrompt`) or a
 * pure I/O leaf (`promoteCompletedContent`): every asynchronous concern the
 * action needs — resolving the model, building the context pack, rendering
 * the "create-plan.md" template into a concrete prompt, and reading plan.md's
 * current revision — is done by the caller (`generatePlanWithAI.ts`) BEFORE
 * `TaskActionCoordinatorV1.executeAction` is invoked, and folded into
 * `GeneratePlanActionInputV1`. This is deliberate: that same input snapshot
 * is exactly what the coordinator persists (plan §5.5) so Resume reconstructs
 * this action from its saved transaction — same prompt bytes, same target
 * locator, same baseline revision — the row's `buildPrompt` requires nothing
 * beyond that already-validated input.
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

export const GENERATE_PLAN_ACTION_KEY_V1 = "generatePlan.v1";
export const GENERATE_PLAN_TARGET_RELATIVE_PATH_V1 = "plan.md";

/**
 * The row's validated input (plan §6.1 step 5's "validated input snapshot").
 * `prompt` is the fully-rendered, action-specific prompt content (the
 * "create-plan.md" template already interpolated with the context pack) —
 * NOT including the coordinator's own result-contract fragment, which is
 * appended uniformly for every provider row.
 */
export interface GeneratePlanActionInputV1 {
  readonly prompt: string;
  readonly targetLocator: { readonly rootId: string; readonly relativePath: string };
  /** plan.md's revision at validation time, or absent when it does not exist yet. */
  readonly baselineRevision?: WorkflowFileRevisionV1;
}

const MAX_PROMPT_LENGTH_V1 = 8 * 1024 * 1024;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** @internal exported for testing */
export function validateGeneratePlanInputV1(rawInput: unknown): TaskActionInputValidationResultV1 {
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
    (locator as Record<string, unknown>).relativePath !== GENERATE_PLAN_TARGET_RELATIVE_PATH_V1
  ) {
    return {
      ok: false,
      reason: `input "targetLocator" must be { rootId: non-empty string, relativePath: "${GENERATE_PLAN_TARGET_RELATIVE_PATH_V1}" }`,
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
  const validated: GeneratePlanActionInputV1 = {
    prompt: raw.prompt,
    targetLocator: {
      rootId: (locator as { rootId: string }).rootId,
      relativePath: GENERATE_PLAN_TARGET_RELATIVE_PATH_V1,
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

class GeneratePlanPromotionErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeneratePlanPromotionErrorV1";
  }
}

/**
 * Write plan.md through the shared workflow file store, guarded by the
 * validated input's captured baseline revision (plan §6.2's "revision-checked
 * coordinator replacement"): a concurrent edit to plan.md between the
 * baseline read and this promotion is detected and refused rather than
 * clobbered — the coordinator maps the resulting throw onto the stable
 * `promotionFailed` outcome, so nothing is silently overwritten.
 */
async function promoteGeneratePlanContentV1(
  content: CompletedContentV1,
  context: TaskActionExecutionContextV1
): Promise<TaskActionPromotionCodeV1> {
  if (!isMarkdownArtifactV1(content)) {
    // Unreachable in production: the coordinator only calls
    // promoteCompletedContent after matching envelope.content.contentType
    // against this row's declared completedContentType. Guarded here so a
    // future refactor cannot silently write the wrong content type.
    throw new GeneratePlanPromotionErrorV1("generatePlan.v1 received a non-markdown-artifact completed content");
  }
  const input = context.validatedInput as GeneratePlanActionInputV1;
  const fileStore = getWorkflowFileStoreV1();
  const bytes = Buffer.from(content.markdown, "utf8");
  const result =
    input.baselineRevision === undefined
      ? await fileStore.createFileExclusive(input.targetLocator, bytes)
      : await fileStore.replaceFileExact(input.targetLocator, bytes, input.baselineRevision);
  if (result.kind !== "ok") {
    throw new GeneratePlanPromotionErrorV1(
      `could not write ${GENERATE_PLAN_TARGET_RELATIVE_PATH_V1}: ${result.kind}${
        "code" in result ? `.${result.code}` : ""
      }`
    );
  }
  return "completed";
}

/**
 * Build the `generatePlan.v1` registry row. A fresh row instance is cheap and
 * stateless (all real state lives in the shared workflow file store / lease
 * store / transaction store singletons), so callers may construct one per
 * registry rather than needing a module-level singleton here.
 */
export function createGeneratePlanRowV1(): ProviderTaskActionRowV1 {
  return {
    kind: "provider",
    actionKey: GENERATE_PLAN_ACTION_KEY_V1,
    routes: ["vs-code-ai-helper.generatePlanWithAI"],
    eligibility: { statuses: ["active"], stages: ["desc", "plan"] },
    requiresTaskOperationLease: true,
    progressLabel: "Generating plan…",
    validateInput: validateGeneratePlanInputV1,
    loggingPolicy: { channel: "action.generatePlan", includeResultMetrics: true },
    providerMode: "text",
    maxResponseBytes: maxResponseBytesCeilingForModeV1("text"),
    permittedResultKinds: ["completed", "questions", "cancelled", "failed"],
    completedContentType: "markdown-artifact.v1",
    // Regenerating plan.md targets the SAME operation/artifact after
    // answering — there is no reason to start a fresh linked operation.
    resumeSemantics: "sameOperation",
    buildPrompt: (context: TaskActionExecutionContextV1): string =>
      (context.validatedInput as GeneratePlanActionInputV1).prompt,
    promoteCompletedContent: promoteGeneratePlanContentV1,
  };
}
