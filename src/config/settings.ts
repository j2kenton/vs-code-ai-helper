import * as vscode from "vscode";

const CONFIG_SECTION = "vs-code-ai-helper";
const META_RESOURCES_PATH_KEY = "metaResourcesPath";
const PROMPT_DISMISSED_KEY = "promptDismissed";

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
