/**
 * bugs4 Step 11 (item 7): an owner tick made through the open-items form is an
 * explicit owner decision. It settles the item for the completeness gate with
 * owner provenance, never counts as reviewer verification, and leaves the
 * evidence rules for model claims untouched.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeTaskProgressTextV1 } from "../services/taskProgressDecoderV1";
import { encodeTaskProgressV1 } from "../services/taskProgressWriterV1";
import { TaskProgress } from "../types/taskProgress";
import {
  countChecklistEvidenceProgressV1,
  describeChecklistGateGapV1,
  EXCLUDED_CHECKLIST_ITEM_MARKER_V1,
  formatChecklistEvidenceForReviewerV1,
  getPlanRevisionV1,
  listProvisionalTestDependentChecklistItemsV1,
  normalizeChecklistItemTextV1,
} from "../utils/implementationChecklist";
import { recordPlanItemOwnerDecisionV1 } from "../utils/taskProgressTransforms";
import { buildStayingOnStageNoticeV1, withoutExcludedFromCountV1 } from "../commands/reviewActions";

const M = EXCLUDED_CHECKLIST_ITEM_MARKER_V1;

/** The captured shape: 63 ticked items and 8 owner hand-offs excluded (71 total). */
function incidentPlan(): string {
  const lines: string[] = [];
  for (let i = 1; i <= 63; i++) lines.push(`- [x] Build part ${i}`);
  for (let i = 1; i <= 8; i++) lines.push(`- [ ] Owner hand-off ${i} ${M}`);
  return ["<!-- ensemble:implementation-checklist -->", "", ...lines, ""].join("\n");
}

function claimOnlyEvidence(plan: string): TaskProgress["planItemEvidence"] {
  const planRevision = getPlanRevisionV1(plan);
  const out: NonNullable<TaskProgress["planItemEvidence"]> = [];
  for (let i = 1; i <= 56; i++) {
    out.push({
      planRevision,
      itemKey: normalizeChecklistItemTextV1(`Build part ${i}`),
      itemText: `Build part ${i}`,
      claims: [{ source: "implementation", at: "2026-10-29T00:00:00.000Z" }],
    });
  }
  return out;
}

function withOwnerTicks(plan: string, count: number): TaskProgress {
  let progress = { planItemEvidence: claimOnlyEvidence(plan) } as unknown as TaskProgress;
  const planRevision = getPlanRevisionV1(plan);
  for (let i = 1; i <= count; i++) {
    progress = recordPlanItemOwnerDecisionV1(progress, {
      planRevision, itemText: `Build part ${i}`, at: "2026-10-29T00:44:55.000Z", formId: "form-1", decision: "tick",
    });
  }
  return progress;
}

/** The gate as every caller reads it: evidence entries plus the top-level owner decisions. */
function gateOf(plan: string, progress: Pick<TaskProgress, "planItemEvidence" | "planItemOwnerDecisions">) {
  return countChecklistEvidenceProgressV1(plan, progress.planItemEvidence ?? [], progress.planItemOwnerDecisions ?? []);
}

