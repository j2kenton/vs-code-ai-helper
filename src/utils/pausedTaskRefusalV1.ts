import * as path from "node:path";
import * as vscode from "vscode";
import { describeAutomationDefaultV1, hasAutomaticOriginV1 } from "../state/automationDispatchContextV1";
import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import { NotificationRouter } from "./notificationRouter";
import { formatNotificationTaskLabelV1 } from "./notificationTaskContextV1";
import { offerActionInChatV1 } from "./chatActionOfferV1";

/**
 * A stage action refused because the task is paused.
 *
 * RC9 item 3 replaces the RC1 item 11 (warning) and RC7 item 4 ("Resume" as a
 * "Decision needed" card holding the task paused) behaviour:
 *  - an AUTOMATIC dispatch (automation chain, scheduler timer, Fast Forward)
 *    that is refused is only logged — the pause that caused it already has its
 *    own card, and a second card added nothing;
 *  - the owner's own click gets an informational notice that names the task by
 *    its display name, with Resume as an optional chat offer (it holds
 *    nothing and blocks nothing).
 *
 * `action` completes the sentence "Resume it before …" (e.g. "running a
 * review"). This check fires before any tracked-operation context exists, so
 * the task's name is named here explicitly rather than relying on the
 * router's ambient attribution.
 */
export async function showPausedTaskRefusalV1(
  action: string,
  taskFolderPath: string,
  displayName?: string,
  options?: { automatic?: boolean }
): Promise<void> {
  if (options?.automatic === true || hasAutomaticOriginV1()) {
    const label = formatNotificationTaskLabelV1(displayName, taskFolderPath);
    console.log(describeAutomationDefaultV1(`${label} is paused, so an automatic request for ${action} was refused`, "logged only"));
    return;
  }
  let resolvedName = displayName;
  if (resolvedName === undefined) {
    const read = await readTaskProgressStrictV1(vscode.Uri.file(taskFolderPath), {
      expectedTaskFolder: path.basename(taskFolderPath),
    });
    resolvedName = read.ok ? read.decoded.progress.displayName : undefined;
  }
  const taskLabel = formatNotificationTaskLabelV1(resolvedName, taskFolderPath);
  const message = `${taskLabel} is paused. Resume it before ${action}.`;
  const pointer = await offerActionInChatV1({
    taskFolderPath,
    taskLabel,
    actionLabel: "Resume",
    command: "vs-code-ai-helper.resumeTask",
    args: [{ taskFolderPath }],
    noticeText: message,
    optional: true,
  });
  NotificationRouter.showInformation(`${taskLabel} is paused. Resume it before ${action}.`, undefined, undefined, undefined, pointer);
}
