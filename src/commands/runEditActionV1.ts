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
} from "../actions/productionTaskActionRuntimeV1";
import { ImplementationRunResult } from "../runners/copilotImplementationRunner";
import { readChatDocumentIdentityV1 } from "../utils/chatHistoryStore";
import { allocateHex128IdV1 } from "../types/actionCorrelationV1";
import { EditPreflightActionInputV1 } from "../actions/rows/editPreflightRowsV1";
import { EDIT_EXECUTION_ACTION_KEY_V1 } from "../actions/rows/editExecutionRowV1";
import { TaskActionOutcomeV1 } from "../types/taskActionOutcomeV1";
import { TaskStage } from "../types/taskProgress";
import {
  computeWorkspaceRootBindingIdV1,
  ensureWorkflowWorkspaceRootV1,
  getEditPlanBrokerV1,
} from "../services/workflowRuntimeServicesV1";
import { probeLmToolCallingHostCapabilityV1, VscodeLmModuleV1 } from "../services/vscodeLmCompat";
import { resolveEffectiveProvider } from "../runners/runnerRegistry";

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
  readonly stage?: TaskStage;
  readonly taskFolderUri?: vscode.Uri;
  /** Mirrors the retired runner option: false lets a no-op plan complete. */
  readonly requireFileChange?: boolean;
}

export async function runSealedImplementationV1(
  options: RunSealedImplementationOptionsV1
): Promise<ImplementationRunResult & { runnerId: string }> {
  options.onProgress("Preflighting edits (read-only)...");

  const taskBindingId = options.taskFolderUri
    ? canonicalPathKey(options.taskFolderUri.fsPath)
    : `workspace:${canonicalPathKey(options.workspaceUri.fsPath)}`;
  let chatDocumentId: string;
  try {
    const identity = options.taskFolderUri
      ? await readChatDocumentIdentityV1(options.taskFolderUri.fsPath, taskBindingId)
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
    taskStage: stage,
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
      return {
        status: "failed",
        filesChanged: [],
        failureKind: "generic",
        errorMessage:
          "The AI returned structured questions instead of an edit plan. Answer them in Chat With AI and resume the action.",
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
