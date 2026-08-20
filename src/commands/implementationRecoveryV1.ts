/**
 * The ONE durable recovery transition for every implementation round that
 * finishes without a usable report (Part 1 of the workflow-robustness fixes,
 * 2026-08-14).
 *
 * Three failure classes land here — a detected deferred round, a detected
 * cut-short round, and a completed round whose summary was stamped unusable
 * (`describeImplementationSummaryShapeIssue`). Before this seam existed the
 * third class persisted NOTHING: round 010 of ".ensemble/2026-08-13_task_1"
 * ("workflow 2") narrated "the full unit suite is running in the background —
 * I'll write the final summary when its completion notification arrives",
 * was finalized `completed` with its edits kept, its summary stamped
 * unusable, and the task then sat at `impl-high-review`/`active`
 * indefinitely: nothing scheduled, nothing surfaced, no round 011.
 *
 * The contract, shared by all three classes:
 *
 *  1. `beginImplementationRecoveryV1` persists — in ONE strict patch, BEFORE
 *     any run-log, artifact, or scheduling write — the quarantined delta
 *     (`pendingImplReviewFiles`, or an explicit `filesChangedUnknown` when
 *     the change set could not be enumerated), the bounded continuation
 *     counter, the review-invalid marker (at a review stage), and the
 *     durable `implRecovery` record with `dispatch: "pending"`. A crash at
 *     any later point can only lose reporting, never the fact that recovery
 *     is owed.
 *  2. `finishDispatch` — called after the run log is durable — notifies the
 *     user in wording distinct from "review paused, waiting on user"
 *     (naming "continuation N of MAX" and the recovery mode), then either
 *     schedules the continuation chain or escalates to a human at the cap.
 *  3. Any implementation round that starts claims the pending record via
 *     `claimImplRecoveryDispatchV1` (`pending` → `dispatched` with a fresh
 *     continuation attemptId, one patch), so a host restart can tell "a
 *     continuation was never started" — re-armed exactly once by
 *     `TaskActionScheduler`'s sweep — from "one started and died", which is
 *     surfaced but never double-fired.
 *  4. The record clears in the same transaction that finalizes a subsequent
 *     usable summary (`promotePendingImplReviewFiles`).
 *
 * Part 2 finding (the observed stage regression on "workflow 2",
 * 2026-08-13_task_1): after round 010's unusable summary, `currentStage`
 * moved from `impl-high-review` back to `impl` and `impl` left
 * `completedStages`. Re-investigated 2026-08-14 against current source: NO
 * automatic path performs that regression. The only code that moves a stage
 * backwards or prunes `completedStages` is user-driven `setTaskStage`
 * (`stageTransition.ts` → `updateTaskProgressStage`, which filters
 * `completedStages` on a backward move) and the completed-task reopen policy
 * (`taskProgressFieldPolicyV1.applyReopenPolicyV1`, gated on
 * `status: "completed"`). The task's own progress file is untracked, so no
 * byte-level history survives, but the shape of the change matches
 * `updateTaskProgressStage`'s backward-move pruning exactly — i.e. a manual
 * (human or chat-confirmed `setTaskStage`) rollback taken to unstick the
 * stranded task, which this transition now makes unnecessary. Nothing to
 * gate; the recovery modes below remove the reason anyone would do it.
 */
import * as vscode from "vscode";
import * as path from "path";
import {
  ImplRecoveryModeV1,
  ImplRecoveryTriggerV1,
  ImplRecoveryV1,
  MAX_INCOMPLETE_ROUND_CONTINUATIONS_V1,
  STAGE_ARTIFACT_FILENAMES,
  TaskProgress,
  TaskStage,
  isReviewStage,
} from "../types/taskProgress";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import { readTextIfExists } from "../utils/fileUtils";
import { parseReadiness } from "../utils/reviewReadiness";
import { isSummaryOnlyDispatchAvailableV1 } from "./implContinuationTextDispatchV1";
import {
  quarantinePendingImplReviewFiles,
  recordReviewInvalidatedByRound,
  setIncompleteRoundContinuations,
} from "../utils/taskProgressTransforms";
import { NotificationRouter } from "../utils/notificationRouter";
import { escalateReviewToHuman } from "../utils/reviewEscalation";
import { scheduleAutomationChain } from "../utils/automationChain";
import type { TaskOperationHandle } from "../utils/taskOperations";
import { postWorkflowDecisionV1 } from "../utils/workflowDecisionDispatchV1";
import type { ChatTarget } from "../views/chatView";

