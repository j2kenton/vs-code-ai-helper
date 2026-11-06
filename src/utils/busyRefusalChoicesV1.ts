/**
 * bugs3 Step 12: the busy refusal's "Cancel" and "Wait" as real choices.
 *
 * `describePlainBusyRefusalV1` says what is running and how long. Words alone leave
 * Cancel and Wait as instructions to go elsewhere; this posts them as options on a chat
 * card (the owner's rule: input and action buttons live in the chat, never in a
 * notification), with the claim's technical identifiers kept on the card's evidence
 * section instead of in its text.
 *
 * Nothing is offered for a stalled claim (nothing is running, so there is nothing to
 * cancel). A fresh claim whose operation has not registered yet still gets the choices:
 * its Cancel carries the claim's id and resolves the operation only while that same claim
 * still holds the task.
 */
import * as path from "node:path";
import type { WorkAdmissionBusyV1, WorkAdmissionWriteFailedV1 } from "../state/workAdmissionV1";
import { describePlainBusyRefusalV1 } from "./busyAdmissionTextV1";
import { offerActionInChatV1 } from "./chatActionOfferV1";

/** A refusal for the same running operation is offered once in this window, however often the owner retries. */
const BUSY_OFFER_DEDUPE_MS_V1 = 60_000;
const recentBusyOffersV1 = new Map<string, number>();

export type ClaimCancelTargetV1 =
  | { readonly kind: "operation"; readonly operationId: string }
  | { readonly kind: "ended" | "notStarted"; readonly message: string };

/**
 * What a claim-only Cancel acts on when it is chosen. The card recorded the claim it was raised
 * for; the operation holding the task is looked up only while that very claim still holds it. A
 * claim that has ended, or been replaced by another action on the same task, never reaches the
 * replacement operation: it is refused with a message and nothing is cancelled.
 */
export function resolveClaimCancelTargetV1(
  taskFolderPath: string,
  claimId: string | undefined,
  deps: {
    readonly currentClaimId: (taskFolderPath: string) => string | undefined;
    readonly liveOperationId: (taskFolderPath: string) => string | undefined;
  }
): ClaimCancelTargetV1 {
  if (claimId === undefined || deps.currentClaimId(taskFolderPath) !== claimId) {
    return {
      kind: "ended",
      message:
        "That action has already ended (the task is free, or a different action now holds it), so nothing was cancelled. To stop a newer action, use its own row in Notifications.",
    };
  }
  const operationId = deps.liveOperationId(taskFolderPath);
  if (operationId === undefined) {
    return {
      kind: "notStarted",
      message:
        "That action has not started yet, so there is nothing to cancel. Try again in a moment; if it never starts it releases the task on its own.",
    };
  }
  return { kind: "operation", operationId };
}

/** review1 Step 41: a hold that started within this window is not offered as "Cancel is the next step". */
const RECENT_HOLD_WINDOW_MS_V1 = 60_000;

/** True when the claim holding the task started within the last minute (whoever started it). */
export function isRecentlyStartedHoldV1(outcome: WorkAdmissionBusyV1, now: number = Date.now()): boolean {
  const startedAtMs = outcome.owner ? Date.parse(outcome.owner.startedAt) : Number.NaN;
  return Number.isFinite(startedAtMs) && now - startedAtMs >= 0 && now - startedAtMs <= RECENT_HOLD_WINDOW_MS_V1;
}

/**
 * The card's "why you are asked" line for a hold that has only just started. The generic line says the
 * Cancel action "is the next step", which for an action started seconds ago (often by the owner's own click) sends
 * the owner to stop the very thing they asked for.
 */
export function describeRecentHoldWhyV1(label: string): string {
  return `${label} only just started, so waiting for it is the usual next step. Cancel it only if you did not mean to run it.`;
}

/** Test seam: forget the recent-offer memory. */
export function resetBusyRefusalOffersForTestV1(): void {
  recentBusyOffersV1.clear();
}

/**
 * For a command's busy refusal: shows nothing itself (the caller still shows its
 * warning text) but posts the Cancel/Wait chat card when a live operation holds the
 * task. Fire-and-forget, so a chat problem never changes the refusal.
 */
export function offerBusyRefusalChoicesOnceV1(
  outcome: WorkAdmissionBusyV1 | WorkAdmissionWriteFailedV1,
  taskDisplayName?: string
): void {
  if (outcome.outcome !== "busy") {
    return;
  }
  const taskFolderPath = path.dirname(path.dirname(outcome.markerPath));
  void offerBusyRefusalChoicesInChatV1(taskFolderPath, outcome, taskDisplayName).catch(() => false);
}

export async function offerBusyRefusalChoicesInChatV1(
  taskFolderPath: string,
  outcome: WorkAdmissionBusyV1,
  taskDisplayName?: string,
  now: number = Date.now()
): Promise<boolean> {
  const plain = describePlainBusyRefusalV1(outcome, taskDisplayName);
  const running = plain.runningOperation;
  if (running === undefined && plain.claimOnlyAction === undefined) {
    return false;
  }
  // A fresh claim whose operation has not registered yet: Cancel names the task and the claim, and the
  // command finds the operation only while that same claim still holds the task (or says it ended / has not started).
  const label = running?.label ?? plain.claimOnlyAction ?? "the running action";
  // Claim-only: carry the originating claim's id so a later action on the same task is never cancelled by it.
  const claimId = outcome.owner?.claimId;
  if (running === undefined && claimId === undefined) {
    return false;
  }
  const cancelArgs = running !== undefined ? { id: running.operationId } : { taskFolderPath, claimId };
  const dedupeKey = `${taskFolderPath}\u0000${running?.operationId ?? `claim:${outcome.owner?.commandId ?? "unknown"}`}`;
  const lastOfferedAt = recentBusyOffersV1.get(dedupeKey);
  if (lastOfferedAt !== undefined && now - lastOfferedAt < BUSY_OFFER_DEDUPE_MS_V1) {
    return false;
  }
  recentBusyOffersV1.set(dedupeKey, now);
  const pointer = await offerActionInChatV1({
    taskFolderPath,
    actionLabel: `Cancel ${label}`,
    ...(isRecentlyStartedHoldV1(outcome, now) ? { whyUserNeeded: describeRecentHoldWhyV1(label) } : {}),
    command: "vs-code-ai-helper.cancelOperation",
    args: [cancelArgs],
    actionResumeKind: "unpause",
    noticeText: plain.message,
    actionConsequence:
      running !== undefined
        ? `Stops ${label}. Work it has already finished stays; the task then accepts a new action.`
        : `Stops ${label} once it has started, if it has by then; if it has not started yet, says so and stops nothing. Work already finished stays.`,
    doNothingOption: {
      label: "Wait",
      consequence: `Does nothing. ${label} finishes on its own, and you can then run this again.`,
    },
    recommend: { target: "none", reasoning: "Waiting is safe; cancel only if you do not want the running action to finish." },
    optional: true,
    evidence: [{ label: "Details", detail: plain.details }],
  });
  return pointer !== undefined;
}
