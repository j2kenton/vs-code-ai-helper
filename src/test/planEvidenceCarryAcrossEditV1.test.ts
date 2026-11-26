/**
 * bugs6 item 12 (1.18 backport): answering an owner-decision or plan-deviation card adds a line to plan-final.md,
 * which changes the plan revision. Evidence for the items that line did not touch is carried to the new revision
 * instead of being dropped (the task fell from 45 of 48 settled to 15).
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TaskProgress } from "../types/taskProgress";
import {
  countChecklistEvidenceProgressV1,
  getPlanRevisionV1,
  listPlanItemKeysWithUnchangedBlocksV1,
  normalizeChecklistItemTextV1,
  settleChecklistItemV1,
} from "../utils/implementationChecklist";
import {
  carryPlanItemEvidenceAcrossPlanEditV1,
  invalidatePlanItemEvidenceForPlanRevisionV1,
} from "../utils/taskProgressTransforms";

const PLAN = [
  "# Plan",
  "",
  "## Checklist",
  "",
  "- [x] Step 1: Build the parser",
  "- [x] Step 2: Build the writer",
  "  - [x] Step 2a: Write the header",
  "- [x] Step 3: Wire the command",
  "- [ ] Step 4: Final verification",
  "",
].join("\n");

const WITH_NOTE = `${PLAN}\n## Owner Decisions\n\n- Owner decision 2026-11-03: Approve plan deviation (plan-deviation-ab12cd34)\n`;

function progressVerifiedAt(plan: string, items: readonly string[]): TaskProgress {
  const planRevision = getPlanRevisionV1(plan);
  return {
    taskFolder: "t",
    currentStage: "impl-high-review",
    status: "active",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    planItemEvidence: items.map((itemText) => ({
      planRevision,
      itemKey: normalizeChecklistItemTextV1(itemText),
      itemText,
      claims: [{ source: "implementation" as const, at: "2026-11-02T00:00:00.000Z", roundId: "r1" }],
      verifications: [{ at: "2026-11-02T01:00:00.000Z", roundId: "rev1", evidence: "src/a.ts:1" }],
    })),
    planItemOwnerDecisions: [
      {
        planRevision,
        itemKey: normalizeChecklistItemTextV1("Step 3: Wire the command"),
        itemText: "Step 3: Wire the command",
        source: "owner" as const,
        at: "2026-11-02T02:00:00.000Z",
        formId: "form-1",
        decision: "tick" as const,
      },
    ],
    planItemOwnerTestRuns: [
      {
        planRevision,
        source: "owner" as const,
        at: "2026-11-02T03:00:00.000Z",
        formId: "run-1",
        command: "pnpm test",
        exitCode: 0,
        summary: "ok",
        itemKeys: [normalizeChecklistItemTextV1("Step 1: Build the parser")],
      },
    ],
  } as TaskProgress;
}

const VERIFIED = ["Step 1: Build the parser", "Step 2: Build the writer", "Step 2a: Write the header"];

function settledCount(plan: string, progress: TaskProgress): number | undefined {
  return countChecklistEvidenceProgressV1(plan, progress.planItemEvidence ?? [], progress.planItemOwnerDecisions ?? [])
    ?.gate.settled;
}

void describe("bugs6 item 12: a card's note does not wipe the plan's evidence", () => {
  void it("reproduces the bug: without the carry, the note's new revision drops every settlement", () => {
    const progress = progressVerifiedAt(PLAN, VERIFIED);
    assert.equal(settledCount(PLAN, progress), 3);
    assert.notEqual(getPlanRevisionV1(PLAN), getPlanRevisionV1(WITH_NOTE));
    assert.equal(settledCount(WITH_NOTE, progress), 0);
  });

  void it("with the carry, an Owner Decisions note keeps every settlement, and the revision wipe keeps it too", () => {
    const carried = carryPlanItemEvidenceAcrossPlanEditV1(progressVerifiedAt(PLAN, VERIFIED), PLAN, WITH_NOTE);
    assert.equal(settledCount(WITH_NOTE, carried), 3);
    const afterWipe = invalidatePlanItemEvidenceForPlanRevisionV1(carried, getPlanRevisionV1(WITH_NOTE));
    assert.equal(settledCount(WITH_NOTE, afterWipe), 3);
    assert.ok(afterWipe.planItemEvidence?.every((row) => (row.verifications?.length ?? 0) > 0));
    assert.equal(afterWipe.planItemOwnerDecisions?.[0]?.planRevision, getPlanRevisionV1(WITH_NOTE));
    assert.equal(afterWipe.planItemOwnerTestRuns?.[0]?.planRevision, getPlanRevisionV1(WITH_NOTE));
  });

  void it("an item the edit changed keeps its old revision, so it stops counting as before", () => {
    // An owner decision's reword (the 1.18 "reword" plan action) rewrites the item's own line.
    const edited = `${PLAN.replace("- [x] Step 1: Build the parser", "- [x] Step 1: Build the streaming parser")}\n## Owner Decisions\n\n- note\n`;
    const carried = carryPlanItemEvidenceAcrossPlanEditV1(progressVerifiedAt(PLAN, VERIFIED), PLAN, edited);
    const nextRevision = getPlanRevisionV1(edited);
    const byKey = new Map((carried.planItemEvidence ?? []).map((row) => [row.itemText, row.planRevision]));
    assert.equal(byKey.get("Step 1: Build the parser"), getPlanRevisionV1(PLAN), "the reworded item's row is not moved");
    assert.equal(byKey.get("Step 2: Build the writer"), nextRevision, "an untouched item's row is moved");
    // The owner's test run names only the reworded item, so it stays behind too.
    assert.equal(carried.planItemOwnerTestRuns?.[0]?.planRevision, getPlanRevisionV1(PLAN));
  });

  void it("excluding an open item moves the other items' rows and leaves the excluded item's", () => {
    const excluded = settleChecklistItemV1(PLAN, "Step 4: Final verification", "exclude", "Owner decision 2026-11-03: drop it");
    assert.ok(excluded.settledItemText !== undefined);
    const progress = progressVerifiedAt(PLAN, [...VERIFIED, "Step 4: Final verification"]);
    const carried = carryPlanItemEvidenceAcrossPlanEditV1(progress, PLAN, excluded.content);
    const byKey = new Map((carried.planItemEvidence ?? []).map((row) => [row.itemText, row.planRevision]));
    assert.equal(byKey.get("Step 4: Final verification"), getPlanRevisionV1(PLAN));
    assert.equal(byKey.get("Step 1: Build the parser"), getPlanRevisionV1(excluded.content));
    assert.equal(settledCount(excluded.content, carried), 4, "three settled items plus the exclusion");
  });

  void it("a parent whose nested child changed is not carried, while its unchanged siblings are", () => {
    const reworded = PLAN.replace("  - [x] Step 2a: Write the header", "  - [x] Step 2a: Write the header and footer");
    const unchanged = listPlanItemKeysWithUnchangedBlocksV1(PLAN, reworded);
    assert.ok(!unchanged.has(normalizeChecklistItemTextV1("Step 2: Build the writer")));
    assert.ok(unchanged.has(normalizeChecklistItemTextV1("Step 1: Build the parser")));
    const carried = carryPlanItemEvidenceAcrossPlanEditV1(progressVerifiedAt(PLAN, VERIFIED), PLAN, reworded);
    const parent = carried.planItemEvidence?.find((row) => row.itemText === "Step 2: Build the writer");
    assert.equal(parent?.planRevision, getPlanRevisionV1(PLAN));
  });

  void it("ticking or unticking a box is not an edit: the revision is the same and nothing changes", () => {
    const progress = progressVerifiedAt(PLAN, VERIFIED);
    const unticked = PLAN.replace("- [x] Step 3: Wire the command", "- [ ] Step 3: Wire the command");
    assert.equal(carryPlanItemEvidenceAcrossPlanEditV1(progress, PLAN, unticked), progress);
  });

  void it("rows from an older revision than the edit's starting point are left alone", () => {
    const older = progressVerifiedAt(`${PLAN}\nolder text\n`, VERIFIED);
    const carried = carryPlanItemEvidenceAcrossPlanEditV1(older, PLAN, WITH_NOTE);
    assert.equal(carried, older);
  });

  void it("never makes a second row for an item that already has one at the new revision", () => {
    const progress = progressVerifiedAt(PLAN, VERIFIED);
    const atNext = progressVerifiedAt(WITH_NOTE, ["Step 1: Build the parser"]).planItemEvidence ?? [];
    const both = { ...progress, planItemEvidence: [...(progress.planItemEvidence ?? []), ...atNext] } as TaskProgress;
    const carried = carryPlanItemEvidenceAcrossPlanEditV1(both, PLAN, WITH_NOTE);
    const nextRevision = getPlanRevisionV1(WITH_NOTE);
    const step1AtNext = (carried.planItemEvidence ?? []).filter(
      (row) => row.itemText === "Step 1: Build the parser" && row.planRevision === nextRevision
    );
    assert.equal(step1AtNext.length, 1);
  });
});
