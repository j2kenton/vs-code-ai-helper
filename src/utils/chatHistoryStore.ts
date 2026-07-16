import * as vscode from "vscode";
import * as path from "path";
import { STAGE_ORDER, TaskStage } from "../types/taskProgress";
import { writeAtomic } from "../state/writeAtomic";
import { CHAT_HISTORY_FILENAME, CHAT_HISTORY_CORRUPT_FILENAME } from "./chatHistoryConstants";

export { CHAT_HISTORY_FILENAME, CHAT_HISTORY_CORRUPT_FILENAME };

/**
 * Task-local chat history persistence.
 *
 * PRODUCT DECISION — concurrency stance: writes to one task's transcript are
 * serialized only within a single extension-host window (see the per-task
 * queue in ChatViewProvider). Unlike task-progress.json, which goes through
 * `patchTaskProgress`'s cross-process lease for a real read-modify-write CAS
 * guarantee, this store does NOT take a lease. Two windows editing the same
 * task's chat concurrently is last-writer-wins and can lose a message. This
 * is a deliberate, weaker guarantee than task progress gets: chat loss is
 * low-stakes compared to progress corruption, and simultaneous multi-window
 * editing of one task's chat is not a supported workflow. If that changes,
 * the upgrade path is the same lease helper `patchTaskProgress` already
 * uses (see taskProgressUtils.ts / taskStateStore.ts's withTaskLock). Also
 * recorded in DISCLAIMER.md and tracked as backlog debt in
 * plans/2026-07-14_task_5/task.md.
 */

const CHAT_HISTORY_SCHEMA_VERSION = 1;
export const CHAT_HISTORY_MAX_MESSAGES = 200;

export interface ChatMessage {
  role: "user" | "assistant" | "question";
  text: string;
  stage: TaskStage;
  at: string;
  /** A question remains pending until the user sends a follow-up message. */
  pending?: boolean;
}

interface ChatHistoryFile {
  version: 1;
  messages: ChatMessage[];
}

const VALID_STAGES = new Set<string>(STAGE_ORDER);

function isChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    (v.role === "user" || v.role === "assistant" || v.role === "question") &&
    typeof v.text === "string" &&
    typeof v.stage === "string" &&
    VALID_STAGES.has(v.stage) &&
    typeof v.at === "string" &&
    (v.pending === undefined || typeof v.pending === "boolean")
  );
}

function isChatHistoryFile(value: unknown): value is ChatHistoryFile {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === CHAT_HISTORY_SCHEMA_VERSION &&
    Array.isArray(v.messages) &&
    v.messages.every(isChatMessage)
  );
}

let diagnosticsChannel: vscode.OutputChannel | undefined;
function getDiagnosticsChannel(): vscode.OutputChannel {
  if (!diagnosticsChannel) {
    diagnosticsChannel = vscode.window.createOutputChannel("Ensemble: Chat History");
  }
  return diagnosticsChannel;
}

function historyUri(taskFolderPath: string): vscode.Uri {
  return vscode.Uri.file(path.join(taskFolderPath, CHAT_HISTORY_FILENAME));
}

function corruptUri(taskFolderPath: string): vscode.Uri {
  return vscode.Uri.file(path.join(taskFolderPath, CHAT_HISTORY_CORRUPT_FILENAME));
}

/**
 * True only for "the file does not exist" — `vscode.workspace.fs.readFile`
 * rejects with a `FileSystemError` whose `.code` is `"FileNotFound"` for a
 * missing file; direct Node `fs` (used by test bridges, and by any future
 * caller that reads chat-v1.json outside the vscode.workspace.fs API) uses
 * `"ENOENT"` for the same condition. Any other code (permissions, a busy/
 * unavailable provider, etc.) is a real failure that must not be conflated
 * with "never chatted" — see readChatHistory's docstring.
 */
function isFileNotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "FileNotFound" || code === "ENOENT";
}

/**
 * True only for "the file does not exist" — any other `stat` failure
 * (permissions, a busy/unavailable provider, etc.) throws rather than
 * reporting "missing". `loadTranscriptWithMigration` treats "missing" as
 * license to serve (and possibly write) a fresh/legacy transcript, so
 * conflating a transient stat failure with "never chatted" would let the
 * next write overwrite an existing-but-momentarily-unstatable chat-v1.json
 * with a near-empty one — the same class of data loss `readChatHistory`'s
 * non-not-found handling exists to prevent.
 */
