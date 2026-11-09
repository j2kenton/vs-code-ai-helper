/**
 * run1 Steps 26 to 30: a held answer is kept on disk, moves from held to dispatching in one swap, is never run
 * while the task is paused, is never re-run by itself after a restart that cut its dispatch off, and is
 * described in plain words.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import type { CreateWorkflowDecisionInputV1 } from "../types/workflowDecisionV1";
import {
  buildHeldDispatchTraceV1,
  decideHeldDispatchV1,
  describeHeldAnswerDroppedV1,
  describeHeldAnswerRowV1,
  describeHeldAnswerStartingV1,
  describeHeldAnswerUncertainV1,
  describeHeldAnswerWaitingForOwnerV1,
  reconcileHeldAnswerV1,
  shouldFastForwardYieldToHeldAnswerV1,
} from "../utils/heldAnswerLifecycleV1";

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

const TASK = "/tmp/tasks/held-task";

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

void describe("held answers kept on disk (run1 Step 26)", () => {
  void it("a held answer survives a reload, and activation re-arms it once", async () => {
    const { memento } = await storeWithHeldMoveOn();
    const reloaded = new WorkflowDecisionStoreV1(memento as unknown as import("vscode").Memento);
    const pending = reloaded.listWithPendingDeferredAnswer(TASK);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.deferredAnswer?.heldState, "held");
    assert.equal(reconcileHeldAnswerV1("held", undefined), "rearm");
  });

  void it("two callers racing the held-to-dispatching swap: exactly one wins, and it writes the dispatch id", async () => {
    const { store } = await storeWithHeldMoveOn();
    const [first, second] = await Promise.all([
      store.swapHeldAnswerState("move-1", "held", { heldState: "dispatching", dispatchId: "dispatch-a" }),
      store.swapHeldAnswerState("move-1", "held", { heldState: "dispatching", dispatchId: "dispatch-b" }),
    ]);
    const winners = [first, second].filter((answer) => answer !== undefined);
    assert.equal(winners.length, 1);
    assert.equal(store.get("move-1")?.deferredAnswer?.heldState, "dispatching");
    assert.equal(store.get("move-1")?.deferredAnswer?.dispatchId, winners[0]?.dispatchId);
  });

  void it("a swap from a state the answer is not in does nothing, and 'ran' is recorded as carried out", async () => {
    const { store } = await storeWithHeldMoveOn();
    assert.equal(await store.swapHeldAnswerState("move-1", "dispatching", { heldState: "ran" }), undefined);
    await store.swapHeldAnswerState("move-1", "held", { heldState: "dispatching", dispatchId: "d1" });
    const ran = await store.swapHeldAnswerState("move-1", "dispatching", { heldState: "ran" });
    assert.equal(ran?.heldState, "ran");
    assert.ok(ran?.carriedOutAt);
    assert.equal(store.listWithPendingDeferredAnswer(TASK).length, 0, "a finished answer is no longer pending");
  });

  void it("a crash after the swap, before the answer was recorded as ran: never run again by itself", () => {
    // Nothing yet carries the dispatch id onto a claim, so with no trace the answer is uncertain.
    assert.equal(reconcileHeldAnswerV1("dispatching", undefined), "uncertain");
    // With a trace: open row means still running, closed row means it ran, a stale claim is uncertain.
    assert.equal(reconcileHeldAnswerV1("dispatching", { ledgerRow: "open", claim: "live", claimCarriesDispatchId: true }), "markRanWhenEnds");
    assert.equal(reconcileHeldAnswerV1("dispatching", { ledgerRow: "closed", claim: "none", claimCarriesDispatchId: false }), "markRan");
    assert.equal(reconcileHeldAnswerV1("dispatching", { ledgerRow: "none", claim: "stale", claimCarriesDispatchId: false }), "uncertain");
    assert.equal(reconcileHeldAnswerV1("dispatching", { ledgerRow: "none", claim: "none", claimCarriesDispatchId: false }), "backToHeld");
    for (const settled of ["ran", "dropped", "uncertain", "waitingForOwner"] as const) {
      assert.equal(reconcileHeldAnswerV1(settled, undefined), "leave");
    }
  });

  void it("a command that took no work admission and was cut off after it started is uncertain, never re-run", async () => {
    // The marker is written before the command runs; an admission-free command leaves no claim or ledger row.
    const { store, memento } = await storeWithHeldMoveOn();
    await store.swapHeldAnswerState("move-1", "held", { heldState: "dispatching", dispatchId: "d1" });
    const afterBeforeStart = store.get("move-1")?.deferredAnswer;
    assert.equal(afterBeforeStart?.commandStartedAt, undefined);
    await store.swapHeldAnswerState("move-1", "dispatching", {
      heldState: "dispatching",
      commandStartedAt: "2026-11-05T08:37:00.000Z",
    });
    const reloaded = new WorkflowDecisionStoreV1(memento as unknown as import("vscode").Memento);
    const answer = reloaded.get("move-1")?.deferredAnswer;
    assert.equal(answer?.commandStartedAt, "2026-11-05T08:37:00.000Z", "the marker survives a reload");
    const none = { claim: "none", claimCarriesDispatchId: false } as const;
    assert.equal(
      reconcileHeldAnswerV1("dispatching", buildHeldDispatchTraceV1("d1", [], none, answer?.commandStartedAt !== undefined)),
      "uncertain"
    );
    // Cut off before the command started (no marker): the dispatch never started, back to held.
    assert.equal(reconcileHeldAnswerV1("dispatching", buildHeldDispatchTraceV1("d1", [], none, false)), "backToHeld");
    // A ledger row carrying the id still wins: it ran or is running.
    assert.equal(
      reconcileHeldAnswerV1(
        "dispatching",
        buildHeldDispatchTraceV1("d1", [{ state: "open", heldDispatchId: "d1" }], none, true)
      ),
      "markRanWhenEnds"
    );
    // A fresh dispatch (a later "Run it") clears the old marker.
    await reloaded.swapHeldAnswerState("move-1", "dispatching", { heldState: "held" });
    const again = await reloaded.swapHeldAnswerState("move-1", "held", {
      heldState: "dispatching",
      dispatchId: "d2",
      commandStartedAt: undefined,
    });
    assert.equal(again?.commandStartedAt, undefined);
  });

  void it("the uncertain card says it may or may not have run and that it will not run again by itself", () => {
    const text = describeHeldAnswerUncertainV1("Move on", "2026-11-05T08:30:13.000Z", "Low-Level Code Review");
    assert.match(text, /'Move on' \(chosen 08:30\) may or may not have run before Ensemble restarted/);
    assert.match(text, /The task is now at Low-Level Code Review/);
    assert.match(text, /will not run it again by itself/);
  });
});

void describe("Pause and Cancel win over a held answer (run1 Step 28)", () => {
  void it("a paused task never has the answer dispatched; it waits for the owner", () => {
    assert.deepEqual(decideHeldDispatchV1({ taskStatus: "paused", lastRunEndedBy: "other" }), {
      kind: "waitForOwner",
      reason: "paused",
    });
  });

  void it("an ordinary cancel blocks it, and the owner's own 'Run it now' cancel does not", () => {
    assert.deepEqual(decideHeldDispatchV1({ taskStatus: "active", lastRunEndedBy: "owner" }), {
      kind: "waitForOwner",
      reason: "cancelledByOwner",
    });
    assert.deepEqual(
      decideHeldDispatchV1({ taskStatus: "active", lastRunEndedBy: "owner", runNowRequestedAt: "2026-11-05T09:33:00.000Z" }),
      { kind: "dispatch" }
    );
    assert.deepEqual(decideHeldDispatchV1({ taskStatus: "active", lastRunEndedBy: "runHeldAnswer" }), { kind: "dispatch" });
  });

  void it("replay of 09:30 to 09:34: after the pause and the cancel the answer is not dispatched and the chat offers it", () => {
    const verdict = decideHeldDispatchV1({ taskStatus: "paused", lastRunEndedBy: "owner" });
    assert.equal(verdict.kind, "waitForOwner");
    const line = describeHeldAnswerWaitingForOwnerV1("Move on", verdict.kind === "waitForOwner" ? verdict.reason : "paused");
    assert.match(line, /Run your held 'Move on' now\?/);
    assert.match(line, /the task is paused/);
  });
});

void describe("held answers at the round boundary and in words (run1 Steps 27, 29, 30)", () => {
  void it("Fast Forward yields at the boundary only to an answer still held", () => {
    const base = { kind: "heldOption" as const, optionId: "moveOn", acceptedAt: "2026-11-05T08:30:13.000Z", itemKeys: [] };
    assert.equal(shouldFastForwardYieldToHeldAnswerV1({ ...base, heldState: "held" }), true);
    for (const state of ["dispatching", "waitingForOwner", "ran", "dropped", "uncertain"] as const) {
      assert.equal(shouldFastForwardYieldToHeldAnswerV1({ ...base, heldState: state }), false);
    }
    assert.equal(shouldFastForwardYieldToHeldAnswerV1(undefined), false);
    assert.equal(shouldFastForwardYieldToHeldAnswerV1({ ...base, kind: "ticksOnly" }), false);
  });

  void it("says when a held answer runs, why one is dropped, and what the row shows while it waits", () => {
    assert.equal(
      describeHeldAnswerStartingV1("Move on", "2026-11-05T08:30:13.000Z", "Fast Forward ran"),
      "Running your 'Move on' (chosen 08:30, held while Fast Forward ran)."
    );
    const dropped = describeHeldAnswerDroppedV1("Move on", "the task has moved on to Low-Level Code Review, so it no longer applies.");
    assert.match(dropped, /was not run: the task has moved on to Low-Level Code Review/);
    assert.match(dropped, /The card is back/);
    assert.equal(describeHeldAnswerRowV1("Move on", "2026-11-05T08:30:13.000Z"), "waiting to run: Move on, held since 08:30");
  });
});
