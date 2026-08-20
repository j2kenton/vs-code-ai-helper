import { getExtensionContextV1 } from "./extensionContextV1";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import { CreateWorkflowDecisionInputV1, WorkflowDecisionV1 } from "../types/workflowDecisionV1";
import { ChatTarget, notifyPendingWorkflowDecision } from "../views/chatView";

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
