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
import { isReviewPassCurrentV1, parseReviewPass } from "../utils/reviewReadiness";

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
