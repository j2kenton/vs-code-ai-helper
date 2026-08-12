/**
 * Hosted engine-run tests (plan Part 5, "host/supervise Part 4 engine
 * runs"): the control plane drives the Part 4a task loop end to end —
 * scripted runners for the loop semantics, REAL Part 4b provider dispatch
 * (with custody-decrypted keys) for the composition proof, and the HTTP
 * handler for the contract wiring:
 *
 * - a checklist plan drives rounds to plan-complete, persisting progress,
 *   per-round history, and job checkpoints, with events fanned out to the
 *   owner's WS subscription;
 * - a questions round pauses the run; answers submitted through the host
 *   resume it exactly once, and a replayed submission observes the original
 *   settlement instead of re-invoking the provider;
 * - Part 4b dispatch (adapters + chain resolution + result-envelope
 *   discipline) runs inside the hosted loop with the model key decrypted
 *   from custody into engine-run memory only;
 * - the HTTP surface starts hosted runs at task creation and routes
 *   structured answers into the paused run (404 for a foreign/unknown
 *   interaction, 422 for rejected answers).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { allocateHex128IdV1 } from "../../ensemble-core/src/actionCorrelationV1";
import type { ModelSettings } from "../../ensemble-core/src/settingsV1";
import type { WsServerEventV1 } from "../../ensemble-contract/src/wsEventsV1";
import type {
  EngineModelProviderAdapterV1,
  EngineTextInvocationV1,
} from "../../ensemble-engine/src/providerAdaptersV1";
import { createEngineProviderRunnerV1 } from "../../ensemble-engine/src/providerDispatchV1";
import type {
  EngineProviderInvocationV1,
  EngineProviderRunnerV1,
  EngineRoundResultV1,
} from "../../ensemble-engine/src/taskLoopV1";
import { createInMemorySandboxClientV1 } from "../../ensemble-engine/src/sandboxClientV1";
import {
  createControlPlaneHandlerV1,
  ControlPlaneHttpRequestV1,
} from "../src/controlPlaneServerV1";
import { createEngineRunHostV1, EngineRunHostV1 } from "../src/engineRunHostV1";
import {
  createBootSecretKekProviderV1,
  decryptKeyMaterialV1,
  encryptKeyMaterialV1,
  maskKeyHintV1,
} from "../src/keyCustodyV1";
import { createSessionServiceV1 } from "../src/sessionServiceV1";
import { taskModelSettingsV1 } from "../src/taskModelSettingsV1";
import { createControlPlaneStoreV1, ControlPlaneStoreV1 } from "../src/storeV1";
import { createWsHubV1, WsHubV1 } from "../src/wsHubV1";
import { makeClock, makeFakeValidator, makeTaskRecord, TestClockV1 } from "./helpersV1";

const PLAN_OF_RECORD = "# Plan\n\n- [ ] step one\n- [ ] step two\n";
const TICK_ONE = "# Round\n\n- [x] step one\n- [ ] step two\n";
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

interface HostWorld {
  readonly clock: TestClockV1;
  readonly store: ControlPlaneStoreV1;
  readonly hub: WsHubV1;
  readonly userId: string;
  readonly token: string;
  makeHost(runner: EngineProviderRunnerV1): EngineRunHostV1;
  /** Subscribe an owner connection and collect delivered events. */
  subscribe(): Promise<WsServerEventV1[]>;
}

async function makeHostWorld(): Promise<HostWorld> {
  const clock = makeClock();
  const store = createControlPlaneStoreV1({ now: clock.now });
  const sessions = createSessionServiceV1({
    store,
    validators: [makeFakeValidator("github", { "code-a": "subject-a" })],
    now: clock.now,
  });
  const hub = createWsHubV1({ sessions, store });
  const exchanged = await sessions.exchange({
    provider: "github",
    authorizationCode: "code-a",
    codeVerifier: "v",
    redirectUri: "app://callback",
  });
  assert.ok(exchanged.ok);
  const token = exchanged.tokens.accessToken;
  return {
    clock,
    store,
    hub,
    userId: exchanged.userId,
    token,
    makeHost(runner: EngineProviderRunnerV1): EngineRunHostV1 {
      return createEngineRunHostV1({
        store,
        hub,
        providerRunnerFor: () => runner,
        now: clock.now,
      });
    },
    async subscribe(): Promise<WsServerEventV1[]> {
      const events: WsServerEventV1[] = [];
      const connection = hub.connect((event) => events.push(event));
      await connection.handleMessage({ type: "subscribe", accessToken: token });
      return events;
    },
  };
}

