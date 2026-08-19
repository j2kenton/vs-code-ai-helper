import {
  MAX_REVIEW_BLOCKER_IDENTITIES,
  ReviewBlockerIdentity,
  ReviewScoreHistoryEntry,
  STAGE_DISPLAY_NAMES,
  TaskStage,
} from "../types/taskProgress";
import { BlockerResolver, meetsAutoAdvanceThreshold, ReviewBlocker } from "./reviewReadiness";

/** Default number of consecutive rounds with no new high-water-mark score
 * before a stage is considered plateaued. Configurable via
 * `ensemble.reviewPlateauRounds` — see settings.ts. */
export const DEFAULT_PLATEAU_WINDOW = 3;

/**
 * Number of commits past which a re-review's "previous review" (2i) is
 * considered stale enough that reconciling against it blocker-by-blocker no
 * longer makes sense — the re-review should instead derive current state
 * from the workspace/context pack and treat the prior review as history only.
 * A plain constant, not a setting: this guards against a multi-day-old review
 * being read as current (the task_5 evidence was a 62-commit gap), not a
 * tunable behavior a user would reasonably want to adjust per repo.
 */
export const STALE_REVIEW_RECONCILIATION_COMMIT_THRESHOLD = 15;

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
/** `${providerLabel}|${storedModelId}` for the reviewer that produced
 * `entry`, or `undefined` when the entry predates identity tracking. */
function reviewerKey(entry: ReviewScoreHistoryEntry): string | undefined {
  return entry.reviewer ? `${entry.reviewer.providerLabel}|${entry.reviewer.storedModelId}` : undefined;
}

/**
 * Restrict a scored-entry list to the trailing run produced by the SAME
 * reviewer as the most recent entry, so plateau/blocker-set-stall windows
 * never compare scores or blocker sets across a provider/model substitution
 * (backup-cascade fallback, manual model switch) — a different reviewer is a
 * different instrument, and the between-reviewer offset can be the same
 * order of magnitude as the signal being measured (2026-08-14 finding:
 * workflow-2 item 7).
 *
 * An entry with no recorded identity (legacy, or the caller passed none)
 * neither confirms nor denies a reviewer change, so it is kept rather than
 * treated as a break — this keeps every pre-existing task's behavior exactly
 * as it was before identity tracking existed. Only an entry whose recorded
 * identity strictly DIFFERS from the most recent entry's cuts the run short,
 * which also means the round immediately after a reviewer change sees a
 * trailing run of length 1 (or 0) — too short to satisfy `window + 1`, so
 * the caller's existing "not enough rounds yet" guard reports not-plateaued
 * for that round rather than comparing across the break.
 */
function restrictToTrailingSameReviewerRun<T extends ReviewScoreHistoryEntry>(
  scored: readonly T[]
): readonly T[] {
  const lastEntry = scored[scored.length - 1];
  if (lastEntry === undefined) {
    return scored;
  }
  const lastKey = reviewerKey(lastEntry);
  if (lastKey === undefined) {
    return scored;
  }
  let startIndex = scored.length - 1;
  for (let i = scored.length - 2; i >= 0; i--) {
    const current = scored[i];
    const key = current === undefined ? undefined : reviewerKey(current);
    if (key !== undefined && key !== lastKey) {
      break;
    }
    startIndex = i;
  }
  return scored.slice(startIndex);
}

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
  const scoredAcrossReviewers = history.filter(
    (entry): entry is ReviewScoreHistoryEntry & { score: number } =>
      entry.stage === stage &&
      entry.score !== null &&
      // Legacy entries predate this field; treat them as countable rather
      // than silently disabling plateau detection for older tasks.
      (entry.taskFixableCount === undefined || entry.taskFixableCount > 0)
  );
  const scored = restrictToTrailingSameReviewerRun(scoredAcrossReviewers);
  if (scored.length < safeWindow + 1) {
    return false;
  }
  const recent = scored.slice(-safeWindow);
  const prior = scored.slice(0, -safeWindow);
  const priorBest = Math.max(...prior.map((entry) => entry.score));
  const recentBest = Math.max(...recent.map((entry) => entry.score));
  return recentBest <= priorBest;
}

/** File-ish token (has a path separator or an extension) named by a blocker
 * description — the most stable "what is this about" key across rewordings. */
