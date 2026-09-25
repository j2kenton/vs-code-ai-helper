/**
 * Coverage for `roundProcessRecordV1.ts` — recording a round's provider CLI
 * processes next to its admission lock (1.0 RC1, Part B, item 2, "Recording
 * and stopping provider CLI processes"). Mirrors `roundLeaseV1.test.ts`'s
 * fake `ExtensionContext` pattern.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import {
  beginRoundProcessRecordingV1,
  clearRoundProcessesV1,
  listRoundProcessesV1,
  recordedClaimIdForTaskV1,
  recordRoundProcessV1,
  type RecordedProviderProcessV1,
} from "../state/roundProcessRecordV1";

function installFakeExtensionContextV1(): { restore: () => void; values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  const memento = {
    get<T>(key: string, defaultValue: T): T {
      return (values.has(key) ? values.get(key) : defaultValue) as T;
    },
    update(key: string, value: unknown): Promise<void> {
      if (value === undefined) {
        values.delete(key);
      } else {
        values.set(key, value);
      }
      return Promise.resolve();
    },
  } as unknown as import("vscode").Memento;
  __extensionContextV1TestOnly.set({ workspaceState: memento } as unknown as import("vscode").ExtensionContext);
  return { restore: (): void => __extensionContextV1TestOnly.reset(), values };
}

function makeProcess(overrides: Partial<RecordedProviderProcessV1> = {}): RecordedProviderProcessV1 {
  return {
    pid: 4242,
    processStartTime: Date.parse("2026-01-01T00:00:00.000Z"),
    providerId: "codex",
    providerLabel: "Codex CLI",
    command: "codex exec --json",
    recordedAt: Date.parse("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

const TASK_A = "/tasks/.ensemble/2026-01-01_task_1";
const TASK_B = "/tasks/.ensemble/2026-01-01_task_2";

void test("recordRoundProcessV1 makes a process appear in listRoundProcessesV1, in recorded order, and reports success", async () => {
  const fakeContext = installFakeExtensionContextV1();
  try {
    assert.deepEqual(listRoundProcessesV1(TASK_A), []);
    const first = makeProcess({ pid: 100 });
    const second = makeProcess({ pid: 200 });
    assert.equal(await recordRoundProcessV1(TASK_A, "claim-a", first), true);
    assert.equal(await recordRoundProcessV1(TASK_A, "claim-a", second), true);
    assert.deepEqual(listRoundProcessesV1(TASK_A), [first, second]);
    assert.equal(recordedClaimIdForTaskV1(TASK_A), "claim-a");
  } finally {
    fakeContext.restore();
  }
});

void test("recordRoundProcessV1 keeps separate tasks' records independent", async () => {
  const fakeContext = installFakeExtensionContextV1();
  try {
    await recordRoundProcessV1(TASK_A, "claim-a", makeProcess({ pid: 1 }));
    await recordRoundProcessV1(TASK_B, "claim-b", makeProcess({ pid: 2 }));
    assert.equal(listRoundProcessesV1(TASK_A).length, 1);
    assert.equal(listRoundProcessesV1(TASK_B).length, 1);
    assert.equal(listRoundProcessesV1(TASK_A)[0]?.pid, 1);
    assert.equal(listRoundProcessesV1(TASK_B)[0]?.pid, 2);
  } finally {
    fakeContext.restore();
  }
});

void test("separate tasks are stored under separate workspaceState keys, so no shared blob exists for concurrent different-task writes to race over", async () => {
  const fakeContext = installFakeExtensionContextV1();
  try {
    await recordRoundProcessV1(TASK_A, "claim-a", makeProcess({ pid: 1 }));
    await recordRoundProcessV1(TASK_B, "claim-b", makeProcess({ pid: 2 }));
    const keys = [...fakeContext.values.keys()];
    assert.equal(keys.length, 2);
    assert.notEqual(keys[0], keys[1]);
  } finally {
    fakeContext.restore();
  }
});

void test("concurrent recordRoundProcessV1 calls for two DIFFERENT tasks do not lose one another's writes (regression: a prior revision shared one map key across tasks)", async () => {
  const fakeContext = installFakeExtensionContextV1();
  try {
    // Interleave writes for TASK_A and TASK_B without awaiting between them,
    // so a shared-map implementation would have a chance to read stale state
    // for one task while the other's write is still in flight.
    await Promise.all([
      recordRoundProcessV1(TASK_A, "claim-a", makeProcess({ pid: 1 })),
      recordRoundProcessV1(TASK_B, "claim-b", makeProcess({ pid: 2 })),
      recordRoundProcessV1(TASK_A, "claim-a", makeProcess({ pid: 3 })),
      recordRoundProcessV1(TASK_B, "claim-b", makeProcess({ pid: 4 })),
    ]);
    assert.deepEqual(
      listRoundProcessesV1(TASK_A)
        .map((entry) => entry.pid)
        .sort((a, b) => a - b),
      [1, 3]
    );
    assert.deepEqual(
      listRoundProcessesV1(TASK_B)
        .map((entry) => entry.pid)
        .sort((a, b) => a - b),
      [2, 4]
    );
  } finally {
    fakeContext.restore();
  }
});

void test("clearRoundProcessesV1 removes every recorded process for a task", async () => {
  const fakeContext = installFakeExtensionContextV1();
  try {
    await recordRoundProcessV1(TASK_A, "claim-a", makeProcess());
    await recordRoundProcessV1(TASK_A, "claim-a", makeProcess({ pid: 2 }));
    assert.equal(listRoundProcessesV1(TASK_A).length, 2);
    await clearRoundProcessesV1(TASK_A);
    assert.deepEqual(listRoundProcessesV1(TASK_A), []);
    assert.equal(recordedClaimIdForTaskV1(TASK_A), undefined);
  } finally {
    fakeContext.restore();
  }
});

void test("a record has no time-based expiry: it survives arbitrarily long, simulating a lock held well past the old 90-minute TTL", async () => {
  const fakeContext = installFakeExtensionContextV1();
  try {
    const start = Date.parse("2026-01-01T00:00:00.000Z");
    let now = start;
    const realDateNow = Date.now;
    Date.now = (): number => now;
    try {
      await recordRoundProcessV1(TASK_A, "claim-crashed", makeProcess());
      assert.equal(listRoundProcessesV1(TASK_A).length, 1);
      // Well past the old ROUND_LEASE_TTL_MS (90 min) — the lock itself is
      // never automatically reclaimed either (workAdmissionV1.ts's interim
      // policy), so the process record recorded against it must not vanish
      // out from under a still-held lock.
      now = start + 4 * 60 * 60 * 1000;
      assert.equal(listRoundProcessesV1(TASK_A).length, 1);
    } finally {
      Date.now = realDateNow;
    }
  } finally {
    fakeContext.restore();
  }
});

void test("recordRoundProcessV1 for a new claimId on the same task replaces the previous generation's record rather than appending to it", async () => {
  const fakeContext = installFakeExtensionContextV1();
  try {
    await recordRoundProcessV1(TASK_A, "claim-1", makeProcess({ pid: 1 }));
    await recordRoundProcessV1(TASK_A, "claim-2", makeProcess({ pid: 2 }));
    const remaining = listRoundProcessesV1(TASK_A);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]?.pid, 2);
    assert.equal(recordedClaimIdForTaskV1(TASK_A), "claim-2");
  } finally {
    fakeContext.restore();
  }
});

void test("concurrent recordRoundProcessV1 calls for the same task do not lose one another's writes", async () => {
  const fakeContext = installFakeExtensionContextV1();
  try {
    await Promise.all(
      Array.from({ length: 10 }, (_, index) => recordRoundProcessV1(TASK_A, "claim-a", makeProcess({ pid: index })))
    );
    const recorded = listRoundProcessesV1(TASK_A);
    assert.equal(recorded.length, 10);
    assert.deepEqual(
      recorded.map((entry) => entry.pid).sort((a, b) => a - b),
      Array.from({ length: 10 }, (_, index) => index)
    );
  } finally {
    fakeContext.restore();
  }
});

void test("beginRoundProcessRecordingV1 records an empty process list for a fresh claim, turning 'no record' into a meaningful empty state", async () => {
  const fakeContext = installFakeExtensionContextV1();
  try {
    assert.equal(recordedClaimIdForTaskV1(TASK_A), undefined);
    assert.equal(await beginRoundProcessRecordingV1(TASK_A, "claim-a"), true);
    assert.equal(recordedClaimIdForTaskV1(TASK_A), "claim-a");
    assert.deepEqual(listRoundProcessesV1(TASK_A), []);
  } finally {
    fakeContext.restore();
  }
});

void test("beginRoundProcessRecordingV1 is idempotent for the same claim: it does not truncate processes already recorded", async () => {
  const fakeContext = installFakeExtensionContextV1();
  try {
    await beginRoundProcessRecordingV1(TASK_A, "claim-a");
    await recordRoundProcessV1(TASK_A, "claim-a", makeProcess({ pid: 1 }));
    assert.equal(await beginRoundProcessRecordingV1(TASK_A, "claim-a"), true);
    assert.equal(listRoundProcessesV1(TASK_A).length, 1);
  } finally {
    fakeContext.restore();
  }
});

void test("beginRoundProcessRecordingV1 for a new claim replaces a stale prior claim's record", async () => {
  const fakeContext = installFakeExtensionContextV1();
  try {
    await recordRoundProcessV1(TASK_A, "claim-1", makeProcess({ pid: 1 }));
    assert.equal(await beginRoundProcessRecordingV1(TASK_A, "claim-2"), true);
    assert.equal(recordedClaimIdForTaskV1(TASK_A), "claim-2");
    assert.deepEqual(listRoundProcessesV1(TASK_A), []);
  } finally {
    fakeContext.restore();
  }
});

void test("recordRoundProcessV1, listRoundProcessesV1, and clearRoundProcessesV1 are no-ops with no ExtensionContext installed (fail closed, never throws)", async () => {
  __extensionContextV1TestOnly.reset();
  assert.equal(await recordRoundProcessV1(TASK_A, "claim-x", makeProcess()), false);
  assert.equal(await beginRoundProcessRecordingV1(TASK_A, "claim-x"), false);
  assert.deepEqual(listRoundProcessesV1(TASK_A), []);
  await clearRoundProcessesV1(TASK_A);
});

void test("recordRoundProcessV1 does not throw when the workspaceState write itself rejects, and reports the failure back to the caller", async () => {
  const memento = {
    get<T>(_key: string, defaultValue: T): T {
      return defaultValue;
    },
    update(): Promise<void> {
      return Promise.reject(new Error("simulated workspaceState failure"));
    },
  } as unknown as import("vscode").Memento;
  __extensionContextV1TestOnly.set({ workspaceState: memento } as unknown as import("vscode").ExtensionContext);
  try {
    let succeeded: boolean | undefined;
    await assert.doesNotReject(async () => {
      succeeded = await recordRoundProcessV1(TASK_A, "claim-write-failed", makeProcess());
    });
    assert.equal(succeeded, false);
  } finally {
    __extensionContextV1TestOnly.reset();
  }
});
