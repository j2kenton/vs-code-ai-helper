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

// Escaped-quote corpus rows (step 2 parity): a round-trip through a
// JSON-encoded field can leave a provider's over-escaped quotes on disk as
// literal backslash-quote sequences instead of plain quotes, both on the
// plan side and the echo side.
const PLAN_ESCAPED_QUOTES = [
  "<!-- ensemble:implementation-checklist -->",
  "",
  `- [ ] Fix the \\"getStageStatus\\" comparison`,
  "- [ ] wire the gate",
  "",
].join("\n");

const SUMMARY_ECHO_CLEAN_QUOTES = [
  "<!-- ensemble:implementation-checklist -->",
  `- [x] Fix the "getStageStatus" comparison`,
  "",
  "## Files Changed",
  "- src/a.ts — created",
  "",
].join("\n");

const SUMMARY_ECHO_ESCAPED_QUOTES = [
  "<!-- ensemble:implementation-checklist -->",
  `- [x] Fix the \\"getStageStatus\\" comparison`,
  "",
  "## Files Changed",
  "- src/a.ts — created",
  "",
].join("\n");

const PLAN_CLEAN_QUOTES = [
  "<!-- ensemble:implementation-checklist -->",
  "",
  `- [ ] Fix the "getStageStatus" comparison`,
  "- [ ] wire the gate",
  "",
].join("\n");

// Exclusion-marker corpus row (step 5 parity): an operator-action/optional
// step that must not count toward the completion denominator.
const PLAN_WITH_EXCLUDED_ITEM = [
  "<!-- ensemble:implementation-checklist -->",
  "",
  "- [ ] wire the gate",
  "- [ ] deploy the classifier change to production <!-- ensemble:excluded -->",
  "- [x] add a regression test",
  "",
].join("\n");

// Retroactive-tick corpus (step 4 parity): a round's own `## Plan Item
// Checklist` section may claim an item complete from an earlier round via
// RETROACTIVE_TICK_MARKER_V1 plus evidence, distinct from the echo above.
const PLAN_FOR_RETROACTIVE = [
  "<!-- ensemble:implementation-checklist -->",
  "",
  "- [ ] add the databaseWaking state",
  "- [ ] wire the SPA retry",
  "",
].join("\n");

const SUMMARY_WITH_RETROACTIVE_CLAIM = [
  "## Files Changed",
  "- (none)",
  "",
  "## Plan Item Checklist",
  "",
  "- add the databaseWaking state — done <!-- ensemble:retroactive --> — app.ts:194",
  "- wire the SPA retry — not reached — deferred",
  "",
].join("\n");

const SUMMARY_WITH_RETROACTIVE_CLAIM_NO_EVIDENCE = [
  "## Files Changed",
  "- (none)",
  "",
  "## Plan Item Checklist",
  "",
  "- add the databaseWaking state — done <!-- ensemble:retroactive -->",
  "",
].join("\n");

// Contradictory no-checklist-change corpus (round 013, task "1.9",
// 2026-08-14 — Part 3 parity): a response declaring "nothing to tick" while
// also reporting a retroactive completion in its own Plan Item Checklist.
const NO_CHECKLIST_CHANGE_PLAIN = [
  "<!-- ensemble:no-checklist-change -->",
  "This round fixed the review's blocker; no checkbox state changes.",
  "",
  "## Files Changed",
  "",
  "- `src/foo.ts` — fixed the null check",
  "",
  "## Verification",
  "",
  "- ran the unit tests",
].join("\n");

const RETROACTIVE_CLAIM_NO_DECLARATION = [
  "## Files Changed",
  "",
  "- (none)",
  "",
  "## Plan Item Checklist",
  "",
  "- some plan item — done <!-- ensemble:retroactive --> — src/views/settingsView.ts:672-675",
].join("\n");

const ROUND_013_SHAPED_RESPONSE = [
  "Status: completed",
  "",
  "Files changed:",
  "_none recorded_",
  "",
  "<!-- ensemble:no-checklist-change -->",
  "This round independently re-verified every plan anchor in the working tree.",
  "",
  "## Files Changed",
  "",
  "None — no source, test, or configuration file was created, modified, or deleted this round.",
  "",
  "## Plan Item Checklist",
  "",
  "- `.model-combo-input` small font + reduced padding — done <!-- ensemble:retroactive --> — src/views/settingsView.ts:672-675",
  "",
  "## Verification",
  "",
  "- pnpm run test:unit — 2688/2688 pass",
].join("\n");

