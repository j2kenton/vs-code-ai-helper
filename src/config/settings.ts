import * as vscode from "vscode";
import { AI_MODEL_STAGES, TaskStage } from "../types/taskProgress";

const CONFIG_SECTION = "vs-code-ai-helper";
const META_RESOURCES_PATH_KEY = "metaResourcesPath";
const PROMPT_DISMISSED_KEY = "promptDismissed";
const AI_MODEL_DEFAULTS_KEY = "aiModelDefaults";
const MODEL_PROMPT_SHOWN_KEY = "modelSelectionPromptShown";

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
