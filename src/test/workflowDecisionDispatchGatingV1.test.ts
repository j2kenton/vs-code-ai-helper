/**
 * Unit coverage for `assertGatingRequirementV1` (task "Actionable Hand-offs:
 * one contract, nine surfaces", PART 5's creation-time guard).
 *
 * `postWorkflowDecisionV1` (`src/utils/workflowDecisionDispatchV1.ts`) is the
 * single production chokepoint that creates a `WorkflowDecisionV1` (every
 * other path either reads or resolves an existing one — see that store's
 * `post` method, which only this dispatch function calls). Calling the
 * exported guard directly, rather than driving the whole async dispatch
 * function, avoids standing up a `vscode.ExtensionContext` / `Memento` just
 * to prove the guard rejects an omission — the guard is a pure function with
 * no dependency on either.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertGatingRequirementV1 } from "../utils/workflowDecisionDispatchV1";

const wellFormedGating = {
  holdsTaskPaused: false,
  unblocksProgress: false,
  detail: "Does not change whether the task is paused or moves forward.",
};

void describe("assertGatingRequirementV1 (PART 5 creation-time guard)", () => {
  void it("throws for a brand-new decision key that omits gating", () => {
    assert.throws(
      () => assertGatingRequirementV1("someBrandNewDecisionKey", undefined),
      /must supply "gating"/
    );
  });

  void it("does not throw for a brand-new decision key that supplies gating", () => {
    assert.doesNotThrow(() => assertGatingRequirementV1("someBrandNewDecisionKey", wellFormedGating));
  });

  void it("throws for any of today's known-compliant keys if gating were ever omitted", () => {
    for (const decisionKey of [
      "applyReviewerVerifiedTicks",
      "restoreRejectedImplementationRound",
      "reconcilePlanChecklist",
      "providerChainExhausted",
    ]) {
      assert.throws(() => assertGatingRequirementV1(decisionKey, undefined), /must supply "gating"/);
    }
  });

  void it("does not throw for providerChainExhausted once it supplies gating", () => {
    assert.doesNotThrow(() => assertGatingRequirementV1("providerChainExhausted", wellFormedGating));
  });
});
