/**
 * Coverage for A1's watchdog predicate (`taskWatchdogV1.ts`, 1.0.0 gate):
 * `isImpossibleActiveStateV1` must return `true` for exactly one evidence
 * combination — `status: active`, no open round-ledger row, no `implRecovery`,
 * no `scheduledRun`/`scheduledResumeTime`, and no live scheduling intent —
 * and `false` for every other combination. The scheduler-level wiring
 * (pausing a task the predicate flags, and doing so idempotently) is covered
 * end to end in `scheduleTaskResume.test.ts`; this file isolates the pure
 * predicate so every evidence combination can be enumerated directly.
 */
import * as assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  STALE_DISPATCH_GRACE_MS,
  hasOpenRoundLedgerRowV1,
  isImpossibleActiveStateV1,
  isReconstructableImplRecoveryV1,
  isStaleDispatchedImplRecoveryV1,
  isUnrecoverableImplRecoveryV1,
} from "../utils/taskWatchdogV1";
import { ImplRecoveryV1, RoundLedgerEntryV1, TaskProgress } from "../types/taskProgress";
import { __extensionContextV1TestOnly, getExtensionContextV1 } from "../utils/extensionContextV1";
import { SchedulingIntentStoreV1 } from "../state/schedulingIntentV1";

function baseProgress(overrides: Partial<TaskProgress> = {}): TaskProgress {
  return {
    taskFolder: "task",
    currentStage: "impl",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function openRow(state: RoundLedgerEntryV1["state"]): RoundLedgerEntryV1 {
  return {
    roundId: "round-1",
    attemptIds: [],
    stage: "impl",
    mode: "implementation",
    startedAt: "2026-01-01T00:00:00.000Z",
    state,
  };
}

function installFakeMemento(): { restore: () => void } {
  const values = new Map<string, unknown>();
  const memento = {
    get<T>(key: string, defaultValue: T): T {
      return (values.has(key) ? values.get(key) : defaultValue) as T;
    },
    update(key: string, value: unknown): Promise<void> {
      values.set(key, value);
      return Promise.resolve();
    },
  } as unknown as import("vscode").Memento;
  __extensionContextV1TestOnly.set({ workspaceState: memento } as unknown as import("vscode").ExtensionContext);
  return { restore: (): void => __extensionContextV1TestOnly.reset() };
}

void describe("hasOpenRoundLedgerRowV1", () => {
  void it("is false with no roundLedger at all", () => {
    assert.equal(hasOpenRoundLedgerRowV1(baseProgress()), false);
  });

  void it("is true for a 'scheduled' or 'open' row, false for every terminal state", () => {
    assert.equal(hasOpenRoundLedgerRowV1(baseProgress({ roundLedger: [openRow("scheduled")] })), true);
    assert.equal(hasOpenRoundLedgerRowV1(baseProgress({ roundLedger: [openRow("open")] })), true);
    for (const state of ["completed", "rejected", "cancelled", "failed", "quota-blocked", "dropped", "interrupted"] as const) {
      assert.equal(hasOpenRoundLedgerRowV1(baseProgress({ roundLedger: [openRow(state)] })), false, `state ${state} must not read as open`);
    }
  });
});

void describe("isImpossibleActiveStateV1 — the watchdog predicate's determinism matrix", () => {
  let fakeContext: { restore: () => void };
  before(() => { fakeContext = installFakeMemento(); });
  after(() => { fakeContext.restore(); });

  void it("is true only when EVERY exempting condition is absent", () => {
    assert.equal(
      isImpossibleActiveStateV1({ progress: baseProgress(), taskCanonicalId: "task-a" }),
      true
    );
  });

  void it("is false for a non-active status, regardless of everything else", () => {
    for (const status of ["paused", "completed", "creating"] as const) {
      assert.equal(
        isImpossibleActiveStateV1({ progress: baseProgress({ status }), taskCanonicalId: "task-a" }),
        false,
        `status ${status} must exempt`
      );
    }
  });

  void it("is false with an open round-ledger row", () => {
    assert.equal(
      isImpossibleActiveStateV1({
        progress: baseProgress({ roundLedger: [openRow("open")] }),
        taskCanonicalId: "task-a",
      }),
      false
    );
  });

  void it("is false with a pending implRecovery, regardless of age", () => {
    assert.equal(
      isImpossibleActiveStateV1({
        progress: baseProgress({
          implRecovery: {
            sourceAttemptId: "x",
            reason: "x",
            trigger: "roundIncomplete",
            mode: "unconstrained",
            dispatch: "pending",
            at: "2026-01-01T00:00:00.000Z",
          },
        }),
        taskCanonicalId: "task-a",
        now: Date.parse("2026-06-01T00:00:00.000Z"),
      }),
      false,
      "a pending record is owed work about to be armed by the sweep"
    );
  });

  void it("is false with a dispatched implRecovery still within the stale-dispatch grace window", () => {
    const at = "2026-01-01T00:00:00.000Z";
    const now = Date.parse(at) + STALE_DISPATCH_GRACE_MS - 1000;
    assert.equal(
      isImpossibleActiveStateV1({
        progress: baseProgress({
          implRecovery: {
            sourceAttemptId: "x",
            reason: "x",
            trigger: "roundIncomplete",
            mode: "unconstrained",
            dispatch: "dispatched",
            at,
          },
        }),
        taskCanonicalId: "task-a",
        now,
      }),
      false,
      "a dispatched record still within grace may legitimately be running the full CLI timeout elsewhere"
    );
  });

  void it("is false with a stale dispatched implRecovery that is still reconstructable — the sweep will reclaim it next", () => {
    const at = "2026-01-01T00:00:00.000Z";
    const now = Date.parse(at) + STALE_DISPATCH_GRACE_MS + 1000;
    assert.equal(
      isImpossibleActiveStateV1({
        progress: baseProgress({
          pendingImplReviewFiles: ["src/a.ts"],
          implRecovery: {
            sourceAttemptId: "x",
            reason: "x",
            trigger: "roundIncomplete",
            mode: "unconstrained",
            dispatch: "dispatched",
            at,
            sourceRoundId: "round-1",
          },
        }),
        taskCanonicalId: "task-a",
        now,
      }),
      false,
      "stale-but-reconstructable is about to recover, not stuck"
    );
  });

  void it("is TRUE with a stale dispatched implRecovery that has lost its reconstructability evidence — A1's second route", () => {
    const at = "2026-01-01T00:00:00.000Z";
    const now = Date.parse(at) + STALE_DISPATCH_GRACE_MS + 1000;
    assert.equal(
      isImpossibleActiveStateV1({
        progress: baseProgress({
          implRecovery: {
            sourceAttemptId: "x",
            reason: "x",
            trigger: "roundIncomplete",
            mode: "unconstrained",
            dispatch: "dispatched",
            at,
          },
        }),
        taskCanonicalId: "task-a",
        now,
      }),
      true,
      "no source round or quarantined file set — nothing can bring this back automatically"
    );
  });

  void it("is false with a scheduledRun or a scheduledResumeTime", () => {
    assert.equal(
      isImpossibleActiveStateV1({
        progress: baseProgress({ scheduledRun: { runAt: "2026-01-02T00:00:00.000Z", stage: "impl" } }),
        taskCanonicalId: "task-a",
      }),
      false
    );
    assert.equal(
      isImpossibleActiveStateV1({
        progress: baseProgress({ scheduledResumeTime: "2026-01-02T00:00:00.000Z" }),
        taskCanonicalId: "task-a",
      }),
      false
    );
  });

  void it("is false with a live scheduling-intent entry, and returns to true once it clears", async () => {
    const context = getExtensionContextV1();
    assert.ok(context, "fake context must be installed");
    const store = new SchedulingIntentStoreV1(context.workspaceState);
    const entry = await store.recordScheduled({
      taskCanonicalId: "task-live",
      command: "x.review",
      chainId: "auto-review",
      trigger: "test",
      willRetry: false,
    });
    assert.equal(
      isImpossibleActiveStateV1({ progress: baseProgress(), taskCanonicalId: "task-live" }),
      false,
      "a scheduled scheduling-intent entry must exempt"
    );
    await store.recordTerminal(entry.intentId, "completed");
    assert.equal(
      isImpossibleActiveStateV1({ progress: baseProgress(), taskCanonicalId: "task-live" }),
      true,
      "once the entry is terminal, the predicate must fire again"
    );
  });

  void it("fails open (never fires) when the scheduling-intent context is unavailable", () => {
    fakeContext.restore();
    try {
      assert.equal(
        isImpossibleActiveStateV1({ progress: baseProgress(), taskCanonicalId: "task-indeterminate" }),
        false,
        "indeterminate scheduling-intent evidence must never be read as 'definitely nothing scheduled'"
      );
    } finally {
      fakeContext = installFakeMemento();
    }
  });

  void it("is idempotent: evaluating twice against the same unchanged progress gives the same answer", () => {
    const progress = baseProgress();
    const first = isImpossibleActiveStateV1({ progress, taskCanonicalId: "task-b" });
    const second = isImpossibleActiveStateV1({ progress, taskCanonicalId: "task-b" });
    assert.equal(first, second);
    assert.equal(first, true);
  });
});

void describe("stale-dispatch + reconstructability evidence — the single definition shared by the sweep and the watchdog", () => {
  const at = "2026-01-01T00:00:00.000Z";
  const withinGrace = Date.parse(at) + STALE_DISPATCH_GRACE_MS - 1000;
  const pastGrace = Date.parse(at) + STALE_DISPATCH_GRACE_MS + 1000;

  function dispatchedRecovery(overrides: Partial<ImplRecoveryV1> = {}): ImplRecoveryV1 {
    return {
      sourceAttemptId: "x",
      reason: "x",
      trigger: "roundIncomplete",
      mode: "unconstrained",
      dispatch: "dispatched",
      at,
      ...overrides,
    };
  }

  void it("isStaleDispatchedImplRecoveryV1 is false for a pending record regardless of age", () => {
    const pending: ImplRecoveryV1 = { ...dispatchedRecovery(), dispatch: "pending" };
    assert.equal(isStaleDispatchedImplRecoveryV1(pending, pastGrace), false);
  });

  void it("isStaleDispatchedImplRecoveryV1 anchors on leaseUntil when present, else at", () => {
    assert.equal(isStaleDispatchedImplRecoveryV1(dispatchedRecovery(), withinGrace), false);
    assert.equal(isStaleDispatchedImplRecoveryV1(dispatchedRecovery(), pastGrace), true);
    const laterLease = dispatchedRecovery({ leaseUntil: "2026-01-01T05:00:00.000Z" });
    assert.equal(
      isStaleDispatchedImplRecoveryV1(laterLease, pastGrace),
      false,
      "a later leaseUntil moves the anchor forward, so the same 'now' is no longer past grace"
    );
  });

  void it("isReconstructableImplRecoveryV1 requires sourceRoundId AND (pendingImplReviewFiles OR filesChangedUnknown)", () => {
    const noEvidence = dispatchedRecovery();
    assert.equal(isReconstructableImplRecoveryV1(noEvidence, baseProgress()), false);

    const roundOnly = dispatchedRecovery({ sourceRoundId: "round-1" });
    assert.equal(
      isReconstructableImplRecoveryV1(roundOnly, baseProgress()),
      false,
      "a round id alone with no known file set is still not enough to safely re-arm"
    );

    const roundAndFiles = dispatchedRecovery({ sourceRoundId: "round-1" });
    assert.equal(
      isReconstructableImplRecoveryV1(roundAndFiles, baseProgress({ pendingImplReviewFiles: ["a.ts"] })),
      true
    );

    const roundAndExplicitUnknown = dispatchedRecovery({ sourceRoundId: "round-1", filesChangedUnknown: true });
    assert.equal(
      isReconstructableImplRecoveryV1(roundAndExplicitUnknown, baseProgress()),
      true,
      "an explicit 'unknown' admission is still a recorded fact, not silent absence"
    );
  });

  void it("isUnrecoverableImplRecoveryV1 — the determinism matrix (stale x reconstructable)", () => {
    const progressWithFiles = baseProgress({ pendingImplReviewFiles: ["a.ts"] });
    const reconstructable = dispatchedRecovery({ sourceRoundId: "round-1" });
    const bare = dispatchedRecovery();

    // not stale, reconstructable -> not unrecoverable
    assert.equal(isUnrecoverableImplRecoveryV1(reconstructable, progressWithFiles, withinGrace), false);
    // not stale, not reconstructable -> not unrecoverable (staleness gates first)
    assert.equal(isUnrecoverableImplRecoveryV1(bare, baseProgress(), withinGrace), false);
    // stale, reconstructable -> not unrecoverable (the sweep will reclaim it)
    assert.equal(isUnrecoverableImplRecoveryV1(reconstructable, progressWithFiles, pastGrace), false);
    // stale, not reconstructable -> unrecoverable, the only true cell
    assert.equal(isUnrecoverableImplRecoveryV1(bare, baseProgress(), pastGrace), true);
  });
});
