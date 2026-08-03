import * as vscode from "vscode";
import * as path from "path";
import { createHash, randomBytes } from "crypto";
import { STAGE_ORDER, TaskStage } from "../types/taskProgress";
import {
  CHAT_HISTORY_FILENAME,
  CHAT_HISTORY_CORRUPT_FILENAME,
  GLOBAL_ASSISTANT_CANONICAL_ID,
} from "./chatHistoryConstants";
import {
  ensureWorkflowNonTaskStorageRootV1,
  ensureWorkflowTaskFolderRootV1,
  getChatInteractionTransactionStoreV1,
  getVerifiedTaskBindingIdV1,
  getWorkflowFileStoreV1,
  getWorkflowPathRegistryV1,
  getWorkflowPrivateStorageRootIdV1,
} from "../services/workflowRuntimeServicesV1";
import { WorkflowFileLocatorV1 } from "../services/workflowFileStoreV1";
import { ChatInteractionTransactionV1 } from "../types/chatInteractionTransactionV1";
import {
  decodeStructuredAnswersArrayV1,
  decodeStructuredQuestionsV1,
  StructuredAnswerV1,
  StructuredQuestionV1,
} from "../types/structuredQuestionV1";

export { CHAT_HISTORY_FILENAME, CHAT_HISTORY_CORRUPT_FILENAME };
export { GLOBAL_ASSISTANT_CANONICAL_ID };

/**
 * Task-local chat history persistence (plan §5.1-§5.3).
 *
 * PATH/STORAGE BOUNDARY — every locator this module touches is vended by the
 * extension host's SINGLE shared `WorkflowPathRegistryV1` (plan §2.1), held
 * by `workflowRuntimeServicesV1.ts`: `<task-folder>/chat-v1.json` is a
 * registered family, and roots are registered once and idempotently through
 * ONE dispatch point (`ensureConversationChatRootV1`): a TASK conversation's
 * folder goes through the strict, ownership-backed
 * `ensureWorkflowTaskFolderRootV1` — mutation authority derives from the
 * folder's validated persisted `ownership` + `taskFolder` binding (plan
 * §3.9), and missing progress, missing ownership, an underivable binding, a
 * dead workspace owner, or an uncontained location REFUSES the operation —
 * while the Global Assistant's dedicated folder (the reserved
 * `GLOBAL_ASSISTANT_CANONICAL_ID` conversation, not a task) goes through
 * the separate `ensureWorkflowNonTaskStorageRootV1`. Every filesystem
 * operation goes through the shared `WorkflowFileStoreV1`'s exact §1.8
 * surface (exclusive-create, revision-guarded replace, bounded reads,
 * exact-file unlink). This module holds NO path authority of its own — the
 * earlier module-local registry that trusted every caller-supplied folder is
 * gone.
 *
 * DOCUMENT SHAPE (plan §5.1) — the persisted file carries a path-independent
 * `documentId`, a `taskBindingId` plus its provenance (`taskBindingSource`:
 * `"ownershipDerived"` — EVERY task conversation's default: a real digest of
 * the task folder's persisted `ownership` + `taskFolder` binding (see
 * workflowRuntimeServicesV1.ts's strict `ensureWorkflowTaskFolderRootV1`,
 * which refuses ownership-free folders outright, and
 * `getVerifiedTaskBindingIdV1`), never a path/id stand-in; `"localDigest"`
 * — the path/canonicalId stand-in used ONLY for the Global Assistant's
 * dedicated non-task folder, the one conversation with no ownership to
 * derive from; `"coordinatorSupplied"` once any caller posts an interaction
 * with an explicit, action-coordinator-derived binding — adopted on first
 * contact, fail-closed on any later conflict against an
 * already-authoritative (`coordinatorSupplied` or `ownershipDerived`)
 * document, and validated against the folder's own freshly derived
 * ownership binding before every post), the bounded
 * display transcript, any unresolved/settled structured-question interactions
 * (`ChatDocumentInteractionV1`, each carrying the source operation/attempt/
 * interaction references), an optional non-destructive migration marker, a
 * reset epoch, and compaction bookkeeping.

 *
 * LIMITS AND COMPACTION — a message over `CHAT_HISTORY_MAX_MESSAGE_BYTES`
 * (64 KiB canonical) is refused on write and quarantined as unreadable on
 * read (never silently truncated — a truncated AI response or question could
 * mislead the user). The whole document is bounded at
 * `CHAT_HISTORY_MAX_FILE_BYTES` (4 MiB canonical) and at
 * `CHAT_HISTORY_MAX_MESSAGES` (200) settled messages; EVERY write — message
 * appends AND interaction posts/settlements/answers/resets — passes the
 * whole-document byte check inside `persistDocument`, so interaction writes
 * cannot bypass the 4 MiB cap. Compaction drops the OLDEST settled messages
 * first and protects EVERY unsettled (pending) message — not only the
 * trailing one — plus every structured interaction. If compaction alone
 * cannot fit the mandatory (non-compactable) content under the byte limit,
 * the write is refused with `ChatHistoryRecoveryErrorV1`
 * (`chatRecoveryRequired`) rather than silently dropping something
 * recovery-critical.
 *
 * UNKNOWN VERSIONS — a chat-v1.json whose envelope is recognized but whose
 * schema version is not this module's own fails CLOSED into recovery: the
 * file is quarantined to chat-v1.corrupt.json for evidence and reads throw
 * `ChatHistoryRecoveryErrorV1`. It is never treated as an empty transcript
 * (a subsequent write would silently destroy the unknown content).
 *
 * MIGRATION — the legacy workspace-state (Memento) transcript is migrated
 * into chat-v1.json the first time a task with no chat-v1.json yet is read
 * (`loadTranscriptWithMigration`), under the plan §5.3 protocol: exact-prefix
 * key enumeration with a canonical round-trip of the encoded suffix, STRICT
 * §5.2 DTO decoding (settled user/assistant records import as display
 * messages; a pending assistant imports as a read-only `legacyPendingAssistant`
 * recovery record; a `question` role imports as a read-only `legacyQuestion`
 * recovery record; an unknown role, a pending user, a non-boolean `pending`,
 * invalid/oversized text, an invalid stage, or a missing/invalid timestamp
 * is WHOLE-TRANSCRIPT recovery — nothing is imported and the Memento value
 * is left untouched), source-key and source-value digests recorded in the
 * migration marker, a pre-commit re-read/re-digest (a value that changed
 * mid-migration aborts the commit), and one atomic exclusive-create commit.
 * The Memento value is left UNCHANGED either way (plan §5.3 step 8 /
 * AC-CHAT-MIGRATE-03) — this module never deletes it.
 *
 * RESET — `resetChatHistoryV1` clears every unresolved interaction (settling
 * each as `resetByChatRecovery`, never invoking a provider) and bumps
 * `resetEpoch`, but only after writing a verified snapshot of the pre-reset
 * document to the REGISTERED PRIVATE-STORAGE recovery family
 * (`chat-recovery/<document-id>/<reset-id>/snapshot-v1.json`, plan §2.1).
 * The earlier task-folder snapshot fallback is gone: a snapshot inside the
 * task folder could escape Chat-private handling (neither the privacy
 * classifier nor Commit/Push's sensitive-basename gate covered that name),
 * so reset now REFUSES — leaving chat-v1.json untouched — when the
 * private-storage root is not configured (`workflowStorageUnavailable`); the
 * NO-DOCUMENT case (nothing has ever been committed yet — see below) applies
 * this exact same storage-availability gate for consistency, even though
 * there is no prior document content to snapshot. Counterpart durable
 * transactions (when the activation-wired transaction store is present) are
 * settled as `resetByChatRecovery` alongside the display mirror; an
 * interaction whose durable counterpart FAILS to settle is left `unresolved`
 * in the mirror rather than falsely marked `resetByChatRecovery` — the
 * display must never claim an interaction is resolved when its durable
 * record is not, and leaving it `unresolved` lets normal reconciliation
 * (below) keep retrying it on a later read.
 *
 * RECONCILIATION (AC-CHAT-TX-03) — `readChatInteractions` reconciles every
 * unresolved display-mirror interaction against the durable transaction
 * store (when wired): a settled transaction downgrades the mirror to the
 * same settlement, and a missing or undecodable transaction downgrades it to
 * the read-only, non-resumable `missingTransaction` state. The durable
 * transaction's own `answers` (present from `answersDraft` onward) are also
 * backfilled into the mirror whenever they differ — Chat Send's "durable
 * store first, mirror second" write order (see chatView.ts's
 * `doSubmitInteractionAnswers`) means a crash between those two writes would
 * otherwise leave the mirror showing a blank, already-submitted question
 * again. Downgrades and backfills are persisted best-effort; either way the
 * caller's returned view always reflects them.
 *
 * CONCURRENCY — as before (see the historical note preserved in
 * DISCLAIMER.md and plans/2026-07-14_task_5/task.md): writes to one task's
 * transcript are serialized only within this extension-host window (the
 * per-task queue in ChatViewProvider), not by a cross-process lease. This
 * remains a deliberate, weaker guarantee than task-progress.json's
 * `patchTaskProgress` lease.
 */

