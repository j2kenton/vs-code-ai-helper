import { getExtensionContextV1 } from "../utils/extensionContextV1";
import type { RecordedProcessIdentityV1 } from "./processLivenessClassifierV1";

/**
 * Recorded provider CLI processes, next to a task's admission lock (1.0 RC1,
 * Part B, item 2, "Recording and stopping provider CLI processes" — the
 * first bullet: "Record the pid, start time, provider name, and
 * executable/command line of each provider CLI a round starts, next to the
 * lock").
 *
 * Deliberately its OWN small module, not folded into `roundLeaseV1.ts`: that
 * module's doc comment is specific to a single narrow purpose (a liveness
 * beacon for round-ledger reconciliation) and its own review history
 * documents exactly why it stays that shape. This module answers a different
 * question — "which OS processes did this round start, and are they still
 * running" — needed by the dead-owner cleanup and Cancel paths (not yet
 * wired to this module; see the doc comment on `recordRoundProcessV1`).
 *
 * KEYED BY `taskFolderPath`, the admission lock's own identity
 * (`WorkAdmissionHandleV1.taskFolderPath`, `workAdmissionV1.ts`), AND bound to
 * `claimId` (`WorkAdmissionHandleV1.claimId` — the claim record's own unique
 * id, minted fresh by `acquireWorkAdmissionV1` for every acquisition,
 * independent of any caller-supplied string). A prior revision keyed the
 * "which round owns this record" question by a caller-supplied `roundId`
 * instead: a review caught that nothing proved a given `roundId` was actually
 * a legitimate successor of the lock generation whose processes were on
 * file — an accidental or malformed `roundId` could unconditionally replace
 * another generation's still-relevant record. `claimId` cannot have that
 * problem: it comes from the SAME acquisition that produced the
 * `WorkAdmissionHandleV1` the caller is holding, so "this record's `claimId`
 * matches my handle's `claimId`" is proof, not a caller's claim.
 *
 * NO time-based expiry. A prior version of this module expired entries after
 * `ROUND_LEASE_TTL_MS` (90 min), independently of the lock's own lifetime —
 * a review caught that a long-running round, or a crashed window whose
 * marker is never automatically reclaimed (`workAdmissionV1.ts`'s own
 * documented "interim policy"), could then have its process record vanish
 * out from under a still-live lock, making dead-owner cleanup read "no
 * processes recorded" and treat an unrecorded, possibly still-running CLI as
 * already gone. A record now lives exactly as long as the lock's own
 * bookkeeping keeps it: cleared only by an explicit
 * `clearRoundProcessesForClaimV1` call, made by the cleanup/release path once
 * every recorded process for that exact claim is CONFIRMED gone — never on a
 * timer, and never implicitly superseded by a fresh acquisition recording
 * under a new `claimId` (see the "PER-(TASK, CLAIM) STORAGE KEY" section
 * below for why a new claim no longer touches an old one's record at all).
 *
 * PER-(TASK, CLAIM) STORAGE KEY, not one shared task-level blob. A prior
 * revision stored every task's record in a single `workspaceState` entry
 * (one JSON blob keyed by `taskFolderPath` alone, holding whichever
 * `claimId` last wrote to it) with writes serialized only per
 * `taskFolderPath`. A review caught the cross-task version of this bug (two
 * DIFFERENT tasks racing a shared blob); giving every task its own key fixed
 * that. A SECOND review (2026-09-29, RC2 item 2 / Step 57a) caught the same
 * class of bug one level down, WITHIN a single task: a caller that read
 * "the record on file belongs to claim A" and only later — after awaiting
 * signalling, polling and re-classifying a process, all of which cross
 * multiple turns — cleared "whatever is on file for this task" could lose a
 * race to a SUCCESSOR claim (B) that began recording its own processes in
 * the gap, wiping B's just-written record instead of A's stale one. That
 * gap exists for ANY caller who checks-then-acts across an await, in ANY
 * process — including, worse, a caller running in a DIFFERENT VS Code window
 * than the one that recorded the successor's data, which cannot even see a
 * live update to the other window's in-memory `workspaceState` cache (the
 * same limitation `hostDecisionMirrorV1.ts` documents for pending
 * decisions): no in-process check, however carefully sequenced, can close
 * that gap, because the read and the write are two separate `Memento`
 * operations with no compare-and-swap between them.
 *
 * The fix removes the shared key a stale claim's write could ever hit:
 * every `claimId` gets its OWN `workspaceState` key
 * (`${ROUND_PROCESS_RECORD_KEY_PREFIX}${taskFolderPath}\0${claimId}`, see
 * `storageKeyForClaimV1`). A caller clearing claim A's key can therefore
 * never touch claim B's key, REGARDLESS of which process performs the clear,
 * how stale its cache is, or how long it awaited before calling — there is
 * no read involved in choosing what to delete, so there is nothing for a
 * stale read to get wrong. This is strictly stronger than the per-task
 * partitioning above: recording under a new `claimId` no longer needs to
 * "replace" a prior generation's record either (Step 8's surviving
 * `beginRoundProcessRecordingV1`/`recordRoundProcessV1` behavior lived at the
 * old task-level key; there is no such shared slot to replace or supersede
 * any more). A stale claim's now-orphaned key is harmless bookkeeping left
 * behind until it is itself cleared (normally by its own
 * `clearRoundProcessesForClaimV1` call once its processes are confirmed
 * gone) — never a hazard to any other claim's data.
 *
 * Same underlying persistence choice as `roundLeaseV1.ts`:
 * `context.workspaceState`, backed by a file shared across every window open
 * on this workspace, so a NEW window opened after a crash can still see what
 * a crashed window's round had recorded (a currently-running window's own
 * in-memory cache of a DIFFERENT window's concurrent writes is a separate
 * question — see above — and this module's cross-claim key partitioning
 * does not depend on that cache ever being fresh). Writes for a given
 * `(taskFolderPath, claimId)` pair are still serialized through an
 * in-process queue (mirroring `workAdmissionV1.ts`'s own owner-local queue)
 * so two writes recorded in quick succession for the SAME claim cannot race
 * a read-modify-write and silently drop one another; writes for DIFFERENT
 * claims (even under the same task) now touch disjoint keys and queues, so
 * they never need to wait on each other either.
 *
 * NO-RECORD AMBIGUITY. `listRoundProcessesV1` returning `[]` is ambiguous on
 * its own between "this claim genuinely started no provider CLI" and "a
 * record write failed or never landed before a crash" — a real gap a review
 * identified. `beginRoundProcessRecordingV1` removes the coarsest form of it:
 * persisting an (initially empty) record for `claimId` before any process is
 * spawned means "no record at all, or a record for a DIFFERENT claimId"
 * comes to mean "this claim never even started recording" (safe to treat as
 * no CLI launched under it). That alone still leaves a narrower gap a
 * SECOND review caught: a crash between `cp.spawn()` handing back a pid and
 * the post-spawn `recordRoundProcessV1` append landing would leave
 * `processes` empty too, looking identical to "recording began, nothing
 * spawned yet". `spawnsStarted`/`spawnsAbandoned` close that: a caller
 * durably increments `spawnsStarted` (`beginProcessSpawnAttemptV1`) BEFORE
 * every `cp.spawn()` call, and either appends the resulting process
 * (`recordRoundProcessV1`) or durably proves it produced none
 * (`abandonProcessSpawnAttemptV1`). `unconfirmedProcessSpawnCountV1` reads
 * the difference back; a caller that gets `false` from ANY of
 * `beginRoundProcessRecordingV1`, `beginProcessSpawnAttemptV1`, or
 * `recordRoundProcessV1` MUST NOT treat this claim's process list as a
 * complete account when deciding whether it is safe to release the lock —
 * `stopRecordedCliProcessesV1` is the write-failure-aware caller that closes
 * the gap by consulting `unconfirmedProcessSpawnCountV1` before ever
 * reporting `allGone`.
 *
 * Best-effort, but NOT silently so: every write here returns whether it was
 * durably persisted. A caller that gets `false` back cannot assume the
 * process/claim it just tried to record will be visible to a future cleanup
 * pass, and per the plan's safety rule ("a lock is never released while a
 * provider CLI recorded against it may still be running") must not treat
 * this record as a complete account of this round's processes when deciding
 * whether it is safe to auto-release a lock — see `stopRecordedCliProcessesV1`
 * for how that integration is built; this module only guarantees the write
 * outcome is not thrown away unreported the way a void-returning
 * best-effort write would.
 *
 * `RecordedProcessIdentityV1` (`processLivenessClassifierV1.ts`) is reused
 * as-is for the (pid, processStartTime) pair every recorded process carries,
 * so classifying a recorded process later needs no shape conversion.
 */

