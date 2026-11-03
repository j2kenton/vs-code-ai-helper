/**
 * chat1 Steps 18 and 19: a refusal because another action holds the task names the holder, since
 * when and what to do; the bare outcome code never reaches the owner; one Notifications entry per
 * refusal.
 */
import * as assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { describeTaskHeldRefusalV1 } from "../utils/taskActionOutcomeTextV1";
import { reportTaskHeldRefusalV1 } from "../utils/taskHeldRefusalNoticeV1";
import { deactivateNotificationRouter, initNotificationRouter } from "../utils/notificationRouter";
import { duplicateRejectedV1 } from "../types/taskActionOutcomeV1";
import { setLiveTaskOperationLookupV1 } from "../utils/liveTaskOperationLookupV1";
import { taskOperations } from "../utils/taskOperations";

const ACQUIRED_AT = new Date(2026, 10, 2, 21, 20, 0).toISOString();
const SINCE_2120 = new Date(2026, 10, 2, 21, 20, 0).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

void describe("describeTaskHeldRefusalV1", () => {
  const base = { taskLabel: "bugs5", attemptedAction: "Complete Task", attemptedVerb: "complete" };

  void it("names Commit & Push, since when, and where it waits, when it waits on the owner", () => {
    const text = describeTaskHeldRefusalV1({
      ...base,
      outcome: { holder: { actionKey: "commitPush.v1", operationId: "op-1", acquiredAt: ACQUIRED_AT } },
      waitsOnOwner: true,
    });
    assert.equal(
      text,
      `Can't complete bugs5: Commit & Push has been running since ${SINCE_2120} and is waiting for you in Chat With AI. ` +
        "Answer or cancel it there, then Complete Task again."
    );
  });

  void it("says to wait or stop it when the holder is simply still running", () => {
    const text = describeTaskHeldRefusalV1({
      ...base,
      outcome: { holder: { actionKey: "review.v1", operationId: "op-2", acquiredAt: ACQUIRED_AT } },
      waitsOnOwner: false,
    });
    assert.equal(
      text,
      `Can't complete bugs5: A review has been running since ${SINCE_2120}. Wait for it or stop it from Chat With AI, then Complete Task again.`
    );
  });

  void it("prefers the live operation's label and start time", () => {
    const startedAt = new Date(2026, 10, 2, 19, 5, 0).getTime();
    const text = describeTaskHeldRefusalV1({
      ...base,
      outcome: { holder: { actionKey: "commitPush.v1", operationId: "op-1", acquiredAt: ACQUIRED_AT } },
      live: { label: "Publish Checks", startedAt },
      waitsOnOwner: false,
    });
    assert.match(text, /^Can't complete bugs5: Publish Checks have been running since /);
    assert.ok(text.includes(new Date(startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })));
  });

  void it("falls back to 'Another action' for an unknown action key or no holder, never to a code", () => {
    for (const outcome of [
      { holder: { actionKey: "someNewThing.v9", operationId: "op-3", acquiredAt: "not a date" } },
      {},
    ]) {
      const text = describeTaskHeldRefusalV1({ ...base, outcome, waitsOnOwner: false });
      assert.match(text, /^Can't complete bugs5: Another action has been running\. Wait for it/);
      assert.doesNotMatch(text, /duplicateRejected|operationAlreadyRunning|\.v\d/);
    }
  });
});

void describe("reportTaskHeldRefusalV1", () => {
  afterEach(() => {
    deactivateNotificationRouter();
    setLiveTaskOperationLookupV1(undefined);
  });

  function run(outcomeKind: "duplicateRejected" | "failed"): {
    handled: boolean;
    entries: unknown[][];
    settled: unknown[][];
  } {
    const entries: unknown[][] = [];
    const settled: unknown[][] = [];
    initNotificationRouter({ addEntry: (...args: unknown[]): void => { entries.push(args); } });
    setLiveTaskOperationLookupV1(() => ({ label: "Commit & Push", operationId: "op-holder", startedAt: Date.parse(ACQUIRED_AT) }));
    const handled = reportTaskHeldRefusalV1({
      outcome:
        outcomeKind === "duplicateRejected"
          ? duplicateRejectedV1({ actionKey: "commitPush.v1", operationId: "lease-op", acquiredAt: ACQUIRED_AT })
          : { kind: "failed", code: "x" } as never,
      taskFolderPath: "/tasks/bugs5",
      canonicalId: "/tasks/bugs5",
      progress: { displayName: "bugs5", currentStage: "publish" },
      folderName: "bugs5",
      op: { id: "op-self", settleAs: (...args: unknown[]): void => { settled.push(args); } },
      attemptedAction: "Complete Task",
      attemptedVerb: "complete",
    });
    return { handled, entries, settled };
  }

  void it("posts exactly one warning, with an Open in Chat action and the holder's Stop, and settles as refused", () => {
    const { handled, entries, settled } = run("duplicateRejected");
    assert.equal(handled, true);
    assert.equal(entries.length, 1, "one notification per refusal");
    const [message, level, , , sourceOperationId, action] = entries[0] as [string, string, unknown, unknown, string, { command: string; title: string }];
    assert.equal(level, "warning");
    // The task label is the notification convention's quoted name.
    assert.match(message, /Can't complete "bugs5": Commit & Push has been running since /);
    assert.doesNotMatch(message, /duplicateRejected|operationAlreadyRunning/);
    assert.equal(sourceOperationId, "op-holder", "the holder's row can be stopped from this entry");
    assert.equal(action.command, "vs-code-ai-helper.openWorkflowDecision");
    assert.equal(action.title, "Open in Chat");
    assert.equal(settled.length, 1);
    assert.equal(settled[0]?.[0], "refused");
    assert.deepEqual(settled[0]?.[2], { reportedByCommand: true });
  });

  void it("never names the refused operation as its own holder", () => {
    const entries: unknown[][] = [];
    initNotificationRouter({ addEntry: (...args: unknown[]): void => { entries.push(args); } });
    setLiveTaskOperationLookupV1(() => ({ label: "Complete Task", operationId: "op-self", startedAt: 1 }));
    reportTaskHeldRefusalV1({
      outcome: duplicateRejectedV1({ actionKey: "commitPush.v1", operationId: "lease-op", acquiredAt: ACQUIRED_AT }),
      taskFolderPath: "/tasks/bugs5",
      canonicalId: "/tasks/bugs5",
      progress: { displayName: "bugs5", currentStage: "publish" },
      folderName: "bugs5",
      op: { id: "op-self", settleAs: (): void => undefined },
      attemptedAction: "Complete Task",
      attemptedVerb: "complete",
    });
    assert.match(String(entries[0]?.[0]), /Commit & Push has been running/);
    assert.ok(!String(entries[0]?.[0]).includes("Complete Task has been"));
    assert.equal(entries[0]?.[4], undefined);
  });

  void it("leaves any other outcome to the caller", () => {
    const { handled, entries, settled } = run("failed");
    assert.equal(handled, false);
    assert.equal(entries.length, 0);
    assert.equal(settled.length, 0);
  });

  void it("is unused by taskOperations here (the registry is only read through the lookup)", () => {
    assert.ok(taskOperations);
  });
});
