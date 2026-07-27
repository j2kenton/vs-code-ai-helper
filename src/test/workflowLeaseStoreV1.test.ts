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
});
