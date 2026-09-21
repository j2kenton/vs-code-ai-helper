/**
 * v1 fixes 2, item 20: a review stamps the commit it actually reviewed. HEAD is
 * resolved before the minutes-long verified checks and again after them; a
 * commit made in between must be the stamp, and the checks section must say
 * they ran against the earlier tree.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import { reconcileReviewedCommitAfterChecksV1 } from "../commands/reviewActions";

const CHECKS = "## Verified checks\nAll passed.";

void describe("reconcileReviewedCommitAfterChecksV1 (item 20)", () => {
  void it("keeps the stamp and the checks text when HEAD did not move", () => {
    const result = reconcileReviewedCommitAfterChecksV1("aaa111", "aaa111", CHECKS);
    assert.deepEqual(result, { reviewedCommitSha: "aaa111", verifiedChecks: CHECKS });
  });

  void it("stamps the post-commit SHA and records that the checks ran against an earlier tree", () => {
    const result = reconcileReviewedCommitAfterChecksV1("aaa111", "bbb222", CHECKS);
    assert.equal(result.reviewedCommitSha, "bbb222");
    assert.ok(result.verifiedChecks.startsWith(CHECKS));
    assert.match(result.verifiedChecks, /ran against an earlier tree \(commit aaa111\)/);
    assert.match(result.verifiedChecks, /stamped with the later commit bbb222/);
  });

  void it("keeps the snapshot's stamp when a commit lands after the context pack was built", () => {
    const result = reconcileReviewedCommitAfterChecksV1("aaa111", "bbb222", CHECKS, "dispatch-preparation");
    assert.equal(result.reviewedCommitSha, "aaa111");
    assert.match(result.verifiedChecks, /landed after this review's file snapshot was taken/);
    assert.match(result.verifiedChecks, /stamped with the snapshot's commit aaa111/);
    assert.doesNotMatch(result.verifiedChecks, /while these checks were running/);
  });

  void it("leaves the checks text alone when HEAD did not move during dispatch preparation", () => {
    const result = reconcileReviewedCommitAfterChecksV1("aaa111", "aaa111", CHECKS, "dispatch-preparation");
    assert.deepEqual(result, { reviewedCommitSha: "aaa111", verifiedChecks: CHECKS });
  });

  void it("keeps the earlier stamp when HEAD cannot be resolved after the checks", () => {
    const result = reconcileReviewedCommitAfterChecksV1("aaa111", undefined, CHECKS);
    assert.deepEqual(result, { reviewedCommitSha: "aaa111", verifiedChecks: CHECKS });
  });

  void it("stamps a commit that appeared where none could be resolved before", () => {
    const result = reconcileReviewedCommitAfterChecksV1(undefined, "ccc333", CHECKS);
    assert.equal(result.reviewedCommitSha, "ccc333");
    assert.match(result.verifiedChecks, /ran against an earlier tree;/);
  });
});
