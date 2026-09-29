/**
 * Coverage for `roundProcessRecordV1.ts` — recording a round's provider CLI
 * processes next to its admission lock (1.0 RC1, Part B, item 2, "Recording
 * and stopping provider CLI processes"). Mirrors `roundLeaseV1.test.ts`'s
 * fake `ExtensionContext` pattern.
 *
 * 2026-09-29 review (RC2 item 2 / Step 57a): storage moved from one shared
 * `workspaceState` key per task to one key per `(taskFolderPath, claimId)`
 * pair, so a claim's data can never be read or cleared through a DIFFERENT
 * claim's key — see the module doc comment. Several tests below were
 * rewritten from the old "a new claim replaces the previous one's record"
 * behavior to the new "each claim's record is fully independent" behavior,
 * and `recordedClaimIdForTaskV1` (which assumed one "current" claim per task)
 * is replaced by `hasRoundProcessRecordV1(taskFolderPath, claimId)`.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import {
  abandonProcessSpawnAttemptV1,
  beginProcessSpawnAttemptV1,
  beginRoundProcessRecordingV1,
  clearRoundProcessesForClaimV1,
  clearRoundProcessesV1,
  hasRoundProcessRecordV1,
  listRoundProcessesV1,
  pendingSpawnInfoV1,
  recordRoundProcessV1,
  unconfirmedProcessSpawnCountV1,
  type RecordedProviderProcessV1,
} from "../state/roundProcessRecordV1";

/** A fake `Memento` backed by a plain `Map`, standing in for ONE VS Code
 * window's in-memory `workspaceState` cache. `keys()` mirrors the real
 * `vscode.Memento` interface (used by `clearRoundProcessesV1`'s enumeration). */
function makeFakeMementoV1(backing: Map<string, unknown>): import("vscode").Memento {
  return {
    get<T>(key: string, defaultValue: T): T {
      return (backing.has(key) ? backing.get(key) : defaultValue) as T;
    },
    update(key: string, value: unknown): Promise<void> {
      if (value === undefined) {
        backing.delete(key);
      } else {
        backing.set(key, value);
      }
      return Promise.resolve();
    },
    keys(): readonly string[] {
      return [...backing.keys()];
    },
  } as unknown as import("vscode").Memento;
}

function installFakeExtensionContextV1(): { restore: () => void; values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  __extensionContextV1TestOnly.set({ workspaceState: makeFakeMementoV1(values) } as unknown as import("vscode").ExtensionContext);
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
    assert.deepEqual(listRoundProcessesV1(TASK_A, "claim-a"), []);
    const first = makeProcess({ pid: 100 });
    const second = makeProcess({ pid: 200 });
    assert.equal(await recordRoundProcessV1(TASK_A, "claim-a", first), true);
    assert.equal(await recordRoundProcessV1(TASK_A, "claim-a", second), true);
    assert.deepEqual(listRoundProcessesV1(TASK_A, "claim-a"), [first, second]);
    assert.equal(hasRoundProcessRecordV1(TASK_A, "claim-a"), true);
  } finally {
    fakeContext.restore();
  }
});

void test("recordRoundProcessV1 keeps separate tasks' records independent", async () => {
  const fakeContext = installFakeExtensionContextV1();
  try {
    await recordRoundProcessV1(TASK_A, "claim-a", makeProcess({ pid: 1 }));
    await recordRoundProcessV1(TASK_B, "claim-b", makeProcess({ pid: 2 }));
    assert.equal(listRoundProcessesV1(TASK_A, "claim-a").length, 1);
    assert.equal(listRoundProcessesV1(TASK_B, "claim-b").length, 1);
    assert.equal(listRoundProcessesV1(TASK_A, "claim-a")[0]?.pid, 1);
    assert.equal(listRoundProcessesV1(TASK_B, "claim-b")[0]?.pid, 2);
  } finally {
    fakeContext.restore();
  }
});

