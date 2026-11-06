/**
 * bugs5 Step 27 (item 15): a threshold-clearing review whose scope is known to miss changed files is qualified in
 * its verdict and does not auto-advance the stage, unless the owner accepted exactly that gap.
 *
 * Drives `handleReviewOutcomeV1` end to end, like `reviewNoTrackedFileSetV1.test.ts`, with the partial-scope facts
 * carried in the prompt `variables` the way dispatch carries them.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import * as vscode from "vscode";

import { handleReviewOutcomeV1 } from "../commands/reviewActions";
import type { TaskActionOutcomeV1 } from "../types/taskActionOutcomeV1";
import { deactivateNotificationRouter, initNotificationRouter } from "../utils/notificationRouter";
import {
  hashMissingFilesV1,
  partialScopeVariablesV1,
  PARTIAL_SCOPE_ACCEPTANCE_FILE_V1,
} from "../utils/reviewPartialScopeV1";
import type { TaskProgress } from "../types/taskProgress";
import { safeRemoveDir } from "./testFsUtils";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const settingsModule = require("../config/settings") as Record<string, unknown>;

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-partial-scope-route-test-"));
after(() => {
  safeRemoveDir(ROOT);
});

type MemStore = Map<string, string>;

function installMemStore(store: MemStore): { restore: () => void } {
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
  return {
    restore: (): void => {
      Object.assign(fsObj, orig);
    },
  };
}

class RecordingSurface {
  entries: { message: string; level: "info" | "warning" | "error" }[] = [];
  addEntry(message: string, level: "info" | "warning" | "error"): void {
    this.entries.push({ message, level });
  }
}

const PASSING_REVIEW = "# Implementation Review\n\nReadiness: 10/10\n\nEverything checks out. No blockers.\n";
const MISSING = ["src/a.ts", "src/b.ts", "src/c.ts"];
const SUMMARY = "Reviewed 40 of 43 changed files (25 of 28 production files)";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const partialScopeCardModule = require("../commands/partialScopeDecisionV1") as Record<string, unknown>;

async function routeCompletedReview(
  name: string,
  variables: Record<string, string>,
  acceptance?: { stage: string; hash: string },
  reviewText: string = PASSING_REVIEW
): Promise<{ entries: RecordingSurface["entries"]; reviewContent: string; cards: Array<Record<string, unknown>> }> {
  const cards: Array<Record<string, unknown>> = [];
  const originalPostCard = partialScopeCardModule.postPartialScopeDecisionV1;
  partialScopeCardModule.postPartialScopeDecisionV1 = (options: Record<string, unknown>): Promise<undefined> => {
    cards.push(options);
    return Promise.resolve(undefined);
  };
  const store: MemStore = new Map();
  const bridge = installMemStore(store);
  const surface = new RecordingSurface();
  initNotificationRouter(surface);
  const folderUri = vscode.Uri.file(path.join(ROOT, ".ensemble", name));
  const reviewUri = vscode.Uri.joinPath(folderUri, "impl-high-review.md");
  const progress: TaskProgress = {
    taskFolder: name,
    currentStage: "impl-high-review",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    reviewAttemptId: "attempt-partial-scope",
  };
  store.set(vscode.Uri.joinPath(folderUri, "task-progress.json").toString(), JSON.stringify(progress, null, 2));
  store.set(reviewUri.toString(), reviewText);
  if (acceptance) {
    store.set(
      vscode.Uri.joinPath(folderUri, PARTIAL_SCOPE_ACCEPTANCE_FILE_V1).toString(),
      JSON.stringify({
        stage: acceptance.stage,
        hash: acceptance.hash,
        missingCount: MISSING.length,
        acceptedAt: "2026-11-02T10:00:00.000Z",
      })
    );
  }

  const originals = ["isAutoAdvanceEnabled", "getAutoAdvanceScoreThreshold"].map(
    (key) => [key, settingsModule[key]] as const
  );
  settingsModule.isAutoAdvanceEnabled = (): boolean => true;
  settingsModule.getAutoAdvanceScoreThreshold = (): number => 8;
  try {
    const outcome: TaskActionOutcomeV1 = {
      kind: "completed",
      code: "completed",
      correlation: {
        actionKey: "review.v1",
        operationId: "0".repeat(32),
        attemptId: "1".repeat(32),
        taskBindingId: "2".repeat(32),
        chatDocumentId: "3".repeat(32),
      },
      provider: { providerLabel: "Codex", storedModelId: "codex-cli:gpt-5.6" },
    };
    try {
      await handleReviewOutcomeV1(outcome, {
        extensionUri: vscode.Uri.file(ROOT),
        folderUri,
        workspaceUri: vscode.Uri.file(ROOT),
        currentStage: "impl-high-review",
        targetStage: "impl-high-review",
        reviewUri,
        variables,
        reviewAttemptId: "attempt-partial-scope",
        modelId: "codex-cli:gpt-5.6",
        providerId: "codex-cli",
      });
    } catch {
      // The advance path beyond the "Auto-advancing" notice needs more of the production harness than this test
      // wires; what it announced before that point is the observable under test.
    }
    return { entries: surface.entries, reviewContent: store.get(reviewUri.toString()) ?? "", cards };
  } finally {
    partialScopeCardModule.postPartialScopeDecisionV1 = originalPostCard;
    for (const [key, value] of originals) {
      settingsModule[key] = value;
    }
    deactivateNotificationRouter();
    bridge.restore();
  }
}

void describe("handleReviewOutcomeV1 — a review over a partial scope does not clear the stage (bugs5 Step 27)", () => {
  void it("a 10/10 review that missed 3 changed files is qualified in its verdict and never reaches auto-advance", async () => {
    const { entries, reviewContent } = await routeCompletedReview(
      "partial-held",
      partialScopeVariablesV1(MISSING, SUMMARY)
    );
    assert.ok(
      !entries.some((e) => e.message.includes("Auto-advancing stage")),
      "a partial-scope verdict must not reach the auto-advance path"
    );
    assert.match(reviewContent, /<!--\s*review-scope:\s*partial\s*-->/);
    assert.match(reviewContent, /Reviewed 40 of 43 changed files/);
    assert.match(reviewContent, /does not clear the stage/);
    assert.match(reviewContent, /Readiness: 10\/10/, "the original verdict text is preserved, only qualified");
  });

  void it("the same review with the owner's acceptance of exactly this gap advances (control)", async () => {
    const { entries, reviewContent } = await routeCompletedReview(
      "partial-accepted",
      partialScopeVariablesV1(MISSING, SUMMARY),
      { stage: "impl-high-review", hash: hashMissingFilesV1(MISSING) }
    );
    assert.ok(
      entries.some((e) => e.message.includes("Auto-advancing stage")),
      "an accepted gap lets the threshold-clearing score advance"
    );
    assert.match(reviewContent, /The owner accepted this partial scope/);
  });

  void it("an acceptance of a different gap does not release the hold", async () => {
    const { entries } = await routeCompletedReview("partial-other-gap", partialScopeVariablesV1(MISSING, SUMMARY), {
      stage: "impl-high-review",
      hash: hashMissingFilesV1(["src/other.ts"]),
    });
    assert.ok(!entries.some((e) => e.message.includes("Auto-advancing stage")));
  });

  void it("a 7/10 review over a partial scope still raises the partial-scope card (review1 Step 59)", async () => {
    const { cards, reviewContent } = await routeCompletedReview(
      "partial-low-score",
      partialScopeVariablesV1(MISSING, SUMMARY),
      undefined,
      "# Implementation Review\n\nReadiness: 7/10\n\nThree things still to fix.\n"
    );
    assert.equal(cards.length, 1, "a score under the threshold still gets the way out");
    assert.equal(cards[0]?.scoreClears, false);
    assert.equal(cards[0]?.stage, "impl-high-review");
    assert.deepEqual((cards[0]?.scope as { files: string[] }).files, MISSING);
    assert.match(reviewContent, /review-scope:\s*partial/);
  });

  void it("a threshold-clearing review over a partial scope raises the card too, flagged as clearing", async () => {
    const { cards } = await routeCompletedReview("partial-clearing", partialScopeVariablesV1(MISSING, SUMMARY));
    assert.equal(cards.length, 1);
    assert.equal(cards[0]?.scoreClears, true);
  });

  void it("an accepted gap raises no card", async () => {
    const { cards } = await routeCompletedReview(
      "partial-accepted-no-card",
      partialScopeVariablesV1(MISSING, SUMMARY),
      { stage: "impl-high-review", hash: hashMissingFilesV1(MISSING) },
      "# Implementation Review\n\nReadiness: 7/10\n\nThree things still to fix.\n"
    );
    assert.equal(cards.length, 0);
  });

  void it("a scope that matches the change set adds nothing to the review and advances (control)", async () => {
    const { entries, reviewContent } = await routeCompletedReview("scope-complete", {});
    assert.ok(entries.some((e) => e.message.includes("Auto-advancing stage")));
    assert.doesNotMatch(reviewContent, /review-scope/);
  });
});
