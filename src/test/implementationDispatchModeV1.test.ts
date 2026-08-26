import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  deriveCurrentDispatchModeV1,
  deriveNextRecoverySourceV1,
  formatRunLogModeHeaderV1,
  shouldContinueAsApplyReviewV1,
} from "../utils/implementationDispatchModeV1";
import { ReviewBlockerIdentity } from "../types/taskProgress";

// ---------------------------------------------------------------------------
// deriveCurrentDispatchModeV1 (item 17a — Part 2 step 5)
// ---------------------------------------------------------------------------

void test("a fresh checklist-driven round (no continuation, no editActionKey) is 'implementation'", () => {
  assert.equal(deriveCurrentDispatchModeV1(false, undefined), "implementation");
});

void test("a fresh round dispatched with editActionKey applyReviewEdit.v1 is 'apply-review'", () => {
  assert.equal(deriveCurrentDispatchModeV1(false, "applyReviewEdit.v1"), "apply-review");
});

void test("a claimed continuation is always 'continuation', regardless of editActionKey", () => {
  assert.equal(deriveCurrentDispatchModeV1(true, undefined), "continuation");
  assert.equal(deriveCurrentDispatchModeV1(true, "applyReviewEdit.v1"), "continuation");
});

// ---------------------------------------------------------------------------
// deriveNextRecoverySourceV1 (item 17a — Part 2 step 6)
// ---------------------------------------------------------------------------

void test("a plain implementation round with no apply-review ancestry records sourceDispatchMode implementation", () => {
  const next = deriveNextRecoverySourceV1(undefined, "impl-high-review", undefined);
  assert.deepEqual(next, { sourceDispatchMode: "implementation" });
});

void test("a round dispatched as apply-review records sourceDispatchMode apply-review with the current review stage", () => {
  const next = deriveNextRecoverySourceV1("applyReviewEdit.v1", "impl-high-review", undefined);
  assert.deepEqual(next, {
    sourceDispatchMode: "apply-review",
    sourceReviewStage: "impl-high-review",
  });
});

void test("apply-review ancestry propagates through a continuation that successfully re-rendered (editActionKey set)", () => {
  // A continuation of a continuation of an apply-review round, whose
  // re-render from apply-impl-review-code.md SUCCEEDED this round — the
  // caller sets editActionKey to applyReviewEdit.v1 only in that case (see
  // reviewActions.ts's `sourceReviewStageForRun` gate) — still resolves to
  // apply-review, never collapsing to plain "implementation", and carries
  // forward the ORIGINAL source review stage via claimedSourceReviewStage.
  const next = deriveNextRecoverySourceV1("applyReviewEdit.v1", "impl-low-review", "impl-high-review");
  assert.deepEqual(next, {
    sourceDispatchMode: "apply-review",
    sourceReviewStage: "impl-high-review",
  });
});

void test("apply-review ancestry falls back to the current postRunReviewStage when no prior stage is recorded", () => {
  const next = deriveNextRecoverySourceV1("applyReviewEdit.v1", "impl-high-review", undefined);
  assert.deepEqual(next, {
    sourceDispatchMode: "apply-review",
    sourceReviewStage: "impl-high-review",
  });
});

void test("a continuation whose apply-review re-render FAILED and fell through to run-implementation.md records sourceDispatchMode implementation, never apply-review (review blocker, 2026-08-26)", () => {
  // Regression for "an Apply Review continuation can silently fall back to
  // checklist-driven work while its run log still reports Apply Review
  // ancestry": the caller leaves editActionKey unset when the source review
  // artifact could not be read/assembled this round, even though the
  // claimed record's OWN sourceDispatchMode was "apply-review" and it
  // carries a sourceReviewStage. Ancestry alone must never be enough to
  // claim apply-review for a round that actually dispatched checklist-driven.
  const next = deriveNextRecoverySourceV1(undefined, "impl-low-review", "impl-high-review");
  assert.deepEqual(next, { sourceDispatchMode: "implementation" });
});

// ---------------------------------------------------------------------------
// formatRunLogModeHeaderV1 (review blocker, 2026-08-26 — Part 2 step 5)
// ---------------------------------------------------------------------------

void test("a fresh checklist-driven round's header names only its mode", () => {
  const header = formatRunLogModeHeaderV1("implementation", "implementation", undefined, undefined);
  assert.equal(header, "Mode: implementation\n\n");
});

void test("a fresh apply-review round's header names the review stage and its blocker ids", () => {
  const blockers: ReviewBlockerIdentity[] = [
    { category: "completion", resolver: "task-fixable", subject: "src/foo.ts", id: "b1" },
    { category: "architectural", resolver: "task-fixable", subject: "src/bar.ts" },
  ];
  const header = formatRunLogModeHeaderV1(
    "apply-review",
    "apply-review",
    "impl-high-review",
    blockers
  );
  assert.equal(
    header,
    "Mode: apply-review (impl-high-review)\n\n" +
      "Blockers: b1 [completion/task-fixable] src/foo.ts; unidentified [architectural/task-fixable] src/bar.ts\n\n"
  );
});

void test("a continuation whose apply-review re-render succeeded names its ancestry, never bare 'continuation'", () => {
  const header = formatRunLogModeHeaderV1(
    "continuation",
    "apply-review",
    "impl-high-review",
    undefined
  );
  assert.equal(header, "Mode: continuation (apply-review, impl-high-review)\n\n");
});

void test("a continuation whose apply-review re-render FAILED renders bare 'continuation', never apply-review ancestry it did not run under (review blocker, 2026-08-26)", () => {
  // This is the exact case the review flagged: currentDispatchMode is
  // "continuation" (a recovery record was claimed), but
  // nextRecoverySourceDispatchMode is "implementation" because the caller
  // could not re-render from apply-impl-review-code.md this round — the
  // header must not claim apply-review ancestry regardless of what the
  // claimed record's OWN sourceDispatchMode was.
  const header = formatRunLogModeHeaderV1("continuation", "implementation", undefined, undefined);
  assert.equal(header, "Mode: continuation\n\n");
});

void test("no blocker ids means no Blockers: line", () => {
  const header = formatRunLogModeHeaderV1("apply-review", "apply-review", "impl-high-review", []);
  assert.equal(header, "Mode: apply-review (impl-high-review)\n\n");
});

// ---------------------------------------------------------------------------
// shouldContinueAsApplyReviewV1 (item 17b — Part 2 step 6)
// ---------------------------------------------------------------------------

void test("a continuation of a review-driven (apply-review) round stays review-driven", () => {
  const stage = shouldContinueAsApplyReviewV1({
    sourceDispatchMode: "apply-review",
    sourceReviewStage: "impl-high-review",
  });
  assert.equal(stage, "impl-high-review");
});

void test("a continuation of a checklist-driven (implementation) round does not switch to apply-review", () => {
  const stage = shouldContinueAsApplyReviewV1({
    sourceDispatchMode: "implementation",
    sourceReviewStage: undefined,
  });
  assert.equal(stage, undefined);
});

void test("apply-review source with no recorded review stage does not switch (nothing to re-read)", () => {
  const stage = shouldContinueAsApplyReviewV1({
    sourceDispatchMode: "apply-review",
    sourceReviewStage: undefined,
  });
  assert.equal(stage, undefined);
});

void test("an undefined recovery record (no continuation owed) does not switch", () => {
  assert.equal(shouldContinueAsApplyReviewV1(undefined), undefined);
});
