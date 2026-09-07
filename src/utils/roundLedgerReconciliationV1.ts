/**
 * Round-ledger reconciliation, pass (a) — "orphan starts" (wf "make the stage
 * chat a record of work" Part 4 / item 1, plan step 14).
 *
 * `TaskProgress.roundLedger` rows are opened `"scheduled"`/`"open"` by the
 * dispatch paths that start a round (today: `claimReviewAttempt`,
 * `reviewActions.ts` — see `roundLedgerV1.ts`'s own doc comment for what
 * remains unwired). If the process that would have terminalized a row dies
 * first — the extension host crashes, the window closes mid-round — that row
 * sits `"open"` forever with no ending, which is exactly the "rounds begin and
 * then simply cease to exist" defect this task exists to fix, just moved from
 * the chat transcript into the ledger that now backs it.
 *
 * This module closes those rows as `"interrupted"` once nothing live remains
 * that could still terminalize them. Checked PER ROW where the row carries an
 * identity to check (`operationId` against `liveOperationIds`, or `intentId`
 * against `liveSchedulingIntentIds`) — a task-wide "is ANYTHING live right
 * now" boolean over-protects: a task's rounds ARE exclusive-locked one at a
 * time in the steady state, but that invariant is exactly what a crash can
 * violate (a fresh round starts, and is genuinely live, while an EARLIER
 * row from a still-unreconciled crash sits open from a previous window) —
 * checked task-wide, that earlier stale row would be shielded from
 * orphan-closure for as long as ANYTHING else is live on the task, which can
 * be indefinitely (2026-08-27 review follow-up, blocker "orphan
 * reconciliation still returns early on task-wide booleans... rather than
 * checking each row's own operationId or intentId"). A row that carries
 * NEITHER id — a review round's row is opened under its own
 * independently-minted `reviewAttemptId` before the coordinator's
 * `operationId` exists (see `terminalizeRoundV1`'s doc comment), and some
 * manually-dispatched rows never acquire an `intentId` either — has nothing
 * to check per-row and falls back to the task-wide booleans exactly as
 * before; this is a narrower, still-honest degradation rather than the
 * blanket over-protection the task-wide check used to apply to every row.
 *
 * Deliberately conservative: this only ever closes a row as `"interrupted"`
 * with a short, honest `outcome.rejectionReason` naming when it started and
 * that no ending was recorded — the row's own `stage`/`mode`/`startedAt` are
 * still preserved, and this never invents files changed, a score, or any
 * other fact about what the round actually did. Callers wire this into
 * `TaskActionScheduler.armAll()` (reconciliation runs BEFORE
 * `armPendingImplRecoveries()` re-arms anything, per step 14's ordering
 * requirement, on both activation and the periodic sweep).
 *
 * Passes (b) and (c) are implemented below `reconcileOrphanedRoundLedgerRowsV1`
 * (pass (a)):
 *
 *  - Pass (b), `repairMissingRoundOutcomeMessagesV1`: every TERMINAL
 *    `roundLedger` row with no `kind: "outcome"` chat message carrying its
 *    `roundId` gets exactly one appended, best-effort. This repairs the crash
 *    window `terminalizeRoundV1`'s own doc comment already names (the ledger
 *    write lands, the chat write throws) and is what projects a pass-(c)
 *    synthesized row's ending into the transcript.
 *  - Pass (c), `synthesizeLegacyRoundLedgerRowsV1`: every `_Auto-starting_`
 *    chat message written before `kind`/`intentId` existed (no `kind`, no
 *    `intentId`) gets a `roundLedger` row synthesized ONCE, already closed
 *    `"interrupted"` (a legacy transcript's true ending, if any, was never
 *    recorded and cannot be reconstructed) — deterministically keyed by the
 *    message's own index and timestamp (`legacy:<index>:<at>`) so re-running
 *    this pass never synthesizes a second row for the same message. Pass (b)
 *    then projects that row's ending into the transcript on the same or a
 *    later sweep.
 *
 * `reconcileRoundLedgerV1` runs (c), then (a), then (b), in that order, so a
 * freshly-synthesized legacy row is eligible to be picked up by (a) (a
 * "started, never ending" row with nothing live is exactly what (a) closes —
 * though (c) already closes its own rows as interrupted directly, since a
 * legacy message's true liveness can never be determined) and always gets its
 * outcome message from (b) within the same call.
 */
