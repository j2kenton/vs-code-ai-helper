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
  parseModelSelection,
  ProviderId,
} from "./providers";
import { getModelSettings } from "../config/settings";
import { chooseFallback, getBackupModels } from "../utils/modelFallback";
import { recordQuotaObservation } from "../utils/quota";
import { patchTaskProgress } from "../utils/taskProgressUtils";
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
function resolveEffectiveProvider(
  modelId: string | undefined
): EffectiveProvider {
  const parsed = parseModelSelection(modelId);
  if (parsed.provider !== "copilot") {
    const def = getCliProvider(parsed.provider);
    if (def) {
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

function backupModelsForStage(
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
  return getBackupModels(setting).filter(candidate => candidate !== modelId);
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

async function recordActiveFallbackModel(
  taskFolderUri: vscode.Uri,
  stage: TaskStage,
  modelId: string
): Promise<void> {
  await patchTaskProgress(taskFolderUri, (current) => ({
    ...current,
    fallbackActive: {
      ...current.fallbackActive,
      [stage]: true,
    },
    fallbackModelId: {
      ...current.fallbackModelId,
      [stage]: modelId,
    },
  }));
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
  stage: TaskStage
): Promise<boolean> {
  let activated = false;
  await patchTaskProgress(taskFolderUri, (current) => {
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
 * Resolve the runner responsible for a stored stage model ID (plan/review
 * stages — see resolveEffectiveProvider for the auto-detection rules).
 */
export function resolveRunnerForModel(
  modelId: string | undefined,
  stage?: TaskStage,
  taskFolderUri?: vscode.Uri
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
                return last;
              }
              continue;
            }
            const fallbackResult = await fallback.runner.run({ ...request, modelId: fallback.nativeModelId }, token);
            recordQuotaObservation(stage, backupModel, fallbackResult.failureKind, fallbackResult.errorMessage);
            last = fallbackResult;
            if (
              fallbackResult.failureKind !== "quota" &&
              fallbackResult.failureKind !== "temporarily-unavailable"
            ) {
              await recordActiveFallbackModel(
                taskFolderUri ?? request.taskFolderUri,
                stage,
                backupModel
              );
              return fallbackResult;
            }
          }
          return last ?? { runnerId: primary.id, status: "failed", failureKind: "temporarily-unavailable", errorMessage: "No backup model is available." };
        };
        const availability = await primary.isAvailable();
        // Never spend a backup allocation on credentials/configuration errors.
        // Providers commonly report these as plain HTTP status text.
        const authenticationFailure = isAuthenticationFailure(availability.reason);
        if (!availability.available && !authenticationFailure) {
          const folder = taskFolderUri ?? request.taskFolderUri;
          if (folder && await reserveFallback(folder, stage)) {
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
        const reserved = await reserveFallback(folder, stage);
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
    for (const backupModel of getBackupModels(setting)) {
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
          return fallbackFailure;
        }
        continue;
      }
      const fallbackResult = await run(resolveEffectiveProvider(backupModel));
      recordQuotaObservation(options.stage, backupModel, fallbackResult.failureKind, fallbackResult.errorMessage);
      if (
        fallbackResult.status !== "failed" ||
        (fallbackResult.failureKind !== "quota" &&
          fallbackResult.failureKind !== "temporarily-unavailable")
      ) {
        await recordActiveFallbackModel(
          options.taskFolderUri,
          options.stage,
          backupModel
        );
        return fallbackResult;
      }
    }
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
