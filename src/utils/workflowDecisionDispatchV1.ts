import * as vscode from "vscode";
import { getExtensionContextV1 } from "./extensionContextV1";
import { readAutoContinueMinutes } from "../config/settings";
import { planAutoContinueV1, withWaitForMeOptionV1 } from "./autoContinueV1";
import { currentRunBindingV1, matchesKeepGoingV1, withKeepGoingOptionV1 } from "./autoContinueKeepGoingV1";
import { requestAutoContinueSweepNowV1 } from "../state/autoContinueSweepTriggerV1";
import { readAutoContinueTaskStateV1 } from "./autoContinueTaskStateV1";

/**
 * The Memento the DECISION VIEWS are built over. In a viewer that is not
 * `context.workspaceState` itself but a wrapper carrying the runner's mirrored
 * decisions too (hostDecisionMirrorV1.ts) — and the store's change signal is
 * keyed by Memento identity, so posting through the raw state left the chat
 * panel and the tree unaware of a decision this window had just raised
 * (verification review, 2026-09-17). extension.ts installs it during
 * activation; unset, the raw workspaceState is used exactly as before.
 */
let decisionStateV1: vscode.Memento | undefined;

export function configureWorkflowDecisionStateV1(state: vscode.Memento | undefined): void {
  decisionStateV1 = state;
}

function decisionStoreStateV1(context: vscode.ExtensionContext): vscode.Memento {
  return decisionStateV1 ?? context.workspaceState;
}

/** The decision store over the same state the poster uses, or `undefined` before activation. */
export function openWorkflowDecisionStoreV1(): WorkflowDecisionStoreV1 | undefined {
  const context = getExtensionContextV1();
  return context ? new WorkflowDecisionStoreV1(decisionStoreStateV1(context)) : undefined;
}
import {
  WorkflowDecisionStoreV1,
  clearWorkflowDecisionOrphanedV1,
  markWorkflowDecisionOrphanedV1,
} from "../state/workflowDecisionStoreV1";
import { CreateWorkflowDecisionInputV1, WorkflowDecisionV1 } from "../types/workflowDecisionV1";
import { describeDeferredAnswerCarryOverV1 } from "../commands/verifiedTicksHeldOptionsV1";
import {
  ACTIVATION_ID_V1,
  describeOrphanedAwaitedDecisionV1,
  isOrphanedAwaitedDecisionV1,
  registerAwaitedWaiterV1,
  releaseAwaitedWaiterV1,
} from "./awaitedDecisionWaitersV1";
import { HandoffGatingV1 } from "../types/handoffGuidanceV1";
import type { TaskStage } from "../types/taskProgress";
import { ChatTarget, notifyPendingWorkflowDecision } from "../views/chatView";
import { revealChatForOwnerCardV1 } from "../views/chatRevealV1";
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import { appendChatMessageV1, CHAT_HISTORY_FILENAME } from "./chatHistoryStore";
import { retirePendingQuestionsV1 } from "./cardLifecycleV1";
import { recommendationPreconditionsV1 } from "./recommendationPreconditionsV1";
import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import { isEffectivelyPausedV1 } from "../state/effectivePauseStatusV1";
import { logChatStatusToNotificationsV1 } from "./chatStatusLogV1";

/**
 * Apply `recommendationPreconditionsV1` to every option of a decision about
 * to be posted, best-effort (task "stage chat as a record of work" item 14 /
 * Part 12 step 34). A caller-supplied `disabled: true` is never overridden.
 * If the read of `TaskProgress` fails (folder missing, decode failure — the
 * same class of best-effort courtesy failure `postWorkflowDecisionV1` already
 * tolerates for the chat-message projection), every option is left exactly
 * as the caller supplied it: a courtesy check must never itself withhold an
 * option that would in fact have worked.
 */
