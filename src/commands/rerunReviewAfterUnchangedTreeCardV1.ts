/**
 * RC3 item 13: the sole effect of "Review again anyway" on the unchanged-tree
 * chat card `runReviewForFolder` posts in place of the old modal warning (see
 * that function's `isReviewDispatchAgainstUnchangedTreeV1` branch). Confined
 * to that one option — never contributed to package.json, never bound to a
 * button or menu — so an ordinary owner-started review against a
 * still-unchanged tree hits the guard again rather than bypassing it.
 */
import * as vscode from "vscode";
import * as path from "path";
import { TaskStage } from "../types/taskProgress";
import { REVIEW_TARGETS } from "../utils/reviewReadiness";
import { runReviewForFolder } from "./reviewActions";
import { NotificationRouter } from "../utils/notificationRouter";
import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import { formatNotificationTaskLabelV1 } from "../utils/notificationTaskContextV1";
import { ChatViewProvider } from "../views/chatView";

export async function rerunReviewAfterUnchangedTreeCardV1(
  extensionUri: vscode.Uri,
  input: {
    readonly taskFolderPath: string;
    /** The REVIEW (target) stage the unchanged-tree card fired for. */
    readonly stage: TaskStage;
  },
  chatViewProvider?: ChatViewProvider
): Promise<void> {
  const taskLabel = formatNotificationTaskLabelV1(undefined, input.taskFolderPath);
  const folderUri = vscode.Uri.file(input.taskFolderPath);
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(folderUri);
  if (!workspaceFolder) {
    NotificationRouter.showWarning(
      `${taskLabel}: could not re-review — this task's workspace is not currently open.`
    );
    return;
  }
  // Read the CURRENT stage fresh — some time may have passed since the card
  // was posted, and `runReviewForFolder` derives its review target from the
  // task's underlying current stage, not the stage recorded on the card.
  const read = await readTaskProgressStrictV1(folderUri, {
    expectedTaskFolder: path.basename(input.taskFolderPath),
  });
  if (!read.ok) {
    NotificationRouter.showWarning(`${taskLabel}: could not re-review — the task's progress could not be read.`);
    return;
  }
  const currentStage = read.decoded.progress.currentStage;
  if (REVIEW_TARGETS[currentStage] !== input.stage) {
    NotificationRouter.showWarning(
      `${formatNotificationTaskLabelV1(read.decoded.progress.displayName, input.taskFolderPath)}: could not re-review — the task has since moved past the stage this card was about.`
    );
    return;
  }
  await runReviewForFolder(extensionUri, folderUri, workspaceFolder, currentStage, true, {
    chatViewProvider,
    // The owner deliberately chose to re-check unchanged content — the exact
    // opposite of what the guard exists to stop, so bypass it entirely
    // rather than re-post the same card.
    skipUnchangedTreeGuard: true,
  });
}

export function registerRerunReviewAfterUnchangedTreeCardCommandV1(
  context: vscode.ExtensionContext,
  chatViewProvider?: ChatViewProvider
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "vs-code-ai-helper.rerunReviewAfterUnchangedTreeCardV1",
      (arg?: { taskFolderPath?: string; stage?: TaskStage }) =>
        arg?.taskFolderPath && arg.stage
          ? rerunReviewAfterUnchangedTreeCardV1(
              context.extensionUri,
              { taskFolderPath: arg.taskFolderPath, stage: arg.stage },
              chatViewProvider
            )
          : Promise.resolve()
    )
  );
}
