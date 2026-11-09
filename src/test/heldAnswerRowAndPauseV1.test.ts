/**
 * run1 Steps 27, 28 and 30: a held owner answer is shown on the running row with Run it now / Drop it, waits for
 * the registry's operations rather than the Fast Forward run flag, and an owner's Pause stops countdowns.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { WorkflowDecisionOptionV1, WorkflowDecisionV1 } from "../types/workflowDecisionV1";
import { evaluateAutoContinueV1, planAutoContinueV1, withWaitForMeOptionV1 } from "../utils/autoContinueV1";
import {
  clearFastForwardRunActiveV1,
  markFastForwardRunActiveV1,
} from "../utils/activeFastForwardRunsV1";
import {
  buildHeldAnswerOwnerCardInputV1,
  describeHeldAnswerRowInfoV1,
  isOwnerActionableHeldStateV1,
} from "../utils/heldAnswerLifecycleV1";
import { getLiveTaskOperationV1, isTaskOperationRunningV1 } from "../utils/liveTaskOperationLookupV1";
import { TaskOperationRegistry, taskOperations, type TaskOperationSnapshot } from "../utils/taskOperations";
import { OPERATION_HELD_CONTEXT_SUFFIX_V1, StatusTreeProvider, type StatusOperationNode, type StatusTreeNode } from "../views/statusView";

const T0 = Date.parse("2026-11-07T08:30:00.000Z");

const SAFE_OPTION: WorkflowDecisionOptionV1 = {
  optionId: "moveOn",
  label: "Move on",
  consequence: "Moves on.",
  resumeKind: "continue",
  unattendedSafe: true,
  effect: { kind: "command", command: "vs-code-ai-helper.moveOn" },
};

function card(): WorkflowDecisionV1 {
  return {
    decisionId: "d1",
    decisionKey: "reviewClean",
    taskCanonicalId: "/ws/.ensemble/task-x",
    stage: "impl-high-review",
    state: "pending",
    options: withWaitForMeOptionV1([SAFE_OPTION]),
    recommendation: { kind: "option", optionId: "moveOn", reasoning: "safe" },
  } as unknown as WorkflowDecisionV1;
}

function operationNodes(provider: StatusTreeProvider): StatusOperationNode[] {
  return ((provider.getChildren() ?? []) as StatusTreeNode[]).filter(
    (node): node is StatusOperationNode => "kind" in node && node.kind === "operation"
  );
}

void describe("run1 Step 28: an owner's Pause stops countdowns", () => {
  void it("no countdown is armed on a task the owner paused, and one is armed on a task paused by an escalation", () => {
    assert.equal(planAutoContinueV1(card(), 15, T0, { paused: true }), undefined);
    assert.ok(planAutoContinueV1(card(), 15, T0, {}), "an escalation's pause is what a card's countdown is for");
  });

  void it("an armed countdown is cancelled, not run, once the owner pauses the task", () => {
    const armed = planAutoContinueV1(card(), 15, T0, { progressVersion: 4, roundCount: 7 });
    assert.ok(armed);
    const decision = { ...card(), autoContinue: armed };
    const afterDeadline = T0 + 16 * 60_000;
    assert.deepEqual(evaluateAutoContinueV1(decision, afterDeadline, { progressVersion: 4, roundCount: 7 }), {
      kind: "run",
      optionId: "moveOn",
    });
    const paused = evaluateAutoContinueV1(decision, afterDeadline, { progressVersion: 4, roundCount: 7, paused: true });
    assert.equal(paused.kind, "cancel");
    assert.match(paused.kind === "cancel" ? paused.reason : "", /you paused the task/);
  });
});

void describe("run1 Step 27: a held answer waits for the registry's operations, not the Fast Forward run flag", () => {
  void it("a Fast Forward run flag with no operation is busy for a card's lookup but not for a held answer", () => {
    const taskPath = `/dev/held_busy_${Math.floor(Math.random() * 1e9)}`;
    markFastForwardRunActiveV1(taskPath);
    try {
      assert.deepEqual(getLiveTaskOperationV1(taskPath), { label: "Fast Forward" });
      assert.equal(isTaskOperationRunningV1(taskPath), false);
    } finally {
      clearFastForwardRunActiveV1(taskPath);
    }
  });

  void it("a registered operation keeps the task busy", () => {
    const taskPath = `/dev/held_busy_op_${Math.floor(Math.random() * 1e9)}`;
    const op = taskOperations.begin(taskPath, { label: "Apply Review", taskName: "held_busy_op", stage: "impl", cancellable: true });
    assert.ok(op);
    try {
      assert.equal(isTaskOperationRunningV1(taskPath), true);
    } finally {
      taskOperations.end(op);
    }
    assert.equal(isTaskOperationRunningV1(taskPath), false);
  });
});

void describe("run1 Steps 26 and 28: the card that asks what to do with an answer that did not run", () => {
  const facts = {
    heldDecisionId: "d1",
    taskCanonicalId: "/ws/.ensemble/task-x",
    stage: "impl-high-review" as const,
    label: "Move on",
    chosenAt: "2026-11-05T08:30:00.000Z",
  };

  void it("after a pause it asks 'Run your held Move on now?' with Run it and Drop it, which act on the held answer", () => {
    const card = buildHeldAnswerOwnerCardInputV1({ ...facts, why: "paused" });
    assert.equal(card.whyUserNeeded, "Run your held 'Move on' now?");
    assert.match(card.whatHappened, /has not run, because the task is paused/);
    assert.deepEqual(
      card.options.map((option) => option.label),
      ["Run it", "Drop it"]
    );
    const [run, drop] = card.options;
    assert.deepEqual(run?.effect, {
      kind: "command",
      command: "vs-code-ai-helper.runHeldAnswerNow",
      args: [{ heldAnswerV1: { decisionId: "d1" } }],
    });
    assert.equal(drop?.effect.kind === "command" ? drop.effect.command : "", "vs-code-ai-helper.dropHeldAnswer");
    assert.equal(card.recommendation.kind, "none", "the owner paused, so nothing is recommended for them");
  });

  void it("after a restart that left it unclear it offers Run it again and Drop it, in plain words", () => {
    const card = buildHeldAnswerOwnerCardInputV1({ ...facts, why: "uncertain", stageNow: "Low-Level Code Review" });
    assert.deepEqual(
      card.options.map((option) => option.label),
      ["Run it again", "Drop it"]
    );
    assert.match(card.whatHappened, /may or may not have run before Ensemble restarted/);
    assert.match(card.whatHappened, /Low-Level Code Review/);
    const text = JSON.stringify([card.whatHappened, card.whyUserNeeded, ...card.options.map((o) => [o.label, o.consequence])]);
    assert.doesNotMatch(text, /[a-z][A-Z]/, "no camelCase identifier on the card");
  });

  void it("the owner can still act on a held, kept-back or uncertain answer, and on no other", () => {
    for (const state of ["held", "waitingForOwner", "uncertain"] as const) {
      assert.equal(isOwnerActionableHeldStateV1(state), true);
    }
    for (const state of ["dispatching", "ran", "dropped", undefined] as const) {
      assert.equal(isOwnerActionableHeldStateV1(state), false);
    }
  });
});

void describe("run1 Step 30: the runner's held answer reaches a viewer window's row", () => {
  void it("a mirrored root operation carries the held answer, so the viewer's row shows it and its buttons act on it", () => {
    const task = `/dev/held_mirror_${Math.floor(Math.random() * 1e9)}`;
    const held = {
      decisionId: "d1",
      optionId: "moveOn",
      label: "Move on",
      chosenAt: "2026-11-05T08:30:00.000Z",
      state: "held" as const,
    };
    const viewer = new TaskOperationRegistry();
    // The written snapshot is JSON on disk; the viewer reads it back and puts it in its own registry.
    const written = JSON.parse(
      JSON.stringify({
        id: "op-1",
        key: task,
        label: "Fast Forward Review",
        taskName: "held_mirror",
        startedAt: Date.now(),
        waitingForUser: false,
        exclusive: true,
        cancellable: true,
        state: "running",
        heldAnswerV1: held,
      })
    ) as unknown as TaskOperationSnapshot;
    viewer.setMirroredOperations([written]);
    assert.deepEqual(viewer.heldAnswerForTaskV1(task), held);
    viewer.setMirroredOperations([]);
    assert.equal(viewer.heldAnswerForTaskV1(task), undefined, "gone with the runner's operation");
  });
});

void describe("run1 Step 30: the running row shows a held answer with Run it now and Drop it", () => {
  void it("describes a waiting and a kept-back answer in plain words", () => {
    assert.match(
      describeHeldAnswerRowInfoV1({ decisionId: "d1", optionId: "moveOn", label: "Move on", chosenAt: "2026-11-05T08:30:00.000Z", state: "held" }),
      /^waiting to run: Move on, held since 08:30$/
    );
    assert.match(
      describeHeldAnswerRowInfoV1({ decisionId: "d1", optionId: "moveOn", label: "Move on", chosenAt: "2026-11-05T08:30:00.000Z", state: "waitingForOwner" }),
      /'Move on' \(chosen 08:30\) is waiting for you/
    );
  });

  void it("the row carries the held line and the -held context while it waits, and neither once it is cleared", () => {
    const provider = new StatusTreeProvider();
    const taskPath = `/dev/held_row_${Math.floor(Math.random() * 1e9)}`;
    const op = taskOperations.begin(taskPath, { label: "Fast Forward Review", taskName: "held_row", stage: "impl", cancellable: true });
    assert.ok(op);
    try {
      taskOperations.setHeldAnswerForTaskV1(taskPath, {
        decisionId: "d1",
        optionId: "moveOn",
        label: "Move on",
        chosenAt: "2026-11-05T08:30:00.000Z",
        state: "held",
      });
      const node = operationNodes(provider).find((n) => n.taskName === "held_row");
      assert.ok(node);
      assert.equal(node.heldAnswerV1?.decisionId, "d1", "the node carries the answer the buttons act on");
      const item = provider.getTreeItem(node);
      assert.match(String(item.description), /waiting to run: Move on, held since 08:30/);
      assert.ok(String(item.contextValue).endsWith(OPERATION_HELD_CONTEXT_SUFFIX_V1));
      assert.ok(String(item.contextValue).startsWith("ensemble-operation-cancellable"), "Stop stays on the row");

      taskOperations.setHeldAnswerForTaskV1(taskPath, undefined);
      const cleared = provider.getTreeItem(operationNodes(provider).find((n) => n.taskName === "held_row")!);
      assert.doesNotMatch(String(cleared.description), /waiting to run/);
      assert.equal(cleared.contextValue, "ensemble-operation-cancellable");
    } finally {
      taskOperations.setHeldAnswerForTaskV1(taskPath, undefined);
      taskOperations.end(op);
      provider.dispose();
    }
  });
});
