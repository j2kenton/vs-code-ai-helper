/**
 * Unit tests for the two pure decision/rendering functions extracted from
 * `reviewActions.ts`'s round-completion write path (plan Part 4, review
 * follow-up 2026-08-21): `computeSyntheticRoundChecklistLatchV1` (the
 * `checklistProgressUnreliable` latch decision for a synthetic edit round)
 * and `buildChecklistMergeDiagnosticsNoteV1` (the `## Checklist merge
 * diagnostics` run-log rendering). Both were previously inline in a large,
 * module-private function and only reachable through a full round; pulling
 * them out makes the exact wiring the review flagged as under-tested
 * directly exercisable here.
 *
 * 2026-08-21 NINTH review round: `computeSyntheticRoundChecklistLatchV1` no
 * longer takes an `automaticChecklistReconciliation` parameter at all — the
 * automatic reconciliation pass gathers evidence for a human to act on, but
 * never exempts a synthetic round from the latch on its own strength,
 * regardless of what it found (see that function's own doc comment). Only
 * `reconcilePlanChecklistConfirmedV1` — an explicit human attestation — ever
 * clears it.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildChecklistMergeDiagnosticsNoteV1,
  computeSyntheticRoundChecklistLatchV1,
} from "../commands/reviewActions";
import {
  areAllUnmatchedChecklistClaimsAlreadySettledV1,
  mergeChecklistProgressV1,
} from "../utils/implementationChecklist";

void describe("computeSyntheticRoundChecklistLatchV1", () => {
  void it("latches a synthetic round that changed files", () => {
    const latched = computeSyntheticRoundChecklistLatchV1({
      planChecklistPresent: true,
      roundMayHaveChangedFiles: true,
      summaryIsSynthetic: true,
      summaryIssuePresent: false,
      checklistClaimedButUnmerged: false,
    });
    assert.equal(latched, true);
  });

  void it("latches a round with a malformed/rejected summary that may have changed files", () => {
    const latched = computeSyntheticRoundChecklistLatchV1({
      planChecklistPresent: true,
      roundMayHaveChangedFiles: true,
      summaryIsSynthetic: false,
      summaryIssuePresent: true,
      checklistClaimedButUnmerged: false,
    });
    assert.equal(latched, true);
  });

  void it("never latches a synthetic round that changed no files", () => {
    const latched = computeSyntheticRoundChecklistLatchV1({
      planChecklistPresent: true,
      roundMayHaveChangedFiles: false,
      summaryIsSynthetic: true,
      summaryIssuePresent: false,
      checklistClaimedButUnmerged: false,
    });
    assert.equal(latched, false);
  });

  void it("latches a non-synthetic round whose claimed ticks matched no plan item (checklistClaimedButUnmerged)", () => {
    const latched = computeSyntheticRoundChecklistLatchV1({
      planChecklistPresent: true,
      roundMayHaveChangedFiles: false,
      summaryIsSynthetic: false,
      summaryIssuePresent: false,
      checklistClaimedButUnmerged: true,
    });
    assert.equal(latched, true);
  });

  void it("never latches a round with a clean echoed merge and no claimed-but-unmerged tick", () => {
    const latched = computeSyntheticRoundChecklistLatchV1({
      planChecklistPresent: true,
      roundMayHaveChangedFiles: true,
      summaryIsSynthetic: false,
      summaryIssuePresent: false,
      checklistClaimedButUnmerged: false,
    });
    assert.equal(latched, false);
  });

  void it("never latches when the plan has no checklist at all", () => {
    const latched = computeSyntheticRoundChecklistLatchV1({
      planChecklistPresent: false,
      roundMayHaveChangedFiles: true,
      summaryIsSynthetic: true,
      summaryIssuePresent: false,
      checklistClaimedButUnmerged: false,
    });
    assert.equal(latched, false);
  });
});

/**
 * RC3 item 1 (Step 2a) — execution-path coverage: a round's REAL echoed
 * checklist text runs through the actual {@link mergeChecklistProgressV1}
 * merge and the actual {@link areAllUnmatchedChecklistClaimsAlreadySettledV1}
 * resolver, and the resulting `checklistClaimedButUnmerged` feeds the real
 * latch decision — the exact composition `reviewActions.ts` performs at its
 * one flag-computation site — rather than asserting on hand-built booleans
 * or a hand-built `unmatchedAll` array. This is what proves a round that
 * reports "Steps 1–33" in shorthand raises no flag/card when those items are
 * already settled, and still raises one when they are not — the two
 * outcomes the acceptance criteria name.
 */
