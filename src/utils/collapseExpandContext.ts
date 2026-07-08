/**
 * Pure helper for computing collapse/expand context state.
 * No vscode imports - testable under node:test.
 */

export type ExpansionMode = 'autoFirstActive' | 'allCollapsed' | 'allExpanded';

/**
 * Compute whether the tasks view should show the "all collapsed" state.
 * Returns true when we want to show the "expand" button (currently collapsed),
 * and false when we want to show the "collapse" button (currently expanded).
 */
export function computeCollapseExpandContext(
  mode: ExpansionMode,
  taskCount: number
): boolean {
  // allCollapsed mode: show expand button (return true)
  if (mode === 'allCollapsed') {
    return taskCount > 0;
  }
  // allExpanded mode: show collapse button (return false)
  if (mode === 'allExpanded') {
    return false;
  }
  // autoFirstActive mode: first active is expanded, so show collapse button (return false)
  return false;
}
