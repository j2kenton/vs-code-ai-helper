/**
 * Pure derivation rules for `ImplementationDispatchModeV1` (item 17a — "make
 * the stage chat a record of work", Part 2). Kept separate from
 * `reviewActions.ts`'s orchestration so the routing decisions are unit
 * testable without mocking the whole implementation-run pipeline.
 */
import {
  ImplementationDispatchModeV1,
  ImplRecoveryV1,
  ReviewBlockerIdentity,
  TaskStage,
} from "../types/taskProgress";

const APPLY_REVIEW_EDIT_ACTION_KEY = "applyReviewEdit.v1";

/**
 * What THIS round is running as. A round that claimed a pending recovery
 * record (`isContinuation`) is always `"continuation"` regardless of
 * `editActionKey` — the continuation's own template/content may follow the
 * source round's mode (see `shouldContinueAsApplyReviewV1`), but the round
 * itself is a continuation, not a fresh dispatch of either other kind.
 */
export function deriveCurrentDispatchModeV1(
  isContinuation: boolean,
  editActionKey: string | undefined
): ImplementationDispatchModeV1 {
  if (isContinuation) {
    return "continuation";
  }
  return editActionKey === APPLY_REVIEW_EDIT_ACTION_KEY ? "apply-review" : "implementation";
}

/**
 * What a NEW recovery record (if this round needs one) should record as its
 * `sourceDispatchMode`/`sourceReviewStage` — i.e. what THIS round was
 * ACTUALLY working from, for the benefit of its OWN future continuation.
 * Propagates `"apply-review"` through a chain of continuations (a
 * continuation of a continuation of an apply-review round still resolves to
 * `"apply-review"`, never collapsing to `"continuation"`, which describes
 * only the round that just ran) — but ONLY when this round itself genuinely
 * ran from the apply-review template.
 *
 * Deliberately keyed on `editActionKey` alone, never on an ancestor record's
 * `sourceDispatchMode` (review blocker, 2026-08-26: "an Apply Review
 * continuation can silently fall back to checklist-driven work while its run
 * log still reports Apply Review ancestry"). A continuation whose SOURCE
 * round was apply-review re-renders from `apply-impl-review-code.md` only
 * when the source review artifact can still be read and assembled
 * (`shouldContinueAsApplyReviewV1` + the caller's read/assembly attempt); on
 * failure it falls through to the checklist-driven template instead, and the
 * caller correspondingly leaves `editActionKey` unset for that dispatch. If
 * this function fell back to trusting the ancestor's `sourceDispatchMode` in
 * that case, it would propagate "apply-review" for a round that actually ran
 * checklist-driven — exactly the lie the run log's `Mode:` line must not
 * tell. Because the caller sets `editActionKey` to `applyReviewEdit.v1` on
 * EVERY successful apply-review dispatch (fresh or re-rendered continuation)
 * and leaves it unset on every other path, it is sufficient on its own.
 */
export function deriveNextRecoverySourceV1(
  editActionKey: string | undefined,
  postRunReviewStage: TaskStage,
  claimedSourceReviewStage: TaskStage | undefined
): { sourceDispatchMode: ImplementationDispatchModeV1; sourceReviewStage?: TaskStage } {
  if (editActionKey !== APPLY_REVIEW_EDIT_ACTION_KEY) {
    return { sourceDispatchMode: "implementation" };
  }
  return {
    sourceDispatchMode: "apply-review",
    sourceReviewStage: claimedSourceReviewStage ?? postRunReviewStage,
  };
}

/**
 * The run log's `Mode:`/`Blockers:` header lines — extracted as a pure
 * function (review blocker, 2026-08-26) so the exact text the automatic
 * loop's dispatch choices are audited against is directly unit-testable,
 * rather than only reachable by mocking the whole implementation-run
 * pipeline. `nextRecoverySourceDispatchMode`/`nextRecoverySourceReviewStage`
 * must be the values `deriveNextRecoverySourceV1` returned for THIS round —
 * never a value read independently from a claimed record — so this header
 * can never disagree with what that function decided.
 */
export function formatRunLogModeHeaderV1(
  currentDispatchMode: ImplementationDispatchModeV1,
  nextRecoverySourceDispatchMode: ImplementationDispatchModeV1,
  nextRecoverySourceReviewStage: TaskStage | undefined,
  dispatchedBlockerIds: readonly ReviewBlockerIdentity[] | undefined
): string {
  const modeLine =
    currentDispatchMode === "apply-review" && nextRecoverySourceReviewStage
      ? `Mode: apply-review (${nextRecoverySourceReviewStage})\n\n`
      : currentDispatchMode === "continuation" && nextRecoverySourceDispatchMode === "apply-review"
        ? `Mode: continuation (apply-review, ${nextRecoverySourceReviewStage ?? "unknown"})\n\n`
        : `Mode: ${currentDispatchMode}\n\n`;
  const blockerIdsLine =
    dispatchedBlockerIds && dispatchedBlockerIds.length > 0
      ? `Blockers: ${dispatchedBlockerIds
          .map((b) => `${b.id ?? "unidentified"} [${b.category}/${b.resolver}] ${b.subject}`)
          .join("; ")}\n\n`
      : "";
  return `${modeLine}${blockerIdsLine}`;
}

/**
 * Whether a claimed continuation should re-render from
 * `apply-impl-review-code.md` with the original review content instead of
 * `run-implementation.md` — item 17b. Returns the review stage to re-read
 * when so, `undefined` otherwise (checklist-driven continuation).
 */
export function shouldContinueAsApplyReviewV1(
  recoveryRecord: Pick<ImplRecoveryV1, "sourceDispatchMode" | "sourceReviewStage"> | undefined
): TaskStage | undefined {
  if (recoveryRecord?.sourceDispatchMode === "apply-review" && recoveryRecord.sourceReviewStage) {
    return recoveryRecord.sourceReviewStage;
  }
  return undefined;
}
