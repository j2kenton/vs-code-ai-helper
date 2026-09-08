import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { ADMISSION_DIRNAME_V1 } from "../services/workflowPrivacyClassifierV1";
import { resolveHostIdentityV1 } from "./hostIdentityV1";

/**
 * Work admission (v1 fixes item 1, Part 1a — 1.0.0 gate).
 *
 * A1's watchdog (`taskWatchdogV1.ts`) closes the silent-stop failure by
 * pausing a task that is `active` with nothing live, owed, or scheduled. But
 * a command that is STARTING work has not yet opened a round-ledger row —
 * the only durable liveness evidence the watchdog previously consulted — so
 * for the whole of its setup phase (context-pack assembly, model resolution,
 * consent checks) it is indistinguishable from a task doing nothing. Measured
 * directly: a High-Level Review paused mid-setup on 2026-09-07, then aborted
 * on its own paused check.
 *
 * This module is the durable admission signal that closes that gap. A
 * command that is about to start work acquires an admission marker for its
 * task BEFORE any awaited setup begins; the watchdog treats a live marker
 * (this module's `hasLiveWorkAdmissionBestEffortV1`) as an additional
 * exemption, alongside the round ledger, `implRecovery`, `scheduledRun`, and
 * scheduling-intent checks it already has (`taskWatchdogV1.ts`).
 *
 * Genesis protocol (per task folder, directory `admission-v1/`):
 *   1. Exclusively create a SHARED contested filename, `admission.claim`
 *      (`fs.promises.writeFile(..., { flag: "wx" })` — the same primitive
 *      `primarySessionLock.ts` uses for its own exclusive-create lease).
 *      Only one concurrent caller can win this create; every loser reads the
 *      winner's claim back as a `busy` diagnostic.
 *   2. Re-list the admission directory. If any marker (`admission.<token>.g
 *      <N>.<epoch>`) already exists — a prior owner never released — the
 *      just-created claim file is removed (it is unambiguously this caller's
 *      own file) and the caller reports `busy` against the existing marker
 *      instead of completing genesis.
 *   3. Otherwise rename `admission.claim` to `admission.<ownerToken>.g1.
 *      <epoch>` — the published, live, generation-1 marker. The rename is
 *      safe unaccompanied by a race check: exclusive create in step 1
 *      guarantees this caller is the sole holder of `admission.claim`.
 *   4. `heartbeat()` renames the current marker to the next generation with a
 *      fresh epoch, serialized through an owner-local promise queue so a
 *      heartbeat and a release (or two heartbeats) can never race each other
 *      for the same owner.
 *   5. `release()` unlinks exactly the owner's current generation filename.
 *      `ENOENT` is treated as "displaced", not an error — nothing in v1a
 *      reclaims another owner's marker, so this should not happen in
 *      practice, but a future takeover mechanism (1c) may have moved it.
 *
 * Interim policy (v1a, explicit and temporary): a stale claim or marker is
 * NEVER automatically reclaimed. `hasLiveWorkAdmissionBestEffortV1` and the
 * genesis flow both treat ANY existing claim/marker file as live, regardless
 * of its age — so during this interim period "present" and "live" are
 * synonymous. This is deliberately conservative: without 1b's generation
 * fencing and 1c's conservative liveness/takeover protocol, there is no safe
 * way to tell "the owning process died" from "the owning process is still
 * working slowly", so the only safe default is to never let anyone override
 * a stale record and never let the watchdog pause the task either — the
 * sweep stands down for the whole task rather than guessing. A command that
 * cannot acquire admission because of a stale record reports a `busy`
 * diagnostic naming the owner, its age, and the marker path so a human can
 * decide, rather than silently retrying or silently proceeding unprotected.
 *
 * All admission-directory paths are classified `workflowControl` by
 * `workflowPrivacyClassifierV1.ts` (`ADMISSION_DIRNAME_V1`) — this is pure
 * bookkeeping, never provider output, and must never enter a context pack,
 * an artifact, or a change set (see `sanitizeChangeSetV1`, Part 5).
 */

export { ADMISSION_DIRNAME_V1 };

