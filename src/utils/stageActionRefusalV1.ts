/**
 * Why the most recent `applyCurrentStageAction` call for a task returned
 * `false`, keyed by task folder (never a "current task" — concurrent calls for
 * different tasks cannot cross). A caller that got `false` reads it once with
 * `takeStageActionRefusalReasonV1` to name the real cause instead of guessing.
 */
const stageActionRefusalReasonsV1 = new Map<string, string>();

export function recordStageActionRefusalReasonV1(taskFolderPath: string, reason: string): void {
  stageActionRefusalReasonsV1.set(taskFolderPath, reason);
}

export function clearStageActionRefusalReasonV1(taskFolderPath: string): void {
  stageActionRefusalReasonsV1.delete(taskFolderPath);
}

export function takeStageActionRefusalReasonV1(taskFolderPath: string): string | undefined {
  const reason = stageActionRefusalReasonsV1.get(taskFolderPath);
  stageActionRefusalReasonsV1.delete(taskFolderPath);
  return reason;
}
