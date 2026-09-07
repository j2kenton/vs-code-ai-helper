import * as vscode from "vscode";
import { normalizePath } from "../utils/taskRoot";
import {
  CreateWorkflowDecisionInputV1,
  createWorkflowDecisionV1,
  WorkflowDecisionOptionV1,
  WorkflowDecisionV1,
} from "../types/workflowDecisionV1";

const STORAGE_KEY = "workflowDecisions";

/**
 * `WorkflowDecisionStoreV1` is deliberately re-constructed independently at
 * each call site rather than threaded through as a single shared instance
 * (module header). That means two instances built over the SAME `Memento`
 * (e.g. `ChatViewProvider`'s and `TaskTreeProvider`'s, both backed by
 * `context.workspaceState`) are different objects — a plain per-instance
 * `EventEmitter` would let the tree miss a decision resolved from the chat
 * panel. Keying the emitter by the `Memento` object identity instead means
 * every store over the same underlying storage shares one change signal,
 * without requiring callers to pass a singleton around.
 */
const changeEmitters = new WeakMap<vscode.Memento, vscode.EventEmitter<void>>();

function changeEmitterFor(state: vscode.Memento): vscode.EventEmitter<void> {
  let emitter = changeEmitters.get(state);
  if (!emitter) {
    emitter = new vscode.EventEmitter<void>();
    changeEmitters.set(state, emitter);
  }
  return emitter;
}

/**
 * In-process tombstone for a decision whose owning continuation has already
 * ended (cancellation, or an extension-restart sweep) but whose durable
 * `dismiss` write itself failed (e.g. a rejected `Memento.update`) — task
 * "Actionable Hand-offs" review, architectural blocker round 3: a failed
 * cleanup write must not leave the record presenting as answerable just
 * because the PERSISTED state still reads `"pending"`.
 *
 * Deliberately process-wide rather than per-`Memento`: a decisionId is
 * globally unique (`crypto.randomUUID()`), so there is nothing to key it
 * against, and the failure this guards is itself an in-process fact (no
 * continuation exists to resume) independent of which storage instance
 * observes it. `workflowDecisionDispatchV1.ts` marks/clears this set; this
 * store only reads it, at the two points a stale-but-still-pending record
 * could otherwise be treated as live: listing what's pending, and resolving
 * an answer against it.
 */
const orphanedDecisionIds = new Set<string>();

/**
 * 1.0.0 gate, A4 (task "1.0.0 Gate", Part A): `workspaceState` is a Memento —
 * VS Code holds it in memory and rewrites it WHOLE on every update — so an
 * unbounded `workflowDecisions` array is not just disk growth, it is
 * resident memory that grows without limit as rounds run. Measured on a real
 * workspace, 2026-09-04: 331 records (245 of them `reconcilePlanChecklist`
 * re-posts for one standing condition) at 2.46 MB, cited as the dominant
 * contributor to a repeated `oom` window termination. A "cap of 200" was
 * assumed by design but never actually enforced anywhere in this store —
 * every write just appended. This constant and `enforceWorkflowDecisionCapV1`
 * are the enforcement that was missing.
 */
export const MAX_WORKFLOW_DECISIONS_V1 = 200;

/**
 * Bounds the persisted array to {@link MAX_WORKFLOW_DECISIONS_V1}, called
 * from every write path via `saveAll`. PENDING decisions are never dropped
 * to make room — they are still actionable, and silently discarding one
 * would strand whatever it was holding paused exactly like the store
 * overflow this guards against, just via a different mechanism. Only
 * already-settled records (resolved/dismissed/withdrawn/superseded — pure
 * history) are eligible for trimming, oldest-first, until the total is back
 * at the cap or there is no more history left to drop. A workspace that
 * somehow accumulates more than the cap's worth of PENDING decisions keeps
 * all of them uncapped — that is a real backlog needing a human, not
 * something safe to solve by deleting an unanswered decision.
 */
