/**
 * bugs4 item 21 / item 17 (Step 17): the two captured occurrences (2026-10-30 05:06 and 06:46), the
 * automatic latch clear with its chat line, and the control that a claimed item the reviewer finds
 * unbuilt stays provisional. Fixture text is paraphrased from task.md; nothing here reads `.ensemble/`.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatClaimVerificationReportV1 } from "../utils/claimVerificationReportV1";
import { decideLatchAutoClearAfterReviewV1, formatLatchAutoClearedLineV1 } from "../utils/latchAutoClearV1";
import {
  filterAlreadyCheckedPlanItemsV1,
  getApplicablePassingTestReportForItemV1,
  listUncountedTestReportClaimsV1,
} from "../utils/implementationChecklist";
import { parseReviewVerifiedCompleteV1 } from "../utils/reviewReadiness";

const LOCK_ITEM = "Add tests for the git index lock capture (gitIndexLockV1).";
const WRAPPER_ITEM = "Add tests for the round git wrapper (gitIndexLockRoundWrapperV1).";
const UNBUILT_ITEM = "Add tests for the retention sweep (retentionSweepV1).";
const PLAN = [
  "<!-- ensemble:implementation-checklist -->",
  `- [x] ${LOCK_ITEM}`,
  `- [x] ${WRAPPER_ITEM}`,
  `- [x] ${UNBUILT_ITEM}`,
].join("\n");

void describe("2026-10-30 05:06 occurrence: one template command over listed .js files, evidence naming .ts sources", () => {
  const summary = [
    "## Files Changed",
    "- src/utils/gitIndexLockV1.ts",
    "## Plan Item Checklist",
    `- ${LOCK_ITEM} — done — \`gitIndexLockV1.test.ts\` (52 pass)`,
    `- ${WRAPPER_ITEM} — done — \`gitIndexLockRoundWrapperV1.test.ts\` (52 pass)`,
    "## Verification",
    "- `node --require ./test-stubs/register.js --test out/test/gitIndexLockV1.test.js out/test/gitIndexLockRoundWrapperV1.test.js` — 476 pass, 0 fail.",
    "- Final post-edit run of the touched test files: 476 passed, 0 failed (post-edit source state).",
  ].join("\n");

  void it("both test-dependent items now count, so nothing is reported uncounted", () => {
    assert.ok(getApplicablePassingTestReportForItemV1(PLAN, LOCK_ITEM, summary));
    assert.ok(getApplicablePassingTestReportForItemV1(PLAN, WRAPPER_ITEM, summary));
    assert.deepEqual(listUncountedTestReportClaimsV1(PLAN, summary).map((entry) => entry.itemText), []);
  });

  void it("the round report states claimed versus verified with a reason when the review named none", () => {
    const line = formatClaimVerificationReportV1({ claimed: 37, verified: 0, testReportsParsed: 0, uncounted: [] });
    assert.match(line, /^37 claimed; 0 verified:/);
    assert.match(line, /review named none/);
  });
});

void describe("2026-10-30 06:46 occurrence: 'on the final source' and bare ticks", () => {
  const summary = [
    "## Files Changed",
    "- src/utils/gitIndexLockV1.ts",
    "## Plan Item Checklist",
    `- ${LOCK_ITEM} — done`,
    "## Verification",
    "- `node --require ./test-stubs/register.js --test out/test/gitIndexLockV1.test.js` — 715 passed, 0 failed on the final source.",
  ].join("\n");

  void it("a bare 'done' tick with no per-item evidence is reported uncounted with its reason, never silently zero", () => {
    const uncounted = listUncountedTestReportClaimsV1(PLAN, summary);
    assert.deepEqual(uncounted.map((entry) => entry.itemText), [LOCK_ITEM]);
    assert.match(uncounted[0]!.reason, /names no test file, test name or command/);
    const line = formatClaimVerificationReportV1({ claimed: 1, verified: 0, testReportsParsed: 0, uncounted });
    assert.match(line, /1 claimed test item not counted \(/);
  });
});

void describe("automatic latch clear after a review (item 17)", () => {
  void it("clears with a chat line that names why and what happens next", () => {
    const decision = decideLatchAutoClearAfterReviewV1({ blockPresent: true, appliedCount: 3, withheldTestItems: 0 });
    assert.equal(decision.clear, true);
    const line = formatLatchAutoClearedLineV1(decision);
    assert.match(line, /no longer flagged unreliable/);
    assert.match(line, /3 verified ticks were applied/);
    assert.match(line, /Nothing else will run now/);
  });

  void it("clears when the review found nothing to add, and stays when test items are still withheld", () => {
    assert.equal(decideLatchAutoClearAfterReviewV1({ blockPresent: true, appliedCount: 0, withheldTestItems: 0 }).clear, true);
    assert.equal(decideLatchAutoClearAfterReviewV1({ blockPresent: true, appliedCount: 2, withheldTestItems: 1 }).clear, false);
  });
});

void describe("control: a claimed item the reviewer finds unbuilt stays provisional", () => {
  const review = [
    "Readiness: 6/10",
    "",
    "<!-- verified-complete:start -->",
    `- ${LOCK_ITEM}`,
    "  evidence: opened src/utils/gitIndexLockV1.ts lines 1-80",
    `- ${WRAPPER_ITEM}`,
    "  evidence: opened src/utils/roundGitStateV1.ts lines 1-60",
    "<!-- verified-complete:end -->",
    "",
    "<!-- blockers:start -->",
    `- [completion] [task-fixable] ${UNBUILT_ITEM} is ticked but the sweep is not implemented`,
    "<!-- blockers:end -->",
  ].join("\n");

  void it("only the items the review named are matched; the unbuilt claim is not", () => {
    const verified = parseReviewVerifiedCompleteV1(review);
    const matched = filterAlreadyCheckedPlanItemsV1(PLAN, verified.items);
    assert.deepEqual([...matched].sort(), [LOCK_ITEM, WRAPPER_ITEM].sort());
    assert.ok(!matched.includes(UNBUILT_ITEM));
  });

  void it("the claim report keeps the unverified count visible", () => {
    const line = formatClaimVerificationReportV1({ claimed: 3, verified: 2, testReportsParsed: 2, uncounted: [] });
    assert.match(line, /3 claimed; 2 verified:/);
    assert.match(line, /review named none/);
  });
});
