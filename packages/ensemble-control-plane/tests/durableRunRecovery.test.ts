/**
 * Durable question-pause recovery (plan Part 5, restart/recovery semantics):
 * the engine's chat-transaction store runs over the control-plane store's
 * persisted backend, so a question-paused hosted run survives a control-plane
 * restart — unlike the previous in-memory-only wiring whose recorded limit
 * this suite closes:
 *
 * - a run paused on structured questions checkpoints `questionsPaused` with
 *   its durable resume point (interaction address + plan of record);
 * - a NEW store + host built from the same persisted document (a real
 *   restart) accepts the answers, rebuilds the run, and resumes it with
 *   exactly one provider invocation;
 * - the invocation-once claim persists too: a claim recorded before the
 *   crash fails the post-restart resume CLOSED (`resumeUnavailable`) and the
 *   job stays durably question-paused — never a second invocation;
 * - boot reconciliation: a stale `running` checkpoint (crashed mid-round, no
 *   durable resume point) reads `failed` after restart, never a zombie
 *   running job, while `questionsPaused` checkpoints are left recoverable.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { allocateHex128IdV1 } from "../../ensemble-core/src/actionCorrelationV1";
import type {
  EngineProviderInvocationV1,
  EngineProviderRunnerV1,
  EngineRoundResultV1,
} from "../../ensemble-engine/src/taskLoopV1";
import { createEngineRunHostV1, EngineRunHostV1 } from "../src/engineRunHostV1";
import { createSessionServiceV1 } from "../src/sessionServiceV1";
import {
  ControlPlanePersistenceV1,
  ControlPlaneStoreV1,
  createControlPlaneStoreV1,
  createInMemoryControlPlanePersistenceV1,
} from "../src/storeV1";
import { createWsHubV1 } from "../src/wsHubV1";
import { makeClock, makeFakeValidator, makeTaskRecord, TestClockV1 } from "./helpersV1";

const PLAN_OF_RECORD = "# Plan\n\n- [ ] step one\n- [ ] step two\n";
const TICK_BOTH = "# Round\n\n- [x] step one\n- [x] step two\n";

const QUESTIONS = [
  {
    questionId: "q-1",
    kind: "text",
    prompt: "Which module first?",
    required: true,
    allowBlank: false,
    maxLength: 100,
  },
] as const;

const ANSWERS = [{ questionId: "q-1", kind: "text", state: "answered", value: "ship it" }];

function scriptedRunner(
  script: (invocation: EngineProviderInvocationV1, count: number) => EngineRoundResultV1
): EngineProviderRunnerV1 & { readonly invocations: EngineProviderInvocationV1[] } {
  const invocations: EngineProviderInvocationV1[] = [];
  return {
    invocations,
    invoke(invocation): Promise<EngineRoundResultV1> {
      invocations.push(invocation);
      return Promise.resolve(script(invocation, invocations.length));
    },
  };
}

interface ProcessV1 {
  readonly store: ControlPlaneStoreV1;
  readonly host: EngineRunHostV1;
  readonly runner: EngineProviderRunnerV1 & {
    readonly invocations: EngineProviderInvocationV1[];
  };
  readonly userId: string;
}

/** Boot one "control-plane process" over the shared persisted document. */
async function bootProcess(
  persistence: ControlPlanePersistenceV1,
  clock: TestClockV1,
  script: (invocation: EngineProviderInvocationV1, count: number) => EngineRoundResultV1
): Promise<ProcessV1> {
  const store = createControlPlaneStoreV1({ persistence, now: clock.now });
  const sessions = createSessionServiceV1({
    store,
    validators: [makeFakeValidator("github", { "code-a": "subject-a" })],
    now: clock.now,
  });
  const hub = createWsHubV1({ sessions, store });
  const user = store.upsertUserByIdentity("github", "subject-a");
  const runner = scriptedRunner(script);
  const host = createEngineRunHostV1({
    store,
    hub,
    providerRunnerFor: () => runner,
    now: clock.now,
  });
  return { store, host, runner, userId: user.userId };
}

const QUESTION_THEN_COMPLETE = (
  invocation: EngineProviderInvocationV1
): EngineRoundResultV1 =>
  invocation.answers === undefined
    ? { kind: "questions", questions: [...QUESTIONS] }
    : { kind: "completed", summaryMarkdown: TICK_BOTH };

