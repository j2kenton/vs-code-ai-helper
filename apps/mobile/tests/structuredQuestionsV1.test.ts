/**
 * Answer-drafting tests: the client-side build enforces the same rules the
 * Part 2 validator applies server-side (skip only where optional, blank
 * text only where allowed, maxLength, selection cardinality) and emits the
 * exact contract answer variants.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildStructuredAnswersV1,
  decodeQuestionListV1,
  initialDraftsV1,
  toggleOptionV1,
  EMPTY_ANSWER_DRAFT_V1,
  type StructuredQuestionV1,
} from '../src/chat/structuredQuestionsV1';

const TEXT_REQUIRED: StructuredQuestionV1 = {
  questionId: 'q-text',
  kind: 'text',
  prompt: 'Why?',
  required: true,
  allowBlank: false,
  maxLength: 10,
};

const SINGLE: StructuredQuestionV1 = {
  questionId: 'q-single',
  kind: 'singleChoice',
  prompt: 'Pick one',
  required: true,
  options: [
    { optionId: 'a', label: 'A' },
    { optionId: 'b', label: 'B' },
  ],
};

const MULTI: StructuredQuestionV1 = {
  questionId: 'q-multi',
  kind: 'multipleChoice',
  prompt: 'Pick some',
  required: false,
  minSelections: 1,
  maxSelections: 2,
  options: [
    { optionId: 'a', label: 'A' },
    { optionId: 'b', label: 'B' },
    { optionId: 'c', label: 'C' },
  ],
};

test('a complete draft builds the exact contract answer variants', () => {
  const drafts = {
    'q-text': { skipped: false, text: 'because', selectedOptionIds: [] },
    'q-single': { skipped: false, text: '', selectedOptionIds: ['b'] },
    'q-multi': { skipped: false, text: '', selectedOptionIds: ['a', 'c'] },
  };
  const built = buildStructuredAnswersV1([TEXT_REQUIRED, SINGLE, MULTI], drafts);
  assert.equal(built.ok, true);
  assert.deepEqual(built.ok && built.answers, [
    { questionId: 'q-text', kind: 'text', state: 'answered', value: 'because' },
    { questionId: 'q-single', kind: 'singleChoice', state: 'answered', selectedOptionId: 'b' },
    { questionId: 'q-multi', kind: 'multipleChoice', state: 'answered', selectedOptionIds: ['a', 'c'] },
  ]);
});

test('required questions cannot be skipped; optional ones skip explicitly', () => {
  const requiredSkipped = buildStructuredAnswersV1([TEXT_REQUIRED], {
    'q-text': { skipped: true, text: '', selectedOptionIds: [] },
  });
  assert.equal(requiredSkipped.ok, false);

  const optionalSkipped = buildStructuredAnswersV1([MULTI], {
    'q-multi': { skipped: true, text: '', selectedOptionIds: [] },
  });
  assert.deepEqual(optionalSkipped.ok && optionalSkipped.answers, [
    { questionId: 'q-multi', kind: 'multipleChoice', state: 'skipped' },
  ]);
});

test('blank text is rejected unless allowed, and maxLength is enforced', () => {
  const blank = buildStructuredAnswersV1([TEXT_REQUIRED], { 'q-text': EMPTY_ANSWER_DRAFT_V1 });
  assert.equal(blank.ok, false);
  assert.match(!blank.ok ? blank.reason : '', /blank/);

  const tooLong = buildStructuredAnswersV1([TEXT_REQUIRED], {
    'q-text': { skipped: false, text: 'x'.repeat(11), selectedOptionIds: [] },
  });
  assert.equal(tooLong.ok, false);

  const allowBlank: StructuredQuestionV1 = { ...TEXT_REQUIRED, allowBlank: true };
  const blankOk = buildStructuredAnswersV1([allowBlank], { 'q-text': EMPTY_ANSWER_DRAFT_V1 });
  assert.equal(blankOk.ok, true);
});

test('selection cardinality is enforced for both choice kinds', () => {
  const noSelection = buildStructuredAnswersV1([SINGLE], { 'q-single': EMPTY_ANSWER_DRAFT_V1 });
  assert.equal(noSelection.ok, false);

  const overMax = buildStructuredAnswersV1([MULTI], {
    'q-multi': { skipped: false, text: '', selectedOptionIds: ['a', 'b', 'c'] },
  });
  assert.equal(overMax.ok, false);
  assert.match(!overMax.ok ? overMax.reason : '', /between 1 and 2/);
});

test('toggleOptionV1 is radio-like for single choice and additive for multi', () => {
  const single = toggleOptionV1(toggleOptionV1(EMPTY_ANSWER_DRAFT_V1, 'a', true), 'b', true);
  assert.deepEqual(single.selectedOptionIds, ['b']);

  let multi = toggleOptionV1(EMPTY_ANSWER_DRAFT_V1, 'a', false);
  multi = toggleOptionV1(multi, 'c', false);
  assert.deepEqual(multi.selectedOptionIds, ['a', 'c']);
  multi = toggleOptionV1(multi, 'a', false);
  assert.deepEqual(multi.selectedOptionIds, ['c']);

  const unskips = toggleOptionV1({ ...EMPTY_ANSWER_DRAFT_V1, skipped: true }, 'a', true);
  assert.equal(unskips.skipped, false);
});

test('initial drafts cover every question with the empty draft', () => {
  const drafts = initialDraftsV1([TEXT_REQUIRED, SINGLE]);
  assert.deepEqual(drafts['q-text'], EMPTY_ANSWER_DRAFT_V1);
  assert.deepEqual(drafts['q-single'], EMPTY_ANSWER_DRAFT_V1);
});

test('the question-list decoder accepts contract shapes and rejects broken ones whole', () => {
  const decoded = decodeQuestionListV1([
    { questionId: 'q1', kind: 'text', prompt: 'p', required: true, allowBlank: true, maxLength: 5 },
    {
      questionId: 'q2',
      kind: 'multipleChoice',
      prompt: 'p',
      required: false,
      minSelections: 0,
      maxSelections: 1,
      options: [
        { optionId: 'a', label: 'A' },
        { optionId: 'b', label: 'B' },
      ],
    },
  ]);
  assert.equal(decoded?.length, 2);

  assert.equal(
    decodeQuestionListV1([
      { questionId: 'q1', kind: 'text', prompt: 'p', required: true, allowBlank: true, maxLength: 5 },
      { questionId: 'q1', kind: 'text', prompt: 'dup id', required: true, allowBlank: true, maxLength: 5 },
    ]),
    null
  );
  assert.equal(decodeQuestionListV1([{ questionId: 'q1', kind: 'singleChoice', prompt: 'p', required: true, options: [] }]), null);
  assert.equal(decodeQuestionListV1([]), null);
});
