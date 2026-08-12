/**
 * Gate machinery + crash-safe external-effect protocol tests (plan Part 4c,
 * acceptance criterion 3).
 *
 * Covers: exactly-once gate transitions under the (owner, gate, idempotency
 * key) contract (replay → original outcome; same-key/different-payload →
 * typed mismatch; conflict → typed conflict), decisions for already-resumed
 * gates as no-ops, diff generation wired into the gate events, the
 * single-worker lease, and — centrally — CRASH INJECTION at each
 * persistence-to-external-effect boundary:
 *   1. before the attempt record persists,
 *   2. after persist, before the external call,
 *   3. after the call, before the outcome persists,
 * asserting recovery yields exactly one external effect (or an explicit
 * indeterminate re-offer), never a silent duplicate.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { allocateHex128IdV1 } from "../../ensemble-core/src/actionCorrelationV1";
import { createRecordingEventSinkV1 } from "../src/engineEventsV1";
import {
  createInMemoryExecutionAttemptStoreV1,
  deriveExecutionAttemptKeyV1,
  EngineExecutionAttemptStoreV1,
} from "../src/executionAttemptStoreV1";
import {
  createEngineGateMachineryV1,
  EngineExternalEffectV1,
  EngineGateMachineryV1,
} from "../src/gateMachineryV1";
import { createInMemoryGateStoreV1 } from "../src/gateStoreV1";
import { createInMemoryLeaseStoreV1 } from "../src/leaseStoreV1";
import {
  createAttemptGuardedProviderRunnerV1,
  providerRoundStepIdV1,
} from "../src/attemptGuardedRunnerV1";

/** Deterministic, strictly increasing clock. */
function testClock(startMs = Date.UTC(2026, 7, 12, 5, 0, 0)): () => Date {
  let tick = 0;
  return () => new Date(startMs + 1000 * tick++);
}

const TASK_ID = "task-4c-demo";
const OWNER_ID = "user-owner-1";

function machineryWith(overrides?: {
  readonly attemptStore?: EngineExecutionAttemptStoreV1;
  readonly workerId?: string;
  readonly shared?: Pick<EngineGateMachineryV1, "gateStore" | "attemptStore" | "leaseStore">;
}): EngineGateMachineryV1 & { readonly sink: ReturnType<typeof createRecordingEventSinkV1> } {
  const now = testClock();
  const sink = createRecordingEventSinkV1();
  const machinery = createEngineGateMachineryV1({
    taskId: TASK_ID,
    ownerId: OWNER_ID,
    workerId: overrides?.workerId ?? "worker-a",
    sink,
    now,
    ...(overrides?.shared !== undefined
      ? {
          gateStore: overrides.shared.gateStore,
          attemptStore: overrides.shared.attemptStore,
          leaseStore: overrides.shared.leaseStore,
        }
      : overrides?.attemptStore !== undefined
        ? { attemptStore: overrides.attemptStore }
        : {}),
  });
  return Object.assign(machinery, { sink });
}

/**
 * A fake external platform: executions are recorded per attempt key. With
 * `platformIdempotent`, executing an already-seen key returns the original
 * outcome WITHOUT a second execution (at-most-once semantics); without it,
 * every execute call is a real (possibly duplicate) execution.
 */
function createEffectLedger(config: {
  readonly platformIdempotent: boolean;
  readonly reconcilable?: boolean;
}): {
  effect: EngineExternalEffectV1;
  executions: string[];
  /** Simulate a crash inside the effect body BEFORE its side effect lands. */
  crashNextBeforeSideEffect(): void;
} {
  const executions: string[] = [];
  let crashBefore = false;
  const effect: EngineExternalEffectV1 = {
    effectKind: "modelProviderCall",
    supportsIdempotentReplay: config.platformIdempotent,
    async execute(attemptKey: string) {
      if (crashBefore) {
        crashBefore = false;
        throw new Error("injected crash: before the external call went out");
      }
      if (config.platformIdempotent && executions.includes(attemptKey)) {
        return { status: "succeeded", code: "platformDeduplicated" };
      }
      executions.push(attemptKey);
      return { status: "succeeded", code: "ok" };
    },
    ...(config.reconcilable === true
      ? {
          async reconcile(attemptKey: string) {
            return executions.includes(attemptKey) ? ("executed" as const) : ("notExecuted" as const);
          },
        }
      : {}),
  };
  return {
    effect,
    executions,
    crashNextBeforeSideEffect(): void {
      crashBefore = true;
    },
  };
}

