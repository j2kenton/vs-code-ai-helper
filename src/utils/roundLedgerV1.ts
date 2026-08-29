/**
 * `terminalizeRoundV1` — the sole writer of a terminal `RoundLedgerEntryV1`
 * state, the compatibility `TaskProgress.roundOutcomes` classification entry,
 * and the chat transcript's `kind: "outcome"` message (wf "make the stage
 * chat a record of work" Part 4 / item 1).
 *
 * Callers resolve a round by whichever identity they hold (scheduling
 * `intentId`, coordinator `operationId`, or any `attemptId`) — see
 * `resolveRoundV1` (`taskProgressTransforms.ts`) — and this function performs
 * the two writes that must both happen exactly once per round ending:
 *
 *  1. the `TaskProgress.roundLedger` row's `state`/`endedAt`/`outcome`
 *     (and, optionally, the compatibility `roundOutcomes` entry), in one
 *     `patchTaskProgressStrictV1` transaction so the two can never observably
 *     disagree about whether a round ended;
 *  2. the chat transcript's outcome message, best-effort AFTER the ledger
 *     write has landed — a failure here does not roll back the terminal
 *     ledger state (which is durable and authoritative); the reconciliation
 *     sweep's pass (b) is what repairs a missing outcome message for a
 *     terminal row on the next activation/periodic sweep.
 *
 * Idempotent: a second call against a row already in a terminal state is a
 * logged no-op — it neither re-terminalizes the row nor writes a second
 * outcome message.
 *
 * WIRED so far only into the review-round path: `claimReviewAttempt`
 * (`reviewActions.ts`) opens the `state: "open"` row at a review round's
 * real start, in the same transaction as the attempt claim, and
 * `handleReviewRoutingOutcome` / `terminalizeUnclosedReviewRoundV1` are the
 * two call sites that terminalize it — the latter a safety net covering
 * every non-"completed" review outcome and any "completed" outcome whose own
 * routing never reaches the former. Every one of those terminalization call
 * sites also forwards the coordinator's own `operationId`/`attemptId`
 * (`TaskActionOutcomeV1.correlation`, read via `outcomeCorrelationV1` where
 * the outcome kind is not narrowed) into `terminalizeRoundV1`'s
 * `operationId`/`attemptId` options, so the row `claimReviewAttempt` opened
 * under its own independently-minted `reviewAttemptId` is enriched with the
 * coordinator's identities once the provider call actually completes —
 * `resolveRoundV1` can then find the row by any of the three. The row's own
 * `roundId` is never replaced: `claimReviewAttempt` opens it before the
 * coordinator call is dispatched, so no coordinator id exists yet at open
 * time, only at the terminal write.
 *
 * ATTACHED AT ALLOCATION TIME, not only at the terminal write, as of the
 * 2026-08-27 architectural-blocker follow-up: both review-round call sites
 * (`runReviewForFolder`'s initial dispatch, `resumeReviewInteractionV1`'s
 * resume drive) now call `attachCoordinatorIdentityToRoundV1`
 * from inside their `onPromptAssembled` callback — the moment the
 * coordinator's `operationId`/`attemptId` for THIS attempt exist
 * (`runProviderRow`, `taskActionCoordinatorV1.ts`), well before the round
 * ends. This closes the review-round half of the "coordinator-owned
 * lifecycle identity" blocker: a review round's row now carries a real
 * `operationId` for its entire live window, not only from its terminal write
 * onward, so a crash mid-round leaves a row reconciliation
 * (`roundLedgerReconciliationV1.ts`) can check per-identity rather than
 * falling back to the task-wide liveness booleans.
 *
 * NARROWED FURTHER (2026-08-28 review, blocker "coordinator allocation sites
 * still do not synchronously attach durable round identities before
 * pre-prompt failures can return"): `onPromptAssembled` only fires once an
 * attempt reaches successful prompt assembly (`assembleAttemptPromptV1`
 * returning ok), so an attempt that fails BEFORE that point — every
 * candidate exhausted before invocation (`providerUnavailablePreInvocation`
 * at `taskActionCoordinatorV1.ts`'s two `noneRemaining` branches, one inside
 * `runProviderRow`'s invocation loop, one inside `admitAction`'s own
 * pre-admission loop) — was previously never recorded anywhere, not even at
 * the round's own terminal write. `TaskActionRequestV1`/
 * `TaskActionResumeRequestV1` now also carry `onAttemptAllocated`, which
 * fires synchronously the instant `session.allocateAttempt()` returns, at
 * every one of the coordinator's attempt-allocation sites, strictly before
 * any of those failure branches can execute.
 *
 * Both review-round call sites (`runReviewForFolder`, `resumeReviewInteractionV1`)
 * persist the attachment from their awaited `onAttemptAllocated` callback and
 * also keep an in-memory `observedCoordinatorAttemptIds` record. Wiring both hooks to
 * attach to disk independently was tried first and reverted the same day:
 * moving a fire-and-forget `patchTaskProgressStrictV1` write's start time
 * earlier (to allocation time instead of post-assembly) shifts when it
 * completes relative to a concurrent out-of-band progress write enough to
 * lose that write's update — `publishOwnershipMatrix.test.ts`'s "paused
 * while the review was running" case caught it, reproducibly, even with only
 * ONE such write per attempt (moved earlier), not just with two. The
 * in-memory push instead reaches disk only through the SAME already-proven
 * path every id in that array already takes: forwarded as
 * `extraCoordinatorAttemptIds` into whichever `terminalizeRoundV1` call ends
 * the round. `onPromptAssembled` at those two call sites is UNCHANGED from
 * before this review (still does both the push and the disk attach) — so a
 * pre-assembly-failed attempt is now recorded on the row at ROUND END
 * (through the existing, safe forwarding path) rather than live during the
 * round, which is a real improvement without the disk-write timing risk.
 * CLOSED for the implementation-round path too (2026-08-28 review follow-up,
 * same day): `runTwoPhaseEditActionV1` (`runEditActionV1.ts`) now wires the
 * SAME zero-I/O `onAttemptAllocated` push (`capturedAllocatedAttemptIds`,
 * surfaced as `TwoPhaseEditResultV1.allocatedAttemptIds` /
 * `ImplementationRunResult.allocatedAttemptIds`), forwarded by
 * `executeImplementationRun` (`reviewActions.ts`) into `extraAttemptIds` at
 * every one of its five `terminalizeRoundV1` call sites — the same
 * end-of-round forwarding path the review-round call sites already use, not a
 * new disk-write timing risk. `onPromptAssembled` now retains prompt
 * observability only; identity attachment happens at allocation. Residual,
 * unaffected by this: a CLI-resolved
 * implementation round never goes through this coordinator at all, so it has
 * no `onAttemptAllocated` to wire in the first place — see this module's own
 * "Residual gap" paragraph below, which already documents that case.
 *
 * DURABLE AT ALLOCATION TIME, closing the residual gap the two reverted
 * direct-attach attempts above left open (2026-08-28 review fix, same
 * architectural blocker: "A pre-assembly live attempt therefore still lacks
 * the allocation-time durable identity required by Step 12"): every
 * `onAttemptAllocated` hook wired above (both review-round call sites,
 * `runTwoPhaseEditActionV1`) now ALSO calls
 * `attachCoordinatorIdentityToRoundV1` before provider work begins. This is
 * deliberately not a fire-and-forget write:
 * the direct-attach fix the two NOTEs above document reverting: it sidesteps
 * the hazard by construction rather than trying to time around it — nothing
 * on this write path ever reads or writes `task-progress.json`, so it cannot
 * participate in that file's read-modify-write window and cannot reproduce
 * the `publishOwnershipMatrix.test.ts` regression (verified: the full suite,
 * including that exact test, passes with this wired). The callback is awaited
 * by the coordinator, so an attempt has a real `operationId`/`attemptId` on
 * its ledger row before it can fail or invoke a provider. CLI-resolved
 * implementation rounds remain the documented exception: they do not use
 * the coordinator and are protected by reconciliation's conservative
 * identity-less fallback until that path has a durable identity.
 *
 * EXTENDED to the Copilot-resolved sealed implementation pipeline (same-day
 * follow-up, blocker "wired only for review rounds"): `runTwoPhaseEditActionV1`
 * (`runEditActionV1.ts`) now accepts optional `taskFolderUri`/`roundId`
 * options and, when both are supplied, attaches identity from inside its OWN
 * `onPromptAssembled` closure — the same allocation-time hook, reached via the
 * SAME coordinator call every Copilot-resolved implementation/Fast-Forward/
 * Apply-Review dispatch already makes, rather than a new code path. Threaded
 * from `executeImplementationRun` (`reviewActions.ts`), which passes its own
 * already-claimed `implRoundId` (`claimImplementationRoundLedgerV1`) straight
 * through `runImplementationOrSealedV1`/`runSealedImplementationV1`'s shared
 * `options` spread. Not wired at the `lint.v1` call site
 * (`runLintingFixes.ts`), which claims no `roundLedger` row at all — an
 * absent `roundId` is a no-op there, matching prior behavior exactly. See
 * this module's residual-gap note for the one path this still does not reach
 * (CLI-resolved implementation rounds,
 * which never go through this coordinator at all) and why.
 *
 * PARTIALLY WIRED into the automation-dispatch path (2026-08-27 review
 * follow-up, revised again the same day): `automationChain.ts` now opens a
 * GENERIC `"scheduled"` row for every auto-started dispatch the MOMENT its
 * `intentId` exists — before any of the gates that can still drop it
 * (`stillEnabled`, the root operation ending unsuccessfully) — via
 * `openScheduledAutomationRoundLedgerRowBestEffortV1` below, keyed by that
 * `intentId`; `announceAutoStartBestEffortV1` (`schedulingIntentV1.ts`) then
 * flips that SAME row to `"open"` once the dispatch actually starts running
 * (`openAutomationRoundLedgerRowBestEffortV1`, which falls back to creating a
 * fresh `"open"` row directly only when nothing was scheduled first). Every
 * point this dispatch can end — the two `deps.execute` settle points
 * (immediate and deferred dispatch), AND the `stillEnabled`/root-operation
 * drop gates that fire before `deps.execute` is ever reached — calls
 * `terminalizeRoundV1` on that SAME row, paired 1:1 with the existing
 * `recordTerminalIntentBestEffortV1` calls at those same branches (narrowed
 * blocker, 2026-08-27: "dropped/cancelled scheduling paths record only a
 * terminal scheduling intent, never a ledger ending"), so a row opened this
 * way can never leak `"scheduled"`/`"open"`: every path that terminates the
 * scheduling-intent already terminates the ledger row. This is deliberately
 * GENERIC (mode inferred from the command name alone, `outcome` left unset
 * beyond an error's message or a drop reason) because `automationChain.ts`
 * sees only the command string before dispatch, never the round's actual
 * files-changed/score/blocker facts — a call site with real per-round data
 * (`claimReviewAttempt`, or a future implementation-round integration) always
 * wins the terminal write, since `terminalizeRoundV1` is idempotent and the
 * generic settle point in `automationChain.ts` fires strictly AFTER the
 * dispatched command's own promise (and any internal terminalization it
 * performed) has already resolved.
 *
 * NOW WIRED into the implementation-round path's own rich accounting
 * (2026-08-27 review follow-up, closing the gap this comment used to
 * describe as outstanding): `executeImplementationRun` claims THIS round's
 * own row at its own start via `claimImplementationRoundLedgerV1` — reusing
 * a continuation's row (already opened/linked by
 * `claimImplRecoveryDispatchV1`) or an auto-dispatch's pending generic row
 * when either exists, opening a fresh row under the round's own
 * `promptRoundId` otherwise, which is what closes the "a manually-triggered
 * implementation round receives NO ledger row at all" gap. Every one of its
 * former `appendRoundOutcome` call sites (the gate/degenerate-episode branch,
 * the zero-change branch, the edits-produced/no-edits branches, and the
 * cancellation branch) now calls `terminalizeRoundV1` against that claimed
 * `implRoundId` with the round's real files-changed facts instead, via the
 * `roundOutcomeClassification` option (see `TerminalizeRoundOutcomeClassificationV1`)
 * so the compatibility `roundOutcomes` entry and the ledger's own terminal
 * state are written in the SAME transaction. This module implements the
 * terminalizer itself to the plan's idempotency/ordering contract, verified
 * in isolation against directly-constructed `TaskProgress` fixtures and,
 * for the review and implementation-round paths, against the real
 * `reviewActions.ts` call sites (`roundLedgerV1.test.ts`).
 *
 * Residual gap, unaffected by the above: `runImplementationOrSealedV1`
 * (`runEditActionV1.ts`) still surfaces no coordinator `attemptId`/
 * `operationId` at all for a CLI-resolved dispatch, so an implementation
 * round's ledger row carries no coordinator-issued identity beyond its own
 * `promptRoundId`/`attemptId` — `resolveRoundV1` can still find it by that
 * id, but not by a coordinator `operationId` the way a review round's row
 * can be enriched (see the coordinator-correlation paragraph above). See
 * this task's Accepted Non-Goals (Part 2 step 7) for the same underlying
 * surface gap as it affects prompt retention.
 *
 * The implementation-RECOVERY continuation path's source/continuation
 * linkage IS wired, separately from the rich per-round accounting above
 * (2026-08-27 review follow-up, revised again in the same day's follow-up
 * review): `beginImplementationRecoveryV1` (`implementationRecoveryV1.ts`)
 * now calls `terminalizeRoundV1` ITSELF for the source round — via
 * `fallbackToAnyLiveRow` (resolve by the caller's own hint, else whichever
 * row is currently live for the task) and `synthesizeIfMissing` (open a
 * fresh row under `sourceAttemptId` when nothing is live to reuse) — rather
 * than duplicating the terminal-write/chat-append logic itself, closing the
 * "bypasses the declared sole terminal writer" blocker. The `implRecovery`
 * record (with `sourceRoundId` read off the terminalized entry's own,
 * possibly-synthesized, `roundId`) is written via `postTerminalizePatch`, in
 * the SAME transaction as the termination. `claimImplRecoveryDispatchV1` then
 * links the continuation's own row to it via `continuationOf: sourceRoundId`
 * — reusing the task's existing live row (an auto-dispatched continuation's
 * own generic row, opened by the SAME dispatch moments earlier, resolved by
 * PEEKING that dispatch's staged `intentId` rather than scanning for
 * "whichever row is currently live for this task") rather than opening a
 * second one for the identical round, or synthesizing one under the fresh
 * continuation `attemptId` for a manual rerun. See
 * `implementationRecoveryRoundLedgerV1.test.ts`.
 *
 * Reconciliation sweep status: all three passes are wired in
 * `roundLedgerReconciliationV1.ts`, orchestrated by `reconcileRoundLedgerV1`
 * and called from `TaskActionScheduler.armAll()` (activation + the periodic
 * sweep) — a round-identity backfill runs FIRST (see the "DURABLE AT
 * ALLOCATION TIME" paragraph above), then (c) synthesize legacy rows, then
 * (a) close genuine orphans, then (b) repair any terminal row missing its
 * outcome message. Pass (a) now closes a `"scheduled"`/`"open"` row PER ROW —
 * checked against that row's own `operationId`/`intentId` where the row
 * carries one. A CLI-resolved identity-less implementation row falls back to
 * the task-wide liveness signals, while all identity-bearing rows are checked
 * precisely regardless of which dispatch path opened them; review rows (`claimReviewAttempt`) and
 * implementation rows (`claimImplementationRoundLedgerV1`) are both
 * live-row-opening paths now; passes (b) and (c) operate on terminal rows and
 * legacy chat messages respectively, so they were never limited to one
 * path's rows.
 */
