/**
 * `draft.v1` registry row (plan §6.3, "Migrate Draft atomically with
 * task-document formatting") — the second action migrated onto the
 * coordinator built in steps 5-8, mirroring `generatePlanRowV1.ts`'s shape.
 * Target artifact: `<task-folder>/task.md`'s `## Draft with AI` section,
 * completed-content type `markdown-artifact.v1`, revision-checked
 * read-merge-write promotion (unlike plan.md, task.md already exists and
 * carries OTHER sections — Task Description, intro/shortcut boilerplate —
 * that promotion must preserve byte-for-byte).
 *
 * Per plan §6.3, the V1 rewriter never emits fresh `## Open Questions`
 * content: a clarification need is returned as the envelope's `questions`
 * kind (routed to Chat With AI by the caller, exactly like generatePlan.v1)
 * instead of free-text parsed out of a completed response. Promotion
 * therefore always clears `openQuestions` — even a legacy document's
 * existing active section is dropped on the next V1 rewrite ("removes the
 * legacy active section when rewriting").
 *
 * `content.markdown` is the model's raw draft BODY (the goal line plus the
 * three required `###` subsections) — not wrapped in `## Draft with AI` /
 * `## Open Questions` headings; those are promotion's job, exactly as
 * plan.md's promotion owns wrapping generatePlan.v1's content in nothing at
 * all (a whole-file artifact) versus this row's section-merge.
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
import {
  buildTaskDocument,
  parseTaskDocument,
  validateDraftStructure,
  wrapUnstructuredDraft,
} from "../../utils/taskDescriptionDocument";

export const DRAFT_ACTION_KEY_V1 = "draft.v1";
export const DRAFT_TARGET_RELATIVE_PATH_V1 = "task.md";

/** Bounded read ceiling for task.md during promotion's read-merge-write. */
const MAX_TASK_DOCUMENT_BYTES_V1 = 4 * 1024 * 1024;

/**
 * The row's validated input (plan §6.1 step 5's "validated input snapshot").
 * `prompt` is the fully-rendered, action-specific prompt content — NOT
 * including the coordinator's own result-contract fragment. Unlike
 * generatePlan.v1's plan.md (which may not exist yet on first generation),
 * task.md always exists by the time Draft with AI can run (created at task
 * creation), so `baselineRevision` is required rather than optional.
 */
export interface DraftActionInputV1 {
  readonly prompt: string;
  readonly targetLocator: { readonly rootId: string; readonly relativePath: string };
  readonly baselineRevision: WorkflowFileRevisionV1;
}

const MAX_PROMPT_LENGTH_V1 = 8 * 1024 * 1024;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** @internal exported for testing */
export function validateDraftInputV1(rawInput: unknown): TaskActionInputValidationResultV1 {
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
    (locator as Record<string, unknown>).relativePath !== DRAFT_TARGET_RELATIVE_PATH_V1
  ) {
    return {
      ok: false,
      reason: `input "targetLocator" must be { rootId: non-empty string, relativePath: "${DRAFT_TARGET_RELATIVE_PATH_V1}" }`,
    };
  }
  if (!isNonEmptyString(raw.baselineRevision)) {
    return { ok: false, reason: "input is missing a non-empty \"baselineRevision\" string" };
  }
  const allowedKeys = new Set(["prompt", "targetLocator", "baselineRevision"]);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, reason: `input has an unknown field: ${key}` };
    }
  }
  const validated: DraftActionInputV1 = {
    prompt: raw.prompt,
    targetLocator: {
      rootId: (locator as { rootId: string }).rootId,
      relativePath: DRAFT_TARGET_RELATIVE_PATH_V1,
    },
    baselineRevision: raw.baselineRevision,
  };
  return { ok: true, input: validated };
}

function isMarkdownArtifactV1(
  content: CompletedContentV1
): content is Extract<CompletedContentV1, { contentType: "markdown-artifact.v1" }> {
  return content.contentType === "markdown-artifact.v1";
}

class DraftPromotionErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DraftPromotionErrorV1";
  }
}

