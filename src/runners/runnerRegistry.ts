import * as vscode from "vscode";
import {
  AgentAvailability,
  AgentRunner,
  AgentRunResult,
} from "../types/agentRunner";
import { CopilotLanguageModelRunner } from "./copilotLanguageModelRunner";
import {
  checkImplementationAvailability,
  ImplementationRunResult,
  runImplementationWithCopilot,
} from "./copilotImplementationRunner";
import {
  CliAgentRunner,
  cliCommandExists,
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
import { recordQuotaObservation } from "../utils/quota";
import {
  clearStageFallbackReservation,
  patchTaskProgress,
} from "../utils/taskProgressUtils";
import { TaskStage } from "../types/taskProgress";

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

function resolveEffectiveProvider(
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
 * independent of that strategy choice. Also exported for runAiToFile's
 * content-validation retry (reviewActions.ts): a model that exits cleanly
 * with unusable content is, from the user's automatic-switch-over
 * preference's point of view, exactly the same question as a quota failure —
 * so it must honor the same strategy gate, not the second-opinion mechanism's
 * strategy-agnostic list below.
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
 * primary. Exported for runAiToFile's content-validation retry
 * (reviewActions.ts), which needs to record the same outcome when ITS OWN
 * backup search (not this file's quota/unavailable cascade) is what actually
 * found the working model.
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
  await patchTaskProgress(taskFolderUri, (current) => {
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
      const result = await runner.run(request, token);
      recordQuotaObservation(stage, modelId, result.failureKind, result.errorMessage);
      return result;
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
  await patchTaskProgress(taskFolderUri, (current) => {
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
  await patchTaskProgress(taskFolderUri, (current) => {
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
    return resolved;
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
}): Promise<ImplementationRunResult & { runnerId: string }> {
  const effective = resolveEffectiveProvider(options.modelId);

  const run = async (selected: EffectiveProvider): Promise<ImplementationRunResult & { runnerId: string }> => {
    if (selected.kind === "cli") {
      const result = await runImplementationWithCli({
        def: selected.def,
        model: selected.model,
        prompt: options.prompt,
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
      prompt: options.prompt,
      modelId: selected.model,
      workspaceUri: options.workspaceUri,
      token: options.token,
      onProgress: options.onProgress,
      onBusyDetail: options.onBusyDetail,
    });
    return { ...result, runnerId: "copilot-lm" };
  };
  const result = await run(effective);
  if (options.stage) {
    recordQuotaObservation(options.stage, options.modelId, result.failureKind, result.errorMessage);
  }
  const setting = getModelSettings()[options.stage as keyof ReturnType<typeof getModelSettings>];
  const authFailure = isAuthenticationFailure(result.errorMessage);
  if (
    !authFailure &&
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
      const fallbackResult = await run(resolveEffectiveProvider(backupModel));
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
    }
    await releaseReservation();
  }
  return result;
}

// Authentication failures are terminal for the selected provider. Keep this
// deliberately broad: providers often label expired credentials as generic
// unavailability (or even "try again later"-style transient wording) rather
// than a clean 401/403, so a narrow match would auto-fallback to the backup
// model on what is actually an auth problem — exactly what callers must
// never do (see the two call sites below). Exported for direct unit testing.
export function isAuthenticationFailure(message: string | undefined): boolean {
  const value = message ?? "";
  if (/not\s+installed|command\s+not\s+found|could\s+not\s+start\b/i.test(value)) {
    return false;
  }
  // "session"/"token" tolerate a short word gap (e.g. "session has timed
  // out", "token has been revoked") instead of requiring the state word to
  // sit directly next to the noun.
  return /sign[\s-]*in|log(?:ged|ging)?[\s-]*(?:in|out)|session(?:\s+\w+){0,3}\s+(?:expired|invalid|missing|timed?\s*out)|authenticat\w*|authoris\w*|authoriz\w*|credential|re[-\s]?auth\w*|token(?:\s+\w+){0,3}\s+(?:expired|invalid|missing|revoked)|api\s*key|access\s*denied|permission\s*denied|forbidden|unauthori[sz]ed|\b(?:401|403)\b/i.test(value);
}
