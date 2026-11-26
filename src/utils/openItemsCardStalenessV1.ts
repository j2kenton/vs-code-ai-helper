/**
 * bugs4 item 13 / Step 24: the "open plan items" decision card states how many items were open
 * when it was raised ("The plan checklist still has N open items"). Once plan-final.md has fewer
 * open items than that, the card's list is out of date: its premise was invalidated when those
 * items were ticked, so it is withdrawn by the same rule that withdraws the tick-application card.
 */

/** The `decisionKey` of the open-items card (see `buildOpenPlanItemsNeedDecisionCardInputV1`). */
export const OPEN_PLAN_ITEMS_DECISION_KEY_V1 = "openPlanItemsNeedDecision";

const OPEN_COUNT_RE = /\bstill has (\d+) open items?\b/i;

/** The open-item count the card stated, or undefined when its text does not state one. */
export function parseOpenItemsCardCountV1(whatHappened: string): number | undefined {
  const match = OPEN_COUNT_RE.exec(whatHappened);
  return match?.[1] === undefined ? undefined : Number.parseInt(match[1], 10);
}

/**
 * True when the plan now has fewer open items than the card listed. A card that does not state a
 * count is never judged stale here (the render-time safety net still covers it).
 */
export function isOpenItemsCardStaleV1(whatHappened: string, currentOpenCount: number): boolean {
  const listed = parseOpenItemsCardCountV1(whatHappened);
  return listed !== undefined && currentOpenCount < listed;
}
