/**
 * bugs3 item 18: a review that says "Unfinished Steps 1–3 and unbuilt Steps
 * 4–10 remain" against a plan whose steps are numbered section headings with
 * unnumbered checklist items must be read as unbuilt work — so the card
 * recommends building it and the running-Implementation card keeps the run.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveBlockerPlanReferencesV1 } from "../utils/implementationChecklist";
import {
  decidePostReviewActionV1,
  isUnbuiltWorkBlockerV1,
  runningImplementationRecommendedOptionV1,
  taskFixableAreAllUnbuiltWorkV1,
} from "../utils/reviewRouting";
import type { ReviewBlocker } from "../utils/reviewReadiness";
import type { ReviewScoreHistoryEntry } from "../types/taskProgress";

const VERBATIM_UNBUILT =
  "Unfinished Steps 1–3 and unbuilt Steps 4–10 remain: complete schema reconciliation/inventory, catalog drift " +
  "integration, dependency/bundling and multipart support, offline recovery and fixtures, portable " +
  "entrypoint/runbook, exporter/provenance, validator/combined alarm, digest, and owner-gated retention.";
const VERBATIM_OWNER_EVIDENCE =
  "Owner evidence needed: selected historical export source key/version ID, preserved compatibility destination " +
  "key/version ID, and source/destination HEAD byte lengths recorded in task.md before Step 10.";

function items(prefix: string, settled: number, open: number): string[] {
  return [
    ...Array.from({ length: settled }, (_, i) => `- [x] ${prefix} settled item ${i + 1}`),
    ...Array.from({ length: open }, (_, i) => `- [ ] ${prefix} open item ${i + 1}`),
  ];
}

/** 114 items, 15 settled: Steps 1–3 partly done, 4–9 unbuilt, 10 owner-gated. */
function groupedPlan(): string {
  const lines = ["<!-- ensemble:implementation-checklist -->", "", "# Plan", ""];
  const sections: [number, number, number][] = [
    [1, 6, 2],
    [2, 5, 1],
    [3, 4, 1],
    [4, 0, 14],
    [5, 0, 14],
    [6, 0, 14],
    [7, 0, 14],
    [8, 0, 14],
    [9, 0, 14],
    [10, 0, 11],
  ];
  for (const [n, settled, open] of sections) {
    lines.push(`### ${n}. Section ${n}`, "", ...items(`S${n}`, settled, open), "");
  }
  return lines.join("\n");
}

const PLAN = groupedPlan();

function ref(text: string, plan = PLAN): string[] {
  return resolveBlockerPlanReferencesV1(text, plan).map((r) => `${r.reference}:${r.open}/${r.settled}`);
}

void describe("grouped step references against numbered section headings", () => {
  void it("fixture has 114 items with 15 settled", () => {
    assert.equal((PLAN.match(/^- \[[ x]\]/gm) ?? []).length, 114);
    assert.equal((PLAN.match(/^- \[x\]/gm) ?? []).length, 15);
  });

  void it("counts only open items in a partly settled section", () => {
    assert.deepEqual(ref("Step 1 remains incomplete"), ["Step 1:2/6"]);
    assert.deepEqual(ref("Steps 1, 2 and 3"), ["Step 1:2/6", "Step 2:1/5", "Step 3:1/4"]);
  });

  for (const [label, text] of [
    ["en-dash range", "Steps 4–6"],
    ["hyphen range", "Steps 4-6"],
    ["to range", "Steps 4 to 6"],
    ["list", "Steps 4, 5 and 6"],
    ["singular repeated", "Step 4, Step 5 and Step 6"],
  ] as const) {
    void it(`resolves ${label}`, () => {
      assert.deepEqual(ref(text), ["Step 4:14/0", "Step 5:14/0", "Step 6:14/0"]);
    });
  }

  void it("resolves the verbatim blocker into Steps 1–10", () => {
    const refs = ref(VERBATIM_UNBUILT);
    assert.equal(refs.length, 10);
    assert.equal(refs[0], "Step 1:2/6");
    assert.equal(refs[9], "Step 10:11/0");
  });

  void it("is conservative about malformed, reversed, unknown or over-wide references", () => {
    assert.deepEqual(ref("Steps 9–4"), []);
    assert.deepEqual(ref("Steps 4–11"), [], "Step 11 does not exist, so the whole range is dropped");
    assert.deepEqual(ref("Steps 1–500"), []);
    assert.deepEqual(ref("Step 99"), []);
  });

  void it("treats a number that repeats across Parts as ambiguous unless the Part is named", () => {
    const plan = [
      "<!-- ensemble:implementation-checklist -->",
      "## Part A",
      "### 1. alpha",
      "- [ ] a one",
      "## Part B",
      "### 1. beta",
      "- [x] b one",
      "",
    ].join("\n");
    assert.deepEqual(ref("Step 1 remains open", plan), []);
    assert.deepEqual(ref("Part B Step 1 remains open", plan), ["Step 1:0/1"]);
  });
});

