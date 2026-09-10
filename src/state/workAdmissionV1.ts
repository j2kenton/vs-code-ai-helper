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
 *      Only one concurrent caller can win this create. A loser whose OWN
 *      `purpose` is not blocked by the current holder's recorded `purpose`
 *      (`markerBlocksAcquisitionV1` — concretely, an `admission`-purpose
 *      loser against a `pauseCommit` holder) polls the create
 *      (`CLAIM_CONTENTION_POLL_INTERVAL_MS_V1`) while that
 *      short-lived claim resolves one way or the other, bounded not by an
 *      arbitrary short timeout but by the SAME `WORK_ADMISSION_LIKELY_STALE_MS_V1`
 *      staleness threshold `describeClaimAsBlockerV1` already uses to judge a
 *      claim stale — so an ordinary (if slow, e.g. under AV-scan or disk
 *      contention) claim genesis is always waited out, and only a genuinely
 *      stale claim falls through to the interim `busy` diagnostic. "The loser
 *      should be the pause, not the round" holds at the claim stage, not only once a
 *      marker exists. Every other loser reads the winner's claim back as a
 *      `busy` diagnostic immediately, with no retry.
 *   2. Re-list the admission directory. If any marker (`admission.<token>.g
 *      <N>.<epoch>`) already exists whose recorded `purpose` blocks this
 *      caller's own (`markerBlocksAcquisitionV1` again — a `pauseCommit`
 *      marker never blocks a new `admission` acquisition) — a prior owner
 *      never released — the just-created claim file is removed (it is
 *      unambiguously this caller's own file) and the caller reports `busy`
 *      against the existing marker instead of completing genesis.
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
  /** The claim record's own unique id (`WorkAdmissionClaimInfoV1.claimId`),
   * exposed so a `pauseCommit` caller can bind it immutably to whatever it
   * commits while holding this handle (see `pauseTaskWithReasonForClaimV1`,
   * Part 1a step 4) — distinct from `ownerToken`, which identifies this
   * PROCESS's acquisition across heartbeat generations, not this specific
   * claim attempt. */
  readonly claimId: string;
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

/**
 * Format the interim `busy`/`writeFailed` work-admission diagnostic (v1
 * fixes item 1, Part 1a's interim policy) as a user-facing message — naming
 * the blocking owner, its age, and the marker path for `busy`, or the real
 * filesystem error for `writeFailed`, rather than a generic "task is busy".
 *
 * Co-located here rather than in `reviewActions.ts` (non-blocking review
 * suggestion, raised twice, 2026-09-08): it formats only this module's own
 * result types and has no dependency on anything else in that (large) file,
 * so keeping it there forced `resumeTask.ts` to import from
 * `reviewActions.ts` just for this one formatter.
 */
export function describeWorkAdmissionRefusalV1(outcome: WorkAdmissionBusyV1 | WorkAdmissionWriteFailedV1): string {
  if (outcome.outcome === "writeFailed") {
    return `Could not start this stage action: ${outcome.error.message}`;
  }
  const ageSeconds = Math.round(outcome.ageMs / 1000);
  const ownerDetail = outcome.owner
    ? `held by ${outcome.owner.commandId} (pid ${outcome.owner.pid} on ${outcome.owner.hostId})`
    : "held by an unreadable record";
  return (
    `This task already has a stage action in progress (${ownerDetail}, started ~${ageSeconds}s ago at ` +
    `${outcome.markerPath})${outcome.likelyStale ? " — this looks stale, but it is not reclaimed automatically." : ""}.`
  );
}

const processStartTimeV1 = Date.now() - Math.floor(process.uptime() * 1000);

/** Process-local registry of admission handles this window currently holds,
 * keyed by task folder path. Lets same-window callers answer "do I already
 * hold admission for this task" without a filesystem round trip, and backs
 * the synchronous half of `hasLiveWorkAdmissionBestEffortV1`. Also backs
 * `acquireOrAdoptWorkAdmissionV1`'s same-process handoff below. */
const localHandlesV1 = new Map<string, WorkAdmissionHandleV1>();

/**
 * Same-process PRE-genesis intent, keyed by task folder path to the set of
 * `ownerToken`s currently attempting `acquireWorkAdmissionV1` for it whose
 * genesis has not yet settled (durably acquired, busy, or writeFailed).
 *
 * 2026-09-09 review architectural blocker fix ("starting admission can still
 * lose to `pauseCommit`"): `acquireWorkAdmissionV1` computes `ownerToken`
 * synchronously but then AWAITS `resolveHostIdentityV1()` before writing
 * anything — mkdir, the claim file, everything — so for that whole gap a
 * command that is starting work is registered NOWHERE, neither in
 * `localHandlesV1` (not acquired yet) nor on disk (not written yet). A
 * same-process watchdog sweep's pre-check
 * (`isImpossibleActiveStateV1` → `hasLiveWorkAdmissionBestEffortV1`) run
 * during exactly that window sees nothing and can commit a pause on a task
 * that is, at that very moment, starting real work.
 *
 * This entry is added synchronously the instant `ownerToken` exists — before
 * the first `await` — and removed in a `finally` covering every exit path of
 * `acquireWorkAdmissionV1` (acquired, busy, or writeFailed all clear it: once
 * genesis settles, durable state — a marker, or nothing — is the source of
 * truth again). Because Node runs synchronous code to completion before any
 * other callback gets a turn, this registration is guaranteed to land before
 * a same-process sweep's next check, closing the gap for the common single-
 * window case; a cross-window sweep can only ever observe durable state, so
 * that residual race is left to 1b/1c as documented in the module's own
 * genesis notes.
 */
const localPendingIntentsV1 = new Map<string, Set<string>>();

function registerPendingIntentV1(taskFolderPath: string, ownerToken: string): void {
  const existing = localPendingIntentsV1.get(taskFolderPath);
  if (existing) {
    existing.add(ownerToken);
  } else {
    localPendingIntentsV1.set(taskFolderPath, new Set([ownerToken]));
  }
}

function clearPendingIntentV1(taskFolderPath: string, ownerToken: string): void {
  const existing = localPendingIntentsV1.get(taskFolderPath);
  if (!existing) {
    return;
  }
  existing.delete(ownerToken);
  if (existing.size === 0) {
    localPendingIntentsV1.delete(taskFolderPath);
  }
}

/** True when some OTHER same-process caller (not `excludedOwnerToken`, when
 * supplied) currently has a pre-genesis admission attempt in flight for this
 * task. See `localPendingIntentsV1`'s doc comment. */
function hasPendingIntentV1(taskFolderPath: string, excludedOwnerToken?: string): boolean {
  const tokens = localPendingIntentsV1.get(taskFolderPath);
  if (!tokens || tokens.size === 0) {
    return false;
  }
  if (excludedOwnerToken === undefined) {
    return true;
  }
  for (const token of tokens) {
    if (token !== excludedOwnerToken) {
      return true;
    }
  }
  return false;
}

/**
 * Total outstanding in-process holders of one task's live marker — the
 * original acquirer plus every adopted view created by
 * `acquireOrAdoptWorkAdmissionV1` that has not yet released. Absent is read
 * as 1 (just the original acquirer, no adoption has happened). Every release
 * — the original handle's own, or any adopted view's — decrements this by
 * one; only the release that brings it to zero actually unlinks the marker,
 * via `localReleaseFinalizersV1` below. This is what lets a resume flow hold
 * admission continuously across a downstream dispatch that itself also
 * acquires admission for the same task in the same process (2026-09-08
 * review completion blocker: releasing before dispatch left a real gap with
 * no admission and no arranged work; holding across dispatch without this
 * would instead make the downstream acquisition observe a live marker it
 * does not own and refuse with `busy`).
 */
const localHolderCountsV1 = new Map<string, number>();

/** The live marker's actual unlink-when-last-holder-releases logic for a
 * task, captured once at genesis (it closes over that acquisition's mutable
 * `currentPath`, which heartbeats advance) so an adopted view — created
 * later, outside that closure — can trigger the real unlink without ever
 * needing filesystem details of its own. Removed once the marker is
 * actually unlinked. */
const localReleaseFinalizersV1 = new Map<string, () => Promise<void>>();

/**
 * One FIFO serializer per task, shared by the base handle AND every adopted
 * view created over it — the same closure `acquireWorkAdmissionV1` already
 * builds for its own `heartbeat()`/`release()`/`handover()`, additionally
 * registered here so `createAdoptedViewV1` can enqueue its release through
 * that SAME queue instead of calling the finalizer directly.
 *
 * Completion blocker fix (2026-09-08 review): an adopted view's `release()`
 * previously called `localReleaseFinalizersV1`'s finalizer straight away,
 * outside any queue. If the base handle (or another adopted view) had an
 * in-flight heartbeat rename at that moment, the two could race: unlink
 * could observe the marker at its OLD path (ENOENT, swallowed as
 * "displaced") a moment before the heartbeat's rename landed at the NEW
 * path, leaving that renamed file behind forever — a leaked marker under
 * v1a's interim never-reclaim policy, i.e. the task stays "busy" permanently.
 * Routing every release through this shared queue means the unlink can only
 * run after every heartbeat enqueued before it has settled, and any
 * heartbeat that loses the race and gets enqueued AFTER the unlink simply
 * finds `currentPath` gone and treats it as an ordinary displaced-marker
 * ENOENT (already-handled, non-error) instead of racing it.
 *
 * Removed at the same moment as `localReleaseFinalizersV1`'s entry, once the
 * marker is actually unlinked.
 */
const localSerializersV1 = new Map<string, (fn: () => Promise<void>) => Promise<void>>();

/**
 * Per-task single-use handoff authorization (2026-09-08 review architectural
 * blocker fix). `acquireOrAdoptWorkAdmissionV1` used to adopt an already-live
 * SAME-PROCESS marker for ANY caller in the same extension host, which
 * defeats single-owner admission for a task the moment two unrelated
 * commands for it happen to run in the same window — exactly the
 * cross-process exclusivity `acquireWorkAdmissionV1` otherwise guarantees.
 *
 * A resume-then-dispatch flow (`resumeTask.ts`'s `resumeThenDispatchV1`) is
 * the only legitimate adopter: it already holds admission and is about to
 * make exactly ONE specific downstream dispatch on its own behalf. It calls
 * `authorizeWorkAdmissionHandoffV1` immediately before that dispatch and
 * threads the returned token through the dispatched command's own arguments
 * (see `reviewActions.ts`'s `admissionHandoffTokenV1` arg field); the
 * downstream command's own admission-acquisition call passes that token back
 * in. Adoption succeeds ONLY when the token presented matches the one
 * currently authorized for that exact task, and the token is consumed
 * (deleted) the instant it is used, so it can authorize at most one adoption.
 * Any other same-process caller — a concurrent unrelated invocation, or a
 * stale/already-consumed token — presents no token or a non-matching one and
 * falls through to the ordinary `acquireWorkAdmissionV1` genesis path, which
 * observes the live marker on disk and is correctly refused `busy`, exactly
 * like a cross-process caller.
 */
const pendingHandoffTokensV1 = new Map<string, string>();

/**
 * Authorize exactly one same-process adoption of `taskFolderPath`'s
 * currently-held admission marker, returning the single-use token the
 * intended downstream dispatch must present to `acquireOrAdoptWorkAdmissionV1`.
 * Overwrites (invalidates) any previous unconsumed token for the same task —
 * only the most recently authorized handoff is honored, matching "about to
 * make exactly one specific dispatch".
 */
export function authorizeWorkAdmissionHandoffV1(taskFolderPath: string): string {
  const token = crypto.randomUUID();
  pendingHandoffTokensV1.set(taskFolderPath, token);
  return token;
}

/**
 * Invalidate any outstanding, unconsumed handoff token for `taskFolderPath`.
 * Called once the resume-then-dispatch flow's own dispatch has settled
 * (successfully consumed or not), so a token never outlives the single
 * dispatch it was minted for. A no-op if already consumed or never issued.
 */
export function revokeWorkAdmissionHandoffV1(taskFolderPath: string): void {
  pendingHandoffTokensV1.delete(taskFolderPath);
}

/**
 * Test-only override for the real directory a task's admission directory is
 * rooted under. Production behavior (the default, `undefined`) roots
 * `admission-v1/` directly inside the real task folder — but a test that
 * exercises this module only through a PLACEHOLDER `taskFolderPath` (not a
 * real directory on disk, e.g. a fixture like `"C:\\tasks\\task"` used by
 * `scheduleTaskResume.test.ts`'s watchdog-sweep coverage) must not let this
 * module's real `mkdir`/`writeFile`/`rename` calls land on that arbitrary,
 * non-task-owned host path. Every disk path this module computes goes
 * through `admissionDirV1` below, so installing a resolver here redirects
 * ALL of them at once; every process-local registry in this module (keyed by
 * the ORIGINAL `taskFolderPath`, never the resolved disk root) is unaffected.
 */
let admissionRootOverrideV1: ((taskFolderPath: string) => string) | undefined;
export function setWorkAdmissionRootOverrideForTestV1(
  resolver: ((taskFolderPath: string) => string) | undefined
): void {
  admissionRootOverrideV1 = resolver;
}

function admissionDirV1(taskFolderPath: string): string {
  const root = admissionRootOverrideV1 ? admissionRootOverrideV1(taskFolderPath) : taskFolderPath;
  return path.join(root, ADMISSION_DIRNAME_V1);
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
  if (hasPendingIntentV1(taskFolderPath)) {
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

/**
 * Liveness check for a caller that ALREADY holds a live marker of its own
 * (`excludedOwnerToken`) and wants to know whether a DIFFERENT admission is
 * live — used by the watchdog sweep's `pauseCommit` commit protocol
 * (`scheduleTaskResume.ts`, v1 fixes item 1, Part 1a step 4) so a sweep
 * holding its own `pauseCommit` marker can check "did an unrelated admission
 * arrive" without perpetually seeing its own transitional lock as that
 * unrelated admission and refusing to ever commit.
 *
 * Deliberately checks MARKERS ONLY, never the shared `admission.claim` staging
 * file — unlike `hasLiveWorkAdmissionBestEffortV1`, whose claim-file check is
 * right for its OWN callers (deciding whether to touch the task at all, where
 * "any genesis might be in flight" must fail open). Here the caller already
 * holds a published marker, and the shared claim filename is exclusive: any
 * OTHER `admission.claim` this call observes can only have been created
 * AFTER the caller's own claim vacated that name (by publishing its marker) —
 * every invariant `acquireWorkAdmissionV1` enforces guarantees such a
 * contender will see the caller's marker during its own re-list step and
 * back off `busy`, never complete genesis, while the caller's marker exists.
 * Treating that transient, already-doomed claim file as "live" here is a pure
 * false positive: it caused exactly this — a sweep reversing its own just-
 * committed pause because a losing contender's SHARED claim file was still on
 * disk at the instant of the check (2026-09-09, caught by
 * "armAll's watchdog GENERIC route ... is also race-safe across two
 * concurrently-sweeping windows", which requires exactly one of two racing
 * sweeps to end up paused — the self-reversal made both end up active).
 *
 * `ownerToken` is unique per acquisition and embedded in every marker
 * filename that acquisition publishes, so this can never accidentally
 * exclude a DIFFERENT owner's marker.
 */
export function hasLiveWorkAdmissionExcludingOwnerV1(taskFolderPath: string, excludedOwnerToken: string): boolean {
  const local = localHandlesV1.get(taskFolderPath);
  if (local && local.ownerToken !== excludedOwnerToken) {
    return true;
  }
  // A different same-process caller's pre-genesis attempt counts as "unrelated
  // live work arriving" too (see `localPendingIntentsV1`'s doc comment) — this
  // is what lets the sweep's pre-write and post-write checks catch a command
  // that started admission in the narrow window before its own marker landed
  // on disk, not just after.
  if (hasPendingIntentV1(taskFolderPath, excludedOwnerToken)) {
    return true;
  }
  const dir = admissionDirV1(taskFolderPath);
  try {
    return listMarkersSyncV1(dir).some((marker) => {
      const parsed = parseMarkerBasenameV1(marker.basename);
      return parsed === undefined || parsed.ownerToken !== excludedOwnerToken;
    });
  } catch {
    return true;
  }
}

/**
 * Same-process count of commands currently resolving WHICH task they target,
 * before that target is known — the window `runPublishChecks.ts`,
 * `commitAndPushTask.ts` and `completeCommitAndPushTask` all cross between
 * `TaskCreationStartupReconcilerV1.waitUntilReady()` and the moment
 * `resolveTaskContext`'s `onResolvedCandidate` hook fires (2026-09-10 review,
 * narrowed completion blocker: a refresh-discovered actual target — one no
 * synchronous pre-refresh peek could have guessed — has no task folder path
 * to admit until resolution itself, including its own awaited
 * `inventory.refresh()`, has already run). Per-task admission cannot protect
 * a task whose identity is not yet known; this is a coarser same-process
 * stand-down that covers the whole window regardless of which task turns out
 * to be the target, in exchange for pausing the sweep's ENTIRE pass rather
 * than just one task's. The setup-phase race this closes is fundamentally a
 * same-window race (the file watcher and the 5-minute timer both arm the
 * sweep in the same extension host the resolving command is running in),
 * exactly like the `localPendingIntentsV1` gap this mirrors — this counter
 * alone is never durable and never visible cross-window.
 *
 * 2026-09-10 review completion blocker (new): a SECOND window sweeping the
 * SAME workspace while this window resolves has no way to observe this
 * in-process counter at all, and could pause a task this window is about to
 * admit before this window's own `onResolvedCandidate` hook ever runs.
 * `durableResolutionMarkersV1` below closes that gap with a best-effort
 * cross-window signal, layered on top of (never replacing) this counter.
 */
let resolutionInFlightCountV1 = 0;

/**
 * Process-local, reference-counted durable admission markers backing the
 * cross-window half of target resolution — keyed by task ROOT path (e.g. the
 * `.ensemble` directory itself), never by an individual task folder path,
 * because the whole point is that no task folder path is known yet. Held at
 * `<rootPath>/admission-v1/`, a directory distinct from and never contended
 * by any real per-task admission marker (which always lives one level down,
 * inside a specific task's own folder).
 *
 * Reference-counted per root so that several resolutions running
 * concurrently IN THIS WINDOW (e.g. Publish checks and Commit/Push triggered
 * moments apart) share one on-disk marker instead of contending with each
 * other for it — `purpose: "admission"` always blocks another `admission`
 * acquisition at the same path, including this module's own, so a second
 * concurrent `beginTargetResolutionV1` call in this window would otherwise
 * see its own root marker as `busy`. A DIFFERENT window's concurrent
 * resolution can still see `busy` here and end up holding no durable marker
 * of its own — accepted as a rare, narrow residual gap (documented on
 * `beginTargetResolutionV1` itself): that other window's own
 * `resolutionInFlightCountV1` still protects ITS sweep, and by the time a
 * cross-window pause could land, this marker (acquired by whichever window
 * got there first) is very likely still held, since resolution windows are
 * short and release only after the acquiring window's own resolution ends.
 */
const durableResolutionMarkersV1 = new Map<string, { handle: WorkAdmissionHandleV1; refCount: number }>();

/** Opaque handle returned by `beginTargetResolutionV1`, threaded back into
 * the matching `endTargetResolutionV1` call so it releases exactly the
 * durable root markers this call acquired (or reused) — never a different
 * caller's. */
export interface TargetResolutionHandleV1 {
  readonly rootPaths: readonly string[];
}

/**
 * Call before `waitUntilReady()`/`resolveTaskContext` when the eventual
 * target folder path is not yet known synchronously. Always pair with an
 * awaited `endTargetResolutionV1(handle)` in a `finally`, passing back the
 * handle this call returns — see that function's doc comment.
 *
 * `taskRootPaths` (default: none) are the currently open workspace's task
 * root candidates (`resolveTaskRootCandidates().map(c => c.absolutePath)`,
 * computed by the caller — this module stays free of the VS Code API). For
 * each one, this best-effort acquires (or reuses, if this window already
 * holds one) a durable admission marker at that root, so a SECOND window's
 * sweep can observe resolution-in-flight on disk, not just in this process.
 * A root whose marker could not be acquired (busy, or a real write failure)
 * is silently skipped — this cross-window signal is pure defense-in-depth
 * layered on the durable `resolutionInFlightCountV1` bump above, which always
 * happens synchronously regardless of what happens here, and it must never
 * block or fail the caller's own resolution.
 */
export async function beginTargetResolutionV1(
  taskRootPaths: readonly string[] = []
): Promise<TargetResolutionHandleV1> {
  resolutionInFlightCountV1 += 1;
  const acquiredRoots: string[] = [];
  for (const rootPath of taskRootPaths) {
    const existing = durableResolutionMarkersV1.get(rootPath);
    if (existing) {
      existing.refCount += 1;
      acquiredRoots.push(rootPath);
      continue;
    }
    try {
      const result = await acquireWorkAdmissionV1({
        taskFolderPath: rootPath,
        purpose: "admission",
        commandId: "resolutionInFlight",
      });
      if (result.outcome === "acquired") {
        durableResolutionMarkersV1.set(rootPath, { handle: result.handle, refCount: 1 });
        acquiredRoots.push(rootPath);
      }
    } catch {
      // Best-effort — never let a durable-marker failure block resolution.
    }
  }
  return { rootPaths: acquiredRoots };
}

/**
 * Ends one `beginTargetResolutionV1()` window: always decrements the
 * same-process counter (clamped at zero, so a caller need not track whether
 * `begin` ran on every exit path), and — when `handle` is the value that
 * call returned — releases this caller's share of each durable root marker,
 * actually removing it from disk only once every concurrent same-window
 * holder has released its own share.
 */
export async function endTargetResolutionV1(handle?: TargetResolutionHandleV1): Promise<void> {
  resolutionInFlightCountV1 = Math.max(0, resolutionInFlightCountV1 - 1);
  if (!handle) {
    return;
  }
  for (const rootPath of handle.rootPaths) {
    const entry = durableResolutionMarkersV1.get(rootPath);
    if (!entry) {
      continue;
    }
    entry.refCount -= 1;
    if (entry.refCount <= 0) {
      durableResolutionMarkersV1.delete(rootPath);
      try {
        await entry.handle.release();
      } catch {
        // Best-effort — a stuck marker here just means the interim fail-open
        // policy (module doc comment) stands other windows' sweeps down for
        // this root until it ages out, never that anything gets paused
        // wrongly.
      }
    }
  }
}

/** True while ANY same-process command is between `beginTargetResolutionV1()`
 * and `endTargetResolutionV1()` — see the counter's own doc comment. The
 * watchdog sweep (`scheduleTaskResume.ts`'s `detectAndRepairStalledActiveTasksV1`)
 * stands its ENTIRE pause pass down while this is true, the same fail-open
 * direction as every other watchdog exemption in this module: an extra
 * skipped sweep costs nothing (the very next sweep re-evaluates from
 * scratch), while pausing mid-resolution is the exact trap this task exists
 * to close. */
export function hasResolutionInFlightBestEffortV1(): boolean {
  return resolutionInFlightCountV1 > 0;
}

/**
 * Cross-window counterpart to `hasResolutionInFlightBestEffortV1`: true when
 * ANY task root candidate in `taskRootPaths` has a live durable admission
 * marker or claim on disk — from THIS window's own `durableResolutionMarkersV1`
 * (the process-local fast path `hasLiveWorkAdmissionBestEffortV1` already
 * takes) or, cross-window, one a DIFFERENT window's resolution published.
 * The watchdog sweep should stand its whole pass down (same as the
 * same-process check) whenever this is true, so a second window's
 * in-flight-but-not-yet-per-task-admitted resolution is never paused
 * underneath it.
 */
export function hasDurableResolutionInFlightV1(taskRootPaths: readonly string[]): boolean {
  return taskRootPaths.some((rootPath) => hasLiveWorkAdmissionBestEffortV1(rootPath));
}

/** Test-only reset, mirroring this module's other `*ForTestV1` escape
 * hatches — clears the counter between tests regardless of how many
 * begin/end calls a failed assertion left unbalanced. Does not touch
 * `durableResolutionMarkersV1`: no test exercises non-empty `taskRootPaths`
 * without pairing its own `begin`/`end` calls, so the map is always empty
 * between tests already. */
export function resetTargetResolutionForTestV1(): void {
  resolutionInFlightCountV1 = 0;
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

/** Build a `busy` diagnostic directly from the shared claim file, or
 * `undefined` when it no longer exists. Used by the claim-write retry loop
 * (`acquireWorkAdmissionCoreV1`) both for an immediately-confirmed blocking
 * purpose and for its retry-exhausted fallback — see
 * `describeClaimRetryExhaustedBlockerV1`'s doc comment for why the claim
 * itself is always reported regardless of purpose, unlike a marker. */
function describeClaimAsBlockerV1(claimPath: string, now: number): WorkAdmissionBusyV1 | undefined {
  let claimStat: fs.Stats;
  try {
    claimStat = fs.statSync(claimPath);
  } catch {
    return undefined;
  }
  return {
    outcome: "busy",
    owner: readClaimInfoSyncV1(claimPath),
    markerPath: claimPath,
    ageMs: now - claimStat.mtimeMs,
    likelyStale: now - claimStat.mtimeMs > WORK_ADMISSION_LIKELY_STALE_MS_V1,
  };
}

/**
 * Purpose-aware diagnostic for the claim-write retry loop, called once its
 * elapsed-time budget (the claim's own age against
 * `WORK_ADMISSION_LIKELY_STALE_MS_V1`) is exhausted. Despite the name, an
 * `undefined` result here is NOT terminal: the caller
 * (`acquireWorkAdmissionCoreV1`) treats it as "the path is free right now"
 * and retries the write itself, bounded separately by
 * `postExhaustionRetryStillFresh`'s own independently-anchored elapsed-time
 * budget (not more retries of `claimContentionStillFresh`, which is
 * guaranteed already false here — see that call site's doc comment) so
 * continuous churn (a new contender appearing on every attempt) still
 * terminates. Only a defined result ends the attempt.
 *
 * 2026-09-09 review architectural blocker (narrowed remainder, second half):
 * the shared `admission.claim` file, if STILL PHYSICALLY PRESENT after the
 * entire retry window, is always reported as the blocker regardless of its
 * recorded purpose — it has occupied the one fixed filename our own write
 * needs for the whole window, so by this point it is a real, present
 * obstruction, not a hypothetical one the retry loop was right to wait out.
 * Only once the claim has actually vanished (renamed away to a marker, or
 * removed) does purpose filtering apply, and only to markers — a live marker
 * whose recorded purpose does not block `acquiringPurpose`
 * (`markerBlocksAcquisitionV1`) is not a blocker at all, exactly like the
 * `blockingMarkers` filter `acquireWorkAdmissionCoreV1` applies a few lines
 * below this loop. Without this marker-side filtering, a `pauseCommit` claim
 * that resolved into its own (non-blocking) marker in the narrow window
 * between our failed `EEXIST` and this diagnostic call was misreported as
 * busy purely because SOME marker existed, with no purpose check at all —
 * reproducing "the pause wins" at the exhaustion step even though the
 * ordinary retry path above already fixed the common case.
 */
function describeClaimRetryExhaustedBlockerV1(
  taskFolderPath: string,
  acquiringPurpose: WorkAdmissionPurposeV1,
  now: number
): WorkAdmissionBusyV1 | undefined {
  const dir = admissionDirV1(taskFolderPath);
  const claimPath = path.join(dir, CLAIM_FILENAME_V1);
  const claimBlocker = describeClaimAsBlockerV1(claimPath, now);
  if (claimBlocker) {
    return claimBlocker;
  }
  const blockingMarker = listMarkersSyncV1(dir).find((marker) =>
    markerBlocksAcquisitionV1(readClaimInfoSyncV1(marker.filePath)?.purpose, acquiringPurpose)
  );
  return blockingMarker ? describeMarkerAsBlockerV1(blockingMarker.filePath, now) : undefined;
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

/**
 * Poll interval between retries of the shared `admission.claim` exclusive
 * create, used ONLY while the current holder's own recorded purpose does not
 * block ours (`markerBlocksAcquisitionV1` — a `pauseCommit` claim contending
 * against an `admission`-purpose acquirer). This is a poll CADENCE, not a
 * completion budget — the budget is elapsed real time against
 * `WORK_ADMISSION_LIKELY_STALE_MS_V1`, below.
 *
 * 2026-09-09 review architectural blocker (narrowed remainder): purpose-aware
 * filtering already exempts a live `pauseCommit` MARKER from blocking a new
 * `admission` acquisition, but the fixed, SHARED `admission.claim` filename
 * that every genesis briefly holds before it either renames to a marker or
 * backs off was still purpose-BLIND — a work-starting command that lost the
 * exclusive-create race against the sweep's `pauseCommit` claim was refused
 * immediately, with no retry, exactly reproducing "the pause wins" even
 * though the marker-level fix already guarantees "the pause should lose".
 *
 * 2026-09-09 review architectural blocker (fourth round): the first fix
 * bounded the retry by a fixed ~1 second delay schedule, reasoned from "the
 * sweep's own hold on this claim has no awaited step besides its own fast
 * filesystem calls." That reasoning is true of the LOGICAL steps (write, a
 * synchronous relist, then rename-to-marker or claim-cleanup), but not of
 * their WALL-CLOCK cost — each of those calls can individually be delayed
 * well past a second by ordinary, non-crashed contention (the same
 * antivirus/indexer interference `CLAIM_CLEANUP_RETRY_DELAYS_MS_V1`'s own
 * doc comment already names for the cleanup unlink). A ~1 second budget is
 * therefore still an arbitrary timeout the plan never approved as a
 * substitute for "the pause loses regardless of ordinary filesystem timing" —
 * it can make a healthy, still-in-flight `pauseCommit` claim look busy. The
 * retry loop now polls at this cadence for as long as the claim's own age
 * stays under `WORK_ADMISSION_LIKELY_STALE_MS_V1` — the SAME named staleness
 * threshold `describeClaimAsBlockerV1` already uses to decide whether a
 * claim record looks stale — so a claim is only ever given up on once it
 * would ALSO be diagnosed as stale, never merely because it outlasted a
 * short, unrelated wall-clock guess. A genuinely crashed/stuck claim still
 * falls through to the ordinary interim fail-open `busy` diagnostic once it
 * crosses that same threshold, per Part 1a step 2's interim policy — this
 * never retries forever.
 */
const CLAIM_CONTENTION_POLL_INTERVAL_MS_V1 = 100;

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
  /** 2026-09-09 review architectural blocker (third round): a side-effect-only
   * seam (no return value — this is not a failure to inject, it is a race to
   * simulate) fired immediately before the claim-write retry loop's exhaustion
   * diagnostic (`describeClaimRetryExhaustedBlockerV1`) runs. It exists to
   * deterministically reproduce the one window that is otherwise impossible to
   * hit with real timers: between the loop's final failed exclusive-create and
   * its synchronous exhaustion diagnostic there is no `await`, so no other
   * async callback (including a `setTimeout`-based test) can ever execute
   * "during" it — only a hook invoked from inside that same synchronous
   * stretch can land there. A test uses it to rename a still-present claim
   * into a non-blocking marker at exactly that instant, proving the loop
   * retries the write afterward instead of surfacing a terminal `writeFailed`
   * for an obstruction that had already cleared. */
  readonly onBeforeClaimRetryExhaustionDiagnosis?: () => void;
}
let fsFailureInjectionV1: WorkAdmissionFsFailureInjectionV1 | undefined;
export function setWorkAdmissionFsFailureInjectionForTestV1(injection: WorkAdmissionFsFailureInjectionV1 | undefined): void {
  fsFailureInjectionV1 = injection;
}

/**
 * Injectable time source for the claim-contention retry loop's elapsed-time
 * bound (`WORK_ADMISSION_LIKELY_STALE_MS_V1`). Defaults to the real clock;
 * tests override it so the loop's "genuinely stale" branch is reachable
 * deterministically without an actual ~20-minute wait — see
 * `setWorkAdmissionClockForTestV1`'s own call sites for how. Scoped to this
 * one retry loop's `now()` calls only, not a general clock abstraction for
 * the module.
 */
let nowV1: () => number = () => Date.now();
export function setWorkAdmissionClockForTestV1(clock: (() => number) | undefined): void {
  nowV1 = clock ?? ((): number => Date.now());
}

/**
 * True when `markerPurpose` (a live marker's OR a live claim's own recorded
 * `purpose` — this is shared by both callers below, `undefined` when the
 * record is unreadable/corrupt) should block a NEW acquisition attempt for
 * `acquiringPurpose`.
 *
 * 2026-09-09 review architectural blocker fix ("starting admission can still
 * lose to `pauseCommit`"): a `pauseCommit` marker (or the shared
 * `admission.claim` file while a `pauseCommit` genesis is briefly mid-flight)
 * is the watchdog sweep's own SHORT-LIVED transitional commit lock, never
 * real work — the plan's own contract is "the loser should be the pause, not
 * the round", so a command starting real work (`purpose: "admission"`) must
 * not be turned away just because the sweep happens to be mid-commit. Against
 * a live MARKER, it proceeds immediately to publish its own marker alongside
 * the sweep's; the sweep's own pre-write/post-write checks
 * (`hasLiveWorkAdmissionExcludingOwnerV1`, which this filtering does NOT
 * apply to — that function intentionally treats ANY other marker as live) are
 * what then catch the command's marker and reverse an in-flight or already-
 * committed pause. Against the shared `admission.claim` file itself — the
 * narrower remainder of the same blocker, fixed separately in
 * `acquireWorkAdmissionCoreV1`'s claim-write loop — a non-blocked loser
 * instead RETRIES the exclusive create for a bounded window while the
 * sweep's claim resolves (to a marker, or to nothing), rather than treating
 * the claim's mere existence as an immediate, permanent `busy`. Without
 * either half, the command was refused `busy` immediately, never got to
 * publish anything, and the sweep's reversal check had nothing left to find —
 * precisely the observed bug.
 *
 * A `pauseCommit` marker or claim still blocks another `pauseCommit`
 * acquisition (prevents two concurrent sweep commits), and an
 * `admission`-purpose marker or claim (or an unreadable one — conservative
 * default) always blocks everything, as before.
 */
function markerBlocksAcquisitionV1(
  markerPurpose: WorkAdmissionPurposeV1 | undefined,
  acquiringPurpose: WorkAdmissionPurposeV1
): boolean {
  if (markerPurpose === "pauseCommit") {
    return acquiringPurpose === "pauseCommit";
  }
  return true;
}

/**
 * Acquire durable work admission for `taskFolderPath`, running the genesis
 * flow described in the module doc comment. Never throws — filesystem
 * failures during the claim/rename sequence resolve to `writeFailed` with
 * the real underlying error, kept distinct from an ordinary `busy` (someone
 * else already owns admission) so a caller can tell "I could not even try"
 * from "someone got there first".
 *
 * Registers this attempt's `ownerToken` in `localPendingIntentsV1`
 * SYNCHRONOUSLY, before the first `await`, and clears it in `finally` — see
 * that map's doc comment for why (closes the pre-genesis race a same-process
 * watchdog sweep could otherwise win).
 */
export async function acquireWorkAdmissionV1(params: {
  readonly taskFolderPath: string;
  readonly purpose: WorkAdmissionPurposeV1;
  readonly commandId: string;
}): Promise<WorkAdmissionResultV1> {
  const ownerToken = `${process.pid.toString(36)}-${crypto.randomBytes(6).toString("hex")}`;
  registerPendingIntentV1(params.taskFolderPath, ownerToken);
  try {
    return await acquireWorkAdmissionCoreV1(params, ownerToken);
  } finally {
    clearPendingIntentV1(params.taskFolderPath, ownerToken);
  }
}

async function acquireWorkAdmissionCoreV1(
  params: {
    readonly taskFolderPath: string;
    readonly purpose: WorkAdmissionPurposeV1;
    readonly commandId: string;
  },
  ownerToken: string
): Promise<WorkAdmissionResultV1> {
  const { taskFolderPath, purpose, commandId } = params;
  const dir = admissionDirV1(taskFolderPath);
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

  // 2026-09-09 review architectural blocker (narrowed remainder): retry the
  // shared, fixed-path `admission.claim` exclusive create when — and only
  // when — its CURRENT holder's own recorded purpose does not block ours
  // (`markerBlocksAcquisitionV1`, the same rule already applied to markers
  // below). This is what makes "the loser should be the pause, not the
  // round" hold at the claim stage too, not just once a marker exists: a
  // work-starting `admission` acquirer that loses the exclusive-create race
  // against the sweep's short-lived `pauseCommit` claim polls
  // (`CLAIM_CONTENTION_POLL_INTERVAL_MS_V1`) for that claim to resolve
  // (rename to a marker, or vacate on its own busy backoff) instead of being
  // refused immediately — for as long as the claim would not yet be judged
  // stale (`WORK_ADMISSION_LIKELY_STALE_MS_V1`), not merely a short fixed
  // delay. Any OTHER contention — an `admission` claim already owns it,
  // another `pauseCommit` attempt is racing this one — blocks immediately,
  // with no retry.
  //
  // 2026-09-09 review architectural blocker (further narrowed, second
  // round): `readClaimInfoSyncV1` returns `undefined` for BOTH "the claim is
  // gone" and "the claim is present but its JSON is mid-write/corrupt" —
  // there is no way to tell those apart from a failed read alone. The
  // previous version fed that `undefined` straight into
  // `markerBlocksAcquisitionV1`, which conservatively treats an unreadable
  // purpose as blocking everything — so a claim caught mid-initialization
  // was terminal on the very first `EEXIST`, with no retry at all, even
  // though the write finishing (as it almost always does within
  // milliseconds) would have revealed a harmless, non-blocking `pauseCommit`
  // purpose. Only a SUCCESSFULLY READ purpose that positively conflicts with
  // ours is treated as a confirmed, non-resolving blocker now; a read
  // failure is treated the same as a known non-blocking purpose — ambiguous,
  // and worth waiting out — so a transiently unreadable claim gets the same
  // retry budget as a transiently non-blocking one.
  // 2026-09-09 review architectural blocker (third round, remainder): once the
  // retry budget below is spent, the obstruction can still resolve (to
  // nothing, or to a marker whose purpose does not block us) in the narrow,
  // synchronous window between the loop's final failed exclusive-create and
  // its own exhaustion diagnostic — there is no `await` in that stretch, so a
  // real timer can never land "during" it, but it is a real gap all the same.
  // `describeClaimRetryExhaustedBlockerV1` returning `undefined` there means
  // the shared claim path is free RIGHT NOW; the correct response is to retry
  // the write immediately (nothing is blocking it), not to surface a terminal
  // `writeFailed` for an obstruction that already cleared.
  //
  // 2026-09-09 review architectural blocker (fourth round): the ambiguous-
  // claim wait above used to be bounded by a small, hand-picked ~1 second
  // delay schedule — an arbitrary timeout the plan never approved as a
  // stand-in for "the pause loses regardless of ordinary filesystem timing."
  // It is now bounded by elapsed real time against the SAME
  // `WORK_ADMISSION_LIKELY_STALE_MS_V1` staleness threshold
  // `describeClaimAsBlockerV1` already uses to judge a claim record stale —
  // captured once via the (test-overridable) `nowV1()` before this loop
  // begins — so a claim is only ever given up on once it would ALSO be
  // diagnosed as stale, never merely because it outlasted a short,
  // disconnected wall-clock guess.
  //
  // 2026-09-09 review architectural blocker (fifth round): the
  // post-exhaustion-diagnosis retry below (for the "nothing is blocking us
  // right now" case, including a BLOCKING claim that vanished between the
  // purpose read and the stat) used to be bounded by a small fixed COUNT
  // (5) instead of this same elapsed-time check, on the reasoning that
  // reusing the staleness window would let rapid churn spin the event loop.
  // That bound fired on genuinely fast, repeated vanish/recontend cycles —
  // ordinary contention among legitimate acquirers, not a runaway loop —
  // and turned it into a fabricated `writeFailed`, contradicting "the pause
  // loses regardless of ordinary filesystem timing" at exactly the boundary
  // that phrase is meant to cover. It is now bounded by the SAME elapsed-time
  // check as the ambiguous-wait branch above, with a poll delay
  // (`CLAIM_CONTENTION_POLL_INTERVAL_MS_V1`) before each retry — the delay is
  // what keeps this from spinning the event loop, not a short attempt count,
  // so ordinary contention is never mistaken for a stuck/dead claim merely
  // because it churned a few times quickly.
  //
  // 2026-09-09 review architectural blocker (sixth round): reusing the SAME
  // `claimContentionStillFresh()` predicate for the post-exhaustion retry was
  // itself wrong, not just its earlier fixed-count predecessor — that branch
  // is ONLY EVER REACHED once `claimContentionStillFresh()` has already
  // turned false (that is precisely what triggers the exhaustion diagnosis a
  // few lines above it), so re-checking the identical predicate immediately
  // afterward is checking something already known false. The branch could
  // never retry; every path through it fell straight to the terminal
  // `writeFailed`, regardless of whether the diagnosis found a real blocker —
  // reproducing "the pause wins" one boundary later than the fifth round's
  // fix believed it had closed. A dedicated regression test
  // (`workAdmissionV1.test.ts`, "retries the write when its own exhaustion
  // diagnostic is raced...") demonstrates this directly: the injected race
  // clears the obstruction, the diagnosis correctly reports no blocker, and
  // the old code still returned `writeFailed`.
  //
  // The post-exhaustion retry now uses its OWN independently-anchored
  // elapsed-time budget (`postExhaustionRetryStillFresh`, lazily started the
  // first time it is consulted — i.e. the moment exhaustion is first
  // reached), not the already-expired `claimContentionStillFresh` window. It
  // reuses the same `WORK_ADMISSION_LIKELY_STALE_MS_V1` duration — still no
  // arbitrary short timeout, per the plan's "the pause loses regardless of
  // ordinary filesystem timing" — but measured from a start time that can
  // actually still be fresh when consulted, so legitimate rapid churn
  // (a contender resolving and a new one appearing) gets a real window to
  // settle instead of a branch that was dead on arrival.
  const claimContentionStartedAtMs = nowV1();
  const claimContentionStillFresh = (): boolean =>
    nowV1() - claimContentionStartedAtMs < WORK_ADMISSION_LIKELY_STALE_MS_V1;

  let postExhaustionRetryStartedAtMs: number | undefined;
  const postExhaustionRetryStillFresh = (): boolean => {
    const now = nowV1();
    if (postExhaustionRetryStartedAtMs === undefined) {
      postExhaustionRetryStartedAtMs = now;
    }
    return now - postExhaustionRetryStartedAtMs < WORK_ADMISSION_LIKELY_STALE_MS_V1;
  };

  for (;;) {
    try {
      const injected = fsFailureInjectionV1?.onBeforeClaimWrite?.();
      if (injected) {
        throw injected;
      }
      await fs.promises.writeFile(claimPath, JSON.stringify(claimInfo), { flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        return { outcome: "writeFailed", error: error as Error };
      }
      const existingPurpose = readClaimInfoSyncV1(claimPath)?.purpose;
      if (existingPurpose !== undefined && markerBlocksAcquisitionV1(existingPurpose, purpose)) {
        // A successfully read purpose that genuinely conflicts with ours
        // (e.g. two `pauseCommit` attempts) will not resolve into something
        // we can proceed past — report it immediately, with no retry.
        const claimBlocker = describeClaimAsBlockerV1(claimPath, nowV1());
        if (claimBlocker) {
          return claimBlocker;
        }
        // Vanished between the purpose read above and this stat — fall
        // through to the ordinary exhaustion diagnostic below rather than
        // fabricating a blocker that no longer exists.
      } else if (claimContentionStillFresh()) {
        // A confirmed non-blocking purpose, OR an unreadable/vanished
        // record — both are ambiguous, and both deserve the chance to
        // resolve (to a marker, to nothing, or to a readable non-conflicting
        // purpose) before we give up, for as long as the claim itself would
        // not yet be judged stale.
        await delayV1(CLAIM_CONTENTION_POLL_INTERVAL_MS_V1);
        continue;
      }
      // Either the claim's age has crossed the staleness threshold, or it
      // vanished right as we checked it — diagnose what, if anything, is
      // left blocking us.
      fsFailureInjectionV1?.onBeforeClaimRetryExhaustionDiagnosis?.();
      const blocker = describeClaimRetryExhaustedBlockerV1(taskFolderPath, purpose, nowV1());
      if (blocker) {
        return blocker;
      }
      // Nothing currently blocks us: the claim vanished (and did not resolve
      // into a marker whose purpose conflicts with ours). The path is free —
      // retry the write itself rather than handing back a terminal failure
      // for an obstruction that has already cleared (this is what makes "the
      // loser should be the pause, not the round" hold at this boundary too).
      // Bounded by `postExhaustionRetryStillFresh`'s own, independently-
      // anchored elapsed-time budget, NOT `claimContentionStillFresh` — that
      // predicate is guaranteed already false here (it is what triggered the
      // exhaustion diagnosis above), so reusing it made this branch
      // unreachable in practice; see this section's own doc comment.
      if (postExhaustionRetryStillFresh()) {
        await delayV1(CLAIM_CONTENTION_POLL_INTERVAL_MS_V1);
        continue;
      }
      return {
        outcome: "writeFailed",
        error: new Error(
          "Work admission claim was repeatedly contended and kept vanishing without resolving to a durable " +
            "blocker or a successful write, even after waiting out the full staleness window; giving up."
        ),
      };
    }
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
  // Purpose-aware filtering (2026-09-09 review architectural blocker fix):
  // a live `pauseCommit` marker never blocks a NEW `admission`-purpose
  // acquisition — see `markerBlocksAcquisitionV1`'s doc comment. Markers are
  // re-read here (not cached from `existingMarkers`' listing) since content
  // is only available per-file, and a marker whose record cannot be read is
  // conservatively treated as blocking regardless of the acquiring purpose.
  const blockingMarkers = existingMarkers.filter((marker) =>
    markerBlocksAcquisitionV1(readClaimInfoSyncV1(marker.filePath)?.purpose, purpose)
  );
  if (blockingMarkers.length > 0) {
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
    // The busy diagnosis is captured from `blockingMarkers[0]` directly via
    // `describeMarkerAsBlockerV1`, NOT via `describeWorkAdmissionBlockerV1(taskFolderPath)`
    // — that function checks for a live `admission.claim` FIRST, and if
    // cleanup below fails, THIS caller's own not-yet-removed claim is sitting
    // at that exact fixed path. Calling it (especially after cleanup, when
    // failure is most likely) would misreport this caller's own stranded
    // claim as "the blocker" instead of the marker's real owner.
    const busy = describeMarkerAsBlockerV1(blockingMarkers[0]!.filePath, Date.now());
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
  // Shared with any adopted view created later over this same marker (see
  // `localSerializersV1`'s doc comment) so an adopted view's release cannot
  // race this handle's own in-flight heartbeat.
  localSerializersV1.set(taskFolderPath, enqueueV1);

  const handle: WorkAdmissionHandleV1 = {
    ownerToken,
    claimId: claimInfo.claimId,
    taskFolderPath,
    commandId,
    purpose,
    heartbeat(): Promise<void> {
      // 2026-09-08 review completion blocker: this used to return early once
      // THIS handle's own `released` flag was set — but `released` only
      // means "this specific handle called release()/handover()", not "the
      // marker itself is gone". While an adopted view (`createAdoptedViewV1`)
      // still holds the SAME marker, `released` can already be true here
      // (the original acquirer let go first) while `currentPath` still
      // exists on disk, owned by that remaining holder — and every adopted
      // view's heartbeat forwards to THIS closure (`shared.heartbeat()`), so
      // that early return silently stopped renewing the marker for the rest
      // of its life the moment the original handle released, regardless of
      // how many holders remained. The rename below already treats a
      // genuinely displaced marker (ENOENT, e.g. after the real unlink once
      // every holder has released) as a no-op, so no separate guard is
      // needed to make a heartbeat on an already-unlinked marker safe.
      return enqueueV1(async () => {
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

  // Same-process handoff (2026-09-08 review completion blocker): the actual
  // unlink, factored out so an adopted view (created later, in
  // `acquireOrAdoptWorkAdmissionV1`, outside this closure) can trigger it too
  // without needing any filesystem detail of its own — it closes over
  // `currentPath`, which heartbeats keep current. Registered in
  // `localReleaseFinalizersV1` below and removed once actually run.
  async function unlinkMarkerV1(): Promise<void> {
    try {
      await fs.promises.unlink(currentPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      // Displaced — not an error.
    }
  }

  // Decrement the total-holders count and unlink only when it reaches zero.
  // Called by this handle's own `release()`/`handover()` (guarded below by
  // `released`, so it contributes at most one decrement) AND by every
  // adopted view's release (guarded by that view's own flag) — whichever
  // call brings the count to zero performs the real unlink, so the marker
  // survives until every in-process holder, original and adopted alike, has
  // let go. See `localHolderCountsV1`'s doc comment for the full protocol.
  async function decrementHoldersAndMaybeUnlinkV1(): Promise<void> {
    const current = localHolderCountsV1.get(taskFolderPath) ?? 1;
    if (current > 1) {
      localHolderCountsV1.set(taskFolderPath, current - 1);
      return;
    }
    localHolderCountsV1.delete(taskFolderPath);
    localReleaseFinalizersV1.delete(taskFolderPath);
    localSerializersV1.delete(taskFolderPath);
    localHandlesV1.delete(taskFolderPath);
    await unlinkMarkerV1();
  }

  async function releaseMarkerOnceV1(): Promise<void> {
    if (released) {
      return;
    }
    released = true;
    await decrementHoldersAndMaybeUnlinkV1();
  }

  localHandlesV1.set(taskFolderPath, handle);
  localReleaseFinalizersV1.set(taskFolderPath, decrementHoldersAndMaybeUnlinkV1);
  return { outcome: "acquired", handle };
}

/**
 * Adopt an already-live, SAME-PROCESS admission marker instead of racing a
 * fresh genesis against it — the fix for the 2026-09-08 review completion
 * blocker. A resume-then-dispatch flow (`resumeTask.ts`'s
 * `resumeThenDispatchV1`) holds its own admission continuously through a
 * downstream command's ENTIRE dispatch, including that command's own setup;
 * a downstream command that is itself admission-wired (`runReviewWithAI`,
 * `fastForwardReviewWithAI`) must therefore be able to join that already-live
 * marker rather than trying to create a second one and being refused `busy`
 * against a marker this very process already owns.
 *
 * Adoption is gated by `handoffToken` (2026-09-08 review architectural
 * blocker fix — see `pendingHandoffTokensV1`'s doc comment). When no local
 * handle exists for the task, or a local handle exists but the caller's
 * token does not match the one currently authorized for it (absent,
 * mismatched, or already consumed), this is exactly `acquireWorkAdmissionV1`
 * — the ordinary, cross-process-safe genesis path. Against an already-live
 * SAME-process marker with no matching authorization, that ordinary path
 * observes the marker on disk and correctly refuses `busy`: adoption is
 * therefore never a way for an unrelated concurrent same-process command to
 * join another command's admission.
 *
 * Only when the token matches does this return a distinct VIEW over the same
 * live marker: its own `heartbeat()` renews the shared marker; its own
 * `release()`/`handover()` are independently idempotent (a caller can call
 * either exactly once, same as any other handle), run through the SAME
 * owner-local serialized queue as the base handle's own heartbeat (via
 * `localSerializersV1`, so a release can never race an in-flight heartbeat
 * rename), and decrement the shared total-holders count so the marker is
 * only actually unlinked once every holder — the original acquirer and every
 * adopted view — has released, regardless of the order they do so in.
 */
export async function acquireOrAdoptWorkAdmissionV1(params: {
  readonly taskFolderPath: string;
  readonly purpose: WorkAdmissionPurposeV1;
  readonly commandId: string;
  /** Presented by the intended downstream dispatch of a resume-then-dispatch
   * flow; must match the token `authorizeWorkAdmissionHandoffV1` most
   * recently issued for this exact task, or adoption does not happen. */
  readonly handoffToken?: string;
}): Promise<WorkAdmissionResultV1> {
  const existing = localHandlesV1.get(params.taskFolderPath);
  const authorized = pendingHandoffTokensV1.get(params.taskFolderPath);
  const authorizedForThisCaller =
    existing !== undefined &&
    params.handoffToken !== undefined &&
    authorized !== undefined &&
    params.handoffToken === authorized;
  if (!authorizedForThisCaller) {
    return acquireWorkAdmissionV1(params);
  }
  // Single-use: consume the token the instant it authorizes an adoption, so
  // it cannot be replayed to join a second, later, unrelated dispatch.
  pendingHandoffTokensV1.delete(params.taskFolderPath);
  return { outcome: "acquired", handle: createAdoptedViewV1(params.taskFolderPath, existing) };
}

function createAdoptedViewV1(taskFolderPath: string, shared: WorkAdmissionHandleV1): WorkAdmissionHandleV1 {
  const current = localHolderCountsV1.get(taskFolderPath) ?? 1;
  localHolderCountsV1.set(taskFolderPath, current + 1);

  let viewReleased = false;
  const releaseViewV1 = async (): Promise<void> => {
    if (viewReleased) {
      return;
    }
    viewReleased = true;
    const finalize = localReleaseFinalizersV1.get(taskFolderPath);
    if (!finalize) {
      // The marker was unlinked by another holder between this view's
      // creation and its release — nothing left to decrement or unlink; a
      // displaced view releasing is not an error, same as an ENOENT on the
      // base handle's own unlink.
      return;
    }
    // Route through the SAME owner-local queue the base handle's own
    // heartbeat/release/handover use (`localSerializersV1`), not a direct
    // call — see that map's doc comment for the heartbeat-vs-unlink race
    // this closes. If the serializer is already gone (marker unlinked
    // concurrently, same race as the `finalize` check above), there is
    // nothing left to serialize against either.
    const serialize = localSerializersV1.get(taskFolderPath);
    if (serialize) {
      await serialize(finalize);
    } else {
      await finalize();
    }
  };

  return {
    ownerToken: shared.ownerToken,
    claimId: shared.claimId,
    taskFolderPath: shared.taskFolderPath,
    commandId: shared.commandId,
    purpose: shared.purpose,
    heartbeat: () => shared.heartbeat(),
    release: releaseViewV1,
    handover: releaseViewV1,
  };
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
