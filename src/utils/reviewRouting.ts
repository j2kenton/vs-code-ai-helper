import { ReviewScoreHistoryEntry, TaskStage } from "../types/taskProgress";
import { BlockerResolver, ReviewBlocker } from "./reviewReadiness";

/** Default number of consecutive rounds with no new high-water-mark score
 * before a stage is considered plateaued. Configurable via
 * `ensemble.reviewPlateauRounds` — see settings.ts. */
export const DEFAULT_PLATEAU_WINDOW = 3;

/**
 * A stage is plateaued when the best score seen in the most recent `window`
 * rounds is no better than the best score seen in every round before that
 * window — i.e. the last `window` rounds collectively failed to set a new
 * high-water mark. Oscillation within a band (5→6→5→6, as happened in the
 * task this was built to fix) counts as plateaued: it never asks "did the
 * score go up since the immediately previous round", only "did it exceed
 * the run's own best so far".
 *
 * Requires at least `window + 1` rounds for this stage (one round to
 * establish a baseline, plus a full window after it) — with fewer rounds
 * there isn't enough signal to distinguish "still improving" from "stuck",
 * so this conservatively returns false rather than guessing.
 *
 * Rounds that reported no task-fixable blocker are excluded entirely. A
 * plateau is meant to answer "is automated iteration failing to fix what it
 * was told to fix?", and a round with nothing fixable to act on is no
 * evidence either way: most often it is a healthy review sitting below a
 * strict numeric threshold (e.g. a staged plan legitimately capped at ~5/10
 * while only a third of its ordered steps have landed) with the reviewer
 * reporting zero blockers. Counting those rounds made a genuinely
 * progressing task look stuck — observed 2026-07-26, where three clean
 * zero-blocker rounds became the "prior best" that a later round carrying a
 * brand-new blocker was then measured against, escalating on that blocker's
 * FIRST appearance under the banner "unable to resolve it across multiple
 * rounds". Rounds that did carry fixable work still count in full, so a real
 * stall is still caught.
 */
export function detectPlateau(
  history: readonly ReviewScoreHistoryEntry[],
  stage: TaskStage,
  window: number = DEFAULT_PLATEAU_WINDOW
): boolean {
  // A non-finite/non-positive window (e.g. NaN from a malformed setting)
  // must not reach the slice(-window) calls below: Array.prototype.slice
  // coerces a NaN offset to 0, which silently makes `prior` permanently
  // empty and this function permanently return false — a caller that
  // passes a bad window gets a working default instead of a silently
  // disabled safety valve.
  const safeWindow = Number.isFinite(window) && window > 0 ? Math.floor(window) : DEFAULT_PLATEAU_WINDOW;
  const scored = history.filter(
    (entry): entry is ReviewScoreHistoryEntry & { score: number } =>
      entry.stage === stage &&
      entry.score !== null &&
      // Legacy entries predate this field; treat them as countable rather
      // than silently disabling plateau detection for older tasks.
      (entry.taskFixableCount === undefined || entry.taskFixableCount > 0)
  );
  if (scored.length < safeWindow + 1) {
    return false;
  }
  const recent = scored.slice(-safeWindow);
  const prior = scored.slice(0, -safeWindow);
  const priorBest = Math.max(...prior.map((entry) => entry.score));
  const recentBest = Math.max(...recent.map((entry) => entry.score));
  return recentBest <= priorBest;
}

export type ReviewRoute =
  | "advance"
  | "advance-with-note"
  | "iterate"
  | "second-opinion"
  | "escalate";

export interface RouteDecision {
  route: ReviewRoute;
  reason: string;
}

/**
 * The rubric instructs reviewers to keep the score at 7 or below whenever any
 * blocker is reported (review-scoring-rubric.md: "Blockers of any category
 * this review uses ... should normally keep the score at 7 or below"). A
 * configured stop level or auto-advance threshold above this is therefore
 * unreachable for as long as any blocker keeps getting reported — not a
 * mis-configuration on the user's part, since the shipped default threshold
 * (10) already sits above this same cap. See rubricCapLikelyBlockedAdvance.
 */
export const REVIEW_RUBRIC_BLOCKER_SCORE_CAP = 7;

/**
 * Whether a Fast Forward run that failed to reach its configured stop level
 * most likely hit the rubric's structural cap rather than a genuinely
 * unresolved implementation problem: the best score it ever reached was
 * already at or below that cap, while the configured stop level asks for
 * something higher. Used only to decide whether to explain WHY the target
 * was never reached — never to change the configured level itself.
 */
export function rubricCapLikelyBlockedAdvance(
  bestScore: number | null,
  configuredStopLevel: number
): boolean {
  return (
    bestScore !== null &&
    bestScore <= REVIEW_RUBRIC_BLOCKER_SCORE_CAP &&
    configuredStopLevel > REVIEW_RUBRIC_BLOCKER_SCORE_CAP
  );
}

