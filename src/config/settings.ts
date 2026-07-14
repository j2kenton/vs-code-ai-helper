import * as vscode from "vscode";
import { AI_MODEL_STAGES, TaskStage } from "../types/taskProgress";
import { FallbackStrategy, ModelSettings } from "../utils/modelFallback";
import { normalizeQualifiedModelId, parseModelSelection } from "../runners/providers";

const CONFIG_SECTION = "vs-code-ai-helper";
const META_RESOURCES_PATH_KEY = "metaResourcesPath";
const PROMPT_DISMISSED_KEY = "promptDismissed";
const AI_MODEL_DEFAULTS_KEY = "aiModelDefaults";
const MODEL_PROMPT_SHOWN_KEY = "modelSelectionPromptShown";
const META_FILES_HIDDEN_KEY = "metaFilesHidden";
const ENABLED_PROVIDERS_KEY = "enabledProviders";
const FAST_FORWARD_MAX_ITERATIONS_KEY = "fastForwardMaxIterations";
const AUTO_ADVANCE_ENABLED_KEY = "autoAdvanceEnabled";
const AUTO_ADVANCE_SCORE_KEY = "autoAdvanceScoreThreshold";
const COMPLETE_AND_MOVE_ON_TRIGGERS_AI_KEY = "completeAndMoveOnTriggersAI";

/** Whether completing a stage automatically starts the destination stage's AI action. */
export function completeAndMoveOnTriggersAI(): boolean {
  return vscode.workspace.getConfiguration("vs-code-ai-helper")
    .get<boolean>(COMPLETE_AND_MOVE_ON_TRIGGERS_AI_KEY, true);
}
const FAST_FORWARD_STOP_LEVEL_KEY = "fastForwardStopLevel";
const FAST_FORWARD_USE_ACCEPTANCE_KEY = "fastForwardUseAcceptanceThreshold";
const AUTO_REVIEW_AFTER_PLAN_KEY = "autoReviewAfterPlan";
const AUTO_REVIEW_AFTER_IMPLEMENTATION_KEY = "autoReviewAfterImplementation";
const ALLOW_DIRTY_WORKTREE_CHANGES_KEY = "allowDirtyWorktreeChanges";
const DESKTOP_NOTIFICATIONS_KEY = "desktopNotifications";

export function areMetaFilesHidden(): boolean {
  return vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>(META_FILES_HIDDEN_KEY, false);
}

export async function setMetaFilesHidden(hidden: boolean): Promise<void> {
  await vscode.workspace.getConfiguration(CONFIG_SECTION).update(META_FILES_HIDDEN_KEY, hidden, vscode.ConfigurationTarget.Workspace);
}

/** Providers are opt-in.  A migration on activation preserves providers that
 * are already referenced by older model settings. */
export function isProviderEnabled(provider: string): boolean {
  const enabled = vscode.workspace.getConfiguration(CONFIG_SECTION).get<Record<string, boolean>>(ENABLED_PROVIDERS_KEY, {});
  return enabled[provider] === true;
}

/**
 * One-time compatibility migration for the old implicit-enable behaviour.
 * Only providers actually referenced by a pre-existing stage model are kept
 * enabled; a new workspace therefore starts with every provider disabled.
 */
export async function migrateEnabledProvidersForExistingModels(): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  if (config.inspect<Record<string, boolean>>(ENABLED_PROVIDERS_KEY)?.workspaceValue !== undefined) {
    return;
  }
  const settings = getModelSettings();
  const enabled: Record<string, boolean> = {};
  for (const setting of Object.values(settings)) {
    for (const model of [setting?.primary, setting?.backup, ...(setting?.backups ?? [])]) {
      if (!model) continue;
      enabled[parseModelSelection(model).provider] = true;
    }
  }
  if (Object.keys(enabled).length > 0) {
    await config.update(ENABLED_PROVIDERS_KEY, enabled, vscode.ConfigurationTarget.Workspace);
  }
}

export function getFastForwardMaxIterations(): number {
  const value = vscode.workspace.getConfiguration(CONFIG_SECTION).get<number>(FAST_FORWARD_MAX_ITERATIONS_KEY, 5);
  return Math.max(1, Math.min(99, Math.floor(value)));
}

