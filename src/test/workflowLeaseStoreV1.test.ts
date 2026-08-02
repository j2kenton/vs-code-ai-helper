/**
 * Coverage for the §3.9 runtime lease store: one lease per task binding,
 * stable duplicateRejected outcome, id-exact release, and no interference
 * across bindings.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { allocateHex128IdV1, isHex128IdV1 } from "../types/actionCorrelationV1";
import { createWorkflowLeaseStoreV1 } from "../services/workflowLeaseStoreV1";

void describe("workflowLeaseStoreV1", () => {
  void it("acquires a lease with a fresh id and the injected clock", () => {
    const store = createWorkflowLeaseStoreV1(() => "2026-07-26T12:00:00.000Z");
    const result = store.acquire("binding-a", "generatePlan.v1", allocateHex128IdV1());
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(isHex128IdV1(result.lease.leaseId), true);
      assert.equal(result.lease.taskBindingId, "binding-a");
      assert.equal(result.lease.actionKey, "generatePlan.v1");
      assert.equal(result.lease.acquiredAt, "2026-07-26T12:00:00.000Z");
      assert.deepEqual(store.heldLease("binding-a"), result.lease);
    }
  });

  void it("rejects a duplicate acquisition with the stable coordinator outcome", () => {
    const store = createWorkflowLeaseStoreV1();
    const first = store.acquire("binding-a", "generatePlan.v1", allocateHex128IdV1());
    assert.equal(first.ok, true);
    const second = store.acquire("binding-a", "draft.v1", allocateHex128IdV1());
    assert.equal(second.ok, false);
    if (!second.ok) {
      assert.deepEqual(second.outcome, { kind: "duplicateRejected", code: "operationAlreadyRunning" });
    }
    // A different task binding is unaffected.
    assert.equal(store.acquire("binding-b", "draft.v1", allocateHex128IdV1()).ok, true);
  });

  void it("releases by exact lease id and allows reacquisition", () => {
    const store = createWorkflowLeaseStoreV1();
    const first = store.acquire("binding-a", "generatePlan.v1", allocateHex128IdV1());
    assert.equal(first.ok, true);
    if (!first.ok) {
      return;
    }
    assert.equal(store.release(first.lease.leaseId), true);
    assert.equal(store.heldLease("binding-a"), undefined);
    // Double release is a no-op...
    assert.equal(store.release(first.lease.leaseId), false);

    const second = store.acquire("binding-a", "draft.v1", allocateHex128IdV1());
    assert.equal(second.ok, true);
    // ...and a stale id can never free the newer lease.
    assert.equal(store.release(first.lease.leaseId), false);
    assert.notEqual(store.heldLease("binding-a"), undefined);
  });

  void describe("acquireChild", () => {
    void it("grants a nested lease while the matching parent operation holds the binding", () => {
      const store = createWorkflowLeaseStoreV1();
      const parentOperationId = allocateHex128IdV1();
      const parent = store.acquire("binding-a", "commitPush.v1", parentOperationId);
      assert.equal(parent.ok, true);
      const child = store.acquireChild(
        "binding-a",
        parentOperationId,
        "commitPushMetadata.v1",
        allocateHex128IdV1()
      );
      assert.equal(child.ok, true);
      if (child.ok) {
        assert.equal(isHex128IdV1(child.lease.leaseId), true);
        assert.equal(child.lease.actionKey, "commitPushMetadata.v1");
        // The child never becomes the binding's own held lease — the parent
        // remains the authoritative binding-level holder throughout.
        assert.deepEqual(store.heldLease("binding-a"), parent.ok ? parent.lease : undefined);
      }
    });

    void it("rejects a child when no parent lease is held for the binding", () => {
      const store = createWorkflowLeaseStoreV1();
      const result = store.acquireChild(
        "binding-a",
        allocateHex128IdV1(),
        "commitPushMetadata.v1",
        allocateHex128IdV1()
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.deepEqual(result.outcome, { kind: "duplicateRejected", code: "operationAlreadyRunning" });
      }
    });

    void it("rejects a child whose parentOperationId does not match the binding's ACTUAL held operation (no cross-operation nesting)", () => {
      const store = createWorkflowLeaseStoreV1();
      const realOperationId = allocateHex128IdV1();
      const acquired = store.acquire("binding-a", "commitPush.v1", realOperationId);
      assert.equal(acquired.ok, true);
      // An unrelated caller guessing/asserting a DIFFERENT operation id must
      // never be granted a child against this binding — this is the core
      // safety property: a child can only ever be issued to the operation
      // that already exclusively holds the binding, so two independent
      // operations can never both act on the same task concurrently.
      const impostor = store.acquireChild(
        "binding-a",
        allocateHex128IdV1(),
        "commitPushMetadata.v1",
        allocateHex128IdV1()
      );
      assert.equal(impostor.ok, false);
      if (!impostor.ok) {
        assert.deepEqual(impostor.outcome, { kind: "duplicateRejected", code: "operationAlreadyRunning" });
      }
    });

    void it("does not let a plain acquire() on the same binding succeed while a parent lease is held (base exclusivity unchanged)", () => {
      const store = createWorkflowLeaseStoreV1();
      const parentOperationId = allocateHex128IdV1();
      store.acquire("binding-a", "commitPush.v1", parentOperationId);
      const unrelated = store.acquire("binding-a", "implementation.v1", allocateHex128IdV1());
      assert.equal(unrelated.ok, false);
    });

    void it("releasing a child never releases the parent's binding-level hold", () => {
      const store = createWorkflowLeaseStoreV1();
      const parentOperationId = allocateHex128IdV1();
      const parent = store.acquire("binding-a", "commitPush.v1", parentOperationId);
      assert.equal(parent.ok, true);
      const child = store.acquireChild("binding-a", parentOperationId, "commitPushMetadata.v1", allocateHex128IdV1());
      assert.equal(child.ok, true);
      if (!child.ok) {
        return;
      }
      assert.equal(store.release(child.lease.leaseId), true);
      assert.notEqual(store.heldLease("binding-a"), undefined);
      // A second child can be acquired afterward exactly as before.
      const secondChild = store.acquireChild(
        "binding-a",
        parentOperationId,
        "commitPushMetadata.v1",
        allocateHex128IdV1()
      );
      assert.equal(secondChild.ok, true);
    });

    void it("releasing the parent also releases any still-open child, leaving no phantom lock", () => {
      const store = createWorkflowLeaseStoreV1();
      const parentOperationId = allocateHex128IdV1();
      const parent = store.acquire("binding-a", "commitPush.v1", parentOperationId);
      assert.equal(parent.ok, true);
      if (!parent.ok) {
        return;
      }
      const child = store.acquireChild("binding-a", parentOperationId, "commitPushMetadata.v1", allocateHex128IdV1());
      assert.equal(child.ok, true);
      if (!child.ok) {
        return;
      }
      // Parent releases first (mirrors a caller that forgets/skips an
      // explicit child release before its own outermost finally runs).
      assert.equal(store.release(parent.lease.leaseId), true);
      assert.equal(store.heldLease("binding-a"), undefined);
      // The now-orphaned child id is already gone — no double-free crash,
      // and it can never be mistaken for a live lock on a future lookup.
      assert.equal(store.release(child.lease.leaseId), false);
      // The binding is fully free: a fresh, unrelated acquire succeeds.
      const fresh = store.acquire("binding-a", "implementation.v1", allocateHex128IdV1());
      assert.equal(fresh.ok, true);
    });
  });
});
