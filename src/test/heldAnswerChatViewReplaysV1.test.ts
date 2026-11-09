/**
 * run1 Steps 26 to 30 and 33: the replays of 2026-11-05 (items 27 and 29), driven through the real chat view:
 * a held answer is shown while it waits and runs once when the round ends, never runs over a pause, is offered
 * with its own card, can be dropped, and runs once when a reload re-arms it in two windows.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { ChatViewProvider } from "../views/chatView";
import type { CreateWorkflowDecisionInputV1 } from "../types/workflowDecisionV1";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import { taskOperations } from "../utils/taskOperations";
import { readChatHistory } from "../utils/chatHistoryStore";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import { initNotificationRouter, deactivateNotificationRouter, type StatusSurface } from "../utils/notificationRouter";
import { makeOwnedTaskFolder } from "./taskFolderFixture";
import { safeRemoveDir } from "./testFsUtils";

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

interface FakeWebviewView {
  readonly view: vscode.WebviewView;
  readonly posted: Array<Record<string, unknown>>;
  send(message: unknown): Promise<void>;
}

function makeFakeWebviewView(): FakeWebviewView {
  let handler: ((message: unknown) => unknown) | undefined;
  const posted: Array<Record<string, unknown>> = [];
  const webview = {
    options: {},
    html: "",
    postMessage: (msg: Record<string, unknown>): Promise<boolean> => {
      posted.push(msg);
      return Promise.resolve(true);
    },
    onDidReceiveMessage: (cb: (message: unknown) => unknown): vscode.Disposable => {
      handler = cb;
      return { dispose: (): void => undefined };
    },
  };
  const view = {
    webview,
    visible: true,
    onDidChangeVisibility: (): vscode.Disposable => ({ dispose: (): void => undefined }),
  } as unknown as vscode.WebviewView;
  return {
    view,
    posted,
    send: async (message: unknown): Promise<void> => {
      await handler?.(message);
    },
  };
}

async function waitForStateMessage(fake: FakeWebviewView): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (fake.posted.some((m) => m.type === "state")) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function installNotificationRouterCapture(): { restore: () => void } {
  const stub: StatusSurface = { addEntry: (): void => undefined };
  initNotificationRouter(stub);
  return { restore: (): void => deactivateNotificationRouter() };
}

/** The test stub's file reads fail closed by default; the held-answer path reads the task's progress. */
function installRealFs(): { restore: () => void } {
  const fsRecord = vscode.workspace.fs as unknown as Record<string, unknown>;
  const original = fsRecord.readFile;
  fsRecord.readFile = async (uri: vscode.Uri): Promise<Uint8Array> =>
    new TextEncoder().encode(await fs.promises.readFile(uri.fsPath, "utf8"));
  return {
    restore: (): void => {
      fsRecord.readFile = original;
    },
  };
}

function withRecordedCommands(): { calls: string[]; restore: () => void } {
  const commandsObj = vscode.commands as unknown as {
    _executeCommandOverride?: (id: string, ...args: unknown[]) => Promise<unknown>;
  };
  const original = commandsObj._executeCommandOverride;
  const calls: string[] = [];
  commandsObj._executeCommandOverride = (id: string): Promise<unknown> => {
    // The panel's own focus command is not part of what the held answer dispatches.
    if (id === "ensemble.doIt") calls.push(id);
    return Promise.resolve(undefined);
  };
  return {
    calls,
    restore: (): void => {
      commandsObj._executeCommandOverride = original;
    },
  };
}

function continueCard(folder: string): CreateWorkflowDecisionInputV1 {
  return {
    decisionId: "decision-1",
    decisionKey: "exampleDecision",
    taskCanonicalId: folder,
    stage: "impl",
    whatHappened: "The review is clean.",
    whyUserNeeded: "Choose what happens next.",
    options: [
      {
        optionId: "doIt",
        label: "Do it",
        consequence: "Moves on.",
        resumeKind: "continue",
        effect: { kind: "command", command: "ensemble.doIt", args: ["arg1"] },
      },
    ],
    recommendation: { kind: "option", optionId: "doIt", reasoning: "Safe." },
    createdAt: new Date().toISOString(),
  };
}

