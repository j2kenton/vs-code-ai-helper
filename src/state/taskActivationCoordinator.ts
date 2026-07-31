import * as vscode from "vscode";
import { TaskInventory } from "./taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { NotificationRouter } from "../utils/notificationRouter";
import { patchTaskProgress, readTaskProgress, updateTaskStatus } from "../utils/taskProgressUtils";
import { withMetaRootLock } from "./taskStateStore";
import type { TaskProgress, TaskStatus } from "../types/taskProgress";
import * as path from "path";
import * as fs from "fs";
import {
  ActivationCheckpoint,
  clearActivationCheckpoint,
  readActivationCheckpoint,
  writeActivationCheckpoint,
} from "./taskActivationCheckpoint";

/**
 * Thrown by an `ActivateTaskOptions.mutateTarget` callback when the fresh,
 * locked read of the target's progress no longer matches the state the
 * caller captured before showing a picker (e.g. a completed task was
 * resumed, modified, or re-completed by another window while a reopen
 * picker was open). Always thrown before persistence — `mutateTarget` runs
 * strictly before the write — so it is unconditionally safe to roll back.
 */
export class StaleReopenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleReopenError";
  }
}

export interface ActivateTaskOptions {
  /**
   * Composed into the coordinator's single target write as
   * `updateTaskStatus(mutateTarget(current), "active")`, so a completed-task
   * reopen and its activation are one CAS write under the same root lock.
   * The callback is the stale-state validation point: it runs against a
   * fresh locked read and should throw `StaleReopenError` (see
   * utils/reopenTask.ts) if the task is no longer in the state the caller
   * captured before showing a picker. That throw is pre-persistence by
   * construction, so it is always safe to roll back.
   */
  mutateTarget?: (current: TaskProgress) => TaskProgress;
  /**
   * Replace the coordinator's own target write entirely (mutually exclusive
   * with `mutateTarget`): the callback must itself persist the target task's
   * activation (status flip included) and return whether the write landed.
   * Used by the strict reopen path (plan §9) — `utils/reopenTask.ts` routes
   * the target write through the `resumeTask.v1` registry row so the field
   * policy and strict progress stack own the mutation, while THIS
   * coordinator keeps owning the surrounding sequence (pause-others,
   * checkpoint, rollback, sole-active focus). Contract mirrors
   * `mutateTarget`'s error semantics: throw `StaleReopenError` for a
   * pre-persistence staleness rejection (always safe to roll back); return
   * false when the target's progress could not be read/decoded (rolled back
   * like an unreadable legacy target); any other throw is resolved through
   * `resolveTargetWritePending`, exactly like a throwing direct write.
   * Runs INSIDE the meta-root lock — a strict patch invoked from here must
   * skip the per-task lock (see `patchTaskProgressStrictV1`'s `skipLock`).
   */
  writeTarget?: () => Promise<boolean>;
}

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
  canonicalId: string,
  options?: ActivateTaskOptions
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
    activateTaskLocked(inventory, currentTaskStore, taskFolderPath, canonicalId, root, options)
  );
}

