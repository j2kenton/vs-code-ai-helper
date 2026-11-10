/**
 * review2 Steps 13-14: every review refusal says why and what to click next, a held answer's "has now run" line
 * is written once, and a partial-scope stop never rests on a card that is not there.
 */
import * as assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { terminalEntryFor } from "../utils/operationNotificationBridge";
import type { TaskOperationSnapshot, TaskOperationState } from "../utils/taskOperations";
import { OperationEndedLineTrackerV1 } from "../utils/operationEndedLineV1";
import { resetTerminalLinesV1 } from "../utils/terminalLineEmitterV1";
import {
  NO_RECORDED_REFUSAL_REASON_V1,
  REVIEW_REFUSAL_NEXT_CLICK_V1,
  describeRefusalReasonV1,
} from "../utils/refusalGuidanceV1";
import {
  armDeferredOptionRunV1,
  createDeferredRunRegistryV1,
  hasDeferredOptionRunReportedV1,
  type DeferredRunOutcomeV1,
} from "../utils/deferredOptionRunV1";
import { parsePartialScopeGapRecordV1, hashMissingFilesV1 } from "../utils/reviewPartialScopeV1";

function snap(state: TaskOperationState, kind: string, endReasonV1?: string): TaskOperationSnapshot {
  return {
    id: "op-1",
    key: "/tasks/t",
    taskName: "t",
    label: "Review",
    kind,
    state,
    startedAt: 0,
    ...(endReasonV1 !== undefined ? { endReasonV1 } : {}),
  } as unknown as TaskOperationSnapshot;
}

void describe("a refused review states its reason and next click (review2 Step 13)", () => {
  beforeEach(() => resetTerminalLinesV1());

  void it("a review refused with no recorded reason says so and names the next click", () => {
    const text = describeRefusalReasonV1(undefined, "review");
    assert.ok(text?.startsWith(NO_RECORDED_REFUSAL_REASON_V1));
    assert.ok(text?.includes(REVIEW_REFUSAL_NEXT_CLICK_V1.replace(/\.$/, "")));
  });

  void it("a review reason that already names a click is kept as it is", () => {
    const reason = "nothing has changed since the last review. Next: choose Review again anyway on the card";
    assert.equal(describeRefusalReasonV1(reason, "review"), reason);
  });

  void it("a review reason with no next click gets one", () => {
    const text = describeRefusalReasonV1("the reviewer model is unavailable.", "review");
    assert.match(text ?? "", /^the reviewer model is unavailable\. Next: /);
  });

  void it("other kinds keep their reason exactly (their own wording carries the recovery)", () => {
    assert.equal(describeRefusalReasonV1("no task.md", "generate-plan"), "no task.md");
    assert.equal(describeRefusalReasonV1(undefined, "generate-plan"), undefined);
  });

  void it("the notification for a refused review carries the reason and the next click", () => {
    const message = terminalEntryFor(snap("refused", "review"))?.message ?? "";
    assert.match(message, /refused — nothing was started: no reason was recorded\. Next: /);
    const withReason = terminalEntryFor(snap("refused", "review", "the review inputs are unchanged"))?.message ?? "";
    assert.match(withReason, /refused — nothing was started: the review inputs are unchanged\. Next: /);
  });

  void it("the chat's Ended line for a refused review carries the reason and the next click", () => {
    const tracker = new OperationEndedLineTrackerV1();
    tracker.register({ id: "r", label: "Review" });
    const line = tracker.ended({ id: "r", label: "Review", state: "refused", kind: "review" });
    assert.match(line ?? "", /^Ended Review — refused — it did not start: no reason was recorded\. Next: .*\.$/);
  });

  void it("a refusal of any other kind reads exactly as before", () => {
    const tracker = new OperationEndedLineTrackerV1();
    tracker.register({ id: "p", label: "Plan" });
    assert.equal(
      tracker.ended({ id: "p", label: "Plan", state: "refused", kind: "generate-plan", endReasonV1: "no task.md" }),
      "Ended Plan — refused — it did not start: no task.md."
    );
  });
});

void describe("a held answer's 'has now run' line is written once (review2 Step 13)", () => {
  function runnable(registry: ReturnType<typeof createDeferredRunRegistryV1>, key: string, reports: DeferredRunOutcomeV1[]) {
    let busy = true;
    let free: (() => void) | undefined;
    const armed = armDeferredOptionRunV1({
      registry,
      key,
      isTaskBusy: () => busy,
      subscribeToTaskFree: (listener) => {
        free = listener;
        return { dispose: (): void => undefined };
      },
      carryOut: () => Promise.resolve({ kind: "done" }),
      report: (outcome) => {
        reports.push(outcome);
        return Promise.resolve();
      },
      pollMs: 60_000,
    });
    return {
      armed,
      release: (): void => {
        busy = false;
        free?.();
      },
    };
  }

  void it("arming the same answer again after it ran neither runs nor reports it a second time", async () => {
    const registry = createDeferredRunRegistryV1();
    const reports: DeferredRunOutcomeV1[] = [];
    const first = runnable(registry, "d:move-on", reports);
    assert.equal(first.armed, true);
    first.release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(reports, [{ kind: "done" }]);
    assert.equal(hasDeferredOptionRunReportedV1("d:move-on", registry), true);

    const again = runnable(registry, "d:move-on", reports);
    assert.equal(again.armed, false);
    again.release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reports.length, 1);
  });

  void it("an answer that could not be carried out may be armed again (its card came back)", async () => {
    const registry = createDeferredRunRegistryV1();
    const reports: DeferredRunOutcomeV1[] = [];
    let free: (() => void) | undefined;
    armDeferredOptionRunV1({
      registry,
      key: "d:retry",
      isTaskBusy: () => false,
      subscribeToTaskFree: (listener) => {
        free = listener;
        return { dispose: (): void => undefined };
      },
      carryOut: () => Promise.resolve({ kind: "notCarriedOut", reason: "the task moved on." }),
      report: (outcome) => {
        reports.push(outcome);
        return Promise.resolve();
      },
      pollMs: 60_000,
    });
    free?.();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reports.length, 1);
    assert.equal(hasDeferredOptionRunReportedV1("d:retry", registry), false);
    assert.equal(runnable(registry, "d:retry", reports).armed, true);
  });
});

void describe("the kept partial-scope gap (review2 Step 14)", () => {
  const files = ["src/a.ts", "src/b.ts"];
  const record = {
    stage: "impl-high-review",
    scope: { hash: hashMissingFilesV1(files), summary: "Reviewed 5 of 7 changed files", missingCount: 2, files },
    score: 8,
    threshold: 8,
    scoreClears: true,
    recordedAt: "2026-11-09T12:00:00.000Z",
  };

  void it("a recorded gap reads back whole, so the card can be rebuilt from it", () => {
    const parsed = parsePartialScopeGapRecordV1(JSON.parse(JSON.stringify(record)));
    assert.equal(parsed?.stage, "impl-high-review");
    assert.deepEqual(parsed?.scope.files, files);
    assert.equal(parsed?.scope.hash, hashMissingFilesV1(files));
    assert.equal(parsed?.score, 8);
    assert.equal(parsed?.scoreClears, true);
  });

  void it("a record missing its files or hash is not a gap", () => {
    assert.equal(parsePartialScopeGapRecordV1({ ...record, scope: { summary: "x", missingCount: 1 } }), undefined);
    assert.equal(parsePartialScopeGapRecordV1(null), undefined);
  });
});
