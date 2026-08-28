/**
 * Round-identity sidecar log — the allocation-time durability route for the
 * coordinator's `operationId`/`attemptId`, independent of `task-progress.json`
 * (2026-08-28 review fix, architectural blocker "coordinator allocation
 * sites still do not attach operation and attempt identities to a
 * round-ledger row ... at allocation time" / "no Accepted Non-Goal or owner
 * decision removes the requirement").
 *
 * Two prior attempts to attach identity directly onto `TaskProgress.roundLedger`
 * from `onAttemptAllocated` (a `patchTaskProgressStrictV1` write, same as the
 * existing `onPromptAssembled` attach) were tried and reverted the same day:
 * moving that fire-and-forget write's start time earlier shifts when it
 * completes relative to a concurrent OUT-OF-BAND write to `task-progress.json`
 * enough to lose that write's update — `publishOwnershipMatrix.test.ts`'s
 * "paused while the review was running" case reproduces this. See
 * `roundLedgerV1.ts`'s own doc comment for the full history.
 *
 * This module sidesteps that hazard entirely rather than reproducing the
 * failed attempt a third time: `appendRoundIdentityLogEntryBestEffortV1`
 * writes to its OWN file (`round-identity-log.jsonl`, one JSON line per
 * allocated attempt), never `task-progress.json` — so it cannot participate
 * in that file's read-modify-write window, and the regression the two prior
 * attempts hit cannot recur here by construction (there is no shared
 * read-then-later-write race with an unrelated concurrent progress patch,
 * because nothing in this module ever reads or writes `task-progress.json`
 * on the append path). Appends are serialized in-process, per task, via
 * `withPlanFileWriteLockV1` (the same primitive `finalizePlanRevisionBestEffortV1`
 * uses to guard its own sidecar file) and written with `writeAtomic`, so a
 * crash mid-append leaves the file at its previous complete state, never a
 * torn line.
 *
 * `backfillRoundIdentityFromLogV1` is the read side: run by the reconciliation
 * sweep, it attaches any logged `operationId`/`attemptId` onto its matching
 * `roundLedger` row that does not already carry it — closing the "a
 * pre-assembly live attempt ... previously left NO durable identity record
 * anywhere" gap for exactly the crash window (allocation succeeded, the
 * round then died before `onPromptAssembled`'s own disk attach could ever
 * fire) that motivated this file. Mirrors `attachCoordinatorIdentityToRoundBestEffortV1`'s
 * merge semantics (`operationId` attached once and never reassigned,
 * `attemptId` merged into `attemptIds` deduplicated) but, unlike that
 * function, is not restricted to a still-LIVE row: a terminal row whose
 * terminalizer never had the operationId to attach (the orphan-reconciliation
 * pass closed it with no coordinator identity known) is equally worth
 * completing for forensic correlation, and this never touches `state`/
 * `endedAt`/`outcome` — only the two identity fields — so it cannot violate
 * `terminalizeRoundV1`'s "a terminal row's facts are frozen" contract.
 */
import * as vscode from "vscode";
import { readNonEmptyText, withPlanFileWriteLockV1 } from "./fileUtils";
import { writeAtomic } from "../state/writeAtomic";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import { resolveRoundV1, upsertRoundLedgerEntryV1 } from "./taskProgressTransforms";
import { TaskProgress } from "../types/taskProgress";

export const ROUND_IDENTITY_LOG_FILENAME = "round-identity-log.jsonl";

/** Upper bound on retained entries — trimmed oldest-first on append, mirroring
 * `TaskProgress.roundLedger`'s own 200-row cap (a generous multiple of it,
 * since this log additionally covers attempts that never reach a round-ledger
 * row at all — every candidate exhausted before allocation has nothing here
 * to log in the first place, but a genuinely allocated-then-abandoned attempt
 * does). */
export const ROUND_IDENTITY_LOG_MAX_ENTRIES = 500;

export interface RoundIdentityLogEntryV1 {
  readonly roundId: string;
  readonly operationId: string;
  readonly attemptId: string;
  readonly at: string;
}