async function waitFor(condition: () => boolean, ms = 10_000): Promise<void> {
  for (let waited = 0; waited < ms && !condition(); waited += 50) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Opens the chat on a task with a running round, and answers the card so the answer is held. */
async function holdAnAnswer(folder: string, provider: ChatViewProvider, taskName: string) {
  const fake = makeFakeWebviewView();
  const op = taskOperations.begin(folder, { label: "Apply Review", taskName, stage: "impl", cancellable: true });
  assert.ok(op);
  await provider.workflowDecisionStore.post(continueCard(folder));
  provider.resolveWebviewView(fake.view);
  await provider.open({ canonicalId: folder, taskFolderPath: folder, stage: "impl" });
  await waitForStateMessage(fake);
  await fake.send({ type: "resolveWorkflowDecision", decisionId: "decision-1", optionId: "doIt" });
  return op;
}

void describe("held owner answers through the chat view (run1 Step 33 replays)", () => {
  void it("replay of 08:30 to 08:37: 'Move on' chosen while a round runs is shown as waiting, then runs once when the round ends, with a line saying so", async () => {
    const folder = makeOwnedTaskFolder("ensemble-held-replay-").folder;
    const realFs = installRealFs();
    const provider = new ChatViewProvider(makeMemento());
    const notify = installNotificationRouterCapture();
    const commands = withRecordedCommands();
    try {
      const op = await holdAnAnswer(folder, provider, "held_replay");
      assert.deepEqual(commands.calls, [], "nothing runs into the round that is still running");
      assert.equal(taskOperations.heldAnswerForTaskV1(folder)?.label, "Do it", "the running row shows the held answer");
      assert.equal(provider.workflowDecisionStore.get("decision-1")?.deferredAnswer?.heldState, "held");

      taskOperations.end(op);
      await waitFor(() => commands.calls.length > 0);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.deepEqual(commands.calls, ["ensemble.doIt"], "it runs once, when the round ends");
      assert.equal(provider.workflowDecisionStore.get("decision-1")?.deferredAnswer?.heldState, "ran");
      assert.equal(taskOperations.heldAnswerForTaskV1(folder), undefined, "the row stops showing it");
      const texts = (await readChatHistory(folder)).map((entry) => entry.text);
      assert.ok(texts.some((text) => text.startsWith("Running your 'Do it' (chosen")), "the chat says it ran");
    } finally {
      commands.restore();
      notify.restore();
      realFs.restore();
      provider.dispose();
      safeRemoveDir(folder);
    }
  });

  void it("replay of 09:30 to 09:34: after the pause and the cancel nothing runs, the chat asks 'Run your held Do it now?', and Run it runs it once", async () => {
    const folder = makeOwnedTaskFolder("ensemble-held-pause-").folder;
    const realFs = installRealFs();
    const memento = makeMemento();
    // The owner's card is posted through the extension's own poster, which finds its store from the context.
    __extensionContextV1TestOnly.set({
      subscriptions: [] as vscode.Disposable[],
      extensionUri: vscode.Uri.file(folder),
      workspaceState: memento,
      globalState: memento,
    } as unknown as vscode.ExtensionContext);
    const provider = new ChatViewProvider(memento);
    const notify = installNotificationRouterCapture();
    const commands = withRecordedCommands();
    try {
      const op = await holdAnAnswer(folder, provider, "held_pause");
      // The owner pauses, then cancels the round.
      await patchTaskProgressStrictV1(vscode.Uri.file(folder), (current) => ({
        ...current,
        status: "paused" as const,
        ownerPausedAt: new Date().toISOString(),
      }));
      taskOperations.cancelOperation(op.id, "notifications");
      taskOperations.end(op);
      await waitFor(() => provider.workflowDecisionStore.get("decision-1")?.deferredAnswer?.heldState === "waitingForOwner");
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.deepEqual(commands.calls, [], "the pause wins: nothing is dispatched");
      const texts = (await readChatHistory(folder)).map((entry) => entry.text);
      assert.ok(texts.some((text) => text.includes("Run your held 'Do it' now?")), "the chat asks");
      const ownerCard = provider.workflowDecisionStore
        .listPending(folder)
        .find((candidate) => candidate.decisionKey === "heldAnswerNeedsOwner");
      assert.ok(ownerCard, "a card of its own offers Run it and Drop it");
      assert.deepEqual(
        ownerCard.options.map((option) => option.label),
        ["Run it", "Drop it"]
      );

      assert.deepEqual(await provider.runHeldAnswerNowV1("decision-1"), { ok: true, message: "" });
      await waitFor(() => commands.calls.includes("ensemble.doIt"));
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(commands.calls.filter((id) => id === "ensemble.doIt").length, 1, "Run it runs it once");
    } finally {
      __extensionContextV1TestOnly.reset();
      commands.restore();
      notify.restore();
      realFs.restore();
      provider.dispose();
      safeRemoveDir(folder);
    }
  });

  void it("Drop it does not run the answer, says so, and brings the original card back", async () => {
    const folder = makeOwnedTaskFolder("ensemble-held-drop-").folder;
    const realFs = installRealFs();
    const provider = new ChatViewProvider(makeMemento());
    const notify = installNotificationRouterCapture();
    const commands = withRecordedCommands();
    try {
      const op = await holdAnAnswer(folder, provider, "held_drop");
      assert.deepEqual(await provider.dropHeldAnswerV1("decision-1"), { ok: true, message: "" });
      taskOperations.end(op);
      await new Promise((resolve) => setTimeout(resolve, 600));
      assert.deepEqual(commands.calls, [], "a dropped answer never runs");
      assert.equal(taskOperations.heldAnswerForTaskV1(folder), undefined);
      assert.equal(provider.workflowDecisionStore.get("decision-1")?.state, "pending", "the original card is back");
      const texts = (await readChatHistory(folder)).map((entry) => entry.text);
      assert.ok(texts.some((text) => text.includes("Your held 'Do it' was not run")));
    } finally {
      commands.restore();
      notify.restore();
      realFs.restore();
      provider.dispose();
      safeRemoveDir(folder);
    }
  });

  void it("a restart that cut a dispatch off with nothing to show whether it ran asks with a card, and never runs it by itself", async () => {
    const folder = makeOwnedTaskFolder("ensemble-held-uncertain-").folder;
    const realFs = installRealFs();
    const memento = makeMemento();
    __extensionContextV1TestOnly.set({
      subscriptions: [] as vscode.Disposable[],
      extensionUri: vscode.Uri.file(folder),
      workspaceState: memento,
      globalState: memento,
    } as unknown as vscode.ExtensionContext);
    const provider = new ChatViewProvider(memento);
    const notify = installNotificationRouterCapture();
    const commands = withRecordedCommands();
    try {
      await provider.workflowDecisionStore.post(continueCard(folder));
      await provider.workflowDecisionStore.resolve("decision-1", "doIt");
      await provider.workflowDecisionStore.recordDeferredAnswer("decision-1", {
        kind: "heldOption",
        heldState: "dispatching",
        dispatchId: "dispatch-cut-off",
        optionId: "doIt",
        optionLabel: "Do it",
        acceptedAt: new Date().toISOString(),
        itemKeys: [],
      });
      // The task's progress cannot be read, so nothing shows whether the dispatch ran.
      fs.rmSync(`${folder}/task-progress.json`, { force: true });
      provider.rearmKeptAnswersV1();
      await waitFor(() => provider.workflowDecisionStore.get("decision-1")?.deferredAnswer?.heldState === "uncertain");
      await waitFor(() =>
        provider.workflowDecisionStore.listPending(folder).some((card) => card.decisionKey === "heldAnswerNeedsOwner")
      );
      const card = provider.workflowDecisionStore
        .listPending(folder)
        .find((candidate) => candidate.decisionKey === "heldAnswerNeedsOwner");
      assert.ok(card, "the owner is asked");
      assert.deepEqual(
        card.options.map((option) => option.label),
        ["Run it again", "Drop it"]
      );
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.deepEqual(commands.calls, [], "it is never run again by itself");
    } finally {
      __extensionContextV1TestOnly.reset();
      commands.restore();
      notify.restore();
      realFs.restore();
      provider.dispose();
      safeRemoveDir(folder);
    }
  });

  void it("a held answer survives a reload and runs once even when two windows re-arm it", async () => {
    const folder = makeOwnedTaskFolder("ensemble-held-reload-").folder;
    const realFs = installRealFs();
    const memento = makeMemento();
    const first = new ChatViewProvider(memento);
    const notify = installNotificationRouterCapture();
    const commands = withRecordedCommands();
    let second: ChatViewProvider | undefined;
    try {
      const op = await holdAnAnswer(folder, first, "held_reload");
      first.dispose();
      // The reload: a new window over the same stored decisions re-arms the held answer; so does a second one.
      second = new ChatViewProvider(memento);
      second.rearmKeptAnswersV1();
      second.rearmKeptAnswersV1();
      assert.equal(second.workflowDecisionStore.get("decision-1")?.deferredAnswer?.heldState, "held");
      assert.deepEqual(commands.calls, []);
      taskOperations.end(op);
      await waitFor(() => commands.calls.length > 0);
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.deepEqual(commands.calls, ["ensemble.doIt"], "it ran exactly once");
    } finally {
      commands.restore();
      notify.restore();
      realFs.restore();
      second?.dispose();
      first.dispose();
      safeRemoveDir(folder);
    }
  });
});