function enforceWorkflowDecisionCapV1(
  decisions: readonly WorkflowDecisionV1[]
): readonly WorkflowDecisionV1[] {
  if (decisions.length <= MAX_WORKFLOW_DECISIONS_V1) {
    return decisions;
  }
  const pendingCount = decisions.reduce((n, d) => (d.state === "pending" ? n + 1 : n), 0);
  const keepSettledCount = Math.max(0, MAX_WORKFLOW_DECISIONS_V1 - pendingCount);
  let settledSeen = 0;
  const totalSettled = decisions.length - pendingCount;
  const dropSettledCount = Math.max(0, totalSettled - keepSettledCount);
  // Single forward pass, oldest-first (the array is append order): drop the
  // OLDEST `dropSettledCount` settled records, keep every pending record and
  // every settled record after that point.
  return decisions.filter((decision) => {
    if (decision.state === "pending") {
      return true;
    }
    settledSeen += 1;
    return settledSeen > dropSettledCount;
  });
}

export function markWorkflowDecisionOrphanedV1(decisionId: string): void {
  orphanedDecisionIds.add(decisionId);
}

export function clearWorkflowDecisionOrphanedV1(decisionId: string): void {
  orphanedDecisionIds.delete(decisionId);
}

export function isWorkflowDecisionOrphanedV1(decisionId: string): boolean {
  return orphanedDecisionIds.has(decisionId);
}

export type PostWorkflowDecisionResultV1 =
  | { readonly ok: true; readonly decision: WorkflowDecisionV1 }
  | { readonly ok: false; readonly reason: string };

export type ResolveWorkflowDecisionResultV1 =
  | { readonly kind: "resolved"; readonly decision: WorkflowDecisionV1; readonly option: WorkflowDecisionOptionV1 }
  /**
   * The decision was already resolved/dismissed/superseded — the answer
   * already landed. Callers must present this as "already submitted", not as
   * a failed round (task: "an already-answered decision is not an error").
   */
  | { readonly kind: "alreadySettled"; readonly decision: WorkflowDecisionV1 }
  | { readonly kind: "missing" }
  | { readonly kind: "rejected"; readonly reason: string }
  /**
   * The decision's owning in-process continuation has already ended (its
   * dismissal write failed, so the persisted record may still read
   * `"pending"`, but nothing is left to act on an answer). Distinct from
   * `alreadySettled`: the store record itself may not be settled yet — this
   * fires from the in-process tombstone, ahead of and independent of the
   * persisted state, so the caller never dispatches an option's effect into
   * a continuation that no longer exists.
   */
  | { readonly kind: "orphaned" };

export type DismissWorkflowDecisionResultV1 =
  | { readonly kind: "dismissed"; readonly decision: WorkflowDecisionV1 }
  | { readonly kind: "alreadySettled"; readonly decision: WorkflowDecisionV1 }
  | { readonly kind: "missing" };

export type WithdrawWorkflowDecisionResultV1 =
  | { readonly kind: "withdrawn"; readonly decision: WorkflowDecisionV1 }
  | { readonly kind: "alreadySettled"; readonly decision: WorkflowDecisionV1 }
  | { readonly kind: "missing" };

/**
 * Persistent store for `WorkflowDecisionV1` records (task: "Replace hidden
 * notification decision buttons with explained, selectable decisions").
 *
 * Backed by a single `vscode.Memento` key, mirroring `PendingOperationsStore`'s
 * convention (`src/state/pendingOperationsStore.ts`): decisions are advisory
 * UI state that mirrors work already tracked durably elsewhere (round
 * summaries, chat transactions, notifications), not itself the source of
 * truth for workflow progress, so the lighter Memento-backed pattern applies
 * rather than the exclusive-create/revision-guarded filesystem stores used
 * for durable cross-process transactional records.
 *
 * `post` updates any existing PENDING decision sharing the same
 * `decisionKey` + `taskCanonicalId` IN PLACE (same `decisionId`, refreshed
 * content) rather than superseding it and appending a new record —
 * e.g. a second `reconcilePlanChecklist` decision for the same task refreshes
 * the first instead of presenting two. 1.0.0 gate, A4/B2 (review finding,
 * 2026-09-06): the prior supersede-then-append behavior meant a recurring
 * standing condition (`reconcilePlanChecklist` reposted 245 times on one
 * real task) grew the store by one record on every repost, relying on the
 * array cap to eventually trim the resulting history; update-in-place means
 * a recurring condition costs the store nothing extra at all.
 */