/**
 * How long the transition's own lease on the pending dispatch lasts. Short by
 * design: the in-process continuation chain fires moments after the root
 * operation ends, so the lease only has to cover that hand-off. If the window
 * dies first, another window's sweep may claim the record the moment this
 * expires — an hour-long wait (the scheduledRun lease) would just prolong the
 * stall this transition exists to end.
 */
const RECOVERY_TRANSITION_LEASE_MS = 10 * 60 * 1000;

/** Chain identity for every recovery continuation dispatch (all windows). */
export const IMPL_CONTINUATION_CHAIN_ID_V1 = "impl-continuation";

let recoveryOwnerToken: string | undefined;

/** Stable per-window owner id for recovery leases (parity with the scheduler's). */
function ownerToken(): string {
  if (recoveryOwnerToken === undefined) {
    const sessionId =
      typeof vscode.env?.sessionId === "string" ? vscode.env.sessionId : "window";
    recoveryOwnerToken = `${sessionId}:${Math.random().toString(36).slice(2)}`;
  }
  return recoveryOwnerToken;
}

function freshToken(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Everything the recovery-mode decision may look at (Part 2). Kept a plain
 * data bag so the decision rule itself (`selectImplRecoveryModeV1`) is a pure,
 * exhaustively testable function with no reads of its own.
 *
 * A prior clean review approves only the workspace boundary it reviewed — it
 * never approves edits made by a later round. That is why `summary-only`
 * requires ALL THREE of: a 0-blocker high review, that review still
 * DESCRIBING the pre-round tree (fresh artifact at the reviewed stage — a
 * bare history entry has no boundary identity and can outlive the tree it
 * scored), and a clean pre-round boundary (no quarantined unreported delta,
 * no review-invalid marker). Together they say the review's verdict described
 * exactly the tree this round started from.
 */
export interface ImplRecoveryModeEvidenceV1 {
  /**
   * True when the triggering round was killed from outside (wall-clock
   * timeout, inactivity kill, crash) rather than returning a final response.
   * A known file list from such a round proves only that edits LANDED, never
   * that they are FINISHED — the process may have stopped mid-edit — so
   * external termination is never `summary-only` (Part 7 routes timeouts
   * here with this flag set).
   */
  readonly terminatedExternally: boolean;
  /** True when the round's change set could not be enumerated. */
  readonly filesChangedUnknown: boolean;
  /** Size of the round's enumerated git-snapshot delta. */
  readonly changedFileCount: number;
  /** The latest `impl-high-review` history entry passed with 0 blockers. */
  readonly latestHighReviewPassedZeroBlockers: boolean;
  /**
   * The latest impl-high-review VERDICT actually describes the tree this
   * round started from — not merely "a 0-blocker entry exists in history".
   * A score history entry has no boundary identity of its own, so without
   * this signal a successful post-review edit round (which promotes the
   * pending set and clears the invalid marker) followed by another
   * unreported round could reuse an older 0-blocker score that never
   * reviewed the newer edits (review blocker 2, 2026-08-14).
   *
   * Computed from durable review-tracking state: the round ran AT
   * `impl-high-review` (any implementation round that lands edits at a
   * review stage stale-stamps exactly that stage's artifact; edits landed at
   * other stages never re-validate this one) AND the on-disk
   * `impl-high-review.md` is currently a usable review — non-empty, carrying
   * a real `Readiness` score, not the `# Review Stale` placeholder a
   * post-review edit round writes over it.
   */
  readonly latestHighReviewDescribesPreRoundTree: boolean;
  /**
   * No `pendingImplReviewFiles` and no `reviewInvalidatedByRound` existed
   * BEFORE this round — i.e. the last review's boundary was the tree this
   * round started from, with no unreported edits outstanding.
   */
  readonly preRoundBoundaryClean: boolean;
  /**
   * The stage's provider path can dispatch a `summary-only` continuation
   * with edit permissions actually withheld (broker `mode: "text"`). When it
   * cannot, the plan's fallback applies: `inspect-and-complete`, never an
   * edit run carrying only a no-edits instruction.
   */
  readonly summaryOnlyDispatchAvailable: boolean;
  /**
   * A `summary-only` continuation violated its no-edit premise (the post-run
   * delta gate found a non-empty delta). The mode escalates — the violating
   * round's edits are real and must be inspected, not narrated over.
   */
  readonly escalatedFromSummaryOnly: boolean;
}

/**
 * The Part 2 decision rule — evidence in, one persisted mode out:
 *
 *  - `summary-only` iff the round terminated normally, the delta is known,
 *    the latest impl-high-review passed with 0 blockers AND still describes
 *    the pre-round tree (fresh artifact, at the reviewed stage) over a clean
 *    pre-round boundary, and a text-mode dispatch can enforce the no-edit
 *    premise;
 *  - `inspect-and-complete` for an externally-killed round with a known
 *    non-empty change set, for a summary-only premise violation, and as the
 *    enforceable fallback when text mode is not honorable;
 *  - `unconstrained` when the edits themselves are suspect: open blockers or
 *    no passing review on record, or no trustworthy delta
 *    (`filesChangedUnknown`) to summarize or inspect.
 */
export function selectImplRecoveryModeV1(
  evidence: ImplRecoveryModeEvidenceV1
): ImplRecoveryModeV1 {
  if (evidence.filesChangedUnknown) {
    return "unconstrained";
  }
  if (evidence.escalatedFromSummaryOnly) {
    return "inspect-and-complete";
  }
  if (evidence.terminatedExternally) {
    return evidence.changedFileCount > 0 ? "inspect-and-complete" : "unconstrained";
  }
  if (
    evidence.latestHighReviewPassedZeroBlockers &&
    evidence.latestHighReviewDescribesPreRoundTree &&
    evidence.preRoundBoundaryClean
  ) {
    return evidence.summaryOnlyDispatchAvailable ? "summary-only" : "inspect-and-complete";
  }
  return "unconstrained";
}

/**
 * Whether the on-disk impl-high-review artifact is currently a USABLE review
 * — the reviewed-boundary freshness half of the summary-only evidence (see
 * `latestHighReviewDescribesPreRoundTree`). A missing file, the
 * `# Review Stale` placeholder a post-review edit round writes, or content
 * with no `Readiness: N/10` line all mean the latest 0-blocker history entry
 * no longer describes the current tree.
 *
 * Read BEFORE the recovery transition's strict patch runs: for a rejected
 * summary, `executeImplementationRun` stale-stamps this artifact only AFTER
 * the transition (its marker-ordering invariant), so the content read here is
 * the pre-round state the mode decision needs.
 */
async function isHighReviewArtifactUsableV1(folderUri: vscode.Uri): Promise<boolean> {
  const artifactUri = vscode.Uri.file(
    path.join(
      folderUri.fsPath,
      STAGE_ARTIFACT_FILENAMES["impl-high-review"] ?? "impl-high-review.md"
    )
  );
  const content = await readTextIfExists(artifactUri);
  if (content === undefined || content.trim().length === 0) {
    return false;
  }
  if (content.trimStart().startsWith("# Review Stale")) {
    return false;
  }
  return parseReadiness(content).score !== null;
}

/** Latest `impl-high-review` entry in the score history passed with 0 blockers. */
function latestHighReviewPassedZeroBlockersV1(current: TaskProgress): boolean {
  const history = current.reviewScoreHistory;
  if (!history) {
    return false;
  }
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry?.stage === "impl-high-review") {
      return entry.blockerCount === 0;
    }
  }
  return false;
}

