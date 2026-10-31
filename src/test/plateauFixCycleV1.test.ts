import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

import {
  fixRoundIdsSincePreviousReviewV1,
  historyAfterFixCyclesV1,
  KEEP_ITERATING_SEQUENCE_NOTE_V1,
  resumeReReviewNoticeV1,
  reviewPredatesRoundNeedsFreshReviewV1,
} from "../utils/plateauFixCycleV1";
import { buildEscalationDecisionV1 } from "../utils/reviewEscalation";
import { detectBlockerSetStall } from "../utils/reviewRouting";
import { clearEscalationRecordingPlateauOverrideV1 } from "../utils/taskProgressTransforms";
import type {
  ReviewScoreHistoryEntry,
  RoundLedgerEntryV1,
  RoundLedgerStateV1,
  TaskEscalation,
  TaskProgress,
} from "../types/taskProgress";

const STAGE = "impl-high-review" as const;
const SAME_BLOCKER = [{ category: "completion", resolver: "task-fixable", subject: "steps 4-9 unbuilt" }];

function minute(n: number): string {
  return new Date(Date.UTC(2026, 9, 26, 12, n)).toISOString();
}

function review(attempt: string, at: number): ReviewScoreHistoryEntry {
  return { stage: STAGE, score: 6, attemptId: attempt, at: minute(at), blockerCount: 1, taskFixableCount: 1, blockers: SAME_BLOCKER };
}

function fix(id: string, endMinute: number, state: RoundLedgerStateV1 = "completed"): RoundLedgerEntryV1 {
  return {
    roundId: id,
    attemptIds: [id],
    stage: STAGE,
    mode: "apply-review",
    startedAt: minute(endMinute - 1),
    endedAt: minute(endMinute),
    state,
  };
}

function reviewRow(id: string, endMinute: number): RoundLedgerEntryV1 {
  return { ...fix(id, endMinute), mode: "review" };
}

void describe("recorded fix-round ids (bugs3 Step 9)", () => {
  void it("lists the real fix rounds between the previous scored review and now, by id", () => {
    const history = [review("a", 10)];
    const ledger = [fix("fix-1", 15), reviewRow("rev-1", 16), fix("fix-2", 18), fix("late", 45)];
    assert.deepEqual(fixRoundIdsSincePreviousReviewV1(history, STAGE, ledger, minute(20)), ["fix-1", "fix-2"]);
  });

  void it("is empty when only reviews, scheduled or dropped rounds lie between", () => {
    const history = [review("a", 10)];
    const ledger = [reviewRow("rev-1", 15), fix("never-ran", 16, "dropped"), fix("waiting", 17, "scheduled")];
    assert.deepEqual(fixRoundIdsSincePreviousReviewV1(history, STAGE, ledger, minute(20)), []);
  });

  void it("is undefined for the stage's first scored review, whatever other stages hold", () => {
    const otherStage: ReviewScoreHistoryEntry = { ...review("x", 5), stage: "plan-high-review" };
    assert.equal(fixRoundIdsSincePreviousReviewV1([otherStage], STAGE, [fix("fix-1", 6)], minute(20)), undefined);
    assert.equal(fixRoundIdsSincePreviousReviewV1([], STAGE, undefined, minute(20)), undefined);
  });

  void it("the recorded ids decide separation even after the ledger is trimmed", () => {
    const history = [
      review("a", 10),
      { ...review("b", 20), fixRoundIds: ["fix-1"] },
      { ...review("c", 30), fixRoundIds: ["fix-2"] },
    ];
    // The ledger no longer holds either fix round; the recorded ids still say they ran.
    const out = historyAfterFixCyclesV1(history, STAGE, [], undefined);
    assert.deepEqual(out.map((entry) => entry.attemptId), ["a", "b", "c"]);
  });

  void it("an empty recorded list breaks the chain even when the ledger now shows a round in that window", () => {
    const history = [review("a", 10), { ...review("b", 20), fixRoundIds: [] }, { ...review("c", 30), fixRoundIds: ["fix-2"] }];
    const out = historyAfterFixCyclesV1(history, STAGE, [fix("late-arrival", 15)], undefined);
    assert.deepEqual(out.map((entry) => entry.attemptId), ["b", "c"]);
  });

  void it("entries without ids still read the ledger's timestamps", () => {
    const history = [review("a", 10), review("b", 20)];
    assert.deepEqual(historyAfterFixCyclesV1(history, STAGE, [fix("fix-1", 15)], undefined).map((e) => e.attemptId), ["a", "b"]);
    assert.deepEqual(historyAfterFixCyclesV1(history, STAGE, [], undefined).map((e) => e.attemptId), ["b"]);
  });

  void it("wiring: the review recorder stamps the ids on the entry it appends", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "..", "..", "src", "commands", "reviewActions.ts"), "utf8");
    const stamp = source.indexOf("fixRoundIdsSincePreviousReviewV1(\n");
    const append = source.indexOf("fixRoundIds !== undefined ? { ...historyEntry, fixRoundIds }", stamp);
    assert.ok(stamp > 0 && append > stamp, "the history entry must carry the recorded fix-round ids");
  });
});