async function applyRecommendationPreconditionsV1(
  input: PostWorkflowDecisionInputV1,
  target: ChatTarget
): Promise<PostWorkflowDecisionInputV1> {
  let status: string | undefined;
  let currentStage: string | undefined;
  let reviewInvalidatedByRoundStage: string | undefined;
  let continuationOwed: boolean | undefined;
  try {
    const read = await readTaskProgressStrictV1(vscode.Uri.file(target.taskFolderPath));
    if (read.ok) {
      const progress = read.decoded.progress;
      status = progress.status;
      // Part 1b step 13 ("audit every pause-sensitive read ... notifications"):
      // `recommendationPreconditionsV1` is pure/synchronous and has no fence
      // access of its own (see its own doc comment), so it cannot tell a
      // REVOKED watchdog pause — one whose recorded fence generation a
      // revocation has already advanced past — from a real one. Left
      // uncorrected, a recommended chat action would be disabled with
      // "resume the task first" for a task the tree and status bar already
      // show as active, the exact state-mismatch the release bar forbids.
      // This caller already awaits a fresh disk read for this exact
      // decision, so resolving effective status here costs nothing extra.
      if (status === "paused" && !(await isEffectivelyPausedV1(target.taskFolderPath, progress))) {
        status = "active";
      }
      currentStage = progress.currentStage;
      reviewInvalidatedByRoundStage = progress.reviewInvalidatedByRound?.stage;
      continuationOwed = progress.implRecovery !== undefined;
    }
  } catch {
    // Best-effort: leave options exactly as supplied.
  }
  if (status === undefined) {
    return input;
  }
  const options = input.options.map((option) => {
    if (option.disabled === true) {
      return option;
    }
    const result = recommendationPreconditionsV1(option.effect, {
      status,
      currentStage,
      reviewInvalidatedByRoundStage,
      continuationOwed,
    });
    if (!result.blocked) {
      return option;
    }
    return { ...option, disabled: true, disabledReason: result.reason };
  });
  // A recommendation that now points at an option this pass just disabled
  // (the caller chose it before this state was known) is downgraded to an
  // explicit "no recommendation" rather than posted — the same
  // "never recommend a known-wrong option" rule item 10 established,
  // applied here to an option disabled by state rather than one that was
  // always wrong.
  if (input.recommendation.kind === "option") {
    const recommendedOptionId = input.recommendation.optionId;
    const stillRecommendable = options.find((o) => o.optionId === recommendedOptionId);
    if (stillRecommendable?.disabled === true) {
      return {
        ...input,
        options,
        recommendation: {
          kind: "none",
          reasoning: `The recommended option is currently unavailable — ${stillRecommendable.disabledReason}.`,
        },
      };
    }
  }
  return { ...input, options };
}

/**
 * Backoff schedule for `retryOrphanDismissV1`'s background retries of a
 * failed dismissal write (task "Actionable Hand-offs" review, round 3:
 * "durable retry" half of the fix). Exported so tests can supply a tiny
 * schedule instead of waiting on production delays.
 */
export const DEFAULT_ORPHAN_DISMISS_RETRY_DELAYS_MS: readonly number[] = [2_000, 10_000, 30_000];

/**
 * Keep retrying a failed `store.dismiss` write in the background until it
 * succeeds (or the record has already left `"pending"` by some other path,
 * which `dismiss` reports as `alreadySettled` — also success for this
 * purpose) or the schedule is exhausted. The in-process tombstone
 * (`markWorkflowDecisionOrphanedV1`) already makes the record non-answerable
 * immediately regardless of whether this succeeds; this only closes the
 * PERSISTED gap so the record doesn't sit `"pending"` forever if storage
 * recovers. If every attempt fails, the tombstone stays in place for the
 * rest of this process's life, and the next activation's
 * `dismissOrphanedAwaitedDecisionsV1` sweep is the backstop.
 */
export async function retryOrphanDismissV1(
  store: WorkflowDecisionStoreV1,
  decisionId: string,
  delaysMs: readonly number[] = DEFAULT_ORPHAN_DISMISS_RETRY_DELAYS_MS
): Promise<void> {
  for (const delayMs of delaysMs) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delayMs);
      // Node-only: a background retry must never keep the extension host
      // (or a test process) alive purely to finish its backoff schedule.
      // Webview/browser timer handles have no `unref`, hence the guard.
      const unrefable = timer as unknown as { unref?: () => void };
      unrefable.unref?.();
    });
    try {
      await store.dismiss(decisionId);
      clearWorkflowDecisionOrphanedV1(decisionId);
      return;
    } catch (err) {
      console.error(`Retry failed to dismiss orphaned workflow decision "${decisionId}"`, err);
    }
  }
}

/**
 * PART 5's creation-time guard: every decision key must supply `gating`.
 * `reviewActions.ts`'s `providerChainExhausted` decision was the sole tracked
 * exception while "workflow 8" (the concurrent task owning that file) was
 * still open; that task closed (branch `workflow-8-findings` merged to
 * `main`), PART 9's gating population for that one call site landed as part
 * of closing this blocker, and the exception was removed — do not reintroduce
 * one without an equally explicit, tracked reason. `gating` stays optional on
 * `CreateWorkflowDecisionInputV1` at the TYPE level only for callers (tests)
 * that exercise `createWorkflowDecisionV1`'s shape validation independent of
 * this runtime guard — this function is the actual enforcement
 * `postWorkflowDecisionV1` applies to every call, so a brand-new call site
 * cannot silently omit `gating` the way a source-grep audit alone would allow
 * (it would only ever check sites it already knows about). Exported so it can
 * be unit-tested directly without standing up a full `vscode.ExtensionContext`.
 */
