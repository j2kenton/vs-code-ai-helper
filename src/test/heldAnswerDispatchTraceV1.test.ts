/**
 * run1 Steps 26 to 30 and 33: the dispatch trace on the claim and the ledger, the owner's cancel, the kept
 * waiting and uncertain records, and the replays of 2026-11-05 08:23 to 09:34.
 */
import * as assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import type { CreateWorkflowDecisionInputV1 } from "../types/workflowDecisionV1";
import {
  acquireWorkAdmissionV1,
  readAdmissionTraceForDispatchV1,
  setWorkAdmissionRootOverrideForTestV1,
} from "../state/workAdmissionV1";
import { runWithHeldDispatchIdV1 } from "../state/automationDispatchContextV1";
import {
  buildHeldDispatchTraceV1,
  decideHeldDispatchV1,
  reconcileHeldAnswerV1,
  shouldFastForwardYieldToHeldAnswerV1,
} from "../utils/heldAnswerLifecycleV1";
import {
  clearOwnerCancelRecordsForTestV1,
  lastOwnerCancelV1,
  lastRunEndedByForAnswerV1,
  recordOwnerCancelV1,
} from "../utils/ownerCancelRecordV1";
import { armDeferredOptionRunV1 } from "../utils/deferredOptionRunV1";
import { TaskOperationRegistry } from "../utils/taskOperations";

class FakeMemento {
  private readonly values = new Map<string, unknown>();
  get<T>(key: string, defaultValue: T): T {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
  }
  update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
}

const TASK = "/tmp/tasks/held-trace-task";

function moveOnCard(): CreateWorkflowDecisionInputV1 {
  return {
    decisionId: "move-1",
    decisionKey: "reviewClean",
    taskCanonicalId: TASK,
    stage: "impl-high-review",
    whatHappened: "The review is clean.",
    whyUserNeeded: "Choose what happens next.",
    options: [
      {
        optionId: "moveOn",
        label: "Move on",
        resumeKind: "continue",
        consequence: "Moves to the next stage.",
        effect: { kind: "command", command: "vs-code-ai-helper.advanceStage", args: [{ taskFolderPath: TASK }] },
      },
      {
        optionId: "skip",
        label: "Not now",
        resumeKind: "unpause",
        consequence: "Does nothing.",
        effect: { kind: "doNothing" },
      },
    ],
    recommendation: { kind: "option", optionId: "moveOn", reasoning: "Clean." },
    gating: { holdsTaskPaused: false, unblocksProgress: true, detail: "Moves the task forward." },
    createdAt: new Date().toISOString(),
  };
}

async function storeWithHeldMoveOn(memento = new FakeMemento()): Promise<{ store: WorkflowDecisionStoreV1; memento: FakeMemento }> {
  const store = new WorkflowDecisionStoreV1(memento as unknown as import("vscode").Memento);
  await store.post(moveOnCard());
  await store.resolve("move-1", "moveOn");
  await store.recordDeferredAnswer("move-1", {
    kind: "heldOption",
    heldState: "held",
    optionId: "moveOn",
    optionLabel: "Move on",
    acceptedAt: "2026-11-05T08:30:13.000Z",
    itemKeys: [],
  });
  return { store, memento };
}

void describe("a held dispatch leaves a trace that activation can read (run1 Step 26)", () => {
  const admissionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-held-trace-"));
  before(() => {
    setWorkAdmissionRootOverrideForTestV1((folder) => path.join(admissionRoot, Buffer.from(folder).toString("hex")));
  });
  after(() => {
    setWorkAdmissionRootOverrideForTestV1(undefined);
    fs.rmSync(admissionRoot, { recursive: true, force: true });
  });

  void it("the work-admission claim written inside a held dispatch carries the dispatch id, and one outside does not", async () => {
    const folder = path.join(admissionRoot, "tasks", "trace-task");
    const outside = await acquireWorkAdmissionV1({ taskFolderPath: folder, purpose: "admission", commandId: "x" });
    assert.equal(outside.outcome, "acquired");
    assert.equal(readAdmissionTraceForDispatchV1(folder, "dispatch-1").claimCarriesDispatchId, false);
    if (outside.outcome === "acquired") await outside.handle.release();

    const inside = await runWithHeldDispatchIdV1("dispatch-1", () =>
      acquireWorkAdmissionV1({ taskFolderPath: folder, purpose: "admission", commandId: "advanceStage" })
    );
    assert.equal(inside.outcome, "acquired");
    assert.deepEqual(readAdmissionTraceForDispatchV1(folder, "dispatch-1"), { claim: "live", claimCarriesDispatchId: true });
    assert.equal(readAdmissionTraceForDispatchV1(folder, "another-dispatch").claimCarriesDispatchId, false);
    // A claim nobody renewed for a long time reads as stale: activation then asks instead of guessing.
    assert.equal(readAdmissionTraceForDispatchV1(folder, "dispatch-1", Date.now() + 60 * 60 * 1000).claim, "stale");
    if (inside.outcome === "acquired") await inside.handle.release();
    assert.equal(readAdmissionTraceForDispatchV1(folder, "dispatch-1").claim, "none");
  });

  void it("the ledger rows decide ran, running or never started", () => {
    const none = { claim: "none" as const, claimCarriesDispatchId: false };
    const trace = (rows: { state: string; heldDispatchId?: string }[]) => buildHeldDispatchTraceV1("d1", rows, none);
    assert.equal(reconcileHeldAnswerV1("dispatching", trace([])), "backToHeld");
    assert.equal(reconcileHeldAnswerV1("dispatching", trace([{ state: "open", heldDispatchId: "d1" }])), "markRanWhenEnds");
    assert.equal(reconcileHeldAnswerV1("dispatching", trace([{ state: "completed", heldDispatchId: "d1" }])), "markRan");
    assert.equal(
      reconcileHeldAnswerV1("dispatching", trace([{ state: "completed", heldDispatchId: "someone-else" }])),
      "backToHeld",
      "another dispatch's row is not this answer's trace"
    );
    assert.equal(
      reconcileHeldAnswerV1("dispatching", buildHeldDispatchTraceV1("d1", [], { claim: "stale", claimCarriesDispatchId: true })),
      "uncertain"
    );
  });
});