void describe("historyAfterFixCyclesV1 (bugs3 Step 9)", () => {
  void it("cannot plateau when the ledger has no fix rounds at all", () => {
    const history = [review("a", 10), review("b", 20), review("c", 30), review("d", 40)];
    for (const ledger of [[reviewRow("r1", 10)], [], undefined]) {
      const out = historyAfterFixCyclesV1(history, STAGE, ledger, undefined);
      assert.deepEqual(out.map((entry) => entry.attemptId), ["d"]);
      assert.equal(detectBlockerSetStall(out, STAGE, 3), false);
    }
  });

  void it("applies the override baseline even when the ledger has no fix rounds", () => {
    const history = [review("a", 10), review("b", 20), review("c", 30), review("d", 40)];
    const override: TaskEscalation = { stage: STAGE, kind: "plateau", reason: "x", at: minute(25) };
    const out = historyAfterFixCyclesV1(history, STAGE, [], [override]);
    assert.deepEqual(out.map((entry) => entry.attemptId), ["d"]);
  });

  void it("does not manufacture a plateau from reviews with no fix round between them", () => {
    const history = [review("a", 10), review("b", 20), review("c", 30), review("d", 40)];
    const ledger = [fix("f0", 5), reviewRow("r1", 10), reviewRow("r2", 20), reviewRow("r3", 30), reviewRow("r4", 40)];
    assert.equal(detectBlockerSetStall(history, STAGE, 3), true, "control: the raw history reads as a stall");
    const chain = historyAfterFixCyclesV1(history, STAGE, ledger, undefined);
    assert.deepEqual(chain.map((entry) => entry.attemptId), ["d"]);
    assert.equal(detectBlockerSetStall(chain, STAGE, 3), false);
  });

  void it("counts a plateau when every review pair is separated by a completed fix round", () => {
    const history = [review("a", 10), review("b", 20), review("c", 30), review("d", 40)];
    const ledger = [fix("f1", 15), fix("f2", 25), fix("f3", 35)];
    const chain = historyAfterFixCyclesV1(history, STAGE, ledger, undefined);
    assert.equal(chain.length, 4);
    assert.equal(detectBlockerSetStall(chain, STAGE, 3), true);
  });

  void it("restarts the chain at the first review after a gap with no fix round", () => {
    const history = [review("a", 10), review("b", 20), review("c", 30), review("d", 40)];
    const ledger = [fix("f1", 15), fix("f3", 35)];
    const chain = historyAfterFixCyclesV1(history, STAGE, ledger, undefined);
    assert.deepEqual(chain.map((entry) => entry.attemptId), ["c", "d"]);
  });

  void it("counts a failed fix round only when it edited files", () => {
    const history = [review("a", 10), review("b", 20)];
    const idle = historyAfterFixCyclesV1(history, STAGE, [fix("f0", 5), fix("f1", 15, "failed")], undefined);
    assert.deepEqual(idle.map((entry) => entry.attemptId), ["b"]);
    const edited: RoundLedgerEntryV1 = { ...fix("f1", 15, "failed"), outcome: { filesChanged: ["src/a.ts"] } };
    const kept = historyAfterFixCyclesV1(history, STAGE, [edited], undefined);
    assert.deepEqual(kept.map((entry) => entry.attemptId), ["a", "b"]);
  });

  void it("starts a fresh baseline after an overridden plateau for the stage", () => {
    const history = [review("a", 10), review("b", 20), review("c", 30), review("d", 40), review("e", 60)];
    const ledger = [fix("f1", 15), fix("f2", 25), fix("f3", 35), fix("f4", 55)];
    const override: TaskEscalation = { stage: STAGE, kind: "plateau", reason: "x", at: minute(45) };
    const chain = historyAfterFixCyclesV1(history, STAGE, ledger, [override]);
    assert.deepEqual(chain.map((entry) => entry.attemptId), ["e"]);
    assert.equal(detectBlockerSetStall(chain, STAGE, 3), false);
  });

  void it("ignores overrides recorded for another stage or another kind", () => {
    const history = [review("a", 10), review("b", 20)];
    const ledger = [fix("f1", 15)];
    const overrides: TaskEscalation[] = [
      { stage: "plan-high-review", kind: "plateau", reason: "x", at: minute(50) },
      { stage: STAGE, kind: "environmental", reason: "x", at: minute(50) },
    ];
    assert.equal(historyAfterFixCyclesV1(history, STAGE, ledger, overrides).length, 2);
  });
});

