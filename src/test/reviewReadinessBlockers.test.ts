import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  hasZeroTaskFixableEvidence,
  parseReviewBlockers,
  parseReviewBlockersDetailed,
} from "../utils/reviewReadiness";

void describe("parseReviewBlockers", () => {
  void it("returns an empty array when no blockers block is present", () => {
    assert.deepStrictEqual(parseReviewBlockers("Readiness: 9/10\n\nLooks good."), []);
  });

  void it("parses a well-formed blockers block", () => {
    const content = [
      "Readiness: 5/10",
      "",
      "Some prose.",
      "",
      "<!-- blockers:start -->",
      "- [completion] [task-fixable] missing redo command-level tests",
      "- [review-confidence] [environmental] Windows EPERM temp-dir cleanup race",
      "<!-- blockers:end -->",
    ].join("\n");
    const blockers = parseReviewBlockers(content);
    assert.deepStrictEqual(blockers, [
      { category: "completion", resolver: "task-fixable", description: "missing redo command-level tests" },
      { category: "review-confidence", resolver: "environmental", description: "Windows EPERM temp-dir cleanup race" },
    ]);
  });

  void it("is case-insensitive on category/resolver keywords", () => {
    const content = [
      "<!-- blockers:start -->",
      "- [Completion] [Task-Fixable] example",
      "<!-- blockers:end -->",
    ].join("\n");
    assert.deepStrictEqual(parseReviewBlockers(content), [
      { category: "completion", resolver: "task-fixable", description: "example" },
    ]);
  });

  void it("skips malformed lines instead of throwing", () => {
    const content = [
      "<!-- blockers:start -->",
      "- [completion] missing the resolver bracket entirely",
      "- [not-a-category] [task-fixable] bad category",
      "- [completion] [not-a-resolver] bad resolver",
      "- [completion] [task-fixable] the one valid line",
      "<!-- blockers:end -->",
    ].join("\n");
    assert.deepStrictEqual(parseReviewBlockers(content), [
      { category: "completion", resolver: "task-fixable", description: "the one valid line" },
    ]);
  });

  void it("returns an empty array for an empty blockers block (reviewer found nothing)", () => {
    const content = ["<!-- blockers:start -->", "<!-- blockers:end -->"].join("\n");
    assert.deepStrictEqual(parseReviewBlockers(content), []);
  });

  void it("accepts the 'shipping' category (review-publish.md's only substantive blocker category)", () => {
    // Regression: the category alternation originally omitted "shipping",
    // so every Publish review's shipping blockers silently parsed to zero
    // structured blockers and every Publish review routed as "advance".
    const content = [
      "<!-- blockers:start -->",
      "- [shipping] [task-fixable] leftover debug console.log in commitAndPushTask.ts",
      "<!-- blockers:end -->",
    ].join("\n");
    assert.deepStrictEqual(parseReviewBlockers(content), [
      { category: "shipping", resolver: "task-fixable", description: "leftover debug console.log in commitAndPushTask.ts" },
    ]);
  });

  void it("handles all four resolver kinds", () => {
    const content = [
      "<!-- blockers:start -->",
      "- [completion] [task-fixable] a",
      "- [completion] [environmental] b",
      "- [completion] [unverifiable] c",
      "- [completion] [spec-defect] d",
      "<!-- blockers:end -->",
    ].join("\n");
    const blockers = parseReviewBlockers(content);
    assert.deepStrictEqual(
      blockers.map((b) => b.resolver),
      ["task-fixable", "environmental", "unverifiable", "spec-defect"]
    );
  });
});

void describe("parseReviewBlockersDetailed / hasZeroTaskFixableEvidence", () => {
  void it("distinguishes an absent block from a present-but-empty block", () => {
    assert.strictEqual(parseReviewBlockersDetailed("Readiness: 9/10").blockPresent, false);
    const empty = ["<!-- blockers:start -->", "<!-- blockers:end -->"].join("\n");
    assert.strictEqual(parseReviewBlockersDetailed(empty).blockPresent, true);
  });

  void it("treats a parsed empty blocker block as positive zero-fixable evidence", () => {
    const content = ["Readiness: 6/10", "<!-- blockers:start -->", "<!-- blockers:end -->"].join("\n");
    assert.strictEqual(hasZeroTaskFixableEvidence(content), true);
  });

  void it("treats a present block with only non-task-fixable blockers as zero-fixable evidence", () => {
    // The task_5 rounds 84-85 shape: 1 blocker / 0 task-fixable (the
    // deferred host matrix) — no amount of iteration could ever clear it.
    const content = [
      "<!-- blockers:start -->",
      "- [completion] [environmental] deferred host matrix",
      "<!-- blockers:end -->",
    ].join("\n");
    assert.strictEqual(hasZeroTaskFixableEvidence(content), true);
  });

  void it("does NOT treat the mere absence of the block as evidence", () => {
    assert.strictEqual(hasZeroTaskFixableEvidence("Readiness: 9/10\n\nLooks great."), false);
  });

  void it("accepts an explicit no-blockers statement as evidence when the block is absent", () => {
    assert.strictEqual(hasZeroTaskFixableEvidence("Readiness: 9/10\n\nNo blockers remain."), true);
    assert.strictEqual(hasZeroTaskFixableEvidence("Readiness: 9/10\n\nBlockers: none"), true);
  });

  void it("a present block with a task-fixable blocker is never zero-fixable evidence", () => {
    const content = [
      "No blockers were expected, but:",
      "<!-- blockers:start -->",
      "- [completion] [task-fixable] real remaining work",
      "<!-- blockers:end -->",
    ].join("\n");
    assert.strictEqual(hasZeroTaskFixableEvidence(content), false);
  });
});
