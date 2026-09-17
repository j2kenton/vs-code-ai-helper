import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { writeMirrorSnapshotV1 } from "./hostMirrorWriteV1";

/**
 * What the runner is doing right now, visible in every viewer window
 * (hostRoleV1.ts).
 *
 * The spinner, the Notifications progress bar and the running-operation rows
 * all come from `taskOperations`, an in-memory registry of the window that
 * runs the work. A viewer's registry is empty, so a task running on the
 * runner showed no sign of life at all in the viewer — a 15-minute
 * verification looked like nothing was happening (seen live 2026-09-17).
 *
 * The runner writes a snapshot of its running operations to
 * `<relay dir>/operations-v1.json` whenever they change, and re-writes it as
 * a heartbeat; a viewer reads it and shows it. A snapshot older than
 * `RUNNER_OPERATIONS_STALE_MS_V1` means the runner stopped writing — shown as
 * such, never as work still spinning. VS Code-free, so it is unit-testable.
 */

export const HOST_OPERATIONS_MIRROR_FILENAME_V1 = "operations-v1.json";
export const RUNNER_OPERATIONS_HEARTBEAT_MS_V1 = 30 * 1000;
export const RUNNER_OPERATIONS_STALE_MS_V1 = 3 * RUNNER_OPERATIONS_HEARTBEAT_MS_V1;

/**
 * Identifies ONE runner activation. Operation ids restart at `op-1` every
 * time the runner's extension host starts, so a Stop pressed on a row the
 * viewer had not refreshed yet would otherwise cancel whatever the RESTARTED
 * runner happens to be calling `op-1` now (review, 2026-09-17). A cancel
 * request carries the activation it was read from and the runner refuses it
 * unless that is still its own.
 */
export const runnerActivationIdV1 = crypto.randomUUID();

export interface MirroredOperationV1 {
  readonly id: string;
  readonly label: string;
  readonly taskName: string;
  readonly startedAt: number;
  readonly parentId?: string;
  readonly activity?: string;
  readonly waitingForUser: boolean;
  /**
   * The rest of the operation, so a viewer can put it in its own registry
   * and every surface (stage spinners, Notifications rows) renders it as a
   * local run. Optional only for snapshots written by an older runner.
   */
  readonly key?: string;
  readonly stage?: string;
  readonly kind?: string;
  readonly detail?: string;
  readonly modelId?: string;
  readonly activityStartedAt?: number;
  readonly exclusive?: boolean;
  readonly cancellable?: boolean;
  readonly resultTargetUri?: string;
}

/**
 * Viewer side: the operations to show as running here — none once the
 * runner has gone silent (a stopped runner's work must not keep spinning),
 * and none written by a runner too old to say which task they belong to.
 */
export function liveMirroredOperationsV1(
  snapshot: RunnerOperationsSnapshotV1 | undefined,
  now: number
): readonly (MirroredOperationV1 & { readonly key: string })[] {
  if (snapshot === undefined || now - snapshot.writtenAt > RUNNER_OPERATIONS_STALE_MS_V1) {
    return [];
  }
  return snapshot.operations.filter((op): op is MirroredOperationV1 & { readonly key: string } => typeof op.key === "string");
}

export interface RunnerOperationsSnapshotV1 {
  readonly writtenAt: number;
  readonly operations: readonly MirroredOperationV1[];
  /** The writing runner's activation (see `runnerActivationIdV1`). */
  readonly activationId?: string;
}

/** Runner side: write the snapshot atomically, in order. Never throws. */
export async function writeRunnerOperationsSnapshotV1(dir: string, snapshot: RunnerOperationsSnapshotV1): Promise<void> {
  await writeMirrorSnapshotV1(dir, HOST_OPERATIONS_MIRROR_FILENAME_V1, snapshot);
}

function isMirroredOperation(value: unknown): value is MirroredOperationV1 {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.label === "string" &&
    typeof record.taskName === "string" &&
    typeof record.startedAt === "number"
  );
}

/** Viewer side: the snapshot, or undefined when there is none (the runner never ran) or it is unreadable. */
export async function readRunnerOperationsSnapshotV1(dir: string): Promise<RunnerOperationsSnapshotV1 | undefined> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(dir, HOST_OPERATIONS_MIRROR_FILENAME_V1), "utf8"));
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record.writtenAt !== "number" || !Array.isArray(record.operations)) {
      return undefined;
    }
    return {
      writtenAt: record.writtenAt,
      operations: record.operations.filter(isMirroredOperation),
      ...(typeof record.activationId === "string" ? { activationId: record.activationId } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Whether the runner is reporting at all right now. The runner writes this
 * snapshot on a heartbeat even while idle, so silence past the stale limit
 * means its VS Code is not running (or is wedged) — a viewer must say so
 * instead of sending it work and waiting out the relay timeout.
 */
export function isRunnerReportingV1(snapshot: RunnerOperationsSnapshotV1 | undefined, now: number): boolean {
  return snapshot !== undefined && now - snapshot.writtenAt <= RUNNER_OPERATIONS_STALE_MS_V1;
}

export type RunnerActivityViewV1 =
  | { readonly kind: "idle" }
  | { readonly kind: "stale"; readonly sinceMs: number }
  | {
      readonly kind: "running";
      /** One line for the status bar. */
      readonly text: string;
      /** Every running operation, one per line, for the tooltip. */
      readonly details: readonly string[];
      /** Every running operation is only waiting for the user. */
      readonly waitingForUser: boolean;
    };

function formatElapsed(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) {
    return "<1 min";
  }
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** What a viewer should show for a snapshot read at `now`. */
export function describeRunnerActivityV1(
  snapshot: RunnerOperationsSnapshotV1 | undefined,
  now: number
): RunnerActivityViewV1 {
  if (snapshot === undefined) {
    return { kind: "idle" };
  }
  if (now - snapshot.writtenAt > RUNNER_OPERATIONS_STALE_MS_V1) {
    // The runner writes a heartbeat while anything runs; silence past the
    // stale limit with work listed means it stopped (crashed, restarted).
    return snapshot.operations.length === 0 ? { kind: "idle" } : { kind: "stale", sinceMs: now - snapshot.writtenAt };
  }
  const roots = snapshot.operations.filter((op) => op.parentId === undefined);
  if (roots.length === 0) {
    return { kind: "idle" };
  }
  const first = roots[0]!;
  // The most specific current activity: the newest operation that reports one.
  const activity = [...snapshot.operations].reverse().find((op) => op.activity !== undefined)?.activity;
  const more = roots.length > 1 ? ` (+${roots.length - 1} more)` : "";
  return {
    kind: "running",
    text: `Runner: ${first.label} — ${first.taskName}${activity !== undefined ? ` · ${activity}` : ""}${more}`,
    details: roots.map((op) => `${op.label} — ${op.taskName} (${formatElapsed(now - op.startedAt)})`),
    waitingForUser: snapshot.operations.every((op) => op.waitingForUser),
  };
}
