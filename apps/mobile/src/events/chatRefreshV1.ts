/**
 * Chat live-refresh trigger (plan Part 9 polish): which stream events should
 * make an open Chat screen re-fetch its turns and gates. The binder bumps a
 * per-task revision for these; ChatScreen reloads when the revision of ITS
 * task changes. Kept pure so the mapping is unit-testable.
 *
 * Covered: gate lifecycle (a `gateRequested` notification or a
 * `gateStateChanged` transition — new gate cards, decisions landing from
 * another device) and `chatTransactionState` (the engine advancing a chat
 * interaction). Progress frames and feed-only notifications don't touch the
 * chat transcript and deliberately do not trigger a refetch.
 */
import type { WsServerEventV1 } from './wsEventsV1';

/**
 * The task whose open Chat screen should refresh for this event, or `null`
 * when the event cannot change the chat transcript or gate list.
 */
export function chatRefreshTaskIdV1(event: WsServerEventV1): string | null {
  if (event.type === 'notification' && event.notification.kind === 'gateRequested') {
    return event.notification.taskId;
  }
  if (event.type === 'gateStateChanged' || event.type === 'chatTransactionState') {
    return event.taskId;
  }
  return null;
}
