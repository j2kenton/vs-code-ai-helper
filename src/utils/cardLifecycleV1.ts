/**
 * How a pending card closes without an answer (bugs3 Step 8).
 *
 * Two kinds of record can ask the owner for something: a workflow decision
 * (`WorkflowDecisionV1`, in the decision store) and a question (a
 * `role: "question"` row in `chat-v1.json`, which includes the "Owner evidence
 * needed" card). Both close the same two ways:
 *
 *   - **retired** by the system — the task left the stage that raised the card,
 *     or a resume or later answer made it moot;
 *   - **dismissed** by the owner — no dispatch, nothing written to `task.md`.
 *
 * Both record why, and an answer that arrives afterwards is refused with that
 * reason instead of being saved. This module holds the shared wording and the
 * question side of retirement; the decision side lives in
 * `workflowDecisionDispatchV1.ts` / `workflowDecisionStoreV1.ts`.
 */

import * as os from "os";
import { withTaskLock } from "../state/taskStateStore";
import type { TaskStage } from "../types/taskProgress";
import type { WorkflowDecisionV1 } from "../types/workflowDecisionV1";
import {
  type ChatMessage,
  type ChatQuestionSettlementV1,
  type SettleChatQuestionsFilterV1,
  closeOpenPlanItemsFormsV1,
  appendChatMessageV1,
  chatQuestionKeyV1,
  expireLocalOnlyInteractionsV1,
  retireOperationInteractionsV1,
  settleChatQuestionsV1,
} from "./chatHistoryStore";
import {
  abandonChatFreeTextQuestionV1,
  FREE_TEXT_WAITER_GONE_REASON_V1,
  describeFreeTextWaiterGoneReasonV1,
  hasLiveChatFreeTextWaiterV1,
  isChatFreeTextQuestionV1,
  isFreeTextQuestionFromEarlierActivationV1,
} from "./chatFreeTextV1";

/** The reason recorded on a card closed because its stage was left. */
export const CARD_RETIRED_BY_TASK_MOVING_ON_REASON_V1 = "retired by the task moving on, not answered";

/** Who a dismissal is recorded against when no account name is available. */
export const CARD_DISMISSED_BY_OWNER_V1 = "the owner";

/** The account name a dismissal is recorded against, else "the owner". */
export function currentActorNameV1(): string {
  try {
    const name = os.userInfo().username;
    return name && name.trim().length > 0 ? name.trim() : CARD_DISMISSED_BY_OWNER_V1;
  } catch {
    return CARD_DISMISSED_BY_OWNER_V1;
  }
}

/**
 * Retire every pending question matching `filter` (a departed stage, or a
 * single moot card). Releases any command waiting on a retired free-text
 * question. Returns the questions it closed.
 */
export async function retirePendingQuestionsV1(
  taskFolderPath: string,
  canonicalId: string,
  reason: string,
  filter: SettleChatQuestionsFilterV1
): Promise<ChatMessage[]> {
  const closed = await settleChatQuestionsV1(taskFolderPath, canonicalId, filter, { kind: "retired", reason });
  for (const question of closed) {
    abandonChatFreeTextQuestionV1(question.text);
  }
  // Leaving a whole stage also closes its local-only choice cards (no
  // operation backs them); a narrow filter (one card, or one kind) does not.
  if (filter.stage !== undefined && filter.matches === undefined && filter.questionKey === undefined) {
    const forms = await withTaskLock(taskFolderPath, () => closeOpenPlanItemsFormsV1(taskFolderPath, canonicalId, {
      stage: filter.stage,
      ...(filter.raisedAtOrBefore !== undefined ? { raisedAtOrBefore: filter.raisedAtOrBefore } : {}),
    }, { state: "stale", reason }));
    for (const form of forms) {
      await appendChatMessageV1(taskFolderPath, { role: "assistant", text: `Withdrawn: ${reason}`, stage: form.stage, at: new Date().toISOString() }, canonicalId);
    }
    await expireLocalOnlyInteractionsV1(taskFolderPath, canonicalId, {
      stage: filter.stage,
      reason,
      ...(filter.raisedAtOrBefore !== undefined ? { raisedAtOrBefore: filter.raisedAtOrBefore } : {}),
    });
    await retireOperationInteractionsV1(taskFolderPath, canonicalId, {
      stage: filter.stage,
      reason,
      ...(filter.raisedAtOrBefore !== undefined ? { raisedAtOrBefore: filter.raisedAtOrBefore } : {}),
    });
  }
  return closed;
}

/**
 * A command-bound free-text question whose waiter is gone (the window reloaded,
 * or the question timed out) would save an answer and do nothing with it. When
 * `question` is such a question, close it with the reason and return the
 * settlement so the caller refuses the answer; otherwise return undefined and
 * leave the card alone.
 */
export async function retireQuestionIfWaiterGoneV1(
  taskFolderPath: string,
  canonicalId: string,
  question: Pick<ChatMessage, "id" | "at" | "text">
): Promise<ChatQuestionSettlementV1 | undefined> {
  if (!isChatFreeTextQuestionV1(question.text) || hasLiveChatFreeTextWaiterV1(question.text)) {
    return undefined;
  }
  const reason = describeFreeTextWaiterGoneReasonV1(question.text);
  const closed = await retirePendingQuestionsV1(taskFolderPath, canonicalId, reason, {
    questionKey: chatQuestionKeyV1(question),
  });
  if (closed.length === 0) {
    return undefined;
  }
  return { kind: "retired", reason, at: new Date().toISOString() };
}

