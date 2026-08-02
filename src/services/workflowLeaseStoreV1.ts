/**
 * Runtime task-operation lease store (plan §1.8 / §3.9).
 *
 * One in-memory lease per task binding: the coordinator acquires before
 * running an operation against a task and releases in its outermost finally.
 * A second acquisition against a held binding returns the stable
 * `duplicateRejected` coordinator outcome instead of queueing or throwing.
 *
 * Leases are runtime/private-control records ONLY. This module deliberately
 * imports no filesystem or serialization machinery: a lease can never be
 * written into task-progress.json, and losing the extension host releases
 * everything by construction (no stale on-disk lease to recover). The
 * persisted `ownership` binding is a different concept and is never touched
 * here (plan §3.9: "Operation leases must never overwrite or clear
 * persisted ownership").
 */
import { ActionKeyV1, allocateHex128IdV1, OperationIdV1 } from "../types/actionCorrelationV1";
import { DuplicateRejectedOutcomeV1, duplicateRejectedV1 } from "../types/taskActionOutcomeV1";
import { TaskOperationLeaseV1 } from "../types/taskOperationLeaseV1";

export type TaskOperationLeaseAcquireResultV1 =
  | { readonly ok: true; readonly lease: TaskOperationLeaseV1 }
  | { readonly ok: false; readonly outcome: DuplicateRejectedOutcomeV1 };

export interface WorkflowLeaseStoreV1 {
  /** Acquire the single operation lease for a task binding, or reject the duplicate. */
  acquire(
    taskBindingId: string,
    actionKey: ActionKeyV1,
    operationId: OperationIdV1
  ): TaskOperationLeaseAcquireResultV1;
  /**
   * Release by lease id. Returns false (a no-op) when the id is unknown or
   * already released — a late double-release in a finally block must never
   * free a NEWER lease another operation now holds.
   */
  release(leaseId: string): boolean;
  /** The lease currently held for a binding, if any. */
  heldLease(taskBindingId: string): TaskOperationLeaseV1 | undefined;
  /**
   * Acquire a NESTED lease for a child action that runs, on the SAME task
   * binding, strictly inside an already-admitted parent operation's own held
   * lease — e.g. `commitPush.v1`'s `execute` invoking the `commitPushMetadata.v1`
   * provider row against the same task while its own lease is still held,
   * which a plain `acquire` against an already-locked binding would reject
   * as a (false-positive) duplicate and self-deadlock.
   *
   * Legal ONLY while `parentOperationId` names the binding's CURRENTLY held
   * lease's operation: only the workflow that already proved exclusive
   * access to this binding can ever learn its own `operationId` and pass it
   * back in, so this can never let two INDEPENDENT operations hold the same
   * binding concurrently — the base `acquire`/`heldLease` exclusivity for
   * that binding is unchanged (plan §3.9/§10: a real concurrency-safety
   * property, not cosmetic access).
   *
   * A child lease is tracked separately from the binding-level slot: it
   * never appears in `heldLease`, and releasing it (via the ordinary
   * `release(leaseId)`) never frees the parent's hold. Releasing the PARENT
   * also releases any of its still-open children, so a caller that forgets
   * to release a child before its parent can never leak a phantom lock.
   */
  acquireChild(
    taskBindingId: string,
    parentOperationId: OperationIdV1,
    actionKey: ActionKeyV1,
    operationId: OperationIdV1
  ): TaskOperationLeaseAcquireResultV1;
}

class WorkflowLeaseStoreImplV1 implements WorkflowLeaseStoreV1 {
  private readonly leasesByBinding = new Map<string, TaskOperationLeaseV1>();
  private readonly childLeasesById = new Map<
    string,
    { readonly parentLeaseId: string; readonly lease: TaskOperationLeaseV1 }
  >();

  constructor(private readonly now: () => string) {}

  acquire(
    taskBindingId: string,
    actionKey: ActionKeyV1,
    operationId: OperationIdV1
  ): TaskOperationLeaseAcquireResultV1 {
    if (this.leasesByBinding.has(taskBindingId)) {
      return { ok: false, outcome: duplicateRejectedV1() };
    }
    const lease: TaskOperationLeaseV1 = {
      leaseId: allocateHex128IdV1(),
      actionKey,
      operationId,
      taskBindingId,
      acquiredAt: this.now(),
    };
    this.leasesByBinding.set(taskBindingId, lease);
    return { ok: true, lease };
  }

  acquireChild(
    taskBindingId: string,
    parentOperationId: OperationIdV1,
    actionKey: ActionKeyV1,
    operationId: OperationIdV1
  ): TaskOperationLeaseAcquireResultV1 {
    const parent = this.leasesByBinding.get(taskBindingId);
    if (!parent || parent.operationId !== parentOperationId) {
      // No matching parent hold for THIS binding: reject exactly like a
      // duplicate. This is the entire safety property — a child can only
      // ever be granted to the operation that already exclusively holds the
      // binding, never to an unrelated caller.
      return { ok: false, outcome: duplicateRejectedV1() };
    }
    const lease: TaskOperationLeaseV1 = {
      leaseId: allocateHex128IdV1(),
      actionKey,
      operationId,
      taskBindingId,
      acquiredAt: this.now(),
    };
    this.childLeasesById.set(lease.leaseId, { parentLeaseId: parent.leaseId, lease });
    return { ok: true, lease };
  }

  release(leaseId: string): boolean {
    if (this.childLeasesById.has(leaseId)) {
      this.childLeasesById.delete(leaseId);
      return true;
    }
    for (const [bindingId, lease] of this.leasesByBinding) {
      if (lease.leaseId === leaseId) {
        this.leasesByBinding.delete(bindingId);
        for (const [childId, entry] of this.childLeasesById) {
          if (entry.parentLeaseId === leaseId) {
            this.childLeasesById.delete(childId);
          }
        }
        return true;
      }
    }
    return false;
  }

  heldLease(taskBindingId: string): TaskOperationLeaseV1 | undefined {
    return this.leasesByBinding.get(taskBindingId);
  }
}

export function createWorkflowLeaseStoreV1(
  now: () => string = (): string => new Date().toISOString()
): WorkflowLeaseStoreV1 {
  return new WorkflowLeaseStoreImplV1(now);
}
