/**
 * A user-authored message typed into a PAUSED task's stage chat (bugs2
 * finding 8, narrowed by the owner's 2026-10-25 decision): sending it resumes
 * the task and sends the message as ONE action. There is no prerequisite
 * option card, no "answer without resuming" branch and no free-text intent
 * detection — typing and sending the message is the authorization, and the
 * chat then says plainly what it did.
 *
 * Automatic dispatches are not covered here: they stay refused and logged only
 * (`showPausedTaskRefusalV1`), because nobody typed anything.
 *
 * This module holds the decision logic behind injectable dependencies so it is
 * unit-testable without a window; `chatWithStage.ts` supplies the real ones.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { STAGE_ORDER, type TaskStage } from "../types/taskProgress";
import type { TaskActionOutcomeV1 } from "../types/taskActionOutcomeV1";
import { appendChatMessageV1, type ChatMessage } from "../utils/chatHistoryStore";

export type ChatSendStatusV1 = "retained" | "promoting" | "held" | "completed" | "failed";

export interface ChatSendRecordV1 {
  readonly sendId: string;
  readonly status: ChatSendStatusV1;
  readonly recordedAt: string;
  readonly message?: string;
  readonly stage?: string;
  readonly reason?: string;
  readonly promotionSettled?: boolean;
  readonly effectsApplied?: boolean;
  readonly finalText?: string;
  readonly proposedStageAction?: unknown;
  readonly proposedBlockerSupersessionEdit?: unknown;
  readonly promotionEvidence?: unknown;
}

const sendStateCache = new Map<string, Map<string, ChatSendRecordV1>>();

function isTaskStageV1(value: unknown): value is TaskStage {
  return typeof value === "string" && STAGE_ORDER.includes(value as TaskStage);
}

function isProposedStageActionV1(value: unknown): value is NonNullable<ChatMessage["proposedStageAction"]> {
  return value !== null && typeof value === "object" && "id" in value && typeof value.id === "string";
}

function isProposedBlockerEditV1(value: unknown): value is NonNullable<ChatMessage["proposedBlockerSupersessionEdit"]> {
  if (value === null || typeof value !== "object") return false;
  return "relPath" in value && typeof value.relPath === "string" &&
    "content" in value && typeof value.content === "string" &&
    "blockerDescription" in value && typeof value.blockerDescription === "string" &&
    "reviewStage" in value && isTaskStageV1(value.reviewStage);
}

function getSendStatePath(taskFolderPath: string): string {
  return path.join(taskFolderPath, "chat-send-state-v1.json");
}

export function resetChatSendStateForTestV1(): void {
  sendStateCache.clear();
}

export async function getChatSendStateV1(
  taskFolderPath: string,
  sendId: string
): Promise<ChatSendRecordV1 | undefined> {
  const cached = sendStateCache.get(taskFolderPath)?.get(sendId);
  if (cached) {
    return cached;
  }
  try {
    const raw = await fs.promises.readFile(getSendStatePath(taskFolderPath), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      let folderCache = sendStateCache.get(taskFolderPath);
      if (!folderCache) {
        folderCache = new Map();
        sendStateCache.set(taskFolderPath, folderCache);
      }
      for (const [id, rec] of Object.entries(parsed as Record<string, ChatSendRecordV1>)) {
        if (rec && typeof rec === "object") {
          folderCache.set(id, rec);
        }
      }
      return folderCache.get(sendId);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export async function recordChatSendStateV1(
  taskFolderPath: string,
  sendId: string,
  status: ChatSendStatusV1,
  details?: {
    message?: string;
    stage?: string;
    reason?: string;
    promotionSettled?: boolean;
    effectsApplied?: boolean;
    finalText?: string;
    proposedStageAction?: unknown;
    proposedBlockerSupersessionEdit?: unknown;
    promotionEvidence?: unknown;
  }
): Promise<void> {
  let folderCache = sendStateCache.get(taskFolderPath);
  const cached = folderCache?.get(sendId);
  if (cached?.status === "completed" && status !== "completed") {
    return;
  }

  let existing: Record<string, ChatSendRecordV1> = {};
  try {
    const raw = await fs.promises.readFile(getSendStatePath(taskFolderPath), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      existing = parsed as Record<string, ChatSendRecordV1>;
    }
  } catch {
    // Existing file absent or unreadable; start from empty map
  }

  if (existing[sendId]?.status === "completed" && status !== "completed") {
    if (!folderCache) {
      folderCache = new Map();
      sendStateCache.set(taskFolderPath, folderCache);
    }
    folderCache.set(sendId, existing[sendId]);
    return;
  }

  // A terminal delivery error can happen after promotion has already applied
  // task-file effects. Keep that checkpoint when changing only the status or
  // reason, otherwise a later retry could execute the provider twice.
  // The process cache may contain a newer checkpoint than the last durable
  // record when a write failed after the task-file effects were applied.
  // Prefer each cached field over its older on-disk counterpart so a later
  // terminal failure cannot erase that indeterminate-promotion evidence.
  const prior = { ...(existing[sendId] ?? {}), ...(cached ?? {}) } as ChatSendRecordV1 | undefined;
  const record: ChatSendRecordV1 = {
    ...(prior ?? {}),
    sendId,
    status,
    recordedAt: new Date().toISOString(),
    ...(details?.message !== undefined ? { message: details.message } : {}),
    ...(details?.stage !== undefined ? { stage: details.stage } : {}),
    ...(details?.reason !== undefined ? { reason: details.reason } : {}),
    ...(details?.promotionSettled !== undefined ? { promotionSettled: details.promotionSettled } : {}),
    ...(details?.effectsApplied !== undefined ? { effectsApplied: details.effectsApplied } : {}),
    ...(details?.finalText !== undefined ? { finalText: details.finalText } : {}),
    ...(details?.proposedStageAction !== undefined ? { proposedStageAction: details.proposedStageAction } : {}),
    ...(details?.proposedBlockerSupersessionEdit !== undefined ? { proposedBlockerSupersessionEdit: details.proposedBlockerSupersessionEdit } : {}),
    ...(details?.promotionEvidence !== undefined ? { promotionEvidence: details.promotionEvidence } : {}),
  };
  if (!folderCache) {
    folderCache = new Map();
    sendStateCache.set(taskFolderPath, folderCache);
  }
  folderCache.set(sendId, record);

  existing[sendId] = record;
  await fs.promises.writeFile(getSendStatePath(taskFolderPath), JSON.stringify(existing, null, 2), "utf8");
}

/**
 * Reconciles recoverable invocation and promotion settlement before admitting or dispatching another send.
 * If promotion already appended an assistant response for this sendId into chat-v1.json (e.g. before a crash),
 * or if promotion was interrupted between task-file update and transcript append, this recovers the promotion,
 * updates the receipt to 'completed' and returns settled: true so callers avoid duplicate execution.
 * If promotion was interrupted before task-file updates or is indeterminate, it holds the attempt.
 */
