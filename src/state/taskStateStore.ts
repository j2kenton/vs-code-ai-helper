import * as fs from "fs";
import * as vscode from "vscode";
import { writeAtomic } from "./writeAtomic";
import { PrimarySessionLock } from "./primarySessionLock";
import * as path from "path";

// Commands issued from one extension host can overlap (for example, a second
// click on "Complete Stage & Move On" while the first state write is still
// finishing). Queue them before taking the cross-process lease so a local
// duplicate waits for the first operation instead of surfacing a misleading
// "Another Ensemble session" error. The on-disk leases still protect against
// other extension hosts and processes.
const localMutationQueues = new Map<string, Promise<void>>();

function localQueueKey(tasksRoot: string): string {
  const resolved = path.resolve(tasksRoot);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function withLocalMutationQueue<T>(
  tasksRoot: string,
  operation: () => Promise<T>
): Promise<T> {
  const key = localQueueKey(tasksRoot);
  const previous = localMutationQueues.get(key) ?? Promise.resolve();
  let releaseGate: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  localMutationQueues.set(key, tail);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    releaseGate?.();
    if (localMutationQueues.get(key) === tail) {
      localMutationQueues.delete(key);
    }
  }
}

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
  const tasksRoot = path.join(taskFolderPath, "..");
  return withLocalMutationQueue(tasksRoot, async () => {
    // Mutations always acquire the shared session, meta-root, then task lease.
    // Keeping this order fixed prevents activation and task writes deadlocking.
    const locks = [
      ...metaLocksForTasksRoot(tasksRoot),
      new PrimarySessionLock(path.join(taskFolderPath, ".ensemble-task.lock")),
    ];
    const releases: Array<() => Promise<void>> = [];
    try {
      for (const lock of locks) {
        releases.push(await lock.acquire());
      }
      return await operation();
    } finally {
      for (const release of releases.reverse()) {
        await release();
      }
    }
  });
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
  return withLocalMutationQueue(tasksRoot, async () => {
    const locks = metaLocksForTasksRoot(tasksRoot);
    const releases: Array<() => Promise<void>> = [];
    try {
      for (const lock of locks) {
        releases.push(await lock.acquire());
      }
      return await operation();
    } finally {
      for (const release of releases.reverse()) {
        await release();
      }
    }
  });
}

/**
 * Acquire the session+meta locks for every distinct meta root in
 * `tasksRoots` before running `operation`, then release them all. Used by
 * task creation, which must check "no active task exists under ANY meta root
 * reachable from this window" and write this task's initial status in one
 * atomic section spanning every one of those roots — a single `withMetaRootLock`
 * only excludes concurrent mutation under its own root, so a sibling
 * workspace folder's root could otherwise still race the disk scan.
 *
 * Roots are locked in a fixed (sorted) order regardless of the order they're
 * passed in, so two callers locking the same set of roots in different
 * argument order can never deadlock on each other.
 */
export async function withAllMetaRootsLock<T>(
  tasksRoots: readonly string[],
  operation: () => Promise<T>
): Promise<T> {
  const sorted = Array.from(new Set(tasksRoots.map((p) => path.resolve(p)))).sort();
  const acquireNext = (index: number): Promise<T> => {
    const root = sorted[index];
    if (root === undefined) {
      return operation();
    }
    return withMetaRootLock(root, () => acquireNext(index + 1));
  };
  return acquireNext(0);
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
