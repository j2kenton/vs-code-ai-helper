/**
 * wf10 item 7d / Part 5 step 15: a rejected degenerate/unparseable review
 * round is a candidate failure for backup-selection purposes, even though
 * the RUNNER itself succeeded (it returned text; only the parser found
 * nothing usable) — so it is invisible to `switch-to-backup`'s existing
 * runner-level failure handling. This module decides, from durable state
 * alone, what should happen next: automatically advance to the next
 * configured backup, offer it as a one-click manual retry, or report the
 * chain exhausted.
 */
import { FallbackStrategy } from "./modelFallback";
import { RoundOutcomeEntryV1, TaskStage } from "../types/taskProgress";

export type DegenerateReviewBackupAdvanceDecisionV1 =
  | { kind: "advance"; nextModelId: string }
  | { kind: "manual"; nextModelId: string }
  | { kind: "exhausted" };

/**
 * The stored model ids already tried and rejected as degenerate THIS
 * episode, most recent first is not required — order doesn't matter to the
 * caller, only membership does. An "episode" is the unbroken trailing run of
 * `rejected-degenerate` entries for `stage` at the end of `roundOutcomes` —
 * a non-degenerate entry for the same stage (an `edits-produced`/
 * `genuine-no-op` implementation round) ends it, so a candidate that failed
 * degenerate long ago but has since been superseded by a real review round is
 * eligible to be tried again in a LATER episode.
 *
 * wf10 review fix (Part 5 step 15): a successfully SCORED review never
 * appends a `roundOutcomes` entry at all (only `rejected-degenerate` rounds
 * do — see `RoundOutcomeClassificationV1`), so the "a real score ends it"
 * half of the claim above was never actually enforced: with no intervening
 * roundOutcomes entry, the trailing-run scan could walk straight past a
 * successful review into a much older episode's rejections, wrongly
 * expanding `tried` (and wrongly permanently excluding a candidate) even
 * though that candidate hasn't failed once in the CURRENT episode.
 * `latestScoredReviewAt`, when given, is the newest `reviewScoreHistory`
 * entry's `at` for this stage — the scan stops (episode boundary) at the
 * first entry at or before that timestamp, so only rejections strictly after
 * the last successful score for this stage count.
 */
export function computeDegenerateReviewEpisodeModelIdsV1(
  roundOutcomes: readonly RoundOutcomeEntryV1[] | undefined,
  stage: TaskStage,
  latestScoredReviewAt?: string
): string[] {
  const forStage = (roundOutcomes ?? []).filter((entry) => entry.stage === stage);
  const tried: string[] = [];
  for (let i = forStage.length - 1; i >= 0; i--) {
    const entry = forStage[i]!;
    if (entry.classification !== "rejected-degenerate") {
      break;
    }
    if (latestScoredReviewAt !== undefined && entry.at <= latestScoredReviewAt) {
      break;
    }
    if (entry.modelId) {
      tried.push(entry.modelId);
    }
  }
  return tried;
}

/**
 * `chainBackups` should already be skip-filtered and provider-enabled-
 * filtered (`getConfiguredBackupModelsForStage`'s own output) — this
 * function only decides ORDER-preserving selection among what it is given,
 * it does not re-derive eligibility itself.
 */
export function decideDegenerateReviewBackupAdvanceV1(input: {
  chainBackups: readonly string[];
  strategy: FallbackStrategy | undefined;
  /** The stored model id THIS just-rejected round ran with. */
  currentModelId: string | undefined;
  /** `computeDegenerateReviewEpisodeModelIdsV1`'s output — already-tried candidates this episode. */
  episodeTriedModelIds: readonly string[];
}): DegenerateReviewBackupAdvanceDecisionV1 {
  const tried = new Set(input.episodeTriedModelIds);
  if (input.currentModelId) {
    tried.add(input.currentModelId);
  }
  const next = input.chainBackups.find((candidate) => !tried.has(candidate));
  if (!next) {
    return { kind: "exhausted" };
  }
  // Only genuinely automatic when the user has actually opted into
  // switch-to-backup for this stage — a user on "pause-and-resume" or
  // "alert-and-wait" made a deliberate choice not to have Ensemble silently
  // change which model runs; a degenerate-content rejection is not a reason
  // to override that, even though a runner-level failure wouldn't either.
  return input.strategy === "switch-to-backup"
    ? { kind: "advance", nextModelId: next }
    : { kind: "manual", nextModelId: next };
}
