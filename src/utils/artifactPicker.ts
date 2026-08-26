/**
 * Pure helper for artifact picker filtering and empty-state handling.
 * No vscode imports - testable under node:test.
 */

export interface TaskMetadata<TUri extends { toString(): string } = { toString(): string }> {
  folderName: string;
  folderUri: TUri;
  /** wf10 item 21: rendered as the picker label (with `folderName` as the
   * description) instead of the unrecognizable folder id. Optional because
   * a legacy record may not have one, in which case `folderName` is used as
   * the label exactly as before. */
  displayName?: string;
}

export interface PickerItem<TUri extends { toString(): string } = { toString(): string }> {
  label: string;
  description?: string;
  task: TaskMetadata<TUri>;
}

export interface ArtifactPickerOptions<TUri extends { toString(): string } = { toString(): string }> {
  tasks: TaskMetadata<TUri>[];
  /** Map keyed by task.folderUri.toString(), pre-evaluated by caller */
  hasPlanMap: Map<string, boolean>;
  mode: 'viewTask' | 'viewPlan';
}

export interface ArtifactPickerResult<TUri extends { toString(): string } = { toString(): string }> {
  items: PickerItem<TUri>[];
  emptyMessage?: string;
}

/**
 * Prepare filtered picker items and empty-state message for artifact commands.
 * Caller must pre-evaluate hasPlanMap before calling this helper.
 */
export function prepareArtifactPicker<TUri extends { toString(): string }>(
  options: ArtifactPickerOptions<TUri>
): ArtifactPickerResult<TUri> {
  const { tasks, hasPlanMap, mode } = options;

  let filteredTasks: TaskMetadata<TUri>[];

  if (mode === 'viewTask') {
    // Include all tasks for viewTask
    filteredTasks = tasks;
  } else {
    // viewPlan: filter to only tasks with existing plans
    filteredTasks = tasks.filter((task) => {
      const key = task.folderUri.toString();
      return hasPlanMap.get(key) === true;
    });
  }

  if (filteredTasks.length === 0) {
    const emptyMessage =
      mode === 'viewTask'
        ? "No task folders found. Use 'Start New Task' to create one."
        : 'No tasks with an existing plan were found.';
    return { items: [], emptyMessage };
  }

  const items: PickerItem<TUri>[] = filteredTasks.map((task) => ({
    label: task.displayName ?? task.folderName,
    // Only distinguish the folder id when it isn't already the label —
    // avoids a redundant description repeating the label verbatim for a
    // task with no separate display name.
    description: task.displayName ? task.folderName : undefined,
    task,
  }));

  return { items };
}
