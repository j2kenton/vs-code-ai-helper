/**
 * bugs7 item 3 (Step 11 / Step 14): a review that ends, however it was started, names the next click. This drives the
 * real routing function (`handleReviewRoutingOutcome`) with the card and chat writers recorded, so a missing card, a
 * card inside Fast Forward, and a second hand-back for the same outcome are all caught by behaviour, not by reading
 * the source.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import * as vscode from "vscode";

import { handleReviewRoutingOutcome } from "../commands/reviewActions";
import { deactivateNotificationRouter, initNotificationRouter } from "../utils/notificationRouter";
import {
  __resetFastForwardRunsForTestV1,
  clearFastForwardRunActiveV1,
  markFastForwardRunActiveV1,
} from "../utils/activeFastForwardRunsV1";
import type { TaskProgress } from "../types/taskProgress";
import { safeRemoveDir } from "./testFsUtils";

/* eslint-disable @typescript-eslint/no-var-requires */
const settingsModule = require("../config/settings") as Record<string, unknown>;
const cardModule = require("../commands/automationStoppedCardV1") as Record<string, unknown>;
const chatModule = require("../utils/chatHistoryStore") as Record<string, unknown>;
/* eslint-enable @typescript-eslint/no-var-requires */

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-review-end-routing-"));
after(() => {
  safeRemoveDir(ROOT);
});

type MemStore = Map<string, string>;

function installMemStore(store: MemStore): () => void {
  const fsObj = vscode.workspace.fs as unknown as Record<string, unknown>;
  const orig = { ...fsObj };
  fsObj.readFile = (uri: vscode.Uri): Promise<Uint8Array> => {
    const content = store.get(uri.toString());
    if (content === undefined) {
      return Promise.reject(Object.assign(new Error(`ENOENT: ${uri.toString()}`), { code: "FileNotFound" }));
    }
    return Promise.resolve(new TextEncoder().encode(content));
  };
  fsObj.writeFile = (uri: vscode.Uri, data: Uint8Array): Promise<void> => {
    store.set(uri.toString(), new TextDecoder().decode(data));
    return Promise.resolve();
  };
  fsObj.createDirectory = (): Promise<void> => Promise.resolve();
  fsObj.readDirectory = (): Promise<Array<[string, number]>> => Promise.resolve([]);
  return () => {
    Object.assign(fsObj, orig);
  };
}

class Surface {
  addEntry(): void {
    /* not under test */
  }
}

interface Recorded {
  readonly stoppedCards: { ending: string; stopReason: string }[];
  readonly readyCards: number;
  readonly chat: string[];
}

const BELOW = [
  "Readiness: 6/10",
  "",
  "<!-- blockers:start -->",
  "- [completion] [task-fixable] Step 12's rewording is not applied",
  "<!-- blockers:end -->",
].join("\n");
const CLEAN = "Readiness: 9/10\n\nNo blockers.\n\n<!-- blockers:start -->\n<!-- blockers:end -->\n";

let counter = 0;

async function routeReview(input: {
  readonly content: string;
  readonly score: number;
  readonly fastForward?: boolean;
  readonly autoAdvance?: boolean;
}): Promise<Recorded> {
  counter += 1;
  const name = `review-end-${counter}`;
  const store: MemStore = new Map();
  const restoreFs = installMemStore(store);
  initNotificationRouter(new Surface());
  const folderUri = vscode.Uri.file(path.join(ROOT, ".ensemble", name));
  const progress: TaskProgress = {
    taskFolder: name,
    currentStage: "impl-high-review",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    reviewAttemptId: `attempt-${name}`,
  };
  store.set(vscode.Uri.joinPath(folderUri, "task-progress.json").toString(), JSON.stringify(progress, null, 2));

  const recorded = { stoppedCards: [] as Recorded["stoppedCards"], readyCards: 0, chat: [] as string[] };
  const saved = {
    stopped: cardModule.postAutomationStoppedCardV1,
    ready: cardModule.postStageReadyCardIfReadyV1,
    chat: chatModule.appendChatMessageV1,
    auto: settingsModule.isAutoAdvanceEnabled,
    threshold: settingsModule.getAutoAdvanceScoreThreshold,
  };
  cardModule.postAutomationStoppedCardV1 = (args: { ending: string; stopReason: string }): Promise<undefined> => {
    recorded.stoppedCards.push({ ending: args.ending, stopReason: args.stopReason });
    return Promise.resolve(undefined);
  };
  cardModule.postStageReadyCardIfReadyV1 = (): Promise<undefined> => {
    recorded.readyCards += 1;
    return Promise.resolve(undefined);
  };
  chatModule.appendChatMessageV1 = (_folder: string, message: { text: string }): Promise<undefined> => {
    recorded.chat.push(message.text);
    return Promise.resolve(undefined);
  };
  settingsModule.isAutoAdvanceEnabled = (): boolean => input.autoAdvance === true;
  settingsModule.getAutoAdvanceScoreThreshold = (): number => 8;
  if (input.fastForward === true) markFastForwardRunActiveV1(folderUri.fsPath);
  try {
    await handleReviewRoutingOutcome({
      folderUri,
      targetStage: "impl-high-review",
      reviewAttemptId: `attempt-${name}`,
      content: input.content,
      score: input.score,
      threshold: 8,
    }).catch(() => undefined);
  } finally {
    if (input.fastForward === true) clearFastForwardRunActiveV1(folderUri.fsPath);
    cardModule.postAutomationStoppedCardV1 = saved.stopped;
    cardModule.postStageReadyCardIfReadyV1 = saved.ready;
    chatModule.appendChatMessageV1 = saved.chat;
    settingsModule.isAutoAdvanceEnabled = saved.auto;
    settingsModule.getAutoAdvanceScoreThreshold = saved.threshold;
    deactivateNotificationRouter();
    restoreFs();
  }
  return recorded;
}

void describe("a review that ends names the next click, however it started (bugs7 item 3)", () => {
  beforeEach(() => __resetFastForwardRunsForTestV1());
  afterEach(() => __resetFastForwardRunsForTestV1());

  void it("outside Fast Forward, a review below the threshold with a task-fixable blocker posts the end card", async () => {
    const result = await routeReview({ content: BELOW, score: 6 });
    assert.equal(result.stoppedCards.length, 1, JSON.stringify(result));
    assert.equal(result.stoppedCards[0]?.ending, "review-ended");
    assert.match(result.stoppedCards[0]?.stopReason ?? "", /6\/10/);
  });

  void it("inside a Fast Forward run, the run owns the next step: no end card from the review", async () => {
    const result = await routeReview({ content: BELOW, score: 6, fastForward: true });
    assert.equal(result.stoppedCards.length, 0, JSON.stringify(result));
  });

  void it("a passing review with automatic advancement on raises the done card once, and no second hand-back", async () => {
    const result = await routeReview({ content: CLEAN, score: 9, autoAdvance: true });
    assert.equal(result.readyCards, 1, JSON.stringify(result));
    assert.equal(result.stoppedCards.length, 0);
  });

  void it("a passing review with automatic advancement off leaves the one next-click offer to the manual-advance hand-back (no second done card)", async () => {
    const result = await routeReview({ content: CLEAN, score: 9, autoAdvance: false });
    assert.equal(result.readyCards, 0, "the routing's own Complete Stage & Move On offer is the one hand-back");
    assert.equal(result.stoppedCards.length, 0);
  });
});
