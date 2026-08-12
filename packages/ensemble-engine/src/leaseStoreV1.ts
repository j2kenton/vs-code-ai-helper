/**
 * Single-worker job lease (plan Parts 4c/5).
 *
 * Post-decision resumption runs under a lease so two engine workers can
 * never concurrently act on one approval: a leased job row with a holder,
 * heartbeat renewal, and expiry. The lease is NECESSARY BUT NOT SUFFICIENT
 * for duplicate-execution safety — a lease can be lost mid-effect (crash,
 * network partition, clock skew past TTL), so the durable
 * execution-attempt/effect protocol (`executionAttemptStoreV1.ts` +
 * `gateMachineryV1.ts`) is what actually prevents duplicates: whichever
 * worker holds the lease next always consults attempt records and
 * reconciles or re-offers before re-issuing any external call.
 *
 * The in-memory reference implementation is for tests and single-process
 * dev; Part 5 implements the same interface as a leased job row with
 * heartbeat and expiry columns.
 */

export interface EngineLeaseAcquireResultV1 {
  readonly acquired: boolean;
  /** Present when another worker holds an unexpired lease. */
  readonly holderWorkerId?: string;
}

export interface EngineLeaseStoreV1 {
  /**
   * Acquire (or renew, for the current holder) the job's lease for `ttlMs`.
   * An expired lease is taken over; an unexpired lease held by another
   * worker refuses with the holder's id.
   */
  acquire(jobId: string, workerId: string, ttlMs: number): Promise<EngineLeaseAcquireResultV1>;
  /** Extend the lease; false when this worker no longer holds it. */
  heartbeat(jobId: string, workerId: string, ttlMs: number): Promise<boolean>;
  /** Release the lease if (and only if) this worker holds it. */
  release(jobId: string, workerId: string): Promise<void>;
}

/** In-memory reference implementation (tests / single-process dev). */
export function createInMemoryLeaseStoreV1(options?: {
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date;
}): EngineLeaseStoreV1 {
  const now = options?.now ?? ((): Date => new Date());
  const leases = new Map<string, { workerId: string; expiresAtMs: number }>();

  return {
    acquire(jobId: string, workerId: string, ttlMs: number): Promise<EngineLeaseAcquireResultV1> {
      const nowMs = now().getTime();
      const lease = leases.get(jobId);
      if (lease !== undefined && lease.workerId !== workerId && lease.expiresAtMs > nowMs) {
        return Promise.resolve({ acquired: false, holderWorkerId: lease.workerId });
      }
      leases.set(jobId, { workerId, expiresAtMs: nowMs + ttlMs });
      return Promise.resolve({ acquired: true });
    },

    heartbeat(jobId: string, workerId: string, ttlMs: number): Promise<boolean> {
      const nowMs = now().getTime();
      const lease = leases.get(jobId);
      if (lease === undefined || lease.workerId !== workerId || lease.expiresAtMs <= nowMs) {
        return Promise.resolve(false);
      }
      leases.set(jobId, { workerId, expiresAtMs: nowMs + ttlMs });
      return Promise.resolve(true);
    },

    release(jobId: string, workerId: string): Promise<void> {
      const lease = leases.get(jobId);
      if (lease !== undefined && lease.workerId === workerId) {
        leases.delete(jobId);
      }
      return Promise.resolve();
    },
  };
}
