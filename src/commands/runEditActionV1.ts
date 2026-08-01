/**
 * Two-phase edit-action driver (plan §7.5/§7.6): the ONE path every
 * edit-capable action (implementation, Fast Forward, edit Apply Review, AI
 * lint fallback) takes after the §7.8 cutover.
 *
 * Phase 0 — §7.5 availability, BEFORE any task or source read:
 *   host floor (1.100.0) + runtime tool shapes → `hostToolApiUnavailable`;
 *   a Copilot-backed model path for this stage → `providerModeUnavailable`;
 *   workspace-root registration → `workspaceRootUnsupported` /
 *   `workspacePathUnsafe`. No standalone probing command exists.
 * Phase 1 — the preflight action (read tools only). Structured questions
 *   ride the ordinary question/Resume plumbing; `completed/noChanges`
 *   settles with no edit session (§7.4).
 * Phase 2 — a FRESH mutation-only conversation for the sealed plan: claim
 *   the execution permit (durable, claim-once), then drive
 *   `editExecution.v1`, whose prompt is the fixed contract + the canonical
 *   script and nothing else (§7.6). After settlement the broker's
 *   authoritative state maps non-completed executions onto
 *   `stalePreflight` / `partialEditBlocked` (§7.7) — never auto-retried.
 */
import * as vscode from "vscode";
import * as path from "path";
import { createHash } from "crypto";
import {
  createProductionTaskActionCoordinatorV1,
  getProductionActionConversationOrchestratorV1,
} from "../actions/productionTaskActionRuntimeV1";
import { ImplementationRunResult } from "../runners/copilotImplementationRunner";
import { readChatDocumentIdentityV1 } from "../utils/chatHistoryStore";
import { allocateHex128IdV1 } from "../types/actionCorrelationV1";
import {
  APPLY_REVIEW_EDIT_ACTION_KEY_V1,
  EditPreflightActionInputV1,
  FAST_FORWARD_ACTION_KEY_V1,
  IMPLEMENTATION_ACTION_KEY_V1,
  LINT_ACTION_KEY_V1,
} from "../actions/rows/editPreflightRowsV1";
import { EDIT_EXECUTION_ACTION_KEY_V1 } from "../actions/rows/editExecutionRowV1";
import { TaskActionOutcomeV1 } from "../types/taskActionOutcomeV1";
import { TaskStage } from "../types/taskProgress";
import {
  computeWorkspaceRootBindingIdV1,
  ensureWorkflowTaskFolderRootV1,
  ensureWorkflowWorkspaceRootV1,
  getEditPlanBrokerV1,
  getVerifiedTaskBindingIdV1,
} from "../services/workflowRuntimeServicesV1";
import { probeLmToolCallingHostCapabilityV1, VscodeLmModuleV1 } from "../services/vscodeLmCompat";
import { resolveEffectiveProvider } from "../runners/runnerRegistry";
import { resolveFreshModelForStage } from "../utils/modelSelection";
import { writeRunLog } from "../utils/runLog";
import { NotificationRouter } from "../utils/notificationRouter";
import type { TaskInventory } from "../state/taskInventory";
import type {
  ChatViewProvider,
  ChatInteractionRefV1,
  ChatInteractionResumeResultV1,
} from "../views/chatView";
import type { InteractionRefV1 } from "../actions/actionConversationOrchestratorV1";

/** §7.5's host floor for request-local preflight/edit (workflow-inventories/lm-host-capability-v1.json). */
export const EDIT_ACTION_HOST_FLOOR_V1 = "1.100.0";

export type EditActionAvailabilityV1 =
  | { readonly ok: true; readonly rootId: string; readonly rootBindingId: string }
  | {
      readonly ok: false;
      readonly code:
        | "hostToolApiUnavailable"
        | "providerModeUnavailable"
        | "workspaceRootUnsupported"
        | "workspacePathUnsafe";
      readonly reason: string;
    };

function hostVersionAtLeast(version: unknown, floor: string): boolean {
  if (typeof version !== "string" || version.length === 0) {
    return false;
  }
  const parse = (value: string): number[] => value.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(version);
  const b = parse(floor);
  for (let i = 0; i < 3; i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) {
      return left > right;
    }
  }
  return true;
}

