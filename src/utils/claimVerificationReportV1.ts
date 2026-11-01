/**
 * bugs4 item 21 / Step 17: when a round claims plan items, say how many became verified and why
 * the rest did not, so a verified count that is not moving always has a stated reason
 * ("37 claimed; 0 verified: review named none; 0 test reports parsed").
 *
 * A model claim becomes verified only when a review names it under `## Verified Complete`
 * (and, for a test-dependent item, an applicable passing test report exists), so at the end of
 * an editing round the verified count is whatever the review had already recorded.
 */

export interface ClaimVerificationInputV1 {
  /** Items this round newly ticked or claimed done. */
  readonly claimed: number;
  /** Of those, how many already carry a reviewer verification. */
  readonly verified: number;
  /** Applicable passing test reports parsed from this round's summary. */
  readonly testReportsParsed: number;
  /** Claimed test-dependent items whose evidence did not count, each with the reason. */
  readonly uncounted: ReadonlyArray<{ readonly itemText: string; readonly reason: string }>;
  /** The round reported that the provider refused its test commands. */
  readonly testsRefused?: boolean;
}

/** One-line report: "N claimed; M verified: <reasons>". Empty when nothing was claimed. */
export function formatClaimVerificationReportV1(input: ClaimVerificationInputV1): string {
  if (input.claimed <= 0) return "";
  const unverified = Math.max(0, input.claimed - input.verified);
  const reasons: string[] = [];
  if (unverified > 0) {
    reasons.push("review named none yet (a model claim is verified only when a review names it under Verified Complete)");
  }
  reasons.push(
    `${input.testReportsParsed} test report${input.testReportsParsed === 1 ? "" : "s"} parsed`
  );
  if (input.uncounted.length > 0) {
    const first = input.uncounted[0]!;
    reasons.push(
      `${input.uncounted.length} claimed test item${input.uncounted.length === 1 ? "" : "s"} not counted (${first.reason}${input.uncounted.length > 1 ? "; see the run log for the rest" : ""})`
    );
  }
  if (input.testsRefused === true) {
    reasons.push("the provider refused the round's test commands, so no report could exist");
  }
  return `${input.claimed} claimed; ${input.verified} verified: ${reasons.join("; ")}.`;
}

/** Run-log section carrying the report line. */
export function formatClaimVerificationSectionV1(input: ClaimVerificationInputV1): string {
  const line = formatClaimVerificationReportV1(input);
  return line.length === 0 ? "" : `\n\n## Claims and verification\n\n${line}\n`;
}

/**
 * Every plan item a round claimed done: the boxes it newly ticked plus the claims the
 * test-evidence rule withheld. A withheld claim is exactly the case the report must explain
 * ("N claimed; 0 verified: no test report parsed"), so counting only new ticks would produce
 * no report at all for it. De-duplicated by `keyOf`, in first-seen order.
 */
export function collectRoundClaimedItemsV1(
  newlyChecked: readonly string[],
  withheldForTestEvidence: readonly string[],
  keyOf: (text: string) => string
): readonly string[] {
  const seen = new Set<string>();
  const claimed: string[] = [];
  for (const text of [...newlyChecked, ...withheldForTestEvidence]) {
    const key = keyOf(text);
    if (seen.has(key)) continue;
    seen.add(key);
    claimed.push(text);
  }
  return claimed;
}
