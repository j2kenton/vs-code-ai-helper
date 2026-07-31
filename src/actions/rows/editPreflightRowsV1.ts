/**
 * Preflight registry rows (plan §7.3/§7.8): the four edit-capable actions —
 * implementation, Fast Forward, edit-based Apply Review, and the AI lint
 * fallback — each run their READ-ONLY planning pass through one shared
 * provider-row core with `providerMode: "preflight"`. The model sees the
 * caller-rendered task/source prompt plus the five read tools, and must
 * return a `preflight-plan.v1` document (or structured questions — legal
 * before any edit session, §7.3).
 *
 * Promotion validates the plan against exactly the observations THIS
 * attempt's read session minted (`context.preflight.ledger`), checks the
 * `requestDigest`/`rootBindingId` echoes, and:
 *  - an EMPTY plan settles as `completed/noChanges` — no edit session ever
 *    opens (§7.4);
 *  - a non-empty plan is SEALED by the edit broker (digests, execution id,
 *    authored script, exclusive persistence + read-back) and settles as
 *    `completed` — the two-phase command wrapper (`runEditActionV1.ts`)
 *    then claims the permit and launches the `editExecution.v1` session.
 */
import {
  ProviderTaskActionRowV1,
  TaskActionExecutionContextV1,
  TaskActionInputValidationResultV1,
  TaskActionPromotionCodeV1,
} from "../taskActionRegistryV1";
import { maxResponseBytesCeilingForModeV1 } from "../../types/agentExecutionV1";
import { CompletedContentV1 } from "../../types/aiResultEnvelope";
import { validatePreflightPlanAgainstLedgerV1 } from "../../types/preflightPlanV1";
import { getEditPlanBrokerV1 } from "../../services/workflowRuntimeServicesV1";

export const IMPLEMENTATION_ACTION_KEY_V1 = "implementation.v1";
export const FAST_FORWARD_ACTION_KEY_V1 = "fastForward.v1";
export const APPLY_REVIEW_EDIT_ACTION_KEY_V1 = "applyReviewEdit.v1";
export const LINT_ACTION_KEY_V1 = "lint.v1";

export interface EditPreflightActionInputV1 {
  /** Fully-rendered action prompt (task/plan/review/lint context). */
  readonly prompt: string;
  /** The registered workspace root the read session exposes (§7.2). */
  readonly rootId: string;
  /** `computeWorkspaceRootBindingIdV1(rootId, fsPath)` — echoed by the plan. */
  readonly rootBindingId: string;
  /** SHA-256 the returned plan must echo as its requestDigest (§7.3). */
  readonly requestDigest: string;
}

const MAX_PROMPT_LENGTH_V1 = 8 * 1024 * 1024;
const SHA256_HEX_V1 = /^[0-9a-f]{64}$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** @internal exported for testing */
export function validateEditPreflightInputV1(
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
  if (!isNonEmptyString(raw.rootId)) {
    return { ok: false, reason: "input is missing a non-empty \"rootId\" string" };
  }
  if (typeof raw.rootBindingId !== "string" || !SHA256_HEX_V1.test(raw.rootBindingId)) {
    return { ok: false, reason: "input \"rootBindingId\" must be a sha256 hex digest" };
  }
  if (typeof raw.requestDigest !== "string" || !SHA256_HEX_V1.test(raw.requestDigest)) {
    return { ok: false, reason: "input \"requestDigest\" must be a sha256 hex digest" };
  }
  const allowedKeys = new Set(["prompt", "rootId", "rootBindingId", "requestDigest"]);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, reason: `input has an unknown field: ${key}` };
    }
  }
  const validated: EditPreflightActionInputV1 = {
    prompt: raw.prompt,
    rootId: raw.rootId,
    rootBindingId: raw.rootBindingId,
    requestDigest: raw.requestDigest,
  };
  return { ok: true, input: validated };
}

class EditPreflightPromotionErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditPreflightPromotionErrorV1";
  }
}

