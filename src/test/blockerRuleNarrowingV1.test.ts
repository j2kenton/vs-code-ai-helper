/**
 * review2 Steps 33-34 (Part 7; bugs6 item 36): a blocker whose fixes keep closing one path and missing the next gets the
 * plateau card's "Settle it with a rule", and the answer is followed by exactly one Apply Review. The history is
 * shaped like review1's 18:02 → 19:11 lineage: reviewed, fixed, reviewed (narrowed), fixed, reviewed (same).
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ReviewScoreHistoryEntry, RoundLedgerEntryV1 } from "../types/taskProgress";
import { startReReviewAfterOwnerDecisionV1 } from "../commands/ownerPlanDecisionCommandV1";
import { detectNarrowedBlockerV1 } from "../utils/blockerRuleNarrowingV1";
import { buildEscalationDecisionV1 } from "../utils/reviewEscalation";

const STAGE = "impl-low-review" as const;

function review(at: string, lineage?: "new" | "same" | "narrowed"): ReviewScoreHistoryEntry {
  return {
    stage: STAGE,
    score: 7,
    attemptId: `a-${at}`,
    at,
    blockerCount: 1,
    taskFixableCount: 1,
    blockers: [
      {
        category: "defect",
        resolver: "task-fixable",
        subject: "plan item evidence keyed by text",
        id: "b1",
        description: "A plan item's evidence settles a same-worded item at another level.",
        ...(lineage === "same" ? { lineage: { kind: "same", refId: "b1" } } : {}),
        ...(lineage === "narrowed" ? { lineage: { kind: "narrowed", refId: "b1" } } : {}),
      },
    ],
  } as ReviewScoreHistoryEntry;
}

function applyReview(endedAt: string, filesChanged: readonly string[]): RoundLedgerEntryV1 {
  return {
    roundId: `r-${endedAt}`,
    attemptIds: [],
    stage: STAGE,
    mode: "apply-review",
    startedAt: endedAt,
    endedAt,
    state: "completed",
    outcome: { filesChanged },
  } as RoundLedgerEntryV1;
}

const REVIEW_1 = review("2026-11-05T18:02:00Z", "new");
const FIX_1 = applyReview("2026-11-05T18:30:00Z", ["src/a.ts"]);
const REVIEW_2 = review("2026-11-05T18:34:00Z", "narrowed");
const FIX_2 = applyReview("2026-11-05T19:06:00Z", ["src/a.ts", "src/b.ts"]);
const REVIEW_3 = review("2026-11-05T19:11:00Z", "same");

void describe("a blocker that two fixes have each closed part of (review2 Step 33)", () => {
  void it("is spotted after two file-changing Apply Reviews, and not after one", () => {
    const afterTwo = detectNarrowedBlockerV1({ stage: STAGE, history: [REVIEW_1, REVIEW_2, REVIEW_3], ledger: [FIX_1, FIX_2] });
    assert.equal(afterTwo?.blockerId, "b1");
    assert.equal(afterTwo?.fixes, 2);
    const afterOne = detectNarrowedBlockerV1({ stage: STAGE, history: [REVIEW_1, REVIEW_2], ledger: [FIX_1] });
    assert.equal(afterOne, undefined);
  });

  void it("counts Apply Reviews, never reviews alone: a second review with no fix between does not add one", () => {
    const noSecondFix = detectNarrowedBlockerV1({ stage: STAGE, history: [REVIEW_1, REVIEW_2, REVIEW_3], ledger: [FIX_1] });
    assert.equal(noSecondFix, undefined);
  });

  void it("does not count an Apply Review that changed no files", () => {
    const empty = applyReview("2026-11-05T19:06:00Z", []);
    assert.equal(detectNarrowedBlockerV1({ stage: STAGE, history: [REVIEW_1, REVIEW_2, REVIEW_3], ledger: [FIX_1, empty] }), undefined);
  });

  void it("needs the blocker to be declared the same lineage each time (a new blocker restarts the count)", () => {
    const fresh = review("2026-11-05T19:11:00Z", "new");
    assert.equal(detectNarrowedBlockerV1({ stage: STAGE, history: [REVIEW_1, REVIEW_2, fresh], ledger: [FIX_1, FIX_2] }), undefined);
  });
});

void describe("the plateau card offers 'Settle it with a rule' (review2 Steps 33 and 34)", () => {
  const BASE = {
    blockersCount: 1,
    primaryBlockerDescription: "A defect.",
    allBlockerDescriptions: ["A defect."],
    narrowedNote: "",
    progressNote: "",
    taskFixableCount: 1,
    hasSpecDefect: false,
    hasDeclinedBlocker: false,
    hasNonFixableBlocker: false,
    nextStageHasRun: false,
    clearingNote: "",
    dispatchModeEvidence: [],
    planItemsOpen: 0,
  };
  const TARGET = { canonicalId: "c", taskFolderPath: "/t" };
  const narrowed = { blockerId: "b1", description: "A plan item's evidence settles a same-worded item.", fixes: 2 };

  void it("offers the option with the blocker id, the own-words entry point and a single Apply Review follow-up", () => {
    const card = buildEscalationDecisionV1("plateau", STAGE, "plateau", TARGET, { ...BASE, narrowedBlockerRule: narrowed });
    const option = card.options.find((o) => o.optionId === "settleWithRule");
    assert.ok(option, "the option is offered");
    assert.equal(option.label, "Settle it with a rule");
    assert.match(option.consequence, /2 fixes have each closed part of/);
    assert.match(option.consequence, /exactly one Apply Review/);
    assert.equal(option.effect.kind, "command");
    if (option.effect.kind === "command") {
      assert.equal(option.effect.command, "vs-code-ai-helper.recordOwnerPlanDecisionV1");
      assert.deepEqual(option.effect.args, [
        {
          taskFolderPath: "/t",
          stage: STAGE,
          blockerId: "b1",
          optionId: "settleWithRule",
          optionLabel: "Settle it with a rule",
          ownWords: true,
          thenApplyReview: true,
          blockerText: narrowed.description,
        },
      ]);
    }
    assert.ok((card.evidence ?? []).some((e) => /the rule may be missing/.test(e.detail)));
  });

  void it("is absent when no blocker is narrowing", () => {
    const card = buildEscalationDecisionV1("plateau", STAGE, "plateau", TARGET, BASE);
    assert.equal(card.options.some((o) => o.optionId === "settleWithRule"), false);
  });
});

void describe("the rule answer is followed by exactly one Apply Review (review2 Step 34)", () => {
  const arg = {
    taskFolderPath: "/t",
    stage: STAGE,
    blockerId: "b1",
    optionId: "settleWithRule",
    optionLabel: "an ambiguous reviewer entry verifies nothing",
    ownWords: true as const,
    rejects: true,
    thenApplyReview: true as const,
  };

  void it("dispatches one Apply Review and no re-review", async () => {
    const calls: string[] = [];
    const started = await startReReviewAfterOwnerDecisionV1(arg, (command) => {
      calls.push(command);
      return Promise.resolve(true);
    });
    assert.equal(started.kind, "started");
    assert.deepEqual(calls, ["vs-code-ai-helper.resumeAndApplyCurrentStageAction"]);
  });

  void it("a plain own-words answer still re-runs the review, not an Apply Review", async () => {
    const calls: string[] = [];
    const { thenApplyReview: _unused, ...plain } = arg;
    void _unused;
    await startReReviewAfterOwnerDecisionV1(plain, (command) => {
      calls.push(command);
      return Promise.resolve(true);
    });
    assert.deepEqual(calls, ["vs-code-ai-helper.resumeAndRerunReview"]);
  });
});
