/**
 * `editExecution.v1` registry row (plan §7.4/§7.6): the fresh mutation-only
 * conversation that executes one SEALED plan. Its prompt is the fixed
 * edit-execution contract plus the canonical execution script and NOTHING
 * else — no task, artifact, Chat, or source content — and the registry
 * forbids `questions` for its `edit-execution.v1` content type (§7.6:
 * questions are invalid during edit execution).
 *
 * Promotion cross-checks the final `edit-execution.v1` document against the
 * broker's authoritative state: the execution must be `completed` and the
 * document's `receiptIds` must equal the broker's ordered applied-receipt
 * list exactly (§7.4).
 */
import {
  ProviderTaskActionRowV1,
  TaskActionExecutionContextV1,
  TaskActionInputValidationResultV1,
  TaskActionPromotionCodeV1,
} from "../taskActionRegistryV1";
import { maxResponseBytesCeilingForModeV1 } from "../../types/agentExecutionV1";
import { CompletedContentV1 } from "../../types/aiResultEnvelope";
import { getEditPlanBrokerV1 } from "../../services/workflowRuntimeServicesV1";
import { buildEditExecutionContractPromptV1 } from "../../prompts/editExecutionContractV1";

export const EDIT_EXECUTION_ACTION_KEY_V1 = "editExecution.v1";

export interface EditExecutionActionInputV1 {
  readonly executionId: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** @internal exported for testing */
export function validateEditExecutionInputV1(
  rawInput: unknown
): TaskActionInputValidationResultV1 {
  if (typeof rawInput !== "object" || rawInput === null) {
    return { ok: false, reason: "input is not an object" };
  }
  const raw = rawInput as Record<string, unknown>;
  if (!isNonEmptyString(raw.executionId) || raw.executionId.length > 256) {
    return { ok: false, reason: "input is missing a valid \"executionId\"" };
  }
  for (const key of Object.keys(raw)) {
    if (key !== "executionId") {
      return { ok: false, reason: `input has an unknown field: ${key}` };
    }
  }
  return { ok: true, input: { executionId: raw.executionId } };
}

class EditExecutionPromotionErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditExecutionPromotionErrorV1";
  }
}

function promoteEditExecutionContentV1(
  content: CompletedContentV1,
  context: TaskActionExecutionContextV1
): Promise<TaskActionPromotionCodeV1> {
  if (content.contentType !== "edit-execution.v1") {
    throw new EditExecutionPromotionErrorV1(`unexpected content type ${content.contentType}`);
  }
  const input = context.validatedInput as EditExecutionActionInputV1;
  const broker = getEditPlanBrokerV1();
  const sealed = broker.sealedExecution(input.executionId);
  if (!sealed) {
    throw new EditExecutionPromotionErrorV1("no sealed execution matches this invocation");
  }
  if (
    content.executionId !== sealed.executionId ||
    content.planId !== sealed.planId ||
    content.planDigest !== sealed.planDigest
  ) {
    throw new EditExecutionPromotionErrorV1("the completion does not reference the sealed plan");
  }
  const outcome = broker.executionOutcome(input.executionId);
  if (!outcome || outcome.state !== "completed") {
    throw new EditExecutionPromotionErrorV1(
      `the broker's authoritative state is ${outcome?.state ?? "unknown"}, not completed`
    );
  }
  // §7.4: the receipt list must match the broker's authoritative ordered
  // list exactly — same ids, same order, nothing missing or invented.
  if (
    content.receiptIds.length !== outcome.appliedReceiptIds.length ||
    content.receiptIds.some((receiptId, index) => receiptId !== outcome.appliedReceiptIds[index])
  ) {
    throw new EditExecutionPromotionErrorV1(
      "the completion's receiptIds do not match the broker's ordered receipts"
    );
  }
  return Promise.resolve("completed");
}

export function createEditExecutionRowV1(): ProviderTaskActionRowV1 {
  return {
    kind: "provider",
    actionKey: EDIT_EXECUTION_ACTION_KEY_V1,
    // Internal-only: never dispatched from a user-facing route — the
    // two-phase wrapper (runEditActionV1.ts) launches it after a sealed,
    // permit-claimed preflight.
    routes: ["internal:editExecution.v1"],
    // Union of the four preflight rows' declared stages (editPreflightRowsV1)
    // — a sealed execution can only follow a stage-eligible preflight.
    eligibility: {
      statuses: ["active"],
      stages: ["impl", "impl-high-review", "impl-low-review", "publish"],
    },
    requiresTaskOperationLease: true,
    progressLabel: "Applying planned edits…",
    validateInput: validateEditExecutionInputV1,
    loggingPolicy: { channel: "action.editExecution", includeResultMetrics: true },
    providerMode: "edit",
    maxResponseBytes: maxResponseBytesCeilingForModeV1("edit"),
    // No "questions": the registry enforces this pairing for
    // edit-execution.v1 content (§7.6).
    permittedResultKinds: ["completed", "cancelled", "failed"],
    completedContentType: "edit-execution.v1",
    resumeSemantics: "sameOperation",
    buildPrompt: (context) => {
      const input = context.validatedInput as EditExecutionActionInputV1;
      const sealed = getEditPlanBrokerV1().sealedExecution(input.executionId);
      if (!sealed) {
        throw new EditExecutionPromotionErrorV1("no sealed execution matches this invocation");
      }
      // The ONLY inputs a mutation session receives (§7.4): the fixed
      // contract prompt plus the canonical script.
      return buildEditExecutionContractPromptV1(sealed.script);
    },
    promoteCompletedContent: promoteEditExecutionContentV1,
  };
}
