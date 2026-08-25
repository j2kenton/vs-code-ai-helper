/**
 * wf10 item 7d / Part 5 step 15: the manual affordance behind the "Retry
 * with <model>" button a degenerate-review rejection offers when automatic
 * backup advance did not apply — the stage's strategy is not
 * switch-to-backup (a deliberate pause-and-resume/alert-and-wait choice, see
 * decideDegenerateReviewBackupAdvanceV1's doc comment), so Ensemble does not
 * silently change which model runs, but the user can still choose to on this
 * one round.
 *
 * Not contributed to package.json's `commands`: like goToReviewAndApplyV1,
 * this is a wiring detail behind one notification button, not something to
 * offer in the command palette.
 */
import * as vscode from "vscode";
import * as path from "path";
import { TaskStage } from "../types/taskProgress";
import { REVIEW_TARGETS } from "../utils/reviewReadiness";
import { recordActiveFallbackModel } from "../runners/runnerRegistry";
import { runReviewForFolder } from "./reviewActions";
import { NotificationRouter } from "../utils/notificationRouter";
import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";

export async function retryReviewWithBackupV1(
  extensionUri: vscode.Uri,
  input: {
    readonly taskFolderPath: string;
    /** The REVIEW (target) stage the degenerate rejection fired for, e.g. "impl-high-review". */
    readonly stage: TaskStage;
    readonly modelId: string;
  }
): Promise<void> {
  const folderUri = vscode.Uri.file(input.taskFolderPath);
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(folderUri);
  if (!workspaceFolder) {
    NotificationRouter.showWarning(
      "Could not retry with a different model: this task's workspace is not currently open."
    );
    return;
  }
  // `runReviewForFolder` takes the task's underlying CURRENT stage (it
  // derives the review target itself via REVIEW_TARGETS) — read it fresh
  // rather than assuming it still matches the stage this button was
  // rendered for, since some time may have passed since the warning fired.
  const read = await readTaskProgressStrictV1(folderUri, {
    expectedTaskFolder: path.basename(input.taskFolderPath),
  });
  if (!read.ok) {
    NotificationRouter.showWarning("Could not retry with a different model: the task's progress could not be read.");
    return;
  }
  const currentStage = read.decoded.progress.currentStage;
  if (REVIEW_TARGETS[currentStage] !== input.stage) {
    NotificationRouter.showWarning(
      "Could not retry with a different model: the task has since moved past the stage this retry was for."
    );
    return;
  }
  await recordActiveFallbackModel(folderUri, input.stage, input.modelId);
  await runReviewForFolder(extensionUri, folderUri, workspaceFolder, currentStage, true, {
    preserveActiveFallback: true,
  });
}

export function registerRetryReviewWithBackupCommandV1(
  context: vscode.ExtensionContext
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "vs-code-ai-helper.retryReviewWithBackupV1",
      (arg?: { taskFolderPath?: string; stage?: TaskStage; modelId?: string }) =>
        arg?.taskFolderPath && arg.stage && arg.modelId
          ? retryReviewWithBackupV1(context.extensionUri, {
              taskFolderPath: arg.taskFolderPath,
              stage: arg.stage,
              modelId: arg.modelId,
            })
          : Promise.resolve()
    )
  );
}
