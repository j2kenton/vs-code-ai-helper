/**
 * Structured-question client shapes and answer drafting (plan Part 9),
 * mirroring the Part 2 contract structurally — the app packages cannot
 * declare `workspace:*` dependencies until the dependency-install round, so
 * (like the control-plane client's DTOs) these mirror `@ensemble/core`'s
 * `StructuredQuestionV1`/`StructuredAnswerV1` wire shapes rather than import
 * them. The server validates every submission with the real Part 2 codec;
 * this module gives the UI immediate, contract-faithful feedback and builds
 * the exact answer array the `ChatTurnRequest` contract expects.
 */

export interface QuestionOptionV1 {
  readonly optionId: string;
  readonly label: string;
  readonly description?: string;
}

export type StructuredQuestionV1 =
  | {
      readonly questionId: string;
      readonly kind: 'text';
      readonly prompt: string;
      readonly helpText?: string;
      readonly required: boolean;
      readonly allowBlank: boolean;
      readonly maxLength: number;
    }
  | {
      readonly questionId: string;
      readonly kind: 'singleChoice';
      readonly prompt: string;
      readonly helpText?: string;
      readonly required: boolean;
      readonly options: readonly QuestionOptionV1[];
    }
  | {
      readonly questionId: string;
      readonly kind: 'multipleChoice';
      readonly prompt: string;
      readonly helpText?: string;
      readonly required: boolean;
      readonly minSelections: number;
      readonly maxSelections: number;
      readonly options: readonly QuestionOptionV1[];
    };

