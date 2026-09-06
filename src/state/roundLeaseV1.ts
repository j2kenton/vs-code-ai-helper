import { getExtensionContextV1 } from "../utils/extensionContextV1";

/**
 * A1's watchdog (1.0.0 gate), architectural blocker follow-up, 2026-09-04
 * review: `roundLedgerReconciliationV1.ts`'s `isRoundLedgerRowProtectedV1`
 * falls back to the process-local `taskOperations` registry
 * (`hasLiveOperation`/`hasLiveSchedulingIntent`) for a round-ledger row that
 * carries neither `operationId` nor `intentId` — a CLI-resolved
 * implementation round, which never enters the coordinator and so never
 * acquires either identity (see `roundLedgerV1.ts`'s own "Residual gap" doc
 * comment). That registry is this window's own in-memory state: a CLI round
 * genuinely running in a DIFFERENT VS Code window is invisible to it, so
 * reconciliation could close that row as orphaned — and the watchdog then
 * pause the task — while the round is, in fact, still live elsewhere.
 *
 * This module closes that gap with the same durable-Memento pattern
 * `schedulingIntentV1.ts` already uses for auto-dispatched rounds
 * (`context.workspaceState`, shared on disk across every window open on this
 * workspace, unlike `taskOperations`) — but as its OWN namespace, not by
 * reusing `SchedulingIntentStoreV1`: that store's entries drive posture text,
 * chat announcements, and retry semantics for the AUTOMATION chokepoint, none
 * of which apply to a manually-dispatched round, and stamping a fake
 * "scheduled"/"running" automation entry onto one would risk misdescribing it
 * in the UI. This is a narrower, purpose-built liveness beacon: one entry per
 * live CLI round, keyed by the round's own `roundId` (`claimImplementationRoundLedgerV1`'s
 * `implRoundId`), written once at dispatch start with an expiry far past the
 * longest a round can legitimately run, and cleared once the round ends.
 *
 * A single long-TTL write (no periodic heartbeat) is deliberate: the CLI
 * timeout ceiling is well-known (60 minutes) and fixed for the round's whole
 * life, so one expiry set at start is exactly as accurate as a renewed one
 * would be, without an interval timer to leak or clean up on a crash/dispose.
 * `ROUND_LEASE_TTL_MS` mirrors `taskWatchdogV1.ts`'s `STALE_DISPATCH_GRACE_MS`
 * (90 minutes — the same margin already established there over the 60-minute
 * CLI ceiling) so a live round is never mistaken for stale by a stricter
 * margin than the rest of A1 already uses.
 *
 * Best-effort throughout, mirroring `schedulingIntentV1.ts`'s own contract:
 * every write swallows its own failure internally (never throws), and a
 * missing/unreadable store reads as "no live lease". Most callers have
 * `hasLiveOperation`/`hasLiveSchedulingIntent` as a further fallback, so
 * failing closed here only narrows protection back to the pre-existing
 * behavior for them, never removes it — those callers may ignore
 * `markRoundLiveV1`'s return value.
 *
 * 2026-09-06 review follow-up (A1 architectural blocker, narrowed a third
 * time): a review round is different from those callers. Its round-ledger
 * row can end up with NEITHER an `operationId`/`intentId` match (a
 * CLI-resolved dispatch never acquires one) NOR a live in-process operation
 * if it is running in another window — this lease is its ONLY liveness
 * evidence. `markRoundLiveV1` therefore now RETURNS whether the write
 * actually persisted, so a caller with no other fallback
 * (`claimReviewAttemptWithLiveLeaseV1` in `reviewActions.ts`) can at least
 * LOG that the row it is about to open has no liveness evidence behind it,
 * rather than staying silent about the gap. It does NOT refuse the claim on
 * this signal: a prior revision did, and running the full test suite showed
 * many production call paths (and their tests) legitimately reach this point
 * with no `ExtensionContext` installed, so refusing turned a diagnostic gap
 * into a hard failure of ordinary review dispatch.
 */

const ROUND_LEASE_KEY = "ensemble.roundLeaseV1";
export const ROUND_LEASE_TTL_MS = 90 * 60 * 1000;

interface RoundLeaseEntryV1 {
  readonly roundId: string;
  readonly expiresAt: number;
}

