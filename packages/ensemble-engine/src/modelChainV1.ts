/**
 * Effective model-chain resolution (plan Part 4b port of
 * `src/utils/modelSelection.ts`'s `resolveEffectiveStageChainV1` /
 * `skipFilteredChainOf` and `src/runners/runnerRegistry.ts`'s
 * `backupModelsForStage` / `getConfiguredBackupModelsForStage`).
 *
 * All functions here are pure over a settings SNAPSHOT (`ModelSettings` +
 * `EnabledProviders` from `@ensemble/core`'s settings shapes) — reading the
 * live settings source is host-specific (VS Code configuration there, the
 * control-plane settings store here) and stays with the caller.
 */
import {
  EnabledProviders,
  FallbackStrategy,
  ModelSettings,
  StageModelSetting,
} from "../../ensemble-core/src/settingsV1";
import { TaskStage } from "../../ensemble-core/src/taskProgressV1";
import {
  isEngineModelProviderDisabledV1,
  normalizeEngineQualifiedModelIdV1,
} from "./providerCatalogV1";

/**
 * The stage whose configured chain doubles as the general model: the default
 * for any stage with no (enabled) model of its own.
 */
export const GENERAL_MODEL_STAGE_V1: TaskStage = "desc";

export type EffectiveChainSourceV1 = "stage" | "general" | "none";

/** The effective, skip-filtered model chain a stage resolves to. */
export interface EffectiveStageChainV1 {
  /** Stage whose configured chain actually supplies the models
   * (=== the requested stage unless source is "general"). */
  readonly originStage: TaskStage;
  readonly source: EffectiveChainSourceV1;
  readonly primary?: string;
  readonly backups: readonly string[];
  readonly strategy?: FallbackStrategy;
}

/**
 * Skip-filtered view of one stage's OWN configured chain: backups whose
 * `backupsEnabled` flag is false are dropped, and a skipped (or absent)
 * primary promotes the first enabled backup into the effective primary slot
 * with the rest kept in order.
 */
function skipFilteredChainOf(
  setting: StageModelSetting | undefined
): { primary?: string; backups: string[] } {
  if (!setting) {
    return { backups: [] };
  }
  const configured =
    Array.isArray(setting.backups) && setting.backups.length > 0
      ? setting.backups
      : setting.backup
        ? [setting.backup]
        : [];
  const flags = setting.backupsEnabled;
  const seen = new Set<string>();
  let backups: string[] = [];
  configured.forEach((model, index) => {
    if (typeof model !== "string" || model.trim().length === 0) {
      return;
    }
    if (flags && flags[index] === false) {
      return;
    }
    const trimmed = model.trim();
    if (seen.has(trimmed)) {
      return;
    }
    seen.add(trimmed);
    backups.push(trimmed);
  });
  let primary = setting.primaryEnabled === false ? undefined : setting.primary;
  if (!primary && backups.length > 0) {
    primary = backups[0];
    backups = backups.slice(1);
  }
  return { primary, backups: backups.filter((model) => model !== primary) };
}

/**
 * The single resolver for "which model chain does this stage actually run
 * with". Tier order: the stage's own skip-filtered chain; else the general
 * model's chain (with the general chain's backups AND strategy); else
 * nothing configured anywhere.
 */
export function resolveEffectiveStageChainV1(
  settings: ModelSettings,
  stage: TaskStage
): EffectiveStageChainV1 {
  const own = skipFilteredChainOf(settings[stage]);
  if (own.primary) {
    const strategy = settings[stage]?.strategy;
    return {
      originStage: stage,
      source: "stage",
      primary: own.primary,
      backups: own.backups,
      ...(strategy !== undefined ? { strategy } : {}),
    };
  }
  if (stage !== GENERAL_MODEL_STAGE_V1) {
    const general = skipFilteredChainOf(settings[GENERAL_MODEL_STAGE_V1]);
    if (general.primary) {
      const strategy = settings[GENERAL_MODEL_STAGE_V1]?.strategy;
      return {
        originStage: GENERAL_MODEL_STAGE_V1,
        source: "general",
        primary: general.primary,
        backups: general.backups,
        ...(strategy !== undefined ? { strategy } : {}),
      };
    }
  }
  return { originStage: stage, source: "none", backups: [] };
}

