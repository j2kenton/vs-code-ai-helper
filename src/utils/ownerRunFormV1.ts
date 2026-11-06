/**
 * review1 Step 50: the chat form behind "I ran it — record the result". It generalises the owner test-run card (which
 * has no inputs) to any command: three text fields (the command, its exit code, the end of its output) and one
 * "Record it" choice whose effect carries the blocker's identity. The chat settles the form by merging the typed
 * answers into that effect's arguments and running it, so no input box is ever opened outside the chat.
 *
 * Pure: no `vscode`, no I/O.
 */
import { allocateHex128IdV1 } from "../types/actionCorrelationV1";
import type { StructuredAnswerV1, StructuredQuestionV1 } from "../types/structuredQuestionV1";
import type { WorkflowDecisionOptionEffectV1 } from "../types/workflowDecisionV1";

export const OWNER_RUN_FORM_QUESTION_ID_PREFIX_V1 = "owner-run-form-";
export const OWNER_RUN_FORM_COMMAND_QUESTION_ID_V1 = `${OWNER_RUN_FORM_QUESTION_ID_PREFIX_V1}command`;
export const OWNER_RUN_FORM_EXIT_CODE_QUESTION_ID_V1 = `${OWNER_RUN_FORM_QUESTION_ID_PREFIX_V1}exit-code`;
export const OWNER_RUN_FORM_OUTPUT_QUESTION_ID_V1 = `${OWNER_RUN_FORM_QUESTION_ID_PREFIX_V1}output`;
export const OWNER_RUN_FORM_RECORD_QUESTION_ID_V1 = `${OWNER_RUN_FORM_QUESTION_ID_PREFIX_V1}record`;

/** The fields of the form that the record command accepts. */
export interface OwnerRunFormValuesV1 {
  readonly command?: string;
  readonly exitCode?: string;
  readonly outputTail?: string;
}

export interface OwnerRunFormMetaV1 {
  readonly taskFolderPath: string;
  readonly stage: string;
  /** The blocker text the run answers. */
  readonly blocker: string;
  /** The blocker's lineage identity (`blockerOwnerIdentityV1`), the key the record is bound to. */
  readonly blockerLineageId: string;
}

export interface OwnerRunFormV1 {
  readonly questions: StructuredQuestionV1[];
  readonly optionEffects: Record<string, WorkflowDecisionOptionEffectV1>;
}

const TEXT_MAX_LENGTH_V1 = 8_000;

export function buildOwnerRunFormV1(meta: OwnerRunFormMetaV1, command: string, suggestedCommand?: string): OwnerRunFormV1 {
  const recordOptionId = allocateHex128IdV1();
  const questions: StructuredQuestionV1[] = [
    {
      questionId: OWNER_RUN_FORM_COMMAND_QUESTION_ID_V1,
      kind: "text",
      prompt: "The exact command you ran outside this task." + (suggestedCommand ? `\nThe blocker names: ${suggestedCommand}` : ""),
      helpText: `Blocker: ${meta.blocker.replace(/\s+/g, " ").trim().slice(0, 300)}`,
      required: false,
      allowBlank: true,
      maxLength: TEXT_MAX_LENGTH_V1,
    },
    {
      questionId: OWNER_RUN_FORM_EXIT_CODE_QUESTION_ID_V1,
      kind: "text",
      prompt: "Its exit code (0 means it passed).",
      required: false,
      allowBlank: true,
      maxLength: 8,
    },
    {
      questionId: OWNER_RUN_FORM_OUTPUT_QUESTION_ID_V1,
      kind: "text",
      prompt: "The last lines of its output, if you want them on record (optional). Secrets are removed.",
      required: false,
      allowBlank: true,
      maxLength: TEXT_MAX_LENGTH_V1,
    },
    {
      questionId: OWNER_RUN_FORM_RECORD_QUESTION_ID_V1,
      kind: "singleChoice",
      prompt: "Save this as your own run, bound to the blocker, and re-run the review?",
      required: true,
      options: [
        {
          optionId: recordOptionId,
          label: "Record it and re-run the review",
          description:
            "Saves the command, exit code and output under Owner evidence in task.md as your own run, then re-runs the " +
            "review. The review may still disagree, but it has to cite your record.",
        },
      ],
    },
  ];
  return {
    questions,
    optionEffects: {
      [recordOptionId]: {
        kind: "command",
        command,
        args: [{ ...meta }],
        recordedNext: "saves your run under Owner evidence in task.md and re-runs the review",
      },
    },
  };
}

/** Whether a question set is the owner-run form. */
export function isOwnerRunFormV1(questions: readonly StructuredQuestionV1[]): boolean {
  return (
    questions.length > 0 &&
    questions.some((q) => q.questionId === OWNER_RUN_FORM_COMMAND_QUESTION_ID_V1) &&
    questions.every((q) => q.questionId.startsWith(OWNER_RUN_FORM_QUESTION_ID_PREFIX_V1))
  );
}

/** What the owner typed into the form's text fields (blank fields are absent). */
export function readOwnerRunFormValuesV1(answers: readonly StructuredAnswerV1[]): OwnerRunFormValuesV1 {
  const text = (questionId: string): string | undefined => {
    const answer = answers.find((a) => a.questionId === questionId);
    return answer?.kind === "text" && answer.state === "answered" && answer.value.trim().length > 0
      ? answer.value.trim()
      : undefined;
  };
  const command = text(OWNER_RUN_FORM_COMMAND_QUESTION_ID_V1);
  const exitCode = text(OWNER_RUN_FORM_EXIT_CODE_QUESTION_ID_V1);
  const outputTail = text(OWNER_RUN_FORM_OUTPUT_QUESTION_ID_V1);
  return {
    ...(command !== undefined ? { command } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(outputTail !== undefined ? { outputTail } : {}),
  };
}

/**
 * The "Record it" effect with the typed values merged into its arguments. An effect that is not a command with an
 * argument object is returned unchanged.
 */
export function mergeOwnerRunFormValuesIntoEffectV1(
  effect: WorkflowDecisionOptionEffectV1,
  values: OwnerRunFormValuesV1
): WorkflowDecisionOptionEffectV1 {
  if (effect.kind !== "command" || !Array.isArray(effect.args) || typeof effect.args[0] !== "object" || effect.args[0] === null) {
    return effect;
  }
  const [first, ...rest] = effect.args as unknown[];
  return { ...effect, args: [{ ...(first as Record<string, unknown>), ...values }, ...rest] };
}
