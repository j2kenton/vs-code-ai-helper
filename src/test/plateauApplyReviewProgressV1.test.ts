import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyReviewRoundsClosedNoneV1,
  describeApplyReviewNoProgressV1,
  isVerificationStallV1,
} from "../utils/applyReviewProgressV1";
import { buildEscalationDecisionV1, reviewNamesAllItemsBuiltV1 } from "../utils/reviewEscalation";
import type {
  PlanItemEvidenceV1,
  PlanItemOwnerDecisionV1,
  RoundLedgerEntryV1,
  RoundOutcomeEntryV1,
} from "../types/taskProgress";

const STAGE = "impl-high-review" as const;

function minute(n: number): string {
  return new Date(Date.UTC(2026, 9, 30, 16, n)).toISOString();
}

function applyReview(id: string, startMinute: number, stage: RoundLedgerEntryV1["stage"] = STAGE): RoundLedgerEntryV1 {
  return {
    roundId: id,
    attemptIds: [id],
    stage,
    mode: "apply-review",
    startedAt: minute(startMinute),
    endedAt: minute(startMinute + 3),
    state: "completed",
  };
}

function implOutcome(row: RoundLedgerEntryV1, originatingReviewStage: RoundLedgerEntryV1["stage"]): RoundOutcomeEntryV1 {
  return {
    stage: "impl",
    classification: "completed",
    at: row.endedAt ?? row.startedAt,
    attemptId: row.attemptIds[0]!,
    originatingReviewStage,
  } as unknown as RoundOutcomeEntryV1;
}

function verified(itemKey: string, atMinute: number): PlanItemEvidenceV1 {
  return {
    planRevision: "r1",
    itemKey,
    itemText: itemKey,
    claims: [],
    verifications: [{ at: minute(atMinute), evidence: "opened" }],
  };
}

void describe("applyReviewRoundsClosedNoneV1 (bugs4 item 18)", () => {
  void it("counts five consecutive Apply Reviews that settled nothing", () => {
    const ledger = [0, 10, 20, 30, 40].map((m, i) => applyReview(`r${i}`, m));
    assert.equal(applyReviewRoundsClosedNoneV1({ stage: STAGE, ledger }), 5);
  });

  void it("also reads Apply Reviews bookkept under the literal impl stage", () => {
    const ledger = [0, 10].map((m, i) => applyReview(`r${i}`, m, "impl"));
    const roundOutcomes = ledger.map((row) => implOutcome(row, STAGE));
    assert.equal(applyReviewRoundsClosedNoneV1({ stage: STAGE, ledger, roundOutcomes }), 2);
  });

  void it("does not mix literal-impl Apply Reviews from another review stage or with no origin", () => {
    const ledger: RoundLedgerEntryV1[] = [
      applyReview("low", 0, "impl"),
      applyReview("legacy", 10, "impl"),
      applyReview("high", 20, "impl"),
    ];
    const roundOutcomes = [implOutcome(ledger[0]!, "impl-low-review"), implOutcome(ledger[2]!, STAGE)];
    assert.equal(applyReviewRoundsClosedNoneV1({ stage: STAGE, ledger, roundOutcomes }), 1);
    assert.equal(applyReviewRoundsClosedNoneV1({ stage: "impl-low-review", ledger, roundOutcomes }), 1);
    assert.equal(applyReviewRoundsClosedNoneV1({ stage: STAGE, ledger }), 0);
  });

  void it("a bare model claim does not count as closing an item", () => {
    const ledger = [0, 10, 20].map((m, i) => applyReview(`r${i}`, m));
    const claimed: PlanItemEvidenceV1 = {
      planRevision: "r1",
      itemKey: "a",
      itemText: "a",
      claims: [{ source: "implementation", at: minute(12), roundId: "r1" }],
    };
    assert.equal(applyReviewRoundsClosedNoneV1({ stage: STAGE, ledger, planItemEvidence: [claimed] }), 3);
  });

  void it("stops counting at a round during which an item was verified", () => {
    const ledger = [0, 10, 20, 30].map((m, i) => applyReview(`r${i}`, m));
    const evidence = [verified("a", 12)];
    assert.equal(applyReviewRoundsClosedNoneV1({ stage: STAGE, ledger, planItemEvidence: evidence }), 2);
  });

  void it("an owner decision counts as a round closing an item", () => {
    const ledger = [0, 10].map((m, i) => applyReview(`r${i}`, m));
    const decision: PlanItemOwnerDecisionV1 = {
      planRevision: "r1",
      itemKey: "a",
      itemText: "a",
      source: "owner",
      at: minute(11),
      formId: "f1",
      decision: "tick",
    };
    assert.equal(applyReviewRoundsClosedNoneV1({ stage: STAGE, ledger, ownerDecisions: [decision] }), 0);
  });

  void it("ignores live rows, review rows and other stages", () => {
    const ledger: RoundLedgerEntryV1[] = [
      { ...applyReview("live", 0), state: "open" },
      { ...applyReview("review", 5), mode: "review" },
      applyReview("other", 10, "impl-low-review"),
    ];
    assert.equal(applyReviewRoundsClosedNoneV1({ stage: STAGE, ledger }), 0);
  });
});

