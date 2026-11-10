/**
 * review2 Step 13: every review refusal says why it did not start and what to click next.
 *
 * A review that returned without starting used to end as "refused — it did not start" with no
 * reason when a guard clause had raised only a toast (or nothing). This is the one place that
 * turns a refusal's recorded reason (possibly missing) into the sentence the chat's "Ended …"
 * line and the notification show.
 */

/** What to say when whoever refused recorded nothing. */
export const NO_RECORDED_REFUSAL_REASON_V1 = "no reason was recorded";

/** The next click after a review refusal whose own reason named none. */
export const REVIEW_REFUSAL_NEXT_CLICK_V1 =
  "Next: clear that cause and click Review again, or open the task chat for the card Ensemble raised.";

/** Operation kinds whose refusals must always carry a next click. */
const KINDS_WITH_NEXT_CLICK_V1: ReadonlySet<string> = new Set(["review"]);

/** True when the text already tells the reader what to do next. */
function namesNextClickV1(text: string): boolean {
  return /\bnext:|\b(click|choose|press|re-?run|retry|open|use|add|fix|wait|accept|keep|widen|resolve|configure|set up)\b/i.test(text);
}

/**
 * The reason to show for a refused operation. A missing reason becomes
 * "no reason was recorded"; a review refusal whose reason names no next click gets one.
 * Other kinds keep their reason exactly as recorded (their own wording already carries recovery).
 */
export function describeRefusalReasonV1(reason: string | undefined, kind: string | undefined): string | undefined {
  const trimmed = reason?.trim().replace(/[.\s]+$/, "") ?? "";
  const isReview = kind !== undefined && KINDS_WITH_NEXT_CLICK_V1.has(kind);
  if (!isReview) {
    return trimmed === "" ? undefined : trimmed;
  }
  const base = trimmed === "" ? NO_RECORDED_REFUSAL_REASON_V1 : trimmed;
  return namesNextClickV1(base) ? base : `${base}. ${REVIEW_REFUSAL_NEXT_CLICK_V1.replace(/\.$/, "")}`;
}
