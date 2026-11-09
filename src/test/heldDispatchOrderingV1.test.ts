/**
 * run1 Steps 26 to 28 and 33: the ordering of a held answer's dispatch against Pause, restarts and Fast Forward's
 * round boundary:
 * - the swap from held to dispatching happens before the command runs, under the task's lock;
 * - a pause committed while that lock is held wins;
 * - an owner's Cancel survives a restart;
 * - the owner's Pause is never overwritten by a ride-through;
 * - a chained re-review is not started ahead of a held answer, inside Fast Forward only;
 * - two windows over one stored answer run it once.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { afterEach, describe, it } from "node:test";
import * as vscode from "vscode";
import { ChatViewProvider } from "../views/chatView";
import type { CreateWorkflowDecisionInputV1 } from "../types/workflowDecisionV1";
import type { WorkflowDecisionDeferredAnswerV1, WorkflowDecisionV1 } from "../types/workflowDecisionV1";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import { taskOperations } from "../utils/taskOperations";
import { withTaskLock } from "../state/taskStateStore";
import { initNotificationRouter, deactivateNotificationRouter, type StatusSurface } from "../utils/notificationRouter";
import {
  clearOwnerCancelRecordsForTestV1,
  forgetInMemoryOwnerCancelsForTestV1,
  lastRunEndedByForAnswerV1,
  recordOwnerCancelV1,
  setOwnerCancelStoreV1,
} from "../utils/ownerCancelRecordV1";
import { escalationIdentityStillMatchesV1, skipChainedReReviewForHeldAnswerV1 } from "../commands/reviewActions";
import {
  __resetFastForwardRunsForTestV1,
  clearFastForwardRunActiveV1,
  markFastForwardRunActiveV1,
} from "../utils/activeFastForwardRunsV1";
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

async function holdAnAnswer(folder: string, provider: ChatViewProvider, taskName: string) {
  const fake = makeFakeWebviewView();
  const op = taskOperations.begin(folder, { label: "Apply Review", taskName, stage: "impl", cancellable: true });
  assert.ok(op);
  await provider.workflowDecisionStore.post(card(folder));
  provider.resolveWebviewView(fake.view);
  await provider.open({ canonicalId: folder, taskFolderPath: folder, stage: "impl" });
  for (let i = 0; i < 100 && !fake.posted.some((m) => m.type === "state"); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await fake.send({ type: "resolveWorkflowDecision", decisionId: "decision-1", optionId: "doIt" });
  return op;
}

function provider_state(provider: ChatViewProvider): WorkflowDecisionDeferredAnswerV1 | undefined {
  return provider.workflowDecisionStore.get("decision-1")?.deferredAnswer;
}

afterEach(() => {
  clearOwnerCancelRecordsForTestV1();
  __resetFastForwardRunsForTestV1();
});

void describe("held answer dispatch ordering (run1 Steps 26 to 28)", () => {
  void it("the answer is recorded as dispatching, with its dispatch id, before a command that takes no work admission runs", async () => {
    const folder = makeOwnedTaskFolder("ensemble-held-order-").folder;
    const realFs = installRealFs();
    const provider = new ChatViewProvider(makeMemento());
    const notify = installNotificationRouterCapture();
    const commandsObj = vscode.commands as unknown as {
      _executeCommandOverride?: (id: string, ...args: unknown[]) => Promise<unknown>;
    };
    const originalOverride = commandsObj._executeCommandOverride;
    let stateWhenCommandRan: WorkflowDecisionDeferredAnswerV1 | undefined;
    commandsObj._executeCommandOverride = (id: string): Promise<unknown> => {
      if (id === "ensemble.doIt") {
        stateWhenCommandRan = provider.workflowDecisionStore.get("decision-1")?.deferredAnswer;
      }
      return Promise.resolve(undefined);
    };
    try {
      const op = await holdAnAnswer(folder, provider, "held_order");
      taskOperations.end(op);
      await waitFor(() => stateWhenCommandRan !== undefined);
      assert.equal(stateWhenCommandRan?.heldState, "dispatching", "durably dispatching before the command ran");
      assert.ok((stateWhenCommandRan?.dispatchId ?? "").length > 0, "its dispatch id was written first");
      assert.ok(stateWhenCommandRan?.commandStartedAt, "and the start of the command was written before it ran");
      await waitFor(() => provider.workflowDecisionStore.get("decision-1")?.deferredAnswer?.heldState === "ran");
      assert.equal(provider.workflowDecisionStore.get("decision-1")?.deferredAnswer?.heldState, "ran");
    } finally {
      commandsObj._executeCommandOverride = originalOverride;
      notify.restore();
      realFs.restore();
      provider.dispose();
      safeRemoveDir(folder);
    }
  });

  void it("a pause committed while the task's lock is held wins: the dispatch waits for the lock, sees the pause and runs nothing", async () => {
    const folder = makeOwnedTaskFolder("ensemble-held-lock-").folder;
    const realFs = installRealFs();
    const memento = makeMemento();
    const provider = new ChatViewProvider(memento);
    const notify = installNotificationRouterCapture();
    const commandsObj = vscode.commands as unknown as {
      _executeCommandOverride?: (id: string, ...args: unknown[]) => Promise<unknown>;
    };
    const originalOverride = commandsObj._executeCommandOverride;
    const calls: string[] = [];
    commandsObj._executeCommandOverride = (id: string): Promise<unknown> => {
      if (id === "ensemble.doIt") calls.push(id);
      return Promise.resolve(undefined);
    };
    try {
      const op = await holdAnAnswer(folder, provider, "held_lock");
      let releasePause!: () => void;
      const pauseCommitted = new Promise<void>((resolve) => {
        releasePause = resolve;
      });
      // Pause's own write holds the task's lock; the round ends meanwhile, so the dispatch is due.
      const pausing = withTaskLock(folder, async () => {
        taskOperations.end(op);
        await new Promise((resolve) => setTimeout(resolve, 400));
        assert.deepEqual(calls, [], "the dispatch waits for the lock");
        await patchTaskProgressStrictV1(
          vscode.Uri.file(folder),
          (current) => ({ ...current, status: "paused" as const, ownerPausedAt: new Date().toISOString() }),
          { skipLock: true }
        );
        releasePause();
      });
      await pauseCommitted;
      await pausing;
      await waitFor(() => provider.workflowDecisionStore.get("decision-1")?.deferredAnswer?.heldState === "waitingForOwner");
      assert.equal(provider.workflowDecisionStore.get("decision-1")?.deferredAnswer?.heldState, "waitingForOwner");
      assert.deepEqual(calls, [], "the pause won: nothing was dispatched");
    } finally {
      commandsObj._executeCommandOverride = originalOverride;
      notify.restore();
      realFs.restore();
      provider.dispose();
      safeRemoveDir(folder);
    }
  });

  void it("a crash while a command that takes no work admission was running: after the restart it asks, and never runs it again", async () => {
    const folder = makeOwnedTaskFolder("ensemble-held-crash-").folder;
    const realFs = installRealFs();
    const memento = makeMemento();
    const first = new ChatViewProvider(memento);
    const notify = installNotificationRouterCapture();
    const commandsObj = vscode.commands as unknown as {
      _executeCommandOverride?: (id: string, ...args: unknown[]) => Promise<unknown>;
    };
    const originalOverride = commandsObj._executeCommandOverride;
    const calls: string[] = [];
    let releaseCommand: () => void = () => undefined;
    // The command has its effect and the process dies before anything else is written: it never returns.
    commandsObj._executeCommandOverride = (id: string): Promise<unknown> => {
      if (id === "ensemble.doIt") {
        calls.push(id);
        return new Promise<unknown>((resolve) => {
          releaseCommand = (): void => resolve(undefined);
        });
      }
      return Promise.resolve(undefined);
    };
    let restarted: ChatViewProvider | undefined;
    try {
      const op = await holdAnAnswer(folder, first, "held_crash");
      taskOperations.end(op);
      await waitFor(() => calls.length > 0);
      assert.deepEqual(calls, ["ensemble.doIt"]);
      assert.equal(provider_state(first)?.heldState, "dispatching");
      // The restarted window reads the same stored record, with no claim and no ledger row for the dispatch.
      restarted = new ChatViewProvider(memento);
      restarted.rearmKeptAnswersV1();
      await waitFor(() => provider_state(restarted!)?.heldState === "uncertain");
      assert.equal(provider_state(restarted)?.heldState, "uncertain", "ask the owner; do not guess");
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.deepEqual(calls, ["ensemble.doIt"], "the command was not run a second time");
    } finally {
      // Let the "crashed" window's waiter finish, so it doesn't stay armed under this decision id for other tests.
      releaseCommand();
      await new Promise((resolve) => setTimeout(resolve, 300));
      commandsObj._executeCommandOverride = originalOverride;
      notify.restore();
      realFs.restore();
      restarted?.dispose();
      first.dispose();
      safeRemoveDir(folder);
    }
  });

  void it("two windows over one stored answer run it once", async () => {
    const folder = makeOwnedTaskFolder("ensemble-held-twowin-").folder;
    const realFs = installRealFs();
    const memento = makeMemento();
    const first = new ChatViewProvider(memento);
    const notify = installNotificationRouterCapture();
    const commandsObj = vscode.commands as unknown as {
      _executeCommandOverride?: (id: string, ...args: unknown[]) => Promise<unknown>;
    };
    const originalOverride = commandsObj._executeCommandOverride;
    const calls: string[] = [];
    commandsObj._executeCommandOverride = (id: string): Promise<unknown> => {
      if (id === "ensemble.doIt") calls.push(id);
      return Promise.resolve(undefined);
    };
    let second: ChatViewProvider | undefined;
    try {
      const op = await holdAnAnswer(folder, first, "held_twowin");
      // The other window is a separate provider over the same stored decisions, armed on its own.
      second = new ChatViewProvider(memento);
      second.rearmKeptAnswersV1();
      taskOperations.end(op);
      await waitFor(() => calls.length > 0);
      await new Promise((resolve) => setTimeout(resolve, 600));
      assert.deepEqual(calls, ["ensemble.doIt"], "run once across the two windows");
    } finally {
      commandsObj._executeCommandOverride = originalOverride;
      notify.restore();
      realFs.restore();
      second?.dispose();
      first.dispose();
      safeRemoveDir(folder);
    }
  });
});

void describe("an owner's Cancel survives a restart (run1 Step 28)", () => {
  void it("a held answer chosen before the Cancel is still blocked after the process forgets it", () => {
    const store = makeMemento();
    setOwnerCancelStoreV1(store);
    const taskPath = "/tmp/ensemble-cancel-restart/task";
    const chosenAt = Date.now() - 60_000;
    recordOwnerCancelV1(taskPath, "owner", Date.now() - 30_000);
    forgetInMemoryOwnerCancelsForTestV1();
    assert.equal(lastRunEndedByForAnswerV1(taskPath, chosenAt), "owner");
    assert.equal(lastRunEndedByForAnswerV1(taskPath, Date.now()), "other", "a cancel from before the answer does not count");
  });

  void it("'Run it now' stays the go-ahead after a restart", () => {
    setOwnerCancelStoreV1(makeMemento());
    const taskPath = "/tmp/ensemble-cancel-restart/run-now";
    recordOwnerCancelV1(taskPath, "runHeldAnswer", Date.now() - 10_000);
    forgetInMemoryOwnerCancelsForTestV1();
    assert.equal(lastRunEndedByForAnswerV1(taskPath, Date.now() - 60_000), "runHeldAnswer");
  });
});

void describe("ride-through never overwrites an owner's pause (run1 Step 28)", () => {
  const escalation = { stage: "impl", kind: "stuck", at: "2026-11-05T09:00:00.000Z" } as never;
  void it("the write-time check refuses once the owner's pause has landed", () => {
    assert.equal(
      escalationIdentityStillMatchesV1({ status: "paused", escalation } as never, escalation, "impl"),
      true
    );
    assert.equal(
      escalationIdentityStillMatchesV1(
        { status: "paused", escalation, ownerPausedAt: "2026-11-05T09:01:00.000Z" } as never,
        escalation,
        "impl"
      ),
      false
    );
  });
});

void describe("Fast Forward's round boundary (run1 Step 27)", () => {
  const folder = "/tmp/ensemble-boundary/task";
  const held = (heldState: string): WorkflowDecisionV1 =>
    ({ deferredAnswer: { kind: "heldOption", heldState } }) as unknown as WorkflowDecisionV1;
  const storeWith = (...answers: WorkflowDecisionV1[]) => ({ listWithPendingDeferredAnswer: () => answers });

  void it("inside a Fast Forward run, a held answer means no chained re-review before Fast Forward yields", () => {
    markFastForwardRunActiveV1(folder);
    assert.equal(skipChainedReReviewForHeldAnswerV1(folder, storeWith(held("held"))), true);
    clearFastForwardRunActiveV1(folder);
  });

  void it("with nothing held, or with the answer waiting for the owner, the re-review runs as before", () => {
    markFastForwardRunActiveV1(folder);
    assert.equal(skipChainedReReviewForHeldAnswerV1(folder, storeWith()), false);
    assert.equal(skipChainedReReviewForHeldAnswerV1(folder, storeWith(held("waitingForOwner"))), false);
    clearFastForwardRunActiveV1(folder);
  });

  void it("a hand-started round (no Fast Forward run) keeps its re-review even with an answer held", () => {
    assert.equal(skipChainedReReviewForHeldAnswerV1(folder, storeWith(held("held"))), false);
  });
});
