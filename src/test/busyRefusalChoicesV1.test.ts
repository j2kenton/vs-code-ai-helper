/**
 * bugs3 Step 12: a claim-only Cancel card is bound to the claim it was raised for. It never
 * cancels an action that started after that claim ended.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveClaimCancelTargetV1 } from "../utils/busyRefusalChoicesV1";

const TASK = "/w/.ensemble/t1";

void describe("claim-only Cancel target (bugs3 Step 12)", () => {
  void it("cancels the live operation while the originating claim still holds the task", () => {
    const target = resolveClaimCancelTargetV1(TASK, "claim-A", {
      currentClaimId: () => "claim-A",
      liveOperationId: () => "op-1",
    });
    assert.deepEqual(target, { kind: "operation", operationId: "op-1" });
  });

  void it("says the action has not started when its claim holds the task but no operation has registered", () => {
    const target = resolveClaimCancelTargetV1(TASK, "claim-A", {
      currentClaimId: () => "claim-A",
      liveOperationId: () => undefined,
    });
    assert.equal(target.kind, "notStarted");
    assert.ok("message" in target && /not started yet/.test(target.message));
  });

  void it("refuses when action A finished and action B now holds the task: B is not cancelled", () => {
    const target = resolveClaimCancelTargetV1(TASK, "claim-A", {
      currentClaimId: () => "claim-B",
      liveOperationId: () => "op-B",
    });
    assert.equal(target.kind, "ended");
    assert.ok("message" in target && /already ended/.test(target.message));
  });

  void it("refuses when the task is free, and when the card carries no claim id", () => {
    const free = resolveClaimCancelTargetV1(TASK, "claim-A", {
      currentClaimId: () => undefined,
      liveOperationId: () => "op-B",
    });
    assert.equal(free.kind, "ended");
    const legacy = resolveClaimCancelTargetV1(TASK, undefined, {
      currentClaimId: () => undefined,
      liveOperationId: () => "op-B",
    });
    assert.equal(legacy.kind, "ended");
    const legacyHeld = resolveClaimCancelTargetV1(TASK, undefined, {
      currentClaimId: () => "claim-B",
      liveOperationId: () => "op-B",
    });
    assert.equal(legacyHeld.kind, "ended");
  });

  void it("never looks up an operation for a claim that is no longer current", () => {
    let looked = false;
    resolveClaimCancelTargetV1(TASK, "claim-A", {
      currentClaimId: () => "claim-B",
      liveOperationId: () => {
        looked = true;
        return "op-B";
      },
    });
    assert.equal(looked, false);
  });
});