void test("separate (task, claim) pairs are stored under separate workspaceState keys, so no shared blob exists for concurrent writes to race over", async () => {
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

void test("two DIFFERENT claims under the SAME task are also stored under separate keys (the exact partition the 2026-09-29 review required)", async () => {
  const fakeContext = installFakeExtensionContextV1();
  try {
    await recordRoundProcessV1(TASK_A, "claim-a", makeProcess({ pid: 1 }));
    await recordRoundProcessV1(TASK_A, "claim-b", makeProcess({ pid: 2 }));
    const keys = [...fakeContext.values.keys()];
    assert.equal(keys.length, 2, "claim-a and claim-b must not share a storage key");
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
      listRoundProcessesV1(TASK_A, "claim-a")
        .map((entry) => entry.pid)
        .sort((a, b) => a - b),
      [1, 3]
    );
    assert.deepEqual(
      listRoundProcessesV1(TASK_B, "claim-b")
        .map((entry) => entry.pid)
        .sort((a, b) => a - b),
      [2, 4]
    );
  } finally {
    fakeContext.restore();
  }
});

void test("clearRoundProcessesV1 removes every claim's recorded processes for a task", async () => {
  const fakeContext = installFakeExtensionContextV1();
  try {
    await recordRoundProcessV1(TASK_A, "claim-a", makeProcess());
    await recordRoundProcessV1(TASK_A, "claim-a", makeProcess({ pid: 2 }));
    await recordRoundProcessV1(TASK_A, "claim-b", makeProcess({ pid: 3 }));
    assert.equal(listRoundProcessesV1(TASK_A, "claim-a").length, 2);
    await clearRoundProcessesV1(TASK_A);
    assert.deepEqual(listRoundProcessesV1(TASK_A, "claim-a"), []);
    assert.deepEqual(listRoundProcessesV1(TASK_A, "claim-b"), []);
    assert.equal(hasRoundProcessRecordV1(TASK_A, "claim-a"), false);
    assert.equal(hasRoundProcessRecordV1(TASK_A, "claim-b"), false);
  } finally {
    fakeContext.restore();
  }
});

void test("clearRoundProcessesV1 for one task never touches a DIFFERENT task's record", async () => {
  const fakeContext = installFakeExtensionContextV1();
  try {
    await recordRoundProcessV1(TASK_A, "claim-a", makeProcess({ pid: 1 }));
    await recordRoundProcessV1(TASK_B, "claim-b", makeProcess({ pid: 2 }));
    await clearRoundProcessesV1(TASK_A);
    assert.deepEqual(listRoundProcessesV1(TASK_A, "claim-a"), []);
    assert.deepEqual(
      listRoundProcessesV1(TASK_B, "claim-b").map((p) => p.pid),
      [2]
    );
  } finally {
    fakeContext.restore();
  }
});

void test("clearRoundProcessesForClaimV1 clears a matching claim's record", async () => {
  const fakeContext = installFakeExtensionContextV1();
  try {
    await recordRoundProcessV1(TASK_A, "claim-a", makeProcess());
    assert.equal(listRoundProcessesV1(TASK_A, "claim-a").length, 1);
    await clearRoundProcessesForClaimV1(TASK_A, "claim-a");
    assert.deepEqual(listRoundProcessesV1(TASK_A, "claim-a"), []);
    assert.equal(hasRoundProcessRecordV1(TASK_A, "claim-a"), false);
  } finally {
    fakeContext.restore();
  }
});

void test("clearRoundProcessesForClaimV1 leaves a DIFFERENT claim's record untouched (2026-09-29 review, RC2 item 2 / Step 57a: the successor-claim race)", async () => {
  const fakeContext = installFakeExtensionContextV1();
  try {
    // Simulates a stale caller (e.g. an owner-confirmed release for a claim
    // whose marker was already released and reacquired) that only learns
    // AFTER awaiting other work that a successor claim has since started its
    // own recording. Under the old task-level-key design a later claim's
    // record REPLACED the older one's at the same key, so a stale clear could
    // land on top of it; under per-claim keys, claim-a and claim-b were never
    // sharing a key in the first place — recording under claim-b never even
    // touched claim-a's own key.
    await recordRoundProcessV1(TASK_A, "claim-a", makeProcess({ pid: 1 }));
    await recordRoundProcessV1(TASK_A, "claim-b", makeProcess({ pid: 2 }));
    assert.deepEqual(
      listRoundProcessesV1(TASK_A, "claim-a").map((entry) => entry.pid),
      [1],
      "claim-a's own record must still exist independently of claim-b's"
    );

    await clearRoundProcessesForClaimV1(TASK_A, "claim-a");

    assert.equal(hasRoundProcessRecordV1(TASK_A, "claim-a"), false);
    assert.equal(
      hasRoundProcessRecordV1(TASK_A, "claim-b"),
      true,
      "a stale claim's clear must never erase a successor claim's own record"
    );
    assert.deepEqual(
      listRoundProcessesV1(TASK_A, "claim-b").map((entry) => entry.pid),
      [2]
    );
  } finally {
    fakeContext.restore();
  }
});

void test("cross-window regression: a stale window's clear for claim-a cannot erase claim-b's record even though the stale window's own cache never observed claim-b's write (2026-09-29 review, RC2 item 2 / Step 57a)", async () => {
  // Models two independent VS Code windows sharing one on-disk
  // `workspaceState` file: each window's Memento is backed by its OWN Map
  // (never directly shared, exactly like two separate extension-host
  // processes), and only an explicit "resync" (a fresh Map cloned from the
  // other window's Map) simulates what a NEW window reads at startup. A
  // currently-running window never resyncs on its own — matching
  // `hostDecisionMirrorV1.ts`'s documented "another VS Code process cannot
  // read the raising window's workspaceState" limitation.
  const windowADisk = new Map<string, unknown>();
  __extensionContextV1TestOnly.set({ workspaceState: makeFakeMementoV1(windowADisk) } as unknown as import("vscode").ExtensionContext);
  try {
    // Window A begins recording claim-a and appends one process — this is
    // the round A itself started.
    await beginRoundProcessRecordingV1(TASK_A, "claim-a");
    await recordRoundProcessV1(TASK_A, "claim-a", makeProcess({ pid: 111 }));

    // Window B is a SEPARATE window/process with its OWN cache, resynced
    // from disk at the moment it opens (here: cloned from window A's Map at
    // this instant, before claim-b exists). It then records ITS OWN claim
    // (b) — e.g. the owner reopened the task and a fresh round started after
    // window A's marker was released as stale.
    const windowBDisk = new Map<string, unknown>(windowADisk);
    __extensionContextV1TestOnly.set({ workspaceState: makeFakeMementoV1(windowBDisk) } as unknown as import("vscode").ExtensionContext);
    await beginRoundProcessRecordingV1(TASK_A, "claim-b");
    await recordRoundProcessV1(TASK_A, "claim-b", makeProcess({ pid: 222 }));

    // Window A resumes (its own cache still has no idea claim-b exists) and
    // — having finally confirmed its OWN claim-a process is gone — clears
    // claim-a's record. Deliberately do NOT resync window A's cache from
    // window B's write first: that is exactly the staleness the review
    // found unsafe to rely on.
    __extensionContextV1TestOnly.set({ workspaceState: makeFakeMementoV1(windowADisk) } as unknown as import("vscode").ExtensionContext);
    assert.equal(
      hasRoundProcessRecordV1(TASK_A, "claim-b"),
      false,
      "window A's own stale cache genuinely has no visibility into claim-b — this is the staleness being modeled"
    );
    await clearRoundProcessesForClaimV1(TASK_A, "claim-a");

    // A THIRD "reload" reads whatever is actually on window B's disk (the
    // one holding the real, current truth) — modeling a fresh window opened
    // afterward. Claim-b's record must have survived window A's clear,
    // because the key window A ever wrote to is claim-a's key alone.
    __extensionContextV1TestOnly.set({ workspaceState: makeFakeMementoV1(windowBDisk) } as unknown as import("vscode").ExtensionContext);
    assert.deepEqual(
      listRoundProcessesV1(TASK_A, "claim-b").map((p) => p.pid),
      [222],
      "claim-b's record, written through a window whose cache the stale clear never saw, must survive"
    );
  } finally {
    __extensionContextV1TestOnly.reset();
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
      assert.equal(listRoundProcessesV1(TASK_A, "claim-crashed").length, 1);
      // Well past the old ROUND_LEASE_TTL_MS (90 min) — the lock itself is
      // never automatically reclaimed either (workAdmissionV1.ts's interim
      // policy), so the process record recorded against it must not vanish
      // out from under a still-held lock.
      now = start + 4 * 60 * 60 * 1000;
      assert.equal(listRoundProcessesV1(TASK_A, "claim-crashed").length, 1);
    } finally {
      Date.now = realDateNow;
    }
  } finally {
    fakeContext.restore();
  }
});