async function openApprovedGate(
  machinery: EngineGateMachineryV1,
  summary = "run the approved step"
): Promise<string> {
  const gate = await machinery.openGate({ summary });
  const decided = await machinery.decide({
    gateId: gate.gateId,
    decision: "approve",
    idempotencyKey: allocateHex128IdV1(),
  });
  assert.equal(decided.kind, "decided");
  return gate.gateId;
}

// ─── Gate decision idempotency (criterion 3) ────────────────────────────────

test("same key + same payload replays the original outcome; mismatch and conflict return typed errors", async () => {
  const machinery = machineryWith();
  const gate = await machinery.openGate({ summary: "approve deploying the fix" });
  const key = allocateHex128IdV1();

  const first = await machinery.decide({ gateId: gate.gateId, decision: "approve", idempotencyKey: key });
  assert.equal(first.kind, "decided");
  assert.ok(first.kind === "decided");
  assert.equal(first.record.state, "approved");

  // Same key + same payload: the ORIGINAL outcome, no second transition.
  const replay = await machinery.decide({ gateId: gate.gateId, decision: "approve", idempotencyKey: key });
  assert.equal(replay.kind, "replayed");
  assert.ok(replay.kind === "replayed");
  assert.equal(replay.record.state, "approved");
  assert.deepEqual(replay.record.decision, first.record.decision);

  // Same key + DIFFERENT payload: typed mismatch.
  const mismatch = await machinery.decide({ gateId: gate.gateId, decision: "reject", idempotencyKey: key });
  assert.ok(mismatch.kind === "error" && mismatch.code === "gateDecisionPayloadMismatch");

  // Conflicting decision under a fresh key: typed conflict, never a second execution.
  const conflict = await machinery.decide({
    gateId: gate.gateId,
    decision: "reject",
    idempotencyKey: allocateHex128IdV1(),
  });
  assert.ok(conflict.kind === "error" && conflict.code === "gateAlreadyDecided");

  // gateStateChanged emitted exactly once per REAL transition: pending (open) + approved.
  const gateEvents = machinery.sink.events.filter((event) => event.type === "gateStateChanged");
  assert.deepEqual(
    gateEvents.map((event) => (event.type === "gateStateChanged" ? event.state : "")),
    ["pending", "approved"]
  );
});

test("an unknown gate and a foreign owner's gate both read as gateNotFound", async () => {
  const machinery = machineryWith();
  const result = await machinery.decide({
    gateId: allocateHex128IdV1(),
    decision: "approve",
    idempotencyKey: allocateHex128IdV1(),
  });
  assert.ok(result.kind === "error" && result.code === "gateNotFound");

  // A gate created under a different owner is indistinguishable from absence.
  const foreign = await machinery.gateStore.create({
    taskId: TASK_ID,
    ownerId: "someone-else",
    summary: "not yours",
  });
  const denied = await machinery.decide({
    gateId: foreign.gateId,
    decision: "approve",
    idempotencyKey: allocateHex128IdV1(),
  });
  assert.ok(denied.kind === "error" && denied.code === "gateNotFound");
});

test("a decision replay for an already-resumed gate is a no-op: nothing re-executes, nothing re-emits", async () => {
  const machinery = machineryWith();
  const ledger = createEffectLedger({ platformIdempotent: false, reconcilable: true });
  const gate = await machinery.openGate({ summary: "step" });
  const key = allocateHex128IdV1();
  await machinery.decide({ gateId: gate.gateId, decision: "approve", idempotencyKey: key });

  const resumed = await machinery.resumeApproved(gate.gateId, ledger.effect);
  assert.equal(resumed.kind, "executed");
  assert.equal(ledger.executions.length, 1);
  const emittedBefore = machinery.sink.events.length;

  // Replay of the decision AFTER resume: stored outcome, no emission.
  const replay = await machinery.decide({ gateId: gate.gateId, decision: "approve", idempotencyKey: key });
  assert.equal(replay.kind, "replayed");
  assert.equal(machinery.sink.events.length, emittedBefore);

  // Driving resumption again: consumed decision + terminal attempt → no-op.
  const again = await machinery.resumeApproved(gate.gateId, ledger.effect);
  assert.equal(again.kind, "alreadyExecuted");
  assert.equal(ledger.executions.length, 1);
});