/** Drop backup candidates whose provider is disabled so a fallback can never
 * route around the runner-entry guard. */
export function filterEnabledBackupModelsV1(
  enabledProviders: EnabledProviders | undefined,
  models: readonly string[]
): string[] {
  return models.filter(
    (candidate) => !isEngineModelProviderDisabledV1(enabledProviders, candidate)
  );
}

/**
 * Configured backup models for a stage, excluding `modelId` itself and any
 * provider currently disabled — but ONLY when the stage's effective fallback
 * strategy is "switch-to-backup" (the quota-triggered automatic switch-over
 * opt-in). A stage configured with "never-switch" returns nothing here, by
 * design: that strategy means the user explicitly
 * does NOT want an automatic provider swap on quota failure.
 */
export function backupModelsForStageV1(
  settings: ModelSettings,
  enabledProviders: EnabledProviders | undefined,
  stage: TaskStage,
  modelId: string | undefined
): string[] {
  const chain = resolveEffectiveStageChainV1(settings, stage);
  if (chain.strategy !== "switch-to-backup") {
    return [];
  }
  const primary = modelId !== undefined ? normalizeEngineQualifiedModelIdV1(modelId) : undefined;
  const seen = new Set<string>();
  return filterEnabledBackupModelsV1(enabledProviders, chain.backups).filter((candidate) => {
    const normalized = normalizeEngineQualifiedModelIdV1(candidate);
    if (normalized === primary || seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
    return true;
  });
}

/**
 * Every configured backup model for a stage, excluding `modelId` itself and
 * any disabled provider — regardless of the stage's fallback strategy.
 * Ported for the deliberate second-opinion mechanism (a plateau-triggered
 * review against a different model), which must not be silently inert for
 * users who opted out of automatic quota switch-over.
 */
export function getConfiguredBackupModelsForStageV1(
  settings: ModelSettings,
  enabledProviders: EnabledProviders | undefined,
  stage: TaskStage,
  modelId: string | undefined
): string[] {
  return filterEnabledBackupModelsV1(
    enabledProviders,
    resolveEffectiveStageChainV1(settings, stage).backups.filter(
      (candidate) => candidate !== modelId
    )
  );
}

/** The per-stage sticky-fallback routing state (see the dispatch store). */
export interface EngineStageFallbackStateV1 {
  readonly active: boolean;
  readonly modelId?: string;
}

export interface ResolvedEngineStageModelV1 {
  readonly modelId?: string;
  readonly source: "stage" | "general" | "none";
}

/**
 * Resolve the model a stage should run with, honoring an active sticky
 * fallback (port of `resolveModelForStage`'s settings semantics): when the
 * strategy is "switch-to-backup" and a fallback is active for the stage, the
 * recorded fallback model is used if it is still among the chain's backups,
 * else the first backup; otherwise the chain's primary.
 */
export function resolveEngineModelForStageV1(
  settings: ModelSettings,
  stage: TaskStage,
  fallbackState: EngineStageFallbackStateV1
): ResolvedEngineStageModelV1 {
  const chain = resolveEffectiveStageChainV1(settings, stage);
  if (!chain.primary) {
    return { source: "none" };
  }
  const source = chain.source === "general" ? "general" : "stage";
  if (
    fallbackState.active &&
    chain.strategy === "switch-to-backup" &&
    chain.backups.length > 0
  ) {
    const active = fallbackState.modelId;
    const modelId =
      active !== undefined && chain.backups.includes(active) ? active : chain.backups[0];
    return modelId !== undefined ? { modelId, source } : { modelId: chain.primary, source };
  }
  return { modelId: chain.primary, source };
}
