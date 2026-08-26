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
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import * as vscode from "vscode";
import {
  buildStageActionPayload,
  buildStageResponsePrompt,
  dispatchProposedBlockerSupersessionEditV1,
  dispatchProposedStageActionV1,
  getStageChatAction,
  readStageArtifactsForChat,
  splitStageActionEnvelopes,
  STAGE_CHAT_ACTIONS,
} from "../commands/chatWithStage";
import { planStageAction } from "../utils/chatStageActionEnvelope";
import { getGlobalAssistantOperation } from "../utils/globalAssistantActions";
import { ChatViewProvider } from "../views/chatView";
import { readChatHistory } from "../utils/chatHistoryStore";
import { makeOwnedTaskFolder, readTaskProgressForTest } from "./taskFolderFixture";
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

// wf10 item 19 / plan Step 28 (prompt-side prerequisite only — the full
// confirmable-edit + durable supersession + stage-gate recognition flow
// remains unbuilt, see the round summary): a jester task 4 live transcript
// showed stage chat declaring a recorded blocker resolved and advising the
// user to "complete this stage and advance" while plan.md stayed byte-for-
// byte unchanged, because the model only said so in prose instead of
// drafting the already-existing [[UPDATE_FILE:...]] envelope. The prompt
// must instruct the model to draft the update as part of declaring a
// blocker resolved, and to use the "shall I write it to plan.md?" phrasing
// (never advice to advance) until it has.
void test("stage prompt instructs drafting the plan update, not just advice, when declaring a recorded blocker resolved", () => {
  const prompt = buildStageResponsePrompt("Plan", "my-task", "", "ctx", "msg");
  assert.match(
    prompt,
    /draft that decision into the relevant file with `\[\[UPDATE_FILE:\.\.\.\]\]`/,
    "prompt must instruct drafting the UPDATE_FILE envelope as part of declaring a blocker resolved, not only stating it"
  );
  assert.match(
    prompt,
    /this resolves it once recorded — shall I write it to plan\.md\?/,
    "prompt must carry the exact required phrasing before the write is drafted"
  );
  assert.match(
    prompt,
    /do not advise completing this stage or advancing/,
    "prompt must forbid advancing advice while the recorded blocker is still unaddressed in the artifacts"
  );
});

// wf10 review fix (2026-08-25, new completion blocker): the prior wording
// only forbade advancing advice "until you have actually drafted that
// update" — since drafting happens synchronously in the same response, that
// left the model free to draft the UPDATE_FILE envelope AND advise advancing
// in that same reply, before the user has confirmed anything and before any
// write has landed. A declined or failed confirmation could then leave chat
// advising advancement while plan.md was never actually touched. The prompt
// must instead require seeing this conversation's own confirmed-write
// message before advising advancing at all.
void test("stage prompt forbids advancing advice even in the same response that drafts the update, until a confirmed write is visible in history", () => {
  const prompt = buildStageResponsePrompt("Plan", "my-task", "", "ctx", "msg");
  assert.match(
    prompt,
    /that restriction still applies in the very same response where you draft the update/,
    "prompt must forbid advancing advice within the same response that drafts the UPDATE_FILE envelope, not only before drafting it"
  );
  assert.match(
    prompt,
    /once this conversation's own history shows a message beginning "_Updated `<file>`\._" for that exact update/,
    "prompt must require the confirmed-write outcome message before advising advancing"
  );
  assert.match(
    prompt,
    /A declined confirmation instead reports "_\.\.\.was not confirmed; nothing was written\._"/,
    "prompt must tell the model to recognize a declined confirmation and keep treating the blocker as outstanding"
  );
});