test("a checklist plan drives to completion: progress persisted, rounds recorded, job completed, events fanned out", async () => {
  const world = await makeHostWorld();
  const events = await world.subscribe();
  const runner = scriptedRunner((_invocation, count) => ({
    kind: "completed",
    summaryMarkdown: count === 1 ? TICK_ONE : TICK_BOTH,
  }));
  const host = world.makeHost(runner);
  const task = {
    ...makeTaskRecord("task-run-1", world.userId, world.clock.now().toISOString()),
    request: PLAN_OF_RECORD,
  };
  world.store.createTask(task);

  const outcome = await host.start(task);
  assert.deepEqual(outcome, { kind: "completed" });
  assert.equal(runner.invocations.length, 2, "two rounds finish the two-item checklist");

  const persisted = world.store.readTask(task.taskId);
  assert.ok(persisted !== undefined);
  assert.equal(persisted.progress.status, "completed", "the sink persisted the progress snapshots");
  assert.equal(persisted.rounds.length, 2, "each completed round appended history");
  assert.equal(persisted.rounds[0]?.summary, "1/2");
  assert.equal(persisted.rounds[1]?.summary, "2/2");

  assert.equal(world.store.readJob(task.taskId)?.status, "completed");

  assert.ok(
    events.some((event) => event.type === "taskProgress"),
    "task-progress frames reached the owner's subscription"
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "notification" &&
        event.notification.kind === "agentLifecycle" &&
        event.notification.phase === "completed"
    ),
    "the completion lifecycle notification reached the owner's subscription"
  );

  // start() is idempotent: a second call observes the same settlement and
  // never spawns a second engine task.
  assert.deepEqual(await host.start(task), { kind: "completed" });
  assert.equal(runner.invocations.length, 2);
});

test("a questions round pauses; answers resume exactly once; a replayed submission observes the original settlement", async () => {
  const world = await makeHostWorld();
  const runner = scriptedRunner((invocation) =>
    invocation.answers === undefined
      ? { kind: "questions", questions: [...QUESTIONS] }
      : { kind: "completed", summaryMarkdown: TICK_BOTH }
  );
  const host = world.makeHost(runner);
  const task = {
    ...makeTaskRecord("task-run-2", world.userId, world.clock.now().toISOString()),
    request: PLAN_OF_RECORD,
  };
  world.store.createTask(task);

  const paused = await host.start(task);
  assert.equal(paused.kind, "questionsPaused");
  assert.ok(paused.kind === "questionsPaused");
  assert.equal(host.pendingInteractionId(task.taskId), paused.interactionId);
  assert.equal(world.store.readTask(task.taskId)?.progress.status, "paused");
  assert.ok(
    world.store
      .listChatTurns(task.taskId)
      .some((turn) => turn.role === "assistant" && turn.interactionId === paused.interactionId),
    "the question post landed in the task's chat thread"
  );

  const answerId = allocateHex128IdV1();
  const submitted = await host.submitAnswers(task.taskId, paused.interactionId, ANSWERS, answerId);
  assert.ok(submitted.ok);
  assert.equal(submitted.duplicate, false);
  assert.deepEqual(await submitted.settled, { kind: "completed" });
  assert.equal(runner.invocations.length, 2, "the resumed invocation ran exactly once");
  assert.equal(world.store.readJob(task.taskId)?.status, "completed");

  // A replay (same interaction, same idempotency id) never re-invokes.
  const replayed = await host.submitAnswers(task.taskId, paused.interactionId, ANSWERS, answerId);
  assert.ok(replayed.ok);
  assert.equal(replayed.duplicate, true);
  assert.deepEqual(await replayed.settled, { kind: "completed" });
  assert.equal(runner.invocations.length, 2);

  // An unknown interaction is refused without touching the engine.
  const unknown = await host.submitAnswers(task.taskId, "f".repeat(32), ANSWERS, allocateHex128IdV1());
  assert.ok(!unknown.ok);
  assert.equal(unknown.code, "unknownInteraction");
});

