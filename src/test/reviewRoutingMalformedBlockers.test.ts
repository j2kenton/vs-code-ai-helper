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
import { decodeTaskProgressTextV1 } from "../services/taskProgressDecoderV1";
import { TaskProgress } from "../types/taskProgress";
import { safeRemoveDir } from "./testFsUtils";

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
  safeRemoveDir(TEST_ROOT);
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
    // Seed the round-ledger row `claimReviewAttempt` would have opened before
    // dispatching this review round in production — `terminalizeRoundV1`
    // (called below via `handleReviewRoutingOutcome`'s degenerate-rejection
    // branch) is the sole writer of `roundOutcomes`/`reviewRejections` for
    // this path now, and only writes when it can resolve a matching row.
    seedProgress(
      store,
      folderUri,
      baseProgress({
        reviewAttemptId: "attempt-degenerate",
        roundLedger: [
          {
            roundId: "attempt-degenerate",
            attemptIds: ["attempt-degenerate"],
            stage: "impl-high-review",
            mode: "review",
            startedAt: "2026-01-01T00:00:00.000Z",
            state: "open",
          },
        ],
      })
    );

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
    seedProgress(
      store,
      folderUri,
      baseProgress({
        reviewAttemptId: "attempt-advance",
        roundLedger: [
          {
            roundId: "attempt-advance",
            attemptIds: ["attempt-advance"],
            stage: "impl-high-review",
            mode: "review",
            startedAt: "2026-01-01T00:00:00.000Z",
            state: "open",
          },
        ],
      })
    );

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
    seedProgress(
      store,
      folderUri,
      baseProgress({
        reviewAttemptId: "attempt-causal",
        roundLedger: [
          {
            roundId: "attempt-causal",
            attemptIds: ["attempt-causal"],
            stage: "impl-high-review",
            mode: "review",
            startedAt: "2026-01-01T00:00:00.000Z",
            state: "open",
          },
        ],
      })
    );

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
    // Also seed the round-ledger row `claimReviewAttempt` would have opened
    // for THIS round's attempt, since `terminalizeRoundV1` only records the
    // `roundOutcomes` classification for a resolvable row (see the sibling
    // test above).
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
        roundLedger: [
          {
            roundId: "attempt-exhausted",
            attemptIds: ["attempt-exhausted"],
            stage: "impl-high-review",
            mode: "review",
            startedAt: "2026-01-01T00:00:00.000Z",
            state: "open",
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

  void it("does not automatically advance under never-switch (migrated from pause-and-resume)", async () => {
    const store = new Map<string, string>();
    installMemStore(store);
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    // Part 13/14's fallback-strategy collapse (`FallbackStrategy = "switch-to-backup" | "never-switch"`)
    // migrates the legacy `"pause-and-resume"` value to `"never-switch"` on
    // read (`getModelSettings`), which `resolveEffectiveStageChainV1` (used
    // by `handleReviewRoutingOutcome`) then resolves through. Kept as
    // `"pause-and-resume"` here deliberately, so this test also exercises
    // that migration rather than only the post-migration value.
    const settings = installModelSettingsV1({
      "impl-high-review": {
        primary: "codex-cli:gpt-5.6",
        backups: ["claude-cli:sonnet"],
        strategy: "pause-and-resume",
      },
    });
    const folderUri = makeTaskFolderUri("degenerate-manual-retry");
    seedProgress(
      store,
      folderUri,
      baseProgress({
        reviewAttemptId: "attempt-manual",
        roundLedger: [
          {
            roundId: "attempt-manual",
            attemptIds: ["attempt-manual"],
            stage: "impl-high-review",
            mode: "review",
            startedAt: "2026-01-01T00:00:00.000Z",
            state: "open",
          },
        ],
      })
    );

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
        kind: "stop",
        nextModelId: "claude-cli:sonnet",
      });
      const retryWarning = surface.entries.find(
        (e) => e.level === "warning" && e.message.includes("set to Never switch")
      );
      assert.ok(retryWarning, "the withheld-switch reason must be surfaced to the user");
    } finally {
      settings.restore();
      deactivateNotificationRouter();
    }
  });
});

