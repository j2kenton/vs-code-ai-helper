/**
 * bugs3 Step 12: the "already has a stage action in progress" refusal names the action in plain
 * words, offers Cancel and Wait, and keeps pids, host ids, command ids and lock-file paths out of
 * the message (they go to `details`, for a log or a details toggle).
 */
import * as assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { WORK_ADMISSION_HEARTBEAT_INTERVAL_MS_V1 } from "../state/workAdmissionV1";
import type { WorkAdmissionBusyV1 } from "../state/workAdmissionV1";
import { describePlainBusyRefusalV1, describeWorkAdmissionRefusalForUserV1 } from "../utils/busyAdmissionTextV1";
import { setLiveTaskOperationLookupV1 } from "../utils/liveTaskOperationLookupV1";

const NOW = Date.parse("2026-10-26T20:12:00.000Z");

function busy(over: Partial<WorkAdmissionBusyV1> = {}, commandId = "resumeThenDispatchV1"): WorkAdmissionBusyV1 {
  return {
    outcome: "busy",
    owner: {
      claimId: "c1",
      ownerToken: "o1",
      hostId: "62a10e54-host",
      pid: 23188,
      commandId,
      purpose: "admission",
      startedAt: new Date(NOW - 3 * 60_000).toISOString(),
    },
    markerPath: "/w/.ensemble/t1/admission-v1/admission.hw4.g2.abc",
    ageMs: 63_000,
    likelyStale: false,
    ...over,
  } as WorkAdmissionBusyV1;
}

afterEach(() => setLiveTaskOperationLookupV1(undefined));

void describe("plain busy refusal (bugs3 Step 12)", () => {
  void it("names the live operation, its phase and elapsed time, and offers Cancel and Wait", () => {
    setLiveTaskOperationLookupV1(() => ({ label: "Publish Checks", startedAt: NOW - 3 * 60_000, activity: "tests" }));
    const { message } = describePlainBusyRefusalV1(busy(), "backup", NOW);
    assert.match(message, /^"backup" already has a stage action in progress — Publish Checks are running: tests, 3 min so far\./);
    assert.match(message, /Cancel: stop it from its row in Notifications/);
    assert.match(message, /Wait: it finishes on its own/);
  });

  void it("never shows pids, host ids, command ids or lock-file paths in the message; they are in the details", () => {
    setLiveTaskOperationLookupV1(() => ({ label: "Publish Checks", startedAt: NOW - 60_000 }));
    const plain = describePlainBusyRefusalV1(busy(), undefined, NOW);
    for (const technical of ["23188", "62a10e54-host", "resumeThenDispatchV1", "admission-v1", "admission.hw4"]) {
      assert.ok(!plain.message.includes(technical), `${technical} must not be in the message`);
      assert.ok(plain.details.includes(technical), `${technical} belongs in the details`);
    }
  });

  void it("falls back to the claim's command, in plain words, when the registry has no row yet", () => {
    setLiveTaskOperationLookupV1(() => undefined);
    const publish = describePlainBusyRefusalV1(busy({}, "runPublishChecks"), undefined, NOW).message;
    assert.match(publish, /Publish Checks are running, 3 min so far/);
    const resumed = describePlainBusyRefusalV1(busy(), undefined, NOW).message;
    assert.match(resumed, /A resumed stage action is running, 3 min so far/);
    const unknown = describePlainBusyRefusalV1(busy({}, "someFutureCommand"), undefined, NOW).message;
    assert.match(unknown, /Another stage action is running/);
  });

  void it("carries the live operation's id so the chat card's Cancel targets exactly that operation", () => {
    setLiveTaskOperationLookupV1(() => ({ label: "Publish Checks", operationId: "op-77", startedAt: NOW - 60_000 }));
    assert.deepEqual(describePlainBusyRefusalV1(busy(), undefined, NOW).runningOperation, { operationId: "op-77", label: "Publish Checks" });
  });

  void it("offers no Cancel target when no operation has registered or the claim has stalled", () => {
    setLiveTaskOperationLookupV1(() => undefined);
    assert.equal(describePlainBusyRefusalV1(busy(), undefined, NOW).runningOperation, undefined);
    setLiveTaskOperationLookupV1(() => ({ label: "Publish Checks", operationId: "op-77" }));
    assert.equal(
      describePlainBusyRefusalV1(busy({ ageMs: 6 * WORK_ADMISSION_HEARTBEAT_INTERVAL_MS_V1 }), undefined, NOW).runningOperation,
      undefined
    );
  });

  void it("a fresh claim with no registered operation names its action so Cancel can resolve the operation when chosen", () => {
    setLiveTaskOperationLookupV1(() => undefined);
    const plain = describePlainBusyRefusalV1(busy({}, "runPublishChecks"), undefined, NOW);
    assert.equal(plain.runningOperation, undefined);
    assert.equal(plain.claimOnlyAction, "Publish Checks");
    // A live registered operation, or a stalled claim, is never a claim-only start.
    setLiveTaskOperationLookupV1(() => ({ label: "Publish Checks", operationId: "op-77" }));
    assert.equal(describePlainBusyRefusalV1(busy({}, "runPublishChecks"), undefined, NOW).claimOnlyAction, undefined);
    setLiveTaskOperationLookupV1(() => undefined);
    assert.equal(
      describePlainBusyRefusalV1(busy({ ageMs: 6 * WORK_ADMISSION_HEARTBEAT_INTERVAL_MS_V1 }, "runPublishChecks"), undefined, NOW)
        .claimOnlyAction,
      undefined
    );
  });

  void it("a claim nobody renews is not described as running work", () => {
    setLiveTaskOperationLookupV1(() => ({ label: "Publish Checks", startedAt: NOW - 60_000 }));
    const stale = describePlainBusyRefusalV1(busy({ ageMs: 6 * WORK_ADMISSION_HEARTBEAT_INTERVAL_MS_V1 }), undefined, NOW);
    assert.match(stale.message, /looks stuck rather than busy/);
    assert.doesNotMatch(stale.message, /Cancel: stop it/);
  });

  void it("the notification string is the plain message; a write failure keeps its own wording", () => {
    setLiveTaskOperationLookupV1(() => ({ label: "Fast Forward Review", startedAt: NOW - 120_000 }));
    const text = describeWorkAdmissionRefusalForUserV1(busy(), "backup");
    assert.match(text, /Fast Forward Review is running/);
    assert.doesNotMatch(text, /pid|hostId|held by/);
    const failed = describeWorkAdmissionRefusalForUserV1({ outcome: "writeFailed", error: new Error("EACCES") }, "backup");
    assert.match(failed, /Could not start this stage action for "backup": EACCES/);
  });
});