const CHAT_HISTORY_SCHEMA_VERSION = 1;
export const CHAT_HISTORY_MAX_MESSAGES = 200;
export const CHAT_HISTORY_MAX_FILE_BYTES = 4 * 1024 * 1024;
export const CHAT_HISTORY_MAX_MESSAGE_BYTES = 64 * 1024;

/**
 * The fail-closed recovery condition (plan §5.1/§3.7's `chatRecoveryRequired`):
 * an unknown schema version, an unmigratable legacy transcript, or mandatory
 * Chat content that cannot fit the document limits. The message is prefixed
 * with the stable code so callers can match it without importing the class.
 */
export class ChatHistoryRecoveryErrorV1 extends Error {
  readonly code = "chatRecoveryRequired" as const;
  constructor(message: string) {
    super(`chatRecoveryRequired: ${message}`);
    this.name = "ChatHistoryRecoveryErrorV1";
  }
}

export interface ChatMessage {
  role: "user" | "assistant" | "question";
  text: string;
  /**
   * The message's stage snapshot. `null` is legal ONLY on a migrated legacy
   * recovery record whose source had no stage (plan §5.2's "Missing stage →
   * snapshot null"); a null-stage message appears only in unfiltered reads,
   * never in a stage-isolated view.
   */
  stage: TaskStage | null;
  at: string;
  /** A question remains pending until the user sends a follow-up message. */
  pending?: boolean;
  /**
   * Present only on records imported from the legacy Memento DTO that plan
   * §5.2 maps to READ-ONLY recovery records: they render their text but can
   * never carry controls or Resume a provider.
   */
  legacyRecovery?: "legacyPendingAssistant" | "legacyQuestion";
}

/** The display-mirror states a structured-question interaction can be in (plan §5.1/§5.5). */
export type ChatDocumentInteractionStateV1 =
  | "unresolved"
  | "resumed"
  | "cancelled"
  | "expired"
  | "supersededByReplacementOperation"
  | "resetByChatRecovery"
  /**
   * AC-CHAT-TX-03: the mirror record exists but its durable transaction is
   * missing or undecodable — rendered read-only and non-resumable.
   */
  | "missingTransaction"
  /**
   * AC-CHAT-TX-03's other direction: a durable transaction exists (and is
   * not yet settled) but this task-local Chat document has no mirror
   * interaction naming it — e.g. a crash between the transaction's `begin()`
   * and the mirror's `appendChatInteraction()` call. Synthesized by
   * `readChatInteractions`, never persisted by `appendChatInteraction`
   * itself; rendered read-only and non-resumable exactly like
   * `missingTransaction`.
   */
  | "orphanedTransaction";

/** One structured-question interaction as mirrored into task-local Chat for display (plan §5.1/§5.5). */
export interface ChatDocumentInteractionV1 {
  readonly interactionId: string;
  readonly operationId: string;
  readonly actionKey: string;
  /**
   * The question-time source attempt reference (plan §5.1). Optional only
   * because documents written before this field existed remain readable —
   * every NEW interaction requires it (see `NewChatDocumentInteractionV1`).
   */
  readonly sourceAttemptId?: string;
  /** Stage-scoped like display messages — a stage's Chat never shows another stage's interaction. */
  readonly stage: TaskStage;
  readonly questions: readonly StructuredQuestionV1[];
  readonly state: ChatDocumentInteractionStateV1;
  readonly answers?: readonly StructuredAnswerV1[];
  readonly postedAt: string;
}

/** The input a caller posts a new unresolved interaction with (plan §5.1/§6.1). */
export interface NewChatDocumentInteractionV1 {
  readonly interactionId: string;
  readonly operationId: string;
  readonly actionKey: string;
  /** Required: the question-time source attempt that produced the questions. */
  readonly sourceAttemptId: string;
  readonly stage: TaskStage;
  readonly questions: readonly StructuredQuestionV1[];
  readonly postedAt: string;
  /**
   * The operation's authoritative binding (plan §3.1 / AC-ID-03). REQUIRED:
   * posting a structured-question interaction must always carry the
   * coordinator's ownership-derived `taskBindingId` plus this document's id
   * — never fall back to a bare path/canonicalId stand-in the way a plain
   * message append may. For a NEW document the supplied `chatDocumentId`
   * becomes the document's id (so the correlation and the document agree by
   * construction); for an existing document it must match exactly. The
   * first supplied `taskBindingId` is adopted as the document's authoritative
   * binding; any later conflicting one fails closed.
   */
  readonly binding: {
    readonly taskBindingId: string;
    readonly chatDocumentId: string;
  };
}

/** Provenance of the document's stored `taskBindingId` (see the module header). */
export type ChatTaskBindingSourceV1 = "localDigest" | "ownershipDerived" | "coordinatorSupplied";

interface ChatMigrationMarkerV1 {
  /** SHA-256 over the canonical JSON of the legacy Memento VALUE (plan §5.3). */
  readonly legacyValueSha256: string;
  /** SHA-256 over the exact legacy Memento KEY the value was read from (plan §5.3). */
  readonly legacyKeySha256?: string;
  readonly migratedAt: string;
}

interface ChatCompactionStateV1 {
  readonly compactedMessageCount: number;
  /** SHA-256 over the compacted-away messages' canonical JSON, for audit — never their content. */
  readonly lastCompactionDigest?: string;
}

interface ChatDocumentV1 {
  readonly schemaVersion: 1;
  readonly documentId: string;
  readonly taskBindingId: string;
  readonly taskBindingSource: ChatTaskBindingSourceV1;
  readonly messages: ChatMessage[];
  readonly interactions: ChatDocumentInteractionV1[];
  readonly migration?: ChatMigrationMarkerV1;
  readonly resetEpoch: number;
  readonly compaction: ChatCompactionStateV1;
}


const VALID_STAGES = new Set<string>(STAGE_ORDER);
const HEX128_RE = /^[0-9a-f]{32}$/;

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function newDocumentId(): string {
  return randomBytes(16).toString("hex");
}

function newResetId(): string {
  return randomBytes(16).toString("hex");
}

/**
 * True only for the Global Assistant's reserved conversation identity — the
 * ONE conversation whose folder is dedicated non-task storage rather than a
 * task folder. Every other conversation is a task conversation whose folder
 * must satisfy the strict, ownership-backed task-folder root contract.
 */
function isGlobalAssistantConversationV1(canonicalId: string): boolean {
  return canonicalId === GLOBAL_ASSISTANT_CANONICAL_ID;
}

/**
 * The single registration dispatch point for every Chat storage operation
 * (the implementation review's "separate the Global Assistant's non-task
 * storage registration from task-folder registration" contract): the Global
 * Assistant's dedicated folder registers through
 * `ensureWorkflowNonTaskStorageRootV1` (shape+containment trust, no task
 * progress exists to derive ownership from); EVERY task conversation
 * registers through the strict `ensureWorkflowTaskFolderRootV1`, whose
 * mutation authority derives from the folder's validated persisted
 * `ownership` + `taskFolder` binding (plan §3.9) — a task folder with
 * missing progress, missing ownership, an underivable binding, a dead
 * workspace owner, an uncontained location, or (when supplied) a mismatched
 * caller binding is refused outright.
 */
function ensureConversationChatRootV1(
  taskFolderPath: string,
  canonicalId: string,
  expectedBindingId?: string
): string {
  if (isGlobalAssistantConversationV1(canonicalId)) {
    return ensureWorkflowNonTaskStorageRootV1(taskFolderPath);
  }
  return ensureWorkflowTaskFolderRootV1(
    taskFolderPath,
    expectedBindingId !== undefined ? { bindingId: expectedBindingId } : undefined
  );
}

/**
 * The LOCAL binding stand-in: a digest of the canonical conversation id,
 * used ONLY for the Global Assistant's dedicated non-task folder (the one
 * conversation with no ownership to derive a real binding from — see
 * `resolveDefaultTaskBindingV1`). An explicit `coordinatorSupplied` binding
 * always takes precedence (see `taskBindingSource`).
 *
 * Exported so `globalAssistantSend.v1` (openGeneralAssistant.ts) can derive
 * the SAME id to pass as the coordinator's `taskBinding.taskBindingId` —
 * there must be exactly one formula for the Global Assistant's binding, not
 * a second one recomputed at the call site.
 */
