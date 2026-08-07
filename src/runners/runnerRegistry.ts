import * as vscode from "vscode";
import {
  AgentAvailability,
  AgentRunner,
  AgentRunResult,
} from "../types/agentRunner";
import { AttemptIdV1 } from "../types/actionCorrelationV1";
import { AgentExecutionModeV1, AgentTransportV1 } from "../types/agentExecutionV1";
import { ProviderReservationHandleV1 } from "../types/providerReservationV1";
import { ProviderSelectionSessionV1 } from "../services/providerSelectionPolicyV1";
import {
  CopilotLanguageModelRunner,
  createCopilotLmTextTransportV1,
} from "./copilotLanguageModelRunner";
import {
  checkImplementationAvailability,
  ImplementationRunResult,
  runImplementationWithCopilot,
} from "./copilotImplementationRunner";
import {
  CliAgentRunner,
  cliCommandExists,
  cliProviderSupportsV1StdoutCapture,
  createCliTextTransportV1,
  runImplementationWithCli,
} from "./cliAgentRunner";
import {
  cliDisplayLabel,
  CliProviderDefinition,
  getCliProvider,
  getProviderAccountEntry,
  normalizeQualifiedModelId,
  parseModelSelection,
  providerAccountIdForModelId,
  ProviderId,
} from "./providers";
import {
  getModelSettings,
  isModelProviderEnabled,
  isProviderSelectionConfigured,
} from "../config/settings";
import { chooseFallback, getBackupModels } from "../utils/modelFallback";
import { isAuthenticationFailure, recordQuotaObservation } from "../utils/quota";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import { clearStageFallbackReservation } from "../utils/taskProgressTransforms";
import { createCopilotLmToolSessionTransportV1 } from "../services/languageModelToolSessionV1";
import { RequestLocalToolHandlerV1 } from "../services/requestLocalToolHandlerV1";
import { TaskStage } from "../types/taskProgress";
import { assertNoUnauthorizedV1CorrelationV0 } from "../services/legacyAiActionSafetyGateV0";

type EffectiveProvider =
  | { kind: "copilot"; model: string | undefined }
  | { kind: "cli"; def: CliProviderDefinition; model: string | undefined };

/**
 * Resolve which provider actually handles a stage's stored model ID.
 *
 * An explicit provider-qualified ID (e.g. "claude-cli:sonnet") always wins.
 * A bare/legacy ID always means Copilot (pre-provider behavior — those IDs
 * came from vscode.lm before other providers existed). When no stage model
 * is configured at all (modelId undefined, i.e. resolveModelForStage
 * returned "source: none"), Copilot is preferred if it has any models
 * available, but falls back to the first installed CLI provider — so a
 * CLI-only setup (no Copilot subscription) works without the user first
 * visiting the model picker. This is what makes "at least one of Copilot /
 * Claude Code / Codex / Gemini / Antigravity / Kiro" (see README) actually
 * hold without extra
 * configuration.
 *
 * Shared by resolveRunnerForModel (plan/review) and the two implementation
 * entry points below so all three "with AI" paths auto-detect the same way.
 */
/**
 * Runner-entry guard: a model belonging to a provider the user has disabled
 * in Provider Selection must never run, no matter which code path resolved
 * it (stage command, chat, implementation, backup fallback). The stored
 * model id itself is preserved untouched; only running it is refused. The
 * guard is active only once a provider selection actually exists — a fresh
 * pre-migration state (no enabledProviders value in any scope) blocks
 * nothing, matching migrateEnabledProvidersForExistingModels's semantics.
 * Mirrors the command-level ensureStageModelConfigured guard, which
 * additionally opens the AI Models view; this one is the last line of
 * defense for paths that never went through a guarded command entry point.
 */
function isModelProviderDisabled(modelId: string | undefined): boolean {
  // Copilot is not exempt: isProviderEnabled treats it as enabled unless the
  // user explicitly disables it in Provider Selection.
  return isProviderSelectionConfigured() && !isModelProviderEnabled(modelId);
}

/**
 * Also exported for `runEditActionV1.ts`'s §7.5 availability checks and
 * `runImplementationOrSealedV1`'s routing decision: an edit-capable action's
 * stage model must resolve to SOME runnable path before the action may
 * begin any task or source read — Copilot's sealed pipeline, or a CLI
 * provider's own direct edit-mode invocation.
 */
export function resolveEffectiveProvider(
  modelId: string | undefined
): EffectiveProvider {
  const parsed = parseModelSelection(modelId);
  if (parsed.provider !== "copilot") {
    const def = getCliProvider(parsed.provider);
    if (def) {
      if (isModelProviderDisabled(modelId)) {
        const account = getProviderAccountEntry(providerAccountIdForModelId(modelId));
        throw new Error(
          `The selected model ("${modelId}") belongs to ${account?.label ?? def.label}, which is disabled in Provider Selection. ` +
            "Enable the provider or choose another model in AI Models."
        );
      }
      return { kind: "cli", def, model: parsed.model };
    }
  }

  if (modelId !== undefined) {
    // Explicit (legacy/bare) selection — always Copilot, never silently
    // redirected to a different provider.
    return { kind: "copilot", model: parsed.model };
  }

  throw new Error("No model is configured for this stage. Open Settings and select a primary model.");
}

export interface ResolvedRunner {
  runner: AgentRunner;
  provider: ProviderId;
  /** Short display name for user-facing messages ("Copilot", "Claude Code"…). */
  providerLabel: string;
  /**
   * The provider-native model identifier to pass in AgentRunRequest.modelId
   * (undefined = provider default). Stored IDs are provider-qualified; this
   * is the unqualified form each runner actually understands.
   */
  nativeModelId: string | undefined;
}

export interface RunnerAvailability {
  availability: AgentAvailability;
  providerLabel: string;
  provider: ProviderId;
  modelId: string | undefined;
  nativeModelId: string | undefined;
}

function toResolvedRunner(effective: EffectiveProvider): ResolvedRunner {
  if (effective.kind === "cli") {
    return {
      runner: new CliAgentRunner(effective.def),
      provider: effective.def.id,
      providerLabel: effective.def.label,
      nativeModelId: effective.model,
    };
  }
  return {
    runner: new CopilotLanguageModelRunner(),
    provider: "copilot",
    providerLabel: "Copilot",
    nativeModelId: effective.model,
  };
}

/** Drop backup candidates whose provider is disabled so a fallback can never
 * route around the runner-entry guard above. */
function filterEnabledBackupModels(models: readonly string[]): string[] {
  return models.filter(
    (candidate) => !isModelProviderDisabled(candidate)
  );
}

