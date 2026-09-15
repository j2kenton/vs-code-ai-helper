import * as vscode from "vscode";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import {
  isWatchdogPauseFenceCurrentSyncV1,
  isWatchdogPauseFenceCurrentV1,
  registerPauseRevocationCleanupHookV1,
} from "./workAdmissionV1";
import { TaskProgress } from "../types/taskProgress";

/**
 * v1 fixes item 1, Part 1b step 13 — the centralized effective-pause-status
 * resolver plan step 13 asks for, kept in its own module (rather than folded
 * into `workAdmissionV1.ts`, which stays free of `task-progress.json`'s
 * format and the VS Code API — see that module's own doc comments — or into
 * `workAdmissionReconciliationV1.ts`, whose `reconcileWatchdogPauseAgainstAdmissionV1`
 * answers a different question: "did THIS command's own fresh admission just
 * prove an existing pause silently wrong").
 *
 * This resolver answers a narrower, purely READ-side question any consumer
 * can ask without acquiring anything: given a task's already-loaded
 * `status`/`watchdogPauseClaimId`/`watchdogPauseFenceGeneration`, is its
 * pause (if any) still EFFECTIVE right now? An older-generation watchdog
 * pause — one whose recorded fence generation a later revocation
 * (`workAdmissionV1.ts`'s `revokeStalePauseCommitClaimV1` +
 * `advancePauseFenceForRevocationV1`) has since advanced past — must be
 * treated as revoked "regardless of what `status`/`pausedReason` still say on
 * disk" (`TaskProgress.watchdogPauseFenceGeneration`'s own doc comment); a
 * current-generation watchdog pause remains real; a user pause (or a quota
 * park, or a pause written by a pre-1b build with no claim id at all) is
 * ALWAYS authoritative and is never second-guessed here.
 *
 * Plan step 13's "audit every pause-sensitive read: command self-checks,
 * tree/context-key derivation, automation gates, advancement gates,
 * scheduled dispatch, notifications" audit is wired incrementally, one site
 * at a time, against this module's async resolver (async command paths —
 * `resolveTaskContext.ts`'s shared gate, `reviewActions.ts`,
 * `applyCurrentStageAction.ts`, `pauseTask.ts`, `resumeTask.ts`, and more)
 * and its synchronous twin below (render paths that cannot await mid-render
 * — `taskTreeProvider.ts`, `taskStatusBar.ts`). Not every reader is migrated
 * yet; each migration is a single, verifiable call rather than
 * reimplementing the fence check inline.
 *
 * 2026-09-14 review completion blocker (readiness 7/10): the async resolver
 * below now SCHEDULES durable cleanup (`repairRevokedWatchdogPauseV1`, via
 * `scheduleRevokedWatchdogPauseCleanupV1`) the moment it observes a revoked
 * watchdog pause, rather than only reporting it. See that function's own doc
 * comment for why the ONE existing repair trigger — `workAdmissionV1.ts`'s
 * barrier-completion hook, which fires from the claim id captured BEFORE the
 * fence advance — is not enough on its own: if the old `pauseCommit` owner's
 * raw pause write to `task-progress.json` had not yet landed at that exact
 * instant, the hook's own patch is a harmless no-op (nothing paused yet under
 * that claim to clear), and nothing was ever scheduled to retry once the late
 * write actually arrived. The stale pause was then reported correctly by
 * every reader forever, but never actually repaired on disk.
 *
 * 2026-09-15 review completion blocker (readiness 7/10, narrowed): the
 * synchronous render-path twin (`resolveEffectivePauseStatusSyncV1`) now
 * schedules the SAME best-effort repair the async resolver does, instead of
 * being purely read-only. A task whose tree row or status bar is the only
 * thing ever observing it (no command dispatched, nothing else calling the
 * async resolver) previously left a late-landing stale pause unrepaired on
 * disk forever, even though every reader already correctly displayed it as
 * not-paused — see `scheduleRevokedWatchdogPauseCleanupV1`'s own comment for
 * why this is cheap rather than a "write storm": it is deduplicated per
 * (taskFolderPath, staleClaimId), so a render tick that observes the same
 * still-unrepaired stale claim it already scheduled a repair for is a no-op
 * map lookup, not a new write; and the moment the repair lands, the claim id
 * it was keyed on is gone from disk, so no further render tick can re-key
 * against it.
 */
