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
 * The Global Assistant's reserved conversation identity. Its command surface
 * (Open AI Assistant, Send) was retired during the Cleanup cohort's
 * disposition of supplementary legacy AI routes (see
 * legacyAiActionSafetyGateV0.ts's file header) and no longer exists, but this
 * identity remains owned here, at the utils layer, because chatHistoryStore.ts
 * still dispatches task-folder vs. non-task-storage root registration on it
 * for the dedicated folder's historical/direct-storage-API test coverage.
 *
 * This is the ONLY conversation identity whose folder is registered through
 * the non-task storage path (`ensureWorkflowNonTaskStorageRootV1`): its
 * dedicated folder is not a task and carries no task-progress.json ownership
 * binding. Every other conversation is a task conversation and its folder
 * must satisfy the strict, ownership-backed task-folder root contract.
 */
export const GLOBAL_ASSISTANT_CANONICAL_ID = "global-assistant";
