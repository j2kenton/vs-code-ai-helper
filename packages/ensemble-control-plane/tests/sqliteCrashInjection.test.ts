/**
 * The Part 4c crash-injection tests re-run against the SQLite durable store
 * (criterion 3, over the plan's accepted single-node dev database): failures
 * injected at each persistence-to-external-effect boundary, with recovery
 * driven by a REAL restart — a brand-new store instance over the same
 * database file. Recovery must yield exactly one external effect or an
 * explicit indeterminate re-offer, never a silent duplicate. Same scenarios
 * as `crashInjection.test.ts`, which pins the persisted-document store.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allocateHex128IdV1 } from "../../ensemble-core/src/actionCorrelationV1";
import { createRecordingEventSinkV1 } from "../../ensemble-engine/src/engineEventsV1";
import {
  createEngineGateMachineryV1,
  EngineEffectReconcileVerdictV1,
  EngineExternalEffectV1,
  EngineGateMachineryV1,
} from "../../ensemble-engine/src/gateMachineryV1";
import type { EngineExecutionAttemptStoreV1 } from "../../ensemble-engine/src/executionAttemptStoreV1";
import {
  createSqliteControlPlaneStoreV1,
  SqliteControlPlaneStoreV1,
} from "../src/sqliteStoreV1";

const TASK = "task-1";
const OWNER = "owner-a";

function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "ensemble-cp-sqlite-crash-")), "store.sqlite");
}

function openStore(path: string): SqliteControlPlaneStoreV1 {
  return createSqliteControlPlaneStoreV1({ databasePath: path });
}

function machineryOver(
  store: SqliteControlPlaneStoreV1,
  workerId: string,
  attemptStore?: EngineExecutionAttemptStoreV1
): EngineGateMachineryV1 {
  return createEngineGateMachineryV1({
    taskId: TASK,
    ownerId: OWNER,
    workerId,
    sink: createRecordingEventSinkV1(),
    gateStore: store.gates,
    attemptStore: attemptStore ?? store.attempts,
    leaseStore: store.leases,
  });
}

/**
 * The "sandbox": an external ledger that SURVIVES control-plane restarts
 * (external provider state does). `verdictWhenAsked` models how much the
 * provider's audit surface can prove.
 */
function makeExternalLedger(verdictWhenAsked?: "definitive" | "unavailable") {
  const executions: string[] = [];
  return {
    executions,
    effect(behavior?: {
      readonly throwBeforeEffect?: boolean;
      readonly throwAfterEffect?: boolean;
    }): EngineExternalEffectV1 {
      return {
        effectKind: "sandboxCommand",
        supportsIdempotentReplay: false,
        execute(attemptKey: string) {
          if (behavior?.throwBeforeEffect === true) {
            throw new Error("crash: after attempt persist, before the external call");
          }
          executions.push(attemptKey);
          if (behavior?.throwAfterEffect === true) {
            throw new Error("crash: after the call, before the outcome persists");
          }
          return Promise.resolve({ status: "succeeded" as const, code: "exit0" });
        },
        reconcile(attemptKey: string): Promise<EngineEffectReconcileVerdictV1> {
          if (verdictWhenAsked === "unavailable") {
            return Promise.resolve("unknown");
          }
          return Promise.resolve(executions.includes(attemptKey) ? "executed" : "notExecuted");
        },
      };
    },
  };
}

async function approvedGate(store: SqliteControlPlaneStoreV1): Promise<string> {
  const gate = await store.gates.create({ taskId: TASK, ownerId: OWNER, summary: "run" });
  const decided = await store.gates.decide(OWNER, {
    gateId: gate.gateId,
    decision: "approve",
    idempotencyKey: allocateHex128IdV1(),
  });
  assert.equal(decided.kind, "decided");
  return gate.gateId;
}