const BLOCKER_SUBJECT_FILE_RE = /[\w@][\w@./\\-]*[/\\.][\w./\\-]*\w/;

/**
 * Reduce one reported blocker to the stable identity persisted in
 * `reviewScoreHistory` and compared by {@link detectBlockerSetStall}.
 * Deliberately NOT the raw prose: reviewer wording drifts round to round
 * ("still fails in three test files" → "fails during collection in all three
 * test files") while the underlying cause never changes, so identity is
 * category + resolver + the file/subject named. When no file-ish token is
 * present the normalized leading prose stands in — imperfect, but two rounds
 * describing the same problem usually share their opening words.
 */
export function blockerIdentity(blocker: ReviewBlocker): ReviewBlockerIdentity {
  const fileMatch = BLOCKER_SUBJECT_FILE_RE.exec(blocker.description);
  const subject = fileMatch
    ? fileMatch[0].toLowerCase()
    : blocker.description.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 64);
  return {
    category: blocker.category,
    resolver: blocker.resolver,
    subject: subject || "unspecified",
  };
}

/** Truncated to the persisted cap so an over-verbose review can't grow a
 * history entry unboundedly (and fail the strict decoder's bound). */
export function blockerIdentities(blockers: readonly ReviewBlocker[]): ReviewBlockerIdentity[] {
  return blockers.slice(0, MAX_REVIEW_BLOCKER_IDENTITIES).map(blockerIdentity);
}

function identityKeySet(blockers: readonly ReviewBlockerIdentity[]): Set<string> {
  return new Set(blockers.map((b) => `${b.category}|${b.resolver}|${b.subject}`));
}

/**
 * Blocker-set stall detection — the `ensemble.resilience.blockerSetPlateau`
 * replacement for {@link detectPlateau}'s score-high-water-mark test. The
 * blocker set is the progress signal; the score is display only:
 *
 *  - Improving: the set shrank, or its CONTENTS changed (one resolved, one
 *    new — same count, real progress) → not stalled, score ignored.
 *  - Stuck: the set is substantively unchanged across the window → stalled.
 *  - Regressing: the set only ever grew across the window → stalled
 *    (iteration is making things worse, escalate rather than run on).
 *
 * "Substantively" means identity comparison (category, resolver, file/subject
 * — see blockerIdentity), never byte-for-byte prose. Requires `window`
 * transitions (window + 1 rounds) that all carry identity data — AND a
 * non-empty blocker set at the start of the window, so a blocker's first
 * appearance after clean rounds never reads as "stuck for the whole window".
 * Entries written before the `blockers` field existed fall back to the
 * legacy score test so older tasks keep a working safety valve rather than
 * silently losing it.
 */
export function detectBlockerSetStall(
  history: readonly ReviewScoreHistoryEntry[],
  stage: TaskStage,
  window: number = DEFAULT_PLATEAU_WINDOW
): boolean {
  const safeWindow = Number.isFinite(window) && window > 0 ? Math.floor(window) : DEFAULT_PLATEAU_WINDOW;
  const scoredAcrossReviewers = history.filter(
    (entry) => entry.stage === stage && entry.score !== null
  );
  const scored = restrictToTrailingSameReviewerRun(scoredAcrossReviewers);
  if (scored.length < safeWindow + 1) {
    return false;
  }
  const recent = scored.slice(-(safeWindow + 1));
  if (recent.some((entry) => entry.blockers === undefined)) {
    return detectPlateau(history, stage, safeWindow);
  }
  // A stall means the SAME work stayed unresolved for the whole window, so
  // the window must START with something to be stuck on. A blocker whose
  // first appearance falls inside the window is NEW work, not a stall —
  // escalating on it would reinstate the 2026-07-26 regression the legacy
  // detector's zero-fixable filter exists for (clean rounds becoming the
  // baseline a brand-new blocker is measured against, escalating on its
  // FIRST appearance as "unable to resolve across multiple rounds"). This
  // also covers the all-empty window: healthy clean rounds are not a stall
  // (decideReviewRoute already refuses to escalate with zero current
  // blockers; zero-fixable termination is reviewScoreLoop's job).
  if ((recent[0]?.blockers ?? []).length === 0) {
    return false;
  }
  for (let i = 1; i < recent.length; i++) {
    const prev = identityKeySet(recent[i - 1]?.blockers ?? []);
    const next = identityKeySet(recent[i]?.blockers ?? []);
    const removed = [...prev].some((key) => !next.has(key));
    const shrank = next.size < prev.size;
    // Any transition that resolved at least one prior blocker (or shrank the
    // set) is real progress — the window is not a stall.
    if (removed || shrank) {
      return false;
    }
  }
  // Every transition kept the full prior set (unchanged or grew) — stuck or
  // regressing for the whole window.
  return true;
}