const CLAIM_FILENAME_V1 = "admission.claim";
const MARKER_RE_V1 = /^admission\.([0-9a-z-]+)\.g(\d+)\.([0-9a-z]+)$/;

/** How often a held marker should be heartbeat-renewed. Well inside any
 * plausible staleness threshold, so a live owner's marker never appears
 * stale to a concurrent reader. */
export const WORK_ADMISSION_HEARTBEAT_INTERVAL_MS_V1 = 2 * 60 * 1000;

export type WorkAdmissionPurposeV1 = "admission" | "pauseCommit";

export interface WorkAdmissionClaimInfoV1 {
  readonly claimId: string;
  readonly purpose: WorkAdmissionPurposeV1;
  readonly ownerToken: string;
  readonly pid: number;
  /** Best-effort approximation of this process's own start time
   * (`Date.now() - process.uptime() * 1000`, captured once at module load).
   * Real cross-process start-time comparison (for conservative liveness
   * detection of a DIFFERENT process) is 1c's job; v1a only ever compares a
   * marker's recorded info to itself, never probes a live PID. */
  readonly processStartTime: number;
  readonly hostId: string;
  readonly commandId: string;
  readonly startedAt: string;
}

export interface WorkAdmissionHandleV1 {
  readonly ownerToken: string;
  readonly taskFolderPath: string;
  readonly commandId: string;
  readonly purpose: WorkAdmissionPurposeV1;
  /** Renew the marker to the next generation with a fresh epoch. */
  heartbeat(): Promise<void>;
  /** Release the marker. Best-effort — a displaced marker (ENOENT) is not an error. */
  release(): Promise<void>;
  /**
   * Release the marker because durable protection has been HANDED OVER to
   * something else that now exempts the task on its own terms (e.g. an
   * opened round-ledger row) — as opposed to `release()`, called when the
   * command itself is simply done. Mechanically identical to `release()` in
   * v1a (both unlink the exact tracked generation and are ENOENT-safe): the
   * distinction is call-site intent, not different disk behavior, and it
   * matters for what comes next. A command's setup phase must call ONE of
   * `handover()` or `release()` before the task can be considered
   * unprotected again — never neither (see the module doc comment's "keep
   * durable protection until a confirmed exemption has taken over" rule) —
   * and future callers (a round-ledger integration) can distinguish "hand
   * off" from "done" in logs/telemetry without this module needing to know
   * what took over. Serialized through the same owner-local queue as
   * `heartbeat()`/`release()`, so a heartbeat can never race a handover.
   */
  handover(): Promise<void>;
}

export interface WorkAdmissionAcquiredV1 {
  readonly outcome: "acquired";
  readonly handle: WorkAdmissionHandleV1;
}

export interface WorkAdmissionBusyV1 {
  readonly outcome: "busy";
  /** The existing owner's recorded claim info, when the record was readable. */
  readonly owner: WorkAdmissionClaimInfoV1 | undefined;
  readonly markerPath: string;
  readonly ageMs: number;
  /** True when the record is old enough that a human might reasonably ask
   * whether its owner is still alive. v1a never acts on this — it is
   * diagnostic only (see interim policy above). */
  readonly likelyStale: boolean;
}

export interface WorkAdmissionWriteFailedV1 {
  readonly outcome: "writeFailed";
  readonly error: Error;
}

export type WorkAdmissionResultV1 = WorkAdmissionAcquiredV1 | WorkAdmissionBusyV1 | WorkAdmissionWriteFailedV1;

/** Diagnostic-only threshold for `likelyStale` — not used for reclamation
 * anywhere in v1a. Generous, so a slow-but-alive owner is never flagged. */
export const WORK_ADMISSION_LIKELY_STALE_MS_V1 = 20 * 60 * 1000;

const processStartTimeV1 = Date.now() - Math.floor(process.uptime() * 1000);

/** Process-local registry of admission handles this window currently holds,
 * keyed by task folder path. Lets same-window callers answer "do I already
 * hold admission for this task" without a filesystem round trip, and backs
 * the synchronous half of `hasLiveWorkAdmissionBestEffortV1`. */
const localHandlesV1 = new Map<string, WorkAdmissionHandleV1>();

