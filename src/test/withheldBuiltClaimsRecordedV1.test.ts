/**
 * review2 Step 9 (bugs6 item 25): a built claim the test-evidence rule withheld is recorded as a claim, so the
 * open-items card says "waiting for a passing test report" and not "not reached: the round did not report it built".
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TaskProgress } from "../types/taskProgress";
import {
  getPlanRevisionV1,
  indexPlanItemRowsV1,
  listPlanItemContentHashesV1,
} from "../utils/implementationChecklist";
import { classifyOpenPlanItemsV1 } from "../utils/openPlanItemClassificationV1";
import { recordPlanItemClaimEvidenceV1 } from "../utils/taskProgressTransforms";

const PLAN = [
  "<!-- ensemble:implementation-checklist -->",
  "",
  "- [ ] Write the tests for Part 2",
  "- [ ] Write the tests for Part 3",
  "",
].join("\n");

/** The card's own derivation of the built signal (`postOpenPlanItemsCardV1`). */
function builtKeys(progress: TaskProgress): Set<string> {
  const claimsFor = indexPlanItemRowsV1(progress.planItemEvidence ?? []);
  const keys = new Set<string>();
  for (const entry of listPlanItemContentHashesV1(PLAN)) {
    if (claimsFor(entry).some((row) => row.claims.length > 0)) keys.add(entry.key);
  }
  return keys;
}

void describe("withheld built claims are recorded (review2 Step 9)", () => {
  void it("without the claim, a test item is 'not reached'; with it, it is waiting for a test report", () => {
    const empty = {} as unknown as TaskProgress;
    const items = [{ itemText: "Write the tests for Part 2", reason: "" }];
    const before = classifyOpenPlanItemsV1(items, new Set(), builtKeys(empty));
    assert.equal(before[0]!.category, "not-reached");

    const claimed = recordPlanItemClaimEvidenceV1(empty, {
      planRevision: getPlanRevisionV1(PLAN),
      itemText: "Write the tests for Part 2",
      source: "implementation",
      at: "2026-11-05T08:07:32.000Z",
      roundId: "round-161",
      planText: PLAN,
      evidence: "built claim withheld: no passing test report is recorded for this item yet",
    });
    const after = classifyOpenPlanItemsV1(items, new Set(), builtKeys(claimed));
    assert.equal(after[0]!.category, "awaiting-test-report");
    assert.match(after[0]!.reason, /waiting for a passing test report/);
  });

  void it("the claim belongs to the item it was recorded for, not the one beside it", () => {
    const claimed = recordPlanItemClaimEvidenceV1({} as unknown as TaskProgress, {
      planRevision: getPlanRevisionV1(PLAN),
      itemText: "Write the tests for Part 2",
      source: "implementation",
      at: "2026-11-05T08:07:32.000Z",
      roundId: "round-161",
      planText: PLAN,
    });
    const classified = classifyOpenPlanItemsV1(
      [
        { itemText: "Write the tests for Part 2", reason: "" },
        { itemText: "Write the tests for Part 3", reason: "" },
      ],
      new Set(),
      builtKeys(claimed)
    );
    assert.deepEqual(
      classified.map((item) => item.category),
      ["awaiting-test-report", "not-reached"]
    );
  });
});