/**
 * How many consecutive trailing review rounds (for this stage, scored, with
 * a recorded taskFixableCount) have gone by WITHOUT a strict decrease in
 * task-fixable blockers — the churn-ceiling input: a loop that keeps
 * completing rounds while the amount of fixable work never falls is burning
 * budget regardless of what the score or the blocker identities are doing.
 * Returns 0 when fewer than two comparable rounds exist.
 *
 * Only counts a transition where the PREVIOUS round already carried
 * task-fixable work (`taskFixableCount > 0`). A transition out of a
 * zero-fixable round is not churn: report 12 observed a task stall cleanly
 * for 18 zero-blocker rounds (nothing to churn on), then have the churn
 * ceiling fire on the very next round — the first one to find a real
 * blocker — because `0 >= 0` had been silently accruing to this counter the
 * whole time. Counting only genuine "keeps finding the same amount of work"
 * runs means the counter no longer charges up during a healthy or
 * differently-stalled stretch and then detonates on the round that proves
 * iteration is converging.
 */
export function roundsWithoutTaskFixableDecrease(
  history: readonly ReviewScoreHistoryEntry[],
  stage: TaskStage
): number {
  const scored = history.filter(
    (entry) => entry.stage === stage && entry.score !== null && entry.taskFixableCount !== undefined
  );
  let rounds = 0;
  for (let i = scored.length - 1; i >= 1; i--) {
    const current = scored[i];
    const previous = scored[i - 1];
    if (!current || !previous || previous.taskFixableCount <= 0 || current.taskFixableCount < previous.taskFixableCount) {
      break;
    }
    rounds++;
  }
  return rounds;
}

/**
 * Churn-ceiling escalation decision (extracted from
 * handleReviewRoutingOutcome so the escalate-or-not choice has a unit-test
 * seam): escalate when the flag is on (`churnCeilingRounds > 0`), the round
 * that was just recorded still carries task-fixable work, and the trailing
 * run of rounds without a decrease in `taskFixableCount` has reached the
 * ceiling. With the flag off (0) this never escalates — the legacy behavior.
 */
export function shouldEscalateChurnCeiling(input: {
  history: readonly ReviewScoreHistoryEntry[];
  stage: TaskStage;
  /** The just-recorded round's task-fixable count — a round with nothing
   * fixable left is not churning, it is (at worst) waiting on escalation
   * paths that own that case. */
  taskFixableCount: number;
  /** ensemble.resilience.churnCeilingRounds (0 = off). */
  churnCeilingRounds: number;
}): boolean {
  if (input.churnCeilingRounds <= 0 || input.taskFixableCount <= 0) {
    return false;
  }
  return (
    roundsWithoutTaskFixableDecrease(input.history, input.stage) >=
    input.churnCeilingRounds
  );
}

/**
 * Whether the last two same-stage review rounds report the same blocker
 * situation — by identity set when both rounds recorded one, else by equal
 * non-zero blocker/task-fixable counts. False without two comparable rounds:
 * the no-progress breaker never escalates on missing evidence.
 */
export function sameBlockerPersistsAcrossLastRounds(
  history: readonly ReviewScoreHistoryEntry[] | undefined
): boolean {
  const lastEntry = history?.[history.length - 1];
  if (!lastEntry) {
    return false;
  }
  const sameStage = (history ?? []).filter((entry) => entry.stage === lastEntry.stage);
  const prev = sameStage[sameStage.length - 2];
  const last = sameStage[sameStage.length - 1];
  if (!prev || !last) {
    return false;
  }
  if (prev.blockers !== undefined && last.blockers !== undefined) {
    const prevKeys = identityKeySet(prev.blockers);
    const lastKeys = identityKeySet(last.blockers);
    return (
      lastKeys.size > 0 &&
      prevKeys.size === lastKeys.size &&
      [...lastKeys].every((k) => prevKeys.has(k))
    );
  }
  return (
    last.taskFixableCount > 0 &&
    last.taskFixableCount === prev.taskFixableCount &&
    last.blockerCount === prev.blockerCount
  );
}

