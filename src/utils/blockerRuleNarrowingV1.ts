/**
 * review2 Step 33 (bugs6 item 36): spots a blocker whose fixes keep closing one path and missing the next, the sign that
 * the plan never stated the rule the model keeps guessing. A blocker lineage (`[same:<id>]` / `[narrowed:<id>]`) that
 * survives two Apply Reviews, each of which changed files for it, is "narrowing". The plateau card then offers
 * "Settle it with a rule".
 *
 * Pure: it reads the review history and the round ledger it is given.
 */
import type { ReviewScoreHistoryEntry, RoundLedgerEntryV1, TaskStage } from "../types/taskProgress";

/** How many fixing Apply Reviews a lineage must survive before the rule may be missing. */
export const NARROWING_FIXES_BEFORE_RULE_V1 = 2;

export interface NarrowedBlockerV1 {
  /** The blocker's stable lineage id. */
  readonly blockerId: string;
  /** The blocker's description from the latest review, for the card and the recorded rule. */
  readonly description: string;
  /** How many Apply Reviews that changed files ran between reviews that both listed the blocker. */
  readonly fixes: number;
}

function appliedFilesBetweenV1(ledger: readonly RoundLedgerEntryV1[], stage: TaskStage, from: string, to: string): boolean {
  return ledger.some((row) => {
    if (row.mode !== "apply-review" || row.state !== "completed" || row.stage !== stage) return false;
    const ended = row.endedAt ?? row.startedAt;
    if (ended < from || ended > to) return false;
    return (row.outcome?.filesChanged?.length ?? 0) > 0 || row.outcome?.filesChangedUnknown === true;
  });
}

/**
 * The first blocker of the latest review (in its own order) whose lineage survived at least
 * {@link NARROWING_FIXES_BEFORE_RULE_V1} file-changing Apply Reviews, or undefined. A blocker counts once per pair of
 * consecutive reviews: the earlier lists its id, the later lists the same id declared `same` or `narrowed`, and an
 * Apply Review that changed files ended between the two. Reviews alone never count (bugs6 item 9).
 */
export function detectNarrowedBlockerV1(input: {
  readonly stage: TaskStage;
  readonly history: readonly ReviewScoreHistoryEntry[];
  readonly ledger: readonly RoundLedgerEntryV1[] | undefined;
}): NarrowedBlockerV1 | undefined {
  const reviews = input.history
    .filter((entry) => entry.stage === input.stage && entry.blockers !== undefined)
    .slice()
    .sort((a, b) => a.at.localeCompare(b.at));
  const latest = reviews[reviews.length - 1];
  if (!latest?.blockers || reviews.length < NARROWING_FIXES_BEFORE_RULE_V1 + 1) return undefined;
  const ledger = input.ledger ?? [];
  for (const blocker of latest.blockers) {
    if (!blocker.id) continue;
    let fixes = 0;
    for (let i = reviews.length - 1; i > 0; i--) {
      const later = reviews[i];
      const earlier = reviews[i - 1];
      const inLater = later?.blockers?.find((b) => b.id === blocker.id);
      const inEarlier = earlier?.blockers?.find((b) => b.id === blocker.id);
      if (!later || !earlier || !inLater || !inEarlier) break;
      const declared = inLater.lineage?.kind;
      if (declared !== "same" && declared !== "narrowed") break;
      if (appliedFilesBetweenV1(ledger, input.stage, earlier.at, later.at)) fixes += 1;
    }
    if (fixes >= NARROWING_FIXES_BEFORE_RULE_V1) {
      return {
        blockerId: blocker.id,
        description: (blocker.description ?? blocker.subject).replace(/\s+/g, " ").trim(),
        fixes,
      };
    }
  }
  return undefined;
}
