import { BlockerSupersessionRecordV1, TaskStage } from "../types/taskProgress";
import { ReviewBlocker, ReviewProgress, parseReviewProgress } from "./reviewReadiness";

/**
 * Shared evidence-normalization layer (wf10 items 18 / 7b) — the single place
 * that turns a review's raw markdown (or an already-parsed blocker list, for
 * a caller that has one in memory from the round it just finished) into the
 * handful of facts every evidence-backed decision surface actually consumes:
 * the `<!-- progress: N/M -->` marker, the blocker set, how many of those
 * blockers are task-fixable, and which ones carry a `[narrowed:…]` lineage
 * citation against the prior round's list.
 *
 * Two call sites need exactly this shape and previously risked growing two
 * ad hoc readings of it: `reconcilePlanChecklist.ts`'s reconciliation
 * recommendation (reads a review stage's artifact from disk, since the
 * decision can be invoked long after the round that wrote it) and the
 * plateau escalation built in `reviewActions.ts` (already holds the just-
 * published round's `content` and parsed `blockers` in memory, so it calls
 * {@link normalizeReviewEvidenceV1} directly rather than re-reading the file
 * it just wrote). Keeping the normalization pure and content-in/facts-out is
 * what lets both share it without either owning the other's I/O.
 */
export interface NormalizedReviewEvidenceV1 {
  /** The review's own self-reported plan-progress marker, or `null` when the
   * review carried none (older prompt, or a provider that omitted it). */
  readonly progress: ReviewProgress | null;
  /** Every blocker the review reported, in the order it reported them. */
  readonly blockers: readonly ReviewBlocker[];
  /** Of those, how many are classified `task-fixable` — the same count
   * `ReviewScoreHistoryEntry.taskFixableCount` records at publish time. */
  readonly taskFixableCount: number;
  /** The subset of `blockers` the reviewer declared `[narrowed:<id>]` against
   * the prior round's list — evidence that iteration is making progress on a
   * standing blocker even though it has not yet cleared (task item 7b, "cite
   * the narrowing instead of claiming no iteration can resolve it"). */
  readonly narrowedBlockers: readonly ReviewBlocker[];
}

/**
 * Pure normalization: `content` is only consulted for the progress marker
 * (`parseReviewProgress`) — `blockers` is taken as given rather than
 * re-parsed from `content`, so a caller that already has its own parsed
 * (and possibly blocker-lineage-augmented, e.g. `getMechanicalBlockersForStage`
 * merged in) list is never made to reconcile two independently-parsed views
 * of the same review.
 */
export function normalizeReviewEvidenceV1(
  content: string,
  blockers: readonly ReviewBlocker[]
): NormalizedReviewEvidenceV1 {
  return {
    progress: parseReviewProgress(content),
    blockers,
    taskFixableCount: blockers.filter((b) => b.resolver === "task-fixable").length,
    narrowedBlockers: blockers.filter((b) => b.lineage?.kind === "narrowed"),
  };
}

/**
 * wf10 item 19 — "teach the stage gate to recognize an annotated-superseded
 * blocker as no longer outstanding". A blocker a human declared resolved via
 * this task's own stage chat (recorded in `TaskProgress.blockerSupersessions`
 * the moment the confirmable `plan.md` edit lands, see that field's doc
 * comment) is dropped from `blockers` here before any gate — the sole-blocker
 * reconcile recommendation (`reconcilePlanChecklist.ts`) or the plateau
 * escalation (`reviewEscalation.ts`) — reads it as still outstanding.
 *
 * Matches on exact (trimmed) description text for the SAME stage only: a
 * different stage's review can legitimately carry an identically-worded
 * blocker, and that occurrence was never the one the human resolved. Pure and
 * order-preserving; callers needing a fresh `taskFixableCount` etc. should
 * re-run {@link normalizeReviewEvidenceV1} on the filtered list rather than
 * patching the normalized shape in place.
 *
 * Review-flagged (2026-08-25, new architectural blocker): a supersession is
 * NOT a permanent verdict on the blocker's text — it records that a
 * PARTICULAR, now-stale review artifact was resolved. A fresh review that
 * independently re-finds the identically-worded blocker is strictly newer
 * evidence than the chat resolution and must never be masked by it — masking
 * it here would let a real, still-live blocker vanish from history and
 * routing forever, the exact failure this fix closes. `reviewAsOfMs` is the
 * instant the `blockers` being filtered were actually produced: the mtime of
 * a persisted review artifact read from disk (`reconcilePlanChecklist.ts`),
 * or `undefined` for blockers just parsed from a review round that completed
 * THIS invocation (`reviewActions.ts`'s `handleReviewRoutingOutcome`,
 * `reviewEscalation.ts`'s plateau evidence) — content newer than anything a
 * prior supersession could have anticipated, so nothing is ever filtered for
 * it. A supersession only suppresses a blocker when the content being
 * filtered demonstrably predates the resolution (`supersededAt` is after
 * `reviewAsOfMs`); once a review has run since, the supersession is
 * considered consumed for that content and no longer applies.
 */
export function filterSupersededBlockersV1(
  stage: TaskStage,
  blockers: readonly ReviewBlocker[],
  supersessions: readonly BlockerSupersessionRecordV1[] | undefined,
  reviewAsOfMs?: number
): ReviewBlocker[] {
  if (!supersessions || supersessions.length === 0 || reviewAsOfMs === undefined) {
    return [...blockers];
  }
  const superseded = new Set(
    supersessions
      .filter((entry) => entry.stage === stage && new Date(entry.supersededAt).getTime() > reviewAsOfMs)
      .map((entry) => entry.blockerDescription.trim())
  );
  if (superseded.size === 0) {
    return [...blockers];
  }
  return blockers.filter((blocker) => !superseded.has(blocker.description.trim()));
}