/**
 * Read task.md through the shared workflow file store, merge the completed
 * draft body into its `## Draft with AI` section, and write it back guarded
 * by an exact revision check against the validated input's captured
 * baseline (plan §6.2's "revision-checked coordinator replacement", applied
 * here to a read-merge-write instead of a whole-file replace): a concurrent
 * edit to task.md between the baseline read and this promotion is detected
 * and refused rather than clobbered.
 */
async function promoteDraftContentV1(
  content: CompletedContentV1,
  context: TaskActionExecutionContextV1
): Promise<TaskActionPromotionCodeV1> {
  if (!isMarkdownArtifactV1(content)) {
    // Unreachable in production: the coordinator only calls
    // promoteCompletedContent after matching envelope.content.contentType
    // against this row's declared completedContentType. Guarded here so a
    // future refactor cannot silently write the wrong content type.
    throw new DraftPromotionErrorV1("draft.v1 received a non-markdown-artifact completed content");
  }
  const input = context.validatedInput as DraftActionInputV1;
  const fileStore = getWorkflowFileStoreV1();

  const current = await fileStore.readFileBounded(input.targetLocator, MAX_TASK_DOCUMENT_BYTES_V1);
  if (current.kind !== "ok") {
    throw new DraftPromotionErrorV1(
      `could not read ${DRAFT_TARGET_RELATIVE_PATH_V1} to merge the draft: ${current.kind}${
        "code" in current ? `.${current.code}` : ""
      }`
    );
  }
  if (current.value.revision !== input.baselineRevision) {
    throw new DraftPromotionErrorV1(
      `${DRAFT_TARGET_RELATIVE_PATH_V1} changed since this drive's baseline revision was captured`
    );
  }

  const existingText = current.value.bytes.toString("utf8");
  const parsed = parseTaskDocument(existingText);

  const structure = validateDraftStructure(content.markdown);
  const draftWithAI = structure.valid
    ? content.markdown
    : wrapUnstructuredDraft(content.markdown, structure.missing);

  const newContent = buildTaskDocument({
    ...parsed,
    draftWithAI,
    // The V1 rewriter never carries Open Questions content forward — new
    // clarification needs route to Chat With AI instead (plan §6.3).
    openQuestions: "",
  });

  const result = await fileStore.replaceFileExact(
    input.targetLocator,
    Buffer.from(newContent, "utf8"),
    current.value.revision
  );
  if (result.kind !== "ok") {
    throw new DraftPromotionErrorV1(
      `could not write ${DRAFT_TARGET_RELATIVE_PATH_V1}: ${result.kind}${
        "code" in result ? `.${result.code}` : ""
      }`
    );
  }
  return "completed";
}

/**
 * Build the `draft.v1` registry row. A fresh row instance is cheap and
 * stateless (all real state lives in the shared workflow file store / lease
 * store / transaction store singletons), so callers may construct one per
 * registry rather than needing a module-level singleton here.
 */
export function createDraftRowV1(): ProviderTaskActionRowV1 {
  return {
    kind: "provider",
    actionKey: DRAFT_ACTION_KEY_V1,
    routes: ["vs-code-ai-helper.draftTaskWithAI"],
    eligibility: { statuses: ["active"], stages: ["desc"] },
    requiresTaskOperationLease: true,
    progressLabel: "Drafting task…",
    validateInput: validateDraftInputV1,
    loggingPolicy: { channel: "action.draft", includeResultMetrics: true },
    providerMode: "text",
    maxResponseBytes: maxResponseBytesCeilingForModeV1("text"),
    permittedResultKinds: ["completed", "questions", "cancelled", "failed"],
    completedContentType: "markdown-artifact.v1",
    // Regenerating task.md's draft section targets the SAME operation/
    // artifact after answering — there is no reason to start a fresh linked
    // operation.
    resumeSemantics: "sameOperation",
    buildPrompt: (context: TaskActionExecutionContextV1): string =>
      (context.validatedInput as DraftActionInputV1).prompt,
    promoteCompletedContent: promoteDraftContentV1,
  };
}