export function localTaskBindingId(canonicalId: string): string {
  return sha256Hex(`chat-task-binding:${canonicalId}`);
}

/**
 * The default task binding for a NEW document (or one being upgraded from a
 * pre-binding shape), before any explicit `coordinatorSupplied` binding is
 * considered. A TASK conversation always resolves to the folder's own
 * ownership-derived binding (plan §3.9 — a real digest of this task's
 * persisted `ownership` + `taskFolder`, backed by
 * workflowRuntimeServicesV1.ts's strict registration contract): the strict
 * task-folder root registration guarantees one exists, so a missing
 * verified binding here is an invariant violation, not a fallback case.
 * Only the Global Assistant's dedicated non-task folder falls back to
 * `localTaskBindingId` — it is not a task and has no ownership to derive
 * from. The caller must have already resolved this folder's root id (every
 * call site does, via `historyLocator`/`ensureConversationChatRootV1`,
 * earlier in the same operation) — resolving it again here is idempotent
 * and cheap.
 */
function resolveDefaultTaskBindingV1(
  taskFolderPath: string,
  canonicalId: string
): { taskBindingId: string; taskBindingSource: ChatTaskBindingSourceV1 } {
  if (isGlobalAssistantConversationV1(canonicalId)) {
    // Registration side-effect matters (the locator resolves against it);
    // the non-task root carries no ownership binding to read back.
    ensureWorkflowNonTaskStorageRootV1(taskFolderPath);
    return { taskBindingId: localTaskBindingId(canonicalId), taskBindingSource: "localDigest" };
  }
  const rootId = ensureWorkflowTaskFolderRootV1(taskFolderPath);
  const verifiedBindingId = getVerifiedTaskBindingIdV1(rootId);
  if (verifiedBindingId === undefined) {
    throw new Error(
      "invariant violation: a strictly registered task-folder root has no ownership-derived binding"
    );
  }
  return { taskBindingId: verifiedBindingId, taskBindingSource: "ownershipDerived" };
}

/**
 * Resolve a conversation folder's chat-v1.json locator through the ONE
 * shared registry — registering the folder as a validated, trusted root
 * first when it has never been seen (idempotently), through the strict
 * task-folder path or the non-task storage path per
 * `ensureConversationChatRootV1`. The locator must be resolved BEFORE
 * `getWorkflowFileStoreV1()` is evaluated at every call site: for a
 * never-before-seen folder, resolving the locator is what registers its
 * root and rebuilds the shared file store — evaluating the store getter
 * first would capture the STALE store instance that doesn't know the new
 * root yet.
 */
function historyLocator(taskFolderPath: string, canonicalId: string): WorkflowFileLocatorV1 {
  const rootId = ensureConversationChatRootV1(taskFolderPath, canonicalId);
  return getWorkflowPathRegistryV1().taskChatFile(rootId).locator;
}

/** Not a registered §2.1 family (an internal quarantine artifact); a raw
 * sibling locator under the same already-registered, already-trusted root. */
function corruptLocator(taskFolderPath: string, canonicalId: string): WorkflowFileLocatorV1 {
  return {
    rootId: ensureConversationChatRootV1(taskFolderPath, canonicalId),
    relativePath: CHAT_HISTORY_CORRUPT_FILENAME,
  };
}

function describeStoreFailure(result: { readonly kind: string; readonly code?: string; readonly errno?: string }): string {
  if (result.kind === "unavailable") {
    return `workflow root unavailable (${result.code})`;
  }
  return `${result.code ?? "unknown"}${result.errno ? ` (${result.errno})` : ""}`;
}

let diagnosticsChannel: vscode.OutputChannel | undefined;
function getDiagnosticsChannel(): vscode.OutputChannel {
  if (!diagnosticsChannel) {
    diagnosticsChannel = vscode.window.createOutputChannel("Ensemble: Chat History");
  }
  return diagnosticsChannel;
}

/**
 * Test isolation: drop the cached diagnostics channel so the next quarantine
 * re-resolves `vscode.window.createOutputChannel` — otherwise a test's own
 * stubbed channel is silently ignored once any earlier test in the same
 * process has already triggered the cache. Production never calls this.
 */
export function resetChatHistoryDiagnosticsChannelForTestV1(): void {
  diagnosticsChannel = undefined;
}

/**
 * True only for "the file does not exist." Any other failure (permissions,
 * an unsupported/unsafe root, a directory where a file was expected, etc.)
 * is a real failure that must not be conflated with "never chatted."
 */
export async function chatHistoryFileExists(
  taskFolderPath: string,
  canonicalId = taskFolderPath
): Promise<boolean> {
  const locator = historyLocator(taskFolderPath, canonicalId);
  const stat = await getWorkflowFileStoreV1().stat(locator);
  if (stat.kind === "ok") {
    if (stat.value.kind === "missing") return false;
    if (stat.value.kind === "file") return true;
    throw new Error("chat-v1.json could not be accessed: a directory exists at that path");
  }
  throw new Error(`chat-v1.json could not be accessed: ${describeStoreFailure(stat)}`);
}

/**
 * Preserve an unreadable chat-v1.json as chat-v1.corrupt.json (overwriting
 * any earlier quarantine) and log one diagnostic line. Returns whether the
 * quarantine copy was actually written — the caller MUST treat `false` as
 * fatal (see readChatHistory), since the corrupt bytes are still on disk
 * either way but an unquarantined loss would let the next write silently
 * overwrite them.
 */