const ROUND_PROCESS_RECORD_KEY_PREFIX = "ensemble.roundProcessRecordV1:";

/** `\0` cannot appear in either `taskFolderPath` or `claimId` (a filesystem
 * path and a generated id, respectively), so this is an unambiguous composite
 * key — no escaping needed, and no risk of two distinct (task, claim) pairs
 * ever colliding on the same key. */
function storageKeyForClaimV1(taskFolderPath: string, claimId: string): string {
  return `${ROUND_PROCESS_RECORD_KEY_PREFIX}${taskFolderPath}\0${claimId}`;
}

function taskKeyPrefixV1(taskFolderPath: string): string {
  return `${ROUND_PROCESS_RECORD_KEY_PREFIX}${taskFolderPath}\0`;
}

export interface RecordedProviderProcessV1 extends RecordedProcessIdentityV1 {
  /** `CliProviderDefinition.id`, e.g. "codex". */
  readonly providerId: string;
  /** `CliProviderDefinition.label`, e.g. "Codex CLI" — for display only. */
  readonly providerLabel: string;
  /** The resolved command line used to spawn this process, for display only
   * (never re-executed). */
  readonly command: string;
  readonly recordedAt: number;
}

interface RoundProcessRecordEntryV1 {
  readonly taskFolderPath: string;
  /** `WorkAdmissionHandleV1.claimId` of the acquisition this record belongs
   * to — the lock's own immutable identity, never a caller-supplied string. */
  readonly claimId: string;
  readonly processes: readonly RecordedProviderProcessV1[];
  /**
   * Spawn attempts begun under this claim (`beginProcessSpawnAttemptV1`,
   * durably written BEFORE `cp.spawn()` is called) minus the ones later
   * proven to have produced no live process (`abandonProcessSpawnAttemptV1`).
   * Closes the residual crash window `processes` alone cannot: a crash
   * between `cp.spawn()` returning a pid and the post-spawn append in
   * `processes` landing would otherwise leave `processes` looking exactly
   * like "no CLI was ever spawned" — see `unconfirmedProcessSpawnCountV1`'s
   * doc comment and the review this closes (1.0 RC1, Part B, item 2 defect
   * blocker: a dead-owner cleanup treating that empty list as `allGone` could
   * release the lock while the unrecorded CLI was still editing).
   */
  readonly spawnsStarted: number;
  readonly spawnsAbandoned: number;
  /**
   * Provider label and display-only command line for the MOST RECENT spawn
   * attempt `beginProcessSpawnAttemptV1` began — the same fields
   * `RecordedProviderProcessV1` carries once a pid is confirmed, recorded one
   * step earlier so they survive the exact crash window `unconfirmedSpawn`
   * exists for. Step 57a's "Provider process may still be running" card needs
   * these to name the provider and command for an `unconfirmedSpawn` hold,
   * which otherwise has no `RecordedProviderProcessV1` entry to read them
   * from at all. Best-effort and display-only, like the rest of this record;
   * `undefined` for a record written before this field existed, or a caller
   * that omitted them.
   */
  readonly pendingSpawnLabel?: string;
  readonly pendingSpawnCommand?: string;
}

