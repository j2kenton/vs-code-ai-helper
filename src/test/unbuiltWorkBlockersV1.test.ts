/**
 * RC7 item 3: a task-fixable blocker that only says plan work is not built
 * yet is answered by building it, not by another review-driven round. Covers
 * the plan-reference resolver, the unbuilt-work test, and the running-
 * Implementation card's `recommendLetItRun`.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveBlockerPlanReferencesV1 } from "../utils/implementationChecklist";
import { findPlanStageNarrowingBlockerV1 } from "../utils/planItemNarrowingV1";
import {
  decidePostReviewActionV1,
  isUnbuiltWorkBlockerV1,
  runningImplementationRecommendedOptionV1,
  taskFixableAreAllUnbuiltWorkV1,
} from "../utils/reviewRouting";
import type { ReviewBlocker } from "../utils/reviewReadiness";
import type { ReviewScoreHistoryEntry } from "../types/taskProgress";

const PLAN = [
  "<!-- ensemble:implementation-checklist -->",
  "## Part A: handlers",
  "- [ ] Step 1: add the A handler",
  "## Part B: reader",
  "- [x] Step 4: fix the stage reader",
  "- [ ] Step 13: investigate the previous HEAD cause-first",
  "## Part C: helpers",
  "- [x] Step 15: add the helper test",
  "  - [ ] nested child of the helper test",
  "## Part D: delivery",
  "- [ ] Step 11: deliver the D work",
  "## Part E: extras",
  "- [ ] Step 20: deliver the E work",
  "## Part F: finish",
  "- [ ] Step 21: deliver the F work",
  "",
].join("\n");

const DUPLICATE_PLAN = [
  "<!-- ensemble:implementation-checklist -->",
  "- [ ] Add the handler for alpha inputs",
  "- [ ] Add the handler for beta inputs",
  "",
].join("\n");

const RC7_STEP_13 =
  "Step 13's previous-HEAD, cause-first investigation and specified targeted Parts A, B, D, E and F tests " +
  "remain incomplete; the failed-settlement test is still open. The Step 15 helper test is now present.";

void describe("resolveBlockerPlanReferencesV1", () => {
  void it("resolves backticked item text, Step N and Part X with open and settled counts", () => {
    const refs = resolveBlockerPlanReferencesV1(
      "`Step 4: fix the stage reader` is done, Step 13 and Part A are not",
      PLAN
    );
    const kinds = refs.map((r) => `${r.kind}:${r.reference}:${r.open}/${r.settled}`);
    assert.ok(kinds.includes("item:Step 4: fix the stage reader:0/1"));
    assert.ok(kinds.includes("step:Step 13:1/0"));
    assert.ok(kinds.includes("part:Part A:1/0"));
  });

  void it("resolves Part lists", () => {
    const parts = (text: string): string[] =>
      resolveBlockerPlanReferencesV1(text, PLAN)
        .filter((r) => r.kind === "part")
        .map((r) => r.reference);
    assert.deepEqual(parts("Parts A, B and D remain incomplete"), ["Part A", "Part B", "Part D"]);
    assert.deepEqual(parts("Part A, B, D and F remain incomplete"), ["Part A", "Part B", "Part D", "Part F"]);
  });

  void it("drops references that match nothing and spans that match several items", () => {
    assert.deepEqual(resolveBlockerPlanReferencesV1("Step 99 and Part Z are open", PLAN), []);
    assert.deepEqual(resolveBlockerPlanReferencesV1("`Add the handler for` is open", DUPLICATE_PLAN), []);
  });

  void it("never counts an open nested child as an open Part", () => {
    const refs = resolveBlockerPlanReferencesV1("Part C remains incomplete", PLAN);
    assert.equal(refs.length, 1);
    assert.equal(refs[0]?.open, 0);
    assert.equal(refs[0]?.settled, 1);
  });
});

void describe("isUnbuiltWorkBlockerV1", () => {
  void it("is true for the RC7 Step 13 wording, including a hyphenated failed-settlement and a done sentence", () => {
    assert.equal(isUnbuiltWorkBlockerV1(RC7_STEP_13, PLAN), true);
    assert.equal(
      isUnbuiltWorkBlockerV1(
        "Step 13's previous-HEAD, cause-first investigation and specified targeted Parts A, B, D, E and F tests remain incomplete;",
        PLAN
      ),
      true
    );
  });

  for (const description of [
    "Part A's handler is missing empty-list handling",
    "Part A's empty-list handling is not yet implemented",
    "Part A's handler throws on an empty list",
    "Step 4's fix is not yet implemented for the empty case",
    "Step 4 returns the old stage",
    "Part A tests remain incomplete. Step 4's fix is wrong.",
    "Step 13 and the Part C tests remain incomplete",
    "The docs are stale",
    "Step 13 remains incomplete. Step 99 remains incomplete.",
    "Step 13 remains incomplete. The remaining work is still open.",
  ]) {
    void it(`is false for: ${description}`, () => {
      assert.equal(isUnbuiltWorkBlockerV1(description, PLAN), false);
    });
  }
});

function blocker(overrides: Partial<ReviewBlocker>): ReviewBlocker {
  return {
    category: "completion",
    resolver: "task-fixable",
    description: RC7_STEP_13,
    origin: "reviewer",
    ...overrides,
  };
}

void describe("taskFixableAreAllUnbuiltWorkV1", () => {
  void it("is true for an unbuilt-work completion blocker, with or without a mechanical one", () => {
    assert.equal(taskFixableAreAllUnbuiltWorkV1([blocker({})], PLAN), true);
    assert.equal(
      taskFixableAreAllUnbuiltWorkV1(
        [blocker({}), blocker({ origin: "mechanical", description: "lint failed" })],
        PLAN
      ),
      true
    );
  });

  void it("is false for an architectural blocker, a defect, mechanical-only blockers or no plan text", () => {
    assert.equal(taskFixableAreAllUnbuiltWorkV1([blocker({ category: "architectural" })], PLAN), false);
    assert.equal(
      taskFixableAreAllUnbuiltWorkV1([blocker({ description: "Step 4's fix is not yet implemented" })], PLAN),
      false
    );
    assert.equal(
      taskFixableAreAllUnbuiltWorkV1([blocker({ origin: "mechanical", description: "lint failed" })], PLAN),
      false
    );
    assert.equal(taskFixableAreAllUnbuiltWorkV1([blocker({})], undefined), false);
  });
});

function historyWith(
  descriptions: { description: string; category?: string; origin?: "reviewer" | "mechanical" }[]
): ReviewScoreHistoryEntry[] {
  const entry: ReviewScoreHistoryEntry = {
    stage: "impl-high-review",
    score: 5,
    attemptId: "a1",
    at: "2026-10-02T10:00:00.000Z",
    blockerCount: descriptions.length,
    taskFixableCount: descriptions.length,
    blockers: descriptions.map((d, i) => ({
      category: d.category ?? "completion",
      resolver: "task-fixable",
      subject: `s${i}`,
      description: d.description,
      origin: d.origin ?? "reviewer",
    })),
  };
  return [entry];
}

void describe("decidePostReviewActionV1 recommendLetItRun (RC7 item 3)", () => {
  const stages = ["impl-high-review", "impl-low-review"] as const;

  void it("is true with open items and only unbuilt-work blockers", () => {
    const decision = decidePostReviewActionV1({
      history: historyWith([{ description: RC7_STEP_13 }, { description: "lint failed", origin: "mechanical" }]),
      stages,
      hasUntickedChecklistItems: true,
      planOfRecord: PLAN,
    });
    assert.equal(decision.action, "both");
    assert.equal(decision.recommendLetItRun, true);
  });

  void it("is false for a defect, an architectural blocker, a ticked step or mechanical-only blockers", () => {
    for (const blockers of [
      [{ description: RC7_STEP_13 }, { description: "Part A's handler throws on an empty list" }],
      [{ description: RC7_STEP_13, category: "architectural" }],
      [{ description: "Step 4's fix is not yet implemented" }],
      [{ description: "lint failed", origin: "mechanical" as const }],
    ]) {
      const decision = decidePostReviewActionV1({
        history: historyWith(blockers),
        stages,
        hasUntickedChecklistItems: true,
        planOfRecord: PLAN,
      });
      assert.equal(decision.recommendLetItRun, false);
    }
  });

  void it("is false with no open items, even when the plan text and blockers would qualify", () => {
    const decision = decidePostReviewActionV1({
      history: historyWith([{ description: RC7_STEP_13 }]),
      stages,
      hasUntickedChecklistItems: false,
      planOfRecord: PLAN,
    });
    assert.equal(decision.action, "apply-review");
    assert.equal(decision.recommendLetItRun, false);
  });
});

void describe("running-Implementation card recommended option (RC7 item 3)", () => {
  const stages = ["impl-high-review", "impl-low-review"] as const;
  const optionFor = (
    blockers: { description: string; category?: string; origin?: "reviewer" | "mechanical" }[],
    open: boolean
  ) =>
    runningImplementationRecommendedOptionV1(
      decidePostReviewActionV1({
        history: historyWith(blockers),
        stages,
        hasUntickedChecklistItems: open,
        planOfRecord: PLAN,
      })
    );

  void it("recommends keeping Implementation for unbuilt work plus a mechanical blocker", () => {
    assert.equal(
      optionFor([{ description: RC7_STEP_13 }, { description: "lint failed", origin: "mechanical" }], true),
      "letItRun"
    );
  });

  void it("recommends Review & Apply for a landed defect, no open items, or non-completion blockers", () => {
    assert.equal(
      optionFor(
        [
          { description: RC7_STEP_13 },
          { description: "New test file src/test/x.test.ts:126 breaks lint" },
          { description: "lint failed", origin: "mechanical" },
        ],
        true
      ),
      "goToReviewAndApply"
    );
    assert.equal(optionFor([{ description: RC7_STEP_13 }], false), "goToReviewAndApply");
    assert.equal(
      optionFor([{ description: "Part A's handler is missing empty-list handling" }], true),
      "goToReviewAndApply"
    );
    assert.equal(
      optionFor([{ description: "Step 4's fix is not yet implemented for the empty case" }], true),
      "goToReviewAndApply"
    );
    assert.equal(optionFor([{ description: RC7_STEP_13, category: "architectural" }], true), "goToReviewAndApply");
    assert.equal(optionFor([{ description: "lint failed", origin: "mechanical" }], true), "goToReviewAndApply");
  });
});

void describe("findPlanStageNarrowingBlockerV1 on numbered plan.md steps", () => {
  const PLAN_MD = [
    "## Part D",
    "10. Wire the other thing",
    "11. **Skip the Publish review** after a successful fix",
    "    - nested child that mentions Step 11",
    "",
  ].join("\n");

  void it("locates a numbered step from a 'Step N' blocker and ignores nested bullets", () => {
    const found = findPlanStageNarrowingBlockerV1(
      [{ description: "Narrowing needs an owner decision: Part D Step 11 skips the review" }],
      PLAN_MD,
      "Step 11 skips the review.",
      "plan-high-review.md"
    );
    assert.equal(found?.itemText, "**Skip the Publish review** after a successful fix");
  });
});

const RC6_STILL_OPEN =
  "Still open: Step 13's previous-HEAD, cause-first investigation (fallback applied first); " +
  "the promotion-guard failed-settlement test; and the targeted Part A, B, D and F scenario tests. " +
  "The Step 15 helper test is now present.";

void describe("RC6 verbatim shapes (RC7 item 3)", () => {
  const stages = ["impl-high-review", "impl-low-review"] as const;

  void it("RC6's verbatim 'Still open: …' blocker is unbuilt work", () => {
    assert.equal(isUnbuiltWorkBlockerV1(RC6_STILL_OPEN, PLAN), true);
  });

  void it("with open items, 'Still open' plus a mechanical blocker recommends letting Implementation run", () => {
    const decision = decidePostReviewActionV1({
      history: historyWith([{ description: RC6_STILL_OPEN }, { description: "lint failed", origin: "mechanical" }]),
      stages,
      hasUntickedChecklistItems: true,
      planOfRecord: PLAN,
    });
    assert.equal(decision.recommendLetItRun, true);
  });

  void it("RC6's three-blocker shape, with a landed lint defect, keeps Go to Review & Apply", () => {
    const decision = decidePostReviewActionV1({
      history: historyWith([
        { description: RC6_STILL_OPEN },
        { description: "New test file src/test/rc6PublishFixNoteV1.test.ts:126 breaks lint under the repo rules." },
        { description: "lint failed", origin: "mechanical" },
      ]),
      stages,
      hasUntickedChecklistItems: true,
      planOfRecord: PLAN,
    });
    assert.equal(decision.recommendLetItRun, false);
  });
});
