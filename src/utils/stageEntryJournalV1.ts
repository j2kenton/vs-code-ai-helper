/**
 * Pre-1.0.0 fixes register, Part 2 (item 15 hardening): the stage-entry
 * journal and its Phase A ("decide, then roll back if the transition never
 * committed") crash recovery.
 *
 * `enterStageOnceV1` (`stageTransition.ts`) is this module's one production
 * writer: its `publishArtifact` closure begins a journal (`phase: "intent"`)
 * before calling `preparePlanPromotion`'s `publish()`, advances it to
 * `"publishing"` (with `expectedSha256`) from `publish()`'s new
 * `onBeforeArtifactWrite` hook, and to `"published"` once the write has
 * landed. `runStageEntryPostCommitV1` deletes it (Phase C) once the
 * transition has actually committed; `enterStageOnceV1`'s own failure paths
 * (`onCommitFailure`, and a non-persisted transition) delete it too.
 * `onCommitFailure` specifically ("In-process failure now uses the same
 * code", per the plan) does this by calling {@link recoverStageEntryJournalV1}
 * itself on THIS transition's own just-begun journal — the SAME Phase A a
 * crash recovery runs, proving or disproving via `expectedSha256`/
 * `priorArtifact` whether the bytes on disk are this transition's before
 * touching anything, rather than a separate in-process-only rollback keyed on
 * bytes captured in closure scope.
 *
 * FAIL-CLOSED (review fix, 2026-09-23, architectural blocker): none of the
 * begin/advance calls in that closure are wrapped in a try/catch that
 * swallows. A failure at any of them propagates, aborts the whole
 * `patchTaskProgressStrictV1` write, and is handled by `onCommitFailure` (the
 * journal-driven artifact rollback described above, folded into the surfaced
 * error) — see `enterStageV1`'s doc comment in `stageTransition.ts`. The one
 * call site that can legitimately find an EXISTING (different-transition)
 * journal on disk — `beginStageEntryJournalV1`, when a prior transition
 * crashed without cleaning up its journal — is recovered via
 * {@link recoverStageEntryJournalV1} (Phase A) and the whole transition is
 * retried once by the exported `enterStageV1` wrapper, exactly as this
 * module's ownership rules require ("must be recovered before a new
 * transition may begin"). Both call sites are safe to call
 * `recoverStageEntryJournalV1` from because, by the time either one runs, the
 * failed attempt's own `patchTaskProgressStrictV1`/`withTaskLock` hold has
 * already released.
 *
 * {@link recoverStageEntryJournalV1} now runs the full three-phase recovery
 * for a `"committed"` journal, not only Phase A: after Phase A's lock hold
 * releases, Phase B + Phase C both run through ONE call to
 * `runStageEntryPostCommitV1` (`stageTransition.ts`) — the SAME function the
 * non-crash post-commit path calls — built from a payload carrying only the
 * journal's `deferredAdoption` (if any) and its `transitionId`. That function
 * applies the deferred adoption (Phase B), then re-acquires `withTaskLock`
 * and deletes the journal (Phase C), but ONLY if its on-disk `transitionId`
 * still equals the one Phase A captured (the same transition-owned-cleanup
 * rule {@link deleteStageEntryJournalV1} already enforces — a concurrent
 * process that recovered this same journal and moved on to a NEW transition
 * must not have its fresh journal deleted here). A `"rolled-back"` outcome
 * needs neither: its journal is already deleted inside Phase A itself, and
 * there is nothing committed to replay.
 *
 * PROACTIVE recovery call sites that run independent of a colliding new
 * transition are now wired via {@link recoverStageEntryJournalIfPresentV1} (a
 * cheap, lock-free existence probe before the real recovery): inside
 * `prepareStageEntryV1` — UNCONDITIONALLY, before its own destination-specific
 * early return, so a stale journal from a PRIOR "impl" entry is reconciled
 * whatever stage a task is next entering (review fix, 2026-09-23, completion
 * blocker: this used to run only for an "impl" destination, which left a
 * journal that outlived its own transition's Phase C cleanup — e.g. a crash
 * between the progress-write commit and that cleanup — un-recovered across
 * every SUBSEQUENT transition until one happened to target "impl" again. By
 * then `currentStage` no longer equals the stale journal's `to`, so Phase A's
 * committed-check would misread a transition that actually succeeded as one
 * that never committed, and roll back the `plan-final.md` every later stage
 * still depends on. Running this at the head of `prepareStageEntryV1` for
 * every destination — this covers both `enterStageV1` itself and the two
 * "friendly pre-check" reads in `reviewActions.ts` — see that function's own
 * doc comment for why one call site covers all three), inside
 * `materializeCanonicalIfNeeded`, and once per task in the activation sweep
 * (`TaskActionScheduler.armAll`'s `recoverStageEntryJournalsV1`,
 * `scheduleTaskResume.ts`). Each was reconciled against the fact that
 * `recoverStageEntryJournalV1` takes `withTaskLock` itself, so it can never
 * run from inside an already-locked caller without a self-deadlock: the ONE
 * caller that could reach this from inside such a hold — the Reopen row's
 * `skipTaskLock` path, invoked from inside `activateTaskLocked`'s meta-root
 * lock (`taskActivationCoordinator.ts`) — is fixed at its OWN call site
 * instead of by skipping recovery: `reopenCompletedTask` (`reopenTask.ts`)
 * now calls this same function itself, lock-free, BEFORE it ever calls
 * `activateTask` (review fix, 2026-09-23, architectural blocker — the
 * previous shape passed `callerHoldsCoveringLock: true` to `enterStageV1` and
 * left it at that, which suppressed recovery entirely on this path rather
 * than merely relocating it ahead of the lock, so a stale journal could sit
 * un-recovered — and, per the paragraph above, could even be
 * MIS-recovered — across every Reopen). `callerHoldsCoveringLock: true` is
 * still passed through from `resumeTaskRowV1.ts` to `enterStageV1`, which
 * still suppresses BOTH the proactive call inside `prepareStageEntryV1` and
 * this module's own reactive recover-and-retry-once — now correctly, since by
 * the time that inner call is reached, `reopenCompletedTask`'s own recovery
 * has already run moments before, outside any lock; the flag remains solely
 * so this exact call path can never self-deadlock, not as its only defense
 * against a stale journal. `materializeCanonicalIfNeeded`'s two production
 * callers, and every task the activation sweep iterates, were audited and
 * confirmed to never hold `withTaskLock` (or an equivalent covering lock) at
 * their call site.
 *
 * Still open, in the plan's own order: cheap existence checks ahead of the
 * `prepareStageEntryV1`/`materializeCanonicalIfNeeded`/activation-sweep call
 * sites above are already how {@link recoverStageEntryJournalIfPresentV1}
 * itself is built (the check lives IN the shared helper, not duplicated at
 * each call site) — what remains per the plan's own wording is auditing any
 * FUTURE caller of `materializeCanonicalIfNeeded`, or any future caller of
 * `enterStageV1` from inside a covering lock, for the same hazard —
 * recovering at the CALLER's own site before it acquires that lock, the way
 * `reopenCompletedTask` now does, rather than reaching for
 * `callerHoldsCoveringLock` as anything more than a self-deadlock backstop.
 *
 * Ownership rules (hold for every function here):
 *   - Every journal create, rewrite and delete happens only while the
 *     caller holds `withTaskLock` for this task. This module does not take
 *     the lock itself for the low-level read/write/delete primitives —
 *     callers that need atomicity across a read-decide-write sequence (e.g.
 *     {@link recoverStageEntryJournalV1}) take the lock themselves.
 *   - A journal is never replaced by a different transition:
 *     {@link writeStageEntryJournalV1} refuses to overwrite an existing
 *     journal whose `transitionId` differs from the one being written.
 *   - A journal is deleted only by a caller that holds the lock and has just
 *     read the same `transitionId` from disk:
 *     {@link deleteStageEntryJournalV1} takes the expected `transitionId` and
 *     is a no-op (leaves the file alone) when the on-disk journal belongs to
 *     a different transition.
 *   - A journal file that exists but cannot be parsed is NEVER treated as
 *     absent for write-ownership purposes: {@link beginStageEntryJournalV1}
 *     and {@link writeStageEntryJournalV1} both throw
 *     {@link StageEntryJournalUnreadableErrorV1} rather than silently
 *     overwriting it, exactly as they refuse to overwrite a journal that
 *     belongs to a different transition. Only {@link recoverStageEntryJournalV1}
 *     may discard an unreadable journal — deliberately, with a run-log line —
 *     since it can never be proven to belong to any transition this process
 *     could otherwise roll back or trust.
 */
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import type { TaskStage } from "../types/taskProgress";
import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import { withTaskLock } from "../state/taskStateStore";
import { writeAtomic, formatAtomicTempBasename } from "../state/writeAtomic";
import { statIfExists, withPlanFileWriteLockV1 } from "./fileUtils";
import { previousVersionUri } from "./artifactBackups";
import {
  getCanonicalImplementationUri,
  getPlanRevisionJournalUri,
  type PlanRevisionAdoptionV1,
} from "./implementationArtifactResolver";
import { writeRunLog } from "./runLog";
// Deliberately circular with `stageTransition.ts` (which imports several
// journal primitives from this module) — safe because both sides only call
// into the other from inside function bodies, never at module top level, and
// TS's Node16/commonjs emit resolves named imports as a lazy property access
// on the whole module object rather than a value captured at import time. See
// `runStageEntryPostCommitV1`'s doc comment for why Phase B/C below share
// this one function with the non-crash post-commit path instead of
// re-implementing "apply the deferred adoption, then clean up the journal" a
// second time here.
import { runStageEntryPostCommitV1 } from "./stageTransition";

