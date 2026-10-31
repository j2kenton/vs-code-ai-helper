/**
 * bugs3 Step 3 (first item): one "Ended" line per logical operation, reporting
 * the operation's own settled outcome.
 */
import * as assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { resetTerminalLinesV1 } from "../utils/terminalLineEmitterV1";
import {
  OperationEndedLineTrackerV1,
  recordOperationTerminalOutcomeV1,
  terminalOutcomeFromTaskActionOutcomeV1,
} from "../utils/operationEndedLineV1";
import type { TaskActionOutcomeV1 } from "../types/taskActionOutcomeV1";

void describe("OperationEndedLineTrackerV1 (bugs3 Step 3)", () => {
  // Operation ids are reused across cases; the shared emitter registry is process-wide.
  beforeEach(() => resetTerminalLinesV1());

  void it("keeps the existing wording for a plain success", () => {
    const tracker = new OperationEndedLineTrackerV1();
    tracker.register({ id: "a", label: "Publish Checks" });
    assert.equal(tracker.ended({ id: "a", label: "Publish Checks", state: "succeeded" }), "Ended Publish Checks — succeeded.");
  });

  void it("reports a failure with the reason its owner gave", () => {
    const tracker = new OperationEndedLineTrackerV1();
    tracker.register({ id: "a", label: "Apply Review" });
    assert.equal(
      tracker.ended({
        id: "a",
        label: "Apply Review",
        state: "failed",
        endReasonV1: "every model failed: opencode-go/glm-5.3@max — HTTP 429.",
      }),
      "Ended Apply Review — failed: every model failed: opencode-go/glm-5.3@max — HTTP 429."
    );
  });

  void it("says a refused operation did not start, and reports a cancellation reason", () => {
    const tracker = new OperationEndedLineTrackerV1();
    tracker.register({ id: "r", label: "Plan" });
    tracker.register({ id: "c", label: "Review" });
    assert.equal(tracker.ended({ id: "r", label: "Plan", state: "refused", endReasonV1: "no task.md" }), "Ended Plan — refused — it did not start: no task.md.");
    assert.equal(
      tracker.ended({ id: "c", label: "Review", state: "cancelled", cancelReasonV1: "cancelled by the owner" }),
      "Ended Review — cancelled: cancelled by the owner."
    );
  });

  void it("posts one line when a same-label child and its parent both end (the doubled 'succeeded')", () => {
    const tracker = new OperationEndedLineTrackerV1();
    tracker.register({ id: "root", label: "Apply Review" });
    tracker.register({ id: "child", label: "Apply Review", parentId: "root" });
    assert.equal(tracker.ended({ id: "child", label: "Apply Review", parentId: "root", state: "succeeded" }), undefined);
    assert.equal(tracker.ended({ id: "root", label: "Apply Review", state: "succeeded" }), "Ended Apply Review — succeeded.");
  });

  void it("lets a root whose command merely returned report the failure of its same-label child", () => {
    const tracker = new OperationEndedLineTrackerV1();
    tracker.register({ id: "root", label: "Apply Review" });
    tracker.register({ id: "child", label: "Apply Review", parentId: "root" });
    assert.equal(
      tracker.ended({
        id: "child",
        label: "Apply Review",
        parentId: "root",
        state: "failed",
        endReasonV1: "every remaining candidate is deferred",
      }),
      undefined
    );
    assert.equal(
      tracker.ended({ id: "root", label: "Apply Review", state: "succeeded" }),
      "Ended Apply Review — failed: every remaining candidate is deferred."
    );
  });

  void it("carries a grandchild's failure up through a silent same-label child", () => {
    const tracker = new OperationEndedLineTrackerV1();
    tracker.register({ id: "root", label: "Plan" });
    tracker.register({ id: "mid", label: "Plan", parentId: "root" });
    tracker.register({ id: "leaf", label: "Plan", parentId: "mid" });
    tracker.ended({ id: "leaf", label: "Plan", parentId: "mid", state: "failed", endReasonV1: "quota" });
    assert.equal(tracker.ended({ id: "mid", label: "Plan", parentId: "root", state: "succeeded" }), undefined);
    assert.equal(tracker.ended({ id: "root", label: "Plan", state: "succeeded" }), "Ended Plan — failed: quota.");
  });

  void it("does not merge a differently-labelled child into its parent's line", () => {
    const tracker = new OperationEndedLineTrackerV1();
    tracker.register({ id: "root", label: "Fast Forward Review" });
    tracker.register({ id: "child", label: "Review", parentId: "root" });
    assert.equal(
      tracker.ended({ id: "child", label: "Review", parentId: "root", state: "failed" }),
      "Ended Review — failed."
    );
    assert.equal(tracker.ended({ id: "root", label: "Fast Forward Review", state: "succeeded" }), "Ended Fast Forward Review — succeeded.");
  });

  void it("never posts a second line for the same operation (duplicate observer delivery)", () => {
    const tracker = new OperationEndedLineTrackerV1();
    tracker.register({ id: "a", label: "Plan" });
    const ended = { id: "a", label: "Plan", state: "failed" as const };
    assert.ok(tracker.ended(ended));
    assert.equal(tracker.ended(ended), undefined);
  });

  void it("stays silent for an operation whose round the ledger already ended in the chat", () => {
    recordOperationTerminalOutcomeV1("covered-op", { state: "failed", ledgerSpeaks: true });
    const tracker = new OperationEndedLineTrackerV1();
    tracker.register({ id: "covered-op", label: "Apply Review" });
    assert.equal(tracker.ended({ id: "covered-op", label: "Apply Review", state: "failed" }), undefined);
  });

  void it("a covered child also silences its same-label root, so one operation ends with no 'Ended' line of its own", () => {
    recordOperationTerminalOutcomeV1("covered-child", { state: "failed", ledgerSpeaks: true });
    const tracker = new OperationEndedLineTrackerV1();
    tracker.register({ id: "covered-root", label: "Plan" });
    tracker.register({ id: "covered-child", label: "Plan", parentId: "covered-root" });
    assert.equal(tracker.ended({ id: "covered-child", label: "Plan", parentId: "covered-root", state: "failed" }), undefined);
    assert.equal(tracker.ended({ id: "covered-root", label: "Plan", state: "succeeded" }), undefined);
  });

  void it("renders the recorded round outcome, not the snapshot of a command that merely returned", () => {
    recordOperationTerminalOutcomeV1("returned-op", {
      state: "failed",
      reason: "every model failed: Kimi — 429 usage limit",
      ledgerSpeaks: false,
    });
    const tracker = new OperationEndedLineTrackerV1();
    tracker.register({ id: "returned-op", label: "Plan" });
    assert.equal(
      tracker.ended({ id: "returned-op", label: "Plan", state: "succeeded" }),
      "Ended Plan — failed: every model failed: Kimi — 429 usage limit."
    );
    // The record is consumed: a duplicate delivery adds nothing.
    assert.equal(tracker.ended({ id: "returned-op", label: "Plan", state: "succeeded" }), undefined);
  });

  void it("derives the terminal state from TaskActionOutcomeV1, with candidatesDeferred and candidatesExhausted as failures", () => {
    const deferred = { kind: "unavailable", code: "candidatesDeferred" } as TaskActionOutcomeV1;
    const exhausted = { kind: "unavailable", code: "candidatesExhausted" } as TaskActionOutcomeV1;
    assert.equal(terminalOutcomeFromTaskActionOutcomeV1(deferred)?.state, "failed");
    assert.equal(terminalOutcomeFromTaskActionOutcomeV1(exhausted)?.state, "failed");
    assert.equal(terminalOutcomeFromTaskActionOutcomeV1({ kind: "cancelled", code: "userCancelled" })?.state, "cancelled");
    assert.equal(
      terminalOutcomeFromTaskActionOutcomeV1({ kind: "failed", code: "x", retryable: false } as TaskActionOutcomeV1)?.state,
      "failed"
    );
    assert.equal(
      terminalOutcomeFromTaskActionOutcomeV1({ kind: "completed", code: "completed" } as TaskActionOutcomeV1)?.state,
      "succeeded"
    );
    // Not decided by the outcome: the operation's own settlement stands.
    assert.equal(
      terminalOutcomeFromTaskActionOutcomeV1({ kind: "completed", code: "roundIncomplete" } as TaskActionOutcomeV1),
      undefined
    );
  });

  void it("still speaks for an operation the ledger did not cover", () => {
    const tracker = new OperationEndedLineTrackerV1();
    tracker.register({ id: "uncovered-op", label: "Apply Review" });
    assert.equal(
      tracker.ended({ id: "uncovered-op", label: "Apply Review", state: "failed" }),
      "Ended Apply Review — failed."
    );
  });
});
