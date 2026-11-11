/**
 * The hover on a running row in Ensemble Status (bugs6 item 43, owner request 2026-11-09).
 *
 * The row's grey text holds everything about the round (stage, what it is doing, model and provider, start time,
 * elapsed time, last activity, a held answer), joined on one line wider than the pane, so the owner scrolled sideways
 * to read it. The hover now lists the same facts one per line, labelled, and never drops one the line shows.
 */
import { describeModelWithProviderV1, getCliProvider, parseModelSelection } from "../runners/providers";

export interface RunningRowTooltipInputV1 {
  /** The row's label, e.g. "Apply Review — review2". */
  readonly label: string;
  /** The task's display name, shown as its own "Task:" line (the label above joins it with the action's name). */
  readonly taskName?: string;
  readonly stageLabel?: string;
  /** What the round is doing now (the row's activity segment). */
  readonly doing: string;
  readonly modelId?: string;
  /** The row's model segment when no model id is known (e.g. "checks running; model not started yet"). */
  readonly modelSegment?: string;
  readonly startedAt: number;
  /** When the current step started, if the round reports one; the row's elapsed time counts from here. */
  readonly activityStartedAt?: number;
  readonly now: number;
  /** The no-activity warning, if shown. */
  readonly warning?: string;
  /** "last activity 2m ago …" or "last output 2m ago …", if known; shown with a capital first letter. */
  readonly activityLine?: string;
  /** Further proof-of-life lines. */
  readonly evidenceLines: readonly string[];
  /** The held-answer text the row shows, if an answer is held. */
  readonly heldAnswer?: string;
  readonly cancellable: boolean;
  readonly stuck: boolean;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "14:02 (12:02 UTC)": local clock first, as on the row, then UTC for the run records. */
export function formatClockWithUtcV1(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())} (${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC)`;
}

/** Same format as the row's elapsed segment: "48s", "17m 42s", "1h 5m". */
export function formatDurationV1(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function modelLines(input: RunningRowTooltipInputV1): string[] {
  if (input.modelId) {
    const parsed = parseModelSelection(input.modelId);
    const provider =
      parsed.provider === "copilot" ? "GitHub Copilot" : (getCliProvider(parsed.provider)?.label ?? parsed.provider);
    if (parsed.model && provider) {
      return [`Model: ${parsed.model}`, `Provider: ${provider}`];
    }
    return [`Model: ${describeModelWithProviderV1(input.modelId)}`];
  }
  return [`Model: ${input.modelSegment ?? "not reported yet"}`];
}

/** The hover text for a running row: one labelled fact per line. */
export function buildRunningRowTooltipV1(input: RunningRowTooltipInputV1): string {
  const lines: string[] = [input.label, ""];
  if (input.taskName) {
    lines.push(`Task: ${input.taskName}`);
  }
  if (input.stageLabel) {
    lines.push(`Stage: ${input.stageLabel}`);
  }
  lines.push(`Doing: ${input.doing}`);
  lines.push(...modelLines(input));
  lines.push(`Started: ${formatClockWithUtcV1(input.startedAt)}`);
  lines.push(`Running for: ${formatDurationV1(input.now - input.startedAt)}`);
  if (input.activityStartedAt !== undefined && input.activityStartedAt > input.startedAt) {
    lines.push(
      `This step: ${formatDurationV1(input.now - input.activityStartedAt)}, since ${formatClockWithUtcV1(input.activityStartedAt)}`
    );
  }
  if (input.warning !== undefined) {
    lines.push(`Warning: ${input.warning}`);
  }
  if (input.activityLine !== undefined) {
    lines.push(input.activityLine.charAt(0).toUpperCase() + input.activityLine.slice(1));
  }
  lines.push(...input.evidenceLines);
  if (input.heldAnswer !== undefined) {
    lines.push(`Held answer: ${input.heldAnswer}`);
  }
  if (input.cancellable) {
    lines.push("");
    lines.push("Stop button (on this row): cancels this round.");
    if (input.stuck) {
      lines.push("Wait button: keeps the round running and hides the no-activity warning.");
    }
    if (input.heldAnswer !== undefined) {
      lines.push("Run held answer now: stops this round and runs your held answer. Drop: discards the held answer.");
    }
  }
  return lines.join("\n");
}
