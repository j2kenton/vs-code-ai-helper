/**
 * bugs5 Step 19 (item 8): a plateau card's "Keep iterating: resume Fast Forward" answered long after the run
 * paused, across a window restart, resumes Fast Forward from the card's captured run details when the task's own
 * records show nothing has started since. A card that cannot be trusted still says why.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

import {
  buildFastForwardResumeDispatchV1,
  decideDurableFastForwardResumeV1,
  describeKeepIteratingStandInEndedNoteV1,
  type DurableFastForwardResumeFactsV1,
  type FastForwardResumeStateV1,
} from "../commands/fastForwardResumeSuffixV1";
import { computeFastForwardResumeBudgetV1 } from "../commands/reviewActions";
import { reviewPredatesRoundNeedsFreshReviewV1 } from "../utils/plateauFixCycleV1";
import {
  clearPendingEndedLineNoteV1,
  OperationEndedLineTrackerV1,
  setPendingEndedLineNoteV1,
} from "../utils/operationEndedLineV1";
import { __resetFastForwardRunsForTestV1, stampFastForwardResumeProvenanceV1 } from "../utils/activeFastForwardRunsV1";

const MIN = 60 * 1000;

function capturedAt(ms: number): FastForwardResumeStateV1 {
  return {
    attemptNumber: 24,
    maxAttempts: 30,
    fastForwardSessionIdV1: "session-before-restart",
    fastForwardRunEpochV1: 3,
    fastForwardCapturedAtMsV1: ms,
    fastForwardStageV1: "impl-high-review",
  };
}

function facts(overrides: Partial<DurableFastForwardResumeFactsV1> = {}): DurableFastForwardResumeFactsV1 {
  return {
    currentSessionId: "session-after-restart",
    status: "paused",
    currentStage: "impl-high-review",
    hasLiveOperation: false,
    latestRoundStartedAtMs: undefined,
    ...overrides,
  };
}

void describe("bugs5 Step 19: Keep iterating resumes Fast Forward after the run paused", () => {
  const raised = Date.parse("2026-11-01T07:28:36Z");
  const answered = raised + 40 * MIN;

  void it("a plateau card at iteration 24 of 30 answered 40 minutes later, after a restart, is trusted", () => {
    const decision = decideDurableFastForwardResumeV1(
      capturedAt(raised),
      facts({ latestRoundStartedAtMs: raised - 5 * MIN })
    );
    assert.equal(decision.trusted, true);
    void answered;
  });

  void it("is not trusted when a round started after the card was raised", () => {
    const decision = decideDurableFastForwardResumeV1(capturedAt(raised), facts({ latestRoundStartedAtMs: raised + MIN }));
    assert.equal(decision.trusted, false);
    assert.match(decision.trusted === false ? decision.reason : "", /round started after/);
  });

  void it("is not trusted while something is running, or once the task is no longer paused", () => {
    assert.equal(decideDurableFastForwardResumeV1(capturedAt(raised), facts({ hasLiveOperation: true })).trusted, false);
    assert.equal(decideDurableFastForwardResumeV1(capturedAt(raised), facts({ status: "active" })).trusted, false);
  });

  void it("is not trusted after the task moved to another stage", () => {
    const decision = decideDurableFastForwardResumeV1(capturedAt(raised), facts({ currentStage: "publish" }));
    assert.equal(decision.trusted, false);
  });

  void it("in the same window session the in-memory record decides: a run that ended another way is not revived", () => {
    const decision = decideDurableFastForwardResumeV1(
      capturedAt(raised),
      facts({ currentSessionId: "session-before-restart" })
    );
    assert.equal(decision.trusted, false);
  });

  void it("a card with no capture time (older than this fix) is not trusted", () => {
    const { fastForwardCapturedAtMsV1: _omit, ...older } = capturedAt(raised);
    void _omit;
    assert.equal(decideDurableFastForwardResumeV1(older, facts()).trusted, false);
  });

  void it("the provenance stamp records the capture time and the stage", () => {
    __resetFastForwardRunsForTestV1();
    const before = Date.now();
    const stamp = stampFastForwardResumeProvenanceV1("/tmp/task", "impl-high-review");
    assert.ok(stamp.fastForwardCapturedAtMsV1 >= before);
    assert.equal(stamp.fastForwardStageV1, "impl-high-review");
  });
});

void describe("bugs5 Step 19: wiring in resumeAndApplyCurrentStageActionV1", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "src", "commands", "resumeTask.ts"), "utf8");
  const fn = source.slice(source.indexOf("export async function resumeAndApplyCurrentStageActionV1"));

  void it("falls back to the durable check before running one cycle", () => {
    assert.ok(fn.indexOf("decideDurableFastForwardResumeV1(") > 0);
    assert.ok(fn.indexOf("decideDurableFastForwardResumeV1(") < fn.indexOf("if (resumeFastForward) {"));
  });

  void it("a one-cycle run that stood in for Keep iterating says why and offers Fast Forward Review", () => {
    assert.match(fn, /Fast Forward did not continue/);
    assert.match(fn, /vs-code-ai-helper\.fastForwardReviewWithAI/);
  });

  void it("sets the Ended-line note before the one-cycle dispatch and clears it afterwards", () => {
    assert.ok(fn.indexOf("setPendingEndedLineNoteV1(") > 0);
    assert.ok(fn.indexOf("setPendingEndedLineNoteV1(") < fn.indexOf("resumeThenDispatchV1(", fn.indexOf("standInTaskKey")));
    assert.ok(fn.indexOf("clearPendingEndedLineNoteV1(") > fn.indexOf("setPendingEndedLineNoteV1("));
  });

  void it("the trusted path dispatches through buildFastForwardResumeDispatchV1", () => {
    assert.ok(fn.indexOf("buildFastForwardResumeDispatchV1(") > 0);
  });
});

void describe("bugs5 Step 19: the trusted answer starts Fast Forward at the card's iteration", () => {
  const raised = Date.parse("2026-11-01T07:28:36Z");

  void it("a plateau card at iteration 24 of 30 answered after a restart dispatches Fast Forward with 6 attempts left", () => {
    const state = capturedAt(raised);
    assert.equal(
      decideDurableFastForwardResumeV1(state, facts({ latestRoundStartedAtMs: raised - MIN })).trusted,
      true
    );
    const dispatch = buildFastForwardResumeDispatchV1("/tmp/task", state, "token-1");
    assert.equal(dispatch.command, "vs-code-ai-helper.fastForwardReviewWithAI");
    assert.equal(dispatch.arg.taskFolderPath, "/tmp/task");
    assert.equal(dispatch.arg.admissionHandoffTokenV1, "token-1");
    const resume = dispatch.arg.resumeFromAttemptV1 as { attemptNumber: number; maxAttempts: number };
    assert.deepEqual(
      computeFastForwardResumeBudgetV1({ attemptNumber: resume.attemptNumber, maxAttempts: resume.maxAttempts }, () => 30),
      { maxAttempts: 30, improveReviewScoreMaxAttempts: 6, remainingBudgetExhausted: false }
    );
  });

  void it("the resumed run starts from Apply Review when the tree is unchanged since the review", () => {
    // In reviewActions.ts:10846, resumeFromAttempt !== undefined and treeProvablyUnchanged preserves
    // the existing review content so Fast Forward skips the initial review and starts at Apply Review.
    const needsFresh = reviewPredatesRoundNeedsFreshReviewV1({
      predatesLatestRound: true,
      resumedRun: true,
      treeProvablyUnchanged: true,
    });
    assert.equal(needsFresh, false, "a resumed run on an unchanged tree must not discard the review, so it starts from Apply Review");
  });
});

void describe("bugs5 Step 19: the Ended line of a one-cycle stand-in says why Fast Forward did not continue", () => {
  const TASK = "/tmp/task-ended-note";

  void it("the outermost operation's Ended line carries the note once", () => {
    const note = describeKeepIteratingStandInEndedNoteV1("the run has since ended");
    setPendingEndedLineNoteV1(TASK, note);
    const tracker = new OperationEndedLineTrackerV1(TASK);
    tracker.register({ id: "root", label: "Apply Review" });
    tracker.register({ id: "child", label: "Re-running review", parentId: "root" });
    assert.equal(
      tracker.ended({ id: "child", label: "Re-running review", parentId: "root", state: "succeeded" }),
      "Ended Re-running review — succeeded."
    );
    const line = tracker.ended({ id: "root", label: "Apply Review", state: "succeeded" });
    assert.match(line ?? "", /^Ended Apply Review — succeeded: one cycle finished/);
    assert.match(line ?? "", /Fast Forward did not continue — the run has since ended/);
    assert.match(line ?? "", /choose Fast Forward Review to keep iterating\.$/);
    const next = new OperationEndedLineTrackerV1(TASK);
    next.register({ id: "later", label: "Apply Review" });
    assert.equal(next.ended({ id: "later", label: "Apply Review", state: "succeeded" }), "Ended Apply Review — succeeded.");
  });

  void it("an earlier Resume Task operation does not consume the note; the stand-in stage action carries it", () => {
    const note = describeKeepIteratingStandInEndedNoteV1("the run has since ended");
    setPendingEndedLineNoteV1(TASK, note);
    const tracker = new OperationEndedLineTrackerV1(TASK);
    tracker.register({ id: "resume-1", label: "Resume Task" });
    const resumeLine = tracker.ended({ id: "resume-1", label: "Resume Task", state: "succeeded" });
    assert.equal(resumeLine, "Ended Resume Task — succeeded.");
    tracker.register({ id: "root-standin", label: "Apply Review" });
    const applyLine = tracker.ended({ id: "root-standin", label: "Apply Review", state: "succeeded" });
    assert.match(applyLine ?? "", /^Ended Apply Review — succeeded: one cycle finished/);
    assert.match(applyLine ?? "", /Fast Forward did not continue — the run has since ended/);
    assert.match(applyLine ?? "", /choose Fast Forward Review to keep iterating\.$/);
  });

  void it("a failed operation keeps its own reason", () => {
    setPendingEndedLineNoteV1(TASK, "note");
    const tracker = new OperationEndedLineTrackerV1(TASK);
    tracker.register({ id: "root2", label: "Apply Review" });
    assert.equal(
      tracker.ended({ id: "root2", label: "Apply Review", state: "failed", endReasonV1: "provider error" }),
      "Ended Apply Review — failed: provider error."
    );
    clearPendingEndedLineNoteV1(TASK);
  });
});