test("a rejected gate never executes and consumes exactly once", async () => {
  const machinery = machineryWith();
  const ledger = createEffectLedger({ platformIdempotent: false });
  const gate = await machinery.openGate({ summary: "step" });
  await machinery.decide({
    gateId: gate.gateId,
    decision: "reject",
    idempotencyKey: allocateHex128IdV1(),
  });
  const resumed = await machinery.resumeApproved(gate.gateId, ledger.effect);
  assert.equal(resumed.kind, "rejectedGate");
  assert.equal(ledger.executions.length, 0);
  const again = await machinery.resumeApproved(gate.gateId, ledger.effect);
  assert.equal(again.kind, "rejectedGate");
  assert.equal(ledger.executions.length, 0);
});

test("a still-pending gate refuses resumption", async () => {
  const machinery = machineryWith();
  const ledger = createEffectLedger({ platformIdempotent: false });
  const gate = await machinery.openGate({ summary: "step" });
  const resumed = await machinery.resumeApproved(gate.gateId, ledger.effect);
  assert.equal(resumed.kind, "gateStillPending");
  assert.equal(ledger.executions.length, 0);
});

// ─── Diff generation wired into the gate events ─────────────────────────────

test("openGate generates the unified diff of the proposed changes and announces the gate", async () => {
  const machinery = machineryWith();
  const gate = await machinery.openGate({
    summary: "review the proposed change to src/a.ts",
    changes: [{ path: "src/a.ts", oldText: "old line\n", newText: "new line\n" }],
  });
  assert.ok(gate.diffUnified !== undefined);
  assert.ok(gate.diffUnified.includes("--- a/src/a.ts"));
  assert.ok(gate.diffUnified.includes("-old line"));
  assert.ok(gate.diffUnified.includes("+new line"));

  // The 4a event stream carries the request: gateStateChanged + gateRequested.
  const kinds = machinery.sink.events.map((event) =>
    event.type === "notification" ? event.notification.kind : event.type
  );
  assert.deepEqual(kinds, ["gateStateChanged", "gateRequested"]);
  const requested = machinery.sink.events.find(
    (event) => event.type === "notification" && event.notification.kind === "gateRequested"
  );
  assert.ok(requested !== undefined && requested.type === "notification");
  assert.ok(requested.notification.kind === "gateRequested");
  assert.equal(requested.notification.gateId, gate.gateId);
});

// ─── Deterministic attempt keys ─────────────────────────────────────────────

test("attempt keys are deterministic over stable identifiers and distinct across lineage/gate/task", () => {
  const base = { taskId: "t1", gateId: "g1", effectKind: "modelProviderCall" as const, lineage: 0 };
  assert.equal(deriveExecutionAttemptKeyV1(base), deriveExecutionAttemptKeyV1({ ...base }));
  assert.notEqual(deriveExecutionAttemptKeyV1(base), deriveExecutionAttemptKeyV1({ ...base, lineage: 1 }));
  assert.notEqual(deriveExecutionAttemptKeyV1(base), deriveExecutionAttemptKeyV1({ ...base, gateId: "g2" }));
  assert.notEqual(deriveExecutionAttemptKeyV1(base), deriveExecutionAttemptKeyV1({ ...base, taskId: "t2" }));
  assert.notEqual(
    deriveExecutionAttemptKeyV1(base),
    deriveExecutionAttemptKeyV1({ ...base, effectKind: "sandboxCommand" })
  );
});

// ─── Crash boundary 1: BEFORE the attempt record persists ───────────────────

test("crash before attempt persist: recovery re-runs from scratch with the same key — exactly one effect", async () => {
  const now = testClock();
  const inner = createInMemoryExecutionAttemptStoreV1({ now });
  let crashBegins = 1;
  const crashingStore: EngineExecutionAttemptStoreV1 = {
    ...inner,
    begin(input) {
      if (crashBegins > 0) {
        crashBegins--;
        throw new Error("injected crash: before the attempt record persisted");
      }
      return inner.begin(input);
    },
  };
  const machinery = machineryWith({ attemptStore: crashingStore });
  const ledger = createEffectLedger({ platformIdempotent: false, reconcilable: true });
  const gateId = await openApprovedGate(machinery);

  await assert.rejects(() => machinery.resumeApproved(gateId, ledger.effect), /before the attempt record/);
  // The protocol persists BEFORE calling: no record ⇒ no call went out.
  assert.equal(ledger.executions.length, 0);
  assert.equal((await machinery.attemptStore.listForGate(gateId)).length, 0);

  // Recovery: a fresh drive derives the IDENTICAL deterministic key and runs once.
  const recovered = await machinery.resumeApproved(gateId, ledger.effect);
  assert.equal(recovered.kind, "executed");
  assert.ok(recovered.kind === "executed");
  assert.deepEqual(ledger.executions, [recovered.attemptKey]);
  assert.equal(
    recovered.attemptKey,
    deriveExecutionAttemptKeyV1({ taskId: TASK_ID, gateId, effectKind: "modelProviderCall", lineage: 0 })
  );
});

