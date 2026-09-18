import type { TaskOperationSnapshot } from "../utils/taskOperations";

/**
 * Ends operations whose work has plainly stopped, so the UI can never again
 * advertise a round that is not running.
 *
 * The incident this exists for (2026-09-17, on the cloud runner): a Fast
 * Forward's review round invoked a provider CLI that exited two seconds later
 * with "You've hit your usage limit", and nothing unwound the round. The
 * operation stayed `running` in the in-memory registry for seven hours — a
 * spinner, a progress bar and a Notifications row, all reporting work that had
 * stopped — and pressing Stop reported "can no longer be cancelled" because
 * its token had already been fired with nobody listening. Only reloading the
 * window cleared it.
 *
 * Chasing the individual await that hung is not a fix: any provider, any
 * dialog, any lock can produce the same shape. What every case has in common
 * is that the round stops RENEWING its work admission
 * (`workAdmissionRenewalAgeMsV1`) — that marker is renewed every two minutes
 * by the code that owns the run, from the same process, and it is the only
 * durable evidence that the owner is still alive.
 *
 * Deliberately conservative: an operation is reaped only when its task holds
 * admission that has gone unrenewed well past the heartbeat interval. An
 * operation with no admission marker at all is never reaped (a task-level
 * action such as a rename holds none), and neither is one that is merely
 * waiting for the user — waiting is not stalling.
 */

/** Long enough that a renewal cannot simply have been slow (heartbeat is 2 min). */
export const ABANDONED_OPERATION_RENEWAL_AGE_MS_V1 = 20 * 60 * 1000;

export interface AbandonedOperationV1 {
  readonly id: string;
  readonly label: string;
  readonly taskName: string;
  readonly taskPath: string;
  /** How long its admission had gone unrenewed when it was judged abandoned. */
  readonly unrenewedForMs: number;
}

/**
 * Which of `operations` have stopped, given a way to read each task's
 * admission-renewal age. Pure, so the rule is testable without a clock, a
 * filesystem or VS Code.
 */
export function findAbandonedOperationsV1(
  operations: readonly TaskOperationSnapshot[],
  renewalAgeMs: (taskPath: string) => number | undefined,
  thresholdMs: number = ABANDONED_OPERATION_RENEWAL_AGE_MS_V1
): readonly AbandonedOperationV1[] {
  const abandoned: AbandonedOperationV1[] = [];
  for (const op of operations) {
    // Roots only: ending a root cascades to its children, and a child never
    // owns admission of its own.
    if (op.parentId !== undefined || op.state !== "running") {
      continue;
    }
    // Waiting on a person is not stalling, however long it lasts.
    if (op.waitingForUser) {
      continue;
    }
    const age = renewalAgeMs(op.key);
    if (age === undefined || age <= thresholdMs) {
      continue;
    }
    abandoned.push({
      id: op.id,
      label: op.label,
      taskName: op.taskName,
      taskPath: op.key,
      unrenewedForMs: age,
    });
  }
  return abandoned;
}

/** What the user is told when one is reaped. Names the work and what to do. */
export function describeAbandonedOperationV1(operation: AbandonedOperationV1): string {
  const minutes = Math.round(operation.unrenewedForMs / 60000);
  return (
    `${operation.label} — "${operation.taskName}" stopped without reporting: it held this task for ` +
    `${minutes} min without renewing its claim, so it is no longer shown as running. ` +
    `Check its run log for how far it got, then start it again.`
  );
}
