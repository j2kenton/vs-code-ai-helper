import * as fs from "fs";
import * as vscode from "vscode";
import { writeAtomic } from "./writeAtomic";
import { PrimarySessionLock } from "./primarySessionLock";
import * as path from "path";

// The session lock lives two levels above a task folder (the meta root's
// parent) and the meta lock one level above (the meta root itself, i.e. the
// tasks directory). Both are shared by every task under the same meta root.
// `tasksRoot` is `<taskFolderPath>/..` — callers that only have a task
// folder path derive it before calling this.
function metaLocksForTasksRoot(tasksRoot: string): PrimarySessionLock[] {
  return [
    new PrimarySessionLock(path.join(tasksRoot, "..", ".ensemble-session.lock")),
    new PrimarySessionLock(path.join(tasksRoot, ".ensemble-meta.lock")),
  ];
}

export async function withTaskLock<T>(taskFolderPath: string, operation: () => Promise<T>): Promise<T> {
  // Mutations always acquire the shared session, meta-root, then task lease.
  // Keeping this order fixed prevents activation and task writes deadlocking.
  const locks = [
    ...metaLocksForTasksRoot(path.join(taskFolderPath, "..")),
    new PrimarySessionLock(path.join(taskFolderPath, ".ensemble-task.lock")),
  ];
  const releases: Array<() => Promise<void>> = [];
  try {
    for (const lock of locks) releases.push(await lock.acquire());
    return await operation();
  } finally {
    for (const release of releases.reverse()) await release();
  }
}

/**
 * Acquire only the session+meta locks shared by every task under one meta
 * root, without a per-task lease. Used by operations that mutate several
 * task folders in one go (e.g. activation, which pauses every other active
 * task) and need to exclude ordinary per-task mutations (`withTaskLock`) for
 * the whole operation instead of one task lock at a time.
 *
 * `tasksRoot` must be the directory that directly contains task folders
 * (i.e. `<taskFolderPath>/..`) so the derived lock paths line up exactly
 * with the ones `withTaskLock` computes for any task inside it.
 */
export async function withMetaRootLock<T>(tasksRoot: string, operation: () => Promise<T>): Promise<T> {
  const locks = metaLocksForTasksRoot(tasksRoot);
  const releases: Array<() => Promise<void>> = [];
  try {
    for (const lock of locks) releases.push(await lock.acquire());
    return await operation();
  } finally {
    for (const release of releases.reverse()) await release();
  }
}

/** Compare-and-set persistence for task JSON files. */
export async function updateTaskState<T>(uri: vscode.Uri, mutate: (value: T) => T, expectedUpdatedAt?: string): Promise<T> {
  const raw = await fs.promises.readFile(uri.fsPath, "utf8");
  const current = JSON.parse(raw) as T & { updatedAt?: string };
  if (expectedUpdatedAt !== undefined && current.updatedAt !== expectedUpdatedAt) throw new Error("Task changed in another session; refresh and retry.");
  const next = mutate(current);
  await writeAtomic(uri, JSON.stringify(next, null, 2) + "\n");
  return next;
}