import * as vscode from "vscode";
import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import { appendChatMessageV1, ChatMessage, readChatHistory } from "./chatHistoryStore";
import { formatRoundOutcomeMessageV1, terminalizeRoundV1 } from "./roundLedgerV1";
import { resolveRoundV1, upsertRoundLedgerEntryV1 } from "./taskProgressTransforms";
import { RoundLedgerEntryV1, RoundLedgerModeV1, STAGE_ORDER, TaskProgress, TaskStage } from "../types/taskProgress";
import { formatTimeHHmm } from "./timeFormat";
import { STALE_DISPATCH_GRACE_MS } from "./taskWatchdogV1";

function isTaskStage(value: unknown): value is TaskStage {
  return typeof value === "string" && (STAGE_ORDER as readonly string[]).includes(value);
}

/** A legacy auto-start line has no `kind`/`intentId` at all — every message
 * written by the current `announceAutoStartBestEffortV1` carries `kind:
 * "activity"` (and `intentId` where the caller has one), so the absence of
 * BOTH is what distinguishes a genuinely pre-existing transcript entry from a
 * current one that simply had no `intentId` to thread through. */
function isLegacyAutoStartMessageV1(message: ChatMessage): boolean {
  return (
    message.kind === undefined &&
    message.intentId === undefined &&
    typeof message.text === "string" &&
    message.text.trim().startsWith("_Auto-starting:")
  );
}

export interface ReconcileOrphanedRoundLedgerRowsInputV1 {
  readonly taskFolderUri: vscode.Uri;
  /** True when `taskOperations.getTaskOperations(taskFolderPath)` is
   * non-empty for this task — a genuinely live in-flight round. Retained as
   * the fallback protection for a row that carries neither `operationId` nor
   * `intentId` to correlate against (see `liveOperationIds` below). */
  readonly hasLiveOperation: boolean;
  /** True when this task has a `"scheduled"`/`"running"` scheduling-intent
   * entry (`hasLiveSchedulingIntentBestEffortV1`, `schedulingIntentV1.ts`) —
   * covers the announce-then-dispatch window before a live operation is
   * registered. Same fallback role as `hasLiveOperation` above. */
  readonly hasLiveSchedulingIntent: boolean;
  /**
   * `id`s of every live `TaskOperationSnapshot` for this task
   * (`taskOperations.getTaskOperations(taskFolderPath).map(op => op.id)`) —
   * the row-identifying counterpart to `hasLiveOperation` (2026-08-27 review
   * follow-up, blocker "orphan reconciliation still returns early on
   * task-wide booleans... rather than checking each row's own operationId or
   * intentId"). A row whose `operationId` is one of these is protected
   * regardless of what else is live for the task; a row whose `operationId`
   * is set but NOT among these is an orphan even if some OTHER round is live
   * for the same task.
   */
  readonly liveOperationIds: readonly string[];
  /**
   * `intentId`s of every `"scheduled"`/`"running"` scheduling-intent entry
   * for this task (`liveSchedulingIntentIdsBestEffortV1`), or `undefined`
   * when this could not be determined — the row-identifying counterpart to
   * `hasLiveSchedulingIntent`. `undefined` means "indeterminate": a row whose
   * `intentId` cannot be checked against a real list is protected
   * conservatively (fail-open), matching `hasLiveSchedulingIntentBestEffortV1`'s
   * own fail-open contract, rather than being treated as definitely orphaned.
   */
  readonly liveSchedulingIntentIds: readonly string[] | undefined;
  /**
   * `roundId`s with a currently-live round-lease entry (`roundLeaseV1.ts`) —
   * the durable, cross-window liveness signal for a CLI-resolved
   * implementation round, which carries neither `operationId` nor `intentId`
   * (see `isRoundLedgerRowProtectedV1`'s doc comment, 2026-09-04 review
   * follow-up). Optional and defaulted to empty so existing callers/fixtures
   * that predate this field keep compiling unchanged; a caller that omits it
   * simply gets the prior (task-wide-fallback-only) protection for an
   * identity-less row, same as before this field existed.
   */
  readonly liveRoundLeaseIds?: readonly string[];
  /**
   * Injectable clock, defaulting to `Date.now()` — lets tests set up a row
   * that is within/past the just-opened grace below without waiting on the
   * wall clock, mirroring `taskWatchdogV1.ts`'s own injectable `now`.
   */
  readonly now?: number;
}