/**
 * RC2 item 4: "needs a passing test run" can never be satisfied at an
 * implementation review — those reviews only ever see fast checks (lint,
 * type-check), never the test suite. A blocker whose entire ask is a
 * passing test run must never count toward `taskFixableCount`/`blockers`,
 * or it becomes a permanent blocker no implementation round can ever clear.
 *
 * `patchTaskProgressStrictV1` writes through real `fs` (`writeAtomic`,
 * `withTaskLock`'s on-disk lease files) even though it READS through
 * `vscode.workspace.fs` — the in-memory `installMemStore` used by the rest
 * of this file only satisfies the read half, so a round-trip check of
 * `reviewScoreHistory` needs the real-disk bridge this block installs
 * instead (mirrored from `roundLedgerV1.test.ts`'s `installFsBridge`).
 */
void describe("handleReviewRoutingOutcome — stage-unsatisfiable 'needs a passing test run' blocker (RC2 item 4)", () => {
  function installFsBridge(): { restore: () => void } {
    const target = vscode.workspace.fs as unknown as Record<string, unknown>;
    const orig = { ...target };
    target.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
      fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
    target.writeFile = async (uri: vscode.Uri, content: Uint8Array): Promise<void> => {
      await fs.promises.mkdir(path.dirname(uri.fsPath), { recursive: true });
      await fs.promises.writeFile(uri.fsPath, content);
    };
    target.rename = async (source: vscode.Uri, dest: vscode.Uri): Promise<void> => {
      await fs.promises.rm(dest.fsPath, { force: true });
      await fs.promises.rename(source.fsPath, dest.fsPath);
    };
    target.delete = (uri: vscode.Uri): Promise<void> =>
      fs.promises.rm(uri.fsPath, { force: true, recursive: true });
    target.createDirectory = (uri: vscode.Uri): Promise<void> =>
      fs.promises.mkdir(uri.fsPath, { recursive: true }).then(() => undefined);
    target.readDirectory = async (uri: vscode.Uri): Promise<Array<[string, number]>> => {
      const entries = await fs.promises.readdir(uri.fsPath, { withFileTypes: true });
      return entries.map((entry) => [entry.name, entry.isDirectory() ? 2 : 1]);
    };
    target.stat = async (uri: vscode.Uri): Promise<{ type: number; size: number; ctime: number; mtime: number }> => {
      const stat = await fs.promises.stat(uri.fsPath);
      return { type: stat.isDirectory() ? 2 : 1, size: stat.size, ctime: stat.ctimeMs, mtime: stat.mtimeMs };
    };
    return {
      restore: (): void => {
        for (const key of ["readFile", "writeFile", "rename", "delete", "createDirectory", "readDirectory", "stat"]) {
          target[key] = orig[key];
        }
      },
    };
  }

  function makeRealTaskFolder(name: string, overrides: Partial<TaskProgress> = {}): { folderPath: string; folderUri: vscode.Uri } {
    const folderPath = path.join(TEST_ROOT, "real-plans", name);
    fs.mkdirSync(folderPath, { recursive: true });
    const progress: TaskProgress & { ensembleProgressVersion: 1 } = {
      ensembleProgressVersion: 1,
      taskFolder: name,
      currentStage: "impl-high-review",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      ...overrides,
    };
    fs.writeFileSync(path.join(folderPath, "task-progress.json"), JSON.stringify(progress, null, 2), "utf8");
    return { folderPath, folderUri: vscode.Uri.file(folderPath) };
  }

  function readProgress(folderPath: string): TaskProgress {
    return JSON.parse(fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")) as TaskProgress;
  }

  /**
   * `readProgress` above parses with plain `JSON.parse`, which would never
   * notice the strict decoder rejecting an unknown property (the review
   * blocker found on this round's first pass: `stageUnsatisfiableBlockers`
   * was written but absent from the decoder's allowed-key set, so the
   * written file round-tripped through `JSON.parse` fine while
   * `decodeTaskProgressTextV1` — the real reader every stage-transition and
   * work-admission path uses — would reject it). Round-trip through the real
   * decoder to prove the written file stays readable.
   */
  function assertProgressFileDecodesV1(folderPath: string): void {
    const text = fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8");
    const result = decodeTaskProgressTextV1(text);
    assert.strictEqual(result.ok, true, !result.ok ? `decode failed: ${result.code}: ${result.reason}` : undefined);
  }

  void it("routes as zero blockers when the only finding is a passing-test-run ask, at impl-high-review", async () => {
    const fsBridge = installFsBridge();
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const { folderPath, folderUri } = makeRealTaskFolder("test-run-only-blocker");

    const content = [
      "Readiness: 9/10",
      "",
      "<!-- blockers:start -->",
      "- [completion] [task-fixable] The targeted stall regressions still need a passing test run",
      "<!-- blockers:end -->",
    ].join("\n");

    try {
      const { escalated } = await handleReviewRoutingOutcome({
        folderUri,
        targetStage: "impl-high-review",
        reviewAttemptId: "attempt-tr-1",
        content,
        score: 9,
        threshold: 8,
      });
      assert.strictEqual(escalated, false);

      const entry = readProgress(folderPath).reviewScoreHistory?.find((e) => e.attemptId === "attempt-tr-1");
      assert.ok(entry, "a history entry must have been recorded");
      assert.strictEqual(entry.taskFixableCount, 0, "the passing-test-run blocker must not count as task-fixable");
      assert.strictEqual(entry.blockerCount, 0, "the passing-test-run blocker must not count toward blockerCount");
      assert.strictEqual(entry.stageUnsatisfiableBlockers?.length, 1);
      assert.match(entry.stageUnsatisfiableBlockers?.[0]?.subject ?? "", /passing test run|test run/i);
      assertProgressFileDecodesV1(folderPath);
    } finally {
      deactivateNotificationRouter();
      fsBridge.restore();
    }
  });

  void it("routes as zero blockers when the only finding is declared needs-toolchain (the exact RC1 shape)", async () => {
    const fsBridge = installFsBridge();
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const { folderPath, folderUri } = makeRealTaskFolder("test-run-only-needs-toolchain");

    const content = [
      "Readiness: 8/10",
      "",
      "<!-- blockers:start -->",
      "- [completion] [needs-toolchain] The targeted stall regressions still need a passing test run",
      "<!-- blockers:end -->",
    ].join("\n");

    try {
      const { escalated } = await handleReviewRoutingOutcome({
        folderUri,
        targetStage: "impl-high-review",
        reviewAttemptId: "attempt-tr-nt-1",
        content,
        score: 8,
        threshold: 8,
      });
      assert.strictEqual(escalated, false);

      const entry = readProgress(folderPath).reviewScoreHistory?.find((e) => e.attemptId === "attempt-tr-nt-1");
      assert.ok(entry, "a history entry must have been recorded");
      assert.strictEqual(entry.blockerCount, 0, "a needs-toolchain-only 'passing test run' ask must not remain a blocker");
      assert.strictEqual(entry.stageUnsatisfiableBlockers?.length, 1);
      assertProgressFileDecodesV1(folderPath);
    } finally {
      deactivateNotificationRouter();
      fsBridge.restore();
    }
  });

  void it("routes as zero blockers when the only finding is declared environmental (not task-fixable or needs-toolchain)", async () => {
    const fsBridge = installFsBridge();
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const { folderPath, folderUri } = makeRealTaskFolder("test-run-only-environmental");

    const content = [
      "Readiness: 8/10",
      "",
      "<!-- blockers:start -->",
      "- [completion] [environmental] The targeted stall regressions still need a passing test run",
      "<!-- blockers:end -->",
    ].join("\n");

    try {
      const { escalated } = await handleReviewRoutingOutcome({
        folderUri,
        targetStage: "impl-high-review",
        reviewAttemptId: "attempt-tr-env-1",
        content,
        score: 8,
        threshold: 8,
      });
      assert.strictEqual(escalated, false);

      const entry = readProgress(folderPath).reviewScoreHistory?.find((e) => e.attemptId === "attempt-tr-env-1");
      assert.ok(entry, "a history entry must have been recorded");
      assert.strictEqual(entry.blockerCount, 0, "an environmental-only 'passing test run' ask must not remain a blocker");
      assert.strictEqual(entry.stageUnsatisfiableBlockers?.length, 1);
      assertProgressFileDecodesV1(folderPath);
    } finally {
      deactivateNotificationRouter();
      fsBridge.restore();
    }
  });

  void it("keeps a mixed finding whole when the same line also names a real, distinct defect", async () => {
    const fsBridge = installFsBridge();
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const { folderPath, folderUri } = makeRealTaskFolder("test-run-mixed-with-real-defect");

    const content = [
      "Readiness: 6/10",
      "",
      "<!-- blockers:start -->",
      "- [completion] [task-fixable] The targeted stall regressions still need a passing test run, and the `foo()` helper in src/utils/foo.ts throws on an empty array",
      "<!-- blockers:end -->",
    ].join("\n");

    try {
      await handleReviewRoutingOutcome({
        folderUri,
        targetStage: "impl-high-review",
        reviewAttemptId: "attempt-tr-mixed-1",
        content,
        score: 6,
        threshold: 8,
      });

      const entry = readProgress(folderPath).reviewScoreHistory?.find((e) => e.attemptId === "attempt-tr-mixed-1");
      assert.ok(entry, "a history entry must have been recorded");
      assert.strictEqual(
        entry.taskFixableCount,
        1,
        "a compound finding naming a real defect alongside the test-run wording must not be discarded wholesale"
      );
      assert.strictEqual(entry.blockerCount, 1);
      assert.strictEqual(entry.stageUnsatisfiableBlockers, undefined);
      assertProgressFileDecodesV1(folderPath);
    } finally {
      deactivateNotificationRouter();
      fsBridge.restore();
    }
  });

  void it("still counts a real task-fixable blocker reported in the same review", async () => {
    const fsBridge = installFsBridge();
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const { folderPath, folderUri } = makeRealTaskFolder("test-run-plus-real-blocker");

    const content = [
      "Readiness: 6/10",
      "",
      "<!-- blockers:start -->",
      "- [completion] [task-fixable] The targeted stall regressions still need a passing test run",
      "- [completion] [task-fixable] `src/utils/foo.ts` throws on an empty array",
      "<!-- blockers:end -->",
    ].join("\n");

    try {
      await handleReviewRoutingOutcome({
        folderUri,
        targetStage: "impl-high-review",
        reviewAttemptId: "attempt-tr-2",
        content,
        score: 6,
        threshold: 8,
      });

      const entry = readProgress(folderPath).reviewScoreHistory?.find((e) => e.attemptId === "attempt-tr-2");
      assert.ok(entry, "a history entry must have been recorded");
      assert.strictEqual(entry.taskFixableCount, 1, "the real blocker must still count");
      assert.strictEqual(entry.blockerCount, 1);
      assert.strictEqual(entry.stageUnsatisfiableBlockers?.length, 1);
      assertProgressFileDecodesV1(folderPath);
    } finally {
      deactivateNotificationRouter();
      fsBridge.restore();
    }
  });

  void it("does NOT strip the same wording at a Publish review, where the suite really does run", async () => {
    const fsBridge = installFsBridge();
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const { folderPath, folderUri } = makeRealTaskFolder("test-run-blocker-publish", { currentStage: "publish" });

    const content = [
      "Readiness: 6/10",
      "",
      "<!-- blockers:start -->",
      "- [shipping] [task-fixable] the suite still needs a passing test run before this ships",
      "<!-- blockers:end -->",
    ].join("\n");

    try {
      await handleReviewRoutingOutcome({
        folderUri,
        targetStage: "publish",
        reviewAttemptId: "attempt-tr-3",
        content,
        score: 6,
        threshold: 8,
      });

      const entry = readProgress(folderPath).reviewScoreHistory?.find((e) => e.attemptId === "attempt-tr-3");
      assert.ok(entry, "a history entry must have been recorded");
      assert.strictEqual(entry.taskFixableCount, 1, "at Publish, this blocker is real and must still count");
      assert.strictEqual(entry.stageUnsatisfiableBlockers, undefined);
    } finally {
      deactivateNotificationRouter();
      fsBridge.restore();
    }
  });
});

void describe("handleReviewRoutingOutcome — declined blocker reclassification (RC2 item 7)", () => {
  function installFsBridge(): { restore: () => void } {
    const target = vscode.workspace.fs as unknown as Record<string, unknown>;
    const orig = { ...target };
    target.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
      fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
    target.writeFile = async (uri: vscode.Uri, content: Uint8Array): Promise<void> => {
      await fs.promises.mkdir(path.dirname(uri.fsPath), { recursive: true });
      await fs.promises.writeFile(uri.fsPath, content);
    };
    target.rename = async (source: vscode.Uri, dest: vscode.Uri): Promise<void> => {
      await fs.promises.rm(dest.fsPath, { force: true });
      await fs.promises.rename(source.fsPath, dest.fsPath);
    };
    target.delete = (uri: vscode.Uri): Promise<void> =>
      fs.promises.rm(uri.fsPath, { force: true, recursive: true });
    target.createDirectory = (uri: vscode.Uri): Promise<void> =>
      fs.promises.mkdir(uri.fsPath, { recursive: true }).then(() => undefined);
    target.readDirectory = async (uri: vscode.Uri): Promise<Array<[string, number]>> => {
      const entries = await fs.promises.readdir(uri.fsPath, { withFileTypes: true });
      return entries.map((entry) => [entry.name, entry.isDirectory() ? 2 : 1]);
    };
    target.stat = async (uri: vscode.Uri): Promise<{ type: number; size: number; ctime: number; mtime: number }> => {
      const stat = await fs.promises.stat(uri.fsPath);
      return { type: stat.isDirectory() ? 2 : 1, size: stat.size, ctime: stat.ctimeMs, mtime: stat.mtimeMs };
    };
    return {
      restore: (): void => {
        for (const key of ["readFile", "writeFile", "rename", "delete", "createDirectory", "readDirectory", "stat"]) {
          target[key] = orig[key];
        }
      },
    };
  }

  function makeRealTaskFolder(name: string, overrides: Partial<TaskProgress> = {}): { folderPath: string; folderUri: vscode.Uri } {
    const folderPath = path.join(TEST_ROOT, "real-plans-declined", name);
    fs.mkdirSync(folderPath, { recursive: true });
    const progress: TaskProgress & { ensembleProgressVersion: 1 } = {
      ensembleProgressVersion: 1,
      taskFolder: name,
      currentStage: "impl-high-review",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      ...overrides,
    };
    fs.writeFileSync(path.join(folderPath, "task-progress.json"), JSON.stringify(progress, null, 2), "utf8");
    return { folderPath, folderUri: vscode.Uri.file(folderPath) };
  }

  function readProgress(folderPath: string): TaskProgress {
    return JSON.parse(fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")) as TaskProgress;
  }

  /** See the sibling stage-unsatisfiable block's identical helper: proves the
   * written file stays readable by the REAL strict decoder, not just
   * `JSON.parse` — the exact way this decoder's allowlist was found missing
   * a new field before (`stageUnsatisfiableBlockers`, RC2 item 4). */
  function assertProgressFileDecodesV1(folderPath: string): void {
    const text = fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8");
    const result = decodeTaskProgressTextV1(text);
    assert.strictEqual(result.ok, true, !result.ok ? `decode failed: ${result.code}: ${result.reason}` : undefined);
  }

  const DECLINED_REMOVAL_TEXT =
    "Hide or remove the deprecated `vs-code-ai-helper.hostRole` setting";

  void it("reclassifies a task-fixable blocker matching a prior round's declined removal as environmental, bringing taskFixableCount to 0", async () => {
    const fsBridge = installFsBridge();
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const { folderPath, folderUri } = makeRealTaskFolder("declined-removal-only-blocker");

    // The prior Apply Review round's own summary, declining the removal per
    // rule 7 (no owner approval recorded in Task Description).
    fs.writeFileSync(
      path.join(folderPath, "impl-summary.md"),
      "## Files Changed\n\n- src/foo.ts — unrelated fix\n\n" +
        "## Remaining Blockers\n\n" +
        `- ${DECLINED_REMOVAL_TEXT} — declined: needs a human decision — only the plan asks for this, not the owner's Task Description\n`,
      "utf8"
    );

    const content = [
      "Readiness: 7/10",
      "",
      "<!-- blockers:start -->",
      `- [completion] [task-fixable] ${DECLINED_REMOVAL_TEXT}`,
      "<!-- blockers:end -->",
    ].join("\n");

    try {
      const { escalated } = await handleReviewRoutingOutcome({
        folderUri,
        targetStage: "impl-high-review",
        reviewAttemptId: "attempt-declined-1",
        content,
        score: 7,
        threshold: 8,
      });

      const entry = readProgress(folderPath).reviewScoreHistory?.find((e) => e.attemptId === "attempt-declined-1");
      assert.ok(entry, "a history entry must have been recorded");
      assert.strictEqual(
        entry.taskFixableCount,
        0,
        "the declined removal must not count as task-fixable, or the reviewer and implementer can never agree"
      );
      // Reclassified, not excluded: it still appears in blockers, just with a
      // different resolver — unlike stageUnsatisfiableBlockers, which removes
      // the blocker from blockers/blockerCount entirely.
      assert.strictEqual(entry.blockerCount, 1);
      assert.strictEqual(entry.blockers?.length, 1);
      assert.strictEqual(entry.blockers?.[0]?.resolver, "environmental");
      assert.strictEqual(entry.declinedBlockerReclassifications?.length, 1);
      assert.match(entry.declinedBlockerReclassifications?.[0]?.subject ?? "", /hostrole/i);
      // With every task-fixable blocker declined, this must not escalate as
      // an ordinary task-fixable-remaining plateau either way — the routing
      // decision itself is exercised by reviewEscalation.test.ts's card-level
      // test; this asserts the underlying count that decision reads from.
      assert.strictEqual(typeof escalated, "boolean");
      assertProgressFileDecodesV1(folderPath);
    } finally {
      deactivateNotificationRouter();
      fsBridge.restore();
    }
  });

  void it("leaves an unrelated task-fixable blocker alone even when a declined removal is also present", async () => {
    const fsBridge = installFsBridge();
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const { folderPath, folderUri } = makeRealTaskFolder("declined-removal-plus-real-blocker");

    fs.writeFileSync(
      path.join(folderPath, "impl-summary.md"),
      "## Remaining Blockers\n\n" +
        `- ${DECLINED_REMOVAL_TEXT} — declined: needs a human decision — only the plan asks for this\n`,
      "utf8"
    );

    const content = [
      "Readiness: 5/10",
      "",
      "<!-- blockers:start -->",
      `- [completion] [task-fixable] ${DECLINED_REMOVAL_TEXT}`,
      "- [completion] [task-fixable] `src/utils/foo.ts` throws on an empty array",
      "<!-- blockers:end -->",
    ].join("\n");

    try {
      await handleReviewRoutingOutcome({
        folderUri,
        targetStage: "impl-high-review",
        reviewAttemptId: "attempt-declined-2",
        content,
        score: 5,
        threshold: 8,
      });

      const entry = readProgress(folderPath).reviewScoreHistory?.find((e) => e.attemptId === "attempt-declined-2");
      assert.ok(entry, "a history entry must have been recorded");
      assert.strictEqual(entry.taskFixableCount, 1, "the unrelated real blocker must still count as task-fixable");
      assert.strictEqual(entry.blockerCount, 2);
      assert.strictEqual(entry.declinedBlockerReclassifications?.length, 1);
      assertProgressFileDecodesV1(folderPath);
    } finally {
      deactivateNotificationRouter();
      fsBridge.restore();
    }
  });

  void it("does nothing when impl-summary.md has no declined-blocker entry", async () => {
    const fsBridge = installFsBridge();
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const { folderPath, folderUri } = makeRealTaskFolder("no-declined-blocker");

    fs.writeFileSync(
      path.join(folderPath, "impl-summary.md"),
      "## Files Changed\n\n- src/foo.ts — did a thing\n",
      "utf8"
    );

    const content = [
      "Readiness: 6/10",
      "",
      "<!-- blockers:start -->",
      `- [completion] [task-fixable] ${DECLINED_REMOVAL_TEXT}`,
      "<!-- blockers:end -->",
    ].join("\n");

    try {
      await handleReviewRoutingOutcome({
        folderUri,
        targetStage: "impl-high-review",
        reviewAttemptId: "attempt-declined-3",
        content,
        score: 6,
        threshold: 8,
      });

      const entry = readProgress(folderPath).reviewScoreHistory?.find((e) => e.attemptId === "attempt-declined-3");
      assert.ok(entry, "a history entry must have been recorded");
      assert.strictEqual(entry.taskFixableCount, 1, "with nothing declined, the blocker stays task-fixable");
      assert.strictEqual(entry.declinedBlockerReclassifications, undefined);
      assertProgressFileDecodesV1(folderPath);
    } finally {
      deactivateNotificationRouter();
      fsBridge.restore();
    }
  });
});
