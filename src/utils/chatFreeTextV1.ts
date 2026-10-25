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
import { getExtensionContextV1 } from "./extensionContextV1";

const PENDING = new Map<string, (answer: string) => void>();

const MARKER_PREFIX = "<!-- ensemble:chat-answer:";

export function chatFreeTextMarkerV1(id: string): string {
  return `${MARKER_PREFIX}${id} -->`;
}

export function parseChatFreeTextMarkerV1(text: string): string | undefined {
  const match = new RegExp(`${MARKER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([0-9a-f]+) -->`).exec(text);
  return match?.[1];
}

export function registerChatFreeTextAnswerV1(id: string, resolve: (answer: string) => void): void {
  PENDING.set(id, resolve);
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
  const header = input.title ? `${input.title} — ${marker}\n` : `${marker}\n`;
  const hint = input.placeHolder ? `\n(${input.placeHolder})` : "";
  const questionText = `${header}${input.prompt}${hint}`;
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