/**
 * A row is protected from orphan-closure when its OWN identity is
 * demonstrably still live — checked in preference to the task-wide booleans,
 * which over-protect (any live round anywhere on the task shields every
 * other open row too, including a genuinely stale one left by an earlier
 * crash). A row carrying NEITHER `operationId` nor `intentId` is the one
 * exception: CLI-resolved implementation rounds cannot acquire coordinator
 * identities, so that legacy-compatible shape deliberately falls back to
 * task-wide liveness until the CLI path gets a durable identity.
 */
function isRoundLedgerRowProtectedV1(
  row: RoundLedgerEntryV1,
  input: ReconcileOrphanedRoundLedgerRowsInputV1
): boolean {
  // 2026-09-06 review follow-up (A1 architectural blocker de9851ef…-0,
  // narrowed a fourth time): every check below depends on SOME OTHER signal
  // having already been successfully written after this row opened — an
  // operationId the coordinator attaches moments later, a scheduling intent,
  // or the round-lease beacon (`roundLeaseV1.ts`). All three can be absent
  // through no fault of a genuinely-live round: the coordinator has not
  // attached its id yet, no scheduling intent was ever used for a manual
  // dispatch, or `markRoundLiveV1`'s `workspaceState` write itself failed
  // (see `claimReviewAttemptWithLiveLeaseV1`'s own doc comment — it warns and
  // proceeds rather than refusing the claim). Unlike any of those, the row's
  // own `startedAt` is ALREADY durable, cross-window evidence: it was written
  // by the very same `patchTaskProgressStrictV1` transaction that opened the
  // row, so it requires no separate signal to have succeeded. A row within
  // `STALE_DISPATCH_GRACE_MS` of its own start is therefore protected
  // unconditionally, using the identical 90-minute margin over the 60-minute
  // CLI ceiling the rest of A1 already uses to distinguish "still within its
  // legitimate runtime" from "definitely dead"
  // (`scheduleTaskResume.ts`'s `armPendingImplRecoveries`,
  // `taskWatchdogV1.ts`'s `isStaleDispatchedImplRecoveryV1`). This closes the
  // exact gap the review identified — "reconciliation protects such a row
  // only when another live operation or scheduling intent happens to exist...
  // another window can still close a genuinely running review" — because
  // protection here no longer depends on any of those signals having landed:
  // a sweep firing moments after (or on the same progress-change event as)
  // the row's own commit can never see it unprotected. Only once a row has
  // been open longer than any round could legitimately still be running does
  // this stop protecting it unconditionally and fall through to the identity/
  // lease checks below.
  const startedAtMs = Date.parse(row.startedAt);
  if (!Number.isNaN(startedAtMs) && (input.now ?? Date.now()) - startedAtMs < STALE_DISPATCH_GRACE_MS) {
    return true;
  }
  // 2026-09-04 review follow-up (A1 architectural blocker): `liveOperationIds`
  // is ONLY ever this window's own process-local `taskOperations` registry —
  // a round genuinely running in a DIFFERENT VS Code window is invisible to
  // it. Checking `liveOperationIds` alone therefore lets one window close a
  // round-ledger row (and the watchdog then pause the task) for a round that
  // is, in fact, still live in another window. The scheduling-intent store IS
  // durable/cross-window, so an operationId row is now ALSO protected when
  // this task still shows a live scheduling intent — narrowing, not
  // eliminating, the false-close window: a round dispatched through the
  // scheduling chokepoint (every `scheduleAutomationChain` call site) keeps a
  // live intent entry for its whole run, so cross-window automation rounds
  // are now safe.
  if (row.operationId !== undefined) {
    if (input.liveOperationIds.includes(row.operationId)) {
      return true;
    }
    // 2026-09-04 review follow-up (A1 architectural blocker, narrowed but not
    // closed by the scheduling-intent check below): a MANUALLY-dispatched
    // review round also attaches an `operationId` once the coordinator starts
    // (`attachCoordinatorIdentityToRoundV1` in `reviewActions.ts`), but has no
    // scheduling intent at all — `liveOperationIds` is this window's
    // process-local registry, so a manual review running live in a DIFFERENT
    // window was still invisible here. `liveRoundLeaseIds` is the same
    // durable, cross-window beacon the CLI-implementation branch below
    // already relies on, keyed by this row's own `roundId` — both
    // `runReviewForFolder` and `resumeReviewInteractionV1` now mark it live
    // for the round's whole lifetime regardless of whether it later attaches
    // an operationId.
    if ((input.liveRoundLeaseIds ?? []).includes(row.roundId)) {
      return true;
    }
    return input.liveSchedulingIntentIds === undefined
      ? true
      : input.liveSchedulingIntentIds.length > 0;
  }
  if (row.intentId !== undefined) {
    return input.liveSchedulingIntentIds === undefined
      ? true
      : input.liveSchedulingIntentIds.includes(row.intentId);
  }
  // CLI-resolved implementation rounds never enter the coordinator, so their
  // live ledger row has no operation or scheduling-intent identity to compare
  // here. `liveRoundLeaseIds` (2026-09-04 review follow-up, closing the
  // architectural blocker left open above: "a manually-dispatched round in
  // another window still has no durable liveness signal") is the durable,
  // cross-window signal purpose-built for exactly this row shape — a live
  // entry means SOME window (this one or another) is actively running this
  // round right now, checked by the row's own `roundId` rather than a
  // task-wide boolean. Only when no lease entry exists at all (a legacy row
  // predating this field, or a lease write that failed) does this fall back
  // to the prior task-wide protection — deliberately conservative either way:
  // closing a live round would make the terminalizer discard its true ending,
  // whereas a stale row is repaired on the first sweep with no live task
  // activity.
  if ((input.liveRoundLeaseIds ?? []).includes(row.roundId)) {
    return true;
  }
  return input.hasLiveOperation || input.hasLiveSchedulingIntent;
}

