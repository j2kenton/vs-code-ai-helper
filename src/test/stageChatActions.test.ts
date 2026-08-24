/**
 * Coverage for the stage-chat action boundary: a stage-chat response may
 * propose exactly one of the FOUR pinned stage actions (complete stage, set
 * this task's stage, trigger this task's AI action, complete task) via the
 * shared typed `[[ACTION:id]]` envelope (legacy `[[STAGE_ACTION:id]]`
 * accepted); each id is a global-assistant operation id and executes through
 * the shared typed executor (executeProposedAction) with the chat's own task
 * pinned as the target. Envelope extraction, payload pinning, and the
 * allowlist registry are pure/VS-Code-free, so they're tested directly here
 * without a host.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import * as vscode from "vscode";
import {
  buildStageActionPayload,
  buildStageResponsePrompt,
  dispatchProposedStageActionV1,
  getStageChatAction,
  splitStageActionEnvelopes,
  STAGE_CHAT_ACTIONS,
} from "../commands/chatWithStage";
import { planStageAction } from "../utils/chatStageActionEnvelope";
import { getGlobalAssistantOperation } from "../utils/globalAssistantActions";
import { ChatViewProvider } from "../views/chatView";
import { readChatHistory } from "../utils/chatHistoryStore";
import { makeOwnedTaskFolder } from "./taskFolderFixture";
import { TaskInventory, TaskWithProgress } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { createChatSendRowV1 } from "../actions/rows/chatSendRowV1";
import { TaskActionExecutionContextV1 } from "../actions/taskActionRegistryV1";
import { CompletedContentV1 } from "../types/aiResultEnvelope";
import { ActionCorrelationV1 } from "../types/actionCorrelationV1";

/** Bridges vscode.workspace.fs.readFile to the real filesystem, mirroring
 * globalAssistantSendRowV1.test.ts's installReadFileBridge — the dispatch
 * tests below write real chat history to a real temp task folder. */
function installReadFileBridge(): { restore: () => void } {
  const target = vscode.workspace.fs as unknown as Record<string, unknown>;
  const orig = target.readFile;
  target.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  return { restore: (): void => { target.readFile = orig; } };
}

function makeMemento(): vscode.Memento {
  const store = new Map<string, unknown>();
  return {
    get: <T>(key: string, defaultValue?: T): T => (store.has(key) ? (store.get(key) as T) : (defaultValue as T)),
    update: (key: string, value: unknown): Promise<void> => {
      if (value === undefined) store.delete(key);
      else store.set(key, value);
      return Promise.resolve();
    },
    keys: (): readonly string[] => [...store.keys()],
  } as unknown as vscode.Memento;
}

/** A minimal, mutable single-task inventory: mirrors globalAssistantSendRowV1's
 * `Object.create(TaskInventory.prototype)` stub pattern, but keeps the task in
 * a closed-over array so a command stub can mutate its progress in place and
 * have `getTasks()` (called again after refresh) observe the change — exactly
 * how the real inventory's refresh-then-reread flow behaves. */
function makeSingleTaskInventory(task: TaskWithProgress): TaskInventory {
  const inventory = Object.create(TaskInventory.prototype) as TaskInventory;
  inventory.getTasks = (): TaskWithProgress[] => [task];
  inventory.refresh = async (): Promise<void> => { /* no-op: the command stub mutates task.progress directly */ };
  return inventory;
}

function makeContextStub(): vscode.ExtensionContext {
  return { workspaceState: makeMemento() } as unknown as vscode.ExtensionContext;
}

void test("returns the text unchanged when no envelope is present", () => {
  const result = splitStageActionEnvelopes("just a normal answer");
  assert.equal(result.text, "just a normal answer");
  assert.deepEqual(result.actions, []);
});

void test("extracts the action id and strips the envelope from the text", () => {
  const result = splitStageActionEnvelopes(
    "Done — I'll mark the task complete.\n\n[[STAGE_ACTION:completeTask]]"
  );
  assert.equal(result.text, "Done — I'll mark the task complete.");
  assert.deepEqual(
    result.actions.map((a) => a.id),
    ["completeTask"]
  );
});