void describe("owner decisions in the completeness gate (bugs4 Step 11, item 7)", () => {
  void it("reproduces the captured gap: 63 ticked boxes, model claims only, 8 of 71 settled", () => {
    const plan = incidentPlan();
    const evidence = countChecklistEvidenceProgressV1(plan, claimOnlyEvidence(plan) ?? []);
    assert.ok(evidence);
    assert.equal(evidence.gate.total, 71);
    assert.equal(evidence.gate.settled, 8);
    assert.equal(evidence.gate.remaining, 63);
    assert.equal(evidence.ownerSettled, 0);
  });

  void it("counts form ticks as settled with owner provenance, apart from reviewer verification", () => {
    const plan = incidentPlan();
    const evidence = gateOf(plan, withOwnerTicks(plan, 63));
    assert.ok(evidence);
    assert.equal(evidence.gate.settled, 71);
    assert.equal(evidence.gate.remaining, 0, "nothing open, so the continuation can offer Advance");
    assert.equal(evidence.verified, 0, "an owner tick is never reviewer verification");
    assert.equal(evidence.ownerSettled, 63);
    assert.equal(evidence.provisional, 0);
    assert.equal(describeChecklistGateGapV1(evidence), "63 ticked, 0 verified by review, 63 settled by you");
  });

  void it("control: a model tick with no reviewer verification and no owner decision stays provisional", () => {
    const plan = incidentPlan();
    const evidence = gateOf(plan, withOwnerTicks(plan, 60));
    assert.ok(evidence);
    assert.equal(evidence.ownerSettled, 60);
    assert.equal(evidence.provisional, 3, "parts 61-63 carry no decision and stay provisional");
    assert.equal(evidence.gate.remaining, 3);
  });

  void it("control: a test-dependent model claim with no passing report stays provisional, with or without a reviewer-free gate", () => {
    const plan = ["<!-- ensemble:implementation-checklist -->", "", "- [x] Add a unit test that covers the new parser", ""].join("\n");
    const planRevision = getPlanRevisionV1(plan);
    const claim = [{
      planRevision, itemKey: normalizeChecklistItemTextV1("Add a unit test that covers the new parser"),
      itemText: "Add a unit test that covers the new parser", claims: [{ source: "implementation" as const, at: "t" }],
    }];
    const counted = countChecklistEvidenceProgressV1(plan, claim);
    assert.ok(counted);
    assert.equal(counted.provisional, 1, "a model tick with no verification is provisional");
    assert.equal(counted.gate.remaining, 1);
    assert.deepEqual(
      listProvisionalTestDependentChecklistItemsV1(plan, undefined),
      ["Add a unit test that covers the new parser"],
      "the test-evidence rule still holds the item without a passing report"
    );
  });

  void it("an owner decision does not settle an item whose box is no longer ticked", () => {
    const ticked = incidentPlan();
    const evidence = withOwnerTicks(ticked, 63);
    const unticked = ticked.replace("- [x] Build part 1\n", "- [ ] Build part 1\n");
    // Ticks do not change the plan revision, so the entry still matches; the box does not.
    assert.equal(getPlanRevisionV1(unticked), getPlanRevisionV1(ticked));
    const counted = gateOf(unticked, evidence);
    assert.ok(counted);
    assert.equal(counted.ownerSettled, 62);
    assert.equal(counted.gate.remaining, 1);
  });

  void it("ignores an owner decision recorded against a different plan revision", () => {
    const plan = incidentPlan();
    const ticked = withOwnerTicks(plan, 63);
    const stale = (ticked.planItemOwnerDecisions ?? []).map((row) => ({ ...row, planRevision: "0".repeat(64) }));
    const counted = gateOf(plan, { planItemEvidence: ticked.planItemEvidence, planItemOwnerDecisions: stale });
    assert.ok(counted);
    assert.equal(counted.ownerSettled, 0);
  });

  void it("an exclusion decision is not a tick", () => {
    const plan = incidentPlan();
    let progress = { planItemEvidence: [] } as unknown as TaskProgress;
    progress = recordPlanItemOwnerDecisionV1(progress, {
      planRevision: getPlanRevisionV1(plan), itemText: "Build part 1", at: "t", formId: "f", decision: "exclude",
    });
    const counted = gateOf(plan, progress);
    assert.ok(counted);
    assert.equal(counted.ownerSettled, 0);
  });

  void it("an item that is both reviewer-verified and owner-decided counts once, as verified", () => {
    const plan = incidentPlan();
    const planRevision = getPlanRevisionV1(plan);
    const ticked = withOwnerTicks(plan, 1);
    const entries = (ticked.planItemEvidence ?? []).map((entry) =>
      entry.itemText === "Build part 1" ? { ...entry, verifications: [{ at: "t", evidence: "checked" }] } : entry);
    const counted = gateOf(plan, {
      planItemEvidence: entries.map((entry) => ({ ...entry, planRevision })),
      planItemOwnerDecisions: ticked.planItemOwnerDecisions,
    });
    assert.ok(counted);
    assert.equal(counted.verified, 1);
    assert.equal(counted.ownerSettled, 0, "the one owner-decided item is already counted as verified");
  });

  void it("an owner-decided parent stays open while a nested child is neither verified nor decided", () => {
    const plan = ["<!-- ensemble:implementation-checklist -->", "", "- [x] Parent", "  - [x] Child", ""].join("\n");
    const planRevision = getPlanRevisionV1(plan);
    let progress = { planItemEvidence: [] } as unknown as TaskProgress;
    progress = recordPlanItemOwnerDecisionV1(progress, { planRevision, itemText: "Parent", at: "t", formId: "f", decision: "tick" });
    assert.equal(gateOf(plan, progress)?.gate.remaining, 1);
    progress = recordPlanItemOwnerDecisionV1(progress, { planRevision, itemText: "Child", at: "t", formId: "f", decision: "tick" });
    assert.equal(gateOf(plan, progress)?.gate.remaining, 0);
  });

  void it("recording the same form decision twice adds one record", () => {
    const plan = incidentPlan();
    const input = { planRevision: getPlanRevisionV1(plan), itemText: "Build part 1", at: "t", formId: "f", decision: "tick" as const };
    let progress = { planItemEvidence: [] } as unknown as TaskProgress;
    progress = recordPlanItemOwnerDecisionV1(progress, input);
    progress = recordPlanItemOwnerDecisionV1(progress, { ...input, at: "later" });
    assert.equal(progress.planItemOwnerDecisions?.length, 1);
    assert.equal(progress.planItemEvidence?.length, 0, "owner decisions never touch planItemEvidence entries");
  });

  void it("the reviewer-facing count names owner-settled items separately", () => {
    const plan = incidentPlan();
    const ticked = withOwnerTicks(plan, 10);
    const text = formatChecklistEvidenceForReviewerV1(plan, ticked.planItemEvidence ?? [], ticked.planItemOwnerDecisions ?? []);
    assert.match(text, /0 reviewer-verified; 53 provisional; 10 settled by the owner; 8 explicitly excluded/);
  });
});