async function quarantine(
  taskFolderPath: string,
  raw: Buffer,
  reason: string,
  canonicalId: string
): Promise<boolean> {
  let quarantined = true;
  try {
    const locator = corruptLocator(taskFolderPath, canonicalId);
    const fileStore = getWorkflowFileStoreV1();
    const stat = await fileStore.stat(locator);
    if (stat.kind === "ok" && stat.value.kind === "file" && stat.value.revision !== undefined) {
      const replaced = await fileStore.replaceFileExact(locator, raw, stat.value.revision);
      quarantined = replaced.kind === "ok";
    } else {
      const created = await fileStore.createFileExclusive(locator, raw);
      quarantined = created.kind === "ok";
    }
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


// ---------------------------------------------------------------------------
// Document decode/encode
// ---------------------------------------------------------------------------

const INTERACTION_STATES = new Set<string>([
  "unresolved",
  "resumed",
  "cancelled",
  "expired",
  "supersededByReplacementOperation",
  "resetByChatRecovery",
  "missingTransaction",
  "orphanedTransaction",
]);

function validateMessages(raw: unknown): ChatMessage[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const messages: ChatMessage[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const e = entry as Record<string, unknown>;
    if (e.role !== "user" && e.role !== "assistant" && e.role !== "question") return undefined;
    if (typeof e.text !== "string" || Buffer.byteLength(e.text, "utf8") > CHAT_HISTORY_MAX_MESSAGE_BYTES) {
      return undefined;
    }
    if (typeof e.at !== "string" || Number.isNaN(Date.parse(e.at))) return undefined;
    if (e.pending !== undefined && typeof e.pending !== "boolean") return undefined;
    if (
      e.legacyRecovery !== undefined &&
      e.legacyRecovery !== "legacyPendingAssistant" &&
      e.legacyRecovery !== "legacyQuestion"
    ) {
      return undefined;
    }
    if (e.stage === null || e.stage === undefined) {
      // A null stage snapshot is legal only on a migrated legacy recovery
      // record (plan §5.2's "Missing stage → snapshot null").
      if (e.legacyRecovery === undefined) return undefined;
    } else if (typeof e.stage !== "string" || !VALID_STAGES.has(e.stage)) {
      return undefined;
    }
    messages.push({
      role: e.role,
      text: e.text,
      stage: (e.stage ?? null) as TaskStage | null,
      at: e.at,
      ...(e.pending !== undefined ? { pending: e.pending } : {}),
      ...(e.legacyRecovery !== undefined
        ? { legacyRecovery: e.legacyRecovery as "legacyPendingAssistant" | "legacyQuestion" }
        : {}),
    });
  }
  return messages;
}

function validateInteractions(raw: unknown): ChatDocumentInteractionV1[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const interactions: ChatDocumentInteractionV1[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const e = entry as Record<string, unknown>;
    if (typeof e.interactionId !== "string" || !HEX128_RE.test(e.interactionId)) return undefined;
    if (typeof e.operationId !== "string" || !HEX128_RE.test(e.operationId)) return undefined;
    if (typeof e.actionKey !== "string" || e.actionKey.length === 0) return undefined;
    if (e.sourceAttemptId !== undefined && (typeof e.sourceAttemptId !== "string" || !HEX128_RE.test(e.sourceAttemptId))) {
      return undefined;
    }
    if (typeof e.stage !== "string" || !VALID_STAGES.has(e.stage)) return undefined;
    const decodedQuestions = decodeStructuredQuestionsV1(e.questions);
    if (!decodedQuestions.ok || !decodedQuestions.questions) return undefined;
    if (typeof e.postedAt !== "string") return undefined;
    if (typeof e.state !== "string" || !INTERACTION_STATES.has(e.state)) return undefined;
    let answers: readonly StructuredAnswerV1[] | undefined;
    if (e.answers !== undefined) {
      const decodedAnswers = decodeStructuredAnswersArrayV1(e.answers);
      if (!decodedAnswers.ok) return undefined;
      answers = decodedAnswers.answers;
    }
    interactions.push({
      interactionId: e.interactionId,
      operationId: e.operationId,
      actionKey: e.actionKey,
      ...(e.sourceAttemptId !== undefined ? { sourceAttemptId: e.sourceAttemptId } : {}),
      stage: e.stage as TaskStage,
      questions: decodedQuestions.questions,
      state: e.state as ChatDocumentInteractionStateV1,
      ...(answers !== undefined ? { answers } : {}),
      postedAt: e.postedAt,
    });
  }
  return interactions;
}


function decodeChatDocument(raw: unknown, taskFolderPath: string, canonicalId: string): ChatDocumentV1 | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion === undefined) {
    // The reduced legacy shape ({version: 1, messages}) upgrades in place.
    if (record.version === CHAT_HISTORY_SCHEMA_VERSION) {
      const legacyMessages = validateMessages(record.messages);
      if (!legacyMessages) return undefined;
      const defaultBinding = resolveDefaultTaskBindingV1(taskFolderPath, canonicalId);
      return {
        schemaVersion: 1,
        documentId: newDocumentId(),
        taskBindingId: defaultBinding.taskBindingId,
        taskBindingSource: defaultBinding.taskBindingSource,
        messages: legacyMessages,
        interactions: [],
        resetEpoch: 0,
        compaction: { compactedMessageCount: 0 },
      };
    }
    return undefined;
  }
  if (record.schemaVersion !== CHAT_HISTORY_SCHEMA_VERSION) return undefined;
  if (typeof record.documentId !== "string" || record.documentId.length === 0) return undefined;
  if (typeof record.taskBindingId !== "string" || record.taskBindingId.length === 0) return undefined;
  if (
    record.taskBindingSource !== undefined &&
    record.taskBindingSource !== "localDigest" &&
    record.taskBindingSource !== "ownershipDerived" &&
    record.taskBindingSource !== "coordinatorSupplied"
  ) {
    return undefined;
  }
  const messages = validateMessages(record.messages);
  if (!messages) return undefined;
  const interactions = validateInteractions(record.interactions);
  if (!interactions) return undefined;
  if (typeof record.resetEpoch !== "number" || !Number.isInteger(record.resetEpoch) || record.resetEpoch < 0) {
    return undefined;
  }
  const compactionRaw = record.compaction as Record<string, unknown> | undefined;
  if (typeof compactionRaw?.compactedMessageCount !== "number") return undefined;
  const migrationRaw = record.migration as Record<string, unknown> | undefined;
  if (migrationRaw !== undefined) {
    if (typeof migrationRaw.legacyValueSha256 !== "string" || typeof migrationRaw.migratedAt !== "string") {
      return undefined;
    }
    if (migrationRaw.legacyKeySha256 !== undefined && typeof migrationRaw.legacyKeySha256 !== "string") {
      return undefined;
    }
  }
  return {
    schemaVersion: 1,
    documentId: record.documentId,
    taskBindingId: record.taskBindingId,
    taskBindingSource: (record.taskBindingSource as ChatTaskBindingSourceV1 | undefined) ?? "localDigest",
    messages,
    interactions,
    ...(migrationRaw !== undefined
      ? {
          migration: {
            legacyValueSha256: migrationRaw.legacyValueSha256 as string,
            ...(typeof migrationRaw.legacyKeySha256 === "string"
              ? { legacyKeySha256: migrationRaw.legacyKeySha256 }
              : {}),
            migratedAt: migrationRaw.migratedAt as string,
          },
        }
      : {}),
    resetEpoch: record.resetEpoch,
    compaction: {
      compactedMessageCount: compactionRaw.compactedMessageCount,
      ...(typeof compactionRaw.lastCompactionDigest === "string"
        ? { lastCompactionDigest: compactionRaw.lastCompactionDigest }
        : {}),
    },
  };
}

function encodeChatDocument(document: ChatDocumentV1): Buffer {
  return Buffer.from(JSON.stringify(document, null, 2), "utf8");
}

interface ReadDocumentResultV1 {
  readonly document: ChatDocumentV1 | undefined;
  /** Present exactly when the file exists and decoded. */
  readonly revision?: string;
}


/**
 * Load the raw document (messages, interactions, migration marker, and all)
 * for a task, or `undefined` if none exists yet. Mirrors readChatHistory's
 * not-found/quarantine/throw rules but returns the whole document rather
 * than only the display transcript, so migration and interaction callers can
 * see the full shape without a second read. A recognized envelope with an
 * UNKNOWN schema version quarantines the file and throws
 * `ChatHistoryRecoveryErrorV1` — never "empty transcript".
 */