function admissionDirV1(taskFolderPath: string): string {
  return path.join(taskFolderPath, ADMISSION_DIRNAME_V1);
}

function freshEpochV1(): string {
  return `${Date.now().toString(36)}${crypto.randomBytes(4).toString("hex")}`;
}

function markerBasenameV1(ownerToken: string, generation: number, epoch: string): string {
  return `admission.${ownerToken}.g${generation}.${epoch}`;
}

interface ParsedMarkerV1 {
  readonly ownerToken: string;
  readonly generation: number;
  readonly epoch: string;
}

function parseMarkerBasenameV1(basename: string): ParsedMarkerV1 | undefined {
  const match = MARKER_RE_V1.exec(basename);
  if (!match) {
    return undefined;
  }
  const [, ownerToken, generationText, epoch] = match;
  const generation = Number.parseInt(generationText!, 10);
  if (!Number.isFinite(generation)) {
    return undefined;
  }
  return { ownerToken: ownerToken!, generation, epoch: epoch! };
}

/** List every marker file (not the shared `admission.claim` staging file)
 * currently in the task's admission directory. Empty array (never throws)
 * when the directory does not exist. */
function listMarkersSyncV1(dir: string): readonly { readonly filePath: string; readonly basename: string }[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return entries
    .filter((name) => parseMarkerBasenameV1(name) !== undefined)
    .map((name) => ({ filePath: path.join(dir, name), basename: name }));
}

function readClaimInfoSyncV1(filePath: string): WorkAdmissionClaimInfoV1 | undefined {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<WorkAdmissionClaimInfoV1>;
    if (typeof parsed.ownerToken !== "string" || typeof parsed.claimId !== "string") {
      return undefined;
    }
    return parsed as WorkAdmissionClaimInfoV1;
  } catch {
    // Corrupt or unreadable — the caller treats this as "an owner exists,
    // details unknown", never as "no owner".
    return undefined;
  }
}

/**
 * Best-effort, synchronous, fail-open liveness check for the watchdog
 * (`taskWatchdogV1.ts`'s `isImpossibleActiveStateV1`, which is itself
 * synchronous and re-evaluated fresh inside a CAS patch — this must match
 * that shape rather than force the whole watchdog predicate async). Returns
 * `true` when this window already holds admission for the task (process-
 * local fast path), or when ANY claim/marker file is present on disk for it
 * (interim policy: presence alone is "live", see the module doc comment).
 * On an unexpected filesystem error (not ENOENT) this fails OPEN to `true` —
 * the same conservative direction `hasLiveSchedulingIntentBestEffortV1`
 * takes — because the watchdog must never pause a task it cannot actually
 * prove is idle.
 */
export function hasLiveWorkAdmissionBestEffortV1(taskFolderPath: string): boolean {
  if (localHandlesV1.has(taskFolderPath)) {
    return true;
  }
  const dir = admissionDirV1(taskFolderPath);
  try {
    if (fs.existsSync(path.join(dir, CLAIM_FILENAME_V1))) {
      return true;
    }
    return listMarkersSyncV1(dir).length > 0;
  } catch {
    return true;
  }
}

/** Build a `busy` diagnostic directly from a known marker file, bypassing
 * `describeWorkAdmissionBlockerV1`'s claim-before-marker priority. Used where
 * the caller already positively knows the REAL blocker is a marker (not its
 * own claim) — see that function's own doc comment for why conflating the
 * two there would be wrong. */
function describeMarkerAsBlockerV1(markerFilePath: string, now: number): WorkAdmissionBusyV1 {
  let ageMs = 0;
  try {
    ageMs = now - fs.statSync(markerFilePath).mtimeMs;
  } catch {
    ageMs = Number.POSITIVE_INFINITY;
  }
  return {
    outcome: "busy",
    owner: readClaimInfoSyncV1(markerFilePath),
    markerPath: markerFilePath,
    ageMs,
    likelyStale: ageMs > WORK_ADMISSION_LIKELY_STALE_MS_V1,
  };
}

