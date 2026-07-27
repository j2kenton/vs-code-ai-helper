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
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { ChatViewProvider } from "../views/chatView";
import { readChatHistory } from "../utils/chatHistoryStore";
import { makeOwnedTaskFolder } from "./taskFolderFixture";
import { initNotificationRouter, deactivateNotificationRouter, StatusSurface } from "../utils/notificationRouter";

/** ask() now raises an internal Notifications entry for every question
 * (see chatView.ts's notifyWaitingForFeedback) — a no-op stub surface so
 * that doesn't throw "NotificationRouter is not initialized" in this file's
 * tests, none of which assert on notification content. */
function installNotificationRouterStub(): { restore: () => void } {
  const stub: StatusSurface = { addEntry: (): void => { /* no-op */ } };
  initNotificationRouter(stub);
  return { restore: (): void => deactivateNotificationRouter() };
}

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
  // Task conversations require the strict, ownership-backed task-folder
  // root contract (see workflowRuntimeServicesV1.ts).
  return makeOwnedTaskFolder(`ensemble-chatview-${name}-`).folder;
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

  void it("styles the task/stage header as a distinct title and gives user/agent messages different, theme-safe treatments", () => {
    const html = chatWebviewHtml();

    // Regression coverage for a review finding: the message background used
    // --vscode-editor-inactiveSelectionBackground, a token meant for a
    // transient selection highlight — in some high-contrast dark themes it
    // resolves lighter than --vscode-foreground text sitting permanently on
    // top of it, breaking contrast. That token must be gone.
    assert.doesNotMatch(html, /inactiveSelectionBackground/);

    // The task/stage header (#context) must read as a title, not body text:
    // bold, larger, and visually separated from the message list — not the
    // muted descriptionForeground color used for secondary status text.
    const contextRule = /#context\s*\{([^}]*)\}/.exec(html);
    assert.ok(contextRule, "expected a #context CSS rule");
    assert.match(contextRule[1]!, /font-weight:\s*bold/);
    assert.match(contextRule[1]!, /color:\s*var\(--vscode-foreground\)/);
    assert.doesNotMatch(contextRule[1]!, /descriptionForeground/);

    // User messages: foreground-on-editor-background with a foreground-
    // colored border (the border stands in for a distinct background), so
    // the same pairing that's already readable for the rest of the
    // extension's text is what carries the message, in every theme.
    const userRule = /#messages p\.msg-user\s*\{([^}]*)\}/.exec(html);
    assert.ok(userRule, "expected a #messages p.msg-user CSS rule");
    assert.match(userRule[1]!, /color:\s*var\(--vscode-foreground\)/);
    assert.match(userRule[1]!, /background-color:\s*var\(--vscode-editor-background\)/);
    assert.match(userRule[1]!, /border:\s*var\(--ensemble-border-width\)\s*solid\s*var\(--vscode-foreground\)/);

    // Agent messages: a distinct surface (sideBar-background), not a border,
    // so the two roles are never confused at a glance.
    const agentRule = /#messages p\.msg-agent\s*\{([^}]*)\}/.exec(html);
    assert.ok(agentRule, "expected a #messages p.msg-agent CSS rule");
    assert.match(agentRule[1]!, /background-color:\s*var\(--vscode-sideBar-background\)/);
    assert.match(agentRule[1]!, /border:\s*none/);

    // The render script must actually apply msg-user only to the "user"
    // role, routing every other role (assistant, question) to msg-agent.
    assert.match(html, /className\s*=\s*x\.role\s*===\s*'user'\s*\?\s*'msg-user'\s*:\s*'msg-agent'/);
  });

  void it("writes the question to its own task but does not refocus/retarget the view when a different task is current", async () => {
    const rf = installReadFileBridge();
    const cmds = installExecuteCommandCapture();
    const notify = installNotificationRouterStub();
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
      notify.restore();
      fs.rmSync(folderA, { recursive: true, force: true });
      fs.rmSync(folderB, { recursive: true, force: true });
    }
  });

  void it("focuses the view when the question's task is already the current target", async () => {
    const rf = installReadFileBridge();
    const cmds = installExecuteCommandCapture();
    const notify = installNotificationRouterStub();
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
      notify.restore();
      fs.rmSync(folderA, { recursive: true, force: true });
    }
  });

  void it("focuses the view when nothing is currently open", async () => {
    const rf = installReadFileBridge();
    const cmds = installExecuteCommandCapture();
    const notify = installNotificationRouterStub();
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
      notify.restore();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});
