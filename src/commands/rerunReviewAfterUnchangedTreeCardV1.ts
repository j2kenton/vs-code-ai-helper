/**
 * RC3 item 13: the sole effect of "Review again anyway" on the unchanged-tree
 * chat card `runReviewForFolder` posts in place of the old modal warning (see
 * that function's `isReviewDispatchAgainstUnchangedTreeV1` branch). Confined
 * to that one option — never contributed to package.json, never bound to a
 * button or menu — so an ordinary owner-started review against a
 * still-unchanged tree hits the guard again rather than bypassing it.
 *
 * bugs6 item 32: the card is local to the window that raised it, and a viewer window can never run a review
 * itself. In a viewer the answer is relayed to the runner (the route the viewer already uses for Answer, Cancel and
 * Resume), once per answer; if the runner cannot be reached the chat says so and names the next click.
 */
import * as vscode from "vscode";
import * as path from "path";
import { TaskStage } from "../types/taskProgress";
import { stageGroupLabelV1 } from "../utils/modelStageLabelsV1";
import { REVIEW_TARGETS } from "../utils/reviewReadiness";
import { runReviewForFolder } from "./reviewActions";
import { NotificationRouter } from "../utils/notificationRouter";
import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import { formatNotificationTaskLabelV1 } from "../utils/notificationTaskContextV1";
import { ChatViewProvider } from "../views/chatView";
import { isViewerHostV1 } from "../state/hostRoleV1";
import { forwardToRunnerV1, type ViewerForwardResultV1 } from "../services/viewerForwardingV1";
import { appendChatMessageV1 } from "../utils/chatHistoryStore";

export const RERUN_REVIEW_AFTER_UNCHANGED_TREE_COMMAND_V1 = "vs-code-ai-helper.rerunReviewAfterUnchangedTreeCardV1";

/** Answers already acted on in this window, by `<interaction id>:<option>`: one answer starts one review. */
const handledAnswersV1 = new Set<string>();

/** @internal tests only */
export function __resetRerunAnswersForTestV1(): void {
  handledAnswersV1.clear();
}

/** The chat line when the runner could not be asked, with the next click (bugs6 item 32). */
export function describeRerunNotRelayedV1(stageName: string, indeterminate: boolean): string {
  return indeterminate
    ? `Your "Review again anyway" answer reached the runner, but it has not said whether the ${stageName} review started. ` +
        "Check the Notifications view before clicking again, so the review is not run twice."
    : `Your "Review again anyway" answer could not be sent to the runner, so no ${stageName} review was started. ` +
        `Run "Ensemble: Run on Runner…" from the Command Palette and choose Review, or click Review on the ${stageName} row once the runner is connected.`;
}

export interface RerunReviewDepsV1 {
  readonly isViewer: () => boolean;
  readonly forward: (
    commandId: string,
    taskFolderPath: string | undefined,
    commandArg?: Readonly<Record<string, unknown>>
  ) => Promise<ViewerForwardResultV1>;
  readonly say: (taskFolderPath: string, stage: TaskStage, text: string) => Promise<void>;
}

const defaultDepsV1: RerunReviewDepsV1 = {
  isViewer: isViewerHostV1,
  forward: forwardToRunnerV1,
  say: async (taskFolderPath, stage, text) => {
    await appendChatMessageV1(taskFolderPath, { role: "assistant", text, stage, at: new Date().toISOString() }).catch(
      () => undefined
    );
  },
};

export async function rerunReviewAfterUnchangedTreeCardV1(
  extensionUri: vscode.Uri,
  input: {
    readonly taskFolderPath: string;
    /** The REVIEW (target) stage the unchanged-tree card fired for. */
    readonly stage: TaskStage;
    /** `<interaction id>:<option id>` of the answer; one answer starts at most one review. */
    readonly answerKey?: string;
  },
  chatViewProvider?: ChatViewProvider,
  deps: RerunReviewDepsV1 = defaultDepsV1
): Promise<void> {
  if (input.answerKey !== undefined) {
    if (handledAnswersV1.has(input.answerKey)) {
      return;
    }
    handledAnswersV1.add(input.answerKey);
  }
  const stageName = stageGroupLabelV1(input.stage);
  // A viewer never runs a review itself: the runner owns rounds. Relay the answer and report what happened.
  if (deps.isViewer()) {
    const result = await deps.forward(RERUN_REVIEW_AFTER_UNCHANGED_TREE_COMMAND_V1, input.taskFolderPath, {
      stage: input.stage,
      ...(input.answerKey !== undefined ? { answerKey: input.answerKey } : {}),
    });
    if (!result.ok) {
      // The runner never took it, so the same answer may be given again; an indeterminate one may have started.
      if (input.answerKey !== undefined && result.indeterminate !== true) {
        handledAnswersV1.delete(input.answerKey);
      }
      await deps.say(input.taskFolderPath, input.stage, describeRerunNotRelayedV1(stageName, result.indeterminate === true));
    }
    return;
  }
  const taskLabel = formatNotificationTaskLabelV1(undefined, input.taskFolderPath);
  const folderUri = vscode.Uri.file(input.taskFolderPath);
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(folderUri);
  if (!workspaceFolder) {
    NotificationRouter.showWarning(
      `${taskLabel}: could not re-review — this task's workspace is not currently open.`
    );
    await deps.say(
      input.taskFolderPath,
      input.stage,
      `Your "Review again anyway" answer could not start a ${stageName} review: this task's workspace is not open in this window. Open it, then click Review on the ${stageName} row.`
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
    await deps.say(
      input.taskFolderPath,
      input.stage,
      `Your "Review again anyway" answer could not start a ${stageName} review: the task's progress could not be read. Click Review on the ${stageName} row to try again.`
    );
    return;
  }
  const currentStage = read.decoded.progress.currentStage;
  if (REVIEW_TARGETS[currentStage] !== input.stage) {
    NotificationRouter.showWarning(
      `${formatNotificationTaskLabelV1(read.decoded.progress.displayName, input.taskFolderPath)}: could not re-review — the task has since moved past the stage this card was about.`
    );
    await deps.say(
      input.taskFolderPath,
      input.stage,
      `Your "Review again anyway" answer did not start a review: the task has since moved past ${stageName}. Use the stage the task is on now.`
    );
    return;
  }
  await runReviewForFolder(extensionUri, folderUri, workspaceFolder, currentStage, true, {
    chatViewProvider,
    // The owner deliberately chose to re-check unchanged content — the exact
    // opposite of what the guard exists to stop, so bypass it entirely
    // rather than re-post the same card.
    skipUnchangedTreeGuard: true,
    // bugs6 item 32: any return that follows without a review starting writes a chat line.
    startedByOwnerAnswer: true,
  });
}

export function registerRerunReviewAfterUnchangedTreeCardCommandV1(
  context: vscode.ExtensionContext,
  chatViewProvider?: ChatViewProvider
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      RERUN_REVIEW_AFTER_UNCHANGED_TREE_COMMAND_V1,
      (arg?: { taskFolderPath?: string; stage?: TaskStage; answerKey?: string }) =>
        arg?.taskFolderPath && arg.stage
          ? rerunReviewAfterUnchangedTreeCardV1(
              context.extensionUri,
              {
                taskFolderPath: arg.taskFolderPath,
                stage: arg.stage,
                ...(arg.answerKey !== undefined ? { answerKey: arg.answerKey } : {}),
              },
              chatViewProvider
            )
          : Promise.resolve()
    )
  );
}