export interface ImplementationRecoveryInputV1 {
  /** Failure class of the triggering round. */
  readonly trigger: ImplRecoveryTriggerV1;
  /** Displayable reason the round's report was unusable. */
  readonly reason: string;
  /**
   * True when the triggering round was killed from outside (timeout,
   * inactivity kill, crash) instead of returning a final response — see
   * `ImplRecoveryModeEvidenceV1.terminatedExternally`. Part 7's timeout
   * routing passes true; every summary-gate path passes false.
   */
  readonly terminatedExternally: boolean;
  /**
   * True when this transition is the post-run delta gate rejecting a
   * `summary-only` continuation that edited files — forces the escalation to
   * `inspect-and-complete` (Part 2 step 3).
   */
  readonly escalatedFromSummaryOnly?: boolean;
  /** The round's git-snapshot delta (quarantined verbatim). */
  readonly filesChanged: readonly string[];
  /** True when the change set could not be enumerated — recorded explicitly. */
  readonly filesChangedUnknown: boolean;
  /** The task's current (possibly review) stage, for the invalid marker. */
  readonly postRunReviewStage: TaskStage;
  /** Root operation whose end gates the continuation chain dispatch. */
  readonly parentOperation?: Pick<TaskOperationHandle, "id">;
  /**
   * True when a `_prev` backup pair actually exists to restore from — a
   * completed round whose own summary was rejected (`incompleteRound ===
   * undefined` at the call site), never a detected deferred/cut-short round,
   * which never finished long enough to leave one. When true, `finishDispatch`
   * posts a `WorkflowDecisionV1` (case 3 — "Restore Prior Round" — module
   * doc comment) offering to discard this round's work and restore the prior
   * state, alongside the do-nothing/let-the-continuation-run option.
   */
  readonly offerRestoreOption?: boolean;
}

