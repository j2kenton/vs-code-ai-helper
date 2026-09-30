import * as crypto from "node:crypto";
import { normalizePath } from "./taskRoot";

/**
 * Pre-1.0.0 fixes register, Part 3 Step 3: an escalation card's "Advance"
 * option must know, at the moment the card is BUILT, whether the process it
 * is interrupting was a Fast Forward run or a single stage action — "store
 * this on the decision's context" (the plan's own wording), added with no
 * new persisted progress field.
 *
 * `escalateReviewToHuman` pauses the task and posts the card from deep
 * inside `fastForwardReviewWithAI`'s own call stack when Fast Forward is
 * running it — by the time a HUMAN answers the card (seconds or days later),
 * that in-memory call stack is long gone, so the fact has to be captured at
 * escalation time and baked into the option's own dispatch args, not
 * re-derived when the option is later chosen. A plain in-process map
 * keyed by normalized folder path is enough: `fastForwardReviewWithAI` marks
 * its own task folder active for the whole of its own try/finally (which
 * wraps its entire multi-round `improveReviewScore` loop), and clears it
 * unconditionally in that same `finally` — so at any moment while Fast
 * Forward is genuinely mid-run for a task, and only then, a query against
 * this map answers correctly. Nothing here is durable across a window
 * reload; that is fine, because a reload also ends the in-memory Fast
 * Forward loop this is tracking.
 *
 * RC2 item 12: the map now also carries `attemptNumber`/`maxAttempts` — the
 * SAME live iteration counters `fastForwardReviewWithAI`'s own `apply()`
 * callback already tracks in its local closure — so a plateau card raised
 * mid-run (`reviewEscalation.ts`'s "Keep iterating" option) can bake the
 * exact iteration to resume from into its own dispatch args, for the same
 * "capture now, don't re-derive later" reason `resumeFastForward` above
 * already exists for. A plain boolean presence check
 * ({@link isFastForwardRunActiveV1}) is unaffected — it now reads as "this
 * key is present in the map" rather than "this key is in the set".
 */
export interface FastForwardRunStateV1 {
  readonly attemptNumber: number;
  readonly maxAttempts: number;
}

const activeFastForwardRuns = new Map<string, FastForwardRunStateV1>();

/**
 * RC3 item 4, Step 3 completion fix (review-flagged 2026-09-30): a card's
 * captured `FastForwardRunStateV1` alone cannot tell "genuinely still the
 * same run" from "stale — the extension host restarted, or a different run
 * has since started and possibly ended" once the human answers it, because
 * the active-run map itself is deliberately cleared the moment the run
 * finishes (its own doc comment above). `fastForwardSessionId` changes once
 * per process lifetime — a restart always mints a fresh one, so a card that
 * predates a restart never matches it again — and `runEpochs` increments
 * once per NEW run started for a given task folder and is never removed, so
 * a card whose captured epoch no longer equals the current one for that
 * folder means some other run has started (and possibly ended) since. A card
 * that carries both fields unchanged from their value at post time is safe
 * to trust; see {@link isFastForwardResumeStateTrustedV1} in
 * `fastForwardResumeSuffixV1.ts`, the sole consumer of these two getters.
 */
let fastForwardSessionId = crypto.randomUUID();
const runEpochs = new Map<string, number>();

