/**
 * Routing-level coverage for plan item "Add a routing-level test asserting
 * the run log write when malformed lines are present" (fail-closed review
 * parsing, step 3): `handleReviewRoutingOutcome` must write a `review-guard`
 * run log naming every unparseable blocker line verbatim, and warn the user
 * with the parsed/malformed counts, without rejecting the round itself.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import * as vscode from "vscode";
import { dispatchDegenerateReviewBackupAdvanceV1, handleReviewRoutingOutcome } from "../commands/reviewActions";
import { deactivateNotificationRouter, initNotificationRouter } from "../utils/notificationRouter";
import { TaskProgress } from "../types/taskProgress";

class RecordingSurface {
  entries: { message: string; level: "info" | "warning" | "error" }[] = [];
  addEntry(message: string, level: "info" | "warning" | "error"): void {
    this.entries.push({ message, level });
  }
}

type MemStore = Map<string, string>;

function installMemStore(store: MemStore): void {
  const fsObj = vscode.workspace.fs as unknown as Record<string, unknown>;
  fsObj.readFile = (uri: vscode.Uri): Promise<Uint8Array> => {
    const content = store.get(uri.toString());
    if (content === undefined) {
      throw new Error(`ENOENT: ${uri.toString()}`);
    }
    return Promise.resolve(new TextEncoder().encode(content));
  };
  fsObj.writeFile = (uri: vscode.Uri, data: Uint8Array): Promise<void> => {
    store.set(uri.toString(), new TextDecoder().decode(data));
    return Promise.resolve();
  };
  // writeRunLog's ensureRunsDirectory/getNextRunNumber only need these two to
  // not throw — an empty runs/ directory is fine, numbering starts at 1.
  fsObj.createDirectory = (): Promise<void> => Promise.resolve();
  fsObj.readDirectory = (): Promise<Array<[string, number]>> => Promise.resolve([]);
}

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-review-routing-test-"));
after(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

function makeTaskFolderUri(name: string): vscode.Uri {
  return vscode.Uri.file(path.join(TEST_ROOT, ".ensemble", name));
}

function seedProgress(store: MemStore, folderUri: vscode.Uri, progress: TaskProgress): void {
  const uri = vscode.Uri.joinPath(folderUri, "task-progress.json");
  const named: TaskProgress = { ...progress, taskFolder: path.basename(folderUri.fsPath) };
  store.set(uri.toString(), JSON.stringify(named, null, 2));
}

function baseProgress(overrides: Partial<TaskProgress> = {}): TaskProgress {
  return {
    taskFolder: "task_1",
    currentStage: "impl-high-review",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

void describe("handleReviewRoutingOutcome — malformed blocker lines (step 3)", () => {
  void it("writes a review-guard run log naming the malformed line and warns, without rejecting the round", async () => {
    const store = new Map<string, string>();
    installMemStore(store);
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const folderUri = makeTaskFolderUri("malformed-blocker-line");
    seedProgress(store, folderUri, baseProgress({ reviewAttemptId: "attempt-1" }));

    const content = [
      "Readiness: 5/10",
      "",
      "<!-- blockers:start -->",
      "- [completion] [task-fixable] a real, parseable blocker",
      "- this line has no brackets at all and cannot be parsed",
      "<!-- blockers:end -->",
    ].join("\n");

    try {
      const { escalated } = await handleReviewRoutingOutcome({
        folderUri,
        targetStage: "impl-high-review",
        reviewAttemptId: "attempt-1",
        content,
        score: 5,
        threshold: 8,
      });
      // Below threshold with a task-fixable blocker still present -> the
      // route is "iterate", which is not an escalation/rejection: the round
      // is recorded and continues normally.
      assert.strictEqual(escalated, false);

      const runsUri = vscode.Uri.joinPath(folderUri, "runs");
      const logKeys = [...store.keys()].filter(
        (k) => k.startsWith(runsUri.toString()) && k.includes("review-guard")
      );
      assert.strictEqual(logKeys.length, 1, "exactly one review-guard run log must be written");
      const logContent = store.get(logKeys[0]!)!;
      assert.match(logContent, /1 blocker\(s\) parsed/);
      assert.match(logContent, /1 line\(s\) could not be parsed/);
      assert.ok(
        logContent.includes("this line has no brackets at all and cannot be parsed"),
        "the run log must name the malformed line verbatim"
      );

      const warning = surface.entries.find(
        (e) => e.level === "warning" && e.message.includes("could not be read")
      );
      assert.ok(warning, "a notification naming the malformed-line count must be shown");
      assert.ok(warning.message.includes("1 blocker(s)"));
      assert.ok(warning.message.includes("1 blocker line(s)"));
    } finally {
      deactivateNotificationRouter();
    }
  });

  void it("does not write a review-guard run log when the blocker block is well-formed", async () => {
    const store = new Map<string, string>();
    installMemStore(store);
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const folderUri = makeTaskFolderUri("well-formed-blocker-line");
    seedProgress(store, folderUri, baseProgress({ reviewAttemptId: "attempt-2" }));

    const content = [
      "Readiness: 5/10",
      "",
      "<!-- blockers:start -->",
      "- [completion] [task-fixable] a real, parseable blocker",
      "<!-- blockers:end -->",
    ].join("\n");

    try {
      await handleReviewRoutingOutcome({
        folderUri,
        targetStage: "impl-high-review",
        reviewAttemptId: "attempt-2",
        content,
        score: 5,
        threshold: 8,
      });

      const runsUri = vscode.Uri.joinPath(folderUri, "runs");
      const logKeys = [...store.keys()].filter(
        (k) => k.startsWith(runsUri.toString()) && k.includes("review-guard")
      );
      assert.strictEqual(logKeys.length, 0, "no review-guard run log should be written for a clean parse");
    } finally {
      deactivateNotificationRouter();
    }
  });
});

/**
 * wf10 item 4 / Part 4: a review round rejected as degenerate (no parseable
 * `Readiness: N/10` line) reaches completion accounting — it is a failed
 * attempt wearing a review's clothes, not a runner-level failure — and must
 * be recorded in `TaskProgress.roundOutcomes` as `rejected-degenerate`,
 * folded into the SAME patch as the existing `reviewRejections` append.
 */
