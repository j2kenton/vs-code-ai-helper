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
  getPlanRevisionV1,
  listPlanItemContentHashesV1,
  listProvisionalTickedItemsV1,
  normalizeChecklistItemTextV1,
  settleChecklistItemV1,
  truncateChecklistItemTextV1,
} from "../utils/implementationChecklist";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import { recordPlanItemOwnerDecisionV1 } from "../utils/taskProgressTransforms";
import { askChatChoiceV1 } from "../utils/chatChoiceV1";
import { askChatFreeTextV1 } from "../utils/chatFreeTextV1";
import { postStageReadyCardIfReadyV1 } from "./automationStoppedCardV1";
import { refreshPlanItemSettlementSnapshotV1 } from "./planItemSettlementNoticeV1";

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
  /** review1 Step 7: a ticked item awaiting a check was settled by recording the owner's tick (the line is untouched). */
  | { readonly kind: "ownerTickRecorded"; readonly itemText: string }
  /** review1 Step 7: the item is ticked and a reviewer or the owner already settled it. */
  | { readonly kind: "alreadySettled"; readonly itemText: string }
  | { readonly kind: "noPlan" }
  | { readonly kind: "notFound" }
  | { readonly kind: "changedUnderneath" };

/** The message for an outcome that settled nothing, saying why (review1 Step 7). */
export function describeUnsettledOutcomeV1(taskName: string, outcome: SettleChecklistItemOutcomeV1): string {
  switch (outcome.kind) {
    case "notFound":
      return `${taskName}: that item is not in plan-final.md as it was listed (it was settled, reworded or removed since), so nothing was changed.`;
    case "alreadySettled":
      return `${taskName}: “${truncateChecklistItemTextV1(outcome.itemText, 100)}” is already settled by a review or by you, so nothing was changed.`;
    case "noPlan":
      return `${taskName}: plan-final.md could not be read, so no item was settled.`;
    case "changedUnderneath":
      return `${taskName}: plan-final.md changed while this was being applied — nothing was written. Try again.`;
    default:
      return `${taskName}: nothing was changed.`;
  }
}

/** Records the owner's row for an item, best effort: the plan line is already written when this runs. */
async function recordOwnerSettlementV1(
  taskFolderPath: string,
  plan: string,
  itemText: string,
  decision: "tick" | "exclude"
): Promise<void> {
  const at = new Date().toISOString();
  const planRevision = getPlanRevisionV1(plan);
  await patchTaskProgressStrictV1(vscode.Uri.file(taskFolderPath), (progress) =>
    recordPlanItemOwnerDecisionV1(progress, { planRevision, planText: plan, itemText, at, formId: `settle:${at}`, decision })
  ).catch(() => undefined);
  // review1 Step 8: the owner's settlement changed the count, so the stored snapshot (and any "sent back" note on
  // the Tasks tooltip) follows it.
  await refreshPlanItemSettlementSnapshotV1(vscode.Uri.file(taskFolderPath));
}

/**
 * review1 Step 7: settles a ticked item that only a model has claimed by recording the owner's tick (an owner
 * decision row with the item's content hash). The plan line is not rewritten: the box is already ticked.
 */
export async function applyOwnerTickToProvisionalItemV1(
  taskFolderPath: string,
  itemText: string
): Promise<SettleChecklistItemOutcomeV1> {
  const folderUri = vscode.Uri.file(taskFolderPath);
  const plan = await readTextIfExists(getCanonicalImplementationUri(folderUri));
  if (plan === undefined) {
    return { kind: "noPlan" };
  }
  const read = await readTaskProgressStrictV1(folderUri);
  const progress = read.ok ? read.decoded.progress : undefined;
  const key = normalizeChecklistItemTextV1(itemText);
  const entry = listPlanItemContentHashesV1(plan).find((candidate) => !candidate.nested && candidate.key === key);
  if (!entry || !entry.checked || entry.excluded) {
    return { kind: "notFound" };
  }
  const provisional = listProvisionalTickedItemsV1(plan, progress?.planItemEvidence ?? [], progress?.planItemOwnerDecisions ?? []);
  if (!provisional.some((item) => normalizeChecklistItemTextV1(item.text) === key)) {
    return { kind: "alreadySettled", itemText: entry.text };
  }
  await recordOwnerSettlementV1(taskFolderPath, plan, entry.text, "tick");
  // review1 Step 31: if that was the last open item and the review is clean, say so at once.
  void postStageReadyCardIfReadyV1(taskFolderPath, "After your tick");
  return { kind: "ownerTickRecorded", itemText: entry.text };
}