/**
 * No-progress-breaker decision (2c, ensemble.resilience.noProgressBreakerRounds
 * — extracted from executeImplementationRun so the escalate-or-not choice has
 * a unit-test seam): trip when the flag is on (`breakerRounds > 0`) and the
 * consecutive zero-file-change implementation-round count has reached it.
 * With the flag off (0) this never trips — the legacy behavior.
 *
 * The zero-change count is sufficient on its own — a round that changed no
 * files trips at N whether or not it carried blockers. Requiring the durable
 * review history to also show the same blocker persisting (the original
 * gate) disabled the breaker exactly when the evidence of no progress was
 * strongest: a reviewer reporting zero blockers round after round while
 * nothing gets edited (report 11, an 18-round/9-hour stall) never made
 * `sameBlockerPersistsAcrossLastRounds` true, since that helper requires a
 * non-empty blocker identity set.
 *
 * `sameBlockerPersistsAcrossLastRounds` remains available as an independent
 * signal for rounds that DO change files but keep reproducing the same
 * blocker — a different stall shape from the one this function now measures
 * directly.
 *
 * The item-8 shape this breaker exists for is specifically a PASSING review
 * sending a finished-looking round back to `impl` forever — a review at or
 * above the auto-advance threshold, not a task with real unresolved work.
 * Trip therefore also requires the most recent same-stage history entry to
 * meet `qualifyingThreshold` (2026-08-14 review finding: without this gate,
 * three manual/no-op implementation reruns with no qualifying passing review
 * on record could pause a task too — a different, unrelated stall shape this
 * breaker was never meant to police). `qualifyingStage`/`qualifyingThreshold`
 * are optional so existing callers/tests that predate this gate keep their
 * exact prior behavior (trip on the zero-change count alone) when they omit
 * both; every real call site supplies them together. When they ARE supplied,
 * a `history` with no qualifying entry for `qualifyingStage` — including
 * `undefined`/empty history, or an implementation round that has never yet
 * reached a review stage — does NOT trip: that is exactly the "no qualifying
 * passing-review loop" shape the review finding named, so absence of
 * evidence here is disqualifying, not unknown.
 */
/** The most recent `history` entry for `stage`, or undefined when none exists. */
function latestReviewForStageV1(
  history: readonly ReviewScoreHistoryEntry[] | undefined,
  stage: TaskStage
): ReviewScoreHistoryEntry | undefined {
  const sameStage = (history ?? []).filter((entry) => entry.stage === stage);
  return sameStage[sameStage.length - 1];
}

/**
 * Whether the most recent same-stage review history entry qualifies as "this
 * review already said the work is done" — shared by `shouldTripNoProgressBreaker`
 * below and the `checklistProgressUnreliable` latch's sterile-round trigger
 * (workflow 3 continuation, second item / Part 3), both of which gate a
 * stall-recovery action on the last review for this stage. `requireZeroBlockers`
 * additionally requires `blockerCount === 0`: the no-progress breaker trips on
 * score alone (a high-scoring review WITH blockers still names real,
 * unresolved work worth iterating on), but the latch's "the checklist counts
 * are under-recording by definition" reasoning only holds when the review
 * found nothing left to fix at all — a full-marks, zero-blocker review.
 */
export function latestQualifyingReviewMeetsThresholdV1(input: {
  history: readonly ReviewScoreHistoryEntry[] | undefined;
  stage: TaskStage;
  threshold: number;
  requireZeroBlockers?: boolean;
}): boolean {
  const latest = latestReviewForStageV1(input.history, input.stage);
  if (!latest) {
    return false;
  }
  if (!meetsAutoAdvanceThreshold(latest.score, input.threshold)) {
    return false;
  }
  return !input.requireZeroBlockers || latest.blockerCount === 0;
}

