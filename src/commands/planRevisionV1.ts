import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { NotificationRouter } from "../utils/notificationRouter";
import { TaskCreationStartupReconcilerV1 } from "../state/taskCreationStartupReconcilerV1";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { TaskStage, TaskProgress } from "../types/taskProgress";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import { applyPlanRevisionPolicyV1 } from "../services/taskProgressFieldPolicyV1";
import { markChecklistChangeProposalDiscardedV1 } from "../utils/taskProgressTransforms";
import { snapshotPlanForRevisionV1 } from "../utils/implementationArtifactResolver";
import { postWorkflowDecisionV1, withdrawWorkflowDecisionsByKeyV1 } from "../utils/workflowDecisionDispatchV1";
import { ChatTarget } from "../views/chatView";

/**
 * The "Revise the plan" / "Discard the proposal" decision (wf "make the
 * stage chat a record of work" Part 6 / items 5, 19-20) — the deliberate,
 * reviewable way a discovered checklist-item-set change reaches
 * `plan-final.md`, in contrast to the direct-edit path
 * `detectChecklistItemSetMutationV1` (`implementationChecklist.ts`) always
 * catches and reverts.
 */

type ProposalArg = { canonicalId?: string; taskFolderPath?: string; proposalAt?: string };

function normalizeArg(arg: ProposalArg | undefined): ProposalArg | undefined {
  if (!arg) {
    return undefined;
  }
  return {
    canonicalId: arg.canonicalId,
    taskFolderPath: arg.taskFolderPath,
    proposalAt: arg.proposalAt,
  };
}

/** One `checklistChangeProposals` entry's identifying fields, as seen by the caller posting the decision. */
export interface ChecklistChangeProposalSummaryV1 {
  readonly at: string;
  readonly kind: "added" | "removed" | "renumbered";
  readonly proposedItems: readonly string[];
  readonly removedItems: readonly string[];
}

export type ChecklistChangeProposedDecisionPostResultV1 =
  | { readonly kind: "posted" }
  | { readonly kind: "noContext" };

/**
 * Posts the `checklistChangeProposed` decision for a caught checklist-item-set
 * mutation. Pulled out of `reviewActions.ts`'s implementation-run completion
 * path for the same reason `postApplyReviewerVerifiedTicksDecisionV1` was
 * pulled out of `applyReviewerVerifiedTicks.ts` — that caller has
 * `folderUri`/the caught mutation in hand from the round it just finished,
 * with no `TaskInventory` to resolve a command through.
 *
 * Deliberately withheld until both options are real commands (this file) —
 * offering "Revise the plan" before it existed would have been exactly the
 * "option the system already knows does nothing" item 10 of this same
 * workflow-defects investigation forbids.
 */
export async function postChecklistChangeProposedDecisionV1(
  canonicalId: string,
  taskFolderPath: string,
  stage: TaskStage,
  proposal: ChecklistChangeProposalSummaryV1,
  displayName?: string
): Promise<ChecklistChangeProposedDecisionPostResultV1> {
  const target: ChatTarget = { canonicalId, taskFolderPath, stage, taskName: displayName };
  const verb = proposal.kind === "added" ? "add to" : proposal.kind === "removed" ? "remove from" : "renumber";
  const whatHappened =
    `A round tried to ${verb} plan-final.md's checklist item set — a round never mutates the checklist, so the ` +
    "item set was reverted to what it read at the start of the round." +
    (proposal.proposedItems.length > 0
      ? `\n\nProposed additions (discarded):\n${proposal.proposedItems.map((item) => `- ${item}`).join("\n")}`
      : "") +
    (proposal.removedItems.length > 0
      ? `\n\nDropped items (restored):\n${proposal.removedItems.map((item) => `- ${item}`).join("\n")}`
      : "");

  const decision = await postWorkflowDecisionV1(
    {
      decisionKey: "checklistChangeProposed",
      taskCanonicalId: canonicalId,
      stage,
      whatHappened,
      whyUserNeeded:
        "The checklist item set changes only through a deliberate, reviewable plan revision — never as a side " +
        "effect of an implementation round. Whether this discovered change belongs in the plan of record is a " +
        "judgement only you can make.",
      options: [
        {
          optionId: "revise",
          label: "Revise the plan",
          consequence:
            "Moves the task back to Plan carrying this proposal — plan generation and both plan reviews run " +
            "again before Implementation resumes. Existing ticks are preserved; nothing already done is lost.",
          effect: {
            kind: "command",
            command: "vs-code-ai-helper.reviseChecklistChangeProposalConfirmed",
            args: [{ taskFolderPath, canonicalId, proposalAt: proposal.at }],
          },
        },
        {
          optionId: "discard",
          label: "Discard the proposal",
          consequence: "Leaves plan-final.md exactly as it reads now. The proposal is dropped and nothing changes.",
          effect: {
            kind: "command",
            command: "vs-code-ai-helper.discardChecklistChangeProposalConfirmed",
            args: [{ taskFolderPath, canonicalId, proposalAt: proposal.at }],
          },
        },
      ],
      recommendation: {
        kind: "none",
        reasoning:
          "Whether discovered work belongs in the plan of record versus a later task is a scoping call the " +
          "system has no basis to make for you.",
      },
      gating: {
        holdsTaskPaused: false,
        unblocksProgress: false,
        detail:
          "This does not pause or resume the task. Implementation continues against the reverted checklist " +
          "either way while this is pending.",
      },
    },
    target
  );
  return decision ? { kind: "posted" } : { kind: "noContext" };
}