async function readChatDocument(taskFolderPath: string, canonicalId: string): Promise<ReadDocumentResultV1> {
  const locator = historyLocator(taskFolderPath, canonicalId);
  const read = await getWorkflowFileStoreV1().readFileBounded(locator, CHAT_HISTORY_MAX_FILE_BYTES);
  if (read.kind === "failed" && read.code === "targetMissing") {
    return { document: undefined };
  }
  if (read.kind !== "ok") {
    if (read.kind === "failed" && read.code === "readLimitExceeded") {
      // Too large to read at all: fail closed as a recovery condition rather
      // than guess at partial content. This module has no bytes to
      // quarantine (readFileBounded refuses to return them), so the
      // oversized file is left in place for manual inspection.
      throw new ChatHistoryRecoveryErrorV1(
        "chat-v1.json exceeds the 4 MiB recovery limit and could not be read; use Reset Chat History to recover."
      );
    }
    throw new Error(`chat-v1.json could not be read: ${describeStoreFailure(read)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(read.value.bytes.toString("utf8"));
  } catch (error) {
    const reason = `invalid JSON: ${error instanceof Error ? error.message : String(error)}`;
    if (!(await quarantine(taskFolderPath, read.value.bytes, reason, canonicalId))) {
      throw new Error(`chat-v1.json is unreadable (${reason}) and could not be quarantined`);
    }
    return { document: undefined };
  }

  const rawVersion = (parsed as { version?: unknown } | null)?.version;
  const rawSchemaVersion = (parsed as { schemaVersion?: unknown } | null)?.schemaVersion;
  const document = decodeChatDocument(parsed, taskFolderPath, canonicalId);
  if (!document) {
    const recognizedUnknownVersion =
      (typeof rawVersion === "number" && rawVersion !== CHAT_HISTORY_SCHEMA_VERSION) ||
      (typeof rawSchemaVersion === "number" && rawSchemaVersion !== CHAT_HISTORY_SCHEMA_VERSION);
    if (recognizedUnknownVersion) {
      // UNKNOWN FUTURE VERSION — fail closed into recovery (mirroring the
      // strict progress foundation's unknown-version rule): never treat it
      // as an empty transcript (a subsequent write would silently destroy
      // the unknown content); quarantine it for evidence and surface
      // chatRecoveryRequired instead.
      const reason = `unsupported schema version (${String(rawSchemaVersion ?? rawVersion)})`;
      if (!(await quarantine(taskFolderPath, read.value.bytes, reason, canonicalId))) {
        throw new Error(`chat-v1.json has an unsupported schema version (${reason}) and could not be quarantined`);
      }
      throw new ChatHistoryRecoveryErrorV1(
        "chat-v1.json has an unsupported schema version; the file was preserved as chat-v1.corrupt.json. " +
          "Open Chat Data to inspect it, or Reset Chat History to start over."
      );
    }
    const reason = "unrecognized chat-history document shape";
    if (!(await quarantine(taskFolderPath, read.value.bytes, reason, canonicalId))) {
      throw new Error(`chat-v1.json is unreadable (${reason}) and could not be quarantined`);
    }
    return { document: undefined };
  }
  return { document, revision: read.value.revision };
}

/**
 * Read a task's chat transcript from chat-v1.json. See the module header for
 * the full not-found/quarantine/throw contract; unchanged from before this
 * document format existed.
 */
export async function readChatHistory(taskFolderPath: string, canonicalId = taskFolderPath): Promise<ChatMessage[]> {
  const { document } = await readChatDocument(taskFolderPath, canonicalId);
  return document?.messages.slice(-CHAT_HISTORY_MAX_MESSAGES) ?? [];
}

/** A task-local Chat document's own identity — its authoritative binding, independent of any one interaction. */
export interface ChatDocumentIdentityV1 {
  readonly documentId: string;
  readonly taskBindingId: string;
}

/**
 * Read the CURRENT task-local Chat document's own identity (its
 * `documentId`/`taskBindingId`), or `undefined` if no document exists yet.
 * Derived server-side from the document actually on disk — never from
 * anything the webview supplies — so a caller (chatView.ts's structured
 * Answer/Cancel/Resume controls) can attach the authoritative task/document
 * binding to an interaction reference and have it validated against the
 * durable transaction's OWN recorded binding, not only the interaction id
 * (plan §3.1/§5.5; closes the "reference names the right interaction but the
 * wrong task/document" gap for the two controls production actually wires).
 */
export async function readChatDocumentIdentityV1(
  taskFolderPath: string,
  canonicalId: string
): Promise<ChatDocumentIdentityV1 | undefined> {
  const { document } = await readChatDocument(taskFolderPath, canonicalId);
  if (!document) {
    return undefined;
  }
  return { documentId: document.documentId, taskBindingId: document.taskBindingId };
}


// ---------------------------------------------------------------------------
// Limits and compaction (plan §5.1)
// ---------------------------------------------------------------------------

/**
 * UNSETTLED records are recovery-critical: a pending question (or pending
 * assistant placeholder) the user has not resolved yet must NEVER be
 * compacted away — every one of them, not only the trailing message.
 * Legacy recovery records (`legacyRecovery !== undefined`, imported from the
 * Memento DTO per plan §5.2) are protected the same way regardless of their
 * `pending` flag: a `legacyQuestion` record's source DTO can legally have
 * `pending` missing or `false` (the plan's mapping table keys the recovery
 * classification on `role`, not `pending`), so checking `pending === true`
 * alone would let these recovery-critical records be silently dropped.
 * Structured interactions are protected separately (they never appear in
 * the message list at all).
 */
function isCompactionProtected(message: ChatMessage): boolean {
  return message.pending === true || message.legacyRecovery !== undefined;
}

/**
 * Compact `messages` down to at most `CHAT_HISTORY_MAX_MESSAGES` entries,
 * dropping the OLDEST SETTLED messages first and never a protected
 * (unsettled) one. Returns the surviving list plus the updated compaction
 * counter and, when anything was dropped, an audit digest of the dropped
 * content (never the content itself).
 */
function compactMessages(
  messages: readonly ChatMessage[],
  priorCompactedCount: number
): { messages: ChatMessage[]; compactedCount: number; digest?: string } {
  const working = messages.slice();
  const dropped: ChatMessage[] = [];
  while (working.length > CHAT_HISTORY_MAX_MESSAGES) {
    const index = working.findIndex((m) => !isCompactionProtected(m));
    if (index === -1) {
      // Every remaining message is mandatory (unsettled) — the count cap
      // cannot drop any of them.
      break;
    }
    dropped.push(...working.splice(index, 1));
  }
  if (dropped.length === 0) {
    return { messages: working, compactedCount: priorCompactedCount };
  }
  const digest = sha256Hex(JSON.stringify(dropped));
  return { messages: working, compactedCount: priorCompactedCount + dropped.length, digest };
}

/**
 * The single whole-document byte-limit enforcement point EVERY write passes
 * through (plan §5.1): if the encoded document exceeds the 4 MiB cap, drop
 * the oldest settled (non-protected) messages one at a time until it fits.
 * If only mandatory (unsettled/recovery-critical) content remains and it
 * still does not fit, refuse the write with `chatRecoveryRequired` rather
 * than drop something recovery-critical.
 */
function enforceDocumentLimitsV1(document: ChatDocumentV1): ChatDocumentV1 {
  let encoded = encodeChatDocument(document);
  if (encoded.length <= CHAT_HISTORY_MAX_FILE_BYTES) {
    return document;
  }
  const messages = document.messages.slice();
  let dropped = 0;
  while (encoded.length > CHAT_HISTORY_MAX_FILE_BYTES) {
    const index = messages.findIndex((m) => !isCompactionProtected(m));
    if (index === -1) break;
    messages.splice(index, 1);
    dropped++;
    encoded = encodeChatDocument({ ...document, messages });
  }
  if (encoded.length > CHAT_HISTORY_MAX_FILE_BYTES) {
    throw new ChatHistoryRecoveryErrorV1(
      `the mandatory (non-compactable) Chat content exceeds the ${CHAT_HISTORY_MAX_FILE_BYTES}-byte document limit`
    );
  }
  return {
    ...document,
    messages,
    compaction: {
      compactedMessageCount: document.compaction.compactedMessageCount + dropped,
      lastCompactionDigest: sha256Hex(encoded.toString("utf8")),
    },
  };
}


async function persistDocument(
  taskFolderPath: string,
  document: ChatDocumentV1,
  expectedRevision: string | undefined,
  canonicalId: string
): Promise<void> {
  const locator = historyLocator(taskFolderPath, canonicalId);
  const bytes = encodeChatDocument(enforceDocumentLimitsV1(document));
  const fileStore = getWorkflowFileStoreV1();
  const result =
    expectedRevision !== undefined
      ? await fileStore.replaceFileExact(locator, bytes, expectedRevision)
      : await fileStore.createFileExclusive(locator, bytes);
  if (result.kind === "ok") {
    return;
  }
  if (result.kind === "failed" && result.code === "targetExists" && expectedRevision === undefined) {
    // Lost a race with a concurrent first-write (or a stale in-memory "no
    // file yet" read): fall back to a revision-guarded replace instead of
    // clobbering whatever just landed. This module's own concurrency stance
    // (see header) already accepts last-writer-wins within one host, so this
    // is a best-effort recovery for a benign race, not a stronger guarantee.
    const stat = await fileStore.stat(locator);
    if (stat.kind === "ok" && stat.value.kind === "file" && stat.value.revision !== undefined) {
      const replaced = await fileStore.replaceFileExact(locator, bytes, stat.value.revision);
      if (replaced.kind === "ok") return;
    }
  }
  throw new Error(`chat-v1.json could not be written: ${describeStoreFailure(result)}`);
}

/**
 * Write a task's chat transcript to chat-v1.json, preserving the document's
 * identity/interactions/migration marker/reset epoch and compacting
 * (oldest-settled-first) to stay within the message-count and byte limits.
 * Throws if any single message exceeds `CHAT_HISTORY_MAX_MESSAGE_BYTES`
 * (refused rather than silently truncated) or if the document could not be
 * durably written. Callers own write-failure containment (see
 * ChatViewProvider's per-task write queue).
 */
export async function writeChatHistory(
  taskFolderPath: string,
  messages: ChatMessage[],
  canonicalId = taskFolderPath
): Promise<void> {
  for (const m of messages) {
    if (Buffer.byteLength(JSON.stringify(m), "utf8") > CHAT_HISTORY_MAX_MESSAGE_BYTES) {
      throw new Error(
        `chat-v1.json message exceeds the ${CHAT_HISTORY_MAX_MESSAGE_BYTES}-byte limit and was refused`
      );
    }
  }
  const { document: existing, revision } = await readChatDocument(taskFolderPath, canonicalId);
  let base: ChatDocumentV1;
  if (existing) {
    base = existing;
  } else {
    const defaultBinding = resolveDefaultTaskBindingV1(taskFolderPath, canonicalId);
    base = {
      schemaVersion: 1,
      documentId: newDocumentId(),
      taskBindingId: defaultBinding.taskBindingId,
      taskBindingSource: defaultBinding.taskBindingSource,
      messages: [],
      interactions: [],
      resetEpoch: 0,
      compaction: { compactedMessageCount: 0 },
    };
  }
  const compacted = compactMessages(messages, base.compaction.compactedMessageCount);
  const next: ChatDocumentV1 = {
    ...base,
    messages: compacted.messages,
    compaction: {
      compactedMessageCount: compacted.compactedCount,
      ...(compacted.digest !== undefined ? { lastCompactionDigest: compacted.digest } : {}),
    },
  };
  await persistDocument(taskFolderPath, next, revision, canonicalId);
}

// ---------------------------------------------------------------------------
// Legacy Memento migration (plan §5.2/§5.3)
// ---------------------------------------------------------------------------

/** Exact currently emitted ISO timestamp shape (millisecond precision, `Z`). */
const ISO_MS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const LEGACY_CHAT_KEY_PREFIX = "ensemble.stageChat.transcript.";

/**
 * Find this task's legacy Memento key by exact-prefix enumeration with a
 * canonical round-trip of the encoded suffix (plan §5.3 steps 1-2), rather
 * than presuming the directly-computed key is the only one that could ever
 * exist. A suffix whose `encodeURIComponent(decodeURIComponent(suffix))`
 * does not round-trip back to itself is skipped: it is not a key this (or
 * any) version of the module could have written, so treating it as a match
 * would risk migrating the wrong task's data.
 */
function findLegacyChatKey(memento: vscode.Memento, canonicalId: string): string | undefined {
  const keys = typeof memento.keys === "function" ? memento.keys() : [];
  for (const key of keys) {
    if (!key.startsWith(LEGACY_CHAT_KEY_PREFIX)) continue;
    const suffix = key.slice(LEGACY_CHAT_KEY_PREFIX.length);
    let decoded: string;
    try {
      decoded = decodeURIComponent(suffix);
    } catch {
      continue;
    }
    if (encodeURIComponent(decoded) !== suffix) continue;
    if (decoded === canonicalId) {
      return key;
    }
  }
  return undefined;
}

/**
 * Strictly decode the legacy `{role, text, stage, at, pending}[]` Memento DTO
 * per the plan §5.2 table. Any single invalid entry is WHOLE-TRANSCRIPT
 * recovery: `{ ok: false }`, nothing imported.
 */
function decodeLegacyChatDtoV1(raw: unknown): { ok: true; messages: ChatMessage[] } | { ok: false } {
  if (!Array.isArray(raw)) return { ok: false };
  const messages: ChatMessage[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return { ok: false };
    const e = entry as Record<string, unknown>;
    if (e.role !== "user" && e.role !== "assistant" && e.role !== "question") return { ok: false };
    if (typeof e.text !== "string" || Buffer.byteLength(e.text, "utf8") > CHAT_HISTORY_MAX_MESSAGE_BYTES) {
      return { ok: false };
    }
    if (typeof e.at !== "string" || !ISO_MS_RE.test(e.at)) return { ok: false };
    if (e.pending !== undefined && typeof e.pending !== "boolean") return { ok: false };
    if (e.role === "user" && e.pending === true) return { ok: false };
    let stage: TaskStage | null;
    if (e.stage === undefined || e.stage === null) {
      stage = null;
    } else if (typeof e.stage === "string" && VALID_STAGES.has(e.stage)) {
      stage = e.stage as TaskStage;
    } else {
      return { ok: false };
    }
    const legacyRecovery: ChatMessage["legacyRecovery"] =
      e.role === "assistant" && e.pending === true
        ? "legacyPendingAssistant"
        : e.role === "question"
          ? "legacyQuestion"
          : undefined;
    messages.push({
      role: e.role,
      text: e.text,
      stage,
      at: e.at,
      ...(e.pending !== undefined ? { pending: e.pending as boolean } : {}),
      ...(legacyRecovery !== undefined ? { legacyRecovery } : {}),
    });
  }
  return { ok: true, messages };
}

/** Commit a fresh migrated document (exclusive create — never overwrites a racing writer; see persistDocument). */
async function commitMigration(
  taskFolderPath: string,
  canonicalId: string,
  legacyKey: string,
  legacyValue: unknown,
  messages: ChatMessage[]
): Promise<void> {
  const defaultBinding = resolveDefaultTaskBindingV1(taskFolderPath, canonicalId);
  const document: ChatDocumentV1 = {
    schemaVersion: 1,
    documentId: newDocumentId(),
    taskBindingId: defaultBinding.taskBindingId,
    taskBindingSource: defaultBinding.taskBindingSource,
    messages,
    interactions: [],
    migration: {
      legacyValueSha256: sha256Hex(JSON.stringify(legacyValue)),
      legacyKeySha256: sha256Hex(legacyKey),
      migratedAt: new Date().toISOString(),
    },
    resetEpoch: 0,
    compaction: { compactedMessageCount: 0 },
  };
  await persistDocument(taskFolderPath, document, undefined, canonicalId);
}

/**
 * Load a task's transcript, migrating the legacy per-workspace Memento
 * transcript into `chat-v1.json` the first time a task with no file yet is
 * read (plan §5.3). The Memento value is NEVER deleted or modified — see the
 * module header. `chat-v1.json`, once present, is always authoritative and
 * the legacy key is never consulted again.
 *
 * An unmigratable legacy DTO (unknown role, invalid text/stage/timestamp, a
 * pending user record, etc.) fails CLOSED into `chatRecoveryRequired` rather
 * than degrading to an indistinguishable "no chat yet" empty transcript — the
 * raw value is quarantined to `chat-v1.corrupt.json` for evidence (mirroring
 * every other unreadable-content path in this module) and the Memento value
 * itself is left untouched either way. This repeats on every read until the
 * user resolves it via Reset Chat History (which, for this no-document-yet
 * case, starts a fresh empty document — see `resetChatHistoryV1`).
 */
export async function loadTranscriptWithMigration(
  taskFolderPath: string,
  canonicalId: string,
  memento: vscode.Memento
): Promise<ChatMessage[]> {
  const exists = await chatHistoryFileExists(taskFolderPath, canonicalId);
  if (exists) {
    return readChatHistory(taskFolderPath, canonicalId);
  }
  const legacyKey = findLegacyChatKey(memento, canonicalId);
  if (legacyKey === undefined) {
    return [];
  }
  const legacyValue = memento.get<unknown>(legacyKey);
  if (legacyValue === undefined) {
    return [];
  }
  const decoded = decodeLegacyChatDtoV1(legacyValue);
  if (!decoded.ok) {
    // WHOLE-TRANSCRIPT recovery (plan §5.2): nothing is imported and the
    // Memento value is left untouched, but unlike a benign "no chat yet"
    // state this must surface as a fail-closed recovery condition (a caller
    // could not otherwise tell a fresh task apart from one whose real
    // history failed to import).
    const reason = "the legacy chat transcript is an unrecognized shape and could not be migrated";
    if (!(await quarantine(taskFolderPath, Buffer.from(JSON.stringify(legacyValue, null, 2), "utf8"), reason, canonicalId))) {
      throw new Error(`the legacy chat transcript is unreadable (${reason}) and could not be quarantined`);
    }
    throw new ChatHistoryRecoveryErrorV1(
      `${reason}. The original data is untouched in VS Code's workspace state, and a copy was preserved as ` +
        `${CHAT_HISTORY_CORRUPT_FILENAME} for inspection. Reset Chat History will start a fresh, empty conversation.`
    );
  }
  try {
    // Re-read/re-digest immediately before commit (plan §5.3 step 6): a
    // value that changed mid-migration aborts the commit — migration is
    // retried on the next read instead of committing a stale snapshot.
    const recheck = memento.get<unknown>(legacyKey);
    if (JSON.stringify(recheck) === JSON.stringify(legacyValue)) {
      await commitMigration(taskFolderPath, canonicalId, legacyKey, legacyValue, decoded.messages);
    }
  } catch {
    // The legacy key is retained and migration is retried on the next read
    // (no marker was committed); legacy entries are still served now.
  }
  return decoded.messages.slice(-CHAT_HISTORY_MAX_MESSAGES);
}

