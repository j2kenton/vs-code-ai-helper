/**
 * chat1 Step 6: the live run strip. "Is it running?" is answered in the chat without a log: one
 * line says what runs, on which model, since when, and its latest progress. It is replaced in place
 * as the operation reports, and is gone when the run ends. Pure so it is testable without VS Code;
 * the chat view posts the result as its own `runStrip` message.
 */
import type { TaskStage } from "../types/taskProgress";
import { describeOperationModelSegmentV1 } from "../utils/operationModelSegmentV1";
import { operationChatLabelV1 } from "../utils/stepLabelsV1";

/** The few operation fields the strip reads (a `TaskOperationSnapshot` satisfies this). */
export interface RunStripOperationV1 {
  readonly id: string;
  readonly label: string;
  readonly stage?: TaskStage;
  readonly appliesStage?: TaskStage;
  readonly startedAt: number;
  readonly modelId?: string;
  readonly activity?: string;
  readonly detail?: string;
  readonly waitingForUser: boolean;
  readonly cancellable: boolean;
  readonly parentId?: string;
  readonly state: string;
}

export interface RunStripV1 {
  /** The root operation the strip describes; "Show in Notifications" and "Stop" point at it. */
  readonly operationId: string;
  /** What is running, e.g. `Apply Review — High-Level Code Review`. Changes rarely, so it is what is announced. */
  readonly label: string;
  /** The model actually running it, or a plain note while checks run before any model starts. */
  readonly model?: string;
  /** Epoch ms the operation started, so the webview can keep "N min" fresh without a new message. */
  readonly startedAt: number;
  /** `HH:MM` of the start, pre-formatted on the host. */
  readonly sinceClock: string;
  /** The latest progress the operation reported. */
  readonly latest?: string;
  /** The operation is paused on the owner. */
  readonly waiting: boolean;
  readonly cancellable: boolean;
}

/**
 * The strip for a task's live operations, or undefined when nothing runs. Only root operations count
 * (a child is part of its root's work). An operation that does not wait on the owner wins over one
 * that does, and the newest wins among equals, so the strip names what is actually moving.
 */
export function buildRunStripV1(
  operations: readonly RunStripOperationV1[],
  fallbackStage: TaskStage,
  formatClock: (epochMs: number) => string
): RunStripV1 | undefined {
  const roots = operations.filter((op) => op.parentId === undefined && op.state === "running");
  if (roots.length === 0) return undefined;
  const chosen = [...roots].sort(
    (a, b) => Number(a.waitingForUser) - Number(b.waitingForUser) || b.startedAt - a.startedAt
  )[0]!;
  const label = operationChatLabelV1({ ...chosen, detail: undefined, activity: undefined }, fallbackStage);
  const model = describeOperationModelSegmentV1({
    modelId: chosen.modelId,
    activity: chosen.activity,
    detail: chosen.detail,
  });
  const latest = (chosen.activity ?? chosen.detail)?.trim();
  return {
    operationId: chosen.id,
    label,
    ...(model !== undefined ? { model } : {}),
    startedAt: chosen.startedAt,
    sinceClock: formatClock(chosen.startedAt),
    ...(latest ? { latest } : {}),
    waiting: chosen.waitingForUser,
    cancellable: chosen.cancellable,
  };
}

/** Whether two strips differ in anything the owner sees, so an unchanged strip is not posted again. */
export function runStripChangedV1(a: RunStripV1 | undefined, b: RunStripV1 | undefined): boolean {
  return JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);
}