class PlanRevisionPolicyFailureError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

/**
 * Executes the "Revise the plan" option: snapshots the current
 * `plan-final.md` to the revision journal (`snapshotPlanForRevisionV1`,
 * 2026-08-28 review fix — see `PlanRevisionStateV1.journaledPlanRef`'s doc
 * comment), then runs `applyPlanRevisionPolicyV1` (moves the task back to
 * `plan`, truncating `completedStages` while retaining
 * `implReviewFiles`/`reviewScoreHistory`) and records
 * `TaskProgress.planRevision` with that journal's filename attached. Re-derives
 * the proposal by `proposalAt` fresh against whatever is on disk right now
 * rather than trusting anything carried in the decision's args, same
 * rationale as `applyReviewerVerifiedTicksConfirmedV1`'s re-derivation.
 *
 * `plan-final.md` itself is left untouched here — it is still the
 * pre-revision artifact, and stays that way through the plan/plan-review
 * stages this transition enters. It is overwritten once the revised plan is
 * re-finalized (`preparePlanPromotion`'s plan-revision branch,
 * `implementationArtifactResolver.ts`), which reads the JOURNALED copy taken
 * here — not the (in practice identical, but no longer merely assumed-safe)
 * live file — as the source of prior ticks to re-merge.
 *
 * The snapshot is taken BEFORE the policy patch, deliberately: if it fails,
 * the whole revision aborts rather than proceeding without a frozen source
 * for the re-finalization merge to fall back on.
 */
