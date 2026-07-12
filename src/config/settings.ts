import * as vscode from "vscode";
import { AI_MODEL_STAGES, TaskStage } from "../types/taskProgress";
import { ModelSettings } from "../utils/modelFallback";

const CONFIG_SECTION = "vs-code-ai-helper";
const META_RESOURCES_PATH_KEY = "metaResourcesPath";
const PROMPT_DISMISSED_KEY = "promptDismissed";
const AI_MODEL_DEFAULTS_KEY = "aiModelDefaults";
const MODEL_PROMPT_SHOWN_KEY = "modelSelectionPromptShown";
const CODEX_BYPASS_SANDBOX_FOR_IMPLEMENTATION_KEY =
  "codexDangerouslyBypassSandboxForImplementation";

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
      defaults[stage] = value;
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
 * Whether Codex implementation runs should bypass Codex approvals/sandboxing.
 * Dangerous: only used for explicit workspace opt-in.
 */
export function isCodexDangerouslyBypassSandboxForImplementationEnabled(): boolean {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return config.get<boolean>(
    CODEX_BYPASS_SANDBOX_FOR_IMPLEMENTATION_KEY,
    false
  );
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
    const primary = typeof entry.primary === "string" && entry.primary.trim() ? entry.primary : undefined;
    const backup = typeof entry.backup === "string" && entry.backup.trim() ? entry.backup : undefined;
    const strategy = entry.strategy === "switch-to-backup" || entry.strategy === "pause-and-resume" || entry.strategy === "alert-and-wait"
      ? entry.strategy : "alert-and-wait";
    result[stage] = { primary, backup, fallbackEnabled: entry.fallbackEnabled === true, strategy };
  }
  // Migrate the older primary-only setting so existing workspaces do not
  // silently lose their configured models when the settings panel is opened.
  for (const stage of AI_MODEL_STAGES) {
    if (!result[stage]) {
      const legacy = getAiModelDefault(stage);
      if (legacy) result[stage] = { primary: legacy, fallbackEnabled: false, strategy: "alert-and-wait" };
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
      const fallbackEnabled = Boolean(setting.fallbackEnabled) && Boolean(backup) && backup !== primary;
      // Turning fallback off is a policy change, not deletion of the user's
      // configured backup. Preserve it so re-enabling fallback is reversible.
      clean[stage] = { ...setting, primary, backup, fallbackEnabled };
    }
  }
  await config.update(
    MODEL_SETTINGS_KEY,
    clean,
    vscode.ConfigurationTarget.Workspace
  );
}
