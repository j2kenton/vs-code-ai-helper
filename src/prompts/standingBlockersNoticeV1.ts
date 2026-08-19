/**
 * The standing-blockers notice appended to an Implementation round's prompt.
 *
 * `run-implementation.md` is rendered with `{ contextPack, plan }` — the plan
 * checklist and nothing else. The review is not one of its template variables,
 * so an Implementation round is structurally blind to whatever the newest
 * review reported. That is by design: Apply Review
 * (`apply-impl-review-code.md`) is the action rendered WITH the review and
 * told to fix every blocker in it, and `decidePostReviewActionV1` routes to it
 * whenever task-fixable blockers stand.
 *
 * This notice is the hedge behind that routing, not a replacement for it. A
 * round can still reach Implementation with blockers outstanding — a user
 * invoking the command directly, a scheduled chain that predates the routing,
 * a recovery continuation — and when it does, spending the whole round on a
 * checklist that has nothing actionable left is a wasted round. Naming the
 * blockers lets that round do something useful instead.
 *
 * Deliberately framed as context rather than as the round's mandate: the
 * checklist is still what this prompt is built around, and Apply Review
 * remains the action that owns blocker resolution. Overriding the round's
 * purpose here would give the two actions the same job and make which one ran
 * a coin flip.
 */

import { ReviewBlocker } from "../utils/reviewReadiness";

/**
 * Cap on how many blockers are listed. A review that reports a very long
 * blocker list is usually restating one systemic problem many times, and the
 * prompt-size gate is a real constraint (a context pack already inlines ~8KB
 * per reviewed file). The count line below always states the true total, so a
 * truncated list never reads as the complete picture.
 */
export const MAX_LISTED_STANDING_BLOCKERS_V1 = 8;

/**
 * Append the standing task-fixable blockers to an Implementation prompt.
 *
 * Returns `basePrompt` unchanged when nothing is task-fixable — a round with
 * only environmental/unverifiable/spec-defect blockers has nothing it could
 * act on, and saying so would only add noise to a prompt that is already at
 * the size gate's mercy.
 */
export function buildStandingBlockersNoticeV1(
  basePrompt: string,
  context: {
    /** Every blocker the newest review for this stage reported. */
    readonly blockers: readonly ReviewBlocker[];
    /** Display name of the stage that review belongs to. */
    readonly reviewStageName: string;
  }
): string {
  const taskFixable = context.blockers.filter((b) => b.resolver === "task-fixable");
  if (taskFixable.length === 0) {
    return basePrompt;
  }
  const listed = taskFixable.slice(0, MAX_LISTED_STANDING_BLOCKERS_V1);
  const omitted = taskFixable.length - listed.length;
  return (
    basePrompt +
    [
      "",
      "",
      "## Standing Review Blockers",
      "",
      `The most recent ${context.reviewStageName} reported ` +
        `${taskFixable.length} unresolved task-fixable blocker(s) against work that is ` +
        "already built. These are defects in existing code, not unbuilt plan steps, so " +
        "several of them may have no corresponding checklist item at all.",
      "",
      ...listed.map((blocker) => `- [${blocker.category}] ${blocker.description}`),
      ...(omitted > 0 ? ["", `_(${omitted} further task-fixable blocker(s) not listed.)_`] : []),
      "",
      "Your checklist work above remains this round's purpose. But if the checklist has " +
        "nothing left that you can actually act on, fix what you can from this list rather " +
        "than reporting that there is nothing to do — a round that changes nothing while " +
        "these stand is a round wasted, and the next review will report them again " +
        "unchanged. Use the `<!-- ensemble:no-checklist-change -->` marker documented above " +
        "when you fix a blocker that ticks no box.",
    ].join("\n")
  );
}