/** Diagnostic snapshot of whatever is currently blocking admission for a
 * task, for a `busy` outcome's message or a stand-down log line. `undefined`
 * when nothing is present.
 *
 * Prioritizes a live `admission.claim` over a marker: normally correct (a
 * claim mid-genesis is a real, if young, blocker), but this makes it the
 * WRONG diagnostic for a caller who already knows the real blocker is a
 * MARKER and who may itself have a not-yet-cleaned-up claim sitting at the
 * same fixed path (e.g. cleanup failed after losing to an existing marker) —
 * that caller would see this function misreport its OWN stale claim as "the
 * blocker" instead of the marker's real owner. Such a caller must use
 * `describeMarkerAsBlockerV1` on the marker it already found directly,
 * rather than calling this. */
export function describeWorkAdmissionBlockerV1(
  taskFolderPath: string,
  now: number = Date.now()
): WorkAdmissionBusyV1 | undefined {
  const dir = admissionDirV1(taskFolderPath);
  const claimPath = path.join(dir, CLAIM_FILENAME_V1);
  try {
    const claimStat = fs.statSync(claimPath);
    return {
      outcome: "busy",
      owner: readClaimInfoSyncV1(claimPath),
      markerPath: claimPath,
      ageMs: now - claimStat.mtimeMs,
      likelyStale: now - claimStat.mtimeMs > WORK_ADMISSION_LIKELY_STALE_MS_V1,
    };
  } catch {
    // No claim file — fall through to markers.
  }
  const markers = listMarkersSyncV1(dir);
  if (markers.length === 0) {
    return undefined;
  }
  return describeMarkerAsBlockerV1(markers[0]!.filePath, now);
}

/** Small fixed delays between cleanup retries — long enough to ride out a
 * transient same-host contender (e.g. an antivirus scan or another process
 * that briefly opened the file), short enough not to meaningfully delay
 * error reporting for a genuinely stuck cleanup. */
const CLAIM_CLEANUP_RETRY_DELAYS_MS_V1 = [10, 50, 150];

function delayV1(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Best-effort removal of a claim file this exact call created — never an
 * error if it is already gone (a concurrent path already cleaned it up, or
 * the failure that triggered this cleanup was the write itself). Used by
 * every `acquireWorkAdmissionV1` failure branch AFTER the claim was
 * successfully created, so a mid-genesis failure never orphans it.
 *
 * Completion blocker fix (2026-09-08 review): the prior version swallowed
 * EVERY unlink failure unconditionally, including a real, non-ENOENT one
 * (permissions, an antivirus/indexer holding the file open on Windows, ...).
 * Under v1a's interim never-reclaim policy that silently strands
 * `admission.claim` on disk forever — every later caller for the task reads
 * it back as "busy" and the watchdog stands down for the task permanently,
 * with nothing in the returned diagnostic hinting that cleanup itself is
 * what actually failed. This now retries a genuine failure a few times
 * (transient locks are the common real-world case) and, if it still cannot
 * remove the file, returns the error to the caller instead of swallowing it,
 * so `acquireWorkAdmissionV1` can fold it into the reported error message —
 * turning a silent, permanent stranding into a diagnosed one a human can act
 * on immediately instead of discovering only when every later dispatch
 * reports busy against a file that was created by an error path.
 */
async function cleanupOwnClaimBestEffortV1(claimPath: string): Promise<Error | undefined> {
  for (let attempt = 0; attempt <= CLAIM_CLEANUP_RETRY_DELAYS_MS_V1.length; attempt++) {
    try {
      const injected = fsFailureInjectionV1?.onBeforeClaimCleanupUnlink?.();
      if (injected) {
        throw injected;
      }
      await fs.promises.unlink(claimPath);
      return undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // Already gone — a concurrent path cleaned it up, or it was never
        // fully created; nothing to report.
        return undefined;
      }
      const delayMs = CLAIM_CLEANUP_RETRY_DELAYS_MS_V1[attempt];
      if (delayMs === undefined) {
        return error as Error;
      }
      await delayV1(delayMs);
    }
  }
  return undefined;
}

/** Combine a primary failure with a secondary claim-cleanup failure into one
 * error message, when cleanup itself could not remove the claim file — so the
 * report names BOTH the original problem and the fact that `admission.claim`
 * was left behind and needs manual removal, rather than only the first. */
