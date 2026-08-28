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

/**
 * wf10 continuation items 17 / 18: this function measures whether the
 * SCORE has stopped improving — it has no way to see WHY. A frozen
 * `taskFixableCount` (see `roundsWithoutTaskFixableDecrease`,
 * `shouldEscalateChurnCeiling`) across rounds whose `RoundOutcomeEntryV1
 * .dispatchMode` was `"implementation"` the whole time is not evidence the
 * work is genuinely stuck — Implementation only ever reads the plan
 * checklist, so it structurally cannot move a task-fixable blocker count no
 * matter how many rounds run. That is a DISPATCH plateau (the loop kept
 * choosing an action that cannot help), not a WORK plateau (the problem
 * resists every action tried) — `chooseAutomaticImplementationDispatchV1`
 * (this file) exists to prevent the dispatch plateau at the source; a caller
 * diagnosing a churn-ceiling escalation should still check the dispatch mode
 * of the stagnant window's rounds before concluding the problem itself is
 * hard.
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
    ...(blocker.origin ? { origin: blocker.origin } : {}),
  };
}

/** Truncated to the persisted cap so an over-verbose review can't grow a
 * history entry unboundedly (and fail the strict decoder's bound). */
export function blockerIdentities(blockers: readonly ReviewBlocker[]): ReviewBlockerIdentity[] {
  return blockers.slice(0, MAX_REVIEW_BLOCKER_IDENTITIES).map(blockerIdentity);
}

/**
 * Resolve this round's blockers against the PRIOR round's ID'd blocker list
 * (the same list injected into this round's re-review prompt via
 * {@link formatPriorBlockerLineageListV1}), assigning each an opaque stable
 * id and, where the reviewer declared one, a lineage:
 *
 *  - No prior list at all (this stage's first scored round) → every blocker
 *    is lineage-unknown, regardless of what bracket it carries. There is
 *    nothing it could have been "new" relative to yet, and citing an id from
 *    an empty list can never be a valid citation — see the plan's "first
 *    round (no prior list to cite)" rule. A fresh id is still assigned so a
 *    LATER round can legitimately cite it.
 *  - A prior list exists, but the line carried no lineage bracket at all →
 *    lineage-unknown (older prompt, non-compliant provider). Fresh id.
 *  - `[new]` → lineage "new". Fresh id.
 *  - `[same:<id>]` / `[narrowed:<id>]` citing an id actually present in the
 *    prior list → that declared lineage, and the id is CARRIED FORWARD
 *    (not regenerated) so the same underlying issue keeps one stable id
 *    across every round the reviewer keeps citing it.
 *  - `[same:<id>]` / `[narrowed:<id>]` citing an id NOT in the prior list →
 *    lineage-unknown. Never best-effort matched to some other id — an
 *    invalid citation is exactly as uninformative as no citation at all.
 *
 * `attemptId` seeds fresh ids (`${attemptId}-${index}`) so they are unique
 * per round without needing any shared counter state. The separator MUST
 * stay a hyphen, never a colon: a generated id is injected verbatim into the
 * next round's prompt via {@link formatPriorBlockerLineageListV1} for the
 * reviewer to cite back in a `[same:<id>]`/`[narrowed:<id>]` bracket, and
 * both `BLOCKER_LINE_RE` and `parseLineageBracket` in reviewReadiness.ts
 * only accept `[\w-]+` inside that bracket — a colon in the id would make
 * every citation of it unparseable, silently degrading to lineage-unknown.
 */
export function resolveBlockerLineageV1(
  blockers: readonly ReviewBlocker[],
  priorBlockers: readonly ReviewBlockerIdentity[] | undefined,
  attemptId: string
): ReviewBlockerIdentity[] {
  const priorById = new Map<string, ReviewBlockerIdentity>();
  for (const prior of priorBlockers ?? []) {
    if (prior.id !== undefined) {
      priorById.set(prior.id, prior);
    }
  }
  const hasPriorList = (priorBlockers ?? []).length > 0;
  return blockers.slice(0, MAX_REVIEW_BLOCKER_IDENTITIES).map((blocker, index) => {
    const base = blockerIdentity(blocker);
    const description = blocker.description.slice(0, 200);
    const freshId = `${attemptId}-${index}`;
    if (!hasPriorList || !blocker.lineage) {
      return { ...base, id: freshId, description };
    }
    if (blocker.lineage.kind === "new") {
      return { ...base, id: freshId, lineage: blocker.lineage, description };
    }
    const cited = priorById.get(blocker.lineage.refId);
    if (!cited?.id) {
      return { ...base, id: freshId, description };
    }
    return { ...base, id: cited.id, lineage: blocker.lineage, description };
  });
}

