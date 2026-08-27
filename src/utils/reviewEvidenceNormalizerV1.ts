import { BlockerSupersessionRecordV1, TaskStage } from "../types/taskProgress";
import { ReviewBlocker, ReviewProgress, parseReviewProgress } from "./reviewReadiness";
import { headingsV1, walkLinesV1 } from "./markdownStructure";

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
  if (!supersessions || supersessions.length === 0) {
    return [...blockers];
  }
  const superseded = new Set(
    supersessions
      .filter((entry) => {
        if (entry.stage !== stage) {
          return false;
        }
        // wf10 continuation item 18: a `"plan-non-goal"` record is a
        // standing decision about the blocker's SUBJECT (the plan of record
        // declares it out of scope), not a statement about one now-stale
        // review artifact — unlike `"chat-confirmed"` below, it applies even
        // to content produced THIS invocation (`reviewAsOfMs === undefined`).
        // Safe to do unconditionally: the ONLY production caller that derives
        // a plan-non-goal record (`derivePlanNonGoalSupersessionsV1`) does so
        // from a match against THIS SAME round's blockers, so a record never
        // exists here before the round it would suppress.
        if ((entry.source ?? "chat-confirmed") === "plan-non-goal") {
          return true;
        }
        // `"chat-confirmed"` (the default/absent case): only suppresses
        // content that demonstrably PREDATES the resolution — see the
        // doc comment above for why fresh review content must never be
        // filtered by it.
        return reviewAsOfMs !== undefined && new Date(entry.supersededAt).getTime() > reviewAsOfMs;
      })
      .map((entry) => entry.blockerDescription.trim())
  );
  if (superseded.size === 0) {
    return [...blockers];
  }
  return blockers.filter((blocker) => !superseded.has(blocker.description.trim()));
}

/** One entry parsed from `plan-final.md`'s `## Accepted Non-Goals` section —
 * see `parseAcceptedNonGoalsV1`. */
export interface PlanNonGoalEntryV1 {
  /** The entry's own sub-heading, or the `## Accepted Non-Goals` heading
   * itself when the section has no sub-headings (a single flat write-up). */
  readonly heading: string;
  /** The entry's body text, used only for matching — never rendered. */
  readonly bodyText: string;
}

/**
 * Parse `plan-final.md`'s `## Accepted Non-Goals` section (wf10 continuation
 * item 18) into one entry per sub-heading, or one entry for the whole section
 * when it has none. Returns `[]` when the section is absent or empty — most
 * plans, and every plan predating this feature.
 */
export function parseAcceptedNonGoalsV1(planContent: string): PlanNonGoalEntryV1[] {
  const all = headingsV1(planContent);
  const topIndex = all.findIndex((h) => h.title.trim().toLowerCase() === "accepted non-goals");
  if (topIndex === -1) {
    return [];
  }
  const top = all[topIndex]!;
  const lines = walkLinesV1(planContent);
  let sectionEnd = lines.length;
  for (let i = topIndex + 1; i < all.length; i++) {
    if (all[i]!.level <= top.level) {
      sectionEnd = all[i]!.line;
      break;
    }
  }
  const subHeadings = all
    .map((h, idx) => ({ h, idx }))
    .filter(({ h, idx }) => idx > topIndex && h.line < sectionEnd && h.level > top.level);
  const bodyBetween = (startLine: number, endLine: number): string =>
    lines
      .slice(startLine, endLine)
      .map((l) => l.text)
      .join("\n")
      .trim();
  if (subHeadings.length === 0) {
    const bodyText = bodyBetween(top.line + 1, sectionEnd);
    return bodyText ? [{ heading: top.title, bodyText }] : [];
  }
  const entries: PlanNonGoalEntryV1[] = [];
  for (let i = 0; i < subHeadings.length; i++) {
    const current = subHeadings[i]!;
    let end = sectionEnd;
    for (let j = current.idx + 1; j < all.length; j++) {
      if (all[j]!.level <= current.h.level) {
        end = all[j]!.line;
        break;
      }
    }
    const bodyText = bodyBetween(current.h.line + 1, end);
    if (bodyText) {
      entries.push({ heading: current.h.title, bodyText });
    }
  }
  return entries;
}

