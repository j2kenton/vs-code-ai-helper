/**
 * bugs4 item 17 / Step 17: when a review has just checked the code against the checklist (its
 * `## Verified Complete` block was applied, or found nothing to add), the unreliable-checklist
 * flag has nothing left to ask the owner, so Ensemble clears it itself and says so in chat
 * instead of raising a one-option "Decision needed".
 *
 * Deliberately narrow: the general "the latch is set once and never cleared" design belongs to
 * workflow 12. Anything that leaves a question open (test-dependent items still withheld, a
 * plan without a checklist, a review with no Verified Complete block at all) keeps the latch.
 */

export interface VerifiedCompleteReviewOutcomeV1 {
  /** The review carries a `<!-- verified-complete:start/end -->` block (even an empty one). */
  readonly blockPresent: boolean;
  /** Reviewer-verified ticks written to plan-final.md by this review. */
  readonly appliedCount: number;
  /** Items the review named that stay provisional for a missing test report. */
  readonly withheldTestItems: number;
  /** Severity of a blocked derivation: "warning" means something is wrong, "info" means nothing to add. */
  readonly blockedSeverity?: "info" | "warning";
}

export interface LatchAutoClearDecisionV1 {
  readonly clear: boolean;
  /** One plain sentence: why it clears, or why it stays. */
  readonly reason: string;
}

export function decideLatchAutoClearAfterReviewV1(outcome: VerifiedCompleteReviewOutcomeV1): LatchAutoClearDecisionV1 {
  if (!outcome.blockPresent) {
    return {
      clear: false,
      reason: "the review has no Verified Complete block, so it did not check the code against the checklist",
    };
  }
  if (outcome.withheldTestItems > 0) {
    return {
      clear: false,
      reason: `${outcome.withheldTestItems} item${outcome.withheldTestItems === 1 ? "" : "s"} the review named still wait for a passing test report`,
    };
  }
  if (outcome.appliedCount > 0) {
    return {
      clear: true,
      reason: `the review checked the code against the checklist and ${outcome.appliedCount} verified tick${outcome.appliedCount === 1 ? " was" : "s were"} applied`,
    };
  }
  if (outcome.blockedSeverity === "warning") {
    return { clear: false, reason: "applying the review's verified ticks reported a problem" };
  }
  return {
    clear: true,
    reason: "the review checked the code against the checklist and found nothing to add",
  };
}

/** The one chat line that says the flag was cleared. */
export function formatLatchAutoClearedLineV1(decision: LatchAutoClearDecisionV1): string {
  return (
    `The plan checklist is no longer flagged unreliable: ${decision.reason}. ` +
    "Completeness gating counts it as a complete record again. Nothing else will run now; " +
    "use Fast Forward or Apply Current Stage Action to continue."
  );
}