export type StructuredAnswerV1 =
  | {
      readonly questionId: string;
      readonly kind: 'text' | 'singleChoice' | 'multipleChoice';
      readonly state: 'skipped';
    }
  | { readonly questionId: string; readonly kind: 'text'; readonly state: 'answered'; readonly value: string }
  | {
      readonly questionId: string;
      readonly kind: 'singleChoice';
      readonly state: 'answered';
      readonly selectedOptionId: string;
    }
  | {
      readonly questionId: string;
      readonly kind: 'multipleChoice';
      readonly state: 'answered';
      readonly selectedOptionIds: readonly string[];
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeOption(raw: unknown): QuestionOptionV1 | null {
  if (!isRecord(raw) || typeof raw.optionId !== 'string' || typeof raw.label !== 'string') {
    return null;
  }
  return {
    optionId: raw.optionId,
    label: raw.label,
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
  };
}

function decodeOptionList(raw: unknown): readonly QuestionOptionV1[] | null {
  if (!Array.isArray(raw) || raw.length === 0) {
    return null;
  }
  const options: QuestionOptionV1[] = [];
  for (const entry of raw) {
    const option = decodeOption(entry);
    if (option === null) {
      return null;
    }
    options.push(option);
  }
  return options;
}

function decodeQuestion(raw: unknown): StructuredQuestionV1 | null {
  if (
    !isRecord(raw) ||
    typeof raw.questionId !== 'string' ||
    typeof raw.prompt !== 'string' ||
    typeof raw.required !== 'boolean'
  ) {
    return null;
  }
  const base = {
    questionId: raw.questionId,
    prompt: raw.prompt,
    required: raw.required,
    ...(typeof raw.helpText === 'string' ? { helpText: raw.helpText } : {}),
  };
  if (raw.kind === 'text') {
    if (typeof raw.allowBlank !== 'boolean' || typeof raw.maxLength !== 'number') {
      return null;
    }
    return { ...base, kind: 'text', allowBlank: raw.allowBlank, maxLength: raw.maxLength };
  }
  if (raw.kind === 'singleChoice') {
    const options = decodeOptionList(raw.options);
    return options === null ? null : { ...base, kind: 'singleChoice', options };
  }
  if (raw.kind === 'multipleChoice') {
    const options = decodeOptionList(raw.options);
    if (options === null || typeof raw.minSelections !== 'number' || typeof raw.maxSelections !== 'number') {
      return null;
    }
    return {
      ...base,
      kind: 'multipleChoice',
      options,
      minSelections: raw.minSelections,
      maxSelections: raw.maxSelections,
    };
  }
  return null;
}

/**
 * Structurally decode a WS `structuredQuestions` payload. Any malformed
 * entry rejects the whole list — a partially rendered question set could
 * mislead an answer — and the server's Part 2 codec remains the authority.
 */
export function decodeQuestionListV1(raw: unknown): readonly StructuredQuestionV1[] | null {
  if (!Array.isArray(raw) || raw.length === 0) {
    return null;
  }
  const questions: StructuredQuestionV1[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const question = decodeQuestion(entry);
    if (question === null || seen.has(question.questionId)) {
      return null;
    }
    seen.add(question.questionId);
    questions.push(question);
  }
  return questions;
}

/** Per-question draft state the answer form edits. */
export interface AnswerDraftV1 {
  readonly skipped: boolean;
  readonly text: string;
  readonly selectedOptionIds: readonly string[];
}

export const EMPTY_ANSWER_DRAFT_V1: AnswerDraftV1 = { skipped: false, text: '', selectedOptionIds: [] };

export function initialDraftsV1(
  questions: readonly StructuredQuestionV1[]
): Readonly<Record<string, AnswerDraftV1>> {
  return Object.fromEntries(questions.map((q) => [q.questionId, EMPTY_ANSWER_DRAFT_V1]));
}

export function toggleOptionV1(draft: AnswerDraftV1, optionId: string, single: boolean): AnswerDraftV1 {
  if (single) {
    return { ...draft, skipped: false, selectedOptionIds: [optionId] };
  }
  const selected = draft.selectedOptionIds.includes(optionId)
    ? draft.selectedOptionIds.filter((id) => id !== optionId)
    : [...draft.selectedOptionIds, optionId];
  return { ...draft, skipped: false, selectedOptionIds: selected };
}

export type BuildAnswersResultV1 =
  | { readonly ok: true; readonly answers: readonly StructuredAnswerV1[] }
  | { readonly ok: false; readonly questionId: string; readonly reason: string };

/**
 * Build the contract's answer array from drafts, enforcing the same rules
 * the Part 2 validator applies server-side: skip only where optional, blank
 * text only where allowed, maxLength, one selection for singleChoice, and
 * multipleChoice selection bounds.
 */
export function buildStructuredAnswersV1(
  questions: readonly StructuredQuestionV1[],
  drafts: Readonly<Record<string, AnswerDraftV1>>
): BuildAnswersResultV1 {
  const answers: StructuredAnswerV1[] = [];
  for (const question of questions) {
    const draft = drafts[question.questionId] ?? EMPTY_ANSWER_DRAFT_V1;
    if (draft.skipped) {
      if (question.required) {
        return { ok: false, questionId: question.questionId, reason: 'this question is required' };
      }
      answers.push({ questionId: question.questionId, kind: question.kind, state: 'skipped' });
      continue;
    }
    if (question.kind === 'text') {
      if (draft.text.length === 0 && !question.allowBlank) {
        return { ok: false, questionId: question.questionId, reason: 'an answer is required (blank not allowed)' };
      }
      if (draft.text.length > question.maxLength) {
        return {
          ok: false,
          questionId: question.questionId,
          reason: `answer exceeds the ${question.maxLength}-character limit`,
        };
      }
      answers.push({ questionId: question.questionId, kind: 'text', state: 'answered', value: draft.text });
      continue;
    }
    if (question.kind === 'singleChoice') {
      const selected = draft.selectedOptionIds[0];
      if (selected === undefined) {
        return { ok: false, questionId: question.questionId, reason: 'select one option' };
      }
      answers.push({
        questionId: question.questionId,
        kind: 'singleChoice',
        state: 'answered',
        selectedOptionId: selected,
      });
      continue;
    }
    const count = draft.selectedOptionIds.length;
    if (count < question.minSelections || count > question.maxSelections) {
      return {
        ok: false,
        questionId: question.questionId,
        reason: `select between ${question.minSelections} and ${question.maxSelections} options`,
      };
    }
    answers.push({
      questionId: question.questionId,
      kind: 'multipleChoice',
      state: 'answered',
      selectedOptionIds: draft.selectedOptionIds,
    });
  }
  return { ok: true, answers };
}