export type EffectivePauseStatusV1 =
  | { readonly kind: "notPaused" }
  | { readonly kind: "userPause" }
  | { readonly kind: "currentWatchdogPause" }
  | { readonly kind: "revokedWatchdogPause"; readonly staleClaimId: string };

export type EffectivePauseSnapshotV1 = Pick<
  TaskProgress,
  "status" | "watchdogPauseClaimId" | "watchdogPauseFenceGeneration"
>;

/**
 * Resolve whether `progress`'s pause (if `status === "paused"`) is currently
 * effective. Performs one durable fence read (`isWatchdogPauseFenceCurrentV1`)
 * only when the pause was committed through the claim protocol at all
 * (`watchdogPauseClaimId` present) — a user pause, a quota park, or a pause
 * from a pre-1b build never reaches that read and is always `userPause`.
 */
export async function resolveEffectivePauseStatusV1(
  taskFolderPath: string,
  progress: EffectivePauseSnapshotV1
): Promise<EffectivePauseStatusV1> {
  if (progress.status !== "paused") {
    return { kind: "notPaused" };
  }
  if (progress.watchdogPauseClaimId === undefined) {
    return { kind: "userPause" };
  }
  const current = await isWatchdogPauseFenceCurrentV1(taskFolderPath, progress.watchdogPauseFenceGeneration);
  if (current) {
    return { kind: "currentWatchdogPause" };
  }
  // "schedule cleanup, continue" (plan step 13): every observation of a
  // revoked pause re-arms a best-effort durable repair, not just the one at
  // revocation-barrier-completion time — see the module doc comment and
  // `scheduleRevokedWatchdogPauseCleanupV1`'s own comment for why that single
  // trigger can miss a late-landing raw pause write.
  scheduleRevokedWatchdogPauseCleanupV1(taskFolderPath, progress.watchdogPauseClaimId);
  return { kind: "revokedWatchdogPause", staleClaimId: progress.watchdogPauseClaimId };
}

/**
 * Convenience boolean for a gate that only needs "should this currently be
 * treated as paused" — collapses every kind except a revoked, stale watchdog
 * pause (which is never treated as a real block) to `true`/`false`.
 */
export async function isEffectivelyPausedV1(
  taskFolderPath: string,
  progress: EffectivePauseSnapshotV1
): Promise<boolean> {
  const resolved = await resolveEffectivePauseStatusV1(taskFolderPath, progress);
  return resolved.kind === "userPause" || resolved.kind === "currentWatchdogPause";
}

/**
 * Synchronous twin of `resolveEffectivePauseStatusV1`, for tree/context-key
 * derivation and other render-path consumers that cannot await mid-render
 * (plan step 13). Uses `isWatchdogPauseFenceCurrentSyncV1` — a pure,
 * never-writes, never-lazily-initializes read (see that function's own doc
 * comment) — in place of the async durable fence read; every other branch
 * reports the same classification as the async resolver above.
 *
 * Like the async resolver, a revoked pause it observes also schedules
 * (fire-and-forget, via the same deduplicated `scheduleRevokedWatchdogPauseCleanupV1`)
 * a best-effort durable repair — 2026-09-15 review completion blocker: a task
 * whose only readers are render paths (tree row, status bar; no command ever
 * dispatched against it) previously left a late-landing stale pause on disk
 * forever, since nothing else was ever going to call the async resolver for
 * it. The dedup keeps this from being a write storm under frequent render
 * ticks: the underlying fence read itself never writes or creates anything
 * (see `isWatchdogPauseFenceCurrentSyncV1`), so calling this function still
 * never touches disk on its own — only the one deduplicated background
 * repair it may schedule does, at most once per stale claim.
 */