export interface ReconcileOrphanedRoundLedgerRowsResultV1 {
  /** `roundId`s of every row this call closed as `"interrupted"`. Empty when
   * nothing was orphaned, when the task has live state, or when the task's
   * progress could not be read. */
  readonly closed: readonly string[];
}

/**
 * Close every `"scheduled"`/`"open"` `roundLedger` row for one task as
 * `"interrupted"` when that row's own identity is no longer live. Rows with
 * neither identity retain the conservative historical rule: close only when
 * neither task-wide liveness signal holds. Safe to call repeatedly: rows
 * already closed are simply absent from the next read, and
 * `terminalizeRoundV1` is independently idempotent per row.
 */
export async function reconcileOrphanedRoundLedgerRowsV1(
  input: ReconcileOrphanedRoundLedgerRowsInputV1
): Promise<ReconcileOrphanedRoundLedgerRowsResultV1> {
  const read = await readTaskProgressStrictV1(input.taskFolderUri);
  if (!read.ok) {
    return { closed: [] };
  }
  const openRows = (read.decoded.progress.roundLedger ?? []).filter(
    (row) =>
      (row.state === "scheduled" || row.state === "open") &&
      !isRoundLedgerRowProtectedV1(row, input)
  );
  const closed: string[] = [];
  for (const row of openRows) {
    // Step 14's own wording: "started HH:MM; no ending was recorded — the
    // extension host stopped or the round was lost" — otherwise this pass
    // would close the row silently, leaving the chat transcript's ending
    // just as uninformative as the "rounds begin and then simply cease to
    // exist" defect this whole part exists to fix.
    const startedAt = new Date(row.startedAt);
    const reason = Number.isNaN(startedAt.getTime())
      ? "no ending was recorded — the extension host stopped or the round was lost"
      : `started ${formatTimeHHmm(startedAt)}; no ending was recorded — the extension host stopped or the round was lost`;
    const result = await terminalizeRoundV1(
      row.roundId,
      "interrupted",
      { rejectionReason: reason },
      { taskFolderUri: input.taskFolderUri }
    );
    if (result.ok && !result.alreadyTerminal) {
      closed.push(row.roundId);
    }
  }
  return { closed };
}

