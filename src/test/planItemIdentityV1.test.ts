/**
 * review1 Steps 2-4, 6-9: verifications belong to the item they verify, not to the whole plan file. Replays
 * bugs6 item 12 (chat1: answering an owner-decision card appended one line to plan-final.md, the plan revision
 * changed, and 30 reviewer verifications stopped counting: 45 of 48 became 15 of 48).
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import * as vscode from "vscode";
import { after, afterEach, describe, it } from "node:test";

import { decodeTaskProgressTextV1 } from "../services/taskProgressDecoderV1";
import { applyOwnerTickToProvisionalItemV1, applySettleChecklistItemV1 } from "../commands/settleChecklistItem";
import {
  carryLostLabelsForwardV1,
  describeItemsSentBackV1,
  describeSettlementDropForTooltipV1,
  findItemsSentBackByPlanChangeV1,
  observeDisplayedPlanItemCountsV1,
  resetPlanItemCountObserverForTestsV1,
} from "../commands/planItemSettlementNoticeV1";
import { readPlanItemCountsV1, setPlanItemCountsObserverV1 } from "../utils/effectiveReviewProgress";
import { executeOwnerPlanDecisionLockedV1 } from "../commands/ownerPlanDecisionCommandV1";
import type { PlanItemEvidenceV1, PlanItemOwnerDecisionV1, TaskProgress } from "../types/taskProgress";
import {
  computeOpenPlanItemIdV1,
  computePlanItemContentHashV1,
  countChecklistEvidenceProgressV1,
  EXCLUDED_CHECKLIST_ITEM_MARKER_V1,
  findPlanItemContentHashV1,
  formatOpenPlanItemsForRoundV1,
  formatProvisionalTickedItemsForReviewerV1,
  countOpenNestedChecklistItemsV1,
  getPlanRevisionV1,
  listNewlyCheckedChecklistItemOccurrencesV1,
  listOpenPlanItemRecordsV1,
  listPlanItemContentHashesV1,
  listPlanItemIdsV1,
  listPlanItemSettlementV1,
  listProvisionalTickedItemsV1,
  mergeChecklistProgressV1,
  normalizeChecklistItemTextV1,
  planItemRowAppliesV1,
  resolvePlanItemReferenceV1,
  rewordChecklistItemV1,
} from "../utils/implementationChecklist";
import {
  prunePlanItemEvidenceForPlanV1,
  recordPlanItemClaimEvidenceV1,
  recordPlanItemOwnerDecisionV1,
  recordPlanItemOwnerTestRunV1,
  recordPlanItemReviewerVerificationV1,
} from "../utils/taskProgressTransforms";
import { ownerRecordedPassingRunCoversItemV1 } from "../commands/applyReviewerVerifiedTicks";

const M = EXCLUDED_CHECKLIST_ITEM_MARKER_V1;

/** A trimmed copy of chat1's shape: 48 top-level items, 30 verified, 15 excluded, 3 ticked but provisional. */
function chat1Plan(extra = ""): string {
  const lines: string[] = [];
  for (let i = 1; i <= 30; i++) lines.push(`- [x] Step ${i}: built part ${i}`);
  lines.push("- [x] Step 31: Write the tests for Part 1");
  lines.push("- [x] Step 32: Write the tests for Part 2");
  lines.push("- [x] Step 33: Write the tests for Part 3");
  for (let i = 1; i <= 15; i++) lines.push(`- [ ] Owner check ${i} ${M}`);
  return ["<!-- ensemble:implementation-checklist -->", "", ...lines, "", extra].join("\n");
}

const VERIFIED_STEPS = Array.from({ length: 30 }, (_, i) => `Step ${i + 1}: built part ${i + 1}`);

function verifiedEvidence(plan: string, withHash: boolean): PlanItemEvidenceV1[] {
  const out: PlanItemEvidenceV1[] = [];
  for (const itemText of VERIFIED_STEPS) {
    out.push({
      planRevision: getPlanRevisionV1(plan),
      itemKey: normalizeChecklistItemTextV1(itemText),
      itemText,
      ...(withHash ? { itemContentHash: findPlanItemContentHashV1(plan, itemText)! } : {}),
      claims: [],
      verifications: [{ at: "2026-11-03T06:50:00.000Z", evidence: "checked" }],
    });
  }
  return out;
}

const OWNER_NOTE = "## Owner Decisions\n\n- Owner decision 2026-11-03: Approve and update plan (owner-decision-1)\n";

void describe("computePlanItemContentHashV1", () => {
  void it("ignores checkbox state, exclusion markers and Ensemble's own notes", () => {
    const base = computePlanItemContentHashV1("Step 4: Build it");
    assert.equal(computePlanItemContentHashV1("Step 4: Build it — Checked: did it by hand."), base);
    assert.equal(computePlanItemContentHashV1(`Step 4: Build it — Excluded by you: not needed. ${M}`), base);
    assert.equal(computePlanItemContentHashV1("Step 4: Build it — Owner decision 2026-11-03: Approve (x-1)"), base);
    assert.equal(computePlanItemContentHashV1("  step 4:   BUILD it "), base);
  });

  void it("changes with the item's wording and with a nested child's wording", () => {
    const base = computePlanItemContentHashV1("Step 4: Build it", ["a child"]);
    assert.notEqual(computePlanItemContentHashV1("Step 4: Build it differently", ["a child"]), base);
    assert.notEqual(computePlanItemContentHashV1("Step 4: Build it", ["another child"]), base);
    assert.notEqual(computePlanItemContentHashV1("Step 4: Build it"), base);
  });
});