export class WorkflowDecisionStoreV1 {
  /**
   * Fires after `post`/`resolve`/`dismiss`/`removeForTask` durably change
   * this store's records — shared across every instance backed by the same
   * `Memento` (see `changeEmitterFor`), so a task-tree instance and a
   * chat-view instance over the same `workspaceState` both observe the
   * other's writes. Used by `TaskTreeProvider` to refresh a task's pending-
   * decision tooltip line the moment a decision is resolved elsewhere,
   * rather than only on the next unrelated refresh.
   */
  readonly onDidChange: vscode.Event<void>;

  constructor(private readonly state: vscode.Memento) {
    this.onDidChange = changeEmitterFor(state).event;
  }

  private all(): WorkflowDecisionV1[] {
    return this.state.get<WorkflowDecisionV1[]>(STORAGE_KEY, []);
  }

  private async saveAll(decisions: readonly WorkflowDecisionV1[]): Promise<void> {
    await this.state.update(STORAGE_KEY, enforceWorkflowDecisionCapV1(decisions));
    changeEmitterFor(this.state).fire();
  }

  /**
   * Validate and persist a decision. Any existing PENDING decision for the
   * same `decisionKey` + `taskCanonicalId` is updated IN PLACE (same
   * `decisionId`, every other field refreshed to the new content) rather
   * than being superseded and appended after — see the class doc comment for
   * why (1.0.0 gate, A4/B2: a recurring standing condition must cost the
   * store nothing extra on repost).
   */
  async post(input: CreateWorkflowDecisionInputV1): Promise<PostWorkflowDecisionResultV1> {
    const created = createWorkflowDecisionV1(input);
    if (!created.ok) {
      return created;
    }
    const canonicalId = normalizePath(input.taskCanonicalId);
    const existing = this.all();
    const matchIndex = existing.findIndex(
      (decision) =>
        decision.state === "pending" &&
        decision.decisionKey === input.decisionKey &&
        normalizePath(decision.taskCanonicalId) === canonicalId
    );
    if (matchIndex !== -1) {
      const updated: WorkflowDecisionV1 = {
        ...created.decision,
        decisionId: existing[matchIndex]!.decisionId,
      };
      const next = [...existing];
      next[matchIndex] = updated;
      await this.saveAll(next);
      return { ok: true, decision: updated };
    }
    const next = [...existing, created.decision];
    await this.saveAll(next);
    return { ok: true, decision: created.decision };
  }

  /**
   * Every pending decision, optionally filtered to one task. Excludes
   * decisions marked orphaned in-process (see `isWorkflowDecisionOrphanedV1`)
   * even though their persisted `state` may still read `"pending"` — a
   * failed cleanup write must not keep presenting the record as answerable.
   */
  listPending(taskCanonicalId?: string): readonly WorkflowDecisionV1[] {
    const needle = taskCanonicalId !== undefined ? normalizePath(taskCanonicalId) : undefined;
    return this.all().filter(
      (decision) =>
        decision.state === "pending" &&
        !isWorkflowDecisionOrphanedV1(decision.decisionId) &&
        (needle === undefined || normalizePath(decision.taskCanonicalId) === needle)
    );
  }

  get(decisionId: string): WorkflowDecisionV1 | undefined {
    return this.all().find((decision) => decision.decisionId === decisionId);
  }