export interface BegunImplementationRecoveryV1 {
  /** The incremented continuation count (1-based). */
  readonly continuations: number;
  /** True when the continuation budget is exhausted (escalation, not dispatch). */
  readonly capReached: boolean;
  /** Token identifying the triggering round, quoted in its run log. */
  readonly sourceAttemptId: string;
  /** The recovery mode persisted on the record. */
  readonly mode: ImplRecoveryModeV1;
  /** Paths quarantined by the transition (empty when the delta is unknown). */
  readonly quarantinedPaths: readonly string[];
  /** The persisted progress, for CAS-sensitive follow-ups. */
  readonly persisted: TaskProgress | undefined;
  /**
   * Notify + escalate-or-schedule. Call AFTER the run log is durable — the
   * quarantine-before-run-log ordering is the transition's crash invariant,
   * and dispatching before the log exists would race the continuation round
   * against the record of why it was needed.
   */
  finishDispatch(): Promise<void>;
}

/**
 * Persist the recovery transition (one strict patch) and return the deferred
 * dispatch half. See the module doc comment for the full contract.
 */
export async function beginImplementationRecoveryV1(
  folderUri: vscode.Uri,
  input: ImplementationRecoveryInputV1
): Promise<BegunImplementationRecoveryV1> {
  const sourceAttemptId = freshToken("impl-recovery");
  const quarantinedPaths = input.filesChangedUnknown ? [] : [...input.filesChanged];
  let continuations = 0;
  // The two async evidence reads happen BEFORE the patch (the callback must
  // stay synchronous): the artifact's usability is durable review-tracking
  // state that only this same function's caller mutates later in the run, and
  // the capability probe reads global settings — neither can be raced by the
  // patch's own CAS retry.
  const highReviewDescribesPreRoundTree =
    input.postRunReviewStage === "impl-high-review" &&
    (await isHighReviewArtifactUsableV1(folderUri));
  // Mode selection (Part 2) runs INSIDE the patch callback, against the same
  // `current` the transition persists over, so the evidence (score history,
  // pre-round quarantine/marker state) and the recorded mode can never come
  // from two different snapshots. Selected-at-transition-time, persisted on
  // the record — never re-derived later.
  let selectedMode: ImplRecoveryModeV1 = "unconstrained";
  const persisted = await patchTaskProgressStrictV1(folderUri, (current) => {
    selectedMode = selectImplRecoveryModeV1({
      terminatedExternally: input.terminatedExternally,
      filesChangedUnknown: input.filesChangedUnknown,
      changedFileCount: quarantinedPaths.length,
      latestHighReviewPassedZeroBlockers: latestHighReviewPassedZeroBlockersV1(current),
      latestHighReviewDescribesPreRoundTree: highReviewDescribesPreRoundTree,
      preRoundBoundaryClean:
        (current.pendingImplReviewFiles?.length ?? 0) === 0 &&
        current.reviewInvalidatedByRound === undefined,
      summaryOnlyDispatchAvailable: isSummaryOnlyDispatchAvailableV1(),
      escalatedFromSummaryOnly: input.escalatedFromSummaryOnly === true,
    });
    continuations = (current.incompleteRoundContinuations ?? 0) + 1;
    let next = setIncompleteRoundContinuations(current, continuations);
    if (quarantinedPaths.length > 0) {
      next = quarantinePendingImplReviewFiles(next, [...quarantinedPaths]);
    }
    if (isReviewStage(input.postRunReviewStage)) {
      next = recordReviewInvalidatedByRound(next, input.postRunReviewStage);
    }
    const capReached = continuations >= MAX_INCOMPLETE_ROUND_CONTINUATIONS_V1;
    const record: ImplRecoveryV1 = {
      sourceAttemptId,
      reason: input.reason,
      trigger: input.trigger,
      mode: selectedMode,
      dispatch: "pending",
      at: new Date().toISOString(),
      ...(input.filesChangedUnknown ? { filesChangedUnknown: true } : {}),
      // The lease covers only the in-process hand-off to the continuation
      // chain; a cap-reached record gets none — nothing will ever fire it,
      // and a lease would just delay the sweep noticing it is parked.
      ...(capReached
        ? {}
        : {
            leaseOwner: ownerToken(),
            leaseUntil: new Date(Date.now() + RECOVERY_TRANSITION_LEASE_MS).toISOString(),
          }),
    };
    return { ...next, implRecovery: record, updatedAt: new Date().toISOString() };
  });
  const capReached = continuations >= MAX_INCOMPLETE_ROUND_CONTINUATIONS_V1;

  const finishDispatch = async (): Promise<void> => {
    const lead =
      input.escalatedFromSummaryOnly === true
        ? "⚠️ The summary-only continuation edited files it was not permitted to edit, so its report was rejected. "
        : input.trigger === "summaryRejected"
          ? `⚠️ Implementation finished, but the provider did not return a usable summary (${input.reason}). `
          : `⚠️ The implementation round did not finish its turn: ${input.reason}. `;
    const quarantineClause =
      quarantinedPaths.length > 0
        ? `Its ${quarantinedPaths.length} changed file(s) were quarantined for the continuation round. `
        : input.filesChangedUnknown
          ? "Its change set could not be enumerated (recorded as unknown). "
          : "";
    const outcomeClause = capReached
      ? `The continuation budget (${MAX_INCOMPLETE_ROUND_CONTINUATIONS_V1}) is exhausted, so automated recovery has stopped and the task needs a human decision.`
      : `A continuation implementation round (${continuations} of ${MAX_INCOMPLETE_ROUND_CONTINUATIONS_V1}, ${selectedMode}) has been scheduled to complete and report the work.`;
    const whatHappened = `${lead}${quarantineClause}${outcomeClause}`;

    // Case 3 (module doc comment) — several valid options, none automatic:
    // restoring the `_prev` backups discards this round's completed work, and
    // only the user can weigh that against waiting on the scheduled
    // continuation (or, once the budget is exhausted, reviewing the round
    // themselves). Only offered when a `_prev` pair actually exists to
    // restore from (see `offerRestoreOption`'s doc comment).
    if (input.offerRestoreOption === true) {
      const filesClause =
        quarantinedPaths.length > 0
          ? `${quarantinedPaths.length} changed file(s)`
          : input.filesChangedUnknown
            ? "an unknown number of changed files"
            : "no changed files";
      const target: ChatTarget = {
        canonicalId: folderUri.fsPath,
        taskFolderPath: folderUri.fsPath,
        stage: input.postRunReviewStage,
        taskName: persisted?.displayName,
      };
      const decision = await postWorkflowDecisionV1(
        {
          decisionKey: "restoreRejectedImplementationRound",
          taskCanonicalId: folderUri.fsPath,
          stage: input.postRunReviewStage,
          whatHappened,
          whyUserNeeded:
            "Restoring discards this round's completed work, and the system cannot judge whether that " +
            "trade is better than waiting for the scheduled continuation to produce a usable report — " +
            "only you can weigh discarding real edits against keeping an unusable one.",
          options: [
            {
              optionId: "keep",
              label: capReached ? "Leave paused for review" : "Let the continuation run",
              consequence: capReached
                ? "Does nothing — the task stays paused with the unreported edits preserved in " +
                  "pendingImplReviewFiles until you review or rerun the round yourself."
                : `Does nothing — the scheduled continuation round (${continuations} of ` +
                  `${MAX_INCOMPLETE_ROUND_CONTINUATIONS_V1}, ${selectedMode}) will attempt to finish and ` +
                  "report the round's work; this round's edits are kept, quarantined, not discarded.",
              effect: { kind: "doNothing" },
            },
            {
              optionId: "restore",
              label: "Restore Prior Round",
              destructive: true,
              consequence:
                `Overwrites the current implementation summary and review with their _prev backups, ` +
                `discarding this round's completed work (${filesClause}) and returning the task to its ` +
                "pre-round state. This cannot be undone from within the extension.",
              effect: {
                kind: "command",
                command: "vs-code-ai-helper.restoreRejectedImplementationRound",
                args: [folderUri.fsPath, input.postRunReviewStage],
              },
            },
          ],
          recommendation: capReached
            ? {
                kind: "none",
                reasoning:
                  "Automated recovery is exhausted and nothing is running to prefer over restoring — " +
                  "whether to discard this round's edits depends on judging them yourself.",
              }
            : {
                kind: "option",
                optionId: "keep",
                reasoning:
                  "A continuation round is already scheduled to produce a usable report without " +
                  "discarding this round's work.",
              },
        },
        target
      );
      if (!decision) {
        // No activating extension context (e.g. a unit test) — fall back to
        // the plain announcement so the outcome is still surfaced somewhere.
        NotificationRouter.showWarning(whatHappened);
      }
    } else {
      NotificationRouter.showWarning(whatHappened);
    }

    if (capReached) {
      // The attempt CAS expects the value read from the state persisted
      // moments ago — for an implementation-stage task that value is
      // legitimately ABSENT (the impl transition clears reviewAttemptId,
      // taskProgressFieldPolicyV1), so `undefined` is passed through as the
      // expected value rather than coerced to "". Coercing made the CAS
      // unsatisfiable on exactly the stage this cap most needs to escalate.
      const escalated = await escalateReviewToHuman(
        folderUri,
        persisted?.currentStage ?? input.postRunReviewStage,
        "plateau",
        `${continuations} consecutive implementation round(s) ended without a usable report ` +
          `(${input.trigger}). Automated continuation is no longer making the round finish; ` +
          "the unreported edits are preserved in pendingImplReviewFiles.",
        persisted?.reviewAttemptId,
        persisted ?? undefined,
        false
      );
      if (!escalated) {
        // The escalation write can be declined by its CAS guards (e.g. no
        // reviewAttemptId on an implementation-only task). The failure must
        // not be silent — without a continuation OR an escalation the task
        // would go quiet exactly the way this transition exists to prevent.
        NotificationRouter.showWarning(
          "⚠️ Automated continuation stopped after repeated implementation rounds without a " +
            "usable report, and the task could not be paused automatically. Rerun the " +
            "implementation manually — the unreported edits are preserved and listed in the run log."
        );
      }
      return;
    }

    // The continuation is the task's NEXT action: no review dispatch, no
    // auto-advance, no second provider fired inside this round. It runs as a
    // fresh Run Implementation once this run's root operation releases the
    // task lock; runImplementationWithAI sees the pending quarantined set and
    // prepends the continuation notice to its prompt, and its run start
    // claims the record via claimImplRecoveryDispatchV1.
    void scheduleAutomationChain(
      {
        command: "vs-code-ai-helper.runImplementationWithAI",
        // No human on this path — see ReviewCommandArg.automationDispatch.
        arg: { taskFolderPath: folderUri.fsPath, automationDispatch: true },
        taskKey: folderUri.fsPath,
        chainId: IMPL_CONTINUATION_CHAIN_ID_V1,
      },
      input.parentOperation
    );
  };

  return {
    continuations,
    capReached,
    sourceAttemptId,
    mode: selectedMode,
    quarantinedPaths,
    persisted,
    finishDispatch,
  };
}