function withCleanupFailureNotedV1(primary: Error, cleanupError: Error | undefined, claimPath: string): Error {
  if (!cleanupError) {
    return primary;
  }
  return new Error(
    `${primary.message} (additionally, the claim file at ${claimPath} could not be removed during cleanup: ` +
      `${cleanupError.message} — it will strand every later stage action for this task as "busy" until it is ` +
      `removed manually)`
  );
}

/**
 * Test-only deterministic failure injection for the two genesis steps that
 * are otherwise impractical to force reliably and cross-platform with real
 * filesystem permissions (`chmod`'s effect on NEW file creation inside a
 * directory is unreliable on Windows, and the marker's random epoch makes
 * pre-creating a colliding path for the rename target impossible). Set only
 * from tests; `undefined` (the default) means production behavior is
 * unchanged. Completion blocker fix (2026-09-08 review): without this seam
 * the claim-create-failure and rename-failure branches — including their
 * cleanup calls — had no test forcing them for a reason OTHER than the
 * pre-existing `mkdir`-fails-first case, which never reaches either of them.
 */
export interface WorkAdmissionFsFailureInjectionV1 {
  readonly onBeforeClaimWrite?: () => Error | undefined;
  readonly onBeforeMarkerRename?: () => Error | undefined;
  readonly onBeforeClaimCleanupUnlink?: () => Error | undefined;
  /** Non-blocking review suggestion (2026-09-08): forces a genuine (non-ENOENT)
   * failure of a HEARTBEAT's own rename, distinct from `onBeforeMarkerRename`
   * (genesis only) — otherwise as impractical to produce reliably as the two
   * genesis steps above, for the same reason. */
  readonly onBeforeHeartbeatRename?: () => Error | undefined;
}
let fsFailureInjectionV1: WorkAdmissionFsFailureInjectionV1 | undefined;
export function setWorkAdmissionFsFailureInjectionForTestV1(injection: WorkAdmissionFsFailureInjectionV1 | undefined): void {
  fsFailureInjectionV1 = injection;
}

/**
 * Acquire durable work admission for `taskFolderPath`, running the genesis
 * flow described in the module doc comment. Never throws — filesystem
 * failures during the claim/rename sequence resolve to `writeFailed` with
 * the real underlying error, kept distinct from an ordinary `busy` (someone
 * else already owns admission) so a caller can tell "I could not even try"
 * from "someone got there first".
 */
