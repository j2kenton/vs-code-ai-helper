import type { TaskStage } from "../types/taskProgress";

/**
 * review1 Step 57: a manual move out of High-Level Code Review (Complete Stage & Move On, or a card option that runs
 * the same command) while plan items are still open asks first, in a pop-up (it answers a click), and names what will
 * be skipped. Low-Level Code Review asks whether the implementation is any good, which presumes one; at 28% built
 * that move should not be reachable without saying plainly what is being skipped.
 *
 * Pure: the caller supplies the open count from Step 5's counts (`PlanItemCountsV1.open`, which excludes owner
 * hand-offs and settled items).
 */

/** True for the one move this guard covers. */
export function advanceNeedsOpenItemsConfirmationV1(source: TaskStage, destination: TaskStage): boolean {
  return source === "impl-high-review" && destination === "impl-low-review";
}

/** The label of the only button that goes ahead: it states what is being skipped. */
export function advanceOverOpenItemsLabelV1(openCount: number): string {
  return `Move on, leaving ${openCount} plan item${openCount === 1 ? "" : "s"} open`;
}

/** The pop-up's message. */
export function describeAdvanceOverOpenItemsV1(openCount: number, destinationName: string): string {
  const items = openCount === 1 ? "1 plan item is" : `${openCount} plan items are`;
  return (
    `${items} still open in plan-final.md. Moving on to ${destinationName} skips them: the review there looks at the ` +
    "quality of what was built, not at what was never built. Nothing is lost; you can come back and continue the work."
  );
}