/**
 * What the round that just started is running AS: the owed recovery record it
 * claimed (with its persisted mode) and the pre-round boundary, captured in
 * the same read that performed the claim. The post-run delta gate (Part 2
 * step 3) keys on these — `record.mode` decides whether edits were permitted
 * at all (`summary-only`) or bounded (`inspect-and-complete`), and the
 * boundary is what "outside the quarantined plus previously-reviewed scope"
 * is measured against.
 */
export interface ClaimedImplRecoveryV1 {
  /** The owed recovery record as of run start (post-claim), if any. */
  readonly record: ImplRecoveryV1 | undefined;
  /** Review scope banked before this round — the previously-reviewed boundary. */
  readonly priorImplReviewFiles: readonly string[];
  /** Quarantined unreported delta outstanding before this round. */
  readonly priorPendingFiles: readonly string[];
}

/**
 * Claim a pending recovery continuation at implementation-run start: flips
 * `dispatch` → `"dispatched"` with a fresh continuation attemptId in one
 * patch. Idempotent — a record already `"dispatched"` (or no record at all)
 * is left byte-identical, which the strict writer turns into no write.
 *
 * Every implementation run calls this, not just chain-dispatched ones: a
 * manual rerun equally consumes the owed continuation, and after it the
 * record is either cleared (usable summary) or replaced (another failure),
 * so `dispatched` is always a true statement that a round started.
 */
