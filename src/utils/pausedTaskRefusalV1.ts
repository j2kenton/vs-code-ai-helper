import { NotificationRouter } from "./notificationRouter";
import { formatNotificationTaskLabelV1 } from "./notificationTaskContextV1";

/**
 * RC1 item 11: a stage action refused because the task is paused is a
 * WARNING with a Resume button, not an info message — the user has been
 * blocked from doing what they asked, and the way out is one click away.
 * One shared shape so every refusing command words it the same way.
 *
 * `action` completes the sentence "Resume it before …" (e.g. "running a
 * review"). The button runs `resumeTask` for exactly this task. This check
 * fires before any tracked-operation context exists, so the task's name is
 * named here explicitly rather than relying on the router's ambient
 * attribution.
 */
export function showPausedTaskRefusalV1(
  action: string,
  taskFolderPath: string,
  displayName?: string
): void {
  const taskLabel = formatNotificationTaskLabelV1(displayName, taskFolderPath);
  NotificationRouter.showWarning(
    `${taskLabel} is paused. Resume it before ${action}.`,
    undefined,
    undefined,
    undefined,
    {
      command: "vs-code-ai-helper.resumeTask",
      title: "Resume",
      args: [{ taskFolderPath }],
    }
  );
}
