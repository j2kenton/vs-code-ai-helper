/**
 * wf10 item 3 / item 6b / Part 5 step 13-14: a fallback-provider-specific
 * circuit breaker, distinct from the task-wide no-progress breaker
 * (`shouldTripNoProgressBreaker`, reviewRouting.ts). That breaker counts
 * consecutive zero-file rounds across the WHOLE task regardless of which
 * candidate produced them; this one is keyed to one candidate's provider
 * path (its stored model id) so a known-broken fallback is named and can be
 * excluded, rather than waiting for the broader breaker to also trip after
 * more rounds burned on the same wall.
 *
 * Both helpers below read `TaskProgress.roundOutcomes` (wf10 item 4 / Part 4)
 * — the first consumer of that field for a decision, per the Part 4 doc
 * comment's own forward reference ("Part 5's fallback breaker reads this
 * classification alongside `provider-failure-empty` implementation rounds").
 */
import { RoundOutcomeEntryV1, TaskStage } from "../types/taskProgress";

/**
 * Whether the most recent `lookback` `roundOutcomes` entries for
 * (`stage`, `modelId`), bounded to the CURRENT fallback episode, all
 * classify as `provider-failure-empty`. An episode is the unbroken trailing
 * run of entries for `stage` whose `modelId` is exactly the candidate being
 * checked — scanning backward from the newest entry, the FIRST entry
 * belonging to any OTHER candidate (the primary succeeding, or a different
 * configured backup being tried) ends the episode and the scan stops there,
 * so an older episode's failures against this same candidate — from long
 * before the primary most recently ran, or before a different backup was
 * tried — can never be stitched onto a fresh episode's count. Fewer than
 * `lookback` matching entries within the current episode never trips —
 * there is not yet enough evidence against this specific candidate THIS
 * episode.
 *
 * wf10 review fix: the prior version filtered by (stage, modelId) FIRST,
 * then took the trailing N of that filtered list — which silently skipped
 * over (rather than stopped at) any intervening round for a different
 * candidate, so an old episode's failures against this modelId could still
 * be walked into and counted alongside a brand-new episode's first failure.
 */
export function candidateHasRecentZeroFileFailuresV1(
  roundOutcomes: readonly RoundOutcomeEntryV1[] | undefined,
  stage: TaskStage,
  modelId: string,
  lookback: number,
  /**
   * wf10 review fix (Part 5 steps 13-14, narrowed blocker 1): candidate
   * identity is the full provider path (provider id + model id), not
   * `modelId` alone — passing this makes the episode scan also require the
   * entry's recorded `providerId` to match, so a round dispatched through a
   * DIFFERENT provider path cannot extend (or falsely satisfy) this
   * candidate's health window even if it happens to share a model id
   * string. An entry written before `providerId` existed never matches once
   * a `providerId` is supplied here — same "unknown candidate, never a
   * match" doctrine as an absent `modelId`. Omitted entirely, this matches
   * by `modelId` alone (legacy behavior, still used by call sites/tests
   * that have no provider identity to supply).
   */
  providerId?: string
): boolean {
  if (lookback <= 0 || !modelId) {
    return false;
  }
  const forStage = (roundOutcomes ?? []).filter((entry) => entry.stage === stage);
  const episodeTail: RoundOutcomeEntryV1[] = [];
  for (let i = forStage.length - 1; i >= 0; i--) {
    const entry = forStage[i]!;
    if (entry.modelId !== modelId) {
      break;
    }
    if (providerId !== undefined && entry.providerId !== providerId) {
      break;
    }
    episodeTail.push(entry);
    if (episodeTail.length >= lookback) {
      break;
    }
  }
  return (
    episodeTail.length >= lookback &&
    episodeTail.every((entry) => entry.classification === "provider-failure-empty")
  );
}

export interface FallbackProviderBreakerInputV1 {
  readonly roundOutcomes: readonly RoundOutcomeEntryV1[] | undefined;
  readonly stage: TaskStage;
  /** The model id THIS round just ran with. */
  readonly modelId: string | undefined;
  /**
   * The runner id (`runnerId`) THIS round just ran with, when known — see
   * `candidateHasRecentZeroFileFailuresV1`'s own `providerId` parameter.
   * Optional so a caller with no provider identity available still gets the
   * legacy modelId-only match rather than failing to trip at all.
   */
  readonly providerId?: string;
  /** Whether this round's dispatch used the stage's active fallback
   * reservation (`TaskProgress.fallbackActive[stage]`), not the primary. The
   * breaker only ever targets a fallback candidate — a struggling PRIMARY is
   * already the task-wide no-progress breaker's job, and tripping this one
   * on a primary would misname the remedy ("switch the stage model") when
   * the primary already IS the configured model. */
  readonly fallbackActive: boolean;
  /** ensemble.resilience.fallbackProviderBreakerRounds (0 = off). */
  readonly breakerRounds: number;
}

/**
 * Trip when a stage's ACTIVE FALLBACK candidate has produced
 * `breakerRounds` consecutive `provider-failure-empty` rounds. Never trips
 * for a round that ran on the primary (`fallbackActive` false) or when the
 * flag is off (`breakerRounds <= 0`).
 */
export function shouldTripFallbackProviderBreakerV1(input: FallbackProviderBreakerInputV1): boolean {
  if (!input.fallbackActive || !input.modelId) {
    return false;
  }
  return candidateHasRecentZeroFileFailuresV1(
    input.roundOutcomes,
    input.stage,
    input.modelId,
    input.breakerRounds,
    input.providerId
  );
}
