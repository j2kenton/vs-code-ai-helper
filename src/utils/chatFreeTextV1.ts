/**
 * In-process free-text answers in chat (Part 2 Step 12).
 *
 * `ChatViewProvider.answerQuestion` persists every free-text answer into the
 * transcript, but historically nothing awaited it: the asking code was
 * fire-and-forget. Commands that used `vscode.window.showInputBox` did await
 * an answer, so converting them needs a bound answer channel that keeps the
 * same control flow.
 *
 * A question posted through this module carries a marker with a random id.
 * The command registers a resolver before posting and awaits it; when the
 * matching answer arrives, chatView settles that resolver with the exact
 * text the user typed. The transcript entry is still written normally, so
 * the answer remains part of chat history.
 */
import * as crypto from "node:crypto";
import * as vscode from "vscode";
import type { ChatTarget } from "../views/chatView";
import { appendChatMessageV1 } from "./chatHistoryStore";
import { ACTIVATION_ID_V1 } from "./awaitedDecisionWaitersV1";
import { getExtensionContextV1 } from "./extensionContextV1";

const PENDING = new Map<string, (answer: string | undefined) => void>();

const MARKER_PREFIX = "<!-- ensemble:chat-answer:";

export function chatFreeTextMarkerV1(id: string): string {
  return `${MARKER_PREFIX}${id} -->`;
}

export function parseChatFreeTextMarkerV1(text: string): string | undefined {
  const match = new RegExp(`${MARKER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([0-9a-f]+) -->`).exec(text);
  return match?.[1];
}

const OWNER_MARKER_PREFIX = "<!-- ensemble:chat-owner:";

/** bugs3 Step 8: names the extension-host activation whose command is waiting on the question. */
export function chatFreeTextOwnerMarkerV1(activationId: string): string {
  return `${OWNER_MARKER_PREFIX}${activationId} -->`;
}

/** The activation that asked `questionText`; undefined for a question written before the owner was recorded. */
export function parseChatFreeTextOwnerV1(questionText: string): string | undefined {
  const match = new RegExp(`${OWNER_MARKER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([0-9a-fA-F-]+) -->`).exec(questionText);
  return match?.[1];
}

/**
 * True when `questionText` is a command-bound question that no activation can
 * be waiting on any more from this process's point of view: it is marked, no
 * waiter is registered here, and it was asked by a different activation (or by
 * one that never recorded itself). Used by the activation sweep, which runs
 * before this activation could have asked anything.
 */
export function isFreeTextQuestionFromEarlierActivationV1(questionText: string): boolean {
  if (!isChatFreeTextQuestionV1(questionText) || hasLiveChatFreeTextWaiterV1(questionText)) {
    return false;
  }
  return parseChatFreeTextOwnerV1(questionText) !== ACTIVATION_ID_V1;
}

export function registerChatFreeTextAnswerV1(id: string, resolve: (answer: string | undefined) => void): void {
  PENDING.set(id, resolve);
}

/**
 * bugs3 Step 8: the question carried by `questionText` was retired or
 * dismissed. Release whatever command is waiting on it with no answer, so it
 * stops waiting instead of holding until its own timeout.
 */
export function abandonChatFreeTextQuestionV1(questionText: string): boolean {
  const id = parseChatFreeTextMarkerV1(questionText);
  const resolve = id === undefined ? undefined : PENDING.get(id);
  if (id === undefined || !resolve) {
    return false;
  }
  PENDING.delete(id);
  resolve(undefined);
  return true;
}

/** Why a free-text question with no waiter left is closed (its asking command is gone). */
export const FREE_TEXT_WAITER_GONE_REASON_V1 =
  "the action that asked it ended (the window was reloaded or the question timed out); start that action again";

/** True when `questionText` is a command-bound free-text question (it carries a marker). */
export function isChatFreeTextQuestionV1(questionText: string): boolean {
  return parseChatFreeTextMarkerV1(questionText) !== undefined;
}

/**
 * True when a command in THIS process is still waiting on the question. A
 * marked question without a waiter was orphaned by a reload or its own
 * timeout: answering it would be saved and do nothing.
 */
export function hasLiveChatFreeTextWaiterV1(questionText: string): boolean {
  const id = parseChatFreeTextMarkerV1(questionText);
  return id !== undefined && PENDING.has(id);
}