export function assertGatingRequirementV1(decisionKey: string, gating: HandoffGatingV1 | undefined): void {
  if (gating !== undefined) {
    return;
  }
  throw new Error(`workflow decision "${decisionKey}" must supply "gating" (PART 5 creation-time guard)`);
}

/** The task's pending decisions, read-only; empty when there is no extension context. */
export function listPendingWorkflowDecisionsForTaskV1(taskCanonicalId: string): readonly WorkflowDecisionV1[] {
  const context = getExtensionContextV1();
  if (!context) {
    return [];
  }
  return new WorkflowDecisionStoreV1(decisionStoreStateV1(context)).listPending(taskCanonicalId);
}

export type PostWorkflowDecisionInputV1 =Omit<CreateWorkflowDecisionInputV1, "decisionId" | "createdAt"> & {
  /**
   * Pre-generated id, for a caller that needs to reference its own decision's
   * future id BEFORE posting (e.g. embedding it in an option's command args
   * so the confirmed-execution side can look the decision back up — see
   * `reconcilePlanChecklist.ts`'s at-write freshness guard). Referencing a
   * decision's own id is routing, not "caching authority into args": the
   * command still re-reads the decision (and everything else) fresh: only
   * the identifier travels.
   */
  readonly decisionId?: string;
  readonly suppressNotification?: boolean;
  /**
   * For a standing condition that is re-posted while it persists (a refused
   * scheduled action retrying with back-off, bugs2 finding 13): when a pending
   * decision with the same key already exists it is refreshed in place and
   * NOTHING new is announced — no second chat anchor, no second notification.
   * The first post still announces itself normally.
   */
  readonly quietRepost?: boolean;
  /**
   * For `awaitWorkflowDecisionAnswerV1` only: how to start the action again if
   * a reload, crash or update ends the run the card is waiting on ("Publish
   * Checks were interrupted by a reload; run them again."). Recorded on the
   * decision and quoted when the card is dropped or answered too late.
   */
  readonly restartGuidance?: string;
};

/** How an awaited decision ended, kept distinct so a timeout is never reported as the owner cancelling. */
export type AwaitedDecisionOutcomeV1 =
  | { readonly kind: "answered"; readonly optionId: string }
  | { readonly kind: "dismissed" | "timedOut" | "cancelled" | "interrupted" | "unavailable" };

const DEFAULT_AWAITED_RESTART_GUIDANCE_V1 =
  "Start the action again from the Tasks view or the stage's chat.";

/**
 * Shared dispatch for every migrated decision point (task: "Replace hidden
 * notification decision buttons with explained, selectable decisions" —
 * PART 4): post the record to the store backed by the activating extension's
 * `workspaceState`, then demote the announcing notification to a single
 * "Review decision in Chat" action via `notifyPendingWorkflowDecision`.
 *
 * The store needs a `vscode.Memento`, but these migrated call sites
 * (`beginImplementationRecoveryV1`, `pauseTaskForExhaustedChainV1`, the
 * checklist-reconciliation and reviewer-ticks notifiers) sit many layers deep
 * in the action-coordinator call graph with no `ExtensionContext` threaded
 * through — the exact problem `extensionContextV1.ts`'s doc comment already
 * describes for `quota.ts`'s cross-restart ledger. Reusing that same
 * process-wide accessor here is deliberate: it is the established escape
 * hatch for this shape of problem, not a new pattern.
 *
 * Best-effort like the notifications this replaces: if the activating
 * context is unavailable (e.g. a unit test that never called
 * `setExtensionContextV1`), the decision cannot be persisted anywhere
 * durable, so posting is skipped rather than throwing — the caller's own
 * outcome (the write it just made) must never be masked by this courtesy
 * surface failing. A malformed decision (a genuine contract violation by the
 * calling migration) still throws, so a broken migration fails its tests
 * instead of silently posting nothing.
 */