/**
 * Build the prompt sent to a backup model that is taking over from a primary
 * interrupted by a quota/temporarily-unavailable failure with a known,
 * non-empty changed-file set (plan §2e). Preserving the tree instead of
 * suppressing the cascade only helps if the backup is explicitly told what
 * already changed and instructed to build on it rather than restart —
 * otherwise it may silently overwrite or ignore the stranded edits.
 */
export function buildBackupHandoffPromptV1(
  originalPrompt: string,
  changedFiles: readonly string[]
): string {
  const fileList = changedFiles.map((file) => `- ${file}`).join("\n");
  return [
    "IMPORTANT: Another AI agent was implementing this task and was interrupted " +
      "mid-run by a temporary provider outage or quota limit — NOT a defect in its work.",
    "",
    "Before it stopped, that agent already changed the following files in this workspace:",
    fileList,
    "",
    "Inspect those changes first. Preserve them — do not discard, revert, or restart the " +
      "implementation from scratch. Continue from where the interrupted agent left off and " +
      "finish the task described below.",
    "",
    "--- Original implementation task ---",
    "",
    originalPrompt,
  ].join("\n");
}

/**
 * Configured backup models for a stage, excluding `modelId` itself and any
 * provider currently disabled — but ONLY when the stage's fallback strategy
 * is "switch-to-backup" (the quota-triggered automatic switch-over opt-in).
 * A stage configured with "pause-and-resume" or "alert-and-wait" returns
 * nothing here, by design: those strategies mean the user explicitly does
 * NOT want an automatic provider swap on quota failure.
 *
 * Do not reuse this for a different question than "should a quota failure
 * silently switch providers" — see getConfiguredBackupModelsForStage below
 * for "what alternate models are configured for this stage at all",
 * independent of that strategy choice.
 */