void describe("planItemOwnerDecisions round-trip through the task-progress decoder", () => {
  const base = {
    taskFolder: "2026-07-01_task_1", currentStage: "impl",
    createdAt: "2026-07-01T10:00:00.000Z", updatedAt: "2026-07-02T11:30:00.000Z",
  };
  const record = (overrides: Record<string, unknown> = {}) => ({
    planRevision: "a".repeat(64), itemKey: "build part 1", itemText: "Build part 1",
    source: "owner", at: "2026-10-29T00:44:55.000Z", formId: "form-1", decision: "tick", ...overrides,
  });
  /** The `planItemEvidence` entry property set every shipped build accepts. */
  const SHIPPED_ENTRY_KEYS = new Set(["planRevision", "itemKey", "itemText", "claims", "verifications", "testReports"]);

  void it("decodes valid owner decisions unchanged", () => {
    const rows = [record()];
    const result = decodeTaskProgressTextV1(JSON.stringify({ ...base, planItemOwnerDecisions: rows }));
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.decoded.progress.planItemOwnerDecisions, rows);
  });

  void it("rejects a non-owner source, an unknown decision and extra properties", () => {
    for (const bad of [
      record({ source: "reviewer" }),
      record({ decision: "verify" }),
      record({ extra: 1 }),
      "tick",
    ]) {
      const result = decodeTaskProgressTextV1(JSON.stringify({ ...base, planItemOwnerDecisions: [bad] }));
      assert.equal(result.ok, false, JSON.stringify(bad));
    }
    assert.equal(decodeTaskProgressTextV1(JSON.stringify({ ...base, planItemOwnerDecisions: "tick" })).ok, false);
  });

  void it("downgrade: a file carrying owner decisions has only shipped planItemEvidence keys and a non-reserved top-level name", () => {
    const plan = incidentPlan();
    const ticked = withOwnerTicks(plan, 3);
    const text = encodeTaskProgressV1({ ...base, ...ticked, ensembleProgressVersion: 1 } as unknown as Parameters<typeof encodeTaskProgressV1>[0]);
    const raw = JSON.parse(text) as Record<string, unknown>;
    // A shipped decoder keeps an unknown top-level field that does not start
    // with "ensemble" as an opaque entry, and rejects unknown entry properties.
    assert.ok(Array.isArray(raw["planItemOwnerDecisions"]) && raw["planItemOwnerDecisions"].length === 3);
    assert.ok(!"planItemOwnerDecisions".startsWith("ensemble"));
    for (const entry of raw["planItemEvidence"] as Record<string, unknown>[]) {
      assert.ok(Object.keys(entry).every((key) => SHIPPED_ENTRY_KEYS.has(key)), `entry keys: ${Object.keys(entry).join(",")}`);
    }
    assert.equal(decodeTaskProgressTextV1(text).ok, true);
  });

  void it("migrates entry-level ownerDecisions written by the earlier build to the top-level list", () => {
    const legacy = { ...base, planItemEvidence: [{
      planRevision: "a".repeat(64), itemKey: "build part 1", itemText: "Build part 1", claims: [],
      ownerDecisions: [{ source: "owner", at: "2026-10-29T00:44:55.000Z", formId: "form-1", decision: "tick" }],
    }] };
    const result = decodeTaskProgressTextV1(JSON.stringify(legacy));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.decoded.progress.planItemOwnerDecisions, [record()]);
    assert.equal("ownerDecisions" in (result.decoded.progress.planItemEvidence?.[0] ?? {}), false);
    // The next write is readable by a shipped build.
    const rewritten = JSON.parse(encodeTaskProgressV1(
      { ...result.decoded.progress, ensembleProgressVersion: 1 }, result.decoded.entries
    )) as { planItemEvidence: Record<string, unknown>[] };
    assert.ok(rewritten.planItemEvidence.every((entry) => Object.keys(entry).every((key) => SHIPPED_ENTRY_KEYS.has(key))));
  });

  void it("a malformed legacy entry-level ownerDecisions is still rejected", () => {
    const bad = { ...base, planItemEvidence: [{
      planRevision: "a".repeat(64), itemKey: "k", itemText: "t", claims: [],
      ownerDecisions: [{ source: "reviewer", at: "t", formId: "f", decision: "tick" }],
    }] };
    assert.equal(decodeTaskProgressTextV1(JSON.stringify(bad)).ok, false);
  });
});

void describe("the stay-on-stage notice does not count excluded steps as implemented (item 7, second occurrence)", () => {
  void it("takes excluded steps out of both sides, so they are named once", () => {
    const counted = withoutExcludedFromCountV1({ complete: 8, total: 71 }, 8);
    assert.deepEqual(counted, { complete: 0, total: 63 });
    const notice = buildStayingOnStageNoticeV1(8, counted, " (8 additional step(s) marked excluded from this count)", false);
    assert.match(notice, /0 of 63 plan steps are implemented \(8 additional step\(s\) marked excluded/);
  });

  void it("leaves the count alone when nothing is excluded", () => {
    assert.deepEqual(withoutExcludedFromCountV1({ complete: 3, total: 5 }, 0), { complete: 3, total: 5 });
  });
});
