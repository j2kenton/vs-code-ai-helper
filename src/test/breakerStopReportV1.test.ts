/**
 * bugs4 Step 7 (item 36): a round the no-progress breaker stops is reported with
 * its reason and stage, Fast Forward ends "stopped" rather than "succeeded", and
 * no ending line says "refused" or "succeeded" without a reason.
 */
import * as assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  breakerStoppedRoundLabelV1,
  clearBreakerStopV1,
  describeBreakerFastForwardEndV1,
  describeBreakerStopV1,
  recordBreakerStopV1,
  takeBreakerStopSinceV1,
} from "../utils/breakerStopReportV1";
import { OperationEndedLineTrackerV1, recordOperationTerminalOutcomeV1 } from "../utils/operationEndedLineV1";
import { resetTerminalLinesV1 } from "../utils/terminalLineEmitterV1";
import {
  clearStageActionRefusalReasonV1,
  recordStageActionRefusalReasonV1,
  takeStageActionRefusalReasonV1,
} from "../utils/stageActionRefusalV1";

const FOLDER = "/tmp/task_3";

void describe("breaker stop report (bugs4 Step 7, item 36)", () => {
  beforeEach(() => {
    resetTerminalLinesV1();
    clearBreakerStopV1(FOLDER);
    clearStageActionRefusalReasonV1(FOLDER);
  });

  void it("names the round, the stage, the rounds with no changes and that the owner decides", () => {
    assert.equal(
      describeBreakerStopV1("impl-low-review", 3),
      "Apply Review (Low-Level Code Review) not started: no-progress breaker (3 rounds with no changes). Waiting for your decision."
    );
  });

  void it("calls the round Implementation outside a review stage", () => {
    assert.equal(breakerStoppedRoundLabelV1("impl"), "Implementation");
    assert.match(describeBreakerStopV1("impl", 1), /^Implementation \(Implementation\) not started: .*\(1 round with no changes\)/);
  });

  void it("the Apply Review child ends refused WITH the breaker reason, never bare", () => {
    const reason = describeBreakerStopV1("impl-low-review", 3);
    recordStageActionRefusalReasonV1(FOLDER, reason);
    const tracker = new OperationEndedLineTrackerV1();
    tracker.register({ id: "apply", label: "Applying implementation review" });
    const line = tracker.ended({
      id: "apply",
      label: "Applying implementation review",
      state: "refused",
      endReasonV1: takeStageActionRefusalReasonV1(FOLDER),
    });
    assert.ok(line);
    assert.match(line, /not started: no-progress breaker \(3 rounds with no changes\)/);
    assert.match(line, /Waiting for your decision/);
  });

  void it("Fast Forward ends 'stopped' with the breaker named, not 'succeeded'", () => {
    recordBreakerStopV1(FOLDER, "impl-low-review", 3, 1_000);
    const stop = takeBreakerStopSinceV1(FOLDER, 500);
    assert.ok(stop);
    recordOperationTerminalOutcomeV1("ff", {
      state: "stopped",
      reason: describeBreakerFastForwardEndV1(stop.stage, stop.zeroChangeRounds),
    });
    const tracker = new OperationEndedLineTrackerV1();
    tracker.register({ id: "ff", label: "Fast Forward Review" });
    const line = tracker.ended({ id: "ff", label: "Fast Forward Review", state: "succeeded" });
    assert.ok(line);
    assert.match(line, /^Ended Fast Forward Review — stopped: stopped by the no-progress breaker at Low-Level Code Review/);
    assert.doesNotMatch(line, /succeeded/);
  });

  void it("three zero-change rounds produce one breaker record, consumed once", () => {
    recordBreakerStopV1(FOLDER, "impl-low-review", 3, 1_000);
    assert.ok(takeBreakerStopSinceV1(FOLDER, 0));
    assert.equal(takeBreakerStopSinceV1(FOLDER, 0), undefined);
  });

  void it("a breaker stop from before this Fast Forward run began is not attributed to it", () => {
    recordBreakerStopV1(FOLDER, "impl-low-review", 3, 1_000);
    assert.equal(takeBreakerStopSinceV1(FOLDER, 2_000), undefined);
  });

  void it("control: a Fast Forward that did not stop on the breaker still ends 'succeeded'", () => {
    const tracker = new OperationEndedLineTrackerV1();
    tracker.register({ id: "ff2", label: "Fast Forward Review" });
    assert.equal(
      tracker.ended({ id: "ff2", label: "Fast Forward Review", state: "succeeded" }),
      "Ended Fast Forward Review — succeeded."
    );
  });
});