export function resolveEffectivePauseStatusSyncV1(
  taskFolderPath: string,
  progress: EffectivePauseSnapshotV1
): EffectivePauseStatusV1 {
  if (progress.status !== "paused") {
    return { kind: "notPaused" };
  }
  if (progress.watchdogPauseClaimId === undefined) {
    return { kind: "userPause" };
  }
  const current = isWatchdogPauseFenceCurrentSyncV1(taskFolderPath, progress.watchdogPauseFenceGeneration);
  if (current) {
    return { kind: "currentWatchdogPause" };
  }
  scheduleRevokedWatchdogPauseCleanupV1(taskFolderPath, progress.watchdogPauseClaimId);
  return { kind: "revokedWatchdogPause", staleClaimId: progress.watchdogPauseClaimId };
}

/**
 * Convenience boolean twin of `isEffectivelyPausedV1` for synchronous
 * render-path consumers — see `resolveEffectivePauseStatusSyncV1`.
 */
export function isEffectivelyPausedSyncV1(
  taskFolderPath: string,
  progress: EffectivePauseSnapshotV1
): boolean {
  const resolved = resolveEffectivePauseStatusSyncV1(taskFolderPath, progress);
  return resolved.kind === "userPause" || resolved.kind === "currentWatchdogPause";
}

/**
 * Durably clear a watchdog pause the resolver found revoked — a field-scoped
 * patch (plan step 13's field-scoping requirement) that only ever touches the
 * pause fields, and only when the CURRENT on-disk record (re-read inside the
 * CAS) still shows the exact same stale claim. A concurrent fresh pause, a
 * resume, or another actor's repair between the resolve call and this write
 * makes this a no-op — never clobbering whatever superseded it.
 *
 * This is the "schedules durable cleanup" half of plan step 13. Callers decide
 * WHEN to invoke it — this function does not re-resolve on its own, so it
 * never races its own read against its own write beyond the CAS re-validation
 * already described. Invoked from two places: `workAdmissionV1.ts`'s
 * revocation-barrier-completion hook (registered below), and
 * `scheduleRevokedWatchdogPauseCleanupV1` right below, which the async
 * resolver above self-triggers on every observation of a revoked pause — see
 * that function's own comment for why one trigger alone is not enough.
 */
export async function repairRevokedWatchdogPauseV1(
  taskFolderUri: vscode.Uri,
  staleClaimId: string
): Promise<void> {
  await patchTaskProgressStrictV1(taskFolderUri, (current) => {
    if (current.status !== "paused" || current.watchdogPauseClaimId !== staleClaimId) {
      return undefined;
    }
    return {
      ...current,
      status: "active",
      pausedReason: undefined,
      watchdogPauseClaimId: undefined,
      watchdogPauseFenceGeneration: undefined,
      updatedAt: new Date().toISOString(),
    };
  });
}

