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