/**
 * Render the prior round's ID'd blocker list for injection into a re-review
 * prompt (`{{priorBlockerLineageList}}`), so the reviewer has ids to cite in
 * its own lineage brackets this round. Absent/empty input (a first review
 * round, or a prior round predating id tracking) renders explicit guidance
 * to omit the bracket rather than a blank or misleading section.
 */
export function formatPriorBlockerLineageListV1(
  priorBlockers: readonly ReviewBlockerIdentity[] | undefined
): string {
  const idBearing = (priorBlockers ?? []).filter((b) => b.id !== undefined);
  if (idBearing.length === 0) {
    return (
      "(No previous round's blockers are recorded for this stage — either this is the first review " +
      "round, or the previous round predates lineage tracking. Do not add a third lineage bracket to " +
      "any blocker line this round; there is nothing yet to cite.)"
    );
  }
  return idBearing
    .map((b) => `- id: ${b.id} | [${b.category}] [${b.resolver}] ${b.description ?? b.subject}`)
    .join("\n");
}

/** One review round's diagnosed relationship to the churn-ceiling window it
 * sits in — see {@link classifyChurnLineageV1}. */
export type ChurnLineageDiagnosisV1 =
  | { kind: "unchanged"; description: string }
  | { kind: "narrowing" }
  | { kind: "shifting" }
  | { kind: "insufficient-evidence"; perRoundSummaries: string[] };

/**
 * Diagnose WHY a churn-ceiling window (see {@link shouldEscalateChurnCeiling})
 * stopped falling, using only lineage the reviewer itself declared —
 * never inferred from prose similarity. Distinguishes three causes that all
 * hold `taskFixableCount` flat and therefore look identical to the plain
 * churn counter:
 *
 *  - `unchanged`: the same blocker id was cited `same` (never `narrowed`,
 *    never a new id) across every round in the window — true churn, the
 *    requirement itself may need reconsidering.
 *  - `narrowing`: at least one blocker was cited `narrowed` somewhere in the
 *    window — real progress the flat count can't see.
 *  - `shifting`: the id set changed round to round with no declared
 *    narrowing — a different blocker each time, not one stuck defect.
 *  - `insufficient-evidence`: at least one round AFTER the window's first
 *    (baseline) round has a task-fixable blocker with no declared, resolved
 *    lineage (lineage-unknown, or an older entry predating this field) — the
 *    window cannot be classified from lineage alone. Reports the honest
 *    per-round list instead of guessing. The window's first round is exempt:
 *    it only supplies the baseline ids that LATER rounds cite, so its own
 *    lineage field (which resolveBlockerLineageV1 always leaves undefined
 *    when there was no prior list to cite, e.g. a stage's actual first
 *    scored round) carries no information the classification below uses.
 */