// ---------------------------------------------------------------------------
// Structured-question interactions (plan §5.1/§5.5/§6.1)
// ---------------------------------------------------------------------------

export type ChatInteractionMirrorSettlementV1 = Exclude<
  ChatDocumentInteractionStateV1,
  "unresolved" | "missingTransaction" | "orphanedTransaction"
>;

/** A brand-new, empty document using the folder's own default (non-coordinator) binding — see `resolveDefaultTaskBindingV1`. */
function emptyDocumentFor(taskFolderPath: string, canonicalId: string): ChatDocumentV1 {
  const { taskBindingId, taskBindingSource } = resolveDefaultTaskBindingV1(taskFolderPath, canonicalId);
  return {
    schemaVersion: 1,
    documentId: newDocumentId(),
    taskBindingId,
    taskBindingSource,
    messages: [],
    interactions: [],
    resetEpoch: 0,
    compaction: { compactedMessageCount: 0 },
  };
}

/**
 * A brand-new, empty document seeded from a structured-question posting's
 * REQUIRED coordinator-supplied binding (plan §3.1 / AC-ID-03) — never the
 * folder's default binding, since posting must always carry the complete
 * task/document tuple.
 */
function emptyDocumentForInteractionV1(binding: NewChatDocumentInteractionV1["binding"]): ChatDocumentV1 {
  return {
    schemaVersion: 1,
    documentId: binding.chatDocumentId,
    taskBindingId: binding.taskBindingId,
    taskBindingSource: "coordinatorSupplied",
    messages: [],
    interactions: [],
    resetEpoch: 0,
    compaction: { compactedMessageCount: 0 },
  };
}

