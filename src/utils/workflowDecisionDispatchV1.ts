import { getExtensionContextV1 } from "./extensionContextV1";
import {
  WorkflowDecisionStoreV1,
  clearWorkflowDecisionOrphanedV1,
  markWorkflowDecisionOrphanedV1,
} from "../state/workflowDecisionStoreV1";
import { CreateWorkflowDecisionInputV1, WorkflowDecisionV1 } from "../types/workflowDecisionV1";
import { HandoffGatingV1 } from "../types/handoffGuidanceV1";
import { ChatTarget, notifyPendingWorkflowDecision } from "../views/chatView";

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

export type PostWorkflowDecisionInputV1 = Omit<CreateWorkflowDecisionInputV1, "decisionId" | "createdAt"> & {
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
};

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
  const store = new WorkflowDecisionStoreV1(context.workspaceState);
  const result = await store.post({
    ...input,
    decisionId: input.decisionId ?? crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  });
  if (!result.ok) {
    throw new Error(`workflow decision "${input.decisionKey}" failed validation: ${result.reason}`);
  }
  notifyPendingWorkflowDecision(result.decision, target);
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
export async function awaitWorkflowDecisionAnswerV1(
  input: PostWorkflowDecisionInputV1,
  target: ChatTarget,
  token?: import("vscode").CancellationToken
): Promise<string | undefined> {
  assertGatingRequirementV1(input.decisionKey, input.gating);
  const context = getExtensionContextV1();
  if (!context) {
    return undefined;
  }
  const store = new WorkflowDecisionStoreV1(context.workspaceState);
  const posted = await store.post({
    ...input,
    decisionId: input.decisionId ?? crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  });
  if (!posted.ok) {
    throw new Error(`workflow decision "${input.decisionKey}" failed validation: ${posted.reason}`);
  }
  notifyPendingWorkflowDecision(posted.decision, target);
  const decisionId = posted.decision.decisionId;

  return new Promise<string | undefined>((resolve) => {
    let settled = false;
    const changeSubscription = store.onDidChange(checkForResolution);
    const cancelSubscription = token?.onCancellationRequested(() => {
      void handleCancellation();
    });

    async function handleCancellation(): Promise<void> {
      try {
        // If the decision was already resolved/dismissed by the time
        // cancellation fires (a race with the user's own answer), `dismiss`
        // reports `alreadySettled` and is a no-op — `checkForResolution`
        // still wins the race for the returned value in that case.
        await store.dismiss(decisionId);
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
        finish(undefined);
      }
    }

    function checkForResolution(): void {
      const current = store.get(decisionId);
      if (current && current.state !== "pending") {
        finish(current.resolvedOptionId);
      }
    }

    function finish(value: string | undefined): void {
      if (settled) {
        return;
      }
      settled = true;
      changeSubscription.dispose();
      cancelSubscription?.dispose();
      resolve(value);
    }

    // Cover the (unlikely but possible) case where the decision was already
    // resolved/dismissed by the time this subscribes — `post` above already
    // awaited, so a fast concurrent resolver could have beaten us here.
    checkForResolution();
  });
}

/**
 * `decisionKey`s created via `awaitWorkflowDecisionAnswerV1` — the ONLY
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
const AWAIT_ANSWER_DECISION_KEYS: ReadonlySet<string> = new Set([
  "implementationRoundLimitReached",
  "quotaExhaustedDuringRun",
]);

export async function dismissOrphanedAwaitedDecisionsV1(state: import("vscode").Memento): Promise<number> {
  const store = new WorkflowDecisionStoreV1(state);
  const orphaned = store.listPending().filter((decision) => AWAIT_ANSWER_DECISION_KEYS.has(decision.decisionKey));
  for (const decision of orphaned) {
    try {
      await store.dismiss(decision.decisionId);
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