void describe("a verification stays valid while its item is unchanged (bugs6 item 12 replay)", () => {
  void it("the gate reads 45/48 with and without the appended Owner decision lines, and 48/48 after the owner's three ticks", () => {
    const original = chat1Plan();
    // Verifications recorded at the ORIGINAL plan revision, with content hashes (how new rows are written).
    const evidence = verifiedEvidence(original, true);
    const before = countChecklistEvidenceProgressV1(original, evidence, []);
    assert.equal(before?.gate.total, 48);
    assert.equal(before?.gate.settled, 45);

    const withNote = chat1Plan(OWNER_NOTE);
    assert.notEqual(getPlanRevisionV1(withNote), getPlanRevisionV1(original), "the plan revision does change");
    const after = countChecklistEvidenceProgressV1(withNote, evidence, []);
    assert.equal(after?.gate.settled, 45, "…but the verifications still count");
    assert.equal(after?.provisional, 3);

    const owner: PlanItemOwnerDecisionV1[] = [31, 32, 33].map((n) => {
      const itemText = ["Write the tests for Part 1", "Write the tests for Part 2", "Write the tests for Part 3"][n - 31]!;
      const text = `Step ${n}: ${itemText}`;
      return {
        planRevision: getPlanRevisionV1(original),
        itemKey: normalizeChecklistItemTextV1(text),
        itemText: text,
        source: "owner" as const,
        at: "2026-11-03T09:22:00.000Z",
        formId: "settle:1",
        decision: "tick" as const,
        itemContentHash: findPlanItemContentHashV1(withNote, text)!,
      };
    });
    const settledAll = countChecklistEvidenceProgressV1(withNote, evidence, owner);
    assert.equal(settledAll?.gate.settled, 48);
    assert.equal(settledAll?.ownerSettled, 3);
  });

  void it("legacy rows without a content hash still count, matched by the item's text", () => {
    const plan = chat1Plan(OWNER_NOTE);
    const legacy = verifiedEvidence(chat1Plan(), false).map((row) => ({ ...row, planRevision: "0".repeat(64) }));
    assert.equal(countChecklistEvidenceProgressV1(plan, legacy, [])?.gate.settled, 45);
  });

  void it("rewording one item drops only that item's verification, and Step 8 names it", () => {
    const original = chat1Plan();
    const evidence = verifiedEvidence(original, true);
    const reworded = rewordChecklistItemV1(original, "Step 5: built part 5", "Step 5: built part 5 differently", "Owner decision 2026-11-03: reword");
    assert.equal(reworded.previousItemText, "Step 5: built part 5");
    const counted = countChecklistEvidenceProgressV1(reworded.content, evidence, []);
    assert.equal(counted?.gate.settled, 44, "only the reworded item dropped");

    const before = listPlanItemSettlementV1(original, evidence, []);
    const after = listPlanItemSettlementV1(reworded.content, evidence, []);
    const lost = findItemsSentBackByPlanChangeV1(
      { at: "t", items: before.map((i) => ({ hash: i.hash, settled: i.settled, label: i.label })) },
      after
    );
    assert.deepEqual(lost, ["Step 5"]);
    assert.match(describeItemsSentBackV1(lost), /^Step 5 changed, so the review has to re-check 1 item/);

    // Adding a note elsewhere sends nothing back.
    const withNote = listPlanItemSettlementV1(chat1Plan(OWNER_NOTE), evidence, []);
    assert.deepEqual(
      findItemsSentBackByPlanChangeV1({ at: "t", items: before.map((i) => ({ hash: i.hash, settled: i.settled, label: i.label })) }, withNote),
      []
    );
  });

  void it("Step 8's sent-back note clears once the review settles the item again, and keeps the ones still waiting", () => {
    const original = chat1Plan();
    const evidence = verifiedEvidence(original, true);
    const reworded = rewordChecklistItemV1(original, "Step 5: built part 5", "Step 5: built part 5 differently", "").content;
    const stillWaiting = listPlanItemSettlementV1(reworded, evidence, []);
    const previousLost = { at: "t", labels: ["Step 5"] };
    // Right after the reword, Step 5 is unsettled (nothing verifies its new wording) and stays on the list.
    assert.deepEqual(carryLostLabelsForwardV1(previousLost, stillWaiting)?.labels, ["Step 5"]);
    // Once the review verifies the new wording, the label drops.
    const newText = "Step 5: built part 5 differently";
    const reverified: PlanItemEvidenceV1[] = [
      ...evidence,
      {
        planRevision: getPlanRevisionV1(reworded),
        itemKey: normalizeChecklistItemTextV1(newText),
        itemText: newText,
        itemContentHash: findPlanItemContentHashV1(reworded, newText)!,
        claims: [],
        verifications: [{ at: "2026-11-04T06:50:00.000Z", evidence: "checked again" }],
      },
    ];
    const settledAgain = listPlanItemSettlementV1(reworded, reverified, []);
    assert.equal(settledAgain.find((item) => item.label === "Step 5")?.settled, true);
    assert.equal(carryLostLabelsForwardV1({ at: "t", labels: ["Step 5"] }, settledAgain), undefined);
    assert.equal(describeSettlementDropForTooltipV1({ at: "t", items: [] }), undefined);
  });

  void it("pruning drops only the rows of items that changed or are gone", () => {
    const original = chat1Plan();
    let progress = { planItemEvidence: verifiedEvidence(original, true) } as unknown as TaskProgress;
    const noteOnly = prunePlanItemEvidenceForPlanV1(progress, chat1Plan(OWNER_NOTE));
    assert.equal(noteOnly.planItemEvidence?.length, 30);
    const reworded = rewordChecklistItemV1(original, "Step 5: built part 5", "Step 5: another", "").content;
    progress = prunePlanItemEvidenceForPlanV1(progress, reworded);
    assert.equal(progress.planItemEvidence?.length, 29);
  });

  void it("new rows carry the item's content hash and ignore the plan revision when re-recorded", () => {
    const plan = chat1Plan();
    const progress = recordPlanItemReviewerVerificationV1({} as TaskProgress, {
      planRevision: getPlanRevisionV1(plan),
      planText: plan,
      itemText: "Step 1: built part 1",
      at: "t1",
      evidence: "checked",
    });
    const row = progress.planItemEvidence?.[0];
    assert.equal(row?.itemContentHash, findPlanItemContentHashV1(plan, "Step 1: built part 1"));
    const later = recordPlanItemReviewerVerificationV1(progress, {
      planRevision: getPlanRevisionV1(chat1Plan(OWNER_NOTE)),
      planText: chat1Plan(OWNER_NOTE),
      itemText: "Step 1: built part 1",
      at: "t2",
      evidence: "checked again",
    });
    assert.equal(later.planItemEvidence?.length, 1, "the same item keeps one row");
    assert.equal(later.planItemEvidence?.[0]?.verifications?.length, 2);
  });
});

/**
 * review1 Step 11: chat1's REAL plan-final.md (copied byte for byte into `src/test/fixtures/chat1-review1/`), not a
 * generic shape. The file is the plan as it stood after the owner's cards were answered: 48 items, 33 ticked, 15
 * excluded. The suite below builds its 30 reviewer verifications the way `recordPlanItemReviewerVerificationV1`
 * writes them (with content hashes) for every ticked item except Steps 7, 17 and 22 (the three whose test reports
 * Ensemble rejected). The next suite replays chat1's own historical `planItemEvidence` rows instead.
 */