export function isAutoAdvanceEnabled(): boolean {
  return vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>(AUTO_ADVANCE_ENABLED_KEY, false);
}

export function getAutoAdvanceScoreThreshold(): number {
  const value = vscode.workspace.getConfiguration(CONFIG_SECTION).get<number>(AUTO_ADVANCE_SCORE_KEY, 10);
  return Math.max(1, Math.min(10, Math.floor(value)));
}

export function getFastForwardStopLevel(): number {
  const value = vscode.workspace.getConfiguration(CONFIG_SECTION).get<number>(FAST_FORWARD_STOP_LEVEL_KEY, 0);
  return Math.max(0, Math.min(10, Math.floor(value)));
}

export function usesAcceptanceThresholdForFastForward(): boolean {
  return vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>(FAST_FORWARD_USE_ACCEPTANCE_KEY, false);
}

export function shouldAutoReviewAfterPlan(): boolean {
  return vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>(AUTO_REVIEW_AFTER_PLAN_KEY, false);
}

export function shouldAutoReviewAfterImplementation(): boolean {
  return vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>(AUTO_REVIEW_AFTER_IMPLEMENTATION_KEY, false);
}

/** Whether implementation/Fast Forward runs may proceed without prompting when the workspace has unrelated uncommitted changes. */
export function allowsDirtyWorktreeChanges(): boolean {
  return vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>(ALLOW_DIRTY_WORKTREE_CHANGES_KEY, false);
}

/** Whether native OS notifications fire for things that need attention (questions, warnings, errors). Off by default. */
export function isDesktopNotificationsEnabled(): boolean {
  return vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>(DESKTOP_NOTIFICATIONS_KEY, false);
}

/**
 * Get the configured meta resources path for the current workspace
 */
export function getMetaResourcesPath(): string {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return config.get<string>(META_RESOURCES_PATH_KEY, "");
}

/**
 * Set the meta resources path in workspace settings
 */
export async function setMetaResourcesPath(path: string): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  await config.update(
    META_RESOURCES_PATH_KEY,
    path,
    vscode.ConfigurationTarget.Workspace
  );
}

/**
 * Check if the prompt has been dismissed for this workspace
 */
export function isPromptDismissed(): boolean {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return config.get<boolean>(PROMPT_DISMISSED_KEY, false);
}

/**
 * Mark the prompt as dismissed in workspace settings
 */
export async function dismissPrompt(): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  await config.update(
    PROMPT_DISMISSED_KEY,
    true,
    vscode.ConfigurationTarget.Workspace
  );
}

/**
 * Check if a valid meta resources path is configured
 */
export function hasValidMetaResourcesPath(): boolean {
  const path = getMetaResourcesPath();
  return path.length > 0;
}

/**
 * Get workspace-level default model IDs keyed by AI workflow stage.
 */
export function getAiModelDefaults(): Partial<Record<TaskStage, string>> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const raw = config.get<Record<string, unknown>>(AI_MODEL_DEFAULTS_KEY, {});
  const defaults: Partial<Record<TaskStage, string>> = {};

  for (const stage of AI_MODEL_STAGES) {
    const value = raw[stage];
    if (typeof value === "string" && value.trim().length > 0) {
      defaults[stage] = normalizeQualifiedModelId(value);
    }
  }

  return defaults;
}

/**
 * Get the workspace-level default model for a single stage.
 */
export function getAiModelDefault(stage: TaskStage): string | undefined {
  const defaults = getAiModelDefaults();
  return defaults[stage];
}

/**
 * Set or clear a workspace-level default model for one AI workflow stage.
 */
export async function setAiModelDefault(
  stage: TaskStage,
  modelId: string | undefined
): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const current = getAiModelDefaults();

  if (modelId && modelId.trim().length > 0) {
    current[stage] = modelId;
  } else {
    delete current[stage];
  }

  await config.update(
    AI_MODEL_DEFAULTS_KEY,
    current,
    vscode.ConfigurationTarget.Workspace
  );
}