export function classifyChurnLineageV1(
  history: readonly ReviewScoreHistoryEntry[],
  stage: TaskStage,
  stagnantRounds: number
): ChurnLineageDiagnosisV1 {
  const scored = history.filter((entry) => entry.stage === stage && entry.score !== null);
  const windowSize = Math.max(1, Math.floor(stagnantRounds || 1)) + 1;
  const recent = scored.slice(-windowSize);

  const fixableOf = (entry: ReviewScoreHistoryEntry | undefined): ReviewBlockerIdentity[] =>
    (entry?.blockers ?? []).filter((b) => b.resolver === "task-fixable");

  const perRoundSummaries = recent.map((entry) => {
    const fixable = fixableOf(entry);
    return fixable.length === 0
      ? "(no task-fixable blockers recorded)"
      : fixable.map((b) => b.description ?? b.subject).join("; ");
  });

  // NOTE: every blocker resolved by resolveBlockerLineageV1 gets a fresh id
  // even when its lineage is unknown (see that function's doc) — an id alone
  // proves nothing about whether the reviewer's lineage was actually
  // resolvable. Only `lineage !== undefined` means the reviewer's bracket was
  // present and (for same/narrowed) successfully cited a real prior id. The
  // window's first (baseline) round is exempt — see the doc comment above.
  const hasUsableLineage = recent
    .slice(1)
    .every((entry) => fixableOf(entry).every((b) => b.lineage !== undefined));
  if (recent.length < windowSize || !hasUsableLineage) {
    return { kind: "insufficient-evidence", perRoundSummaries };
  }

  let anyNarrowed = false;
  let anyUnresolvedTransition = false;
  for (let i = 1; i < recent.length; i++) {
    const prevIds = new Set(fixableOf(recent[i - 1]).map((b) => b.id));
    const currFixable = fixableOf(recent[i]);
    const currIds = new Set(currFixable.map((b) => b.id));
    for (const b of currFixable) {
      if (b.lineage?.kind === "narrowed") {
        anyNarrowed = true;
      }
    }
    const setsEqual = prevIds.size === currIds.size && [...prevIds].every((id) => currIds.has(id));
    if (!setsEqual) {
      anyUnresolvedTransition = true;
    }
  }

  if (anyNarrowed) {
    return { kind: "narrowing" };
  }
  if (!anyUnresolvedTransition) {
    const description = fixableOf(recent[0])[0]?.description ?? "the same blocker";
    return { kind: "unchanged", description };
  }
  return { kind: "shifting" };
}

/** One-sentence, human-facing rendering of {@link ChurnLineageDiagnosisV1},
 * for folding into an escalation reason. */
export function describeChurnLineageDiagnosisV1(diagnosis: ChurnLineageDiagnosisV1): string {
  switch (diagnosis.kind) {
    case "unchanged":
      return (
        `The reviewer has cited the SAME blocker as unresolved every round in this window: ` +
        `"${diagnosis.description}". Consider whether the requirement itself is achievable as written, ` +
        "not just whether another round can fix it."
      );
    case "narrowing":
      return (
        "At least one blocker in this window was declared narrowed by the reviewer, not merely " +
        "unresolved — this is real progress the round count alone cannot see."
      );
    case "shifting":
      return (
        "A different blocker showed up each round in this window rather than the same one persisting " +
        "— this may point to an unstable or under-specified requirement rather than one stuck defect."
      );
    case "insufficient-evidence":
      return (
        "The reviewer did not declare citable lineage for every round in this window, so the cause " +
        `cannot be classified from lineage alone. Per-round task-fixable blockers: ` +
        diagnosis.perRoundSummaries.map((s, i) => `round ${i + 1}: ${s}`).join(" | ")
      );
  }
}

/**
 * Build the full churn-ceiling escalation reason, including the leading
 * sentence that must MATCH the diagnosis rather than unconditionally
 * asserting churn. Only `unchanged` is actually churn; `narrowing` is
 * declared progress the flat round count cannot see, `shifting` points at an
 * unstable requirement rather than one stuck defect, and
 * `insufficient-evidence` means the cause genuinely cannot be told apart yet
 * — labeling any of those three "churning, not converging" is the exact
 * inverted-guidance defect this task exists to fix (see the plan's "The
 * worse case").
 */
