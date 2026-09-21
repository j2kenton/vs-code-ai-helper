/**
 * Coverage for the per-stage review-pass marker (v1 fixes 2, item 32/6,
 * Wave I): `parseReviewPass` reads the `<!-- review-pass: N -->` marker a
 * review artifact is asked to echo back, and `isReviewPassCurrentV1`
 * decides whether that stamped number still matches the stage's current
 * reservation — deliberately fail-closed, unlike the sibling
 * `reviewed-commit` family, so a leftover artifact from an earlier visit to
 * the stage (or one with no marker at all) can never read as current.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isReviewPassCurrentV1,
  parseReviewPass,
  reviewPredatesLatestImplementationRoundV1,
} from "../utils/reviewReadiness";
import type { RoundLedgerEntryV1 } from "../types/taskProgress";

void describe("parseReviewPass", () => {
  void it("parses the marker's integer value", () => {
    assert.equal(parseReviewPass("Readiness: 9/10\n\n<!-- review-pass: 3 -->"), 3);
  });

  void it("returns undefined when no marker is present", () => {
    assert.equal(parseReviewPass("Readiness: 9/10\n\nNo blockers."), undefined);
  });

  void it("takes the LAST occurrence when a worked example precedes the real marker", () => {
    const content =
      "Emit a marker like this: `<!-- review-pass: 0 -->`\n\n" +
      "Readiness: 9/10\n\n<!-- review-pass: 4 -->";
    assert.equal(parseReviewPass(content), 4);
  });

  void it("returns undefined for a non-numeric or malformed marker", () => {
    assert.equal(parseReviewPass("<!-- review-pass: N -->"), undefined);
  });
});

void describe("isReviewPassCurrentV1", () => {
  void it("is current when the stamped pass equals the stage's reservation", () => {
    const content = "Readiness: 9/10\n\n<!-- review-pass: 2 -->";
    assert.equal(
      isReviewPassCurrentV1(content, { "impl-high-review": 2 }, "impl-high-review"),
      true
    );
  });

  void it("is stale when the stamped pass is behind the stage's current reservation", () => {
    const content = "Readiness: 9/10\n\n<!-- review-pass: 1 -->";
    assert.equal(
      isReviewPassCurrentV1(content, { "impl-high-review": 2 }, "impl-high-review"),
      false
    );
  });

  void it("is stale when the artifact carries no pass marker at all — fail closed, unlike reviewed-commit", () => {
    const content = "Readiness: 9/10\n\nNo blockers.";
    assert.equal(
      isReviewPassCurrentV1(content, { "impl-high-review": 1 }, "impl-high-review"),
      false
    );
  });

  void it("is stale when the task has no recorded reservation for this stage at all", () => {
    const content = "Readiness: 9/10\n\n<!-- review-pass: 1 -->";
    assert.equal(isReviewPassCurrentV1(content, undefined, "impl-high-review"), false);
    assert.equal(isReviewPassCurrentV1(content, {}, "impl-high-review"), false);
  });

  void it("compares each stage's counter independently", () => {
    const content = "Readiness: 9/10\n\n<!-- review-pass: 1 -->";
    assert.equal(
      isReviewPassCurrentV1(content, { "impl-high-review": 1, publish: 5 }, "impl-high-review"),
      true
    );
    assert.equal(
      isReviewPassCurrentV1(content, { "impl-high-review": 1, publish: 5 }, "publish"),
      false
    );
  });
});

void describe("reviewPredatesLatestImplementationRoundV1", () => {
  const entry = (reviewPass: number, at: string) => ({
    stage: "impl-high-review" as const,
    score: 6,
    attemptId: `a${reviewPass}`,
    at,
    blockerCount: 1,
    taskFixableCount: 1,
    reviewPass,
  });
  const round = (mode: "review" | "apply-review", startedAt: string): RoundLedgerEntryV1 =>
    ({
      roundId: `r-${startedAt}`,
      attemptIds: [],
      stage: "impl-high-review",
      mode,
      startedAt,
      state: "completed",
    }) as RoundLedgerEntryV1;

  void it("is stale when an implementation round started after the current-pass review was published", () => {
    assert.equal(
      reviewPredatesLatestImplementationRoundV1(
        {
          stageReviewPasses: { "impl-high-review": 2 },
          reviewScoreHistory: [entry(1, "2026-09-01T00:00:00.000Z"), entry(2, "2026-09-02T00:00:00.000Z")],
          roundLedger: [round("apply-review", "2026-09-03T00:00:00.000Z")],
        },
        "impl-high-review"
      ),
      true
    );
  });

  void it("is current when the round preceded the review, or the only later rows are reviews", () => {
    const base = {
      stageReviewPasses: { "impl-high-review": 2 },
      reviewScoreHistory: [entry(2, "2026-09-02T00:00:00.000Z")],
    };
    assert.equal(
      reviewPredatesLatestImplementationRoundV1(
        { ...base, roundLedger: [round("apply-review", "2026-09-01T00:00:00.000Z")] },
        "impl-high-review"
      ),
      false
    );
    assert.equal(
      reviewPredatesLatestImplementationRoundV1(
        { ...base, roundLedger: [round("review", "2026-09-03T00:00:00.000Z")] },
        "impl-high-review"
      ),
      false
    );
  });

  void it("reports no evidence when there is no current-pass history entry (pass staleness judges that case)", () => {
    assert.equal(
      reviewPredatesLatestImplementationRoundV1(
        {
          stageReviewPasses: { "impl-high-review": 2 },
          reviewScoreHistory: [entry(1, "2026-09-01T00:00:00.000Z")],
          roundLedger: [round("apply-review", "2026-09-03T00:00:00.000Z")],
        },
        "impl-high-review"
      ),
      false
    );
    assert.equal(reviewPredatesLatestImplementationRoundV1({}, "impl-high-review"), false);
  });
});
