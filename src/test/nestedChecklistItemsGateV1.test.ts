/**
 * bugs4 Step 13 (item 29): an unticked nested child keeps its parent open in the
 * completeness gate, without changing the total (the checklist-freeze design:
 * sub-items do not change the count).
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TaskProgress } from "../types/taskProgress";
import {
  countChecklistEvidenceProgressV1,
  getPlanRevisionV1,
  normalizeChecklistItemTextV1,
} from "../utils/implementationChecklist";
import { recordPlanItemOwnerDecisionV1 } from "../utils/taskProgressTransforms";

function ownerSettle(plan: string, texts: readonly string[]): TaskProgress {
  let progress = { planItemEvidence: [] } as unknown as TaskProgress;
  const planRevision = getPlanRevisionV1(plan);
  for (const itemText of texts) {
    progress = recordPlanItemOwnerDecisionV1(progress, {
      planRevision, itemText, at: "2026-10-31T00:00:00.000Z", formId: "form-1", decision: "tick",
    });
  }
  return progress;
}

const PARENT = "Retire the old backup bucket policy.";
const CHILD_TICKED = "Remove the deny-delete statement.";
const CHILD_OPEN = "Add the alarm-flapping fix.";

void describe("nested checklist items in the completeness gate (bugs4 item 29)", () => {
  void it("an unticked child keeps a settled parent open, and the total is unchanged", () => {
    const before = `- [x] ${PARENT}\n- [x] Other item.\n`;
    const after = `- [x] ${PARENT}\n  - [ ] ${CHILD_OPEN}\n- [x] Other item.\n`;
    const settled = (plan: string) => {
      const progress = ownerSettle(plan, [PARENT, "Other item."]);
      return countChecklistEvidenceProgressV1(plan, progress.planItemEvidence ?? [], progress.planItemOwnerDecisions ?? []);
    };
    const withoutChild = settled(before);
    const withChild = settled(after);
    assert.ok(withoutChild && withChild);
    assert.equal(withoutChild.gate.total, 2);
    assert.equal(withoutChild.gate.settled, 2);
    // Adding the child leaves the total at 2 and reopens the parent.
    assert.equal(withChild.gate.total, 2);
    assert.equal(withChild.gate.settled, 1);
    assert.equal(withChild.gate.remaining, 1);
    assert.equal(withChild.ownerSettled, 1);
    assert.equal(withChild.provisional, 1, "the parent is ticked but not settled while its child is open");
  });

  void it("a child that is ticked and settled does not hold the parent open", () => {
    const plan = `- [x] ${PARENT}\n  - [x] ${CHILD_TICKED}\n`;
    const progress = ownerSettle(plan, [PARENT, CHILD_TICKED]);
    const result = countChecklistEvidenceProgressV1(plan, progress.planItemEvidence ?? [], progress.planItemOwnerDecisions ?? []);
    assert.ok(result);
    assert.equal(result.gate.total, 1);
    assert.equal(result.gate.settled, 1);
  });

  void it("children added and ticked before the review leave the count the same as having none", () => {
    const plan = `- [x] ${PARENT}\n  - [x] ${CHILD_TICKED}\n  - [x] ${CHILD_OPEN}\n`;
    const progress = ownerSettle(plan, [PARENT, CHILD_TICKED, CHILD_OPEN]);
    const result = countChecklistEvidenceProgressV1(plan, progress.planItemEvidence ?? [], progress.planItemOwnerDecisions ?? []);
    assert.ok(result);
    assert.equal(result.gate.total, 1);
    assert.equal(result.gate.remaining, 0);
    assert.equal(normalizeChecklistItemTextV1(PARENT).length > 0, true);
  });
});