export function shouldTripNoProgressBreaker(input: {
  /** Consecutive completed implementation rounds that changed zero files. */
  zeroChangeRounds: number;
  /** ensemble.resilience.noProgressBreakerRounds (0 = off). */
  breakerRounds: number;
  history: readonly ReviewScoreHistoryEntry[] | undefined;
  /** The review stage this implementation round answers to — the streak only
   * qualifies against that stage's own history, never a different stage's. */
  qualifyingStage?: TaskStage;
  /** The auto-advance score threshold a qualifying review must meet or
   * exceed. Omit together with `qualifyingStage` to skip the gate entirely. */
  qualifyingThreshold?: number;
}): boolean {
  if (input.breakerRounds <= 0) {
    return false;
  }
  if (input.zeroChangeRounds < input.breakerRounds) {
    return false;
  }
  if (input.qualifyingThreshold === undefined || input.qualifyingStage === undefined) {
    return true;
  }
  return latestQualifyingReviewMeetsThresholdV1({
    history: input.history,
    stage: input.qualifyingStage,
    threshold: input.qualifyingThreshold,
  });
}

/**
 * Degenerate-review rejection decision (2d,
 * ensemble.resilience.rejectDegenerateReviews — extracted from
 * handleReviewRoutingOutcome so both flag states have a unit-test seam).
 * Returns the human-readable rejection reason when the round must be
 * recorded as a failed attempt and EXCLUDED from reviewScoreHistory (a
 * phantom scoreless round would otherwise distort plateau detection), or
 * null when the round proceeds normally: flag off (legacy behavior — the
 * round is appended to history with a null score), or a parseable score.
 */
