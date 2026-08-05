/**
 * Two-phase edit-action driver (plan §7.5/§7.6) for every edit-capable
 * action (implementation, Fast Forward, edit Apply Review, AI lint
 * fallback) after the §7.8 cutover. This drives the Copilot-only sealed
 * pipeline; `runImplementationOrSealedV1` below is the actual entry point
 * callers use — it routes a CLI-resolved stage model to its own direct
 * edit-mode invocation instead, since CLI providers cannot join a
 * request-local `vscode.lm` tool session at all.
 *
 * Phase 0 — §7.5 availability, BEFORE any task or source read:
 *   host floor (1.100.0) + runtime tool shapes → `hostToolApiUnavailable`
 *   (Copilot-resolved stages only; skipped for CLI — see
 *   `checkEditActionAvailabilityV1`); an unresolvable model for this stage
 *   → `providerModeUnavailable`; workspace-root registration →
 *   `workspaceRootUnsupported` / `workspacePathUnsafe`. No standalone
 *   probing command exists.
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
import {
  backupModelsForStage,
  checkImplementationAvailabilityForModel,
  recordActiveFallbackModel,
  resolveEffectiveProvider,
  runImplementationForModel,
} from "../runners/runnerRegistry";
import { isAuthenticationFailure } from "../utils/quota";
import { resolveFreshModelForStage } from "../utils/modelSelection";
import { getAiModelDefaults, getModelSettings } from "../config/settings";
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
 * Task/model-INDEPENDENT half of "this stage has a runnable edit path":
 * resolves `stage`'s globally configured primary model — the model the
 * calling edit action actually resolves against (Implementation, Fast
 * Forward, and Apply Review Edit all call `resolveFreshModelForStage(...,
 * "impl")`; the AI lint fallback, the one edit action whose registry row is
 * scoped to `["publish"]`, calls `resolveFreshModelForStage(..., "publish")`
 * — see `modelStageForEditActionKeyV1` in runEditActionV1.ts) — but the
 * PRIMARY alone is not what will actually run: `runImplementationOrSealedV1`
 * falls through to a configured backup when the primary is unavailable, and
 * that backup can be Copilot even when the primary is CLI. Checking only the
 * primary's kind here (Codex review finding, this round) let a CLI-primary/
 * Copilot-backup stage skip the host-floor/LM-tool check entirely — the
 * mismatch then surfaced only much later, inside runImplementationOrSealedV1
 * itself, after resolveTask and every artifact/context-pack read this
 * function exists to precede (§7.5/AC-HOST-03). This function therefore
 * calls `checkImplementationAvailabilityForModel` — the SAME availability
 * resolution `runImplementationOrSealedV1` itself uses — to find the WINNING
 * candidate (the primary if live, else the first available configured
 * backup, of either kind) before deciding whether a host check applies.
 * Copilot runs the sealed two-phase pipeline (§7.5-§7.7); CLI providers run
 * their own direct edit-mode invocation (see `runImplementationOrSealedV1`)
 * — both are valid, so this only rejects a stage with no available candidate
 * at all.
 *
 * Reads ONLY global settings to resolve the STARTING (primary) model id —
 * no `taskFolderUri`, so no per-task read for that half — because
 * `resolveFreshModelForStage` always calls `resolveModelForStage` with
 * `ignoreActiveFallback: true`, whose returned model id is exactly
 * `getModelSettings()[stage]?.primary ?? getAiModelDefaults()[stage]`
 * regardless of any task's own state; the per-task read it performs is
 * solely to clear a stale fallback flag, a side effect this coarse pre-check
 * does not need to reproduce. The availability resolution itself IS I/O (a
 * CLI existence probe, or a Copilot model-list probe) — this function is no
 * longer zero-I/O, but every byte of that I/O is provider-liveness plumbing
 * that never touches this task's own files.
 *
 * Command handlers call this as their first real check — before
 * `resolveTask` or any other task read — so an unresolvable/unavailable
 * model, or (for a Copilot-resolved winning candidate) a pre-1.100 host, is
 * rejected before any task/source read (§7.5). This function alone replaces
 * the old `checkEditActionHostGateV1()`-then-`checkEditActionProviderPathGateV1()`
 * pair: calling the host gate unconditionally, before the provider is even
 * known, incorrectly rejected a CLI-resolved stage on a host missing the
 * Copilot LM tool API — an API that stage's execution path never touches.
 * Resolving the provider FIRST and only then conditionally requiring the
 * host floor is what makes the CLI path actually reachable on such a host.
 * `checkEditActionHostGateV1()` itself is kept exported for the few
 * defense-in-depth call sites that already have a specific resolved model in
 * scope and can make their own copilot-only decision around it. Callers MUST
 * pass the stage the invoked action key actually resolves its model
 * against — passing the wrong stage (e.g. defaulting every caller to
 * `"impl"`) can reject an otherwise-valid action solely because an unrelated
 * stage's model is unconfigured or (if Copilot-resolved) needs a newer host.
 * This is a coarse pre-check, not a replacement for
 * `checkEditActionAvailabilityV1`: the exact per-task capability (plus the
 * workspace-root check, which genuinely needs the resolved task's ownership)
 * is still revalidated by that function immediately before the first source
 * read (§7.6).
 */
