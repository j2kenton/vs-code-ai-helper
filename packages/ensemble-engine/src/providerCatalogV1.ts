/**
 * Direct-API model-provider catalog (plan Part 4b port of the selection
 * vocabulary in `src/runners/providers.ts`).
 *
 * The extension's providers are VS Code LM (Copilot) plus subscription CLI
 * tools; neither exists in the engine's service context. Per the plan, the
 * VS Code LM-bound and CLI-transport paths are REPLACED with direct model
 * provider API calls using user-configured credentials, while the stored-id
 * vocabulary keeps the extension's semantics: provider-qualified
 * `<provider>:<model>` ids, `"default"`/empty meaning the provider's default
 * model, a per-provider `legacyModelAliases` table resolved during parsing,
 * and `normalize`/`toQualified` helpers so every consumer agrees on one
 * canonical id per model.
 *
 * One deliberate deviation, stated for reviewers: the extension maps BARE
 * ids (no provider prefix) to Copilot because pre-provider configurations
 * stored raw `vscode.lm` ids. The engine has no Copilot path and no legacy
 * store, so a bare or unknown-prefixed id is a typed parse failure instead
 * of a silent guess — there is nothing correct to guess.
 *
 * One CLI-transport provider has since RETURNED, deliberately: `claude-cli`
 * (`sandboxCliRunnerV1.ts`) runs the real Claude Code CLI inside the task's
 * sandbox, authenticated by the CLI's own subscription login there — the
 * "bring your own subscription" path, and the one closest to how the
 * extension runs locally. It carries no API key, no base URL, and no
 * adapter; `transport` is what dispatch branches on.
 */
import { EnabledProviders } from "../../ensemble-core/src/settingsV1";

export type EngineProviderIdV1 = "anthropic" | "openai" | "google" | "claude-cli";

/**
 * How a provider's rounds are actually executed: `direct-api` calls the
 * model's HTTP API from the engine host through an adapter and a
 * user-supplied key; `sandbox-cli` runs a subscription CLI inside the task's
 * sandbox, with whatever login the CLI persisted there.
 */
export type EngineProviderTransportV1 = "direct-api" | "sandbox-cli";

interface EngineProviderDefinitionBaseV1 {
  readonly id: EngineProviderIdV1;
  /** Short display name for user-facing messages ("Anthropic", "OpenAI"…). */
  readonly label: string;
  /** Old stored model names mapped to their current canonical form. */
  readonly legacyModelAliases?: Readonly<Record<string, string>>;
}

export interface EngineDirectApiProviderDefinitionV1 extends EngineProviderDefinitionBaseV1 {
  readonly transport: "direct-api";
  /** Provider-native model used when a selection names no model. */
  readonly defaultModel: string;
  /** Default API base URL (override per-adapter for proxies/self-hosting). */
  readonly defaultBaseUrl: string;
}

export interface EngineSandboxCliProviderDefinitionV1 extends EngineProviderDefinitionBaseV1 {
  readonly transport: "sandbox-cli";
  /**
   * No `defaultModel`: a selection naming no model runs the CLI with no
   * `--model` flag at all, so the CLI's own (account-level) default applies —
   * exactly as the extension's "Sonnet (Default, recommended)" entry does.
   */
}

export type EngineProviderDefinitionV1 =
  | EngineDirectApiProviderDefinitionV1
  | EngineSandboxCliProviderDefinitionV1;

export const ENGINE_PROVIDERS_V1: readonly EngineProviderDefinitionV1[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    transport: "direct-api",
    defaultModel: "claude-sonnet-5",
    defaultBaseUrl: "https://api.anthropic.com",
    legacyModelAliases: {
      sonnet: "claude-sonnet-5",
      opus: "claude-opus-5",
      haiku: "claude-haiku-4-5",
    },
  },
  {
    id: "openai",
    label: "OpenAI",
    transport: "direct-api",
    defaultModel: "gpt-5.4",
    defaultBaseUrl: "https://api.openai.com",
  },
  {
    id: "google",
    label: "Google",
    transport: "direct-api",
    defaultModel: "gemini-3.1-pro",
    defaultBaseUrl: "https://generativelanguage.googleapis.com",
  },
  {
    // Same id and label as the extension's `CLI_PROVIDERS` entry, so a
    // stored `claude-cli:<model>` id means the same thing in both hosts.
    // Model names are the CLI's own (`sonnet`, `opus`, `claude-opus-5`…),
    // optionally with the extension's `@<effort>` suffix — no aliasing.
    id: "claude-cli",
    label: "Claude Code",
    transport: "sandbox-cli",
  },
];

export function getEngineProviderV1(
  id: string,
  catalog: readonly EngineProviderDefinitionV1[] = ENGINE_PROVIDERS_V1
): EngineProviderDefinitionV1 | undefined {
  return catalog.find((def) => def.id === id);
}

/**
 * The narrowed lookup the HTTP adapters use: they are each written for one
 * specific direct-API provider, so a catalog entry of any other transport
 * under that id is a programming error, not a runtime condition.
 */