/**
 * Append a new unresolved structured-question interaction (plan §6.1). Never
 * invokes a provider. Requires the full `binding` (plan §3.1 / AC-ID-03) and
 * rejects a duplicate `interactionId` or a `binding` that conflicts with the
 * document's already-adopted authoritative binding (module header: "the
 * first supplied taskBindingId is adopted... any later conflicting one fails
 * closed"). For a task conversation, the supplied `taskBindingId` must
 * additionally EQUAL the binding freshly derived from the folder's current
 * persisted ownership (see the EXACT BINDING VS. FOLDER check below) — a
 * stale, foreign, or rebound claim fails closed before anything is read or
 * written.
 */
export async function appendChatInteraction(
  taskFolderPath: string,
  canonicalId: string,
  input: NewChatDocumentInteractionV1
): Promise<void> {
  if (!HEX128_RE.test(input.interactionId)) {
    throw new Error("interactionId must be a 128-bit lowercase-hex identity");
  }
  if (!HEX128_RE.test(input.operationId)) {
    throw new Error("operationId must be a 128-bit lowercase-hex identity");
  }
  if (!HEX128_RE.test(input.sourceAttemptId)) {
    throw new Error("sourceAttemptId must be a 128-bit lowercase-hex identity");
  }
  if (typeof input.actionKey !== "string" || input.actionKey.length === 0) {
    throw new Error("actionKey is required");
  }
  if (!VALID_STAGES.has(input.stage)) {
    throw new Error(`unrecognized stage: ${String(input.stage)}`);
  }
  if (!Array.isArray(input.questions) || input.questions.length === 0) {
    throw new Error("questions must be a non-empty array");
  }
  if (
    !input.binding ||
    typeof input.binding.taskBindingId !== "string" ||
    input.binding.taskBindingId.length === 0 ||
    typeof input.binding.chatDocumentId !== "string" ||
    input.binding.chatDocumentId.length === 0
  ) {
    throw new Error("binding (taskBindingId + chatDocumentId) is required to post a structured-question interaction");
  }

  // EXACT BINDING VS. FOLDER (plan §3.9 — the review's mutation-authority
  // contract): for a task conversation, the REQUIRED coordinator-supplied
  // binding must equal the binding freshly derived from THIS folder's
  // current persisted ownership — enforced by the strict task-folder
  // registration before any document read or write. A stale, foreign, or
  // rebound binding fails closed here rather than posting an interaction
  // anchored to the wrong task identity. The Global Assistant's non-task
  // conversation has no ownership to validate against (its binding is the
  // localDigest stand-in by design).
  if (!isGlobalAssistantConversationV1(canonicalId)) {
    ensureWorkflowTaskFolderRootV1(taskFolderPath, { bindingId: input.binding.taskBindingId });
  }

  const { document: existing, revision } = await readChatDocument(taskFolderPath, canonicalId);
  let base: ChatDocumentV1;
  if (existing) {
    base = existing;
    if (input.binding.chatDocumentId !== existing.documentId) {
      throw new Error("interaction binding's chatDocumentId does not match this document");
    }
    if (existing.taskBindingSource === "coordinatorSupplied" || existing.taskBindingSource === "ownershipDerived") {
      if (existing.taskBindingId !== input.binding.taskBindingId) {
        throw new Error("interaction binding conflicts with this document's authoritative task binding");
      }
    } else {
      base = { ...existing, taskBindingId: input.binding.taskBindingId, taskBindingSource: "coordinatorSupplied" };
    }
  } else {
    base = emptyDocumentForInteractionV1(input.binding);
  }

  if (base.interactions.some((i) => i.interactionId === input.interactionId)) {
    throw new Error(`an interaction with id ${input.interactionId} already exists`);
  }

  const interaction: ChatDocumentInteractionV1 = {
    interactionId: input.interactionId,
    operationId: input.operationId,
    actionKey: input.actionKey,
    sourceAttemptId: input.sourceAttemptId,
    stage: input.stage,
    questions: input.questions,
    state: "unresolved",
    postedAt: input.postedAt,
  };

  const next: ChatDocumentV1 = { ...base, interactions: [...base.interactions, interaction] };
  await persistDocument(taskFolderPath, next, revision, canonicalId);
}

/** Map a durable transaction's state/settlement onto the mirror's display state, or `undefined` if still unresolved. */
function mapTransactionStateToMirrorV1(
  transaction: Pick<ChatInteractionTransactionV1, "state" | "settlement">
): ChatDocumentInteractionStateV1 | undefined {
  if (transaction.state !== "settled" || transaction.settlement === undefined) {
    return undefined;
  }
  return transaction.settlement;
}

/** Structural equality for a reconciled answers array — order-sensitive, matching how both sides persist it. */
function sameAnswersV1(
  a: readonly StructuredAnswerV1[] | undefined,
  b: readonly StructuredAnswerV1[] | undefined
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Read a task's structured-question interactions, reconciling both
 * AC-CHAT-TX-03 directions against the durable transaction store when one is
 * wired:
 *
 *  - mirror-present, transaction-missing/undecodable: a settled transaction
 *    downgrades the mirror to the same settlement, and a missing/undecodable
 *    transaction downgrades it to the read-only `missingTransaction` state;
 *  - transaction-present, mirror-missing: a not-yet-settled transaction bound
 *    to this document with no matching mirror `interactionId` (e.g. a crash
 *    between the transaction's `begin()` and the mirror's
 *    `appendChatInteraction()` call) is synthesized as a read-only,
 *    non-resumable `orphanedTransaction` entry so it is discoverable at all.
 *
 * Also backfills the durable transaction's own `answers` (present from
 * `answersDraft` onward) into a still-`unresolved` mirror whenever they
 * differ: `doSubmitInteractionAnswers` (chatView.ts) writes the durable
 * transaction FIRST and the mirror second, so a crash between those two
 * writes would otherwise leave the mirror showing a blank, already-submitted
 * question again on the next render, rather than what the user actually
 * submitted.
 *
 * Reconciled downgrades, answer backfills, and synthesized orphans are
 * persisted best-effort; the returned view always reflects them regardless.
 */
export async function readChatInteractions(
  taskFolderPath: string,
  canonicalId: string,
  stage?: TaskStage
): Promise<ChatDocumentInteractionV1[]> {
  const { document, revision } = await readChatDocument(taskFolderPath, canonicalId);
  if (!document) {
    return [];
  }
  const store = getChatInteractionTransactionStoreV1();
  let changed = false;
  const reconciled: ChatDocumentInteractionV1[] = [];
  for (const interaction of document.interactions) {
    if (interaction.state !== "unresolved" || !store) {
      reconciled.push(interaction);
      continue;
    }
    let next = interaction;
    try {
      const result = await store.load(interaction.operationId);
      if (result.kind === "ok") {
        const mapped = mapTransactionStateToMirrorV1(result.transaction);
        const durableAnswers = result.transaction.answers;
        const needsAnswerBackfill =
          durableAnswers !== undefined && !sameAnswersV1(next.answers, durableAnswers);
        if ((mapped !== undefined && mapped !== next.state) || needsAnswerBackfill) {
          next = {
            ...next,
            ...(mapped !== undefined ? { state: mapped } : {}),
            ...(needsAnswerBackfill ? { answers: durableAnswers } : {}),
          };
        }
      } else if (result.kind === "missing" || result.kind === "recoveryRequired") {
        next = { ...interaction, state: "missingTransaction" };
      }
      // "unavailable" / "storageFailure" / "rejected": a transient
      // reconciliation failure must not permanently downgrade the mirror.
    } catch {
      // Best-effort — leave the interaction as-is on an unexpected error.
    }
    if (next !== interaction) {
      changed = true;
    }
    reconciled.push(next);
  }
  if (store) {
    try {
      const knownInteractionIds = new Set(reconciled.map((i) => i.interactionId));
      const orphans = await store.listUnresolvedForChatDocument(document.documentId);
      for (const transaction of orphans) {
        if (knownInteractionIds.has(transaction.interactionId)) {
          continue;
        }
        if (transaction.questions === undefined) {
          // listUnresolvedForChatDocument excludes invocationPending records
          // (never a real, renderable interaction — plan §6.1 step 5); this
          // is defensive, not a real runtime path.
          continue;
        }
        const postedAt = transaction.transitions[0]?.at ?? new Date(0).toISOString();
        reconciled.push({
          interactionId: transaction.interactionId,
          operationId: transaction.operationId,
          actionKey: transaction.actionKey,
          sourceAttemptId: transaction.sourceAttemptId,
          stage: transaction.stage,
          questions: transaction.questions,
          state: "orphanedTransaction",
          ...(transaction.answers !== undefined ? { answers: transaction.answers } : {}),
          postedAt,
        });
        knownInteractionIds.add(transaction.interactionId);
        changed = true;
      }
    } catch {
      // Best-effort — a transient listing failure just means this round
      // doesn't discover a new orphan; it is not a fatal read failure.
    }
  }
  if (changed) {
    try {
      await persistDocument(taskFolderPath, { ...document, interactions: reconciled }, revision, canonicalId);
    } catch {
      // Best-effort persistence — the caller still gets the reconciled view.
    }
  }
  return stage === undefined ? reconciled : reconciled.filter((i) => i.stage === stage);
}

