import * as fs from "fs";
import * as vscode from "vscode";
import { writeAtomic } from "./writeAtomic";
import { PrimarySessionLock } from "./primarySessionLock";
import * as path from "path";

export async function withTaskLock<T>(taskFolderPath: string, operation: () => Promise<T>): Promise<T> {
  // Mutations always acquire the shared session, meta-root, then task lease.
  // Keeping this order fixed prevents activation and task writes deadlocking.
  const locks = [
    new PrimarySessionLock(path.join(taskFolderPath, "..", "..", ".ensemble-session.lock")),
    new PrimarySessionLock(path.join(taskFolderPath, "..", ".ensemble-meta.lock")),
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

/** Compare-and-set persistence for task JSON files. */
export async function updateTaskState<T>(uri: vscode.Uri, mutate: (value: T) => T, expectedUpdatedAt?: string): Promise<T> {
  const raw = await fs.promises.readFile(uri.fsPath, "utf8");
  const current = JSON.parse(raw) as T & { updatedAt?: string };
  if (expectedUpdatedAt !== undefined && current.updatedAt !== expectedUpdatedAt) throw new Error("Task changed in another session; refresh and retry.");
  const next = mutate(current);
  await writeAtomic(uri, JSON.stringify(next, null, 2) + "\n");
  return next;
}