export async function claimImplRecoveryDispatchV1(
  folderUri: vscode.Uri
): Promise<ClaimedImplRecoveryV1> {
  let record: ImplRecoveryV1 | undefined;
  let priorImplReviewFiles: readonly string[] = [];
  let priorPendingFiles: readonly string[] = [];
  await patchTaskProgressStrictV1(folderUri, (current) => {
    priorImplReviewFiles = [...(current.implReviewFiles ?? [])];
    priorPendingFiles = [...(current.pendingImplReviewFiles ?? [])];
    if (!current.implRecovery || current.implRecovery.dispatch !== "pending") {
      record = current.implRecovery;
      return current;
    }
    const claimed: ImplRecoveryV1 = {
      ...current.implRecovery,
      dispatch: "dispatched",
      attemptId: freshToken("impl-continuation"),
    };
    record = claimed;
    return {
      ...current,
      implRecovery: claimed,
      updatedAt: new Date().toISOString(),
    };
  });
  return { record, priorImplReviewFiles, priorPendingFiles };
}

/**
 * Atomically downgrade a claimed `summary-only` record to
 * `inspect-and-complete` when the round that just claimed it can no longer
 * dispatch with edit permissions actually withheld (review blocker,
 * 2026-08-14): the transition-time capability probe
 * (`isSummaryOnlyDispatchAvailableV1`) ran against the stage chain's
 * PRIMARY, but a sticky fallback — or a live settings change between
 * transition and claim — can resolve this round against a different model
 * whose text mode is not guaranteed read-only. Falling through to an edit
 * run while the persisted record and prompt still say `summary-only` is
 * exactly the "edit run carrying only a no-edits instruction" the plan
 * forbids.
 *
 * CAS'd on the claimed record's own `attemptId`: a record that has already
 * moved on (cleared by a subsequent usable summary, or already escalated by
 * a concurrent caller) is returned unchanged rather than clobbered. Callers
 * must use the RETURNED record for every downstream decision — the input
 * `claimed` reflects only the state as of the claim, before this check.
 */