void test("recordRoundProcessV1 for a new claimId on the same task does not touch the previous generation's own record (each claim's key is independent)", async () => {
  const fakeContext = installFakeExtensionContextV1();
  try {
    await recordRoundProcessV1(TASK_A, "claim-1", makeProcess({ pid: 1 }));
    await recordRoundProcessV1(TASK_A, "claim-2", makeProcess({ pid: 2 }));
    assert.deepEqual(
      listRoundProcessesV1(TASK_A, "claim-1").map((p) => p.pid),
      [1],
      "claim-1's record survives a later claim-2 recording under the same task"
    );
    assert.deepEqual(
      listRoundProcessesV1(TASK_A, "claim-2").map((p) => p.pid),
      [2]
    );
  } finally {
    fakeContext.restore();
  }
});

void test("concurrent recordRoundProcessV1 calls for the same task and claim do not lose one another's writes", async () => {
  const fakeContext = installFakeExtensionContextV1();
  try {
    await Promise.all(
      Array.from({ length: 10 }, (_, index) => recordRoundProcessV1(TASK_A, "claim-a", makeProcess({ pid: index })))
    );
    const recorded = listRoundProcessesV1(TASK_A, "claim-a");
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
    assert.equal(hasRoundProcessRecordV1(TASK_A, "claim-a"), false);
    assert.equal(await beginRoundProcessRecordingV1(TASK_A, "claim-a"), true);
    assert.equal(hasRoundProcessRecordV1(TASK_A, "claim-a"), true);
    assert.deepEqual(listRoundProcessesV1(TASK_A, "claim-a"), []);
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
    assert.equal(listRoundProcessesV1(TASK_A, "claim-a").length, 1);
  } finally {
    fakeContext.restore();
  }
});