void describe("new or narrowed blockers continue automatically (bugs3 Step 9)", () => {
  const A = { category: "completion", resolver: "task-fixable", subject: "steps 4-9 unbuilt" };
  const B = { category: "defect", resolver: "task-fixable", subject: "src/a.ts" };
  const C = { category: "defect", resolver: "task-fixable", subject: "src/b.ts" };
  const withBlockers = (attempt: string, at: number, blockers: typeof SAME_BLOCKER): ReviewScoreHistoryEntry => ({
    ...review(attempt, at),
    blockers,
    blockerCount: blockers.length,
    taskFixableCount: blockers.length,
  });
  const ledger = [fix("f1", 15), fix("f2", 25), fix("f3", 35)];

  void it("a narrowed set is not a plateau even with a fix round between every review", () => {
    const history = [
      withBlockers("a", 10, [A, B, C]),
      withBlockers("b", 20, [A, B, C]),
      withBlockers("c", 30, [A, B]),
      withBlockers("d", 40, [A, B]),
    ];
    const chain = historyAfterFixCyclesV1(history, STAGE, ledger, undefined);
    assert.equal(chain.length, 4);
    assert.equal(detectBlockerSetStall(chain, STAGE, 3), false);
  });

  void it("one blocker resolved and another newly raised is not a plateau", () => {
    const history = [
      withBlockers("a", 10, [A, B]),
      withBlockers("b", 20, [A, B]),
      withBlockers("c", 30, [A, C]),
      withBlockers("d", 40, [A, C]),
    ];
    const chain = historyAfterFixCyclesV1(history, STAGE, ledger, undefined);
    assert.equal(detectBlockerSetStall(chain, STAGE, 3), false);
  });

  void it("the same set across every fix cycle is still a plateau", () => {
    const history = [
      withBlockers("a", 10, [A, B]),
      withBlockers("b", 20, [A, B]),
      withBlockers("c", 30, [A, B]),
      withBlockers("d", 40, [A, B]),
    ];
    const chain = historyAfterFixCyclesV1(history, STAGE, ledger, undefined);
    assert.equal(detectBlockerSetStall(chain, STAGE, 3), true);
  });
});

void describe("reviewPredatesRoundNeedsFreshReviewV1 (bugs3 Step 9)", () => {
  void it("a resumed run keeps a review of the unchanged tree and starts with Apply Review", () => {
    assert.equal(
      reviewPredatesRoundNeedsFreshReviewV1({ predatesLatestRound: true, resumedRun: true, treeProvablyUnchanged: true }),
      false
    );
  });

  void it("re-reviews first when the tree changed or cannot be shown unchanged", () => {
    assert.equal(
      reviewPredatesRoundNeedsFreshReviewV1({ predatesLatestRound: true, resumedRun: true, treeProvablyUnchanged: false }),
      true
    );
  });

  void it("a run that was not resumed keeps the ledger test even on an unchanged tree", () => {
    assert.equal(
      reviewPredatesRoundNeedsFreshReviewV1({ predatesLatestRound: true, resumedRun: false, treeProvablyUnchanged: true }),
      true
    );
  });

  void it("adds nothing when the review does not predate a round", () => {
    assert.equal(
      reviewPredatesRoundNeedsFreshReviewV1({ predatesLatestRound: false, resumedRun: true, treeProvablyUnchanged: false }),
      false
    );
  });
});

