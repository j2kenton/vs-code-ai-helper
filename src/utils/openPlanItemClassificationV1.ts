/**
 * bugs4 items 5 and 27: why a plan item is still open, as the "nothing more to
 * build" card states it. The card used to print "no reason given" for every item
 * the round did not name and call all of them items "the round could not build".
 * This classifier gives each item the reason the system actually has:
 *
 * - `refused-by-round`: the round itself said it could not build the item, and
 *   why. Only these items may be called "could not build".
 * - `awaiting-test-report`: the item requires tests, the round durably claimed it
 *   built, and no passing test report has been recorded, so the evidence rule
 *   withholds it. An item with no built signal is `not-reached` however
 *   test-dependent it is: nothing says the work exists. The remedy is an
 *   editing round that runs the tests, not hand-settling the checklist.
 * - `verified-by-review-no-report`: the latest review verified the item built,
 *   but the test-evidence rule (or an unticked box) still holds it back.
 * - `not-reached`: the round neither reported the item built nor unbuildable.
 *
 * Pure: no I/O. The test-evidence rule itself is not touched.
 */
import { isTestDependentChecklistItemV1, normalizeChecklistItemTextV1 } from "./implementationChecklist";

export type OpenPlanItemCategoryV1 =
  | "refused-by-round"
  | "claim-dropped"
  | "awaiting-test-report"
  | "verified-by-review-no-report"
  | "not-reached";

export interface ClassifiedOpenPlanItemV1 {
  readonly itemText: string;
  readonly category: OpenPlanItemCategoryV1;
  /** True when the item requires tests (see `isTestDependentChecklistItemV1`). */
  readonly testDependent: boolean;
  /** One plain sentence; never empty, never "no reason given". */
  readonly reason: string;
}

export interface ClassifyOpenPlanItemInputV1 {
  readonly itemText: string;
  /** The reason the round gave for this item (empty when it named none). */
  readonly roundReason: string;
  /** Normalized item keys (see `normalizeChecklistItemTextV1`) the latest review verified complete. */
  readonly reviewVerifiedKeys?: ReadonlySet<string>;
  /**
   * Normalized item keys the round durably claimed built (a `planItemEvidence`
   * claim for the current plan revision). With a review verification, the only
   * built signal: without one a test-dependent item is not "waiting for a report".
   */
  readonly builtClaimedKeys?: ReadonlySet<string>;
  /**
   * review2 Step 11: normalized keys of items the round's report claimed done while also declaring no checklist
   * change. Ensemble did not use those claims; the item is open because the report contradicted itself, which is
   * a different fact from "the round never reached it".
   */
  readonly droppedClaimKeys?: ReadonlySet<string>;
}

const CLAIM_DROPPED_REASON_V1 =
  "the round claimed it done, but its report also declared no checklist change, so the claim was not used";
const AWAITING_TEST_REPORT_REASON_V1 =
  "waiting for a passing test report: no editing round has recorded one for this item";
const VERIFIED_NO_REPORT_TEST_REASON_V1 =
  "verified built by the review; held back only because no passing test report is recorded";
const VERIFIED_NO_REPORT_REASON_V1 = "verified built by the review; not yet ticked";
const NOT_REACHED_REASON_V1 = "not reached: the round did not report it built or unbuildable";