function readRecordV1(taskFolderPath: string, claimId: string): RoundProcessRecordEntryV1 | undefined {
  const state = getExtensionContextV1()?.workspaceState;
  if (!state) {
    return undefined;
  }
  return state.get<RoundProcessRecordEntryV1 | undefined>(storageKeyForClaimV1(taskFolderPath, claimId), undefined);
}

// Per-(taskFolderPath, claimId) write queue so a read-modify-write cycle for
// one claim cannot race a concurrent call for the SAME claim and silently
// lose one of the two updates. Mirrors `workAdmissionV1.ts`'s
// `localSerializersV1` pattern. Deliberately NOT a single global queue, nor
// even a per-task queue: with each (task, claim) pair now on its own
// `workspaceState` key (see the module doc comment), writes for a different
// claim — even under the same task — touch disjoint storage and never need
// to wait on each other.
const writeQueuesV1 = new Map<string, Promise<unknown>>();

function enqueueWriteV1<T>(queueKey: string, run: () => Promise<T>): Promise<T> {
  const prior = writeQueuesV1.get(queueKey) ?? Promise.resolve();
  const settled = prior.then(run, run);
  // Keep the queue alive on failure (so the NEXT write still waits its
  // turn) without propagating a rejection through the chain other callers
  // are also awaiting.
  writeQueuesV1.set(
    queueKey,
    settled.then(
      () => undefined,
      () => undefined
    )
  );
  return settled;
}