/** Basename of the stage-entry journal file, one per task folder. Added to
 * `WORKFLOW_CONTROL_BASENAMES` (`workflowPrivacyClassifierV1.ts`) so it is
 * Ensemble's own bookkeeping, never a round's changed file. */
export const STAGE_ENTRY_JOURNAL_FILENAME = "stage-entry-journal.json";

export function getStageEntryJournalUri(taskFolderUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(taskFolderUri, STAGE_ENTRY_JOURNAL_FILENAME);
}

export type StageEntryJournalPhaseV1 = "intent" | "publishing" | "published" | "committed";

/** What the journaled artifact write is replacing — the exact prior bytes
 * are never stored (only their hash), so a rollback that needs to restore
 * non-absent prior content must locate those bytes elsewhere (the plan
 * revision's frozen snapshot, or the `_prev` backup) and verify them against
 * this hash before trusting them. */
export type StageEntryJournalPriorArtifactV1 = "absent" | { readonly sha256: string };

export interface StageEntryJournalV1 {
  readonly transitionId: string;
  readonly from: TaskStage;
  readonly to: TaskStage;
  readonly startedAt: string;
  readonly artifact: "plan-final.md";
  readonly priorArtifact: StageEntryJournalPriorArtifactV1;
  readonly phase: StageEntryJournalPhaseV1;
  /** Set once `phase` reaches `"publishing"`: the hash of the exact bytes the
   * artifact write is about to land. */
  readonly expectedSha256?: string;
  /** Set once `phase` reaches `"published"`, when the promotion was a plan
   * revision re-finalization with adoption facts still to be applied
   * post-commit (Phase B — replayed by {@link recoverAndReplayCommittedJournalV1}
   * via `runStageEntryPostCommitV1`). */
  readonly deferredAdoption?: PlanRevisionAdoptionV1;
}