void test("beginRoundProcessRecordingV1 for a new claim does not touch a stale prior claim's own record", async () => {
  const fakeContext = installFakeExtensionContextV1();
  try {
    await recordRoundProcessV1(TASK_A, "claim-1", makeProcess({ pid: 1 }));
    assert.equal(await beginRoundProcessRecordingV1(TASK_A, "claim-2"), true);
    assert.equal(hasRoundProcessRecordV1(TASK_A, "claim-2"), true);
    assert.deepEqual(listRoundProcessesV1(TASK_A, "claim-2"), []);
    assert.deepEqual(
      listRoundProcessesV1(TASK_A, "claim-1").map((p) => p.pid),
      [1],
      "claim-1's record must be untouched by claim-2 beginning to record"
    );
  } finally {
    fakeContext.restore();
  }
});

void test("recordRoundProcessV1, listRoundProcessesV1, and clearRoundProcessesV1 are no-ops with no ExtensionContext installed (fail closed, never throws)", async () => {
  __extensionContextV1TestOnly.reset();
  assert.equal(await recordRoundProcessV1(TASK_A, "claim-x", makeProcess()), false);
  assert.equal(await beginRoundProcessRecordingV1(TASK_A, "claim-x"), false);
  assert.deepEqual(listRoundProcessesV1(TASK_A, "claim-x"), []);
  await clearRoundProcessesV1(TASK_A);
});