// Review-flagged (2026-08-25, third narrowing of task-fixable blocker
// fc82d17d-…-3): the prompt must instruct the model to emit the explicit
// `[[RESOLVES_BLOCKER]]` marker as part of declaring a blocker resolved — the
// signal `detectBlockerSupersessionCandidateV1` (chatSendRowV1.ts) now relies
// on instead of inferring resolution from the edit's own vocabulary.
void test("stage prompt instructs the [[RESOLVES_BLOCKER]] marker when declaring a recorded blocker resolved", () => {
  const prompt = buildStageResponsePrompt("Plan", "my-task", "", "ctx", "msg");
  assert.match(
    prompt,
    /also end your response with `\[\[RESOLVES_BLOCKER\]\]` on its own line/,
    "prompt must instruct emitting the explicit marker alongside the UPDATE_FILE draft"
  );
  assert.match(
    prompt,
    /never for an edit that merely discusses, restates, or promises to resolve the blocker later/,
    "prompt must warn against marking an edit that does not actually resolve the blocker"
  );
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

// wf10 item 19 / plan Step 28: a chat-drafted `plan.md` edit sent while the
// chat's own stage is a plan-review stage with exactly ONE recorded blocker,
// AND accompanied by the model's own explicit `[[RESOLVES_BLOCKER]]` marker,
// is a candidate blocker-supersession edit — the write must NOT be
// auto-applied (unlike an ordinary chat markdown edit); it must be proposed
// on the message instead, for a confirmation dialog to gate it, so the same
// class of defect that let stage chat advise "this resolves it, advance"
// while plan.md stayed unchanged cannot recur behind a silent auto-write.
void test("a plan.md edit marked [[RESOLVES_BLOCKER]] during a sole-blocker plan-review chat is proposed, not auto-applied", async () => {
  const bridge = installReadFileBridge();
  const { folder } = makeOwnedTaskFolder("blocker-supersession-candidate-");
  const canonicalId = folder;
  try {
    fs.writeFileSync(
      `${folder}/plan-high-review.md`,
      [
        "Readiness: 7/10",
        "",
        "<!-- blockers:start -->",
        "- [architectural] [environmental] the owner must approve a complete tie policy",
        "<!-- blockers:end -->",
        "",
      ].join("\n"),
      "utf8"
    );

    const row = createChatSendRowV1();
    const correlation: ActionCorrelationV1 = {
      actionKey: "chatSend.v1",
      operationId: "op-supersession-candidate",
      attemptId: "attempt-supersession-candidate",
      taskBindingId: "binding-1",
      chatDocumentId: "doc-1",
    };
    const context: TaskActionExecutionContextV1 = {
      correlation,
      stage: "plan-high-review",
      validatedInput: { prompt: "irrelevant", taskFolderPath: folder, canonicalId },
    };
    const content: CompletedContentV1 = {
      contentType: "chat-message.v1",
      schemaVersion: 1,
      text:
        "Recorded your decision. [[UPDATE_FILE:plan.md]]# Plan\n\nOwner-approved tie policy: ...\n[[/UPDATE_FILE]]" +
        "\n[[RESOLVES_BLOCKER]]",
    };
    const code = await row.promoteCompletedContent(content, context);
    assert.equal(code, "completed");

    const history = await readChatHistory(folder, canonicalId);
    const last = history[history.length - 1];
    assert.ok(last);
    assert.ok(!last.text.includes("UPDATE_FILE"), "the envelope must never survive into the displayed text");
    assert.ok(!last.text.includes("RESOLVES_BLOCKER"), "the marker must never survive into the displayed text");
    assert.match(last.text, /confirm to apply/i);
    assert.ok(last.proposedBlockerSupersessionEdit, "must carry a proposed edit awaiting confirmation");
    assert.equal(last.proposedBlockerSupersessionEdit?.relPath, "plan.md");
    assert.equal(
      last.proposedBlockerSupersessionEdit?.blockerDescription,
      "the owner must approve a complete tie policy"
    );
    assert.equal(last.proposedBlockerSupersessionEdit?.reviewStage, "plan-high-review");

    // Not auto-applied: plan.md must not exist on disk yet.
    assert.ok(!fs.existsSync(`${folder}/plan.md`), "plan.md must not be written until the user confirms");
  } finally {
    bridge.restore();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

// Review-flagged (2026-08-25, third narrowing of task-fixable blocker
// fc82d17d-…-3): the marker replaces lexical correlation as the SOLE
// resolution signal — an edit sharing plenty of the blocker's vocabulary is
// never treated as a candidate without the model's own explicit marker,
// exactly like a model that never intended to draft a resolution.
void test("a plan.md edit that shares the blocker's vocabulary but omits [[RESOLVES_BLOCKER]] still auto-applies", async () => {
  const bridge = installReadFileBridge();
  const { folder } = makeOwnedTaskFolder("blocker-supersession-no-marker-");
  const canonicalId = folder;
  try {
    fs.writeFileSync(
      `${folder}/plan-high-review.md`,
      [
        "Readiness: 7/10",
        "",
        "<!-- blockers:start -->",
        "- [architectural] [environmental] the owner must approve a complete tie policy",
        "<!-- blockers:end -->",
        "",
      ].join("\n"),
      "utf8"
    );

    const row = createChatSendRowV1();
    const correlation: ActionCorrelationV1 = {
      actionKey: "chatSend.v1",
      operationId: "op-supersession-no-marker",
      attemptId: "attempt-supersession-no-marker",
      taskBindingId: "binding-1",
      chatDocumentId: "doc-1",
    };
    const context: TaskActionExecutionContextV1 = {
      correlation,
      stage: "plan-high-review",
      validatedInput: { prompt: "irrelevant", taskFolderPath: folder, canonicalId },
    };
    const content: CompletedContentV1 = {
      contentType: "chat-message.v1",
      schemaVersion: 1,
      text:
        "Noted. [[UPDATE_FILE:plan.md]]# Plan\n\n## Open decisions\n\nThe tie policy remains pending — the owner " +
        "has not yet approved it.\n[[/UPDATE_FILE]]",
    };
    const code = await row.promoteCompletedContent(content, context);
    assert.equal(code, "completed");

    const history = await readChatHistory(folder, canonicalId);
    const last = history[history.length - 1];
    assert.ok(last);
    assert.equal(
      last.proposedBlockerSupersessionEdit,
      undefined,
      "vocabulary overlap alone, with no explicit marker, must never be treated as resolving the blocker"
    );
    assert.match(last.text, /_Updated `plan\.md`\._/);
  } finally {
    bridge.restore();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

// Review-flagged (2026-08-25): a sole recorded blocker is not, by itself,
// evidence that a given plan.md edit resolves it — confirming an UNRELATED
// wording fix elsewhere in the document must not be misread as "this
// resolves the blocker" and silently suppress a genuinely unresolved one.
// With the explicit-marker design, this is trivially true: no marker means
// no candidate, whatever the edit's content — this fixture also has no
// marker, matching a model that never intended to declare a resolution.
void test("an unrelated plan.md edit during a sole-blocker plan-review chat still auto-applies (no unsafe supersession guess)", async () => {
  const bridge = installReadFileBridge();
  const { folder } = makeOwnedTaskFolder("blocker-supersession-unrelated-");
  const canonicalId = folder;
  try {
    fs.writeFileSync(
      `${folder}/plan.md`,
      ["# Plan", "", "## Part 1", "", "Some existing unrelated content.", ""].join("\n"),
      "utf8"
    );
    fs.writeFileSync(
      `${folder}/plan-high-review.md`,
      [
        "Readiness: 7/10",
        "",
        "<!-- blockers:start -->",
        "- [architectural] [environmental] the owner must approve a complete tie policy",
        "<!-- blockers:end -->",
        "",
      ].join("\n"),
      "utf8"
    );

    const row = createChatSendRowV1();
    const correlation: ActionCorrelationV1 = {
      actionKey: "chatSend.v1",
      operationId: "op-supersession-unrelated",
      attemptId: "attempt-supersession-unrelated",
      taskBindingId: "binding-1",
      chatDocumentId: "doc-1",
    };
    const context: TaskActionExecutionContextV1 = {
      correlation,
      stage: "plan-high-review",
      validatedInput: { prompt: "irrelevant", taskFolderPath: folder, canonicalId },
    };
    const content: CompletedContentV1 = {
      contentType: "chat-message.v1",
      schemaVersion: 1,
      text:
        "Fixed a typo. [[UPDATE_FILE:plan.md]]# Plan\n\n## Part 1\n\nSome existing unrelated content, now with a " +
        "typo fixed.\n[[/UPDATE_FILE]]",
    };
    const code = await row.promoteCompletedContent(content, context);
    assert.equal(code, "completed");

    const history = await readChatHistory(folder, canonicalId);
    const last = history[history.length - 1];
    assert.ok(last);
    assert.equal(
      last.proposedBlockerSupersessionEdit,
      undefined,
      "an edit sharing none of the blocker's vocabulary must not be treated as resolving it"
    );
    assert.match(last.text, /_Updated `plan\.md`\._/);
    const written = fs.readFileSync(`${folder}/plan.md`, "utf8");
    assert.match(written, /typo fixed/, "the unrelated edit must still auto-apply, exactly like any ordinary chat edit");
  } finally {
    bridge.restore();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

// Review-flagged (2026-08-25, blocker fc82d17d-…-3, now resolved by the
// explicit `[[RESOLVES_BLOCKER]]` marker rather than lexical detection — see
// `detectBlockerSupersessionCandidateV1`'s doc comment): the review's own
// worked example — an edit that shares significant vocabulary with the
// blocker while explicitly saying the matter is STILL pending — is a
// realistic case where a well-behaved model would never emit the marker in
// the first place. This proves the fixture's realistic (marker-less) shape
// still auto-applies, not any text analysis of "remains pending".
void test("an edit restating the blocker as still pending (with no marker) still auto-applies", async () => {
  const bridge = installReadFileBridge();
  const { folder } = makeOwnedTaskFolder("blocker-supersession-still-pending-");
  const canonicalId = folder;
  try {
    fs.writeFileSync(
      `${folder}/plan.md`,
      ["# Plan", "", "## Part 1", "", "Some existing unrelated content.", ""].join("\n"),
      "utf8"
    );
    fs.writeFileSync(
      `${folder}/plan-high-review.md`,
      [
        "Readiness: 7/10",
        "",
        "<!-- blockers:start -->",
        "- [architectural] [environmental] the owner must approve a complete tie policy",
        "<!-- blockers:end -->",
        "",
      ].join("\n"),
      "utf8"
    );

    const row = createChatSendRowV1();
    const correlation: ActionCorrelationV1 = {
      actionKey: "chatSend.v1",
      operationId: "op-supersession-still-pending",
      attemptId: "attempt-supersession-still-pending",
      taskBindingId: "binding-1",
      chatDocumentId: "doc-1",
    };
    const context: TaskActionExecutionContextV1 = {
      correlation,
      stage: "plan-high-review",
      validatedInput: { prompt: "irrelevant", taskFolderPath: folder, canonicalId },
    };
    const content: CompletedContentV1 = {
      contentType: "chat-message.v1",
      schemaVersion: 1,
      text:
        "Noted. [[UPDATE_FILE:plan.md]]# Plan\n\n## Part 1\n\nSome existing unrelated content.\n\n" +
        "## Open decisions\n\nThe tie policy remains pending — the owner has not yet approved it.\n[[/UPDATE_FILE]]",
    };
    const code = await row.promoteCompletedContent(content, context);
    assert.equal(code, "completed");

    const history = await readChatHistory(folder, canonicalId);
    const last = history[history.length - 1];
    assert.ok(last);
    assert.equal(
      last.proposedBlockerSupersessionEdit,
      undefined,
      "an edit with no [[RESOLVES_BLOCKER]] marker must never be treated as resolving the blocker, regardless of vocabulary"
    );
    assert.match(last.text, /_Updated `plan\.md`\._/);
  } finally {
    bridge.restore();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

// Review-flagged (2026-08-25, blocker fc82d17d-…-3, now resolved by the
// explicit marker — see the "still pending" test above for why this fixture
// stays marker-less): "the tie policy will be presented for approval
// tomorrow" shares plenty of vocabulary with the blocker while describing a
// FUTURE promise, not a decision already made — another realistic case a
// well-behaved model would never mark `[[RESOLVES_BLOCKER]]`.
void test("an edit merely promising future approval (with no marker) still auto-applies", async () => {
  const bridge = installReadFileBridge();
  const { folder } = makeOwnedTaskFolder("blocker-supersession-future-promise-");
  const canonicalId = folder;
  try {
    fs.writeFileSync(
      `${folder}/plan.md`,
      ["# Plan", "", "## Part 1", "", "Some existing unrelated content.", ""].join("\n"),
      "utf8"
    );
    fs.writeFileSync(
      `${folder}/plan-high-review.md`,
      [
        "Readiness: 7/10",
        "",
        "<!-- blockers:start -->",
        "- [architectural] [environmental] the owner must approve a complete tie policy",
        "<!-- blockers:end -->",
        "",
      ].join("\n"),
      "utf8"
    );

    const row = createChatSendRowV1();
    const correlation: ActionCorrelationV1 = {
      actionKey: "chatSend.v1",
      operationId: "op-supersession-future-promise",
      attemptId: "attempt-supersession-future-promise",
      taskBindingId: "binding-1",
      chatDocumentId: "doc-1",
    };
    const context: TaskActionExecutionContextV1 = {
      correlation,
      stage: "plan-high-review",
      validatedInput: { prompt: "irrelevant", taskFolderPath: folder, canonicalId },
    };
    const content: CompletedContentV1 = {
      contentType: "chat-message.v1",
      schemaVersion: 1,
      text:
        "Noted. [[UPDATE_FILE:plan.md]]# Plan\n\n## Part 1\n\nSome existing unrelated content.\n\n" +
        "## Open decisions\n\nThe tie policy will be presented for approval tomorrow.\n[[/UPDATE_FILE]]",
    };
    const code = await row.promoteCompletedContent(content, context);
    assert.equal(code, "completed");

    const history = await readChatHistory(folder, canonicalId);
    const last = history[history.length - 1];
    assert.ok(last);
    assert.equal(
      last.proposedBlockerSupersessionEdit,
      undefined,
      "an edit with no [[RESOLVES_BLOCKER]] marker must never be treated as resolving the blocker, regardless of vocabulary"
    );
    assert.match(last.text, /_Updated `plan\.md`\._/);
  } finally {
    bridge.restore();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

// Review-flagged (2026-08-25, blocker fc82d17d-…-3, now resolved by the
// explicit marker): "owner sign-off is outstanding" shares plenty of
// vocabulary with the blocker while asserting the matter is unresolved — a
// phrasing that defeated two rounds of denylist narrowing before the marker
// replaced lexical inference entirely. A well-behaved model would never mark
// `[[RESOLVES_BLOCKER]]` on this text, and its absence is now the only thing
// that matters.
void test("an edit describing sign-off as outstanding (with no marker) still auto-applies", async () => {
  const bridge = installReadFileBridge();
  const { folder } = makeOwnedTaskFolder("blocker-supersession-outstanding-");
  const canonicalId = folder;
  try {
    fs.writeFileSync(
      `${folder}/plan.md`,
      ["# Plan", "", "## Part 1", "", "Some existing unrelated content.", ""].join("\n"),
      "utf8"
    );
    fs.writeFileSync(
      `${folder}/plan-high-review.md`,
      [
        "Readiness: 7/10",
        "",
        "<!-- blockers:start -->",
        "- [architectural] [environmental] the owner must approve a complete tie policy",
        "<!-- blockers:end -->",
        "",
      ].join("\n"),
      "utf8"
    );

    const row = createChatSendRowV1();
    const correlation: ActionCorrelationV1 = {
      actionKey: "chatSend.v1",
      operationId: "op-supersession-outstanding",
      attemptId: "attempt-supersession-outstanding",
      taskBindingId: "binding-1",
      chatDocumentId: "doc-1",
    };
    const context: TaskActionExecutionContextV1 = {
      correlation,
      stage: "plan-high-review",
      validatedInput: { prompt: "irrelevant", taskFolderPath: folder, canonicalId },
    };
    const content: CompletedContentV1 = {
      contentType: "chat-message.v1",
      schemaVersion: 1,
      text:
        "Noted. [[UPDATE_FILE:plan.md]]# Plan\n\n## Part 1\n\nSome existing unrelated content.\n\n" +
        "## Open decisions\n\nTie-policy alternatives include equal final-entry timestamps and guarantees for " +
        "the promised outcome; owner sign-off is outstanding.\n[[/UPDATE_FILE]]",
    };
    const code = await row.promoteCompletedContent(content, context);
    assert.equal(code, "completed");

    const history = await readChatHistory(folder, canonicalId);
    const last = history[history.length - 1];
    assert.ok(last);
    assert.equal(
      last.proposedBlockerSupersessionEdit,
      undefined,
      "an edit with no [[RESOLVES_BLOCKER]] marker must never be treated as resolving the blocker, regardless of vocabulary"
    );
    assert.match(last.text, /_Updated `plan\.md`\._/);
  } finally {
    bridge.restore();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

// The same shape but with TWO recorded blockers, and the model DOES include
// the marker: cardinality still refuses to guess which blocker the write
// addresses, so the explicit marker alone does not bypass this guard — this
// stays an ordinary chat file update and auto-applies exactly as before.
void test("a plan.md edit marked [[RESOLVES_BLOCKER]] during a multi-blocker plan-review chat still auto-applies (no ambiguous supersession guess)", async () => {
  const bridge = installReadFileBridge();
  const { folder } = makeOwnedTaskFolder("blocker-supersession-multi-");
  const canonicalId = folder;
  try {
    fs.writeFileSync(
      `${folder}/plan-high-review.md`,
      [
        "Readiness: 5/10",
        "",
        "<!-- blockers:start -->",
        "- [architectural] [environmental] the owner must approve a tie policy",
        "- [completion] [task-fixable] the retry loop still swallows errors",
        "<!-- blockers:end -->",
        "",
      ].join("\n"),
      "utf8"
    );

    const row = createChatSendRowV1();
    const correlation: ActionCorrelationV1 = {
      actionKey: "chatSend.v1",
      operationId: "op-supersession-multi",
      attemptId: "attempt-supersession-multi",
      taskBindingId: "binding-1",
      chatDocumentId: "doc-1",
    };
    const context: TaskActionExecutionContextV1 = {
      correlation,
      stage: "plan-high-review",
      validatedInput: { prompt: "irrelevant", taskFolderPath: folder, canonicalId },
    };
    const content: CompletedContentV1 = {
      contentType: "chat-message.v1",
      schemaVersion: 1,
      text: "Updating the plan. [[UPDATE_FILE:plan.md]]# Plan\n\nSome update.\n[[/UPDATE_FILE]]\n[[RESOLVES_BLOCKER]]",
    };
    const code = await row.promoteCompletedContent(content, context);
    assert.equal(code, "completed");

    const history = await readChatHistory(folder, canonicalId);
    const last = history[history.length - 1];
    assert.ok(last);
    assert.ok(!last.text.includes("RESOLVES_BLOCKER"), "the marker must never survive into the displayed text");
    assert.equal(
      last.proposedBlockerSupersessionEdit,
      undefined,
      "the explicit marker must not override the multi-blocker ambiguity guard"
    );
    assert.match(last.text, /_Updated `plan\.md`\._/);
    assert.ok(fs.existsSync(`${folder}/plan.md`), "an ordinary chat edit with no candidate must still auto-apply");
  } finally {
    bridge.restore();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

// Dispatch-path coverage for the confirm/apply half, mirroring
// dispatchProposedStageActionV1's own applied/declined pair above.
void test("dispatchProposedBlockerSupersessionEditV1 applies the write only on confirmation (applied)", async () => {
  const bridge = installReadFileBridge();
  const { folder } = makeOwnedTaskFolder("supersession-dispatch-applied-");
  const win = vscode.window as unknown as Record<string, unknown>;
  const originalWarning = win.showWarningMessage;
  try {
    win.showWarningMessage = (): Promise<string | undefined> => Promise.resolve("Apply Update");
    const provider = new ChatViewProvider(makeMemento());

    await dispatchProposedBlockerSupersessionEditV1(provider, folder, folder, "plan-high-review", {
      relPath: "plan.md",
      content: "# Plan\n\nOwner-approved tie policy.",
      blockerDescription: "the owner must approve a complete tie policy",
      reviewStage: "plan-high-review",
    });

    const history = await readChatHistory(folder, folder);
    assert.equal(history.length, 1);
    assert.match(history[0]!.text, /_Updated `plan\.md`\._/);
    assert.equal(fs.readFileSync(`${folder}/plan.md`, "utf8"), "# Plan\n\nOwner-approved tie policy.");

    // wf10 item 19: the write must ALSO record a durable supersession entry
    // — this is what lets readStageArtifactsForChat (the production consumer,
    // see TaskProgress.blockerSupersessions's doc comment) recognize the
    // blocker as no longer outstanding without requiring a fresh review round.
    const progress = await readTaskProgressForTest(vscode.Uri.file(folder));
    assert.equal(progress?.blockerSupersessions?.length, 1);
    assert.equal(progress?.blockerSupersessions?.[0]?.stage, "plan-high-review");
    assert.equal(
      progress?.blockerSupersessions?.[0]?.blockerDescription,
      "the owner must approve a complete tie policy"
    );
    assert.equal(progress?.blockerSupersessions?.[0]?.planRelPath, "plan.md");
  } finally {
    win.showWarningMessage = originalWarning;
    bridge.restore();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

void test("dispatchProposedBlockerSupersessionEditV1 writes nothing when the confirmation is declined (declined)", async () => {
  const bridge = installReadFileBridge();
  const { folder } = makeOwnedTaskFolder("supersession-dispatch-declined-");
  const win = vscode.window as unknown as Record<string, unknown>;
  const originalWarning = win.showWarningMessage;
  try {
    win.showWarningMessage = (): Promise<string | undefined> => Promise.resolve(undefined);
    const provider = new ChatViewProvider(makeMemento());

    await dispatchProposedBlockerSupersessionEditV1(provider, folder, folder, "plan-high-review", {
      relPath: "plan.md",
      content: "# Plan\n\nOwner-approved tie policy.",
      blockerDescription: "the owner must approve a complete tie policy",
      reviewStage: "plan-high-review",
    });

    const history = await readChatHistory(folder, folder);
    assert.equal(history.length, 1);
    assert.match(history[0]!.text, /not confirmed; nothing was written/);
    assert.ok(!fs.existsSync(`${folder}/plan.md`), "declining the confirmation must never write the file");

    // wf10 item 19: a declined write must never record a supersession —
    // nothing was actually resolved on disk, so a stage gate must keep
    // reading the blocker as outstanding.
    const progress = await readTaskProgressForTest(vscode.Uri.file(folder));
    assert.equal(progress?.blockerSupersessions, undefined);
  } finally {
    win.showWarningMessage = originalWarning;
    bridge.restore();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

// wf10 review fix (2026-08-25, new completion blocker): `readStageArtifactsForChat`
// is the real production consumer of `TaskProgress.blockerSupersessions` for a
// plan-review stage — see its own doc comment and TaskProgress.blockerSupersessions's
// for why the two consumers a prior comment named here never actually applied.
void test("readStageArtifactsForChat annotates a blocker superseded via chat, without hiding the raw review text", async () => {
  const bridge = installReadFileBridge();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-stage-artifact-supersession-"));
  try {
    fs.writeFileSync(
      path.join(dir, "plan-high-review.md"),
      [
        "Readiness: 5/10",
        "",
        "<!-- blockers:start -->",
        "- [architectural] [environmental] the owner must approve a complete tie policy",
        "<!-- blockers:end -->",
        "",
      ].join("\n"),
      "utf8"
    );

    // supersededAt must be unambiguously AFTER the review artifact's own
    // mtime — the artifact above was just written via fs.writeFileSync, so
    // its mtime is real wall-clock "now"; a same-day midnight timestamp here
    // would (almost always) read as BEFORE that mtime and be treated as a
    // stale supersession (see the sibling "stale supersession" test below),
    // not the fresh one this test exercises.
    const context = await readStageArtifactsForChat(vscode.Uri.file(dir), "plan-high-review", [
      {
        stage: "plan-high-review",
        blockerDescription: "the owner must approve a complete tie policy",
        supersededAt: "2099-01-01T00:00:00.000Z",
        planRelPath: "plan.md",
        confirmingMessageAt: "2098-12-31T23:59:00.000Z",
      },
    ]);

    assert.match(context, /the owner must approve a complete tie policy/, "raw review text must survive unchanged");
    assert.match(context, /Superseded: the blocker "the owner must approve a complete tie policy"/);
    assert.match(context, /2099-01-01T00:00:00\.000Z/);
    assert.match(context, /`plan\.md`/);
  } finally {
    bridge.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

void test("readStageArtifactsForChat never masks a blocker a fresher review re-asserts (stale supersession)", async () => {
  const bridge = installReadFileBridge();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-stage-artifact-stale-supersession-"));
  try {
    fs.writeFileSync(
      path.join(dir, "plan-high-review.md"),
      [
        "Readiness: 5/10",
        "",
        "<!-- blockers:start -->",
        "- [architectural] [environmental] the owner must approve a complete tie policy",
        "<!-- blockers:end -->",
        "",
      ].join("\n"),
      "utf8"
    );

    // Supersession recorded long before this artifact's own mtime — a later,
    // still-current review round independently re-found the identically
    // worded blocker, so it must read as outstanding, not superseded.
    const context = await readStageArtifactsForChat(vscode.Uri.file(dir), "plan-high-review", [
      {
        stage: "plan-high-review",
        blockerDescription: "the owner must approve a complete tie policy",
        supersededAt: "2000-01-01T00:00:00.000Z",
        planRelPath: "plan.md",
      },
    ]);

    assert.match(context, /the owner must approve a complete tie policy/);
    assert.doesNotMatch(context, /Superseded: the blocker/);
  } finally {
    bridge.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

void test("readStageArtifactsForChat ignores a supersession recorded against a different stage", async () => {
  const bridge = installReadFileBridge();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-stage-artifact-wrong-stage-supersession-"));
  try {
    fs.writeFileSync(
      path.join(dir, "plan-high-review.md"),
      [
        "Readiness: 5/10",
        "",
        "<!-- blockers:start -->",
        "- [architectural] [environmental] the owner must approve a complete tie policy",
        "<!-- blockers:end -->",
        "",
      ].join("\n"),
      "utf8"
    );

    const context = await readStageArtifactsForChat(vscode.Uri.file(dir), "plan-high-review", [
      {
        stage: "plan-low-review",
        blockerDescription: "the owner must approve a complete tie policy",
        supersededAt: "2026-08-26T00:00:00.000Z",
        planRelPath: "plan.md",
      },
    ]);

    assert.doesNotMatch(context, /Superseded: the blocker/);
  } finally {
    bridge.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
