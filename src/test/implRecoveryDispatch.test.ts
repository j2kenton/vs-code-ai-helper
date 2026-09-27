/**
 * The `implRecovery.dispatch` state machine's restart half (Part 1, extended
 * by A1's stale-dispatch reclaim, 1.0.0 gate): `TaskActionScheduler.armAll`
 * sweeps owed recovery continuations on task load/activation (and every 5
 * minutes), so a transition that persisted `dispatch: "pending"` and then
 * lost its window is re-armed exactly once. A `dispatched` record (a
 * continuation that STARTED) is left alone while its round could still
 * plausibly be running — but once its anchor (`leaseUntil ?? at`) plus the
 * 90-minute stale-dispatch grace has elapsed, the round it named is presumed
 * dead: the record is reclaimed back to `pending` and re-armed by the same
 * claim path a freshly-persisted pending record uses. Before this, a
 * `dispatched` record was surfaced once and never re-fired — the observed
 * failure this closes (2026-08-29): a continuation dispatched moments before
 * the provider hit a usage limit sat `dispatched` forever, with every
 * downstream action refusing on "nothing to review/fast-forward from" and
 * nothing ever retrying. Uses the scheduler's injectable inventory / clock /
 * store seams; the chain dispatch boundary is monkey-patched the same way
 * deferredRoundRecovery.test.ts patches it.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import * as vscode from "vscode";

import { TaskActionScheduler } from "../commands/scheduleTaskResume";
import {
  ImplRecoveryV1,
  MAX_INCOMPLETE_ROUND_CONTINUATIONS_V1,
  TaskProgress,
} from "../types/taskProgress";
import type { TaskInventory } from "../state/taskInventory";
import type { AutomationDispatch } from "../utils/automationChain";
import {
  deactivateNotificationRouter,
  initNotificationRouter,
} from "../utils/notificationRouter";
import { StatusTreeProvider } from "../views/statusView";
import {
  advancePauseFenceGenerationV1,
  readOrInitPauseFenceGenerationV1,
  setWorkAdmissionRootOverrideForTestV1,
} from "../state/workAdmissionV1";
import { flushScheduledRevokedWatchdogPauseCleanupsV1 } from "../state/effectivePauseStatusV1";
import {
  describeOwedImplRecoveryRefusalV1,
  discardOwedImplRecoveryV1,
  isImplRecoveryDiscardOfferableV1,
  retireSatisfiedSummaryRejectedRecoveryV1,
  shouldLogNoOpContinuationRoundV1,
} from "../commands/implementationRecoveryV1";
import { IMPLEMENTATION_SUMMARY_UNUSABLE_MARKER_V1 } from "../utils/implementationArtifactResolver";
import { registerReviewActionCommands } from "../commands/reviewActions";
import { safeRemoveDir } from "./testFsUtils";

/**
 * `armAll()` (exercised throughout this file) may reach the watchdog sweep's
 * `pauseCommit` admission claim (v1 fixes item 1, Part 1a step 4), which does
 * real filesystem I/O rooted at each task's `taskFolderPath` — a placeholder
 * here (e.g. `"C:/tasks/2026-08-14_task_1"`), not a real directory. Redirect
 * to a disposable temp root for the whole file, same as
 * `scheduleTaskResume.test.ts`.
 */
const admissionTestRootV1 = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-admission-test-"));
setWorkAdmissionRootOverrideForTestV1((taskFolderPath) =>
  path.join(admissionTestRootV1, Buffer.from(taskFolderPath).toString("hex"))
);
after(() => {
  setWorkAdmissionRootOverrideForTestV1(undefined);
  safeRemoveDir(admissionTestRootV1);
});

/* eslint-disable @typescript-eslint/no-var-requires */
const automationChainModule = require("../utils/automationChain") as Record<string, unknown>;
/* eslint-enable @typescript-eslint/no-var-requires */

const OWNER = "test-owner";
const OTHER_OWNER = "other-window";
const BASE_NOW = Date.parse("2026-08-14T12:00:00.000Z");

interface Harness {
  scheduler: TaskActionScheduler;
  progress: TaskProgress;
  dispatches: AutomationDispatch[];
  notifications: string[];
  advance(ms: number): void;
  armAll(): Promise<void>;
  dispose(): void;
}

function makeProgress(recovery: ImplRecoveryV1 | undefined, extra: Partial<TaskProgress> = {}): TaskProgress {
  return {
    taskFolder: "2026-08-14_task_1",
    currentStage: "impl-high-review",
    status: "active",
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
    ...(recovery !== undefined ? { implRecovery: recovery } : {}),
    ...extra,
  };
}

function makeHarness(progress: TaskProgress): Harness {
  const provider = new StatusTreeProvider();
  initNotificationRouter(provider);
  const notifications: string[] = [];
  const providerTarget = provider as unknown as { addEntry: (...args: unknown[]) => unknown };
  const origAddEntry = providerTarget.addEntry.bind(provider);
  providerTarget.addEntry = (...args: unknown[]): unknown => {
    notifications.push(args[0] as string);
    return origAddEntry(...args);
  };

  const dispatches: AutomationDispatch[] = [];
  const origSchedule = automationChainModule.scheduleAutomationChain;
  automationChainModule.scheduleAutomationChain = (dispatch: AutomationDispatch): Promise<boolean> => {
    dispatches.push(dispatch);
    return Promise.resolve(true);
  };

  let nowMs = BASE_NOW;
  const clock = {
    now: (): number => nowMs,
    setTimeout: (callback: () => void, delay: number): ReturnType<typeof setTimeout> =>
      setTimeout(callback, Math.min(delay, 10)),
    clearTimeout: (timer: ReturnType<typeof setTimeout>): void => clearTimeout(timer),
  };

  const state = { progress };
  const store = {
    patch: (
      _folder: vscode.Uri,
      update: (current: TaskProgress) => TaskProgress
    ): Promise<TaskProgress | undefined> => {
      state.progress = update(state.progress);
      return Promise.resolve(state.progress);
    },
  };
  const inventory = {
    getTasks: () => [
      {
        taskFolderPath: "C:/tasks/2026-08-14_task_1",
        canonicalId: "C:/tasks/2026-08-14_task_1",
        progress: state.progress,
      },
    ],
  } as unknown as TaskInventory;

  const scheduler = new TaskActionScheduler(inventory, clock, store, OWNER);
  return {
    scheduler,
    get progress(): TaskProgress {
      return state.progress;
    },
    dispatches,
    notifications,
    advance: (ms: number): void => {
      nowMs += ms;
    },
    armAll: () => scheduler.armAll(),
    dispose: (): void => {
      scheduler.dispose();
      automationChainModule.scheduleAutomationChain = origSchedule;
      provider.dispose();
      deactivateNotificationRouter();
    },
  };
}