void describe("handleReviewRoutingOutcome — degenerate rejection records roundOutcomes (wf10 item 4 / Part 4)", () => {
  void it("records a rejected-degenerate round outcome alongside the reviewRejections entry", async () => {
    const store = new Map<string, string>();
    installMemStore(store);
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const folderUri = makeTaskFolderUri("degenerate-review-round");
    seedProgress(store, folderUri, baseProgress({ reviewAttemptId: "attempt-degenerate" }));

    const content = "I read the file but it kept truncating, so here is my current blocker instead.";

    try {
      const { escalated } = await handleReviewRoutingOutcome({
        folderUri,
        targetStage: "impl-high-review",
        reviewAttemptId: "attempt-degenerate",
        content,
        score: null,
        threshold: 8,
      });
      assert.strictEqual(escalated, false);

      // `patchTaskProgressStrictV1` persists via `writeAtomic`, which always
      // hits the REAL filesystem (bypassing the `vscode.workspace.fs` stub
      // above) — see `reviewEscalation.test.ts`'s identically-reasoned
      // `readProgress` helper. Once the write lands, the real file on disk
      // is current state, not the seeded mem-store snapshot.
      const progressUri = vscode.Uri.joinPath(folderUri, "task-progress.json");
      const persisted = fs.existsSync(progressUri.fsPath)
        ? (JSON.parse(fs.readFileSync(progressUri.fsPath, "utf8")) as TaskProgress)
        : (JSON.parse(store.get(progressUri.toString())!) as TaskProgress);
      assert.strictEqual(persisted.reviewRejections?.length, 1, "the degenerate round must still be recorded in reviewRejections");
      assert.strictEqual(persisted.reviewRejections?.[0]?.attemptId, "attempt-degenerate");
      assert.strictEqual(persisted.roundOutcomes?.length, 1, "the degenerate round must also be recorded in roundOutcomes");
      assert.strictEqual(persisted.roundOutcomes?.[0]?.classification, "rejected-degenerate");
      assert.strictEqual(persisted.roundOutcomes?.[0]?.stage, "impl-high-review");
      assert.strictEqual(persisted.roundOutcomes?.[0]?.attemptId, "attempt-degenerate");
      assert.strictEqual(
        persisted.reviewScoreHistory,
        undefined,
        "a degenerate round must never enter reviewScoreHistory (would distort plateau detection)"
      );
    } finally {
      deactivateNotificationRouter();
    }
  });
});

/**
 * wf10 item 7d / Part 5 step 15: a rejected degenerate review is a candidate
 * failure for backup-selection purposes, invisible to switch-to-backup's own
 * runner-level failure handling since the runner itself succeeded. This
 * proves `handleReviewRoutingOutcome`'s new `degenerateBackupAdvance` verdict
 * — the decision `routeReviewOutcomeV1` (reviewActions.ts, not exported)
 * consumes to actually dispatch the next candidate — comes out correctly
 * against a real configured backup chain.
 */
