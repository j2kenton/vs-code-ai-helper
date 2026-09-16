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
} from "../commands/implementationRecoveryV1";
import { IMPLEMENTATION_SUMMARY_UNUSABLE_MARKER_V1 } from "../utils/implementationArtifactResolver";
import { registerReviewActionCommands } from "../commands/reviewActions";

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
  fs.rmSync(admissionTestRootV1, { recursive: true, force: true });
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
    fs.rmSync(ROOT, { recursive: true, force: true });
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
  });

  void describe("discardOwedImplRecoveryV1", () => {
    void it("clears the recovery record and its quarantined pending files WITHOUT promoting them into review scope", async () => {
      const { folderUri, folderPath } = makeTaskFolder("discard_owed");
      seedProgress(folderPath, {
        implRecovery: pendingRecord({ trigger: "summaryRejected", dispatch: "dispatched" }),
        pendingImplReviewFiles: ["src/should-not-be-reviewed.ts"],
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
          2,
          "discard removes only the recovery record and quarantined pending-review paths — the continuation budget counter is unrelated state and must survive so a future recovery cannot restart its budget from zero"
        );
        assert.ok(
          !(after.implReviewFiles ?? []).includes("src/should-not-be-reviewed.ts"),
          "a discarded continuation's files must never enter review scope — that is the difference from retiring"
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
     * Part 5 step 34's own wording: "record the action, and re-evaluate
     * advancement immediately" — a discard that only cleared state and left
     * the user to click "Complete Stage & Move On" a second time would still
     * be the friction the finding names as a dead end. Driven through the
     * REAL registered "vs-code-ai-helper.discardOwedImplRecoveryV1" command
     * (the exact invocation the refusal's notification button makes, per
     * reviewActions.ts's `nextStage` catch site), with only the confirmation
     * prompt and the `nextStage` re-entry itself faked — same shape as
     * restoreRejectedImplementationRound.test.ts's rerun-on-success wiring
     * tests for the analogous restore action.
     */
    void it("re-invokes vs-code-ai-helper.nextStage with {taskFolderPath} after a confirmed, successful discard", async () => {
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
        assert.deepEqual(nextStageCalls, [{ taskFolderPath: folderPath }]);
        assert.equal(readProgress(folderPath).implRecovery, undefined);
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
});
