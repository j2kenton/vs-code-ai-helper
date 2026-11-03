/**
 * chat1 Steps 18 and 19: every refusal "another action holds this task" (Complete Task, reopen, and
 * the Commit & Push paths) goes through the shared holder message, so the owner never sees the bare
 * outcome code and gets one entry per refusal.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";

import { duplicateRejectedV1 } from "../types/taskActionOutcomeV1";
import { deactivateNotificationRouter, initNotificationRouter } from "../utils/notificationRouter";
import { setLiveTaskOperationLookupV1 } from "../utils/liveTaskOperationLookupV1";
import { buildTaskHeldRefusalMessageV1, showTaskHeldRefusalWarningV1 } from "../utils/taskHeldRefusalNoticeV1";

const SRC = path.resolve(__dirname, "..", "..", "src");
const ACQUIRED_AT = new Date(2026, 10, 2, 21, 20, 0).toISOString();

function read(relativePath: string): string {
  return fs.readFileSync(path.join(SRC, relativePath), "utf8");
}

const task = {
  taskFolderPath: "/tasks/bugs5",
  canonicalId: "/tasks/bugs5",
  progress: { displayName: "bugs5", currentStage: "publish" as const },
  folderName: "bugs5",
  attemptedAction: "Resume Task",
  attemptedVerb: "reopen",
};

void describe("buildTaskHeldRefusalMessageV1", () => {
  afterEach(() => {
    deactivateNotificationRouter();
    setLiveTaskOperationLookupV1(undefined);
  });

  void it("is undefined for any outcome that is not a held-task refusal", () => {
    assert.equal(buildTaskHeldRefusalMessageV1({ ...task, outcome: { kind: "failed", code: "x" } as never }), undefined);
  });

  void it("names the holder and what to do for a reopen, with no outcome code, and carries the holder's row", () => {
    setLiveTaskOperationLookupV1(() => ({ label: "Commit & Push", operationId: "op-holder", startedAt: Date.parse(ACQUIRED_AT) }));
    const held = buildTaskHeldRefusalMessageV1({
      ...task,
      outcome: duplicateRejectedV1({ actionKey: "commitPush.v1", operationId: "lease-op", acquiredAt: ACQUIRED_AT }),
    });
    assert.ok(held);
    assert.match(held.message, /^Can't reopen "bugs5": Commit & Push has been running since /);
    assert.match(held.message, /then Resume Task again\.$/);
    assert.doesNotMatch(held.message, /duplicateRejected|operationAlreadyRunning/);
    assert.equal(held.holderOperationId, "op-holder");
  });

  void it("falls back to the lease's holder when no operation is registered", () => {
    const held = buildTaskHeldRefusalMessageV1({
      ...task,
      outcome: duplicateRejectedV1({ actionKey: "commitPush.v1", operationId: "lease-op", acquiredAt: ACQUIRED_AT }),
    });
    assert.ok(held);
    assert.match(held.message, /Commit & Push has been running since /);
    assert.equal(held.holderOperationId, undefined);
  });

  void it("showTaskHeldRefusalWarningV1 posts exactly one warning", () => {
    const entries: unknown[][] = [];
    initNotificationRouter({ addEntry: (...args: unknown[]): void => { entries.push(args); } });
    showTaskHeldRefusalWarningV1({ message: "Can't commit and push bugs5: X.", holderOperationId: "op-holder" }, task);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.[1], "warning");
    assert.equal(entries[0]?.[4], "op-holder");
  });
});

void describe("held-task refusals use the shared message at every call site", () => {
  void it("reopenTask.ts builds the holder sentence and keeps no hand-written one", () => {
    const source = read("utils/reopenTask.ts");
    assert.match(source, /buildTaskHeldRefusalMessageV1/);
    assert.doesNotMatch(source, /another action is still running for it/);
  });

  void it("commitAndPushTask.ts reports a held task through the shared helpers on all three paths", () => {
    const source = read("commands/commitAndPushTask.ts");
    assert.match(source, /buildTaskHeldRefusalMessageV1\(/);
    assert.match(source, /showTaskHeldRefusalWarningV1\(held, resolvedTask\)/);
    assert.equal((source.match(/reportCompleteCommitPushHeldV1\(/g) ?? []).length, 3, "one definition and two call sites");
  });
});