/**
 * The task/model-INDEPENDENT half of the §7.5 gate: host floor + runtime
 * tool-shape probe. Public edit handlers call this as their first statement
 * — before consent, task resolution, or any artifact read — so a 1.93 host
 * returns `hostToolApiUnavailable` before any task/source read (AC-HOST-03).
 */
export function checkEditActionHostGateV1():
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "hostToolApiUnavailable"; readonly reason: string } {
  if (!hostVersionAtLeast(vscode.version, EDIT_ACTION_HOST_FLOOR_V1)) {
    return {
      ok: false,
      code: "hostToolApiUnavailable",
      reason: `VS Code ${EDIT_ACTION_HOST_FLOOR_V1}+ is required for AI-assisted edits (running ${vscode.version}).`,
    };
  }
  const capability = probeLmToolCallingHostCapabilityV1(vscode as unknown as VscodeLmModuleV1);
  if (!capability.supported) {
    return { ok: false, code: "hostToolApiUnavailable", reason: capability.reason };
  }
  return { ok: true };
}

/**
 * §7.5: checked by the command wrapper BEFORE any task or source read.
 * `stageModelId` is the stage's stored (provider-qualified) model id — the
 * check requires at least one Copilot-backed path (CLI providers cannot run
 * request-local tool sessions; §7.5 requires the absence of a
 * general-workspace CLI edit path).
 */
