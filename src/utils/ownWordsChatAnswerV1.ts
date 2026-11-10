import type { WorkflowDecisionV1 } from "../types/workflowDecisionV1";
import {
  type AnswersDecisionV1,
  handOverOwnWordsTextV1,
  normalizeOwnWordsTextV1,
  ownWordsArgOfOptionV1,
} from "./ownWordsAnswerV1";
import { normalizePath } from "./taskRoot";

/**
 * review2 Step 43: the window that runs the workflow receives a chat send that answers an own-words card
 * (`answersDecision`). This checks the card is still open and really is an own-words option of this task, hands the
 * typed text to the card's own command and resolves the card, which runs that command (it records the text under task.md's
 * "## Owner decisions" and starts what the option promised). It never starts a Chat With AI round.
 */
export interface OwnWordsChatAnswerDepsV1 {
  /** Pending cards of the task. */
  readonly pending: readonly WorkflowDecisionV1[];
  /** Saves the owner's message in the transcript, so the answer reads as said in the chat. */
  readonly appendOwnerMessage: (text: string, stage: WorkflowDecisionV1["stage"]) => Promise<void>;
  /** Resolves the card with the option; its effect command runs. */
  readonly resolve: (decisionId: string, optionId: string) => Promise<{ readonly ok: boolean; readonly message?: string }>;
  readonly warn: (text: string) => void;
}

export type OwnWordsChatAnswerResultV1 =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly reason: string };

export async function answerOwnWordsFromChatV1(
  input: {
    readonly taskFolderPath: string;
    readonly answers: AnswersDecisionV1;
    readonly text: string;
  },
  deps: OwnWordsChatAnswerDepsV1
): Promise<OwnWordsChatAnswerResultV1> {
  const text = normalizeOwnWordsTextV1(input.text);
  const refuse = (reason: string): OwnWordsChatAnswerResultV1 => {
    deps.warn(reason);
    return { accepted: false, reason };
  };
  if (text === "") return refuse("The answer was empty, so nothing was recorded. The question is still open.");
  const canonicalId = normalizePath(input.taskFolderPath);
  const decision = deps.pending.find(
    (card) => card.decisionId === input.answers.decisionId && normalizePath(card.taskCanonicalId) === canonicalId
  );
  if (decision === undefined || decision.state !== "pending") {
    return refuse("The question this answer was for is no longer open, so nothing was recorded.");
  }
  const option = decision.options.find((candidate) => candidate.optionId === input.answers.optionId);
  const ownWords = option === undefined ? undefined : ownWordsArgOfOptionV1(option);
  if (ownWords === undefined || normalizePath(ownWords.taskFolderPath) !== canonicalId) {
    return refuse("That choice does not take a typed answer, so nothing was recorded.");
  }
  await deps.appendOwnerMessage(text, decision.stage);
  handOverOwnWordsTextV1(ownWords.taskFolderPath, ownWords.blockerId, text);
  const outcome = await deps.resolve(decision.decisionId, input.answers.optionId);
  return outcome.ok ? { accepted: true } : { accepted: false, reason: outcome.message ?? "the answer could not be recorded" };
}
