import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  hasZeroTaskFixableEvidence,
  parseReviewBlockers,
  parseReviewBlockersDetailed,
  parseReviewProgress,
  isPlanIncomplete,
  meetsAutoAdvanceThreshold,
  readyToAdvanceStage,
  detectSiblingReviewDisagreement,
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

  void it("excludes malformed lines from .blockers instead of throwing", () => {
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

/**
 * Fail-closed on unreadable lines (2026-08-07, step 2). The live incident:
 * two genuine blockers written in a shape the parser could not read parsed
 * to zero blockers, and hasZeroTaskFixableEvidence then reported that as
 * POSITIVE evidence of a clean round. An unreadable line must report itself
 * (`malformedLines`) rather than vanish, and must veto the zero-fixable
 * reading rather than be silently indistinguishable from "nothing to report".
 */
void describe("parseReviewBlockersDetailed.malformedLines (fail-closed)", () => {
  void it("reports one good blocker and one garbage line, and fails closed on zero-fixable evidence", () => {
    const content = [
      "<!-- blockers:start -->",
      "- [completion] [task-fixable] the one valid line",
      "- this is not a blocker line at all",
      "<!-- blockers:end -->",
    ].join("\n");
    const evidence = parseReviewBlockersDetailed(content);
    assert.deepStrictEqual(evidence.blockers, [
      { category: "completion", resolver: "task-fixable", description: "the one valid line" },
    ]);
    assert.deepStrictEqual(evidence.malformedLines, ["- this is not a blocker line at all"]);
    assert.strictEqual(hasZeroTaskFixableEvidence(content), false);
  });

  void it("a garbage-only block yields zero blockers but still fails closed", () => {
    const content = [
      "<!-- blockers:start -->",
      "- totally unstructured prose about a problem",
      "<!-- blockers:end -->",
    ].join("\n");
    const evidence = parseReviewBlockersDetailed(content);
    assert.deepStrictEqual(evidence.blockers, []);
    assert.strictEqual(evidence.malformedLines.length, 1);
    assert.strictEqual(hasZeroTaskFixableEvidence(content), false);
  });

  void it("a category-only line (no resolver) lands in malformedLines, not .blockers", () => {
    const content = [
      "<!-- blockers:start -->",
      "- [completion] category but no resolver bracket",
      "<!-- blockers:end -->",
    ].join("\n");
    const evidence = parseReviewBlockersDetailed(content);
    assert.deepStrictEqual(evidence.blockers, []);
    assert.deepStrictEqual(evidence.malformedLines, ["- [completion] category but no resolver bracket"]);
  });

  void it("an explicitly empty block still yields zero-fixable evidence, with malformedLines empty", () => {
    const content = ["<!-- blockers:start -->", "<!-- blockers:end -->"].join("\n");
    const evidence = parseReviewBlockersDetailed(content);
    assert.deepStrictEqual(evidence.blockers, []);
    assert.deepStrictEqual(evidence.malformedLines, []);
    assert.strictEqual(hasZeroTaskFixableEvidence(content), true);
  });

  void it("blank/whitespace-only lines inside the block are never reported as malformed", () => {
    const content = [
      "<!-- blockers:start -->",
      "",
      "   ",
      "- [completion] [task-fixable] the only real line",
      "",
      "<!-- blockers:end -->",
    ].join("\n");
    const evidence = parseReviewBlockersDetailed(content);
    assert.strictEqual(evidence.blockers.length, 1);
    assert.deepStrictEqual(evidence.malformedLines, []);
  });

  void it("regression: the incident's resolver-only lines still parse cleanly, not as malformed", () => {
    // .ensemble/2026-07-24_task_1, impl-high round 1 — the exact two lines
    // that motivated step 1 (optional category bracket).
    const content = [
      "<!-- blockers:start -->",
      "- [needs-toolchain] Production-source baseline drifted (verify:workflow-production-sources)",
      "- [environmental] Manual Extension Development Host verification not performed",
      "<!-- blockers:end -->",
    ].join("\n");
    const evidence = parseReviewBlockersDetailed(content);
    assert.deepStrictEqual(evidence.malformedLines, []);
    assert.strictEqual(evidence.blockers.length, 2);
    assert.deepStrictEqual(
      evidence.blockers.map((b) => b.resolver),
      ["needs-toolchain", "environmental"]
    );
    assert.strictEqual(hasZeroTaskFixableEvidence(content), true);
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

/**
 * Stage-advance gate (2026-08-07). This is the rule that actually fired the
 * live failure: with the progress marker in place the review score was freed
 * to measure QUALITY, so a flawless partial plan scored 8.5 at 13 of 25 steps
 * and auto-advanced out of implementation with 12 steps unbuilt.
 *
 * The equivalent rule inside improveReviewScore is pinned separately
 * (reviewScoreLoop.test.ts). These exist so the two sites cannot drift apart:
 * the same "a high score does not mean finished" mistake has now been made in
 * two different places.
 */
void describe("readyToAdvanceStage", () => {
  void it("advances when the score clears the threshold and the plan is complete", () => {
    assert.strictEqual(readyToAdvanceStage(8.5, 8, { complete: 25, total: 25 }), true);
  });

  void it("does NOT advance mid-plan, however high the score", () => {
    // The exact live failure: 8.5/10, zero blockers, 13 of 25 steps built.
    assert.strictEqual(readyToAdvanceStage(8.5, 8, { complete: 13, total: 25 }), false);
    assert.strictEqual(readyToAdvanceStage(10, 8, { complete: 24, total: 25 }), false);
  });

  void it("does NOT advance when the score is below the threshold, complete or not", () => {
    assert.strictEqual(readyToAdvanceStage(6.3, 8, { complete: 25, total: 25 }), false);
    assert.strictEqual(readyToAdvanceStage(6.3, 8, { complete: 8, total: 25 }), false);
  });

  void it("falls back to score-only when no progress marker was emitted", () => {
    // Pre-marker behavior must be preserved exactly: an absent signal is
    // unknown completeness, not a reason to block.
    assert.strictEqual(readyToAdvanceStage(8.5, 8, null), true);
    assert.strictEqual(readyToAdvanceStage(7.9, 8, null), false);
  });

  void it("treats a null score as never ready", () => {
    assert.strictEqual(readyToAdvanceStage(null, 8, { complete: 25, total: 25 }), false);
    assert.strictEqual(readyToAdvanceStage(null, 8, null), false);
  });

  void it("advances exactly at the threshold boundary", () => {
    assert.strictEqual(readyToAdvanceStage(8, 8, { complete: 25, total: 25 }), true);
  });

  void it("stays consistent with meetsAutoAdvanceThreshold when the plan is complete", () => {
    // The two must never disagree once completeness is satisfied, or the
    // notification branch (which uses the score-only predicate) would
    // contradict the advance decision.
    for (const score of [0, 5, 7.9, 8, 8.1, 10]) {
      assert.strictEqual(
        readyToAdvanceStage(score, 8, { complete: 4, total: 4 }),
        meetsAutoAdvanceThreshold(score, 8),
        `score ${score} must agree with the score-only predicate on a complete plan`
      );
    }
  });
});

/**
 * The single shared completeness predicate. Three sites decide "is this
 * finished" — readyToAdvanceStage (stage advance) and the two termination
 * gates in reviewScoreLoop.ts — and all three now route through this. These
 * tests exist because the same "a high score does not mean finished" bug was
 * shipped three times in different disguises; three correct copies of a rule
 * drift, one shared predicate cannot.
 */
void describe("isPlanIncomplete", () => {
  void it("is true while steps remain", () => {
    assert.strictEqual(isPlanIncomplete({ complete: 13, total: 25 }), true);
    assert.strictEqual(isPlanIncomplete({ complete: 0, total: 1 }), true);
  });

  void it("is false once every step is done", () => {
    assert.strictEqual(isPlanIncomplete({ complete: 25, total: 25 }), false);
  });

  void it("treats an absent marker as NOT incomplete, preserving pre-marker behavior", () => {
    // Unknown completeness must never block a caller on a signal that was
    // never sent — both null and undefined, since ReviewRoundOutcome.progress
    // is optional while reviewActions parses to null.
    assert.strictEqual(isPlanIncomplete(null), false);
    assert.strictEqual(isPlanIncomplete(undefined), false);
  });

  void it("is defensive about a numerator past the denominator", () => {
    // parseReviewProgress rejects this shape, but the predicate is called
    // with hand-built outcomes in tests and by reviewScoreLoop's callers.
    assert.strictEqual(isPlanIncomplete({ complete: 30, total: 25 }), false);
  });

  void it("is the definition readyToAdvanceStage actually uses", () => {
    // Pins the sharing itself: for any progress shape, a score clearing the
    // threshold advances exactly when the plan is not incomplete. If either
    // side is ever re-derived inline, this disagrees.
    const cases = [
      { complete: 0, total: 5 },
      { complete: 4, total: 5 },
      { complete: 5, total: 5 },
      null,
    ];
    for (const progress of cases) {
      assert.strictEqual(
        readyToAdvanceStage(9, 8, progress),
        !isPlanIncomplete(progress),
        `advance decision must equal !isPlanIncomplete for ${JSON.stringify(progress)}`
      );
    }
  });
});

/**
 * Coverage for 2k (reconcile sibling reviews of the same commit): the
 * task_5 evidence was impl-high reporting "18 of 18 ordered steps complete"
 * while impl-low, on the same commit, reported required steps missing.
 * Deliberately conservative — every negative case below is a reason the
 * function must refuse to claim a contradiction rather than risk a false one.
 */
void describe("detectSiblingReviewDisagreement (2k)", () => {
  const SHA = "abc1234";

  function implHigh(progress: string, sha: string = SHA): string {
    return `Readiness: 9/10\n\nSummary verdict — on track.\n\n<!-- progress: ${progress} -->\n<!-- reviewed-commit: ${sha} -->\n`;
  }

  function implLow(blockersBlock: string, sha: string = SHA): string {
    return `Readiness: 8/10\n\nSummary verdict — needs changes.\n\n<!-- blockers:start -->\n${blockersBlock}\n<!-- blockers:end -->\n<!-- reviewed-commit: ${sha} -->\n`;
  }

  void it("detects the contradiction: impl-high says complete, impl-low reports a completion blocker, same commit", () => {
    const result = detectSiblingReviewDisagreement(
      implHigh("18/18"),
      implLow("- [completion] [task-fixable] steps 5-18 do not exist yet"),
      SHA
    );
    assert.ok(result);
    assert.deepStrictEqual(result.implHighProgress, { complete: 18, total: 18 });
    assert.strictEqual(result.implLowCompletionBlockers.length, 1);
    assert.strictEqual(
      result.implLowCompletionBlockers[0]?.description,
      "steps 5-18 do not exist yet"
    );
  });

  void it("returns null when impl-high itself reports the plan incomplete (nothing to contradict)", () => {
    const result = detectSiblingReviewDisagreement(
      implHigh("6/18"),
      implLow("- [completion] [task-fixable] steps 7-18 do not exist yet"),
      SHA
    );
    assert.strictEqual(result, null);
  });

  void it("returns null when impl-low reports no completion-category blocker", () => {
    const result = detectSiblingReviewDisagreement(
      implHigh("18/18"),
      implLow("- [review-confidence] [environmental] flaky temp-dir cleanup"),
      SHA
    );
    assert.strictEqual(result, null);
  });

  void it("returns null when impl-low reports zero blockers at all", () => {
    const result = detectSiblingReviewDisagreement(
      implHigh("18/18"),
      "Readiness: 9/10\n\nblockers: none\n\n<!-- reviewed-commit: " + SHA + " -->\n",
      SHA
    );
    assert.strictEqual(result, null);
  });

  void it("returns null when the two sibling reviews reviewed different commits", () => {
    const result = detectSiblingReviewDisagreement(
      implHigh("18/18", "sha-high"),
      implLow("- [completion] [task-fixable] steps 5-18 do not exist yet", "sha-low"),
      "sha-high"
    );
    assert.strictEqual(result, null);
  });

  void it("returns null when the siblings agree with each other but not with the commit publish is about to review", () => {
    // Both impl-high and impl-low reviewed the same (now stale) commit —
    // that is 2i's problem, not 2k's; comparing against an older commit than
    // the one currently under review would manufacture a false positive.
    const result = detectSiblingReviewDisagreement(
      implHigh("18/18", SHA),
      implLow("- [completion] [task-fixable] steps 5-18 do not exist yet", SHA),
      "a-newer-commit-sha"
    );
    assert.strictEqual(result, null);
  });

  void it("returns null when either review is missing its reviewed-commit marker", () => {
    const noMarkerHigh = "Readiness: 9/10\n\n<!-- progress: 18/18 -->\n";
    const result = detectSiblingReviewDisagreement(
      noMarkerHigh,
      implLow("- [completion] [task-fixable] steps 5-18 do not exist yet"),
      SHA
    );
    assert.strictEqual(result, null);
  });

  void it("returns null when either review artifact is missing", () => {
    assert.strictEqual(
      detectSiblingReviewDisagreement(undefined, implLow("- [completion] [task-fixable] x"), SHA),
      null
    );
    assert.strictEqual(
      detectSiblingReviewDisagreement(implHigh("18/18"), undefined, SHA),
      null
    );
  });

  void it("returns null when the current reviewed-commit sha is unknown", () => {
    const result = detectSiblingReviewDisagreement(
      implHigh("18/18"),
      implLow("- [completion] [task-fixable] steps 5-18 do not exist yet"),
      undefined
    );
    assert.strictEqual(result, null);
  });
});