export async function acquireWorkAdmissionV1(params: {
  readonly taskFolderPath: string;
  readonly purpose: WorkAdmissionPurposeV1;
  readonly commandId: string;
}): Promise<WorkAdmissionResultV1> {
  const { taskFolderPath, purpose, commandId } = params;
  const dir = admissionDirV1(taskFolderPath);
  const ownerToken = `${process.pid.toString(36)}-${crypto.randomBytes(6).toString("hex")}`;
  const hostId = await resolveHostIdentityV1();
  const claimInfo: WorkAdmissionClaimInfoV1 = {
    claimId: crypto.randomUUID(),
    purpose,
    ownerToken,
    pid: process.pid,
    processStartTime: processStartTimeV1,
    hostId,
    commandId,
    startedAt: new Date().toISOString(),
  };
  const claimPath = path.join(dir, CLAIM_FILENAME_V1);

  try {
    await fs.promises.mkdir(dir, { recursive: true });
  } catch (error) {
    return { outcome: "writeFailed", error: error as Error };
  }

  try {
    const injected = fsFailureInjectionV1?.onBeforeClaimWrite?.();
    if (injected) {
      throw injected;
    }
    await fs.promises.writeFile(claimPath, JSON.stringify(claimInfo), { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const blocker = describeWorkAdmissionBlockerV1(taskFolderPath);
      if (blocker) {
        return blocker;
      }
      // The claim existed a moment ago but is gone now (the other owner
      // released between our failed create and this read) — nothing to
      // report as busy; the caller may simply retry.
      return { outcome: "writeFailed", error: new Error("Work admission claim was contended and then vanished; retry.") };
    }
    return { outcome: "writeFailed", error: error as Error };
  }

  // Re-list: if a live marker already exists (a prior owner never
  // released), this caller's own just-created claim file is removed — it is
  // unambiguously ours — and we report busy against the existing marker
  // instead of completing genesis.
  //
  // Completion blocker fix (2026-09-08 review): this listing can itself
  // throw (a non-ENOENT `readdirSync` error), and this whole branch's
  // cleanup — including the ORIGINAL EEXIST branch above, which never
  // touches its own claim at all — must never leave `admission.claim`
  // orphaned on disk. An orphaned claim makes every later caller busy and
  // the watchdog stand down for this task FOREVER (v1a's interim policy
  // never reclaims a claim/marker automatically) — exactly the kind of
  // dead end this whole task exists to remove. Every failure path from here
  // on cleans up the claim it just created before returning.
  let existingMarkers: readonly { readonly filePath: string; readonly basename: string }[];
  try {
    existingMarkers = listMarkersSyncV1(dir);
  } catch (error) {
    const cleanupError = await cleanupOwnClaimBestEffortV1(claimPath);
    return { outcome: "writeFailed", error: withCleanupFailureNotedV1(error as Error, cleanupError, claimPath) };
  }
  if (existingMarkers.length > 0) {
    // 2026-09-08 review (blocker `…-2`, narrowed): this branch used to await
    // cleanup and discard whatever it returned. If that unlink genuinely
    // fails (not ENOENT — `cleanupOwnClaimBestEffortV1` already treats a
    // displaced claim as success), OUR OWN just-created `admission.claim`
    // is left behind on disk, and since v1a never reclaims a stale claim
    // automatically, every later caller for this task is now permanently
    // "busy" against a claim that isn't even the live marker's owner — the
    // exact stranding this whole cleanup path exists to prevent. A `busy`
    // result alone would hide that: the caller would correctly learn about
    // the OTHER owner's marker but never learn its own claim also needs
    // manual removal. Escalate to `writeFailed`, composing the busy
    // diagnosis as the primary message via `withCleanupFailureNotedV1`, so
    // the stranded-claim note always reaches the caller when it happens.
    //
    // The busy diagnosis is captured from `existingMarkers[0]` directly via
    // `describeMarkerAsBlockerV1`, NOT via `describeWorkAdmissionBlockerV1(taskFolderPath)`
    // — that function checks for a live `admission.claim` FIRST, and if
    // cleanup below fails, THIS caller's own not-yet-removed claim is sitting
    // at that exact fixed path. Calling it (especially after cleanup, when
    // failure is most likely) would misreport this caller's own stranded
    // claim as "the blocker" instead of the marker's real owner.
    const busy = describeMarkerAsBlockerV1(existingMarkers[0]!.filePath, Date.now());
    const cleanupError = await cleanupOwnClaimBestEffortV1(claimPath);
    if (!cleanupError) {
      return busy;
    }
    const ownerDetail = busy.owner
      ? `held by ${busy.owner.commandId} (pid ${busy.owner.pid} on ${busy.owner.hostId})`
      : "held by an unreadable record";
    const primary = new Error(
      `Work admission is already ${ownerDetail} at ${busy.markerPath}.`
    );
    return { outcome: "writeFailed", error: withCleanupFailureNotedV1(primary, cleanupError, claimPath) };
  }

  let currentGeneration = 1;
  let currentPath = path.join(dir, markerBasenameV1(ownerToken, currentGeneration, freshEpochV1()));
  try {
    const injected = fsFailureInjectionV1?.onBeforeMarkerRename?.();
    if (injected) {
      throw injected;
    }
    await fs.promises.rename(claimPath, currentPath);
  } catch (error) {
    // The rename failed — the claim may still be sitting at `claimPath`
    // (a partial/failed rename never moves the source on most platforms,
    // but this must not assume that): clean it up rather than leaving it to
    // strand every future caller for this task.
    const cleanupError = await cleanupOwnClaimBestEffortV1(claimPath);
    return { outcome: "writeFailed", error: withCleanupFailureNotedV1(error as Error, cleanupError, claimPath) };
  }

  // Owner-local serialization queue: heartbeat and release for THIS handle
  // must never run concurrently with each other, or a heartbeat could rename
  // a marker release just unlinked (or vice versa).
  //
  // Non-blocking review suggestion (2026-09-08): `queue` itself must never
  // become a rejected promise. The original `queue = queue.then(fn)` made a
  // failed step's rejection the new `queue` — every LATER call chains via
  // `.then()` with no rejection handler, which passes a rejection straight
  // through without ever running `fn`. A single failed heartbeat (a real,
  // non-ENOENT rename error) would then permanently poison `release()` and
  // `handover()` for this handle: they would resolve to that same old
  // rejection without ever unlinking the marker, leaving it behind forever.
  // `enqueueV1` keeps the CALLER-facing promise for each step accurately
  // reflecting that step's own success/failure (so a failed heartbeat's
  // caller still sees the error), while the internal `queue` used purely for
  // sequencing always settles, so the next queued step still runs regardless
  // of how the previous one ended.
  let queue: Promise<void> = Promise.resolve();
  let released = false;

  function enqueueV1(fn: () => Promise<void>): Promise<void> {
    const step = queue.then(fn);
    queue = step.catch(() => undefined);
    return step;
  }

  const handle: WorkAdmissionHandleV1 = {
    ownerToken,
    taskFolderPath,
    commandId,
    purpose,
    heartbeat(): Promise<void> {
      return enqueueV1(async () => {
        if (released) {
          return;
        }
        const nextGeneration = currentGeneration + 1;
        const nextEpoch = freshEpochV1();
        const nextPath = path.join(dir, markerBasenameV1(ownerToken, nextGeneration, nextEpoch));
        try {
          const injected = fsFailureInjectionV1?.onBeforeHeartbeatRename?.();
          if (injected) {
            throw injected;
          }
          await fs.promises.rename(currentPath, nextPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            // Displaced: nothing in v1a removes another owner's marker, so
            // this should not happen in practice, but is not an error.
            return;
          }
          throw error;
        }
        currentGeneration = nextGeneration;
        currentPath = nextPath;
      });
    },
    release(): Promise<void> {
      return enqueueV1(() => releaseMarkerOnceV1());
    },
    handover(): Promise<void> {
      // See the interface doc comment: mechanically identical to `release()`
      // in v1a — same exact-filename unlink, same ENOENT-is-displaced
      // handling, same owner-local queue — distinguished only by call-site
      // intent (protection was handed off, not simply finished).
      return enqueueV1(() => releaseMarkerOnceV1());
    },
  };

  async function releaseMarkerOnceV1(): Promise<void> {
    if (released) {
      return;
    }
    released = true;
    localHandlesV1.delete(taskFolderPath);
    try {
      await fs.promises.unlink(currentPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      // Displaced — not an error.
    }
  }

  localHandlesV1.set(taskFolderPath, handle);
  return { outcome: "acquired", handle };
}

/**
 * Convenience wrapper: acquire admission, run `fn` while a heartbeat keeps
 * the marker fresh, and always release. Returns `undefined` (never throws
 * for the admission step itself) on `busy`/`writeFailed`, invoking
 * `onRefused` with the full outcome first so the caller can show a tailored
 * diagnostic — the interim `busy` policy requires naming the owner, age, and
 * path (module doc comment), not a generic "task is busy" message.
 */
export async function withWorkAdmissionV1<T>(
  params: {
    readonly taskFolderPath: string;
    readonly purpose: WorkAdmissionPurposeV1;
    readonly commandId: string;
    readonly onRefused: (outcome: WorkAdmissionBusyV1 | WorkAdmissionWriteFailedV1) => void;
  },
  fn: () => Promise<T>
): Promise<T | undefined> {
  const result = await acquireWorkAdmissionV1(params);
  if (result.outcome !== "acquired") {
    params.onRefused(result);
    return undefined;
  }
  const heartbeatTimer = setInterval(() => {
    void result.handle.heartbeat();
  }, WORK_ADMISSION_HEARTBEAT_INTERVAL_MS_V1);
  try {
    return await fn();
  } finally {
    clearInterval(heartbeatTimer);
    await result.handle.release();
  }
}