void describe("chat1's real plan-final.md (bugs6 item 12 replay, historical fixture)", () => {
  const fixturePath = nodePath.join(__dirname, "..", "..", "src", "test", "fixtures", "chat1-review1", "plan-final.md");
  const withOwnerLines = nodeFs.readFileSync(fixturePath, "utf8");
  const ownerHeading = withOwnerLines.indexOf("\n## Owner Decisions");
  assert.ok(ownerHeading > 0, "the real plan carries the appended Owner Decisions block");
  const withoutOwnerLines = withOwnerLines.slice(0, ownerHeading + 1);
  const PROVISIONAL_STEPS = [7, 17, 22];

  const tickedItems = withOwnerLines
    .split(/\r?\n/)
    .filter((line) => /^- \[x\] /.test(line))
    .map((line) => line.replace(/^- \[x\] /, ""));
  const itemTextOfStep = (n: number): string => {
    const found = tickedItems.find((text) => text.startsWith(`Step ${n}:`));
    assert.ok(found, `Step ${n} is ticked in the real plan`);
    return found;
  };

  /** Verification rows keyed by the plan without the owner lines (the revision the 06:50 review verified against). */
  function verificationRows(): PlanItemEvidenceV1[] {
    return tickedItems
      .filter((text) => !PROVISIONAL_STEPS.some((n) => text.startsWith(`Step ${n}:`)))
      .map((itemText) => ({
        planRevision: getPlanRevisionV1(withoutOwnerLines),
        itemKey: normalizeChecklistItemTextV1(itemText),
        itemText,
        itemContentHash: findPlanItemContentHashV1(withoutOwnerLines, itemText)!,
        claims: [],
        verifications: [{ at: "2026-11-03T06:50:00.000Z", evidence: "checked against the code" }],
      }));
  }

  void it("is the shape the replay needs: 48 items, 33 ticked, 15 excluded, and the three test steps among the ticked", () => {
    const counts = countChecklistEvidenceProgressV1(withoutOwnerLines, [], []);
    assert.equal(counts?.gate.total, 48);
    assert.equal(tickedItems.length, 33);
    assert.equal(counts?.gate.closedWithoutDoing, 15);
    for (const n of PROVISIONAL_STEPS) itemTextOfStep(n);
    assert.equal(verificationRows().length, 30);
  });

  void it("the gate reads 45/48 with and without the appended Owner decision lines, and 48/48 after the owner's ticks on Steps 7, 17 and 22", () => {
    const evidence = verificationRows();
    const before = countChecklistEvidenceProgressV1(withoutOwnerLines, evidence, []);
    assert.equal(before?.gate.settled, 45);
    assert.equal(before?.provisional, 3);

    assert.notEqual(getPlanRevisionV1(withOwnerLines), getPlanRevisionV1(withoutOwnerLines), "the appended lines do change the revision");
    const after = countChecklistEvidenceProgressV1(withOwnerLines, evidence, []);
    assert.equal(after?.gate.settled, 45, "…and the 30 verifications still count");
    assert.equal(after?.verified, 30);

    const owner: PlanItemOwnerDecisionV1[] = PROVISIONAL_STEPS.map((n) => {
      const text = itemTextOfStep(n);
      return {
        planRevision: getPlanRevisionV1(withoutOwnerLines),
        itemKey: normalizeChecklistItemTextV1(text),
        itemText: text,
        source: "owner" as const,
        at: "2026-11-03T09:22:00.000Z",
        formId: "settle:1",
        decision: "tick" as const,
        itemContentHash: findPlanItemContentHashV1(withOwnerLines, text)!,
      };
    });
    const settled = countChecklistEvidenceProgressV1(withOwnerLines, evidence, owner);
    assert.equal(settled?.gate.settled, 48);
    assert.equal(settled?.ownerSettled, 3);
    assert.equal(settled?.provisional, 0);
  });

  void it("rows written before the content hash existed (legacy) also keep counting across the appended lines", () => {
    const legacy = verificationRows().map(({ itemContentHash: _dropped, ...row }) => row);
    const after = countChecklistEvidenceProgressV1(withOwnerLines, legacy, []);
    assert.equal(after?.gate.settled, 45);
  });

  void it("rewording one real item drops only that item's verification", () => {
    const evidence = verificationRows();
    const target = itemTextOfStep(5);
    const reworded = withOwnerLines.replace(`- [x] ${target}`, `- [x] ${target} Also record the result in impl-summary.md.`);
    assert.notEqual(reworded, withOwnerLines);
    const after = countChecklistEvidenceProgressV1(reworded, evidence, []);
    assert.equal(after?.gate.settled, 44, "only the reworded item lost its verification");
    assert.equal(after?.verified, 29);
  });
});

/**
 * review1 Step 11, the historical evidence: chat1's REAL `planItemEvidence` (100 rows, copied from its
 * `task-progress.json` into `src/test/fixtures/chat1-review1/plan-item-evidence.json`), keyed to four plan revisions,
 * none of them carrying an `itemContentHash`. These are the rows bugs6 item 12 lost when one Owner Decisions line was
 * appended to plan-final.md; with the item matcher they must count against the real plan again.
 */
void describe("chat1's real planItemEvidence rows (bugs6 item 12 replay, historical fixture)", () => {
  const dir = nodePath.join(__dirname, "..", "..", "src", "test", "fixtures", "chat1-review1");
  const withOwnerLines = nodeFs.readFileSync(nodePath.join(dir, "plan-final.md"), "utf8");
  const withoutOwnerLines = withOwnerLines.slice(0, withOwnerLines.indexOf("\n## Owner Decisions") + 1);
  const realRows = JSON.parse(nodeFs.readFileSync(nodePath.join(dir, "plan-item-evidence.json"), "utf8")) as PlanItemEvidenceV1[];
  const PROVISIONAL_STEPS = [7, 17, 22];

  void it("are the historical rows: no content hashes, and several superseded plan revisions", () => {
    assert.equal(realRows.length, 100);
    assert.ok(realRows.every((row) => row.itemContentHash === undefined), "all are legacy rows");
    const revisions = new Set(realRows.map((row) => row.planRevision));
    assert.ok(revisions.size >= 3, "keyed to several plan revisions");
    assert.ok(!revisions.has(getPlanRevisionV1(withOwnerLines)) || revisions.size > 1);
  });

  void it("count the same with and without the appended Owner decision lines, whatever revision each row carries", () => {
    const before = countChecklistEvidenceProgressV1(withoutOwnerLines, realRows, []);
    const after = countChecklistEvidenceProgressV1(withOwnerLines, realRows, []);
    assert.equal(before?.gate.total, 48);
    assert.equal(after?.gate.total, 48);
    assert.equal(after?.gate.settled, before?.gate.settled, "appending the owner lines changes nothing");
    assert.equal(after?.verified, before?.verified);
    assert.equal(after?.provisional, before?.provisional);
  });

  void it("settle 45/48 against the real plan (30 verified, 15 excluded) and 48/48 after the owner's ticks on Steps 7, 17 and 22", () => {
    const counted = countChecklistEvidenceProgressV1(withOwnerLines, realRows, []);
    assert.equal(counted?.gate.settled, 45);
    assert.equal(counted?.verified, 30);
    assert.equal(counted?.gate.closedWithoutDoing, 15);
    assert.equal(counted?.provisional, 3);

    const owner: PlanItemOwnerDecisionV1[] = PROVISIONAL_STEPS.map((n) => {
      const text = withOwnerLines
        .split(/\r?\n/)
        .filter((line) => /^- \[x\] /.test(line))
        .map((line) => line.replace(/^- \[x\] /, ""))
        .find((item) => item.startsWith(`Step ${n}:`))!;
      return {
        planRevision: getPlanRevisionV1(withOwnerLines),
        itemKey: normalizeChecklistItemTextV1(text),
        itemText: text,
        source: "owner" as const,
        at: "2026-11-03T09:22:00.000Z",
        formId: "settle:1",
        decision: "tick" as const,
      };
    });
    const settled = countChecklistEvidenceProgressV1(withOwnerLines, realRows, owner);
    assert.equal(settled?.gate.settled, 48);
    assert.equal(settled?.ownerSettled, 3);
  });
});

