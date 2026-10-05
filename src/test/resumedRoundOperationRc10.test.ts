/**
 * RC10 item 1: a round resumed by answering an in-chat question registers its
 * own tracked operation (`runResumedRoundOperationV1`), so the task's row and
 * the Notifications panel show it running. The helper adds no guard, wait or
 * lock: it is non-exclusive, carries no conflict keys and never refuses.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { runResumedRoundOperationV1, runTrackedOperation, taskOperations } from "../utils/taskOperations";

function freshTaskPath(): string {
  return `/tmp/rc10-resumed-${Math.random().toString(36).slice(2)}`;
}

const SPEC = { label: "Apply Review", stage: "plan", kind: "apply-review", displayName: "Renamed task" } as const;

void describe("runResumedRoundOperationV1 (RC10 item 1)", () => {
  void it("registers a running, non-exclusive, cancellable root operation with the given label and stage", async () => {
    const taskPath = freshTaskPath();
    let seen: ReturnType<typeof taskOperations.getTaskOperations> = [];
    const result = await runResumedRoundOperationV1(taskPath, { ...SPEC, activity: "Applying review fixes…" }, () => {
      seen = taskOperations.getTaskOperations(taskPath).map((o) => ({ ...o }));
      return Promise.resolve("outcome");
    });
    assert.equal(result, "outcome");
    assert.equal(seen.length, 1);
    const op = seen[0]!;
    assert.equal(op.state, "running");
    assert.equal(op.label, "Apply Review");
    assert.equal(op.stage, "plan");
    assert.equal(op.kind, "apply-review");
    assert.equal(op.taskName, "Renamed task");
    assert.equal(op.exclusive, false);
    assert.equal(op.cancellable, true);
    assert.equal(op.parentId, undefined);
    assert.equal(op.activity, "Applying review fixes…");
    assert.deepEqual(taskOperations.getTaskOperations(taskPath), [], "ended once the round returns");
  });

  void it("is admitted while an exclusive operation holds the task, and admits an exclusive one started inside it", async () => {
    const taskPath = freshTaskPath();
    const holder = taskOperations.begin(taskPath, { label: "Holder" });
    assert.ok(holder, "precondition: the exclusive holder is admitted");
    try {
      let ran = false;
      await runResumedRoundOperationV1(taskPath, SPEC, () => {
        ran = true;
        return Promise.resolve(true);
      });
      assert.equal(ran, true);
    } finally {
      taskOperations.end(holder, "succeeded");
    }

    let nestedRan = false;
    await runResumedRoundOperationV1(taskPath, SPEC, async () => {
      const nested = await runTrackedOperation(taskPath, { label: "Re-running review", stage: "plan" }, () => {
        nestedRan = true;
        return Promise.resolve(true);
      });
      assert.equal(nested, true, "an exclusive operation started inside the resumed round is admitted");
      return true;
    });
    assert.equal(nestedRan, true);
  });

  void it("ends the operation as failed and rethrows when the round throws", async () => {
    const taskPath = freshTaskPath();
    const ended: string[] = [];
    const sub = taskOperations.onDidEnd?.((snapshot: { state: string }) => ended.push(snapshot.state));
    try {
      await assert.rejects(
        runResumedRoundOperationV1(taskPath, SPEC, () => Promise.reject(new Error("provider exploded"))),
        /provider exploded/
      );
    } finally {
      sub?.dispose();
    }
    assert.deepEqual(taskOperations.getTaskOperations(taskPath), []);
    if (sub) {
      assert.deepEqual(ended, ["failed"]);
    }
  });

  void it("cancelOperation cancels the token the round runs under", async () => {
    const taskPath = freshTaskPath();
    let token: vscode.CancellationToken | undefined;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const running = runResumedRoundOperationV1(taskPath, SPEC, async (op) => {
      token = op.token;
      await gate;
      return true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const [snapshot] = taskOperations.getTaskOperations(taskPath);
    assert.ok(snapshot, "the operation is registered synchronously");
    assert.ok(token, "the handle exposes a token");
    assert.equal(token.isCancellationRequested, false);
    assert.equal(taskOperations.cancelOperation(snapshot.id), true);
    assert.equal(token.isCancellationRequested, true);
    release();
    await running;
  });

  void it("throws instead of adding a refusal path when no result is produced", async () => {
    const taskPath = freshTaskPath();
    await assert.rejects(
      runResumedRoundOperationV1<undefined>(taskPath, SPEC, () => Promise.resolve(undefined)),
      /produced no result/
    );
    assert.deepEqual(taskOperations.getTaskOperations(taskPath), []);
  });
});