/** Persist `entry` (or clear it, for `undefined`) for `(taskFolderPath,
 * claimId)`, replacing whatever was previously stored under its own key.
 * Never throws; returns whether the write actually landed. */
async function writeRecordV1(
  taskFolderPath: string,
  claimId: string,
  entry: RoundProcessRecordEntryV1 | undefined
): Promise<boolean> {
  const state = getExtensionContextV1()?.workspaceState;
  if (!state) {
    return false;
  }
  try {
    await state.update(storageKeyForClaimV1(taskFolderPath, claimId), entry);
    return true;
  } catch {
    return false;
  }
}

/** Mark `claimId` as recording processes against `taskFolderPath`, before any
 * process has been spawned under it. Call once, as early as possible after
 * acquiring the admission lock and before spawning the round's first
 * provider CLI — see the module doc comment's "NO-RECORD AMBIGUITY" section
 * for why this call matters: it is what turns "no record for this claim"
 * into a meaningful "this claim started no CLI" rather than an ambiguous
 * "recording may never have begun".
 *
 * Idempotent: if a record already exists for this exact `claimId` (e.g. a
 * retried call, or processes already recorded), it is left untouched rather
 * than truncated back to zero processes. A DIFFERENT `claimId` (a stale
 * prior generation, or a fresh successor) lives at its own key entirely (see
 * the module doc comment) and is never read or touched by this call.
 *
 * Never throws. Returns whether the (possibly no-op) state is durably
 * persisted — `false` means a caller has no evidence this claim's process
 * list will be complete and must not treat it as safe to auto-release. */
export async function beginRoundProcessRecordingV1(taskFolderPath: string, claimId: string): Promise<boolean> {
  if (!getExtensionContextV1()?.workspaceState) {
    return false;
  }
  return enqueueWriteV1(storageKeyForClaimV1(taskFolderPath, claimId), async () => {
    const existing = readRecordV1(taskFolderPath, claimId);
    if (existing) {
      return true;
    }
    return writeRecordV1(taskFolderPath, claimId, {
      taskFolderPath,
      claimId,
      processes: [],
      spawnsStarted: 0,
      spawnsAbandoned: 0,
    });
  });
}

/** Append one recorded provider CLI process to `taskFolderPath`'s record,
 * next to its admission lock. Call once per spawned process, as soon as its
 * pid is known. Never throws. Returns `true` once the write is durably
 * persisted, `false` if it could not be (e.g. no `ExtensionContext`, or the
 * underlying `workspaceState.update` rejected) — see the module doc comment
 * for why a caller must not treat `false` as "safe to ignore."
 *
 * `claimId` has its own storage key (see the module doc comment), so this
 * only ever appends to THIS claim's own record; a different claim's record —
 * whether an older generation or a newer one — lives at a different key and
 * is never read or overwritten by this call. Callers should normally call
 * `beginRoundProcessRecordingV1` first so a fresh claim's record starts as an
 * explicit empty list rather than being created implicitly here. */
export async function recordRoundProcessV1(
  taskFolderPath: string,
  claimId: string,
  process: RecordedProviderProcessV1
): Promise<boolean> {
  if (!getExtensionContextV1()?.workspaceState) {
    return false;
  }
  return enqueueWriteV1(storageKeyForClaimV1(taskFolderPath, claimId), async () => {
    const existing = readRecordV1(taskFolderPath, claimId);
    return writeRecordV1(taskFolderPath, claimId, {
      taskFolderPath,
      claimId,
      processes: [...(existing?.processes ?? []), process],
      spawnsStarted: existing?.spawnsStarted ?? 0,
      spawnsAbandoned: existing?.spawnsAbandoned ?? 0,
    });
  });
}

/**
 * Mark one spawn attempt as begun under `claimId`, durably, BEFORE the
 * caller calls `cp.spawn()`. Pairs with `abandonProcessSpawnAttemptV1` (if
 * the attempt never produces a live process) or an ordinary
 * `recordRoundProcessV1` append (once it does) — see
 * `unconfirmedProcessSpawnCountV1` for how the pairing is read back.
 *
 * Like `beginRoundProcessRecordingV1`, a caller that gets `false` back must
 * not proceed to spawn: this write is what lets a later reader tell "this
 * claim attempted a spawn" apart from "recording began but nothing was ever
 * attempted", so a spawn that goes ahead without it succeeding could vanish
 * from both `processes` and this counter if the window crashes right after.
 *
 * Never throws. Idempotent is NOT meaningful here (unlike
 * `beginRoundProcessRecordingV1`): every call is a distinct attempt and
 * always increments.
 *
 * `providerLabel`/`command` (Step 57a) are the same display-only values
 * `recordRoundProcessV1` would record once the pid is confirmed — recorded
 * here too, one step earlier, so an attempt that never reaches that point
 * (an `unconfirmedSpawn`) still leaves something for the held-marker card to
 * show. Overwrites any prior attempt's values: only the MOST RECENT attempt's
 * provider/command is kept, which is the one an outstanding
 * `unconfirmedProcessSpawnCountV1` can actually be about.
 */
