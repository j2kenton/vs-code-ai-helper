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
 * bookkeeping keeps it: cleared only by an explicit `clearRoundProcessesV1`
 * call (made by the cleanup/release path once every recorded process is
 * CONFIRMED gone — never on a timer) or implicitly superseded the next time
 * a caller records against the same `taskFolderPath` with a different
 * `claimId` (a fresh acquisition of the lock; see below).
 *
 * PER-TASK STORAGE KEY, not one shared map. A prior revision stored every
 * task's record in a single `workspaceState` entry (one JSON blob keyed by
 * `taskFolderPath`) with writes serialized only per `taskFolderPath`. A
 * review caught that this does NOT prevent cross-task data loss: two
 * DIFFERENT tasks' queues can each read the same shared blob, compute their
 * own key's update against what they read, and write back — and because
 * `Memento.update` is asynchronous, task B's read can happen before task A's
 * concurrent write has landed, so task B's write-back silently reverts task
 * A's change. Giving every task its own `workspaceState` key
 * (`${ROUND_PROCESS_RECORD_KEY}:${taskFolderPath}`) removes the shared
 * mutable object entirely — there is no longer any blob for two different
 * tasks' writes to race over, matching this module's own reviewed
 * reasoning for why per-task queues should not make unrelated tasks wait on
 * each other. Same persistence choice as `roundLeaseV1.ts` and for the same
 * reason: `context.workspaceState`, shared on disk across every window open
 * on this workspace, so a NEW window opened after a crash can still see what
 * a crashed window's round had recorded. Writes for a given `taskFolderPath`
 * are still serialized through an in-process queue (mirroring
 * `workAdmissionV1.ts`'s own owner-local queue) so two processes recorded in
 * quick succession for the SAME task cannot race a read-modify-write and
 * silently drop one another.
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

function storageKeyForTaskV1(taskFolderPath: string): string {
  return `${ROUND_PROCESS_RECORD_KEY_PREFIX}${taskFolderPath}`;
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
}

function readRecordV1(taskFolderPath: string): RoundProcessRecordEntryV1 | undefined {
  const state = getExtensionContextV1()?.workspaceState;
  if (!state) {
    return undefined;
  }
  return state.get<RoundProcessRecordEntryV1 | undefined>(storageKeyForTaskV1(taskFolderPath), undefined);
}

// Per-`taskFolderPath` write queue so a read-modify-write cycle for one task
// cannot race a concurrent call for the SAME task and silently lose one of
// the two updates. Mirrors `workAdmissionV1.ts`'s `localSerializersV1`
// pattern. Deliberately NOT a single global queue: with each task now on its
// own `workspaceState` key (see the module doc comment), writes for unrelated
// tasks touch disjoint storage and never need to wait on each other.
const writeQueuesV1 = new Map<string, Promise<unknown>>();

function enqueueWriteV1<T>(taskFolderPath: string, run: () => Promise<T>): Promise<T> {
  const prior = writeQueuesV1.get(taskFolderPath) ?? Promise.resolve();
  const settled = prior.then(run, run);
  // Keep the queue alive on failure (so the NEXT write still waits its
  // turn) without propagating a rejection through the chain other callers
  // are also awaiting.
  writeQueuesV1.set(
    taskFolderPath,
    settled.then(
      () => undefined,
      () => undefined
    )
  );
  return settled;
}

/** Persist `entry` for `taskFolderPath`, replacing whatever was previously
 * stored under its own key. Never throws; returns whether the write actually
 * landed. */
async function writeRecordV1(taskFolderPath: string, entry: RoundProcessRecordEntryV1): Promise<boolean> {
  const state = getExtensionContextV1()?.workspaceState;
  if (!state) {
    return false;
  }
  try {
    await state.update(storageKeyForTaskV1(taskFolderPath), entry);
    return true;
  } catch {
    return false;
  }
}

/** Mark `claimId` as the current lock generation recording processes against
 * `taskFolderPath`, before any process has been spawned under it. Call once,
 * as early as possible after acquiring the admission lock and before
 * spawning the round's first provider CLI — see the module doc comment's
 * "NO-RECORD AMBIGUITY" section for why this call matters: it is what turns
 * "no record for this claim" into a meaningful "this claim started no CLI"
 * rather than an ambiguous "recording may never have begun".
 *
 * Idempotent for the same `claimId`: if a record already exists for this
 * exact `claimId` (e.g. a retried call, or processes already recorded), it
 * is left untouched rather than truncated back to zero processes. A record
 * for a DIFFERENT `claimId` (a stale prior generation) is replaced, matching
 * `recordRoundProcessV1`'s own replace-on-new-claim behavior.
 *
 * Never throws. Returns whether the (possibly no-op) state is durably
 * persisted — `false` means a caller has no evidence this claim's process
 * list will be complete and must not treat it as safe to auto-release. */
export async function beginRoundProcessRecordingV1(taskFolderPath: string, claimId: string): Promise<boolean> {
  if (!getExtensionContextV1()?.workspaceState) {
    return false;
  }
  return enqueueWriteV1(taskFolderPath, async () => {
    const existing = readRecordV1(taskFolderPath);
    if (existing && existing.claimId === claimId) {
      return true;
    }
    return writeRecordV1(taskFolderPath, {
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
 * If the record already held for `taskFolderPath` belongs to a DIFFERENT
 * `claimId`, it is replaced rather than appended to — that is a previous
 * lock generation's now-stale bookkeeping (its own hold has ended, since a
 * different `claimId` can only mean a fresh, later acquisition), not more
 * processes for the generation currently recording. Callers should normally
 * call `beginRoundProcessRecordingV1` first so this replacement is the rare
 * case rather than the common one. */
export async function recordRoundProcessV1(
  taskFolderPath: string,
  claimId: string,
  process: RecordedProviderProcessV1
): Promise<boolean> {
  if (!getExtensionContextV1()?.workspaceState) {
    return false;
  }
  return enqueueWriteV1(taskFolderPath, async () => {
    const existing = readRecordV1(taskFolderPath);
    const carriedProcesses = existing && existing.claimId === claimId ? existing.processes : [];
    const carriedStarted = existing && existing.claimId === claimId ? existing.spawnsStarted : 0;
    const carriedAbandoned = existing && existing.claimId === claimId ? existing.spawnsAbandoned : 0;
    return writeRecordV1(taskFolderPath, {
      taskFolderPath,
      claimId,
      processes: [...carriedProcesses, process],
      spawnsStarted: carriedStarted,
      spawnsAbandoned: carriedAbandoned,
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
 */
export async function beginProcessSpawnAttemptV1(taskFolderPath: string, claimId: string): Promise<boolean> {
  if (!getExtensionContextV1()?.workspaceState) {
    return false;
  }
  return enqueueWriteV1(taskFolderPath, async () => {
    const existing = readRecordV1(taskFolderPath);
    const carriedProcesses = existing && existing.claimId === claimId ? existing.processes : [];
    const carriedStarted = existing && existing.claimId === claimId ? existing.spawnsStarted : 0;
    const carriedAbandoned = existing && existing.claimId === claimId ? existing.spawnsAbandoned : 0;
    return writeRecordV1(taskFolderPath, {
      taskFolderPath,
      claimId,
      processes: carriedProcesses,
      spawnsStarted: carriedStarted + 1,
      spawnsAbandoned: carriedAbandoned,
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
 * more conservatively than necessary — never less. A record belonging to a
 * different `claimId` is not this claim's to abandon against; a silent no-op.
 */
export async function abandonProcessSpawnAttemptV1(taskFolderPath: string, claimId: string): Promise<void> {
  const state = getExtensionContextV1()?.workspaceState;
  if (!state) {
    return;
  }
  await enqueueWriteV1(taskFolderPath, async () => {
    const existing = readRecordV1(taskFolderPath);
    if (!existing || existing.claimId !== claimId) {
      return;
    }
    try {
      await state.update(storageKeyForTaskV1(taskFolderPath), {
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
 * `processes` shows" and refuse to report `allGone` on that basis alone. A
 * record belonging to a different `claimId` (or no record at all) counts as
 * `0` — matching `listRoundProcessesV1`'s own "nothing recorded" contract. */
export function unconfirmedProcessSpawnCountV1(taskFolderPath: string, claimId: string): number {
  const existing = readRecordV1(taskFolderPath);
  if (!existing || existing.claimId !== claimId) {
    return 0;
  }
  return Math.max(0, existing.spawnsStarted - existing.spawnsAbandoned - existing.processes.length);
}

/** Every process recorded for `taskFolderPath`'s current lock, oldest first,
 * or an empty list if none are recorded (no claim has begun recording, or
 * the store is unreadable) — a caller must treat "nothing recorded" the same
 * as "no processes to check", never as an error, and must not treat it as
 * PROOF no process was ever spawned unless it has also confirmed (via
 * {@link recordedClaimIdForTaskV1}) that the record on file belongs to the
 * `claimId` it is checking (see the module doc comment's "NO-RECORD
 * AMBIGUITY" section). */
export function listRoundProcessesV1(taskFolderPath: string): readonly RecordedProviderProcessV1[] {
  return readRecordV1(taskFolderPath)?.processes ?? [];
}

/** The `claimId` currently recording against `taskFolderPath`, if any — lets
 * a caller confirm the record it is about to act on belongs to the lock
 * generation (`WorkAdmissionHandleV1.claimId`) it thinks it does, rather than
 * a stale prior generation or no recording at all. */
export function recordedClaimIdForTaskV1(taskFolderPath: string): string | undefined {
  return readRecordV1(taskFolderPath)?.claimId;
}

/** Clear `taskFolderPath`'s recorded processes once every one of them is
 * confirmed gone (or the round never started one). Call from the same
 * cleanup site that releases the task's lock, never before that
 * confirmation — see the module doc comment's safety rule. Best-effort,
 * matching `clearRoundLiveV1`; serialized through the same per-task queue as
 * `recordRoundProcessV1` so it cannot race a late-arriving record write. */
export async function clearRoundProcessesV1(taskFolderPath: string): Promise<void> {
  const state = getExtensionContextV1()?.workspaceState;
  if (!state) {
    return;
  }
  await enqueueWriteV1(taskFolderPath, async () => {
    try {
      await state.update(storageKeyForTaskV1(taskFolderPath), undefined);
    } catch {
      // Best-effort, same reasoning as recordRoundProcessV1.
    }
  });
}