export function buildChurnEscalationReasonV1(
  stageDisplayName: string,
  stagnantRounds: number,
  diagnosis: ChurnLineageDiagnosisV1
): string {
  const leadingClause =
    diagnosis.kind === "narrowing"
      ? "The blocker count alone has not fallen, but the reviewer has declared real narrowing " +
        "progress within this window — this is not churn."
      : diagnosis.kind === "shifting"
        ? "A different blocker has come up each round rather than one persisting, which may point " +
          "to an unstable or under-specified requirement rather than simple churn."
        : diagnosis.kind === "insufficient-evidence"
          ? "The blocker count has not fallen, and the reviewer's declared lineage is incomplete for " +
            "this window, so whether this is churn cannot yet be determined from lineage alone."
          : "Automated iteration is churning, not converging.";
  return (
    `${stageDisplayName} has completed ${stagnantRounds} consecutive rounds without reducing the ` +
    "number of task-fixable blockers (churn ceiling, ensemble.resilience.churnCeilingRounds). " +
    `${leadingClause} ` +
    describeChurnLineageDiagnosisV1(diagnosis)
  );
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

/**
 * wf10 item 7c / Part 6 step 16: known provider Read-tool ceilings, in bytes,
 * below which a provider has been observed to silently truncate a prompt
 * file read. kimi-cli's ceiling was measured at 66,192-66,715 bytes across
 * twelve consecutive reads of the same file — a VARYING cap (token-based,
 * not byte-based), so this constant is the lowest observed floor, used only
 * as an advisory trigger, never a hard byte-exact cutoff.
 */
export const KNOWN_PROVIDER_READ_CEILING_BYTES_V1: Readonly<Record<string, number>> = {
  "kimi-cli": 66000,
};

/**
 * Pick the first candidate in an already-ranked chain whose known Read
 * ceiling the prompt does NOT exceed.
 *
 * The advisory below deliberately never refuses a dispatch, because the
 * ceiling is token-based and variable: a prompt under the floor can still
 * truncate and one over it can still land fine. That reasoning is sound for
 * REFUSING, and does not extend to CHOOSING. When the chain already offers a
 * candidate with no known ceiling problem, preferring it costs nothing and
 * risks nothing — the rejected candidate keeps its place for every future
 * round whose prompt fits.
 *
 * Why this exists (jester, 2026-08-28 14:38): a 66,136-byte prompt was
 * dispatched to `kimi-cli`, whose ceiling is 66,000. The advisory fired
 * correctly BEFORE dispatch and was shown as a warning — then the round ran
 * anyway. kimi read a truncated prompt, announced "the file is too large for
 * a single read; I'll page through it in chunks", emitted nothing else, and
 * the 154-byte result was rejected as degenerate — after overwriting the
 * stage's previous accepted review. Every fact needed to avoid that was
 * known before the round started.
 *
 * Returns undefined when nothing better is available: no ranked candidates,
 * the head already fits, or every candidate exceeds its ceiling. Undefined
 * means "change nothing" — the caller dispatches as it would have, keeping
 * the advisory. Pure; no settings or provider I/O.
 */
export function preferCandidateWithinReadCeilingV1(
  rankedStoredIds: readonly string[],
  promptByteLength: number | undefined,
  providerIdOf: (storedModelId: string) => string | undefined
): string | undefined {
  if (promptByteLength === undefined || rankedStoredIds.length === 0) {
    return undefined;
  }
  const exceedsCeiling = (storedModelId: string): boolean => {
    const providerId = providerIdOf(storedModelId);
    if (providerId === undefined) {
      // Unknown provider: no known ceiling, so nothing to avoid. Treated as
      // fitting rather than as suspect — the same fail-open stance the
      // advisory takes for providers absent from the ceiling table.
      return false;
    }
    const ceiling = KNOWN_PROVIDER_READ_CEILING_BYTES_V1[providerId];
    return ceiling !== undefined && promptByteLength > ceiling;
  };
  // The head is what would be dispatched. If it fits, there is nothing to do
  // — never reorder a chain the user configured for any other reason.
  if (!exceedsCeiling(rankedStoredIds[0]!)) {
    return undefined;
  }
  // Cannot return the head: it was just shown to exceed, and `exceedsCeiling`
  // is deterministic per id, so `find` skips it (and any duplicate of it).
  return rankedStoredIds.find((id) => !exceedsCeiling(id));
}

/**
 * Advisory text when an assembled prompt exceeds a provider's known Read
 * ceiling (wf10 item 7c / Part 6 step 16). Never a hard rejection — the
 * ceiling is token-based/variable and the prompt is measured in bytes, so a
 * prompt under the floor can still truncate and one over it can still land
 * fine; this only names the risk and its remedy. Returns undefined when the
 * provider has no known ceiling or the prompt is within it.
 */
export function promptCeilingAdvisoryV1(
  promptLength: number | undefined,
  providerId: string | undefined
): string | undefined {
  if (promptLength === undefined || providerId === undefined) {
    return undefined;
  }
  const ceiling = KNOWN_PROVIDER_READ_CEILING_BYTES_V1[providerId];
  if (ceiling === undefined || promptLength <= ceiling) {
    return undefined;
  }
  return (
    `The assembled prompt (${promptLength} bytes) exceeds ${providerId}'s known Read-tool ceiling ` +
    `(~${ceiling} bytes observed, varies by token count) — it may be silently truncated. Shrink the prompt ` +
    "(fewer/smaller context-pack files) or route this stage to a different provider."
  );
}

/** Reply length above which the provider-exhaustion reply shape (below)
 * never matches — a genuine exhaustion report is short by construction (the
 * observed case was 151 characters); a multi-KB reply that happens to share
 * a phrase is not this shape, whatever else it is. */
const PROVIDER_EXHAUSTION_REPLY_MAX_LENGTH = 4000;

/**
 * Unambiguous procedural markers of the injected budget-handler mechanism
 * itself ("Write your final response now, without any further tool calls…")
 * or of the specific known truncation cause (kimi's Read tool). Either alone
 * is strong enough evidence — there is no plausible genuinely-malformed
 * review that happens to describe the harness's own tool-call cutoff or name
 * "the read tool" alongside "truncat[ing]".
 */
const PROVIDER_EXHAUSTION_PROCEDURAL_PATTERNS: readonly RegExp[] = [
  /without any further tool calls/i,
  /read tool[\s\S]{0,60}truncat/i,
  /truncat[\s\S]{0,60}read tool/i,
];

/**
 * Topic words from the injected question's own two-part prompt ("Cover: the
 * current blocker… what you need from the user to unblock progress"). Each
 * is individually too weak on its own — "current blocker" or "to unblock
 * progress" can plausibly appear in ordinary review prose unrelated to
 * budget exhaustion — so `isProviderExhaustionReplyShapeV1` below requires
 * BOTH a blocker-topic match and a needed-from-user-topic match, matching
 * the injected question's actual two-part shape, rather than any one phrase.
 */
const PROVIDER_EXHAUSTION_BLOCKER_TOPIC_PATTERNS: readonly RegExp[] = [/current blocker/i];
const PROVIDER_EXHAUSTION_NEEDED_TOPIC_PATTERNS: readonly RegExp[] = [
  /what (?:you need|i need|is needed) from (?:the )?user/i,
  /to unblock progress/i,
];

/**
 * Whether a rejected (no parseable `Readiness: N/10`) reply matches the
 * shape of a provider-side read/tool-budget EXHAUSTION REPORT rather than
 * genuine malformed/degenerate output (wf10 item 7c / Part 6 step 16). This
 * distinction matters because the remedy is completely different: malformed
 * output points at the model or a transport glitch, while an exhaustion
 * report is the model correctly answering a question Ensemble never asked,
 * after running out of budget reading an oversized prompt — the actionable
 * fact is prompt size, not model quality.
 *
 * wf10 review fix: matching on ANY single topic phrase (e.g. "current
 * blocker" alone) over-matched ordinary replies that happen to use that
 * phrase for an unrelated reason. Requires either an unambiguous procedural
 * marker, or BOTH halves of the injected question's own blocker-plus-
 * needed-from-user shape — never a lone topic word.
 */
export function isProviderExhaustionReplyShapeV1(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length === 0 || trimmed.length > PROVIDER_EXHAUSTION_REPLY_MAX_LENGTH) {
    return false;
  }
  if (PROVIDER_EXHAUSTION_PROCEDURAL_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return true;
  }
  const hasBlockerTopic = PROVIDER_EXHAUSTION_BLOCKER_TOPIC_PATTERNS.some((pattern) => pattern.test(trimmed));
  const hasNeededTopic = PROVIDER_EXHAUSTION_NEEDED_TOPIC_PATTERNS.some((pattern) => pattern.test(trimmed));
  return hasBlockerTopic && hasNeededTopic;
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
 *
 * "Precedence" governs the RECOMMENDATION, not the truth of the alternative.
 * `"apply-review"` is returned only when the checklist is ALSO complete, so
 * Implementation genuinely has nothing left to do — "will most likely change
 * nothing" is then a true statement. Whenever a task-fixable blocker AND
 * unticked checklist items coexist, `"both"` is returned instead: two
 * genuinely valid actions exist (Apply Review fixes what the review found;
 * Implementation can still land real, queued checklist work Apply Review does
 * not touch), and a caller asserting the second is futile would be asserting
 * something false. Observed 2026-08-21 (wf9 audit item 6): a task carrying 1
 * task-fixable blocker and 77 unticked checklist items was told Implementation
 * "will most likely change nothing" — the newest review's own progress marker
 * showed 76 of those steps still queued and actionable.
 */
/**
 * Human-readable rendering of a task-fixable blocker count that splits out
 * how many were raised by the reviewer itself versus generated mechanically
 * from a failed Verified Check (`ReviewBlockerIdentity.origin`), e.g.
 * `"3 problem(s) (2 reviewer-reported, 1 mechanical)"`. Falls back to a bare
 * count when origin isn't recorded for every task-fixable blocker (older
 * entries predating the field, or a caller that never threaded it through)
 * — the split is only ever shown when it can be stated with certainty,
 * never guessed at. Used everywhere a blocker count reaches the user, so a
 * mechanically generated blocker (wf10 continuation item 12) is never
 * silently indistinguishable from one the reviewer actually found.
 */
export function describeTaskFixableBlockersV1(
  count: number,
  blockers: readonly ReviewBlockerIdentity[] | undefined
): string {
  const label = `${count} problem(s)`;
  const taskFixable = (blockers ?? []).filter((b) => b.resolver === "task-fixable");
  if (taskFixable.length !== count || taskFixable.some((b) => b.origin === undefined)) {
    return label;
  }
  const mechanicalCount = taskFixable.filter((b) => b.origin === "mechanical").length;
  const reviewerCount = taskFixable.filter((b) => b.origin === "reviewer").length;
  return `${label} (${reviewerCount} reviewer-reported, ${mechanicalCount} mechanical)`;
}

export type PostReviewActionV1 = "apply-review" | "implementation" | "both" | "none";

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
  /**
   * Whether a continuation round is currently owed for this task
   * (`TaskProgress.implRecovery` present) — outranks blocker/checklist
   * routing (task "Actionable Hand-offs", "The worse case"). While a
   * continuation is owed, Review/Apply Review/Fast Forward all refuse (a
   * review must not run against edits no round has reported), so
   * recommending "apply-review" here is always wrong: it points at the one
   * set of actions guaranteed to refuse, while withholding the one action
   * that can actually drain the continuation. Optional so every existing
   * caller keeps behaving exactly as before until it is threaded through —
   * `undefined`/`false` is indistinguishable from "no continuation owed".
   */
  continuationOwed?: boolean;
  /**
   * Count of files quarantined behind an owed continuation
   * (`TaskProgress.pendingImplReviewFiles.length`). A non-empty quarantine
   * with no `implRecovery` record would still mean edits are waiting on a
   * round that has not reported them, so this is checked independently of
   * `continuationOwed` rather than folded into it.
   */
  pendingImplReviewFilesCount?: number;
}): PostReviewActionDecisionV1 {
  if (input.continuationOwed === true || (input.pendingImplReviewFilesCount ?? 0) > 0) {
    return {
      action: "implementation",
      reason:
        "A continuation round is owed for this task — a prior round's edits have not yet been reported. " +
        "Review, Apply Review, and Fast Forward will all refuse until it is drained. Implementation is the " +
        "only action that can claim and complete it.",
    };
  }
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
  // STAGE_DISPLAY_NAMES already ends in "Review" for every review stage
  // ("Low-Level Code Review"), so nothing below appends the word again — that
  // read as "the Low-Level Code Review review found…" in a user-facing dialog.
  const stageName = latest ? STAGE_DISPLAY_NAMES[latest.stage] : "code review";
  // No review for these stages yet — the checklist is the only signal there
  // is, and Implementation is the action that reads it.
  if (!latest) {
    return input.hasUntickedChecklistItems
      ? {
          action: "implementation",
          reason: `No ${stageName} has run yet; the plan checklist still has unticked items.`,
        }
      : {
          action: "none",
          reason: `No ${stageName} has run yet and the plan checklist is complete.`,
        };
  }
  if (latest.taskFixableCount > 0) {
    if (input.hasUntickedChecklistItems) {
      // Two genuinely valid actions (module doc comment above): recommend
      // Apply Review first, per the module's own precedence rule, but never
      // claim Implementation would change nothing — real, queued checklist
      // work is exactly what it would act on.
      return {
        action: "both",
        reviewStage: latest.stage,
        reason:
          `The ${stageName} found ${describeTaskFixableBlockersV1(latest.taskFixableCount, latest.blockers)} ` +
          "in the code that still need fixing, and the plan checklist still has unticked items. Both are " +
          "valid here: Apply Review can fix the problems the review found (Implementation cannot see them " +
          "— it only reads the plan checklist), and Implementation can still make progress on the unticked " +
          "checklist items.",
      };
    }
    return {
      action: "apply-review",
      reviewStage: latest.stage,
      // Plain language on purpose: this string is shown to the user in a
      // dialog they have to act on, and "task-fixable blockers are not
      // rendered into the implementation prompt" is a sentence that describes
      // the mechanism perfectly and tells nobody what to click.
      reason:
        `The ${stageName} found ${describeTaskFixableBlockersV1(latest.taskFixableCount, latest.blockers)} ` +
        "in the code that still need fixing. Implementation works only from the plan checklist, so it " +
        "cannot fix them — Apply Review can.",
    };
  }
  if (input.hasUntickedChecklistItems) {
    return {
      action: "implementation",
      reviewStage: latest.stage,
      reason: `The newest ${stageName} reports no task-fixable blockers; unticked checklist items remain.`,
    };
  }
  return {
    action: "none",
    reviewStage: latest.stage,
    reason: `The newest ${stageName} reports no task-fixable blockers and the plan checklist is complete.`,
  };
}

