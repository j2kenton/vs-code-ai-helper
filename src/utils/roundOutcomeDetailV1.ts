/**
 * chat1 Step 5: a round's outcome detail (score, files changed, model, run log) used to be a chat
 * line. The chat no longer shows it, so it goes to Notifications without a second entry for the same
 * ending: while a root operation for the task is still live, the detail waits here and that
 * operation's end entry (`installOperationNotificationBridge`) carries it; a round with no live
 * operation gets its own entry.
 */

const MAX_PENDING_DETAILS_V1 = 100;
const MAX_DETAIL_CHARS_V1 = 1200;

interface PendingDetailV1 {
  readonly taskKey: string;
  readonly operationId: string;
  readonly detail: string;
}

const pendingDetailsV1: PendingDetailV1[] = [];

/**
 * The detail of a round's ending, without the `_Ended: <step> — <state>` head the operation's end
 * entry already says. `undefined` when the line has nothing beyond that head.
 */
export function roundOutcomeDetailOfV1(messageText: string, head: string): string | undefined {
  const body = messageText.replace(/^_+|_+$/g, "").trim();
  const rest = body.startsWith(head) ? body.slice(head.length) : body;
  const detail = rest.replace(/^\s*—\s*/, "").trim();
  if (detail.length === 0) return undefined;
  return detail.length > MAX_DETAIL_CHARS_V1 ? `${detail.slice(0, MAX_DETAIL_CHARS_V1)}…` : detail;
}

/** Keep a round's detail for the end entry of the task's root operation. */
export function stashRoundOutcomeDetailV1(taskKey: string, operationId: string, detail: string): void {
  const existing = pendingDetailsV1.findIndex((p) => p.operationId === operationId);
  if (existing >= 0) pendingDetailsV1.splice(existing, 1);
  pendingDetailsV1.push({ taskKey, operationId, detail });
  while (pendingDetailsV1.length > MAX_PENDING_DETAILS_V1) pendingDetailsV1.shift();
}

/**
 * Take (and forget) every detail kept for the task, oldest first. Called when a root operation of
 * the task ends: the round that ran under it (or under a child of it) ended with it.
 */
export function takeRoundOutcomeDetailsForTaskV1(taskKey: string): string[] {
  const taken: string[] = [];
  for (let i = pendingDetailsV1.length - 1; i >= 0; i--) {
    const pending = pendingDetailsV1[i];
    if (pending !== undefined && pending.taskKey === taskKey) {
      taken.unshift(pending.detail);
      pendingDetailsV1.splice(i, 1);
    }
  }
  return taken;
}

const MAX_PROJECTED_ROUNDS_V1 = 500;
const projectedRoundKeysV1 = new Set<string>();

/**
 * Claim the right to send one round's ending to Notifications. The chat line and the Notifications
 * entry have separate claims: when the operation observer already posted the chat line, the round
 * still owes Notifications its detail, and a second terminalization of the same round must not
 * send it twice. Returns true for the first claim of a key.
 */
export function claimRoundNotificationV1(roundKey: string): boolean {
  if (projectedRoundKeysV1.has(roundKey)) return false;
  projectedRoundKeysV1.add(roundKey);
  if (projectedRoundKeysV1.size > MAX_PROJECTED_ROUNDS_V1) {
    const oldest = projectedRoundKeysV1.values().next().value;
    if (oldest !== undefined) projectedRoundKeysV1.delete(oldest);
  }
  return true;
}

/** Give a claim back, so a failed projection can be retried. */
export function releaseRoundNotificationV1(roundKey: string): void {
  projectedRoundKeysV1.delete(roundKey);
}

/** Test seam. */
export function clearRoundOutcomeDetailsV1(): void {
  pendingDetailsV1.length = 0;
  projectedRoundKeysV1.clear();
}