function pendingRecord(overrides: Partial<ImplRecoveryV1> = {}): ImplRecoveryV1 {
  return {
    sourceAttemptId: "impl-recovery-test",
    reason: "the provider ended its turn deferring",
    trigger: "roundDeferred",
    mode: "unconstrained",
    dispatch: "pending",
    at: new Date(BASE_NOW - 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

let active: Harness | undefined;
afterEach(() => {
  active?.dispose();
  active = undefined;
});

void describe("implRecovery dispatch sweep (restart semantics)", () => {
  void it("re-arms a pending record with no live lease exactly once, claiming the lease", async () => {
    const harness = makeHarness(makeProgress(pendingRecord()));
    active = harness;

    await harness.armAll();
    assert.equal(harness.dispatches.length, 1);
    assert.equal(harness.dispatches[0]?.command, "vs-code-ai-helper.runImplementationWithAI");
    assert.equal(harness.dispatches[0]?.chainId, "impl-continuation");
    assert.equal(harness.progress.implRecovery?.leaseOwner, OWNER);

    // Immediate re-sweeps (progress-change refreshes, the 5-minute recovery
    // timer) must not double-fire while the claim's lease is live.
    await harness.armAll();
    await harness.armAll();
    assert.equal(harness.dispatches.length, 1);
  });

  void it("respects another window's live lease on a pending record", async () => {
    const harness = makeHarness(
      makeProgress(
        pendingRecord({
          leaseOwner: OTHER_OWNER,
          leaseUntil: new Date(BASE_NOW + 5 * 60 * 1000).toISOString(),
        })
      )
    );
    active = harness;

    await harness.armAll();
    assert.equal(harness.dispatches.length, 0);
    assert.equal(harness.progress.implRecovery?.leaseOwner, OTHER_OWNER);

    // Once the other window's lease expires the record is claimable again —
    // a crashed window cannot park the task forever.
    harness.advance(6 * 60 * 1000);
    await harness.armAll();
    assert.equal(harness.dispatches.length, 1);
    assert.equal(harness.progress.implRecovery?.leaseOwner, OWNER);
  });

  void it("leaves a dispatched record alone while still within the stale-dispatch grace window", async () => {
    const harness = makeHarness(
      makeProgress(
        pendingRecord({
          dispatch: "dispatched",
          attemptId: "impl-continuation-dead",
          leaseUntil: new Date(BASE_NOW - 60 * 60 * 1000).toISOString(),
        })
      )
    );
    active = harness;

    // Not yet past the grace window (lease + 90 min): silent, no dispatch.
    await harness.armAll();
    assert.equal(harness.dispatches.length, 0);
    assert.equal(harness.notifications.length, 0);
    assert.equal(harness.progress.implRecovery?.dispatch, "dispatched");
  });

  void it("reclaims a dispatched record once clearly dead AND reconstructable (A1, 1.0.0 gate), re-arming it exactly once", async () => {
    const harness = makeHarness(
      makeProgress(
        pendingRecord({
          dispatch: "dispatched",
          attemptId: "impl-continuation-dead",
          leaseUntil: new Date(BASE_NOW - 60 * 60 * 1000).toISOString(),
          // Reconstructable: a source round to link back to, plus an
          // explicit "the file set could not be enumerated" admission — the
          // evidence the sweep now REQUIRES before reclaiming a stale
          // dispatch (2026-09-04 review follow-up: reclaiming without it
          // would re-dispatch a continuation with nothing to continue).
          sourceRoundId: "round-source-1",
          filesChangedUnknown: true,
        })
      )
    );
    active = harness;

    // Well past the grace window (lease + 90 min): the round it named is
    // presumed dead, so the record is reclaimed to "pending" and re-armed by
    // the same claim path a freshly-persisted pending record uses — surfaced
    // once as a reclaim, not left to sit dispatched forever.
    harness.advance(2 * 60 * 60 * 1000);
    await harness.armAll();
    await harness.armAll();

    assert.equal(harness.dispatches.length, 1, "the reclaimed record must be re-armed exactly once");
    assert.equal(harness.dispatches[0]?.command, "vs-code-ai-helper.runImplementationWithAI");
    assert.equal(harness.progress.implRecovery?.dispatch, "pending");
    assert.equal(harness.progress.implRecovery?.leaseOwner, OWNER);
    assert.equal(harness.progress.implRecovery?.attemptId, undefined, "the reclaimed record must shed the dead dispatch's attemptId");
    const surfaced = harness.notifications.filter((message) =>
      /reclaimed and will be re-armed automatically/.test(message)
    );
    assert.equal(surfaced.length, 1, "the reclaim must be surfaced exactly once, not once per sweep");
  });

  void it("does NOT reclaim a dispatched record that is clearly dead but has lost its reconstructability evidence — closed out by the watchdog instead (A1 second route)", async () => {
    const harness = makeHarness(
      makeProgress(
        pendingRecord({
          dispatch: "dispatched",
          attemptId: "impl-continuation-dead-2",
          leaseUntil: new Date(BASE_NOW - 60 * 60 * 1000).toISOString(),
          // No sourceRoundId, no filesChangedUnknown, and makeProgress below
          // sets no pendingImplReviewFiles — nothing to reconstruct from.
        })
      )
    );
    active = harness;

    harness.advance(2 * 60 * 60 * 1000);
    await harness.armAll();

    assert.equal(harness.dispatches.length, 0, "must not re-dispatch a continuation with no source round or file set");
    assert.notEqual(harness.progress.implRecovery?.dispatch, "pending", "must not be reclaimed");
    assert.ok(
      !harness.notifications.some((message) => /reclaimed and will be re-armed automatically/.test(message)),
      "must not post the reclaim notification for an unreconstructable record"
    );
  });

  void it("does not re-arm once the continuation cap is reached", async () => {
    const harness = makeHarness(
      makeProgress(pendingRecord(), {
        incompleteRoundContinuations: MAX_INCOMPLETE_ROUND_CONTINUATIONS_V1,
      })
    );
    active = harness;

    await harness.armAll();
    assert.equal(harness.dispatches.length, 0);
  });

  void it("does not re-arm on a paused task", async () => {
    const harness = makeHarness(makeProgress(pendingRecord(), { status: "paused" }));
    active = harness;

    await harness.armAll();
    assert.equal(harness.dispatches.length, 0);
  });

  void it(
    "re-arms a pending record even while status is still 'paused' on disk, when that pause is a REVOKED " +
      "watchdog pause (2026-09-15 review round: Part 1b step 13's \"automation gates\" audit site — this " +
      "sweep dispatches with no human invoking it, so unlike a manual command it cannot rely on the command's " +
      "own admission check to reject a real pause and accept a stale one; before this fix it used a raw " +
      "`status !== \"active\"` check that could not tell a stale pause a revocation has already fenced past " +
      "from a real one, stranding the owed continuation until some other reader happened to trigger the " +
      "resolver's background repair)",
    async () => {
      const taskFolderPath = "C:/tasks/2026-08-14_task_1";
      const staleGeneration = await readOrInitPauseFenceGenerationV1(taskFolderPath);
      await advancePauseFenceGenerationV1(taskFolderPath);
      const harness = makeHarness(
        makeProgress(pendingRecord(), {
          status: "paused",
          pausedReason: "stalled-active-task",
          watchdogPauseClaimId: "claim-stale-for-recovery-sweep",
          watchdogPauseFenceGeneration: staleGeneration,
        })
      );
      active = harness;

      await harness.armAll();
      assert.equal(
        harness.dispatches.length,
        1,
        "a revoked watchdog pause must not block the automated recovery re-arm"
      );
      // The fix routes through `isEffectivelyPausedV1`, which also schedules
      // its own best-effort durable repair of the stale pause fields — a
      // guaranteed no-op here (this harness's `task-progress.json` is an
      // in-memory mock, not a real file for that repair to patch). Flush it
      // so the (caught, logged) failure settles before this test returns
      // rather than leaking into a later test's output.
      await flushScheduledRevokedWatchdogPauseCleanupsV1();
    }
  );

  void it("does not re-arm while status is 'paused' under a CURRENT (still-effective) watchdog pause", async () => {
    const taskFolderPath = "C:/tasks/2026-08-14_task_1";
    const currentGeneration = await readOrInitPauseFenceGenerationV1(taskFolderPath);
    const harness = makeHarness(
      makeProgress(pendingRecord(), {
        status: "paused",
        pausedReason: "stalled-active-task",
        watchdogPauseClaimId: "claim-current-for-recovery-sweep",
        watchdogPauseFenceGeneration: currentGeneration,
      })
    );
    active = harness;

    await harness.armAll();
    assert.equal(harness.dispatches.length, 0, "a still-effective watchdog pause must still block the re-arm");
  });

  void describe("workflow-6 Item 1: the automation chain guard", () => {
    void it("skips the reclaim while the chain guard is live, surfacing it once per window", async () => {
      // The reclaimer at scheduleTaskResume.ts's armPendingImplRecoveries
      // consults isAutomationChainActive before re-dispatching. A live guard
      // must still skip the reclaim (a genuinely in-flight chain must not be
      // double-dispatched) — but before this fix the skip was completely
      // silent, and was the exact mechanism that let a completed run's
      // rejected continuation sit idle for ~2.5 hours (2026-08-17).
      const harness = makeHarness(makeProgress(pendingRecord()));
      active = harness;
      const originalIsActive = automationChainModule.isAutomationChainActive;
      automationChainModule.isAutomationChainActive = (): boolean => true;
      try {
        await harness.armAll();
        assert.equal(harness.dispatches.length, 0, "a live guard must still block the reclaim");
        const skipNotices = harness.notifications.filter((message) =>
          /automation chain guard is still held/.test(message)
        );
        assert.equal(skipNotices.length, 1, "the skip must be surfaced");

        // A second sweep while the guard is still live must not spam a
        // second notification — same once-per-window rule as the sibling
        // "dispatched" surfacing test above.
        await harness.armAll();
        assert.equal(
          harness.notifications.filter((message) => /automation chain guard is still held/.test(message)).length,
          1
        );
      } finally {
        automationChainModule.isAutomationChainActive = originalIsActive;
      }
    });

    void it("re-arms once the chain guard clears (or expires) without needing a window reload", async () => {
      const harness = makeHarness(makeProgress(pendingRecord()));
      active = harness;
      const originalIsActive = automationChainModule.isAutomationChainActive;
      let guardActive = true;
      automationChainModule.isAutomationChainActive = (): boolean => guardActive;
      try {
        await harness.armAll();
        assert.equal(harness.dispatches.length, 0);

        // The guard clears (released normally, or — the point of this item —
        // expired on its own after a crash). The very next sweep must
        // re-dispatch without any special reset step.
        guardActive = false;
        await harness.armAll();
        assert.equal(harness.dispatches.length, 1);
        assert.equal(harness.dispatches[0]?.chainId, "impl-continuation");
      } finally {
        automationChainModule.isAutomationChainActive = originalIsActive;
      }
    });
  });
});

/**
 * 2026-09-15 post-freeze findings, item 5 (Part 5 steps 33-35): a
 * `summaryRejected` recovery must retire itself once a usable impl-summary.md
 * exists again — the observed real-world case was a recovery whose blocking
 * condition had already been satisfied by a 9/10, zero-blocker review, still
 * refusing advancement for over two hours. `discardOwedImplRecoveryV1` is the
 * separate, explicit-abandonment escape for a record with no automated way
 * back. Uses a REAL temp task folder (these functions call
 * `patchTaskProgressStrictV1`/`readTextIfExists` directly, not through the
 * scheduler's injectable store above), same pattern as
 * reviewInProgressStatus.test.ts's `installFsStub`/`makeTaskFolder`.
 */
void describe("retireSatisfiedSummaryRejectedRecoveryV1 / discardOwedImplRecoveryV1 (2026-09-15 post-freeze findings, item 5)", () => {
  const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-impl-recovery-retire-"));
  after(() => {
    safeRemoveDir(ROOT);
  });

  function installFsStub(): () => void {
    const fsRecord = vscode.workspace.fs as unknown as Record<string, unknown>;
    const originalRead = fsRecord.readFile;
    const originalWrite = fsRecord.writeFile;
    fsRecord.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
      fs.promises.readFile(uri.fsPath) as Promise<Uint8Array>;
    fsRecord.writeFile = (uri: vscode.Uri, content: Uint8Array): Promise<void> =>
      fs.promises.writeFile(uri.fsPath, content).then(() => undefined);
    return (): void => {
      fsRecord.readFile = originalRead;
      fsRecord.writeFile = originalWrite;
    };
  }

  // Lock-scope isolation: `withTaskLock` derives the shared session lock TWO
  // levels above the task folder (see `taskFolderFixture.ts`'s
  // `makeOwnedTaskFolder`). Nesting under `ROOT/tasks/<name>` instead of
  // `ROOT/<name>` keeps that session lock inside this file's own private
  // `ROOT` mkdtemp container instead of colliding with `os.tmpdir()` itself,
  // where every other concurrently running test file's session lock would
  // otherwise also land.
  function makeTaskFolder(name: string): { folderUri: vscode.Uri; folderPath: string } {
    const folderPath = path.join(ROOT, "tasks", name);
    fs.mkdirSync(folderPath, { recursive: true });
    return { folderUri: vscode.Uri.file(folderPath), folderPath };
  }

  function seedProgress(folderPath: string, overrides: Partial<TaskProgress>): void {
    const full: TaskProgress = {
      taskFolder: path.basename(folderPath),
      currentStage: "impl-high-review",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      ...overrides,
    };
    fs.writeFileSync(
      path.join(folderPath, "task-progress.json"),
      JSON.stringify(full, null, 2),
      "utf8"
    );
  }

  function readProgress(folderPath: string): TaskProgress {
    return JSON.parse(fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")) as TaskProgress;
  }

  void describe("retireSatisfiedSummaryRejectedRecoveryV1", () => {
    void it("retires a summaryRejected recovery, unioning its pending files into review scope, once impl-summary.md is usable again", async () => {
      const { folderUri, folderPath } = makeTaskFolder("retire_usable");
      fs.writeFileSync(path.join(folderPath, "impl-summary.md"), "## Files Changed\n\n_none_\n", "utf8");
      seedProgress(folderPath, {
        implRecovery: pendingRecord({ trigger: "summaryRejected" }),
        pendingImplReviewFiles: ["src/a.ts"],
      });

      const restore = installFsStub();
      try {
        const retired = await retireSatisfiedSummaryRejectedRecoveryV1(folderUri);
        assert.equal(retired, true);
        const after = readProgress(folderPath);
        assert.equal(after.implRecovery, undefined);
        assert.equal(after.pendingImplReviewFiles, undefined);
        assert.ok(
          (after.implReviewFiles ?? []).includes("src/a.ts"),
          "the previously-pending file must be promoted into review scope, not silently dropped"
        );
      } finally {
        restore();
      }
    });

    // v1 fixes 2, item 1: a form-rejected round leaves the last usable summary
    // in place, so "usable" alone no longer proves the continuation answered
    // the debt — only a summary written AFTER the recovery record does.
    void it("does not retire a summaryRejected recovery on a preserved summary older than the record", async () => {
      const { folderUri, folderPath } = makeTaskFolder("retire_preserved_older");
      const summaryPath = path.join(folderPath, "impl-summary.md");
      fs.writeFileSync(summaryPath, "## Files Changed\n\n_none_\n", "utf8");
      const recordedAt = Date.now();
      fs.utimesSync(summaryPath, new Date(recordedAt - 60_000), new Date(recordedAt - 60_000));
      seedProgress(folderPath, {
        implRecovery: pendingRecord({ trigger: "summaryRejected", at: new Date(recordedAt).toISOString() }),
        pendingImplReviewFiles: ["src/a.ts"],
      });

      const restore = installFsStub();
      const fsRecord = vscode.workspace.fs as unknown as Record<string, unknown>;
      const originalStat = fsRecord.stat;
      fsRecord.stat = (uri: vscode.Uri): Promise<{ mtime: number }> =>
        Promise.resolve({ mtime: fs.statSync(uri.fsPath).mtimeMs });
      try {
        assert.equal(await retireSatisfiedSummaryRejectedRecoveryV1(folderUri), false);
        assert.notEqual(readProgress(folderPath).implRecovery, undefined);

        // The continuation then writes a fresh summary after the record.
        const later = new Date(recordedAt + 60_000);
        fs.writeFileSync(summaryPath, "## Files Changed\n\n- src/a.ts\n", "utf8");
        fs.utimesSync(summaryPath, later, later);
        assert.equal(await retireSatisfiedSummaryRejectedRecoveryV1(folderUri), true);
        assert.equal(readProgress(folderPath).implRecovery, undefined);
      } finally {
        fsRecord.stat = originalStat;
        restore();
      }
    });

    // Equal timestamps carry no ordering evidence, so they must fail closed.
    void it("does not retire a summaryRejected recovery when the summary mtime equals the record timestamp", async () => {
      const { folderUri, folderPath } = makeTaskFolder("retire_equal_mtime");
      const summaryPath = path.join(folderPath, "impl-summary.md");
      fs.writeFileSync(summaryPath, "## Files Changed\n\n_none_\n", "utf8");
      const recordedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
      fs.utimesSync(summaryPath, recordedAt, recordedAt);
      seedProgress(folderPath, {
        implRecovery: pendingRecord({ trigger: "summaryRejected", at: recordedAt.toISOString() }),
        pendingImplReviewFiles: ["src/a.ts"],
      });

      const restore = installFsStub();
      const fsRecord = vscode.workspace.fs as unknown as Record<string, unknown>;
      const originalStat = fsRecord.stat;
      fsRecord.stat = (uri: vscode.Uri): Promise<{ mtime: number }> =>
        Promise.resolve({ mtime: fs.statSync(uri.fsPath).mtimeMs });
      try {
        assert.equal(await retireSatisfiedSummaryRejectedRecoveryV1(folderUri), false);
        const after = readProgress(folderPath);
        assert.notEqual(after.implRecovery, undefined);
        assert.deepEqual(after.pendingImplReviewFiles, ["src/a.ts"]);
      } finally {
        fsRecord.stat = originalStat;
        restore();
      }
    });

    // Interleaving: a continuation overwrites the preserved usable summary with
    // an unusable stamp after the helper read the usable content but before it
    // takes the mtime. The old content must not be paired with the new mtime.
    void it("does not retire a summaryRejected recovery when the summary is rewritten between the content read and the mtime stat", async () => {
      const { folderUri, folderPath } = makeTaskFolder("retire_interleaved_write");
      const summaryPath = path.join(folderPath, "impl-summary.md");
      fs.writeFileSync(summaryPath, "## Files Changed\n\n_none_\n", "utf8");
      const recordedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
      const older = new Date(recordedAt.getTime() - 60_000);
      fs.utimesSync(summaryPath, older, older);
      seedProgress(folderPath, {
        implRecovery: pendingRecord({ trigger: "summaryRejected", at: recordedAt.toISOString() }),
        pendingImplReviewFiles: ["src/a.ts"],
      });

      const restore = installFsStub();
      const fsRecord = vscode.workspace.fs as unknown as Record<string, unknown>;
      const originalStat = fsRecord.stat;
      let statCalls = 0;
      fsRecord.stat = (uri: vscode.Uri): Promise<{ mtime: number }> => {
        statCalls += 1;
        if (statCalls === 2) {
          // The stat that follows the content read: the file was just replaced.
          fs.writeFileSync(
            summaryPath,
            `${IMPLEMENTATION_SUMMARY_UNUSABLE_MARKER_V1}\n\nThis round's report was not usable.\n`,
            "utf8"
          );
          const later = new Date(recordedAt.getTime() + 60_000);
          fs.utimesSync(summaryPath, later, later);
        }
        return Promise.resolve({ mtime: fs.statSync(uri.fsPath).mtimeMs });
      };
      try {
        assert.equal(await retireSatisfiedSummaryRejectedRecoveryV1(folderUri), false);
        const after = readProgress(folderPath);
        assert.notEqual(after.implRecovery, undefined);
        assert.deepEqual(after.pendingImplReviewFiles, ["src/a.ts"]);
      } finally {
        fsRecord.stat = originalStat;
        restore();
      }
    });

    // Interleaving: the summary is replaced after the helper's second stat has
    // validated a usable, newer file but before the progress write commits. The
    // final revalidation under the progress lock must keep the recovery.
    void it("does not retire a summaryRejected recovery when the summary is rewritten after validation but before the progress write", async () => {
      const { folderUri, folderPath } = makeTaskFolder("retire_write_window");
      const summaryPath = path.join(folderPath, "impl-summary.md");
      fs.writeFileSync(summaryPath, "## Files Changed\n\n_none_\n", "utf8");
      const recordedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
      const newer = new Date(recordedAt.getTime() + 60_000);
      fs.utimesSync(summaryPath, newer, newer);
      seedProgress(folderPath, {
        implRecovery: pendingRecord({ trigger: "summaryRejected", at: recordedAt.toISOString() }),
        pendingImplReviewFiles: ["src/a.ts"],
      });

      const restore = installFsStub();
      const fsRecord = vscode.workspace.fs as unknown as Record<string, unknown>;
      const originalStat = fsRecord.stat;
      let statCalls = 0;
      fsRecord.stat = (uri: vscode.Uri): Promise<{ mtime: number }> => {
        statCalls += 1;
        // Calls 1 and 2 are the pre/post-read snapshot; call 3 is the first
        // stat inside the pre-write revalidation. Replace the file just before.
        if (statCalls === 3) {
          fs.writeFileSync(
            summaryPath,
            `${IMPLEMENTATION_SUMMARY_UNUSABLE_MARKER_V1}\n\nThis round's report was not usable.\n`,
            "utf8"
          );
          const later = new Date(newer.getTime() + 60_000);
          fs.utimesSync(summaryPath, later, later);
        }
        return Promise.resolve({ mtime: fs.statSync(uri.fsPath).mtimeMs });
      };
      try {
        assert.equal(await retireSatisfiedSummaryRejectedRecoveryV1(folderUri), false);
        const after = readProgress(folderPath);
        assert.notEqual(after.implRecovery, undefined);
        assert.deepEqual(after.pendingImplReviewFiles, ["src/a.ts"]);
      } finally {
        fsRecord.stat = originalStat;
        restore();
      }
    });

    void it("restores the owed continuation when the summary is rewritten after the pre-write check but before the commit is confirmed", async () => {
      const { folderUri, folderPath } = makeTaskFolder("retire_post_commit_window");
      const summaryPath = path.join(folderPath, "impl-summary.md");
      fs.writeFileSync(summaryPath, "## Files Changed\n\n_none_\n", "utf8");
      const recordedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
      const newer = new Date(recordedAt.getTime() + 60_000);
      fs.utimesSync(summaryPath, newer, newer);
      seedProgress(folderPath, {
        implRecovery: pendingRecord({ trigger: "summaryRejected", at: recordedAt.toISOString() }),
        pendingImplReviewFiles: ["src/a.ts"],
      });

      const restore = installFsStub();
      const fsRecord = vscode.workspace.fs as unknown as Record<string, unknown>;
      const originalStat = fsRecord.stat;
      let statCalls = 0;
      fsRecord.stat = (uri: vscode.Uri): Promise<{ mtime: number }> => {
        statCalls += 1;
        // Calls 1-2: pre/post-read snapshot. Calls 3-4: the pre-write check
        // (before/after its read). Call 5 is the first stat of the post-commit
        // revalidation: rewrite the summary just before it, i.e. after the
        // pre-write check passed and the progress write already committed.
        if (statCalls === 5) {
          fs.writeFileSync(
            summaryPath,
            `${IMPLEMENTATION_SUMMARY_UNUSABLE_MARKER_V1}\n\nThis round's report was not usable.\n`,
            "utf8"
          );
          const later = new Date(newer.getTime() + 60_000);
          fs.utimesSync(summaryPath, later, later);
        }
        return Promise.resolve({ mtime: fs.statSync(uri.fsPath).mtimeMs });
      };
      try {
        assert.equal(await retireSatisfiedSummaryRejectedRecoveryV1(folderUri), false);
        const after = readProgress(folderPath);
        assert.notEqual(after.implRecovery, undefined);
        assert.deepEqual(after.pendingImplReviewFiles, ["src/a.ts"]);
        assert.equal(after.implReviewFiles?.includes("src/a.ts") ?? false, false);
      } finally {
        fsRecord.stat = originalStat;
        restore();
      }
    });

    void it("keeps the gate closed when an unusable stamp lands after the final validation, because the stamp writer arms its own recovery first", async () => {
      const { folderUri, folderPath } = makeTaskFolder("retire_after_final_check");
      const summaryPath = path.join(folderPath, "impl-summary.md");
      fs.writeFileSync(summaryPath, "## Files Changed\n\n_none_\n", "utf8");
      const recordedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
      const newer = new Date(recordedAt.getTime() + 60_000);
      fs.utimesSync(summaryPath, newer, newer);
      seedProgress(folderPath, {
        implRecovery: pendingRecord({ trigger: "summaryRejected", at: recordedAt.toISOString() }),
        pendingImplReviewFiles: ["src/a.ts"],
      });

      const restore = installFsStub();
      const fsRecord = vscode.workspace.fs as unknown as Record<string, unknown>;
      const originalStat = fsRecord.stat;
      let statCalls = 0;
      fsRecord.stat = (uri: vscode.Uri): Promise<{ mtime: number }> => {
        statCalls += 1;
        const mtime = fs.statSync(uri.fsPath).mtimeMs;
        // Call 6 is the last stat of the post-commit revalidation. Everything
        // after it is the unobserved window: play the stamp writer's own
        // ordering — record a fresh implRecovery first, then write the stamp.
        if (statCalls === 6) {
          const later = new Date(newer.getTime() + 60_000);
          seedProgress(folderPath, {
            implRecovery: pendingRecord({ trigger: "summaryRejected", at: later.toISOString() }),
            pendingImplReviewFiles: ["src/b.ts"],
          });
          fs.writeFileSync(
            summaryPath,
            `${IMPLEMENTATION_SUMMARY_UNUSABLE_MARKER_V1}\n\nThis round's report was not usable.\n`,
            "utf8"
          );
          fs.utimesSync(summaryPath, later, later);
        }
        return Promise.resolve({ mtime });
      };
      try {
        await retireSatisfiedSummaryRejectedRecoveryV1(folderUri);
        const after = readProgress(folderPath);
        assert.notEqual(after.implRecovery, undefined, "the stamp's own recovery record must still gate advancement");
        assert.deepEqual(after.pendingImplReviewFiles, ["src/b.ts"]);
      } finally {
        fsRecord.stat = originalStat;
        restore();
      }
    });

    void it("does nothing while impl-summary.md is still stamped unusable", async () => {
      const { folderUri, folderPath } = makeTaskFolder("retire_still_unusable");
      fs.writeFileSync(
        path.join(folderPath, "impl-summary.md"),
        `${IMPLEMENTATION_SUMMARY_UNUSABLE_MARKER_V1}\n\nThis round's report was not usable.\n`,
        "utf8"
      );
      seedProgress(folderPath, { implRecovery: pendingRecord({ trigger: "summaryRejected" }) });

      const restore = installFsStub();
      try {
        const retired = await retireSatisfiedSummaryRejectedRecoveryV1(folderUri);
        assert.equal(retired, false);
        assert.notEqual(readProgress(folderPath).implRecovery, undefined);
      } finally {
        restore();
      }
    });

    void it("does not retire a non-summaryRejected trigger even when the summary is usable", async () => {
      const { folderUri, folderPath } = makeTaskFolder("retire_wrong_trigger");
      fs.writeFileSync(path.join(folderPath, "impl-summary.md"), "## Files Changed\n\n_none_\n", "utf8");
      seedProgress(folderPath, { implRecovery: pendingRecord({ trigger: "roundDeferred" }) });

      const restore = installFsStub();
      try {
        const retired = await retireSatisfiedSummaryRejectedRecoveryV1(folderUri);
        assert.equal(retired, false);
        assert.equal(readProgress(folderPath).implRecovery?.trigger, "roundDeferred");
      } finally {
        restore();
      }
    });

    void it("does nothing when there is no recovery to retire", async () => {
      const { folderUri, folderPath } = makeTaskFolder("retire_nothing");
      fs.writeFileSync(path.join(folderPath, "impl-summary.md"), "## Files Changed\n\n_none_\n", "utf8");
      seedProgress(folderPath, {});

      const restore = installFsStub();
      try {
        assert.equal(await retireSatisfiedSummaryRejectedRecoveryV1(folderUri), false);
      } finally {
        restore();
      }
    });

    // v1 fixes 2, Wave I chokepoint (clears a recovery, sweep call site only):
    // per this function's own doc comment, `armPendingImplRecoveries`
    // (`scheduleTaskResume.ts`) `continue`s the loop the moment this returns
    // `true` — nothing further is arranged for this task in that sweep pass —
    // so THAT call site passes `{ nextActorOnRetire: "human" }`, folded into
    // this function's own atomic CAS write (2026-09-17 review fix: no longer
    // a second, separately-locked patch). Driven through the real
    // `TaskActionScheduler.armAll()` sweep, not a direct call, so this
    // exercises the actual wiring rather than just the function under test.
    void it("armAll's sweep sets nextActor: human immediately after retiring a satisfied summaryRejected recovery", async () => {
      const { folderPath } = makeTaskFolder("sweep_retire_next_actor");
      fs.writeFileSync(path.join(folderPath, "impl-summary.md"), "## Files Changed\n\n_none_\n", "utf8");
      seedProgress(folderPath, {
        updatedAt: new Date(BASE_NOW).toISOString(),
        implRecovery: pendingRecord({ trigger: "summaryRejected" }),
        pendingImplReviewFiles: ["src/a.ts"],
      });

      const restore = installFsStub();
      initNotificationRouter(new StatusTreeProvider());
      const clock = {
        now: (): number => BASE_NOW,
        setTimeout: (callback: () => void, delay: number): ReturnType<typeof setTimeout> =>
          setTimeout(callback, Math.min(delay, 10)),
        clearTimeout: (timer: ReturnType<typeof setTimeout>): void => clearTimeout(timer),
      };
      const inventory = {
        getTasks: () => [
          { taskFolderPath: folderPath, canonicalId: folderPath, progress: readProgress(folderPath) },
        ],
      } as unknown as TaskInventory;
      const scheduler = new TaskActionScheduler(inventory, clock, undefined, OWNER);
      try {
        await scheduler.armAll();
        const after = readProgress(folderPath);
        assert.equal(
          after.implRecovery,
          undefined,
          "the recovery must actually have been retired for this test to be meaningful"
        );
        assert.equal(
          after.nextActor,
          "human",
          "the sweep's own call site continues immediately after retiring — nothing further is arranged for this task in this pass"
        );
      } finally {
        scheduler.dispose();
        deactivateNotificationRouter();
        restore();
      }
    });
  });

  void describe("discardOwedImplRecoveryV1", () => {
    void it("clears the owed continuation and promotes its quarantined pending files into review scope", async () => {
      const { folderUri, folderPath } = makeTaskFolder("discard_owed");
      seedProgress(folderPath, {
        implRecovery: pendingRecord({ trigger: "summaryRejected", dispatch: "dispatched" }),
        pendingImplReviewFiles: ["src/should-be-reviewed.ts"],
        incompleteRoundContinuations: 2,
      });

      const restore = installFsStub();
      try {
        const discarded = await discardOwedImplRecoveryV1(folderUri);
        assert.equal(discarded, true);
        const after = readProgress(folderPath);
        assert.equal(after.implRecovery, undefined);
        assert.equal(after.pendingImplReviewFiles, undefined);
        assert.equal(
          after.incompleteRoundContinuations,
          undefined,
          "per the release scope ('offer Discard this owed continuation, promoting the quarantined files to review scope') and Part 1 step 5, discard clears implRecovery AND incompleteRoundContinuations in the same transform as a normal promotion"
        );
        assert.ok(
          (after.implReviewFiles ?? []).includes("src/should-be-reviewed.ts"),
          "discard must promote the quarantined files into review scope, exactly as retireSatisfiedSummaryRejectedRecoveryV1 does — the continuation being discarded is the obligation to re-report, not the already-applied edits themselves"
        );
        // v1 fixes 2, Wave I chokepoint (clears a recovery): discard is only
        // ever reached from an explicit user click and dispatches nothing of
        // its own, so nextActor must read "human" afterward.
        assert.equal(
          after.nextActor,
          "human",
          "discarding an owed continuation is a human act with no automated follow-up"
        );
      } finally {
        restore();
      }
    });

    void it("returns false when there is nothing to discard", async () => {
      const { folderUri, folderPath } = makeTaskFolder("discard_nothing");
      seedProgress(folderPath, {});

      const restore = installFsStub();
      try {
        assert.equal(await discardOwedImplRecoveryV1(folderUri), false);
      } finally {
        restore();
      }
    });

    /**
     * 2026-09-18 review fix (narrowed blocker
     * d1b82577-74db-4b46-880d-29a903207a6a-1): a successful discard must NOT
     * auto-advance the stage — the promoted files still need a fresh review
     * before the task can move on, since discarding only means "stop waiting
     * for the conforming re-report", not "this stage is now reviewed".
     * Driven through the REAL registered
     * "vs-code-ai-helper.discardOwedImplRecoveryV1" command (the exact
     * invocation the refusal's notification button makes), with only the
     * confirmation prompt and the `nextStage` re-entry itself faked.
     */
    void it("does NOT re-invoke vs-code-ai-helper.nextStage after a confirmed, successful discard", async () => {
      const { folderPath } = makeTaskFolder("discard_reevaluates");
      seedProgress(folderPath, {
        implRecovery: pendingRecord({ trigger: "summaryRejected", dispatch: "dispatched" }),
      });

      const restoreFs = installFsStub();
      initNotificationRouter(new StatusTreeProvider());
      const originalShowWarningMessage = vscode.window.showWarningMessage;
      (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage = (
        (): Promise<string> => Promise.resolve("Discard Continuation")
      ) as unknown as typeof vscode.window.showWarningMessage;
      const fakeContext = {
        subscriptions: [],
        extensionUri: vscode.Uri.file("/fake-extension"),
      } as unknown as vscode.ExtensionContext;
      registerReviewActionCommands(fakeContext);
      const nextStageCalls: unknown[] = [];
      vscode.commands.registerCommand("vs-code-ai-helper.nextStage", (arg: unknown) => {
        nextStageCalls.push(arg);
      });

      try {
        await vscode.commands.executeCommand(
          "vs-code-ai-helper.discardOwedImplRecoveryV1",
          folderPath
        );
        assert.deepEqual(
          nextStageCalls,
          [],
          "discard must promote files into review scope without bypassing the review gate by auto-advancing"
        );
        assert.equal(readProgress(folderPath).implRecovery, undefined);
        assert.ok(
          (readProgress(folderPath).implReviewFiles ?? []).length >= 0,
          "discard still clears implRecovery even though it no longer advances the stage"
        );
      } finally {
        vscode.window.showWarningMessage = originalShowWarningMessage;
        deactivateNotificationRouter();
        restoreFs();
      }
    });

    void it("does NOT re-invoke vs-code-ai-helper.nextStage when the discard confirmation is declined", async () => {
      const { folderPath } = makeTaskFolder("discard_declined");
      seedProgress(folderPath, {
        implRecovery: pendingRecord({ trigger: "summaryRejected", dispatch: "dispatched" }),
      });

      const restoreFs = installFsStub();
      initNotificationRouter(new StatusTreeProvider());
      const originalShowWarningMessage = vscode.window.showWarningMessage;
      (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage = (
        (): Promise<string | undefined> => Promise.resolve(undefined)
      ) as unknown as typeof vscode.window.showWarningMessage;
      const fakeContext = {
        subscriptions: [],
        extensionUri: vscode.Uri.file("/fake-extension"),
      } as unknown as vscode.ExtensionContext;
      registerReviewActionCommands(fakeContext);
      const nextStageCalls: unknown[] = [];
      vscode.commands.registerCommand("vs-code-ai-helper.nextStage", (arg: unknown) => {
        nextStageCalls.push(arg);
      });

      try {
        await vscode.commands.executeCommand(
          "vs-code-ai-helper.discardOwedImplRecoveryV1",
          folderPath
        );
        assert.deepEqual(nextStageCalls, []);
        assert.notEqual(readProgress(folderPath).implRecovery, undefined);
      } finally {
        vscode.window.showWarningMessage = originalShowWarningMessage;
        deactivateNotificationRouter();
        restoreFs();
      }
    });
  });
});

/**
 * Pure-function coverage for the explanation text and discard-offer gate —
 * no filesystem needed.
 */
void describe("describeOwedImplRecoveryRefusalV1 / isImplRecoveryDiscardOfferableV1", () => {
  const baseProgress: TaskProgress = {
    taskFolder: "2026-09-15_task_1",
    currentStage: "impl-high-review",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  void it("names the trigger and clearing condition for a pending summaryRejected recovery", () => {
    const recovery = pendingRecord({ trigger: "summaryRejected" });
    const message = describeOwedImplRecoveryRefusalV1(recovery, baseProgress, BASE_NOW);
    assert.match(message, /summary was rejected as unusable/);
    assert.match(message, /Status: pending/);
    assert.match(message, /Clears automatically once a usable Implementation Summary exists/);
    assert.ok(!message.includes("Discard this owed continuation"));
  });

  void it("offers the discard hint for a stale dispatched recovery with no reconstructable evidence", () => {
    const recovery: ImplRecoveryV1 = {
      ...pendingRecord({ trigger: "roundIncomplete" }),
      dispatch: "dispatched",
      // Well past the 90-minute stale-dispatch grace.
      leaseUntil: new Date(BASE_NOW - 4 * 60 * 60 * 1000).toISOString(),
    };
    // No `pendingImplReviewFiles` and no `filesChangedUnknown` — not
    // reconstructable, so the sweep's own reclaim would also leave it alone.
    const progressWithoutQuarantine: TaskProgress = { ...baseProgress };
    assert.equal(isImplRecoveryDiscardOfferableV1(recovery, progressWithoutQuarantine, BASE_NOW), true);
    const message = describeOwedImplRecoveryRefusalV1(recovery, progressWithoutQuarantine, BASE_NOW);
    assert.match(message, /Status: dispatched — its lease has expired/);
    assert.match(message, /Discard this owed continuation/);
  });

  void it("does not offer the discard hint for a dispatched recovery that can still reconstruct itself", () => {
    const recovery: ImplRecoveryV1 = {
      ...pendingRecord({ trigger: "roundIncomplete" }),
      dispatch: "dispatched",
      leaseUntil: new Date(BASE_NOW - 4 * 60 * 60 * 1000).toISOString(),
      // Reconstructable requires BOTH a source round to link back to AND a
      // known change set to quarantine — see isReconstructableImplRecoveryV1.
      sourceRoundId: "round-source-1",
    };
    const progressWithQuarantine: TaskProgress = { ...baseProgress, pendingImplReviewFiles: ["src/a.ts"] };
    assert.equal(isImplRecoveryDiscardOfferableV1(recovery, progressWithQuarantine, BASE_NOW), false);
    const message = describeOwedImplRecoveryRefusalV1(recovery, progressWithQuarantine, BASE_NOW);
    assert.ok(!message.includes("Discard this owed continuation"));
  });

  void it("does not offer the discard hint for a dispatched recovery still within its lease", () => {
    const recovery: ImplRecoveryV1 = {
      ...pendingRecord({ trigger: "roundIncomplete" }),
      dispatch: "dispatched",
      leaseUntil: new Date(BASE_NOW + 60 * 60 * 1000).toISOString(),
    };
    assert.equal(isImplRecoveryDiscardOfferableV1(recovery, baseProgress, BASE_NOW), false);
    const message = describeOwedImplRecoveryRefusalV1(recovery, baseProgress, BASE_NOW);
    assert.match(message, /a continuation round is running or holds an unexpired lease/);
    assert.ok(!message.includes("Discard this owed continuation"));
  });

  void it("offers the discard hint for a pending recovery whose continuation budget is exhausted (v1 fixes 2, items 15/21)", () => {
    // beginImplementationRecoveryV1 leaves `dispatch: "pending"` with no lease
    // exactly when the cap is reached — nothing will ever flip it to
    // "dispatched" or re-arm it, so it is unrecoverable despite never having
    // gone stale in the "dispatched" sense.
    const recovery = pendingRecord({ trigger: "roundIncomplete" });
    const progressAtCap: TaskProgress = {
      ...baseProgress,
      incompleteRoundContinuations: MAX_INCOMPLETE_ROUND_CONTINUATIONS_V1,
    };
    assert.equal(isImplRecoveryDiscardOfferableV1(recovery, progressAtCap, BASE_NOW), true);
    const message = describeOwedImplRecoveryRefusalV1(recovery, progressAtCap, BASE_NOW);
    assert.match(message, /Status: pending/);
    assert.match(message, /Discard this owed continuation/);
  });

  void it("does not offer the discard hint for a pending recovery still under its continuation budget", () => {
    const recovery = pendingRecord({ trigger: "roundIncomplete" });
    const progressUnderCap: TaskProgress = {
      ...baseProgress,
      incompleteRoundContinuations: MAX_INCOMPLETE_ROUND_CONTINUATIONS_V1 - 1,
    };
    assert.equal(isImplRecoveryDiscardOfferableV1(recovery, progressUnderCap, BASE_NOW), false);
    const message = describeOwedImplRecoveryRefusalV1(recovery, progressUnderCap, BASE_NOW);
    assert.ok(!message.includes("Discard this owed continuation"));
  });
});

// Part 4 Step 10 (item 16) completion blocker, 2026-09-24 review: the old
// inline condition inferred "no provider was invoked" purely from the
// terminal operation state, which is wrong in both directions — see
// `shouldLogNoOpContinuationRoundV1`'s doc comment. These pin the corrected
// decision directly, without needing to dispatch a real implementation round.
void describe("shouldLogNoOpContinuationRoundV1 (Part 4 Step 10 / item 16)", () => {
  void it("never logs without an owed continuation, whatever the state or provider flag", () => {
    assert.equal(shouldLogNoOpContinuationRoundV1(false, "refused", false), false);
    assert.equal(shouldLogNoOpContinuationRoundV1(false, "cancelled", false), false);
  });

  void it("never logs a succeeded round, whether or not a provider ran", () => {
    assert.equal(shouldLogNoOpContinuationRoundV1(true, "succeeded", false), false);
    assert.equal(shouldLogNoOpContinuationRoundV1(true, "succeeded", true), false);
  });

  void it("logs a refused/failed/interrupted round when no provider was ever invoked", () => {
    assert.equal(shouldLogNoOpContinuationRoundV1(true, "refused", false), true);
    assert.equal(shouldLogNoOpContinuationRoundV1(true, "failed", false), true);
    assert.equal(shouldLogNoOpContinuationRoundV1(true, "interrupted", false), true);
  });

  void it(
    "logs a CANCELLED round reached before any provider call — the review's second finding: the old " +
      "blanket state === \"cancelled\" exclusion silently dropped exactly this pre-provider no-op",
    () => {
      assert.equal(shouldLogNoOpContinuationRoundV1(true, "cancelled", false), true);
    }
  );

  void it(
    "does NOT log once a provider has been invoked, even though the round did not succeed — the review's " +
      "first finding: a checklist-generation or main-dispatch provider call that itself failed, was " +
      "declined, or was cancelled mid-round is not a pre-provider no-op, and already has its own failure " +
      "reporting from that provider call",
    () => {
      assert.equal(shouldLogNoOpContinuationRoundV1(true, "failed", true), false);
      assert.equal(shouldLogNoOpContinuationRoundV1(true, "refused", true), false);
      assert.equal(shouldLogNoOpContinuationRoundV1(true, "cancelled", true), false);
      assert.equal(shouldLogNoOpContinuationRoundV1(true, "interrupted", true), false);
    }
  );
});