import * as vscode from "vscode";
import {
  ImplementationDispatchModeV1,
  RoundLedgerEntryV1,
  RoundLedgerModeV1,
  RoundLedgerOutcomeV1,
  RoundOutcomeClassificationV1,
  STAGE_DISPLAY_NAMES,
  TaskProgress,
  TaskStage,
} from "../types/taskProgress";
import { PersistedTaskProgressV1 } from "../services/taskProgressDecoderV1";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import { appendRoundOutcome, resolveRoundV1, upsertRoundLedgerEntryV1 } from "./taskProgressTransforms";
import { appendChatMessageV1 } from "./chatHistoryStore";

/** `RoundLedgerEntryV1.state` values `terminalizeRoundV1` may set — every
 * value except the two live states. */
export type RoundLedgerTerminalStateV1 = Exclude<
  RoundLedgerEntryV1["state"],
  "scheduled" | "open"
>;

/** Optional compatibility classification, recorded onto
 * `TaskProgress.roundOutcomes` in the SAME patch as the ledger write, when a
 * caller's round also went through completion accounting. See
 * `RoundOutcomeEntryV1`. */
export interface TerminalizeRoundOutcomeClassificationV1 {
  readonly classification: RoundOutcomeClassificationV1;
  readonly attemptId?: string;
  readonly modelId?: string;
  readonly providerId?: string;
  readonly dispatchMode?: ImplementationDispatchModeV1;
  readonly originatingReviewStage?: TaskStage;
  /**
   * Overrides the ledger row's own `stage` for THIS `roundOutcomes` entry
   * only, when the two must legitimately differ: an implementation round
   * dispatched while the task displays an impl-review stage still resolves
   * its model/quota/fallback chain, and is bookkept by the fallback circuit
   * breaker, under the literal stage `"impl"` (see the `gateStage`/
   * `implBookkeepingStage` split documented at the `reviewActions.ts` call
   * sites this exists for) — while the SAME round's ledger row correctly
   * carries the review stage it actually ran against, for chat rendering.
   * Defaults to the ledger row's own `stage` when omitted, which is correct
   * for every review-round call site (the two are the same there).
   */
  readonly stage?: TaskStage;
}

