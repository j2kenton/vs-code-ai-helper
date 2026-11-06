/**
 * review1 Step 5 and Step 10: every surface reads the plan-item counts from one place, so the Tasks pane, the chat
 * header, the status bar and the reviewer's `{{checklistProgress}}` can never disagree; a latched checklist keeps
 * its figure with a note, and clears itself once a review leaves nothing provisional.
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import * as vscode from "vscode";
import { after, afterEach, describe, it } from "node:test";

import type { PlanItemEvidenceV1, TaskProgress } from "../types/taskProgress";
import { computeChurnProgressSignalsV1 } from "../utils/churnProgressSignalsV1";
import {
  computePlanItemCountsV1,
  describeOpenAndHandOffsFromCountsV1,
  formatPlanItemCountsEvidenceLineV1,
  formatPlanItemCountsForReviewerV1,
  formatPlanItemCountsLineV1,
  LATCHED_COUNT_NOTE_V1,
  readDisplayPlanChecklistProgressV1,
  readEffectivePlanChecklistProgressForDisplayV1,
  readEffectivePlanChecklistProgressV1,
  readPlanItemCountsV1,
} from "../utils/effectiveReviewProgress";
import {
  describeOpenAndHandOffsV1,
  EXCLUDED_CHECKLIST_ITEM_MARKER_V1,
  findPlanItemContentHashV1,
  formatChecklistEvidenceForReviewerV1,
  formatChecklistProgressForReviewerV1,
  getPlanRevisionV1,
  normalizeChecklistItemTextV1,
} from "../utils/implementationChecklist";
import { decideLatchAutoClearAfterReviewV1 } from "../utils/latchAutoClearV1";

const M = EXCLUDED_CHECKLIST_ITEM_MARKER_V1;

const PLAN = [
  "<!-- ensemble:implementation-checklist -->",
  "",
  "- [x] Step 1: Verified item",
  "- [x] Step 2: Another verified item",
  "- [x] Step 3: Ticked, never checked",
  "- [ ] Step 4: Not built",
  `- [ ] Step 5: Owner hand-off ${M}`,
  "",
  "## Owner Decisions",
  "",
  "- Owner decision 2026-11-03: Approve (owner-decision-1)",
  "",
].join("\n");

function verified(itemText: string): PlanItemEvidenceV1 {
  return {
    planRevision: "0".repeat(64),
    itemKey: normalizeChecklistItemTextV1(itemText),
    itemText,
    itemContentHash: findPlanItemContentHashV1(PLAN, itemText)!,
    claims: [],
    verifications: [{ at: "2026-11-03T06:50:00.000Z", evidence: "checked" }],
  };
}

const PROGRESS = {
  planItemEvidence: [verified("Step 1: Verified item"), verified("Step 2: Another verified item")],
} as unknown as TaskProgress;

void describe("computePlanItemCountsV1", () => {
  void it("reports the gate's split once: total, settled, verified, provisional, open, hand-offs", () => {
    const counts = computePlanItemCountsV1({ planText: PLAN, progress: PROGRESS });
    assert.ok(counts);
    assert.equal(counts.total, 5);
    assert.equal(counts.verified, 2);
    assert.equal(counts.provisional, 1);
    assert.equal(counts.excluded, 1);
    assert.equal(counts.handOffs, 1);
    assert.equal(counts.settled, 3, "two verified plus the excluded hand-off");
    assert.equal(counts.open, 1, "Step 4 is the only unbuilt item");
    assert.equal(counts.percent, 60);
    assert.equal(counts.latched, false);
  });

  void it("keeps the figure while the checklist is flagged unreliable, and says so", () => {
    const counts = computePlanItemCountsV1({ planText: PLAN, progress: { ...PROGRESS, checklistProgressUnreliable: true } as TaskProgress });
    assert.ok(counts);
    assert.equal(counts.latched, true);
    assert.equal(counts.settled, 3);
    const line = formatPlanItemCountsLineV1(counts);
    assert.match(line, /^60% \(2 verified, 1 provisional, some ticks not yet checked\)$/);
    assert.ok(line.includes(LATCHED_COUNT_NOTE_V1));
  });

  void it("shows the running round's live ticks as a separate detail, never in the count", () => {
    const counts = computePlanItemCountsV1({
      planText: PLAN,
      progress: PROGRESS,
      withRoundProgress: { total: 5, checked: 4, closedWithoutDoing: 1, settled: 5, remaining: 0, excluded: 1 },
    });
    assert.ok(counts);
    assert.equal(counts.settled, 3);
    assert.equal(counts.roundTicks, 1);
    assert.match(formatPlanItemCountsLineV1(counts), /1 ticked this round, awaiting review/);
  });

  void it("an unchanged plan gives the same numbers with and without an appended note", () => {
    const withNote = computePlanItemCountsV1({ planText: `${PLAN}\n- Owner decision 2026-11-03: Another note\n`, progress: PROGRESS });
    assert.equal(withNote?.settled, 3);
  });

  void it("the reviewer's {{checklistProgress}} line is the same counts", () => {
    const counts = computePlanItemCountsV1({ planText: PLAN, progress: PROGRESS });
    assert.equal(
      formatPlanItemCountsForReviewerV1(counts),
      formatChecklistProgressForReviewerV1(PLAN, PROGRESS.planItemEvidence ?? [], [])
    );
    assert.equal(formatPlanItemCountsForReviewerV1(counts), "3/5");
    assert.equal(
      formatPlanItemCountsEvidenceLineV1(counts),
      formatChecklistEvidenceForReviewerV1(PLAN, PROGRESS.planItemEvidence ?? [], []).split("\n")[0]
    );
    assert.equal(formatPlanItemCountsForReviewerV1(undefined), "unknown");
  });

  void it("returns nothing for a plan with no checklist", () => {
    assert.equal(computePlanItemCountsV1({ planText: "# no checklist", progress: undefined }), undefined);
  });
});

const ROOT = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "ensemble-plan-item-counts-"));
after(() => {
  nodeFs.rmSync(ROOT, { recursive: true, force: true });
});

void describe("every reader gives the same numbers for one task", () => {
  const fsApi = vscode.workspace.fs as unknown as { readFile: unknown };
  const origReadFile = fsApi.readFile;
  afterEach(() => {
    fsApi.readFile = origReadFile;
  });

  void it("the Tasks pane reader, the chat header and status bar reader, the gate reader and the shared read agree", async () => {
    fsApi.readFile = async (uri: vscode.Uri): Promise<Uint8Array> =>
      new TextEncoder().encode(await nodeFs.promises.readFile(uri.fsPath, "utf8"));
    const folder = nodePath.join(ROOT, ".ensemble", "same-numbers");
    nodeFs.mkdirSync(folder, { recursive: true });
    nodeFs.writeFileSync(nodePath.join(folder, "plan-final.md"), PLAN, "utf8");
    nodeFs.writeFileSync(
      nodePath.join(folder, "task-progress.json"),
      JSON.stringify({
        taskFolder: "same-numbers",
        currentStage: "impl",
        status: "active",
        createdAt: "2026-11-01T00:00:00.000Z",
        updatedAt: "2026-11-01T00:00:00.000Z",
        planItemEvidence: PROGRESS.planItemEvidence,
      }),
      "utf8"
    );
    const uri = vscode.Uri.file(folder);
    const shared = await readPlanItemCountsV1(uri, { mode: "display" });
    const tree = await readDisplayPlanChecklistProgressV1(uri);
    const header = await readEffectivePlanChecklistProgressForDisplayV1(uri);
    const gate = await readEffectivePlanChecklistProgressV1(uri);
    assert.ok(shared && tree && header && gate);
    assert.equal(tree.verifiedCounts.settled, shared.settled);
    assert.equal(tree.verified, shared.verified);
    assert.equal(tree.provisional, shared.provisional);
    assert.equal(header.settled, shared.settled);
    assert.equal(header.percent, shared.percent);
    assert.equal(gate.settled, shared.settled);
    assert.equal(gate.total, shared.total);
  });
});

void describe("the unreliable-checklist latch clears itself when a review leaves nothing provisional (Step 10)", () => {
  void it("clears on zero provisional items even when the review had no Verified Complete block", () => {
    const decision = decideLatchAutoClearAfterReviewV1({
      blockPresent: false,
      appliedCount: 0,
      withheldTestItems: 0,
      provisionalItems: 0,
    });
    assert.equal(decision.clear, true);
    assert.match(decision.reason, /no ticked item is left unchecked/);
  });

  void it("stays latched while a ticked item is still provisional", () => {
    const decision = decideLatchAutoClearAfterReviewV1({
      blockPresent: false,
      appliedCount: 0,
      withheldTestItems: 0,
      provisionalItems: 2,
    });
    assert.equal(decision.clear, false);
  });

  void it("a blocked derivation that reported a problem keeps it, whatever the count", () => {
    assert.equal(
      decideLatchAutoClearAfterReviewV1({ blockPresent: true, appliedCount: 0, withheldTestItems: 0, blockedSeverity: "warning", provisionalItems: 0 }).clear,
      false
    );
  });

  void it("without a count the earlier rules apply unchanged", () => {
    assert.equal(decideLatchAutoClearAfterReviewV1({ blockPresent: true, appliedCount: 1, withheldTestItems: 0 }).clear, true);
    assert.equal(decideLatchAutoClearAfterReviewV1({ blockPresent: false, appliedCount: 0, withheldTestItems: 0 }).clear, false);
  });
});

void it("getPlanRevisionV1 changes with an appended note but the counts do not", () => {
  const a = computePlanItemCountsV1({ planText: PLAN, progress: PROGRESS });
  const b = computePlanItemCountsV1({ planText: `${PLAN}\n- another line\n`, progress: PROGRESS });
  assert.notEqual(getPlanRevisionV1(PLAN), getPlanRevisionV1(`${PLAN}\n- another line\n`));
  assert.deepEqual(
    [a?.settled, a?.verified, a?.provisional, a?.percent],
    [b?.settled, b?.verified, b?.provisional, b?.percent]
  );
});

void describe("the open-items sentence and the churn signal read the shared counts (Step 5)", () => {
  void it("describeOpenAndHandOffsFromCountsV1 gives the same sentence as the text-based helper", () => {
    const fromCounts = describeOpenAndHandOffsFromCountsV1(computePlanItemCountsV1({ planText: PLAN, progress: PROGRESS }));
    assert.equal(fromCounts, describeOpenAndHandOffsV1(PLAN));
    assert.equal(fromCounts, "2 open, of which 1 are owner hand-offs");
    assert.equal(describeOpenAndHandOffsFromCountsV1(undefined), undefined);
  });

  void it("the churn signal's settled count is the shared settled count", () => {
    const shared = computePlanItemCountsV1({ planText: PLAN, progress: PROGRESS });
    const signals = computeChurnProgressSignalsV1({
      planOfRecord: PLAN,
      planItemEvidence: PROGRESS.planItemEvidence,
      planItemOwnerDecisions: PROGRESS.planItemOwnerDecisions,
      blockers: [],
    });
    assert.equal(signals.settledItemCount, shared?.settled);
  });
});
