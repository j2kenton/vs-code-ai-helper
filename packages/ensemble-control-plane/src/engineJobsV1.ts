/**
 * Engine job supervision and restart recovery (plan Part 5).
 *
 * The control plane hosts Part 4 engine runs. Job state — including the
 * gate-paused position — is CHECKPOINTED to the durable store, so a control
 * plane restart resumes or cleanly re-offers a gate-paused in-progress task
 * rather than orphaning it:
 *
 * - `machineryFor` builds the engine's gate machinery OVER THE DURABLE STORE
 *   (gates, execution attempts, and the single-worker lease all persist), so
 *   every gated/ungated effect this control plane runs is crash-safe by the
 *   Part 4c protocol, and events fan out through the WS hub;
 * - `recoverGatePausedJobs` is the restart procedure: for every job
 *   checkpointed `gatePaused`, RE-ACQUIRE the lease and drive
 *   `resumeApproved` — which by construction replays the attempt-record
 *   recovery procedure (safe replay / reconcile / indeterminate re-offer)
 *   BEFORE re-issuing any external call. A still-pending gate is left
 *   offered (the task stays listed, the gate stays decidable — not
 *   orphaned); a decided gate resumes to exactly one effect or an explicit
 *   re-offer, never a duplicate (tests/restartRecovery.test.ts).
 *
 * The lease is necessary but not sufficient: a second worker attempting the
 * same recovery is refused by the lease, and even a lease LOST mid-effect is
 * safe because the next holder's recovery consults the persisted attempt
 * records first.
 */
import type { EngineExternalEffectV1 } from "../../ensemble-engine/src/gateMachineryV1";
import {
  createEngineGateMachineryV1,
  EngineGateMachineryV1,
  EngineGateResumeResultV1,
} from "../../ensemble-engine/src/gateMachineryV1";
import type { ControlPlaneStoreV1, EngineJobRecordV1, EngineJobStatusV1 } from "./storeV1";
import type { WsHubV1 } from "./wsHubV1";

export interface EngineJobRecoveryReportV1 {
  readonly jobId: string;
  readonly taskId: string;
  readonly gateId: string;
  readonly outcome:
    | "resumed"
    | "reoffered"
    | "stillPending"
    | "leaseUnavailable"
    | "gateMissing";
  readonly resume?: EngineGateResumeResultV1;
}

export interface EngineJobSupervisorV1 {
  /** Gate machinery for one task, over the durable store + hub fan-out. */
  machineryFor(taskId: string, ownerUserId: string): EngineGateMachineryV1;
  checkpoint(
    taskId: string,
    ownerUserId: string,
    status: EngineJobStatusV1,
    pausedGateId?: string
  ): void;
  readJob(taskId: string): EngineJobRecordV1 | undefined;
  /**
   * The restart procedure: recover every gate-paused job. `effectFor`
   * supplies the external effect a resumed gate executes (the same effect
   * shape the gate was opened for — Part 4d sandbox command effects in
   * production composition).
   */
  recoverGatePausedJobs(
    effectFor: (job: EngineJobRecordV1) => EngineExternalEffectV1
  ): Promise<readonly EngineJobRecoveryReportV1[]>;
}

export interface CreateEngineJobSupervisorOptionsV1 {
  readonly store: ControlPlaneStoreV1;
  readonly hub: WsHubV1;
  /** Stable identity of THIS control-plane worker (the lease holder id). */
  readonly workerId: string;
  readonly now?: () => Date;
  readonly leaseTtlMs?: number;
}

export function createEngineJobSupervisorV1(
  options: CreateEngineJobSupervisorOptionsV1
): EngineJobSupervisorV1 {
  const { store, hub, workerId } = options;
  const now = options.now ?? ((): Date => new Date());

  function machineryFor(taskId: string, ownerUserId: string): EngineGateMachineryV1 {
    return createEngineGateMachineryV1({
      taskId,
      ownerId: ownerUserId,
      workerId,
      sink: hub.createEngineSink(ownerUserId),
      gateStore: store.gates,
      attemptStore: store.attempts,
      leaseStore: store.leases,
      now,
      ...(options.leaseTtlMs !== undefined ? { leaseTtlMs: options.leaseTtlMs } : {}),
    });
  }

  function checkpoint(
    taskId: string,
    ownerUserId: string,
    status: EngineJobStatusV1,
    pausedGateId?: string
  ): void {
    store.upsertJob({
      jobId: taskId,
      taskId,
      ownerUserId,
      status,
      ...(pausedGateId !== undefined ? { pausedGateId } : {}),
      updatedAt: now().toISOString(),
    });
  }

  return {
    machineryFor,
    checkpoint,

    readJob(taskId: string): EngineJobRecordV1 | undefined {
      return store.readJob(taskId);
    },

    async recoverGatePausedJobs(
      effectFor: (job: EngineJobRecordV1) => EngineExternalEffectV1
    ): Promise<readonly EngineJobRecoveryReportV1[]> {
      const reports: EngineJobRecoveryReportV1[] = [];
      for (const job of store.listJobsByStatus("gatePaused")) {
        const gateId = job.pausedGateId;
        if (gateId === undefined) {
          reports.push({ jobId: job.jobId, taskId: job.taskId, gateId: "", outcome: "gateMissing" });
          continue;
        }
        const machinery = machineryFor(job.taskId, job.ownerUserId);
        const gate = await store.gates.read(gateId);
        if (gate === undefined) {
          reports.push({ jobId: job.jobId, taskId: job.taskId, gateId, outcome: "gateMissing" });
          continue;
        }
        if (gate.state === "pending") {
          // Not orphaned: the gate stays offered and decidable; the job
          // checkpoint keeps it in the recovery worklist.
          reports.push({ jobId: job.jobId, taskId: job.taskId, gateId, outcome: "stillPending" });
          continue;
        }
        // Decided gate: resume under the re-acquired lease. resumeApproved
        // replays the attempt-record recovery procedure before any call.
        const resume = await machinery.resumeApproved(gateId, effectFor(job));
        if (resume.kind === "leaseUnavailable") {
          reports.push({
            jobId: job.jobId,
            taskId: job.taskId,
            gateId,
            outcome: "leaseUnavailable",
            resume,
          });
          continue;
        }
        if (resume.kind === "indeterminate") {
          // The re-offer gate is the new paused position.
          checkpoint(job.taskId, job.ownerUserId, "gatePaused", resume.reofferGateId);
          reports.push({ jobId: job.jobId, taskId: job.taskId, gateId, outcome: "reoffered", resume });
          continue;
        }
        const failed =
          (resume.kind === "executed" || resume.kind === "recovered") &&
          resume.outcome.status === "failed";
        checkpoint(job.taskId, job.ownerUserId, failed ? "failed" : "completed");
        reports.push({ jobId: job.jobId, taskId: job.taskId, gateId, outcome: "resumed", resume });
      }
      return reports;
    },
  };
}