export async function postWorkflowDecisionV1(
  input: PostWorkflowDecisionInputV1,
  target: ChatTarget
): Promise<WorkflowDecisionV1 | undefined> {
  assertGatingRequirementV1(input.decisionKey, input.gating);
  const context = getExtensionContextV1();
  if (!context) {
    return undefined;
  }
  const preconditioned = await applyRecommendationPreconditionsV1(input, target);
  const store = new WorkflowDecisionStoreV1(decisionStoreStateV1(context));
  // review1 Step 53: a card whose recommended option is safe to run unattended carries a countdown and a
  // "Wait for me" choice. The plan is made from the card as it will be stored.
  const autoContinueMinutes = readAutoContinueMinutes();
  const plannedCountdown =
    autoContinueMinutes > 0
      ? planAutoContinueV1(
          { options: preconditioned.options, recommendation: preconditioned.recommendation, state: "pending" },
          autoContinueMinutes,
          Date.now(),
          await readAutoContinueTaskStateV1(target.taskFolderPath)
        )
      : undefined;
  // review1 Step 54: the owner already chose "and keep going" for this kind of card in this run, so it runs at once.
  const keepGoingApplies =
    plannedCountdown !== undefined &&
    matchesKeepGoingV1(
      {
        taskCanonicalId: target.canonicalId,
        decisionKey: input.decisionKey,
        options: preconditioned.options,
        recommendation: preconditioned.recommendation,
        state: "pending",
      },
      store.listKeepGoing(),
      Date.now(),
      currentRunBindingV1(target.taskFolderPath)
    );
  const autoContinuePlan =
    plannedCountdown !== undefined && keepGoingApplies
      ? { ...plannedCountdown, deadline: new Date().toISOString(), keepGoing: true }
      : plannedCountdown;
  const autoContinueOption =
    autoContinuePlan !== undefined
      ? preconditioned.options.find((candidate) => candidate.optionId === autoContinuePlan.optionId)
      : undefined;
  const storedInput =
    autoContinuePlan !== undefined && autoContinueOption !== undefined
      ? {
          ...preconditioned,
          // The countdown sentence is not stored: the chat draws it from the deadline each time (describeAutoContinueNoteV1).
          options: withKeepGoingOptionV1(withWaitForMeOptionV1(preconditioned.options), autoContinuePlan.optionId),
        }
      : preconditioned;
  const result = await store.post({
    ...storedInput,
    decisionId: storedInput.decisionId ?? crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  });
  if (!result.ok) {
    throw new Error(`workflow decision "${input.decisionKey}" failed validation: ${result.reason}`);
  }
  if (!result.suppressed && autoContinuePlan !== undefined && autoContinueOption !== undefined) {
    // The deadline lives on the stored record, so the periodic sweep finds it again after a reload.
    await store.armAutoContinue(result.decision.decisionId, autoContinuePlan);
    if (autoContinuePlan.keepGoing === true) {
      requestAutoContinueSweepNowV1();
    }
  }
  if (result.suppressed) {
    // Already answered with the same condition and answers (item 7): no new
    // card, no chat anchor, no announcing notification. The earlier resolved
    // record is returned so the caller still sees "a decision exists" rather
    // than the no-extension-context `undefined`.
    return result.decision;
  }
  if (result.deferredCarryOver !== undefined) {
    // bugs5 Step 3: the card that held the owner's kept answer was replaced by a newer review's.
    // Say what carried over and what is new, once, whatever else this post does.
    try {
      await appendChatMessageV1(target.taskFolderPath, {
        role: "assistant",
        text: describeDeferredAnswerCarryOverV1(result.deferredCarryOver),
        stage: result.decision.stage,
        at: new Date().toISOString(),
      }, target.canonicalId);
    } catch {
      // Best-effort: the kept answer itself is already on the replacement record.
    }
  }
  if (input.quietRepost === true && result.updatedInPlace === true) {
    // The standing card was refreshed where it already sits (same decision id,
    // so its existing chat anchor still points at it): announce nothing again.
    return result.decision;
  }
  // The card itself lives in workspaceState, while the transcript is a
  // file. Write a small durable anchor beside it so the chat can place the
  // pending card at the moment it was raised rather than appending every
  // decision after every message. A failed projection is harmless: the
  // renderer falls back to the decision's createdAt timestamp.
  try {
    await appendChatMessageV1(target.taskFolderPath, {
      role: "assistant",
      text: `Decision raised: ${result.decision.whatHappened}`,
      stage: result.decision.stage,
      at: result.decision.createdAt,
      kind: "decision",
      decisionId: result.decision.decisionId,
    }, target.canonicalId);
  } catch {
    // The decision store is authoritative for the card; leave timestamp
    // ordering as the compatibility fallback when the projection cannot run.
  }
  if (!input.suppressNotification) {
    notifyPendingWorkflowDecision(result.decision, target);
  }
  // bugs4 item 20: a card that waits on the owner opens the chat once, without taking focus.
  void revealChatForOwnerCardV1(result.decision, context.workspaceState);
  return result.decision;
}

