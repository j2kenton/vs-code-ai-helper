/**
 * 1.0.0 gate, A4 (task "1.0.0 Gate", Part A): `ensemble.notifications` is a
 * Memento-backed array of exactly the same unbounded-growth shape as
 * `workflowDecisions`, whose overflow (331 records, 2.46 MB) was named as the
 * dominant contributor to a repeated OOM window termination measured
 * 2026-09-04. This file's own array was measured at 0.31 MB the same day —
 * not yet the dominant contributor, but unbounded in the identical way.
 * These tests lock in the cap added to `StatusTreeProvider`.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StatusTreeProvider } from "../views/statusView";

type Stored = Record<string, unknown>;

function memento(initial: Stored = {}): {
  get<T>(key: string, defaultValue?: T): T;
  update(key: string, value: unknown): Thenable<void>;
} {
  const store: Stored = { ...initial };
  return {
    get<T>(key: string, defaultValue?: T): T {
      return (store[key] as T | undefined) ?? (defaultValue as T);
    },
    update(key: string, value: unknown): Thenable<void> {
      store[key] = value;
      return Promise.resolve();
    },
  };
}

const MAX_STATUS_ENTRIES = 500;

void describe("StatusTreeProvider notification cap (1.0.0 gate A4)", () => {
  void it("bounds growth: adding well past the cap never leaves more than the cap persisted", () => {
    const state = memento();
    const provider = new StatusTreeProvider(state as never);
    try {
      for (let i = 0; i < MAX_STATUS_ENTRIES + 100; i += 1) {
        provider.addEntry(`entry ${i}`, "info");
      }
      assert.ok(
        provider.getEntries().length <= MAX_STATUS_ENTRIES,
        `in-memory entries (${provider.getEntries().length}) must never exceed the cap (${MAX_STATUS_ENTRIES})`
      );
      const persisted = state.get<unknown[]>("ensemble.notifications", []);
      assert.ok(
        persisted.length <= MAX_STATUS_ENTRIES,
        `persisted array (${persisted.length}) must never exceed the cap (${MAX_STATUS_ENTRIES})`
      );
      // Newest-first (unshift): the most recently added entry must survive,
      // the earliest ones must be the ones dropped.
      assert.equal(provider.getEntries()[0]?.message, `entry ${MAX_STATUS_ENTRIES + 99}`);
      assert.ok(
        !provider.getEntries().some((e) => e.message === "entry 0"),
        "the oldest entries must be trimmed once the cap is exceeded"
      );
    } finally {
      provider.dispose();
    }
  });

  void it("trims an already-oversized persisted array back to the cap on load", () => {
    const oversized = Array.from({ length: MAX_STATUS_ENTRIES + 50 }, (_, i) => ({
      message: `stale ${i}`,
      level: "info" as const,
      timestamp: new Date(Date.now() - i * 1000).toISOString(),
    }));
    const state = memento({ "ensemble.notifications": oversized });
    const provider = new StatusTreeProvider(state as never);
    try {
      assert.ok(
        provider.getEntries().length <= MAX_STATUS_ENTRIES,
        "a workspace whose stored array already exceeds the cap from before this fix must be bounded again on load"
      );
    } finally {
      provider.dispose();
    }
  });

  void it("trims interrupted-operation entries restored at load back to the cap, not just new persisted state", () => {
    // Review-narrowed blocker (2026-09-06): the constructor unshifts one
    // synthesized entry per interrupted operation AFTER already trimming the
    // loaded array to the cap, then persists unconditionally — a workspace
    // whose persisted array was already at (or near) the cap, restarted with
    // enough interrupted operations, could write more than the cap to disk.
    const atCap = Array.from({ length: MAX_STATUS_ENTRIES }, (_, i) => ({
      message: `existing ${i}`,
      level: "info" as const,
      timestamp: new Date(Date.now() - i * 1000).toISOString(),
    }));
    const interruptedCount = 10;
    const interrupted = Array.from({ length: interruptedCount }, (_, i) => ({
      id: `op-${i}`,
      key: `op-${i}`,
      label: `Operation ${i}`,
      taskName: "Task",
      stage: "impl",
      startedAt: Date.now(),
      exclusive: false,
      parentId: undefined,
      cancellable: false,
    }));
    const state = memento({
      "ensemble.notifications": atCap,
      "ensemble.runningOperations": interrupted,
    });
    const provider = new StatusTreeProvider(state as never);
    try {
      assert.ok(
        provider.getEntries().length <= MAX_STATUS_ENTRIES,
        `in-memory entries (${provider.getEntries().length}) must never exceed the cap after restoring interrupted operations`
      );
      const persisted = state.get<unknown[]>("ensemble.notifications", []);
      assert.ok(
        persisted.length <= MAX_STATUS_ENTRIES,
        `persisted array (${persisted.length}) must never exceed the cap once interrupted-operation entries are folded in`
      );
    } finally {
      provider.dispose();
    }
  });
});