void describe("isVerificationStallV1 and the progress sentence", () => {
  void it("is a verification stall only with provisional claims and flat rounds", () => {
    assert.equal(isVerificationStallV1({ provisional: 90, roundsClosedNone: 3 }), true);
    assert.equal(isVerificationStallV1({ provisional: 0, roundsClosedNone: 3 }), false);
    assert.equal(isVerificationStallV1({ provisional: 90, roundsClosedNone: 1 }), false);
  });

  void it("states N open items and the last K rounds", () => {
    assert.equal(
      describeApplyReviewNoProgressV1(132, 5),
      "132 open items; the last 5 Apply Review rounds closed none of them"
    );
  });
});

void describe("plateau card with a defect beside a mostly unbuilt plan (bugs4 item 18)", () => {
  const target = { canonicalId: "c", taskFolderPath: "/nonexistent-task-folder-for-plateau-test" };
  const base = {
    blockersCount: 3,
    primaryBlockerDescription: "Required implementation remains partial or unbuilt in Steps 6, 8-10",
    allBlockerDescriptions: ["unbuilt Steps", "fix-progress reporting defect", "Owner evidence needed: Cline receipt"],
    narrowedNote: "",
    progressNote: "20 of 152 plan steps verified.",
    taskFixableCount: 2,
    hasSpecDefect: false,
    hasDeclinedBlocker: false,
    hasNonFixableBlocker: true,
    nextStageHasRun: false,
    clearingNote: "",
    dispatchModeEvidence: [],
    planItemsOpen: 132,
    taskFixableIncludesUnbuiltWork: true,
    applyReviewRoundsClosedNone: 5,
    provisionalTicks: 90,
  };

  void it("recommends Build the 132 open plan items and names the evidence", () => {
    const card = buildEscalationDecisionV1("plateau", STAGE, "plateau", target, base);
    assert.equal(card.recommendation?.kind, "option");
    assert.equal(card.recommendation?.kind === "option" ? card.recommendation.optionId : "", "buildRemaining");
    const reasoning = card.recommendation?.kind === "option" ? card.recommendation.reasoning : "";
    assert.match(reasoning, /132 open items; the last 5 Apply Review rounds closed none of them/);
    const progress = card.evidence?.find((e) => e.label === "Progress");
    assert.ok(progress);
    assert.match(progress.detail, /132 open items/);
  });

  void it("labels a flat verified count with many unverified claims a verification stall", () => {
    const card = buildEscalationDecisionV1("plateau", STAGE, "plateau", target, base);
    const stall = card.evidence?.find((e) => e.label === "Kind of stall");
    assert.ok(stall);
    assert.match(stall.detail, /Verification stall: 90 ticked items have only a model claim/);
  });

  void it("an owner-evidence blocker never makes Apply Review the recommendation", () => {
    const card = buildEscalationDecisionV1("plateau", STAGE, "plateau", target, {
      ...base,
      taskFixableCount: 0,
      taskFixableIncludesUnbuiltWork: false,
      applyReviewRoundsClosedNone: 0,
    });
    const optionId = card.recommendation?.kind === "option" ? card.recommendation.optionId : "";
    assert.notEqual(optionId, "keepIterating");
  });

  void it("never recommends building when every open item is already built and only awaits verification (bugs4 item 53)", () => {
    const card = buildEscalationDecisionV1("plateau", STAGE, "plateau", target, {
      ...base,
      blockersCount: 1,
      allBlockerDescriptions: ["Owner evidence needed: devpass seed regeneration"],
      taskFixableCount: 0,
      taskFixableIncludesUnbuiltWork: false,
      hasNonFixableBlocker: true,
      planItemsOpen: 132,
      provisionalTicks: 132,
      reviewAffirmsOpenItemsBuilt: true,
      applyReviewRoundsClosedNone: 0,
    });
    const optionId = card.recommendation?.kind === "option" ? card.recommendation.optionId : "";
    assert.notEqual(optionId, "buildRemaining");
    assert.notEqual(optionId, "keepIterating");
    assert.equal(optionId, "advance");
    const reasoning = card.recommendation?.kind === "option" ? card.recommendation.reasoning : "";
    assert.match(reasoning, /already built and ticked, waiting only for verification/);
  });

  void it("bugs8 item 3: items that are all built but not yet checked never get a Build option, whatever the review says about them", () => {
    // Before bugs8 a model tick was only a claim, so Build was still offered for it. The stop card's own split ("N to
    // build, M built but not yet checked") now decides: nothing is left to build, so the evidence path is offered.
    const card = buildEscalationDecisionV1("plateau", STAGE, "plateau", target, {
      ...base,
      blockersCount: 1,
      allBlockerDescriptions: ["Owner evidence needed: devpass seed regeneration"],
      taskFixableCount: 0,
      taskFixableIncludesUnbuiltWork: false,
      hasNonFixableBlocker: true,
      planItemsOpen: 132,
      provisionalTicks: 132,
      provisionalItemTexts: ["Step 1: first built item"],
      reviewAffirmsOpenItemsBuilt: false,
      applyReviewRoundsClosedNone: 0,
    });
    const optionId = card.recommendation?.kind === "option" ? card.recommendation.optionId : "";
    assert.notEqual(optionId, "buildRemaining");
    assert.ok(!card.options.some((option) => option.optionId === "buildRemaining"), "Build was offered with nothing left to build");
    assert.ok(card.options.some((option) => option.optionId === "checkBuiltItems"), "the evidence path was not offered");
  });

  void it("control: open items that are NOT all built still recommend building them", () => {
    const card = buildEscalationDecisionV1("plateau", STAGE, "plateau", target, {
      ...base,
      taskFixableCount: 0,
      taskFixableIncludesUnbuiltWork: false,
      planItemsOpen: 132,
      provisionalTicks: 90,
      applyReviewRoundsClosedNone: 0,
    });
    const optionId = card.recommendation?.kind === "option" ? card.recommendation.optionId : "";
    assert.equal(optionId, "buildRemaining");
  });

  void it("control: a landed-work defect with few open items still recommends Apply Review", () => {
    const card = buildEscalationDecisionV1("plateau", STAGE, "plateau", target, {
      ...base,
      blockersCount: 1,
      taskFixableCount: 1,
      hasNonFixableBlocker: false,
      planItemsOpen: 0,
      taskFixableIncludesUnbuiltWork: false,
      applyReviewRoundsClosedNone: 0,
      provisionalTicks: 0,
    });
    const optionId = card.recommendation?.kind === "option" ? card.recommendation.optionId : "";
    assert.equal(optionId, "keepIterating");
  });

  void it("control: Apply Reviews that did close items keep Apply Review recommended", () => {
    const card = buildEscalationDecisionV1("plateau", STAGE, "plateau", target, {
      ...base,
      applyReviewRoundsClosedNone: 0,
    });
    const optionId = card.recommendation?.kind === "option" ? card.recommendation.optionId : "";
    assert.equal(optionId, "keepIterating");
  });
});

void describe("reviewNamesAllItemsBuiltV1 (bugs4 item 53)", () => {
  const review = [
    "## Verified Complete",
    "<!-- verified-complete:start -->",
    "- Wire the emitter.",
    "  evidence: src/a.ts:10",
    "- Add the gate test.",
    "<!-- verified-complete:end -->",
  ].join("\n");

  void it("is true only when the review names every item", () => {
    assert.equal(reviewNamesAllItemsBuiltV1(review, ["Wire the emitter.", "Add the gate test."]), true);
  });

  void it("is false when one item is not named, when there are no items, or when there is no block", () => {
    assert.equal(reviewNamesAllItemsBuiltV1(review, ["Wire the emitter.", "Something unnamed."]), false);
    assert.equal(reviewNamesAllItemsBuiltV1(review, []), false);
    assert.equal(reviewNamesAllItemsBuiltV1("No block here.", ["Wire the emitter."]), false);
  });
});