test("sqlite boundary 1 — crash BEFORE the attempt record persists: nothing executed; retry executes exactly once", async () => {
  const path = tempDbPath();
  const store = openStore(path);
  const gateId = await approvedGate(store);
  const ledger = makeExternalLedger();

  // The begin write itself crashes: the record never persists, so the
  // external call can never have been reached.
  const failingBegin: EngineExecutionAttemptStoreV1 = {
    ...store.attempts,
    begin: () => Promise.reject(new Error("crash: before the attempt record persists")),
  };
  await assert.rejects(
    machineryOver(store, "w1", failingBegin).resumeApproved(gateId, ledger.effect())
  );
  assert.equal(ledger.executions.length, 0);
  store.close();

  // Restart against the same database: recovery finds NO attempt record and
  // executes freshly — exactly once.
  const restarted = openStore(path);
  const result = await machineryOver(restarted, "w2").resumeApproved(gateId, ledger.effect());
  assert.equal(result.kind, "executed");
  assert.equal(ledger.executions.length, 1);
  restarted.close();
});

test("sqlite boundary 2 — crash AFTER persist, BEFORE the call: reconcile proves non-execution, re-issue exactly once", async () => {
  const path = tempDbPath();
  const store = openStore(path);
  const gateId = await approvedGate(store);
  const ledger = makeExternalLedger();

  await assert.rejects(
    machineryOver(store, "w1").resumeApproved(gateId, ledger.effect({ throwBeforeEffect: true }))
  );
  assert.equal(ledger.executions.length, 0);
  store.close();

  const restarted = openStore(path);
  const open = await restarted.attempts.listOpenForTask(TASK);
  assert.equal(open.length, 1, "the open attempt record survived the restart on disk");

  const result = await machineryOver(restarted, "w2").resumeApproved(gateId, ledger.effect());
  assert.equal(result.kind, "recovered");
  assert.equal(result.kind === "recovered" ? result.method : "", "reconciledReissued");
  assert.equal(ledger.executions.length, 1);
  restarted.close();

  // The terminal outcome is durable: a third instance reads it back.
  const reread = openStore(path);
  const attempts = await reread.attempts.listForGate(gateId);
  assert.equal(attempts[0]?.state, "succeeded");
  reread.close();
});

test("sqlite boundary 3 — crash AFTER the call, BEFORE the outcome persists: reconcile adopts, never re-executes", async () => {
  const path = tempDbPath();
  const store = openStore(path);
  const gateId = await approvedGate(store);
  const ledger = makeExternalLedger();

  await assert.rejects(
    machineryOver(store, "w1").resumeApproved(gateId, ledger.effect({ throwAfterEffect: true }))
  );
  assert.equal(ledger.executions.length, 1, "the external effect DID happen before the crash");
  store.close();

  const restarted = openStore(path);
  const result = await machineryOver(restarted, "w2").resumeApproved(gateId, ledger.effect());
  assert.equal(result.kind, "recovered");
  assert.equal(result.kind === "recovered" ? result.method : "", "reconciledAdoptedOutcome");
  assert.equal(ledger.executions.length, 1, "exactly one execution — no silent duplicate");
  restarted.close();
});

test("sqlite indeterminate: unprovable recovery re-offers through the gate flow; re-approval runs a NEW attempt", async () => {
  const path = tempDbPath();
  const store = openStore(path);
  const gateId = await approvedGate(store);
  const ledger = makeExternalLedger("unavailable");

  await assert.rejects(
    machineryOver(store, "w1").resumeApproved(gateId, ledger.effect({ throwBeforeEffect: true }))
  );
  assert.equal(ledger.executions.length, 0);
  store.close();

  const restarted = openStore(path);
  const machinery = machineryOver(restarted, "w2");
  const result = await machinery.resumeApproved(gateId, ledger.effect());
  assert.equal(result.kind, "indeterminate");
  const reofferGateId = result.kind === "indeterminate" ? result.reofferGateId : "";

  // NOTHING re-executed; the re-offer gate is durable and pending.
  assert.equal(ledger.executions.length, 0);
  const reoffer = await restarted.gates.read(reofferGateId);
  assert.equal(reoffer?.state, "pending");
  assert.ok(reoffer?.reofferOfAttemptKey !== undefined);

  // Explicit re-approval: the effect runs again as a NEW attempt lineage.
  const decided = await restarted.gates.decide(OWNER, {
    gateId: reofferGateId,
    decision: "approve",
    idempotencyKey: allocateHex128IdV1(),
  });
  assert.equal(decided.kind, "decided");
  const rerun = await machinery.resumeApproved(reofferGateId, ledger.effect());
  assert.equal(rerun.kind, "executed");
  assert.equal(ledger.executions.length, 1);
  restarted.close();
});
