import * as vscode from "vscode";
import { TaskInventory } from "./taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { patchTaskProgress, updateTaskStatus } from "../utils/taskProgressUtils";
import { withMetaRootLock } from "./taskStateStore";
import type { TaskStatus } from "../types/taskProgress";
import * as path from "path";
import * as fs from "fs";
import {
  ActivationCheckpoint,
  clearActivationCheckpoint,
  readActivationCheckpoint,
  writeActivationCheckpoint,
} from "./taskActivationCheckpoint";

/**
 * Makes one task the focused task.  Background runners are deliberately not
 * cancelled; this only changes persisted focus/lifecycle state.
 *
 * The multi-step disk sequence (pause every other active task, activate the
 * target, update focus) is checkpointed to disk as it progresses so a crash
 * or reload mid-activation can be reconciled by `recoverActivationCheckpoint`
 * on the next startup instead of leaving stale status flags behind.
 */
export async function activateTask(
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore,
  taskFolderPath: string,
  canonicalId: string
): Promise<boolean> {
  // Checkpoints must live in the same task-root directory scanned during
  // startup recovery.  Putting them in the parent of that root made a crash
  // invisible to recovery.
  const root = path.resolve(taskFolderPath, "..");
  // Hold the same session+meta locks ordinary per-task mutations
  // (withTaskLock) take, so activation and a concurrent status/progress
  // write for any task under this root can never interleave. The
  // per-task writes below pass skipLock: true because this lock already
  // covers them.
  return withMetaRootLock(root, () =>
    activateTaskLocked(inventory, currentTaskStore, taskFolderPath, canonicalId, root)
  );
}

async function activateTaskLocked(
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore,
  taskFolderPath: string,
  canonicalId: string,
  root: string
): Promise<boolean> {
  if (!path.isAbsolute(taskFolderPath) || !fs.existsSync(path.join(taskFolderPath, "task-progress.json"))) return false;
  const previous = inventory.getTasks().map((task) => ({ taskFolderPath: task.taskFolderPath, status: task.progress.status ?? "active" }));

  const checkpointBase = {
    schemaVersion: 1 as const,
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    targetTaskFolderPath: taskFolderPath,
    targetCanonicalId: canonicalId,
    previousStatuses: previous,
    createdAt: new Date().toISOString(),
  };
  await writeActivationCheckpoint(root, { ...checkpointBase, pausedFolders: [], phase: "intent-recorded" });

  const changed: string[] = [];
  for (const task of inventory.getTasks()) {
    if (task.taskFolderPath !== taskFolderPath &&
        (task.progress.status === "active" || task.progress.status === "creating")) {
      const paused = await patchTaskProgress(
        vscode.Uri.file(task.taskFolderPath),
        (current) => updateTaskStatus(current, "paused"), true
      );
      if (!paused) {
        await rollback(previous, changed);
        await clearActivationCheckpoint(root);
        return false;
      }
      changed.push(task.taskFolderPath);
      await writeActivationCheckpoint(root, { ...checkpointBase, pausedFolders: [...changed], phase: "others-paused" });
    }
  }

  const activated = await patchTaskProgress(
    vscode.Uri.file(taskFolderPath),
    (current) => updateTaskStatus(current, "active"), true
  );
  if (!activated) {
    await rollback(previous, changed);
    await clearActivationCheckpoint(root);
    return false;
  }
  await writeActivationCheckpoint(root, { ...checkpointBase, pausedFolders: [...changed], phase: "target-activated" });

  await currentTaskStore.set(canonicalId);
  await writeActivationCheckpoint(root, { ...checkpointBase, pausedFolders: [...changed], phase: "focus-updated" });

  await inventory.refresh();
  await clearActivationCheckpoint(root);
  return true;
}

async function rollback(previous: Array<{ taskFolderPath: string; status: string }>, changed: string[]): Promise<void> {
  for (const folder of changed) {
    const old = previous.find(item => item.taskFolderPath === folder);
    if (old) await patchTaskProgress(vscode.Uri.file(folder), current => updateTaskStatus(current, old.status as TaskStatus), true);
  }
}

/**
 * Startup recovery for an activation checkpoint left behind by a crash or
 * reload mid-activation. Called once per task-root candidate before commands
 * become available.
 *
 *   - "intent-recorded" / "others-paused": the target task's own status was
 *     never confirmed active, so the activation never actually completed.
 *     Roll back every folder that was actually paused (tracked incrementally,
 *     so this is exact — not a guess) and leave the world as if the
 *     activation never started.
 *   - "target-activated" / "focus-updated": the target is already persisted
 *     as active on disk. Rolling back now would leave zero active tasks
 *     (worse than doing nothing), so instead complete the transition forward
 *     by making sure CurrentTaskStore points at it.
 *
 * Returns a human-readable summary for a single notification, or undefined
 * if there was no interrupted activation to recover.
 */
export async function recoverActivationCheckpoint(
  root: string,
  currentTaskStore: CurrentTaskStore
): Promise<string | undefined> {
  // Same shared session+meta locks as activateTask (see comment there) so
  // startup recovery can't race a concurrent activation or task mutation.
  return withMetaRootLock(root, () => recoverActivationCheckpointLocked(root, currentTaskStore));
}

async function recoverActivationCheckpointLocked(
  root: string,
  currentTaskStore: CurrentTaskStore
): Promise<string | undefined> {
  const checkpoint: ActivationCheckpoint | undefined = await readActivationCheckpoint(root);
  if (!checkpoint) return undefined;

  if (checkpoint.phase === "target-activated" || checkpoint.phase === "focus-updated") {
    await currentTaskStore.set(checkpoint.targetCanonicalId);
    await clearActivationCheckpoint(root);
    return `Recovered an interrupted task activation for "${path.basename(checkpoint.targetTaskFolderPath)}" — it is now the active task.`;
  }

  for (const folder of checkpoint.pausedFolders) {
    const old = checkpoint.previousStatuses.find(item => item.taskFolderPath === folder);
    if (old) {
      await patchTaskProgress(vscode.Uri.file(folder), current => updateTaskStatus(current, old.status as TaskStatus));
    }
  }
  await clearActivationCheckpoint(root);
  return `Rolled back an interrupted task activation for "${path.basename(checkpoint.targetTaskFolderPath)}".`;
}