const QUOTED_MARKER_IN_ECHOED_ITEM = [
  "<!-- ensemble:implementation-checklist -->",
  "",
  "# Implementation Checklist",
  "",
  "- [x] Treat a summary that both declares <!-- ensemble:no-checklist-change --> and supplies " +
    "retroactive/done claims as self-contradictory",
  "",
  "## Files Changed",
  "",
  "- `src/foo.ts` — fixed the null check",
  "",
  "## Plan Item Checklist",
  "",
  "- some plan item — done <!-- ensemble:retroactive --> — src/views/settingsView.ts:672-675",
  "",
  "## Verification",
  "",
  "- ran the unit tests",
].join("\n");

// Part 4 corpus (workflow 3 continuation, second item's extra requirement):
// a plan item whose own text contains " — ", bare "done" prose with no
// retroactive marker, and a PART-level claim ("Part 7 — done this round
// (6/6), evidence: ...", the exact shape observed live on round 073 of
// "workflow 3").
const PLAN_WITH_DASH_ITEM = [
  "<!-- ensemble:implementation-checklist -->",
  "",
  "- [ ] In the webview <style>, set .model-combo-input to font-size: var(--x) — and reduce its vertical padding",
  "- [ ] a second, unrelated item",
  "",
].join("\n");

const SUMMARY_CLAIMING_DASH_ITEM = [
  "## Files Changed",
  "- (none)",
  "",
  "## Plan Item Checklist",
  "",
  "- In the webview <style>, set .model-combo-input to font-size: var(--x) — and reduce its vertical padding — done <!-- ensemble:retroactive --> — src/views/settingsView.ts:672-675",
  "",
].join("\n");

const SUMMARY_WITH_PROSE_CLAIM_NO_MARKER = [
  "## Files Changed",
  "- (none)",
  "",
  "## Plan Item Checklist",
  "",
  "- add the databaseWaking state — done — built and tested this round",
  "",
].join("\n");

const PLAN_WITH_PART_7 = [
  "<!-- ensemble:implementation-checklist -->",
  "",
  "## Part 6 — Some earlier part",
  "",
  "- [ ] an item in Part 6",
  "",
  "## Part 7 — Copilot desc/impl and the auto default",
  "",
  "- [ ] item one",
  "- [ ] item two",
  "- [ ] item three",
  "",
].join("\n");