export async function escalateClaimedSummaryOnlyIfUnavailableV1(
  folderUri: vscode.Uri,
  claimed: ImplRecoveryV1 | undefined,
  modelId: string | undefined
): Promise<ImplRecoveryV1 | undefined> {
  if (!claimed || claimed.mode !== "summary-only") {
    return claimed;
  }
  if (isSummaryOnlyDispatchAvailableV1(modelId)) {
    return claimed;
  }
  let updated: ImplRecoveryV1 | undefined = claimed;
  await patchTaskProgressStrictV1(folderUri, (current) => {
    if (
      !current.implRecovery ||
      current.implRecovery.attemptId !== claimed.attemptId ||
      current.implRecovery.mode !== "summary-only"
    ) {
      updated = current.implRecovery;
      return current;
    }
    const escalated: ImplRecoveryV1 = {
      ...current.implRecovery,
      mode: "inspect-and-complete",
    };
    updated = escalated;
    return { ...current, implRecovery: escalated, updatedAt: new Date().toISOString() };
  });
  return updated;
}

/**
 * The exact header every `buildImplementationContinuationPromptV1` variant
 * appends after `basePrompt` — used to strip a stale continuation notice
 * before rebuilding one for an escalated mode (see
 * `escalateClaimedSummaryOnlyIfUnavailableV1`). Finds the LAST occurrence so
 * a `basePrompt` that could theoretically contain the literal heading text
 * earlier in the document is left alone.
 */
const CONTINUATION_NOTICE_MARKER_V1 = "\n\n## Continuation Notice";

/**
 * Recover the `basePrompt` a continuation prompt was built from, by
 * truncating at the last appended `## Continuation Notice` section. A prompt
 * with no such section (never went through `buildImplementationContinuationPromptV1`,
 * or has no mode/pending files) is returned unchanged.
 */
export function stripImplementationContinuationNoticeV1(prompt: string): string {
  const markerIndex = prompt.lastIndexOf(CONTINUATION_NOTICE_MARKER_V1);
  return markerIndex === -1 ? prompt : prompt.slice(0, markerIndex);
}

/**
 * Build the continuation round's prompt (Part 2 step 2's mandates). Pure so
 * the exact wording each mode receives is unit-testable; `runImplementationWithAI`
 * calls this with the freshest persisted state.
 *
 * The prompt is a MANDATE, not the enforcement: `summary-only`'s no-edit
 * premise is enforced by the dispatch mode (edit permissions withheld) and by
 * the post-run delta gate, and `inspect-and-complete`'s boundary by the same
 * gate's out-of-boundary recording. The text tells the model what the gates
 * will hold it to.
 */
