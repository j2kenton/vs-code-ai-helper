/**
 * bugs4 item 17: a card headed "Decision needed" never offers a single option. The idle
 * unreliable-checklist card has one action, so it is a notice with a button.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDecisionCopyTextV1, buildIdleReconcileDecisionV1 } from "../views/chatView";

const TARGET = {
  canonicalId: "task-3",
  taskFolderPath: "/work/.ensemble/2026-10-26_task_3",
  stage: "impl-high-review" as const,
  taskName: "Strengthen Backup Integrity And Prove Recovery",
};

void describe("idle unreliable-checklist card (bugs4 item 17)", () => {
  void it("is not a blocking decision: its single action is shown as an optional notice", () => {
    const decision = buildIdleReconcileDecisionV1(TARGET);
    assert.equal(decision.options.length, 1);
    // Mirrors the panel's headline predicate: blocking when gating is unknown or holds/unblocks something.
    const isBlocking =
      decision.gating === undefined ||
      decision.gating.holdsTaskPaused === true ||
      decision.gating.unblocksProgress === true;
    assert.equal(isBlocking, false);
    const copy = buildDecisionCopyTextV1(decision, "", isBlocking);
    assert.match(copy, /^Optional\n/);
    assert.doesNotMatch(copy, /Decision needed/);
  });

  void it("still offers the one action, with its consequence stated", () => {
    const decision = buildIdleReconcileDecisionV1(TARGET);
    const [option] = decision.options;
    assert.equal(option?.optionId, "reconcile");
    assert.match(option?.consequence ?? "", /without dispatching a stage action/);
    assert.match(decision.whyUserNeeded, /changes nothing else/);
  });
});
