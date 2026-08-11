import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import { IncompleteTask } from "../types/incompleteTask";
import { NotificationRouter } from "../utils/notificationRouter";
import { TaskCreationStartupReconcilerV1 } from "../state/taskCreationStartupReconcilerV1";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import {
  getCanonicalImplementationUri,
  readPlanOfRecordV1,
} from "../utils/implementationArtifactResolver";
import { readTextIfExists } from "../utils/fileUtils";

type ReconcileArg =
  | { task?: IncompleteTask }
  | { canonicalId?: string; taskFolderPath?: string };

function normalizeArg(
  arg: ReconcileArg | undefined
): { canonicalId?: string; taskFolderPath?: string } | undefined {
  if (!arg) {
    return undefined;
  }
  // Explicit ids first, and the tree-node branch guarded: a dispatcher can
  // hand over a partial `task` carrying only `progress`, which an unguarded
  // `arg.task.folderUri.fsPath` turns into a TypeError.
  const explicit = arg as { canonicalId?: string; taskFolderPath?: string };
  if (explicit.canonicalId || explicit.taskFolderPath) {
    return { canonicalId: explicit.canonicalId, taskFolderPath: explicit.taskFolderPath };
  }
  if ("task" in arg && arg.task?.folderUri) {
    return { taskFolderPath: arg.task.folderUri.fsPath };
  }
  return undefined;
}

/**
 * Clear a task's `checklistProgressUnreliable` latch after the user has brought
 * `plan-final.md`'s checkboxes back in line with the tree.
 *
 * The latch is set when a round changes files without its checklist state
 * being recorded — a runner-authored summary (the sealed edit pipeline returns
 * verified receipts, not prose) or a rejected one. Those completions can never
 * be recovered automatically: no later round knows what an unrecorded round
 * did, and inferring it would tick items nobody verified. So the counts stay
 * understated until a human fixes them, and while they are understated the
 * completeness gate stands down rather than hold a finished plan short of its
 * total.
 *
 * That made the latch one-way, which turned the task tooltip's advice ("tick
 * the missed items in plan-final.md to restore them") into a false promise —
 * the boxes could be ticked and nothing changed. This is the other half of
 * that instruction.
 *
 * Deliberately explicit rather than automatic: ticking a box cannot be
 * distinguished from ticking the LAST box, so no file-watch heuristic can tell
 * a partial edit from a finished reconciliation. Confirming is the user
 * asserting the checklist now matches the work, which is exactly the judgement
 * the workflow cannot make for itself.
 */
export async function reconcilePlanChecklist(
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore,
  explicitArg?: ReconcileArg
): Promise<void> {
  // Activation-order barrier (plan §1.4) — same rationale as pinTask.
  await TaskCreationStartupReconcilerV1.waitUntilReady();
  // The store is what makes this reachable from the Command Palette, which
  // passes no argument: without it resolveTaskContext has nothing to fall back
  // on and always returns undefined, so the command contributed to fix a false
  // promise was itself unusable from the surface it was advertised on.
  const resolved = await resolveTaskContext(
    inventory,
    normalizeArg(explicitArg),
    { allowPaused: true },
    currentTaskStore
  );
  if (!resolved) {
    NotificationRouter.showError(
      "The task could not be found. Refresh the Tasks panel and try again."
    );
    return;
  }
  if (!resolved.progress.checklistProgressUnreliable) {
    NotificationRouter.showInformation(
      "This task's plan checklist is already treated as a complete record."
    );
    return;
  }

  const folderUri = vscode.Uri.file(resolved.taskFolderPath);
  const planUri = getCanonicalImplementationUri(folderUri);

  // Reads durable bytes, saving the user's unsaved ticks first — the shared
  // resolver owns that rule so this command and the completeness gate can
  // never disagree about what the plan says.
  const plan = await readPlanOfRecordV1(folderUri);
  const planOfRecord = plan.text;
  const counted = plan.counts;
  // Nothing to reconcile against. Clearing the latch here would report that
  // completeness gating is restored while readPlanOfRecordV1 keeps returning no
  // counts and the gate stays down — telling the user a safety net is back when
  // it is not, which is the failure this whole mechanism exists to prevent.
  if (!plan.hasChecklist || !counted) {
    NotificationRouter.showWarning(
      "plan-final.md has no implementation checklist to reconcile, so completeness cannot gate " +
        "this task. Generate or restore the checklist first, then run this again."
    );
    return;
  }
  const state =
    `plan-final.md currently reads ${counted.checked}/${counted.total} items complete, ` +
    `with ${counted.remaining} outstanding.`;

  const confirmed = await vscode.window.showWarningMessage(
    "Mark this plan's checklist as an accurate record?\n\n" +
      `${state}\n\n` +
      "Confirm only once you have ticked every item that is actually done. " +
      "Plan completeness will gate stage advancement again from these counts, so " +
      "an item left unticked will hold the task open, and one ticked in error can " +
      "let unfinished work advance.",
    { modal: true },
    "Mark Reconciled"
  );
  if (confirmed !== "Mark Reconciled") {
    return;
  }

  // The modal is a window an implementation run can finish inside. If one
  // landed while it was open, it may have latched the flag for work the user
  // never saw, and clearing regardless would re-arm the gate on counts that
  // went stale between the dialog opening and this write.
  //
  // The freshness check has to happen INSIDE the patch callback, not before
  // it: a check outside still leaves the window between reading and acquiring
  // the write lock, which is exactly where the offending round lands. Throwing
  // from the callback aborts the write atomically. Optimistic rather than a
  // lease because the confirmation is about a specific snapshot — the honest
  // response to that snapshot moving is to ask again, not to win a race.
  const latest = await readTextIfExists(planUri);
  if (latest !== planOfRecord) {
    NotificationRouter.showWarning(
      "plan-final.md changed while the confirmation was open, so the checklist you approved is no " +
        "longer what is on disk. Re-check it and run this again."
    );
    return;
  }

  let raced = false;
  await patchTaskProgressStrictV1(folderUri, (current) => {
    if (current.updatedAt !== resolved.progress.updatedAt) {
      raced = true;
      return current;
    }
    return { ...current, checklistProgressUnreliable: undefined };
  });
  if (raced) {
    NotificationRouter.showWarning(
      "The task changed while the confirmation was open — a round may have landed work the checklist " +
        "does not record. Re-check plan-final.md and run this again."
    );
    return;
  }
  await inventory.refresh();
  NotificationRouter.showInformation(
    "Plan checklist marked as reconciled — completeness now gates advancement again."
  );
}

export function registerReconcilePlanChecklistCommands(
  context: vscode.ExtensionContext,
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "vs-code-ai-helper.reconcilePlanChecklist",
      (arg?: ReconcileArg) => reconcilePlanChecklist(inventory, currentTaskStore, arg)
    )
  );
}
