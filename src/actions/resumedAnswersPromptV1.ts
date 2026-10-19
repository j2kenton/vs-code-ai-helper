import type { StructuredAnswerV1, StructuredQuestionV1 } from "../types/structuredQuestionV1";

export interface ResumedAnswersV1 {
  readonly questions: readonly StructuredQuestionV1[];
  readonly answers: readonly StructuredAnswerV1[];
}

function labelFor(question: StructuredQuestionV1, optionId: string): string {
  if (question.kind === "text") {
    return optionId;
  }
  return question.options.find((o) => o.optionId === optionId)?.label ?? optionId;
}

function answerText(question: StructuredQuestionV1 | undefined, answer: StructuredAnswerV1): string {
  if (answer.state === "skipped") {
    return "(skipped)";
  }
  if (answer.kind === "text") {
    return answer.value;
  }
  if (answer.kind === "singleChoice") {
    return question ? labelFor(question, answer.selectedOptionId) : answer.selectedOptionId;
  }
  return answer.selectedOptionIds
    .map((id) => (question ? labelFor(question, id) : id))
    .join(", ");
}

/** Prompt section appended on Resume so the AI receives the user's answers. */
export function buildResumedAnswersBlockV1(
  questions: readonly StructuredQuestionV1[],
  answers: readonly StructuredAnswerV1[]
): string {
  const byId = new Map(questions.map((q) => [q.questionId, q] as const));
  const lines = ["## Your earlier questions and the user's answers", ""];
  for (const answer of answers) {
    const question = byId.get(answer.questionId);
    lines.push(`Question: ${question?.prompt ?? answer.questionId}`);
    lines.push(`Answer: ${answerText(question, answer)}`);
    lines.push("");
  }
  lines.push(
    "These answers are final. Complete the action now using them, and do not ask any of these questions (or the same question again) a second time."
  );
  return lines.join("\n");
}
