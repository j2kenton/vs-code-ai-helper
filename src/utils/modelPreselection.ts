/**
 * Pure helper for model preselection logic.
 * No vscode imports - testable under node:test.
 */

export interface ModelPreselectionOptions {
  /** Current explicitly saved model for this stage/scope */
  currentModel?: string;
  /** Inherited effective model (task scope only, when no task override exists) */
  inheritedModel?: string;
  /** Last model selected in this command invocation */
  cachedModel?: string;
  /** Available model IDs that can be preselected */
  availableModels: string[];
}

/**
 * Select the preferred model to preselect in a picker, following precedence:
 * currentModel → inheritedModel → cachedModel
 *
 * Returns the model ID to preselect, or undefined if no preselection should occur.
 * Falls through to next precedence level if preferred model is unavailable.
 */
export function selectPreferredModel(
  options: ModelPreselectionOptions
): string | undefined {
  const { currentModel, inheritedModel, cachedModel, availableModels } = options;

  // Empty model list - no preselection possible
  if (availableModels.length === 0) {
    return undefined;
  }

  // Try precedence order: current → inherited → cached
  const candidates = [currentModel, inheritedModel, cachedModel].filter(
    (id): id is string => id !== undefined && id.length > 0
  );

  for (const candidate of candidates) {
    if (availableModels.includes(candidate)) {
      return candidate;
    }
  }

  return undefined;
}
