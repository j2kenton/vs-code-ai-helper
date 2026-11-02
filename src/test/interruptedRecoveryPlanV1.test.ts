/**
 * bugs5 Step 12: the recovery card after an interrupted run restarts what was interrupted by name,
 * lists Publish's real actions by their button names, and recommends one from the state of the
 * checks. Reported 2026-11-01 (jester): an interrupted Commit & Push offered only "Run Current
 * Stage Action", which at Publish re-runs the 20-minute Publish Checks.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planInterruptedRecoveryV1, recommendPublishActionV1 } from "../utils/interruptedRecoveryPlanV1";

void describe("planInterruptedRecoveryV1 (bugs5 Step 12)", () => {
  void it("an interrupted Commit & Push after a pass on the current tree recommends Commit & Push again", () => {
    const plan = planInterruptedRecoveryV1({
      label: "Complete, Commit and Push",
      kind: "complete-commit-push",
      atPublish: true,
      checksState: "passedOnCurrentTree",
    });
    assert.equal(plan.primary?.label, "Commit & Push again");
    assert.equal(plan.primary?.command, "vs-code-ai-helper.commitAndPushTask");
    assert.deepEqual(
      plan.alternatives.map((action) => action.label),
      ["Run Publish Checks", "Fix Linting & Code Errors", "Complete Task"]
    );
    assert.match(plan.reasoning, /already passed/);
  });

  void it("an interrupted Publish Checks run on a tree with no passing result recommends the checks again", () => {
    const plan = planInterruptedRecoveryV1({
      label: "Run Publish Checks",
      atPublish: true,
      checksState: "neverRanOrStale",
      lastRunCommands: ["pnpm run verify"],
      lastRunMinutes: 20,
    });
    assert.equal(plan.primary?.label, "Run Publish Checks again");
    assert.equal(plan.primary?.consequence, "Runs Publish Checks: pnpm run verify; about 20 min here.");
  });

  void it("an interrupted Commit & Push is still offered by name first when the state recommends something else", () => {
    const plan = planInterruptedRecoveryV1({ label: "Commit and Push", kind: "commit-push", atPublish: true, checksState: "failed" });
    assert.equal(plan.primary?.label, "Fix Linting & Code Errors");
    assert.equal(plan.alternatives[0]?.label, "Commit & Push again");
  });

  void it("recommends the fix after a failure, the checks when none passed, Commit & Push after a pass", () => {
    assert.equal(recommendPublishActionV1("failed").action, "fix");
    assert.equal(recommendPublishActionV1("neverRanOrStale").action, "checks");
    assert.equal(recommendPublishActionV1(undefined).action, "checks");
    assert.equal(recommendPublishActionV1("passedOnCurrentTree").action, "commit");
  });

  void it("outside Publish, names the interrupted operation instead of the generic stage action", () => {
    const impl = planInterruptedRecoveryV1({ label: "Run Implementation", kind: "run-implementation", atPublish: false });
    assert.equal(impl.primary?.label, "Run Implementation again");
    assert.equal(impl.primary?.command, "vs-code-ai-helper.runImplementationWithAI");
    const apply = planInterruptedRecoveryV1({ label: "Apply Review", kind: "apply-review", atPublish: false });
    assert.equal(apply.primary?.label, "Apply Review again");
  });

  void it("no consequence just repeats its label", () => {
    const plan = planInterruptedRecoveryV1({ label: "Run Publish Checks", atPublish: true, checksState: "neverRanOrStale" });
    for (const action of [plan.primary, ...plan.alternatives]) {
      assert.ok(action);
      assert.notEqual(action.consequence, `Runs "${action.label}" for this task now.`);
      assert.ok(action.consequence.length > action.label.length);
    }
  });

  void it("an operation it cannot name gets no generic stage-action option, and the reasoning says what to do", () => {
    const plan = planInterruptedRecoveryV1({ label: "Something New", atPublish: false });
    assert.equal(plan.primary, undefined);
    assert.deepEqual(plan.alternatives, []);
    assert.match(plan.reasoning, /own button/);
  });

  void it("names Generate Plan and Release by their own commands", () => {
    assert.equal(
      planInterruptedRecoveryV1({ label: "Generate Plan", kind: "generate-plan", atPublish: false }).primary?.command,
      "vs-code-ai-helper.generatePlanWithAI"
    );
    assert.equal(
      planInterruptedRecoveryV1({ label: "Release", kind: "release", atPublish: false }).primary?.command,
      "vs-code-ai-helper.release"
    );
  });
});
