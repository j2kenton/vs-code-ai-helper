/**
 * run1 Step 33: replays of bugs6 items 27 and 29 through the real pieces end to end, on a real task folder:
 * - the real score loop (`improveReviewScore`) with the same yield rule Fast Forward's callbacks use
 *   (`shouldFastForwardYieldToHeldAnswerV1` over the real decision store);
 * - the real `ChatViewProvider` holding and dispatching the answer, with the real work admission, task lock and
 *   operation registry;
 * - the task's own `task-progress.json`, which the dispatched "Move on" really moves from High-Level to
 *   Low-Level Code Review.
 * Only the model rounds and the command that advances the stage are stand-ins.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { afterEach, describe, it } from "node:test";
import * as vscode from "vscode";

import { ChatViewProvider } from "../views/chatView";
import type { CreateWorkflowDecisionInputV1, WorkflowDecisionDeferredAnswerV1 } from "../types/workflowDecisionV1";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import { readTaskProgressForTest, makeOwnedTaskFolder } from "./taskFolderFixture";
import { taskOperations } from "../utils/taskOperations";
import { initNotificationRouter, deactivateNotificationRouter, type StatusSurface } from "../utils/notificationRouter";
import { clearOwnerCancelRecordsForTestV1 } from "../utils/ownerCancelRecordV1";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import { improveReviewScore, type ReviewRoundOutcome } from "../utils/reviewScoreLoop";
import { shouldFastForwardYieldToHeldAnswerV1, HELD_ANSWER_OWNER_CARD_KEY_V1 } from "../utils/heldAnswerLifecycleV1";
import {
  __resetFastForwardRunsForTestV1,
  clearFastForwardRunActiveV1,
  markFastForwardRunActiveV1,
} from "../utils/activeFastForwardRunsV1";
import { normalizePath } from "../utils/taskRoot";
import { safeRemoveDir } from "./testFsUtils";

const DECISION_ID = "replay-move-on";
const STILL_BLOCKED: ReviewRoundOutcome = { score: 8, taskFixableCount: 0, zeroFixableEvidence: false };

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

function makeExtensionContext(): vscode.ExtensionContext {
  const memento = makeMemento();
  return { workspaceState: memento, globalState: memento, subscriptions: [] } as unknown as vscode.ExtensionContext;
}

function makeFakeWebviewView(): { view: vscode.WebviewView; posted: Array<Record<string, unknown>>; send(message: unknown): Promise<void> } {
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
  return { view, posted, send: async (message: unknown): Promise<void> => void (await handler?.(message)) };
}

function installRealFs(): { restore: () => void } {
  const fsRecord = vscode.workspace.fs as unknown as Record<string, unknown>;
  const original = fsRecord.readFile;
  fsRecord.readFile = async (uri: vscode.Uri): Promise<Uint8Array> =>
    new TextEncoder().encode(await fs.promises.readFile(uri.fsPath, "utf8"));
  return { restore: (): void => void (fsRecord.readFile = original) };
}

function moveOnCard(folder: string): CreateWorkflowDecisionInputV1 {
  return {
    decisionId: DECISION_ID,
    decisionKey: "reviewClean",
    taskCanonicalId: folder,
    stage: "impl-high-review",
    whatHappened: "The High-Level Code Review is clean.",
    whyUserNeeded: "Choose what happens next.",
    options: [
      {
        optionId: "moveOn",
        label: "Move on",
        consequence: "Moves to Low-Level Code Review.",
        resumeKind: "continue",
        effect: { kind: "command", command: "ensemble.replayMoveOn", args: [{ taskFolderPath: folder }] },
      },
    ],
    recommendation: { kind: "option", optionId: "moveOn", reasoning: "Clean." },
    createdAt: new Date().toISOString(),
  };
}

async function waitFor(condition: () => boolean, ms = 10_000): Promise<void> {
  for (let waited = 0; waited < ms && !condition(); waited += 25) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

interface Replay {
  readonly folder: string;
  readonly provider: ChatViewProvider;
  readonly fake: ReturnType<typeof makeFakeWebviewView>;
  readonly moveOnCalls: string[];
  readonly answer: () => WorkflowDecisionDeferredAnswerV1 | undefined;
  readonly stage: () => Promise<string | undefined>;
  readonly status: () => Promise<string | undefined>;
  cleanup(): void;
}

async function startReplay(prefix: string): Promise<Replay> {
  const folder = makeOwnedTaskFolder(prefix).folder;
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
  const stub: StatusSurface = { addEntry: (): void => undefined };
  initNotificationRouter(stub);
  await patchTaskProgressStrictV1(vscode.Uri.file(folder), (current) => ({
    ...current,
    currentStage: "impl-high-review" as const,
    status: "active" as const,
  }));
  const commandsObj = vscode.commands as unknown as {
    _executeCommandOverride?: (id: string, ...args: unknown[]) => Promise<unknown>;
  };
  const originalOverride = commandsObj._executeCommandOverride;
  const moveOnCalls: string[] = [];
  // The one stand-in on the command side: "Move on" really moves the task's stage on disk.
  commandsObj._executeCommandOverride = async (id: string): Promise<unknown> => {
    if (id === "ensemble.replayMoveOn") {
      moveOnCalls.push(id);
      await patchTaskProgressStrictV1(vscode.Uri.file(folder), (current) => ({
        ...current,
        currentStage: "impl-low-review" as const,
      }));
    }
    return undefined;
  };
  const fake = makeFakeWebviewView();
  await provider.workflowDecisionStore.post(moveOnCard(folder));
  provider.resolveWebviewView(fake.view);
  await provider.open({ canonicalId: folder, taskFolderPath: folder, stage: "impl-high-review" });
  for (let i = 0; i < 100 && !fake.posted.some((m) => m.type === "state"); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return {
    folder,
    provider,
    fake,
    moveOnCalls,
    answer: () => provider.workflowDecisionStore.get(DECISION_ID)?.deferredAnswer,
    stage: async () => (await readTaskProgressForTest(vscode.Uri.file(folder)))?.currentStage,
    status: async () => (await readTaskProgressForTest(vscode.Uri.file(folder)))?.status,
    cleanup: (): void => {
      commandsObj._executeCommandOverride = originalOverride;
      provider.dispose();
      deactivateNotificationRouter();
      realFs.restore();
      safeRemoveDir(folder);
    },
  };
}

/**
 * Fast Forward's loop as reviewActions drives it: a round's apply and review both stand aside once an answer is
 * held (the same predicate, over the real store), and the claim is released when the loop ends.
 */
