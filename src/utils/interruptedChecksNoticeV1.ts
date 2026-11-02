/**
 * bugs5 Step 11: when activation finds a Publish Checks run whose process is gone (the extension host
 * restarted mid-run), say so in the task's chat, once, and offer the way back. Before this the run
 * died silently: the stage still looked active and nothing said the checks needed re-running.
 */
import * as path from "node:path";
import { appendChatMessageV1 } from "./chatHistoryStore";
import { offerInterruptedOperationRecoveryV1 } from "./operationNotificationBridge";
import type { TaskOperationSnapshot } from "./taskOperations";

export function formatRestartTimeV1(at: Date): string {
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

export function describeInterruptedChecksNoticeV1(at: Date): string {
  return `Publish Checks were interrupted (Ensemble restarted at ${formatRestartTimeV1(at)}) — run them again.`;
}

/** Run ids already announced in this window, so a repeated sweep does not post the line twice. */
const announcedRunIdsV1 = new Set<string>();

export async function announceInterruptedChecksRunV1(input: {
  readonly taskFolderPath: string;
  readonly taskName: string | undefined;
  /** The interrupted run's operation id; the notice is posted once per id. */
  readonly runId: string;
  readonly now?: () => Date;
}): Promise<boolean> {
  const key = `${input.taskFolderPath}::${input.runId}`;
  if (announcedRunIdsV1.has(key)) {
    return false;
  }
  announcedRunIdsV1.add(key);
  const now = (input.now ?? (() => new Date()))();
  try {
    await appendChatMessageV1(
      input.taskFolderPath,
      { role: "assistant", text: describeInterruptedChecksNoticeV1(now), stage: "publish", at: now.toISOString() },
      input.taskFolderPath
    );
  } catch (error) {
    console.warn("[interruptedChecksNotice] Could not post the interruption notice", error);
  }
  const snapshot: TaskOperationSnapshot = {
    id: input.runId,
    key: input.taskFolderPath,
    label: "Run Publish Checks",
    taskName: input.taskName ?? path.basename(input.taskFolderPath),
    startedAt: now.getTime(),
    finishedAt: now.getTime(),
    exclusive: true,
    cancellable: false,
    state: "interrupted",
    waitingForUser: false,
    stage: "publish",
  };
  await offerInterruptedOperationRecoveryV1(snapshot).catch((error) =>
    console.warn("[interruptedChecksNotice] Could not post the recovery card", error)
  );
  return true;
}
