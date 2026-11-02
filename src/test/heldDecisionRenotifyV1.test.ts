/**
 * bugs5 Step 1: a card announced "For information" because a running operation held back its action
 * is announced as a decision once, when the action is available again and the card still pends.
 */
import * as assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { WorkflowDecisionV1 } from "../types/workflowDecisionV1";
import {
  isDecisionAnnouncedAsInformationOnlyV1,
  markDecisionAnnouncedAsInformationOnlyV1,
  renotifyHeldDecisionsV1,
  resetHeldDecisionAnnouncementsForTestV1,
} from "../utils/heldDecisionRenotifyV1";

function decision(state: WorkflowDecisionV1["state"] = "pending"): WorkflowDecisionV1 {
  return {
    decisionId: "d1",
    decisionKey: "applyReviewerVerifiedTicks",
    taskCanonicalId: "/t",
    stage: "impl-high-review",
    whatHappened: "x",
    whyUserNeeded: "y",
    options: [],
    recommendation: { kind: "none", reasoning: "z" },
    createdAt: new Date().toISOString(),
    state,
  };
}

void describe("renotifyHeldDecisionsV1 (bugs5 Step 1)", () => {
  afterEach(() => resetHeldDecisionAnnouncementsForTestV1());

  void it("announces a pending card once its action is available again, then forgets it", () => {
    markDecisionAnnouncedAsInformationOnlyV1("d1", { id: "target" });
    const notified: unknown[] = [];
    const deps = {
      getViewedPending: () => decision(),
      hasActionableOption: () => true,
      notify: (_d: WorkflowDecisionV1, target: unknown) => notified.push(target),
    };
    assert.deepEqual(renotifyHeldDecisionsV1(deps), ["d1"]);
    assert.deepEqual(renotifyHeldDecisionsV1(deps), [], "announced only once");
    assert.deepEqual(notified, [{ id: "target" }]);
    assert.equal(isDecisionAnnouncedAsInformationOnlyV1("d1"), false);
  });

  void it("keeps a still-held card for the next operation end without announcing it", () => {
    markDecisionAnnouncedAsInformationOnlyV1("d1", {});
    const notified: string[] = [];
    renotifyHeldDecisionsV1({
      getViewedPending: () => decision(),
      hasActionableOption: () => false,
      notify: (d) => notified.push(d.decisionId),
    });
    assert.deepEqual(notified, []);
    assert.equal(isDecisionAnnouncedAsInformationOnlyV1("d1"), true);
  });

  void it("forgets a card that was resolved, dismissed, withdrawn or replaced meanwhile, without a word", () => {
    for (const state of ["resolved", "dismissed", "withdrawn", "superseded"] as const) {
      markDecisionAnnouncedAsInformationOnlyV1("d1", {});
      const notified: string[] = [];
      renotifyHeldDecisionsV1({
        getViewedPending: () => decision(state),
        hasActionableOption: () => true,
        notify: (d) => notified.push(d.decisionId),
      });
      assert.deepEqual(notified, [], state);
      assert.equal(isDecisionAnnouncedAsInformationOnlyV1("d1"), false, state);
    }
    markDecisionAnnouncedAsInformationOnlyV1("d1", {});
    renotifyHeldDecisionsV1({ getViewedPending: () => undefined, hasActionableOption: () => true, notify: () => undefined });
    assert.equal(isDecisionAnnouncedAsInformationOnlyV1("d1"), false);
  });
});
