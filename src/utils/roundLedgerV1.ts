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
 * NOT YET WIRED into the implementation-round path: the six
 * `appendRoundOutcome` call sites in `reviewActions.ts` that record
 * implementation-round completion accounting do not yet open a
 * corresponding round-ledger row at dispatch or call `terminalizeRoundV1` at
 * completion, nor does `automationChain.ts`'s dropped/cancelled handling or
 * the implementation-recovery continuation path. That remains a separate,
 * larger integration step. Likewise the reconciliation sweep (orphan-closing
 * passes a/b/c) is not yet implemented. This module implements the
 * terminalizer itself to the plan's idempotency/ordering contract, verified
 * in isolation against directly-constructed `TaskProgress` fixtures and,
 * for the review path, against the real `reviewActions.ts` call sites.
 */
import * as vscode from "vscode";
import {
  ImplementationDispatchModeV1,
  RoundLedgerEntryV1,
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
}

export type TerminalizeRoundResultV1 =
  | { readonly ok: true; readonly alreadyTerminal: boolean; readonly entry: RoundLedgerEntryV1 }
  | { readonly ok: false; readonly reason: "notFound" | "writeFailed" };

/** The `_Ended: …_` line rendered into the chat transcript for a
 * terminalized round — Part 9 (step 25) owns the FULL rendering contract for
 * this in the webview; this is the durable message TEXT stored in
 * `chat-v1.json`, kept short and self-contained since it is also what a
 * plain-text reader of the transcript sees. */
export function formatRoundOutcomeMessageV1(entry: RoundLedgerEntryV1): string {
  const stageName = STAGE_DISPLAY_NAMES[entry.stage] ?? entry.stage;
  const parts: string[] = [`_Ended: ${stageName} — ${entry.state}`];
  if (entry.continuationOf) {
    parts.push(`continuation of the round started earlier`);
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
    if (outcome.runLogPath) {
      parts.push(outcome.runLogPath);
    }
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
    const row = resolveRoundV1(current, id);
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
    let next = upsertRoundLedgerEntryV1(current, nextEntry);
    if (options.roundOutcomeClassification) {
      const c = options.roundOutcomeClassification;
      next = appendRoundOutcome(next, {
        stage: nextEntry.stage,
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
        text: formatRoundOutcomeMessageV1(entry),
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

  return { ok: true, alreadyTerminal: false, entry };
}