/**
 * 2026-09-14 review completion blocker: schedule (fire-and-forget) a durable
 * repair of a stale pause observed by `resolveEffectivePauseStatusV1`. The
 * ONE existing repair trigger before this fix — `workAdmissionV1.ts`'s
 * `performPauseRevocationBarrierFinishSequenceV1`, which calls
 * `repairRevokedWatchdogPauseV1` with the claim id it captured BEFORE its own
 * fence advance — fires exactly once, at barrier-completion time. If the old
 * `pauseCommit` owner was merely suspended (not dead) and its raw pause write
 * to `task-progress.json` had not yet reached disk at that instant, that
 * one-shot call is a harmless no-op (nothing paused yet under that claim to
 * clear) — and nothing was ever scheduled to retry once the late write
 * actually landed. Every reader still correctly reports the pause as
 * `revokedWatchdogPause` forever afterward (the fence generation alone
 * guarantees that), but the raw fields could sit unrepaired on disk
 * indefinitely, which is precisely the gap the review flagged: "the resolver
 * ... does not schedule durable cleanup ... a late raw pause is hidden but
 * can remain indefinitely on disk."
 *
 * Calling this from the resolver itself closes the gap without needing to
 * predict timing: the very next time ANYTHING calls the async resolver
 * (`resolveTaskContext.ts`'s shared command-resolution gate, chiefly) against
 * a task whose stale pause has by then landed on disk, cleanup is scheduled
 * again, this time against the real record.
 *
 * 2026-09-15: also called from the synchronous render-path twin
 * (`resolveEffectivePauseStatusSyncV1`), for the same reason one level
 * further out — a task nobody ever runs a command against, only ever
 * rendered (tree row, status bar), would otherwise never trigger this at
 * all. The dedup below is what makes that safe to call on every render tick.
 *
 * Deduplicated per (taskFolderPath, staleClaimId) so N concurrent
 * observations of the same stale pause in the same instant schedule ONE
 * repair, not N. The entry is removed once that repair settles — success OR
 * failure — so a transient write failure is retried on the next observation
 * rather than permanently abandoned, and a successful repair (which clears
 * `watchdogPauseClaimId`) naturally stops the resolver from ever observing
 * this exact stale claim again.
 */
const pendingRevokedWatchdogPauseRepairsV1 = new Map<string, Promise<void>>();

function scheduleRevokedWatchdogPauseCleanupV1(taskFolderPath: string, staleClaimId: string): void {
  const key = `${taskFolderPath} ${staleClaimId}`;
  if (pendingRevokedWatchdogPauseRepairsV1.has(key)) {
    return;
  }
  const repair = repairRevokedWatchdogPauseV1(vscode.Uri.file(taskFolderPath), staleClaimId)
    .catch((error) => {
      console.error(
        `scheduleRevokedWatchdogPauseCleanupV1: best-effort repair failed for stale claim "${staleClaimId}" ` +
          `in "${taskFolderPath}" — will retry on the next observation of the same stale pause.`,
        error
      );
    })
    .finally(() => {
      pendingRevokedWatchdogPauseRepairsV1.delete(key);
    });
  pendingRevokedWatchdogPauseRepairsV1.set(key, repair);
}

/**
 * Test-only: resolve once every repair currently scheduled by
 * `scheduleRevokedWatchdogPauseCleanupV1` has settled, so a test can assert
 * on the durable on-disk effect of a `resolveEffectivePauseStatusV1` call
 * without an arbitrary sleep.
 * @internal exported for testing
 */
export async function flushScheduledRevokedWatchdogPauseCleanupsV1(): Promise<void> {
  await Promise.all(Array.from(pendingRevokedWatchdogPauseRepairsV1.values()));
}

/**
 * Part 1b step 12/13 wiring (2026-09-11 review completion blocker
 * `dceb2646...-2`, fixed): this is the one module with both a durable
 * pause-fence read (`workAdmissionV1.ts`) and `task-progress.json` write
 * access (this module's own doc comment above), so it is the correct place
 * to self-register as `workAdmissionV1.ts`'s pause-cleanup hook — invoked
 * (best-effort) after a revocation barrier's fence-advance completes, so the
 * completing acquisition also clears the stale `watchdogPauseClaimId`/
 * `pausedReason`/`status` fields left behind by the revoked pause, not just
 * the fence generation. Registered once, at import time: every consumer of
 * this module (the sweep, and any future pause-sensitive reader migrated
 * under plan step 13) already imports it before it could possibly race a
 * real acquisition.
 */
registerPauseRevocationCleanupHookV1(async (taskFolderPath, staleClaimId) => {
  await repairRevokedWatchdogPauseV1(vscode.Uri.file(taskFolderPath), staleClaimId);
});