export interface TerminalizeRoundOptionsV1 {
  readonly taskFolderUri: vscode.Uri;
  /** Chat document canonical id, when the task uses a non-default one.
   * Defaults to `taskFolderUri.fsPath`, matching `appendChatMessageV1`'s own
   * default. */
  readonly canonicalId?: string;
  readonly roundOutcomeClassification?: TerminalizeRoundOutcomeClassificationV1;
  /**
   * The coordinator's own `operationId`/`attemptId` for the provider call
   * that just completed (`TaskActionOutcomeV1.correlation`), when the caller
   * has it (Part 4 architectural fix, 2026-08-27 review, blocker "review rows
   * still use an independent reviewAttemptId and never attach the coordinator
   * operation or provider attempt identities"). Attached onto the row in the
   * SAME transaction as the terminal write: `operationId` only when the row
   * does not already carry one (never overwritten once set — mirrors the
   * entry field's own "attached once, never reassigned" contract), and
   * `attemptId` appended into `attemptIds` when not already present, so
   * `resolveRoundV1` can find this round by whichever identity a caller
   * holds. A review round's `roundId` remains its own independently-minted
   * `reviewAttemptId` (`claimReviewAttempt` opens it before the coordinator
   * call is dispatched, so no coordinator id exists yet at open time) — this
   * only enriches the row with the coordinator's identities once they exist,
   * it never replaces the row's own id.
   */
  readonly operationId?: string;
  readonly attemptId?: string;
  /**
   * Every OTHER coordinator `attemptId` observed for this round beyond the
   * single `attemptId` above (2026-08-27 review, blocker "review rows...
   * omit earlier retry-attempt identities") — e.g. a primary candidate's
   * attempt that failed before a fallback candidate or an item-14
   * same-candidate retry produced the final correlation attached via
   * `attemptId`. A round can accumulate several coordinator attempts
   * (`onPromptAssembled` fires once per attempt); without this, only the
   * LAST attempt was ever attached to the row, so `resolveRoundV1` could not
   * find the round by an earlier attempt's id — exactly the gap the drift
   * test in Part 4 step 12 checks for. Merged into `attemptIds` alongside
   * `attemptId`, deduplicated, in the same terminal-write transaction.
   */
  readonly extraAttemptIds?: readonly string[];
  /**
   * An additional pure transform folded into the SAME `patchTaskProgressStrictV1`
   * transaction as the ledger write and (when supplied) the `roundOutcomes`
   * classification — e.g. `appendReviewRejection`. Exists so a caller whose
   * round ending also needs to record something else durable (a rejection
   * trail entry, a supersession record) never has to split that write across
   * two transactions, which would let the two records observably disagree if
   * either write failed independently. Applied BEFORE the ledger/outcome
   * writes, so it sees the pre-terminalization `TaskProgress`.
   */
  readonly extraPatch?: (current: PersistedTaskProgressV1) => TaskProgress;
  /**
   * When `id` (after `extraPatch`) resolves to no row, or resolves to a row
   * that is not LIVE (`"scheduled"`/`"open"`), fall back to whichever row in
   * `roundLedger` IS live, if any — the "resolve by hint, else whichever row
   * is currently live for this task" pattern `beginImplementationRecoveryV1`
   * needs for a triggering round it may only have a best-effort hint for
   * (Part 4 architectural fix, 2026-08-27 review: "beginImplementationRecoveryV1
   * directly constructs/upserts a terminal row... bypassing the declared sole
   * terminal writer"). Every OTHER caller of `terminalizeRoundV1` holds its
   * own round's real id and must never fall back to an unrelated live row —
   * this defaults to `false`.
   */
  readonly fallbackToAnyLiveRow?: boolean;
  /**
   * Called only when, after resolution AND the `fallbackToAnyLiveRow` scan
   * above, still no row was found — synthesizes a fresh `"open"` row (upserted
   * into the SAME transaction, immediately terminalized) for a round that
   * never had one opened for it (a manually-triggered round whose start
   * predates this file's "claim at start" pattern reaching every dispatch
   * path). `attemptIds`/`startedAt` default when omitted.
   */
  readonly synthesizeIfMissing?: () => Pick<RoundLedgerEntryV1, "roundId" | "stage" | "mode"> &
    Partial<Pick<RoundLedgerEntryV1, "attemptIds" | "startedAt" | "intentId" | "operationId" | "continuationOf">>;
  /**
   * An additional pure transform folded into the SAME transaction as the
   * ledger/outcome writes, applied AFTER them — the mirror of `extraPatch`.
   * Receives the post-write `TaskProgress` and the entry that was just
   * terminalized (so a caller can read its FINAL `roundId`, e.g. to record it
   * as a `sourceRoundId` on other durable state in the same atomic write,
   * rather than needing a second, separately-racing transaction).
   */
  readonly postTerminalizePatch?: (current: TaskProgress, entry: RoundLedgerEntryV1) => TaskProgress;
}