/**
 * Post a decision and wait, in-process, for it to be resolved — for the two
 * "genuine automation-surfaced decisions" (task "Actionable Hand-offs", Part
 * 11 notification audit): `copilotImplementationRunner.ts`'s round-limit gate
 * and `quota.ts`'s `handleQuotaFailure`. Both used to `await` a raw
 * `vscode.window.showWarningMessage` and branch their own control flow on the
 * answer, which is why they could not be swapped for the fire-and-forget
 * `postWorkflowDecisionV1` the way `preImplementationRouting`/
 * `sterileRoundRouting` were: those two are advisory and fall through
 * regardless of the answer, but these two genuinely cannot proceed without
 * one.
 *
 * `WorkflowDecisionStoreV1` has no built-in "await the answer" primitive —
 * `resolve()` is driven by the chat panel's own message handler — but it does
 * expose `onDidChange` (fired after every `post`/`resolve`/`dismiss`) and
 * `get` (a fresh read), which is enough to build one without redesigning the
 * calling loop: the awaiting call stays alive in-process, exactly as it does
 * today around a modal `await`, and this promise simply resolves once the
 * decision's `state` leaves `"pending"`.
 *
 * Returns the chosen `resolvedOptionId` (or `undefined` if the decision was
 * dismissed rather than resolved, or a `token` was supplied and cancellation
 * fired first, or no extension context is available to post through at all —
 * every one of these must be handled by the caller exactly like "no answer").
 *
 * Cancellation also DISMISSES the persisted record (task "Actionable
 * Hand-offs" review, architectural blocker): the only thing that can ever
 * resume from this decision's answer is the in-process `Promise` below. Once
 * `token` fires, that promise is gone — the operation it was gating has
 * already ended one way or another — so leaving the record `"pending"` would
 * present a gating choice that no longer gates anything: answering it later
 * would resolve the store but reach no waiting caller. Dismissing it here
 * keeps the record's `state` honest with what can actually happen next.
 *
 * The dismissal is AWAITED before the returned promise resolves (review
 * fix, round 2): resolving first and dismissing after — the original
 * shape — let the caller (and the operation it owns) move on while the
 * record was still `"pending"`, so a concurrent answer could race the
 * dismissal, and a rejected `Memento.update` write left a stale, still-
 * answerable card with nothing left to consume it. Ordering it the other
 * way means the caller's `await` genuinely does not return until the
 * record is settled one way or the other; a rejected write is logged and
 * still lets the operation proceed (cancellation must never hang on a
 * storage failure).
 *
 * A rejected write (review fix, round 3) no longer just logs and hopes the
 * next restart's sweep catches it: it immediately marks the decision
 * orphaned in the in-process tombstone (`markWorkflowDecisionOrphanedV1`),
 * which makes `listPending`/`resolve` treat it as non-answerable in THIS
 * session too, not only after a future restart — and starts a background
 * retry (`retryOrphanDismissV1`) of the write itself, so the persisted
 * record still settles once storage recovers rather than needing a restart
 * to close the gap. The activation-time sweep remains the backstop for
 * whatever the retry schedule doesn't catch before the process ends.
 */
/** Timeout for awaiting a workflow decision before auto-dismissing (10 minutes). */
const WORKFLOW_DECISION_AWAIT_TIMEOUT_MS = 10 * 60 * 1000;

export interface AwaitWorkflowDecisionOptionsV1 {
  /**
   * Keep the card open until it is answered, cancelled or interrupted, instead of
   * dismissing it unanswered after {@link WORKFLOW_DECISION_AWAIT_TIMEOUT_MS}.
   */
  readonly noTimeout?: boolean;
}

export async function awaitWorkflowDecisionAnswerV1(
  input: PostWorkflowDecisionInputV1,
  target: ChatTarget,
  token?: import("vscode").CancellationToken,
  /**
   * Told how the wait ended (answered, timed out, interrupted, dismissed, …) so
   * a caller that only gets `undefined` back can still say which of those it was.
   */
  onOutcome?: (outcome: AwaitedDecisionOutcomeV1) => void,
  options?: AwaitWorkflowDecisionOptionsV1
): Promise<string | undefined> {
  const outcome = await awaitWorkflowDecisionOutcomeV1(input, target, token, options);
  onOutcome?.(outcome);
  return outcome.kind === "answered" ? outcome.optionId : undefined;
}

/**
 * The awaiting helper's full result (bugs3 Step 13): which of answered,
 * dismissed, timed out, cancelled or interrupted ended the wait, so a caller
 * can say what stopped it instead of treating every non-answer as the owner
 * cancelling. `awaitWorkflowDecisionAnswerV1` is this with the reason dropped.
 *
 * The waiter is registered BEFORE the card is posted, and the decision records
 * its waiter, activation and restart guidance, so the activation sweep and the
 * answer path can tell a live card from one a reload left behind without a
 * hand-kept list of decision keys.
 */
