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

/**
 * Verified pre-reset snapshot written under the private-storage
 * `chat-recovery/<document-id>/<reset-id>/` family before Reset Chat History
 * clears any unresolved interaction (plan §5.1).
 */
export const CHAT_RECOVERY_SNAPSHOT_FILENAME = "snapshot-v1.json";

/**
 * The Global Assistant's reserved conversation identity (its `canonicalId` in
 * every Chat With AI target and every chatHistoryStore call). Owned here, at
 * the utils layer, because chatHistoryStore.ts dispatches task-folder vs.
 * non-task-storage root registration on it — commands/openGeneralAssistant.ts
 * (which re-exports it) sits ABOVE this module in the dependency graph and
 * importing it from here would create a cycle through views/chatView.ts.
 *
 * This is the ONLY conversation identity whose folder is registered through
 * the non-task storage path (`ensureWorkflowNonTaskStorageRootV1`): the Global
 * Assistant's dedicated folder is not a task and carries no task-progress.json
 * ownership binding. Every other conversation is a task conversation and its
 * folder must satisfy the strict, ownership-backed task-folder root contract.
 */
export const GLOBAL_ASSISTANT_CANONICAL_ID = "global-assistant";