void describe("rewordChecklistItemV1 (Step 4)", () => {
  const PLAN = [
    "<!-- ensemble:implementation-checklist -->",
    "",
    "- [ ] Do the thing",
    "- [ ] Do the thing",
    "  - [ ] Do the thing",
    "",
  ].join("\n");

  void it("rewords the occurrence asked for, only at top level, and keeps the checkbox", () => {
    const second = rewordChecklistItemV1(PLAN, "Do the thing", "Do the new thing", "", 2);
    assert.deepEqual(second.content.split("\n").slice(2, 5), ["- [ ] Do the thing", "- [ ] Do the new thing", "  - [ ] Do the thing"]);
    const ticked = rewordChecklistItemV1("- [x] Do the thing\n", "Do the thing", "Do it better", "note");
    assert.equal(ticked.content, "- [x] Do it better — note\n");
  });

  void it("changes nothing when no checklist line matches, even if the text appears elsewhere in the file", () => {
    const plan = ["# Plan", "", "Prose mentioning Do the other thing.", "", "- [ ] Different"].join("\n");
    const result = rewordChecklistItemV1(plan, "Do the other thing", "X", "");
    assert.equal(result.previousItemText, undefined);
    assert.equal(result.content, plan);
  });
});

void describe("nested items and item ids (Steps 6 and 9)", () => {
  const PLAN = [
    "<!-- ensemble:implementation-checklist -->",
    "",
    "- [x] Step 1: Parent",
    "  - [x] first child",
    "  - [ ] second child",
    "- [ ] Step 2: Open item",
    "- [ ] Step 3: Same words",
    "- [ ] Step 3: Same words",
    "",
  ].join("\n");

  void it("lists a ticked, unverified child under its parent for the reviewer", () => {
    const provisional = listProvisionalTickedItemsV1(PLAN, [], []);
    assert.equal(provisional.length, 1);
    assert.deepEqual(provisional[0]?.unverifiedChildren, ["first child"]);
    const text = formatProvisionalTickedItemsForReviewerV1(PLAN, [], []);
    // review1 (owner decision 2026-11-05): the reviewer is shown the item ids it cites in `## Verified Complete`.
    const ids = listPlanItemIdsV1(PLAN);
    assert.ok(text.includes(`- [item:${ids[0]!.itemId}] Step 1: Parent\n  - [item:${ids[1]!.itemId}] first child [nested: verify separately]`));
  });

  void it("the open-items records (card and form) are the top-level open items; open nested sub-items are counted apart", () => {
    const open = listOpenPlanItemRecordsV1(PLAN).filter((record) => !record.settled).map((record) => record.itemText);
    assert.deepEqual(open, ["Step 2: Open item", "Step 3: Same words", "Step 3: Same words"]);
    assert.equal(countOpenNestedChecklistItemsV1(PLAN), 1, "the second child is open and is named on the card, not listed");
  });

  void it("gives every item, nested ones included, an occurrence-aware id that does not collide", () => {
    const ids = listPlanItemIdsV1(PLAN);
    assert.equal(ids.length, 6);
    assert.equal(new Set(ids.map((entry) => entry.itemId)).size, 6, "the two identical items still get two ids");
    assert.equal(ids[1]?.nested, true);
    assert.equal(ids[1]?.parentId, ids[0]?.itemId);
    assert.equal(ids[0]?.itemId, computeOpenPlanItemIdV1("Step 1: Parent", 1), "a top-level id is unchanged");
    const listing = formatOpenPlanItemsForRoundV1(PLAN);
    assert.match(listing, new RegExp(`\\[item:${ids[3]!.itemId}\\] Step 2: Open item`));
    assert.match(listing, new RegExp(`- \\[item:${ids[2]!.itemId}\\] \\(nested, open\\) second child`));
  });

  void it("resolves item:<id> and a bare Step N that names exactly one item, and reports the rest truthfully", () => {
    const ids = listPlanItemIdsV1(PLAN);
    const expected = { kind: "item", itemText: "Step 2: Open item", itemIndex: 3 };
    assert.deepEqual(resolvePlanItemReferenceV1(PLAN, `item:${ids[3]!.itemId}`), expected);
    assert.deepEqual(resolvePlanItemReferenceV1(PLAN, `[item:${ids[3]!.itemId}]`), expected);
    assert.deepEqual(resolvePlanItemReferenceV1(PLAN, "Step 2"), expected);
    assert.equal(resolvePlanItemReferenceV1(PLAN, "Step 3").kind, "problem", "two items share Step 3");
    assert.equal(resolvePlanItemReferenceV1(PLAN, "item:0000000000000000").kind, "problem");
    assert.equal(resolvePlanItemReferenceV1(PLAN, "Step 2: Open item").kind, "not-a-reference");
  });

  void it("merges an item:<id> claim and a bare Step N claim as item matches", () => {
    const ids = listPlanItemIdsV1(PLAN);
    const summary = [
      "## Files Changed",
      "",
      "- src/a.ts",
      "",
      "## Plan Item Checklist",
      "",
      `- item:${ids[3]!.itemId} — done <!-- ensemble:retroactive --> — src/a.ts:10`,
      "",
    ].join("\n");
    const merged = mergeChecklistProgressV1(PLAN, summary);
    assert.equal(merged.kind, "merged");
    if (merged.kind === "merged") assert.match(merged.content, /- \[x\] Step 2: Open item/);

    const byStep = mergeChecklistProgressV1(PLAN, ["## Files Changed", "", "- src/a.ts", "", "## Plan Item Checklist", "", "- Step 2 — done <!-- ensemble:retroactive --> — src/a.ts:10"].join("\n"));
    assert.equal(byStep.kind, "merged");
  });

  void it("an item:<id> claim for the second of two identically worded items ticks that line, not the first", () => {
    const ids = listPlanItemIdsV1(PLAN);
    const claim = (id: string): string =>
      [
        "## Files Changed",
        "",
        "- src/a.ts",
        "",
        "## Plan Item Checklist",
        "",
        `- item:${id} — done <!-- ensemble:retroactive --> — src/a.ts:10`,
        "",
      ].join("\n");
    const second = mergeChecklistProgressV1(PLAN, claim(ids[5]!.itemId));
    assert.equal(second.kind, "merged");
    if (second.kind === "merged") {
      const lines = second.content.split("\n").filter((line) => line.includes("Step 3: Same words"));
      assert.deepEqual(lines, ["- [ ] Step 3: Same words", "- [x] Step 3: Same words"]);
    }
    // With the first copy already ticked, a claim for the second is still a tick, not absorbed by the checked count.
    const firstTicked = PLAN.replace("- [ ] Step 3: Same words", "- [x] Step 3: Same words");
    const afterFirst = mergeChecklistProgressV1(firstTicked, claim(listPlanItemIdsV1(firstTicked)[5]!.itemId));
    assert.equal(afterFirst.kind, "merged");
    if (afterFirst.kind === "merged") {
      assert.equal(afterFirst.content.split("\n").filter((line) => line === "- [x] Step 3: Same words").length, 2);
    }
  });

  void it("a newly ticked second copy is recorded against the second copy, not the first (review1 Step 9)", () => {
    const secondTicked = PLAN.replace(/(- \[ \] Step 3: Same words)([\s\S]*?)(- \[ \] Step 3: Same words)/, "$1$2- [x] Step 3: Same words");
    const added = listNewlyCheckedChecklistItemOccurrencesV1(PLAN, secondTicked);
    assert.deepEqual(added, [{ text: "Step 3: Same words", occurrence: 2, nested: false }]);
    const progress = recordPlanItemClaimEvidenceV1({} as TaskProgress, {
      planRevision: getPlanRevisionV1(secondTicked),
      itemText: added[0]!.text,
      itemOccurrence: 2,
      source: "implementation",
      at: "2026-11-04T10:00:00.000Z",
      planText: secondTicked,
    });
    const rows = progress.planItemEvidence ?? [];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.itemOccurrence, 2);
  });

  void it("a newly ticked second identical child is recorded against the second child (review1 Step 9)", () => {
    const before = [
      "<!-- ensemble:implementation-checklist -->",
      "- [ ] Step 1: Parent",
      "  - [ ] Same child words",
      "  - [ ] Same child words",
      "",
    ].join("\n");
    const after = before.replace(/( {2}- \[ \] Same child words\n) {2}- \[ \] Same child words/, "$1  - [x] Same child words");
    const added = listNewlyCheckedChecklistItemOccurrencesV1(before, after);
    assert.deepEqual(added, [{ text: "Same child words", occurrence: 2, nested: true }]);
    const progress = recordPlanItemClaimEvidenceV1({} as TaskProgress, {
      planRevision: getPlanRevisionV1(after),
      itemText: added[0]!.text,
      itemOccurrence: added[0]!.occurrence,
      itemNested: added[0]!.nested,
      source: "implementation",
      at: "2026-11-04T10:00:00.000Z",
      planText: after,
    });
    const rows = progress.planItemEvidence ?? [];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.itemOccurrence, 2, "stored against the second child, not the first");
    const secondChild = listPlanItemContentHashesV1(after).filter((entry) => entry.nested)[1]!;
    assert.equal(rows[0]!.itemContentHash, secondChild.hash);
    assert.equal(planItemRowAppliesV1(rows[0]!, secondChild), true);
    const firstChild = listPlanItemContentHashesV1(after).filter((entry) => entry.nested)[0]!;
    assert.equal(planItemRowAppliesV1(rows[0]!, firstChild), false, "the first child is not settled by it");
  });

  void it("an unknown id or an ambiguous Step N ticks nothing, says why, and is not an unmatched claim", () => {
    const summary = [
      "## Files Changed",
      "",
      "- src/a.ts",
      "",
      "## Plan Item Checklist",
      "",
      "- item:ffffffffffffffff — done <!-- ensemble:retroactive --> — evidence one",
      "- Step 3 — done <!-- ensemble:retroactive --> — evidence two",
      "",
    ].join("\n");
    const merged = mergeChecklistProgressV1(PLAN, summary);
    assert.equal(merged.kind, "no-report", "nothing was claimed that could latch the checklist");
    assert.equal(merged.referenceProblems?.length, 2);
    assert.match(merged.referenceProblems?.[0] ?? "", /not an item id in the plan of record/);
    assert.match(merged.referenceProblems?.[1] ?? "", /names 2 plan items/);
  });
});

