/**
 * Filenames for task-local chat history. Kept in their own dependency-free
 * module so both VS-Code-API modules (chatHistoryStore.ts, commitAndPushTask.ts,
 * toggleMetaResourcesGitIgnore.ts) and the VS-Code-API-free contextEligibility.ts
 * can share one source of truth without contextEligibility.ts picking up a
 * vscode import.
 */

/** Task-local chat transcript file, stored inside the task folder. */
export const CHAT_HISTORY_FILENAME = "chat-v1.json";

/**
 * Quarantine copy of a `chat-v1.json` that failed to parse or validate.
 * Only the most recent quarantine is kept — a new corruption overwrites the
 * previous quarantine copy rather than accumulating.
 */
export const CHAT_HISTORY_CORRUPT_FILENAME = "chat-v1.corrupt.json";
