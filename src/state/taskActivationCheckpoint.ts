import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { createHash } from "crypto";
import { writeAtomic } from "./writeAtomic";

const CHECKPOINT_FILENAME = ".ensemble-activation-checkpoint.json";

/**
 * Activation is a multi-step disk mutation (pause every other active task,
 * then activate the target, then update focus). This tracks how far that
 * sequence got so a crash mid-activation can be reconciled deterministically
 * on the next startup instead of leaving stale "paused"/"active" flags with
 * no record of what the coordinator was trying to do.
 *
 * "target-write-pending" is written immediately before the target's own
 * `patchTaskProgress` call (the write that flips it to "active", optionally
 * composed with a reopen mutation) and closes the interval between that
 * write landing and the "target-activated" checkpoint being recorded — a
 * crash there previously had no checkpoint to recover from. Recovery for
 * this phase re-reads the target's durable state rather than assuming
 * success or failure; see `resolveTargetWritePending` in
 * taskActivationCoordinator.ts.
 *
 * Downgrade caveat: an older extension build that doesn't know this phase
 * would treat it as an unrecognized-but-earlier phase and roll back — if the
 * target write had actually landed, that reproduces the pre-existing
 * two-active-tasks exposure this phase closes. This only happens on a crash
 * followed by a downgrade to an older build, and is no worse than the bug
 * that existed before this phase was added.
 */
export type ActivationCheckpointPhase =
  | "intent-recorded"
  | "others-paused"
  | "target-write-pending"
  | "target-activated"
  | "focus-updated";

export interface ActivationCheckpoint {
  schemaVersion: 1;
  id: string;
  targetTaskFolderPath: string;
  targetCanonicalId: string;
  /** Status each other active task had before activation began, for rollback. */
  previousStatuses: Array<{ taskFolderPath: string; status: string }>;
  /** Folders whose status has actually been flipped to "paused" so far. */
  pausedFolders: string[];
  phase: ActivationCheckpointPhase;
  createdAt: string;
  checksum: string;
}

function checksum(value: Omit<ActivationCheckpoint, "checksum">): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function checkpointPath(root: string): string {
  return path.join(root, CHECKPOINT_FILENAME);
}

export async function writeActivationCheckpoint(
  root: string,
  value: Omit<ActivationCheckpoint, "checksum">
): Promise<void> {
  const record: ActivationCheckpoint = { ...value, checksum: checksum(value) };
  await fs.promises.mkdir(root, { recursive: true });
  await writeAtomic(
    vscode.Uri.file(checkpointPath(root)),
    JSON.stringify(record, null, 2) + "\n"
  );
}

export async function clearActivationCheckpoint(root: string): Promise<void> {
  try {
    await fs.promises.unlink(checkpointPath(root));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Returns undefined for a missing, corrupt, or tampered checkpoint. */
export async function readActivationCheckpoint(
  root: string
): Promise<ActivationCheckpoint | undefined> {
  try {
    const value = JSON.parse(
      await fs.promises.readFile(checkpointPath(root), "utf8")
    ) as ActivationCheckpoint;
    const { checksum: stored, ...base } = value;
    if (value.schemaVersion !== 1 || stored !== checksum(base)) {
      return undefined;
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}
