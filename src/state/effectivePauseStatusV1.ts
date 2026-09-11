import * as vscode from "vscode";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import { isWatchdogPauseFenceCurrentV1 } from "./workAdmissionV1";
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
 * NOT YET WIRED into any consumer (plan step 13's "audit every pause-sensitive
 * read: command self-checks, tree/context-key derivation, automation gates,
 * advancement gates, scheduled dispatch, notifications" remains open) —
 * this module is the primitive that audit will call into, added and tested
 * standalone first so each site can be migrated with a single, verifiable
 * call rather than reimplementing the fence check inline.
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
  return current
    ? { kind: "currentWatchdogPause" }
    : { kind: "revokedWatchdogPause", staleClaimId: progress.watchdogPauseClaimId };
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
 * Durably clear a watchdog pause the resolver found revoked — a field-scoped
 * patch (plan step 13's field-scoping requirement) that only ever touches the
 * pause fields, and only when the CURRENT on-disk record (re-read inside the
 * CAS) still shows the exact same stale claim. A concurrent fresh pause, a
 * resume, or another actor's repair between the resolve call and this write
 * makes this a no-op — never clobbering whatever superseded it.
 *
 * This is the "schedules durable cleanup" half of plan step 13; callers
 * decide WHEN to invoke it (typically right after `resolveEffectivePauseStatusV1`
 * returns `revokedWatchdogPause`) — this function does not re-resolve on its
 * own, so it never races its own read against its own write beyond the CAS
 * re-validation already described.
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