void describe("clearEscalationRecordingPlateauOverrideV1 (bugs3 Step 9)", () => {
  const progress = (escalation?: TaskEscalation, overridden?: TaskEscalation[]): TaskProgress => ({
    taskFolder: "2026-10-26_task_1",
    currentStage: STAGE,
    createdAt: minute(0),
    updatedAt: minute(0),
    ...(escalation ? { escalation } : {}),
    ...(overridden ? { overriddenEscalations: overridden } : {}),
  });
  const plateau: TaskEscalation = { stage: STAGE, kind: "plateau", reason: "x", at: minute(45) };

  void it("records a resumed plateau, so the next review starts a fresh baseline", () => {
    const out = clearEscalationRecordingPlateauOverrideV1(progress(plateau));
    assert.equal(out.escalation, undefined);
    assert.deepEqual(out.overriddenEscalations, [plateau]);
    const history = [review("a", 10), review("b", 20), review("c", 30), review("d", 40), review("e", 50)];
    const ledger = [fix("f1", 15), fix("f2", 25), fix("f3", 35), fix("f4", 48)];
    const chain = historyAfterFixCyclesV1(history, STAGE, ledger, out.overriddenEscalations);
    assert.deepEqual(chain.map((entry) => entry.attemptId), ["e"]);
    assert.equal(detectBlockerSetStall(chain, STAGE, 3), false);
  });

  void it("records the same escalation once", () => {
    const out = clearEscalationRecordingPlateauOverrideV1(progress(plateau, [plateau]));
    assert.deepEqual(out.overriddenEscalations, [plateau]);
  });

  void it("does not record other kinds, and returns progress untouched without an escalation", () => {
    const env: TaskEscalation = { ...plateau, kind: "environmental" };
    assert.equal(clearEscalationRecordingPlateauOverrideV1(progress(env)).overriddenEscalations, undefined);
    const bare = progress();
    assert.equal(clearEscalationRecordingPlateauOverrideV1(bare), bare);
  });
});

void describe("Keep iterating states its first step (bugs3 Step 9)", () => {
  const context = {
    blockersCount: 2,
    primaryBlockerDescription: "Plan lacks a rollback step",
    allBlockerDescriptions: ["Plan lacks a rollback step", "Plan lacks an owner"],
    narrowedNote: "",
    progressNote: "",
    taskFixableCount: 2,
    hasSpecDefect: false,
    hasDeclinedBlocker: false,
    hasNonFixableBlocker: false,
    nextStageHasRun: false,
    clearingNote: "",
    dispatchModeEvidence: [],
    planItemsOpen: 0,
  };
  const target = { canonicalId: "c", taskFolderPath: "/nonexistent-task-folder-for-sequence-test" };

  void it("the plain option says it starts with Apply Review and reviews first only if inputs changed", () => {
    const card = buildEscalationDecisionV1("plateau", "impl-high-review", "plateau", target, context);
    const option = card.options.find((o) => o.optionId === "keepIterating");
    assert.ok(option);
    assert.ok(option.consequence.includes(KEEP_ITERATING_SEQUENCE_NOTE_V1));
    assert.match(option.consequence, /starts with Apply Review/);
    assert.match(option.consequence, /reviews first instead and says so/);
  });

  void it("a resumed run that must review first says why, by cause", () => {
    const changed = resumeReReviewNoticeV1("impl-high-review", false);
    assert.match(changed, /Reviewing High-Level Code Review again before applying fixes/);
    assert.match(changed, /workspace or the review's inputs changed/);
    const stale = resumeReReviewNoticeV1("impl-high-review", true);
    assert.match(stale, /out of date/);
    assert.doesNotMatch(stale, /workspace or the review's inputs changed/);
  });

  void it("a resumed run on a provably unchanged tree keeps its review, so it starts with Apply Review", () => {
    // The dispatch order: no fresh review is demanded when the review is of the current tree...
    assert.equal(
      reviewPredatesRoundNeedsFreshReviewV1({ predatesLatestRound: true, resumedRun: true, treeProvablyUnchanged: true }),
      false
    );
    // ...and one is demanded, with the notice above, when it is not.
    assert.equal(
      reviewPredatesRoundNeedsFreshReviewV1({ predatesLatestRound: true, resumedRun: true, treeProvablyUnchanged: false }),
      true
    );
  });
});