async function activateTaskLocked(
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore,
  taskFolderPath: string,
  canonicalId: string,
  root: string,
  options?: ActivateTaskOptions
): Promise<boolean> {
  if (!path.isAbsolute(taskFolderPath) || !fs.existsSync(path.join(taskFolderPath, "task-progress.json"))) return false;

  // A checkpoint left by a prior, not-yet-confirmed activation attempt must
  // be resolved (or block this attempt) before the intent-recorded write
  // below overwrites it. Normally cleared by startup recovery, but an
  // ambiguous target-write-pending checkpoint is deliberately left in place
  // until its target becomes readable (see resolveTargetWritePending) — so
  // without this guard, a fresh activation could blow through it, discard
  // the record that the earlier attempt's outcome is still unconfirmed, and
  // reopen the exact two-active-tasks exposure the checkpoint exists to
  // prevent.
  if (!(await ensureNoPendingActivation(inventory, root, currentTaskStore, taskFolderPath))) {
    return false;
  }

  // `inventory` is an in-memory cache that can be stale relative to writes
  // another window made while this window held no lock — e.g. this window
  // had a reopen picker open against a completed task while another window
  // already resumed it, pausing a different task in the process. Snapshotting
  // "previous" from that stale cache would record the wrong prior status for
  // that other task, and a later `StaleReopenError` rollback (see the catch
  // below) would then restore it to a status it no longer actually had —
  // resurrecting a task another window correctly paused and producing two
  // active tasks. Refreshing here, still inside the root lock acquired by
  // `activateTask`, guarantees this snapshot reflects the true on-disk state
  // immediately before this operation's own writes begin.
  await inventory.refresh();
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

  // Written immediately before the target write below so a crash between
  // that write landing and the "target-activated" checkpoint (previously
  // unrecoverable — recovery would see only "others-paused" and roll back
  // paused tasks while the target might already be active on disk) can be
  // reconciled by re-reading the target's durable state. See
  // resolveTargetWritePending and taskActivationCheckpoint.ts.
  const pendingCheckpoint = { ...checkpointBase, pausedFolders: [...changed], phase: "target-write-pending" as const };
  await writeActivationCheckpoint(root, pendingCheckpoint);

  let activated: TaskProgress | boolean | undefined;
  try {
    activated = options?.writeTarget
      ? await options.writeTarget()
      : await patchTaskProgress(
          vscode.Uri.file(taskFolderPath),
          (current) => updateTaskStatus(options?.mutateTarget ? options.mutateTarget(current) : current, "active"),
          true
        );
  } catch (error) {
    if (error instanceof StaleReopenError) {
      // Thrown by mutateTarget itself, before any persistence — always safe
      // to roll back as if the write never happened.
      await rollback(previous, changed);
      await clearActivationCheckpoint(root);
      throw error;
    }
    // Any other throw from the target write (a rename/read-back failure, or
    // an unexpected error from the finalization journal) may or may not have
    // actually landed on disk. Rather than special-casing every failure
    // shape, resolve it the same way startup recovery resolves a crash at
    // this exact interval: re-read the target's durable state and act on
    // what's actually there. This can never restore paused tasks while the
    // target might be active, and is idempotent if called again.
    const outcome = await resolveTargetWritePending(root, pendingCheckpoint, currentTaskStore);
    if (outcome === "forward") {
      await inventory.refresh();
      return true;
    }
    if (outcome === "ambiguous") {
      // Same warning startup recovery would eventually show for this
      // checkpoint — surfaced immediately here too, since a caller reading a
      // plain `false` has no way to know this is a pending-recovery
      // condition (retried automatically) rather than an ordinary failure.
      warnBestEffort(
        `Could not verify whether "${path.basename(taskFolderPath)}" finished activating — it will be retried automatically the next time a task is activated or the window reloads.`
      );
    }
    return false;
  }
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

/**
 * Best-effort notification: showing a warning about a pending/ambiguous
 * activation is UX sugar layered on top of the state transition, not part of
 * its correctness. A host that can't show a message (or a test environment
 * with no window surface stubbed) must never turn a warning attempt into an
 * unhandled throw out of the activation path itself.
 */
function warnBestEffort(message: string): void {
  try {
    NotificationRouter.showWarning(message);
  } catch {
    // Notification surface unavailable — the caller's boolean/checkpoint
    // state already reflects the pending condition; nothing else to do.
  }
}

async function rollback(previous: Array<{ taskFolderPath: string; status: string }>, changed: string[]): Promise<void> {
  for (const folder of changed) {
    const old = previous.find(item => item.taskFolderPath === folder);
    if (old) await patchTaskProgress(vscode.Uri.file(folder), current => updateTaskStatus(current, old.status as TaskStatus), true);
  }
}

/**
 * Single shared resolution rule for a checkpoint parked at
 * "target-write-pending" — used identically by the immediate error handler
 * in `activateTaskLocked` and by startup recovery below, so there is never
 * more than one interpretation of what this checkpoint phase means.
 *
 * Re-reads the target task's own persisted progress (under the caller's
 * lock) rather than guessing from the failure shape:
 *   - readable and "active"  -> the write landed: roll forward exactly like
 *     a normal successful activation (record target-activated/focus-updated,
 *     set focus, clear the checkpoint).
 *   - readable and not active -> the write never landed: roll back every
 *     folder this activation paused and clear the checkpoint.
 *   - unreadable/unparseable -> ambiguous. Rolling back here risks ending up
 *     with paused tasks AND an active target (two active tasks) if the write
 *     actually landed. Leave the checkpoint in place and change nothing;
 *     this same rule runs again next time (next startup, or a later manual
 *     retry) and resolves once the file is readable.
 */
async function resolveTargetWritePending(
  root: string,
  checkpoint: Omit<ActivationCheckpoint, "checksum">,
  currentTaskStore: CurrentTaskStore
): Promise<"forward" | "back" | "ambiguous"> {
  const targetProgress = await readTaskProgress(vscode.Uri.file(checkpoint.targetTaskFolderPath));
  if (!targetProgress) {
    return "ambiguous";
  }

  if (targetProgress.status === "active") {
    await writeActivationCheckpoint(root, { ...checkpoint, phase: "target-activated" });
    await currentTaskStore.set(checkpoint.targetCanonicalId);
    await writeActivationCheckpoint(root, { ...checkpoint, phase: "focus-updated" });
    await clearActivationCheckpoint(root);
    return "forward";
  }

  await rollback(checkpoint.previousStatuses, checkpoint.pausedFolders);
  await clearActivationCheckpoint(root);
  return "back";
}

/**
 * Guard run at the very start of `activateTaskLocked`, before it writes its
 * own "intent-recorded" checkpoint. A checkpoint can already be sitting in
 * `root` for one of two reasons:
 *
 *   - Normal case: none, or one startup recovery already resolved. Returns
 *     true immediately.
 *   - A crash-recovery phase ("intent-recorded" / "others-paused" /
 *     "target-activated" / "focus-updated") that startup recovery hasn't run
 *     for yet in this process — defensively resolved the same way
 *     `recoverActivationCheckpointLocked` would, then true.
 *   - An ambiguous "target-write-pending" checkpoint that startup recovery
 *     already tried and deliberately left in place (see
 *     `resolveTargetWritePending`) because the target was unreadable. A
 *     fresh resolution attempt is made here; if it's still ambiguous, this
 *     activation must refuse to proceed — writing a new "intent-recorded"
 *     checkpoint over it would discard the record that the earlier attempt's
 *     outcome is unconfirmed, and this attempt could then pause/activate
 *     tasks without knowing whether the earlier target is already active,
 *     reopening the two-active-tasks exposure the checkpoint exists to
 *     prevent.
 *
 * Returns false only for that last case — the caller must not proceed.
 */
async function ensureNoPendingActivation(
  inventory: TaskInventory,
  root: string,
  currentTaskStore: CurrentTaskStore,
  requestedTaskFolderPath: string
): Promise<boolean> {
  const checkpoint = await readActivationCheckpoint(root);
  if (!checkpoint) return true;

  if (checkpoint.phase === "target-activated" || checkpoint.phase === "focus-updated") {
    await currentTaskStore.set(checkpoint.targetCanonicalId);
    await clearActivationCheckpoint(root);
    await inventory.refresh();
    return true;
  }

  if (checkpoint.phase === "target-write-pending") {
    const outcome = await resolveTargetWritePending(root, checkpoint, currentTaskStore);
    if (outcome === "ambiguous") {
      warnBestEffort(
        `Could not activate "${path.basename(requestedTaskFolderPath)}" yet — a previous activation for ` +
          `"${path.basename(checkpoint.targetTaskFolderPath)}" is still unresolved and will be retried automatically.`
      );
      return false;
    }
    await inventory.refresh();
    return true;
  }

  // "intent-recorded" / "others-paused": the target task's own write was
  // never even attempted, so roll back every folder actually paused by that
  // abandoned attempt before this new one starts.
  for (const folder of checkpoint.pausedFolders) {
    const old = checkpoint.previousStatuses.find(item => item.taskFolderPath === folder);
    if (old) {
      await patchTaskProgress(vscode.Uri.file(folder), current => updateTaskStatus(current, old.status as TaskStatus), true);
    }
  }
  await clearActivationCheckpoint(root);
  await inventory.refresh();
  return true;
}

/**
 * Startup recovery for an activation checkpoint left behind by a crash or
 * reload mid-activation. Called once per task-root candidate before commands
 * become available.
 *
 *   - "intent-recorded" / "others-paused": the target task's own write was
 *     never even attempted, so the activation never actually completed.
 *     Roll back every folder that was actually paused (tracked incrementally,
 *     so this is exact — not a guess) and leave the world as if the
 *     activation never started.
 *   - "target-write-pending": the target write was attempted but its outcome
 *     was never confirmed (checkpoint recorded before the write, and the
 *     process didn't survive to record "target-activated" after it). Resolve
 *     via `resolveTargetWritePending` rather than assuming either direction.
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

  if (checkpoint.phase === "target-write-pending") {
    const outcome = await resolveTargetWritePending(root, checkpoint, currentTaskStore);
    if (outcome === "forward") {
      return `Recovered an interrupted task activation for "${path.basename(checkpoint.targetTaskFolderPath)}" — it is now the active task.`;
    }
    if (outcome === "back") {
      return `Rolled back an interrupted task activation for "${path.basename(checkpoint.targetTaskFolderPath)}".`;
    }
    // Ambiguous: checkpoint deliberately retained; report nothing changed
    // yet so the message doesn't overclaim, but let the user know recovery
    // is still pending rather than staying silent about it.
    return `Could not verify an interrupted task activation for "${path.basename(checkpoint.targetTaskFolderPath)}" yet — it will be retried automatically.`;
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