function installModelSettingsV1(raw: Record<string, unknown>): { restore: () => void } {
  const original = (vscode.workspace as unknown as Record<string, unknown>).getConfiguration;
  (vscode.workspace as unknown as Record<string, unknown>).getConfiguration = (): {
    get: (key: string, defaultValue?: unknown) => unknown;
    inspect: () => undefined;
  } => ({
    get: (key: string, defaultValue?: unknown): unknown =>
      key === "modelSettings" ? raw : defaultValue,
    inspect: () => undefined,
  });
  return {
    restore: (): void => {
      (vscode.workspace as unknown as Record<string, unknown>).getConfiguration = original;
    },
  };
}

void describe("handleReviewRoutingOutcome — degenerate rejection decides backup advance (Part 5 step 15)", () => {
  void it("advances automatically to the next configured backup under switch-to-backup", async () => {
    const store = new Map<string, string>();
    installMemStore(store);
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const settings = installModelSettingsV1({
      "impl-high-review": {
        primary: "codex-cli:gpt-5.6",
        backups: ["claude-cli:sonnet"],
        strategy: "switch-to-backup",
      },
    });
    const folderUri = makeTaskFolderUri("degenerate-advances-to-backup");
    seedProgress(store, folderUri, baseProgress({ reviewAttemptId: "attempt-advance" }));

    const content = "I read the file but it kept truncating, so here is my current blocker instead.";

    try {
      const { escalated, degenerateBackupAdvance } = await handleReviewRoutingOutcome({
        folderUri,
        targetStage: "impl-high-review",
        reviewAttemptId: "attempt-advance",
        content,
        score: null,
        threshold: 8,
        reviewer: { providerLabel: "Codex", storedModelId: "codex-cli:gpt-5.6" },
      });
      assert.strictEqual(escalated, false);
      assert.deepStrictEqual(degenerateBackupAdvance, {
        kind: "advance",
        nextModelId: "claude-cli:sonnet",
      });

      const progressUri = vscode.Uri.joinPath(folderUri, "task-progress.json");
      const persisted = JSON.parse(fs.readFileSync(progressUri.fsPath, "utf8")) as TaskProgress;
      assert.strictEqual(persisted.roundOutcomes?.[0]?.modelId, "codex-cli:gpt-5.6");
    } finally {
      settings.restore();
      deactivateNotificationRouter();
    }
  });

  // wf10 review fix (Part 5 step 15, narrowed blocker 2): the prior round's
  // coverage tested the decision (`handleReviewRoutingOutcome`) and the
  // dispatch (`dispatchDegenerateReviewBackupAdvanceV1`) in isolation — one
  // with a hand-constructed `nextModelId`, and a source-text assertion that
  // `routeReviewOutcomeV1`'s "advance" branch calls the dispatch function at
  // all. Neither made a rejected review actually TRAVERSE production routing
  // into a second dispatch. This test chains the two REAL exported
  // production functions together — the exact decision this round computes
  // is the exact value fed into dispatch, nothing hand-built in between —
  // and asserts the automatic second review round is actually invoked.
  // `routeReviewOutcomeV1` itself is only a 4-line forwarding conditional
  // between these two calls (still verified separately, by source text, in
  // degenerateReviewBackupAdvanceV1.test.ts) — everything with actual
  // decision logic or side effects is exercised for real here.
  void it("a rejected review flows through production routing to an automatic second dispatch (causal regression)", async () => {
    const store = new Map<string, string>();
    installMemStore(store);
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const settings = installModelSettingsV1({
      "impl-high-review": {
        primary: "codex-cli:gpt-5.6",
        backups: ["claude-cli:sonnet"],
        strategy: "switch-to-backup",
      },
    });
    const folderUri = makeTaskFolderUri("degenerate-causal-redispatch");
    const workspaceUri = vscode.Uri.file(TEST_ROOT);
    const extensionUri = vscode.Uri.file(path.join(TEST_ROOT, "ext"));
    seedProgress(store, folderUri, baseProgress({ reviewAttemptId: "attempt-causal" }));

    const content = "I read the file but it kept truncating, so here is my current blocker instead.";
    const dispatchCalls: string[] = [];

    try {
      // Step 1: the REAL production decision function computes a real
      // "advance" verdict against a real configured backup chain.
      const { escalated, degenerateBackupAdvance } = await handleReviewRoutingOutcome({
        folderUri,
        targetStage: "impl-high-review",
        reviewAttemptId: "attempt-causal",
        content,
        score: null,
        threshold: 8,
        reviewer: { providerLabel: "Codex", storedModelId: "codex-cli:gpt-5.6" },
      });
      assert.strictEqual(escalated, false);
      assert.deepStrictEqual(degenerateBackupAdvance, { kind: "advance", nextModelId: "claude-cli:sonnet" });
      assert.ok(degenerateBackupAdvance?.kind === "advance");

      // Step 2: the REAL dispatch function, fed the decision's OWN
      // `nextModelId` (never a synthetic one), actually dispatches a fresh
      // review round.
      const fakeWorkspaceFolder = { uri: workspaceUri, name: "ws", index: 0 } as vscode.WorkspaceFolder;
      const result = await dispatchDegenerateReviewBackupAdvanceV1(
        {
          folderUri,
          workspaceUri,
          extensionUri,
          targetStage: "impl-high-review",
          currentStage: "impl-high-review",
          nextModelId: degenerateBackupAdvance.nextModelId,
        },
        {
          recordActiveFallbackModel: (_fUri, stage, modelId) => {
            dispatchCalls.push(`record:${stage}:${modelId}`);
            return Promise.resolve(true);
          },
          getWorkspaceFolder: () => fakeWorkspaceFolder,
          runReviewForFolder: (_extUri, _fUri, _wsFolder, currentStage) => {
            dispatchCalls.push(`run:${currentStage}`);
            return Promise.resolve();
          },
          showWarning: () => {
            dispatchCalls.push("showWarning (must not happen)");
          },
        }
      );

      assert.deepStrictEqual(result, { dispatched: true });
      assert.deepStrictEqual(dispatchCalls, ["record:impl-high-review:claude-cli:sonnet", "run:impl-high-review"]);
    } finally {
      settings.restore();
      deactivateNotificationRouter();
    }
  });

  void it("reports the chain exhausted once the only configured backup has also failed this episode", async () => {
    const store = new Map<string, string>();
    installMemStore(store);
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const settings = installModelSettingsV1({
      "impl-high-review": {
        primary: "codex-cli:gpt-5.6",
        backups: ["claude-cli:sonnet"],
        strategy: "switch-to-backup",
      },
    });
    const folderUri = makeTaskFolderUri("degenerate-chain-exhausted");
    // The primary already failed degenerate this same episode — the only
    // configured backup (claude-cli:sonnet) is now itself the one failing.
    seedProgress(
      store,
      folderUri,
      baseProgress({
        reviewAttemptId: "attempt-exhausted",
        roundOutcomes: [
          {
            stage: "impl-high-review",
            classification: "rejected-degenerate",
            attemptId: "attempt-prior",
            at: "2026-01-01T00:00:00.000Z",
            modelId: "codex-cli:gpt-5.6",
          },
        ],
      })
    );

    const content = "I read the file but it kept truncating, so here is my current blocker instead.";

    try {
      const { escalated, degenerateBackupAdvance } = await handleReviewRoutingOutcome({
        folderUri,
        targetStage: "impl-high-review",
        reviewAttemptId: "attempt-exhausted",
        content,
        score: null,
        threshold: 8,
        reviewer: { providerLabel: "Claude", storedModelId: "claude-cli:sonnet" },
      });
      assert.strictEqual(escalated, false);
      assert.deepStrictEqual(degenerateBackupAdvance, { kind: "exhausted" });
    } finally {
      settings.restore();
      deactivateNotificationRouter();
    }
  });

  void it("offers a manual retry (does not automatically advance) under pause-and-resume", async () => {
    const store = new Map<string, string>();
    installMemStore(store);
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const settings = installModelSettingsV1({
      "impl-high-review": {
        primary: "codex-cli:gpt-5.6",
        backups: ["claude-cli:sonnet"],
        strategy: "pause-and-resume",
      },
    });
    const folderUri = makeTaskFolderUri("degenerate-manual-retry");
    seedProgress(store, folderUri, baseProgress({ reviewAttemptId: "attempt-manual" }));

    const content = "I read the file but it kept truncating, so here is my current blocker instead.";

    try {
      const { degenerateBackupAdvance } = await handleReviewRoutingOutcome({
        folderUri,
        targetStage: "impl-high-review",
        reviewAttemptId: "attempt-manual",
        content,
        score: null,
        threshold: 8,
        reviewer: { providerLabel: "Codex", storedModelId: "codex-cli:gpt-5.6" },
      });
      assert.deepStrictEqual(degenerateBackupAdvance, {
        kind: "manual",
        nextModelId: "claude-cli:sonnet",
      });
      const retryWarning = surface.entries.find(
        (e) => e.level === "warning" && e.message.includes("has not been tried this episode")
      );
      assert.ok(retryWarning, "the manual-retry affordance must be surfaced to the user");
    } finally {
      settings.restore();
      deactivateNotificationRouter();
    }
  });
});