/**
 * RC3 item 4, Step 3 completion fix round 2 (review-flagged 2026-09-30,
 * narrowed blocker `62a487ef-0d12-4476-a39f-abc4016bf4d4-0`): session id and
 * run epoch alone cannot tell "this run paused to raise the very card now
 * being answered" from "this run has since ended for a reason that has
 * nothing to do with that card" (it finished, gave up, or errored) — both
 * leave the epoch untouched, since epoch only increments on a new run
 * START, never on an end. `activeFastForwardRuns` itself can't answer this
 * either: it is deliberately cleared on EVERY exit (paused or not), because
 * card-BUILD-time liveness checks ({@link getFastForwardRunStateV1},
 * {@link isFastForwardRunActiveV1}) need "is a run genuinely, synchronously
 * still executing right now" — true only inside the run's own try/finally —
 * and must stay false the instant that run exits for ANY reason, or a later
 * single (non-Fast-Forward) action on the same folder would wrongly see a
 * stale entry and offer to "resume Fast Forward" for a run nobody asked to
 * continue.
 *
 * This second, separate map answers the DIFFERENT, consumption-time
 * question: "of the runs that have started for this folder, does the most
 * recent one's ending still represent an unresolved pause awaiting exactly
 * this decision?" `fastForwardReviewWithAI` (`reviewActions.ts`) records one
 * of two outcomes into it, in its own `finally`, once it knows why it is
 * exiting: {@link recordFastForwardRunPausedV1} when the loop stopped
 * because `improveReviewScore` reported `paused` (a card was raised and not
 * ridden through), or {@link clearFastForwardRunPausedProvenanceV1} for
 * every other exit (success, stalled, exhausted attempts, a thrown error) —
 * an ending "for an unrelated reason" invalidates any pause this run might
 * otherwise seem to still own. A captured card's provenance is trusted (see
 * `isFastForwardResumeStateTrustedV1` in `fastForwardResumeSuffixV1.ts`)
 * only when this map's current record for the folder still names the EXACT
 * session and epoch the card was built from.
 */
const pausedRunProvenance = new Map<string, { readonly sessionId: string; readonly epoch: number }>();

export function markFastForwardRunActiveV1(
  taskFolderPath: string,
  state: FastForwardRunStateV1 = { attemptNumber: 0, maxAttempts: 0 }
): void {
  const key = normalizePath(taskFolderPath);
  runEpochs.set(key, (runEpochs.get(key) ?? 0) + 1);
  activeFastForwardRuns.set(key, state);
  // A new run starting always supersedes any pause a PRIOR run for this same
  // folder left behind — the bumped epoch above already makes any old card's
  // captured epoch stale, but clearing here too means a stale card is never
  // even momentarily trusted while this fresh run is starting up.
  pausedRunProvenance.delete(key);
}

/**
 * Records that the Fast Forward run currently active for this folder (at the
 * CURRENT session id and run epoch) has ended specifically because it paused
 * to raise a decision card — the card's resume option is trusted only while
 * this record still names that same session and epoch. Called from
 * `fastForwardReviewWithAI`'s own `finally`, exactly once per run, in place
 * of {@link clearFastForwardRunPausedProvenanceV1} when (and only when) the
 * run's own outcome reported `paused: true`.
 */
export function recordFastForwardRunPausedV1(taskFolderPath: string): void {
  const key = normalizePath(taskFolderPath);
  pausedRunProvenance.set(key, { sessionId: fastForwardSessionId, epoch: runEpochs.get(key) ?? 0 });
}

/**
 * Invalidates any pending pause record for this folder — called for every
 * `fastForwardReviewWithAI` exit that is NOT a paused-for-a-card stop
 * (success, stalled, exhausted attempts, a thrown error), so a card raised
 * by an EARLIER pause of the same run generation can never be resumed once
 * that run has gone on to end for an unrelated reason.
 */
export function clearFastForwardRunPausedProvenanceV1(taskFolderPath: string): void {
  pausedRunProvenance.delete(normalizePath(taskFolderPath));
}

/**
 * Whether `taskFolderPath`'s most recent recorded pause still matches the
 * exact session and epoch a card captured at build time — the sole
 * consumer is {@link isFastForwardResumeStateTrustedV1}
 * (`fastForwardResumeSuffixV1.ts`).
 */
export function isFastForwardRunPausedProvenanceCurrentV1(
  taskFolderPath: string,
  sessionId: string,
  epoch: number
): boolean {
  const record = pausedRunProvenance.get(normalizePath(taskFolderPath));
  return record !== undefined && record.sessionId === sessionId && record.epoch === epoch;
}

