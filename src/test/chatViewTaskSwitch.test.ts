/**
 * Regression coverage for ChatViewProvider.ask() task-switch behavior (Slice 1
 * of the 2026-07-14_task_5 backlog: task-local chat history).
 *
 * chatWithStage.ts captures the target task before starting a (possibly
 * long-running) stage AI call, so a response — including one that ends in a
 * clarifying question via ChatViewProvider.ask() — can complete well after
 * the user has switched the chat view to a different task. That response
 * must still be written to the task it actually answers, but must NOT yank
 * the view (focus + re-render) back onto that task if some other task is
 * what the user is currently looking at.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { ChatViewProvider } from "../views/chatView";
import { readChatHistory } from "../utils/chatHistoryStore";

/** Bridges vscode.workspace.fs.readFile to the real filesystem, mirroring
 * chatHistoryStore.test.ts's installReadFileBridge. */
function installReadFileBridge(): { restore: () => void } {
  const target = vscode.workspace.fs as unknown as Record<string, unknown>;
  const orig = target.readFile;
  target.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  return { restore: (): void => { target.readFile = orig; } };
}

/** Captures every command ID executeCommand is asked to run, and answers
 * every call with undefined — the webview-focus command ChatViewProvider.open()
 * invokes isn't a `registerCommand`-registered handler in this test process,
 * so the stub's default executeCommand would otherwise throw "not registered". */
function installExecuteCommandCapture(): { executed: string[]; restore: () => void } {
  const executed: string[] = [];
  const commandsObj = vscode.commands as unknown as {
    _executeCommandOverride?: (id: string, ...args: unknown[]) => Promise<unknown>;
  };
  const orig = commandsObj._executeCommandOverride;
  commandsObj._executeCommandOverride = (id: string): Promise<unknown> => {
    executed.push(id);
    return Promise.resolve(undefined);
  };
  return { executed, restore: (): void => { commandsObj._executeCommandOverride = orig; } };
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

function makeTaskFolder(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ensemble-chatview-${name}-`));
}

const FOCUS_COMMAND = `${ChatViewProvider.viewType}.focus`;

function chatWebviewHtml(): string {
  const provider = new ChatViewProvider(makeMemento());
  return (provider as unknown as { html(): string }).html();
}

void describe("ChatViewProvider.ask() task-switch behavior", () => {
  void it("uses VS Code theme tokens and exposes an accessible in-view error state", () => {
    const html = chatWebviewHtml();

    assert.match(html, /background-color: var\(--vscode-editor-background\)/);
    assert.match(html, /color: var\(--vscode-inputValidation-errorForeground\)/);
    assert.match(html, /id="error" role="alert"/);
    assert.match(html, /errorMessage/);
    assert.match(html, /prefers-reduced-motion/);
  });

  void it("writes the question to its own task but does not refocus/retarget the view when a different task is current", async () => {
    const rf = installReadFileBridge();
    const cmds = installExecuteCommandCapture();
    const folderA = makeTaskFolder("a");
    const folderB = makeTaskFolder("b");
    const provider = new ChatViewProvider(makeMemento());

    try {
      // The user has task A open in the chat view.
      await provider.open({ canonicalId: folderA, taskFolderPath: folderA, stage: "impl" });
      cmds.executed.length = 0; // discard the focus call from opening A

      // Task B's stage AI response (captured/started before the user switched
      // to A) completes with a clarifying question.
      await provider.ask({
        canonicalId: folderB,
        taskFolderPath: folderB,
        stage: "impl",
        question: "Which approach should I take?",
      });

      assert.deepEqual(
        cmds.executed,
        [],
        "ask() for a task that is no longer current must not focus/retarget the chat view"
      );

      const transcriptB = await readChatHistory(folderB);
      assert.deepEqual(
        transcriptB.map((m) => ({ role: m.role, text: m.text, pending: m.pending })),
        [{ role: "question", text: "Which approach should I take?", pending: true }]
      );

      const transcriptA = await readChatHistory(folderA);
      assert.deepEqual(transcriptA, [], "task A's transcript must be untouched by task B's question");
    } finally {
      rf.restore();
      cmds.restore();
      fs.rmSync(folderA, { recursive: true, force: true });
      fs.rmSync(folderB, { recursive: true, force: true });
    }
  });

  void it("focuses the view when the question's task is already the current target", async () => {
    const rf = installReadFileBridge();
    const cmds = installExecuteCommandCapture();
    const folderA = makeTaskFolder("same");
    const provider = new ChatViewProvider(makeMemento());

    try {
      await provider.open({ canonicalId: folderA, taskFolderPath: folderA, stage: "impl" });
      cmds.executed.length = 0;

      await provider.ask({
        canonicalId: folderA,
        taskFolderPath: folderA,
        stage: "impl",
        question: "Still there?",
      });

      assert.ok(
        cmds.executed.includes(FOCUS_COMMAND),
        "ask() for the currently-open task must still focus the chat view"
      );
      const transcript = await readChatHistory(folderA);
      assert.deepEqual(transcript.map((m) => m.text), ["Still there?"]);
    } finally {
      rf.restore();
      cmds.restore();
      fs.rmSync(folderA, { recursive: true, force: true });
    }
  });

  void it("focuses the view when nothing is currently open", async () => {
    const rf = installReadFileBridge();
    const cmds = installExecuteCommandCapture();
    const folder = makeTaskFolder("none-open");
    const provider = new ChatViewProvider(makeMemento());

    try {
      await provider.ask({
        canonicalId: folder,
        taskFolderPath: folder,
        stage: "impl",
        question: "First question ever asked",
      });

      assert.ok(
        cmds.executed.includes(FOCUS_COMMAND),
        "ask() must open/focus the view when no task is currently open"
      );
      const transcript = await readChatHistory(folder);
      assert.deepEqual(transcript.map((m) => m.text), ["First question ever asked"]);
    } finally {
      rf.restore();
      cmds.restore();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});