void describe("the reported unbuilt-work wording", () => {
  void it("is unbuilt work", () => {
    assert.equal(isUnbuiltWorkBlockerV1(VERBATIM_UNBUILT, PLAN), true);
  });

  void it("accepts singular, plural, list and range equivalents", () => {
    for (const text of [
      "Unfinished Step 4 remains.",
      "Unbuilt Steps 4-9 remain.",
      "Steps 4, 5 and 6 are unfinished.",
      "Unfinished Steps 4 to 9 remain: build the exporter.",
    ]) {
      assert.equal(isUnbuiltWorkBlockerV1(text, PLAN), true, text);
    }
  });

  void it("stays false for defects, unresolved references and settled work", () => {
    for (const text of [
      "Unbuilt Steps 4–11 remain.",
      "Unbuilt Steps 9–4 remain.",
      "Unfinished Step 4 is broken and throws on an empty list.",
      "The exporter is unfinished.",
    ]) {
      assert.equal(isUnbuiltWorkBlockerV1(text, PLAN), false, text);
    }
    const settledPlan = PLAN.replace(/- \[ \] S4 open item/g, "- [x] S4 open item");
    assert.equal(isUnbuiltWorkBlockerV1("Unbuilt Step 4 remains.", settledPlan), false);
  });
});

function entry(blockers: ReviewBlocker[]): ReviewScoreHistoryEntry {
  return {
    stage: "impl-high-review",
    score: 7,
    attemptId: "a13",
    at: "2026-10-27T10:00:00.000Z",
    blockerCount: blockers.length,
    taskFixableCount: blockers.filter((b) => b.resolver === "task-fixable").length,
    blockers: blockers.map((b, i) => ({ ...b, subject: `s${i}` })),
  };
}

const UNBUILT: ReviewBlocker = {
  category: "completion",
  resolver: "task-fixable",
  description: VERBATIM_UNBUILT,
  origin: "reviewer",
};
const OWNER: ReviewBlocker = {
  category: "completion",
  resolver: "environmental",
  description: VERBATIM_OWNER_EVIDENCE,
  origin: "reviewer",
};

void describe("item 18 routing with the verbatim blockers", () => {
  const stages = ["impl-high-review", "impl-low-review"] as const;

  void it("every task-fixable blocker is unbuilt work even beside the owner-evidence blocker", () => {
    assert.equal(taskFixableAreAllUnbuiltWorkV1([UNBUILT, OWNER], PLAN), true);
  });

  void it("recommends letting the running Implementation round run", () => {
    const decision = decidePostReviewActionV1({
      history: [entry([UNBUILT, OWNER])],
      stages,
      hasUntickedChecklistItems: true,
      planOfRecord: PLAN,
    });
    assert.equal(decision.recommendLetItRun, true);
    assert.equal(runningImplementationRecommendedOptionV1(decision), "letItRun");
  });

  void it("keeps Apply Review for a real defect or an architectural blocker", () => {
    for (const blockers of [
      [UNBUILT, { ...UNBUILT, description: "Step 2's reconciler throws on an empty inventory." }],
      [{ ...UNBUILT, category: "architectural" as const }],
    ]) {
      const decision = decidePostReviewActionV1({
        history: [entry(blockers)],
        stages,
        hasUntickedChecklistItems: true,
        planOfRecord: PLAN,
      });
      assert.equal(decision.recommendLetItRun, false);
      assert.equal(runningImplementationRecommendedOptionV1(decision), "goToReviewAndApply");
    }
  });
});
