/**
 * review2 Steps 3-4 (bugs6 item 28): an owner decision taken on a card or form is keyed to the plan item's issued id
 * and stores the item's own clean text. The wording a card displayed ("— Checked: …") never reaches the stored row,
 * and two identical items stay two items.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeTaskProgressTextV1 } from "../services/taskProgressDecoderV1";
import { encodeTaskProgressV1 } from "../services/taskProgressWriterV1";
import type { TaskProgress } from "../types/taskProgress";
import {
  applyOpenPlanItemsFormV1,
  cleanPlanItemTextV1,
  countChecklistEvidenceProgressV1,
  findPlanItemHashEntryByIdV1,
  getPlanRevisionV1,
  listPlanItemIdsV1,
  listUnresolvedLegacyOwnerDecisionsV1,
  resolveOwnerDecisionRowsV1,
} from "../utils/implementationChecklist";
import { describeUnresolvedLegacyOwnerDecisionsV1 } from "../commands/planItemSettlementNoticeV1";
import {
  recordPlanItemClaimEvidenceV1,
  recordPlanItemOwnerDecisionV1,
  recordPlanItemOwnerTestRunV1,
} from "../utils/taskProgressTransforms";

const PLAN = [
  "<!-- ensemble:implementation-checklist -->",
  "",
  "- [ ] Write the tests for Part 2",
  "- [ ] Write the tests for Part 2",
  "- [ ] Build the thing",
  "",
].join("\n");

const ANNOTATED = "Write the tests for Part 2 — Checked: not reached: the round did not report it built or unbuildable.";

function emptyProgress(): TaskProgress {
  return {} as unknown as TaskProgress;
}

void describe("owner decisions keyed by issued id (review2 Steps 3-4)", () => {
  void it("cleanPlanItemTextV1 removes a display note and the exclusion marker, and nothing else", () => {
    assert.equal(cleanPlanItemTextV1(ANNOTATED), "Write the tests for Part 2");
    assert.equal(cleanPlanItemTextV1("Plain item"), "Plain item");
  });

  void it("stores the clean text and the issued id, whatever text the card displayed", () => {
    const ids = listPlanItemIdsV1(PLAN);
    const second = ids[1]!;
    const next = recordPlanItemOwnerDecisionV1(emptyProgress(), {
      planRevision: getPlanRevisionV1(PLAN),
      planText: PLAN,
      itemText: ANNOTATED,
      itemId: second.itemId,
      at: "2026-11-05T08:28:27.815Z",
      formId: "form-1",
      decision: "tick",
    });
    const [row] = next.planItemOwnerDecisions ?? [];
    assert.ok(row);
    assert.equal(row.itemText, "Write the tests for Part 2", "no card annotation in the stored text");
    assert.equal(row.itemKey, "write the tests for part 2", "keyed to the clean text");
    assert.equal(row.itemId, second.itemId);
    assert.equal(row.itemOccurrence, 2, "the second of two identical items, picked by id");
    assert.equal(row.itemContentHash, findPlanItemHashEntryByIdV1(PLAN, second.itemId)?.hash);
  });

  void it("an owner tick for the second identical item settles that one and not the first", () => {
    const ids = listPlanItemIdsV1(PLAN);
    const ticked = PLAN.replace("- [ ] Write the tests for Part 2\n- [ ] Write the tests for Part 2\n", "- [x] Write the tests for Part 2\n- [x] Write the tests for Part 2\n");
    const planRevision = getPlanRevisionV1(ticked);
    const progress = recordPlanItemOwnerDecisionV1(emptyProgress(), {
      planRevision,
      planText: ticked,
      itemText: "Write the tests for Part 2",
      itemId: ids[1]!.itemId,
      at: "2026-11-05T08:28:27.815Z",
      formId: "form-1",
      decision: "tick",
    });
    const counts = countChecklistEvidenceProgressV1(ticked, [], progress.planItemOwnerDecisions ?? []);
    assert.ok(counts);
    assert.equal(counts.ownerSettled, 1, "exactly one of the two identical items is settled by the owner");
  });

  void it("two decisions for two identical items in one form are both kept", () => {
    const ids = listPlanItemIdsV1(PLAN);
    let progress = emptyProgress();
    for (const id of [ids[0]!.itemId, ids[1]!.itemId]) {
      progress = recordPlanItemOwnerDecisionV1(progress, {
        planRevision: getPlanRevisionV1(PLAN),
        planText: PLAN,
        itemText: "Write the tests for Part 2",
        itemId: id,
        at: "2026-11-05T08:28:27.815Z",
        formId: "form-1",
        decision: "tick",
      });
    }
    assert.deepEqual(
      (progress.planItemOwnerDecisions ?? []).map((row) => row.itemOccurrence),
      [1, 2]
    );
  });

  void it("an unrecognised id falls back to the clean text's first copy and keeps the id off nothing", () => {
    const next = recordPlanItemOwnerDecisionV1(emptyProgress(), {
      planRevision: getPlanRevisionV1(PLAN),
      planText: PLAN,
      itemText: "Build the thing",
      itemId: "ffffffffffffffff",
      at: "2026-11-05T08:28:27.815Z",
      formId: "form-1",
      decision: "tick",
    });
    const [row] = next.planItemOwnerDecisions ?? [];
    assert.equal(row?.itemText, "Build the thing");
    assert.equal(row?.itemOccurrence, 1);
  });

  void it("claim evidence and owner test runs also store clean text", () => {
    const claim = recordPlanItemClaimEvidenceV1(emptyProgress(), {
      planRevision: getPlanRevisionV1(PLAN),
      planText: PLAN,
      itemText: ANNOTATED,
      source: "implementation",
      at: "2026-11-05T08:00:00.000Z",
    });
    assert.equal(claim.planItemEvidence?.[0]?.itemText, "Write the tests for Part 2");
    assert.equal(claim.planItemEvidence?.[0]?.itemKey, "write the tests for part 2");
    const run = recordPlanItemOwnerTestRunV1(emptyProgress(), {
      planRevision: getPlanRevisionV1(PLAN),
      planText: PLAN,
      itemTexts: [ANNOTATED],
      at: "2026-11-05T08:00:00.000Z",
      formId: "run-1",
      command: "pnpm test",
      exitCode: 0,
      summary: "ok",
    });
    assert.deepEqual(run.planItemOwnerTestRuns?.[0]?.itemKeys, ["write the tests for part 2"]);
  });

  void it("the open-items form reports each settled item by id with its clean text, though the plan line carries the note", () => {
    const ids = listPlanItemIdsV1(PLAN);
    const applied = applyOpenPlanItemsFormV1(
      PLAN,
      new Set(ids.map((entry) => entry.itemId)),
      [{ itemId: ids[1]!.itemId, choice: "tick", note: "not reached: the round did not report it built or unbuildable" }],
      "2026-11-05"
    );
    assert.ok(applied.ok);
    if (!applied.ok) return;
    assert.match(applied.content, /- \[x\] Write the tests for Part 2 — Checked: not reached/);
    assert.deepEqual(applied.decided, [
      { itemId: ids[1]!.itemId, itemText: "Write the tests for Part 2", decision: "tick" },
    ]);
    assert.match(applied.tickedWritten[0]!, /— Checked:/, "the written text keeps the note on the plan line");
    // The row recorded from `decided` is keyed to the id and carries no note.
    const row = recordPlanItemOwnerDecisionV1(emptyProgress(), {
      planRevision: getPlanRevisionV1(applied.content),
      planText: applied.content,
      itemText: applied.decided[0]!.itemText,
      itemId: applied.decided[0]!.itemId,
      at: "2026-11-05T08:28:27.815Z",
      formId: "form-1",
      decision: "tick",
    }).planItemOwnerDecisions?.[0];
    assert.equal(row?.itemText, "Write the tests for Part 2");
    assert.equal(row?.itemId, ids[1]!.itemId);
    assert.equal(row?.itemOccurrence, 2);
  });

  void it("a legacy decision with no id that names two identical items settles neither and is listed as unresolved (Step 5)", () => {
    const ticked = "<!-- ensemble:implementation-checklist -->\n\n- [x] Same words\n- [x] Same words\n- [x] Solo item\n";
    const rows = [
      { planRevision: "r", itemKey: "same words", itemText: "Same words — Checked: x.", decision: "tick" },
      { planRevision: "r", itemKey: "solo item", itemText: "Solo item", decision: "tick" },
    ];
    const resolved = resolveOwnerDecisionRowsV1(ticked, rows);
    assert.deepEqual(resolved.unresolved.map((row) => row.itemKey), ["same words"]);
    assert.deepEqual(resolved.byContent.map((row) => row.itemKey), ["solo item"]);
    const counts = countChecklistEvidenceProgressV1(ticked, [], rows);
    assert.equal(counts?.ownerSettled, 1, "only the uniquely named item is settled by the legacy rows");
    assert.deepEqual(listUnresolvedLegacyOwnerDecisionsV1(ticked, rows).map((row) => row.itemKey), ["same words"]);
    const line = describeUnresolvedLegacyOwnerDecisionsV1(resolved.unresolved);
    assert.match(line, /"Same words — Checked: x\."/);
    assert.match(line, /more than one plan item shares/);
  });

  void it("a decision with an issued id still counts after unrelated plan revisions (Step 8)", () => {
    const before = "<!-- ensemble:implementation-checklist -->\n\n- [x] Alpha\n- [x] Beta\n";
    const id = listPlanItemIdsV1(before).find((entry) => entry.itemText === "Beta")!.itemId;
    const rows = recordPlanItemOwnerDecisionV1(emptyProgress(), {
      planRevision: getPlanRevisionV1(before),
      planText: before,
      itemText: "Beta",
      itemId: id,
      at: "2026-11-05T08:28:27.815Z",
      formId: "form-1",
      decision: "tick",
    }).planItemOwnerDecisions!;
    // Unrelated revisions: a new item before it, another item reworded, a new item after it.
    const after = "<!-- ensemble:implementation-checklist -->\n\n- [ ] Brand new first\n- [x] Alpha reworded\n- [x] Beta\n- [ ] Tail\n";
    assert.notEqual(getPlanRevisionV1(before), getPlanRevisionV1(after));
    assert.equal(countChecklistEvidenceProgressV1(after, [], rows)?.ownerSettled, 1);
    // An item the id does not name is not settled by it.
    const renamed = "<!-- ensemble:implementation-checklist -->\n\n- [x] Alpha\n- [x] Beta renamed\n";
    assert.equal(countChecklistEvidenceProgressV1(renamed, [], rows)?.ownerSettled, 0);
  });

  void it("the decoder keeps a decision's itemId through a write and read", () => {
    const ids = listPlanItemIdsV1(PLAN);
    const progress = recordPlanItemOwnerDecisionV1(
      {
        taskFolder: "t",
        currentStage: "impl",
        status: "active",
        createdAt: "2026-11-05T08:00:00.000Z",
        updatedAt: "2026-11-05T08:00:00.000Z",
      } as unknown as TaskProgress,
      {
        planRevision: getPlanRevisionV1(PLAN),
        planText: PLAN,
        itemText: "Build the thing",
        itemId: ids[2]!.itemId,
        at: "2026-11-05T08:28:27.815Z",
        formId: "form-1",
        decision: "tick",
      }
    );
    const decoded = decodeTaskProgressTextV1(
      encodeTaskProgressV1({ ...progress, ensembleProgressVersion: 1 } as unknown as Parameters<typeof encodeTaskProgressV1>[0])
    );
    assert.equal(decoded.ok, true);
    if (decoded.ok) assert.equal(decoded.decoded.progress.planItemOwnerDecisions?.[0]?.itemId, ids[2]!.itemId);
  });
});