const ROOT = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "ensemble-plan-item-identity-"));
after(() => {
  nodeFs.rmSync(ROOT, { recursive: true, force: true });
});

function makeTask(name: string, plan: string, progress: Partial<TaskProgress> = {}): string {
  const folder = nodePath.join(ROOT, ".ensemble", name);
  nodeFs.mkdirSync(folder, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(folder, "plan-final.md"), plan, "utf8");
  nodeFs.writeFileSync(
    nodePath.join(folder, "task-progress.json"),
    JSON.stringify({
      taskFolder: name,
      currentStage: "impl-high-review",
      status: "active",
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
      ...progress,
    }, undefined, 2),
    "utf8"
  );
  return folder;
}

function readProgress(folder: string): TaskProgress {
  return JSON.parse(nodeFs.readFileSync(nodePath.join(folder, "task-progress.json"), "utf8")) as TaskProgress;
}

void describe("Tick or Exclude settles items the gate was holding (Step 7)", () => {
  const fsApi = vscode.workspace.fs as unknown as { readFile: unknown };
  const origReadFile = fsApi.readFile;
  afterEach(() => {
    fsApi.readFile = origReadFile;
  });
  function patchReadFile(): void {
    fsApi.readFile = async (uri: vscode.Uri): Promise<Uint8Array> =>
      new TextEncoder().encode(await nodeFs.promises.readFile(uri.fsPath, "utf8"));
  }

  const PLAN = ["<!-- ensemble:implementation-checklist -->", "", "- [x] Step 7: Write the tests for Part 1", "- [ ] Step 8: Open item", ""].join("\n");

  void it("on a ticked item no reviewer has verified, records the owner's tick and leaves the line alone", async () => {
    patchReadFile();
    const folder = makeTask("provisional", PLAN);
    const outcome = await applySettleChecklistItemV1(folder, "Step 7: Write the tests for Part 1", "tick", "ran them");
    assert.equal(outcome.kind, "ownerTickRecorded");
    assert.equal(nodeFs.readFileSync(nodePath.join(folder, "plan-final.md"), "utf8"), PLAN, "the plan line is not rewritten");
    const progress = readProgress(folder);
    assert.equal(progress.planItemOwnerDecisions?.length, 1);
    assert.equal(progress.planItemOwnerDecisions?.[0]?.decision, "tick");
    const counted = countChecklistEvidenceProgressV1(PLAN, progress.planItemEvidence ?? [], progress.planItemOwnerDecisions ?? []);
    assert.equal(counted?.ownerSettled, 1);
    assert.equal(counted?.provisional, 0);
  });

  void it("says why when the item is already settled or no longer there", async () => {
    patchReadFile();
    const folder = makeTask("already", PLAN);
    await applyOwnerTickToProvisionalItemV1(folder, "Step 7: Write the tests for Part 1");
    const again = await applyOwnerTickToProvisionalItemV1(folder, "Step 7: Write the tests for Part 1");
    assert.equal(again.kind, "alreadySettled");
    const gone = await applyOwnerTickToProvisionalItemV1(folder, "Step 99: nothing like it");
    assert.equal(gone.kind, "notFound");
  });

  void it("ticking an unticked item also records the owner row, so the gate counts it as settled by the owner", async () => {
    patchReadFile();
    const folder = makeTask("unticked", PLAN);
    const outcome = await applySettleChecklistItemV1(folder, "Step 8: Open item", "tick", "done by hand");
    assert.equal(outcome.kind, "settled");
    const plan = nodeFs.readFileSync(nodePath.join(folder, "plan-final.md"), "utf8");
    const progress = readProgress(folder);
    assert.equal(progress.planItemOwnerDecisions?.length, 1);
    const counted = countChecklistEvidenceProgressV1(plan, progress.planItemEvidence ?? [], progress.planItemOwnerDecisions ?? []);
    assert.equal(counted?.ownerSettled, 1, "the tick carries a note, but the owner row is keyed to the item's content");
  });
});

