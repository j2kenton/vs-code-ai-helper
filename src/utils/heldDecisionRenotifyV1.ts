import type { WorkflowDecisionV1 } from "../types/workflowDecisionV1";

/**
 * bugs5 Step 1 / item 1: a card announced "For information" because a running operation held back
 * its only actionable option is announced again as "Decision needed" when that operation ends, if
 * the card is still pending and its option is available again. This module remembers which cards
 * were announced as information only; the re-check itself is pure (injected reads), so it is
 * testable without a window.
 *
 * Memory only, on purpose: after a restart the pending card is still on screen with its button
 * back, and a stale "raised again" toast for an old card would be noise.
 */

interface HeldAnnouncementV1<TTarget> {
  readonly target: TTarget;
}

const announcedAsInformation = new Map<string, HeldAnnouncementV1<unknown>>();

export function markDecisionAnnouncedAsInformationOnlyV1<TTarget>(decisionId: string, target: TTarget): void {
  announcedAsInformation.set(decisionId, { target });
}

export function clearDecisionAnnouncedAsInformationOnlyV1(decisionId: string): void {
  announcedAsInformation.delete(decisionId);
}

export function isDecisionAnnouncedAsInformationOnlyV1(decisionId: string): boolean {
  return announcedAsInformation.has(decisionId);
}

export function resetHeldDecisionAnnouncementsForTestV1(): void {
  announcedAsInformation.clear();
}

export interface RenotifyHeldDecisionsDepsV1<TTarget> {
  /** The decision as the owner sees it now (after the live-operation hold), or undefined when it is gone. */
  readonly getViewedPending: (decisionId: string) => WorkflowDecisionV1 | undefined;
  readonly hasActionableOption: (decision: WorkflowDecisionV1) => boolean;
  readonly notify: (decision: WorkflowDecisionV1, target: TTarget) => void;
}

/**
 * Called whenever an operation ended. Cards that are gone (resolved, dismissed, withdrawn,
 * replaced) are forgotten without a word; cards that are pending and actionable again are
 * announced once more and forgotten; cards still held stay remembered for the next end.
 * Returns the ids announced again.
 */
export function renotifyHeldDecisionsV1<TTarget>(deps: RenotifyHeldDecisionsDepsV1<TTarget>): readonly string[] {
  const announced: string[] = [];
  for (const [decisionId, entry] of [...announcedAsInformation]) {
    const viewed = deps.getViewedPending(decisionId);
    if (!viewed || viewed.state !== "pending") {
      announcedAsInformation.delete(decisionId);
      continue;
    }
    if (!deps.hasActionableOption(viewed)) {
      continue;
    }
    announcedAsInformation.delete(decisionId);
    deps.notify(viewed, entry.target as TTarget);
    announced.push(decisionId);
  }
  return announced;
}
