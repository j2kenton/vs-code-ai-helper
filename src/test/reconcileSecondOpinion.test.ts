/**
 * Coverage for reconcileSecondOpinion (reviewActions.ts) — the deliberate
 * second-opinion mechanism's reconciliation step. A prior version of this
 * function gated its "two reviewers agree" branch on the PRIMARY review
 * having only non-task-fixable blockers, but the function's only call site
 * is reached exclusively when the primary has a task-fixable blocker (that
 * is exactly what routes to "second-opinion" instead of a direct
 * "escalate" — see decideReviewRoute), so that branch could never fire:
 * every second opinion, regardless of what it actually said, was
 * unconditionally reported as "reviewer-disagreement". These tests pin the
 * redesigned behavior, keyed only on the second opinion's own content.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reconcileSecondOpinion } from "../commands/reviewActions";

function secondOpinion(content: string, modelId = "codex-cli:gpt-5"): { content: string; modelId: string } {
  return { content, modelId };
}

void describe("reconcileSecondOpinion", () => {
  void it("reclassifies as environmental when the second opinion independently finds only non-fixable blockers", () => {
    const content = [
      "Readiness: 5/10",
      "<!-- blockers:start -->",
      "- [review-confidence] [environmental] Windows EPERM temp-dir cleanup race",
      "<!-- blockers:end -->",
    ].join("\n");
    const result = reconcileSecondOpinion(secondOpinion(content, "gemini-cli:default"));
    assert.strictEqual(result.kind, "environmental");
    assert.match(result.reason, /independently concluded/);
    assert.match(result.reason, /gemini-cli:default/);
  });

  void it("reclassifies as unverifiable when that's the only non-fixable resolver present — the duplicate-arm ternary bug fixed here", () => {
    // The kind ternary used to be resolverKinds.has("environmental") ?
    // "environmental" : resolverKinds.has("spec-defect") ? "spec-defect" :
    // "environmental" — the final fallback duplicated the first arm, so an
    // unverifiable-only blocker set was silently mislabeled "environmental".
    const content = [
      "Readiness: 4/10",
      "<!-- blockers:start -->",
      "- [review-confidence] [unverifiable] could not confirm this against truncated context",
      "<!-- blockers:end -->",
    ].join("\n");
    const result = reconcileSecondOpinion(secondOpinion(content));
    assert.strictEqual(result.kind, "unverifiable");
    assert.notStrictEqual(result.kind, "environmental");
  });

  void it("reclassifies as spec-defect when that's the only non-fixable resolver present", () => {
    const content = [
      "Readiness: 6/10",
      "<!-- blockers:start -->",
      "- [completion] [spec-defect] acceptance criterion cannot be satisfied as written",
      "<!-- blockers:end -->",
    ].join("\n");
    const result = reconcileSecondOpinion(secondOpinion(content));
    assert.strictEqual(result.kind, "spec-defect");
  });

  void it("reports reviewer-disagreement when the second opinion finds nothing blocking", () => {
    const content = "Readiness: 9/10\n\nLooks ready to me.";
    const result = reconcileSecondOpinion(secondOpinion(content));
    assert.strictEqual(result.kind, "reviewer-disagreement");
    assert.match(result.reason, /found no blockers/);
  });

  void it("does NOT report reviewer-disagreement when the second opinion also reports a real task-fixable issue — the actual bug fixed here", () => {
    // The old predicate's dead "agreement" branch meant THIS case — the
    // second reviewer confirming the same real, fixable-in-theory issue —
    // was indistinguishable from outright disagreement. It should instead
    // read as confirmed-stuck.
    const content = [
      "Readiness: 5/10",
      "<!-- blockers:start -->",
      "- [completion] [task-fixable] the same bug the primary review already flagged",
      "<!-- blockers:end -->",
    ].join("\n");
    const result = reconcileSecondOpinion(secondOpinion(content));
    assert.notStrictEqual(result.kind, "reviewer-disagreement");
    assert.strictEqual(result.kind, "plateau");
    assert.match(result.reason, /independently confirmed a real issue/);
  });

  void it("a low score with no parseable blockers block still reads as disagreement, not silently swallowed", () => {
    const content = "Readiness: 3/10\n\nSomething is wrong but no structured blockers were emitted.";
    const result = reconcileSecondOpinion(secondOpinion(content));
    // Not "nothing blocking" (score < 8) and not "only non-fixable" (no
    // blockers parsed at all) — falls through to the confirmed-stuck case.
    assert.strictEqual(result.kind, "plateau");
  });
});
