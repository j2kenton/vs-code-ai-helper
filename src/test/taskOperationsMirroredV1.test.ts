/**
 * A viewer shows the runner's operations through its own registry
 * (TaskOperationRegistry.setMirroredOperations): every display query sees
 * them, nothing that locks, hands out tokens or persists does.
 */
import * as assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { describeOtherTaskChangingCodeV1, TaskOperationRegistry, TaskOperationSnapshot } from "../utils/taskOperations";

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

  void it("holds the task's exclusive lock: a second writer here is refused while the runner owns it", () => {
    registry.setMirroredOperations([mirrored({ id: "op-1", stage: "impl" })]);
    assert.equal(
      registry.begin(TASK, { label: "Revert Stage Changes" }),
      null,
      "starting a local writer against a task the runner is mid-write on would race its artifacts"
    );
    assert.equal(registry.busyLabel(TASK), "Fast Forward Review", "and the refusal can name what holds it");
    // Advisory (non-exclusive) work is unaffected, exactly as it is locally.
    const advisory = registry.begin(TASK, { label: "Chat", exclusive: false });
    assert.ok(advisory);
    registry.end(advisory);
    // Ids, tokens and root-id lookups stay local-only: nothing here can
    // cancel or stamp the runner's work by accident.
    assert.equal(registry.rootOperationIdFor(TASK), undefined);
    assert.equal(registry.tokenFor(TASK), undefined);
    registry.setMirroredOperations([]);
    const local = registry.begin(TASK, { label: "Pause Task" });
    assert.ok(local, "and the lock is released as soon as the runner's work is gone");
    assert.notEqual(local.id, "runner:op-1");
    registry.end(local);
  });

  void it("separates its own operations from the runner's, for the code that must not touch theirs", () => {
    registry.setMirroredOperations([mirrored({ id: "op-1", stage: "impl" })]);
    const local = registry.begin(TASK, { label: "Chat", exclusive: false });
    assert.ok(local);
    assert.deepEqual(registry.getLocalTaskOperations(TASK).map((op) => op.label), ["Chat"]);
    assert.deepEqual(registry.getMirroredTaskOperations(TASK).map((op) => op.id), ["runner:op-1"]);
    assert.equal(registry.getTaskOperations(TASK).length, 2, "display sees both");
    assert.equal(registry.hasRootOperationForTask(TASK), true);
    registry.end(local);
    assert.equal(registry.hasRootOperationForTask(TASK), true, "the runner's root still counts");
    registry.setMirroredOperations([]);
    assert.equal(registry.hasRootOperationForTask(TASK), false);
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

void describe("one code-changing round per workspace (run1 Step 24)", () => {
  const OTHER = process.platform === "win32" ? "C:\\w\\.ensemble\\2026-09-17_task_4" : "/w/.ensemble/2026-09-17_task_4";
  const ELSEWHERE = process.platform === "win32" ? "C:\\x\\.ensemble\\2026-09-17_task_9" : "/x/.ensemble/2026-09-17_task_9";

  void it("a second code-changing round in the same workspace is refused, naming who is changing code", () => {
    const registry = new TaskOperationRegistry();
    registry.setMirroredOperations([mirrored({ id: "op-1", kind: "apply-review", label: "Apply Review", taskName: "Increase Spacing" })]);
    assert.equal(registry.begin(OTHER, { label: "Run Implementation", kind: "run-implementation" }), null);
    assert.deepEqual(registry.otherTaskChangingCodeV1(OTHER), { taskName: "Increase Spacing", label: "Apply Review" });
    assert.equal(
      describeOtherTaskChangingCodeV1({ taskName: "Increase Spacing" }),
      "Increase Spacing is changing code in this workspace; start this when it ends."
    );
  });

  void it("a review, another workspace, the task's own work and an ended round are not refused", () => {
    const registry = new TaskOperationRegistry();
    const local = registry.begin(TASK, { label: "Run Implementation", kind: "run-implementation", taskName: "A" });
    assert.ok(local);
    const review = registry.begin(OTHER, { label: "Review", kind: "review" });
    assert.ok(review, "a review changes no code");
    registry.end(review);
    const elsewhere = registry.begin(ELSEWHERE, { label: "Run Implementation", kind: "run-implementation" });
    assert.ok(elsewhere, "another workspace has its own tree");
    registry.end(elsewhere);
    assert.equal(registry.otherTaskChangingCodeV1(TASK), undefined, "the task's own operations are not 'another task'");
    assert.equal(registry.begin(OTHER, { label: "Apply Review", kind: "apply-review" }), null);
    registry.end(local);
    const after = registry.begin(OTHER, { label: "Apply Review", kind: "apply-review" });
    assert.ok(after, "start is allowed once the other round has ended");
    registry.end(after);
  });

  void it("a Fast Forward Apply Review child is refused while a sibling task's code-changing round is live", () => {
    const registry = new TaskOperationRegistry();
    const forward = registry.begin(TASK, { label: "Fast Forward Review", kind: "fast-forward", taskName: "A" });
    assert.ok(forward);
    const sibling = registry.begin(OTHER, { label: "Apply Review", kind: "apply-review", taskName: "B" });
    assert.ok(sibling, "the sibling's round started after Fast Forward, which itself changes no code");
    assert.equal(
      registry.begin(TASK, { parent: forward, label: "Apply Review", kind: "apply-review" }),
      null,
      "the child changes code, so it is refused before it starts"
    );
    assert.equal(registry.getTaskOperations(OTHER).length, 1, "nothing running was aborted");
    registry.end(sibling);
    const child = registry.begin(TASK, { parent: forward, label: "Apply Review", kind: "apply-review" });
    assert.ok(child, "allowed once the sibling's round has ended");
    registry.end(child);
    registry.end(forward);
  });

  void it("a root and a child in the same task's own chain are not refused by each other", () => {
    const registry = new TaskOperationRegistry();
    const root = registry.begin(TASK, { label: "Run Implementation", kind: "run-implementation", taskName: "A" });
    assert.ok(root);
    const child = registry.begin(TASK, { parent: root, label: "Apply Review", kind: "apply-review" });
    assert.ok(child, "the same task's chain does not block itself");
    registry.end(child);
    registry.end(root);
  });
});

void describe("TaskOperationRegistry.rootOperationForPauseV1 (run1 Step 31)", () => {
  void it("a viewer window gets the runner's mirrored root, its Fast Forward kind, and a cancel that relays", () => {
    const registry = new TaskOperationRegistry();
    registry.setMirroredOperations([
      mirrored({ id: "op-1", kind: "fast-forward" }),
      mirrored({ id: "op-2", parentId: "op-1", label: "Apply Review", exclusive: false, startedAt: 2000 }),
    ]);
    assert.equal(registry.rootOperationIdFor(TASK), undefined, "the local-only lookup finds nothing in a viewer");
    const root = registry.rootOperationForPauseV1(TASK);
    assert.deepEqual(root, { id: "runner:op-1", isFastForward: true });
    const sent: string[] = [];
    registry.configureMirroredOperationCancel((id) => sent.push(id));
    assert.equal(registry.cancelOperation(root.id, "notifications"), true);
    assert.deepEqual(sent, ["op-1"]);
  });

  void it("a non-Fast-Forward mirrored root says so, a local root wins, and no root gives nothing", () => {
    const registry = new TaskOperationRegistry();
    assert.equal(registry.rootOperationForPauseV1(TASK), undefined);
    registry.setMirroredOperations([mirrored({ id: "op-1", kind: "review" })]);
    assert.deepEqual(registry.rootOperationForPauseV1(TASK), { id: "runner:op-1", isFastForward: false });
    registry.setMirroredOperations([]);
    const local = registry.begin(TASK, { label: "Review", kind: "fast-forward" });
    assert.ok(local);
    assert.equal(registry.rootOperationForPauseV1(TASK)?.id, local.id);
    assert.equal(registry.rootOperationForPauseV1(TASK)?.isFastForward, true);
    registry.end(local);
  });
});