export async function beginProcessSpawnAttemptV1(
  taskFolderPath: string,
  claimId: string,
  providerLabel?: string,
  command?: string
): Promise<boolean> {
  if (!getExtensionContextV1()?.workspaceState) {
    return false;
  }
  return enqueueWriteV1(storageKeyForClaimV1(taskFolderPath, claimId), async () => {
    const existing = readRecordV1(taskFolderPath, claimId);
    return writeRecordV1(taskFolderPath, claimId, {
      taskFolderPath,
      claimId,
      processes: existing?.processes ?? [],
      spawnsStarted: (existing?.spawnsStarted ?? 0) + 1,
      spawnsAbandoned: existing?.spawnsAbandoned ?? 0,
      ...(providerLabel !== undefined ? { pendingSpawnLabel: providerLabel } : {}),
      ...(command !== undefined ? { pendingSpawnCommand: command } : {}),
    });
  });
}

/**
 * Mark one spawn attempt begun via `beginProcessSpawnAttemptV1` as proven to
 * have left no live process behind — either because `cp.spawn()` threw
 * synchronously or returned a child with no `pid`, or because the child ran
 * and is now confirmed exited (the caller's own `settled`/`childExited`
 * flag) before its post-spawn `recordSpawnedCliProcessV1` write could be
 * confirmed durable — so it must not count as unconfirmed. Best-effort,
 * matching `clearRoundProcessesV1`: a caller that gets no
 * confirmation back has no further action to take (the attempt already
 * produced no process either way), and per the module's fail-open-to-blocked
 * rule, a write that does not land here only leaves the lock held slightly
 * more conservatively than necessary — never less. No record at all for this
 * exact `claimId` (nothing to abandon against) is a silent no-op.
 */
export async function abandonProcessSpawnAttemptV1(taskFolderPath: string, claimId: string): Promise<void> {
  const state = getExtensionContextV1()?.workspaceState;
  if (!state) {
    return;
  }
  await enqueueWriteV1(storageKeyForClaimV1(taskFolderPath, claimId), async () => {
    const existing = readRecordV1(taskFolderPath, claimId);
    if (!existing) {
      return;
    }
    try {
      await state.update(storageKeyForClaimV1(taskFolderPath, claimId), {
        ...existing,
        spawnsAbandoned: existing.spawnsAbandoned + 1,
      });
    } catch {
      // Best-effort, same reasoning as recordRoundProcessV1.
    }
  });
}

/**
 * How many spawn attempts begun under `claimId` are neither proven abandoned
 * nor accounted for in `processes` — i.e. attempts whose outcome a crash
 * could have erased before it was durably recorded. `0` is the ordinary
 * case; a caller such as `stopRecordedCliProcessesV1` must treat anything
 * greater as "cannot prove this claim started no CLI beyond what
 * `processes` shows" and refuse to report `allGone` on that basis alone. No
 * record at all for this exact `claimId` counts as `0` — matching
 * `listRoundProcessesV1`'s own "nothing recorded" contract. */
export function unconfirmedProcessSpawnCountV1(taskFolderPath: string, claimId: string): number {
  const existing = readRecordV1(taskFolderPath, claimId);
  if (!existing) {
    return 0;
  }
  return Math.max(0, existing.spawnsStarted - existing.spawnsAbandoned - existing.processes.length);
}

/**
 * The provider label and display-only command line `beginProcessSpawnAttemptV1`
 * most recently recorded for `claimId` (Step 57a) — what the "Provider
 * process may still be running" card shows for an `unconfirmedSpawn` hold,
 * since that state has no `RecordedProviderProcessV1` entry to read them
 * from. `undefined` fields when no record exists, or the record predates
 * this field, or the caller that began the attempt omitted them.
 */
export function pendingSpawnInfoV1(
  taskFolderPath: string,
  claimId: string
): { readonly providerLabel: string | undefined; readonly command: string | undefined } {
  const existing = readRecordV1(taskFolderPath, claimId);
  return { providerLabel: existing?.pendingSpawnLabel, command: existing?.pendingSpawnCommand };
}

