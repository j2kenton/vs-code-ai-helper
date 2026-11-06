/**
 * review1 Step 56: on a review stage that has a current review, the next action is named for the work, not for where
 * the stage pointer sits: "Continue the work (N of M plan items left)". N and M come from the shared plan-item
 * counter (`readPlanItemCountsV1`), so the stage action, the Tasks row and the cards give one figure.
 */
export interface PlanItemsLeftV1 {
  /** Plan items not yet settled (`total - settled`). */
  readonly left: number;
  /** Top-level plan items (the fixed denominator). */
  readonly total: number;
}

/** `{ left, total }` from the shared counter's `total` and `settled`. Never negative. */
export function planItemsLeftFromCountsV1(counts: { readonly total: number; readonly settled: number }): PlanItemsLeftV1 {
  return { left: Math.max(0, counts.total - counts.settled), total: counts.total };
}

/** "3 of 48 plan items left" — the figure shown next to the score and in the action label. */
export function describePlanItemsLeftV1(items: PlanItemsLeftV1): string {
  return `${items.left} of ${items.total} plan items left`;
}

/** A menu entry the status bar's Ensemble Actions pick offers for the stage action. */
export interface ContinueTheWorkMenuEntryV1 {
  readonly label: string;
  readonly detail: string;
}

/**
 * The stage action as a menu entry on a review stage that has a current review (review1 Step 56). The command
 * palette and keybinding titles in `package.json` are static, so this live label is the selectable surface that can
 * carry the figure; it runs the same stage action. Never worded as going back a stage.
 */
export function describeContinueTheWorkMenuEntryV1(items: PlanItemsLeftV1 | undefined): ContinueTheWorkMenuEntryV1 {
  return {
    label: `$(play) ${describeContinueTheWorkLabelV1(items)}`,
    detail:
      "Runs the stage's next action with the latest review and the plan: fixes the blockers, then builds the next " +
      "unbuilt plan steps, then re-reviews",
  };
}

/** The stage action's name on a review stage with a current review. */
export function describeContinueTheWorkLabelV1(items: PlanItemsLeftV1 | undefined): string {
  return items && items.total > 0 ? `Continue the work (${describePlanItemsLeftV1(items)})` : "Continue the work";
}