void describe("computeSyntheticRoundChecklistLatchV1 end-to-end via the numbered-claim resolver (RC3 item 1, Step 2a)", () => {
  // Four top-level items: #1-#3 already ticked, #4 still open.
  const PLAN = [
    "<!-- ensemble:implementation-checklist -->",
    "",
    "- [x] First step",
    "- [x] Second step",
    "- [x] Third step",
    "- [ ] Fourth step",
  ].join("\n");

  function latchFor(summaryEcho: string): boolean {
    const mergeResult = mergeChecklistProgressV1(PLAN, summaryEcho);
    const checklistNoMatchAlreadySettled =
      mergeResult.kind === "no-match" && areAllUnmatchedChecklistClaimsAlreadySettledV1(PLAN, mergeResult.unmatchedAll);
    const checklistClaimedButUnmerged = mergeResult.kind === "no-match" && !checklistNoMatchAlreadySettled;
    return computeSyntheticRoundChecklistLatchV1({
      planChecklistPresent: true,
      roundMayHaveChangedFiles: false,
      summaryIsSynthetic: false,
      summaryIssuePresent: false,
      checklistClaimedButUnmerged,
    });
  }

  void it("raises no flag/card when the round echoes a numbered range that is fully settled", () => {
    const echo = ["<!-- ensemble:implementation-checklist -->", "- [x] Steps 1-3"].join("\n");
    // Sanity: this is genuinely the "no-match" merge outcome the resolver is
    // meant to rescue, not an ordinary tick the merge itself applied.
    assert.equal(mergeChecklistProgressV1(PLAN, echo).kind, "no-match");
    assert.equal(latchFor(echo), false);
  });

  void it("raises no flag/card for the task's own acceptance-criteria example, 'Steps 1–33 — done', when every named item is settled", () => {
    // The literal example from RC3 item 1's own verification bullet, echoed
    // exactly as a checklist-block line: the "— done" status suffix survives
    // into the raw item text here (unlike a "## Plan Item Checklist" claim
    // line, where ` — ` splitting strips it before this parser ever sees
    // it), so this is the path that actually needs the status-suffix
    // grammar `parseNumberedChecklistClaimV1` accepts.
    const echo = ["<!-- ensemble:implementation-checklist -->", "- [x] Steps 1–3 — done"].join("\n");
    assert.equal(mergeChecklistProgressV1(PLAN, echo).kind, "no-match");
    assert.equal(latchFor(echo), false);
  });

  void it("still raises the flag/card when the echoed numbered range includes an open item", () => {
    const echo = ["<!-- ensemble:implementation-checklist -->", "- [x] Steps 1-4"].join("\n");
    assert.equal(mergeChecklistProgressV1(PLAN, echo).kind, "no-match");
    assert.equal(latchFor(echo), true);
  });

  void it("still raises the flag/card for a single numbered claim naming an open item", () => {
    const echo = ["<!-- ensemble:implementation-checklist -->", "- [x] Step 4"].join("\n");
    assert.equal(mergeChecklistProgressV1(PLAN, echo).kind, "no-match");
    assert.equal(latchFor(echo), true);
  });

  void it("still raises the flag/card for an ordinary reworded claim matching no item text", () => {
    const echo = ["<!-- ensemble:implementation-checklist -->", "- [x] A reworded claim matching nothing"].join(
      "\n"
    );
    assert.equal(mergeChecklistProgressV1(PLAN, echo).kind, "no-match");
    assert.equal(latchFor(echo), true);
  });
});

