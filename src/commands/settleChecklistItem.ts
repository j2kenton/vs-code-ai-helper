import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { IncompleteTask } from "../types/incompleteTask";
import { NotificationRouter } from "../utils/notificationRouter";
import { formatNotificationTaskLabelV1 } from "../utils/notificationTaskContextV1";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { TaskCreationStartupReconcilerV1 } from "../state/taskCreationStartupReconcilerV1";
import { getCanonicalImplementationUri } from "../utils/implementationArtifactResolver";
import { readTextIfExists, writeTextFileIfUnchangedV1 } from "../utils/fileUtils";
import {
  classifyUncheckedChecklistItemsV1,
  settleChecklistItemV1,
  truncateChecklistItemTextV1,
} from "../utils/implementationChecklist";

/**
 * "Settle a checklist item by hand" (RC1 item 8): tick or exclude ONE item of
 * `plan-final.md` without editing the file. Only that item's line changes —
 * the item set and the denominator are untouched — and the write is
 * revision-conditional, so a plan edited since it was read is refused rather
 * than overwritten.
 */

const COMMAND = "vs-code-ai-helper.settleChecklistItem";

export type SettleChecklistItemArgV1 =
  | { readonly task?: IncompleteTask }
  | {
      readonly canonicalId?: string;
      readonly taskFolderPath?: string;
      readonly itemText?: string;
      readonly mode?: "tick" | "exclude";
      readonly note?: string;
    };

export type SettleChecklistItemOutcomeV1 =
  | { readonly kind: "settled"; readonly itemText: string }
  | { readonly kind: "noPlan" }
  | { readonly kind: "notFound" }
  | { readonly kind: "changedUnderneath" };

/** Re-reads the plan and settles the one item. Everything is re-derived from disk. */
export async function applySettleChecklistItemV1(
  taskFolderPath: string,
  itemText: string,
  mode: "tick" | "exclude",
  note: string
): Promise<SettleChecklistItemOutcomeV1> {
  const planUri = getCanonicalImplementationUri(vscode.Uri.file(taskFolderPath));
  const plan = await readTextIfExists(planUri);
  if (plan === undefined) {
    return { kind: "noPlan" };
  }
  const { content, settledItemText } = settleChecklistItemV1(plan, itemText, mode, note);
  if (settledItemText === undefined) {
    return { kind: "notFound" };
  }
  if (!(await writeTextFileIfUnchangedV1(planUri, plan, content))) {
    return { kind: "changedUnderneath" };
  }
  return { kind: "settled", itemText: settledItemText };
}

export async function settleChecklistItem(
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore,
  arg?: SettleChecklistItemArgV1
): Promise<boolean> {
  await TaskCreationStartupReconcilerV1.waitUntilReady();
  const explicit = arg as
    | { canonicalId?: string; taskFolderPath?: string; itemText?: string; mode?: "tick" | "exclude"; note?: string }
    | undefined;
  const treeTask = arg && "task" in arg ? arg.task : undefined;
  const resolved = await resolveTaskContext(
    inventory,
    explicit?.canonicalId || explicit?.taskFolderPath
      ? { canonicalId: explicit.canonicalId, taskFolderPath: explicit.taskFolderPath }
      : treeTask?.folderUri
        ? { taskFolderPath: treeTask.folderUri.fsPath }
        : undefined,
    { allowPaused: true },
    currentTaskStore
  );
  if (!resolved) {
    NotificationRouter.showError("The task could not be found. Refresh the Tasks panel and try again.");
    return false;
  }
  const taskName = formatNotificationTaskLabelV1(resolved.progress.displayName, resolved.taskFolderPath);
  const plan = await readTextIfExists(getCanonicalImplementationUri(vscode.Uri.file(resolved.taskFolderPath)));
  if (plan === undefined) {
    NotificationRouter.showWarning(`${taskName}: plan-final.md could not be read, so no item was settled.`);
    return false;
  }
  const classified = classifyUncheckedChecklistItemsV1(plan);
  const unchecked = [...classified.buildable, ...classified.handoff];
  if (unchecked.length === 0) {
    NotificationRouter.showInformation(`${taskName}: every checklist item is already settled.`);
    return false;
  }

  let itemText = explicit?.itemText;
  if (!itemText) {
    const picked = await vscode.window.showQuickPick(
      unchecked.map((text) => ({ label: truncateChecklistItemTextV1(text, 120), text })),
      { title: `Settle a checklist item — ${taskName}`, placeHolder: "Choose the item to settle by hand", ignoreFocusOut: true }
    );
    if (!picked) {
      return false;
    }
    itemText = picked.text;
  }

  let mode = explicit?.mode;
  if (!mode) {
    const choice = await vscode.window.showQuickPick(
      [
        { label: "Tick it", detail: "You did this (or checked it). Ticks the box and records your note beside it.", mode: "tick" as const },
        {
          label: "Exclude it",
          detail: "This item no longer applies. Leaves the box open, marks it excluded, and keeps it in the count.",
          mode: "exclude" as const,
        },
      ],
      { title: truncateChecklistItemTextV1(itemText, 100), placeHolder: "Only this one line of plan-final.md changes", ignoreFocusOut: true }
    );
    if (!choice) {
      return false;
    }
    mode = choice.mode;
  }

  let note = explicit?.note;
  if (note === undefined) {
    note = await vscode.window.showInputBox({
      title: mode === "tick" ? "Tick this item" : "Exclude this item",
      prompt: mode === "tick" ? "What did you see? Recorded beside the item." : "Why does it not apply? Recorded beside the item.",
      ignoreFocusOut: true,
    });
    if (note === undefined) {
      return false;
    }
  }

  const outcome = await applySettleChecklistItemV1(resolved.taskFolderPath, itemText, mode, note);
  switch (outcome.kind) {
    case "settled":
      await inventory.refresh();
      NotificationRouter.showInformation(
        `${taskName}: ${mode === "tick" ? "ticked" : "excluded"} “${truncateChecklistItemTextV1(outcome.itemText, 100)}” in plan-final.md.`
      );
      return true;
    case "notFound":
      NotificationRouter.showInformation(
        `${taskName}: that item is already settled, or plan-final.md has changed since it was listed.`
      );
      return false;
    case "noPlan":
      NotificationRouter.showWarning(`${taskName}: plan-final.md could not be read, so no item was settled.`);
      return false;
    case "changedUnderneath":
      NotificationRouter.showWarning(`${taskName}: plan-final.md changed while this was being applied — nothing was written. Try again.`);
      return false;
  }
}

export function registerSettleChecklistItemCommandV1(
  context: vscode.ExtensionContext,
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND, (arg?: SettleChecklistItemArgV1) =>
      settleChecklistItem(inventory, currentTaskStore, arg)
    )
  );
}