/**
 * Re-reads the plan and settles the one item. Everything is re-derived from disk. An unticked item is ticked or
 * excluded in the plan and the owner's decision is recorded (review1 Step 7: today the command wrote only the
 * plan, so the gate could not tell an owner tick from a model's); a ticked item awaiting a check records the
 * owner's tick without rewriting the line.
 */
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
    // Not an unticked item: a ticked item still awaiting a check is settled by the owner's tick.
    return mode === "tick" ? applyOwnerTickToProvisionalItemV1(taskFolderPath, itemText) : { kind: "notFound" };
  }
  if (!(await writeTextFileIfUnchangedV1(planUri, plan, content))) {
    return { kind: "changedUnderneath" };
  }
  // The text as written now carries the settle note; the owner row is keyed to the item's content, not the note.
  await recordOwnerSettlementV1(taskFolderPath, content, settledItemText, mode);
  void postStageReadyCardIfReadyV1(taskFolderPath, mode === "tick" ? "After your tick" : "After your exclusion");
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
  // review1 Step 7: ticked items still awaiting a check can be settled by the owner here too.
  const progressRead = await readTaskProgressStrictV1(vscode.Uri.file(resolved.taskFolderPath));
  const awaitingCheck = listProvisionalTickedItemsV1(
    plan,
    progressRead.ok ? progressRead.decoded.progress.planItemEvidence ?? [] : [],
    progressRead.ok ? progressRead.decoded.progress.planItemOwnerDecisions ?? [] : []
  ).map((item) => item.text);
  if (unchecked.length === 0 && awaitingCheck.length === 0) {
    NotificationRouter.showInformation(`${taskName}: every checklist item is already settled.`);
    return false;
  }
  const pickable = [...unchecked, ...awaitingCheck];
  const awaitingKeys = new Set(awaitingCheck.map(normalizeChecklistItemTextV1));

  const target = {
    canonicalId: resolved.canonicalId,
    taskFolderPath: resolved.taskFolderPath,
    stage: resolved.progress.currentStage,
    taskName: resolved.progress.displayName ?? resolved.folderName,
  };

  let itemText = explicit?.itemText;
  if (!itemText) {
    const chosenItem = await askChatChoiceV1({
      decisionKey: "settleChecklistPickItem",
      target,
      whatHappened: `Settle a checklist item — ${taskName}`,
      whyUserNeeded: "Choose the item to settle by hand.",
      options: pickable.map((text, index) => {
        const awaiting = awaitingKeys.has(normalizeChecklistItemTextV1(text)) && index >= unchecked.length;
        return {
          optionId: `item-${index}`,
          label: awaiting
            ? `Ticked, awaiting check — ${truncateChecklistItemTextV1(text, 100)}`
            : truncateChecklistItemTextV1(text, 120),
          consequence: awaiting
            ? "Selects this ticked item. Its box is already ticked; you record that you checked it, and the plan line is not changed."
            : "Selects this checklist item to tick or exclude.",
        };
      }),
      detail: "Answering selects the checklist item to settle.",
    });
    const itemIndex = chosenItem === undefined ? -1 : pickable.findIndex((_t, i) => `item-${i}` === chosenItem);
    if (itemIndex < 0) {
      return false;
    }
    itemText = pickable[itemIndex]!;
  }

  // A ticked item awaiting a check has one way to settle: record that the owner checked it.
  if (awaitingKeys.has(normalizeChecklistItemTextV1(itemText)) && !unchecked.some((text) => normalizeChecklistItemTextV1(text) === normalizeChecklistItemTextV1(itemText))) {
    const recorded = await applyOwnerTickToProvisionalItemV1(resolved.taskFolderPath, itemText);
    if (recorded.kind === "ownerTickRecorded") {
      await inventory.refresh();
      NotificationRouter.showInformation(
        `${taskName}: recorded your tick for “${truncateChecklistItemTextV1(recorded.itemText, 100)}”. The plan line is unchanged.`
      );
      return true;
    }
    NotificationRouter.showInformation(describeUnsettledOutcomeV1(taskName, recorded));
    return false;
  }

  let mode = explicit?.mode;
  if (!mode) {
    const choice = await askChatChoiceV1({
      decisionKey: "settleChecklistPickMode",
      target,
      whatHappened: truncateChecklistItemTextV1(itemText, 100),
      whyUserNeeded: "Only this one line of plan-final.md changes.",
      options: [
        {
          optionId: "tick",
          label: "Tick it",
          description: "You did this (or checked it). Ticks the box and records your note beside it.",
        },
        {
          optionId: "exclude",
          label: "Exclude it",
          description: "This item no longer applies. Leaves the box open, marks it excluded, and keeps it in the count.",
        },
      ],
      recommendedOptionId: "tick",
      recommendationReasoning: "Ticking records completed or verified work.",
      detail: "Answering chooses how to settle the selected item.",
    });
    if (choice !== "tick" && choice !== "exclude") {
      return false;
    }
    mode = choice;
  }

  let note = explicit?.note;
  if (note === undefined) {
    note = await askChatFreeTextV1({
      target,
      title: mode === "tick" ? "Tick this item" : "Exclude this item",
      prompt: mode === "tick" ? "What did you see? Recorded beside the item." : "Why does it not apply? Recorded beside the item.",
      restartGuidance: `choose ${mode === "tick" ? "Tick" : "Exclude"} on that plan item again.`,
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
    case "ownerTickRecorded":
      await inventory.refresh();
      NotificationRouter.showInformation(
        `${taskName}: recorded your tick for “${truncateChecklistItemTextV1(outcome.itemText, 100)}”. The plan line is unchanged.`
      );
      return true;
    case "noPlan":
    case "changedUnderneath":
      NotificationRouter.showWarning(describeUnsettledOutcomeV1(taskName, outcome));
      return false;
    case "notFound":
    case "alreadySettled":
      NotificationRouter.showInformation(describeUnsettledOutcomeV1(taskName, outcome));
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
