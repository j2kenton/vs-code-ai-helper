/**
 * v1 fixes 2, item 21 (2026-09-17 instance) / Part 1 step 6: a review that ran
 * with no tracked implementation file set (context pack fell back to the open
 * editors) states what it covered and never auto-advances the stage.
 *
 * The fact travels from dispatch — the context-pack writer's own `isFallback`
 * — to routing through the prompt `variables`, so the first block pins the
 * pure predicate and the second drives `handleReviewOutcomeV1` end to end:
 * a threshold-clearing review over the fallback scope stays on its stage, the
 * artifact is durably qualified, and the same review WITHOUT the fallback
 * fact does advance (proving the harness reaches the advance path at all).
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import * as vscode from "vscode";

import {
  handleReviewOutcomeV1,
  handleReviewRoutingOutcome,
  qualifyOpenEditorScopeInReviewV1,
  qualifyOpenEditorScopeWithDispositionV1,
  reviewCoveredOpenEditorsOnlyV1,
  reviewRanWithoutTrackedFileSetV1,
  reviewScopeFromInputSnapshotV1,
  settleUnqualifiableScopeReviewV1,
} from "../commands/reviewActions";
import type { TaskActionOutcomeV1 } from "../types/taskActionOutcomeV1";
import { latestQualifyingReviewMeetsThresholdV1 } from "../utils/reviewRouting";
import { deactivateNotificationRouter, initNotificationRouter } from "../utils/notificationRouter";
import { ReviewScoreHistoryEntry, TaskProgress } from "../types/taskProgress";
import { safeRemoveDir } from "./testFsUtils";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const settingsModule = require("../config/settings") as Record<string, unknown>;

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-no-tracked-set-test-"));
after(() => {
  safeRemoveDir(ROOT);
});

void describe("reviewRanWithoutTrackedFileSetV1", () => {
  void it("is true for an implementation review carrying the open-editor fallback fact", () => {
    const variables = { reviewScopeFallback: "open-editors" };
    assert.equal(reviewRanWithoutTrackedFileSetV1(variables, "impl-high-review"), true);
    assert.equal(reviewRanWithoutTrackedFileSetV1(variables, "impl-low-review"), true);
  });

  void it("is false when the dispatch found a tracked file set (no fallback fact) — including an empty tracked list", () => {
    assert.equal(reviewRanWithoutTrackedFileSetV1({}, "impl-high-review"), false);
  });

  void it("is false for plan reviews, which never read a tracked file set", () => {
    const variables = { reviewScopeFallback: "open-editors" };
    assert.equal(reviewRanWithoutTrackedFileSetV1(variables, "plan-high-review"), false);
    assert.equal(reviewRanWithoutTrackedFileSetV1(variables, "plan-low-review"), false);
  });
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

interface RoutedResult {
  entries: RecordingSurface["entries"];
  reviewContent: string;
}

async function routeCompletedReview(name: string, variables: Record<string, string>): Promise<RoutedResult> {
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
    reviewAttemptId: "attempt-no-tracked",
  };
  store.set(vscode.Uri.joinPath(folderUri, "task-progress.json").toString(), JSON.stringify(progress, null, 2));
  store.set(reviewUri.toString(), PASSING_REVIEW);

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
        reviewAttemptId: "attempt-no-tracked",
        modelId: "codex-cli:gpt-5.6",
        providerId: "codex-cli",
      });
    } catch {
      // The advance path beyond the "Auto-advancing" notice needs more of the
      // production harness than this test wires; what it announced before
      // that point is the observable under test.
    }
    return { entries: surface.entries, reviewContent: store.get(reviewUri.toString()) ?? "" };
  } finally {
    for (const [key, value] of originals) {
      settingsModule[key] = value;
    }
    deactivateNotificationRouter();
    bridge.restore();
  }
}

void describe("handleReviewOutcomeV1 — a review over the open-editor fallback never auto-advances", () => {
  void it("a 10/10 review carrying the fallback fact stays on its stage, says what it covered, and qualifies the artifact", async () => {
    const { entries, reviewContent } = await routeCompletedReview("fallback-scope", {
      reviewScopeFallback: "open-editors",
    });
    assert.ok(
      entries.some((e) => e.level === "warning" && e.message.includes("no tracked implementation file set")),
      "the routing must tell the user the review covered only the open editors"
    );
    assert.ok(
      !entries.some((e) => e.message.includes("Auto-advancing stage")),
      "a fallback-scope verdict must never reach the auto-advance path"
    );
    assert.match(reviewContent, /<!--\s*review-scope:\s*open-editors\s*-->/);
    assert.match(reviewContent, /covered only the files open in the editor/);
    assert.match(reviewContent, /Readiness: 10\/10/, "the original verdict text is preserved, only qualified");
  });

  void it("the same review WITHOUT the fallback fact reaches the auto-advance path (control)", async () => {
    const { entries, reviewContent } = await routeCompletedReview("tracked-scope", {});
    assert.ok(
      entries.some((e) => e.message.includes("Auto-advancing stage")),
      "a tracked-scope threshold-clearing review must still auto-advance"
    );
    assert.doesNotMatch(reviewContent, /review-scope/);
  });
});

void describe("qualifyOpenEditorScopeInReviewV1", () => {
  void it("is idempotent — an already-qualified artifact is returned unchanged and not rewritten", async () => {
    const store: MemStore = new Map();
    const bridge = installMemStore(store);
    try {
      const uri = vscode.Uri.file(path.join(ROOT, "qualify", "impl-high-review.md"));
      const once = await qualifyOpenEditorScopeInReviewV1(uri, PASSING_REVIEW);
      const twice = await qualifyOpenEditorScopeInReviewV1(uri, once);
      assert.equal(twice, once);
      assert.equal(once.match(/review-scope/g)?.length, 1);
    } finally {
      bridge.restore();
    }
  });

  void it("retries a transient write failure so the persisted verdict is qualified and no warning is raised", async () => {
    const store: MemStore = new Map();
    const bridge = installMemStore(store);
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const fsObj = vscode.workspace.fs as unknown as Record<string, unknown>;
    const realWrite = fsObj.writeFile as (uri: vscode.Uri, bytes: Uint8Array) => Promise<void>;
    let calls = 0;
    fsObj.writeFile = (uri: vscode.Uri, bytes: Uint8Array): Promise<void> => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error("EBUSY: locked")) : realWrite(uri, bytes);
    };
    try {
      const uri = vscode.Uri.file(path.join(ROOT, "qualify-transient", "impl-high-review.md"));
      await qualifyOpenEditorScopeInReviewV1(uri, PASSING_REVIEW);
      assert.equal(calls, 2, "the second attempt succeeds");
      const persisted = [...store.values()].join("\n");
      assert.match(persisted, /<!--\s*review-scope:\s*open-editors\s*-->/);
      assert.equal(surface.entries.some((e) => e.level === "warning"), false);
    } finally {
      deactivateNotificationRouter();
      bridge.restore();
    }
  });

  void it("on a write failure still returns the qualified text and tells the user the scope note was not saved", async () => {
    const store: MemStore = new Map();
    const bridge = installMemStore(store);
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const fsObj = vscode.workspace.fs as unknown as Record<string, unknown>;
    fsObj.writeFile = (): Promise<void> => Promise.reject(new Error("EACCES: read-only"));
    try {
      const uri = vscode.Uri.file(path.join(ROOT, "qualify-fail", "impl-high-review.md"));
      const result = await qualifyOpenEditorScopeInReviewV1(uri, PASSING_REVIEW);
      assert.match(result, /<!--\s*review-scope:\s*open-editors\s*-->/);
      assert.ok(
        surface.entries.some((e) => e.level === "warning" && e.message.includes("could not be saved")),
        "a failed scope-marker write must be surfaced, not swallowed"
      );
    } finally {
      deactivateNotificationRouter();
      bridge.restore();
    }
  });
});

void describe("settleUnqualifiableScopeReviewV1 — a persistently unqualifiable verdict is never left readable", () => {
  void it("writes the qualified verdict through the node filesystem when only the workspace-fs write fails", async () => {
    const dir = fs.mkdtempSync(path.join(ROOT, "settle-write-"));
    const file = path.join(dir, "impl-high-review.md");
    fs.writeFileSync(file, PASSING_REVIEW);
    const disposition = await settleUnqualifiableScopeReviewV1(vscode.Uri.file(file), "qualified text <!-- review-scope: open-editors -->");
    assert.equal(disposition, "qualified");
    assert.match(fs.readFileSync(file, "utf8"), /review-scope: open-editors/);
  });

  void it("moves the unqualified artifact aside when it cannot be rewritten", async () => {
    // A directory at the artifact path cannot be written as a file but can be
    // renamed — stands in for a file the node fs cannot overwrite.
    const dir = fs.mkdtempSync(path.join(ROOT, "settle-aside-"));
    const file = path.join(dir, "impl-high-review.md");
    fs.mkdirSync(file);
    const disposition = await settleUnqualifiableScopeReviewV1(vscode.Uri.file(file), "x");
    assert.equal(disposition, "moved-aside");
    assert.equal(fs.existsSync(file), false, "the stage artifact no longer exists to be misread");
    assert.equal(fs.existsSync(`${file}.open-editors-unqualified`), true);
  });

  void it("reports unqualified when the artifact can be neither rewritten nor taken away", async () => {
    const dir = fs.mkdtempSync(path.join(ROOT, "settle-none-"));
    const file = path.join(dir, "missing", "impl-high-review.md");
    assert.equal(await settleUnqualifiableScopeReviewV1(vscode.Uri.file(file), "x"), "unqualified");
  });

  void it("qualify falls back to the node filesystem after the workspace-fs write fails persistently, with no warning", async () => {
    const store: MemStore = new Map();
    const bridge = installMemStore(store);
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const fsObj = vscode.workspace.fs as unknown as Record<string, unknown>;
    fsObj.writeFile = (): Promise<void> => Promise.reject(new Error("EACCES: workspace fs down"));
    const dir = fs.mkdtempSync(path.join(ROOT, "settle-qualify-"));
    const file = path.join(dir, "impl-high-review.md");
    fs.writeFileSync(file, PASSING_REVIEW);
    try {
      await qualifyOpenEditorScopeInReviewV1(vscode.Uri.file(file), PASSING_REVIEW);
      assert.match(fs.readFileSync(file, "utf8"), /<!--\s*review-scope:\s*open-editors\s*-->/);
      assert.equal(surface.entries.some((e) => e.level === "warning"), false);
    } finally {
      deactivateNotificationRouter();
      bridge.restore();
    }
  });
});

void describe("qualifyOpenEditorScopeWithDispositionV1 — the caller learns whether the artifact is safe to show", () => {
  void it("reports qualified when the scope note was written", async () => {
    const store: MemStore = new Map();
    const bridge = installMemStore(store);
    try {
      const uri = vscode.Uri.file(path.join(ROOT, "disposition-ok", "impl-high-review.md"));
      const result = await qualifyOpenEditorScopeWithDispositionV1(uri, PASSING_REVIEW);
      assert.equal(result.disposition, "qualified");
      assert.match(result.content, /review-scope: open-editors/);
    } finally {
      bridge.restore();
    }
  });

  void it("reports moved-aside when the artifact cannot be rewritten, so it must not be opened", async () => {
    const store: MemStore = new Map();
    const bridge = installMemStore(store);
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const fsObj = vscode.workspace.fs as unknown as Record<string, unknown>;
    fsObj.writeFile = (): Promise<void> => Promise.reject(new Error("EACCES: read-only"));
    const dir = fs.mkdtempSync(path.join(ROOT, "disposition-aside-"));
    const file = path.join(dir, "impl-high-review.md");
    fs.mkdirSync(file); // cannot be written as a file, can be renamed
    try {
      const result = await qualifyOpenEditorScopeWithDispositionV1(vscode.Uri.file(file), PASSING_REVIEW);
      assert.equal(result.disposition, "moved-aside");
      assert.equal(fs.existsSync(file), false);
    } finally {
      deactivateNotificationRouter();
      bridge.restore();
    }
  });
});

void describe("reviewScopeFromInputSnapshotV1 — a resumed review uses the scope of the prompt that ran", () => {
  void it("reads open-editors from a snapshot whose prompt carries the fallback context pack", () => {
    const canonicalJson = JSON.stringify({
      prompt: "# Review\n\n## Open Editors (Fallback)\n\n- src/a.ts\n",
    });
    assert.equal(reviewScopeFromInputSnapshotV1(canonicalJson), "open-editors");
  });

  void it("reads tracked from a snapshot whose prompt has no fallback heading", () => {
    const canonicalJson = JSON.stringify({ prompt: "# Review\n\n## Changed Files\n\n- src/a.ts\n" });
    assert.equal(reviewScopeFromInputSnapshotV1(canonicalJson), "tracked");
  });

  void it("is undefined when the snapshot is unreadable or has no prompt", () => {
    assert.equal(reviewScopeFromInputSnapshotV1("not json"), undefined);
    assert.equal(reviewScopeFromInputSnapshotV1(JSON.stringify({ other: 1 })), undefined);
  });
});

void describe("handleReviewRoutingOutcome — the fallback scope is recorded durably in score history", () => {
  async function routeAndReadHistory(name: string, reviewScope?: "open-editors"): Promise<TaskProgress["reviewScoreHistory"]> {
    const store: MemStore = new Map();
    const bridge = installMemStore(store);
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const folderUri = vscode.Uri.file(path.join(ROOT, ".ensemble", name));
    const progress: TaskProgress = {
      taskFolder: name,
      currentStage: "impl-high-review",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      reviewAttemptId: "attempt-scope",
    };
    const progressUri = vscode.Uri.joinPath(folderUri, "task-progress.json");
    store.set(progressUri.toString(), JSON.stringify(progress, null, 2));
    try {
      await handleReviewRoutingOutcome({
        folderUri,
        targetStage: "impl-high-review",
        reviewAttemptId: "attempt-scope",
        content: [
          "Readiness: 6/10",
          "",
          "<!-- blockers:start -->",
          "- [completion] [task-fixable] a real, parseable blocker",
          "<!-- blockers:end -->",
        ].join("\n"),
        score: 6,
        threshold: 8,
        ...(reviewScope ? { reviewScope } : {}),
      });
      // Progress writes are atomic and hit the real filesystem, bypassing the
      // vscode.workspace.fs stub, so read the real file first.
      const raw = fs.existsSync(progressUri.fsPath)
        ? fs.readFileSync(progressUri.fsPath, "utf8")
        : (store.get(progressUri.toString()) ?? "{}");
      const history = (JSON.parse(raw) as TaskProgress).reviewScoreHistory;
      assert.ok(history, `routing recorded no history; notifications: ${JSON.stringify(surface.entries)}`);
      return history;
    } finally {
      deactivateNotificationRouter();
      bridge.restore();
    }
  }

  void it("stamps scope: open-editors on the history entry, independent of the artifact write", async () => {
    const history = await routeAndReadHistory("history-fallback", "open-editors");
    assert.equal(history?.length, 1);
    assert.equal(history?.[0]?.scope, "open-editors");
  });

  void it("readers treat a history-recorded fallback scope as open-editors-only even when the artifact is unqualified", () => {
    assert.equal(reviewCoveredOpenEditorsOnlyV1("Readiness: 10/10\n", { scope: "open-editors" }), true);
    assert.equal(reviewCoveredOpenEditorsOnlyV1("Readiness: 10/10\n", {}), false);
    assert.equal(reviewCoveredOpenEditorsOnlyV1("Readiness: 10/10\n<!-- review-scope: open-editors -->", undefined), true);
    const entry = (scope?: "open-editors"): ReviewScoreHistoryEntry => ({
      stage: "impl-high-review",
      score: 10,
      attemptId: "a",
      at: "2026-01-01T00:00:00.000Z",
      blockerCount: 0,
      taskFixableCount: 0,
      ...(scope ? { scope } : {}),
    });
    const clears = (scope?: "open-editors"): boolean =>
      latestQualifyingReviewMeetsThresholdV1({ history: [entry(scope)], stage: "impl-high-review", threshold: 8 });
    assert.equal(clears(), true);
    assert.equal(clears("open-editors"), false, "a fallback-scope verdict never counts as 'the work is done'");
  });

  void it("leaves an ordinary tracked-scope entry without a scope", async () => {
    const history = await routeAndReadHistory("history-tracked");
    assert.equal(history?.length, 1);
    assert.equal(history?.[0]?.scope, undefined);
  });
});