void describe("the owner's cancel is remembered per task (run1 Step 28)", () => {
  beforeEach(() => clearOwnerCancelRecordsForTestV1());

  void it("an operation cancelled from a click is recorded; an unattributed cancel is not", () => {
    const registry = new TaskOperationRegistry();
    const task = "/dev/held_cancel_task";
    const op = registry.begin(task, { label: "Fast Forward", exclusive: true, cancellable: true });
    assert.ok(op);
    registry.cancelOperation(op.id);
    assert.equal(lastOwnerCancelV1(task), undefined, "an unattributed cancel is not the owner's");
    registry.end(op);

    const second = registry.begin(task, { label: "Apply Review", exclusive: true, cancellable: true });
    assert.ok(second);
    registry.cancelOperation(second.id, "notifications");
    assert.equal(lastOwnerCancelV1(task)?.reason, "owner");
    registry.end(second);
  });

  void it("'Run it now' cancels with its own reason, and an ordinary cancel in the same cascade does not replace it", () => {
    const registry = new TaskOperationRegistry();
    const task = "/dev/held_run_now_task";
    const parent = registry.begin(task, { label: "Fast Forward", exclusive: true, cancellable: true });
    assert.ok(parent);
    registry.cancelOperation(parent.id, "chat", "runHeldAnswer");
    assert.equal(lastOwnerCancelV1(task)?.reason, "runHeldAnswer");
    recordOwnerCancelV1(task, "owner");
    assert.equal(lastOwnerCancelV1(task)?.reason, "runHeldAnswer");
    registry.end(parent);
  });

  void it("only a cancel after the answer was chosen blocks it, and 'Run it now' is the go-ahead", () => {
    const task = "/dev/held_cancel_after";
    const chosen = Date.parse("2026-11-05T08:30:13.000Z");
    recordOwnerCancelV1(task, "owner", chosen - 1000);
    assert.equal(lastRunEndedByForAnswerV1(task, chosen), "other", "a cancel from before it was chosen is about an earlier round");
    recordOwnerCancelV1(task, "owner", chosen + 3_000_000);
    assert.equal(lastRunEndedByForAnswerV1(task, chosen), "owner");
    assert.equal(decideHeldDispatchV1({ taskStatus: "active", lastRunEndedBy: "owner" }).kind, "waitForOwner");
    recordOwnerCancelV1(task, "runHeldAnswer", chosen + 4_000_000);
    assert.equal(lastRunEndedByForAnswerV1(task, chosen), "runHeldAnswer");
    assert.equal(
      decideHeldDispatchV1({ taskStatus: "active", lastRunEndedBy: lastRunEndedByForAnswerV1(task, chosen) }).kind,
      "dispatch"
    );
  });
});

void describe("waiting and uncertain records stay on the decision (run1 Steps 26 and 28)", () => {
  void it("reopening the card keeps a waiting-for-owner record, and drops any other", async () => {
    const { store } = await storeWithHeldMoveOn();
    await store.swapHeldAnswerState("move-1", "held", { heldState: "waitingForOwner" });
    assert.equal(await store.reopenResolved("move-1", "moveOn", { keepHeldAnswer: true }), true);
    const reopened = store.get("move-1");
    assert.equal(reopened?.state, "pending");
    assert.equal(reopened?.deferredAnswer?.heldState, "waitingForOwner", "the durable record survives the reopen");
    assert.equal(reconcileHeldAnswerV1("waitingForOwner", undefined), "leave", "activation never runs it by itself");

    // A refused answer that is still plainly held is dropped when its card comes back, as before.
    const other = await storeWithHeldMoveOn();
    assert.equal(await other.store.reopenResolved("move-1", "moveOn", { keepHeldAnswer: true }), true);
    assert.equal(other.store.get("move-1")?.deferredAnswer, undefined);
  });

  void it("choosing the card again is the owner's go-ahead: the spent record is not left on the new resolution", async () => {
    const { store } = await storeWithHeldMoveOn();
    await store.swapHeldAnswerState("move-1", "held", { heldState: "uncertain" });
    await store.reopenResolved("move-1", "moveOn", { keepHeldAnswer: true });
    assert.equal(store.get("move-1")?.deferredAnswer?.heldState, "uncertain");
    const result = await store.resolve("move-1", "moveOn");
    assert.equal(result.kind, "resolved");
    assert.equal(store.get("move-1")?.deferredAnswer, undefined);
    assert.equal(store.listWithPendingDeferredAnswer(TASK).length, 0);
  });
});