// ─── Crash boundary 2: after persist, BEFORE the external call ──────────────

test("crash after persist / before call (idempotent platform): recovery replays the SAME key — exactly one effect", async () => {
  const machinery = machineryWith();
  const ledger = createEffectLedger({ platformIdempotent: true });
  const gateId = await openApprovedGate(machinery);

  ledger.crashNextBeforeSideEffect();
  await assert.rejects(() => machinery.resumeApproved(gateId, ledger.effect), /injected crash/);
  const open = await machinery.attemptStore.listForGate(gateId);
  assert.equal(open.length, 1);
  assert.equal(open[0]!.state, "pending");
  assert.equal(ledger.executions.length, 0);

  const recovered = await machinery.resumeApproved(gateId, ledger.effect);
  assert.equal(recovered.kind, "recovered");
  assert.ok(recovered.kind === "recovered");
  assert.equal(recovered.method, "replayedWithSameKey");
  assert.equal(recovered.attemptKey, open[0]!.attemptKey);
  assert.deepEqual(ledger.executions, [open[0]!.attemptKey]);
  assert.equal((await machinery.attemptStore.read(open[0]!.attemptKey))?.state, "succeeded");
});

test("crash after persist / before call (non-idempotent, reconcilable): reconcile says notExecuted → re-issue once", async () => {
  const machinery = machineryWith();
  const ledger = createEffectLedger({ platformIdempotent: false, reconcilable: true });
  const gateId = await openApprovedGate(machinery);

  ledger.crashNextBeforeSideEffect();
  await assert.rejects(() => machinery.resumeApproved(gateId, ledger.effect), /injected crash/);
  assert.equal(ledger.executions.length, 0);

  const recovered = await machinery.resumeApproved(gateId, ledger.effect);
  assert.equal(recovered.kind, "recovered");
  assert.ok(recovered.kind === "recovered");
  assert.equal(recovered.method, "reconciledReissued");
  assert.equal(ledger.executions.length, 1);
});

// ─── Crash boundary 3: after the call, BEFORE the outcome persists ──────────

function completeCrashingStore(now: () => Date): {
  store: EngineExecutionAttemptStoreV1;
  armCrash(): void;
} {
  const inner = createInMemoryExecutionAttemptStoreV1({ now });
  let crashCompletes = 0;
  return {
    store: {
      ...inner,
      complete(attemptKey, state, outcomeCode) {
        if (crashCompletes > 0) {
          crashCompletes--;
          throw new Error("injected crash: before the outcome persisted");
        }
        return inner.complete(attemptKey, state, outcomeCode);
      },
    },
    armCrash(): void {
      crashCompletes = 1;
    },
  };
}

test("crash after call / before outcome persist (idempotent platform): replay with the SAME key deduplicates — exactly one effect", async () => {
  const now = testClock();
  const { store, armCrash } = completeCrashingStore(now);
  const machinery = machineryWith({ attemptStore: store });
  const ledger = createEffectLedger({ platformIdempotent: true });
  const gateId = await openApprovedGate(machinery);

  armCrash();
  await assert.rejects(() => machinery.resumeApproved(gateId, ledger.effect), /before the outcome/);
  // The call DID go out; the outcome never persisted.
  assert.equal(ledger.executions.length, 1);
  assert.equal((await machinery.attemptStore.listForGate(gateId))[0]!.state, "pending");

  const recovered = await machinery.resumeApproved(gateId, ledger.effect);
  assert.equal(recovered.kind, "recovered");
  assert.ok(recovered.kind === "recovered");
  assert.equal(recovered.method, "replayedWithSameKey");
  assert.equal(recovered.outcome.code, "platformDeduplicated");
  // Still exactly one execution: the platform deduplicated the same key.
  assert.equal(ledger.executions.length, 1);
});