export async function awaitWorkflowDecisionOutcomeV1(
  input: PostWorkflowDecisionInputV1,
  target: ChatTarget,
  token?: import("vscode").CancellationToken,
  options?: AwaitWorkflowDecisionOptionsV1
): Promise<AwaitedDecisionOutcomeV1> {
  assertGatingRequirementV1(input.decisionKey, input.gating);
  const context = getExtensionContextV1();
  if (!context) {
    return { kind: "unavailable" };
  }
  const store = new WorkflowDecisionStoreV1(decisionStoreStateV1(context));
  const waiterId = registerAwaitedWaiterV1();
  const { restartGuidance, ...decisionInput } = input;
  let posted: Awaited<ReturnType<WorkflowDecisionStoreV1["post"]>>;
  try {
    posted = await store.post({
      ...decisionInput,
      awaited: {
        waiterId,
        activationId: ACTIVATION_ID_V1,
        taskFolderPath: target.taskFolderPath,
        restartGuidance: restartGuidance ?? DEFAULT_AWAITED_RESTART_GUIDANCE_V1,
      },
      decisionId: input.decisionId ?? crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    releaseAwaitedWaiterV1(waiterId);
    throw err;
  }
  if (!posted.ok) {
    releaseAwaitedWaiterV1(waiterId);
    throw new Error(`workflow decision "${input.decisionKey}" failed validation: ${posted.reason}`);
  }
  notifyPendingWorkflowDecision(posted.decision, target);
  // bugs4 item 20: an awaited card blocks the caller on the owner, so it opens the chat once too.
  void revealChatForOwnerCardV1(posted.decision, context.workspaceState);
  const decisionId = posted.decision.decisionId;

  return new Promise<AwaitedDecisionOutcomeV1>((resolve) => {
    let settled = false;
    const changeSubscription = store.onDidChange(checkForResolution);
    const cancelSubscription = token?.onCancellationRequested(() => {
      void handleCancellation();
    });
    // A confirmation the owner asked for (Commit & Push) stays open while they are
    // away; it ends by an answer, the operation's own Cancel, or a reload.
    const timeoutHandle =
      options?.noTimeout === true ? undefined : setTimeout(() => void handleTimeout(), WORKFLOW_DECISION_AWAIT_TIMEOUT_MS);

    async function handleCancellation(): Promise<void> {
      try {
        // If the decision was already resolved/dismissed by the time
        // cancellation fires (a race with the user's own answer), `dismiss`
        // reports `alreadySettled` and is a no-op — `checkForResolution`
        // still wins the race for the returned value in that case.
        await store.dismiss(decisionId, undefined, "cancelled");
      } catch (err) {
        // The write failed (e.g. a rejected `Memento.update`): the record
        // may still read `"pending"`. Cancellation must not hang on a
        // storage failure, so the operation still ends here — but the
        // record must stop presenting as answerable immediately, not only
        // after a future restart's sweep, since THIS session's chat panel
        // is still live and could otherwise let the record be resolved into
        // a continuation (this very `Promise`) that is about to end.
        console.error(`Failed to dismiss workflow decision "${decisionId}" on cancellation`, err);
        markWorkflowDecisionOrphanedV1(decisionId);
        void retryOrphanDismissV1(store, decisionId);
      } finally {
        finish({ kind: "cancelled" });
      }
    }

    async function handleTimeout(): Promise<void> {
      console.warn(`Workflow decision "${decisionId}" (${input.decisionKey}) timed out after ${WORKFLOW_DECISION_AWAIT_TIMEOUT_MS}ms waiting for user answer`);
      try {
        await store.dismiss(decisionId, undefined, "timedOut");
      } catch (err) {
        console.error(`Failed to dismiss timed-out workflow decision "${decisionId}"`, err);
        markWorkflowDecisionOrphanedV1(decisionId);
        void retryOrphanDismissV1(store, decisionId);
      } finally {
        finish({ kind: "timedOut" });
      }
    }

    function checkForResolution(): void {
      const current = store.get(decisionId);
      if (current && current.state !== "pending") {
        finish(outcomeOfSettledDecisionV1(current));
      }
    }

    function finish(outcome: AwaitedDecisionOutcomeV1): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutHandle);
      changeSubscription.dispose();
      cancelSubscription?.dispose();
      releaseAwaitedWaiterV1(waiterId);
      resolve(outcome);
    }

    // Cover the (unlikely but possible) case where the decision was already
    // resolved/dismissed by the time this subscribes — `post` above already
    // awaited, so a fast concurrent resolver could have beaten us here.
    checkForResolution();
  });
}

/** Map a settled record to how its wait ended: an answer, or the distinct reason it was not one. */
function outcomeOfSettledDecisionV1(decision: WorkflowDecisionV1): AwaitedDecisionOutcomeV1 {
  if (decision.resolvedOptionId !== undefined) {
    return { kind: "answered", optionId: decision.resolvedOptionId };
  }
  if (decision.completionReason === "timedOut" || decision.completionReason === "cancelled") {
    return { kind: decision.completionReason };
  }
  // A system retirement (withdrawn/superseded) or a reload sweep ended it, not the owner.
  if (decision.state === "withdrawn" || decision.state === "superseded" || decision.completionReason === "interrupted") {
    return { kind: "interrupted" };
  }
  return { kind: "dismissed" };
}

