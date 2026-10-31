import { randomUUID } from "node:crypto";
import type { WorkflowDecisionAwaitedOriginV1, WorkflowDecisionV1 } from "../types/workflowDecisionV1";

/**
 * In-process ownership of awaited decisions (bugs3 Step 13).
 *
 * A decision posted by `awaitWorkflowDecisionAnswerV1` can only be acted on by
 * the in-process promise that posted it. This module is the single place that
 * knows which waiters are alive in THIS extension host activation, so the
 * activation sweep, the answer path and the chat can all ask the same question
 * ("can anything still act on an answer?") instead of listing decision keys.
 *
 * No `vscode` import: the store and the dispatcher both depend on it.
 */

/** Identity of this extension-host activation; a record from another activation has no live waiter. */
export const ACTIVATION_ID_V1 = randomUUID();

const liveWaiterIds = new Set<string>();

/** Register a waiter BEFORE its card is exposed, so no answer can race ahead of it. */
export function registerAwaitedWaiterV1(): string {
  const waiterId = randomUUID();
  liveWaiterIds.add(waiterId);
  return waiterId;
}

/** Release a waiter once its promise has settled (answered, dismissed, timed out, cancelled). */
export function releaseAwaitedWaiterV1(waiterId: string): void {
  liveWaiterIds.delete(waiterId);
}

export function isAwaitedWaiterLiveV1(awaited: WorkflowDecisionAwaitedOriginV1): boolean {
  return awaited.activationId === ACTIVATION_ID_V1 && liveWaiterIds.has(awaited.waiterId);
}

/**
 * Decision keys created through the awaiting helper before records carried
 * `awaited`. Only these legacy records are treated as awaited by key: every
 * other record without `awaited` is left alone, because a durable
 * command-backed decision must never be retired just for lacking the marker.
 */
export const LEGACY_AWAITED_DECISION_KEYS_V1: ReadonlySet<string> = new Set([
  "implementationRoundLimitReached",
  "quotaExhaustedDuringRun",
  "choosePublishVerificationScope",
  "confirmLargePromptSize",
  "confirmBlockerSupersessionEdit",
  "settleChecklistPickItem",
  "settleChecklistPickMode",
  "chooseReviewRetryModel",
  "confirmGlobalAssistantAction",
  "recoverInterruptedRevertJournal",
]);

/**
 * True when the decision was waiting on an in-process continuation that no
 * longer exists. Records with the `awaited` marker are judged by their waiter;
 * legacy records only by the known awaited keys.
 */
export function isOrphanedAwaitedDecisionV1(decision: WorkflowDecisionV1): boolean {
  if (decision.state !== "pending") {
    return false;
  }
  if (decision.awaited !== undefined) {
    return !isAwaitedWaiterLiveV1(decision.awaited);
  }
  return LEGACY_AWAITED_DECISION_KEYS_V1.has(decision.decisionKey);
}

/** How to start again, in the owner's words; the caller's guidance when it supplied one. */
export function awaitedRestartGuidanceV1(decision: WorkflowDecisionV1): string {
  return (
    decision.awaited?.restartGuidance ??
    "Start the action again from the Tasks view or the stage's chat."
  );
}

/** The chat line recording that an awaited card was dropped, and how to run it again. */
export function describeOrphanedAwaitedDecisionV1(decision: WorkflowDecisionV1): string {
  return (
    `Dismissed: "${decision.whatHappened}" was waiting on a run that a reload, crash or update ended, ` +
    `so it can no longer be answered. ${awaitedRestartGuidanceV1(decision)}`
  );
}