void test("extracts every envelope so multi-action responses can be rejected whole", () => {
  const result = splitStageActionEnvelopes(
    "[[STAGE_ACTION:completeStage]] and [[STAGE_ACTION:completeTask]]"
  );
  assert.equal(result.text, "and");
  assert.deepEqual(
    result.actions.map((a) => a.id),
    ["completeStage", "completeTask"]
  );
});

void test("no envelope survives into the displayed text even for unknown ids", () => {
  const result = splitStageActionEnvelopes("Answer. [[STAGE_ACTION:formatDisk]]");
  assert.ok(!result.text.includes("STAGE_ACTION"));
  assert.deepEqual(
    result.actions.map((a) => a.id),
    ["formatDisk"]
  );
});

void test("unknown action ids are not in the registry", () => {
  assert.equal(getStageChatAction("formatDisk"), undefined);
  assert.equal(getStageChatAction(""), undefined);
});

void test("the catalog is exactly the four approved pinned stage actions", () => {
  assert.deepEqual(
    STAGE_CHAT_ACTIONS.map((action) => action.id),
    ["completeStage", "setTaskStage", "triggerStageAI", "completeTask"]
  );
});

void test("every stage action executes through the shared typed executor", () => {
  for (const action of STAGE_CHAT_ACTIONS) {
    const operation = getGlobalAssistantOperation(action.id);
    assert.ok(
      operation,
      `${action.id} must be a global-assistant operation so it runs through executeProposedAction`
    );
    assert.equal(
      operation.requiresConfirmation,
      true,
      `${action.id} must be confirmation-gated`
    );
    // The executor receives the pinned {taskFolder} payload plus the
    // action's allowlisted pass-through keys (setTaskStage's "stage").
    const payload = buildStageActionPayload(
      action,
      "some-task",
      action.id === "setTaskStage" ? { stage: "plan" } : undefined
    );
    assert.equal(
      operation.validatePayload(payload),
      undefined,
      `${action.id} must accept the chat's pinned payload`
    );
    assert.ok(action.label.length > 0, `${action.id} needs a label`);
    assert.ok(action.description.length > 0, `${action.id} needs a description`);
    assert.equal(getStageChatAction(action.id), action);
  }
});

void test("the proposal payload can never retarget another task", () => {
  const setStage = getStageChatAction("setTaskStage");
  assert.ok(setStage);
  const payload = buildStageActionPayload(setStage, "the-chats-own-task", {
    taskFolder: "some-other-task",
    stage: "impl",
    extraneous: "dropped",
  });
  assert.deepEqual(payload, {
    stage: "impl",
    taskFolder: "the-chats-own-task",
  });

  // Actions with no allowlisted keys pass nothing through at all.
  const completeTask = getStageChatAction("completeTask");
  assert.ok(completeTask);
  assert.deepEqual(
    buildStageActionPayload(completeTask, "the-chats-own-task", {
      taskFolder: "some-other-task",
      stage: "impl",
    }),
    { taskFolder: "the-chats-own-task" }
  );
});

void test("stage prompt advertises the shared ACTION envelope and every action id", () => {
  const prompt = buildStageResponsePrompt("Plan", "my-task", "", "ctx", "msg");
  assert.ok(prompt.includes("[[ACTION:"), "prompt must advertise the shared typed envelope");
  assert.ok(prompt.includes("[[STAGE_ACTION:"), "prompt must mention the legacy form");
  for (const action of STAGE_CHAT_ACTIONS) {
    assert.ok(prompt.includes(action.id), `prompt must list ${action.id}`);
  }
});

