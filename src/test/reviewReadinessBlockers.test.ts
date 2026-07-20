import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseReviewBlockers } from "../utils/reviewReadiness";

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
