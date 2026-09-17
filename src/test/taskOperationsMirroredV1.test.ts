/**
 * A viewer shows the runner's operations through its own registry
 * (TaskOperationRegistry.setMirroredOperations): every display query sees
 * them, nothing that locks, hands out tokens or persists does.
 */
import * as assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { TaskOperationRegistry, TaskOperationSnapshot } from "../utils/taskOperations";

const TASK = process.platform === "win32" ? "C:\\w\\.ensemble\\2026-09-17_task_3" : "/w/.ensemble/2026-09-17_task_3";

function mirrored(overrides: Partial<TaskOperationSnapshot> & { id: string }): TaskOperationSnapshot {
  return {
    key: TASK,
    label: "Fast Forward Review",
    taskName: "Increase Spacing",
    startedAt: 1000,
    exclusive: true,
    cancellable: true,
    state: "running",
    waitingForUser: false,
    ...overrides,
  };
}

void describe("TaskOperationRegistry mirrored operations", () => {
  let registry: TaskOperationRegistry;
  beforeEach(() => {
    registry = new TaskOperationRegistry();
  });

  void it("puts the spinner on the leaf stage the runner is working on, and counts as running", () => {
    registry.setMirroredOperations([
      mirrored({ id: "op-1", stage: "impl-low-review", kind: "review" }),
      mirrored({ id: "op-2", parentId: "op-1", label: "Implementation", stage: "impl", exclusive: false, startedAt: 2000 }),
    ]);
    assert.deepEqual(registry.getActiveStages(TASK), ["impl"], "stage level, not the task or the composite root");
    assert.equal(registry.hasAnyRunning(), true);
    assert.equal(registry.hasAny(), true);
    const roots = registry.getRootOperations();
    assert.equal(roots.length, 1);
    assert.equal(roots[0]!.id, "runner:op-1");
    assert.equal(registry.getDisplayStage("runner:op-1"), "impl");
    assert.equal(registry.getTaskOperations(TASK).length, 2);
  });

  void it("never locks, tokens or ids for local work: a local begin still succeeds and owns the task", () => {
    registry.setMirroredOperations([mirrored({ id: "op-1", stage: "impl" })]);
    const local = registry.begin(TASK, { label: "Pause Task" });
    assert.ok(local, "the runner's work does not refuse local admission");
    assert.equal(registry.rootOperationIdFor(TASK), local.id);
    assert.notEqual(local.id, "runner:op-1");
    registry.end(local);
    assert.equal(registry.tokenFor(TASK), undefined);
  });

  void it("a waiting runner operation shows waiting, not spinning", () => {
    registry.setMirroredOperations([mirrored({ id: "op-1", stage: "impl-low-review", waitingForUser: true })]);
    assert.deepEqual(registry.getActiveStages(TASK), []);
    assert.deepEqual(registry.getWaitingStages(TASK), ["impl-low-review"]);
    assert.equal(registry.hasAnyRunning(), false);
  });

  void it("fires a change only when the mirrored set changes, and clears", async () => {
    let changes = 0;
    registry.onDidChange(() => changes++);
    const ops = [mirrored({ id: "op-1", stage: "impl" })];
    registry.setMirroredOperations(ops);
    await Promise.resolve();
    registry.setMirroredOperations([...ops]);
    await Promise.resolve();
    assert.equal(changes, 1);
    registry.setMirroredOperations([]);
    await Promise.resolve();
    assert.equal(changes, 2);
    assert.equal(registry.hasAny(), false);
    assert.deepEqual(registry.getActiveStages(TASK), []);
  });

  void it("cancel goes to the owning window with its own id; nothing to send it to means not cancellable", () => {
    registry.setMirroredOperations([
      mirrored({ id: "op-1", stage: "impl" }),
      mirrored({ id: "op-9", key: `${TASK}x`, stage: "plan", cancellable: false }),
    ]);
    assert.equal(registry.cancelOperation("runner:op-1"), false, "no cancel route configured");
    const sent: string[] = [];
    registry.configureMirroredOperationCancel((id) => sent.push(id));
    assert.equal(registry.cancelOperation("runner:op-1"), true);
    assert.equal(registry.cancelOperation("runner:op-9"), false, "the runner said it cannot be cancelled");
    assert.deepEqual(sent, ["op-1"]);
    assert.equal(registry.getRootOperations().find((op) => op.id === "runner:op-1")?.detail, "cancelling…");
  });
});