/**
 * Decide what should happen next for a review round, given its score,
 * classified blockers, and whether this stage has plateaued. This does not
 * itself gate stage advancement — the existing score-threshold auto-advance
 * logic in reviewActions.ts is left untouched, since it carries a lot of
 * carefully-tuned CAS/locking/chain-scheduling behavior. This function is
 * instead consulted for the case that logic has no answer for today: the
 * task sits below threshold with nothing automated ever noticing it's stuck.
 *
 * Routes:
 *  - advance / advance-with-note: informational — the caller's existing
 *    threshold check already handles advancing; "advance-with-note" flags
 *    that only known-environmental blockers remain, worth surfacing even
 *    though nothing needs to change about the advance itself.
 *  - iterate: below threshold, but either no blockers were parsed (older
 *    review, nothing to route on) or task-fixable work remains and no
 *    plateau has been detected yet — normal automated iteration continues.
 *  - second-opinion: plateaued with task-fixable blockers still claimed —
 *    worth one independent second reviewer before giving up (see
 *    reconcileReviews in reviewActions.ts).
 *  - escalate: nothing left for automation to try — either every remaining
 *    blocker is environmental/unverifiable/spec-defect (no plateau required:
 *    another round cannot act on these regardless of score trend), or the
 *    stage has plateaued and a second opinion has already been tried this
 *    plateau and didn't resolve it.
 */
export function decideReviewRoute(input: {
  score: number | null;
  threshold: number;
  blockers: readonly ReviewBlocker[];
  plateaued: boolean;
  secondOpinionTriedThisPlateau: boolean;
}): RouteDecision {
  const { score, threshold, blockers, plateaued, secondOpinionTriedThisPlateau } = input;
  const meetsThreshold = score !== null && score >= threshold;
  const countByResolver = (resolver: BlockerResolver): number =>
    blockers.filter((b) => b.resolver === resolver).length;
  const taskFixable = countByResolver("task-fixable");
  const specDefect = countByResolver("spec-defect");
  const environmental = countByResolver("environmental");
  const onlyEnvironmentalRemain = blockers.length > 0 && environmental === blockers.length;
  const onlyNonFixableRemain = blockers.length > 0 && taskFixable === 0;

  if (meetsThreshold && blockers.length === 0) {
    return {
      route: "advance",
      reason: "Score meets the configured threshold and no blockers were reported.",
    };
  }
  if (meetsThreshold && taskFixable === 0 && specDefect === 0) {
    // Threshold met, but some non-task-fixable, non-spec-defect blocker
    // (environmental and/or unverifiable) is still on record — worth
    // surfacing even though nothing needs to change about the advance.
    return {
      route: "advance-with-note",
      reason: onlyEnvironmentalRemain
        ? "Score meets the configured threshold; only known-environmental blockers remain."
        : "Score meets the configured threshold; only environmental/unverifiable blockers remain.",
    };
  }
  if (blockers.length === 0) {
    // No blocker was reported at all — most commonly a score capped below a
    // strict configured threshold (e.g. the default requires a perfect
    // 10/10) with nothing the reviewer actually flagged as wrong. That is
    // not "stuck": there is nothing for a second opinion to adjudicate and
    // nothing for a human to be pulled in for. Escalating here — as an
    // earlier version of this function did — produced a false "stuck, and
    // no alternate model was available" alarm on totally healthy stock
    // settings (no blockers, 9/10, default plateau window) purely because
    // the numeric threshold was strict. Plateau-driven routes below
    // therefore require at least one reported blocker to act on.
    return {
      route: "iterate",
      reason: "No blockers were reported; the score alone has not reached the configured threshold. Not treated as stuck.",
    };
  }
  if (onlyNonFixableRemain) {
    // Every reported blocker is environmental, unverifiable, or a spec
    // defect — none is something another automated implementation round
    // could act on. That is true independent of the score's trend: unlike
    // "iterate" (below), where waiting to see whether task-fixable work
    // lands over more rounds is worthwhile, there is nothing here for more
    // rounds to change. Escalate immediately rather than waiting out a full
    // plateau window (and, previously, a wasted second-opinion round) on
    // rounds that could not have altered the outcome either way.
    return {
      route: "escalate",
      reason: plateaued
        ? "The score has plateaued and every remaining blocker is outside automation's control (environmental, unverifiable, or a spec defect)."
        : "Every remaining blocker is outside automation's control (environmental, unverifiable, or a spec defect); no amount of further automated iteration can resolve it.",
    };
  }
  if (plateaued && !secondOpinionTriedThisPlateau) {
    return {
      route: "second-opinion",
      reason: "The score has plateaued across multiple rounds — getting an independent second opinion before escalating.",
    };
  }
  if (plateaued) {
    return {
      route: "escalate",
      reason: "The score has plateaued across multiple rounds and a second opinion did not resolve it.",
    };
  }
  return {
    route: "iterate",
    reason: taskFixable > 0
      ? "Task-fixable work remains and no plateau has been detected yet."
      : "No plateau detected yet.",
  };
}