test("Part 4b dispatch drives a hosted run end to end with the model key decrypted from custody", async () => {
  const world = await makeHostWorld();

  // Custody: the key exists only as an envelope; dispatch sees the decrypted
  // material in engine-run memory only.
  const kek = createBootSecretKekProviderV1({ kekId: "kek-1", bootSecret: "boot" });
  const envelope = await encryptKeyMaterialV1(kek, "sk-ant-live-1234");
  world.store.writeKeyRecord({
    keyKind: "model:anthropic",
    ownerUserId: world.userId,
    envelope,
    maskedHint: maskKeyHintV1("sk-ant-live-1234"),
    updatedAt: world.clock.now().toISOString(),
  });
  const keyRecord = world.store.readKeyRecord(world.userId, "model:anthropic");
  assert.ok(keyRecord !== undefined);
  const apiKey = await decryptKeyMaterialV1(kek, keyRecord.envelope);

  const seenKeys: string[] = [];
  const anthropic: EngineModelProviderAdapterV1 = {
    providerId: "anthropic",
    invokeText(input: EngineTextInvocationV1) {
      seenKeys.push(input.apiKey);
      const match = /\(echo it verbatim\): (\{[^\n]*\})/.exec(input.prompt);
      assert.ok(match, "the round prompt carries the correlation echo");
      const correlation = JSON.parse(match[1] as string) as unknown;
      const payload = {
        version: 1,
        correlation,
        kind: "completed",
        content: {
          contentType: "markdown-artifact.v1",
          schemaVersion: 1,
          markdown: TICK_BOTH,
        },
      };
      return Promise.resolve({
        status: "completed" as const,
        text: `<<<ENSEMBLE_AI_RESULT_V1>>>\n${JSON.stringify(payload)}\n<<<END_ENSEMBLE_AI_RESULT_V1>>>\n`,
      });
    },
  };
  const settings: ModelSettings = {
    desc: { primary: "anthropic:claude-sonnet-5", strategy: "switch-to-backup" },
  };
  const runner = createEngineProviderRunnerV1({
    getModelSettings: () => settings,
    getEnabledProviders: () => ({ anthropic: true, openai: true, google: true }),
    getProviderApiKey: (provider) => (provider === "anthropic" ? apiKey : undefined),
    adapters: new Map([["anthropic", anthropic]]),
  });

  const host = world.makeHost(runner);
  const task = {
    ...makeTaskRecord("task-run-3", world.userId, world.clock.now().toISOString()),
    request: PLAN_OF_RECORD,
  };
  world.store.createTask(task);

  const outcome = await host.start(task);
  assert.deepEqual(outcome, { kind: "completed" });
  assert.deepEqual(seenKeys, ["sk-ant-live-1234"], "dispatch used the custody-decrypted key");
  assert.equal(world.store.readTask(task.taskId)?.progress.status, "completed");
});

test("a non-retryable provider failure checkpoints the job failed", async () => {
  const world = await makeHostWorld();
  const runner = scriptedRunner(() => ({
    kind: "failed",
    code: "authenticationFailed",
    retryable: false,
  }));
  const host = world.makeHost(runner);
  const task = {
    ...makeTaskRecord("task-run-4", world.userId, world.clock.now().toISOString()),
    request: PLAN_OF_RECORD,
  };
  world.store.createTask(task);

  const outcome = await host.start(task);
  assert.deepEqual(outcome, { kind: "failed", code: "authenticationFailed" });
  assert.equal(world.store.readJob(task.taskId)?.status, "failed");
});