void test("accepts the shared typed [[ACTION:...]] protocol alongside the legacy form", () => {
  const shared = splitStageActionEnvelopes("Marking done. [[ACTION:completeTask]]");
  assert.equal(shared.text, "Marking done.");
  assert.deepEqual(
    shared.actions.map((a) => a.id),
    ["completeTask"]
  );

  // A JSON payload is captured (setTaskStage needs its target stage); the
  // target task is still pinned by buildStageActionPayload at execution.
  const withPayload = splitStageActionEnvelopes(
    'Done. [[ACTION:setTaskStage {"stage": "impl"}]]'
  );
  assert.equal(withPayload.text, "Done.");
  assert.deepEqual(withPayload.actions, [
    { id: "setTaskStage", payload: { stage: "impl" } },
  ]);

  // An unparseable payload yields undefined — the operation's own
  // validation then rejects it with a useful message.
  const broken = splitStageActionEnvelopes("Done. [[ACTION:setTaskStage {not json}]]");
  assert.deepEqual(broken.actions, [{ id: "setTaskStage", payload: undefined }]);

  const mixed = splitStageActionEnvelopes(
    "[[ACTION:completeStage]] then [[STAGE_ACTION:completeTask]]"
  );
  assert.deepEqual(
    mixed.actions.map((a) => a.id),
    ["completeStage", "completeTask"]
  );
  assert.ok(!mixed.text.includes("ACTION"));
});

// planStageAction is the dispatch-path decision `chatSendRowV1.ts`'s
// production promotion path (`promoteChatSendContentV1`) actually runs on
// every send: this is the fix for the previously-dead `proposedAction`
// variable in chatWithStage.ts (declared, never assigned — the "silently
// dropped stage change" defect). These tests pin the same three verdicts
// that function now derives from `splitStageActionEnvelopes`'s output.

void test("planStageAction proposes the single recognized action", () => {
  const plan = planStageAction([{ id: "completeTask" }]);
  assert.deepEqual(plan, { action: "propose", proposal: { id: "completeTask" } });
});

void test("planStageAction is a no-op for an empty action list", () => {
  assert.deepEqual(planStageAction([]), { action: "none" });
});

void test("planStageAction rejects whole when more than one action is proposed", () => {
  const plan = planStageAction([{ id: "completeStage" }, { id: "completeTask" }]);
  assert.equal(plan.action, "reject");
  assert.ok(plan.action === "reject" && /proposed 2 actions/.test(plan.note));
  assert.ok(plan.action === "reject" && plan.note.includes("completeStage"));
  assert.ok(plan.action === "reject" && plan.note.includes("completeTask"));
});

void test("planStageAction rejects a single action id outside the pinned catalog", () => {
  const plan = planStageAction([{ id: "formatDisk" }]);
  assert.equal(plan.action, "reject");
  assert.ok(plan.action === "reject" && plan.note.includes("formatDisk"));
  assert.ok(plan.action === "reject" && plan.note.includes("not one of this task's stage actions"));
});

void test("planStageAction carries a JSON payload through to the proposal", () => {
  const plan = planStageAction([{ id: "setTaskStage", payload: { stage: "impl" } }]);
  assert.deepEqual(plan, {
    action: "propose",
    proposal: { id: "setTaskStage", payload: { stage: "impl" } },
  });
});

void test("the full dispatch path rejects a malformed (unparseable JSON) payload rather than applying it", () => {
  // End to end: splitStageActionEnvelopes -> planStageAction -> the same
  // buildStageActionPayload/operation.validatePayload pair
  // dispatchProposedStageActionV1 (chatWithStage.ts) actually calls. An
  // unparseable payload yields `payload: undefined`, which planStageAction
  // still proposes (id was recognized), but the operation's own validation
  // is what refuses it — malformed input must never reach setTaskStage's
  // effect.
  const { actions } = splitStageActionEnvelopes("Done. [[ACTION:setTaskStage {not json}]]");
  const plan = planStageAction(actions);
  assert.equal(plan.action, "propose", "the id was recognized, so planStageAction proposes it");
  assert.ok(plan.action === "propose" && plan.proposal.payload === undefined);

  const action = getStageChatAction("setTaskStage")!;
  const payload = buildStageActionPayload(action, "some-task", plan.action === "propose" ? plan.proposal.payload : undefined);
  const operation = getGlobalAssistantOperation("setTaskStage")!;
  const validationError = operation.validatePayload(payload);
  assert.ok(
    typeof validationError === "string" && validationError.length > 0,
    "a malformed payload must be refused by the operation's own validation, not silently applied"
  );
});