export function backupModelsForStage(
  stage: TaskStage | undefined,
  modelId: string | undefined
): string[] {
  if (!stage) {
    return [];
  }
  const setting = getModelSettings()[stage];
  if (setting?.strategy !== "switch-to-backup") {
    return [];
  }
  const primary = normalizeQualifiedModelId(modelId);
  const seen = new Set<string>();
  return filterEnabledBackupModels(getBackupModels(setting)).filter((candidate) => {
    const normalized = normalizeQualifiedModelId(candidate);
    if (normalized === primary || seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
    return true;
  });
}

/**
 * Every configured backup model for a stage, excluding `modelId` itself and
 * any provider currently disabled — regardless of the stage's fallback
 * strategy. Exported for the deliberate second-opinion mechanism in
 * reviewActions.ts: when review-score iteration plateaus, one round is run
 * against a different model from this list, turning what used to be an
 * accidental quota-fallback reviewer swap into an intentional check.
 *
 * Deliberately does NOT gate on `strategy === "switch-to-backup"` the way
 * backupModelsForStage does: a user who configured backups under
 * "pause-and-resume" or "alert-and-wait" has explicitly opted OUT of
 * automatic quota switch-over, but still has models genuinely available —
 * gating a plateau-triggered second opinion on that unrelated setting would
 * silently make the mechanism inert (always "no alternate model was
 * available") for anyone who made that choice.
 */
export function getConfiguredBackupModelsForStage(
  stage: TaskStage | undefined,
  modelId: string | undefined
): string[] {
  if (!stage) {
    return [];
  }
  return filterEnabledBackupModels(
    getBackupModels(getModelSettings()[stage]).filter(candidate => candidate !== modelId)
  );
}

export async function checkRunnerAvailabilityForModel(
  modelId: string | undefined,
  stage?: TaskStage
): Promise<RunnerAvailability> {
  const resolved = toResolvedRunner(resolveEffectiveProvider(modelId));
  const primaryAvailability = await resolved.runner.isAvailable();
  const primary: RunnerAvailability = {
    availability: primaryAvailability,
    providerLabel: resolved.providerLabel,
    provider: resolved.provider,
    modelId,
    nativeModelId: resolved.nativeModelId,
  };

  if (
    primaryAvailability.available ||
    isAuthenticationFailure(primaryAvailability.reason)
  ) {
    return primary;
  }

  for (const backupModel of backupModelsForStage(stage, modelId)) {
    const fallback = toResolvedRunner(resolveEffectiveProvider(backupModel));
    const fallbackAvailability = await fallback.runner.isAvailable();
    const candidate: RunnerAvailability = {
      availability: fallbackAvailability,
      providerLabel: fallback.providerLabel,
      provider: fallback.provider,
      modelId: backupModel,
      nativeModelId: fallback.nativeModelId,
    };
    if (
      fallbackAvailability.available ||
      isAuthenticationFailure(fallbackAvailability.reason)
    ) {
      return candidate;
    }
  }

  return primary;
}

/**
 * Persist which model actually served a stage after a fallback, so a later
 * `resolveModelForStage` call honoring `fallbackActive` (e.g. a subsequent
 * Fast Forward iteration passing `preserveActiveFallback`) routes straight to
 * the known-working model instead of re-paying the cost of a known-flaky
 * primary.
 */
export async function recordActiveFallbackModel(
  taskFolderUri: vscode.Uri,
  stage: TaskStage,
  modelId: string,
  options: {
    /** Decline the write if a newer review attempt now owns the stage. */
    expectedReviewAttemptId?: string;
    /** Claim and record in one locked write; decline an unrelated reservation. */
    requireUnreserved?: boolean;
    /**
     * When `requireUnreserved` is set, still allow replacing the active route
     * if it names the model this call intentionally started from. An active
     * reservation without a model id is also replaceable: that is the
     * intermediate state written by reserveFallback before a working backup
     * has been identified. A different named model continues to win.
     */
    replaceActiveModelId?: string;
  } = {}
): Promise<boolean> {
  let recorded = false;
  await patchTaskProgressStrictV1(taskFolderUri, (current) => {
    if (
      options.expectedReviewAttemptId !== undefined &&
      current.reviewAttemptId !== options.expectedReviewAttemptId
    ) {
      return current;
    }
    if (options.requireUnreserved && current.fallbackActive?.[stage]) {
      const activeModelId = current.fallbackModelId?.[stage];
      if (
        options.replaceActiveModelId === undefined ||
        (activeModelId !== undefined &&
          normalizeQualifiedModelId(activeModelId) !==
            normalizeQualifiedModelId(options.replaceActiveModelId))
      ) {
        return current;
      }
    }
    recorded = true;
    return {
      ...current,
      fallbackActive: {
        ...current.fallbackActive,
        [stage]: true,
      },
      fallbackModelId: {
        ...current.fallbackModelId,
        [stage]: modelId,
      },
    };
  });
  return recorded;
}

function withQuotaObservation(
  runner: AgentRunner,
  stage: TaskStage,
  modelId: string | undefined
): AgentRunner {
  return {
    id: runner.id,
    label: runner.label,
    capabilities: runner.capabilities,
    isAvailable: () => runner.isAvailable(),
    async run(request, token): Promise<AgentRunResult> {
      assertNoUnauthorizedV1CorrelationV0(request);
      const result = await runner.run(request, token);
      recordQuotaObservation(stage, modelId, result.failureKind, result.errorMessage);
      return result;
    },
  };
}

/**
 * Regression coverage for a review finding: the stage-less branch of
 * `resolveRunnerForModel` returned the raw runner from `toResolvedRunner`
 * untouched, so a caller that never passes `stage` (historically
 * `runSecondOpinionReview` in reviewActions.ts and the Global Assistant in
 * openGeneralAssistant.ts — both call sites were later removed entirely
 * during the Cleanup cohort's disposition of those two routes, see
 * legacyAiActionSafetyGateV0.ts's file header) reached the concrete
 * `CliAgentRunner`/`CopilotLanguageModelRunner` `.run()` directly — bypassing
 * `assertNoUnauthorizedV1CorrelationV0` entirely, not merely being subject to
 * it. `withQuotaObservation` and the backup-model wrapper below both already
 * assert before delegating; this gives the stage-less path the identical
 * guarantee so EVERY exit of this function enforces the same boundary, per
 * the plan's "shared runner/provider boundary ... rejects ... any legacy
 * (uncorrelated) request" rule (plan §1.3) with no caller-shape exemption —
 * kept even though no production caller of this branch remains today, since
 * `resolveRunnerForModel`/`AgentRunner.run()` stays retained, tested legacy
 * infrastructure (plan §3.4: "No supported text runner silently disappears").
 */
function withUnauthorizedV1CorrelationBackstop(runner: AgentRunner): AgentRunner {
  return {
    id: runner.id,
    label: runner.label,
    capabilities: runner.capabilities,
    isAvailable: () => runner.isAvailable(),
    async run(request, token): Promise<AgentRunResult> {
      assertNoUnauthorizedV1CorrelationV0(request);
      return runner.run(request, token);
    },
  };
}

/**
 * Atomic/durable fallback switcher to ensure we only switch to the backup
 * model once per stage epoch, preventing concurrent duplicate runs from both
 * consuming the backup.
 */
async function reserveFallback(
  taskFolderUri: vscode.Uri,
  stage: TaskStage,
  expectedReviewAttemptId?: string
): Promise<boolean> {
  let activated = false;
  await patchTaskProgressStrictV1(taskFolderUri, (current) => {
    if (
      expectedReviewAttemptId !== undefined &&
      current.reviewAttemptId !== expectedReviewAttemptId
    ) {
      return current;
    }
    if (current.fallbackActive?.[stage]) {
      return current;
    }
    activated = true;
    const fallbackModelId = { ...current.fallbackModelId };
    delete fallbackModelId[stage];
    return {
      ...current,
      fallbackActive: {
        ...current.fallbackActive,
        [stage]: true,
      },
      fallbackModelId: Object.keys(fallbackModelId).length > 0
        ? fallbackModelId
        : undefined,
    };
  });
  return activated;
}

/**
 * Release the short-lived fallback reservation when no backup actually
 * completed. `reserveFallback` writes an active flag before a backup starts
 * so concurrent runs cannot spend the same backup allocation. That flag must
 * not outlive a failed, cancelled, or unauthenticated backup: model resolution
 * would otherwise treat the failed backup as the stage's preferred route.
 *
 * A named fallback model is retained deliberately. It can only have been
 * written after a completed backup, either by this run or a concurrent run
 * that won the reservation, and is therefore a valid route to preserve.
 */
async function releaseUnresolvedFallbackReservation(
  taskFolderUri: vscode.Uri,
  stage: TaskStage,
  expectedReviewAttemptId?: string
): Promise<void> {
  await patchTaskProgressStrictV1(taskFolderUri, (current) => {
    if (
      expectedReviewAttemptId !== undefined &&
      current.reviewAttemptId !== expectedReviewAttemptId
    ) {
      return current;
    }
    if (!current.fallbackActive?.[stage] || current.fallbackModelId?.[stage]) {
      return current;
    }
    return clearStageFallbackReservation(current, stage);
  });
}

/**
 * Resolve the runner responsible for a stored stage model ID (plan/review
 * stages — see resolveEffectiveProvider for the auto-detection rules).
 * `expectedReviewAttemptId` makes fallback reservation and routing writes
 * conditional on that review still owning the stage after a long provider
 * call; callers without review-attempt ownership leave it undefined.
 */
export function resolveRunnerForModel(
  modelId: string | undefined,
  stage?: TaskStage,
  taskFolderUri?: vscode.Uri,
  expectedReviewAttemptId?: string
): ResolvedRunner {
  const resolved = toResolvedRunner(resolveEffectiveProvider(modelId));
  if (!stage) {
    return { ...resolved, runner: withUnauthorizedV1CorrelationBackstop(resolved.runner) };
  }
  const primary = resolved.runner;
  // Record what every run reveals about this stage+model's quota state
  // (session-observed only — see utils/quota.ts for why a numeric percentage
  // isn't offered) so the settings webview can show real, non-fabricated
  // telemetry instead of a permanent placeholder.
  const instrumented = withQuotaObservation(primary, stage, modelId);
  const backupModels = backupModelsForStage(stage, modelId);
  if (backupModels.length === 0) {
    return { ...resolved, runner: instrumented };
  }
  return {
    ...resolved,
    runner: {
      id: instrumented.id,
      label: instrumented.label,
      capabilities: instrumented.capabilities,
      isAvailable: async () =>
        (await checkRunnerAvailabilityForModel(modelId, stage)).availability,
      async run(request, token): Promise<AgentRunResult> {
        assertNoUnauthorizedV1CorrelationV0(request);
        const runBackups = async (): Promise<AgentRunResult> => {
          const releaseReservation = (): Promise<void> =>
            releaseUnresolvedFallbackReservation(
              taskFolderUri ?? request.taskFolderUri,
              stage,
              expectedReviewAttemptId
            );
          let last: AgentRunResult | undefined;
          for (const backupModel of backupModels) {
            const fallback = toResolvedRunner(resolveEffectiveProvider(backupModel));
            const fallbackAvailability = await fallback.runner.isAvailable();
            if (!fallbackAvailability.available) {
              last = {
                runnerId: fallback.runner.id,
                status: "failed",
                failureKind: isAuthenticationFailure(fallbackAvailability.reason)
                  ? "generic"
                  : "temporarily-unavailable",
                errorMessage: fallbackAvailability.reason ?? "Backup model is unavailable.",
              };
              recordQuotaObservation(stage, backupModel, last.failureKind, last.errorMessage);
              if (isAuthenticationFailure(fallbackAvailability.reason)) {
                await releaseReservation();
                return last;
              }
              continue;
            }
            const fallbackResult = await fallback.runner.run({ ...request, modelId: fallback.nativeModelId }, token);
            recordQuotaObservation(stage, backupModel, fallbackResult.failureKind, fallbackResult.errorMessage);
            last = fallbackResult;
            if (fallbackResult.status === "completed") {
              await recordActiveFallbackModel(
                taskFolderUri ?? request.taskFolderUri,
                stage,
                backupModel,
                { expectedReviewAttemptId }
              );
              return fallbackResult;
            }
            // A generic failure (including an auth error) and a user
            // cancellation are terminal for this run, but neither makes this
            // backup a known-good route for later runs.
            if (
              fallbackResult.status === "cancelled" ||
              (fallbackResult.failureKind !== "quota" &&
                fallbackResult.failureKind !== "temporarily-unavailable")
            ) {
              await releaseReservation();
              return fallbackResult;
            }
          }
          await releaseReservation();
          return last ?? { runnerId: primary.id, status: "failed", failureKind: "temporarily-unavailable", errorMessage: "No backup model is available." };
        };
        const availability = await primary.isAvailable();
        // Never spend a backup allocation on credentials/configuration errors.
        // Providers commonly report these as plain HTTP status text.
        const authenticationFailure = isAuthenticationFailure(availability.reason);
        if (!availability.available && !authenticationFailure) {
          const folder = taskFolderUri ?? request.taskFolderUri;
          if (folder && await reserveFallback(folder, stage, expectedReviewAttemptId)) {
            return runBackups();
          }
          return { runnerId: primary.id, status: "failed", failureKind: "temporarily-unavailable", errorMessage: availability.reason ?? "Model is temporarily unavailable." };
        }
        const result = await primary.run(request, token);
        recordQuotaObservation(stage, modelId, result.failureKind, result.errorMessage);
        if (result.failureKind !== "quota" && result.failureKind !== "temporarily-unavailable") {
          return result;
        }

        const folder = taskFolderUri ?? request.taskFolderUri;
        if (!folder) {
          return result;
        }
        const reserved = await reserveFallback(folder, stage, expectedReviewAttemptId);
        if (!reserved) {
          return result;
        }

        return runBackups();
      },
    },
  };
}

/**
 * Availability check for an implementation (code-editing) run with the
 * provider a stage's model ID selects (or auto-detects — see
 * resolveEffectiveProvider).
 */
export async function checkImplementationAvailabilityForModel(
  modelId: string | undefined,
  stage?: TaskStage
): Promise<RunnerAvailability> {
  const check = async (
    storedModelId: string | undefined,
    effective: EffectiveProvider
  ): Promise<RunnerAvailability> => {
    if (effective.kind === "copilot") {
      return {
        availability: await checkImplementationAvailability(),
        providerLabel: "Copilot",
        provider: "copilot",
        modelId: storedModelId,
        nativeModelId: effective.model,
      };
    }
    const { def } = effective;
    const exists = await cliCommandExists(def.command, def.commandAliases);
    return {
      availability: exists
        ? { available: true }
        : {
            available: false,
            reason: `The ${cliDisplayLabel(def)} CLI (${def.command}) is not installed. ${def.installHint}`,
          },
      providerLabel: def.label,
      provider: def.id,
      modelId: storedModelId,
      nativeModelId: effective.model,
    };
  };

  const primary = await check(modelId, resolveEffectiveProvider(modelId));
  if (
    primary.availability.available ||
    isAuthenticationFailure(primary.availability.reason)
  ) {
    return primary;
  }

  for (const backupModel of backupModelsForStage(stage, modelId)) {
    const fallback = await check(backupModel, resolveEffectiveProvider(backupModel));
    if (
      fallback.availability.available ||
      isAuthenticationFailure(fallback.availability.reason)
    ) {
      return fallback;
    }
  }

  return primary;
}

/**
 * Run an agentic implementation with whichever provider the stage's model
 * ID selects (or auto-detects): Copilot uses the LM API tool-calling loop;
 * CLI providers edit the workspace directly with edit-level permissions.
 */
export async function runImplementationForModel(options: {
  modelId: string | undefined;
  prompt: string;
  workspaceUri: vscode.Uri;
  token: vscode.CancellationToken;
  onProgress: (message: string) => void;
  stage?: TaskStage;
  taskFolderUri?: vscode.Uri;
  /** See runImplementationWithCli — default true; pass false when the
   * prompt may legitimately be answered without an edit. Copilot's runner
   * has no equivalent no-op failure, so this only affects CLI providers. */
  requireFileChange?: boolean;
  onBusyDetail?: (detail: string | undefined) => void;
  onWaitingForUser?: (waiting: boolean) => void;
  /**
   * V1 correlation for `assertNoUnauthorizedV1CorrelationV0` below — REQUIRED
   * (no default) so every caller states its intent explicitly, matching the
   * removed isImplementationV1Bootstrap field's own rationale. `actionKey`
   * must be one of MIGRATED_ACTION_KEYS_V0's edit-cohort keys
   * (implementation.v1/fastForward.v1/applyReviewEdit.v1/lint.v1); this
   * function reads nothing else off it — there is no coordinator lease or
   * receipt at this call site to attach a full ActionCorrelationV1 to, since
   * the CLI edit path this feeds has none of that machinery.
   */
  correlation: { readonly actionKey: string };
  /**
   * REQUIRED (no default). When false, a configured backup whose effective
   * provider kind differs from the PRIMARY's is treated as unavailable and
   * skipped by THIS function's own direct dispatch (the `run` closure below)
   * — it never silently crosses from one runner kind to another itself. This
   * matters because the two kinds have categorically different safety
   * properties: a CLI provider's edit mode is a blunt, extension-unmediated
   * workspace-wide write grant, while Copilot's callers outside this
   * function route through the sealed two-phase pipeline
   * (runSealedImplementationV1 in runEditActionV1.ts) with its own
   * preflight/receipts/host-floor gate. Dispatching a Copilot backup through
   * `run` below — runImplementationWithCopilot, the older, unsealed Copilot
   * runner — would silently bypass every one of the sealed pipeline's
   * guarantees. Pass true only for a caller that has no such distinction to
   * protect (e.g. a primary that is itself Copilot falling back to another
   * Copilot model). A caller that DOES need a cross-kind backup reachable
   * (runImplementationOrSealedV1, whose own top-level dispatch already knows
   * how to run a Copilot candidate safely) should instead pass
   * `runCrossProviderBackup` and leave this false — see that option.
   */
  allowCrossProviderBackups: boolean;
  /**
   * Optional safe cross-provider handoff (Codex review finding: a CLI
   * primary that passes its pre-run availability probe but then fails at
   * RUNTIME with a quota/temporarily-unavailable error had no way to reach a
   * configured Copilot backup — `allowCrossProviderBackups: false` correctly
   * blocks this cascade's own unsealed `run` dispatch from crossing to it,
   * but the caller never got a chance to route that backup through the
   * sealed pipeline instead, so `switch-to-backup` silently did nothing for
   * a runtime failure even though it already worked for a pre-run
   * unavailable-primary failure via runImplementationOrSealedV1's own
   * top-level resolution). When set, a backup whose kind differs from the
   * primary's is no longer skipped outright: this callback is invoked with
   * its modelId INSTEAD of the unsafe `run` dispatch, and its result flows
   * through the exact same quota-observation/sticky-fallback/dirty-tree-gate
   * bookkeeping as any same-kind backup. An unresolvable backup modelId is
   * still always skipped, regardless of this callback, exactly as before.
   */
  runCrossProviderBackup?: (modelId: string) => Promise<ImplementationRunResult & { runnerId: string }>;
  /**
   * The stage's TRUE globally-configured primary, when `modelId` above is
   * actually a pre-resolved WINNING candidate rather than that primary
   * itself (Codex review finding: runImplementationOrSealedV1 pre-resolves
   * the winning candidate — the primary if live, else the first available
   * configured backup — via checkImplementationAvailabilityForModel, then
   * dispatches straight to it as this function's `modelId`; a direct,
   * first-try success on that candidate previously went unrecorded, since
   * this function's own recordActiveFallbackModel call only fires from
   * inside its OWN internal backup loop below, never for its own top-level
   * `modelId` succeeding directly). Omit when `modelId` already IS the true
   * primary (every other caller) — this only activates the check below when
   * explicitly given a value that differs from `modelId`.
   */
  configuredPrimaryModelId?: string;
}): Promise<ImplementationRunResult & { runnerId: string }> {
  assertNoUnauthorizedV1CorrelationV0(options);
  const effective = resolveEffectiveProvider(options.modelId);

  const run = async (
    selected: EffectiveProvider,
    promptOverride?: string
  ): Promise<ImplementationRunResult & { runnerId: string }> => {
    const prompt = promptOverride ?? options.prompt;
    if (selected.kind === "cli") {
      const result = await runImplementationWithCli({
        def: selected.def,
        model: selected.model,
        prompt,
        workspaceUri: options.workspaceUri,
        token: options.token,
        onProgress: options.onProgress,
        requireFileChange: options.requireFileChange,
        taskFolderUri: options.taskFolderUri,
        stage: options.stage,
      });
      return { ...result, runnerId: selected.def.id };
    }

    const result = await runImplementationWithCopilot({
      prompt,
      modelId: selected.model,
      workspaceUri: options.workspaceUri,
      token: options.token,
      onProgress: options.onProgress,
      onBusyDetail: options.onBusyDetail,
      onWaitingForUser: options.onWaitingForUser,
    });
    return { ...result, runnerId: "copilot-lm" };
  };
  const result = await run(effective);
  if (options.stage) {
    recordQuotaObservation(options.stage, options.modelId, result.failureKind, result.errorMessage);
  }
  // Codex review finding: a pre-resolved winning candidate (passed as
  // `modelId` above, differing from the stage's true `configuredPrimaryModelId`)
  // that succeeds on this direct, first-try attempt was never recorded as the
  // active fallback — only a candidate discovered by THIS function's OWN
  // internal backup loop below gets that treatment. Without this, a later
  // Fast Forward iteration passing preserveActiveFallback re-resolves the
  // stage's raw configured primary instead of sticking with the
  // known-working backup this run just proved out.
  if (
    result.status === "completed" &&
    options.taskFolderUri &&
    options.stage &&
    options.modelId !== undefined &&
    options.configuredPrimaryModelId !== undefined &&
    options.configuredPrimaryModelId !== options.modelId
  ) {
    await recordActiveFallbackModel(options.taskFolderUri, options.stage, options.modelId);
  }
  const setting = getModelSettings()[options.stage as keyof ReturnType<typeof getModelSettings>];
  // Prefer the provider's own pre-hint verdict; fall back to the regex over the
  // pre-hint diagnostic text, and only then over errorMessage. The layering is
  // what breaks a self-reinforcing loop: toFriendlyError APPENDS the login hint
  // ("...paste the OpenCode API key.") into errorMessage, and that hint text
  // itself matches /api\s*key/i in isAuthenticationFailure — so any error that
  // tripped a false-positive auth diagnosis was guaranteed to be re-confirmed
  // as auth by the hint Ensemble added to explain it. authDiagnosticText is the
  // same message without the hint.
  //
  // `||` rather than `??`: a false from a CLI provider means "this provider's
  // marker list didn't match", not "this is definitely not auth". Provider
  // marker lists are narrower than the regex (claude-cli carries no 401/403/
  // forbidden markers), so the regex must still get its say. The Copilot runner
  // leaves both fields undefined and lands on errorMessage — today's behavior.
  const authFailure =
    result.authFailure === true ||
    isAuthenticationFailure(result.authDiagnosticText ?? result.errorMessage);
  // A failed run may already have written partial changes before it failed
  // (a timeout on a provider whose CLI keeps writing right up to the kill,
  // e.g. Cline/Antigravity's unenforced text/edit modes — or, less likely but
  // still possible on any provider, a mid-run failure after some tool calls
  // already landed). filesChanged/filesChangedUnknown are already computed by
  // runImplementationWithCli's before/after git snapshot for exactly this
  // purpose (see its own doc comment) but were previously never consulted
  // here — this cascade dispatched a DIFFERENT model at the current, possibly
  // half-edited working tree the moment failureKind alone said quota/
  // temporarily-unavailable, with no dirty-tree gate at all (unlike the
  // same-model retry path in runImplementationWithCli, which already refuses
  // to retry without a clean git snapshot). Treat "unknown" (git unavailable
  // / not a repository) the same as "dirty" — genuinely not knowing is not
  // evidence of safety. Copilot's runner has its own tool-path boundary
  // rather than a git snapshot, but still always reports a real filesChanged
  // array (see ImplementationRunResult), so this check applies uniformly to
  // every runner kind, not just CLI providers.
  const leftTreeCleanV1 = (r: ImplementationRunResult): boolean =>
    r.filesChangedUnknown !== true && r.filesChanged.length === 0;
  const primaryLeftTreeClean = leftTreeCleanV1(result);
  if (
    !authFailure &&
    primaryLeftTreeClean &&
    (result.failureKind === "quota" ||
      result.failureKind === "temporarily-unavailable") &&
    options.stage &&
    chooseFallback(setting) === "backup" &&
    getBackupModels(setting).length
  ) {
    if (!options.taskFolderUri) {
      return result;
    }
    const reserved = await reserveFallback(options.taskFolderUri, options.stage);
    if (!reserved) {
      return result;
    }
    const releaseReservation = (): Promise<void> =>
      releaseUnresolvedFallbackReservation(options.taskFolderUri!, options.stage!);
    for (const backupModel of filterEnabledBackupModels(getBackupModels(setting))) {
      if (backupModel === options.modelId) {
        continue;
      }
      let useCrossProviderBackup = false;
      if (!options.allowCrossProviderBackups) {
        let backupKind: "cli" | "copilot" | undefined;
        try {
          backupKind = resolveEffectiveProvider(backupModel).kind;
        } catch {
          // Unresolvable — the availability check just below rejects it too;
          // treat as skip either way rather than crossing provider kinds.
        }
        if (backupKind !== effective.kind) {
          // Codex review finding: previously always skipped here, so a
          // primary that passed its pre-run probe but then failed at RUNTIME
          // (quota/temporarily-unavailable) could never reach a
          // cross-provider-kind backup even with switch-to-backup configured
          // — runCrossProviderBackup (when the caller supplied one) is the
          // sanctioned way to still reach it, through that caller's own safe
          // dispatch instead of this cascade's unsealed `run` below. An
          // unresolvable backupKind (undefined) still always skips,
          // regardless, matching the pre-existing comment above.
          if (!options.runCrossProviderBackup || backupKind === undefined) {
            continue;
          }
          useCrossProviderBackup = true;
        }
      }
      const fallbackAvailability =
        await checkImplementationAvailabilityForModel(backupModel);
      if (!fallbackAvailability.availability.available) {
        const fallbackFailure = {
          ...result,
          status: "failed" as const,
          failureKind: isAuthenticationFailure(fallbackAvailability.availability.reason)
            ? "generic" as const
            : "temporarily-unavailable" as const,
          errorMessage: fallbackAvailability.availability.reason ?? "Backup model is unavailable.",
        };
        recordQuotaObservation(options.stage, backupModel, fallbackFailure.failureKind, fallbackFailure.errorMessage);
        if (isAuthenticationFailure(fallbackAvailability.availability.reason)) {
          await releaseReservation();
          return fallbackFailure;
        }
        continue;
      }
      const fallbackResult = useCrossProviderBackup
        ? await options.runCrossProviderBackup!(backupModel)
        : await run(resolveEffectiveProvider(backupModel));
      recordQuotaObservation(options.stage, backupModel, fallbackResult.failureKind, fallbackResult.errorMessage);
      if (fallbackResult.status === "completed") {
        await recordActiveFallbackModel(
          options.taskFolderUri,
          options.stage,
          backupModel
        );
        return fallbackResult;
      }
      // A failed/cancelled backup cannot be the stage's sticky fallback.
      // In particular, this prevents an OpenCode 401 from routing every
      // later implementation attempt to the same unauthenticated model.
      if (
        fallbackResult.status === "cancelled" ||
        (fallbackResult.failureKind !== "quota" &&
          fallbackResult.failureKind !== "temporarily-unavailable")
      ) {
        await releaseReservation();
        return fallbackResult;
      }
      // Codex review finding (P1): this backup's own failure is cascadable
      // by failureKind alone, but the SAME dirty-tree gate applied to the
      // primary above was never re-applied here — a backup that writes
      // partial changes before hitting its own transient quota error would
      // let a THIRD candidate run against that now half-edited (or unknown)
      // tree with no awareness of it. Stop the cascade the moment any
      // attempt — primary or backup — may have mutated the workspace,
      // exactly as the primary's own gate does.
      if (!leftTreeCleanV1(fallbackResult)) {
        await releaseReservation();
        return fallbackResult;
      }
    }
    await releaseReservation();
  } else if (
    // (2e) Backup handoff after a quota-interrupted implementation: the
    // clean-tree cascade above intentionally never fires here because
    // `primaryLeftTreeClean` is false, and the old behavior was to fall
    // straight through to `return result` — stranding whatever the primary
    // had already written with no attempt to finish it. When the change set
    // is actually KNOWN (not `filesChangedUnknown`) and non-empty, preserve
    // the tree and hand the SAME backup chain an explicit handoff prompt
    // instead of silently giving up. Unknown file state is still treated as
    // unsafe to hand off (genuinely not knowing what changed is not
    // evidence it's safe to build on), matching leftTreeCleanV1's own
    // "unknown == dirty" rule.
    !authFailure &&
    result.filesChangedUnknown !== true &&
    result.filesChanged.length > 0 &&
    (result.failureKind === "quota" ||
      result.failureKind === "temporarily-unavailable") &&
    options.stage &&
    chooseFallback(setting) === "backup" &&
    getBackupModels(setting).length
  ) {
    if (!options.taskFolderUri) {
      return result;
    }
    const reserved = await reserveFallback(options.taskFolderUri, options.stage);
    if (!reserved) {
      return result;
    }
    const releaseReservation = (): Promise<void> =>
      releaseUnresolvedFallbackReservation(options.taskFolderUri!, options.stage!);
    const mergeFilesChanged = (
      backup: ImplementationRunResult
    ): Pick<ImplementationRunResult, "filesChanged" | "filesChangedUnknown"> => ({
      filesChanged: Array.from(new Set([...result.filesChanged, ...backup.filesChanged])),
      filesChangedUnknown: backup.filesChangedUnknown === true,
    });
    let handedOff = false;
    for (const backupModel of filterEnabledBackupModels(getBackupModels(setting))) {
      if (backupModel === options.modelId) {
        continue;
      }
      // Mirrors the clean-tree cascade's own kind gate above, minus its
      // `runCrossProviderBackup` escape hatch: that callback takes only a
      // modelId, not a prompt override, so it has no way to carry the
      // handoff instructions. When `allowCrossProviderBackups` is false, a
      // cross-kind backup is therefore always skipped for a handoff (a
      // same-kind backup further down the configured list may still be
      // eligible) rather than silently dropping the handoff context.
      if (!options.allowCrossProviderBackups) {
        let backupKind: "cli" | "copilot" | undefined;
        try {
          backupKind = resolveEffectiveProvider(backupModel).kind;
        } catch {
          // Unresolvable — the availability check just below rejects it too.
        }
        if (backupKind !== effective.kind) {
          continue;
        }
      }
      const fallbackAvailability =
        await checkImplementationAvailabilityForModel(backupModel);
      if (!fallbackAvailability.availability.available) {
        const fallbackFailure = {
          ...result,
          status: "failed" as const,
          failureKind: isAuthenticationFailure(fallbackAvailability.availability.reason)
            ? "generic" as const
            : "temporarily-unavailable" as const,
          errorMessage: fallbackAvailability.availability.reason ?? "Backup model is unavailable.",
        };
        recordQuotaObservation(options.stage, backupModel, fallbackFailure.failureKind, fallbackFailure.errorMessage);
        if (isAuthenticationFailure(fallbackAvailability.availability.reason)) {
          await releaseReservation();
          return fallbackFailure;
        }
        continue;
      }
      handedOff = true;
      options.onProgress(
        `Handing off to backup after the primary was interrupted with ${result.filesChanged.length} file(s) already changed.`
      );
      const handoffPrompt = buildBackupHandoffPromptV1(options.prompt, result.filesChanged);
      const fallbackResult = await run(resolveEffectiveProvider(backupModel), handoffPrompt);
      recordQuotaObservation(options.stage, backupModel, fallbackResult.failureKind, fallbackResult.errorMessage);
      const merged = { ...fallbackResult, ...mergeFilesChanged(fallbackResult) };
      if (fallbackResult.status === "completed") {
        await recordActiveFallbackModel(options.taskFolderUri, options.stage, backupModel);
        return merged;
      }
      // Whether the backup itself failed, was cancelled, or left the tree in
      // an unknown state, do not cascade to a THIRD agent: the combined tree
      // is now the product of two attempts and a further handoff would need
      // to describe both, not just the primary's. Stop and report the
      // merged changed-file set on the backup's own outcome.
      await releaseReservation();
      return merged;
    }
    if (!handedOff) {
      await releaseReservation();
    }
  }
  return result;
}

/* ------------------------------------------------------------------------ *
 * V1 reservation-based selection (plan §3.3/§3.4, executable-order step 5) *
 * ------------------------------------------------------------------------ */

/**
 * A registry-selected, session-reserved provider candidate. The registry —
 * not the caller — chose the runner/provider/model; the caller (the future
 * action coordinator) claims the reservation through the selection session
 * and invokes it exactly once through the execution broker.
 */
export interface V1ReservedProviderV1 {
  readonly handle: ProviderReservationHandleV1;
  /** Short display name for user-facing progress ("Copilot", "Claude Code"…). */
  readonly providerLabel: string;
  /**
   * The stored (provider-qualified) model id this reservation ranks —
   * exactly the id the registry's existing ranking policy produced.
   */
  readonly storedModelId: string;
  /**
   * Construct the transport for exactly this reservation's runner.
   * Construction is not invocation: only the execution broker
   * (`agentExecutionBrokerV1.ts`) invokes, after claiming the reservation,
   * and it rejects a transport whose runnerId differs from the handle's.
   *
   * `toolHandler` (plan §7.2/§7.4) carries the per-attempt request-local
   * tool session for `preflight`/`edit` modes — required there, ignored by
   * `text` transports. The COORDINATOR creates it (read session or edit
   * broker handler) so the registry stays a pure selection authority.
   */
  createTransport(toolHandler?: RequestLocalToolHandlerV1): AgentTransportV1;
}

export type V1ReserveNextResultV1 =
  | { readonly kind: "reserved"; readonly reserved: V1ReservedProviderV1 }
  | {
      /**
       * The next ranked candidate — primary or backup — cannot satisfy the
       * requested mode. It is never silently bypassed: the caller's attempt
       * has already been settled as `providerUnavailablePreInvocation`
       * (a fallback-eligible outcome, plan §3.4: a supported runner that
       * cannot satisfy V1 returns `providerModeUnavailable` rather than
       * disappearing), so the skip is an explicit, auditable attempt record.
       * The caller allocates a fresh attempt and calls `reserveNext` again
       * to reach the next ranked candidate.
       */
      readonly kind: "candidateUnavailable";
      readonly code: "providerModeUnavailable";
      /** The ranked stored model id that could not be served. */
      readonly storedModelId: string;
      readonly providerLabel: string;
      readonly runnerId: string;
    }
  | {
      readonly kind: "noneRemaining";
      /**
       * `providerModeUnavailable`: no ranked candidate can satisfy the
       * requested mode at all (maps to the stable coordinator outcome of the
       * same name). `candidatesExhausted`: mode-capable candidates existed
       * but each has already received its reservation (or been settled as an
       * explicit unavailable attempt).
       */
      readonly code: "providerModeUnavailable" | "candidatesExhausted";
    };

export interface V1RunnerSelectionV1 {
  /**
   * Issue the single reservation for `attemptId`, bound to the next
   * registry-ranked candidate. The selection session enforces that the
   * attempt was allocated by the caller's session, that each attempt gets
   * exactly one reservation, and that fallback only proceeds after a
   * pre-response outcome — this function never invokes a provider
   * (AC-RUNNER-04).
   */
  reserveNext(attemptId: AttemptIdV1): V1ReserveNextResultV1;
}

interface V1CandidateV1 {
  readonly storedModelId: string;
  readonly providerLabel: string;
  readonly runnerId: string;
  readonly providerId: ProviderId;
  readonly nativeModelId: string | undefined;
  readonly createTransport: (toolHandler?: RequestLocalToolHandlerV1) => AgentTransportV1;
}

/**
 * Open the registry's V1 selection for one coordinator operation (plan §3.3:
 * selection is split from invocation; plan product decisions: this registry
 * "remains the sole source of provider/model ranking … and fallback policy,
 * but does not invoke V1 fallback providers internally").
 *
 * Ranking reuses the exact legacy policy: the stage's stored primary model
 * resolves through `resolveEffectiveProvider` (including the runner-entry
 * disabled-provider guard), and fallback candidates come from
 * `backupModelsForStage` — the same strategy-gated, provider-enabled,
 * deduplicated list the legacy cascade consumes. Candidates that cannot
 * satisfy the requested mode are rejected here, at selection time (plan
 * §3.4: "Reject providers that cannot satisfy the requested mode"), and
 * never silently bypassed:
 *  - `text`: Copilot LM plus every CLI provider whose final answer is
 *    capturable from bounded stdout (`cliProviderSupportsV1StdoutCapture`);
 *  - `preflight`/`edit`: the Copilot LM path only, through the request-local
 *    tool-session transport (`languageModelToolSessionV1.ts`, plan §7.2);
 *    CLI providers stay `providerModeUnavailable` — §7.5 explicitly requires
 *    the absence of a general-workspace CLI edit path.
 *
 * When NO ranked candidate can satisfy the mode, every `reserveNext` returns
 * `providerModeUnavailable` for the whole selection. When a ranked candidate
 * (the primary or a mid-list backup) cannot satisfy the mode but a later one
 * can, `reserveNext` settles the caller's attempt as an explicit
 * `providerUnavailablePreInvocation` outcome and returns
 * `candidateUnavailable` naming the skipped candidate — the unavailable
 * primary is represented as a settled attempt before any backup attempt is
 * allocated, so fallback stays within the session's normal
 * one-outcome-per-attempt accounting instead of hiding the skip.
 */
export function openV1RunnerSelection(options: {
  session: ProviderSelectionSessionV1;
  mode: AgentExecutionModeV1;
  /** The stage's stored (provider-qualified) primary model id. */
  modelId: string | undefined;
  stage?: TaskStage;
  /**
   * Working directory CLI transports run in (the workspace root). Fixed at
   * selection time by the caller — never carried inside a V1 request.
   */
  workspaceCwd: string;
}): V1RunnerSelectionV1 {
  const { session, mode, workspaceCwd } = options;

  type RankedEntryV1 =
    | { readonly supported: true; readonly candidate: V1CandidateV1 }
    | {
        readonly supported: false;
        readonly storedModelId: string;
        readonly providerLabel: string;
        readonly runnerId: string;
      };

  const toRankedEntry = (storedModelId: string): RankedEntryV1 => {
    const effective = resolveEffectiveProvider(storedModelId);
    if (effective.kind === "copilot") {
      const nativeModelId = effective.model;
      if (mode !== "text") {
        // Preflight/edit run through the request-local LM tool session
        // (plan §7.2/§7.6): the coordinator supplies the per-attempt tool
        // handler; constructing without one is a programmer error, never a
        // model-reachable state.
        return {
          supported: true,
          candidate: {
            storedModelId,
            providerLabel: "Copilot",
            runnerId: "copilot-lm",
            providerId: "copilot",
            nativeModelId,
            createTransport: (toolHandler) => {
              if (!toolHandler) {
                throw new Error(
                  `A ${mode} transport requires the coordinator's request-local tool handler.`
                );
              }
              return createCopilotLmToolSessionTransportV1({
                model: nativeModelId,
                toolHandler,
              });
            },
          },
        };
      }
      return {
        supported: true,
        candidate: {
          storedModelId,
          providerLabel: "Copilot",
          runnerId: "copilot-lm",
          providerId: "copilot",
          nativeModelId,
          createTransport: () => createCopilotLmTextTransportV1({ model: nativeModelId }),
        },
      };
    }
    if (mode !== "text" || !cliProviderSupportsV1StdoutCapture(effective.def)) {
      // CLI providers are unsupported for preflight/edit (plan product
      // decisions), and a last-message-file CLI cannot satisfy AC-RUNNER-02
      // ("CLI results are captured only from bounded stdout") yet. The
      // candidate stays in the ranked list so `reserveNext` can surface it
      // as an explicit settled attempt instead of silently bypassing it.
      return {
        supported: false,
        storedModelId,
        providerLabel: effective.def.label,
        runnerId: effective.def.id,
      };
    }
    const { def } = effective;
    const nativeModelId = effective.model;
    return {
      supported: true,
      candidate: {
        storedModelId,
        providerLabel: def.label,
        runnerId: def.id,
        providerId: def.id,
        nativeModelId,
        createTransport: () =>
          createCliTextTransportV1({ def, model: nativeModelId, cwd: workspaceCwd }),
      },
    };
  };

  // Ranked stored ids: the primary first, then the strategy-gated backups.
  // `resolveEffectiveProvider` throws for a disabled or unconfigured primary
  // (the same fail-closed behavior as the legacy entry points), and
  // `backupModelsForStage` already excludes disabled providers.
  const rankedStoredIds: string[] = [];
  if (options.modelId !== undefined) {
    rankedStoredIds.push(options.modelId);
  } else {
    // Surface the exact legacy misconfiguration error at selection time.
    resolveEffectiveProvider(undefined);
  }
  rankedStoredIds.push(...backupModelsForStage(options.stage, options.modelId));

  const ranked = rankedStoredIds.map(toRankedEntry);
  const anySupported = ranked.some((entry) => entry.supported);
  let cursor = 0;

  return {
    reserveNext(attemptId: AttemptIdV1): V1ReserveNextResultV1 {
      if (!anySupported) {
        // No ranked candidate can satisfy this mode at all — the whole
        // selection is mode-unavailable (there is nothing to fall back TO,
        // so no per-candidate attempt accounting is warranted).
        return { kind: "noneRemaining", code: "providerModeUnavailable" };
      }
      if (cursor >= ranked.length) {
        return { kind: "noneRemaining", code: "candidatesExhausted" };
      }
      const entry = ranked[cursor]!;
      cursor++;
      if (!entry.supported) {
        // Never silently bypass a ranked candidate (primary OR backup):
        // record it as an explicit settled attempt with the fallback-eligible
        // `providerUnavailablePreInvocation` outcome, so the skip is
        // auditable in the session and the caller allocates a FRESH attempt
        // for the next ranked candidate.
        session.reportAttemptOutcome(attemptId, "providerUnavailablePreInvocation");
        return {
          kind: "candidateUnavailable",
          code: "providerModeUnavailable",
          storedModelId: entry.storedModelId,
          providerLabel: entry.providerLabel,
          runnerId: entry.runnerId,
        };
      }
      const { candidate } = entry;
      const handle = session.reserve({
        attemptId,
        mode,
        runnerId: candidate.runnerId,
        providerId: candidate.providerId,
        modelId: candidate.storedModelId,
      });
      return {
        kind: "reserved",
        reserved: {
          handle,
          providerLabel: candidate.providerLabel,
          storedModelId: candidate.storedModelId,
          createTransport: candidate.createTransport,
        },
      };
    },
  };
}

/**
 * Production opener for the action coordinator's provider boundary
 * (`RunnerSelectionOpenerV1` in `taskActionCoordinatorV1.ts`, plan §3.8).
 *
 * Binds `openV1RunnerSelection` — keeping this registry the sole source of
 * provider/model ranking and fallback policy — to the invocation-fixed
 * workspace cwd and the invoking route's stage-model resolution. Per
 * operation, the coordinator hands over its own selection session, the
 * row's provider mode, and the request's canonical stage; the registry then
 * ranks candidates and issues every reservation through that session. The
 * opener never invokes a provider (AC-RUNNER-04) — invocation stays with
 * the execution broker.
 */
export function createV1RunnerSelectionOpener(options: {
  /** Working directory CLI transports run in (the workspace root). */
  workspaceCwd: string;
  /**
   * Resolve the coordinator request's canonical stage to the stage's stored
   * (provider-qualified) primary model id and stage key — exactly what the
   * legacy entry points pass today. Returning `modelId: undefined` surfaces
   * the legacy misconfiguration error at selection time.
   */
  resolveStagePrimaryModel: (taskStage: string) => {
    readonly modelId: string | undefined;
    readonly stage: TaskStage | undefined;
  };
}): (request: {
  readonly session: ProviderSelectionSessionV1;
  readonly mode: AgentExecutionModeV1;
  readonly taskStage: string;
}) => V1RunnerSelectionV1 {
  return (request) => {
    const resolved = options.resolveStagePrimaryModel(request.taskStage);
    return openV1RunnerSelection({
      session: request.session,
      mode: request.mode,
      modelId: resolved.modelId,
      stage: resolved.stage,
      workspaceCwd: options.workspaceCwd,
    });
  };
}