function fastForwardLoop(replay: Replay, counters: { applies: number; reviews: number }, applyRound: () => Promise<void>) {
  const yields = (): boolean =>
    replay.provider.workflowDecisionStore
      .listWithPendingDeferredAnswer(replay.folder)
      .some((candidate) => shouldFastForwardYieldToHeldAnswerV1(candidate.deferredAnswer));
  return (token: vscode.CancellationToken | undefined) =>
    improveReviewScore({
      context: makeExtensionContext(),
      stage: "impl-high-review",
      baselineScore: 7,
      maxAttempts: 10,
      token,
      apply: async () => {
        if (yields()) return;
        counters.applies += 1;
        await applyRound();
      },
      review: () => {
        if (yields()) return Promise.resolve(null);
        counters.reviews += 1;
        return Promise.resolve(STILL_BLOCKED);
      },
    });
}

afterEach(() => {
  clearOwnerCancelRecordsForTestV1();
  __resetFastForwardRunsForTestV1();
});

void describe("run1 Step 33: replay of items 27 and 29 through the real Fast Forward loop and held-answer dispatch", () => {
  void it("08:23 to 09:24: a 'Move on' chosen mid-run runs when the Apply Review ends, the stage becomes Low-Level Code Review, and no further High-Level round starts", async () => {
    const replay = await startReplay("ensemble-ff-replay-27-");
    try {
      markFastForwardRunActiveV1(replay.folder);
      const root = taskOperations.begin(replay.folder, {
        label: "Fast Forward Review",
        taskName: "replay",
        stage: "impl-high-review",
        cancellable: true,
      });
      assert.ok(root);
      const counters = { applies: 0, reviews: 0 };
      let finishApply!: () => void;
      const applyEnds = new Promise<void>((resolve) => {
        finishApply = resolve;
      });
      const loop = fastForwardLoop(replay, counters, () => applyEnds)(root.token);

      // 08:30: the owner chooses "Move on" while the Apply Review is running.
      await waitFor(() => counters.applies === 1);
      await replay.fake.send({ type: "resolveWorkflowDecision", decisionId: DECISION_ID, optionId: "moveOn" });
      await waitFor(() => replay.answer()?.heldState === "held");
      assert.equal(replay.answer()?.heldState, "held", "kept, not run");
      assert.equal(replay.moveOnCalls.length, 0);

      // 08:37: the Apply Review ends. Fast Forward's review stands aside and the loop ends.
      finishApply();
      const result = await loop;
      assert.equal(counters.applies, 1, "no second Apply Review");
      assert.equal(counters.reviews, 0, "no further High-Level review");
      assert.equal(result.attempts, 1);
      assert.equal(replay.moveOnCalls.length, 0, "it waits for the round's claim to be released");

      // The loop's `finally`: the claim is released, and the held answer is due.
      taskOperations.end(root);
      clearFastForwardRunActiveV1(replay.folder);
      await waitFor(() => replay.moveOnCalls.length > 0 && replay.answer()?.heldState === "ran");
      assert.equal(replay.moveOnCalls.length, 1, "it ran exactly once");
      assert.equal(replay.answer()?.heldState, "ran");
      assert.equal(await replay.stage(), "impl-low-review");
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(counters.applies, 1, "still no further High-Level round");
      assert.equal(replay.moveOnCalls.length, 1);
    } finally {
      replay.cleanup();
    }
  });

  void it("09:30 to 09:34: after the owner pauses, nothing new starts; after the cancel the task stays paused and the chat offers the held 'Move on'", async () => {
    const replay = await startReplay("ensemble-ff-replay-29-");
    try {
      markFastForwardRunActiveV1(replay.folder);
      const root = taskOperations.begin(replay.folder, {
        label: "Fast Forward Review",
        taskName: "replay",
        stage: "impl-high-review",
        cancellable: true,
      });
      assert.ok(root);
      const counters = { applies: 0, reviews: 0 };
      // The Apply Review ignores Pause and runs until the owner cancels it.
      const loop = fastForwardLoop(
        replay,
        counters,
        () =>
          new Promise<void>((resolve) => {
            root.token?.onCancellationRequested(() => resolve());
          })
      )(root.token);
      await waitFor(() => counters.applies === 1);
      await replay.fake.send({ type: "resolveWorkflowDecision", decisionId: DECISION_ID, optionId: "moveOn" });
      await waitFor(() => replay.answer()?.heldState === "held");

      // 09:32: Pause. The round carries on.
      await patchTaskProgressStrictV1(vscode.Uri.file(replay.folder), (current) => ({
        ...current,
        status: "paused" as const,
        ownerPausedAt: new Date().toISOString(),
      }));
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(replay.moveOnCalls.length, 0, "nothing new started after the pause");

      // 09:33:45: the owner cancels the round (an ordinary Cancel).
      assert.equal(taskOperations.cancelOperation(root.id, "notifications"), true);
      await assert.rejects(loop, vscode.CancellationError);
      taskOperations.end(root);
      clearFastForwardRunActiveV1(replay.folder);

      // 09:33:49: the held answer is due. It must not resume the task.
      await waitFor(() => replay.answer()?.heldState === "waitingForOwner");
      assert.equal(replay.answer()?.heldState, "waitingForOwner");
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(replay.moveOnCalls.length, 0, "no resume, no new round");
      assert.equal(await replay.status(), "paused", "the task stays paused");
      assert.equal(await replay.stage(), "impl-high-review");
      const offers = replay.provider.workflowDecisionStore
        .listPending(normalizePath(replay.folder))
        .filter((decision) => decision.decisionKey === HELD_ANSWER_OWNER_CARD_KEY_V1);
      assert.equal(offers.length, 1, "the chat offers the held answer: Run it or Drop it");
      assert.match(offers[0]!.whatHappened, /Move on/);
    } finally {
      replay.cleanup();
    }
  });

  void it("'Run it now' on the waiting row cancels the round for the answer, which then runs once and moves the stage", async () => {
    const replay = await startReplay("ensemble-ff-replay-runnow-");
    try {
      markFastForwardRunActiveV1(replay.folder);
      const root = taskOperations.begin(replay.folder, {
        label: "Fast Forward Review",
        taskName: "replay",
        stage: "impl-high-review",
        cancellable: true,
      });
      assert.ok(root);
      const counters = { applies: 0, reviews: 0 };
      const loop = fastForwardLoop(
        replay,
        counters,
        () =>
          new Promise<void>((resolve) => {
            root.token?.onCancellationRequested(() => resolve());
          })
      )(root.token);
      await waitFor(() => counters.applies === 1);
      await replay.fake.send({ type: "resolveWorkflowDecision", decisionId: DECISION_ID, optionId: "moveOn" });
      await waitFor(() => replay.answer()?.heldState === "held");

      const ran = await replay.provider.runHeldAnswerNowV1(DECISION_ID);
      assert.equal(ran.ok, true, ran.message);
      await assert.rejects(loop, vscode.CancellationError);
      taskOperations.end(root);
      clearFastForwardRunActiveV1(replay.folder);
      await waitFor(() => replay.moveOnCalls.length > 0 && replay.answer()?.heldState === "ran");
      assert.equal(replay.moveOnCalls.length, 1);
      assert.equal(await replay.stage(), "impl-low-review");
      assert.equal(counters.reviews, 0);
    } finally {
      replay.cleanup();
    }
  });
});
