import * as vscode from "vscode";
import { AgentAvailability, AgentRunner } from "../types/agentRunner";
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
  CLI_PROVIDERS,
  CliProviderDefinition,
  getCliProvider,
  parseModelSelection,
  ProviderId,
} from "./providers";

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
async function resolveEffectiveProvider(
  modelId: string | undefined
): Promise<EffectiveProvider> {
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

  // No stage model configured at all: prefer Copilot, but fall back to
  // whichever CLI provider is actually installed.
  const copilotAvailable = await new CopilotLanguageModelRunner()
    .isAvailable()
    .then((a) => a.available)
    .catch(() => false);
  if (copilotAvailable) {
    return { kind: "copilot", model: undefined };
  }

  for (const def of CLI_PROVIDERS) {
    if (await cliCommandExists(def.command, def.commandAliases)) {
      return { kind: "cli", def, model: undefined };
    }
  }

  return { kind: "copilot", model: undefined };
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

/**
 * Resolve the runner responsible for a stored stage model ID (plan/review
 * stages — see resolveEffectiveProvider for the auto-detection rules).
 */
export async function resolveRunnerForModel(
  modelId: string | undefined
): Promise<ResolvedRunner> {
  return toResolvedRunner(await resolveEffectiveProvider(modelId));
}

/**
 * Availability check for an implementation (code-editing) run with the
 * provider a stage's model ID selects (or auto-detects — see
 * resolveEffectiveProvider).
 */
export async function checkImplementationAvailabilityForModel(
  modelId: string | undefined
): Promise<{ availability: AgentAvailability; providerLabel: string }> {
  const effective = await resolveEffectiveProvider(modelId);
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
}): Promise<ImplementationRunResult & { runnerId: string }> {
  const effective = await resolveEffectiveProvider(options.modelId);

  if (effective.kind === "cli") {
    const result = await runImplementationWithCli({
      def: effective.def,
      model: effective.model,
      prompt: options.prompt,
      workspaceUri: options.workspaceUri,
      token: options.token,
      onProgress: options.onProgress,
    });
    return { ...result, runnerId: effective.def.id };
  }

  const result = await runImplementationWithCopilot({
    prompt: options.prompt,
    modelId: effective.model,
    workspaceUri: options.workspaceUri,
    token: options.token,
    onProgress: options.onProgress,
  });
  return { ...result, runnerId: "copilot-lm" };
}
