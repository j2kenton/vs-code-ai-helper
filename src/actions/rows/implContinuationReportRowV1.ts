/**
 * `implContinuationReport.v1` registry row (workflow-robustness Part 2 item 4).
 *
 * The text-mode dispatch for a `summary-only` recovery continuation: a prior
 * implementation round's edits already passed review, only its report is
 * missing, so the continuation runs with provider mode `text` — native edit
 * permissions actually withheld, the same mechanism `chatSend.v1` /
 * `review.v1` rely on — never as an edit run carrying a no-edits instruction.
 *
 * Target artifact: a transfer file INSIDE the task folder
 * (`impl-continuation-report.pending.md`), which the stage owner
 * (`executeImplementationRun` via `runSummaryOnlyContinuationV1`) immediately
 * reads back, deletes, and routes through the exact same summary shape gates,
 * checklist merge, and post-run delta gate an edit round's response gets. The
 * row deliberately does NOT validate the report's shape here: an unusable
 * report must still land so the stage owner can stamp/record/escalate it —
 * rejecting it at promotion would turn a workflow-visible failure into a
 * silent terminal one.
 *
 * Completed-content type: `markdown-artifact.v1`. Provider mode: `text`.
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

export const IMPL_CONTINUATION_REPORT_ACTION_KEY_V1 = "implContinuationReport.v1";

/**
 * The task-folder-relative transfer path the stage owner hands this row and
 * reads back after a completed outcome. Named `.pending.` so it is
 * recognizably transient and never collides with a real stage artifact.
 */
export const IMPL_CONTINUATION_REPORT_TRANSFER_FILENAME_V1 =
  "impl-continuation-report.pending.md";

export interface ImplContinuationReportActionInputV1 {
  readonly prompt: string;
  readonly targetLocator: { readonly rootId: string; readonly relativePath: string };
  readonly baselineRevision?: WorkflowFileRevisionV1;
}

const MAX_PROMPT_LENGTH_V1 = 8 * 1024 * 1024;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** @internal exported for testing */
export function validateImplContinuationReportInputV1(
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
  const validated: ImplContinuationReportActionInputV1 = {
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

class ImplContinuationReportPromotionErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImplContinuationReportPromotionErrorV1";
  }
}

async function promoteImplContinuationReportContentV1(
  content: CompletedContentV1,
  context: TaskActionExecutionContextV1
): Promise<TaskActionPromotionCodeV1> {
  if (!isMarkdownArtifactV1(content)) {
    throw new ImplContinuationReportPromotionErrorV1(
      "implContinuationReport.v1 received a non-markdown-artifact completed content"
    );
  }
  const input = context.validatedInput as ImplContinuationReportActionInputV1;
  const fileStore = getWorkflowFileStoreV1();
  // Raw markdown, unsigned: the stage owner signs the accepted summary with
  // the invoked reservation's identity itself (executeImplementationRun's
  // withAttribution call), exactly as it does for an edit round's response.
  const bytes = Buffer.from(content.markdown, "utf8");
  const result =
    input.baselineRevision === undefined
      ? await fileStore.createFileExclusive(input.targetLocator, bytes)
      : await fileStore.replaceFileExact(input.targetLocator, bytes, input.baselineRevision);
  if (result.kind !== "ok") {
    throw new ImplContinuationReportPromotionErrorV1(
      `could not write continuation report ${input.targetLocator.relativePath}: ${result.kind}${
        "code" in result ? `.${result.code}` : ""
      }`
    );
  }
  return "completed";
}

export function createImplContinuationReportRowV1(): ProviderTaskActionRowV1 {
  return {
    kind: "provider",
    actionKey: IMPL_CONTINUATION_REPORT_ACTION_KEY_V1,
    // Internal-only, like editExecution.v1/renameTask.v1: dispatched by the
    // implementation stage owner when a claimed recovery record's mode is
    // `summary-only`, never bound to a public command of its own.
    routes: ["internal:implContinuationReport.v1"],
    eligibility: {
      statuses: ["active"],
      stages: ["impl", "impl-high-review", "impl-low-review"],
    },
    requiresTaskOperationLease: true,
    progressLabel: "Producing the missing implementation report (no edits)…",
    validateInput: validateImplContinuationReportInputV1,
    loggingPolicy: { channel: "action.implContinuationReport", includeResultMetrics: true },
    providerMode: "text",
    maxResponseBytes: maxResponseBytesCeilingForModeV1("text"),
    permittedResultKinds: ["completed", "questions", "cancelled", "failed"],
    completedContentType: "markdown-artifact.v1",
    resumeSemantics: "sameOperation",
    buildPrompt: (context: TaskActionExecutionContextV1): string =>
      (context.validatedInput as ImplContinuationReportActionInputV1).prompt,
    promoteCompletedContent: promoteImplContinuationReportContentV1,
  };
}