export interface RepairMissingRoundOutcomeMessagesInputV1 {
  readonly taskFolderUri: vscode.Uri;
  /** Chat document canonical id, when the task uses a non-default one.
   * Defaults to `taskFolderUri.fsPath`, matching `appendChatMessageV1`'s own
   * default. */
  readonly canonicalId?: string;
}

export interface RepairMissingRoundOutcomeMessagesResultV1 {
  /** `roundId`s of every terminal row this call appended a missing
   * `kind: "outcome"` message for. */
  readonly repaired: readonly string[];
}

/**
 * Pass (b): append exactly one `kind: "outcome"` chat message for every
 * TERMINAL `roundLedger` row that has none yet, deduped by `roundId`. Covers
 * both a `terminalizeRoundV1` call whose ledger write landed but whose
 * best-effort chat write then failed, and a row `synthesizeLegacyRoundLedgerRowsV1`
 * (pass (c)) just created already-terminal. Safe to call repeatedly: a row
 * that already has its message is simply skipped on the next call.
 */
export async function repairMissingRoundOutcomeMessagesV1(
  input: RepairMissingRoundOutcomeMessagesInputV1
): Promise<RepairMissingRoundOutcomeMessagesResultV1> {
  const read = await readTaskProgressStrictV1(input.taskFolderUri);
  if (!read.ok) {
    return { repaired: [] };
  }
  const terminalRows = (read.decoded.progress.roundLedger ?? []).filter(
    (row) => row.state !== "scheduled" && row.state !== "open"
  );
  if (terminalRows.length === 0) {
    return { repaired: [] };
  }
  const taskFolderPath = input.taskFolderUri.fsPath;
  const canonicalId = input.canonicalId ?? taskFolderPath;
  let messages: ChatMessage[];
  try {
    messages = await readChatHistory(taskFolderPath, canonicalId);
  } catch {
    // Best-effort, same reasoning as `synthesizeLegacyRoundLedgerRowsV1`: a
    // corrupt/quarantined transcript must never abort reconciliation for
    // other tasks in the same sweep.
    return { repaired: [] };
  }
  const hasOutcomeMessage = new Set(
    messages
      .filter((m) => m.kind === "outcome" && m.roundId !== undefined)
      .map((m) => m.roundId as string)
  );
  const repaired: string[] = [];
  for (const row of terminalRows) {
    if (hasOutcomeMessage.has(row.roundId)) {
      continue;
    }
    try {
      await appendChatMessageV1(
        taskFolderPath,
        {
          role: "assistant",
          text: formatRoundOutcomeMessageV1(row),
          stage: row.stage,
          at: row.endedAt ?? new Date().toISOString(),
          kind: "outcome",
          roundId: row.roundId,
          ...(row.intentId !== undefined ? { intentId: row.intentId } : {}),
        },
        canonicalId
      );
      repaired.push(row.roundId);
    } catch {
      // Best-effort — a later sweep retries; never blocks reconciliation of
      // other rows for this task.
    }
  }
  return { repaired };
}

export interface SynthesizeLegacyRoundLedgerRowsInputV1 {
  readonly taskFolderUri: vscode.Uri;
  /** Chat document canonical id, when the task uses a non-default one.
   * Defaults to `taskFolderUri.fsPath`. */
  readonly canonicalId?: string;
}

export interface SynthesizeLegacyRoundLedgerRowsResultV1 {
  /** Synthesized `roundId`s (`legacy:<message index>:<message.at>`) — one per
   * legacy `_Auto-starting_` message that had no ledger row yet. */
  readonly synthesized: readonly string[];
}

/**
 * Pass (c): give every legacy `_Auto-starting_` chat message (written before
 * `kind`/`intentId` existed — see `isLegacyAutoStartMessageV1`) a
 * `roundLedger` row, so the "13 starts, zero endings" transcript this task
 * exists to fix acquires durable endings once and only once. Each row is
 * synthesized ALREADY terminal (`"interrupted"`) — a legacy message's true
 * liveness can never be reconstructed, so there is nothing to wait on — under
 * a deterministic id (`legacy:<message index>:<message.at>`) keyed to the
 * message itself, so re-running this pass against an unchanged transcript
 * never synthesizes a second row for the same message. Pass (b) then projects
 * each synthesized row's ending into the transcript.
 */