  /**
   * Resolve a pending decision with the chosen option. Single-flight: the
   * caller must resolve here FIRST and only then execute the option's
   * effect, so a second press of an already-resolved control reports
   * `alreadySettled` instead of dispatching the effect twice.
   *
   * Paused-answer sequencing (task "Actionable Hand-offs", PART 5, verified
   * 2026-08-23): this method carries no coupling to `TaskProgress.status` at
   * all — it never reads it and never refuses on it. A decision is therefore
   * ALWAYS retained and its option's effect ALWAYS dispatched (by
   * `ChatViewProvider.resolveWorkflowDecision`, `views/chatView.ts`)
   * immediately upon resolving, whether the owning task is paused or active.
   * There is no "accept, then silently drop while paused" path to guard
   * against here; the answer is never queued or deferred. Whether the
   * dispatched effect's own command then does something useful on a paused
   * task is that command's own concern, not this store's.
   */
  async resolve(decisionId: string, optionId: string): Promise<ResolveWorkflowDecisionResultV1> {
    if (isWorkflowDecisionOrphanedV1(decisionId)) {
      // The waiter that could act on this answer is already gone (its
      // dismissal write failed but the continuation still ended). Refuse
      // BEFORE touching persisted state, so a race between a stale rendered
      // control and a background retry can never dispatch an option's
      // effect into nothing.
      return { kind: "orphaned" };
    }
    const existing = this.all();
    const index = existing.findIndex((decision) => decision.decisionId === decisionId);
    if (index === -1) {
      return { kind: "missing" };
    }
    const decision = existing[index]!;
    if (decision.state !== "pending") {
      return { kind: "alreadySettled", decision };
    }
    const option = decision.options.find((candidate) => candidate.optionId === optionId);
    if (!option) {
      return { kind: "rejected", reason: `decision "${decisionId}" has no option "${optionId}"` };
    }
    const resolved: WorkflowDecisionV1 = {
      ...decision,
      state: "resolved",
      resolvedOptionId: optionId,
      resolvedAt: new Date().toISOString(),
    };
    const next = [...existing];
    next[index] = resolved;
    await this.saveAll(next);
    return { kind: "resolved", decision: resolved, option };
  }

  /** Dismiss a pending decision without selecting an option. */
  async dismiss(decisionId: string): Promise<DismissWorkflowDecisionResultV1> {
    const existing = this.all();
    const index = existing.findIndex((decision) => decision.decisionId === decisionId);
    if (index === -1) {
      return { kind: "missing" };
    }
    const decision = existing[index]!;
    if (decision.state !== "pending") {
      return { kind: "alreadySettled", decision };
    }
    const dismissed: WorkflowDecisionV1 = { ...decision, state: "dismissed" };
    const next = [...existing];
    next[index] = dismissed;
    await this.saveAll(next);
    return { kind: "dismissed", decision: dismissed };
  }

  /**
   * Withdraw a pending decision because the SYSTEM determined its triggering
   * condition no longer holds (item 13c) — e.g. the restore card's quarantined
   * files were already cleared, or the plan's item set changed since a
   * `checklistChangeProposed` card was posted. Distinct from `dismiss`
   * (a user declining to answer, no reason recorded): `withdraw` records
   * `reason` on the settled record so the transcript can state why the card
   * vanished ("Withdrawn: <reason>") rather than leaving a silent gap where a
   * decision used to be. Idempotent in effect — withdrawing an
   * already-settled decision reports `alreadySettled` rather than
   * overwriting whatever state it already reached (resolved, dismissed, or a
   * second withdrawal), exactly like `dismiss`.
   */
  async withdraw(decisionId: string, reason: string): Promise<WithdrawWorkflowDecisionResultV1> {
    const existing = this.all();
    const index = existing.findIndex((decision) => decision.decisionId === decisionId);
    if (index === -1) {
      return { kind: "missing" };
    }
    const decision = existing[index]!;
    if (decision.state !== "pending") {
      return { kind: "alreadySettled", decision };
    }
    const withdrawn: WorkflowDecisionV1 = { ...decision, state: "withdrawn", withdrawnReason: reason };
    const next = [...existing];
    next[index] = withdrawn;
    await this.saveAll(next);
    return { kind: "withdrawn", decision: withdrawn };
  }

  /**
   * Drop every persisted decision belonging to one task (mirrors
   * `PendingOperationsStore.removeForTask`), used when a task is archived.
   * Returns how many records were removed.
   */
  async removeForTask(taskCanonicalId: string): Promise<number> {
    const needle = normalizePath(taskCanonicalId);
    const existing = this.all();
    const kept = existing.filter((decision) => normalizePath(decision.taskCanonicalId) !== needle);
    if (kept.length !== existing.length) {
      await this.saveAll(kept);
    }
    return existing.length - kept.length;
  }
}
