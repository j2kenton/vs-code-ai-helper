/**
 * Coverage for hiding (never deleting) a completed/archived task's chat
 * history: when the chat target resolves to a task whose lifecycle status is
 * `completed` or `archived`, render() skips the transcript read and posts
 * zero entries with an explanatory empty-state notice. The history file on
 * disk is untouched, so flipping the status back (resume/reopen) surfaces
 * the same conversation again with no migration or restore step.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { ChatInteractionServicesV1, ChatViewProvider } from "../views/chatView";
import { readChatHistory } from "../utils/chatHistoryStore";
import { makeOwnedTaskFolder } from "./taskFolderFixture";
import { initNotificationRouter, deactivateNotificationRouter, StatusSurface } from "../utils/notificationRouter";

function installNotificationRouterStub(): { restore: () => void } {
  const stub: StatusSurface = { addEntry: (): void => undefined };
  initNotificationRouter(stub);
  return { restore: (): void => deactivateNotificationRouter() };
}

/** Bridges vscode.workspace.fs.readFile to the real filesystem, mirroring
 * chatViewTaskSwitch.test.ts's installReadFileBridge. */
function installReadFileBridge(): { restore: () => void } {
  const target = vscode.workspace.fs as unknown as Record<string, unknown>;
  const orig = target.readFile;
  target.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  return { restore: (): void => { target.readFile = orig; } };
}

function installExecuteCommandCapture(): { restore: () => void } {
  const commandsObj = vscode.commands as unknown as {
    _executeCommandOverride?: (id: string, ...args: unknown[]) => Promise<unknown>;
  };
  const orig = commandsObj._executeCommandOverride;
  commandsObj._executeCommandOverride = (): Promise<unknown> => Promise.resolve(undefined);
  return { restore: (): void => { commandsObj._executeCommandOverride = orig; } };
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

interface FakeWebviewView {
  readonly view: vscode.WebviewView;
  readonly posted: Array<Record<string, unknown>>;
}

function makeFakeWebviewView(): FakeWebviewView {
  const posted: Array<Record<string, unknown>> = [];
  const webview = {
    options: {},
    html: "",
    postMessage: (msg: Record<string, unknown>): Promise<boolean> => {
      posted.push(msg);
      return Promise.resolve(true);
    },
    onDidReceiveMessage: (): vscode.Disposable => ({ dispose: (): void => undefined }),
  };
  const view = {
    webview,
    visible: true,
    onDidChangeVisibility: (): vscode.Disposable => ({ dispose: (): void => undefined }),
  } as unknown as vscode.WebviewView;
  return { view, posted };
}

/** Interaction services whose task-status answer can be flipped mid-test,
 * standing in for the live inventory lookup extension.ts injects. */
function makeStatusServices(status: { value: string | undefined }): ChatInteractionServicesV1 {
  return {
    submitAnswers: () => Promise.resolve({ ok: true }),
    cancel: () => Promise.resolve({ ok: true }),
    getTaskStatus: () => status.value,
  };
}

/** open() fires its render without awaiting it, so poll for the state message. */
async function lastState(posted: Array<Record<string, unknown>>): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = posted.filter((m) => m.type === "state").pop();
    if (state) return state;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("expected a posted state message");
}

void describe("Chat With AI — completed/archived task history suppression", () => {
  void it("hides the conversation for a completed task and restores it when the status flips back", async () => {
    const rf = installReadFileBridge();
    const cmds = installExecuteCommandCapture();
    const notify = installNotificationRouterStub();
    const folder = makeOwnedTaskFolder("ensemble-chat-suppression-").folder;
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const status: { value: string | undefined } = { value: "active" };
    provider.setInteractionServices(makeStatusServices(status));

    try {
      provider.resolveWebviewView(fake.view);
      const target = { canonicalId: folder, taskFolderPath: folder, stage: "impl" as const };
      await provider.open(target);
      await provider.append("user", "hello from an active task", "impl", target);

      let state = await lastState(fake.posted);
      assert.equal((state.entries as unknown[]).length, 1, "active task must show its transcript");
      assert.equal(state.emptyNotice, undefined);

      // Task completes: the next render must post zero entries plus an
      // explanatory notice, without reading (or touching) the history file.
      status.value = "completed";
      fake.posted.length = 0;
      await provider.open(target);
      state = await lastState(fake.posted);
      assert.equal((state.entries as unknown[]).length, 0, "completed task must show an empty chat");
      assert.match(String(state.emptyNotice), /completed/);

      // Archived behaves the same way.
      status.value = "archived";
      fake.posted.length = 0;
      await provider.open(target);
      state = await lastState(fake.posted);
      assert.equal((state.entries as unknown[]).length, 0, "archived task must show an empty chat");
      assert.match(String(state.emptyNotice), /archived/);

      // History was hidden, not deleted: the file still holds the message,
      // and resuming the task (status back to active) shows it again.
      const onDisk = await readChatHistory(folder);
      assert.deepEqual(onDisk.map((m) => m.text), ["hello from an active task"]);
      status.value = "active";
      fake.posted.length = 0;
      await provider.open(target);
      state = await lastState(fake.posted);
      assert.equal((state.entries as unknown[]).length, 1, "resumed task must show its history again");
      assert.equal(state.emptyNotice, undefined);
    } finally {
      rf.restore();
      cmds.restore();
      notify.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("never hides the global assistant, whatever the status lookup returns", async () => {
    const rf = installReadFileBridge();
    const cmds = installExecuteCommandCapture();
    const notify = installNotificationRouterStub();
    const folder = makeOwnedTaskFolder("ensemble-chat-suppression-global-").folder;
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    provider.setInteractionServices(makeStatusServices({ value: "completed" }));

    try {
      provider.resolveWebviewView(fake.view);
      const target = {
        canonicalId: folder,
        taskFolderPath: folder,
        stage: "desc" as const,
        kind: "global" as const,
      };
      await provider.open(target);
      await provider.append("user", "global assistant message", "desc", target);

      const state = await lastState(fake.posted);
      assert.equal((state.entries as unknown[]).length, 1, "the global assistant is never suppressed");
      assert.equal(state.emptyNotice, undefined);
    } finally {
      rf.restore();
      cmds.restore();
      notify.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});