export async function checkEditActionProviderPathGateV1(
  stage: TaskStage
): Promise<
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: "providerModeUnavailable" | "hostToolApiUnavailable";
      readonly reason: string;
    }
> {
  const modelId = getModelSettings()[stage]?.primary ?? getAiModelDefaults()[stage];
  // checkImplementationAvailabilityForModel calls resolveEffectiveProvider(modelId)
  // unguarded internally (runnerRegistry.ts) — an unresolvable/unconfigured
  // modelId throws OUT of it rather than returning a clean unavailable
  // result, so it is checked here first, exactly as runImplementationOrSealedV1
  // already does before its own call to the same function.
  try {
    resolveEffectiveProvider(modelId);
  } catch (error) {
    return {
      ok: false,
      code: "providerModeUnavailable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  const availability = await checkImplementationAvailabilityForModel(modelId, stage);
  if (!availability.availability.available) {
    return {
      ok: false,
      code: "providerModeUnavailable",
      reason: availability.availability.reason ?? `${availability.providerLabel} is unavailable.`,
    };
  }
  let usesCopilot: boolean;
  try {
    usesCopilot = resolveEffectiveProvider(availability.modelId).kind === "copilot";
  } catch (error) {
    return {
      ok: false,
      code: "providerModeUnavailable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (usesCopilot) {
    return checkEditActionHostGateV1();
  }
  return { ok: true };
}

/**
 * §7.5: checked by the command wrapper BEFORE any task or source read.
 * `stageModelId` is the stage's stored (provider-qualified) model id — the
 * STARTING candidate, not necessarily the one that actually runs.
 *
 * Codex review finding: this used to decide `usesCopilot` from
 * `stageModelId` alone, so a Copilot-primary/CLI-backup stage with an
 * unavailable Copilot primary still required the host floor/LM-tool
 * capability here — rejecting a run `runImplementationOrSealedV1` would have
 * happily dispatched to the live CLI backup, never touching Copilot at all.
 * This now resolves the WINNING candidate first (the same
 * `checkImplementationAvailabilityForModel` call `checkEditActionProviderPathGateV1`
 * and `runImplementationOrSealedV1` themselves use — the primary if live,
 * else the first available configured backup, of either kind) and decides
 * `usesCopilot` from THAT, mirroring `checkEditActionProviderPathGateV1`'s
 * already-winner-aware pattern. `stage` must be the same model stage
 * `stageModelId` was resolved against (e.g. "impl" for every edit action
 * except the AI lint fallback's "publish"), since backup resolution is
 * scoped per stage. A CLI provider never touches `vscode.lm` — it edits the
 * workspace directly via `runImplementationOrSealedV1`'s CLI branch — so the
 * host-version/LM-tool probe below (which exists solely to prove the sealed
 * pipeline's request-local tool-calling API is usable) is skipped when the
 * winning candidate is CLI-resolved; only an unresolvable/unavailable model
 * (across the primary and every configured backup) fails this gate.
 */
export async function checkEditActionAvailabilityV1(options: {
  readonly workspaceFsPath: string;
  readonly stageModelId: string | undefined;
  readonly stage: TaskStage;
}): Promise<EditActionAvailabilityV1> {
  const availability = await checkImplementationAvailabilityForModel(options.stageModelId, options.stage);
  if (!availability.availability.available) {
    return {
      ok: false,
      code: "providerModeUnavailable",
      reason: availability.availability.reason ?? `${availability.providerLabel} is unavailable.`,
    };
  }
  let usesCopilot: boolean;
  try {
    usesCopilot = resolveEffectiveProvider(availability.modelId).kind === "copilot";
  } catch (error) {
    return {
      ok: false,
      code: "providerModeUnavailable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (usesCopilot) {
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
  /** The model/quota stage `stageModelId` was resolved against — see checkEditActionAvailabilityV1's `stage` param. */
  readonly modelStage: TaskStage;
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
  const availability = await checkEditActionAvailabilityV1({
    workspaceFsPath: options.workspaceCwd,
    stageModelId: options.stageModelId,
    stage: options.modelStage,
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
  const stage = options.stage ?? "impl";
  // §7.5: the FULL availability gate runs before this adapter reads anything
  // at all — including the task's Chat identity and ownership binding below.
  const availability = await checkEditActionAvailabilityV1({
    workspaceFsPath: options.workspaceUri.fsPath,
    stageModelId: options.modelId,
    stage,
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

  const result = await runTwoPhaseEditActionV1({
    actionKey: options.editActionKey,
    prompt: options.prompt,
    taskBinding: { taskBindingId, chatDocumentId },
    taskStatus: "active",
    taskStage: options.taskStage ?? stage,
    workspaceCwd: options.workspaceUri.fsPath,
    resolveStagePrimaryModel: () => ({ modelId: options.modelId, stage }),
    stageModelId: options.modelId,
    modelStage: stage,
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

/**
 * Dispatch an edit-capable action through whichever path the resolved
 * model's provider actually supports.
 *
 * Copilot runs the sealed two-phase pipeline above (§7.5-§7.7: read-only
 * preflight, structured questions via Chat, receipted mutation session).
 * CLI providers cannot join that pipeline at all — it works by the
 * extension brokering `vscode.lm`'s request-local tool calls one at a time,
 * and a CLI agent edits files with its own in-process tools that the
 * extension never sees or can revalidate between. So CLI-resolved models
 * run through their own direct edit-mode invocation instead
 * (`runImplementationForModel` → `runImplementationWithCli`): the same
 * git-snapshot-based mechanism `runImplementationWithAI` used before the
 * §7.8 cutover, permission-gated per provider (`--permission-mode
 * acceptEdits`, `--sandbox workspace-write`, etc. — see
 * `docs/design/c4-chat-edit-spike-decision.md`). It has no preflight,
 * receipts, or structured mid-run questions — CLI providers never had that
 * and cannot participate in it — but it is a fully supported, tested path,
 * not a stub: same backup-model cascade, same quota/auth classification.
 *
 * Codex review finding (P2, 5th round): the availability-and-backup-
 * selection check below now runs for BOTH primary kinds, not just a CLI
 * primary. An earlier revision short-circuited a Copilot-resolved primary
 * straight into the sealed pipeline before this check, on the reasoning
 * that the sealed pipeline's own gates were a sufficient contract for it —
 * but that skipped backup selection entirely for a Copilot primary that's
 * unavailable with a configured "switch-to-backup" CLI candidate: the CLI
 * backup was configured but unreachable, since nothing ever looked past the
 * (unavailable) Copilot primary to find it. Running the check
 * unconditionally and branching dispatch on the WINNING candidate's
 * provider kind — never the PRIMARY's — makes both fallback directions
 * (CLI-primary-to-Copilot-backup, Copilot-primary-to-CLI-backup)
 * symmetric. For a healthy, backup-free primary of either kind this changes
 * nothing observable: `availability.modelId === options.modelId`, so
 * dispatch lands on the exact same call as before.
 */
export async function runImplementationOrSealedV1(
  options: RunSealedImplementationOptionsV1
): Promise<ImplementationRunResult & { runnerId: string }> {
  try {
    resolveEffectiveProvider(options.modelId);
  } catch (error) {
    return {
      status: "failed",
      filesChanged: [],
      failureKind: "generic",
      errorMessage: error instanceof Error ? error.message : String(error),
      // Codex review nit: resolution failed, so the real provider is
      // unknown — hardcoding "copilot-lm" here misattributed a CLI-prefixed
      // modelId's failure to Copilot in run logs. Best-effort label from the
      // stored id's own "<provider>:" prefix when it has one (still "copilot-lm"
      // for a bare/undefined selection, which really does default to Copilot).
      runnerId: options.modelId?.includes(":") ? options.modelId.split(":", 1)[0]! : "copilot-lm",
    };
  }
  const stage = options.stage ?? "impl";
  // Codex review finding (P2): `options.modelId` is the stage's CONFIGURED
  // primary, not necessarily an installed/live/available one.
  // checkImplementationAvailabilityForModel already knows how to fall
  // through to a configured backup — callers upstream (e.g.
  // executeImplementationRun's own liveness re-check) use its result only
  // for the warning/progress LABEL, never to redirect which model actually
  // runs. Resolving the WINNING candidate here, then branching on *its*
  // provider kind, is what actually reaches that backup: dispatching
  // options.modelId as-is and only then discovering (inside
  // runImplementationForModel, or inside the sealed pipeline) that the
  // primary isn't installed/available is too late — a configured, available
  // backup would never be attempted despite passing this exact availability
  // check moments earlier.
  const availability = await checkImplementationAvailabilityForModel(options.modelId, stage);
  if (!availability.availability.available) {
    return {
      status: "failed",
      filesChanged: [],
      failureKind: isAuthenticationFailure(availability.availability.reason)
        ? "generic"
        : "temporarily-unavailable",
      errorMessage: availability.availability.reason ?? `${availability.providerLabel} is unavailable.`,
      runnerId: availability.provider,
    };
  }
  if (availability.provider !== "copilot") {
    return runImplementationForModel({
      modelId: availability.modelId,
      prompt: options.prompt,
      workspaceUri: options.workspaceUri,
      token: options.token,
      onProgress: options.onProgress,
      stage,
      taskFolderUri: options.taskFolderUri,
      requireFileChange: options.requireFileChange,
      correlation: { actionKey: options.editActionKey },
      // A CLI candidate must never fail over to a Copilot backup INSIDE
      // runImplementationForModel's own cascade — that backup would run
      // through the older, unsealed Copilot runner, bypassing
      // runSealedImplementationV1's preflight/receipts/host-floor gate
      // entirely. See that option's own header in runnerRegistry.ts. (A
      // Copilot candidate found by the availability check above is handled
      // correctly regardless — the branch below runs the sealed pipeline
      // against it instead of ever reaching this call.)
      allowCrossProviderBackups: false,
      // Codex review finding (P2, this round): allowCrossProviderBackups:
      // false correctly stops this cascade's OWN unsealed dispatch from
      // crossing to a configured Copilot backup, but that also meant a CLI
      // candidate that passes ITS pre-run availability probe here and then
      // fails at RUNTIME (quota/temporarily-unavailable) could never reach
      // that Copilot backup at all — switch-to-backup silently did nothing
      // for a runtime failure, even though the pre-run-unavailable case
      // (this same function's own resolution above) already worked. Routing
      // a cross-kind backup back through runSealedImplementationV1 here
      // keeps it on the sealed pipeline while still letting
      // runImplementationForModel's cascade own the iteration order/quota-
      // observation/dirty-tree-gate bookkeeping.
      runCrossProviderBackup: (modelId) => runSealedImplementationV1({ ...options, modelId }),
      // Codex review finding (P2, this round): availability.modelId can be a
      // BACKUP relative to the stage's true configured primary
      // (options.modelId) — passing it as this call's own `modelId` makes it
      // look like a fresh "primary" from runImplementationForModel's own
      // perspective, so a direct success on it never got recorded as the
      // active fallback. configuredPrimaryModelId tells that function the
      // TRUE primary so it can record correctly (see its own header).
      configuredPrimaryModelId: options.modelId,
    });
  }
  // The winning candidate resolves to Copilot — either the primary itself
  // (the common case: availability.modelId === options.modelId, so this is
  // identical to the old unconditional runSealedImplementationV1(options)),
  // or a CLI primary that fell through to a configured Copilot backup. Either
  // way that candidate still requires the sealed pipeline, never
  // runImplementationForModel's unsealed Copilot branch, so route it through
  // runSealedImplementationV1 with the winning modelId.
  const sealedResult = await runSealedImplementationV1({ ...options, modelId: availability.modelId });
  // Codex review finding (P2, this round): the same "backup succeeded but
  // was never recorded as the active fallback" gap applies here too —
  // runSealedImplementationV1 has no cascade of its own to have already
  // handled it, so a single direct check is sufficient (no nested-cascade
  // double-write risk, unlike runImplementationForModel's own case above).
  if (
    sealedResult.status === "completed" &&
    options.taskFolderUri &&
    availability.modelId !== undefined &&
    availability.modelId !== options.modelId
  ) {
    await recordActiveFallbackModel(options.taskFolderUri, stage, availability.modelId);
  }
  return sealedResult;
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

/**
 * Resume-specific gate: unlike a fresh edit-capable invocation (which now has
 * two valid paths — the sealed pipeline for Copilot, or a direct edit-mode
 * run for CLI, via runImplementationOrSealedV1), a pending edit-preflight
 * interaction was, by construction, raised by the sealed pipeline — CLI
 * providers never create one, since ImplementationRunResult has no
 * "questions" outcome and CLI never touches the coordinator's preflight
 * machinery at all. So a CLI-resolved model is never valid here, even though
 * checkEditActionProviderPathGateV1/checkEditActionAvailabilityV1 now accept
 * it for a fresh run.
 *
 * Codex review finding (prior round): checking only the STAGE'S CONFIGURED
 * PRIMARY's kind is wrong on its own terms now that a fresh invocation can
 * fall through a CLI primary to a Copilot BACKUP (runImplementationOrSealedV1
 * / checkEditActionProviderPathGateV1) — an interaction can therefore have
 * been legitimately raised by that Copilot backup while the primary is still
 * (and always was) CLI. The old primary-only check rejected every Resume of
 * such an interaction outright, even with the exact same backup still live,
 * making it unresumable short of the user manually reconfiguring their
 * primary model.
 *
 * Codex review finding (this round): the prior round's fix still applied
 * checkImplementationAvailabilityForModel's normal "primary first, then
 * backups in configured order" winner search — correct for a FRESH run,
 * where the primary should always be preferred when live, but wrong for
 * Resume specifically. If the primary was CLI and unavailable when the
 * interaction was raised (so a Copilot backup won and created it), and that
 * CLI primary later RECOVERS before the user resumes, normal winner ordering
 * picks the now-live CLI primary again — incorrectly rejecting a Resume of a
 * session the still-live Copilot backup could perfectly well continue. The
 * interaction transaction does not record which candidate actually created
 * it (same constraint as before), so instead of top-level winner ordering,
 * this searches the primary and every configured backup, in that same
 * order, for the first one that is BOTH Copilot-resolved AND live — ignoring
 * a live CLI candidate entirely rather than letting it win. Re-verified
 * fresh at Resume time, on the same "re-verify liveness right before use"
 * precedent already used throughout this file.
 *
 * Still guards the two original failure modes: if no candidate for this
 * stage is both Copilot-resolved and live, `coordinator.resumeAction` is
 * never reached — its `preflight` mode has no CLI support and would
 * otherwise settle (consume) the pending interaction as a terminal
 * `providerModeUnavailable` failure, destroying the user's in-flight
 * question/answer with no way to retry it. And the host floor is checked
 * once a live Copilot candidate is actually found, not against a
 * stage-level model that may not be it.
 */
async function requireCopilotForResumeV1(
  modelId: string | undefined,
  stage: TaskStage
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  // modelId is the caller's resolveFreshModelForStage result — identical to
  // getModelSettings()[stage]?.primary ?? getAiModelDefaults()[stage] (see
  // checkEditActionProviderPathGateV1's header) — so it doubles here as the
  // primary candidate to search from, with no extra settings read needed.
  const candidates = [modelId, ...backupModelsForStage(stage, modelId)];
  let lastReason: string | undefined;
  for (const candidate of candidates) {
    let kind: "cli" | "copilot" | undefined;
    try {
      kind = resolveEffectiveProvider(candidate).kind;
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
      continue;
    }
    if (kind !== "copilot") {
      continue;
    }
    const availability = await checkImplementationAvailabilityForModel(candidate, stage);
    if (availability.availability.available) {
      const hostGate = checkEditActionHostGateV1();
      if (!hostGate.ok) {
        return { ok: false, reason: hostGate.reason };
      }
      return { ok: true };
    }
    lastReason = availability.availability.reason;
  }
  return {
    ok: false,
    reason:
      lastReason ??
      "This question was raised during a Copilot preflight session, which only a Copilot model can resume — " +
      "configure a Copilot model for this stage before answering, or start a fresh run instead (CLI providers " +
      "cannot resume a sealed preflight).",
  };
}

/**
 * `actionKey` is the interaction's own recorded correlation key — the
 * dispatcher in extension.ts already loads the interaction transaction (to
 * decide which Resume handler to call at all) and passes its
 * `correlation.actionKey` straight through, so this function never needs a
 * SECOND transaction load just to learn it. Threading it in as a parameter
 * (rather than re-deriving it here) is what lets the stage-scoped provider
 * gate below run with the RIGHT stage — lint.v1 resolves against the
 * Publish-stage model, not Implementation's — before any further read
 * (§7.5; a hardcoded "impl" gate here would reject a valid lint.v1 Resume
 * solely because an unrelated stage's model is CLI-backed).
 */
export async function resumeEditPreflightInteractionV1(
  inventory: TaskInventory,
  chatViewProvider: ChatViewProvider,
  ref: ChatInteractionRefV1,
  actionKey: string,
  resumeIdempotencyId: string,
  cancellationToken: vscode.CancellationToken
): Promise<ChatInteractionResumeResultV1> {
  if (!isEditPreflightActionKeyV1(actionKey)) {
    return { ok: false, reason: `unexpected action key ${actionKey} for an edit-preflight Resume` };
  }
  // §7.5, applied to Resume drives too — but unlike a fresh invocation,
  // Resume is Copilot-only (see requireCopilotForResumeV1's header): the
  // task/model-INDEPENDENT gate runs first, before the inventory lookup
  // below (a task read) or any transaction/binding revalidation, so an
  // unresolvable or CLI-resolved model, or a pre-1.100 host, is rejected
  // before any task/source read, exactly like a fresh invocation
  // (checkEditActionAvailabilityV1's workspace-root half genuinely needs the
  // resolved task's workspace and is revalidated further down once that is
  // known). The stage passed here is the stage THIS actionKey actually
  // resolves its model against, not a hardcoded one.
  const modelStage = modelStageForEditActionKeyV1(actionKey);
  const earlyModelId = getModelSettings()[modelStage]?.primary ?? getAiModelDefaults()[modelStage];
  const providerPathGate = await requireCopilotForResumeV1(earlyModelId, modelStage);
  if (!providerPathGate.ok) {
    return { ok: false, reason: providerPathGate.reason };
  }

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
  const model = await resolveFreshModelForStage(taskFolderUri, modelStage);
  // Registers the workspace root (needed by the coordinator's file-store
  // access below) and revalidates the coarse checks against the exact
  // per-task model — CLI-permissive for a fresh invocation, but Resume's own
  // Copilot-only requirement is enforced separately right after, since a
  // stage's model can have changed to CLI since this interaction was raised
  // (see requireCopilotForResumeV1's header).
  const availability = await checkEditActionAvailabilityV1({
    workspaceFsPath: workspaceFolderUri.fsPath,
    stageModelId: model.modelId,
    stage: modelStage,
  });
  if (!availability.ok) {
    return { ok: false, reason: availability.reason };
  }
  const resumeProviderGate = await requireCopilotForResumeV1(model.modelId, modelStage);
  if (!resumeProviderGate.ok) {
    return { ok: false, reason: resumeProviderGate.reason };
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
