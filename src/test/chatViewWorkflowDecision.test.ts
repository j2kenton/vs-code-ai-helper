/**
 * Coverage for PART 2 of "Replace hidden notification decision buttons with
 * explained, selectable decisions" — Chat With AI rendering and dispatch of
 * `WorkflowDecisionV1` records:
 *
 *  - render() surfaces a task/stage's pending decisions in the posted "state"
 *    message, scoped to the exact task + stage (a decision for a different
 *    task, a different stage of the same task, or posted while the global
 *    assistant is open must never appear).
 *  - The webview's single `resolveWorkflowDecision` message resolves the
 *    record in the store FIRST, then dispatches the chosen option's command
 *    effect exactly once; a `doNothing` option resolves without dispatching
 *    anything.
 *  - A second resolve of an already-settled decision is reported as
 *    informational ("already submitted"), never as a warning/error, and does
 *    not dispatch the command a second time (task: "an already-answered
 *    decision is not an error").
 *  - `notifyPendingWorkflowDecision` posts a single "Review decision in Chat"
 *    action that routes to `vs-code-ai-helper.openWorkflowDecision`, never
 *    itself carrying the decision's options.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { ChatTarget, ChatViewProvider, notifyPendingWorkflowDecision } from "../views/chatView";
import { CreateWorkflowDecisionInputV1, WorkflowDecisionV1 } from "../types/workflowDecisionV1";
import { makeOwnedTaskFolder } from "./taskFolderFixture";
import { initNotificationRouter, deactivateNotificationRouter, StatusSurface } from "../utils/notificationRouter";

interface CapturedNotification {
  message: string;
  level: "info" | "warning" | "error";
  actionCommand?: { command: string; title: string; args?: unknown[] };
}

function installNotificationRouterCapture(): { entries: CapturedNotification[]; restore: () => void } {
  const entries: CapturedNotification[] = [];
  const stub: StatusSurface = {
    addEntry: (message, level, _filePath, _resultTargetUri, _sourceOperationId, actionCommand): void => {
      entries.push({ message, level, actionCommand });
    },
  };
  initNotificationRouter(stub);
  return { entries, restore: (): void => deactivateNotificationRouter() };
}

function installExecuteCommandCapture(): {
  calls: Array<{ id: string; args: unknown[] }>;
  restore: () => void;
} {
  const commandsObj = vscode.commands as unknown as {
    _executeCommandOverride?: (id: string, ...args: unknown[]) => Promise<unknown>;
  };
  const orig = commandsObj._executeCommandOverride;
  const calls: Array<{ id: string; args: unknown[] }> = [];
  commandsObj._executeCommandOverride = (id: string, ...args: unknown[]): Promise<unknown> => {
    calls.push({ id, args });
    return Promise.resolve(undefined);
  };
  return {
    calls,
    restore: (): void => {
      commandsObj._executeCommandOverride = orig;
    },
  };
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

function makeFolder(): string {
  return makeOwnedTaskFolder("ensemble-chat-workflow-decision-").folder;
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

function decisionInput(
  canonicalId: string,
  overrides: Partial<CreateWorkflowDecisionInputV1> = {}
): CreateWorkflowDecisionInputV1 {
  return {
    decisionId: "decision-1",
    decisionKey: "exampleDecision",
    taskCanonicalId: canonicalId,
    stage: "impl",
    whatHappened: "The scheduled round finished and the summary was rejected.",
    whyUserNeeded: "The system cannot tell whether to retry or restore the prior round.",
    options: [
      {
        optionId: "doIt",
        label: "Do it",
        consequence: "Applies the change immediately.",
        effect: { kind: "command", command: "ensemble.doIt", args: ["arg1"] },
      },
    ],
    recommendation: { kind: "option", optionId: "doIt", reasoning: "It is safe and reversible." },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function lastDecisions(fake: FakeWebviewView): readonly WorkflowDecisionV1[] {
  const lastState = fake.posted.filter((m) => m.type === "state").pop();
  return (lastState?.decisions as readonly WorkflowDecisionV1[] | undefined) ?? [];
}

/**
 * `open()` deliberately fires `render()` without awaiting it (matches
 * production — the panel focus command must not block on a full transcript
 * read/render), so a "state" message is not guaranteed to have posted the
 * instant `open()` resolves. Poll briefly instead of asserting on a race.
 */
async function waitForStateMessage(fake: FakeWebviewView): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (fake.posted.some((m) => m.type === "state")) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