void describe("an owner decision answered in the chat no longer undoes verifications (Step 4)", () => {
  const fsApi = vscode.workspace.fs as unknown as { readFile: unknown };
  const origReadFile = fsApi.readFile;
  afterEach(() => {
    fsApi.readFile = origReadFile;
  });

  void it("appending the Owner Decisions line keeps every verification; a reword is recorded as its own kind and names the item", async () => {
    fsApi.readFile = async (uri: vscode.Uri): Promise<Uint8Array> =>
      new TextEncoder().encode(await nodeFs.promises.readFile(uri.fsPath, "utf8"));
    const plan = chat1Plan();
    const folder = makeTask("owner-note", plan, { planItemEvidence: verifiedEvidence(plan, true) });

    await executeOwnerPlanDecisionLockedV1({
      taskFolderPath: folder,
      stage: "impl-high-review",
      blockerId: "owner-decision-1",
      optionId: "approve",
      optionLabel: "Approve and update plan",
      planAction: { kind: "approveDeviation" },
    });
    const written = nodeFs.readFileSync(nodePath.join(folder, "plan-final.md"), "utf8");
    assert.match(written, /Owner decision 2026-\d\d-\d\d: Approve and update plan/);
    const progress = readProgress(folder);
    assert.equal(countChecklistEvidenceProgressV1(written, progress.planItemEvidence ?? [], progress.planItemOwnerDecisions ?? [])?.gate.settled, 45);

    await executeOwnerPlanDecisionLockedV1({
      taskFolderPath: folder,
      stage: "impl-high-review",
      blockerId: "owner-decision-2",
      optionId: "reword",
      optionLabel: "Reword Step 5",
      planAction: { kind: "reword", itemText: "Step 5: built part 5", newText: "Step 5: built part 5, narrowed" },
    });
    const after = readProgress(folder);
    const rewordRow = after.planItemOwnerDecisions?.find((row) => row.decision === "reword");
    assert.ok(rewordRow, "a reword is recorded as its own decision kind, not as an exclusion");
    assert.ok(!after.planItemOwnerDecisions?.some((row) => row.decision === "exclude"));
    const finalPlan = nodeFs.readFileSync(nodePath.join(folder, "plan-final.md"), "utf8");
    assert.equal(countChecklistEvidenceProgressV1(finalPlan, after.planItemEvidence ?? [], after.planItemOwnerDecisions ?? [])?.gate.settled, 44);
    assert.deepEqual(after.lastPlanItemSettlement?.lost?.labels, ["Step 5"], "the Tasks pane can say which item went back");
  });
});

void describe("a displayed count follows the settlement snapshot (review1 Step 8)", () => {
  const fsApi = vscode.workspace.fs as unknown as { readFile: unknown };
  const origReadFile = fsApi.readFile;
  afterEach(() => {
    fsApi.readFile = origReadFile;
    setPlanItemCountsObserverV1(undefined);
    resetPlanItemCountObserverForTestsV1();
  });

  void it("a display-mode count calls the observer; a gate-mode count does not", async () => {
    fsApi.readFile = async (uri: vscode.Uri): Promise<Uint8Array> =>
      new TextEncoder().encode(await nodeFs.promises.readFile(uri.fsPath, "utf8"));
    const plan = chat1Plan();
    const folder = makeTask("observer-wired", plan, { planItemEvidence: verifiedEvidence(plan, true) });
    const seen: string[] = [];
    setPlanItemCountsObserverV1((uri) => {
      seen.push(uri.fsPath);
    });
    await readPlanItemCountsV1(vscode.Uri.file(folder), { policy: "lenient", mode: "gate" });
    assert.deepEqual(seen, [], "a gate read is pure and notifies nothing");
    await readPlanItemCountsV1(vscode.Uri.file(folder), { policy: "lenient", mode: "display" });
    assert.deepEqual(seen, [folder]);
  });

  void it("an item edited by hand is named on the next displayed count, with no Ensemble command involved", async () => {
    fsApi.readFile = async (uri: vscode.Uri): Promise<Uint8Array> =>
      new TextEncoder().encode(await nodeFs.promises.readFile(uri.fsPath, "utf8"));
    const plan = chat1Plan();
    const folder = makeTask("observer-hand-edit", plan, { planItemEvidence: verifiedEvidence(plan, true) });
    const uri = vscode.Uri.file(folder);

    // The first displayed count stores the baseline; nothing was sent back.
    assert.deepEqual(await observeDisplayedPlanItemCountsV1(uri), []);
    assert.ok(readProgress(folder).lastPlanItemSettlement, "the baseline snapshot is stored");

    // The same moment again is debounced.
    assert.equal(observeDisplayedPlanItemCountsV1(uri), undefined);

    // The owner rewords one verified item by hand.
    const edited = plan.replace("- [x] Step 5: built part 5", "- [x] Step 5: built part 5, now narrower");
    nodeFs.writeFileSync(nodePath.join(folder, "plan-final.md"), edited, "utf8");
    resetPlanItemCountObserverForTestsV1();
    const lost = await observeDisplayedPlanItemCountsV1(uri);
    assert.deepEqual(lost, ["Step 5"]);
    assert.deepEqual(readProgress(folder).lastPlanItemSettlement?.lost?.labels, ["Step 5"]);

    // A third count over the same plan reports nothing new and writes nothing.
    resetPlanItemCountObserverForTestsV1();
    assert.deepEqual(await observeDisplayedPlanItemCountsV1(uri), []);
    assert.deepEqual(readProgress(folder).lastPlanItemSettlement?.lost?.labels, ["Step 5"]);
  });
});