export function classifyOpenPlanItemV1(input: ClassifyOpenPlanItemInputV1): ClassifiedOpenPlanItemV1 {
  const roundReason = input.roundReason.trim();
  const testDependent = isTestDependentChecklistItemV1(input.itemText);
  if (roundReason.length > 0) {
    return {
      itemText: input.itemText,
      category: "refused-by-round",
      testDependent,
      reason: `the round said: ${roundReason}`,
    };
  }
  const reviewVerified = input.reviewVerifiedKeys?.has(normalizeChecklistItemTextV1(input.itemText)) === true;
  if (reviewVerified) {
    return {
      itemText: input.itemText,
      category: "verified-by-review-no-report",
      testDependent,
      reason: testDependent ? VERIFIED_NO_REPORT_TEST_REASON_V1 : VERIFIED_NO_REPORT_REASON_V1,
    };
  }
  if (input.droppedClaimKeys?.has(normalizeChecklistItemTextV1(input.itemText)) === true) {
    return { itemText: input.itemText, category: "claim-dropped", testDependent, reason: CLAIM_DROPPED_REASON_V1 };
  }
  const builtClaimed = input.builtClaimedKeys?.has(normalizeChecklistItemTextV1(input.itemText)) === true;
  if (testDependent && builtClaimed) {
    return {
      itemText: input.itemText,
      category: "awaiting-test-report",
      testDependent,
      reason: AWAITING_TEST_REPORT_REASON_V1,
    };
  }
  return { itemText: input.itemText, category: "not-reached", testDependent, reason: NOT_REACHED_REASON_V1 };
}

/**
 * review2 Step 6: the newest editing round's run file among the names in a task's `runs/` folder (for example
 * `161-claude-cli-impl.md`), as `runs/<name>`. Reviews, scope rebuilds and backups do not count: only
 * `<number>-<provider>-impl.md` files are editing rounds. `undefined` when there is none.
 */
export function pickLatestEditingRunFileV1(fileNames: readonly string[]): string | undefined {
  let best: { readonly seq: number; readonly name: string } | undefined;
  for (const name of fileNames) {
    const match = /^(\d+)-[^/\\]*-impl\.md$/.exec(name);
    if (!match) continue;
    const seq = Number(match[1]);
    if (!best || seq > best.seq) best = { seq, name };
  }
  return best ? `runs/${best.name}` : undefined;
}

export function classifyOpenPlanItemsV1(
  items: readonly { readonly itemText: string; readonly reason: string }[],
  reviewVerifiedKeys?: ReadonlySet<string>,
  builtClaimedKeys?: ReadonlySet<string>,
  droppedClaimKeys?: ReadonlySet<string>
): ClassifiedOpenPlanItemV1[] {
  return items.map((item) =>
    classifyOpenPlanItemV1({
      itemText: item.itemText,
      roundReason: item.reason,
      ...(reviewVerifiedKeys ? { reviewVerifiedKeys } : {}),
      ...(builtClaimedKeys ? { builtClaimedKeys } : {}),
      ...(droppedClaimKeys ? { droppedClaimKeys } : {}),
    })
  );
}

const CATEGORY_HEADINGS_V1: Readonly<Record<OpenPlanItemCategoryV1, string>> = {
  "claim-dropped": "The round's report contradicted itself",
  "refused-by-round": "The round could not build these",
  "awaiting-test-report": "Waiting for a passing test report",
  "verified-by-review-no-report": "Verified built by the review",
  "not-reached": "Not reached by the round",
};

const CATEGORY_ORDER_V1: readonly OpenPlanItemCategoryV1[] = [
  "refused-by-round",
  "claim-dropped",
  "not-reached",
  "awaiting-test-report",
  "verified-by-review-no-report",
];

/** The card's evidence block: items grouped by category, each with its own reason. */
export function formatClassifiedOpenPlanItemsV1(items: readonly ClassifiedOpenPlanItemV1[]): string {
  const sections: string[] = [];
  for (const category of CATEGORY_ORDER_V1) {
    const inCategory = items.filter((item) => item.category === category);
    if (inCategory.length === 0) continue;
    sections.push(
      `**${CATEGORY_HEADINGS_V1[category]} (${inCategory.length}):**\n` +
        inCategory.map((item) => `- ${item.itemText} — ${item.reason}`).join("\n")
    );
  }
  return sections.join("\n\n");
}

/**
 * True when every open item is held only by missing test evidence (or is
 * review-verified and held only by it), so the real recovery is an editing
 * round that runs the named tests.
 */
export function onlyMissingTestEvidenceV1(items: readonly ClassifiedOpenPlanItemV1[]): boolean {
  return (
    items.length > 0 &&
    items.every(
      (item) =>
        item.testDependent &&
        (item.category === "awaiting-test-report" || item.category === "verified-by-review-no-report")
    )
  );
}