export function degenerateReviewRejectionReason(input: {
  /** ensemble.resilience.rejectDegenerateReviews. */
  rejectDegenerateReviews: boolean;
  /** Parsed `Readiness: N/10`, or null when no parseable line exists. */
  score: number | null;
  stage: TaskStage;
  attemptId: string;
}): string | null {
  if (!input.rejectDegenerateReviews || input.score !== null) {
    return null;
  }
  return (
    `The ${STAGE_DISPLAY_NAMES[input.stage]} review round (attempt ${input.attemptId}) produced no ` +
    "parseable `Readiness: N/10` line — recorded as a failed attempt, not a review. " +
    "The round was excluded from the review score history so it cannot distort plateau detection."
  );
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
    // Every reported blocker is environmental, unverifiable, a spec defect,
    // or needs-toolchain (requires running the project's own build/codegen,
    // which the implementation stage structurally cannot do) — none is
    // something another automated implementation round could act on. That is
    // true independent of the score's trend: unlike "iterate" (below), where
    // waiting to see whether task-fixable work lands over more rounds is
    // worthwhile, there is nothing here for more rounds to change. Escalate
    // immediately rather than waiting out a full plateau window (and,
    // previously, a wasted second-opinion round) on rounds that could not
    // have altered the outcome either way.
    return {
      route: "escalate",
      reason: plateaued
        ? "The score has plateaued and every remaining blocker is outside automation's control (environmental, unverifiable, a spec defect, or requires toolchain execution)."
        : "Every remaining blocker is outside automation's control (environmental, unverifiable, a spec defect, or requires toolchain execution); no amount of further automated iteration can resolve it.",
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

/**
 * Which edit action can actually act on what the newest review left behind.
 *
 * `decideReviewRoute` above answers "keep iterating, or stop?". It does NOT
 * answer "iterate with WHAT", and that gap is a real stall shape: the two edit
 * actions read different inputs, and only one of them can see a blocker.
 *
 *  - Implementation (`run-implementation.md`) is rendered with
 *    `{ contextPack, plan }` — the plan checklist and nothing else. The review
 *    is not among its template variables, so a blocker is invisible to it.
 *  - Apply Review (`apply-impl-review-code.md`) is rendered with the review
 *    itself and is told to "fix every unresolved or partially resolved blocker
 *    the review identifies".
 *
 * So an `iterate` route answered by another Implementation round can loop
 * forever whenever the standing blockers are defects in code that was already
 * built rather than unbuilt checklist steps: the reviewer keeps reporting
 * them, Implementation keeps never being shown them, and the checklist it CAN
 * see has nothing actionable left — which is also how those rounds end up
 * returning an empty plan and settling `completed`.
 *
 * Observed 2026-08-19: an impl-low review held the same three blockers across
 * ~10 rounds and ~15 hours at a flat 5/10. Two of the three (a mutation
 * atomicity defect and a counter contradicting its own regression test) had no
 * corresponding checklist item, because neither was an unbuilt plan step. No
 * amount of further Implementation rounds could have closed them.
 *
 * Blockers therefore take precedence over unticked checklist items: standing
 * fixable work that iteration is structurally blind to is strictly more urgent
 * than plan steps it can see, and the plan's remaining items are still there
 * on the round after the blockers clear.
 */
export type PostReviewActionV1 = "apply-review" | "implementation" | "none";

export interface PostReviewActionDecisionV1 {
  readonly action: PostReviewActionV1;
  readonly reason: string;
  /**
   * The stage of the review round this decision was made from, so a caller
   * dispatching "apply-review" applies the round that actually carries the
   * blockers rather than guessing between the two impl review artifacts.
   * Absent when no review has run yet.
   */
  readonly reviewStage?: TaskStage;
}

/**
 * The review stages an implementation round answers to. Both are consulted
 * together — see `decidePostReviewActionV1`'s `stages`.
 */
export const IMPL_REVIEW_STAGES_V1: readonly TaskStage[] = [
  "impl-low-review",
  "impl-high-review",
];

export function decidePostReviewActionV1(input: {
  history: readonly ReviewScoreHistoryEntry[] | undefined;
  /**
   * The review stages the next edit round answers to. The implementation
   * stage answers to BOTH `impl-low-review` and `impl-high-review`, and the
   * newest round of either is the only one describing the current tree — so
   * the decision is made from the latest entry across all of them, never from
   * whichever stage happens to be listed first. Reading one stage's entry
   * while the other holds the fresher round is its own observed bug: a Fast
   * Forward run stopped on a stale `impl-high-review` 9/10 while the current
   * `impl-low-review` round stood at 5/10 with three blockers.
   */
  stages: readonly TaskStage[];
  /** Whether the plan of record still has unticked checklist items. */
  hasUntickedChecklistItems: boolean;
}): PostReviewActionDecisionV1 {
  const candidates = input.stages
    .map((stage) => latestReviewForStageV1(input.history, stage))
    .filter((entry): entry is ReviewScoreHistoryEntry => entry !== undefined);
  // `at` is an ISO-8601 UTC timestamp, so lexicographic order is chronological.
  // Ties (same millisecond) keep the later-listed stage, which is harmless:
  // both entries describe the same tree.
  const latest = candidates.reduce<ReviewScoreHistoryEntry | undefined>(
    (best, entry) => (best === undefined || entry.at >= best.at ? entry : best),
    undefined
  );
  const stageName = latest ? STAGE_DISPLAY_NAMES[latest.stage] : "implementation";
  // No review for these stages yet — the checklist is the only signal there
  // is, and Implementation is the action that reads it.
  if (!latest) {
    return input.hasUntickedChecklistItems
      ? {
          action: "implementation",
          reason: `No ${stageName} review has run yet; the plan checklist still has unticked items.`,
        }
      : {
          action: "none",
          reason: `No ${stageName} review has run yet and the plan checklist is complete.`,
        };
  }
  if (latest.taskFixableCount > 0) {
    return {
      action: "apply-review",
      reviewStage: latest.stage,
      // Plain language on purpose: this string is shown to the user in a
      // dialog they have to act on, and "task-fixable blockers are not
      // rendered into the implementation prompt" is a sentence that describes
      // the mechanism perfectly and tells nobody what to click.
      reason:
        `The ${stageName} review found ${latest.taskFixableCount} problem(s) in the code that ` +
        "still need fixing. Implementation works only from the plan checklist, so it cannot fix " +
        "them — Apply Review can.",
    };
  }
  if (input.hasUntickedChecklistItems) {
    return {
      action: "implementation",
      reviewStage: latest.stage,
      reason: `The newest ${stageName} review reports no task-fixable blockers; unticked checklist items remain.`,
    };
  }
  return {
    action: "none",
    reviewStage: latest.stage,
    reason: `The newest ${stageName} review reports no task-fixable blockers and the plan checklist is complete.`,
  };
}

