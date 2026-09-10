/**
 * Pure presentation helpers for the Part 7 task management UI. No React
 * Native imports so the fallback naming rule, `N/M` progress derivation, and
 * status-badge mapping are unit-testable under `node --test`.
 */

export interface TaskNameSourceV1 {
  readonly displayName?: string;
  readonly taskFolder: string;
}

const DATE_PREFIX_V1 = /^\d{4}-\d{2}-\d{2}[_-]/;

/**
 * Humanized derivation of a task folder name: strips a leading ISO date
 * prefix, splits on `_`/`-`, and capitalizes the first word — so an internal
 * folder like `2025-12-01_task_1` reads as "Task 1", never as the raw form.
 */
export function humanizeTaskFolderNameV1(folder: string): string {
  const words = folder
    .replace(DATE_PREFIX_V1, '')
    .split(/[_-]+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) {
    return 'Task';
  }
  const joined = words.join(' ');
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

/**
 * The plan's fallback naming rule: show `displayName` when present (trimmed
 * non-empty), else the humanized folder derivation — never a raw internal
 * folder name.
 */
export function taskDisplayNameV1(source: TaskNameSourceV1): string {
  const trimmed = source.displayName?.trim();
  if (trimmed !== undefined && trimmed.length > 0) {
    return trimmed;
  }
  return humanizeTaskFolderNameV1(source.taskFolder);
}

export interface RoundProgressV1 {
  readonly complete: number;
  readonly total: number;
}

const ROUND_PROGRESS_SUMMARY_V1 = /^(\d+)\/(\d+)$/;

/** Parse a per-round summary of the control plane's `N/M` form. */
export function parseRoundProgressSummaryV1(summary: string | undefined): RoundProgressV1 | null {
  if (summary === undefined) {
    return null;
  }
  const match = ROUND_PROGRESS_SUMMARY_V1.exec(summary.trim());
  if (match === null) {
    return null;
  }
  return { complete: Number(match[1]), total: Number(match[2]) };
}

/** Latest `N/M` progress across a task's round history (newest wins). */
export function latestRoundProgressV1(
  rounds: readonly { readonly summary?: string }[]
): RoundProgressV1 | null {
  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    const parsed = parseRoundProgressSummaryV1(rounds[index]?.summary);
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
}

export interface TaskStatusSourceV1 {
  readonly progress: { readonly status?: string };
  readonly run?: { readonly status: string; readonly failureCode?: string };
}

/**
 * The status a task should be SHOWN with. The core `progress.status` has no
 * failed state — a task whose hosted run stopped on a typed failure is still
 * "active" there, which is what the first live signed-out run looked like:
 * an active task with nothing happening. The run's own state wins when it
 * has stopped (failed) or is waiting on the user (paused); an in-flight or
 * completed run defers to the task's own status, which already says so.
 */
export function effectiveTaskStatusV1(task: TaskStatusSourceV1): string | undefined {
  const run = task.run?.status;
  if (run === 'failed') {
    return 'failed';
  }
  if (run === 'gatePaused' || run === 'questionsPaused') {
    return 'paused';
  }
  return task.progress.status;
}

/** A one-line explanation of a stopped run, or null when there is nothing to explain. */
export function taskFailureNoteV1(task: TaskStatusSourceV1): string | null {
  if (task.run?.status !== 'failed') {
    return null;
  }
  const code = task.run.failureCode;
  switch (code) {
    case undefined:
      return 'The run stopped on a failure.';
    case 'authenticationFailed':
      return 'The run stopped: the model provider rejected the credentials. For claude-cli, sign Claude Code in to your sandbox from Settings; for API models, check the stored key.';
    case 'quotaExhausted':
      return 'The run stopped: the model provider reported its quota or rate limit exhausted, and no backup model was configured.';
    case 'cliRunnerUnavailable':
      return 'The run stopped: the task has no sandbox the Claude Code CLI can run in. Use "My sandbox" (the persistent one) for claude-cli models.';
    case 'sandboxProviderKeyMissing':
      return 'The run stopped: no sandbox provider is enabled for this task\'s provider. Enable it in Settings.';
    case 'sourceAcquisitionFailed':
      return 'The run stopped: the source could not be cloned or attached inside the sandbox.';
    default:
      return `The run stopped: ${code}.`;
  }
}

export type StatusBadgeToneV1 = 'accent' | 'success' | 'warning' | 'danger' | 'muted';

export interface StatusBadgeV1 {
  readonly label: string;
  readonly tone: StatusBadgeToneV1;
}

/**
 * Map a persisted task status to a badge. A missing status means active
 * (the core schema's backward-compat rule); unknown statuses render muted
 * with their own label rather than being hidden.
 */
export function statusBadgeV1(status: string | undefined): StatusBadgeV1 {
  switch (status) {
    case undefined:
    case 'active':
      return { label: 'active', tone: 'accent' };
    case 'creating':
      return { label: 'creating', tone: 'accent' };
    case 'paused':
      return { label: 'paused', tone: 'warning' };
    case 'completed':
      return { label: 'completed', tone: 'success' };
    case 'archived':
      return { label: 'archived', tone: 'muted' };
    case 'failed':
    case 'error':
      return { label: status, tone: 'danger' };
    default:
      return { label: status, tone: 'muted' };
  }
}
