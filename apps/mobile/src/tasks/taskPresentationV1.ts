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
