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
 * identified, and one this module cannot close by itself: there is no
 * always-succeeding channel to make an arbitrary write durably observable
 * across a crash of a DIFFERENT window without also making every OTHER write
 * in the extension that strong. What this module CAN do, and does, is remove
 * the most common source of that ambiguity: `beginRoundProcessRecordingV1`
 * persists an (initially empty) record for `claimId` before any process is
 * spawned, so "no record at all, or a record for a DIFFERENT claimId" comes
 * to mean "this claim never even started recording" (safe to treat as no
 * CLI launched under it), while "a record for THIS claimId with zero
 * processes" means recording began but nothing has been added yet (a narrow
 * window, not a silent gap spanning the round's whole life). A caller that
 * gets `false` back from `beginRoundProcessRecordingV1` (or from
 * `recordRoundProcessV1`) MUST NOT treat this claim's process list as a
 * complete account when deciding whether it is safe to release the lock —
 * that write-failure-aware caller contract (still unbuilt; see the doc
 * comment on `recordRoundProcessV1`) is what ultimately closes the gap, not
 * this module in isolation.
 *
 * Best-effort, but NOT silently so: every write here returns whether it was
 * durably persisted. A caller that gets `false` back cannot assume the
 * process/claim it just tried to record will be visible to a future cleanup
 * pass, and per the plan's safety rule ("a lock is never released while a
 * provider CLI recorded against it may still be running") must not treat
 * this record as a complete account of this round's processes when deciding
 * whether it is safe to auto-release a lock — that integration is still
 * unbuilt (see the doc comment on `recordRoundProcessV1`); this module only
 * guarantees the write outcome is not thrown away unreported the way a
 * void-returning best-effort write would.
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
    return writeRecordV1(taskFolderPath, { taskFolderPath, claimId, processes: [] });
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
    const carried = existing && existing.claimId === claimId ? existing.processes : [];
    return writeRecordV1(taskFolderPath, {
      taskFolderPath,
      claimId,
      processes: [...carried, process],
    });
  });
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