test("crash after call / before outcome persist (non-idempotent, reconcilable): reconcile says executed → adopt, never re-issue", async () => {
  const now = testClock();
  const { store, armCrash } = completeCrashingStore(now);
  const machinery = machineryWith({ attemptStore: store });
  const ledger = createEffectLedger({ platformIdempotent: false, reconcilable: true });
  const gateId = await openApprovedGate(machinery);

  armCrash();
  await assert.rejects(() => machinery.resumeApproved(gateId, ledger.effect), /before the outcome/);
  assert.equal(ledger.executions.length, 1);

  const recovered = await machinery.resumeApproved(gateId, ledger.effect);
  assert.equal(recovered.kind, "recovered");
  assert.ok(recovered.kind === "recovered");
  assert.equal(recovered.method, "reconciledAdoptedOutcome");
  assert.equal(ledger.executions.length, 1);
  const record = await machinery.attemptStore.read(recovered.attemptKey);
  assert.equal(record?.state, "succeeded");
  assert.equal(record?.outcomeCode, "reconciledExecuted");
});

test("crash after call / before outcome persist (non-idempotent, NOT reconcilable): indeterminate re-offer, never a silent re-execution", async () => {
  const now = testClock();
  const { store, armCrash } = completeCrashingStore(now);
  const machinery = machineryWith({ attemptStore: store });
  const ledger = createEffectLedger({ platformIdempotent: false });
  const gateId = await openApprovedGate(machinery);

  armCrash();
  await assert.rejects(() => machinery.resumeApproved(gateId, ledger.effect), /before the outcome/);
  assert.equal(ledger.executions.length, 1);

  const recovered = await machinery.resumeApproved(gateId, ledger.effect);
  assert.equal(recovered.kind, "indeterminate");
  assert.ok(recovered.kind === "indeterminate");
  // NOTHING was re-executed.
  assert.equal(ledger.executions.length, 1);
  const attempt = await machinery.attemptStore.read(recovered.attemptKey);
  assert.equal(attempt?.state, "indeterminate");

  // The re-offer RE-ENTERS THE GATE FLOW: a fresh pending gate plus the
  // typed indeterminateAttempt event naming it.
  const reoffer = await machinery.gateStore.read(recovered.reofferGateId);
  assert.equal(reoffer?.state, "pending");
  assert.equal(reoffer?.reofferOfAttemptKey, recovered.attemptKey);
  const indeterminateEvents = machinery.sink.events.filter(
    (event) => event.type === "notification" && event.notification.kind === "indeterminateAttempt"
  );
  assert.equal(indeterminateEvents.length, 1);
  const event = indeterminateEvents[0]!;
  assert.ok(event.type === "notification" && event.notification.kind === "indeterminateAttempt");
  assert.equal(event.notification.gateId, recovered.reofferGateId);
  assert.equal(event.notification.attemptKey, recovered.attemptKey);

  // EXPLICIT user re-approval of the re-offer gate runs a NEW attempt with a
  // NEW deterministic key (lineage 0 under the re-offer gate) — the
  // deliberate at-most-once bias: re-execution only ever follows a fresh
  // human decision.
  const decided = await machinery.decide({
    gateId: recovered.reofferGateId,
    decision: "approve",
    idempotencyKey: allocateHex128IdV1(),
  });
  assert.equal(decided.kind, "decided");
  const reExecuted = await machinery.resumeApproved(recovered.reofferGateId, ledger.effect);
  assert.equal(reExecuted.kind, "executed");
  assert.ok(reExecuted.kind === "executed");
  assert.notEqual(reExecuted.attemptKey, recovered.attemptKey);
  assert.equal(ledger.executions.length, 2);
});

// ─── Attempt-guarded provider dispatch ──────────────────────────────────────