export async function chatHistoryFileExists(taskFolderPath: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(historyUri(taskFolderPath));
    return true;
  } catch (error) {
    if (isFileNotFoundError(error)) return false;
    throw new Error(`chat-v1.json could not be accessed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Preserve an unreadable chat-v1.json as chat-v1.corrupt.json (overwriting
 * any earlier quarantine — only the most recent is kept) and log one
 * diagnostic line, so the only copy of a possibly-recoverable transcript is
 * never silently discarded by the next message that would otherwise
 * overwrite it with an empty transcript.
 *
 * Returns whether the quarantine copy was actually written. The caller
 * (`readChatHistory`) MUST treat a `false` result as fatal rather than
 * degrading to an empty transcript: chat-v1.json itself is left untouched
 * either way, so the corrupt bytes are still on disk at that path — but if
 * the caller reports "empty" here, the next write (e.g. the next chat
 * message) will overwrite chat-v1.json with fresh content, permanently
 * losing the only copy of the unreadable transcript with no backup ever
 * having been made.
 */
async function quarantine(taskFolderPath: string, raw: string, reason: string): Promise<boolean> {
  let quarantined = true;
  try {
    await writeAtomic(corruptUri(taskFolderPath), raw);
  } catch {
    quarantined = false;
  }
  getDiagnosticsChannel().appendLine(
    `[${new Date().toISOString()}] "${path.basename(taskFolderPath)}": chat-v1.json was unreadable (${reason}) — ${
      quarantined
        ? `quarantined to ${CHAT_HISTORY_CORRUPT_FILENAME}.`
        : `FAILED to quarantine to ${CHAT_HISTORY_CORRUPT_FILENAME} as well; chat-v1.json left untouched.`
    }`
  );
  return quarantined;
}

/**
 * Read a task's chat transcript from chat-v1.json.
 *
 * A missing file, or a file whose schema version isn't recognized, degrades
 * to an empty transcript without throwing — the caller cannot distinguish
 * "never chatted" from "written by a future version" and both are safe to
 * treat as empty. A file that fails to parse as JSON, or parses but doesn't
 * match the expected document shape, is quarantined (see `quarantine`)
 * rather than silently discarded.
 *
 * A read failure for any other reason (permissions, a busy/unavailable
 * filesystem provider, etc.) — i.e. the file exists but couldn't actually be
 * read — throws rather than degrading to empty. Treating that as "empty"
 * would let the caller's next write (e.g. the next chat message) overwrite
 * chat-v1.json with a fresh, near-empty transcript, permanently discarding
 * the inaccessible-but-still-intact original with no backup ever made — the
 * same class of data loss `quarantine` exists to prevent for a corrupt file.
 *
 * If the quarantine copy itself cannot be written, this also throws instead
 * of returning an empty transcript, for the same reason. Callers already own
 * read/write-failure containment (see ChatViewProvider's per-task queue), so
 * this throw is expected to be caught there rather than crash anything.
 */
export async function readChatHistory(taskFolderPath: string): Promise<ChatMessage[]> {
  let raw: string;
  try {
    raw = new TextDecoder().decode(await vscode.workspace.fs.readFile(historyUri(taskFolderPath)));
  } catch (error) {
    if (isFileNotFoundError(error)) return [];
    throw new Error(`chat-v1.json could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const reason = `invalid JSON: ${error instanceof Error ? error.message : String(error)}`;
    if (!(await quarantine(taskFolderPath, raw, reason))) {
      throw new Error(`chat-v1.json is unreadable (${reason}) and could not be quarantined`);
    }
    return [];
  }

  if (!isChatHistoryFile(parsed)) {
    if (typeof (parsed as { version?: unknown })?.version === "number" && (parsed as { version: number }).version !== CHAT_HISTORY_SCHEMA_VERSION) {
      // Recognized envelope, unrecognized version — treat as empty, not corrupt.
      return [];
    }
    const reason = "unrecognized chat-history document shape";
    if (!(await quarantine(taskFolderPath, raw, reason))) {
      throw new Error(`chat-v1.json is unreadable (${reason}) and could not be quarantined`);
    }
    return [];
  }

  return parsed.messages.slice(-CHAT_HISTORY_MAX_MESSAGES);
}

/**
 * Write a task's chat transcript to chat-v1.json, capping at the most
 * recent CHAT_HISTORY_MAX_MESSAGES entries. Throws on failure — callers own
 * write-failure containment (see ChatViewProvider's per-task write queue);
 * this module has no opinion on how a caller serializes concurrent writes.
 */
export async function writeChatHistory(taskFolderPath: string, messages: ChatMessage[]): Promise<void> {
  const capped = messages.slice(-CHAT_HISTORY_MAX_MESSAGES);
  const document: ChatHistoryFile = { version: CHAT_HISTORY_SCHEMA_VERSION, messages: capped };
  await writeAtomic(historyUri(taskFolderPath), JSON.stringify(document, null, 2));
}

function legacyMementoKey(canonicalId: string): string {
  // Canonical IDs are workspace-local, but encoding keeps this Memento key
  // safe even for legacy IDs containing punctuation.
  return `ensemble.stageChat.transcript.${encodeURIComponent(canonicalId)}`;
}

/**
 * Load a task's transcript, lazily migrating a legacy workspace-state
 * (Memento) transcript into chat-v1.json the first time it's read for a task
 * that has no file yet. The legacy Memento key is deleted only after the
 * file write actually succeeds, so the file becomes authoritative without
 * ever risking the only copy of a transcript: a failed migration write
 * leaves the Memento key intact (and is retried on the next read), while a
 * successful write means deleting the file later cannot resurrect stale
 * workspace-state history.
 *
 * If chat-v1.json exists but cannot be `stat`-ed or read for a reason other
 * than not-found, this throws (via `chatHistoryFileExists`/`readChatHistory`)
 * rather than falling through to the legacy/empty path — otherwise a
 * transient stat failure would look like "never chatted" and license a
 * caller's next write to overwrite the real, still-intact transcript.
 */
export async function loadTranscriptWithMigration(
  taskFolderPath: string,
  canonicalId: string,
  memento: vscode.Memento
): Promise<ChatMessage[]> {
  if (await chatHistoryFileExists(taskFolderPath)) {
    return readChatHistory(taskFolderPath);
  }

  const legacyKey = legacyMementoKey(canonicalId);
  const legacy = memento.get<ChatMessage[]>(legacyKey, []);
  if (!Array.isArray(legacy) || legacy.length === 0) {
    return [];
  }

  const capped = legacy.slice(-CHAT_HISTORY_MAX_MESSAGES);
  try {
    await writeChatHistory(taskFolderPath, capped);
  } catch {
    // File write failed — leave the Memento key intact so migration retries
    // on a later read, but still serve the legacy entries this time so the
    // caller isn't left with nothing.
    return capped;
  }
  await memento.update(legacyKey, undefined);
  return capped;
}
