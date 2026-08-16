/**
 * Part 2 unit coverage: the recovery-mode decision rule
 * (`selectImplRecoveryModeV1`), the mode-specific continuation mandates
 * (`buildImplementationContinuationPromptV1`), and the per-provider
 * text-mode capability probe (`isSummaryOnlyDispatchAvailableV1`). The first
 * two are pure by design so the evidence table from the plan can be pinned
 * case by case:
 *
 *  - `summary-only` iff normal termination AND a 0-blocker high review that
 *    still DESCRIBES the pre-round tree over a clean pre-round boundary AND
 *    known delta AND an enforceable text-mode dispatch;
 *  - `inspect-and-complete` for external kills with a known non-empty delta,
 *    for a violated summary-only premise, and as the enforceable fallback
 *    when text mode cannot be honored;
 *  - `unconstrained` whenever the edits themselves are suspect.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ImplRecoveryModeEvidenceV1,
  buildImplementationContinuationPromptV1,
  selectImplRecoveryModeV1,
} from "../commands/implementationRecoveryV1";
import { isSummaryOnlyDispatchAvailableV1 } from "../commands/implContinuationTextDispatchV1";

/** Baseline: normal termination, known small delta, best-case review evidence. */
function evidence(
  overrides: Partial<ImplRecoveryModeEvidenceV1> = {}
): ImplRecoveryModeEvidenceV1 {
  return {
    terminatedExternally: false,
    filesChangedUnknown: false,
    changedFileCount: 2,
    latestHighReviewPassedZeroBlockers: true,
    latestHighReviewDescribesPreRoundTree: true,
    preRoundBoundaryClean: true,
    summaryOnlyDispatchAvailable: true,
    escalatedFromSummaryOnly: false,
    ...overrides,
  };
}

void describe("selectImplRecoveryModeV1 (Part 2 evidence table)", () => {
  void it("normal termination + 0-blocker review + clean boundary + enforceable text mode → summary-only", () => {
    assert.equal(selectImplRecoveryModeV1(evidence()), "summary-only");
  });

  void it("the same evidence without an enforceable text-mode dispatch falls back to inspect-and-complete, never a prompt-only edit run", () => {
    assert.equal(
      selectImplRecoveryModeV1(evidence({ summaryOnlyDispatchAvailable: false })),
      "inspect-and-complete"
    );
  });

  void it("open blockers on the latest high review → unconstrained (the edits are suspect)", () => {
    assert.equal(
      selectImplRecoveryModeV1(evidence({ latestHighReviewPassedZeroBlockers: false })),
      "unconstrained"
    );
  });

  void it("a dirty pre-round boundary (outstanding quarantine or review-invalid marker) → unconstrained", () => {
    assert.equal(
      selectImplRecoveryModeV1(evidence({ preRoundBoundaryClean: false })),
      "unconstrained"
    );
  });

  void it("a 0-blocker score whose review no longer describes the pre-round tree → unconstrained (a stale score approves nothing)", () => {
    // Review blocker 2 (2026-08-14): after a successful post-review edit
    // round promotes the pending set and clears the invalid marker, the
    // boundary reads clean and the 0-blocker history entry still exists —
    // only the freshness signal (stale-stamped artifact / wrong stage) says
    // that score never reviewed the tree the failing round started from.
    assert.equal(
      selectImplRecoveryModeV1(
        evidence({ latestHighReviewDescribesPreRoundTree: false })
      ),
      "unconstrained"
    );
  });

  void it("an externally-killed round with a known non-empty delta → inspect-and-complete, never summary-only", () => {
    // Best-case review evidence on purpose: a known file list from a killed
    // process proves edits LANDED, not that they are FINISHED.
    assert.equal(
      selectImplRecoveryModeV1(evidence({ terminatedExternally: true })),
      "inspect-and-complete"
    );
  });

  void it("an externally-killed round that provably changed nothing → unconstrained", () => {
    assert.equal(
      selectImplRecoveryModeV1(
        evidence({ terminatedExternally: true, changedFileCount: 0 })
      ),
      "unconstrained"
    );
  });

  void it("an unknown delta → unconstrained regardless of every other signal", () => {
    for (const base of [
      evidence({ filesChangedUnknown: true }),
      evidence({ filesChangedUnknown: true, terminatedExternally: true }),
      evidence({ filesChangedUnknown: true, escalatedFromSummaryOnly: true }),
    ]) {
      assert.equal(selectImplRecoveryModeV1(base), "unconstrained");
    }
  });

  void it("a violated summary-only premise escalates to inspect-and-complete under the same cap", () => {
    assert.equal(
      selectImplRecoveryModeV1(evidence({ escalatedFromSummaryOnly: true })),
      "inspect-and-complete"
    );
  });

});

