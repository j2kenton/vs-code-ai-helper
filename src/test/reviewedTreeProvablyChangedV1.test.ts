/**
 * bugs3 Step 9: a resumed run discards a review whose own stamps prove the
 * workspace moved, even when no implementation round ran after it.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isReviewDispatchAgainstUnchangedTreeV1, isReviewedTreeProvablyChangedV1 } from "../utils/reviewReadiness";

const SHA = "0ee558beeda7b6e44a4d59ff64a6a7cb038db1b5";
const OTHER_SHA = "1111111111111111111111111111111111111111";
const FP = "a".repeat(64);
const review = (sha: string | undefined, fingerprint: string | undefined): string =>
  [
    "Readiness: 6/10",
    "",
    ...(sha !== undefined ? [`<!-- reviewed-commit: ${sha} -->`] : []),
    ...(fingerprint !== undefined ? [`<!-- reviewed-tree-fingerprint: ${fingerprint} -->`] : []),
  ].join("\n");

void describe("isReviewedTreeProvablyChangedV1", () => {
  void it("is true when HEAD moved past the reviewed commit", () => {
    assert.equal(isReviewedTreeProvablyChangedV1(review(SHA, FP), OTHER_SHA, FP), true);
  });

  void it("is true when the working-tree fingerprint differs from the stamped one at the same HEAD", () => {
    assert.equal(isReviewedTreeProvablyChangedV1(review(SHA, FP), SHA, "b".repeat(64)), true);
  });

  void it("is false when commit and fingerprint both match, and that is exactly the unchanged-tree verdict", () => {
    assert.equal(isReviewedTreeProvablyChangedV1(review(SHA, FP), SHA, FP), false);
    assert.equal(isReviewDispatchAgainstUnchangedTreeV1(review(SHA, FP), SHA, FP), true);
  });

  void it("is false, not true, when a signal is unknown: no stamp, no git, no review", () => {
    assert.equal(isReviewedTreeProvablyChangedV1(review(SHA, undefined), SHA, FP), false, "no recorded fingerprint");
    assert.equal(isReviewedTreeProvablyChangedV1(review(SHA, FP), SHA, undefined), false, "live fingerprint unavailable");
    assert.equal(isReviewedTreeProvablyChangedV1(review(undefined, undefined), SHA, FP), false, "no stamps at all");
    assert.equal(isReviewedTreeProvablyChangedV1(review(SHA, FP), undefined, FP), false, "HEAD unresolved");
    assert.equal(isReviewedTreeProvablyChangedV1(undefined, SHA, FP), false, "no review");
  });
});
