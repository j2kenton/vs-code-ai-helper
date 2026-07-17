import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StatusTreeProvider } from "../views/statusView";

type Stored = Record<string, unknown>;

function memento(initial: Stored): { get<T>(key: string, defaultValue?: T): T; update(key: string, value: unknown): Thenable<void> } {
  const store: Stored = { ...initial };
  return {
    get<T>(key: string, defaultValue?: T): T {
      return (store[key] as T | undefined) ?? defaultValue as T;
    },
    update(key: string, value: unknown): Thenable<void> {
      store[key] = value;
      return Promise.resolve();
    },
  };
}

void describe("operation reload recovery", () => {
  void it("converts a persisted root operation into one interrupted notification", async () => {
    const state = memento({
      "ensemble.runningOperations": [{
        id: "op-8",
        key: "/workspace/.ensemble/2026-07-17_task_1",
        label: "Run Review",
        taskName: "2026-07-17_task_1",
        startedAt: Date.now() - 1_000,
        exclusive: true,
        cancellable: true,
        kind: "review",
      }],
    });
    const provider = new StatusTreeProvider(state as never);
    try {
      const entries = provider.getEntries();
      assert.equal(entries.length, 1);
      assert.equal(entries[0]?.level, "warning");
      assert.equal(entries[0]?.message, "Run Review — 2026-07-17_task_1: interrupted");
      await Promise.resolve();
      assert.deepEqual(state.get("ensemble.runningOperations", []), []);
    } finally {
      provider.dispose();
    }
  });
});
