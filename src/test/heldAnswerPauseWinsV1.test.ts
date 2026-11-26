/**
 * bugs6 item 29 (backport of run1 Step 28's "Pause wins" rule, abd1aca): a held owner answer never resumes
 * a paused task by itself. Driven through the real chat view, with helpers taken from abd1aca's
 * `heldAnswerChatViewReplaysV1.test.ts`.
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
async function holdAnAnswer(folder: string, provider: ChatViewProvider, taskName: string): Promise<NonNullable<ReturnType<typeof taskOperations.begin>>> {
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

void describe("held owner answers and Pause (bugs6 item 29)", () => {
  void it("an answer held while a round runs still runs once when the round ends and the task is active", async () => {
    const folder = makeOwnedTaskFolder("ensemble-held-active-").folder;
    const realFs = installRealFs();
    const provider = new ChatViewProvider(makeMemento());
    const notify = installNotificationRouterCapture();
    const commands = withRecordedCommands();
    try {
      const op = await holdAnAnswer(folder, provider, "held_active");
      assert.deepEqual(commands.calls, [], "nothing runs into the round that is still running");
      taskOperations.end(op);
      await waitFor(() => commands.calls.length > 0);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.deepEqual(commands.calls, ["ensemble.doIt"], "it runs once, when the round ends");
    } finally {
      commands.restore();
      notify.restore();
      realFs.restore();
      provider.dispose();
      safeRemoveDir(folder);
    }
  });

  void it("replay of 2026-11-05 09:30 to 09:34: after Pause and Cancel the held answer does not run, the chat says why, and the card is back", async () => {
    const folder = makeOwnedTaskFolder("ensemble-held-paused-").folder;
    const realFs = installRealFs();
    const provider = new ChatViewProvider(makeMemento());
    const notify = installNotificationRouterCapture();
    const commands = withRecordedCommands();
    try {
      const op = await holdAnAnswer(folder, provider, "held_paused");
      // The owner pauses, then cancels the round.
      await patchTaskProgressStrictV1(vscode.Uri.file(folder), (current) => ({ ...current, status: "paused" as const }));
      taskOperations.cancelOperation(op.id, "notifications");
      taskOperations.end(op);
      await waitFor(() => provider.workflowDecisionStore.get("decision-1")?.state === "pending");
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.deepEqual(commands.calls, [], "the pause wins: nothing is dispatched");
      assert.equal(provider.workflowDecisionStore.get("decision-1")?.state, "pending", "the card is back");
      const texts = (await readChatHistory(folder, folder)).map((entry) => entry.text);
      assert.ok(
        texts.some((text) => text.includes('"Do it"') && text.includes("the task is paused, so it did not run by itself.")),
        `the chat says why: ${JSON.stringify(texts)}`
      );
    } finally {
      commands.restore();
      notify.restore();
      realFs.restore();
      provider.dispose();
      safeRemoveDir(folder);
    }
  });
});