test("guarded runner: the attempt record persists BEFORE the provider runs and completes after", async () => {
  const now = testClock();
  const attemptStore = createInMemoryExecutionAttemptStoreV1({ now });
  let recordVisibleDuringInvoke = false;
  const guarded = createAttemptGuardedProviderRunnerV1({
    attemptStore,
    inner: {
      async invoke(input) {
        const open = await attemptStore.listOpenForTask(input.taskId);
        recordVisibleDuringInvoke = open.length === 1 && open[0]!.state === "pending";
        return { kind: "completed", summaryMarkdown: "done" };
      },
    },
  });
  const invocation = {
    taskId: TASK_ID,
    taskFolder: "2026-08-12_task_4c",
    stage: "impl" as const,
    round: 1,
    correlation: {
      actionKey: "engine.runRound.v1",
      operationId: allocateHex128IdV1(),
      attemptId: allocateHex128IdV1(),
      taskBindingId: "binding",
      chatDocumentId: "chat-doc",
    },
    planOfRecord: "- [ ] item",
  };
  const result = await guarded.invoke(invocation);
  assert.equal(result.kind, "completed");
  assert.ok(recordVisibleDuringInvoke, "attempt record was not persisted before the provider ran");
  const stepId = providerRoundStepIdV1(invocation);
  const records = await attemptStore.listForGate(stepId);
  assert.equal(records.length, 1);
  assert.equal(records[0]!.state, "succeeded");
  assert.equal(records[0]!.outcomeCode, "completed");
  assert.equal(
    records[0]!.attemptKey,
    deriveExecutionAttemptKeyV1({
      taskId: TASK_ID,
      gateId: stepId,
      effectKind: "modelProviderCall",
      lineage: 0,
    })
  );
});

test("guarded runner: a crash mid-call leaves the open record on the recovery worklist", async () => {
  const now = testClock();
  const attemptStore = createInMemoryExecutionAttemptStoreV1({ now });
  const guarded = createAttemptGuardedProviderRunnerV1({
    attemptStore,
    inner: {
      async invoke() {
        throw new Error("injected crash: provider call interrupted");
      },
    },
  });
  const invocation = {
    taskId: TASK_ID,
    taskFolder: "2026-08-12_task_4c",
    stage: "impl" as const,
    round: 1,
    correlation: {
      actionKey: "engine.runRound.v1",
      operationId: allocateHex128IdV1(),
      attemptId: allocateHex128IdV1(),
      taskBindingId: "binding",
      chatDocumentId: "chat-doc",
    },
    planOfRecord: "- [ ] item",
  };
  await assert.rejects(() => guarded.invoke(invocation), /provider call interrupted/);
  const open = await attemptStore.listOpenForTask(TASK_ID);
  assert.equal(open.length, 1);
  assert.equal(open[0]!.state, "pending");
  assert.equal(open[0]!.gateId, providerRoundStepIdV1(invocation));
});

// ─── The single-worker lease ────────────────────────────────────────────────

test("two workers cannot concurrently act on one approval: the lease admits one, the loser sees the completed state", async () => {
  const now = testClock();
  const gateStore = createInMemoryGateStoreV1({ now });
  const attemptStore = createInMemoryExecutionAttemptStoreV1({ now });
  const leaseStore = createInMemoryLeaseStoreV1({ now });
  const shared = { gateStore, attemptStore, leaseStore };
  const workerA = machineryWith({ workerId: "worker-a", shared });
  const workerB = machineryWith({ workerId: "worker-b", shared });

  const gateId = await openApprovedGate(workerA);

  let releaseEffect: (() => void) | undefined;
  const executions: string[] = [];
  const slowEffect: EngineExternalEffectV1 = {
    effectKind: "modelProviderCall",
    supportsIdempotentReplay: true,
    async execute(attemptKey: string) {
      executions.push(attemptKey);
      await new Promise<void>((resolve) => {
        releaseEffect = resolve;
      });
      return { status: "succeeded", code: "ok" };
    },
  };

  const inFlight = workerA.resumeApproved(gateId, slowEffect);
  // Give worker A's async steps time to reach the (blocking) effect call.
  while (releaseEffect === undefined) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  const blocked = await workerB.resumeApproved(gateId, slowEffect);
  assert.equal(blocked.kind, "leaseUnavailable");
  assert.ok(blocked.kind === "leaseUnavailable");
  assert.equal(blocked.holderWorkerId, "worker-a");
  assert.equal(executions.length, 1);

  releaseEffect!();
  const done = await inFlight;
  assert.equal(done.kind, "executed");

  // After A completes and releases, B finds the consumed, terminal state.
  const after = await workerB.resumeApproved(gateId, slowEffect);
  assert.equal(after.kind, "alreadyExecuted");
  assert.equal(executions.length, 1);
});

