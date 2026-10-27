/**
 * RC7 item 5 + bugs2 finding 5: when Fast Forward's Publish branch starts
 * Publish Checks and they leave no fresh result, the outcome names what
 * actually happened — a refusal names its reason, a cancellation (after the
 * checks started) says "cancelled" and by whom, and "declined to start without
 * saying why" is never shown. The branch sits inside `runFastForward…`'s long
 * closure, so this pins its wiring in source and the terminal row's use of the
 * reason through the real bridge.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

import {
  captureRaisedNoticesV1,
  PUBLISH_CHECKS_NO_REASON_V1,
  publishChecksDeclinedReasonV1,
  recordRaisedNoticeV1,
} from "../utils/notificationTaskContextV1";
import { runFastForwardPublishChecksV1 } from "../utils/fastForwardPublishChecksV1";
import { terminalEntryFor } from "../utils/operationNotificationBridge";
import {
  recordStageActionTerminalOutcomeV1,
  takeStageActionTerminalOutcomeV1,
} from "../utils/stageActionRefusalV1";
import type { TaskOperationSnapshot } from "../utils/taskOperations";

const TASK = "/tmp/ff-publish-refusal-task";

void describe("Fast Forward Publish Checks refusal (RC7 item 5)", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "..", "src", "commands", "reviewActions.ts"),
    "utf8"
  );

  void it("Fast Forward's Publish branch runs the checks through the refusal helper", () => {
    assert.match(source, /runFastForwardPublishChecksV1\(\{[\s\S]{0,300}vs-code-ai-helper\.runPublishChecks/);
  });

  const fakeOp = () => {
    const calls: string[] = [];
    return {
      calls,
      op: {
        settleAs: (state: "refused" | "failed" | "cancelled", reason: string) =>
          calls.push(`settleAs:${state}:${reason}`),
        report: (message: string) => calls.push(`report:${message}`),
      },
    };
  };

  void it("executes the branch: a raised warning and no fresh result settles refused with it", async () => {
    const { calls, op } = fakeOp();
    const ok = await runFastForwardPublishChecksV1({
      taskFolderPath: TASK,
      runChecks: () => {
        recordRaisedNoticeV1("Publish checks failed: lint");
        return Promise.resolve();
      },
      isFreshAfterChecks: () => Promise.resolve(false),
      op,
    });
    assert.equal(ok, false);
    const reason = "Publish Checks declined to start: Publish checks failed: lint";
    assert.deepEqual(calls, [`settleAs:refused:${reason}`, `report:${reason}`]);
  });

  void it("executes the branch: no notice and no outcome settles refused with a diagnostic, never 'without saying why'", async () => {
    const { calls, op } = fakeOp();
    const ok = await runFastForwardPublishChecksV1({
      taskFolderPath: TASK,
      runChecks: () => Promise.resolve(),
      isFreshAfterChecks: () => Promise.resolve(false),
      op,
    });
    assert.equal(ok, false);
    assert.deepEqual(calls, [
      `settleAs:refused:${PUBLISH_CHECKS_NO_REASON_V1}`,
      `report:${PUBLISH_CHECKS_NO_REASON_V1}`,
    ]);
    assert.doesNotMatch(PUBLISH_CHECKS_NO_REASON_V1, /without saying why/);
    assert.match(PUBLISH_CHECKS_NO_REASON_V1, /could not be established/);
  });

  void it("executes the branch: a fresh result continues without settling", async () => {
    const { calls, op } = fakeOp();
    const ok = await runFastForwardPublishChecksV1({
      taskFolderPath: TASK,
      runChecks: () => Promise.resolve(),
      isFreshAfterChecks: () => Promise.resolve(true),
      op,
    });
    assert.equal(ok, true);
    assert.deepEqual(calls, []);
  });

  void it("checks that started and were cancelled settle as cancelled, naming who cancelled them, once (bugs2 finding 5)", async () => {
    const { calls, op } = fakeOp();
    const ok = await runFastForwardPublishChecksV1({
      taskFolderPath: TASK,
      runChecks: () => {
        // What runPublishChecks's cancellation handler records.
        recordStageActionTerminalOutcomeV1(TASK, {
          kind: "cancelled",
          actionLabel: "Publish Checks",
          source: "notifications",
          operationId: "op-7",
        });
        return Promise.resolve(true);
      },
      isFreshAfterChecks: () => Promise.resolve(false),
      op,
    });
    assert.equal(ok, false);
    const text =
      "Publish Checks was cancelled from the Notifications row after it started; nothing was recorded for the run.";
    assert.deepEqual(calls, [`settleAs:cancelled:${text}`, `report:${text}`]);
    for (const call of calls) {
      assert.doesNotMatch(call, /refused|declined/);
    }
    // Read once: a second Fast Forward step cannot see a stale cancellation.
    assert.equal(takeStageActionTerminalOutcomeV1(TASK), undefined);
  });

  void it("checks that failed during execution settle as failed, not refused", async () => {
    const { calls, op } = fakeOp();
    const ok = await runFastForwardPublishChecksV1({
      taskFolderPath: TASK,
      runChecks: () => {
        recordStageActionTerminalOutcomeV1(TASK, {
          kind: "failed",
          actionLabel: "Publish Checks",
          reason: "Publish checks found issues: 2 tests failed",
          operationId: "op-failed",
        });
        return Promise.resolve(true);
      },
      isFreshAfterChecks: () => Promise.resolve(false),
      op,
    });
    assert.equal(ok, false);
    const expected = "Publish Checks started and failed: Publish checks found issues: 2 tests failed";
    assert.deepEqual(calls, [`settleAs:failed:${expected}`, `report:${expected}`]);
  });

  void it("checks that were interrupted settle as interrupted, not failed or refused", async () => {
    const { calls, op } = fakeOp();
    const ok = await runFastForwardPublishChecksV1({
      taskFolderPath: TASK,
      runChecks: () => {
        recordStageActionTerminalOutcomeV1(TASK, {
          kind: "interrupted",
          actionLabel: "Publish Checks",
          reason: "the runner stopped reporting",
          operationId: "op-interrupted",
        });
        return Promise.resolve(true);
      },
      isFreshAfterChecks: () => Promise.resolve(false),
      op,
    });
    assert.equal(ok, false);
    const expected = "Publish Checks was interrupted and its outcome is unknown: the runner stopped reporting";
    assert.deepEqual(calls, [`settleAs:interrupted:${expected}`, `report:${expected}`]);
  });

  void it("a cancellation recorded by an earlier run is not read as this run's", async () => {
    recordStageActionTerminalOutcomeV1(TASK, { kind: "cancelled", actionLabel: "Publish Checks" });
    const { calls, op } = fakeOp();
    const ok = await runFastForwardPublishChecksV1({
      taskFolderPath: TASK,
      runChecks: () => Promise.resolve(true),
      isFreshAfterChecks: () => Promise.resolve(false),
      op,
    });
    assert.equal(ok, false);
    assert.match(calls[0] ?? "", /^settleAs:refused:/);
  });

  void it("a cancelled terminal row carries the stated reason instead of a bare 'cancelled'", () => {
    const text = "Publish Checks was cancelled from a viewer after it started; nothing was recorded for the run.";
    const row = terminalEntryFor({
      id: "op-9",
      key: "/tmp/task",
      label: "Fast Forward Review",
      taskName: "bugs1",
      state: "cancelled",
      detail: text,
      cancelReasonV1: text,
      stage: "publish",
    } as unknown as TaskOperationSnapshot);
    assert.match(row?.message ?? "", /cancelled \(Publish Checks was cancelled from a viewer after it started/);
    assert.doesNotMatch(row?.message ?? "", /refused|declined/);
    assert.equal(row?.level, "warning");
  });

  void it("a cancelled row with only a transient live detail still reads as plain cancelled", () => {
    const row = terminalEntryFor({
      id: "op-10",
      key: "/tmp/task",
      label: "Run Implementation",
      taskName: "bugs1",
      state: "cancelled",
      detail: "cancelling…",
      stage: "impl",
    } as unknown as TaskOperationSnapshot);
    assert.doesNotMatch(row?.message ?? "", /cancelling/);
  });

  void it("a captured warning becomes the reason, and the terminal row includes it", async () => {
    const { notices } = await captureRaisedNoticesV1(() => {
      recordRaisedNoticeV1("Publish checks failed: lint");
      return Promise.resolve(undefined);
    });
    const reason = publishChecksDeclinedReasonV1(notices);
    assert.equal(reason, "Publish Checks declined to start: Publish checks failed: lint");
    const row = terminalEntryFor({
      id: "op-2",
      key: "/tmp/task",
      label: "Fast Forward Review",
      taskName: "rc7",
      state: "refused",
      detail: reason,
      stage: "publish",
    } as unknown as TaskOperationSnapshot);
    assert.match(row?.message ?? "", /refused — nothing was started \(Publish Checks declined to start: Publish checks failed: lint\)/);
  });

  void it("with no notice raised the diagnostic is the reason, and the terminal row includes it", async () => {
    const { notices } = await captureRaisedNoticesV1(() => Promise.resolve(undefined));
    const reason = publishChecksDeclinedReasonV1(notices);
    assert.equal(reason, PUBLISH_CHECKS_NO_REASON_V1);
    const row = terminalEntryFor({
      id: "op-3",
      key: "/tmp/task",
      label: "Fast Forward Review",
      taskName: "rc7",
      state: "refused",
      detail: reason,
      stage: "publish",
    } as unknown as TaskOperationSnapshot);
    assert.match(row?.message ?? "", /refused — nothing was started \(Publish Checks left no fresh result/);
    assert.doesNotMatch(row?.message ?? "", /without saying why/);
  });

  void it("the terminal row carries the reason in brackets", () => {
    const snapshot = {
      id: "op-1",
      key: "/tmp/task",
      label: "Fast Forward Review",
      taskName: "rc7",
      state: "refused",
      detail: "Publish Checks declined to start: the Publish model is not configured",
      stage: "publish",
    } as unknown as TaskOperationSnapshot;
    const entry = terminalEntryFor(snapshot);
    assert.match(entry?.message ?? "", /refused — nothing was started \(Publish Checks declined to start: the Publish model is not configured\)/);
  });
});