test("a question-paused run survives a control-plane restart: the new host resumes it with exactly one invocation", async () => {
  const clock = makeClock();
  const persistence = createInMemoryControlPlanePersistenceV1();

  const before = await bootProcess(persistence, clock, QUESTION_THEN_COMPLETE);
  const task = {
    ...makeTaskRecord("task-restart-1", before.userId, clock.now().toISOString()),
    request: PLAN_OF_RECORD,
  };
  before.store.createTask(task);
  const paused = await before.host.start(task);
  assert.equal(paused.kind, "questionsPaused");
  assert.ok(paused.kind === "questionsPaused");
  assert.equal(before.runner.invocations.length, 1);

  const checkpoint = before.store.readJob(task.taskId);
  assert.equal(checkpoint?.status, "questionsPaused");
  assert.equal(checkpoint?.pausedInteraction?.interactionId, paused.interactionId);
  assert.equal(checkpoint?.pausedInteraction?.planOfRecord, PLAN_OF_RECORD);

  // The restart: a NEW store loaded from the same persisted document, a NEW
  // host with nothing in memory.
  const after = await bootProcess(persistence, clock, QUESTION_THEN_COMPLETE);
  assert.equal(
    after.store.readJob(task.taskId)?.status,
    "questionsPaused",
    "boot reconciliation leaves the recoverable question pause in place"
  );
  assert.equal(after.host.pendingInteractionId(task.taskId), undefined, "nothing in memory yet");

  const answerId = allocateHex128IdV1();
  const submitted = await after.host.submitAnswers(
    task.taskId,
    paused.interactionId,
    ANSWERS,
    answerId
  );
  assert.ok(submitted.ok, "the rebuilt run accepted the answers");
  assert.equal(submitted.duplicate, false);
  assert.deepEqual(await submitted.settled, { kind: "completed" });
  assert.equal(
    after.runner.invocations.length,
    1,
    "the resumed invocation ran exactly once after the restart"
  );
  assert.deepEqual(after.runner.invocations[0]?.answers, ANSWERS);

  assert.equal(after.store.readJob(task.taskId)?.status, "completed");
  assert.equal(after.store.readTask(task.taskId)?.progress.status, "completed");
  assert.equal(after.store.readTask(task.taskId)?.rounds.length, 1);

  // A replay on the restarted host observes the original settlement.
  const replayed = await after.host.submitAnswers(
    task.taskId,
    paused.interactionId,
    ANSWERS,
    answerId
  );
  assert.ok(replayed.ok);
  assert.equal(replayed.duplicate, true);
  assert.deepEqual(await replayed.settled, { kind: "completed" });
  assert.equal(after.runner.invocations.length, 1);
});

test("an invocation-once claim recorded before the crash fails the post-restart resume closed — never a second invocation", async () => {
  const clock = makeClock();
  const persistence = createInMemoryControlPlanePersistenceV1();

  const before = await bootProcess(persistence, clock, QUESTION_THEN_COMPLETE);
  const task = {
    ...makeTaskRecord("task-restart-2", before.userId, clock.now().toISOString()),
    request: PLAN_OF_RECORD,
  };
  before.store.createTask(task);
  const paused = await before.host.start(task);
  assert.ok(paused.kind === "questionsPaused");
  const operationId = before.store.readJob(task.taskId)?.pausedInteraction?.operationId;
  assert.ok(operationId !== undefined);

  // Simulate the worst crash window: the invocation-once claim persisted,
  // but no terminal outcome ever did (the provider call was in flight).
  assert.equal(
    before.store.engineTransactions.claim(operationId, clock.now().toISOString()),
    true
  );

  const after = await bootProcess(persistence, clock, QUESTION_THEN_COMPLETE);
  const submitted = await after.host.submitAnswers(
    task.taskId,
    paused.interactionId,
    ANSWERS,
    allocateHex128IdV1()
  );
  assert.ok(submitted.ok);
  assert.deepEqual(await submitted.settled, {
    kind: "resumeUnavailable",
    code: "invocationOutcomeUnknown",
  });
  assert.equal(after.runner.invocations.length, 0, "the claimed invocation was never re-run");
  assert.equal(
    after.store.readJob(task.taskId)?.status,
    "questionsPaused",
    "the job stays durably paused on its recorded interaction"
  );
});

test("boot reconciliation fails stale running checkpoints and preserves question-paused ones", async () => {
  const clock = makeClock();
  const persistence = createInMemoryControlPlanePersistenceV1();

  const before = await bootProcess(persistence, clock, QUESTION_THEN_COMPLETE);
  const pausedTask = {
    ...makeTaskRecord("task-recon-paused", before.userId, clock.now().toISOString()),
    request: PLAN_OF_RECORD,
  };
  before.store.createTask(pausedTask);
  const paused = await before.host.start(pausedTask);
  assert.ok(paused.kind === "questionsPaused");

  // A crashed mid-round run: checkpointed `running`, no durable resume point.
  before.store.upsertJob({
    jobId: "task-recon-zombie",
    taskId: "task-recon-zombie",
    ownerUserId: before.userId,
    status: "running",
    updatedAt: clock.now().toISOString(),
  });

  const after = await bootProcess(persistence, clock, QUESTION_THEN_COMPLETE);
  assert.equal(
    after.store.readJob("task-recon-zombie")?.status,
    "failed",
    "the stale running checkpoint reconciled to failed at boot"
  );
  assert.equal(
    after.store.readJob(pausedTask.taskId)?.status,
    "questionsPaused",
    "the recoverable question pause was left in place"
  );
});