/**
 * Awaited decisions (bugs3 Step 13) — created via `awaitWorkflowDecisionAnswerV1` — the ONLY
 * continuation that can ever settle one of these is the in-process `Promise`
 * inside the call above. If the extension host restarts (window reload,
 * crash, update) while one is still `"pending"`, that promise — and the
 * operation it was gating — is gone for good; the record survives in
 * `workspaceState` because it is durable by design, but nothing will ever
 * resume from answering it. Left alone, it would keep presenting as an
 * actionable gating decision for a round that no longer exists (review
 * blocker: "extension-host restart similarly loses the only continuation
 * while retaining the decision").
 *
 * `dismissOrphanedAwaitedDecisionsV1` sweeps exactly these two decision keys
 * at activation (see `extension.ts`) and dismisses any still pending —
 * mirroring the cancellation-time dismiss above for the restart case that
 * cancellation can't observe. Keyed by decision KEY, not by some generic
 * "was this created by the await helper" flag, because `WorkflowDecisionV1`
 * has no such flag and adding one would be new persisted schema for a
 * two-entry set that is already exhaustively known here.
 */
/*
 * The sweep no longer lists keys by hand: every decision the awaiting helper
 * posts records its waiter (`WorkflowDecisionV1.awaited`), and
 * `isOrphanedAwaitedDecisionV1` (awaitedDecisionWaitersV1.ts) asks whether
 * that waiter is still alive in this activation. Only records written before
 * the marker existed are matched by the legacy key list kept beside it.
 */

/**
 * Withdraw every still-pending decision matching `decisionKey` for one task
 * (Part 11, event-driven half of item 13c). The render-time safety net
 * (`withdrawStaleDecisionsV1`, chatView.ts) re-derives and withdraws staleness
 * on every render regardless of this call — this is the earlier signal,
 * called from the exact mutation site that made a card stale, so the tree's
 * `hasPendingDecision` token (and any other consumer of `listPending` that
 * never opens the chat panel) does not keep reporting a decision as pending
 * until the next render happens to run.
 *
 * Best-effort, matching `postWorkflowDecisionV1`'s own contract: if no
 * extension context is available (e.g. a unit test), this is a silent no-op
 * rather than a throw, and a rejected individual withdraw write is caught so
 * one failure cannot abort withdrawing the rest of the matches.
 */
export async function withdrawWorkflowDecisionsByKeyV1(
  target: Pick<ChatTarget, "taskFolderPath" | "canonicalId">,
  decisionKey: string,
  reason: string,
  /** When given, only pending decisions it accepts are withdrawn (bugs4 item 13: stale open-items card). */
  shouldWithdraw?: (decision: { readonly whatHappened: string }) => boolean
): Promise<void> {
  const context = getExtensionContextV1();
  if (!context) {
    return;
  }
  const store = new WorkflowDecisionStoreV1(decisionStoreStateV1(context));
  const matches = store
    .listPending(target.canonicalId)
    .filter((d) => d.decisionKey === decisionKey && (shouldWithdraw === undefined || shouldWithdraw(d)));
  for (const decision of matches) {
    try {
      const result = await store.withdraw(decision.decisionId, reason);
      if (result.kind === "withdrawn") {
        // Same "Withdrawn: <reason>" acknowledgement the render-time safety
        // net writes (chatView.ts's withdrawStaleDecisionsV1) — a card
        // vanishing must never be a silent gap in the transcript regardless
        // of which of the two paths caught the staleness first.
        await appendChatMessageV1(target.taskFolderPath, {
          role: "assistant",
          text: `Withdrawn: ${reason}`,
          stage: decision.stage,
          at: new Date().toISOString(),
          kind: "outcome",
        }, target.canonicalId).catch(() => undefined);
        void logChatStatusToNotificationsV1(target.taskFolderPath, `Withdrawn: ${reason}`, decision.stage);
      }
    } catch (err) {
      console.error(`Failed to withdraw workflow decision "${decision.decisionId}"`, err);
    }
  }
}

/**
 * Withdraw EVERY still-pending decision for one task, regardless of
 * `decisionKey` — 1.0.0 gate, A4 (review finding, 2026-09-06): "a decision
 * for a task that has been completed cannot be acted on and should not be
 * retained or rendered" (observed: a `reconcilePlanChecklist` card still
 * presented for a jester task completed a day earlier). Call this from every
 * lifecycle transition after which no further work on the task's stages will
 * ever run again (mark-done completion, archive) — never from a transition
 * that can still resume (pause), where the decision may still need
 * answering.
 *
 * Mirrors {@link withdrawWorkflowDecisionsByKeyV1}'s best-effort contract
 * exactly (silent no-op with no extension context; one failed write does not
 * abort withdrawing the rest), just without the `decisionKey` filter.
 */