const SUMMARY_WITH_PART_LEVEL_CLAIM = [
  "## Files Changed",
  "- (none) — this round only verified prior work",
  "",
  "## Plan Item Checklist",
  "",
  "- Part 7 — done this round (3/3), evidence: src/a.ts:1-2, src/b.ts:3-4",
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
  PLAN_ESCAPED_QUOTES,
  SUMMARY_ECHO_CLEAN_QUOTES,
  SUMMARY_ECHO_ESCAPED_QUOTES,
  PLAN_CLEAN_QUOTES,
  PLAN_WITH_EXCLUDED_ITEM,
  PLAN_FOR_RETROACTIVE,
  SUMMARY_WITH_RETROACTIVE_CLAIM,
  SUMMARY_WITH_RETROACTIVE_CLAIM_NO_EVIDENCE,
  PLAN_WITH_DASH_ITEM,
  SUMMARY_CLAIMING_DASH_ITEM,
  SUMMARY_WITH_PROSE_CLAIM_NO_MARKER,
  PLAN_WITH_PART_7,
  SUMMARY_WITH_PART_LEVEL_CLAIM,
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
    // Escaped-quote corpus, both directions (step 2 parity).
    { plan: PLAN_ESCAPED_QUOTES, summary: SUMMARY_ECHO_CLEAN_QUOTES, label: "corrupted plan, clean echo" },
    { plan: PLAN_CLEAN_QUOTES, summary: SUMMARY_ECHO_ESCAPED_QUOTES, label: "clean plan, corrupted echo" },
    // A round echoing something the plan does not contain at all (step 3 parity).
    {
      plan: PLAN_BASIC,
      summary: [
        "<!-- ensemble:implementation-checklist -->",
        "- [x] a totally unrelated item not in the plan",
        "",
        "## Files Changed",
        "- src/a.ts — created",
        "",
      ].join("\n"),
      label: "no-match merge",
    },
    // Retroactive-tick claims, both the valid (evidenced) and invalid
    // (missing-evidence) shapes (step 4 parity).
    {
      plan: PLAN_FOR_RETROACTIVE,
      summary: SUMMARY_WITH_RETROACTIVE_CLAIM,
      label: "retroactive claim with evidence merges",
    },
    {
      plan: PLAN_FOR_RETROACTIVE,
      summary: SUMMARY_WITH_RETROACTIVE_CLAIM_NO_EVIDENCE,
      label: "retroactive claim without evidence does not merge",
    },
    // Part 4 parity: an item whose own text contains " — ", bare "done"
    // prose with no marker, and a PART-level claim.
    {
      plan: PLAN_WITH_DASH_ITEM,
      summary: SUMMARY_CLAIMING_DASH_ITEM,
      label: "claim against an item whose own text contains ' — '",
    },
    {
      plan: PLAN_FOR_RETROACTIVE,
      summary: SUMMARY_WITH_PROSE_CLAIM_NO_MARKER,
      label: "bare prose 'done' claim with no retroactive marker",
    },
    {
      plan: PLAN_WITH_PART_7,
      summary: SUMMARY_WITH_PART_LEVEL_CLAIM,
      label: "PART-level claim expands to every item under the matching heading",
    },
  ];
  for (const { plan, summary, label } of pairs) {
    assert.deepEqual(
      engine.mergeChecklistProgressV1(plan, summary),
      srcChecklist.mergeChecklistProgressV1(plan, summary),
      `${label}: merge divergence`
    );
  }
  // Pin the actual Part 4 expectations too, not just cross-implementation
  // agreement (mirrors the round-013 pinning below).
  const partMerged = engine.mergeChecklistProgressV1(PLAN_WITH_PART_7, SUMMARY_WITH_PART_LEVEL_CLAIM);
  assert.equal(partMerged.kind, "merged");
  if (partMerged.kind === "merged") {
    assert.equal((partMerged.content.match(/- \[x\]/g) ?? []).length, 3);
    assert.ok(partMerged.content.includes("- [ ] an item in Part 6"));
  }
  // Ticks-only invariant: the merge never unticks second step even though the
  // summary could regress it.
  const merged = engine.mergeChecklistProgressV1(PLAN_BASIC, SUMMARY_ECHO);
  assert.ok(merged.kind === "merged" && merged.content.includes("- [x] second step"));
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
    checklist: { total: number; checked: number; remaining: number; excluded: number } | undefined;
  }> = [
    // The 47-item plan vs a narrowed 5/5 marker (the historical failure).
    { progress: { complete: 5, total: 5 }, checklist: { total: 47, checked: 6, remaining: 41, excluded: 0 } },
    // Fully ticked checklist does NOT override a marker reporting work left.
    { progress: { complete: 3, total: 5 }, checklist: { total: 4, checked: 4, remaining: 0, excluded: 0 } },
    { progress: null, checklist: { total: 4, checked: 1, remaining: 3, excluded: 0 } },
    { progress: null, checklist: undefined },
    { progress: { complete: 2, total: 4 }, checklist: undefined },
    // An excluded-item denominator is exactly like any other narrower total.
    { progress: { complete: 4, total: 4 }, checklist: { total: 5, checked: 4, remaining: 1, excluded: 2 } },
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

test("collectRetroactiveTickClaimsV1 agrees with the extension", () => {
  const docs = [
    srcChecklist.splitSummaryAtEchoV1(SUMMARY_WITH_RETROACTIVE_CLAIM).own,
    srcChecklist.splitSummaryAtEchoV1(SUMMARY_WITH_RETROACTIVE_CLAIM_NO_EVIDENCE).own,
    srcChecklist.splitSummaryAtEchoV1(SUMMARY_WITH_PROSE_CLAIM_NO_MARKER).own,
    "",
  ];
  for (const doc of docs) {
    assert.deepEqual(
      engine.collectRetroactiveTickClaimsV1(doc),
      srcChecklist.collectRetroactiveTickClaimsV1(doc),
      `retroactive-claim divergence for ${JSON.stringify(doc)}`
    );
  }
  // Part 4: an item text containing " — " requires planItemKeys to resolve.
  const dashDoc = srcChecklist.splitSummaryAtEchoV1(SUMMARY_CLAIMING_DASH_ITEM).own;
  const dashKeys = srcChecklist.collectChecklistItemKeysV1(PLAN_WITH_DASH_ITEM);
  assert.deepEqual(
    engine.collectRetroactiveTickClaimsV1(dashDoc, dashKeys),
    srcChecklist.collectRetroactiveTickClaimsV1(dashDoc, dashKeys),
    "embedded-dash item claim divergence"
  );
});

test("collectPartLevelTickClaimsV1 agrees with the extension", () => {
  const doc = srcChecklist.splitSummaryAtEchoV1(SUMMARY_WITH_PART_LEVEL_CLAIM).own;
  assert.deepEqual(
    engine.collectPartLevelTickClaimsV1(doc),
    srcChecklist.collectPartLevelTickClaimsV1(doc),
    "part-level claim divergence"
  );
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

test("declaresNoChecklistChangeV1 agrees with the extension", () => {
  const docs = [
    NO_CHECKLIST_CHANGE_PLAIN,
    RETROACTIVE_CLAIM_NO_DECLARATION,
    ROUND_013_SHAPED_RESPONSE,
    QUOTED_MARKER_IN_ECHOED_ITEM,
    "no marker at all",
  ];
  for (const doc of docs) {
    assert.equal(
      engine.declaresNoChecklistChangeV1(doc),
      srcChecklist.declaresNoChecklistChangeV1(doc),
      `declaration-detection divergence for ${JSON.stringify(doc)}`
    );
  }
});

test("hasContradictoryNoChecklistChangeClaimV1 agrees with the extension (round 013 parity)", () => {
  const docs = [
    NO_CHECKLIST_CHANGE_PLAIN,
    RETROACTIVE_CLAIM_NO_DECLARATION,
    ROUND_013_SHAPED_RESPONSE,
    QUOTED_MARKER_IN_ECHOED_ITEM,
    "no marker at all",
  ];
  for (const doc of docs) {
    assert.equal(
      engine.hasContradictoryNoChecklistChangeClaimV1(doc),
      srcChecklist.hasContradictoryNoChecklistChangeClaimV1(doc),
      `contradiction-detection divergence for ${JSON.stringify(doc)}`
    );
  }
  // Pin the actual expected values too, not just cross-implementation
  // agreement, so a future change that breaks BOTH ports identically is
  // still caught.
  assert.equal(engine.hasContradictoryNoChecklistChangeClaimV1(NO_CHECKLIST_CHANGE_PLAIN), false);
  assert.equal(engine.hasContradictoryNoChecklistChangeClaimV1(RETROACTIVE_CLAIM_NO_DECLARATION), false);
  assert.equal(engine.hasContradictoryNoChecklistChangeClaimV1(ROUND_013_SHAPED_RESPONSE), true);
  assert.equal(engine.hasContradictoryNoChecklistChangeClaimV1(QUOTED_MARKER_IN_ECHOED_ITEM), false);
});

// ---------------------------------------------------------------------------
// Part 5 (workflow 3 continuation) — listUncheckedChecklistItemTextsV1 /
// filterUncheckedPlanItemsV1, the mechanism every "tick the missed items"
// surface and the reviewer-verified-ticks apply path now depend on.
// ---------------------------------------------------------------------------
test("listUncheckedChecklistItemTextsV1 agrees with the extension for every corpus document", () => {
  for (const [name, doc] of Object.entries(CORPUS)) {
    assert.deepEqual(
      engine.listUncheckedChecklistItemTextsV1(doc),
      srcChecklist.listUncheckedChecklistItemTextsV1(doc),
      `${name}: unchecked-items divergence`
    );
    assert.deepEqual(
      engine.listUncheckedChecklistItemTextsV1(doc, 1),
      srcChecklist.listUncheckedChecklistItemTextsV1(doc, 1),
      `${name}: bounded unchecked-items divergence`
    );
  }
});

test("listUncheckedChecklistItemTextsV1 unescapes and bounds, pinned against a literal expectation", () => {
  const plan = [
    "<!-- ensemble:implementation-checklist -->",
    "",
    "- [x] done item",
    '- [ ] Fix the \\"quoted\\" bug',
    "- [ ] a second unchecked item",
  ].join("\n");
  assert.deepEqual(engine.listUncheckedChecklistItemTextsV1(plan), {
    items: ['Fix the "quoted" bug', "a second unchecked item"],
    total: 2,
  });
  assert.deepEqual(engine.listUncheckedChecklistItemTextsV1(plan, 1), {
    items: ['Fix the "quoted" bug'],
    total: 2,
  });
});

test("filterUncheckedPlanItemsV1 agrees with the extension across candidate/plan pairs", () => {
  const cases: Array<{ plan: string; candidates: string[] }> = [
    { plan: PLAN_BASIC, candidates: ["first step", "second step", "third step", "unknown item"] },
    {
      plan: PLAN_DUPLICATE_ITEMS,
      candidates: ["add the web smoke check", "  ADD THE WEB SMOKE CHECK  ", "wire the ci lane"],
    },
    { plan: PLAN_WITH_FENCED_EXAMPLE, candidates: ["real item one", "fenced example item"] },
  ];
  for (const { plan, candidates } of cases) {
    assert.deepEqual(
      engine.filterUncheckedPlanItemsV1(plan, candidates),
      srcChecklist.filterUncheckedPlanItemsV1(plan, candidates),
      `candidate resolution divergence for ${JSON.stringify(candidates)}`
    );
  }
});
