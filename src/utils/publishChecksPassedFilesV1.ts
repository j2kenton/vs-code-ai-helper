/**
 * review1 Step 34: the test files named in the output of the PASSING commands of the latest Publish Checks run,
 * held in memory per task so Fast Forward can read them right after it ran the checks once. A passing run keeps no
 * output on disk (only failures are persisted), so this is the one place the names survive. Never persisted: a
 * reload loses it, which only means the next gap attempt runs the checks itself.
 */
export interface PublishChecksPassedFilesV1 {
  readonly runAt: string;
  /** True when every command passed (modulo known flakes): only then do the files count as passing. */
  readonly passed: boolean;
  readonly testFiles: readonly string[];
}

const latestByTask = new Map<string, PublishChecksPassedFilesV1>();

const keyOf = (taskFolderPath: string): string => taskFolderPath.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

export function recordPublishChecksPassedFilesV1(taskFolderPath: string, value: PublishChecksPassedFilesV1): void {
  latestByTask.set(keyOf(taskFolderPath), value);
  // Bounded: a long session touches few tasks, but never grow without limit.
  if (latestByTask.size > 50) {
    const oldest = latestByTask.keys().next().value;
    if (oldest !== undefined) latestByTask.delete(oldest);
  }
}

/** Reads and clears the latest record for a task, so one run's files are never counted for a later run. */
export function takePublishChecksPassedFilesV1(taskFolderPath: string): PublishChecksPassedFilesV1 | undefined {
  const key = keyOf(taskFolderPath);
  const value = latestByTask.get(key);
  latestByTask.delete(key);
  return value;
}

export function clearPublishChecksPassedFilesV1(taskFolderPath: string): void {
  latestByTask.delete(keyOf(taskFolderPath));
}