/**
 * The current session id and run epoch for `taskFolderPath`, for stamping
 * onto a newly built resumable card — shared by every caller that builds a
 * `resumeFastForwardV1` payload (the reconcile card, the reviewer-verified
 * ticks card, and the plateau card's own "Keep iterating" option), so none
 * of them can regress to the untrusted "no provenance at all" shape that
 * made an older persisted card indistinguishable from a legitimate one.
 *
 * Review-flagged completion fix, round 3 (2026-09-30, narrowed blocker
 * "Step 3 records paused-run provenance only after posting the answerable
 * card"): this is also where the pause itself is now recorded
 * ({@link recordFastForwardRunPausedV1}), synchronously, at the exact moment
 * a resumable card is being built — every one of this function's three
 * callers only ever reaches this line while genuinely interrupting an active
 * Fast Forward run to raise exactly this kind of card (escalation's own
 * `updateTaskStatus(..., "paused")` write has already landed by the time it
 * builds the plateau option; the reconcile/ticks cards are built and posted
 * unconditionally once a live `FastForwardRunStateV1` was captured for this
 * folder). Waiting for `fastForwardReviewWithAI`'s own `finally` — which
 * used to be the ONLY place this was recorded — left a real, non-trivial
 * window between "the card is posted and answerable" and "the pause is on
 * record", during which an immediate read or answer (a fast operator, or an
 * automated flow) saw the card downgraded to "try again (one cycle)" even
 * though the run raising it was genuinely still live. Recording it here
 * instead closes that window at its source. The `finally` block's own call
 * is unchanged and still runs later: it is now a harmless, idempotent
 * re-confirmation on the paused-exit path, and remains the sole place that
 * INVALIDATES a pause recorded here when the same run goes on to end for an
 * unrelated reason (success, stall, exhausted attempts, an error).
 */
export function stampFastForwardResumeProvenanceV1(taskFolderPath: string): {
  readonly fastForwardSessionIdV1: string;
  readonly fastForwardRunEpochV1: number;
} {
  recordFastForwardRunPausedV1(taskFolderPath);
  return {
    fastForwardSessionIdV1: getFastForwardSessionIdV1(),
    fastForwardRunEpochV1: getFastForwardRunEpochV1(taskFolderPath),
  };
}

/** The current process-lifetime session id — changes only when this module
 * is freshly loaded (i.e. a window/extension-host restart). */
export function getFastForwardSessionIdV1(): string {
  return fastForwardSessionId;
}

/** How many Fast Forward runs have ever been marked active for this task
 * folder, in this session — `0` if none yet. Never decremented or cleared
 * when a run ends, unlike {@link activeFastForwardRuns} itself, precisely so
 * a later query can tell "no other run has started since" from "the active
 * map is empty because every run, including this one, has ended." */
export function getFastForwardRunEpochV1(taskFolderPath: string): number {
  return runEpochs.get(normalizePath(taskFolderPath)) ?? 0;
}

/** Test-only: simulates a window/extension-host restart — a fresh session id
 * and cleared epoch/active-run state, exactly what a real restart produces
 * (this module being freshly re-loaded). */
export function __resetFastForwardRunsForTestV1(): void {
  activeFastForwardRuns.clear();
  runEpochs.clear();
  pausedRunProvenance.clear();
  fastForwardSessionId = crypto.randomUUID();
}

/**
 * Updates the live iteration counters for an already-marked-active run.
 * A no-op when the folder was never marked active (or was already cleared) —
 * `fastForwardReviewWithAI`'s own `apply()` callback is the only caller, and
 * it only ever runs between that function's own mark/clear pair.
 */
export function updateFastForwardRunStateV1(taskFolderPath: string, state: FastForwardRunStateV1): void {
  const key = normalizePath(taskFolderPath);
  if (activeFastForwardRuns.has(key)) {
    activeFastForwardRuns.set(key, state);
  }
}

export function clearFastForwardRunActiveV1(taskFolderPath: string): void {
  activeFastForwardRuns.delete(normalizePath(taskFolderPath));
}

export function isFastForwardRunActiveV1(taskFolderPath: string): boolean {
  return activeFastForwardRuns.has(normalizePath(taskFolderPath));
}

/** The live iteration counters for an active run, or `undefined` when the
 * folder is not currently marked active. */
export function getFastForwardRunStateV1(taskFolderPath: string): FastForwardRunStateV1 | undefined {
  return activeFastForwardRuns.get(normalizePath(taskFolderPath));
}
