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
import { afterEach, describe, it } from "node:test";
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
