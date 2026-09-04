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
  hasOpenRoundLedgerRowV1,
  isImpossibleActiveStateV1,
} from "../utils/taskWatchdogV1";
import { RoundLedgerEntryV1, TaskProgress } from "../types/taskProgress";
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

  void it("is false with an owed implRecovery, pending or dispatched", () => {
    for (const dispatch of ["pending", "dispatched"] as const) {
      assert.equal(
        isImpossibleActiveStateV1({
          progress: baseProgress({
            implRecovery: {
              sourceAttemptId: "x",
              reason: "x",
              trigger: "roundIncomplete",
              mode: "unconstrained",
              dispatch,
              at: "2026-01-01T00:00:00.000Z",
            },
          }),
          taskCanonicalId: "task-a",
        }),
        false,
        `dispatch ${dispatch} must exempt`
      );
    }
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