void describe("buildChecklistMergeDiagnosticsNoteV1", () => {
  void it("distinguishes no-report (no echo at all)", () => {
    const note = buildChecklistMergeDiagnosticsNoteV1({
      mergeKind: "no-report",
      latchSet: true,
    });
    assert.match(note, /Merge kind: `no-report`/);
    assert.match(note, /Latch \(`checklistProgressUnreliable`\) after this round: set/);
  });

  void it("distinguishes no-match (echo produced, matched no plan item) and names the unmatched sample", () => {
    const note = buildChecklistMergeDiagnosticsNoteV1({
      mergeKind: "no-match",
      unmatchedSample: ["A reworded claim that matches nothing"],
      latchSet: false,
    });
    assert.match(note, /Merge kind: `no-match`/);
    assert.match(note, /Unmatched claim text: "A reworded claim that matches nothing"/);
    assert.match(note, /Latch \(`checklistProgressUnreliable`\) after this round: not set/);
  });

  void it("distinguishes merged (echo produced and applied)", () => {
    const note = buildChecklistMergeDiagnosticsNoteV1({
      mergeKind: "merged",
      latchSet: false,
    });
    assert.match(note, /Merge kind: `merged`/);
    assert.doesNotMatch(note, /Unmatched claim text/);
  });

  void it("records a candidatesFound automatic reconciliation outcome with its review-verified candidates", () => {
    const note = buildChecklistMergeDiagnosticsNoteV1({
      mergeKind: "no-report",
      latchSet: true,
      automaticChecklistReconciliation: {
        kind: "candidatesFound",
        reviewVerifiedItems: ["Wire the completeness gate"],
        pendingOperationEvidenceItems: [],
        unresolvedOverlap: [],
      },
    });
    assert.match(note, /Automatic checklist reconciliation: `candidatesFound`/);
    assert.match(note, /Wire the completeness gate/);
    assert.match(note, /pending explicit human selection/);
    assert.doesNotMatch(note, /Unresolved overlap/);
    assert.match(note, /Latch \(`checklistProgressUnreliable`\) after this round: set/);
  });

  void it("records a candidatesFound outcome's unresolved overlap alongside its candidates", () => {
    const note = buildChecklistMergeDiagnosticsNoteV1({
      mergeKind: "no-report",
      latchSet: true,
      automaticChecklistReconciliation: {
        kind: "candidatesFound",
        reviewVerifiedItems: ["Wire the completeness gate"],
        pendingOperationEvidenceItems: [],
        unresolvedOverlap: ["Add the missing test in `src/utils/foo.ts`"],
      },
    });
    assert.match(note, /Automatic checklist reconciliation: `candidatesFound`/);
    assert.match(note, /Wire the completeness gate/);
    assert.match(note, /Unresolved overlap — 1 other unticked item/);
    assert.match(note, /Add the missing test in `src\/utils\/foo\.ts`/);
  });

  void it("renders a tier-2 candidate alongside a tier-1 candidate in the same outcome", () => {
    const note = buildChecklistMergeDiagnosticsNoteV1({
      mergeKind: "no-report",
      latchSet: true,
      automaticChecklistReconciliation: {
        kind: "candidatesFound",
        reviewVerifiedItems: ["Wire the completeness gate"],
        pendingOperationEvidenceItems: [
          { item: "Add the missing test", evidence: "candidate, pending human attestation" },
        ],
        unresolvedOverlap: [],
      },
    });
    assert.match(note, /Automatic checklist reconciliation: `candidatesFound`/);
    assert.match(note, /pending human attestation/);
    assert.match(note, /Add the missing test/);
  });

  void it("records a candidatesFound outcome with only tier-2 candidates", () => {
    const note = buildChecklistMergeDiagnosticsNoteV1({
      mergeKind: "no-report",
      latchSet: true,
      automaticChecklistReconciliation: {
        kind: "candidatesFound",
        reviewVerifiedItems: [],
        pendingOperationEvidenceItems: [
          { item: "Wire the completeness gate", evidence: "candidate, pending human attestation" },
        ],
        unresolvedOverlap: [],
      },
    });
    assert.match(note, /Automatic checklist reconciliation: `candidatesFound`/);
    assert.match(note, /pending human attestation/);
    assert.match(note, /Wire the completeness gate/);
    assert.match(note, /no review-verified candidates/);
  });

  void it("records a nothingCovered automatic reconciliation outcome", () => {
    const note = buildChecklistMergeDiagnosticsNoteV1({
      mergeKind: "no-report",
      latchSet: true,
      automaticChecklistReconciliation: { kind: "nothingCovered" },
    });
    assert.match(note, /Automatic checklist reconciliation: `nothingCovered`/);
    // Still latched: an affirmative "nothing covered" is this pass's own
    // conclusion, not a human's, and never exempts the round on its own.
    assert.match(note, /Latch \(`checklistProgressUnreliable`\) after this round: set/);
  });

  void it("records an unavailable automatic reconciliation outcome with its reason", () => {
    const note = buildChecklistMergeDiagnosticsNoteV1({
      mergeKind: "no-report",
      latchSet: true,
      automaticChecklistReconciliation: {
        kind: "unavailable",
        reason: "2 unticked plan item(s) reference file(s) this round changed",
      },
    });
    assert.match(note, /Automatic checklist reconciliation: `unavailable`/);
    assert.match(note, /2 unticked plan item\(s\) reference file\(s\) this round changed/);
  });

  void it("omits the automatic-reconciliation clause entirely when no pass ran (non-synthetic round)", () => {
    const note = buildChecklistMergeDiagnosticsNoteV1({
      mergeKind: "merged",
      latchSet: false,
    });
    assert.doesNotMatch(note, /Automatic checklist reconciliation/);
  });
});
