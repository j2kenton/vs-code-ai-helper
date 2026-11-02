/**
 * bugs5 Step 11: when checkpoint recovery gives up because another window kept the state lock held,
 * say so in the current task's chat (one plain line) instead of only a Notifications warning.
 */
import { appendChatMessageV1 } from "./chatHistoryStore";

export const STATE_LOCK_GIVE_UP_CHAT_TEXT_V1 =
  "Ensemble could not finish checking for work interrupted by the last restart, because another Ensemble window kept the task state locked. Reload this window to try again.";

/** Returns true when the line reached a task chat; false means the caller should fall back to a warning. */
export async function postStateLockGiveUpNoticeV1(input: {
  readonly taskFolderPath: string | undefined;
  readonly canonicalId?: string;
  readonly now?: () => Date;
}): Promise<boolean> {
  if (!input.taskFolderPath) {
    return false;
  }
  try {
    await appendChatMessageV1(
      input.taskFolderPath,
      { role: "assistant", text: STATE_LOCK_GIVE_UP_CHAT_TEXT_V1, stage: "desc", at: (input.now ?? ((): Date => new Date()))().toISOString() },
      input.canonicalId ?? input.taskFolderPath
    );
    return true;
  } catch (error) {
    console.warn("[stateLockGiveUpNotice] Could not post to the task chat", error);
    return false;
  }
}