export async function reviseChecklistChangeProposalConfirmedV1(
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore,
  explicitArg?: ProposalArg
): Promise<void> {
  await TaskCreationStartupReconcilerV1.waitUntilReady();
  const normalized = normalizeArg(explicitArg);
  const resolved = await resolveTaskContext(
    inventory,
    normalized,
    { allowPaused: true },
    currentTaskStore
  );
  if (!resolved) {
    NotificationRouter.showError(
      "The task could not be found. Refresh the Tasks panel and try again."
    );
    return;
  }
  const proposalAt = normalized?.proposalAt;
  if (!proposalAt) {
    NotificationRouter.showError("Revise the plan: missing the proposal this decision resolves.");
    return;
  }

  const folderUri = vscode.Uri.file(resolved.taskFolderPath);
  let journaledPlanRef: string | undefined;
  try {
    journaledPlanRef = await snapshotPlanForRevisionV1(folderUri);
  } catch (error) {
    NotificationRouter.showError(
      `Revise the plan could not run: the pre-revision plan-final.md could not be journaled (${
        error instanceof Error ? error.message : String(error)
      }).`
    );
    return;
  }

  let patched: TaskProgress | undefined;
  try {
    patched = await patchTaskProgressStrictV1(folderUri, (current) => {
      const result = applyPlanRevisionPolicyV1(current, {
        now: new Date().toISOString(),
        proposalAt,
        reason:
          "A round's edit to plan-final.md tried to change the checklist item set. The discovered change was " +
          "reverted and now needs a deliberate plan revision to incorporate.",
        ...(journaledPlanRef !== undefined ? { journaledPlanRef } : {}),
      });
      if (!result.ok) {
        throw new PlanRevisionPolicyFailureError(result.code, result.reason);
      }
      return result.progress;
    });
  } catch (error) {
    if (error instanceof PlanRevisionPolicyFailureError) {
      NotificationRouter.showWarning(
        error.code === "checklistChangeProposalNotPending"
          ? "This proposal was already resolved — nothing to revise."
          : `Revise the plan could not run: ${error.message}`
      );
      return;
    }
    NotificationRouter.showError(
      `Revise the plan failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return;
  }
  if (!patched) {
    NotificationRouter.showError("Revise the plan failed: task-progress.json could not be read.");
    return;
  }

  await inventory.refresh();
  // Event-driven half of Part 11 item 13c: the proposal just left "pending"
  // (moved to "revising"), so the card offering it is stale the instant this
  // patch lands — withdraw it now rather than leaving `hasPendingDecision`
  // true until the chat panel's own render-time safety net happens to run.
  await withdrawWorkflowDecisionsByKeyV1(
    { taskFolderPath: resolved.taskFolderPath, canonicalId: resolved.canonicalId },
    "checklistChangeProposed",
    "this checklist-change proposal has already been revised or discarded"
  );
  NotificationRouter.showInformation(
    "Moved to Plan for revision. Generate the plan again to incorporate the discovered change — Implementation " +
      "and later reviews will re-run once the revised plan is finalized."
  );
}

/**
 * Executes the "Discard the proposal" option: leaves `plan-final.md`
 * untouched and marks the matching `checklistChangeProposals` entry
 * `"discarded"`. A no-op (not an error) when the proposal was already
 * resolved by some other path — the two options race the same underlying
 * record, and the last answer standing wins silently rather than surfacing a
 * confusing failure for what the user experiences as "I already decided this".
 */
export async function discardChecklistChangeProposalConfirmedV1(
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore,
  explicitArg?: ProposalArg
): Promise<void> {
  await TaskCreationStartupReconcilerV1.waitUntilReady();
  const normalized = normalizeArg(explicitArg);
  const resolved = await resolveTaskContext(
    inventory,
    normalized,
    { allowPaused: true },
    currentTaskStore
  );
  if (!resolved) {
    NotificationRouter.showError(
      "The task could not be found. Refresh the Tasks panel and try again."
    );
    return;
  }
  const proposalAt = normalized?.proposalAt;
  if (!proposalAt) {
    NotificationRouter.showError("Discard the proposal: missing the proposal this decision resolves.");
    return;
  }

  const folderUri = vscode.Uri.file(resolved.taskFolderPath);
  await patchTaskProgressStrictV1(folderUri, (current) =>
    markChecklistChangeProposalDiscardedV1(current, proposalAt)
  );
  await inventory.refresh();
  // Event-driven half of Part 11 item 13c — see the matching call in
  // reviseChecklistChangeProposalConfirmedV1 above.
  await withdrawWorkflowDecisionsByKeyV1(
    { taskFolderPath: resolved.taskFolderPath, canonicalId: resolved.canonicalId },
    "checklistChangeProposed",
    "this checklist-change proposal has already been revised or discarded"
  );
  NotificationRouter.showInformation("Discarded the proposed checklist change. plan-final.md is unchanged.");
}

export function registerPlanRevisionCommandsV1(
  context: vscode.ExtensionContext,
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "vs-code-ai-helper.reviseChecklistChangeProposalConfirmed",
      (arg?: ProposalArg) => reviseChecklistChangeProposalConfirmedV1(inventory, currentTaskStore, arg)
    ),
    vscode.commands.registerCommand(
      "vs-code-ai-helper.discardChecklistChangeProposalConfirmed",
      (arg?: ProposalArg) => discardChecklistChangeProposalConfirmedV1(inventory, currentTaskStore, arg)
    )
  );
}
