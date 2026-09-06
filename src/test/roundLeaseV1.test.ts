/**
 * Coverage for `roundLeaseV1.ts` — the durable, cross-window liveness beacon
 * for a CLI-resolved implementation round (2026-09-04 review follow-up,
 * A1 architectural blocker: "a manually-dispatched round in another window
 * still has no durable liveness signal"). Backed by `context.workspaceState`,
 * the same Memento `schedulingIntentV1.ts` already relies on as durable/
 * cross-window evidence.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import {
  clearRoundLiveV1,
  listLiveRoundLeaseIdsV1,
  markRoundLiveV1,
  ROUND_LEASE_TTL_MS,
} from "../state/roundLeaseV1";

function installFakeExtensionContextV1(): { restore: () => void } {
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

void test("markRoundLiveV1 makes a roundId appear in listLiveRoundLeaseIdsV1, clearRoundLiveV1 removes it", async () => {
  const fakeContext = installFakeExtensionContextV1();
  try {
    assert.deepEqual(listLiveRoundLeaseIdsV1(), []);
    await markRoundLiveV1("round-a");
    assert.deepEqual(listLiveRoundLeaseIdsV1(), ["round-a"]);
    await markRoundLiveV1("round-b");
    assert.deepEqual([...listLiveRoundLeaseIdsV1()].sort(), ["round-a", "round-b"]);
    await clearRoundLiveV1("round-a");
    assert.deepEqual(listLiveRoundLeaseIdsV1(), ["round-b"]);
  } finally {
    fakeContext.restore();
  }
});

void test("listLiveRoundLeaseIdsV1 excludes an expired entry without needing clearRoundLiveV1 to have run", async () => {
  const fakeContext = installFakeExtensionContextV1();
  try {
    const start = Date.parse("2026-01-01T00:00:00.000Z");
    let now = start;
    const realDateNow = Date.now;
    Date.now = () => now;
    try {
      await markRoundLiveV1("round-crashed");
      assert.deepEqual(listLiveRoundLeaseIdsV1(now), ["round-crashed"]);
      // Well past ROUND_LEASE_TTL_MS (90 min) with no clearRoundLiveV1 call —
      // simulates a round whose process died before its own `finally` ran.
      now = start + ROUND_LEASE_TTL_MS + 60_000;
      assert.deepEqual(listLiveRoundLeaseIdsV1(now), []);
    } finally {
      Date.now = realDateNow;
    }
  } finally {
    fakeContext.restore();
  }
});

void test("clearRoundLiveV1 and listLiveRoundLeaseIdsV1 are no-ops with no ExtensionContext installed (fail closed, never throws)", async () => {
  __extensionContextV1TestOnly.reset();
  await markRoundLiveV1("round-x");
  assert.deepEqual(listLiveRoundLeaseIdsV1(), []);
  await clearRoundLiveV1("round-x");
});

// 2026-09-06 review follow-up (A1 architectural blocker, narrowed a third
// time): markRoundLiveV1 used to return void, so a caller with no other
// liveness fallback (claimReviewAttemptWithLiveLeaseV1) could not tell a
// genuinely-persisted lease from one that silently failed. It now reports
// whether the write actually persisted.
void test("markRoundLiveV1 returns true when the lease actually persists", async () => {
  const fakeContext = installFakeExtensionContextV1();
  try {
    assert.equal(await markRoundLiveV1("round-persisted"), true);
  } finally {
    fakeContext.restore();
  }
});

void test("markRoundLiveV1 returns false with no ExtensionContext installed", async () => {
  __extensionContextV1TestOnly.reset();
  assert.equal(await markRoundLiveV1("round-no-context"), false);
});

void test("markRoundLiveV1 returns false when the workspaceState write itself rejects", async () => {
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
    assert.equal(await markRoundLiveV1("round-write-failed"), false);
  } finally {
    __extensionContextV1TestOnly.reset();
  }
});
