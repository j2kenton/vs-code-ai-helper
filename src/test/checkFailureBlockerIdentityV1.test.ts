import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  failingCheckCommandOfBlockerV1,
  isMarkedDuplicateBlockerV1,
  mergeCheckFailureBlockersV1,
} from "../utils/checkFailureBlockerIdentityV1";
import { splitTaskFixableBlockersByOriginV1, type ReviewBlocker } from "../utils/reviewReadiness";

const reviewer = (description: string): ReviewBlocker => ({
  category: "completion",
  resolver: "task-fixable",
  description,
  origin: "reviewer",
});
const mechanical = (description: string): ReviewBlocker => ({ ...reviewer(description), origin: "mechanical" });

// The 2026-11-07 17:43 review: one lint failure recorded three times.
const LINT_BLOCKERS: ReviewBlocker[] = [
  reviewer("Root lint still fails with three source errors, run with `pnpm run lint` (exit 1): reviewActions.ts:9700 …"),
  reviewer("The mechanically recorded `pnpm run lint` failure remains unresolved; it duplicates the same three-error source failure above."),
  reviewer("The additional mechanically recorded `pnpm run lint` exit 1 remains unresolved; it duplicates the same three-error source failure above."),
  mechanical("`pnpm run lint` failed (exit 1) — generated mechanically from Verified Checks"),
  reviewer("Steps 26–29 remain partial; Step 30's waiting row is unbuilt."),
];

void describe("one failing check is one blocker (review2 Step 42)", () => {
  void it("names the command of a failing check only when the text says it failed", () => {
    assert.equal(failingCheckCommandOfBlockerV1("`pnpm run lint` failed (exit 1)"), "pnpm run lint");
    assert.equal(failingCheckCommandOfBlockerV1("Run `pnpm run lint` before moving on."), undefined);
    assert.equal(failingCheckCommandOfBlockerV1("Steps 26–29 remain partial."), undefined);
  });

  void it("recognises a blocker the reviewer marks as a duplicate", () => {
    assert.equal(isMarkedDuplicateBlockerV1("it duplicates the same three-error source failure above."), true);
    assert.equal(isMarkedDuplicateBlockerV1("Root lint still fails with three source errors."), false);
  });

  void it("the 17:43 replay: the lint failure is one blocker and the other work stays", () => {
    const merged = mergeCheckFailureBlockersV1(LINT_BLOCKERS);
    assert.equal(merged.length, 2);
    assert.match(merged[0]!.description, /Root lint still fails/);
    assert.match(merged[1]!.description, /Steps 26–29/);
    // Ensemble's own record merged in, so the survivor says the check really failed.
    assert.equal(merged[0]!.origin, "mechanical");
    const split = splitTaskFixableBlockersByOriginV1(merged);
    assert.deepEqual(split, { reviewerBlockers: 1, mechanicalBlockers: 1 });
  });

  void it("keeps the first blocker's lineage id", () => {
    const first: ReviewBlocker = { ...LINT_BLOCKERS[0]!, lineage: { kind: "same", id: "ad4e404a-1" } as never };
    const merged = mergeCheckFailureBlockersV1([first, LINT_BLOCKERS[3]!]);
    assert.equal(merged.length, 1);
    assert.deepEqual(merged[0]!.lineage, first.lineage);
  });

  void it("different commands stay separate blockers", () => {
    const merged = mergeCheckFailureBlockersV1([
      reviewer("`pnpm run lint` failed (exit 1)"),
      reviewer("`pnpm run check-types` failed (exit 2)"),
    ]);
    assert.equal(merged.length, 2);
  });

  void it("a lone marked duplicate is kept when nothing else holds that failure", () => {
    const lone = reviewer("`pnpm run lint` failed; it duplicates the same failure above.");
    assert.equal(mergeCheckFailureBlockersV1([lone]).length, 1);
  });

  void it("blockers that name no check pass through untouched", () => {
    const plain = [reviewer("Step 5 is unbuilt."), reviewer("Step 6 is unbuilt.")];
    assert.deepEqual(mergeCheckFailureBlockersV1(plain), plain);
  });
});