function getRoundIdentityLogUri(taskFolderUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(taskFolderUri, ROUND_IDENTITY_LOG_FILENAME);
}

function isRoundIdentityLogEntryV1(value: unknown): value is RoundIdentityLogEntryV1 {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.roundId === "string" &&
    typeof candidate.operationId === "string" &&
    typeof candidate.attemptId === "string" &&
    typeof candidate.at === "string"
  );
}

/**
 * Read every entry in the sidecar log, oldest first. Malformed or partial
 * lines (a torn trailing write from a hard crash mid-append — `writeAtomic`
 * prevents this for the write this module performs, but the file format is
 * still defensively tolerant of one) are silently skipped rather than
 * quarantining the whole log, matching this module's own best-effort
 * contract: a missing entry costs only that one round's early correlation,
 * never reconciliation for the rest of the task.
 */
export async function readRoundIdentityLogV1(
  taskFolderUri: vscode.Uri
): Promise<RoundIdentityLogEntryV1[]> {
  const text = await readNonEmptyText(getRoundIdentityLogUri(taskFolderUri));
  if (text === undefined) {
    return [];
  }
  const entries: RoundIdentityLogEntryV1[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRoundIdentityLogEntryV1(parsed)) {
        entries.push(parsed);
      }
    } catch {
      // Skip a malformed/partial line — see doc comment above.
    }
  }
  return entries;
}

/**
 * Append one allocation-time identity record, durably, without touching
 * `task-progress.json`. Best-effort: swallows its own failure, never blocks
 * or slows the coordinator dispatch this observes (mirrors every other
 * `onAttemptAllocated`/`onPromptAssembled` hook's "never allowed to affect
 * dispatch" contract).
 */
export async function appendRoundIdentityLogEntryBestEffortV1(
  taskFolderUri: vscode.Uri,
  entry: RoundIdentityLogEntryV1
): Promise<void> {
  try {
    const logUri = getRoundIdentityLogUri(taskFolderUri);
    await withPlanFileWriteLockV1(logUri, async () => {
      const existing = await readRoundIdentityLogV1(taskFolderUri);
      const next = [...existing, entry];
      const trimmed =
        next.length > ROUND_IDENTITY_LOG_MAX_ENTRIES
          ? next.slice(next.length - ROUND_IDENTITY_LOG_MAX_ENTRIES)
          : next;
      const text = trimmed.map((e) => JSON.stringify(e)).join("\n") + "\n";
      await writeAtomic(logUri, text);
    });
  } catch {
    // Best-effort — see doc comment above.
  }
}

/**
 * Attach every logged entry's `operationId`/`attemptId` onto its matching
 * `roundLedger` row when the row does not already carry it — see this
 * module's own doc comment. A no-op when the log is empty, when no entry
 * resolves to a row (nothing yet claimed a row under that `roundId`, or the
 * row has since been pruned by the ledger's own 200-row cap), or when every
 * resolvable row already carries the identity. Best-effort: a failed patch
 * here never blocks the reconciliation sweep it runs inside.
 */
export async function backfillRoundIdentityFromLogV1(taskFolderUri: vscode.Uri): Promise<void> {
  try {
    const entries = await readRoundIdentityLogV1(taskFolderUri);
    if (entries.length === 0) {
      return;
    }
    await patchTaskProgressStrictV1(taskFolderUri, (current) => {
      let next: TaskProgress = current;
      let changed = false;
      for (const entry of entries) {
        const row = resolveRoundV1(next, entry.roundId);
        if (!row) {
          continue;
        }
        const attemptIds = row.attemptIds.includes(entry.attemptId)
          ? row.attemptIds
          : [...row.attemptIds, entry.attemptId];
        const operationIdChanged = row.operationId === undefined;
        if (!operationIdChanged && attemptIds === row.attemptIds) {
          continue;
        }
        next = upsertRoundLedgerEntryV1(next, {
          ...row,
          attemptIds,
          ...(operationIdChanged ? { operationId: entry.operationId } : {}),
        });
        changed = true;
      }
      return changed ? next : undefined;
    });
  } catch {
    // Best-effort — see doc comment above.
  }
}
