/**
 * bugs6 item 3: AI Models names every stage with its group, warns before a save leaves a stage with no enabled model,
 * remembers which stage's model the owner changed last, and says so when a round finds a stage with nothing enabled
 * ("GLM 5.3 was just enabled on High-Level Review (Plan); did you mean High-Level Code Review?").
 */
import { AI_MODEL_STAGES, STAGE_DISPLAY_NAMES, type TaskStage } from "../types/taskProgress";
import type { ModelSettings, StageModelSetting } from "./modelFallback";

/**
 * bugs8 item 5: a stage has one name everywhere, the Tasks pane's (`STAGE_DISPLAY_NAMES`). The two Plan review stages
 * keep "(Plan)" in it ("High-Level Review (Plan)" against "High-Level Code Review"), so they cannot be taken for the
 * code reviews. AI Models, its cards, the quota card and Fast Forward's stop lines all name stages through this.
 */
export function stageGroupLabelV1(stage: TaskStage): string {
  return STAGE_DISPLAY_NAMES[stage] ?? stage;
}

/** The enabled model ids of one stage's chain, primary first. */
export function enabledModelsOfStageV1(setting: StageModelSetting | undefined): string[] {
  if (!setting) return [];
  const out: string[] = [];
  if (setting.primary && setting.primaryEnabled !== false) out.push(setting.primary);
  (setting.backups ?? []).forEach((backup, index) => {
    if (backup && setting.backupsEnabled?.[index] !== false) out.push(backup);
  });
  return out;
}

/** Every configured model id of one stage's chain, enabled or not. */
function configuredModelsOfStageV1(setting: StageModelSetting | undefined): string[] {
  if (!setting) return [];
  return [...(setting.primary ? [setting.primary] : []), ...(setting.backups ?? []).filter((b) => !!b)];
}

/**
 * The stages a save would leave with no enabled model although they had one, or still list models that are all
 * switched off. A stage that was never configured (nothing in it, nothing before) falls back to the default chain and is
 * not counted.
 */
export function stagesLeftWithoutEnabledModelV1(previous: ModelSettings, next: ModelSettings): TaskStage[] {
  return AI_MODEL_STAGES.filter((stage) => {
    if (enabledModelsOfStageV1(next[stage]).length > 0) return false;
    return configuredModelsOfStageV1(next[stage]).length > 0 || enabledModelsOfStageV1(previous[stage]).length > 0;
  });
}

/** A model the owner switched on (or added) in the last save, and the stage it went to. */
export interface LastModelChangeV1 {
  readonly stage: TaskStage;
  readonly modelId: string;
  readonly at: string;
}

/** The first model that is enabled in `next` but was not enabled in `previous` for the same stage. */
export function findNewlyEnabledModelV1(previous: ModelSettings, next: ModelSettings): { stage: TaskStage; modelId: string } | undefined {
  for (const stage of AI_MODEL_STAGES) {
    const before = new Set(enabledModelsOfStageV1(previous[stage]));
    const added = enabledModelsOfStageV1(next[stage]).find((model) => !before.has(model));
    if (added !== undefined) return { stage, modelId: added };
  }
  return undefined;
}

let lastModelChangeV1: LastModelChangeV1 | undefined;

/** Remembers the model a save enabled, when it enabled one. Called by AI Models after it writes the settings. */
export function recordModelSettingsSaveV1(previous: ModelSettings, next: ModelSettings, now: Date = new Date()): void {
  const added = findNewlyEnabledModelV1(previous, next);
  if (added !== undefined) {
    lastModelChangeV1 = { ...added, at: now.toISOString() };
  }
}

export function getLastModelChangeV1(): LastModelChangeV1 | undefined {
  return lastModelChangeV1;
}

/** @internal tests only */
export function __resetLastModelChangeForTestV1(): void {
  lastModelChangeV1 = undefined;
}

/** The confirmation shown before a save that leaves stages with no enabled model. */
export function describeEmptyStageWarningV1(stages: readonly TaskStage[]): string {
  const names = stages.map(stageGroupLabelV1);
  return names.length === 1
    ? `${names[0]} would have no enabled model; its next round will fail.`
    : `${names.join(" and ")} would have no enabled model; their next rounds will fail.`;
}

/**
 * What a round that found `stage` with no enabled model says: the stage with its group, and when the last change
 * went to another stage, where the model went and which stage the owner may have meant.
 */
export function describeNoModelConfiguredV1(
  stage: TaskStage,
  last: LastModelChangeV1 | undefined,
  modelLabel: (modelId: string) => string = (id) => id
): string {
  const label = stageGroupLabelV1(stage);
  const base = `No model is enabled for ${label}.`;
  if (last === undefined || last.stage === stage) {
    return `${base} Open ${label} in AI Models and switch a model on.`;
  }
  return (
    `${base} ${modelLabel(last.modelId)} was just enabled on ${stageGroupLabelV1(last.stage)}; ` +
    `did you mean ${label}? Open ${label} in AI Models and switch a model on there.`
  );
}