export async function reconcileChatSendStateV1(
  taskFolderPath: string,
  sendId: string,
  _canonicalId?: string,
  stage?: string
): Promise<{ readonly settled: boolean; readonly status: ChatSendStatusV1; readonly held?: boolean; readonly reason?: string }> {
  const current = await getChatSendStateV1(taskFolderPath, sendId);
  if (current?.status === "completed") {
    return { settled: true, status: "completed" };
  }
  if (current?.promotionSettled) {
    await recordChatSendStateV1(taskFolderPath, sendId, "completed", {
      stage: current?.stage ?? stage,
      message: current?.message,
      promotionSettled: true,
    });
    return { settled: true, status: "completed" };
  }

  // Interruption between task-file update and transcript append:
  // Recover promotion by appending the assistant message and settling to completed.
  if (current?.effectsApplied && current?.finalText) {
    const canonicalId = _canonicalId ?? taskFolderPath;
    const chatFilePath = path.join(taskFolderPath, "chat-v1.json");
    const readMatchingAssistant = async (): Promise<"matching" | "conflicting" | "missing"> => {
      try {
        const raw = await fs.promises.readFile(chatFilePath, "utf8");
        const parsed = JSON.parse(raw) as { messages?: Array<Record<string, unknown>> };
        const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
        // The retained user entry intentionally shares this stable identity.
        // Only the assistant entry can prove the provider response was stored.
        const existing = messages.find((message) => message?.role === "assistant" && message?.id === sendId);
        if (!existing) return "missing";
        return existing.role === "assistant" && existing.text === current.finalText &&
          existing.stage === (current.stage ?? stage)
          ? "matching"
          : "conflicting";
      } catch {
        return "missing";
      }
    };

    const beforeAppend = await readMatchingAssistant();
    if (beforeAppend === "conflicting") {
      const reason = `A chat message already uses send identity '${sendId}' but does not match this send's recorded promotion. Holding it for recovery.`;
      await recordChatSendStateV1(taskFolderPath, sendId, "held", {
        stage: current.stage ?? stage,
        message: current.message,
        reason,
        effectsApplied: true,
        finalText: current.finalText,
        proposedStageAction: current.proposedStageAction,
        proposedBlockerSupersessionEdit: current.proposedBlockerSupersessionEdit,
        promotionEvidence: current.promotionEvidence,
      });
      return { settled: false, status: "held", held: true, reason };
    }

    try {
      if (beforeAppend === "missing") {
        await appendChatMessageV1(
          taskFolderPath,
          {
            id: sendId,
            role: "assistant",
            text: current.finalText,
            stage: isTaskStageV1(current.stage) ? current.stage : isTaskStageV1(stage) ? stage : "desc",
            at: new Date().toISOString(),
            ...(isProposedStageActionV1(current.proposedStageAction)
              ? { proposedStageAction: current.proposedStageAction }
              : {}),
            ...(isProposedBlockerEditV1(current.proposedBlockerSupersessionEdit)
              ? { proposedBlockerSupersessionEdit: current.proposedBlockerSupersessionEdit }
              : {}),
          },
          canonicalId
        );
      }
    } catch (error) {
      const reason = `The prior send's promotion effects were recorded, but its assistant response could not be persisted: ${error instanceof Error ? error.message : String(error)}. The send is held for recovery.`;
      await recordChatSendStateV1(taskFolderPath, sendId, "held", {
        stage: current.stage ?? stage,
        message: current.message,
        reason,
        effectsApplied: true,
        finalText: current.finalText,
        proposedStageAction: current.proposedStageAction,
        proposedBlockerSupersessionEdit: current.proposedBlockerSupersessionEdit,
        promotionEvidence: current.promotionEvidence,
      });
      return { settled: false, status: "held", held: true, reason };
    }

    if ((await readMatchingAssistant()) !== "matching") {
      const reason = `The prior send's promotion response is not durably present in chat history; holding send '${sendId}' to prevent duplicate execution.`;
      await recordChatSendStateV1(taskFolderPath, sendId, "held", {
        stage: current.stage ?? stage,
        message: current.message,
        reason,
        effectsApplied: true,
        finalText: current.finalText,
        proposedStageAction: current.proposedStageAction,
        proposedBlockerSupersessionEdit: current.proposedBlockerSupersessionEdit,
        promotionEvidence: current.promotionEvidence,
      });
      return { settled: false, status: "held", held: true, reason };
    }

    await recordChatSendStateV1(taskFolderPath, sendId, "completed", {
      stage: current?.stage ?? stage,
      message: current?.message,
      promotionSettled: true,
    });
    return { settled: true, status: "completed" };
  }

  // If promotion started but effects were not confirmed applied, the prior attempt is indeterminate.
  // Hold the indeterminate prior attempt rather than automatically replaying it.
  if (current?.status === "promoting" || current?.status === "held" ||
      (current?.status === "failed" && current.promotionEvidence !== undefined && !current.effectsApplied)) {
    const reason =
      current?.reason ??
      "An earlier provider attempt for this message was interrupted before promotion completed; holding to prevent duplicate execution";
    if (current?.status !== "held") {
      await recordChatSendStateV1(taskFolderPath, sendId, "held", {
        stage: current?.stage ?? stage,
        message: current?.message,
        reason,
      });
    }
    return { settled: false, status: "held", held: true, reason };
  }

  try {
    const chatFilePath = path.join(taskFolderPath, "chat-v1.json");
    const raw = await fs.promises.readFile(chatFilePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      "messages" in parsed &&
      Array.isArray((parsed as { messages: unknown[] }).messages)
    ) {
      const messages = (parsed as { messages: Array<Record<string, unknown>> }).messages;
      const matchingAssistantMessage = messages.find(
        (m) =>
          m &&
          typeof m === "object" &&
          m.role === "assistant" &&
          m.id === sendId &&
          (stage === undefined || m.stage === stage) &&
          typeof m.text === "string"
      );
      if (matchingAssistantMessage) {
        await recordChatSendStateV1(taskFolderPath, sendId, "completed", {
          stage: current?.stage ?? stage,
          message: current?.message,
          promotionSettled: true,
        });
        return { settled: true, status: "completed" };
      }
    }
  } catch {
    // chat-v1.json absent or unreadable
  }

  return { settled: false, status: current?.status ?? "retained" };
}