test("HTTP surface: task creation starts the hosted run; structured answers route into it", async () => {
  const world = await makeHostWorld();
  const runner = scriptedRunner((invocation) =>
    invocation.answers === undefined
      ? { kind: "questions", questions: [...QUESTIONS] }
      : { kind: "completed", summaryMarkdown: TICK_BOTH }
  );
  const host = world.makeHost(runner);

  const sessions = createSessionServiceV1({
    store: world.store,
    validators: [makeFakeValidator("github", { "code-a": "subject-a" })],
    now: world.clock.now,
  });
  const kekProvider = createBootSecretKekProviderV1({ kekId: "kek-1", bootSecret: "boot" });
  const sandbox = createInMemorySandboxClientV1();
  sandbox.addDirectory("sbx-1", "/workspace/src");
  const handler = createControlPlaneHandlerV1({
    store: world.store,
    sessions,
    hub: world.hub,
    kekProvider,
    sandboxFactory: { clientFor: () => sandbox },
    runs: host,
    now: world.clock.now,
  });
  function call(
    method: string,
    path: string,
    body?: unknown
  ): Promise<{ status: number; body?: unknown }> {
    const httpRequest: ControlPlaneHttpRequestV1 = {
      method,
      path,
      query: {},
      headers: { authorization: `Bearer ${world.token}` },
      ...(body !== undefined ? { body } : {}),
    };
    return handler.handle(httpRequest);
  }

  const put = await call("PUT", "/v1/keys/sandbox:e2b", { key: "e2b_live_key_9876" });
  assert.equal(put.status, 204);
  const created = await call("POST", "/v1/tasks", {
    request: PLAN_OF_RECORD,
    displayName: "Hosted run",
    sandboxBinding: {
      provider: "e2b",
      sandboxId: "sbx-1",
      source: { kind: "attachExisting", path: "/workspace" },
      workingDirectoryRoot: "/workspace",
      lifecycle: "user-managed-persistent",
      cleanup: "retain",
    },
  });
  assert.equal(created.status, 201);
  const taskId = (created.body as { taskId: string }).taskId;

  const settled = host.settled(taskId);
  assert.ok(settled !== undefined, "task creation started the hosted run");
  const paused = await settled;
  assert.equal(paused.kind, "questionsPaused");
  assert.ok(paused.kind === "questionsPaused");

  // A wrong interaction id is refused before anything reaches the engine.
  const wrong = await call("POST", `/v1/tasks/${taskId}/chat`, {
    kind: "structuredAnswers",
    interactionId: "f".repeat(32),
    answers: ANSWERS,
    answerIdempotencyId: allocateHex128IdV1(),
  });
  assert.equal(wrong.status, 404);

  const answered = await call("POST", `/v1/tasks/${taskId}/chat`, {
    kind: "structuredAnswers",
    interactionId: paused.interactionId,
    answers: ANSWERS,
    answerIdempotencyId: allocateHex128IdV1(),
  });
  assert.equal(answered.status, 202);
  const final = await host.settled(taskId);
  assert.ok(final !== undefined);
  assert.deepEqual(final, { kind: "completed" });

  const read = await call("GET", `/v1/tasks/${taskId}`);
  assert.equal(read.status, 200);
  const progress = (read.body as { progress: { status: string } }).progress;
  assert.equal(progress.status, "completed");
  assert.equal(world.store.readJob(taskId)?.status, "completed");
});