void test("unconfirmedProcessSpawnCountV1 is 0 for a claim that never began, and for a matched begin+record pair (the ordinary path)", async () => {
  const fakeContext = installFakeExtensionContextV1();
  try {
    assert.equal(unconfirmedProcessSpawnCountV1(TASK_A, "claim-a"), 0);
    await beginRoundProcessRecordingV1(TASK_A, "claim-a");
    assert.equal(await beginProcessSpawnAttemptV1(TASK_A, "claim-a"), true);
    await recordRoundProcessV1(TASK_A, "claim-a", makeProcess({ pid: 1 }));
    assert.equal(unconfirmedProcessSpawnCountV1(TASK_A, "claim-a"), 0);
  } finally {
    fakeContext.restore();
  }
});

void test("unconfirmedProcessSpawnCountV1 is 1 between a durable beginProcessSpawnAttemptV1 and its matching append — the exact crash window the append alone cannot prove closed", async () => {
  const fakeContext = installFakeExtensionContextV1();
  try {
    await beginRoundProcessRecordingV1(TASK_A, "claim-crash");
    assert.equal(await beginProcessSpawnAttemptV1(TASK_A, "claim-crash"), true);
    // Simulates a crash right after cp.spawn returned a pid but before the
    // post-spawn recordRoundProcessV1 append landed: processes stays empty,
    // exactly like "recording began, nothing spawned yet" — but the spawn
    // counter proves otherwise.
    assert.deepEqual(listRoundProcessesV1(TASK_A, "claim-crash"), []);
    assert.equal(unconfirmedProcessSpawnCountV1(TASK_A, "claim-crash"), 1);
  } finally {
    fakeContext.restore();
  }
});

void test("beginProcessSpawnAttemptV1 records the provider label and command for pendingSpawnInfoV1 (Step 57a: the held-marker card names them for an unconfirmed spawn)", async () => {
  const fakeContext = installFakeExtensionContextV1();
  try {
    await beginRoundProcessRecordingV1(TASK_A, "claim-pending-info");
    await beginProcessSpawnAttemptV1(TASK_A, "claim-pending-info", "Codex CLI", "codex exec --json <prompt omitted>");
    assert.deepEqual(pendingSpawnInfoV1(TASK_A, "claim-pending-info"), {
      providerLabel: "Codex CLI",
      command: "codex exec --json <prompt omitted>",
    });
  } finally {
    fakeContext.restore();
  }
});

void test("pendingSpawnInfoV1 reports both fields undefined when never recorded, or for a claim with no record at all", async () => {
  const fakeContext = installFakeExtensionContextV1();
  try {
    await beginRoundProcessRecordingV1(TASK_A, "claim-no-pending-info");
    await beginProcessSpawnAttemptV1(TASK_A, "claim-no-pending-info");
    assert.deepEqual(pendingSpawnInfoV1(TASK_A, "claim-no-pending-info"), {
      providerLabel: undefined,
      command: undefined,
    });
    assert.deepEqual(pendingSpawnInfoV1(TASK_A, "claim-never-began"), {
      providerLabel: undefined,
      command: undefined,
    });
  } finally {
    fakeContext.restore();
  }
});