export function getEngineDirectApiProviderV1(id: EngineProviderIdV1): EngineDirectApiProviderDefinitionV1 {
  const def = getEngineProviderV1(id);
  if (def === undefined || def.transport !== "direct-api") {
    throw new Error(`engine provider ${JSON.stringify(id)} is not a direct-API provider`);
  }
  return def;
}

export interface ParsedEngineModelSelectionV1 {
  readonly provider: EngineProviderDefinitionV1;
  /** Provider-native model name; undefined means the provider's default. */
  readonly model: string | undefined;
}

export type ParseEngineModelSelectionResultV1 =
  | { readonly ok: true; readonly selection: ParsedEngineModelSelectionV1 }
  | {
      readonly ok: false;
      readonly code: "unqualifiedModelId" | "unknownProvider";
      readonly reason: string;
    };

/**
 * Parse a stored engine model id into provider + native model name.
 * `<provider>:` and `<provider>:default` both mean the provider's default
 * model; legacy aliases resolve during parsing, exactly as the extension's
 * `parseModelSelection` does for CLI providers.
 */
export function parseEngineModelSelectionV1(
  modelId: string,
  catalog: readonly EngineProviderDefinitionV1[] = ENGINE_PROVIDERS_V1
): ParseEngineModelSelectionResultV1 {
  const separator = modelId.indexOf(":");
  if (separator <= 0) {
    return {
      ok: false,
      code: "unqualifiedModelId",
      reason: `Model id ${JSON.stringify(modelId)} is not provider-qualified ("<provider>:<model>").`,
    };
  }
  const prefix = modelId.substring(0, separator);
  const rest = modelId.substring(separator + 1);
  const provider = getEngineProviderV1(prefix, catalog);
  if (!provider) {
    return {
      ok: false,
      code: "unknownProvider",
      reason: `Model id ${JSON.stringify(modelId)} names an unknown provider ${JSON.stringify(prefix)}.`,
    };
  }
  const model =
    rest === "default" || rest === ""
      ? undefined
      : (provider.legacyModelAliases?.[rest] ?? rest);
  return { ok: true, selection: { provider, model } };
}

/** Build the qualified model id stored in settings/task records. */
export function toEngineQualifiedModelIdV1(
  provider: EngineProviderIdV1,
  model: string | undefined
): string {
  return `${provider}:${model ?? "default"}`;
}

/**
 * Rewrite a stored qualified model id to its current canonical form
 * (aliases resolved), so dedupe/comparison agrees across consumers. An
 * unparseable id is returned unchanged — comparison-only callers must not
 * throw on a stored id that the run-time guard will reject anyway.
 */
export function normalizeEngineQualifiedModelIdV1(
  modelId: string,
  catalog: readonly EngineProviderDefinitionV1[] = ENGINE_PROVIDERS_V1
): string {
  const parsed = parseEngineModelSelectionV1(modelId, catalog);
  if (!parsed.ok) {
    return modelId;
  }
  return toEngineQualifiedModelIdV1(parsed.selection.provider.id, parsed.selection.model);
}

/**
 * Whether a provider selection exists at all. The extension's guard
 * (`isProviderSelectionConfigured`) is active only once the user has
 * actually configured `enabledProviders` in some scope — a fresh state with
 * no value blocks nothing. The engine mirrors that: `undefined` means "never
 * configured".
 */
export function isEngineProviderSelectionConfiguredV1(
  enabledProviders: EnabledProviders | undefined
): boolean {
  return enabledProviders !== undefined;
}

/**
 * Whether the Provider Selection row governing this exact model is enabled.
 * Engine providers all require explicit opt-in (`true`) once a selection
 * exists — there is no Copilot-style default-enabled special case: every
 * engine provider needs something the user must supply first (an API key,
 * or a CLI login inside their sandbox).
 */
export function isEngineModelProviderEnabledV1(
  enabledProviders: EnabledProviders | undefined,
  modelId: string,
  catalog: readonly EngineProviderDefinitionV1[] = ENGINE_PROVIDERS_V1
): boolean {
  const parsed = parseEngineModelSelectionV1(modelId, catalog);
  if (!parsed.ok) {
    return false;
  }
  return (enabledProviders ?? {})[parsed.selection.provider.id] === true;
}

/**
 * Runner-entry guard (port of `isModelProviderDisabled` in
 * `runnerRegistry.ts`): a model belonging to a provider the user has
 * disabled must never run, no matter which path resolved it. Active only
 * once a provider selection actually exists.
 */
export function isEngineModelProviderDisabledV1(
  enabledProviders: EnabledProviders | undefined,
  modelId: string,
  catalog: readonly EngineProviderDefinitionV1[] = ENGINE_PROVIDERS_V1
): boolean {
  return (
    isEngineProviderSelectionConfiguredV1(enabledProviders) &&
    !isEngineModelProviderEnabledV1(enabledProviders, modelId, catalog)
  );
}