test("lease loss mid-effect: the next holder recovers via attempt records, not a blind re-run", async () => {
  const now = testClock();
  const gateStore = createInMemoryGateStoreV1({ now });
  const leaseStore = createInMemoryLeaseStoreV1({ now });
  const { store: attemptStore, armCrash } = completeCrashingStore(now);
  const shared = { gateStore, attemptStore, leaseStore };
  const workerA = machineryWith({ workerId: "worker-a", shared });
  const workerB = machineryWith({ workerId: "worker-b", shared });
  const ledger = createEffectLedger({ platformIdempotent: false, reconcilable: true });

  const gateId = await openApprovedGate(workerA);
  armCrash();
  await assert.rejects(() => workerA.resumeApproved(gateId, ledger.effect), /before the outcome/);
  assert.equal(ledger.executions.length, 1);

  // Worker B acquires next and MUST consult the open attempt record first:
  // reconciliation proves the effect ran, so it adopts — no duplicate.
  const recovered = await workerB.resumeApproved(gateId, ledger.effect);
  assert.equal(recovered.kind, "recovered");
  assert.ok(recovered.kind === "recovered");
  assert.equal(recovered.method, "reconciledAdoptedOutcome");
  assert.equal(ledger.executions.length, 1);
});

test("in-memory lease semantics: renew, expiry takeover, and scoped release", async () => {
  const startMs = Date.UTC(2026, 7, 12, 6, 0, 0);
  let nowMs = startMs;
  const leaseStore = createInMemoryLeaseStoreV1({ now: () => new Date(nowMs) });

  assert.deepEqual(await leaseStore.acquire("job-1", "worker-a", 1000), { acquired: true });
  // Holder renews; a rival is refused with the holder's id.
  assert.deepEqual(await leaseStore.acquire("job-1", "worker-a", 1000), { acquired: true });
  assert.deepEqual(await leaseStore.acquire("job-1", "worker-b", 1000), {
    acquired: false,
    holderWorkerId: "worker-a",
  });
  assert.equal(await leaseStore.heartbeat("job-1", "worker-a", 1000), true);
  assert.equal(await leaseStore.heartbeat("job-1", "worker-b", 1000), false);

  // Expiry: the rival takes over; the previous holder's heartbeat fails and
  // its release no longer touches the new holder's lease.
  nowMs += 5000;
  assert.deepEqual(await leaseStore.acquire("job-1", "worker-b", 1000), { acquired: true });
  assert.equal(await leaseStore.heartbeat("job-1", "worker-a", 1000), false);
  await leaseStore.release("job-1", "worker-a");
  assert.deepEqual(await leaseStore.acquire("job-1", "worker-c", 1000), {
    acquired: false,
    holderWorkerId: "worker-b",
  });
});

// ─── Indeterminate re-offer crash repair (review suggestion 5) ──────────────

test("crash between marking an attempt indeterminate and creating its re-offer: the next drive repairs the lost re-offer", async () => {
  const machinery = machineryWith();
  const ledger = createEffectLedger({ platformIdempotent: false });
  const gateId = await openApprovedGate(machinery);

  // Simulate the partial recovery a killed worker leaves behind: the attempt
  // was marked indeterminate and the gate consumed, but the crash landed
  // BEFORE the re-offer gate was created — previously this read back as
  // `alreadyExecuted` and the re-approval prompt was silently lost.
  const attemptKey = deriveExecutionAttemptKeyV1({
    taskId: TASK_ID,
    gateId,
    effectKind: "modelProviderCall",
    lineage: 0,
  });
  await machinery.attemptStore.begin({
    attemptKey,
    taskId: TASK_ID,
    gateId,
    effectKind: "modelProviderCall",
    lineage: 0,
  });
  await machinery.attemptStore.markIndeterminate(attemptKey);
  await machinery.gateStore.markResumed(gateId);

  const repaired = await machinery.resumeApproved(gateId, ledger.effect);
  assert.equal(repaired.kind, "indeterminate");
  assert.ok(repaired.kind === "indeterminate");
  assert.equal(repaired.attemptKey, attemptKey);
  assert.equal(ledger.executions.length, 0);

  const reoffer = await machinery.gateStore.read(repaired.reofferGateId);
  assert.equal(reoffer?.state, "pending");
  assert.equal(reoffer?.reofferOfAttemptKey, attemptKey);
  const indeterminateEvents = machinery.sink.events.filter(
    (event) => event.type === "notification" && event.notification.kind === "indeterminateAttempt"
  );
  assert.equal(indeterminateEvents.length, 1);
});