void describe("the evidence rows the writers produce are well-formed", () => {
  void it("a recorded owner decision carries the content hash and round-trips the decoder", () => {
    const plan = chat1Plan();
    const progress = recordPlanItemOwnerDecisionV1(
      { taskFolder: "t", currentStage: "impl", status: "active", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" } as TaskProgress,
      { planRevision: getPlanRevisionV1(plan), planText: plan, itemText: "Step 31: Write the tests for Part 1", at: "t", formId: "f", decision: "tick" }
    );
    assert.equal(progress.planItemOwnerDecisions?.[0]?.itemContentHash, findPlanItemContentHashV1(plan, "Step 31: Write the tests for Part 1"));
    const decoded = decodeTaskProgressTextV1(JSON.stringify({
      ...progress,
      planItemEvidence: verifiedEvidence(plan, true),
      lastPlanItemSettlement: { at: "t", items: [{ hash: "h", settled: true, label: "Step 1" }], lost: { at: "t", labels: ["Step 2"] } },
    }));
    assert.equal(decoded.ok, true);
  });
});

void describe("identical items keep separate rows (review1 Step 2: itemKey plus occurrence)", () => {
  const sameWording = [
    "<!-- ensemble:implementation-checklist -->",
    "",
    "- [x] Step 1: Write the notes",
    "- [x] Step 1: Write the notes",
    "",
  ].join("\n");

  void it("a verification recorded for the first copy does not settle the second", () => {
    const first = recordPlanItemReviewerVerificationV1({} as TaskProgress, {
      planRevision: getPlanRevisionV1(sameWording),
      planText: sameWording,
      itemText: "Step 1: Write the notes",
      at: "t",
      evidence: "checked",
    });
    const rows = first.planItemEvidence ?? [];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.itemOccurrence, 1);
    assert.equal(countChecklistEvidenceProgressV1(sameWording, rows, [])?.gate.settled, 1);
  });

  void it("a row recorded before occurrences existed still applies to every copy", () => {
    const legacy: PlanItemEvidenceV1 = {
      planRevision: "old",
      itemKey: normalizeChecklistItemTextV1("Step 1: Write the notes"),
      itemText: "Step 1: Write the notes",
      itemContentHash: findPlanItemContentHashV1(sameWording, "Step 1: Write the notes")!,
      claims: [],
      verifications: [{ at: "t", evidence: "checked" }],
    };
    assert.equal(countChecklistEvidenceProgressV1(sameWording, [legacy], [])?.gate.settled, 2);
  });

  void it("an owner test run records which copy it covers and does not cover the identical copy", () => {
    const text = "Step 1: Write the notes";
    const progress = recordPlanItemOwnerTestRunV1({} as TaskProgress, {
      planRevision: getPlanRevisionV1(sameWording),
      planText: sameWording,
      itemTexts: [text],
      at: "t",
      formId: "form-1",
      command: "pnpm test",
      exitCode: 0,
      summary: "ok",
    });
    const runs = progress.planItemOwnerTestRuns ?? [];
    const key = normalizeChecklistItemTextV1(text);
    assert.equal(runs[0]?.itemOccurrences?.[key], 1);
    const hash = findPlanItemContentHashV1(sameWording, text)!;
    assert.equal(ownerRecordedPassingRunCoversItemV1(runs, key, hash, 1), true);
    assert.equal(ownerRecordedPassingRunCoversItemV1(runs, key, hash, 2), false, "the second copy is not covered");
    assert.equal(ownerRecordedPassingRunCoversItemV1(runs, key, hash), true, "no occurrence given: the run applies");
  });

  void it("an owner test run recorded before occurrences existed covers every copy", () => {
    const text = "Step 1: Write the notes";
    const key = normalizeChecklistItemTextV1(text);
    const legacy = [{
      planRevision: "old", source: "owner" as const, at: "t", formId: "f", command: "pnpm test",
      exitCode: 0, summary: "ok", itemKeys: [key],
    }];
    assert.equal(ownerRecordedPassingRunCoversItemV1(legacy, key, undefined, 2), true);
  });

  void it("the decoder accepts owner test runs that carry itemOccurrences and rejects bad ones", () => {
    const base = {
      taskFolder: "t", currentStage: "impl", status: "active",
      createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
    };
    const run = (itemOccurrences: unknown) => ({
      planRevision: "r", source: "owner", at: "t", formId: "f", command: "c", exitCode: 0, summary: "",
      itemKeys: ["k"], itemOccurrences,
    });
    assert.equal(decodeTaskProgressTextV1(JSON.stringify({ ...base, planItemOwnerTestRuns: [run({ k: 2 })] })).ok, true);
    assert.equal(decodeTaskProgressTextV1(JSON.stringify({ ...base, planItemOwnerTestRuns: [run({ k: 0 })] })).ok, false);
    assert.equal(decodeTaskProgressTextV1(JSON.stringify({ ...base, planItemOwnerTestRuns: [run({ k: "2" })] })).ok, false);
  });

  void it("the decoder accepts rows that carry itemOccurrence", () => {
    const row = {
      planRevision: "r",
      itemKey: "k",
      itemText: "t",
      itemContentHash: "h",
      itemOccurrence: 2,
      claims: [],
    };
    const decoded = decodeTaskProgressTextV1(JSON.stringify({
      taskFolder: "t", currentStage: "impl", status: "active",
      createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
      planItemEvidence: [row],
    }));
    assert.equal(decoded.ok, true);
  });
});

