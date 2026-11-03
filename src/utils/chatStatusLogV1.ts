/**
 * chat1 Steps 3 and 5: the chat is a conversation, so the status lines it used to show
 * ("Recorded: …", "Dismissed …", "Withdrawn: …") are tagged `kind: "outcome"` at their source and
 * logged to Notifications instead, with the task named. One entry per event.
 */
import * as vscode from "vscode";
import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import { STAGE_DISPLAY_NAMES, type TaskStage } from "../types/taskProgress";
import { formatNotificationTaskLabelV1 } from "./notificationTaskContextV1";
import { getNotificationRouterStatus, NotificationRouter } from "./notificationRouter";

/**
 * Log a status line that is no longer a chat entry to Notifications, naming its task and stage.
 * Best effort: a failed log must never affect the work that raised the line.
 */
export async function logChatStatusToNotificationsV1(
  taskFolderPath: string,
  text: string,
  stage?: TaskStage | null,
  level: "info" | "warning" = "info"
): Promise<void> {
  try {
    if (!getNotificationRouterStatus()) return;
    const read = await readTaskProgressStrictV1(vscode.Uri.file(taskFolderPath)).catch(() => undefined);
    const displayName = read && read.ok ? read.decoded.progress.displayName : undefined;
    const taskLabel = formatNotificationTaskLabelV1(displayName, taskFolderPath);
    const stageName = stage ? STAGE_DISPLAY_NAMES[stage] : undefined;
    if (level === "warning") {
      NotificationRouter.showWarning(`${taskLabel}${stageName ? ` (${stageName})` : ""} — ${text}`);
    } else {
      NotificationRouter.showInformation(`${taskLabel}${stageName ? ` (${stageName})` : ""} — ${text}`);
    }
  } catch {
    // Best effort.
  }
}