/** Every process recorded for `taskFolderPath`'s `claimId`, oldest first, or
 * an empty list if none are recorded (this claim never began recording, or
 * the store is unreadable) — a caller must treat "nothing recorded" the same
 * as "no processes to check", never as an error. Because storage is keyed by
 * `(taskFolderPath, claimId)` together (see the module doc comment), an empty
 * result here is already scoped to exactly this claim — there is no separate
 * "does the record on file belong to this claim" check to make first, unlike
 * the old task-only-keyed design. */
export function listRoundProcessesV1(taskFolderPath: string, claimId: string): readonly RecordedProviderProcessV1[] {
  return readRecordV1(taskFolderPath, claimId)?.processes ?? [];
}

/** Whether ANY record — even an empty one from `beginRoundProcessRecordingV1`
 * alone — is on file for exactly `(taskFolderPath, claimId)`. Replaces the
 * pre-2026-09-29 `recordedClaimIdForTaskV1(taskFolderPath) === claimId`
 * pattern: that comparison assumed one "current" claim per task lived at a
 * single shared key, which is exactly the assumption the review found unsafe
 * (see the module doc comment). With per-claim keys there is nothing to
 * compare — a caller with its own `claimId` in hand just asks whether ITS OWN
 * key has an entry. */
export function hasRoundProcessRecordV1(taskFolderPath: string, claimId: string): boolean {
  return readRecordV1(taskFolderPath, claimId) !== undefined;
}

/** Clear EVERY claim's recorded processes for `taskFolderPath`, regardless of
 * `claimId` — a broader operation than any production caller needs (every
 * production release path holds one specific `claimId` and must use
 * {@link clearRoundProcessesForClaimV1} instead, which cannot ever touch a
 * different claim's key). Kept for a caller that genuinely means "clear
 * every trace of this task's round-process bookkeeping" (e.g. tests
 * exercising the record shape directly, or a future whole-task teardown).
 * Enumerates `workspaceState.keys()` for this task's key prefix, so it never
 * needs to know which claims exist in advance; each claim's key is cleared
 * through its OWN queue (see `enqueueWriteV1`), so this cannot race a
 * concurrent per-claim write any more than clearing them one at a time by
 * hand would. Best-effort, matching every other write in this module. */
export async function clearRoundProcessesV1(taskFolderPath: string): Promise<void> {
  const state = getExtensionContextV1()?.workspaceState;
  if (!state) {
    return;
  }
  const prefix = taskKeyPrefixV1(taskFolderPath);
  const keys = state.keys().filter((key) => key.startsWith(prefix));
  await Promise.all(
    keys.map((key) =>
      enqueueWriteV1(key, async () => {
        try {
          await state.update(key, undefined);
        } catch {
          // Best-effort, same reasoning as recordRoundProcessV1.
        }
      })
    )
  );
}

/**
 * Clear `taskFolderPath`'s recorded processes for lock generation `claimId`
 * ONLY. Before 2026-09-29 this re-read "the" task-level record and compared
 * its `claimId` inside the same queued write as the clear — safe against a
 * race WITHIN one process's queue, but not against a successor claim's
 * record written through a DIFFERENT process's own `workspaceState` cache
 * (2026-09-29 review, RC2 item 2 / Step 57a: a currently-running window
 * cannot see a live update to another window's in-memory cache — the same
 * limitation `hostDecisionMirrorV1.ts` documents for pending decisions — so
 * no in-process re-check, however carefully sequenced, can close that gap).
 *
 * Now unconditional and NEEDS no such check: `claimId` has always identified
 * its own storage key (see the module doc comment), so this can only ever
 * delete that one key. A different claim's record — older or newer, recorded
 * by this process or any other — lives at a different key and is
 * structurally unreachable from here, regardless of what any caller's cache
 * believes is "current". ENOENT-shaped "nothing there" (ordinary
 * `Memento.update` with no prior value) is not an error.
 */
export async function clearRoundProcessesForClaimV1(taskFolderPath: string, claimId: string): Promise<void> {
  const state = getExtensionContextV1()?.workspaceState;
  if (!state) {
    return;
  }
  await enqueueWriteV1(storageKeyForClaimV1(taskFolderPath, claimId), async () => {
    try {
      await state.update(storageKeyForClaimV1(taskFolderPath, claimId), undefined);
    } catch {
      // Best-effort, same reasoning as recordRoundProcessV1.
    }
  });
}
