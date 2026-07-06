/**
 * Pure helper for invocation-local cache mutation during model configuration.
 * No vscode imports - testable under node:test.
 */

import type { StageSave } from '../commands/configureStepModels';

/**
 * Update the invocation-local cache based on a stage save outcome.
 *
 * Cache mutation rules (all writes happen sequentially within this function):
 * - type: 'workspace' with concrete model → set workspace cache
 * - type: 'taskOnly' with concrete model → set task cache
 * - type: 'taskAndWorkspace' with concrete model → set both caches sequentially
 * - Non-concrete/clear outcomes → no cache writes
 *
 * Atomicity means "sequential writes within single function call" - no interleaving,
 * but partial state is possible if an unexpected exception occurs mid-write.
 * Exceptions propagate to caller for stage rollback.
 */
export function updateInvocationCache(
  cache: Map<string, string>,
  stageSave: StageSave,
  taskFolderUriString: string
): void {
  if (stageSave.type === 'workspace' && stageSave.modelId) {
    cache.set('workspace', stageSave.modelId);
  } else if (stageSave.type === 'taskOnly' && stageSave.modelId) {
    cache.set(`task:${taskFolderUriString}`, stageSave.modelId);
  } else if (stageSave.type === 'taskAndWorkspace') {
    // Sequential writes - both must succeed or exception propagates
    cache.set('workspace', stageSave.modelId);
    cache.set(`task:${taskFolderUriString}`, stageSave.modelId);
  }
  // Non-concrete/clear outcomes: no writes
}