test("re-driving a gate whose attempt is indeterminate returns the EXISTING re-offer — no duplicate gate, no duplicate event", async () => {
  const machinery = machineryWith();
  const ledger = createEffectLedger({ platformIdempotent: false }); // no reconcile → unknown
  const gateId = await openApprovedGate(machinery);

  ledger.crashNextBeforeSideEffect();
  await assert.rejects(() => machinery.resumeApproved(gateId, ledger.effect));

  const recovered = await machinery.resumeApproved(gateId, ledger.effect);
  assert.equal(recovered.kind, "indeterminate");
  assert.ok(recovered.kind === "indeterminate");

  const again = await machinery.resumeApproved(gateId, ledger.effect);
  assert.equal(again.kind, "indeterminate");
  assert.ok(again.kind === "indeterminate");
  assert.equal(again.reofferGateId, recovered.reofferGateId);

  const reoffers = (await machinery.gateStore.listForTask(TASK_ID)).filter(
    (gate) => gate.reofferOfAttemptKey === recovered.attemptKey
  );
  assert.equal(reoffers.length, 1);
  const indeterminateEvents = machinery.sink.events.filter(
    (event) => event.type === "notification" && event.notification.kind === "indeterminateAttempt"
  );
  assert.equal(indeterminateEvents.length, 1);
  assert.equal(ledger.executions.length, 0);
});

// ─── Ungated effects under the same protocol (Part 4d prerequisite) ─────────

test("runUngatedEffect: a step executes exactly once, replays as alreadyExecuted, and crash-recovers via reconciliation", async () => {
  const machinery = machineryWith();
  const ledger = createEffectLedger({ platformIdempotent: false, reconcilable: true });

  const first = await machinery.runUngatedEffect("source-acquisition", ledger.effect);
  assert.equal(first.kind, "executed");
  assert.ok(first.kind === "executed");
  assert.equal(ledger.executions.length, 1);

  // The same step never runs twice.
  const replay = await machinery.runUngatedEffect("source-acquisition", ledger.effect);
  assert.equal(replay.kind, "alreadyExecuted");
  assert.ok(replay.kind === "alreadyExecuted");
  assert.equal(replay.attemptKey, first.attemptKey);
  assert.equal(ledger.executions.length, 1);

  // A distinct step is a distinct deterministic key and a fresh execution;
  // a crash before its side effect recovers by reconciliation (notExecuted
  // → re-issue with the SAME key), still exactly one effect for the step.
  ledger.crashNextBeforeSideEffect();
  await assert.rejects(() => machinery.runUngatedEffect("teardown", ledger.effect));
  const recovered = await machinery.runUngatedEffect("teardown", ledger.effect);
  assert.equal(recovered.kind, "recovered");
  assert.ok(recovered.kind === "recovered");
  assert.equal(recovered.method, "reconciledReissued");
  assert.notEqual(recovered.attemptKey, first.attemptKey);
  assert.equal(ledger.executions.length, 2);
});

test("runUngatedEffect: an indeterminate step re-enters the gate flow as a re-offer gate", async () => {
  const machinery = machineryWith();
  const ledger = createEffectLedger({ platformIdempotent: false }); // no reconcile → unknown

  ledger.crashNextBeforeSideEffect();
  await assert.rejects(() => machinery.runUngatedEffect("source-acquisition", ledger.effect));

  const recovered = await machinery.runUngatedEffect("source-acquisition", ledger.effect);
  assert.equal(recovered.kind, "indeterminate");
  assert.ok(recovered.kind === "indeterminate");
  assert.equal(ledger.executions.length, 0);

  const reoffer = await machinery.gateStore.read(recovered.reofferGateId);
  assert.equal(reoffer?.state, "pending");
  assert.equal(reoffer?.reofferOfAttemptKey, recovered.attemptKey);

  // Explicit re-approval of the re-offer gate runs the effect again as a
  // NEW attempt under the re-offer gate's own deterministic key.
  await machinery.decide({
    gateId: recovered.reofferGateId,
    decision: "approve",
    idempotencyKey: allocateHex128IdV1(),
  });
  const executed = await machinery.resumeApproved(recovered.reofferGateId, ledger.effect);
  assert.equal(executed.kind, "executed");
  assert.ok(executed.kind === "executed");
  assert.notEqual(executed.attemptKey, recovered.attemptKey);
  assert.equal(ledger.executions.length, 1);
});
