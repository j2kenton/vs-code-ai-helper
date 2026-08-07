import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  hasZeroTaskFixableEvidence,
  parseReviewBlockers,
  parseReviewBlockersDetailed,
  parseReviewProgress,
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

  void it("handles all five resolver kinds", () => {
    const content = [
      "<!-- blockers:start -->",
      "- [completion] [task-fixable] a",
      "- [completion] [environmental] b",
      "- [completion] [unverifiable] c",
      "- [completion] [spec-defect] d",
      "- [completion] [needs-toolchain] e",
      "<!-- blockers:end -->",
    ].join("\n");
    const blockers = parseReviewBlockers(content);
    assert.deepStrictEqual(
      blockers.map((b) => b.resolver),
      ["task-fixable", "environmental", "unverifiable", "spec-defect", "needs-toolchain"]
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

  void it("treats a needs-toolchain-only block as zero-fixable evidence (3a)", () => {
    // A blocker whose fix is "run the build", not "edit more source" — the
    // implementation stage cannot clear it by iterating further.
    const content = [
      "<!-- blockers:start -->",
      "- [completion] [needs-toolchain] generated bundle is stale relative to source; requires npm run build",
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

// ---------------------------------------------------------------------------
// Empty-but-present block (2026-08-06 live dogfooding fix). The rubric used to
// say "omit the block entirely when you found zero blockers", while
// hasZeroTaskFixableEvidence refuses to read ABSENCE as evidence — so in the
// one case termination needs proof, the prompt deleted the proof.
// zeroFixableTerminatesFastForward could therefore never fire from the block,
// and Fast Forward span to its iteration ceiling applying nothing. The rubric
// now always emits the block; these pin the parser side of that contract.
// ---------------------------------------------------------------------------

void describe("blockers block: presence vs absence", () => {
  void it("an explicitly empty blockers block is PRESENT with zero blockers", () => {
    const content = "Readiness: 8/10\n\n<!-- blockers:start -->\n<!-- blockers:end -->\n";
    const evidence = parseReviewBlockersDetailed(content);
    assert.equal(evidence.blockPresent, true, "markers present means the block is present");
    assert.deepEqual(evidence.blockers, []);
    assert.equal(hasZeroTaskFixableEvidence(content), true);
  });

  void it("markers with nothing at all between them still count as present", () => {
    // The capture is "" here — testing the capture's truthiness (the old bug)
    // read this as no block at all, inverting the meaning of a deliberate
    // empty block into "unknown".
    const content = "Readiness: 8/10\n\n<!-- blockers:start --><!-- blockers:end -->";
    const evidence = parseReviewBlockersDetailed(content);
    assert.equal(evidence.blockPresent, true);
    assert.deepEqual(evidence.blockers, []);
    assert.equal(hasZeroTaskFixableEvidence(content), true);
  });

  void it("a missing block is still NOT evidence of zero blockers", () => {
    // The complement, and the reason the empty block has to exist: a response
    // that simply forgot the block must stay "unknown", never "none".
    const content = "Readiness: 8/10\n\nI found zero blockers of any category.";
    const evidence = parseReviewBlockersDetailed(content);
    assert.equal(evidence.blockPresent, false);
    assert.equal(
      hasZeroTaskFixableEvidence(content),
      false,
      "prose that does not match the explicit no-blockers phrasing is not evidence"
    );
  });
});

/**
 * The plan-progress marker (2026-08-07). A review's score answers "is what was
 * built any good"; this marker answers "is there more of the plan to build".
 * Conflating the two into the score is what made a clean-but-partial round read
 * as failure, so the loop retried the same scope instead of continuing — see
 * reviewScoreLoop.ts's own progress handling for the consuming side.
 */
void describe("parseReviewProgress", () => {
  void it("parses a well-formed progress marker", () => {
    assert.deepStrictEqual(parseReviewProgress("Readiness: 9/10\n\n<!-- progress: 8/25 -->"), {
      complete: 8,
      total: 25,
    });
  });

  void it("tolerates spacing and case variation", () => {
    assert.deepStrictEqual(parseReviewProgress("<!--progress:3/7-->"), { complete: 3, total: 7 });
    assert.deepStrictEqual(parseReviewProgress("<!--   PROGRESS :  12 / 12   -->"), {
      complete: 12,
      total: 12,
    });
  });

  void it("recognizes a fully complete plan", () => {
    assert.deepStrictEqual(parseReviewProgress("<!-- progress: 25/25 -->"), {
      complete: 25,
      total: 25,
    });
  });

  void it("returns null when the marker is absent, so behavior degrades to pre-marker", () => {
    assert.strictEqual(parseReviewProgress("Readiness: 9/10\n\nNo marker here."), null);
  });

  void it("returns null for nonsensical values rather than acting on them", () => {
    assert.strictEqual(parseReviewProgress("<!-- progress: 5/0 -->"), null, "zero total");
    assert.strictEqual(parseReviewProgress("<!-- progress: 9/5 -->"), null, "complete past total");
    assert.strictEqual(parseReviewProgress("<!-- progress: x/5 -->"), null, "non-numeric");
  });

  void it("accepts zero completed steps", () => {
    assert.deepStrictEqual(parseReviewProgress("<!-- progress: 0/25 -->"), {
      complete: 0,
      total: 25,
    });
  });

  void it("takes the LAST marker, so an echoed prompt example cannot win", () => {
    // The prompt asking for this marker contains a worked example of it, and
    // models routinely restate format instructions before complying. Matching
    // the first occurrence would parse the example's 8/25 every round and
    // report frozen progress for a run that is actually advancing.
    const review = [
      "Readiness: 9/10",
      "",
      "The prompt asked me to end with `<!-- progress: 8/25 -->`.",
      "",
      "I completed steps 9 through 13 this round.",
      "",
      "<!-- progress: 13/25 -->",
    ].join("\n");
    assert.deepStrictEqual(parseReviewProgress(review), { complete: 13, total: 25 });
  });

  void it("is stable across repeated calls (no lastIndex leakage from the global regex)", () => {
    const content = "<!-- progress: 4/9 -->";
    assert.deepStrictEqual(parseReviewProgress(content), { complete: 4, total: 9 });
    assert.deepStrictEqual(parseReviewProgress(content), { complete: 4, total: 9 });
    assert.deepStrictEqual(parseReviewProgress(content), { complete: 4, total: 9 });
  });

  void it("falls back to the last VALID marker shape when a later one is nonsense", () => {
    // A trailing malformed marker still yields null rather than silently
    // using an earlier one — the reviewer's final word is authoritative even
    // when it is unusable, so the loop degrades to pre-marker behavior.
    assert.strictEqual(
      parseReviewProgress("<!-- progress: 4/9 -->\n<!-- progress: 9/4 -->"),
      null
    );
  });
});