export async function synthesizeLegacyRoundLedgerRowsV1(
  input: SynthesizeLegacyRoundLedgerRowsInputV1
): Promise<SynthesizeLegacyRoundLedgerRowsResultV1> {
  // Cheap, non-throwing pre-check first — unlike `readChatHistory` (which
  // THROWS for a folder that cannot be verified as a real task root, e.g. a
  // test double or a folder mid-deletion), `readTaskProgressStrictV1` returns
  // `{ok: false}` for exactly that case. Checking this first means a caller
  // sweeping every known task never has this pass abort the whole sweep for
  // one folder that turns out not to be a real, currently-verifiable task.
  const read = await readTaskProgressStrictV1(input.taskFolderUri);
  if (!read.ok) {
    return { synthesized: [] };
  }
  const taskFolderPath = input.taskFolderUri.fsPath;
  const canonicalId = input.canonicalId ?? taskFolderPath;
  let messages: ChatMessage[];
  try {
    messages = await readChatHistory(taskFolderPath, canonicalId);
  } catch {
    // Best-effort: a corrupt/quarantined transcript or a transient store
    // failure must never abort reconciliation for other tasks in the same
    // sweep — a later sweep retries once the underlying issue clears.
    return { synthesized: [] };
  }
  const legacyStarts = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => isLegacyAutoStartMessageV1(message));
  if (legacyStarts.length === 0) {
    return { synthesized: [] };
  }
  const synthesized: string[] = [];
  await patchTaskProgressStrictV1(input.taskFolderUri, (current) => {
    let next: TaskProgress = current;
    let changed = false;
    for (const { message, index } of legacyStarts) {
      const roundId = `legacy:${index}:${message.at}`;
      if (resolveRoundV1(next, roundId)) {
        // Already synthesized on a prior sweep — idempotent no-op.
        continue;
      }
      const stage = isTaskStage(message.stage) ? message.stage : next.currentStage;
      // Best-effort classification from the announcement's own wording —
      // a legacy message names no dispatch mode explicitly, and getting this
      // wrong costs nothing beyond the ledger row's own `mode` label, since
      // the row is synthesized already-terminal with no further routing
      // decision depending on it.
      const mode: RoundLedgerModeV1 = /review/i.test(message.text) ? "review" : "implementation";
      const entry: RoundLedgerEntryV1 = {
        roundId,
        attemptIds: [],
        stage,
        mode,
        startedAt: message.at,
        state: "interrupted",
        endedAt: message.at,
        outcome: {
          rejectionReason:
            "legacy transcript entry — no ending was ever recorded for this round",
        },
      };
      next = upsertRoundLedgerEntryV1(next, entry);
      changed = true;
      synthesized.push(roundId);
    }
    return changed ? next : undefined;
  });
  return { synthesized };
}

export interface ReconcileRoundLedgerInputV1 extends ReconcileOrphanedRoundLedgerRowsInputV1 {
  readonly canonicalId?: string;
}

export interface ReconcileRoundLedgerResultV1 {
  readonly synthesized: readonly string[];
  readonly closed: readonly string[];
  readonly repaired: readonly string[];
}

/**
 * Run every reconciliation pass for one task, in the plan's own order:
 * synthesize legacy rows, then close genuine orphans,
 * then (b) repair any terminal row (including one (c) just synthesized)
 * missing its outcome message. Each pass is independently idempotent, so is
 * this call as a whole — running it twice in a row against unchanged state
 * changes nothing.
 */
export async function reconcileRoundLedgerV1(
  input: ReconcileRoundLedgerInputV1
): Promise<ReconcileRoundLedgerResultV1> {
  const synth = await synthesizeLegacyRoundLedgerRowsV1(input);
  const orphan = await reconcileOrphanedRoundLedgerRowsV1(input);
  const repair = await repairMissingRoundOutcomeMessagesV1(input);
  return { synthesized: synth.synthesized, closed: orphan.closed, repaired: repair.repaired };
}
