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
  CliProviderDefinition,
  getCliProvider,
  parseModelSelection,
  ProviderId,
} from "./providers";
import { getModelSettings } from "../config/settings";
import { chooseFallback } from "../utils/modelFallback";
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
    return {
      ...current,
      fallbackActive: {
        ...current.fallbackActive,
        [stage]: true,
      },
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
  stage?: import("../types/taskProgress").TaskStage,
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
  const setting = getModelSettings()[stage];
  if (!setting?.fallbackEnabled || setting.strategy !== "switch-to-backup" || !setting.backup || setting.backup === modelId) {
    return { ...resolved, runner: instrumented };
  }
  const fallback = toResolvedRunner(resolveEffectiveProvider(setting.backup));
  return {
    ...resolved,
    runner: {
      id: instrumented.id,
      label: instrumented.label,
      capabilities: instrumented.capabilities,
      isAvailable: () => instrumented.isAvailable(),
      async run(request, token): Promise<AgentRunResult> {
        const result = await primary.run(request, token);
        recordQuotaObservation(stage, modelId, result.failureKind, result.errorMessage);
        if (result.failureKind !== "quota") {
          return result;
        }

        const folder = taskFolderUri ?? request.taskFolderUri;
        if (folder) {
          const reserved = await reserveFallback(folder, stage);
          if (!reserved) {
            return result;
          }
        }

        const fallbackResult = await fallback.runner.run({ ...request, modelId: fallback.nativeModelId }, token);
        recordQuotaObservation(stage, setting.backup, fallbackResult.failureKind, fallbackResult.errorMessage);
        return fallbackResult;
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
  modelId: string | undefined
): Promise<{ availability: AgentAvailability; providerLabel: string }> {
  const effective = resolveEffectiveProvider(modelId);
  if (effective.kind === "copilot") {
    return {
      availability: await checkImplementationAvailability(),
      providerLabel: "Copilot",
    };
  }
  const { def } = effective;
  const exists = await cliCommandExists(def.command, def.commandAliases);
  return {
    availability: exists
      ? { available: true }
      : {
          available: false,
          reason: `The ${def.label} CLI (${def.command}) is not installed. ${def.installHint}`,
        },
    providerLabel: def.label,
  };
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
  stage?: import("../types/taskProgress").TaskStage;
  taskFolderUri?: vscode.Uri;
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
      });
      return { ...result, runnerId: selected.def.id };
    }

    const result = await runImplementationWithCopilot({
      prompt: options.prompt,
      modelId: selected.model,
      workspaceUri: options.workspaceUri,
      token: options.token,
      onProgress: options.onProgress,
    });
    return { ...result, runnerId: "copilot-lm" };
  };
  const result = await run(effective);
  if (options.stage) {
    recordQuotaObservation(options.stage, options.modelId, result.failureKind, result.errorMessage);
  }
  const setting = getModelSettings()[options.stage as keyof ReturnType<typeof getModelSettings>];
  if (result.failureKind === "quota" && options.stage && chooseFallback(setting) === "backup" && setting?.backup) {
    if (options.taskFolderUri) {
      const reserved = await reserveFallback(options.taskFolderUri, options.stage);
      if (!reserved) {
        return result;
      }
    }
    const fallbackResult = await run(resolveEffectiveProvider(setting.backup));
    recordQuotaObservation(options.stage, setting.backup, fallbackResult.failureKind, fallbackResult.errorMessage);
    return fallbackResult;
  }
  return result;
}
