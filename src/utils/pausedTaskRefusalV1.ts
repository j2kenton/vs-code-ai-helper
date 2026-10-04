import { NotificationRouter } from "./notificationRouter";
import { formatNotificationTaskLabelV1 } from "./notificationTaskContextV1";
import { offerActionInChatV1 } from "./chatActionOfferV1";

/**
 * RC1 item 11: a stage action refused because the task is paused is a
 * WARNING, not an info message — the user has been blocked from doing what
 * they asked. RC7 item 4: its button only opens the chat, where "Resume" is
 * offered as the recommended option for exactly this task (the same
 * `resumeTask` command reachable from the task tree and Command Palette).
 * One shared shape so every refusing command words it the same way.
 *
 * `action` completes the sentence "Resume it before …" (e.g. "running a
 * review"). This check fires before any tracked-operation context exists, so
 * the task's name is named here explicitly rather than relying on the
 * router's ambient attribution.
 */
export async function showPausedTaskRefusalV1(
  action: string,
  taskFolderPath: string,
  displayName?: string
): Promise<void> {
  const taskLabel = formatNotificationTaskLabelV1(displayName, taskFolderPath);
  const message = `${taskLabel} is paused. Resume it before ${action}.`;
  const pointer = await offerActionInChatV1({
    taskFolderPath,
    taskLabel,
    actionLabel: "Resume",
    command: "vs-code-ai-helper.resumeTask",
    args: [{ taskFolderPath }],
    noticeText: message,
    holdsTaskPaused: true,
  });
  NotificationRouter.showWarning(
    `${taskLabel} is paused. Resume it before ${action}.`,
    undefined,
    undefined,
    undefined,
    pointer
  );
}
