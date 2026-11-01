/**
 * bugs4 Step 8 (item 32): an Apply Review during Low-Level Code Review names the
 * stage it applies, and no progress line reads "Implementation" alone unless the
 * task is at the Implementation stage.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { candidateInvocationMessageV1 } from "../utils/dispatchModelChainV1";
import { applyReviewActivityV1, applyReviewTargetLabelV1, operationChatLabelV1 } from "../utils/stepLabelsV1";

void describe("Apply Review stage labels (bugs4 Step 8, item 32)", () => {
  // The child operation borrows the Implementation stage's role, as in the captured incident.
  const child = {
    label: "Applying implementation review",
    stage: "impl" as const,
    appliesStage: "impl-low-review" as const,
  };

  void it("Started line names Low-Level Code Review, not Implementation", () => {
    const line = `Started ${operationChatLabelV1(child, "impl-low-review")} at 23:55.`;
    assert.equal(line, "Started Applying Low-Level Code Review findings (Implementation model) at 23:55.");
    assert.doesNotMatch(line, /— Implementation/);
  });

  void it("every Progress line keeps naming the applied stage", () => {
    const states = [{ detail: "running" }, { activity: "3 files changed" }, { detail: applyActivityMessage() }];
    for (const state of states) {
      const label = operationChatLabelV1({ ...child, ...state }, "impl-low-review");
      assert.match(label, /^Applying Low-Level Code Review findings \(Implementation model\)/, label);
      assert.doesNotMatch(label, /^Applying implementation review/);
    }
  });

  void it("the model-invocation line names the applied stage, primary and backup", () => {
    const activity = applyReviewActivityV1("Low-Level Code Review");
    assert.equal(
      candidateInvocationMessageV1(activity, "claude-cli:claude-sonnet-5-5@high", "Claude Code", false),
      "Running Apply Review of Low-Level Code Review findings with Claude Code — claude-cli:claude-sonnet-5-5@high."
    );
    assert.match(
      candidateInvocationMessageV1(activity, "m", "Codex", true),
      /^Backup started for Apply Review of Low-Level Code Review findings/
    );
    assert.doesNotMatch(applyActivityMessage(), /Running Implementation with/);
  });

  void it("names the High-Level stage when that is the one applied", () => {
    assert.equal(
      applyReviewTargetLabelV1("High-Level Code Review"),
      "Applying High-Level Code Review findings (Implementation model)"
    );
  });

  void it("control: a real Implementation round at the Implementation stage still reads 'Implementation'", () => {
    const label = operationChatLabelV1({ label: "Run Implementation", stage: "impl", detail: "running" }, "impl");
    assert.equal(label, "Run Implementation — Implementation: running");
  });

  void it("falls back to the task's stage for an operation that carries none", () => {
    assert.equal(operationChatLabelV1({ label: "Review" }, "impl-high-review"), "Review — High-Level Code Review");
  });
});

function applyActivityMessage(): string {
  return candidateInvocationMessageV1(applyReviewActivityV1("Low-Level Code Review"), "m", "Claude Code", false);
}
