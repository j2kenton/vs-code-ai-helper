/**
 * Shared "ask one choice in chat" helper (post-1.0 fixes, Part 2 Steps 10–15).
 *
 * The owner's rule is that every question Ensemble asks is asked in the chat
 * panel with its own controls — never a QuickPick, input box or modal. A
 * command that used to `await vscode.window.showQuickPick(...)` and then keep
 * working with the answer needs the same in-process control flow: post a
 * WorkflowDecisionV1, wait for the answer, and return the chosen option id.
 *
 * Unlike `postWorkflowDecisionV1` (fire-and-forget, for automation hand-offs
 * where nothing is still running), this helper is for the command that asked
 * the question and will continue as soon as the user answers.
 */
import type { ChatTarget } from "../views/chatView";
import { awaitWorkflowDecisionAnswerV1 } from "./workflowDecisionDispatchV1";

export interface ChatChoiceOptionV1 {
  readonly optionId: string;
  readonly label: string;
  readonly description?: string;
  readonly consequence?: string;
  readonly destructive?: boolean;
}

export interface ChatChoiceInputV1 {
  readonly decisionKey: string;
  readonly target: ChatTarget;
  readonly whatHappened: string;
  readonly whyUserNeeded: string;
  readonly options: readonly ChatChoiceOptionV1[];
  readonly recommendedOptionId?: string;
  readonly recommendationReasoning?: string;
  readonly detail?: string;
  /** Optional evidence lines shown above the options. */
  readonly evidence?: readonly { readonly label: string; readonly detail: string }[];
}

/**
 * Ask a single choice in the target's chat and resolve with its option id, or
 * undefined when the user dismisses the card (or there is no chat context).
 * The effect is `doNothing`: the calling command itself continues with the
 * answer, preserving the exact command outcome the old picker produced.
 */
export async function askChatChoiceV1(input: ChatChoiceInputV1): Promise<string | undefined> {
  if (input.options.length === 0) {
    return undefined;
  }
  const recommendation = input.recommendedOptionId &&
    input.options.some((option) => option.optionId === input.recommendedOptionId)
    ? {
        kind: "option" as const,
        optionId: input.recommendedOptionId,
        reasoning: input.recommendationReasoning ?? "This is the usual choice.",
      }
    : { kind: "none" as const, reasoning: "The choice is yours." };
  return awaitWorkflowDecisionAnswerV1(
    {
      decisionKey: input.decisionKey,
      taskCanonicalId: input.target.canonicalId,
      stage: input.target.stage,
      whatHappened: input.whatHappened,
      whyUserNeeded: input.whyUserNeeded,
      options: input.options.map((option) => ({
        optionId: option.optionId,
        label: option.label,
        resumeKind: "continue" as const,
        consequence: option.consequence ?? (option.description ?? "Continues this command with your choice."),
        effect: { kind: "doNothing" as const },
        ...(option.destructive === true ? { destructive: true as const } : {}),
      })),
      recommendation,
      ...(input.evidence && input.evidence.length > 0 ? { evidence: input.evidence } : {}),
      gating: {
        holdsTaskPaused: false,
        unblocksProgress: false,
        detail: input.detail ?? "Answering continues the command that asked.",
      },
    },
    input.target
  );
}