export function buildImplementationContinuationPromptV1(
  basePrompt: string,
  context: {
    /** The owed recovery record's persisted mode, when one exists. */
    readonly mode: ImplRecoveryModeV1 | undefined;
    /** Quarantined unreported delta from the failed round(s). */
    readonly pendingFiles: readonly string[];
    /** Previously-reviewed scope (`implReviewFiles`) — the approved boundary. */
    readonly reviewedFiles: readonly string[];
  }
): string {
  const { mode, pendingFiles, reviewedFiles } = context;
  if (mode === undefined && pendingFiles.length === 0) {
    return basePrompt;
  }
  const fileList = (files: readonly string[]): string[] =>
    files.length > 0 ? files.map((file) => `- ${file}`) : ["- _none recorded_"];

  if (mode === "summary-only") {
    return (
      basePrompt +
      [
        "",
        "",
        "## Continuation Notice — report only (summary-only)",
        "",
        "A previous implementation round for this task ended WITHOUT a usable report.",
        "The PREVIOUSLY-REVIEWED files listed below passed review with 0 blockers",
        "before that round ran; the quarantined delta it left behind has NOT been",
        "reviewed yet — the report you produce will be sent for a fresh review",
        "covering the combined scope. This round must NOT edit any file: any file",
        "edit voids this round's report. Produce the missing report for the EXISTING",
        "combined diff (the previously-reviewed files plus the quarantined delta",
        "listed below): `## Files Changed` covering that combined diff,",
        "`## Verification`, and the plan checklist echo with every box that work",
        "completes. Do not defer any part of the report to a later turn: this round",
        "gets no follow-up turn.",
        "",
        "Quarantined delta awaiting a report:",
        ...fileList(pendingFiles),
        "",
        "Previously-reviewed files:",
        ...fileList(reviewedFiles),
      ].join("\n")
    );
  }

  if (mode === "inspect-and-complete") {
    return (
      basePrompt +
      [
        "",
        "",
        "## Continuation Notice — inspect and complete",
        "",
        "A previous implementation round for this task was interrupted or ended WITHOUT",
        "a usable report after changing the quarantined files listed below. Treat those",
        "edits as unverified work in progress that may have stopped mid-edit: FIRST",
        "inspect each quarantined file for partial or inconsistent edits, finish or",
        "revert whatever is incomplete, and only then report ALL of the work in THIS",
        "round's summary — include the quarantined files under `## Files Changed` and",
        "echo the plan checklist with every box that work completes. Stay within the",
        "boundary below (the quarantined files plus the previously-reviewed files); do",
        "not expand into new scope — files changed outside the boundary are recorded",
        "as unreviewed scope in the run log. Do not defer any part of the report to a",
        "later turn: this round gets no follow-up turn.",
        "",
        "Quarantined files (unverified work in progress):",
        ...fileList(pendingFiles),
        "",
        "Previously-reviewed boundary:",
        ...fileList(reviewedFiles),
      ].join("\n")
    );
  }

  // Unconstrained (or a legacy pending set with no record): today's notice.
  if (pendingFiles.length === 0) {
    return (
      basePrompt +
      [
        "",
        "",
        "## Continuation Notice",
        "",
        "A previous implementation round for this task ended WITHOUT a usable report,",
        "though it changed no files. Complete the remaining plan work, verify it, and",
        "report ALL of it in THIS round's summary — `## Files Changed`,",
        "`## Verification`, and the plan checklist echo. Do not defer any part of the",
        "report to a later turn: this round gets no follow-up turn.",
      ].join("\n")
    );
  }
  return (
    basePrompt +
    [
      "",
      "",
      "## Continuation Notice",
      "",
      "A previous implementation round for this task ended WITHOUT a usable report:",
      "it changed the files listed below but returned no `## Files Changed`, no",
      "`## Verification`, and no checklist echo (it may have deferred to a follow-up",
      "turn that never ran). Treat that round's edits as unverified work in progress.",
      "Complete whatever plan work those edits belong to, verify it, and report ALL of",
      "it in THIS round's summary — include the files below under `## Files Changed`",
      "and echo the plan checklist with every box that work completes. Do not defer",
      "any part of the report to a later turn: this round gets no follow-up turn.",
      "",
      "Files changed by the unreported round:",
      ...pendingFiles.map((file) => `- ${file}`),
    ].join("\n")
  );
}