export function checkEditActionAvailabilityV1(options: {
  readonly workspaceFsPath: string;
  readonly stageModelId: string | undefined;
}): EditActionAvailabilityV1 {
  if (!hostVersionAtLeast(vscode.version, EDIT_ACTION_HOST_FLOOR_V1)) {
    return {
      ok: false,
      code: "hostToolApiUnavailable",
      reason: `VS Code ${EDIT_ACTION_HOST_FLOOR_V1}+ is required for AI-assisted edits (running ${vscode.version}).`,
    };
  }
  const capability = probeLmToolCallingHostCapabilityV1(vscode as unknown as VscodeLmModuleV1);
  if (!capability.supported) {
    return { ok: false, code: "hostToolApiUnavailable", reason: capability.reason };
  }
  try {
    const effective = resolveEffectiveProvider(options.stageModelId);
    if (effective.kind !== "copilot") {
      return {
        ok: false,
        code: "providerModeUnavailable",
        reason:
          "AI-assisted edits run through the request-local Copilot Language Model tool session — " +
          "configure a Copilot model for this stage (CLI providers cannot run sealed edit sessions).",
      };
    }
  } catch (error) {
    return {
      ok: false,
      code: "providerModeUnavailable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  let rootId: string;
  try {
    rootId = ensureWorkflowWorkspaceRootV1(options.workspaceFsPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      code: message.startsWith("workspacePathUnsafe") ? "workspacePathUnsafe" : "workspaceRootUnsupported",
      reason: message,
    };
  }
  return {
    ok: true,
    rootId,
    rootBindingId: computeWorkspaceRootBindingIdV1(rootId, options.workspaceFsPath),
  };
}

export type TwoPhaseEditResultV1 =
  | {
      readonly kind: "completed";
      readonly appliedReceiptIds: readonly string[];
      /** Workspace-relative FILE paths the sealed plan wrote or deleted. */
      readonly changedPaths: readonly string[];
    }
  | { readonly kind: "noChanges" }
  | { readonly kind: "questions"; readonly outcome: TaskActionOutcomeV1 }
  | {
      readonly kind: "unavailable";
      readonly code:
        | "hostToolApiUnavailable"
        | "providerModeUnavailable"
        | "workspaceRootUnsupported"
        | "workspacePathUnsafe";
      readonly reason: string;
    }
  | { readonly kind: "stalePreflight"; readonly reason: string }
  | {
      readonly kind: "partialEditBlocked";
      readonly appliedReceiptIds: readonly string[];
      /** File paths of the steps that verifiably applied before the block. */
      readonly changedPaths: readonly string[];
      readonly reason: string;
    }
  | { readonly kind: "failed"; readonly outcome: TaskActionOutcomeV1 };

export interface RunTwoPhaseEditOptionsV1 {
  readonly actionKey: string;
  /** Fully-rendered action prompt (task/plan/review/lint context). */
  readonly prompt: string;
  readonly taskBinding: { readonly taskBindingId: string; readonly chatDocumentId: string };
  readonly taskStatus: string;
  readonly taskStage: string;
  readonly workspaceCwd: string;
  readonly resolveStagePrimaryModel: (
    taskStage: string
  ) => { readonly modelId: string | undefined; readonly stage: TaskStage | undefined };
  readonly stageModelId: string | undefined;
  readonly cancellationToken: vscode.CancellationToken;
}

/** SHA-256 the plan must echo (§7.3): digest of the exact prompt bytes. */
export function computeEditRequestDigestV1(prompt: string): string {
  return createHash("sha256").update(prompt, "utf8").digest("hex");
}

/**
 * Drive preflight → (sealed plan) → edit execution. Availability is checked
 * FIRST — before any task or source read happens on this path.
 */
export async function runTwoPhaseEditActionV1(
  options: RunTwoPhaseEditOptionsV1
): Promise<TwoPhaseEditResultV1> {
  const availability = checkEditActionAvailabilityV1({
    workspaceFsPath: options.workspaceCwd,
    stageModelId: options.stageModelId,
  });
  if (!availability.ok) {
    return { kind: "unavailable", code: availability.code, reason: availability.reason };
  }

  const coordinator = createProductionTaskActionCoordinatorV1({
    workspaceCwd: options.workspaceCwd,
    resolveStagePrimaryModel: options.resolveStagePrimaryModel,
  });

  const preflightInput: EditPreflightActionInputV1 = {
    prompt: options.prompt,
    rootId: availability.rootId,
    rootBindingId: availability.rootBindingId,
    requestDigest: computeEditRequestDigestV1(options.prompt),
  };
  const preflightOutcome = await coordinator.executeAction({
    actionKey: options.actionKey,
    taskBinding: options.taskBinding,
    taskStatus: options.taskStatus,
    taskStage: options.taskStage,
    rawInput: preflightInput as unknown as Record<string, unknown>,
    cancellationToken: options.cancellationToken,
  });

  if (preflightOutcome.kind === "questions") {
    return { kind: "questions", outcome: preflightOutcome };
  }
  if (preflightOutcome.kind !== "completed") {
    return { kind: "failed", outcome: preflightOutcome };
  }
  if (preflightOutcome.code === "noChanges") {
    // §7.4: an empty plan settles as completed/noChanges — no edit session.
    return { kind: "noChanges" };
  }

  return continueSealedEditExecutionV1(coordinator, preflightOutcome.correlation.operationId, options);
}

/**
 * Phase 2, shared by fresh runs and Resume drives: claim the sealed plan's
 * permit and run the mutation-only session.
 */
export async function continueSealedEditExecutionV1(
  coordinator: ReturnType<typeof createProductionTaskActionCoordinatorV1>,
  preflightOperationId: string,
  options: Pick<
    RunTwoPhaseEditOptionsV1,
    "taskBinding" | "taskStatus" | "taskStage" | "cancellationToken"
  >
): Promise<TwoPhaseEditResultV1> {
  const broker = getEditPlanBrokerV1();
  const sealed = broker.sealedExecutionForOperation(preflightOperationId);
  if (!sealed) {
    return {
      kind: "stalePreflight",
      reason: "No sealed plan exists for this preflight — run the action again.",
    };
  }
  const claim = await broker.claimExecutionPermit(sealed.executionId);
  if (!claim.ok) {
    return {
      kind: "stalePreflight",
      reason:
        claim.code === "permitAlreadyClaimed"
          ? "This plan's execution permit was already claimed — a sealed plan executes at most once."
          : "The execution permit could not be recorded.",
    };
  }

  const editOutcome = await coordinator.executeAction({
    actionKey: EDIT_EXECUTION_ACTION_KEY_V1,
    taskBinding: options.taskBinding,
    taskStatus: options.taskStatus,
    taskStage: options.taskStage,
    rawInput: { executionId: sealed.executionId },
    cancellationToken: options.cancellationToken,
  });

  // FILE paths only (created/replaced/deleted) — directory-only steps are
  // not "files changed" in the ImplementationRunResult sense.
  const filePathOfStep = (index: number): string | undefined => {
    const operation = sealed.operations[index];
    if (!operation) {
      return undefined;
    }
    return operation.kind === "createFile" ||
      operation.kind === "replaceFile" ||
      operation.kind === "deleteFile"
      ? operation.relativePath
      : undefined;
  };
  const changedPathsForApplied = (count: number): string[] => {
    const paths: string[] = [];
    for (let i = 0; i < count; i++) {
      const filePath = filePathOfStep(i);
      if (filePath !== undefined) {
        paths.push(filePath);
      }
    }
    return paths;
  };

  const execution = broker.executionOutcome(sealed.executionId);
  if (editOutcome.kind === "completed" && execution?.state === "completed") {
    return {
      kind: "completed",
      appliedReceiptIds: execution.appliedReceiptIds,
      changedPaths: changedPathsForApplied(sealed.operations.length),
    };
  }
  // §7.7: the broker's authoritative state — not the provider's own story —
  // decides how a non-clean execution surfaces.
  if (execution?.state === "partialEditBlocked" || (execution?.appliedReceiptIds.length ?? 0) > 0) {
    const appliedReceiptIds = execution?.appliedReceiptIds ?? [];
    return {
      kind: "partialEditBlocked",
      appliedReceiptIds,
      changedPaths: changedPathsForApplied(appliedReceiptIds.length),
      reason:
        "The edit session stopped after some steps were verified and applied. Applied edits remain in place; " +
        "review them and run a fresh preflight for the remainder.",
    };
  }
  if (execution?.state === "stalePreflight" || execution?.state === "executing" || execution?.state === "sealed") {
    return {
      kind: "stalePreflight",
      reason: "The workspace changed after preflight — no edits were applied. Run the action again.",
    };
  }
  return { kind: "failed", outcome: editOutcome };
}

// ---------------------------------------------------------------------------
// §7.8 cutover adapter: the drop-in replacement for the retired
// runImplementationForModel call sites (executeImplementationRun in
// reviewActions.ts, runLintingFixes.ts). Keeps the ImplementationRunResult
// contract those flows render (run logs, filesChanged review scope,
// warnings), while the underlying execution is the sealed two-phase
// pipeline. Provider/model fallback now lives in the coordinator's ranked
// selection, superseding the legacy in-runner cascade.
// ---------------------------------------------------------------------------

/** Canonical identity key rule used by CurrentTaskStore/TaskInventory. */
function canonicalPathKey(fsPath: string): string {
  const normalized = path.normalize(fsPath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export interface RunSealedImplementationOptionsV1 {
  /** The registry action key of the edit-capable action being run. */
  readonly editActionKey: string;
  readonly modelId: string | undefined;
  readonly prompt: string;
  readonly workspaceUri: vscode.Uri;
  readonly token: vscode.CancellationToken;
  readonly onProgress: (message: string) => void;
  /** Model/quota stage — the stage whose configured model runs the session. */
  readonly stage?: TaskStage;
  /**
   * The task's ACTUAL current stage, used for registry-row eligibility
   * (editPreflightRowsV1 declares real stage lists). Defaults to `stage`.
   */
  readonly taskStage?: TaskStage;
  readonly taskFolderUri?: vscode.Uri;
  /** Mirrors the retired runner option: false lets a no-op plan complete. */
  readonly requireFileChange?: boolean;
  /**
   * Invoked when the preflight returns structured questions, BEFORE the
   * failed-status result is returned — call sites mirror the persisted
   * interaction into task-local Chat (askInteraction) here so the question
   * gets its full Answer/Resume lifecycle (AC-PREFLIGHT-04, AC-QUESTION-02).
   */
  readonly onQuestions?: (outcome: TaskActionOutcomeV1 & { kind: "questions" }) => Promise<void>;
}

export async function runSealedImplementationV1(
  options: RunSealedImplementationOptionsV1
): Promise<ImplementationRunResult & { runnerId: string }> {
  // §7.5: the FULL availability gate runs before this adapter reads anything
  // at all — including the task's Chat identity and ownership binding below.
  const availability = checkEditActionAvailabilityV1({
    workspaceFsPath: options.workspaceUri.fsPath,
    stageModelId: options.modelId,
  });
  if (!availability.ok) {
    return {
      status: "failed",
      filesChanged: [],
      failureKind: "temporarily-unavailable",
      errorMessage: availability.reason,
      runnerId: "copilot-lm",
    };
  }

  options.onProgress("Preflighting edits (read-only)...");

  // §3.9: the coordinator correlates against the ownership-DERIVED binding
  // digest, never a raw filesystem path (which would leak local paths into
  // provider correlation, leases, and audit records). Task-scoped runs
  // derive it from the strict progress ownership record; workspace-scoped
  // runs use the workspace-root binding digest from the availability gate.
  let taskBindingId: string;
  if (options.taskFolderUri) {
    try {
      const taskRootId = ensureWorkflowTaskFolderRootV1(options.taskFolderUri.fsPath);
      const verified = getVerifiedTaskBindingIdV1(taskRootId);
      if (!verified) {
        return {
          status: "failed",
          filesChanged: [],
          failureKind: "generic",
          errorMessage:
            "This task's ownership binding could not be verified — its task-progress.json needs recovery before AI edits can run.",
          runnerId: "copilot-lm",
        };
      }
      taskBindingId = verified;
    } catch (error) {
      return {
        status: "failed",
        filesChanged: [],
        failureKind: "generic",
        errorMessage: error instanceof Error ? error.message : String(error),
        runnerId: "copilot-lm",
      };
    }
  } else {
    taskBindingId = availability.rootBindingId;
  }

  let chatDocumentId: string;
  try {
    const identity = options.taskFolderUri
      ? await readChatDocumentIdentityV1(
          options.taskFolderUri.fsPath,
          canonicalPathKey(options.taskFolderUri.fsPath)
        )
      : undefined;
    chatDocumentId = identity?.documentId ?? allocateHex128IdV1();
  } catch {
    chatDocumentId = allocateHex128IdV1();
  }

  const stage = options.stage ?? "impl";
  const result = await runTwoPhaseEditActionV1({
    actionKey: options.editActionKey,
    prompt: options.prompt,
    taskBinding: { taskBindingId, chatDocumentId },
    taskStatus: "active",
    taskStage: options.taskStage ?? stage,
    workspaceCwd: options.workspaceUri.fsPath,
    resolveStagePrimaryModel: () => ({ modelId: options.modelId, stage }),
    stageModelId: options.modelId,
    cancellationToken: options.token,
  });

  const runnerId = "copilot-lm";
  switch (result.kind) {
    case "completed":
      options.onProgress("Applied sealed edit plan.");
      return {
        status: "completed",
        filesChanged: [...result.changedPaths],
        summary:
          `Applied ${result.appliedReceiptIds.length} sealed edit step(s) with ordered receipts ` +
          `(${result.changedPaths.length} file(s) changed).`,
        runnerId,
      };
    case "noChanges":
      if (options.requireFileChange === false) {
        return {
          status: "completed",
          filesChanged: [],
          summary: "The preflight produced an empty plan — no changes were needed.",
          runnerId,
        };
      }
      return {
        status: "failed",
        filesChanged: [],
        failureKind: "generic",
        errorMessage:
          "The preflight produced no file changes. Review the prompt/plan and run the action again.",
        runnerId,
      };
    case "questions":
      // The durable Chat interaction transaction is already persisted (the
      // coordinator wrote it through before this outcome surfaced); the call
      // site mirrors it into task-local Chat so Answer/Resume work (§5.5).
      if (options.onQuestions) {
        await options.onQuestions(result.outcome as TaskActionOutcomeV1 & { kind: "questions" });
      }
      return {
        status: "failed",
        filesChanged: [],
        failureKind: "generic",
        errorMessage:
          "The AI returned structured questions instead of an edit plan. Answer them in Chat With AI and use Resume there to continue.",
        runnerId,
      };
    case "unavailable":
      return {
        status: "failed",
        filesChanged: [],
        failureKind: "temporarily-unavailable",
        errorMessage: result.reason,
        runnerId,
      };
    case "stalePreflight":
      return {
        status: "failed",
        filesChanged: [],
        failureKind: "generic",
        errorMessage: result.reason,
        runnerId,
      };
    case "partialEditBlocked":
      return {
        status: "failed",
        filesChanged: [...result.changedPaths],
        failureKind: "generic",
        errorMessage: result.reason,
        runnerId,
      };
    case "failed": {
      if (result.outcome.kind === "cancelled") {
        return { status: "cancelled", filesChanged: [], runnerId };
      }
      const code =
        result.outcome.kind === "failed" || result.outcome.kind === "unavailable"
          ? result.outcome.code
          : result.outcome.kind;
      return {
        status: "failed",
        filesChanged: [],
        failureKind: "generic",
        errorMessage: `The edit action did not complete (${code}).`,
        runnerId,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Explicit Chat Resume for edit-preflight structured questions (plan §5.5 /
// §7.3 / AC-PREFLIGHT-04 / AC-QUESTION-03): the extension.ts interaction
// dispatcher routes the four edit action keys here. Resume follows the rows'
// declared `sameOperation` semantics — the coordinator reconstructs the
// action from the persisted transaction's validated input snapshot and runs
// a FRESH attempt, whose read session mints a fresh observation baseline; a
// sealed plan then continues into the mutation session exactly like a fresh
// invocation.
// ---------------------------------------------------------------------------

const EDIT_PREFLIGHT_ACTION_KEYS_V1: readonly string[] = [
  IMPLEMENTATION_ACTION_KEY_V1,
  FAST_FORWARD_ACTION_KEY_V1,
  APPLY_REVIEW_EDIT_ACTION_KEY_V1,
  LINT_ACTION_KEY_V1,
];

export function isEditPreflightActionKeyV1(actionKey: string): boolean {
  return EDIT_PREFLIGHT_ACTION_KEYS_V1.includes(actionKey);
}

/** Model/quota stage for an edit action key (lint runs on the Publish model). */
function modelStageForEditActionKeyV1(actionKey: string): TaskStage {
  return actionKey === LINT_ACTION_KEY_V1 ? "publish" : "impl";
}

export async function resumeEditPreflightInteractionV1(
  inventory: TaskInventory,
  chatViewProvider: ChatViewProvider,
  ref: ChatInteractionRefV1,
  resumeIdempotencyId: string,
  cancellationToken: vscode.CancellationToken
): Promise<ChatInteractionResumeResultV1> {
  const ownedTask = inventory.getTaskByBindingId(ref.taskBindingId);
  if (!ownedTask) {
    return { ok: false, reason: "the task that asked this question could not be found" };
  }
  const workspaceFolderUri = ownedTask.workspaceFolder;
  if (!workspaceFolderUri) {
    return { ok: false, reason: "the task has no owning workspace" };
  }
  const taskFolderUri = vscode.Uri.file(ownedTask.taskFolderPath);

  const orchestrator = getProductionActionConversationOrchestratorV1();
  const interactionRef: InteractionRefV1 = {
    operationId: ref.operationId,
    interactionId: ref.interactionId,
    taskBindingId: ref.taskBindingId,
    chatDocumentId: ref.chatDocumentId,
    sourceAttemptId: ref.sourceAttemptId,
  };
  const loaded = await orchestrator.loadInteraction(interactionRef);
  if (loaded.kind !== "ok") {
    return {
      ok: false,
      reason: loaded.kind === "storageUnavailable" ? "workflow storage is unavailable" : loaded.reason,
    };
  }
  const actionKey = loaded.record.correlation.actionKey;
  if (!isEditPreflightActionKeyV1(actionKey)) {
    return { ok: false, reason: `unexpected action key ${actionKey} for an edit-preflight Resume` };
  }

  // §7.5 applies to Resume drives too: gate before any further task or
  // source read (the strict inventory lookup above is the binding lookup the
  // transaction revalidation itself requires).
  const modelStage = modelStageForEditActionKeyV1(actionKey);
  const model = await resolveFreshModelForStage(taskFolderUri, modelStage);
  const availability = checkEditActionAvailabilityV1({
    workspaceFsPath: workspaceFolderUri.fsPath,
    stageModelId: model.modelId,
  });
  if (!availability.ok) {
    return { ok: false, reason: availability.reason };
  }

  const coordinator = createProductionTaskActionCoordinatorV1({
    workspaceCwd: workspaceFolderUri.fsPath,
    resolveStagePrimaryModel: () => ({ modelId: model.modelId, stage: modelStage }),
  });

  const outcome = await coordinator.resumeAction({
    interaction: interactionRef,
    taskBinding: { taskBindingId: ref.taskBindingId, chatDocumentId: ref.chatDocumentId },
    taskStatus: ownedTask.progress.status ?? "active",
    taskStage: ownedTask.progress.currentStage,
    resumeIdempotencyId,
    cancellationToken,
  });

  if (outcome.kind === "questions") {
    // The resumed attempt asked again — mirror the NEW persisted interaction
    // into task-local Chat exactly like a fresh invocation would.
    const record = await orchestrator.getRecord({
      operationId: outcome.correlation.operationId,
      interactionId: outcome.interactionId,
      taskBindingId: outcome.correlation.taskBindingId,
      chatDocumentId: outcome.correlation.chatDocumentId,
      sourceAttemptId: outcome.correlation.attemptId,
    });
    if (record) {
      await chatViewProvider.askInteraction({
        canonicalId: ownedTask.canonicalId ?? ownedTask.taskFolderPath,
        taskFolderPath: ownedTask.taskFolderPath,
        stage: record.stage,
        taskName: ownedTask.progress.displayName,
        interactionId: record.interactionId,
        operationId: record.correlation.operationId,
        actionKey: record.correlation.actionKey,
        sourceAttemptId: record.correlation.attemptId,
        // safe: loaded via a "questions" outcome, so questions are posted.
        questions: record.questions!,
        binding: {
          taskBindingId: record.correlation.taskBindingId,
          chatDocumentId: record.correlation.chatDocumentId,
        },
      });
    }
  } else if (outcome.kind === "completed" && outcome.code === "noChanges") {
    NotificationRouter.showInformation(
      "Resumed edit preflight produced an empty plan — no changes were needed."
    );
  } else if (outcome.kind === "completed") {
    // A sealed plan exists for the resumed attempt: continue into the
    // mutation-only session exactly like a fresh two-phase run.
    const execution = await continueSealedEditExecutionV1(
      coordinator,
      outcome.correlation.operationId,
      {
        taskBinding: { taskBindingId: ref.taskBindingId, chatDocumentId: ref.chatDocumentId },
        taskStatus: ownedTask.progress.status ?? "active",
        taskStage: ownedTask.progress.currentStage,
        cancellationToken,
      }
    );
    const logContent =
      `# Resumed ${actionKey} run\n\nResult: ${execution.kind}\n\n` +
      ("changedPaths" in execution && execution.changedPaths.length > 0
        ? `Files changed:\n${execution.changedPaths.map((p) => `- ${p}`).join("\n")}`
        : "_no files changed_");
    const logUri = await writeRunLog(taskFolderUri, "copilot-lm", modelStage, logContent);
    if (execution.kind === "completed") {
      NotificationRouter.showInformation(
        `Resumed ${actionKey}: applied ${execution.appliedReceiptIds.length} sealed edit step(s) ` +
          `(${execution.changedPaths.length} file(s) changed).`
      );
    } else {
      const reason =
        "reason" in execution
          ? execution.reason
          : execution.kind === "failed" && execution.outcome.kind === "cancelled"
            ? "the edit session was cancelled"
            : "the edit session did not complete";
      NotificationRouter.showWarning(`Resumed ${actionKey} did not apply cleanly: ${reason}`);
      await vscode.window.showTextDocument(logUri, { preview: true }).then(
        () => undefined,
        () => undefined
      );
    }
  } else if (outcome.kind === "cancelled") {
    NotificationRouter.showInformation("Resumed edit preflight was cancelled.");
  } else {
    NotificationRouter.showWarning(
      `Resumed edit preflight failed (${outcome.kind === "failed" || outcome.kind === "unavailable" ? outcome.code : outcome.kind}).`
    );
  }

  // Report the ORIGINAL interaction's actual settlement (re-read after
  // resumeAction): a resumed run that itself asks again, fails, or is
  // cancelled still means the interaction being resumed settled exactly once
  // (plan §5.5) — only a rejection BEFORE settlement leaves it resumable.
  const after = await orchestrator.loadInteraction(interactionRef);
  if (
    after.kind === "ok" &&
    after.record.state === "settled" &&
    (after.record.settlement === "resumed" ||
      after.record.settlement === "supersededByReplacementOperation")
  ) {
    return { ok: true, settlement: after.record.settlement };
  }
  return { ok: false, reason: "the interaction did not settle for this Resume — it may already be settled or still awaiting answers" };
}