void describe("replays of 2026-11-05 (run1 Step 33)", () => {
  void it("08:23 to 09:24: 'Move on' held at 08:30 runs when the 08:37 round ends, with no further High-Level round", async () => {
    const { store } = await storeWithHeldMoveOn();
    const roundsStarted: string[] = ["08:01 Apply Review"];
    let fastForwardActive = true;
    let operationRunning = true;
    // The loop asks this at each round boundary, exactly as the loop does.
    const boundary = (): boolean =>
      store.listWithPendingDeferredAnswer(TASK).some((decision) => shouldFastForwardYieldToHeldAnswerV1(decision.deferredAnswer));
    // 08:37: the round that was running when the answer was chosen ends, and the next boundary yields.
    operationRunning = false;
    if (boundary()) {
      fastForwardActive = false;
    } else {
      roundsStarted.push("08:45 review");
    }
    assert.equal(fastForwardActive, false, "Fast Forward ended at the boundary");
    assert.deepEqual(roundsStarted, ["08:01 Apply Review"], "no further same-stage round started");

    let dispatched = 0;
    let freed: (() => void) | undefined;
    const armed = armDeferredOptionRunV1({
      key: "move-1:moveOn:replay",
      isTaskBusy: () => operationRunning || fastForwardActive,
      subscribeToTaskFree: (listener) => {
        freed = listener;
        return { dispose: () => undefined };
      },
      pollMs: 3_600_000,
      carryOut: async () => {
        const swapped = await store.swapHeldAnswerState("move-1", "held", { heldState: "dispatching", dispatchId: "replay-d1" });
        if (!swapped) return { kind: "notCarriedOut", reason: "already running" };
        dispatched += 1;
        await store.swapHeldAnswerState("move-1", "dispatching", { heldState: "ran" });
        return { kind: "done" };
      },
      report: () => Promise.resolve(),
    });
    assert.equal(armed, true);
    freed?.();
    freed?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(dispatched, 1, "the answer ran exactly once");
    assert.equal(store.get("move-1")?.deferredAnswer?.heldState, "ran");
  });

  void it("09:30 to 09:34: a pause then a cancel leave the task paused, nothing starts, and the held answer is offered", async () => {
    const { store } = await storeWithHeldMoveOn();
    const task = "/dev/held_replay_pause";
    clearOwnerCancelRecordsForTestV1();
    recordOwnerCancelV1(task, "owner", Date.parse("2026-11-05T09:33:45.000Z"));
    const verdict = decideHeldDispatchV1({
      taskStatus: "paused",
      lastRunEndedBy: lastRunEndedByForAnswerV1(task, Date.parse("2026-11-05T08:30:13.000Z")),
    });
    assert.equal(verdict.kind, "waitForOwner");
    await store.swapHeldAnswerState("move-1", "held", { heldState: "waitingForOwner" });
    await store.reopenResolved("move-1", "moveOn", { keepHeldAnswer: true });
    assert.equal(store.get("move-1")?.state, "pending", "the card is back");
    assert.equal(store.get("move-1")?.deferredAnswer?.heldState, "waitingForOwner");
    assert.equal(shouldFastForwardYieldToHeldAnswerV1(store.get("move-1")?.deferredAnswer), false);
  });

  void it("a held answer survives a reload, and two windows racing for it run it once", async () => {
    const { memento } = await storeWithHeldMoveOn();
    const windowA = new WorkflowDecisionStoreV1(memento as unknown as import("vscode").Memento);
    const windowB = new WorkflowDecisionStoreV1(memento as unknown as import("vscode").Memento);
    assert.equal(windowA.listWithPendingDeferredAnswer(TASK).length, 1);
    assert.equal(windowB.listWithPendingDeferredAnswer(TASK).length, 1);
    const results = await Promise.all([
      windowA.swapHeldAnswerState("move-1", "held", { heldState: "dispatching", dispatchId: "a" }),
      windowB.swapHeldAnswerState("move-1", "held", { heldState: "dispatching", dispatchId: "b" }),
    ]);
    assert.equal(results.filter((answer) => answer !== undefined).length, 1);
  });
});
