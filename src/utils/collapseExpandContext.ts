/**
 * Pure helper for computing collapse/expand context state.
 * No vscode imports - testable under node:test.
 */

export type ExpansionMode = 'autoFirstActive' | 'allCollapsed';

/**
 * Compute whether the tasks view should show the "all collapsed" state.
 * Returns true only when in collapsed mode with at least one task present.
 */
export function computeCollapseExpandContext(
  mode: ExpansionMode,
  taskCount: number
): boolean {
  return mode === 'allCollapsed' && taskCount > 0;
}
