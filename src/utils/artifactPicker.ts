/**
 * Pure helper for artifact picker filtering and empty-state handling.
 * No vscode imports - testable under node:test.
 */

export interface TaskMetadata {
  folderName: string;
  folderUri: { toString(): string };
  [key: string]: unknown;
}

export interface PickerItem {
  label: string;
  task: TaskMetadata;
  [key: string]: unknown;
}

export interface ArtifactPickerOptions {
  tasks: TaskMetadata[];
  /** Map keyed by task.folderUri.toString(), pre-evaluated by caller */
  hasPlanMap: Map<string, boolean>;
  mode: 'viewTask' | 'viewPlan';
}

export interface ArtifactPickerResult {
  items: PickerItem[];
  emptyMessage?: string;
}

/**
 * Prepare filtered picker items and empty-state message for artifact commands.
 * Caller must pre-evaluate hasPlanMap before calling this helper.
 */
export function prepareArtifactPicker(
  options: ArtifactPickerOptions
): ArtifactPickerResult {
  const { tasks, hasPlanMap, mode } = options;

  let filteredTasks: TaskMetadata[];

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

  const items: PickerItem[] = filteredTasks.map((task) => ({
    label: task.folderName,
    task,
  }));

  return { items };
}
