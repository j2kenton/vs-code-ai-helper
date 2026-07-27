/**
 * Runtime task-operation lease record (plan §3.9).
 *
 * A lease says "this task binding currently has a coordinator operation in
 * flight". It lives ONLY in memory (workflowLeaseStoreV1) — it is never
 * read from or written to task-progress.json, and releasing or losing a
 * lease never touches the persisted `ownership` binding. Keeping the type in
 * its own module (with no serializer) is deliberate: nothing can
 * accidentally spread a lease into a persisted progress patch without the
 * import standing out in review.
 */
import { ActionKeyV1, OperationIdV1 } from "./actionCorrelationV1";

export interface TaskOperationLeaseV1 {
  /** 128-bit random lease identity (allocateHex128IdV1). */
  readonly leaseId: string;
  readonly actionKey: ActionKeyV1;
  readonly operationId: OperationIdV1;
  /** The task binding digest from taskBindingV1 — never a raw path. */
  readonly taskBindingId: string;
  /** ISO timestamp from the store's injected clock. */
  readonly acquiredAt: string;
}
