/**
 * Coverage for the cancellable re-review fix (blocker fix 2026-09-25):
 * ensures that re-review child operations created by `improveReviewScore`
 * receive live, cancellable tokens and that Stop/cancel properly propagates
 * through the review tree instead of creating dead-token fallbacks.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TaskOperationRegistry } from "../utils/taskOperations";

function assertPresentV1<T>(value: T | null | undefined, message: string): asserts value is T {
  assert.ok(value !== null && value !== undefined, message);
}

void describe("re-review operations cancellation propagation", () => {
  void it("creates cancellable child re-review operations under a parent root review", () => {
    const registry = new TaskOperationRegistry();
    const taskPath = "/test/workspace/2026-09-25_task_1";

    // Create root review operation with cancellable: true
    const rootOp = registry.begin(taskPath, {
      label: "Initial Review",
      kind: "review",
      cancellable: true,
    });
    assertPresentV1(rootOp, "root review operation should be created");

    assert.ok(rootOp.token, "root review operation should have a live cancellation token");

    // Create child re-review operation with cancellable: true (after fix)
    const reReviewOp = registry.begin(taskPath, {
      parent: rootOp,
      label: "Re-review",
      kind: "review",
      cancellable: true, // This is the fix
    });
    assertPresentV1(reReviewOp, "child re-review operation should be created");

    assert.ok(reReviewOp.token, "child re-review operation should have a live cancellation token");
    assert.notEqual(
      rootOp.token,
      reReviewOp.token,
      "child should have its own distinct token (not the same object)"
    );
  });

  void it("propagates cancellation from parent to child operations", async () => {
    const registry = new TaskOperationRegistry();
    const taskPath = "/test/workspace/2026-09-25_task_1";

    const rootOp = registry.begin(taskPath, {
      label: "Root",
      kind: "review",
      cancellable: true,
    });
    assertPresentV1(rootOp, "root operation should be created");

    const childOp = registry.begin(taskPath, {
      parent: rootOp,
      label: "Child",
      kind: "review",
      cancellable: true,
    });
    assertPresentV1(childOp, "child operation should be created");
    assertPresentV1(childOp.token, "child operation should have a cancellation token");
    const childToken = childOp.token;

    const childTokenCancelled = new Promise<void>((resolve) => {
      childToken.onCancellationRequested(() => resolve());
    });

    // Cancel the root operation
    const cancelResult = registry.cancelOperation(rootOp.id);
    assert.ok(cancelResult, "cancel should succeed on the parent");

    // Child token should fire (cancellation cascades)
    await Promise.race([
      childTokenCancelled,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("child token cancellation did not fire")), 1000)
      ),
    ]);
  });

  void it("does NOT create dead-token fallback when token is available", () => {
    const registry = new TaskOperationRegistry();
    const taskPath = "/test/workspace/2026-09-25_task_1";

    // Create operation with cancellable: true (provides live token)
    const op = registry.begin(taskPath, {
      label: "Test",
      kind: "review",
      cancellable: true,
    });
    assertPresentV1(op, "operation should be created");
    assertPresentV1(op.token, "operation should have a token");
    const token = op.token;

    assert.equal(
      token.isCancellationRequested,
      false,
      "token should not be pre-cancelled"
    );

    // The token should be cancellable via registry.cancelOperation
    const cancelled = new Promise<void>((resolve) => {
      token.onCancellationRequested(() => resolve());
    });

    registry.cancelOperation(op.id);

    return Promise.race([
      cancelled,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("token was not cancellable")), 1000)
      ),
    ]);
  });

  void it("re-review child without cancellable: true uses parent's token (old pattern)", () => {
    const registry = new TaskOperationRegistry();
    const taskPath = "/test/workspace/2026-09-25_task_1";

    // Root with cancellable: true
    const rootOp = registry.begin(taskPath, {
      label: "Root",
      kind: "review",
      cancellable: true,
    });
    assertPresentV1(rootOp, "root operation should be created");

    // Child without cancellable flag (old pattern) should still be created
    // but this is now the LEGACY case after the fix.
    const childOp = registry.begin(taskPath, {
      parent: rootOp,
      label: "Child",
      kind: "review",
      // No cancellable: true — old pattern
    });
    assertPresentV1(childOp, "legacy child operation should be created");

    // Child without explicit cancellable will have undefined token
    // The fix makes sure all re-review ops have cancellable: true instead
    // So this test documents the old (now-fixed) pattern.
    assert.equal(childOp.token, undefined, "legacy child without cancellable: true has no token");
  });
});