/** Settle the pending question carried by `questionText` with the user's answer. */
export function settleChatFreeTextQuestionV1(questionText: string, answer: string): boolean {
  const id = parseChatFreeTextMarkerV1(questionText);
  if (!id) {
    return false;
  }
  const resolve = PENDING.get(id);
  if (!resolve) {
    return false;
  }
  PENDING.delete(id);
  resolve(answer);
  return true;
}

export function cancelChatFreeTextAnswerV1(id: string): void {
  PENDING.delete(id);
}

/** Test-only reset so one test's unresolved question cannot leak into another. */
export function __resetChatFreeTextTestOnlyV1(): void {
  PENDING.clear();
}

export interface ChatFreeTextInputV1 {
  readonly target: ChatTarget;
  readonly title?: string;
  readonly prompt: string;
  readonly placeHolder?: string;
  /**
   * How to run the asking action again if this question is withdrawn (a reload
   * or the timeout ends the command that was waiting on it). Shown on the card
   * and repeated in the withdrawal line, so a dropped question names its action.
   */
  readonly restartGuidance?: string;
}

const RESTART_LINE_PREFIX_V1 = "If this question is still open after a window reload it is withdrawn; to run it again: ";

/** The restart guidance carried on a free-text question's text, if it carried any. */
export function parseChatFreeTextRestartGuidanceV1(questionText: string): string | undefined {
  const at = questionText.lastIndexOf(RESTART_LINE_PREFIX_V1);
  if (at < 0) {
    return undefined;
  }
  const guidance = questionText.slice(at + RESTART_LINE_PREFIX_V1.length).split("\n")[0]?.trim();
  return guidance && guidance.length > 0 ? guidance : undefined;
}

/** Why a free-text question with no waiter left is closed, naming the action to run again when known. */
export function describeFreeTextWaiterGoneReasonV1(questionText: string): string {
  const guidance = parseChatFreeTextRestartGuidanceV1(questionText);
  return guidance === undefined
    ? FREE_TEXT_WAITER_GONE_REASON_V1
    : `the action that asked it ended (the window was reloaded or the question timed out); ${guidance}`;
}

/**
 * Post a free-text question to the target's chat and resolve with the user's
 * answer (or undefined when no extension context is available or the prompt
 * times out).
 */
export async function askChatFreeTextV1(input: ChatFreeTextInputV1): Promise<string | undefined> {
  if (!getExtensionContextV1() || !input.target.taskFolderPath) {
    return undefined;
  }
  const id = crypto.randomBytes(16).toString("hex");
  const marker = chatFreeTextMarkerV1(id);
  const ownerMarker = chatFreeTextOwnerMarkerV1(ACTIVATION_ID_V1);
  const header = input.title ? `${input.title} — ${marker}${ownerMarker}\n` : `${marker}${ownerMarker}\n`;
  const hint = input.placeHolder ? `\n(${input.placeHolder})` : "";
  const restart =
    input.restartGuidance !== undefined && input.restartGuidance.trim().length > 0
      ? `\n\n${RESTART_LINE_PREFIX_V1}${input.restartGuidance.trim().replace(/\s*\n\s*/g, " ")}`
      : "";
  const questionText = `${header}${input.prompt}${hint}${restart}`;
  const responsePromise = new Promise<string | undefined>((resolve) => {
    registerChatFreeTextAnswerV1(id, (answer) => {
      clearTimeout(timer);
      resolve(answer);
    });
    const timer = setTimeout(() => {
      cancelChatFreeTextAnswerV1(id);
      resolve(undefined);
    }, 10 * 60 * 1000);
    const unrefable = timer as unknown as { unref?: () => void };
    unrefable.unref?.();
  });
  try {
    await appendChatMessageV1(
      input.target.taskFolderPath,
      {
        id,
        role: "question",
        text: questionText,
        pending: true,
        stage: input.target.stage,
        at: new Date().toISOString(),
      },
      input.target.canonicalId
    );
    void Promise.resolve(vscode.commands.executeCommand("vs-code-ai-helper.openWorkflowDecision", input.target)).catch(
      () => undefined
    );
  } catch {
    cancelChatFreeTextAnswerV1(id);
    return undefined;
  }
  return responsePromise;
}