async function promoteEditPreflightContentV1(
  content: CompletedContentV1,
  context: TaskActionExecutionContextV1
): Promise<TaskActionPromotionCodeV1> {
  if (content.contentType !== "preflight-plan.v1") {
    throw new EditPreflightPromotionErrorV1(`unexpected content type ${content.contentType}`);
  }
  const input = context.validatedInput as EditPreflightActionInputV1;
  if (content.requestDigest !== input.requestDigest) {
    throw new EditPreflightPromotionErrorV1("the plan does not echo this request's digest");
  }
  if (content.rootBindingId !== input.rootBindingId) {
    throw new EditPreflightPromotionErrorV1("the plan does not echo this request's root binding");
  }
  const preflight = context.preflight;
  if (!preflight) {
    throw new EditPreflightPromotionErrorV1("no preflight observation ledger is attached to this attempt");
  }
  const validation = validatePreflightPlanAgainstLedgerV1(content, preflight.ledger, input.rootId);
  if (!validation.ok) {
    throw new EditPreflightPromotionErrorV1(`${validation.code}: ${validation.reason}`);
  }
  if (content.operations.length === 0) {
    // §7.4: an empty plan settles as completed/noChanges — no edit session.
    return "noChanges";
  }
  const sealed = await getEditPlanBrokerV1().sealPlan({
    plan: content,
    ledger: preflight.ledger,
    correlation: context.correlation,
    rootId: input.rootId,
  });
  if (!sealed.ok) {
    throw new EditPreflightPromotionErrorV1(sealed.reason);
  }
  return "completed";
}

interface EditPreflightRowConfigV1 {
  readonly actionKey: string;
  readonly routes: readonly string[];
  readonly progressLabel: string;
  readonly loggingChannel: string;
}

function createEditPreflightRowV1(config: EditPreflightRowConfigV1): ProviderTaskActionRowV1 {
  return {
    kind: "provider",
    actionKey: config.actionKey,
    routes: config.routes,
    // Stage discipline stays with the command layer (as it is for these
    // actions today); every edit-capable action requires an active task.
    eligibility: { statuses: ["active"], stages: "anyStage" },
    requiresTaskOperationLease: true,
    progressLabel: config.progressLabel,
    validateInput: validateEditPreflightInputV1,
    loggingPolicy: { channel: config.loggingChannel, includeResultMetrics: true },
    providerMode: "preflight",
    maxResponseBytes: maxResponseBytesCeilingForModeV1("preflight"),
    // Questions are legal BEFORE any edit session (§7.3); §7.6 forbids them
    // only during edit execution, enforced on the editExecution.v1 row.
    permittedResultKinds: ["completed", "questions", "cancelled", "failed"],
    completedContentType: "preflight-plan.v1",
    resumeSemantics: "sameOperation",
    buildPrompt: (context) => (context.validatedInput as EditPreflightActionInputV1).prompt,
    promoteCompletedContent: promoteEditPreflightContentV1,
  };
}

export function createImplementationPreflightRowV1(): ProviderTaskActionRowV1 {
  return createEditPreflightRowV1({
    actionKey: IMPLEMENTATION_ACTION_KEY_V1,
    routes: ["vs-code-ai-helper.runImplementationWithAI"],
    progressLabel: "Planning implementation edits…",
    loggingChannel: "action.implementation",
  });
}

export function createFastForwardPreflightRowV1(): ProviderTaskActionRowV1 {
  return createEditPreflightRowV1({
    actionKey: FAST_FORWARD_ACTION_KEY_V1,
    routes: [
      "vs-code-ai-helper.fastForwardReviewWithAI",
      "vs-code-ai-helper.fastForwardCurrentTaskReview",
    ],
    progressLabel: "Planning fast-forward edits…",
    loggingChannel: "action.fastForward",
  });
}

export function createApplyReviewEditPreflightRowV1(): ProviderTaskActionRowV1 {
  return createEditPreflightRowV1({
    actionKey: APPLY_REVIEW_EDIT_ACTION_KEY_V1,
    // The user-facing apply-review command routes belong to the TEXT
    // applyReview.v1 row (route ids are globally unique); the edit-capable
    // branch is dispatched internally by reviewActions.ts.
    routes: ["internal:applyReviewEdit.v1"],
    progressLabel: "Planning review-fix edits…",
    loggingChannel: "action.applyReviewEdit",
  });
}

export function createLintPreflightRowV1(): ProviderTaskActionRowV1 {
  return createEditPreflightRowV1({
    actionKey: LINT_ACTION_KEY_V1,
    routes: ["vs-code-ai-helper.runLintingFixes"],
    progressLabel: "Planning lint fixes…",
    loggingChannel: "action.lint",
  });
}