test("Part 9 round trip: the model selected at task creation drives the hosted run's provider dispatch", async () => {
  const world = await makeHostWorld();
  const kek = createBootSecretKekProviderV1({ kekId: "kek-1", bootSecret: "boot" });
  world.store.writeKeyRecord({
    keyKind: "model:anthropic",
    ownerUserId: world.userId,
    envelope: await encryptKeyMaterialV1(kek, "sk-ant-live-1234"),
    maskedHint: maskKeyHintV1("sk-ant-live-1234"),
    updatedAt: world.clock.now().toISOString(),
  });
  const modelKeyRecord = world.store.readKeyRecord(world.userId, "model:anthropic");
  assert.ok(modelKeyRecord !== undefined);
  const apiKey = await decryptKeyMaterialV1(kek, modelKeyRecord.envelope);

  const seenModels: Array<string | undefined> = [];
  const anthropic: EngineModelProviderAdapterV1 = {
    providerId: "anthropic",
    invokeText(input: EngineTextInvocationV1) {
      seenModels.push(input.model);
      const match = /\(echo it verbatim\): (\{[^\n]*\})/.exec(input.prompt);
      assert.ok(match, "the round prompt carries the correlation echo");
      const payload = {
        version: 1,
        correlation: JSON.parse(match[1] as string) as unknown,
        kind: "completed",
        content: {
          contentType: "markdown-artifact.v1",
          schemaVersion: 1,
          markdown: TICK_BOTH,
        },
      };
      return Promise.resolve({
        status: "completed" as const,
        text: `<<<ENSEMBLE_AI_RESULT_V1>>>\n${JSON.stringify(payload)}\n<<<END_ENSEMBLE_AI_RESULT_V1>>>\n`,
      });
    },
  };

  // Production-shaped composition: each task's dispatch resolves its chain
  // from the task record's validated selection (taskModelSettingsV1).
  const host = createEngineRunHostV1({
    store: world.store,
    hub: world.hub,
    providerRunnerFor: (task) =>
      createEngineProviderRunnerV1({
        getModelSettings: (): ModelSettings => taskModelSettingsV1(task),
        getEnabledProviders: () => ({ anthropic: true, openai: true, google: true }),
        getProviderApiKey: (provider) => (provider === "anthropic" ? apiKey : undefined),
        adapters: new Map([["anthropic", anthropic]]),
      }),
    now: world.clock.now,
  });

  const sessions = createSessionServiceV1({
    store: world.store,
    validators: [makeFakeValidator("github", { "code-a": "subject-a" })],
    now: world.clock.now,
  });
  const sandbox = createInMemorySandboxClientV1();
  sandbox.addDirectory("sbx-1", "/workspace/src");
  const handler = createControlPlaneHandlerV1({
    store: world.store,
    sessions,
    hub: world.hub,
    kekProvider: kek,
    sandboxFactory: { clientFor: () => sandbox },
    runs: host,
    now: world.clock.now,
  });
  function call(
    method: string,
    path: string,
    body?: unknown
  ): Promise<{ status: number; body?: unknown }> {
    const httpRequest: ControlPlaneHttpRequestV1 = {
      method,
      path,
      query: {},
      headers: { authorization: `Bearer ${world.token}` },
      ...(body !== undefined ? { body } : {}),
    };
    return handler.handle(httpRequest);
  }

  const put = await call("PUT", "/v1/keys/sandbox:e2b", { key: "e2b_live_key_9876" });
  assert.equal(put.status, 204);
  // The client sends the legacy alias; the contract normalizes it and the
  // engine's rounds run with the resolved provider-native model.
  const created = await call("POST", "/v1/tasks", {
    request: PLAN_OF_RECORD,
    model: "anthropic:opus",
    sandboxBinding: {
      provider: "e2b",
      sandboxId: "sbx-1",
      source: { kind: "attachExisting", path: "/workspace" },
      workingDirectoryRoot: "/workspace",
      lifecycle: "user-managed-persistent",
      cleanup: "retain",
    },
  });
  assert.equal(created.status, 201);
  const taskId = (created.body as { taskId: string }).taskId;
  assert.equal(world.store.readTask(taskId)?.modelId, "anthropic:claude-opus-5");

  const settled = host.settled(taskId);
  assert.ok(settled !== undefined, "task creation started the hosted run");
  assert.deepEqual(await settled, { kind: "completed" });
  assert.ok(seenModels.length > 0, "the hosted run reached the provider adapter");
  assert.ok(
    seenModels.every((model) => model === "claude-opus-5"),
    `every round ran with the selected model (saw ${JSON.stringify(seenModels)})`
  );
});