export function sha256HexV1(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Thrown by {@link beginStageEntryJournalV1} / {@link writeStageEntryJournalV1}
 * when a journal for a DIFFERENT transition is already on disk — the caller
 * must recover it (Phase A) before a new transition may begin. */
export class StageEntryRecoveryPendingErrorV1 extends Error {
  constructor(public readonly existing: StageEntryJournalV1) {
    super(
      `A stage-entry journal for a prior transition (${existing.transitionId}, ${existing.from} -> ` +
        `${existing.to}) is still on disk and must be recovered before a new transition may begin.`
    );
    this.name = "StageEntryRecoveryPendingErrorV1";
  }
}

/** Thrown by {@link beginStageEntryJournalV1} / {@link writeStageEntryJournalV1}
 * when a journal FILE exists on disk but cannot be parsed as a valid journal.
 * Treated the same as {@link StageEntryRecoveryPendingErrorV1} — the caller
 * must recover (never silently overwrite) before a new transition may begin.
 * There is no `existing` journal to attach: that is exactly why this is a
 * distinct error rather than reusing the sibling class. */
export class StageEntryJournalUnreadableErrorV1 extends Error {
  constructor() {
    super(
      "A stage-entry journal file exists but could not be read as a valid journal. It must be recovered " +
        "(never silently discarded and overwritten) before a new transition may begin."
    );
    this.name = "StageEntryJournalUnreadableErrorV1";
  }
}

/** The three things a raw read of the journal file can find. Distinguishing
 * `"corrupt"` from `"absent"` is what lets the write-ownership guards
 * ({@link beginStageEntryJournalV1}, {@link writeStageEntryJournalV1}) refuse
 * to silently overwrite a journal they cannot prove is safe to replace — see
 * this module's doc comment. */
export type StageEntryJournalReadOutcomeV1 =
  | { readonly kind: "absent" }
  | { readonly kind: "corrupt" }
  | { readonly kind: "present"; readonly journal: StageEntryJournalV1 };

/** The raw, non-tolerant read: reports whether a journal file exists at all,
 * and — separately — whether its contents parsed as a valid journal. Callers
 * that must never confuse "no journal" with "an unreadable journal" (i.e. the
 * write-ownership guards) use this instead of {@link readStageEntryJournalV1}. */
export async function readStageEntryJournalRawV1(
  taskFolderUri: vscode.Uri
): Promise<StageEntryJournalReadOutcomeV1> {
  const uri = getStageEntryJournalUri(taskFolderUri);
  if (!(await statIfExists(uri))) {
    return { kind: "absent" };
  }
  try {
    const raw = await vscode.workspace.fs.readFile(uri);
    const parsed = JSON.parse(new TextDecoder().decode(raw)) as Partial<StageEntryJournalV1>;
    if (
      typeof parsed.transitionId !== "string" ||
      typeof parsed.from !== "string" ||
      typeof parsed.to !== "string" ||
      typeof parsed.startedAt !== "string" ||
      typeof parsed.phase !== "string"
    ) {
      return { kind: "corrupt" };
    }
    return { kind: "present", journal: parsed as StageEntryJournalV1 };
  } catch {
    return { kind: "corrupt" };
  }
}

/** Tolerant read for callers that only want to know "is there a currently
 * valid journal" (e.g. tests confirming final state, or a cheap pre-lock
 * existence probe) — a missing OR unparsable journal both read as
 * `undefined` here. This collapsing is safe only because nothing that must
 * distinguish "absent" from "corrupt" for write-ownership purposes uses this
 * function; {@link beginStageEntryJournalV1} and {@link writeStageEntryJournalV1}
 * use {@link readStageEntryJournalRawV1} instead precisely so a corrupt
 * journal can never be silently treated as absent and overwritten. */
export async function readStageEntryJournalV1(
  taskFolderUri: vscode.Uri
): Promise<StageEntryJournalV1 | undefined> {
  const outcome = await readStageEntryJournalRawV1(taskFolderUri);
  return outcome.kind === "present" ? outcome.journal : undefined;
}

/**
 * Write (create or advance the phase of) the journal, atomically (temp file
 * + rename via `writeAtomic`). Caller must hold `withTaskLock` for this task.
 *
 * Refuses — never replaces — an on-disk journal belonging to a DIFFERENT
 * transition, or one that exists but cannot be parsed. A caller that hits
 * either must recover the existing journal first (see
 * {@link recoverStageEntryJournalV1}).
 */
export async function writeStageEntryJournalV1(
  taskFolderUri: vscode.Uri,
  journal: StageEntryJournalV1
): Promise<void> {
  const existing = await readStageEntryJournalRawV1(taskFolderUri);
  if (existing.kind === "corrupt") {
    throw new StageEntryJournalUnreadableErrorV1();
  }
  if (existing.kind === "present" && existing.journal.transitionId !== journal.transitionId) {
    throw new StageEntryRecoveryPendingErrorV1(existing.journal);
  }
  await writeAtomic(getStageEntryJournalUri(taskFolderUri), JSON.stringify(journal, null, 2));
}

/**
 * `beforeWrite`'s collision check: throws {@link StageEntryRecoveryPendingErrorV1}
 * when a journal for a different (or any prior, un-recovered) transition is
 * already on disk, or {@link StageEntryJournalUnreadableErrorV1} when a
 * journal file exists but cannot be parsed, otherwise writes the initial
 * `phase: "intent"` journal. Caller must hold `withTaskLock`.
 */
export async function beginStageEntryJournalV1(
  taskFolderUri: vscode.Uri,
  journal: Omit<StageEntryJournalV1, "phase">
): Promise<void> {
  const existing = await readStageEntryJournalRawV1(taskFolderUri);
  if (existing.kind === "corrupt") {
    throw new StageEntryJournalUnreadableErrorV1();
  }
  if (existing.kind === "present") {
    throw new StageEntryRecoveryPendingErrorV1(existing.journal);
  }
  await writeAtomic(
    getStageEntryJournalUri(taskFolderUri),
    JSON.stringify({ ...journal, phase: "intent" satisfies StageEntryJournalPhaseV1 }, null, 2)
  );
}

/**
 * Delete the journal, but only when its on-disk `transitionId` still equals
 * `transitionId` — the "deleted only by a caller that just read the same
 * transition" ownership rule. A journal belonging to a different (later)
 * transition, or no journal at all, is left untouched (a no-op). Caller must
 * hold `withTaskLock`.
 */
export async function deleteStageEntryJournalV1(
  taskFolderUri: vscode.Uri,
  transitionId: string
): Promise<void> {
  const existing = await readStageEntryJournalV1(taskFolderUri);
  if (!existing || existing.transitionId !== transitionId) {
    return;
  }
  try {
    await vscode.workspace.fs.delete(getStageEntryJournalUri(taskFolderUri));
  } catch {
    // Already gone — fine.
  }
}

/** Outcome of {@link recoverStageEntryJournalV1}'s Phase A. */
export type StageEntryJournalRecoveryOutcomeV1 =
  /** No journal was present — nothing to decide. */
  | { readonly kind: "nothing-to-do" }
  /** A journal file existed but could not be parsed. It carries no
   * transitionId, phase or expected hash that could ever be proven against
   * the artifact, so the artifact is left exactly as-is (never touched
   * without proof) and the unreadable journal file itself is discarded — see
   * {@link StageEntryJournalUnreadableErrorV1}'s doc comment for why this is
   * the only function allowed to do that discarding. */
  | { readonly kind: "unreadable-journal-discarded" }
  /** The transition committed (its journal is now marked `"committed"`, or
   * already was). `deferredAdoption`, when set, is Phase B's replay payload —
   * not applied by THIS function (Phase A only decides and, for a
   * not-committed outcome, rolls back). The journal is intentionally left in
   * place here; {@link recoverStageEntryJournalV1} — the caller of this
   * function — runs Phase B (replay) and Phase C (journal cleanup) for a
   * `"committed"` outcome once this function's own lock hold has released. */
  | {
      readonly kind: "committed";
      readonly transitionId: string;
      readonly deferredAdoption?: PlanRevisionAdoptionV1;
    }
  /** The transition did not commit. The journal has been deleted; `action`
   * describes what (if anything) was done to the artifact. */
  | {
      readonly kind: "rolled-back";
      readonly transitionId: string;
      readonly action: StageEntryRollbackActionV1;
    };

export type StageEntryRollbackActionV1 =
  | "left-untouched-no-write-attempted"
  | "deleted-first-seed"
  | "restored-prior-content"
  | "nothing-to-undo-write-never-landed"
  | "left-untouched-unrecognized-content";

async function readCanonicalBytesV1(taskFolderUri: vscode.Uri): Promise<Uint8Array | undefined> {
  const uri = getCanonicalImplementationUri(taskFolderUri);
  if (!(await statIfExists(uri))) {
    return undefined;
  }
  return vscode.workspace.fs.readFile(uri);
}

/**
 * Locate and verify a restore source for a revision re-finalization's prior
 * content: the frozen pre-revision snapshot first (the source `publish()`
 * itself prefers — see `preparePlanPromotion`'s doc comment), falling back to
 * the mutable `_prev` backup. Either is used ONLY when its hash equals the
 * journaled `priorArtifact.sha256` — proof it is genuinely the bytes this
 * transition overwrote, not some other write's leftovers.
 */
async function findVerifiedPriorContentV1(
  taskFolderUri: vscode.Uri,
  expectedSha256: string
): Promise<Uint8Array | undefined> {
  const journalSnapshotUri = getPlanRevisionJournalUri(taskFolderUri);
  if (await statIfExists(journalSnapshotUri)) {
    const bytes = await vscode.workspace.fs.readFile(journalSnapshotUri);
    if (sha256HexV1(bytes) === expectedSha256) {
      return bytes;
    }
  }
  const backupUri = previousVersionUri(getCanonicalImplementationUri(taskFolderUri));
  if (await statIfExists(backupUri)) {
    const bytes = await vscode.workspace.fs.readFile(backupUri);
    if (sha256HexV1(bytes) === expectedSha256) {
      return bytes;
    }
  }
  return undefined;
}

/**
 * Phase A: decide whether a journaled transition committed, and roll back the
 * artifact when it did not — "proof before touching the file" throughout (see
 * this function's own case-by-case comments). Runs under a bare
 * `withTaskLock`; makes no `patchTaskProgressStrictV1` call of its own (only a
 * read).
 *
 * A `"rolled-back"` or `"unreadable-journal-discarded"` outcome is fully
 * resolved by the time this bare lock hold releases: the journal is already
 * deleted, and there is nothing left to replay. A `"committed"` outcome is
 * NOT fully resolved yet — see `recoverAndReplayCommittedJournalV1` below,
 * which this function calls, lock released, once Phase A's own lock hold has
 * returned.
 */
async function recoverStageEntryJournalPhaseAV1(
  taskFolderUri: vscode.Uri
): Promise<StageEntryJournalRecoveryOutcomeV1> {
  // The lock hold covers only the decide-and-write-or-rollback sequence
  // itself. The run-log line is written AFTER `withTaskLock` returns (the
  // plan's own ordering: "After the lock is released, write one run-log line
  // describing what rollback did") — `writeRunLog` does its own directory
  // listing/numbering I/O that has no need of the cross-process task lease.
  let logLine: string | undefined;
  let logStage: TaskStage | undefined;
  const outcome = await withTaskLock(taskFolderUri.fsPath, async (): Promise<StageEntryJournalRecoveryOutcomeV1> => {
    const raw = await readStageEntryJournalRawV1(taskFolderUri);
    if (raw.kind === "absent") {
      return { kind: "nothing-to-do" };
    }

    const progressRead = await readTaskProgressStrictV1(taskFolderUri);
    const currentStage = progressRead.ok ? progressRead.decoded.progress.currentStage : undefined;

    if (raw.kind === "corrupt") {
      // No transitionId, phase or expectedSha256 survived parsing, so
      // nothing can be proven against the artifact — it is left exactly
      // as-is. The unreadable journal is discarded (deliberately, logged)
      // so it cannot block every future transition forever; see
      // StageEntryJournalUnreadableErrorV1's doc comment for why only this
      // function may do that discarding.
      logStage = currentStage ?? "desc";
      try {
        await vscode.workspace.fs.delete(getStageEntryJournalUri(taskFolderUri));
      } catch {
        // Already gone — fine.
      }
      logLine =
        "Recovered an unreadable stage-entry journal: its contents could not be parsed, so no transition " +
        "identity or artifact hash could be proven. The canonical artifact was left untouched and the " +
        "corrupt journal file was discarded so it cannot block a future transition indefinitely.";
      return { kind: "unreadable-journal-discarded" };
    }

    const journal = raw.journal;
    logStage = journal.to;
    const committed = journal.phase === "committed" || currentStage === journal.to;

    if (committed) {
      if (journal.phase !== "committed") {
        await writeStageEntryJournalV1(taskFolderUri, { ...journal, phase: "committed" });
      }
      logLine =
        `Recovered a stage-entry journal (${journal.transitionId}, ${journal.from} -> ${journal.to}): ` +
        "the transition had already committed; replaying its post-commit payload (Phase B) before cleanup (Phase C).";
      return { kind: "committed", transitionId: journal.transitionId, deferredAdoption: journal.deferredAdoption };
    }

    const action = await rollbackJournaledArtifactV1(taskFolderUri, journal);
    await deleteStageEntryJournalV1(taskFolderUri, journal.transitionId);
    logLine =
      `Recovered a stage-entry journal (${journal.transitionId}, ${journal.from} -> ${journal.to}): ` +
      `the transition did not commit. Rollback action: ${action}.`;
    return { kind: "rolled-back", transitionId: journal.transitionId, action };
  });

  if (logLine && logStage) {
    await logRecoveryLineV1(taskFolderUri, logStage, logLine);
  }
  return outcome;
}

/**
 * Phase B + Phase C for a journal Phase A found `"committed"` — delegates
 * both to {@link runStageEntryPostCommitV1} (`stageTransition.ts`), the SAME
 * function the non-crash post-commit path calls, so "apply the deferred plan-
 * revision adoption, then clean up the journal" has exactly one
 * implementation rather than a duplicate one here (review fix, 2026-09-23,
 * completion blocker). Runs with NO lock held on entry (Phase A's own hold
 * has already released by the time its caller reaches this) —
 * `runStageEntryPostCommitV1` acquires the task lock itself for both the
 * deferred-adoption write and its own Phase C journal delete, so calling it
 * here while still holding Phase A's lock would self-deadlock.
 *
 * The payload built here carries no `postCommit` closure: a closure cannot
 * survive a crash or cross a process boundary, so only what the journal
 * itself persisted (`deferredAdoption`) is available to replay. Once a
 * future step needs recovery to also replay caller-supplied follow-up work
 * (e.g. Part 9's departed-stage decision retirement), the journal will need
 * to persist enough data to reconstruct an equivalent closure here — see this
 * module's own doc comment ("still open, in the plan's own order").
 *
 * `runStageEntryPostCommitV1`'s own Phase C delete is keyed on
 * `transitionId` — the "deleted only by a caller that just read the same
 * transition" ownership rule ({@link deleteStageEntryJournalV1}'s doc
 * comment). If some OTHER process has, in the meantime, also recovered this
 * exact journal and moved a NEW transition past it, that new journal's
 * `transitionId` will differ and the delete is a safe no-op.
 */
async function recoverAndReplayCommittedJournalV1(
  taskFolderUri: vscode.Uri,
  transitionId: string,
  deferredAdoption: PlanRevisionAdoptionV1 | undefined
): Promise<void> {
  await runStageEntryPostCommitV1(taskFolderUri, {
    deferredPlanRevisionAdoption: deferredAdoption,
    journalTransitionId: transitionId,
  });
}

/**
 * The full three-phase recovery: Phase A (decide, roll back if the
 * transition never committed — {@link recoverStageEntryJournalPhaseAV1}),
 * then, only for a `"committed"` outcome and with Phase A's lock already
 * released, Phase B (replay the journal's `deferredAdoption` payload) and
 * Phase C (delete the journal, keyed on the transition Phase A captured —
 * {@link recoverAndReplayCommittedJournalV1}). A `"rolled-back"` or
 * `"unreadable-journal-discarded"` outcome needs neither: Phase A already
 * deleted the journal for those cases, and there is nothing committed to
 * replay.
 *
 * Idempotent: a concurrent or repeated call finds `"nothing-to-do"` once the
 * journal is gone, and Phase C's own `deleteStageEntryJournalV1` no-ops on a
 * transitionId mismatch rather than deleting a newer journal.
 */
export async function recoverStageEntryJournalV1(
  taskFolderUri: vscode.Uri
): Promise<StageEntryJournalRecoveryOutcomeV1> {
  const outcome = await recoverStageEntryJournalPhaseAV1(taskFolderUri);
  if (outcome.kind === "committed") {
    await recoverAndReplayCommittedJournalV1(taskFolderUri, outcome.transitionId, outcome.deferredAdoption);
  }
  return outcome;
}

/**
 * Proactive-recovery entry point (Part 2, item 15 hardening, still-open call
 * sites): a cheap, lock-free existence probe first — the overwhelmingly
 * common case is "no journal at all", which costs one `stat` — and only then
 * the full three-phase {@link recoverStageEntryJournalV1}. For a caller that
 * is about to trust whatever the canonical artifact currently holds on disk
 * but does not itself hold `withTaskLock` (this function's full recovery path
 * acquires that lock itself, so a caller that already holds it would
 * self-deadlock — see each call site's own doc comment for why none of them
 * do).
 *
 * Returns `undefined` when there was nothing to recover, so a caller can tell
 * "no journal" apart from "recovered a rolled-back/committed one" without a
 * second read.
 */
export async function recoverStageEntryJournalIfPresentV1(
  taskFolderUri: vscode.Uri
): Promise<StageEntryJournalRecoveryOutcomeV1 | undefined> {
  const probe = await readStageEntryJournalRawV1(taskFolderUri);
  if (probe.kind === "absent") {
    return undefined;
  }
  return recoverStageEntryJournalV1(taskFolderUri);
}

/**
 * Reads the current canonical artifact and, when proof allows, mutates it
 * (delete or restore) — the whole read-decide-mutate sequence runs inside
 * {@link withPlanFileWriteLockV1} for `plan-final.md`, nested under the
 * `withTaskLock` hold {@link recoverStageEntryJournalV1} already has. That is
 * what makes the hash check and the mutation atomic with respect to every
 * OTHER in-process writer of this same artifact (a checklist merge, a human
 * editor save, `applyReviewerVerifiedTicksConfirmedV1`, …) — all of them
 * queue through the same per-uri primitive, so none of them can land between
 * this function's hash check and its delete/restore.
 */
async function rollbackJournaledArtifactV1(
  taskFolderUri: vscode.Uri,
  journal: StageEntryJournalV1
): Promise<StageEntryRollbackActionV1> {
  if (journal.phase === "intent") {
    // Nothing was ever written by this transition (no `publish()` call
    // reached the artifact write) — any plan-final.md present is not this
    // transition's, so it is never touched. No canonical-artifact I/O at all,
    // so no lock is needed for this branch.
    return "left-untouched-no-write-attempted";
  }

  const canonicalUri = getCanonicalImplementationUri(taskFolderUri);
  return withPlanFileWriteLockV1(canonicalUri, async (): Promise<StageEntryRollbackActionV1> => {
    // phase is "publishing" or "published" — the artifact write may or may
    // not have landed. Hash whatever is on disk NOW (inside the lock) and
    // compare against proof.
    const currentBytes = await readCanonicalBytesV1(taskFolderUri);
    const currentHash = currentBytes ? sha256HexV1(currentBytes) : undefined;

    if (journal.expectedSha256 !== undefined && currentHash === journal.expectedSha256) {
      // Provably this transition's bytes — safe to undo.
      if (journal.priorArtifact === "absent") {
        if (currentBytes !== undefined) {
          await vscode.workspace.fs.delete(canonicalUri);
        }
        return "deleted-first-seed";
      }
      const restored = await findVerifiedPriorContentV1(taskFolderUri, journal.priorArtifact.sha256);
      if (restored !== undefined) {
        // Written as the exact verified bytes (no TextDecoder/TextEncoder
        // round trip through `writeAtomic`'s string-only signature) — the
        // hash that verified `restored` against `priorArtifact.sha256` was
        // computed over these bytes, so only these exact bytes may land.
        await writeCanonicalBytesAtomicV1(canonicalUri, restored);
        return "restored-prior-content";
      }
      // No verified restore source available — leave the file exactly as this
      // transition left it rather than guessing; the next promotion attempt
      // will re-derive from plan.md with ticks merged from whatever source is
      // available, same as an ordinary re-finalization.
      return "left-untouched-unrecognized-content";
    }

    if (
      (journal.priorArtifact === "absent" && currentBytes === undefined) ||
      (journal.priorArtifact !== "absent" && currentHash === journal.priorArtifact.sha256)
    ) {
      // The write never landed (or nothing has changed since before it) —
      // nothing to undo.
      return "nothing-to-undo-write-never-landed";
    }

    // Neither this transition's bytes nor the untouched prior state: someone
    // else (a person, or a legitimate later writer) has touched the file
    // since. Leave it exactly as-is.
    return "left-untouched-unrecognized-content";
  });
}

/**
 * Atomically (temp file + rename) writes `bytes` to `targetUri` EXACTLY as
 * given — no text decode/encode round trip, so a verified-by-hash restore
 * source lands byte-for-byte. Uses the same temp-name convention as
 * `writeAtomic` ({@link formatAtomicTempBasename}) so the privacy classifier
 * still recognizes and ignores any crash-orphaned temp file.
 */
async function writeCanonicalBytesAtomicV1(targetUri: vscode.Uri, bytes: Uint8Array): Promise<void> {
  const targetPath = targetUri.fsPath;
  const dir = path.dirname(targetPath);
  const tempFilename = formatAtomicTempBasename(
    path.basename(targetPath),
    `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}`
  );
  const tempPath = path.join(dir, tempFilename);
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(tempPath, bytes);
    await fs.promises.rename(tempPath, targetPath);
  } catch (error) {
    try {
      await fs.promises.unlink(tempPath);
    } catch {
      // Best-effort temp cleanup; the original file is untouched either way.
    }
    throw error;
  }
}

async function logRecoveryLineV1(
  taskFolderUri: vscode.Uri,
  stage: TaskStage,
  line: string
): Promise<void> {
  try {
    await writeRunLog(taskFolderUri, "stage-entry-recovery", stage, `# Stage-Entry Recovery\n\n${line}\n`);
  } catch {
    // Best-effort — recovery itself must never fail because logging did.
  }
}
