/**
 * review1 Step 41: submitting owner evidence starts one thing. A refusal caused only by the task's own chain
 * having started an operation seconds earlier waits for it (bounded); the busy card never presents Cancel of a
 * just-started action as the next step.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { WorkAdmissionBusyV1, WorkAdmissionResultV1 } from "../state/workAdmissionV1";
import { describeRecentHoldWhyV1, isRecentlyStartedHoldV1 } from "../utils/busyRefusalChoicesV1";
import {
  acquireWaitingForYoungHolderV1,
  isYoungAdmissionHolderV1,
  YOUNG_ADMISSION_HOLDER_MAX_WAIT_MS_V1,
} from "../utils/youngAdmissionHolderWaitV1";

const NOW = Date.parse("2026-11-04T10:00:00.000Z");

function busy(startedAgoMs: number, origin?: "owner" | "automatic"): WorkAdmissionBusyV1 {
  return {
    outcome: "busy",
    owner: {
      claimId: "c1",
      purpose: "admission",
      ownerToken: "t",
      pid: 1,
      processStartTime: 0,
      hostId: "h",
      commandId: "resumeTask",
      startedAt: new Date(NOW - startedAgoMs).toISOString(),
      ...(origin !== undefined ? { origin } : {}),
    },
    markerPath: "/w/.ensemble/t1/admission-v1/marker",
    ageMs: 1_000,
    likelyStale: false,
  };
}

const ACQUIRED = { outcome: "acquired" } as unknown as WorkAdmissionResultV1;

function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void>; slept: number[] } {
  let t = NOW;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: (ms) => {
      slept.push(ms);
      t += ms;
      return Promise.resolve();
    },
    slept,
  };
}

void describe("review1 Step 41: wait for the chain's own just-started operation", () => {
  void it("classifies only a young, non-owner holder as worth waiting for", () => {
    assert.equal(isYoungAdmissionHolderV1(busy(5_000), NOW), true);
    assert.equal(isYoungAdmissionHolderV1(busy(5_000, "automatic"), NOW), true);
    assert.equal(isYoungAdmissionHolderV1(busy(5_000, "owner"), NOW), false);
    assert.equal(isYoungAdmissionHolderV1(busy(5 * 60_000), NOW), false);
  });

  void it("retries a refusal from a young holder until the holder releases, then runs", async () => {
    const clock = fakeClock();
    let calls = 0;
    const result = await acquireWaitingForYoungHolderV1(
      () => {
        calls += 1;
        return Promise.resolve(calls < 4 ? busy(5_000) : ACQUIRED);
      },
      clock
    );
    assert.equal(result.outcome, "acquired");
    assert.equal(calls, 4);
    assert.equal(clock.slept.length, 3);
  });

  void it("gives up after the bounded wait and returns the busy outcome for the card", async () => {
    const clock = fakeClock();
    const result = await acquireWaitingForYoungHolderV1(() => Promise.resolve(busy(0)), clock);
    assert.equal(result.outcome, "busy");
    const waited = clock.slept.reduce((a, b) => a + b, 0);
    assert.ok(waited >= YOUNG_ADMISSION_HOLDER_MAX_WAIT_MS_V1 && waited <= YOUNG_ADMISSION_HOLDER_MAX_WAIT_MS_V1 + 1_000);
  });

  void it("stops waiting as soon as the holder is no longer young (re-checked on every retry)", async () => {
    const clock = fakeClock();
    // The holder was already 50 s old when the wait began, so it passes the 60 s mark after about 10 s of waiting.
    const result = await acquireWaitingForYoungHolderV1(() => Promise.resolve(busy(50_000)), clock);
    assert.equal(result.outcome, "busy");
    const waited = clock.slept.reduce((a, b) => a + b, 0);
    assert.ok(waited <= 11_000, `waited ${waited} ms for a holder that stopped being young after about 10 s`);
  });

  void it("does not wait for an old holder or an owner-started one", async () => {
    for (const refusal of [busy(10 * 60_000), busy(5_000, "owner")]) {
      const clock = fakeClock();
      let calls = 0;
      const result = await acquireWaitingForYoungHolderV1(
        () => {
          calls += 1;
          return Promise.resolve(refusal);
        },
        { ...clock, now: () => NOW }
      );
      assert.equal(result.outcome, "busy");
      assert.equal(calls, 1);
      assert.equal(clock.slept.length, 0);
    }
  });

  void it("passes an immediate admission straight through", async () => {
    const clock = fakeClock();
    const result = await acquireWaitingForYoungHolderV1(() => Promise.resolve(ACQUIRED), clock);
    assert.equal(result.outcome, "acquired");
    assert.equal(clock.slept.length, 0);
  });
});

void describe("review1 Step 41: the busy card for a just-started action", () => {
  void it("recognises a hold that started in the last minute, whoever started it", () => {
    assert.equal(isRecentlyStartedHoldV1(busy(10_000, "owner"), NOW), true);
    assert.equal(isRecentlyStartedHoldV1(busy(10_000, "automatic"), NOW), true);
    assert.equal(isRecentlyStartedHoldV1(busy(3 * 60_000), NOW), false);
  });

  void it("does not call Cancel the next step", () => {
    const why = describeRecentHoldWhyV1("A resumed stage action");
    assert.doesNotMatch(why, /is the next step/);
    assert.match(why, /waiting for it is the usual next step/);
    assert.match(why, /only just started/);
  });
});
