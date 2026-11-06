/**
 * review1 Step 59 (and Step 60's budget tests): the review's code budget is what is left of the transport limit after
 * the measured non-code input; the task description shrinks before code, and a file cut by the budget is reported.
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import { describe, it } from "node:test";

import {
  IMPL_REVIEW_BYTES_PER_CODE_CHAR_V1,
  IMPL_REVIEW_INPUT_HEADROOM_BYTES_V1,
  IMPL_REVIEW_MIN_CODE_CHARS_V1,
  nextTaskDescriptionLimitV1,
  planImplReviewCodeBudgetV1,
  shrinkImplReviewCodeBudgetV1,
} from "../utils/implReviewBudgetV1";
import { computeReviewScopeGapV1, formatMissingFilesSectionV1 } from "../utils/reviewScopeGapV1";

const LIMIT = 262_144;

void describe("review1 Step 59: the code budget is a computed remainder", () => {
  void it("gives code what is left after the non-code input and the headroom", () => {
    const plan = planImplReviewCodeBudgetV1({ limitBytes: LIMIT, nonCodeBytes: 60_000 });
    const expected = Math.floor((LIMIT - 60_000 - IMPL_REVIEW_INPUT_HEADROOM_BYTES_V1) / IMPL_REVIEW_BYTES_PER_CODE_CHAR_V1);
    assert.equal(plan.codeBudgetChars, expected);
    assert.equal(plan.cannotFit, false);
    assert.equal(plan.codeHasHalfTheLimit, true);
    // Far more than the old fixed 15000 characters.
    assert.ok(plan.codeBudgetChars > 100_000);
  });

  void it("says when code would get under half of the limit, so the non-code input shrinks first", () => {
    const plan = planImplReviewCodeBudgetV1({ limitBytes: LIMIT, nonCodeBytes: 180_000 });
    assert.equal(plan.codeHasHalfTheLimit, false);
    assert.equal(plan.cannotFit, false);
  });

  void it("never goes below the minimum budget, and says when even that does not fit", () => {
    const plan = planImplReviewCodeBudgetV1({ limitBytes: LIMIT, nonCodeBytes: LIMIT });
    assert.equal(plan.codeBudgetChars, IMPL_REVIEW_MIN_CODE_CHARS_V1);
    assert.equal(plan.cannotFit, true);
  });

  void it("shrinks the task description step by step, then runs out", () => {
    assert.equal(nextTaskDescriptionLimitV1(undefined), 6000);
    assert.equal(nextTaskDescriptionLimitV1(6000), 3000);
    assert.equal(nextTaskDescriptionLimitV1(3000), 1500);
    assert.equal(nextTaskDescriptionLimitV1(1500), undefined);
  });

  void it("a build measured over the limit is scaled down by how far over it was, and never below the minimum", () => {
    assert.equal(shrinkImplReviewCodeBudgetV1(100_000, LIMIT - 20_000, LIMIT), 100_000);
    const scaled = shrinkImplReviewCodeBudgetV1(100_000, LIMIT + 13_000, LIMIT);
    assert.ok(scaled < 100_000 && scaled >= IMPL_REVIEW_MIN_CODE_CHARS_V1);
    assert.equal(shrinkImplReviewCodeBudgetV1(3000, LIMIT + 900_000, LIMIT), IMPL_REVIEW_MIN_CODE_CHARS_V1);
  });
});

void describe("review1 Step 59: a file cut by the budget is listed as not reviewed and keeps the stage open", () => {
  const scope = ["src/a.ts", "src/b.ts", "src/c.ts"];
  const base = { ledgerFiles: scope, workingTreeFiles: scope };

  void it("a scope that fits shows nothing new", () => {
    const gap = computeReviewScopeGapV1({ ...base, scopeFiles: scope });
    assert.equal(gap.missing.length, 0);
    assert.equal(formatMissingFilesSectionV1(gap), "");
  });

  void it("files the pack left out of the input join the not-in-scope list, production first", () => {
    const omitted = new Set(["src/c.ts"]);
    const gap = computeReviewScopeGapV1({ ...base, scopeFiles: scope.filter((file) => !omitted.has(file)) });
    assert.deepEqual(gap.missing, ["src/c.ts"]);
    assert.equal(gap.productionReviewedCount, 2);
    assert.match(formatMissingFilesSectionV1(gap), /Changed files not in this review's scope[\s\S]*- src\/c\.ts/);
  });

  void it("dispatch counts the files the size budget omitted, and takes its budget from the measured input", () => {
    const source = nodeFs.readFileSync(
      nodePath.join(__dirname, "..", "..", "src", "commands", "reviewActions.ts"),
      "utf8"
    );
    assert.match(source, /written\.omittedRelPaths/);
    assert.match(source, /planImplReviewCodeBudgetV1\(/);
    assert.doesNotMatch(source, /IMPL_REVIEW_MAX_TOTAL_CHARS/);
  });
});
