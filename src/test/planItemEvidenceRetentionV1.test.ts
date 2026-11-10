/**
 * review2 Step 8 (bugs6 item 12): evidence is never deleted because an item's text changed. An edit that adds a
 * sub-item under a verified step, a pruning pass, and a byte-for-byte revert bring the verification back, and the
 * rows kept for an edited item are bounded by the item's stable identity.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { TaskProgress } from "../types/taskProgress";
import {
  getPlanRevisionV1,
  listPlanItemContentHashesV1,
  listPlanItemSettlementV1,
  normalizeChecklistItemTextV1,
  planItemRowAppliesV1,
} from "../utils/implementationChecklist";
import {
  MAX_NON_APPLYING_EVIDENCE_ROWS_PER_ITEM_V1,
  prunePlanItemEvidenceForPlanV1,
  recordPlanItemReviewerVerificationV1,
} from "../utils/taskProgressTransforms";

const STEP = "Step 3: Build the retry loop";
const HEADER = "<!-- ensemble:implementation-checklist -->\n\n";
const ORIGINAL = `${HEADER}- [x] ${STEP}\n- [x] Step 4: Another step\n`;

function withSubItem(text: string): string {
  return `${HEADER}- [x] ${STEP}\n  - [x] ${text}\n- [x] Step 4: Another step\n`;
}

function verified(progress: TaskProgress, planText: string, itemText: string, at: string): TaskProgress {
  return recordPlanItemReviewerVerificationV1(progress, {
    planRevision: getPlanRevisionV1(planText),
    planText,
    itemText,
    at,
    evidence: "checked",
  });
}

function settledCount(planText: string, progress: TaskProgress): number {
  return listPlanItemSettlementV1(planText, progress.planItemEvidence ?? []).filter((item) => item.settled).length;
}

function applyingRows(planText: string, progress: TaskProgress): number {
  const entries = listPlanItemContentHashesV1(planText);
  return (progress.planItemEvidence ?? []).filter((row) => entries.some((entry) => planItemRowAppliesV1(row, entry))).length;
}

void describe("evidence survives an edit and comes back on a revert (review2 Step 8)", () => {
  void it("adding a sub-item under a verified step, pruning, then reverting byte for byte restores the count", () => {
    let progress = {} as TaskProgress;
    progress = verified(progress, ORIGINAL, STEP, "2026-11-09T01:00:00.000Z");
    progress = verified(progress, ORIGINAL, "Step 4: Another step", "2026-11-09T01:00:01.000Z");
    assert.equal(settledCount(ORIGINAL, progress), 2);

    // The edit adds a sub-item under Step 3; a review's pruning pass runs against the edited plan.
    const edited = withSubItem("a new sub-item");
    progress = prunePlanItemEvidenceForPlanV1(progress, edited);
    assert.equal(progress.planItemEvidence?.length, 2, "no row is deleted");
    assert.equal(applyingRows(edited, progress), 1, "the edited step's row is ignored while it does not apply");
    assert.equal(settledCount(edited, progress), 1, "only the untouched step counts while the edit stands");

    // The revert is byte for byte: the verification counts again.
    progress = prunePlanItemEvidenceForPlanV1(progress, ORIGINAL);
    assert.equal(progress.planItemEvidence?.length, 2);
    assert.equal(applyingRows(ORIGINAL, progress), 2);
    assert.equal(settledCount(ORIGINAL, progress), 2, "the reverted plan counts its verifications again");
  });

  void it("four successive edits of one item keep at most 3 non-applying rows for it, keyed by the item, not its hash", () => {
    let progress = {} as TaskProgress;
    progress = verified(progress, ORIGINAL, STEP, "2026-11-09T02:00:00.000Z");
    let plan = ORIGINAL;
    for (let edit = 1; edit <= 4; edit += 1) {
      plan = withSubItem(`sub-item version ${edit}`);
      progress = verified(progress, plan, STEP, `2026-11-09T02:00:0${edit}.000Z`);
      progress = prunePlanItemEvidenceForPlanV1(progress, plan);
    }
    const key = normalizeChecklistItemTextV1(STEP);
    const rows = (progress.planItemEvidence ?? []).filter((row) => row.itemKey === key);
    assert.equal(MAX_NON_APPLYING_EVIDENCE_ROWS_PER_ITEM_V1, 3);
    assert.equal(rows.length, 1 + MAX_NON_APPLYING_EVIDENCE_ROWS_PER_ITEM_V1, "the applying row plus the 3 most recent others");
    assert.equal(applyingRows(plan, progress), 1);
    assert.ok(
      !rows.some((row) => row.verifications?.some((v) => v.at === "2026-11-09T02:00:00.000Z")),
      "the oldest row (the original text) was dropped by the bound"
    );
    assert.ok(rows.some((row) => row.verifications?.some((v) => v.at === "2026-11-09T02:00:01.000Z")));
  });

  void it("a card that writes plan-final.md (an owner-decision note, an approved sub-item) leaves the verifications in place", () => {
    let progress = {} as TaskProgress;
    progress = verified(progress, ORIGINAL, STEP, "2026-11-09T04:00:00.000Z");
    progress = verified(progress, ORIGINAL, "Step 4: Another step", "2026-11-09T04:00:01.000Z");
    const withNote = `${ORIGINAL}\n## Owner Decisions\n\n- Owner decision 2026-11-09: Approve (owner-decision-1)\n`;
    progress = prunePlanItemEvidenceForPlanV1(progress, withNote);
    assert.equal(settledCount(withNote, progress), 2, "an appended decision note changes no item");
    const withApproved = withSubItem("approved by the owner");
    progress = prunePlanItemEvidenceForPlanV1(progress, withApproved);
    assert.equal(progress.planItemEvidence?.length, 2, "an approved sub-item deletes nothing");
    assert.equal(
      (progress.planItemEvidence ?? []).reduce((total, row) => total + (row.verifications?.length ?? 0), 0),
      2,
      "both reviewer verifications are still on file"
    );
  });

  void it("the bound is per item: another item's rows are untouched", () => {
    let progress = {} as TaskProgress;
    progress = verified(progress, ORIGINAL, "Step 4: Another step", "2026-11-09T03:00:00.000Z");
    progress = verified(progress, ORIGINAL, STEP, "2026-11-09T03:00:01.000Z");
    for (let edit = 1; edit <= 5; edit += 1) {
      const plan = withSubItem(`sub-item version ${edit}`);
      progress = verified(progress, plan, STEP, `2026-11-09T03:00:1${edit}.000Z`);
      progress = prunePlanItemEvidenceForPlanV1(progress, plan);
    }
    const other = (progress.planItemEvidence ?? []).filter((row) => row.itemKey === normalizeChecklistItemTextV1("Step 4: Another step"));
    assert.equal(other.length, 1);
  });
});
