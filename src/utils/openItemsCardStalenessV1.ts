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

/**
 * review2 Step 7 (bugs6 item 26): the item texts an open-items card lists. The "Decide item by item" option carries
 * them in its args (the same records the form resolves), which is sturdier than reading the card's prose.
 */
export function listOpenItemsCardItemTextsV1(
  options: readonly {
    readonly optionId: string;
    readonly effect: { readonly kind: string; readonly args?: readonly unknown[] };
  }[]
): string[] {
  const decide = options.find((option) => option.optionId === "decideItemByItem");
  const first = decide?.effect.kind === "command" ? decide.effect.args?.[0] : undefined;
  const items = (first as { readonly items?: unknown } | undefined)?.items;
  if (!Array.isArray(items)) return [];
  return items.flatMap((item) => {
    const text = (item as { readonly itemText?: unknown } | null)?.itemText;
    return typeof text === "string" ? [text] : [];
  });
}

/**
 * How many of the card's listed items are no longer open. `settledCount === listed.length` (with items listed)
 * means nothing on the card is open any more. Items match by normalized text, which is only a staleness test:
 * identical twins keep the card up until both are settled, the safe direction.
 */
export function countSettledOpenItemsCardItemsV1(
  listedItemTexts: readonly string[],
  openNowItemTexts: readonly string[],
  normalize: (text: string) => string
): { readonly listed: number; readonly settled: number } {
  const openNow = new Set(openNowItemTexts.map(normalize));
  return { listed: listedItemTexts.length, settled: listedItemTexts.filter((text) => !openNow.has(normalize(text))).length };
}

/** The chat line for a card whose listed items are all settled now. */
export function describeOpenItemsCardAllSettledV1(listed: number): string {
  return `the ${listed} item${listed === 1 ? " is" : "s are"} now settled; nothing is open on this card`;
}