void describe("Chat With AI — WorkflowDecisionV1 rendering and dispatch", () => {
  void it("render() surfaces a pending decision for its exact task and stage", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
    try {
      const posted = await provider.workflowDecisionStore.post(decisionInput(folder));
      assert.ok(posted.ok, posted.ok ? undefined : posted.reason);

      provider.resolveWebviewView(fake.view);
      await provider.open({ canonicalId: folder, taskFolderPath: folder, stage: "impl" });
      await waitForStateMessage(fake);

      const decisions = lastDecisions(fake);
      assert.equal(decisions.length, 1);
      assert.equal(decisions[0]!.decisionId, "decision-1");
    } finally {
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("render() excludes a decision posted for a different stage of the same task", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
    try {
      await provider.workflowDecisionStore.post(decisionInput(folder, { stage: "impl-high-review" }));

      provider.resolveWebviewView(fake.view);
      await provider.open({ canonicalId: folder, taskFolderPath: folder, stage: "impl" });
      await waitForStateMessage(fake);

      assert.equal(lastDecisions(fake).length, 0);
    } finally {
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("render() excludes decisions when the global assistant is open", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
    try {
      await provider.workflowDecisionStore.post(decisionInput(folder));

      provider.resolveWebviewView(fake.view);
      await provider.open({ canonicalId: folder, taskFolderPath: folder, stage: "impl", kind: "global" });
      await waitForStateMessage(fake);

      assert.equal(lastDecisions(fake).length, 0);
    } finally {
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("resolveWorkflowDecision dispatches the chosen option's command exactly once and clears the pending card", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
    try {
      await provider.workflowDecisionStore.post(decisionInput(folder));
      provider.resolveWebviewView(fake.view);
      await provider.open({ canonicalId: folder, taskFolderPath: folder, stage: "impl" });
      await waitForStateMessage(fake);
      assert.equal(lastDecisions(fake).length, 1, "expected the decision to render before resolving it");
      cmds.calls.length = 0; // drop the focus-command call `open()` itself issues

      await fake.send({ type: "resolveWorkflowDecision", decisionId: "decision-1", optionId: "doIt" });

      assert.deepEqual(cmds.calls, [{ id: "ensemble.doIt", args: ["arg1"] }]);
      assert.equal(lastDecisions(fake).length, 0, "a resolved decision must no longer render as pending");
    } finally {
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("resolveWorkflowDecision resolves a doNothing option without dispatching any command", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
    try {
      await provider.workflowDecisionStore.post(
        decisionInput(folder, {
          options: [
            {
              optionId: "wait",
              label: "Wait",
              consequence: "Leaves the round as-is; nothing changes.",
              effect: { kind: "doNothing" },
            },
          ],
          recommendation: { kind: "option", optionId: "wait", reasoning: "Nothing needs to happen yet." },
        })
      );
      provider.resolveWebviewView(fake.view);
      await provider.open({ canonicalId: folder, taskFolderPath: folder, stage: "impl" });
      cmds.calls.length = 0; // drop the focus-command call `open()` itself issues

      await fake.send({ type: "resolveWorkflowDecision", decisionId: "decision-1", optionId: "wait" });

      assert.deepEqual(cmds.calls, [], "a doNothing option must never dispatch a command");
      assert.equal(lastDecisions(fake).length, 0);
    } finally {
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("a second resolve of an already-settled decision is informational, not an error, and does not re-dispatch", async () => {
    const folder = makeFolder();
    const provider = new ChatViewProvider(makeMemento());
    const fake = makeFakeWebviewView();
    const notify = installNotificationRouterCapture();
    const cmds = installExecuteCommandCapture();
    try {
      await provider.workflowDecisionStore.post(decisionInput(folder));
      provider.resolveWebviewView(fake.view);
      await provider.open({ canonicalId: folder, taskFolderPath: folder, stage: "impl" });
      cmds.calls.length = 0; // drop the focus-command call `open()` itself issues

      await fake.send({ type: "resolveWorkflowDecision", decisionId: "decision-1", optionId: "doIt" });
      notify.entries.length = 0;
      await fake.send({ type: "resolveWorkflowDecision", decisionId: "decision-1", optionId: "doIt" });

      assert.deepEqual(cmds.calls, [{ id: "ensemble.doIt", args: ["arg1"] }], "must dispatch exactly once total");
      assert.equal(notify.entries.length, 1);
      assert.equal(notify.entries[0]!.level, "info", "an already-settled decision must not read as a failure");
      assert.match(notify.entries[0]!.message, /already submitted/i);
    } finally {
      notify.restore();
      cmds.restore();
      provider.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("notifyPendingWorkflowDecision posts a single 'Review decision in Chat' action, not the options themselves", () => {
    const folder = makeFolder();
    const notify = installNotificationRouterCapture();
    try {
      const target: ChatTarget = { canonicalId: folder, taskFolderPath: folder, stage: "impl", taskName: "My Task" };
      const decision: WorkflowDecisionV1 = {
        decisionId: "decision-1",
        decisionKey: "exampleDecision",
        taskCanonicalId: folder,
        stage: "impl",
        whatHappened: "The scheduled round finished and the summary was rejected.",
        whyUserNeeded: "The system cannot tell whether to retry or restore the prior round.",
        options: [
          {
            optionId: "doIt",
            label: "Do it",
            consequence: "Applies the change immediately.",
            effect: { kind: "command", command: "ensemble.doIt" },
          },
        ],
        recommendation: { kind: "option", optionId: "doIt", reasoning: "It is safe and reversible." },
        createdAt: new Date().toISOString(),
        state: "pending",
      };

      notifyPendingWorkflowDecision(decision, target);

      assert.equal(notify.entries.length, 1);
      const entry = notify.entries[0]!;
      assert.match(entry.message, /My Task/);
      assert.match(entry.message, /rejected/);
      assert.ok(entry.actionCommand);
      assert.equal(entry.actionCommand.command, "vs-code-ai-helper.openWorkflowDecision");
      assert.equal(entry.actionCommand.title, "Review decision in Chat");
      assert.deepEqual(entry.actionCommand.args, [target]);
    } finally {
      notify.restore();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});
