/**
 * Pure notification-feed model (plan Part 8): mapping of decoded WS server
 * events into renderable feed entries, newest-first accumulation with a
 * bounded cap, and per-task filtering. RN-free so the behavior is
 * node-testable; the Activity screen only renders what this module builds.
 *
 * The feed covers exactly the plan's kinds — agent lifecycle events, gate
 * requests, skipped candidates, indeterminate-attempt re-offers, and errors
 * — plus gate state changes so an approval's outcome is visible in the same
 * stream. Progress/chat frames feed their own screens, not this one.
 */
import type { WsServerEventV1 } from './wsEventsV1';

export type FeedEntryKindV1 =
  | 'agentLifecycle'
  | 'gateRequested'
  | 'candidateSkipped'
  | 'indeterminateAttempt'
  | 'error'
  | 'gateStateChanged';

export interface FeedEntryV1 {
  readonly id: string;
  /** ISO timestamp: the server's for notifications, receipt time otherwise. */
  readonly at: string;
  readonly kind: FeedEntryKindV1;
  readonly title: string;
  readonly detail?: string;
  readonly taskId?: string;
  /** Present on gate-related entries; drives the open-gate deep link. */
  readonly gateId?: string;
}

export const FEED_CAP_V1 = 200;

let feedIdCounter = 0;

/** Monotonic per-session feed-entry id (list keys, not persistence). */
export function nextFeedEntryIdV1(): string {
  feedIdCounter += 1;
  return `feed-${feedIdCounter}`;
}

const LIFECYCLE_TITLES: Record<'started' | 'progress' | 'completed' | 'failed', string> = {
  started: 'Agent run started',
  progress: 'Agent progress',
  completed: 'Agent run completed',
  failed: 'Agent run failed',
};

/**
 * Map one decoded server event to a feed entry, or `null` for event types
 * the feed does not carry. `receivedAt` is the fallback timestamp for
 * events without a server-assigned one.
 */
export function feedEntryFromServerEventV1(
  event: WsServerEventV1,
  receivedAt: string,
  id: string
): FeedEntryV1 | null {
  if (event.type === 'notification') {
    const { notification } = event;
    switch (notification.kind) {
      case 'agentLifecycle':
        return {
          id,
          at: event.at,
          kind: 'agentLifecycle',
          title: LIFECYCLE_TITLES[notification.phase],
          taskId: notification.taskId,
          ...(notification.detail !== undefined ? { detail: notification.detail } : {}),
        };
      case 'gateRequested':
        return {
          id,
          at: event.at,
          kind: 'gateRequested',
          title: 'Gate approval requested',
          detail: notification.summary,
          taskId: notification.taskId,
          gateId: notification.gateId,
        };
      case 'candidateSkipped':
        return {
          id,
          at: event.at,
          kind: 'candidateSkipped',
          title: `Candidate skipped: ${notification.modelId}`,
          detail: notification.reason,
          taskId: notification.taskId,
        };
      case 'indeterminateAttempt':
        return {
          id,
          at: event.at,
          kind: 'indeterminateAttempt',
          title: 'Attempt needs re-approval',
          detail: `Recovery could not prove attempt ${notification.attemptKey} ran; it will not re-execute without your approval.`,
          taskId: notification.taskId,
          gateId: notification.gateId,
        };
      case 'error':
        return {
          id,
          at: event.at,
          kind: 'error',
          title: `Error: ${notification.code}`,
          detail: notification.message,
          ...(notification.taskId !== undefined ? { taskId: notification.taskId } : {}),
        };
    }
  }
  if (event.type === 'gateStateChanged') {
    return {
      id,
      at: receivedAt,
      kind: 'gateStateChanged',
      title: `Gate ${event.state}`,
      taskId: event.taskId,
      gateId: event.gateId,
    };
  }
  return null;
}

/** Prepend an entry (newest first), trimming to the cap. */
export function appendFeedEntryV1(
  entries: readonly FeedEntryV1[],
  entry: FeedEntryV1,
  cap: number = FEED_CAP_V1
): readonly FeedEntryV1[] {
  return [entry, ...entries].slice(0, cap);
}

/** `taskId === null` means no filter (all owned tasks). */
export function filterFeedByTaskV1(
  entries: readonly FeedEntryV1[],
  taskId: string | null
): readonly FeedEntryV1[] {
  return taskId === null ? entries : entries.filter((entry) => entry.taskId === taskId);
}