export type TerminalizeRoundResultV1 =
  | {
      readonly ok: true;
      readonly alreadyTerminal: boolean;
      readonly entry: RoundLedgerEntryV1;
      /** The full patched `TaskProgress`, when this call actually wrote (not
       * `alreadyTerminal`) — lets a caller that also needed the SAME
       * transaction's other effects (e.g. `roundOutcomes`, for the fallback
       * circuit breaker's own read) avoid a second, separately-racing read. */
      readonly progress?: TaskProgress;
    }
  | { readonly ok: false; readonly reason: "notFound" | "writeFailed" };

/** The `_Ended: …_` line rendered into the chat transcript for a
 * terminalized round — Part 9 (step 25) owns the FULL rendering contract for
 * this in the webview; this is the durable message TEXT stored in
 * `chat-v1.json`, kept short and self-contained since it is also what a
 * plain-text reader of the transcript sees. */
export function formatRoundOutcomeMessageV1(entry: RoundLedgerEntryV1, sourceStartedAt?: string): string {
  const stageName = STAGE_DISPLAY_NAMES[entry.stage] ?? entry.stage;
  const parts: string[] = [`_Ended: ${stageName} — ${entry.state}`];
  if (entry.continuationOf) {
    const started = sourceStartedAt
      ? new Date(sourceStartedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : "earlier";
    parts.push(`continuation of the round started ${started}`);
  }
  const outcome = entry.outcome;
  if (outcome) {
    if (outcome.rejectionReason) {
      parts.push(outcome.rejectionReason);
    } else if (outcome.score !== undefined) {
      const reviewer = outcome.reviewerBlockers ?? 0;
      const mechanical = outcome.mechanicalBlockers ?? 0;
      parts.push(`score ${outcome.score} · ${reviewer} reviewer / ${mechanical} mechanical blocker(s)`);
    } else if (outcome.filesChangedUnknown) {
      parts.push("files changed (exact set unknown)");
    } else if (outcome.filesChanged !== undefined) {
      parts.push(
        outcome.filesChanged.length > 0
          ? `${outcome.filesChanged.length} file(s) changed`
          : "no files changed"
      );
    }
    if (outcome.reviewerChallengedNonGoal?.length) {
      parts.push(
        `re-raised a blocker the plan declares out of scope: ${outcome.reviewerChallengedNonGoal.join(", ")}`
      );
    }
    if (outcome.continuationOwed) {
      parts.push("a continuation is owed");
    }
  }
  // The dispatch mode is part of the terminal record, not merely metadata in
  // task-progress.json.  A reader needs it to distinguish checklist-driven
  // Implementation from Apply Review and a continuation after the fact.
  parts.push(`mode ${entry.mode}`);
  if (outcome?.runLogPath) {
    parts.push(outcome.runLogPath);
  }
  return parts.join(" — ") + "_";
}

/**
 * Resolve `id` against `taskFolderUri`'s current `roundLedger`, set the
 * terminal `state`/`endedAt`/`outcome` (and optional `roundOutcomes`
 * classification) in one transaction, then best-effort append the chat
 * outcome message. See this module's doc comment for the full contract.
 */
export async function terminalizeRoundV1(
  id: string,
  state: RoundLedgerTerminalStateV1,
  outcome: RoundLedgerOutcomeV1 | undefined,
  options: TerminalizeRoundOptionsV1
): Promise<TerminalizeRoundResultV1> {
  let resultKind: "notFound" | "alreadyTerminal" | "terminalized" = "notFound";
  let finalEntry: RoundLedgerEntryV1 | undefined;

  const patched = await patchTaskProgressStrictV1(options.taskFolderUri, (initial) => {
    const current: TaskProgress = options.extraPatch ? options.extraPatch(initial) : initial;
    let workingProgress = current;
    let row = resolveRoundV1(current, id);
    const rowIsLive = (candidate: RoundLedgerEntryV1 | undefined): boolean =>
      candidate !== undefined && (candidate.state === "scheduled" || candidate.state === "open");
    if (options.fallbackToAnyLiveRow && !rowIsLive(row)) {
      row = (current.roundLedger ?? []).find(
        (entry) => entry.state === "scheduled" || entry.state === "open"
      );
    }
    if (!row && options.synthesizeIfMissing) {
      const factory = options.synthesizeIfMissing();
      row = {
        attemptIds: factory.attemptIds ?? [],
        startedAt: factory.startedAt ?? new Date().toISOString(),
        state: "open",
        roundId: factory.roundId,
        stage: factory.stage,
        mode: factory.mode,
        ...(factory.intentId !== undefined ? { intentId: factory.intentId } : {}),
        ...(factory.operationId !== undefined ? { operationId: factory.operationId } : {}),
        ...(factory.continuationOf !== undefined ? { continuationOf: factory.continuationOf } : {}),
      };
      workingProgress = upsertRoundLedgerEntryV1(current, row);
    }
    if (!row) {
      resultKind = "notFound";
      return undefined;
    }
    if (row.state !== "scheduled" && row.state !== "open") {
      resultKind = "alreadyTerminal";
      finalEntry = row;
      return undefined;
    }
    resultKind = "terminalized";
    const endedAt = new Date().toISOString();
    const candidateAttemptIds = [
      ...(options.attemptId ? [options.attemptId] : []),
      ...(options.extraAttemptIds ?? []),
    ];
    const attemptIds = candidateAttemptIds.reduce(
      (acc, candidate) => (acc.includes(candidate) ? acc : [...acc, candidate]),
      row.attemptIds
    );
    const nextEntry: RoundLedgerEntryV1 = {
      ...row,
      attemptIds,
      ...(row.operationId === undefined && options.operationId !== undefined
        ? { operationId: options.operationId }
        : {}),
      state,
      endedAt,
      ...(outcome !== undefined ? { outcome } : {}),
    };
    finalEntry = nextEntry;
    let next = upsertRoundLedgerEntryV1(workingProgress, nextEntry);
    if (options.roundOutcomeClassification) {
      const c = options.roundOutcomeClassification;
      next = appendRoundOutcome(next, {
        stage: c.stage ?? nextEntry.stage,
        classification: c.classification,
        at: endedAt,
        ...(c.attemptId !== undefined ? { attemptId: c.attemptId } : {}),
        ...(c.modelId !== undefined ? { modelId: c.modelId } : {}),
        ...(c.providerId !== undefined ? { providerId: c.providerId } : {}),
        ...(c.dispatchMode !== undefined ? { dispatchMode: c.dispatchMode } : {}),
        ...(c.originatingReviewStage !== undefined
          ? { originatingReviewStage: c.originatingReviewStage }
          : {}),
      });
    }
    if (options.postTerminalizePatch) {
      next = options.postTerminalizePatch(next, nextEntry);
    }
    return next;
  });

  if (resultKind === "notFound") {
    return { ok: false, reason: "notFound" };
  }
  if (!patched) {
    return { ok: false, reason: "writeFailed" };
  }
  if (resultKind === "alreadyTerminal") {
    console.warn(
      `terminalizeRoundV1: round "${id}" is already terminal (state=${finalEntry?.state}); no-op`
    );
    return { ok: true, alreadyTerminal: true, entry: finalEntry as RoundLedgerEntryV1 };
  }

  const entry = finalEntry as RoundLedgerEntryV1;
  try {
    await appendChatMessageV1(
      options.taskFolderUri.fsPath,
      {
        role: "assistant",
        text: formatRoundOutcomeMessageV1(
          entry,
          entry.continuationOf
            ? patched.roundLedger?.find((candidate) => candidate.roundId === entry.continuationOf)?.startedAt
            : undefined
        ),
        stage: entry.stage,
        at: entry.endedAt ?? new Date().toISOString(),
        kind: "outcome",
        roundId: entry.roundId,
        ...(entry.intentId !== undefined ? { intentId: entry.intentId } : {}),
      },
      options.canonicalId ?? options.taskFolderUri.fsPath
    );
  } catch {
    // Best-effort only — the ledger write above is authoritative and already
    // landed; reconciliation pass (b) repairs a missing outcome message.
  }

  return { ok: true, alreadyTerminal: false, entry, progress: patched };
}

/**
 * Best-effort, coarse classification of a round-ledger row's `mode` from the
 * automation command about to be dispatched — `automationChain.ts` sees only
 * the command string before dispatch, never the rich per-round dispatch-mode
 * facts `RoundOutcomeEntryV1.dispatchMode` captures once a round actually
 * runs. Distinguishes only the buckets a command name can reliably signal;
 * anything else (plan generation, publish checks, review retries dispatched
 * under a differently-named command, etc.) defaults to `"implementation"`,
 * mirroring `resolveIntentMetadataV1`'s own "generic entry" fallback
 * philosophy (`schedulingIntentV1.ts`) rather than inventing a mode this
 * type does not have a value for.
 */
export function roundLedgerModeForCommandV1(command: string): RoundLedgerModeV1 {
  if (/applyReview/i.test(command)) {
    return "apply-review";
  }
  if (/review/i.test(command)) {
    return "review";
  }
  return "implementation";
}

export interface OpenScheduledAutomationRoundLedgerRowOptionsV1 {
  readonly taskFolderUri: vscode.Uri;
  /** The dispatch's own scheduling `intentId`, reused as this row's
   * `roundId` — the SAME id `automationChain.ts`'s settle handlers resolve
   * against to terminalize this row (see this module's own doc comment). */
  readonly roundId: string;
  readonly command: string;
}

/**
 * Open a `"scheduled"` round-ledger row for an automation dispatch the
 * MOMENT it is scheduled (2026-08-27 review follow-up, narrowed blocker "Auto-
 * dispatch rows are still created directly as state: 'open' ... rather than
 * being created as scheduled when scheduled and flipped to open when
 * execution begins"). Called right after `recordScheduledIntentBestEffortV1`
 * resolves an `intentId`, BEFORE the `stillEnabled`/root-operation-outcome
 * gates that can still drop the dispatch — so a chain dropped at any of
 * those gates now has a real `"scheduled"` row to terminalize as
 * `"cancelled"`/`"dropped"` instead of leaving nothing but a scheduling-intent
 * record (the other half of the same narrowed blocker). Reads `stage` from
 * the SAME `patchTaskProgressStrictV1` transaction that creates the row,
 * rather than requiring the caller to pre-read progress the way the
 * announce-time opener below does. A no-op when a row already resolves this
 * `roundId` — never overwrites an existing row. Best-effort: swallows its own
 * failure, never blocks dispatch.
 */
export async function openScheduledAutomationRoundLedgerRowBestEffortV1(
  options: OpenScheduledAutomationRoundLedgerRowOptionsV1
): Promise<void> {
  try {
    await patchTaskProgressStrictV1(options.taskFolderUri, (current) => {
      if (resolveRoundV1(current, options.roundId)) {
        return undefined;
      }
      const scheduledRow: RoundLedgerEntryV1 = {
        roundId: options.roundId,
        intentId: options.roundId,
        attemptIds: [],
        stage: current.currentStage,
        mode: roundLedgerModeForCommandV1(options.command),
        startedAt: new Date().toISOString(),
        state: "scheduled",
      };
      return upsertRoundLedgerEntryV1(current, scheduledRow);
    });
  } catch {
    // Best-effort — never surfaces to the caller, never blocks dispatch.
  }
}

export interface OpenAutomationRoundLedgerRowOptionsV1 {
  readonly taskFolderUri: vscode.Uri;
  /** The dispatch's own scheduling `intentId`, reused as this row's
   * `roundId` — the SAME id `automationChain.ts`'s settle handlers resolve
   * against to terminalize this row (see this module's own doc comment). */
  readonly roundId: string;
  readonly command: string;
  readonly stage: TaskStage;
}

/**
 * Advance an automation-dispatched round's ledger row to `"open"` — the
 * round's real execution start (wf "make the stage chat a record of work"
 * Part 4 step 12/14; narrowed blocker "rows are still created directly as
 * open rather than scheduled"). When a `"scheduled"` row already exists for
 * this `roundId` (the normal case since
 * `openScheduledAutomationRoundLedgerRowBestEffortV1` now runs at schedule
 * time, before this), flips it to `"open"` in place. Falls back to creating a
 * fresh `"open"` row directly when nothing was scheduled first (a caller that
 * skipped the schedule-time open, or one whose schedule-time write failed) —
 * preserving this function's original behavior so a missed schedule-time open
 * never leaves the round with no row at all. A no-op when the resolved row is
 * already `"open"` or terminal — never regresses a terminal state back to
 * live, and never overwrites a terminal row's facts.
 * Best-effort: swallows its own failure, never blocks dispatch.
 */
export async function openAutomationRoundLedgerRowBestEffortV1(
  options: OpenAutomationRoundLedgerRowOptionsV1
): Promise<void> {
  try {
    await patchTaskProgressStrictV1(options.taskFolderUri, (current) => {
      const existing = resolveRoundV1(current, options.roundId);
      if (existing) {
        if (existing.state !== "scheduled") {
          return undefined;
        }
        return upsertRoundLedgerEntryV1(current, { ...existing, state: "open" });
      }
      const openRow: RoundLedgerEntryV1 = {
        roundId: options.roundId,
        intentId: options.roundId,
        attemptIds: [],
        stage: options.stage,
        mode: roundLedgerModeForCommandV1(options.command),
        startedAt: new Date().toISOString(),
        state: "open",
      };
      return upsertRoundLedgerEntryV1(current, openRow);
    });
  } catch {
    // Best-effort — never surfaces to the caller, never blocks dispatch.
  }
}

/**
 * A dispatch's scheduling `intentId`, staged for the automation-dispatched
 * command to pick up and consume as SOON as it opens its own round-ledger
 * row (Part 4 review follow-up, 2026-08-27 blocker "coordinator-owned
 * lifecycle identity" / "Automated rounds now add an intent-keyed generic
 * row while review rows still use a separate synthetic ID"): without this,
 * `announceAutoStartBestEffortV1` opens a GENERIC row keyed by `intentId`,
 * then the dispatched command (when it is a review) independently opens its
 * OWN row keyed by its own `reviewAttemptId` — two rows for one round, and
 * `automationChain.ts`'s generic settle handler can then write a misleading
 * `"completed"` onto the generic row's independent identity even when the
 * review's own richer terminalizer already recorded the round's true ending
 * on the OTHER row.
 *
 * `scheduleAutomationChain` sets this immediately before calling
 * `deps.execute`, keyed by `dispatch.taskKey` (the task folder path, the
 * same string `claimReviewAttempt`'s `folderUri.fsPath` resolves to for that
 * same dispatch); `claimReviewAttempt` consumes it the moment it opens its
 * own row, and — when present — REUSES the generic row instead of opening a
 * second one (see its own doc comment), so the two settle points end up
 * racing to terminalize the SAME row and idempotency picks whichever carries
 * the richer facts.
 *
 * A lightweight, best-effort, in-memory side channel rather than threading
 * `intentId` through every `AutomationDispatch.arg` shape across the ~12
 * `scheduleAutomationChain` call sites (a far larger change) — safe because
 * a task's rounds are exclusive-locked one at a time (`automationChain.ts`'s
 * own duplicate-chain guard, `taskOperations`' exclusive-operation model), so
 * at most one dispatch's `deps.execute` is ever actually in flight for a
 * given task, and therefore at most one pending entry per task key can ever
 * be live. Consuming ALWAYS deletes the entry (hit or miss), and a short TTL
 * bounds how long a leaked entry (a dispatch whose command never reaches a
 * consumer, e.g. Implementation) can survive — it is simply left to expire,
 * unconsumed, with no effect on that dispatch's own (unchanged) generic-row
 * handling.
 *
 * This does NOT attach identity at the coordinator's own operation/attempt
 * allocation sites (`taskActionCoordinatorV1.ts`) — the review's literal
 * ask — because that requires surfacing a coordinator-issued id out of
 * `runImplementationOrSealedV1`/`executeImplementationRun`, which has no
 * such id to surface today (see this task's Remaining Blockers). It DOES
 * eliminate the concrete duplicate-row symptom for every automation-
 * dispatched review, which is the majority of real automatic dispatches
 * (auto-review, auto-advance, Fast Forward, the periodic recovery sweep all
 * dispatch review commands this way).
 *
 * Stale-rebinding fix (2026-08-27 review follow-up, blocker "the replacement
 * task-key/TTL correlation can attach a later review to a stale,
 * already-terminal round"): an entry left unconsumed here (the dispatched
 * command was not a review, or a review errored before reaching
 * `claimReviewAttempt`) can sit in this map — still resolving to a row the
 * generic settle handler has since terminalized — until its TTL expires or a
 * later same-taskKey dispatch overwrites it. `claimReviewAttempt` no longer
 * trusts presence alone: it only reuses the resolved row when that row is
 * still in a LIVE state (`"scheduled"`/`"open"`); a resolved-but-terminal row
 * is discarded exactly as if nothing were pending, so a stale id can no
 * longer reopen an already-ended round under a new review's facts.
 */
const pendingAutomationRoundIntents = new Map<string, { readonly intentId: string; readonly expiresAt: number }>();

/** Generous upper bound on how long a set-but-unconsumed pending intent may
 * linger before it is treated as abandoned — `deps.execute` starting the
 * dispatched command (and that command reaching its own row-open call, when
 * it has one) happens within milliseconds of this being set, so this is
 * purely a leak guard against a dispatch whose command never consumes it. */
export const PENDING_AUTOMATION_ROUND_INTENT_TTL_MS = 2 * 60 * 1000;

/**
 * Stage `intentId` for `taskKey` to be picked up by the next consumer.
 * Overwrites any still-pending entry for the same key — safe, since only one
 * dispatch's command can be in flight for a given task at a time (see this
 * export's own doc comment above), so a second `set` for the same key can
 * only mean the first was already consumed (or genuinely superseded).
 */
export function setPendingAutomationRoundIntentV1(taskKey: string, intentId: string): void {
  pendingAutomationRoundIntents.set(taskKey, { intentId, expiresAt: Date.now() + PENDING_AUTOMATION_ROUND_INTENT_TTL_MS });
}

/**
 * Consume (read and delete) the pending `intentId` staged for `taskKey`, or
 * `undefined` when nothing is pending or the entry has expired. Always
 * deletes on read — a stale or already-consumed entry is never reused.
 */
export function consumePendingAutomationRoundIntentV1(taskKey: string): string | undefined {
  const entry = pendingAutomationRoundIntents.get(taskKey);
  if (!entry) {
    return undefined;
  }
  pendingAutomationRoundIntents.delete(taskKey);
  if (entry.expiresAt < Date.now()) {
    return undefined;
  }
  return entry.intentId;
}

/** Test-only: clear pending-intent state between unit tests. */
export function __resetPendingAutomationRoundIntentsForTestV1(): void {
  pendingAutomationRoundIntents.clear();
}

/**
 * Read (never delete) the pending `intentId` staged for `taskKey`, or
 * `undefined` when nothing is pending or the entry has expired — the
 * non-destructive counterpart to `consumePendingAutomationRoundIntentV1`
 * (2026-08-27 review follow-up, blocker "recovery linkage selects the first
 * task-wide live row rather than resolving the actual source identity",
 * continuation half): `claimImplRecoveryDispatchV1` runs BEFORE
 * `executeImplementationRun`'s own `claimImplementationRoundLedgerV1` claim
 * for the SAME dispatch, and must not consume the entry itself — doing so
 * would starve that later, real consumer, which would then open a SECOND row
 * for the same round instead of reusing the one this peek identifies. Peeking
 * lets the continuation-linkage claim resolve the SPECIFIC row this dispatch
 * already opened (via `openAutomationRoundLedgerRowBestEffortV1`) rather than
 * falling back to "whichever row is currently live for this task", while
 * leaving the entry in place for the real consumer to claim moments later.
 */
export function peekPendingAutomationRoundIntentV1(taskKey: string): string | undefined {
  const entry = pendingAutomationRoundIntents.get(taskKey);
  if (!entry || entry.expiresAt < Date.now()) {
    return undefined;
  }
  return entry.intentId;
}

export interface ClaimedImplementationRoundLedgerV1 {
  /** The row's real `roundId` — either `candidateRoundId` (a fresh row was
   * opened) or the reused pending-automation row's own pre-existing id. */
  readonly roundId: string;
}

/**
 * Claim (open or reuse) THIS implementation round's own `roundLedger` row, at
 * the round's real start — generalizing `claimReviewAttempt`'s "claim at
 * start" pattern to the implementation-round path (Part 4 architectural
 * fix, 2026-08-27 review follow-up, blocker "coordinator-owned lifecycle
 * identity" / "recovery linkage selects the first task-wide live row rather
 * than resolving the actual source identity"): without a round-owned id
 * captured HERE, at the round's own start, every later consumer (recovery
 * linkage chief among them) has nothing to resolve against but "whichever
 * row is currently live for this task" — correct only by the accident that
 * at most one round runs per task at a time, and unable to name the round
 * that actually failed if that ever stops holding.
 *
 * `candidateRoundId` is the caller's own pre-allocated per-round id (e.g.
 * `executeImplementationRun`'s `promptRoundId`, or a continuation's own
 * `attemptId`) — reused as this row's `roundId` when nothing is pending to
 * reuse instead. When this dispatch was auto-started, `scheduleAutomationChain`
 * already opened a GENERIC row keyed by its own `intentId` and staged that id
 * for the dispatched command to consume (`setPendingAutomationRoundIntentV1`)
 * — consumed and reused here exactly as `claimReviewAttempt` does for review
 * rounds, so the round collapses to the ONE row `automationChain.ts`'s own
 * settle handler already knows how to terminalize generically, rather than a
 * second one under `candidateRoundId` racing it. A manually-triggered round
 * has nothing pending and opens a fresh row under `candidateRoundId` — the
 * gap this closes: a manually-triggered implementation round previously
 * received NO ledger row at all.
 *
 * A no-op (returns the existing row's id unchanged) when `candidateRoundId`
 * already resolves to a row — the continuation-linkage case, where
 * `claimImplRecoveryDispatchV1` already opened or reused this exact round's
 * row moments earlier under the same id.
 */
export async function claimImplementationRoundLedgerV1(
  folderUri: vscode.Uri,
  candidateRoundId: string,
  stage: TaskStage,
  mode: RoundLedgerModeV1
): Promise<ClaimedImplementationRoundLedgerV1> {
  const pendingIntentId = consumePendingAutomationRoundIntentV1(folderUri.fsPath);
  let finalRoundId = candidateRoundId;
  await patchTaskProgressStrictV1(folderUri, (current) => {
    const alreadyOwn = resolveRoundV1(current, candidateRoundId);
    if (alreadyOwn) {
      // The continuation-linkage case: this round's row already exists.
      // Nothing to open or reuse.
      finalRoundId = alreadyOwn.roundId;
      return undefined;
    }
    const resolvedPending = pendingIntentId ? resolveRoundV1(current, pendingIntentId) : undefined;
    // Same stale-rebinding guard as `claimReviewAttempt`: only a row still
    // LIVE is eligible for reuse — a resolved-but-terminal row is treated
    // exactly like no pending intent existed.
    const reused =
      resolvedPending && (resolvedPending.state === "scheduled" || resolvedPending.state === "open")
        ? resolvedPending
        : undefined;
    const openRow: RoundLedgerEntryV1 = reused
      ? {
          ...reused,
          attemptIds: reused.attemptIds.includes(candidateRoundId)
            ? reused.attemptIds
            : [...reused.attemptIds, candidateRoundId],
          stage,
          mode,
          state: "open",
        }
      : {
          roundId: candidateRoundId,
          attemptIds: [candidateRoundId],
          stage,
          mode,
          startedAt: new Date().toISOString(),
          state: "open",
          ...(pendingIntentId && !resolvedPending ? { intentId: pendingIntentId } : {}),
        };
    finalRoundId = openRow.roundId;
    return upsertRoundLedgerEntryV1(current, openRow);
  });
  return { roundId: finalRoundId };
}

export interface AttachCoordinatorIdentityToRoundOptionsV1 {
  readonly taskFolderUri: vscode.Uri;
  /** This round's own `roundLedger` row identity, as already known to the
   * caller (e.g. `reviewAttemptId`) — resolved via `resolveRoundV1`. */
  readonly roundId: string;
  readonly operationId: string;
  readonly attemptId: string;
}

/**
 * Attach the coordinator's own `operationId`/`attemptId` to a round's
 * `roundLedger` row AT ALLOCATION TIME — the moment
 * `TaskActionRequestV1.onPromptAssembled` fires, well before the round ends
 * (Part 4 architectural fix, 2026-08-27 review follow-up: "coordinator
 * allocation sites still do not attach operation and attempt identities to a
 * round-ledger row ... correlation instead still depends on the process-local
 * task-key/TTL map ... review rows receive coordinator identities only during
 * terminalization"). Before this, a review round's row spent its ENTIRE live
 * window (`"scheduled"`/`"open"`) with no `operationId` at all — reconciliation
 * (`roundLedgerReconciliationV1.ts`) and any other per-row identity check
 * could not correlate it against a live operation until the round had already
 * ended, when `terminalizeRoundV1`'s own `options.operationId` first attaches
 * it. Calling this from inside `onPromptAssembled` closes that window: the
 * row carries a real coordinator identity for the whole time it is live, not
 * only at its terminal write.
 *
 * A no-op when the row cannot be resolved, or is no longer LIVE (a race with
 * `terminalizeRoundV1` that this loses is expected and harmless — a terminal
 * row's facts are frozen by that function's own contract, never amended
 * here). `operationId` is attached only when the row does not already carry
 * one (the same "attached once, never reassigned" contract
 * `terminalizeRoundV1`'s own `options.operationId` documents); `attemptId` is
 * merged into `attemptIds`, deduplicated — a round may call this once per
 * coordinator attempt (a fresh candidate, a fallback, an item-14 retry), and
 * every one is worth recording, exactly as `extraAttemptIds` does at
 * termination.
 *
 * Best-effort: swallows its own failure, never blocks or slows the round it
 * is merely observing (mirrors `onPromptAssembled`'s own "never allowed to
 * affect dispatch" contract).
 *
 * Wired into the review-round path (`runReviewForFolder`'s initial dispatch
 * and `resumeReviewInteractionV1`'s resume drive, `reviewActions.ts`) and,
 * as of the same-day follow-up fixing the "wired only for review rounds"
 * blocker, into the Copilot-resolved sealed implementation pipeline too:
 * `runTwoPhaseEditActionV1` (`runEditActionV1.ts`) now calls this from its
 * OWN `onPromptAssembled` closure whenever its caller supplies both
 * `taskFolderUri` and `roundId` — `runSealedImplementationV1`/
 * `runImplementationOrSealedV1` forward those two fields straight through
 * (they share `RunSealedImplementationOptionsV1` via an object spread), and
 * `executeImplementationRun` is the one caller that supplies them, passing
 * its own already-claimed `implRoundId`. This covers every real Copilot-
 * resolved implementation/Fast-Forward/Apply-Review dispatch, since they all
 * share that one function. The `lint.v1` call site (`runLintingFixes.ts`)
 * claims no `roundLedger` row and so passes neither field — an absent
 * `roundId` is simply a no-op, not a gap this blocker is about.
 *
 * CLI-resolved implementation rounds still never go through this coordinator
 * at all (`runImplementationForModel` / `runImplementationWithCli`) and
 * remain the separate, larger, already-documented residual gap this module's
 * own header describes — there is no coordinator `operationId`/`attemptId`
 * for those rounds to attach in the first place, so `resolveRoundV1` can only
 * ever find them by their own `promptRoundId`/`attemptId`.
 */
export async function attachCoordinatorIdentityToRoundV1(
  options: AttachCoordinatorIdentityToRoundOptionsV1
): Promise<void> {
  const patched = await patchTaskProgressStrictV1(options.taskFolderUri, (current) => {
    const row = resolveRoundV1(current, options.roundId);
    if (!row || (row.state !== "scheduled" && row.state !== "open")) {
      throw new Error(`round ledger row ${options.roundId} is not live`);
    }
    if (row.operationId !== undefined && row.operationId !== options.operationId) {
      throw new Error(`round ledger row ${options.roundId} belongs to another operation`);
    }
    const attemptIds = row.attemptIds.includes(options.attemptId)
      ? row.attemptIds
      : [...row.attemptIds, options.attemptId];
    if (row.operationId === options.operationId && attemptIds === row.attemptIds) {
      return undefined;
    }
    return upsertRoundLedgerEntryV1(current, {
      ...row,
      attemptIds,
      operationId: options.operationId,
    });
  });
  const row = patched && resolveRoundV1(patched, options.roundId);
  if (
    !row ||
    row.operationId !== options.operationId ||
    !row.attemptIds.includes(options.attemptId)
  ) {
    throw new Error(`failed to durably attach coordinator identity to round ${options.roundId}`);
  }
}

// `recordChecklistRevisionOnRoundLedgerV1` (Part 6 items 5/19) was removed
// 2026-08-28 (review fix, completion blocker: "the separate best-effort
// write may fail or no-op after the originating row is pruned — adoption may
// be marked durable on the proposal while the required ledger record remains
// absent"): a separate best-effort `patchTaskProgressStrictV1` call after
// adoption could not be made to GUARANTEE the ledger annotation lands
// alongside it, no matter how it was retried, because the two were two
// independent transactions. The annotation is now folded directly into
// `markChecklistChangeProposalAdoptedV1` (`taskProgressTransforms.ts`) — the
// SAME pure transform, applied inside the SAME transaction the caller
// already uses to mark the proposal `"adopted"` — so the two facts can never
// observably disagree because of an independent I/O failure. The one case
// that remains structurally impossible (the row was evicted by the ledger's
// own 200-row cap before adoption) is now recorded as `ledgerAnnotated:
// false` on the durable `ChecklistChangeProposalV1` itself, an observable
// fact rather than a silently swallowed no-op.