void describe("isSummaryOnlyDispatchAvailableV1 (per-provider text-mode capability probe)", () => {
  void it("a CLI provider whose text mode is vendor-enforced read-only can honor the no-edit premise", () => {
    // Claude Code's text mode runs `--permission-mode plan` — no
    // permissionWarning, so text dispatch actually withholds edits.
    assert.equal(isSummaryOnlyDispatchAvailableV1("claude-cli:sonnet"), true);
  });

  void it("providers whose text mode runs every tool auto-approved cannot — selection must fall back, never trust the prompt", () => {
    // Cline and Antigravity carry a permissionWarning: BOTH their modes run
    // shell/file-write-capable tools auto-approved, so a "text" run proves
    // nothing about the tree.
    assert.equal(isSummaryOnlyDispatchAvailableV1("cline-cli:some-model"), false);
    assert.equal(isSummaryOnlyDispatchAvailableV1("antigravity-cli:some-model"), false);
  });

  void it("a Copilot-resolved model can honor it — broker text mode grants no edit tools at all", () => {
    assert.equal(isSummaryOnlyDispatchAvailableV1("copilot:gpt-4o"), true);
  });
});

void describe("buildImplementationContinuationPromptV1 (Part 2 mandates)", () => {
  const BASE = "BASE PROMPT";
  const PENDING = ["src/newfile.ts", "src/other.ts"];
  const REVIEWED = ["src/prior.ts"];

  void it("no recovery record and no pending files → the base prompt unchanged", () => {
    assert.equal(
      buildImplementationContinuationPromptV1(BASE, {
        mode: undefined,
        pendingFiles: [],
        reviewedFiles: REVIEWED,
      }),
      BASE
    );
  });

  void it("summary-only: forbids edits and mandates a report over the combined diff", () => {
    const prompt = buildImplementationContinuationPromptV1(BASE, {
      mode: "summary-only",
      pendingFiles: PENDING,
      reviewedFiles: REVIEWED,
    });
    assert.ok(prompt.startsWith(BASE));
    assert.match(prompt, /## Continuation Notice — report only \(summary-only\)/);
    assert.match(prompt, /must NOT edit any/);
    assert.match(prompt, /Quarantined delta awaiting a report:\n- src\/newfile\.ts\n- src\/other\.ts/);
    assert.match(prompt, /Previously-reviewed files:\n- src\/prior\.ts/);
  });

  void it("inspect-and-complete: mandates verify/finish-or-revert first, bounded to the quarantined + reviewed scope", () => {
    const prompt = buildImplementationContinuationPromptV1(BASE, {
      mode: "inspect-and-complete",
      pendingFiles: PENDING,
      reviewedFiles: REVIEWED,
    });
    assert.match(prompt, /## Continuation Notice — inspect and complete/);
    assert.match(prompt, /inspect each quarantined file for partial or inconsistent edits/);
    assert.match(prompt, /do\nnot expand into new scope/);
    assert.match(prompt, /Quarantined files \(unverified work in progress\):\n- src\/newfile\.ts/);
    assert.match(prompt, /Previously-reviewed boundary:\n- src\/prior\.ts/);
  });

  void it("unconstrained with a pending set keeps the original Continuation Notice wording", () => {
    const prompt = buildImplementationContinuationPromptV1(BASE, {
      mode: "unconstrained",
      pendingFiles: PENDING,
      reviewedFiles: REVIEWED,
    });
    assert.match(prompt, /## Continuation Notice\n/);
    assert.match(prompt, /Files changed by the unreported round:\n- src\/newfile\.ts/);
    assert.doesNotMatch(prompt, /report only|inspect and complete/);
  });

  void it("an unconstrained record with an empty quarantine still tells the round its predecessor never reported", () => {
    const prompt = buildImplementationContinuationPromptV1(BASE, {
      mode: "unconstrained",
      pendingFiles: [],
      reviewedFiles: REVIEWED,
    });
    assert.match(prompt, /## Continuation Notice\n/);
    assert.match(prompt, /though it changed no files/);
  });
});
