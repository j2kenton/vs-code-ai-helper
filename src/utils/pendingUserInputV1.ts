/**
 * Reads the durable, task-bound question state the watchdog and scheduling
 * posture need (bugs2 finding 1): which of a task's chat interactions are
 * still waiting for the user, and which hold a stored answer whose Resume has
 * not run. Reads through `readChatInteractions`, which already reconciles the
 * task-local mirror against the durable transaction store (including
 * transactions whose mirror record was never written), so a restart, another
 * window, or a freshly activated extension sees the same answer.
 *
 * A task that has never chatted (no `chat-v1.json`) has no question to wait
 * on. Any other read failure is reported as `unreadable`, never as "nothing
 * pending": the watchdog treats unreadable state conservatively.
 */
import { chatHistoryFileExists, readChatInteractions } from "./chatHistoryStore";
import { classifyPendingUserInputV1, PendingUserInputEvidenceV1 } from "./taskWatchdogV1";

type PendingUserInputReaderV1 = (
  taskFolderPath: string,
  canonicalId: string
) => Promise<PendingUserInputEvidenceV1>;

let readerOverrideForTestV1: PendingUserInputReaderV1 | undefined;

/**
 * Test seam: sweep tests use placeholder task folders that have no registered
 * ownership, which the real chat store (correctly) refuses to read. Restore by
 * passing `undefined`.
 */
export function setPendingUserInputReaderForTestV1(reader: PendingUserInputReaderV1 | undefined): void {
  readerOverrideForTestV1 = reader;
}

export async function readPendingUserInputEvidenceV1(
  taskFolderPath: string,
  canonicalId: string = taskFolderPath
): Promise<PendingUserInputEvidenceV1> {
  if (readerOverrideForTestV1) {
    return readerOverrideForTestV1(taskFolderPath, canonicalId);
  }
  try {
    if (!(await chatHistoryFileExists(taskFolderPath, canonicalId))) {
      return classifyPendingUserInputV1([]);
    }
    return classifyPendingUserInputV1(await readChatInteractions(taskFolderPath, canonicalId));
  } catch {
    return { state: "unreadable", unansweredQuestions: 0, submittedAwaitingResume: 0 };
  }
}