function readAllLeases(): Record<string, RoundLeaseEntryV1> {
  const state = getExtensionContextV1()?.workspaceState;
  if (!state) {
    return {};
  }
  return state.get<Record<string, RoundLeaseEntryV1>>(ROUND_LEASE_KEY, {});
}

/** Mark `roundId` as a live round for `ROUND_LEASE_TTL_MS` from now. Call once
 * at the start of a CLI-resolved round's dispatch. Never throws — a store
 * failure never blocks the round it is meant to protect — but returns
 * whether the lease actually persisted, so a caller with no other liveness
 * fallback can tell "protected" from "not protected" rather than assuming
 * the former. `false` covers both "no extension context available" and "the
 * workspaceState write itself failed". */
export async function markRoundLiveV1(roundId: string): Promise<boolean> {
  const state = getExtensionContextV1()?.workspaceState;
  if (!state) {
    return false;
  }
  try {
    const map = readAllLeases();
    map[roundId] = { roundId, expiresAt: Date.now() + ROUND_LEASE_TTL_MS };
    await state.update(ROUND_LEASE_KEY, map);
    return true;
  } catch {
    // Best-effort — reconciliation's task-wide fallback still protects a
    // same-window round even without this entry.
    return false;
  }
}

/** Clear `roundId`'s lease once its round has ended (success, failure, or
 * cancellation alike) — called from the dispatcher's own `finally`, so a
 * cleared round never lingers as "live" for the rest of its TTL. Best-effort:
 * a failure here just leaves a harmless entry that expires on its own. */
export async function clearRoundLiveV1(roundId: string): Promise<void> {
  const state = getExtensionContextV1()?.workspaceState;
  if (!state) {
    return;
  }
  try {
    const map = readAllLeases();
    if (roundId in map) {
      delete map[roundId];
      await state.update(ROUND_LEASE_KEY, map);
    }
  } catch {
    // Best-effort, same reasoning as markRoundLiveV1.
  }
}

/** Run `fn` while `roundId` is marked live, clearing the lease afterward
 * regardless of outcome (success, throw, or cancellation) — the single call
 * site a CLI-resolved round's dispatcher wraps its actual work in. Kept as
 * its own top-level helper (rather than an inline `try`/`finally` at the
 * call site) so the call site's own dispatch `try` block — the one
 * `reviewActionsStageActivity.test.ts` locates textually via `source.indexOf`
 * to verify "running" is reported before any `await` — stays the FIRST `try`
 * after that function's start; a second, earlier `try` inlined at the call
 * site would shadow it and break that check.
 *
 * Deliberately does NOT `await` `markRoundLiveV1`/`clearRoundLiveV1` — fired
 * and left to settle on their own. This is a stronger requirement than the
 * usual "best-effort" contract: a REJECTED write is already harmless (caught
 * and swallowed inside each function), but an update call that never SETTLES
 * at all (a misbehaving `Memento`, a stalled extension-host write) must not
 * be able to block the round it exists to protect — `await`ing it here would
 * turn a liveness *beacon* into a liveness *dependency*, exactly the silent-
 * stall shape A1 exists to eliminate. The lease's 90-minute TTL makes the
 * resulting race (dispatch begins microtasks before the lease write lands)
 * immaterial: reconciliation sweeps run every few minutes, never inside that
 * window. */
export async function withRoundLeaseV1<T>(
  roundId: string,
  // `Thenable`, not `Promise`: `vscode.window.withProgress` (this helper's
  // only production caller) returns the former, which lacks `.finally`.
  fn: () => Thenable<T>
): Promise<T> {
  void markRoundLiveV1(roundId);
  try {
    return await fn();
  } finally {
    void clearRoundLiveV1(roundId);
  }
}

/** Every `roundId` with a currently-unexpired lease, across every task in
 * this workspace — reconciliation checks a specific row's own `roundId`
 * against this, so a single workspace-wide list is safe to compute once per
 * sweep and reuse for every task (`roundId`s are minted unique per round). */
export function listLiveRoundLeaseIdsV1(now: number = Date.now()): readonly string[] {
  const map = readAllLeases();
  return Object.values(map)
    .filter((entry) => entry.expiresAt > now)
    .map((entry) => entry.roundId);
}
