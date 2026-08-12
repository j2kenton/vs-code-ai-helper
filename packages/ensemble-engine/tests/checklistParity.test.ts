/**
 * Checklist/`N/M` parity suite (plan Part 4a).
 *
 * The engine's `checklistProgressV1.ts` is a semantic port of the
 * extension's plan-progress machinery. Like the Part 2 dual-decode suite,
 * this runs BOTH implementations — the extension's
 * `src/utils/implementationChecklist.ts` + `src/utils/reviewReadiness.ts`
 * imported directly, and the engine's port — over the same document corpus
 * and requires identical results: counts, merges (byte-identical output),
 * marker parses, and checklist reconciliation.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import * as engine from "../src/checklistProgressV1";
import * as srcChecklist from "../../../src/utils/implementationChecklist";
import * as srcReadiness from "../../../src/utils/reviewReadiness";

const PLAN_BASIC = [
  "<!-- ensemble:implementation-checklist -->",
  "",
  "# Implementation Checklist",
  "",
  "- [ ] first step",
  "- [x] second step",
  "- [ ] third step",
  "",
].join("\n");

const PLAN_WITH_FENCED_EXAMPLE = [
  "<!-- ensemble:implementation-checklist -->",
  "",
  "- [ ] real item one",
  "- [ ] real item two",
  "",
  "```markdown",
  "<!-- ensemble:implementation-checklist -->",
  "- [x] fenced example item",
  "```",
  "",
].join("\n");

const PLAN_DUPLICATE_ITEMS = [
  "<!-- ensemble:implementation-checklist -->",
  "",
  "- [ ] add the web smoke check",
  "- [ ] add the web smoke check",
  "- [ ] wire the CI lane",
  "",
].join("\n");

const PLAN_CRLF = "<!-- ensemble:implementation-checklist -->\r\n\r\n- [ ] crlf item one\r\n- [x] crlf item two\r\n";

const PLAN_TWO_RENDERINGS = [
  "<!-- ensemble:implementation-checklist -->",
  "- [ ] older copy item",
  "",
  "prose between renderings",
  "",
  "<!-- ensemble:implementation-checklist -->",
  "- [x] newer copy item",
  "- [ ] newer copy second item",
  "",
].join("\n");

const SUMMARY_ECHO = [
  "<!-- ensemble:implementation-checklist -->",
  "",
  "# Implementation Checklist",
  "",
  "- [x] first step",
  "- [x] second step",
  "- [ ] third step",
  "",
  "## Files Changed",
  "- src/a.ts — created",
  "",
  "## Verification",
  "- [x] a verification tick that must NOT count as plan progress",
  "",
  "<!-- progress: 2/3 -->",
  "",
].join("\n");

const SUMMARY_DUPLICATES = [
  "<!-- ensemble:implementation-checklist -->",
  "- [x] add the web smoke check",
  "- [ ] add the web smoke check",
  "- [x] wire the CI lane",
  "",
  "## Files Changed",
  "- apps/mobile/smoke.ts — created",
  "",
].join("\n");

const NO_CHECKLIST_DOC = [
  "# Just prose",
  "",
  "This plan quotes the marker `<!-- ensemble:implementation-checklist -->` in prose.",
  "",
].join("\n");

const CORPUS: Record<string, string> = {
  PLAN_BASIC,
  PLAN_WITH_FENCED_EXAMPLE,
  PLAN_DUPLICATE_ITEMS,
  PLAN_CRLF,
  PLAN_TWO_RENDERINGS,
  SUMMARY_ECHO,
  SUMMARY_DUPLICATES,
  NO_CHECKLIST_DOC,
};

test("countChecklistProgressV1 agrees with the extension for every corpus document", () => {
  for (const [name, doc] of Object.entries(CORPUS)) {
    assert.deepEqual(
      engine.countChecklistProgressV1(doc),
      srcChecklist.countChecklistProgressV1(doc),
      `${name}: count divergence`
    );
  }
});

test("hasImplementationChecklistV1 agrees with the extension", () => {
  for (const [name, doc] of Object.entries(CORPUS)) {
    assert.equal(
      engine.hasImplementationChecklistV1(doc),
      srcChecklist.hasImplementationChecklistV1(doc),
      `${name}: presence divergence`
    );
  }
});

test("mergeChecklistProgressV1 produces byte-identical merges", () => {
  const pairs: Array<{ plan: string; summary: string; label: string }> = [
    { plan: PLAN_BASIC, summary: SUMMARY_ECHO, label: "basic echo merge" },
    { plan: PLAN_DUPLICATE_ITEMS, summary: SUMMARY_DUPLICATES, label: "duplicate-item count merge" },
    { plan: PLAN_BASIC, summary: NO_CHECKLIST_DOC, label: "no-op merge (no echo)" },
    { plan: PLAN_TWO_RENDERINGS, summary: SUMMARY_ECHO, label: "latest-rendering confinement" },
  ];
  for (const { plan, summary, label } of pairs) {
    assert.deepEqual(
      engine.mergeChecklistProgressV1(plan, summary),
      srcChecklist.mergeChecklistProgressV1(plan, summary),
      `${label}: merge divergence`
    );
  }
  // Ticks-only invariant: the merge never unticks second step even though the
  // summary could regress it.
  const merged = engine.mergeChecklistProgressV1(PLAN_BASIC, SUMMARY_ECHO);
  assert.ok(merged !== undefined && merged.includes("- [x] second step"));
});

test("progress marker parse agrees with the extension", () => {
  const docs = [
    "prose <!-- progress: 3/14 --> more prose",
    "example <!-- progress: 1/2 --> then final <!-- progress: 8/25 -->",
    "<!-- progress: 5/0 -->",
    "<!-- progress: 6/5 -->",
    "no marker at all",
    "<!--   PROGRESS :  2 / 9   -->",
  ];
  for (const doc of docs) {
    assert.deepEqual(
      engine.parseReviewProgressV1(doc),
      srcReadiness.parseReviewProgress(doc),
      `marker parse divergence for ${JSON.stringify(doc)}`
    );
  }
});

test("checklist reconciliation agrees with the extension (checklist authority)", () => {
  const cases: Array<{
    progress: { complete: number; total: number } | null;
    checklist: { total: number; checked: number; remaining: number } | undefined;
  }> = [
    // The 47-item plan vs a narrowed 5/5 marker (the historical failure).
    { progress: { complete: 5, total: 5 }, checklist: { total: 47, checked: 6, remaining: 41 } },
    // Fully ticked checklist does NOT override a marker reporting work left.
    { progress: { complete: 3, total: 5 }, checklist: { total: 4, checked: 4, remaining: 0 } },
    { progress: null, checklist: { total: 4, checked: 1, remaining: 3 } },
    { progress: null, checklist: undefined },
    { progress: { complete: 2, total: 4 }, checklist: undefined },
  ];
  for (const { progress, checklist } of cases) {
    assert.deepEqual(
      engine.reconcileProgressWithChecklistV1(progress, checklist),
      srcReadiness.reconcileProgressWithChecklistV1(progress, checklist),
      `reconcile divergence for ${JSON.stringify({ progress, checklist })}`
    );
    assert.equal(
      engine.isPlanIncompleteV1(engine.reconcileProgressWithChecklistV1(progress, checklist)),
      srcReadiness.isPlanIncomplete(srcReadiness.reconcileProgressWithChecklistV1(progress, checklist)),
      `incompleteness divergence for ${JSON.stringify({ progress, checklist })}`
    );
  }
});

test("splitSummaryAtEchoV1 boundary detection agrees with the extension", () => {
  for (const [name, doc] of Object.entries(CORPUS)) {
    assert.deepEqual(
      engine.splitSummaryAtEchoV1(doc),
      srcChecklist.splitSummaryAtEchoV1(doc),
      `${name}: echo split divergence`
    );
  }
});