export async function retirePendingWorkflowDecisionsForTaskV1(
  target: Pick<ChatTarget, "taskFolderPath" | "canonicalId">,
  reason: string,
  filter?: {
    /** Retire only decisions raised on this stage (RC1 item 9: the stage being left). */
    readonly stage?: TaskStage;
    /** Retire only decisions raised at or before this instant (ISO), so one raised after it survives. */
    readonly raisedAtOrBefore?: string;
  }
): Promise<void> {
  // bugs3 Step 8: owner-evidence and every other question card is retired with
  // the same reason, through the same filter, not only decisions.
  // A task with no chat document has no question cards to retire.
  if (nodeFs.existsSync(nodePath.join(target.taskFolderPath, CHAT_HISTORY_FILENAME))) {
    try {
      await retirePendingQuestionsV1(target.taskFolderPath, target.canonicalId, reason, {
        ...(filter?.stage !== undefined ? { stage: filter.stage } : {}),
        ...(filter?.raisedAtOrBefore !== undefined ? { raisedAtOrBefore: filter.raisedAtOrBefore } : {}),
      });
    } catch (err) {
      console.error("Failed to retire pending question cards", err);
    }
  }
  const context = getExtensionContextV1();
  if (!context) {
    return;
  }
  const store = new WorkflowDecisionStoreV1(decisionStoreStateV1(context));
  const cutoff = filter?.raisedAtOrBefore === undefined ? undefined : Date.parse(filter.raisedAtOrBefore);
  const matches = store.listPending(target.canonicalId).filter(
    (decision) =>
      (filter?.stage === undefined || decision.stage === filter.stage) &&
      (cutoff === undefined || Number.isNaN(cutoff) || Date.parse(decision.createdAt) <= cutoff)
  );
  for (const decision of matches) {
    try {
      const result = await store.withdraw(decision.decisionId, reason);
      if (result.kind === "withdrawn") {
        await appendChatMessageV1(target.taskFolderPath, {
          role: "assistant",
          text: `Withdrawn: ${reason}`,
          stage: decision.stage,
          at: new Date().toISOString(),
          kind: "outcome",
        }, target.canonicalId).catch(() => undefined);
        void logChatStatusToNotificationsV1(target.taskFolderPath, `Withdrawn: ${reason}`, decision.stage);
      }
    } catch (err) {
      console.error(`Failed to retire workflow decision "${decision.decisionId}"`, err);
    }
  }
}

async function announceDroppedAwaitedDecisionV1(decision: WorkflowDecisionV1): Promise<void> {
  const folder = decision.awaited?.taskFolderPath ?? decision.taskCanonicalId;
  try {
    if (!nodeFs.statSync(folder).isDirectory()) {
      return;
    }
  } catch {
    return;
  }
  await appendChatMessageV1(folder, {
    role: "assistant",
    text: describeOrphanedAwaitedDecisionV1(decision),
    stage: decision.stage,
    at: new Date().toISOString(),
    kind: "outcome",
  }, decision.taskCanonicalId).catch(() => undefined);
  void logChatStatusToNotificationsV1(folder, describeOrphanedAwaitedDecisionV1(decision), decision.stage);
}

/**
 * Dismiss every pending awaited decision nothing is waiting on any more, and
 * say in the owning task's chat what was dropped and how to start it again
 * (bugs3 Step 13). A decision with no usable task folder is still dismissed,
 * just without a chat line.
 */
export async function dismissOrphanedAwaitedDecisionsV1(state: import("vscode").Memento): Promise<number> {
  const store = new WorkflowDecisionStoreV1(state);
  const orphaned = store.listPending().filter(isOrphanedAwaitedDecisionV1);
  for (const decision of orphaned) {
    try {
      await store.dismiss(decision.decisionId, undefined, "interrupted");
      await announceDroppedAwaitedDecisionV1(decision);
    } catch (err) {
      // One decision's write failing must not abort the sweep for the rest
      // (the original shape's un-caught `await` inside this loop did
      // exactly that — review fix, round 3). Same treatment as the
      // cancellation path: tombstone it immediately so it can't render or
      // resolve as answerable in this session, and keep retrying the write
      // in the background.
      console.error(`Failed to dismiss orphaned workflow decision "${decision.decisionId}" at activation`, err);
      markWorkflowDecisionOrphanedV1(decision.decisionId);
      void retryOrphanDismissV1(store, decision.decisionId);
    }
  }
  return orphaned.length;
}
