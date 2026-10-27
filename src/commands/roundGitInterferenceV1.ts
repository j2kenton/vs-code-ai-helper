import * as vscode from "vscode";
import * as path from "node:path";
import type { TaskInventory } from "../state/taskInventory";
import { MIRRORED_OPERATION_ID_PREFIX, taskOperations } from "../utils/taskOperations";
import { NotificationRouter } from "../utils/notificationRouter";
import { formatNotificationTaskLabelV1 } from "../utils/notificationTaskContextV1";
import {
  acknowledgeRoundGitStashInterferenceV1,
  inspectRoundGitInterferenceV1,
  keepWorkingTreeVersionForUnmergedPathV1,
} from "../utils/roundGitStateV1";
import {
  offerRoundGitInterferenceDecisionV1,
  OPEN_ROUND_GIT_EVIDENCE_COMMAND_V1,
  roundGitObservationEvidencePathV1,
  RESOLVE_ROUND_GIT_INTERFERENCE_COMMAND_V1 as COMMAND,
} from "../utils/roundGitInterferenceDecisionV1";

export const RESOLVE_ROUND_GIT_INTERFERENCE_COMMAND_V1 = COMMAND;

type RoundGitInterferenceActionV1 =
  | { readonly kind: "keepWorkingTree"; readonly relativePath: string }
  | { readonly kind: "acknowledgeStash"; readonly operationId: string };

export async function openRoundGitObservationEvidenceV1(input: {
  readonly taskFolderPath: string;
  readonly operationId: string;
  readonly readText: (evidencePath: string) => Promise<string>;
  readonly open: (evidencePath: string) => Promise<void>;
}): Promise<string> {
  const evidencePath = roundGitObservationEvidencePathV1(input.taskFolderPath, input.operationId);
  const parsed = JSON.parse(await input.readText(evidencePath)) as { taskFolderPath?: unknown; operationId?: unknown };
  if (path.resolve(String(parsed.taskFolderPath ?? "")) !== path.resolve(input.taskFolderPath) || parsed.operationId !== input.operationId) {
    throw new Error("The selected Git observation does not belong to this task.");
  }
  await input.open(evidencePath);
  return evidencePath;
}