/** What an automatic (unattended) Implementation dispatch should actually do,
 * given `decidePostReviewActionV1`'s verdict. */
export type AutomaticImplementationDispatchV1 =
  | { readonly kind: "run-implementation" }
  | {
      /**
       * Redirect to Apply Review instead of running a checklist-driven
       * Implementation round — `decision.action` is `"apply-review"` or
       * `"both"`, so Implementation is either structurally unable to fix
       * what the review found, or is one of two valid actions where Apply
       * Review takes precedence (module doc comment above `decidePostReviewActionV1`).
       */
      readonly kind: "redirect-apply-review";
      readonly reviewStage: TaskStage;
      readonly reason: string;
    };

/**
 * wf10 continuation item 17: the manual pre-run routing check
 * (`decidePostReviewActionV1` above) has always been computed on the
 * automatic path too, but automation dispatches only ever POSTED it as a
 * decision card for a human to read — the human path is not there, so the
 * card is skipped, and the round fell through to run Implementation
 * regardless of what the decision said. Observed: ten consecutive automatic
 * `# Implementation Run` rounds against a `[same:…]` blocker frozen at
 * score 6, none of them able to touch it, because Implementation only reads
 * the plan checklist.
 *
 * This is the missing other half: what the AUTOMATIC path should do with the
 * same verdict, with no human to ask. `isAutomationDispatch: false` (a
 * manual run) always runs Implementation here — the decision card handles
 * manual routing on its own, this function must not second-guess a human who
 * already chose to press "Implementation". `continuationOwed: true` also
 * always runs Implementation — draining an owed continuation outranks
 * everything (see `continuationOwed` on `decidePostReviewActionV1`'s input;
 * Review/Apply Review both refuse while a continuation is owed, so a
 * redirect here would just fail).
 */
export function chooseAutomaticImplementationDispatchV1(input: {
  readonly decision: PostReviewActionDecisionV1;
  readonly isAutomationDispatch: boolean;
  readonly continuationOwed: boolean;
}): AutomaticImplementationDispatchV1 {
  if (
    !input.isAutomationDispatch ||
    input.continuationOwed ||
    input.decision.reviewStage === undefined ||
    (input.decision.action !== "apply-review" && input.decision.action !== "both")
  ) {
    return { kind: "run-implementation" };
  }
  return {
    kind: "redirect-apply-review",
    reviewStage: input.decision.reviewStage,
    reason: input.decision.reason,
  };
}