void test("beginProcessSpawnAttemptV1 keeps only the MOST RECENT attempt's provider/command, overwriting an earlier attempt's", async () => {
  const fakeContext = installFakeExtensionContextV1();
  try {
    await beginRoundProcessRecordingV1(TASK_A, "claim-retry-info");
    await beginProcessSpawnAttemptV1(TASK_A, "claim-retry-info", "Codex CLI", "codex exec --json (attempt 1)");
    await abandonProcessSpawnAttemptV1(TASK_A, "claim-retry-info");
    await beginProcessSpawnAttemptV1(TASK_A, "claim-retry-info", "Codex CLI", "codex exec --json (attempt 2)");
    assert.deepEqual(pendingSpawnInfoV1(TASK_A, "claim-retry-info"), {
      providerLabel: "Codex CLI",
      command: "codex exec --json (attempt 2)",
    });
  } finally {
    fakeContext.restore();
  }
});

void test("abandonProcessSpawnAttemptV1 clears the count once a spawn is proven to have produced no process (cp.spawn threw, or no pid)", async () => {
  const fakeContext = installFakeExtensionContextV1();
  try {
    await beginRoundProcessRecordingV1(TASK_A, "claim-a");
    await beginProcessSpawnAttemptV1(TASK_A, "claim-a");
    assert.equal(unconfirmedProcessSpawnCountV1(TASK_A, "claim-a"), 1);
    await abandonProcessSpawnAttemptV1(TASK_A, "claim-a");
    assert.equal(unconfirmedProcessSpawnCountV1(TASK_A, "claim-a"), 0);
  } finally {
    fakeContext.restore();
  }
});

void test("unconfirmedProcessSpawnCountV1 tracks multiple attempts under one claim independently (retry loop): two begun, one recorded, one abandoned leaves 0", async () => {
  const fakeContext = installFakeExtensionContextV1();
  try {
    await beginRoundProcessRecordingV1(TASK_A, "claim-retry");
    await beginProcessSpawnAttemptV1(TASK_A, "claim-retry");
    await beginProcessSpawnAttemptV1(TASK_A, "claim-retry");
    assert.equal(unconfirmedProcessSpawnCountV1(TASK_A, "claim-retry"), 2);
    await recordRoundProcessV1(TASK_A, "claim-retry", makeProcess({ pid: 1 }));
    assert.equal(unconfirmedProcessSpawnCountV1(TASK_A, "claim-retry"), 1);
    await abandonProcessSpawnAttemptV1(TASK_A, "claim-retry");
    assert.equal(unconfirmedProcessSpawnCountV1(TASK_A, "claim-retry"), 0);
  } finally {
    fakeContext.restore();
  }
});

void test("unconfirmedProcessSpawnCountV1 is 0 for a claim with no record at all (a stale prior generation is not this claim's to report)", async () => {
  const fakeContext = installFakeExtensionContextV1();
  try {
    await beginRoundProcessRecordingV1(TASK_A, "claim-1");
    await beginProcessSpawnAttemptV1(TASK_A, "claim-1");
    assert.equal(unconfirmedProcessSpawnCountV1(TASK_A, "claim-2"), 0);
  } finally {
    fakeContext.restore();
  }
});

void test("beginProcessSpawnAttemptV1 and abandonProcessSpawnAttemptV1 are no-ops with no ExtensionContext installed (fail closed, never throws)", async () => {
  __extensionContextV1TestOnly.reset();
  assert.equal(await beginProcessSpawnAttemptV1(TASK_A, "claim-x"), false);
  await assert.doesNotReject(() => abandonProcessSpawnAttemptV1(TASK_A, "claim-x"));
  assert.equal(unconfirmedProcessSpawnCountV1(TASK_A, "claim-x"), 0);
});

void test("recordRoundProcessV1 does not throw when the workspaceState write itself rejects, and reports the failure back to the caller", async () => {
  const memento = {
    get<T>(_key: string, defaultValue: T): T {
      return defaultValue;
    },
    update(): Promise<void> {
      return Promise.reject(new Error("simulated workspaceState failure"));
    },
    keys(): readonly string[] {
      return [];
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