/** What resuming for a send ended as. */
export type PausedSendResumeOutcomeV1 =
  | {
      readonly kind: "resumed";
      readonly pausedOthers: readonly string[];
      readonly release?: (outcome?: TaskActionOutcomeV1) => Promise<void>;
    }
  | { readonly kind: "blocked"; readonly reason: string };

export interface PausedSendResumeDepsV1 {
  /** Labels of OTHER tasks that are active right now (the transition pauses them). */
  readonly listOtherActiveTaskLabels: () => Promise<readonly string[]>;
  /** Drops the send's own work admission so the Resume can take it. */
  readonly releaseOwnAdmission: () => Promise<void>;
  /** The normal Resume (status flip + active-task transition), holding admission for the caller. */
  readonly resume: () => Promise<{
    readonly outcome: string;
    readonly release?: (outcome?: TaskActionOutcomeV1) => Promise<void>;
  }>;
}

/**
 * Resumes the paused task for a user send. Returns `resumed` (with the other
 * tasks the transition paused, and the admission to release after the send) or
 * `blocked` with the real reason — the caller then keeps the message and
 * reports it, never claiming it was sent.
 */
export async function resumePausedTaskForUserSendV1(deps: PausedSendResumeDepsV1): Promise<PausedSendResumeOutcomeV1> {
  const activeBefore = await deps.listOtherActiveTaskLabels();
  await deps.releaseOwnAdmission();
  let resumed: Awaited<ReturnType<PausedSendResumeDepsV1["resume"]>>;
  try {
    resumed = await deps.resume();
  } catch (error) {
    return { kind: "blocked", reason: `resuming the task failed (${error instanceof Error ? error.message : String(error)})` };
  }
  switch (resumed.outcome) {
    case "resumed": {
      const activeAfter = new Set(await deps.listOtherActiveTaskLabels());
      // Tasks that were active before the transition and are no longer active.
      const pausedOthers = activeBefore.filter((label) => !activeAfter.has(label));
      return { kind: "resumed", pausedOthers, ...(resumed.release ? { release: resumed.release } : {}) };
    }
    case "busy":
      return { kind: "blocked", reason: "another operation holds this task right now, so it could not be resumed" };
    case "superseded":
      return { kind: "blocked", reason: "the task was resumed by someone else while this message was being sent" };
    case "notPaused":
      return { kind: "blocked", reason: "the task is not paused" };
    case "completed":
      return { kind: "blocked", reason: "the task is completed" };
    case "notFound":
      return { kind: "blocked", reason: "the task could not be found" };
    default:
      return { kind: "blocked", reason: "the task could not be resumed (see the notification for the cause)" };
  }
}

function nameList(labels: readonly string[]): string {
  if (labels.length === 1) {
    return labels[0]!;
  }
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/**
 * The acknowledgement posted AFTER the message was actually sent: names the
 * task that was paused, resumed and given the message, and any other active
 * task the transition paused.
 */
export function describeResumedSendAcknowledgementV1(taskLabel: string, pausedOthers: readonly string[]): string {
  const others =
    pausedOthers.length === 0
      ? ""
      : ` ${nameList(pausedOthers)} ${pausedOthers.length === 1 ? "was" : "were"} active, so ${
          pausedOthers.length === 1 ? "it was" : "they were"
        } paused to make ${taskLabel} the active task.`;
  return `${taskLabel} was paused. I resumed it and sent your message.${others}`;
}

/** What the chat says when the message is kept but could not be sent. */
export function describeRetainedPausedSendV1(taskLabel: string, reason: string): string {
  return (
    `${taskLabel} is paused and your message was kept but NOT sent: ${reason}. ` +
    "Resolve that, then choose Resume and send — your message will be sent once, exactly as written."
  );
}
