/**
 * run1 Steps 28 and 33 (owner, 2026-11-09): a held answer with two windows open, built from two independent
 * windows. Each window is its own `ChatViewProvider` over its OWN state store (its own Memento) and its own
 * table of waiting answers. They share only what two real VS Code windows share: the task folder on disk (the
 * work-admission claim, the progress file) and, for a viewer, the runner's mirrored record.
 *
 * - The runner holds the answer and carries it out; a viewer window with the mirrored record never arms or runs it.
 * - A reload of the runner while a viewer is open asks the owner once, and nothing runs a second time.
 * - Every held answer runs under the task's work admission, even a command that takes none of its own: while it
 *   runs, the claim on disk carries its dispatch id, and another window's start for the task is refused.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { afterEach, describe, it } from "node:test";
import * as vscode from "vscode";
import { ChatViewProvider } from "../views/chatView";
import type { CreateWorkflowDecisionInputV1, WorkflowDecisionDeferredAnswerV1 } from "../types/workflowDecisionV1";
import { taskOperations } from "../utils/taskOperations";
import { initNotificationRouter, deactivateNotificationRouter, type StatusSurface } from "../utils/notificationRouter";
import { clearOwnerCancelRecordsForTestV1 } from "../utils/ownerCancelRecordV1";
import { __resetFastForwardRunsForTestV1 } from "../utils/activeFastForwardRunsV1";
import { configureEnsembleHostRoleForTestV1 } from "../state/hostRoleV1";
import {
  acquireWorkAdmissionV1,
  hasLiveWorkAdmissionBestEffortV1,
  readAdmissionTraceForDispatchV1,
} from "../state/workAdmissionV1";
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

function makeFakeWebviewView(): {
  view: vscode.WebviewView;
  posted: Array<Record<string, unknown>>;
  send(message: unknown): Promise<void>;
} {
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

function installNotificationRouterCapture(): { restore: () => void } {
  const stub: StatusSurface = { addEntry: (): void => undefined };
  initNotificationRouter(stub);
  return { restore: (): void => deactivateNotificationRouter() };
}

function card(folder: string): CreateWorkflowDecisionInputV1 {
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

function stateOf(provider: ChatViewProvider): WorkflowDecisionDeferredAnswerV1 | undefined {
  return provider.workflowDecisionStore.get("decision-1")?.deferredAnswer;
}

/** The runner window: it posts the card, the owner answers while a round runs, and the answer is held. */
async function holdOnRunner(folder: string, runner: ChatViewProvider) {
  const fake = makeFakeWebviewView();
  const op = taskOperations.begin(folder, { label: "Apply Review", taskName: "windows", stage: "impl", cancellable: true });
  assert.ok(op);
  await runner.workflowDecisionStore.post(card(folder));
  runner.resolveWebviewView(fake.view);
  await runner.open({ canonicalId: folder, taskFolderPath: folder, stage: "impl" });
  for (let i = 0; i < 100 && !fake.posted.some((m) => m.type === "state"); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await fake.send({ type: "resolveWorkflowDecision", decisionId: "decision-1", optionId: "doIt" });
  return op;
}

/** The viewer window: its own store holding the runner's mirrored record of the same held answer. */
async function openViewerWithMirror(folder: string, runnerRecord: WorkflowDecisionDeferredAnswerV1) {
  const viewer = new ChatViewProvider(makeMemento());
  await viewer.workflowDecisionStore.post(card(folder));
  await viewer.workflowDecisionStore.recordDeferredAnswer("decision-1", { ...runnerRecord });
  return viewer;
}

const commandsObj = vscode.commands as unknown as {
  _executeCommandOverride?: (id: string, ...args: unknown[]) => Promise<unknown>;
};

afterEach(() => {
  configureEnsembleHostRoleForTestV1(undefined);
  clearOwnerCancelRecordsForTestV1();
  __resetFastForwardRunsForTestV1();
});

void describe("a held answer with two independent windows (run1 Steps 28 and 33)", () => {
  void it("the runner carries the answer out once; a viewer window holding the mirrored record never arms or runs it", async () => {
    const folder = makeOwnedTaskFolder("ensemble-held-indep-").folder;
    const realFs = installRealFs();
    const runner = new ChatViewProvider(makeMemento());
    const notify = installNotificationRouterCapture();
    const originalOverride = commandsObj._executeCommandOverride;
    const calls: string[] = [];
    commandsObj._executeCommandOverride = (id: string): Promise<unknown> => {
      if (id === "ensemble.doIt") calls.push(id);
      return Promise.resolve(undefined);
    };
    let viewer: ChatViewProvider | undefined;
    try {
      const op = await holdOnRunner(folder, runner);
      const held = stateOf(runner);
      assert.equal(held?.heldState, "held");
      assert.ok(held);
      viewer = await openViewerWithMirror(folder, held);
      // Activation in the viewer window (a viewer is told by its host role; the runner's role is not touched).
      configureEnsembleHostRoleForTestV1("viewer");
      viewer.rearmKeptAnswersV1();
      configureEnsembleHostRoleForTestV1(undefined);
      // The round ends: both windows see the end through their own subscriptions.
      taskOperations.end(op);
      await waitFor(() => calls.length > 0);
      await new Promise((resolve) => setTimeout(resolve, 700));
      assert.deepEqual(calls, ["ensemble.doIt"], "run once across the two windows");
      assert.equal(stateOf(viewer)?.heldState, "held", "the viewer's own record was never swapped or run");
      await waitFor(() => stateOf(runner)?.heldState === "ran");
      assert.equal(stateOf(runner)?.heldState, "ran");
    } finally {
      commandsObj._executeCommandOverride = originalOverride;
      notify.restore();
      realFs.restore();
      viewer?.dispose();
      runner.dispose();
      safeRemoveDir(folder);
    }
  });

  void it("a reload of the runner with a viewer open: the answer asks once, and nothing runs a second time", async () => {
    const folder = makeOwnedTaskFolder("ensemble-held-indep-reload-").folder;
    const realFs = installRealFs();
    const runnerState = makeMemento();
    const runner = new ChatViewProvider(runnerState);
    const notify = installNotificationRouterCapture();
    const originalOverride = commandsObj._executeCommandOverride;
    const calls: string[] = [];
    let releaseCommand: () => void = () => undefined;
    // The command has its effect and the window dies before it returns.
    commandsObj._executeCommandOverride = (id: string): Promise<unknown> => {
      if (id === "ensemble.doIt") {
        calls.push(id);
        return new Promise<unknown>((resolve) => {
          releaseCommand = (): void => resolve(undefined);
        });
      }
      return Promise.resolve(undefined);
    };
    let viewer: ChatViewProvider | undefined;
    let reloaded: ChatViewProvider | undefined;
    try {
      const op = await holdOnRunner(folder, runner);
      viewer = await openViewerWithMirror(folder, stateOf(runner) as WorkflowDecisionDeferredAnswerV1);
      taskOperations.end(op);
      await waitFor(() => calls.length > 0);
      assert.equal(stateOf(runner)?.heldState, "dispatching");
      // The runner reloads: a new provider over the SAME runner state, its own empty table of waiters. No
      // operation is registered any more, and the old window's claim is still on disk carrying the dispatch id.
      reloaded = new ChatViewProvider(runnerState);
      configureEnsembleHostRoleForTestV1("viewer");
      viewer.rearmKeptAnswersV1();
      configureEnsembleHostRoleForTestV1(undefined);
      reloaded.rearmKeptAnswersV1();
      await waitFor(() => stateOf(reloaded!)?.heldState === "uncertain");
      assert.equal(stateOf(reloaded)?.heldState, "uncertain", "it may have had its effect: the owner is asked");
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.deepEqual(calls, ["ensemble.doIt"], "the command was not run a second time, by either window");
      assert.equal(stateOf(viewer)?.heldState, "held", "the viewer never acted on its mirrored record");
    } finally {
      releaseCommand();
      await new Promise((resolve) => setTimeout(resolve, 300));
      commandsObj._executeCommandOverride = originalOverride;
      notify.restore();
      realFs.restore();
      viewer?.dispose();
      reloaded?.dispose();
      runner.dispose();
      safeRemoveDir(folder);
    }
  });

  void it("a command that takes no work admission still runs under the task's claim, and another window's start is refused meanwhile", async () => {
    const folder = makeOwnedTaskFolder("ensemble-held-indep-claim-").folder;
    const realFs = installRealFs();
    const runner = new ChatViewProvider(makeMemento());
    const notify = installNotificationRouterCapture();
    const originalOverride = commandsObj._executeCommandOverride;
    let releaseCommand: () => void = () => undefined;
    let insideCommand:
      | {
          claimWhileRunning: string;
          carriesDispatchId: boolean;
          dispatchId: string | undefined;
          liveClaim: boolean;
        }
      | undefined;
    // The command never calls the work admission itself.
    commandsObj._executeCommandOverride = async (id: string): Promise<unknown> => {
      if (id !== "ensemble.doIt") return undefined;
      const dispatchId = stateOf(runner)?.dispatchId;
      const trace = readAdmissionTraceForDispatchV1(folder, dispatchId ?? "none");
      insideCommand = {
        claimWhileRunning: trace.claim,
        carriesDispatchId: trace.claimCarriesDispatchId,
        dispatchId,
        liveClaim: hasLiveWorkAdmissionBestEffortV1(folder),
      };
      await new Promise<void>((resolve) => {
        releaseCommand = resolve;
      });
      return undefined;
    };
    try {
      const op = await holdOnRunner(folder, runner);
      taskOperations.end(op);
      await waitFor(() => insideCommand !== undefined);
      assert.ok(insideCommand, "the command ran");
      assert.equal(insideCommand.claimWhileRunning, "live", "the dispatch holds the task's claim while the command runs");
      assert.equal(insideCommand.carriesDispatchId, true, "and the claim carries the answer's dispatch id");
      assert.ok((insideCommand.dispatchId ?? "").length > 0);
      assert.equal(insideCommand.liveClaim, true);
      // Another window (outside the dispatch) starting work for this task meets the claim on disk.
      const other = await acquireWorkAdmissionV1({ taskFolderPath: folder, purpose: "admission", commandId: "other-window" });
      if (other.outcome === "acquired") await other.handle.release();
      assert.equal(other.outcome, "busy", "another start for the task is refused, not run beside it");
      releaseCommand();
      await waitFor(() => stateOf(runner)?.heldState === "ran");
      assert.equal(stateOf(runner)?.heldState, "ran");
      await waitFor(() => !hasLiveWorkAdmissionBestEffortV1(folder));
      assert.equal(hasLiveWorkAdmissionBestEffortV1(folder), false, "the claim is given back when the command ends");
    } finally {
      releaseCommand();
      commandsObj._executeCommandOverride = originalOverride;
      notify.restore();
      realFs.restore();
      runner.dispose();
      safeRemoveDir(folder);
    }
  });
});
