/**
 * RC7 item 5: when Fast Forward's Publish branch starts Publish Checks and
 * they leave no fresh result, the refusal names its reason instead of the bare
 * "refused — nothing was started". The branch sits inside `runFastForward…`'s
 * long closure, so this pins its wiring in source and the terminal row's use
 * of the reason through the real bridge.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

import {
  captureRaisedNoticesV1,
  publishChecksDeclinedReasonV1,
  recordRaisedNoticeV1,
} from "../utils/notificationTaskContextV1";
import { runFastForwardPublishChecksV1 } from "../utils/fastForwardPublishChecksV1";
import { terminalEntryFor } from "../utils/operationNotificationBridge";
import type { TaskOperationSnapshot } from "../utils/taskOperations";

void describe("Fast Forward Publish Checks refusal (RC7 item 5)", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "..", "src", "commands", "reviewActions.ts"),
    "utf8"
  );

  void it("Fast Forward's Publish branch runs the checks through the refusal helper", () => {
    assert.match(source, /runFastForwardPublishChecksV1\(\{[\s\S]{0,200}vs-code-ai-helper\.runPublishChecks/);
  });

  const fakeOp = () => {
    const calls: string[] = [];
    return {
      calls,
      op: {
        settleAs: (state: "refused", reason: string) => calls.push(`settleAs:${state}:${reason}`),
        report: (message: string) => calls.push(`report:${message}`),
      },
    };
  };

  void it("executes the branch: a raised warning and no fresh result settles refused with it", async () => {
    const { calls, op } = fakeOp();
    const ok = await runFastForwardPublishChecksV1({
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

  void it("executes the branch: no notice and no fresh result settles refused with the fallback", async () => {
    const { calls, op } = fakeOp();
    const ok = await runFastForwardPublishChecksV1({
      runChecks: () => Promise.resolve(),
      isFreshAfterChecks: () => Promise.resolve(false),
      op,
    });
    assert.equal(ok, false);
    const reason = "Publish Checks declined to start without saying why";
    assert.deepEqual(calls, [`settleAs:refused:${reason}`, `report:${reason}`]);
  });

  void it("executes the branch: a fresh result continues without settling", async () => {
    const { calls, op } = fakeOp();
    const ok = await runFastForwardPublishChecksV1({
      runChecks: () => Promise.resolve(),
      isFreshAfterChecks: () => Promise.resolve(true),
      op,
    });
    assert.equal(ok, true);
    assert.deepEqual(calls, []);
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

  void it("with no notice raised the fixed fallback is the reason, and the terminal row includes it", async () => {
    const { notices } = await captureRaisedNoticesV1(() => Promise.resolve(undefined));
    const reason = publishChecksDeclinedReasonV1(notices);
    assert.equal(reason, "Publish Checks declined to start without saying why");
    const row = terminalEntryFor({
      id: "op-3",
      key: "/tmp/task",
      label: "Fast Forward Review",
      taskName: "rc7",
      state: "refused",
      detail: reason,
      stage: "publish",
    } as unknown as TaskOperationSnapshot);
    assert.match(row?.message ?? "", /refused — nothing was started \(Publish Checks declined to start without saying why\)/);
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