/**
 * Record typed answers against an unresolved interaction (plan §6.1's Answer
 * control). Does not settle the interaction — only explicit Resume/Cancel do.
 */
export async function recordChatInteractionAnswers(
  taskFolderPath: string,
  canonicalId: string,
  interactionId: string,
  answers: readonly StructuredAnswerV1[]
): Promise<void> {
  const { document, revision } = await readChatDocument(taskFolderPath, canonicalId);
  if (!document) {
    throw new Error(`no chat history exists to record answers for interaction ${interactionId}`);
  }
  const index = document.interactions.findIndex((i) => i.interactionId === interactionId);
  if (index === -1) {
    throw new Error(`no interaction with id ${interactionId} exists`);
  }
  const interactions = document.interactions.slice();
  interactions[index] = { ...interactions[index]!, answers };
  await persistDocument(taskFolderPath, { ...document, interactions }, revision, canonicalId);
}

/** Settle an interaction in the display mirror (plan §6.1's Cancel/Resume controls). Never invokes a provider. */
export async function settleChatInteraction(
  taskFolderPath: string,
  canonicalId: string,
  interactionId: string,
  settlement: ChatInteractionMirrorSettlementV1
): Promise<void> {
  const { document, revision } = await readChatDocument(taskFolderPath, canonicalId);
  if (!document) {
    throw new Error(`no chat history exists to settle interaction ${interactionId}`);
  }
  const index = document.interactions.findIndex((i) => i.interactionId === interactionId);
  if (index === -1) {
    throw new Error(`no interaction with id ${interactionId} exists`);
  }
  const interactions = document.interactions.slice();
  interactions[index] = { ...interactions[index]!, state: settlement };
  await persistDocument(taskFolderPath, { ...document, interactions }, revision, canonicalId);
}

// ---------------------------------------------------------------------------
// Reset Chat History (plan §5.1)
// ---------------------------------------------------------------------------

export type ChatHistoryResetResultV1 =
  | { readonly ok: true; readonly resetId: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Reset a task's Chat: writes a verified pre-reset snapshot to registered
 * private storage, then clears every unresolved interaction (settling each
 * as `resetByChatRecovery`, and settling its durable transaction counterpart
 * when one is wired) and bumps `resetEpoch`. The document id and display
 * transcript are preserved. Refuses — leaving chat-v1.json untouched — when
 * private storage is not configured, the snapshot cannot be verified
 * written, or any unresolved interaction's durable transaction counterpart
 * fails to settle (see the module header's RESET section): a successful
 * Reset must actually clear every unresolved interaction, so a partial
 * settlement is reported as a failure — leaving the document completely
 * unchanged, including `resetEpoch` and every OTHER interaction's
 * settlement — rather than silently returning `ok: true` while some
 * interaction remains `unresolved`. The already-written snapshot is simply
 * unused in that case; the caller may retry once the underlying storage
 * issue clears.
 *
 * When NO document exists yet — most commonly because
 * `loadTranscriptWithMigration` quarantined an unmigratable legacy Memento
 * transcript and threw `chatRecoveryRequired` without ever committing
 * anything — there is nothing in chat-v1.json to snapshot. This still starts
 * a fresh, empty, valid document instead of refusing (so the "Reset Chat
 * History" action that recovery notification offers actually resolves the
 * recovery instead of failing with "no chat history exists to reset"), but
 * applies the SAME private-storage-availability gate AND the same
 * write-and-verify-a-snapshot contract as the with-document path below: the
 * "snapshot" in this case is the fresh empty document itself (the true
 * pre-reset state — there being no prior content is itself the state being
 * recorded), written and verified through the exact same registered
 * recovery-family locators before the empty document is committed as
 * chat-v1.json. Reset's declared contract does not silently relax just
 * because there happens to be nothing to snapshot yet.
 */
export async function resetChatHistoryV1(
  taskFolderPath: string,
  canonicalId: string
): Promise<ChatHistoryResetResultV1> {
  const { document: existing, revision } = await readChatDocument(taskFolderPath, canonicalId);
  const privateRootId = getWorkflowPrivateStorageRootIdV1();
  if (privateRootId === undefined) {
    return { ok: false, reason: "workflowStorageUnavailable: the private-storage root is not configured" };
  }
  const document = existing ?? emptyDocumentFor(taskFolderPath, canonicalId);

  const registry = getWorkflowPathRegistryV1();
  const fileStore = getWorkflowFileStoreV1();
  const resetId = newResetId();

  for (const allocated of [
    registry.workflowRuntimeDir(privateRootId),
    registry.chatRecoveryFamilyDir(privateRootId),
    registry.chatRecoveryDocumentDir(privateRootId, document.documentId),
    registry.chatRecoveryDir(privateRootId, document.documentId, resetId),
  ]) {
    const made = await fileStore.createDirectory(allocated.locator);
    if (made.kind === "unavailable") {
      return { ok: false, reason: `workflow root unavailable (${made.code})` };
    }
    if (made.kind === "failed" && made.code !== "targetExists") {
      return { ok: false, reason: `could not provision recovery storage: ${describeStoreFailure(made)}` };
    }
  }

  const snapshotLocator = registry.chatRecoverySnapshotFile(privateRootId, document.documentId, resetId).locator;
  const written = await fileStore.createFileExclusive(snapshotLocator, encodeChatDocument(document));
  if (written.kind !== "ok") {
    return { ok: false, reason: `could not write the verified pre-reset snapshot: ${describeStoreFailure(written)}` };
  }

  if (!existing) {
    // Nothing was ever committed to chat-v1.json — the verified snapshot
    // above IS the (empty) pre-reset state. Commit that same fresh document
    // as the new chat-v1.json; there are no interactions to settle.
    await persistDocument(taskFolderPath, document, undefined, canonicalId);
    return { ok: true, resetId };
  }

  const store = getChatInteractionTransactionStoreV1();
  const interactions: ChatDocumentInteractionV1[] = [];
  let anyDurableSettleFailed = false;
  for (const interaction of document.interactions) {
    if (interaction.state !== "unresolved") {
      interactions.push(interaction);
      continue;
    }
    let durableSettleFailed = false;
    if (store) {
      try {
        const settled = await store.settleByChatRecovery(interaction.operationId);
        // "ok": settled. "missing": nothing durable ever existed for this
        // mirror record, so there is nothing to keep retrying — treat it the
        // same as settled, same as before this fix. Every other kind
        // (`rejected`, `recoveryRequired`, `storageFailure`, `unavailable`)
        // is a real settlement failure.
        durableSettleFailed = settled.kind !== "ok" && settled.kind !== "missing";
      } catch {
        durableSettleFailed = true;
      }
    }
    if (durableSettleFailed) {
      anyDurableSettleFailed = true;
    }
    interactions.push(durableSettleFailed ? interaction : { ...interaction, state: "resetByChatRecovery" });
  }

  if (anyDurableSettleFailed) {
    // Reset's contract is "every unresolved interaction is cleared" — a
    // partial settlement is a failure, not a success with leftover
    // unresolved interactions. Leave chat-v1.json completely untouched (no
    // resetEpoch bump, no interaction changes at all) so the caller can
    // retry the whole operation once the underlying issue clears, rather
    // than reconciling a half-applied reset against the durable store on a
    // later read.
    return {
      ok: false,
      reason:
        "could not settle every unresolved interaction's durable transaction during reset; chat history was left untouched",
    };
  }

  const next: ChatDocumentV1 = {
    ...document,
    interactions,
    resetEpoch: document.resetEpoch + 1,
  };
  await persistDocument(taskFolderPath, next, revision, canonicalId);
  return { ok: true, resetId };
}

