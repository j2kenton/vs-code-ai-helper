/**
 * review1 Step 38 (owner, 2026-11-05; bugs6 item 19): the plateau card recommends "Accept this narrowing" only when
 * the narrowing's reason is checked. Replay of the 2026-11-04 23:27 UTC Step 59 plateau card: the only blocker is a
 * narrowing and the round left no reason on file.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import { findNarrowingBlockerV1, narrowingReasonIsCheckedV1 } from "../utils/planItemNarrowingV1";
import { buildEscalationDecisionV1 } from "../utils/reviewEscalation";

const ITEM = "Step 59: Let the review see every file, and say so when it can't.";
const BLOCKER = `Narrowing needs an owner decision: \`${ITEM}\` leaves the code guarantee out.`;

const BASE = {
  blockersCount: 1,
  primaryBlockerDescription: BLOCKER,
  allBlockerDescriptions: [BLOCKER],
  narrowedNote: "",
  progressNote: "",
  taskFixableCount: 0,
  hasSpecDefect: false,
  hasDeclinedBlocker: false,
  hasNonFixableBlocker: true,
  nextStageHasRun: false,
  clearingNote: "",
  dispatchModeEvidence: [],
  planItemsOpen: 0,
  allBlockersNeedOwnerDecision: true,
};
const TARGET = { canonicalId: "c", taskFolderPath: "/t" };

const UNCHECKED = {
  itemText: ITEM,
  blockerDescription: BLOCKER,
  reason: "The round left no reason on file.",
  reasonSource: "none" as const,
  evidence: "No evidence on file; the blocker text above is all the reviewer recorded.",
  evidenceSource: "none" as const,
};
const CHECKED = {
  itemText: ITEM,
  blockerDescription: BLOCKER,
  reason: "The cap only applies to the retry path.",
  reasonSource: "impl-summary.md" as const,
  evidence: "src/commands/reviewActions.ts:8463 checks the scaled budget",
  evidenceSource: "impl-summary.md" as const,
};

void describe("the plateau card's recommendation for a narrowing (Step 38)", () => {
  void it("a narrowing with no reason and no evidence does not recommend accepting it; it keeps the plan and keeps iterating", () => {
    const card = buildEscalationDecisionV1("plateau", "impl-high-review", "plateau", TARGET, { ...BASE, narrowing: UNCHECKED });
    assert.ok(card.recommendation.kind === "option", "a recommendation is made");
    assert.notEqual(card.recommendation.optionId, "acceptNarrowing", "an unbacked narrowing is never the recommended click");
    assert.equal(card.recommendation.optionId, "keepIterating");
    assert.match(card.recommendation.reasoning, /no reason or evidence on file/);
    assert.ok(card.options.some((o) => o.optionId === "acceptNarrowing"), "the owner can still accept it by choice");
    assert.ok(card.options.some((o) => o.optionId === "keepItemOpen"));
  });

  void it("a narrowing whose reason and evidence are on file still recommends accepting it", () => {
    const card = buildEscalationDecisionV1("plateau", "impl-high-review", "plateau", TARGET, { ...BASE, narrowing: CHECKED });
    assert.equal(card.recommendation.kind === "option" && card.recommendation.optionId, "acceptNarrowing");
  });

  void it("a narrowing the owner can settle is not described as outside automation's control", () => {
    const card = buildEscalationDecisionV1("plateau", "impl-high-review", "plateau", TARGET, { ...BASE, narrowing: UNCHECKED });
    assert.doesNotMatch(card.whyUserNeeded, /outside automation's control/);
    assert.match(card.whyUserNeeded, /narrowing only you can approve/);
    const other = buildEscalationDecisionV1("plateau", "impl-high-review", "plateau", TARGET, { ...BASE, allBlockersNeedOwnerDecision: false });
    assert.match(other.whyUserNeeded, /outside automation's control/, "other non-fixable blockers keep the old wording");
  });

  void it("only a reason with evidence counts as checked", () => {
    assert.equal(narrowingReasonIsCheckedV1(UNCHECKED), false);
    assert.equal(narrowingReasonIsCheckedV1(CHECKED), true);
    assert.equal(narrowingReasonIsCheckedV1({ reasonSource: "impl-summary.md", evidenceSource: "none" }), false);
  });
});

void describe("the narrowing extractor feeds the card only code-backed evidence (Step 38)", () => {
  const PLAN = `<!-- ensemble:implementation-checklist -->\n\n- [ ] ${ITEM}\n`;
  const extract = (summary: string) => {
    const found = findNarrowingBlockerV1([{ description: BLOCKER }], PLAN, undefined, summary);
    assert.ok(found, "the narrowing blocker is recognised");
    return { ...found, blockerDescription: found.blocker };
  };
  const recommended = (summary: string): string | undefined => {
    const card = buildEscalationDecisionV1("plateau", "impl-high-review", "plateau", TARGET, { ...BASE, narrowing: extract(summary) });
    return card.recommendation.kind === "option" ? card.recommendation.optionId : undefined;
  };

  void it("a summary paragraph that merely mentions the item is a reason, not evidence, so acceptance is not recommended", () => {
    const summary = `The code guarantee in \`${ITEM}\` was left out because it was hard.`;
    const narrowing = extract(summary);
    assert.equal(narrowing.reasonSource, "impl-summary.md");
    assert.equal(narrowing.evidenceSource, "none");
    assert.equal(narrowingReasonIsCheckedV1(narrowing), false);
    assert.equal(recommended(summary), "keepIterating");
  });

  void it("an echoed checklist line is neither a reason nor evidence", () => {
    const summary = `- [ ] ${ITEM} see src/utils/implReviewFileSelection.ts:97`;
    const narrowing = extract(summary);
    assert.equal(narrowing.reasonSource, "none");
    assert.equal(narrowing.evidenceSource, "none");
    assert.notEqual(recommended(summary), "acceptNarrowing");
  });

  void it("a path that only appears inside the item's own wording is not evidence the round added", () => {
    const itemWithPath = "Step 59: Delete `src/utils/implReviewFileSelection.ts` limits.";
    const blocker = `Narrowing needs an owner decision: \`${itemWithPath}\` is only partly done.`;
    const plan = `<!-- ensemble:implementation-checklist -->\n\n- [ ] ${itemWithPath}\n`;
    const found = findNarrowingBlockerV1([{ description: blocker }], plan, undefined, `We kept it. ${itemWithPath} is out of scope.`);
    assert.ok(found);
    assert.equal(found.evidenceSource, "none");
  });

  void it("a paragraph that names the code it relies on is checked evidence, and acceptance is recommended", () => {
    const summary = `The cap in \`${ITEM}\` only applies to the retry path: src/commands/reviewActions.ts:8463 checks the scaled budget.`;
    const narrowing = extract(summary);
    assert.equal(narrowing.evidenceSource, "impl-summary.md");
    assert.equal(narrowingReasonIsCheckedV1(narrowing), true);
    assert.equal(recommended(summary), "acceptNarrowing");
  });
});