// Class guard (PART 3.3): every bracket envelope token the stage-chat prompt
// actually advertises to the model must have a production extractor that
// really does something with the result — not just a definition and a test
// file, which is exactly how splitStageActionEnvelopes shipped unwired for
// the ACTION envelope before this round. This scans the prompt text itself
// for every `[[TOKEN` opener rather than checking a fixed list, so a THIRD
// envelope added to the prompt later — without an extractor — fails this
// test instead of shipping the same way. (A prior revision of this prompt
// also advertised `[[QUESTION]]...[[/QUESTION]]` with no extractor anywhere;
// removed rather than wired, since a working structured-question mechanism
// — the JSON `"kind":"questions"` envelope `buildAiResultContractPromptV1`
// appends after this prompt — already covers that need. See
// buildStageResponsePrompt's own doc comment.)
//
// Deliberately routes through `createChatSendRowV1().promoteCompletedContent`
// — the actual `chatSend.v1` production write path — rather than calling
// `splitFileUpdateEnvelopes`/`splitStageActionEnvelopes` directly. A prior
// version of this test called the parser functions in isolation, which meant
// deleting the `splitStageActionEnvelopes(...)` call from
// `promoteChatSendContentV1` (chatSendRowV1.ts) — recreating exactly the
// silently-dropped-action defect this task fixes — would have left the test
// green, since the parser it exercised directly still worked in isolation.
// Routing through the real promotion function means a regression like that
// shows up here: the raw bracket text would survive into the persisted
// message because nothing stripped it.
void test("every bracket envelope token this prompt advertises is consumed by the actual chatSend.v1 production write path (class guard)", async () => {
  const prompt = buildStageResponsePrompt("Plan", "my-task", "", "ctx", "msg");

  const advertisedTokens = [
    ...new Set([...prompt.matchAll(/\[\[([A-Z_]+):/g)].map((m) => m[1]!)),
  ];
  assert.deepEqual(
    new Set(advertisedTokens),
    new Set(["UPDATE_FILE", "ACTION", "STAGE_ACTION"]),
    "a bracket envelope token was added to (or removed from) the prompt without updating this guard's wired-token list"
  );

  const bridge = installReadFileBridge();
  const { folder } = makeOwnedTaskFolder("stage-action-class-guard-");
  // One Chat document per task folder (canonicalId only affects binding
  // resolution, not which file is written), so every iteration below shares
  // and APPENDS to the same transcript — always inspect the newest message,
  // never history[0].
  const canonicalId = folder;
  try {
    const row = createChatSendRowV1();
    const correlation: ActionCorrelationV1 = {
      actionKey: "chatSend.v1",
      operationId: "op-class-guard",
      attemptId: "attempt-class-guard",
      taskBindingId: "binding-1",
      chatDocumentId: "doc-1",
    };
    const context: TaskActionExecutionContextV1 = {
      correlation,
      stage: "desc",
      validatedInput: { prompt: "irrelevant", taskFolderPath: folder, canonicalId },
    };
    for (const token of advertisedTokens) {
      const envelopeText =
        token === "UPDATE_FILE"
          ? "[[UPDATE_FILE:notes.md]]new content[[/UPDATE_FILE]]"
          : token === "STAGE_ACTION"
            ? "[[STAGE_ACTION:completeTask]]"
            : "[[ACTION:completeTask]]";
      const content: CompletedContentV1 = {
        contentType: "chat-message.v1",
        schemaVersion: 1,
        text: `Answer. ${envelopeText}`,
      };
      const code = await row.promoteCompletedContent(content, context);
      assert.equal(code, "completed");

      const history = await readChatHistory(folder, canonicalId);
      const last = history[history.length - 1];
      assert.ok(last, `expected a persisted message for token ${token}`);
      assert.ok(
        !last.text.includes(token),
        `${token} must not survive into the persisted transcript produced by the real write path — ` +
          "its production wiring may have been removed even though a parser for it still exists"
      );
      // ACTION's (and legacy STAGE_ACTION's) recognized proposal must
      // specifically reach a dispatchable verdict attached to the persisted
      // message, not just be stripped — stripping alone would also hide the
      // silently-dropped-action defect this guard exists to catch.
      if (token === "ACTION" || token === "STAGE_ACTION") {
        assert.equal(
          last.proposedStageAction?.id,
          "completeTask",
          `${token}'s recognized proposal must be attached to its persisted message, not silently dropped`
        );
      }
    }
  } finally {
    bridge.restore();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

// Dispatch-path coverage (PART 3.4): the tests above (and the "full dispatch
// path rejects a malformed..." test) only exercise the pure planner and
// payload validator. These exercise the actual exported dispatcher
// (`dispatchProposedStageActionV1`, chatWithStage.ts) end to end — applied,
// refused-by-declined-confirmation, and refused-by-validation — through a
// real `ChatViewProvider` writing to a real temp task folder, per a review
// finding that no existing test reached the dispatcher itself.
void test("dispatchProposedStageActionV1 executes a confirmed action and appends its real outcome to the transcript (applied)", async () => {
  const bridge = installReadFileBridge();
  const { folder } = makeOwnedTaskFolder("stage-dispatch-applied-");
  const win = vscode.window as unknown as Record<string, unknown>;
  const commandsObj = vscode.commands as unknown as {
    _executeCommandOverride?: (id: string, ...args: unknown[]) => Promise<unknown>;
  };
  const originalWarning = win.showWarningMessage;
  const originalExecOverride = commandsObj._executeCommandOverride;
  try {
    const task = {
      taskFolderPath: folder,
      folderName: "the-task",
      canonicalId: folder,
      sourceScopeKey: folder,
      progress: { taskFolder: "the-task", currentStage: "publish", status: "active", displayName: "The Task" },
    } as unknown as TaskWithProgress;
    const inventory = makeSingleTaskInventory(task);
    const currentTaskStore = Object.create(CurrentTaskStore.prototype) as CurrentTaskStore;

    win.showWarningMessage = (): Promise<string | undefined> => Promise.resolve("Run Action");
    // completeTask's operation delegates to vs-code-ai-helper.markTaskDone;
    // this stub mutates the same task object the inventory returns so the
    // operation's own post-condition verify() observes the change, exactly
    // like the real command would after actually marking the task done.
    commandsObj._executeCommandOverride = (id: string): Promise<unknown> => {
      assert.equal(id, "vs-code-ai-helper.markTaskDone");
      task.progress.status = "completed";
      return Promise.resolve(undefined);
    };

    const provider = new ChatViewProvider(makeMemento());
    await dispatchProposedStageActionV1(
      makeContextStub(),
      inventory,
      currentTaskStore,
      provider,
      folder,
      folder,
      "publish",
      { id: "completeTask" }
    );

    const history = await readChatHistory(folder, folder);
    assert.equal(history.length, 1);
    assert.match(history[0]!.text, /Completed "The Task"/);
  } finally {
    win.showWarningMessage = originalWarning;
    commandsObj._executeCommandOverride = originalExecOverride;
    bridge.restore();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

void test("dispatchProposedStageActionV1 appends a declined-confirmation refusal, never touching the command (refused)", async () => {
  const bridge = installReadFileBridge();
  const { folder } = makeOwnedTaskFolder("stage-dispatch-declined-");
  const win = vscode.window as unknown as Record<string, unknown>;
  const commandsObj = vscode.commands as unknown as {
    _executeCommandOverride?: (id: string, ...args: unknown[]) => Promise<unknown>;
  };
  const originalWarning = win.showWarningMessage;
  const originalExecOverride = commandsObj._executeCommandOverride;
  try {
    const task = {
      taskFolderPath: folder,
      folderName: "the-task",
      canonicalId: folder,
      sourceScopeKey: folder,
      progress: { taskFolder: "the-task", currentStage: "publish", status: "active", displayName: "The Task" },
    } as unknown as TaskWithProgress;
    const inventory = makeSingleTaskInventory(task);
    const currentTaskStore = Object.create(CurrentTaskStore.prototype) as CurrentTaskStore;

    // User dismisses the confirmation dialog.
    win.showWarningMessage = (): Promise<string | undefined> => Promise.resolve(undefined);
    commandsObj._executeCommandOverride = (): Promise<unknown> => {
      throw new Error("must not execute the command when the confirmation was declined");
    };

    const provider = new ChatViewProvider(makeMemento());
    await dispatchProposedStageActionV1(
      makeContextStub(),
      inventory,
      currentTaskStore,
      provider,
      folder,
      folder,
      "publish",
      { id: "completeTask" }
    );

    const history = await readChatHistory(folder, folder);
    assert.equal(history.length, 1);
    assert.match(history[0]!.text, /not confirmed; nothing was executed/);
  } finally {
    win.showWarningMessage = originalWarning;
    commandsObj._executeCommandOverride = originalExecOverride;
    bridge.restore();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

void test("dispatchProposedStageActionV1 refuses a malformed setTaskStage payload before any confirmation is shown (malformed payload)", async () => {
  const bridge = installReadFileBridge();
  const { folder } = makeOwnedTaskFolder("stage-dispatch-malformed-");
  const win = vscode.window as unknown as Record<string, unknown>;
  const originalWarning = win.showWarningMessage;
  try {
    const task = {
      taskFolderPath: folder,
      folderName: "the-task",
      canonicalId: folder,
      sourceScopeKey: folder,
      progress: { taskFolder: "the-task", currentStage: "impl", status: "active", displayName: "The Task" },
    } as unknown as TaskWithProgress;
    const inventory = makeSingleTaskInventory(task);
    const currentTaskStore = Object.create(CurrentTaskStore.prototype) as CurrentTaskStore;

    // validatePayload must reject setTaskStage's missing "stage" before any
    // confirmation dialog is ever shown.
    win.showWarningMessage = (): Promise<string | undefined> => {
      throw new Error("must not confirm a payload that failed validation");
    };

    const provider = new ChatViewProvider(makeMemento());
    // The envelope's payload failed to parse as JSON — the real path this
    // exercises (splitStageActionEnvelopes -> planStageAction) still proposes
    // the recognized id with payload: undefined; setTaskStage's own
    // validatePayload is what must refuse it.
    await dispatchProposedStageActionV1(
      makeContextStub(),
      inventory,
      currentTaskStore,
      provider,
      folder,
      folder,
      "impl",
      { id: "setTaskStage", payload: undefined }
    );

    const history = await readChatHistory(folder, folder);
    assert.equal(history.length, 1);
    assert.match(history[0]!.text, /setTaskStage action was rejected/);
  } finally {
    win.showWarningMessage = originalWarning;
    bridge.restore();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

void test("dispatchProposedStageActionV1 refuses an unrecognized action id without executing anything (defense in depth)", async () => {
  const bridge = installReadFileBridge();
  const { folder } = makeOwnedTaskFolder("stage-dispatch-unrecognized-");
  try {
    const task = {
      taskFolderPath: folder,
      folderName: "the-task",
      canonicalId: folder,
      sourceScopeKey: folder,
      progress: { taskFolder: "the-task", currentStage: "impl", status: "active", displayName: "The Task" },
    } as unknown as TaskWithProgress;
    const inventory = makeSingleTaskInventory(task);
    const currentTaskStore = Object.create(CurrentTaskStore.prototype) as CurrentTaskStore;
    const provider = new ChatViewProvider(makeMemento());

    await dispatchProposedStageActionV1(
      makeContextStub(),
      inventory,
      currentTaskStore,
      provider,
      folder,
      folder,
      "impl",
      { id: "formatDisk" }
    );

    const history = await readChatHistory(folder, folder);
    assert.equal(history.length, 1);
    assert.match(history[0]!.text, /not one of this task's recognized stage actions/);
  } finally {
    bridge.restore();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