void describe("a top-level item and an identically worded child never settle each other (review fix)", () => {
  // The parent has a child worded exactly like the top-level leaf after it, so the child and the leaf hash alike.
  const plan = [
    "<!-- ensemble:implementation-checklist -->",
    "",
    "- [x] Step 1: Parent",
    "  - [x] Shared wording",
    "- [x] Shared wording",
    "",
  ].join("\n");
  const verify = (progress: TaskProgress, itemText: string, nested?: boolean): TaskProgress =>
    recordPlanItemReviewerVerificationV1(progress, {
      planRevision: getPlanRevisionV1(plan),
      planText: plan,
      itemText,
      at: "t",
      evidence: "checked",
      ...(nested === true ? { itemNested: true, itemOccurrence: 1 } : {}),
    });

  void it("the twins share a hash, which is why the level has to be recorded", () => {
    const entries = listPlanItemContentHashesV1(plan);
    const child = entries.find((entry) => entry.nested)!;
    const leaf = entries.find((entry) => !entry.nested && entry.text === "Shared wording")!;
    assert.equal(child.hash, leaf.hash);
    assert.equal(child.sharesKeyAcrossLevels, true);
    assert.equal(leaf.sharesKeyAcrossLevels, true);
  });

  void it("a verified top-level leaf does not verify the child, so the parent stays provisional", () => {
    let progress = verify({} as TaskProgress, "Step 1: Parent");
    progress = verify(progress, "Shared wording");
    const rows = progress.planItemEvidence ?? [];
    const leafRow = rows.find((row) => row.itemKey === "shared wording")!;
    assert.equal(leafRow.itemNested, false, "the row records that it belongs to the top-level item");
    const counted = countChecklistEvidenceProgressV1(plan, rows, [])!;
    assert.equal(counted.verified, 1, "only the leaf is settled");
    assert.equal(counted.provisional, 1, "the parent waits for its child");
    const settlement = listPlanItemSettlementV1(plan, rows, []);
    assert.deepEqual(settlement.map((item) => item.settled), [false, true]);
  });

  void it("verifying the child itself, at its own level, settles the parent without touching the leaf's row", () => {
    let progress = verify({} as TaskProgress, "Step 1: Parent");
    progress = verify(progress, "Shared wording", true);
    const rows = progress.planItemEvidence ?? [];
    assert.equal(rows.length, 2, "the child gets its own row, apart from the parent's");
    assert.equal(rows.find((row) => row.itemKey === "shared wording")!.itemNested, true);
    const counted = countChecklistEvidenceProgressV1(plan, rows, [])!;
    assert.equal(counted.verified, 1, "the parent is settled; the leaf has no verification of its own");
    assert.equal(counted.provisional, 1, "the top-level leaf is not settled by the child's row");
  });

  void it("an owner tick on the leaf does not settle the child either", () => {
    let progress = verify({} as TaskProgress, "Step 1: Parent");
    progress = recordPlanItemOwnerDecisionV1(progress, {
      planRevision: getPlanRevisionV1(plan),
      planText: plan,
      itemText: "Shared wording",
      at: "t",
      formId: "settle:1",
      decision: "tick",
    });
    const decisions = progress.planItemOwnerDecisions ?? [];
    assert.equal(decisions[0]?.itemNested, false);
    const counted = countChecklistEvidenceProgressV1(plan, progress.planItemEvidence ?? [], decisions)!;
    assert.equal(counted.ownerSettled, 1, "the leaf");
    assert.equal(counted.provisional, 1, "the parent still waits for its child");
  });

  void it("a row recorded before levels existed is read as the top-level item's, never the child's", () => {
    const hash = findPlanItemContentHashV1(plan, "Shared wording")!;
    const legacyLeaf: PlanItemEvidenceV1 = {
      planRevision: "old",
      itemKey: "shared wording",
      itemText: "Shared wording",
      itemContentHash: hash,
      claims: [],
      verifications: [{ at: "t", evidence: "checked" }],
    };
    const parent: PlanItemEvidenceV1 = {
      planRevision: "old",
      itemKey: normalizeChecklistItemTextV1("Step 1: Parent"),
      itemText: "Step 1: Parent",
      itemContentHash: findPlanItemContentHashV1(plan, "Step 1: Parent")!,
      claims: [],
      verifications: [{ at: "t", evidence: "checked" }],
    };
    const counted = countChecklistEvidenceProgressV1(plan, [parent, legacyLeaf], [])!;
    assert.equal(counted.verified, 1, "the leaf only");
    assert.equal(counted.provisional, 1, "the parent: its child has no row of its own");
    const entries = listPlanItemContentHashesV1(plan);
    const child = entries.find((entry) => entry.nested)!;
    const leaf = entries.find((entry) => !entry.nested && entry.text === "Shared wording")!;
    assert.equal(planItemRowAppliesV1(legacyLeaf, child), false);
    assert.equal(planItemRowAppliesV1(legacyLeaf, leaf), true);
  });

  void it("without a same-worded top-level item, a row from before levels existed still settles its child", () => {
    const solo = ["<!-- ensemble:implementation-checklist -->", "- [x] Step 1: Parent", "  - [x] Only child", ""].join("\n");
    const rows: PlanItemEvidenceV1[] = ["Step 1: Parent", "Only child"].map((itemText) => ({
      planRevision: "old",
      itemKey: normalizeChecklistItemTextV1(itemText),
      itemText,
      itemContentHash: findPlanItemContentHashV1(solo, itemText)!,
      claims: [],
      verifications: [{ at: "t", evidence: "checked" }],
    }));
    assert.equal(countChecklistEvidenceProgressV1(solo, rows, [])?.verified, 1);
    assert.equal(countChecklistEvidenceProgressV1(solo, rows, [])?.provisional, 0);
  });

  void it("the decoder accepts itemNested and rejects a non-boolean", () => {
    const base = {
      taskFolder: "t", currentStage: "impl", status: "active",
      createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
    };
    const row = (itemNested: unknown) => ({ planRevision: "r", itemKey: "k", itemText: "t", itemContentHash: "h", itemNested, claims: [] });
    assert.equal(decodeTaskProgressTextV1(JSON.stringify({ ...base, planItemEvidence: [row(true)] })).ok, true);
    assert.equal(decodeTaskProgressTextV1(JSON.stringify({ ...base, planItemEvidence: [row("yes")] })).ok, false);
    const owner = (itemNested: unknown) => ({
      planRevision: "r", itemKey: "k", itemText: "t", source: "owner", at: "t", formId: "f", decision: "tick", itemNested,
    });
    assert.equal(decodeTaskProgressTextV1(JSON.stringify({ ...base, planItemOwnerDecisions: [owner(false)] })).ok, true);
    assert.equal(decodeTaskProgressTextV1(JSON.stringify({ ...base, planItemOwnerDecisions: [owner(1)] })).ok, false);
  });
});
