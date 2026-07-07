/**
 * Pure helper for computing stage-row context values in the task tree.
 * No vscode imports - testable under node:test.
 */

import type { TaskStage } from '../types/taskProgress';

/**
 * Compute the context value for a stage row in the task tree.
 * These values drive menu visibility via when clauses in package.json.
 */
export function computeStageContext(stage: TaskStage): string {
  // Task-description and plan stages get unique context values for targeted actions
  if (stage === 'task-description') {
    return 'stage-task-description';
  }
  if (stage === 'plan') {
    return 'stage-plan';
  }

  // Other stages use generic context
  return 'stage';
}