/**
 * Normalize for the same "verbatim discipline" `filterSupersededBlockersV1`
 * already applies to `chat-confirmed` supersessions (exact match on trimmed
 * text): lower-case, strip markdown decoration (`` ` ``, `*`, `_`, `>`, `#`)
 * that a plan write-up might wrap a quoted blocker in, and collapse
 * whitespace. NOT a fuzzy/word-bag normalization — this changes nothing about
 * which words are present, only case/markup/spacing, so the result is still a
 * verbatim comparison of the same text.
 */
function normalizeForVerbatimNonGoalMatchV1(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_>#]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** One blocker matched against an Accepted Non-Goals entry describing the
 * same subject. */
export interface PlanNonGoalMatchV1 {
  readonly blocker: ReviewBlocker;
  readonly nonGoalHeading: string;
}

/**
 * Match each of `blockers` against `nonGoals`. A blocker matches an entry
 * only when the blocker's own (normalized) description text appears VERBATIM
 * inside that entry's (normalized) body — the same discipline
 * `filterSupersededBlockersV1` already applies to `chat-confirmed`
 * supersessions (exact text match), not a word-overlap/fuzzy score. This is
 * deliberate (review blocker, 2026-08-26: "plan non-goal supersession uses an
 * unapproved fuzzy matcher that can suppress unrelated live blockers") — a
 * threshold-based similarity score can suppress a genuinely different,
 * still-live blocker that happens to share enough generic vocabulary with an
 * unrelated non-goal write-up. Verbatim containment cannot: it requires the
 * plan author to have actually cited the blocker's own wording (typically by
 * quoting a standing `[same:…]` blocker's already-known text when writing the
 * non-goal entry), so a match is proof the entry is about THIS blocker, not
 * merely a topically similar one. The cost, stated in the plan's own risk
 * notes, is accepted: "a reworded re-finding stops matching and is reported
 * again — which is the intended way a reviewer's genuine new reason
 * surfaces." Pure. Callers that persist a match
 * (`derivePlanNonGoalSupersessionsV1`) always also record it as a visible
 * `reviewerChallengedNonGoal` fact rather than silently trusting it forever.
 */
export function matchBlockersAgainstNonGoalsV1(
  blockers: readonly ReviewBlocker[],
  nonGoals: readonly PlanNonGoalEntryV1[]
): PlanNonGoalMatchV1[] {
  if (nonGoals.length === 0) {
    return [];
  }
  const matches: PlanNonGoalMatchV1[] = [];
  for (const blocker of blockers) {
    const normalizedBlocker = normalizeForVerbatimNonGoalMatchV1(blocker.description);
    if (!normalizedBlocker) {
      continue;
    }
    for (const entry of nonGoals) {
      const normalizedEntry = normalizeForVerbatimNonGoalMatchV1(entry.bodyText);
      if (normalizedEntry.includes(normalizedBlocker)) {
        matches.push({ blocker, nonGoalHeading: entry.heading });
        break;
      }
    }
  }
  return matches;
}

/** Result of matching one round's blockers against the plan of record's
 * Accepted Non-Goals section and reconciling against previously-derived
 * supersession records — see `derivePlanNonGoalSupersessionsV1`. */
export interface PlanNonGoalSupersessionResultV1 {
  /** `blockers` with every matched blocker removed — the set every
   * downstream consumer of this round (history, escalation, notices) should
   * treat as this round's actual outstanding blockers. */
  readonly effectiveBlockers: ReviewBlocker[];
  /** Supersession records not already present in `existingSupersessions`,
   * for the caller to persist alongside this round's other writes. */
  readonly newSupersessions: readonly BlockerSupersessionRecordV1[];
  /** Every match found this round, whether or not it was already known —
   * a review re-raising a blocker the plan already declared out of scope is
   * worth recording every time it happens, not only the first time
   * (`ReviewScoreHistoryEntry.reviewerChallengedNonGoal`). */
  readonly challenged: readonly PlanNonGoalMatchV1[];
}

/**
 * wf10 continuation item 18: "when a review re-raises a blocker the plan
 * declares out of scope, say so" — instead of the blocker silently vanishing
 * (masking a possibly-still-live issue) or silently persisting forever
 * (leaving the plan's decision unenforced). Matches this round's `blockers`
 * against `planContent`'s `## Accepted Non-Goals` section
 * ({@link parseAcceptedNonGoalsV1}, {@link matchBlockersAgainstNonGoalsV1}),
 * derives any supersession records not already in `existingSupersessions`
 * (deduped by exact blocker description within THIS stage), and returns the
 * blocker set with every match removed alongside the full list of matches so
 * the caller can record the disagreement even when it already knew about it.
 *
 * Pure — the caller persists `newSupersessions` and decides what to do with
 * `challenged`.
 */
export function derivePlanNonGoalSupersessionsV1(
  stage: TaskStage,
  blockers: readonly ReviewBlocker[],
  planContent: string,
  existingSupersessions: readonly BlockerSupersessionRecordV1[] | undefined,
  nowIso: string,
  planRelPath = "plan-final.md"
): PlanNonGoalSupersessionResultV1 {
  const nonGoals = parseAcceptedNonGoalsV1(planContent);
  const matches = matchBlockersAgainstNonGoalsV1(blockers, nonGoals);
  if (matches.length === 0) {
    return { effectiveBlockers: [...blockers], newSupersessions: [], challenged: [] };
  }
  const existingDescriptions = new Set(
    (existingSupersessions ?? [])
      .filter((entry) => entry.stage === stage && (entry.source ?? "chat-confirmed") === "plan-non-goal")
      .map((entry) => entry.blockerDescription.trim())
  );
  const newSupersessions: BlockerSupersessionRecordV1[] = [];
  const seenThisRound = new Set<string>();
  for (const match of matches) {
    const description = match.blocker.description.trim();
    if (seenThisRound.has(description)) {
      continue;
    }
    seenThisRound.add(description);
    if (!existingDescriptions.has(description)) {
      newSupersessions.push({
        stage,
        blockerDescription: description,
        supersededAt: nowIso,
        planRelPath,
        source: "plan-non-goal",
      });
    }
  }
  const matchedDescriptions = new Set(matches.map((match) => match.blocker.description.trim()));
  const effectiveBlockers = blockers.filter((blocker) => !matchedDescriptions.has(blocker.description.trim()));
  return { effectiveBlockers, newSupersessions, challenged: matches };
}

/**
 * Render `plan-final.md`'s parsed Accepted Non-Goals entries as the
 * `{{acceptedNonGoals}}` review-prompt variable (wf10 continuation item 18).
 * Always returns non-empty text — an absent section is stated explicitly
 * rather than left as a silently-empty section in the rendered prompt.
 */
export function formatAcceptedNonGoalsVariableV1(nonGoals: readonly PlanNonGoalEntryV1[]): string {
  if (nonGoals.length === 0) {
    return "_No `## Accepted Non-Goals` section is recorded in the plan of record — nothing is declared out of scope for this review._";
  }
  return nonGoals.map((entry) => `### ${entry.heading}\n\n${entry.bodyText}`).join("\n\n");
}

/**
 * Render this stage's standing `blockerSupersessions` (both
 * `"chat-confirmed"` and `"plan-non-goal"`) as the `{{ownerDecisions}}`
 * review-prompt variable (wf10 continuation item 18) — an explicit list of
 * blockers the task owner (or the plan of record) has already resolved,
 * given the same binding weight as the Accepted Non-Goals section. Always
 * returns non-empty text.
 */
export function formatOwnerDecisionsVariableV1(
  stage: TaskStage,
  supersessions: readonly BlockerSupersessionRecordV1[] | undefined
): string {
  const relevant = (supersessions ?? []).filter((entry) => entry.stage === stage);
  if (relevant.length === 0) {
    return "_No standing owner decisions are recorded for this stage._";
  }
  return relevant
    .map((entry) => {
      const kind = (entry.source ?? "chat-confirmed") === "plan-non-goal" ? "plan non-goal" : "chat-confirmed";
      return `- "${entry.blockerDescription}" — resolved (${kind}) on ${entry.supersededAt}`;
    })
    .join("\n");
}
