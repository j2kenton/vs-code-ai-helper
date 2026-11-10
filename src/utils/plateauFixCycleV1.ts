import { STAGE_DISPLAY_NAMES } from "../types/taskProgress";
import type {
  ReviewScoreHistoryEntry,
  RoundLedgerEntryV1,
  TaskEscalation,
  TaskStage,
} from "../types/taskProgress";

/**
 * bugs3 Step 9 (plateau across fix/review cycles).
 *
 * A plateau means "fix rounds are not converging". Two reviews with no fix
 * round between them (a resumed run that only re-reviews unchanged code, or
 * the first review after Implementation) say nothing about that: they must
 * neither count toward a stall nor read as one. This narrows the stage's
 * score history to the trailing chain of reviews where every consecutive pair
 * is separated by a real fix round, and starts that chain after the latest
 * overridden plateau for the stage so an explicit "Keep iterating" opens a
 * fresh baseline.
 *
 * The caller hands the returned history to the existing detectors unchanged.
 * A ledger holding no fix-round rows (or none between the reviews) leaves a
 * chain of at most the latest review, so no plateau can be raised without an
 * intervening fix round.
 */
const FIX_MODES = new Set(["implementation", "apply-review", "continuation"]);

function isRealFixRound(row: RoundLedgerEntryV1): boolean {
  if (!FIX_MODES.has(row.mode)) {
    return false;
  }
  if (row.state === "scheduled" || row.state === "open" || row.state === "dropped") {
    return false;
  }
  if (row.state === "completed" || row.state === "rejected") {
    return true;
  }
  // failed / cancelled / interrupted / quota-blocked: only when it edited files.
  const files = row.outcome?.filesChanged;
  return (files !== undefined && files.length > 0) || row.outcome?.filesChangedUnknown === true;
}

/** How many real fix rounds (Implementation, Apply Review, continuation) the ledger records for the task. */
export function countRealFixRoundsV1(ledger: readonly RoundLedgerEntryV1[] | undefined): number {
  return (ledger ?? []).filter(isRealFixRound).length;
}

function fixRoundBetween(
  fixRows: readonly RoundLedgerEntryV1[],
  afterIso: string,
  untilIso: string
): boolean {
  return fixRoundIdsBetweenV1(fixRows, afterIso, untilIso).length > 0;
}

function fixRoundIdsBetweenV1(fixRows: readonly RoundLedgerEntryV1[], afterIso: string, untilIso: string): string[] {
  return fixRows
    .filter((row) => {
      const end = row.endedAt ?? row.startedAt;
      return end > afterIso && end <= untilIso;
    })
    .map((row) => row.roundId);
}

/**
 * The ids of the real fix rounds that ended after the stage's previous scored
 * review and by `untilIso`, for `ReviewScoreHistoryEntry.fixRoundIds`. Undefined
 * when the stage has no earlier scored review (nothing to be separated from).
 */
export function fixRoundIdsSincePreviousReviewV1(
  history: readonly ReviewScoreHistoryEntry[],
  stage: TaskStage,
  ledger: readonly RoundLedgerEntryV1[] | undefined,
  untilIso: string
): string[] | undefined {
  const previous = [...history].reverse().find((entry) => entry.stage === stage && entry.score !== null);
  if (previous === undefined) {
    return undefined;
  }
  return fixRoundIdsBetweenV1((ledger ?? []).filter(isRealFixRound), previous.at, untilIso);
}

/**
 * Whether a fix round separates `previous` from `current`. A recorded
 * `fixRoundIds` on the later review is the answer; an entry written before the
 * field existed is read from the ledger's timestamps.
 */
function separatedByFixRound(
  fixRows: readonly RoundLedgerEntryV1[],
  previous: ReviewScoreHistoryEntry,
  current: ReviewScoreHistoryEntry
): boolean {
  if (current.fixRoundIds !== undefined) {
    return current.fixRoundIds.length > 0;
  }
  return fixRoundBetween(fixRows, previous.at, current.at);
}

/**
 * bugs3 Step 9: whether a resumed Fast Forward run ("Keep iterating … from
 * Apply Review") must discard the stage's existing review and re-review first.
 * The ledger test (`reviewPredatesLatestImplementationRoundV1`) is
 * conservative — a later round with no recorded outcome reads as "may have
 * changed files" — so on its own it sent a resume back through a review of a
 * tree that had not moved, which finds the same blockers and trips the plateau
 * check again. A resumed run whose review is provably of the current tree
 * (same commit and working-tree fingerprint, no stale banner) keeps it and
 * starts with Apply Review. Every other staleness reason is unaffected, and a
 * run that was not resumed keeps the ledger test as it was.
 */
export function reviewPredatesRoundNeedsFreshReviewV1(input: {
  readonly predatesLatestRound: boolean;
  readonly resumedRun: boolean;
  readonly treeProvablyUnchanged: boolean;
}): boolean {
  return input.predatesLatestRound && !(input.resumedRun && input.treeProvablyUnchanged);
}

/**
 * bugs3 Step 9: a resumed "Keep iterating … from Apply Review" starts with
 * Apply Review when the stage's review is of the current workspace
 * (`reviewPredatesRoundNeedsFreshReviewV1` above); otherwise it reviews first,
 * and the chat says so with this line.
 */
export function resumeReReviewNoticeV1(stage: TaskStage, treeProvablyUnchanged: boolean): string {
  const stageName = STAGE_DISPLAY_NAMES[stage];
  const reason = treeProvablyUnchanged
    ? "that review is out of date, so it can no longer be fixed against"
    : "the workspace or the review's inputs changed since that review, so it can no longer be fixed against";
  return `Reviewing ${stageName} again before applying fixes: ${reason}. Apply Review follows this review.`;
}

/**
 * The sentence the plateau card's "Keep iterating" option adds so its stated
 * first step is the one it will take: the card is raised right after a review
 * of the current workspace, so it starts with Apply Review, and re-reviews
 * first only if something changed before the option is taken.
 */
export const KEEP_ITERATING_SEQUENCE_NOTE_V1 =
  "It starts with Apply Review, because this review is of the current workspace. If the workspace or the " +
  "review's inputs change before you choose this, it reviews first instead and says so in the chat.";

export function historyAfterFixCyclesV1(
  history: readonly ReviewScoreHistoryEntry[],
  stage: TaskStage,
  ledger: readonly RoundLedgerEntryV1[] | undefined,
  overriddenEscalations: readonly TaskEscalation[] | undefined
): readonly ReviewScoreHistoryEntry[] {
  const fixRows = (ledger ?? []).filter(isRealFixRound);
  const overrideAt = (overriddenEscalations ?? [])
    .filter((escalation) => escalation.stage === stage && escalation.kind === "plateau")
    .map((escalation) => escalation.at)
    .sort()
    .pop();
  const stageEntries = history.filter(
    (entry) => entry.stage === stage && entry.score !== null && (overrideAt === undefined || entry.at > overrideAt)
  );
  let start = stageEntries.length - 1;
  while (start > 0) {
    const previous = stageEntries[start - 1]!;
    const current = stageEntries[start]!;
    if (!separatedByFixRound(fixRows, previous, current)) {
      break;
    }
    start--;
  }
  return stageEntries.slice(Math.max(start, 0));
}
