/**
 * Restart/recovery semantics (plan Part 5; criterion 2): a gate-paused task
 * survives a control-plane restart — job state checkpointed to the durable
 * store, the lease re-acquired by the successor worker, and the
 * attempt-record recovery procedure replayed before any external call — so
 * nothing is orphaned and nothing double-runs.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allocateHex128IdV1 } from "../../ensemble-core/src/actionCorrelationV1";
import type {
  EngineEffectReconcileVerdictV1,
  EngineExternalEffectV1,
} from "../../ensemble-engine/src/gateMachineryV1";
import { createEngineJobSupervisorV1, EngineJobSupervisorV1 } from "../src/engineJobsV1";
import { createSessionServiceV1 } from "../src/sessionServiceV1";
import {
  ControlPlaneStoreV1,
  createControlPlaneStoreV1,
  createFileControlPlanePersistenceV1,
} from "../src/storeV1";
import { createWsHubV1 } from "../src/wsHubV1";
import { makeClock, makeTaskRecord, TestClockV1 } from "./helpersV1";

const TASK = "task-1";
const OWNER = "owner-a";

function makeWorld(path: string, workerId: string, clock: TestClockV1): {
  readonly store: ControlPlaneStoreV1;
  readonly supervisor: EngineJobSupervisorV1;
} {
  const store = createControlPlaneStoreV1({
    persistence: createFileControlPlanePersistenceV1(path),
    now: clock.now,
  });
  const sessions = createSessionServiceV1({ store, validators: [], now: clock.now });
  const hub = createWsHubV1({ sessions, store });
  const supervisor = createEngineJobSupervisorV1({ store, hub, workerId, now: clock.now });
  return { store, supervisor };
}

/** External ledger surviving restarts (provider-side state does). */
function makeLedger() {
  const executions: string[] = [];
  return {
    executions,
    effect(options?: { readonly crashBeforeCall?: boolean }): EngineExternalEffectV1 {
      return {
        effectKind: "sandboxCommand",
        supportsIdempotentReplay: false,
        execute(attemptKey: string) {
          if (options?.crashBeforeCall === true) {
            throw new Error("crash before the external call");
          }
          executions.push(attemptKey);
          return Promise.resolve({ status: "succeeded" as const, code: "exit0" });
        },
        reconcile(attemptKey: string): Promise<EngineEffectReconcileVerdictV1> {
          return Promise.resolve(executions.includes(attemptKey) ? "executed" : "notExecuted");
        },
      };
    },
  };
}

test("a gate-paused task survives a restart: lease re-acquired, recovery replayed, exactly one effect", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "ensemble-cp-restart-")), "store.json");
  const clock = makeClock();
  const ledger = makeLedger();

  // First control-plane process: open a gate, checkpoint gate-paused,
  // approve, then crash before the external call goes out.
  const first = makeWorld(path, "worker-1", clock);
  first.store.createTask(makeTaskRecord(TASK, OWNER, clock.now().toISOString()));
  const machinery = first.supervisor.machineryFor(TASK, OWNER);
  const gate = await machinery.openGate({ summary: "apply reviewed changes" });
  first.supervisor.checkpoint(TASK, OWNER, "gatePaused", gate.gateId);
  const decided = await machinery.decide({
    gateId: gate.gateId,
    decision: "approve",
    idempotencyKey: allocateHex128IdV1(),
  });
  assert.equal(decided.kind, "decided");
  await assert.rejects(
    machinery.resumeApproved(gate.gateId, ledger.effect({ crashBeforeCall: true }))
  );
  assert.equal(ledger.executions.length, 0);

  // Restart: a NEW worker over the same durable file. The job is still
  // listed (not orphaned), and recovery resumes it under the new lease.
  const second = makeWorld(path, "worker-2", clock);
  assert.equal(second.store.readJob(TASK)?.status, "gatePaused");
  assert.equal(second.store.listTasksForOwner(OWNER).length, 1);
  const reports = await second.supervisor.recoverGatePausedJobs(() => ledger.effect());
  assert.equal(reports.length, 1);
  assert.equal(reports[0]?.outcome, "resumed");
  assert.equal(reports[0]?.resume?.kind, "recovered");
  assert.equal(ledger.executions.length, 1, "exactly one execution across the restart");
  assert.equal(second.store.readJob(TASK)?.status, "completed");

  // A second recovery pass finds nothing gate-paused: no double-run.
  const again = await second.supervisor.recoverGatePausedJobs(() => ledger.effect());
  assert.equal(again.length, 0);
  assert.equal(ledger.executions.length, 1);
});

test("a still-pending gate stays offered across a restart — not orphaned, not executed", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "ensemble-cp-restart-")), "store.json");
  const clock = makeClock();
  const ledger = makeLedger();

  const first = makeWorld(path, "worker-1", clock);
  first.store.createTask(makeTaskRecord(TASK, OWNER, clock.now().toISOString()));
  const gate = await first.supervisor.machineryFor(TASK, OWNER).openGate({ summary: "hold" });
  first.supervisor.checkpoint(TASK, OWNER, "gatePaused", gate.gateId);

  const second = makeWorld(path, "worker-2", clock);
  const reports = await second.supervisor.recoverGatePausedJobs(() => ledger.effect());
  assert.equal(reports[0]?.outcome, "stillPending");
  assert.equal(ledger.executions.length, 0);
  assert.equal((await second.store.gates.read(gate.gateId))?.state, "pending");
  assert.equal(second.store.readJob(TASK)?.status, "gatePaused");
});

test("recovery under another worker's live lease refuses — the single-worker guarantee", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "ensemble-cp-restart-")), "store.json");
  const clock = makeClock();
  const ledger = makeLedger();

  const first = makeWorld(path, "worker-1", clock);
  first.store.createTask(makeTaskRecord(TASK, OWNER, clock.now().toISOString()));
  const machinery = first.supervisor.machineryFor(TASK, OWNER);
  const gate = await machinery.openGate({ summary: "run" });
  first.supervisor.checkpoint(TASK, OWNER, "gatePaused", gate.gateId);
  await machinery.decide({
    gateId: gate.gateId,
    decision: "approve",
    idempotencyKey: allocateHex128IdV1(),
  });

  // Another worker holds an unexpired lease on the task's job.
  const second = makeWorld(path, "worker-2", clock);
  assert.equal(
    (await second.store.leases.acquire(TASK, "worker-other", 60_000)).acquired,
    true
  );
  const reports = await second.supervisor.recoverGatePausedJobs(() => ledger.effect());
  assert.equal(reports[0]?.outcome, "leaseUnavailable");
  assert.equal(ledger.executions.length, 0);
  assert.equal(second.store.readJob(TASK)?.status, "gatePaused", "still recoverable later");
});