/**
 * Activation sweep: a command-bound free-text question asked by an earlier
 * activation (a reload, crash or update ended the command waiting on it) can
 * never be acted on. Close each with the reason and say in that task's chat
 * which action it belonged to and how to run it again. Runner windows only —
 * a viewer owns no waiters and would close the runner's live questions.
 */
export async function retireFreeTextQuestionsFromEarlierActivationV1(
  taskFolderPath: string,
  canonicalId: string
): Promise<ChatMessage[]> {
  const closed = await retirePendingQuestionsV1(taskFolderPath, canonicalId, FREE_TEXT_WAITER_GONE_REASON_V1, {
    matches: (question) => isFreeTextQuestionFromEarlierActivationV1(question.text),
  });
  for (const question of closed) {
    await appendChatMessageV1(
      taskFolderPath,
      {
        role: "assistant",
        text: `Withdrawn: ${describeFreeTextWaiterGoneReasonV1(question.text)}.`,
        stage: question.stage,
        at: new Date().toISOString(),
      },
      canonicalId
    );
  }
  return closed;
}

/** Dismiss one pending question on the owner's behalf; see {@link retirePendingQuestionsV1}. */
export async function dismissPendingQuestionV1(
  taskFolderPath: string,
  canonicalId: string,
  questionKey: string,
  by: string = CARD_DISMISSED_BY_OWNER_V1
): Promise<ChatMessage | undefined> {
  const closed = await settleChatQuestionsV1(
    taskFolderPath,
    canonicalId,
    { questionKey },
    { kind: "dismissed", reason: "dismissed by the owner, not answered", by }
  );
  for (const question of closed) {
    abandonChatFreeTextQuestionV1(question.text);
  }
  return closed[0];
}

/** One line for the transcript describing how a question card closed. */
export function describeQuestionSettlementV1(settlement: ChatQuestionSettlementV1): string {
  if (settlement.kind === "dismissed") {
    return `Dismissed by ${settlement.by ?? CARD_DISMISSED_BY_OWNER_V1} at ${settlement.at}. Nothing was run and task.md was not changed.`;
  }
  return `Withdrawn: ${settlement.reason}`;
}

/**
 * Why an answer to a decision that is no longer pending was not applied.
 * Quotes the recorded reason for a retired (withdrawn) or dismissed card, and
 * keeps the plain "already submitted" wording for one that was answered.
 */
export function describeSettledDecisionRefusalV1(decision: WorkflowDecisionV1): string {
  if (decision.state === "withdrawn") {
    return `This decision is no longer open (${decision.withdrawnReason ?? "it was withdrawn"}), so your choice was not applied.`;
  }
  if (decision.state === "dismissed") {
    const who = decision.dismissedBy ?? CARD_DISMISSED_BY_OWNER_V1;
    const when = decision.dismissedAt ? ` at ${decision.dismissedAt}` : "";
    return `This decision was dismissed by ${who}${when}, so your choice was not applied.`;
  }
  if (decision.state === "superseded") {
    return "This decision was replaced by a newer one, so your choice was not applied.";
  }
  return "This decision was already submitted.";
}

/** What the task's state was when a card was dismissed. */
export interface CardDismissalContextV1 {
  /** The card was the task's next step (the task is paused or waiting on it). */
  readonly holdsTask: boolean;
  /** Task status at dismissal time, when known. */
  readonly taskStatus?: "creating" | "active" | "paused" | "completed" | "archived";
  /** The stage the card was raised on. */
  readonly stage?: TaskStage;
  /**
   * bugs5 Step 9: the name of the running command that was waiting on this card ("Commit & Push").
   * Dismissing that card ends the command, and the line says so.
   */
  readonly waitingCommand?: string;
  /** What the command would have done ("committed"): "…nothing was committed." */
  readonly waitingNothingDone?: string;
}

/**
 * bugs5 Step 9: what the card says before Dismiss when a running command waits on it.
 * "Dismissing stops this Commit & Push; nothing is committed."
 */
export function describeWaitingCommandDismissWarningV1(command: string, nothingDone?: string): string {
  return `Dismissing stops this ${command}${nothingDone ? `; nothing is ${nothingDone}` : ""}.`;
}

/**
 * The line a dismissal appends. When the dismissed card was what the task
 * waited on, it says so and names what will move the task instead, so
 * dismissing never silently leaves a stuck task.
 */
export function describeCardDismissalV1(what: string, context: CardDismissalContextV1): string {
  if (context.waitingCommand !== undefined) {
    const cmd = context.waitingCommand;
    return (
      `Dismissed ${what}. ${cmd} stopped because the confirmation was dismissed` +
      `${context.waitingNothingDone ? `; nothing was ${context.waitingNothingDone}` : ""}. ` +
      `Choose ${cmd} to start again.`
    );
  }
  const base = `Dismissed ${what}. Nothing was run and task.md was not changed.`;
  if (!context.holdsTask) {
    return base;
  }
  const paused = context.taskStatus === "paused";
  return (
    `${base} This was the card the task was waiting on, so the task ${paused ? "stays paused" : "is still waiting"}: ` +
    `${paused ? "Resume it from the Tasks pane" : "use the Tasks pane to resume it"}, or open the stage and choose its next action ` +
    "(for example Advance, or Run again) to move it on."
  );
}