/**
 * Whether the user has already been prompted about per-stage model config.
 */
export function isModelSelectionPromptShown(): boolean {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return config.get<boolean>(MODEL_PROMPT_SHOWN_KEY, false);
}

/**
 * Mark the per-stage model configuration onboarding prompt as shown.
 */
export async function setModelSelectionPromptShown(): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  await config.update(
    MODEL_PROMPT_SHOWN_KEY,
    true,
    vscode.ConfigurationTarget.Workspace
  );
}

const MODEL_SETTINGS_KEY = "modelSettings";
const MAX_IMPLEMENTATION_ITERATIONS_KEY = "maxImplementationIterations";

export function getMaxImplementationIterations(): number {
  const value = vscode.workspace.getConfiguration(CONFIG_SECTION).get<number>(MAX_IMPLEMENTATION_ITERATIONS_KEY, 200);
  return Math.max(1, Math.min(200, Math.floor(typeof value === "number" && Number.isFinite(value) ? value : 200)));
}

export function getModelSettings(): ModelSettings {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const raw = config.get<Record<string, unknown>>(MODEL_SETTINGS_KEY, {});
  const result: ModelSettings = {};
  for (const stage of AI_MODEL_STAGES) {
    const value = raw[stage];
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    // Normalize through legacyModelAliases so a stage's selection matches
    // the same model everywhere: the execution path already applies the
    // alias inside parseModelSelection, but callers that match a stored ID
    // against getAvailableModels() by exact string (the settings webview)
    // would otherwise still see the old, no-longer-listed ID.
    const primary = typeof entry.primary === "string" && entry.primary.trim() ? normalizeQualifiedModelId(entry.primary) : undefined;
    const backup = typeof entry.backup === "string" && entry.backup.trim() ? normalizeQualifiedModelId(entry.backup) : undefined;
    const backups = Array.isArray(entry.backups)
      ? [
          ...new Set(
            entry.backups
              .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
              .map((v) => normalizeQualifiedModelId(v.trim()))
              .filter((v): v is string => v !== undefined)
          ),
        ]
      : undefined;
    let strategy: FallbackStrategy = entry.strategy === "switch-to-backup" || entry.strategy === "pause-and-resume" || entry.strategy === "alert-and-wait"
      ? entry.strategy : "alert-and-wait";
    // Back-compat: the old UI could save strategy: "switch-to-backup" with
    // fallbackEnabled: false (checkbox unchecked, strategy left untouched).
    // That combination meant "don't use backup" — downgrade it on read so
    // removing the checkbox doesn't silently turn fallback on for those
    // workspaces.
    if (strategy === "switch-to-backup" && entry.fallbackEnabled === false) {
      strategy = "alert-and-wait";
    }
    result[stage] = { primary, backup, backups, strategy };
  }
  // Migrate the older primary-only setting so existing workspaces do not
  // silently lose their configured models when the settings panel is opened.
  for (const stage of AI_MODEL_STAGES) {
    if (!result[stage]) {
      const legacy = getAiModelDefault(stage);
      if (legacy) result[stage] = { primary: legacy, strategy: "alert-and-wait" };
    }
  }
  return result;
}

export async function setModelSettings(settings: ModelSettings): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const clean: ModelSettings = {};
  for (const stage of AI_MODEL_STAGES) {
    const setting = settings[stage];
    if (setting) {
      const primary = typeof setting.primary === "string" && setting.primary.trim() ? setting.primary.trim() : undefined;
      const backup = typeof setting.backup === "string" && setting.backup.trim() ? setting.backup.trim() : undefined;
      const backups = Array.isArray(setting.backups) ? [...new Set(setting.backups.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map(v => v.trim()))].slice(0, 10) : undefined;
      // Preserve a configured backup even if strategy isn't switch-to-backup —
      // switching strategy back later shouldn't lose the user's backup choice.
      clean[stage] = { ...setting, primary, backup, backups };
    }
  }
  await config.update(
    MODEL_SETTINGS_KEY,
    clean,
    vscode.ConfigurationTarget.Workspace
  );
}