/** Register the explicit owner action required to release a round Git hold. */
export function registerRoundGitInterferenceCommandV1(inventory: TaskInventory): vscode.Disposable {
  const resolveCommand = vscode.commands.registerCommand(RESOLVE_ROUND_GIT_INTERFERENCE_COMMAND_V1, async (taskFolderPath?: string, action?: RoundGitInterferenceActionV1): Promise<unknown> => {
    await inventory.refresh();
    const candidates = [];
    for (const task of inventory.getTasks()) {
      if (taskFolderPath && task.taskFolderPath !== taskFolderPath) continue;
      try {
        const liveOperationIds = new Set(taskOperations.getTaskOperations(task.taskFolderPath).map((operation) =>
          operation.id.startsWith(MIRRORED_OPERATION_ID_PREFIX)
            ? operation.id.slice(MIRRORED_OPERATION_ID_PREFIX.length)
            : operation.id
        ));
        const hold = await inspectRoundGitInterferenceV1(task.taskFolderPath, { liveOperationIds });
        if (hold.unmergedPaths.length || hold.stashOperationIds.length) candidates.push({ task, hold });
      } catch (error) {
        await vscode.window.showWarningMessage(`${task.folderName}: Git interference could not be inspected: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!candidates.length) {
      NotificationRouter.showInformation("No unresolved round Git interference was found.");
      return undefined;
    }
    // Decisions are made in chat, never in a picker: without a chosen action
    // (the command run directly, e.g. from the palette), post each affected
    // task's decision card and point to it.
    if (!action) {
      for (const { task, hold } of candidates) {
        const taskLabel = formatNotificationTaskLabelV1(task.progress.displayName, task.taskFolderPath);
        await offerRoundGitInterferenceDecisionV1({
          taskFolderPath: task.taskFolderPath,
          taskName: task.progress.displayName || task.folderName,
          stage: task.progress.currentStage,
          hold,
        });
        NotificationRouter.showInformation(`${taskLabel} — Round Git interference needs your decision; the options are in the task's chat.`);
      }
      return undefined;
    }
    const selected = candidates.length === 1 ? candidates[0] : undefined;
    if (!selected) {
      return { outcome: "refused", message: "Choose a single task for this Git recovery action; no Git state was changed." };
    }
    const taskLabel = formatNotificationTaskLabelV1(selected.task.progress.displayName, selected.task.taskFolderPath);
    const current = await inspectRoundGitInterferenceV1(selected.task.taskFolderPath, {
      liveOperationIds: new Set(taskOperations.getTaskOperations(selected.task.taskFolderPath).map((operation) =>
        operation.id.startsWith(MIRRORED_OPERATION_ID_PREFIX) ? operation.id.slice(MIRRORED_OPERATION_ID_PREFIX.length) : operation.id
      )),
    });
    try {
      if (action.kind === "keepWorkingTree") {
        if (!current.unmergedPaths.includes(action.relativePath)) {
          return { outcome: "alreadyDone", message: `The conflict in ${action.relativePath} is no longer present; no index change was made.` };
        }
        await keepWorkingTreeVersionForUnmergedPathV1(selected.task.taskFolderPath, action.relativePath);
      } else if (action.kind === "acknowledgeStash") {
        if (!current.stashOperationIds.includes(action.operationId)) {
          return { outcome: "alreadyDone", message: `The stash change from ${action.operationId} is already handled; no stash was changed.` };
        }
        await acknowledgeRoundGitStashInterferenceV1(selected.task.taskFolderPath, action.operationId);
      } else {
        return { outcome: "refused", message: "The selected Git recovery action is not recognized; no Git state was changed." };
      }
    } catch (error) {
      return { outcome: "refused", message: `Git recovery could not complete: ${error instanceof Error ? error.message : String(error)}` };
    }
    const remaining = await inspectRoundGitInterferenceV1(selected.task.taskFolderPath, {
      liveOperationIds: new Set(taskOperations.getTaskOperations(selected.task.taskFolderPath).map((operation) =>
        operation.id.startsWith(MIRRORED_OPERATION_ID_PREFIX) ? operation.id.slice(MIRRORED_OPERATION_ID_PREFIX.length) : operation.id
      )),
    });
    if (remaining.unmergedPaths.length || remaining.stashOperationIds.length) {
      await offerRoundGitInterferenceDecisionV1({
        taskFolderPath: selected.task.taskFolderPath,
        taskName: selected.task.progress.displayName || selected.task.folderName,
        stage: selected.task.progress.currentStage,
        hold: remaining,
      });
      return { outcome: "done", message: "That Git recovery choice was recorded. Review the remaining affected paths or stash changes in this updated chat card." };
    }
    NotificationRouter.showInformation(`${taskLabel} — Round Git interference was handled. The task can run again.`);
    return { outcome: "done", message: "The selected Git interference was handled and the repository was reinspected. The task can run again." };
  });
  const evidenceCommand = vscode.commands.registerCommand(OPEN_ROUND_GIT_EVIDENCE_COMMAND_V1, async (taskFolderPath?: string, operationId?: string): Promise<void> => {
    if (!taskFolderPath || !operationId) throw new Error("The task or operation for Git observation evidence is missing.");
    await inventory.refresh();
    const task = inventory.getTasks().find((candidate) => candidate.taskFolderPath === taskFolderPath);
    if (!task) throw new Error("The task-bound Git observation is no longer available in the inventory.");
    await openRoundGitObservationEvidenceV1({
      taskFolderPath: task.taskFolderPath,
      operationId,
      readText: async (evidencePath) => Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(evidencePath))).toString("utf8"),
      open: async (evidencePath) => {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(evidencePath));
        await vscode.window.showTextDocument(document, { preview: true });
      },
    });
  });
  return vscode.Disposable.from(resolveCommand, evidenceCommand);
}
