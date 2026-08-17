/**
 * Structured question/answer wire contract (Part 2 port of
 * `src/types/structuredQuestionV1.ts`).
 *
 * Semantics are byte-identical to the extension's module — the dual-decode
 * conformance suite (tests/conformance.test.ts) runs every fixture under
 * test-fixtures/structured-questions/ through both this codec and the
 * extension's and requires identical verdicts and identical decoded values.
 * The only mechanical difference from the source module is that canonical
 * byte lengths are measured with TextEncoder instead of Node's Buffer, so
 * this package stays runnable outside Node.
 */
import { utf8ByteLengthV1 } from "./sha256V1";

export interface QuestionOptionV1 {
  readonly optionId: string;
  readonly label: string;
  readonly description?: string;
}

export type StructuredQuestionV1 =
  | {
      readonly questionId: string;
      readonly kind: "text";
      readonly prompt: string;
      readonly helpText?: string;
      readonly required: boolean;
      readonly allowBlank: boolean;
      readonly maxLength: number;
    }
  | {
      readonly questionId: string;
      readonly kind: "singleChoice";
      readonly prompt: string;
      readonly helpText?: string;
      readonly required: boolean;
      readonly options: readonly QuestionOptionV1[];
    }
  | {
      readonly questionId: string;
      readonly kind: "multipleChoice";
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
      readonly kind: "text" | "singleChoice" | "multipleChoice";
      readonly state: "skipped";
    }
  | {
      readonly questionId: string;
      readonly kind: "text";
      readonly state: "answered";
      readonly value: string;
    }
  | {
      readonly questionId: string;
      readonly kind: "singleChoice";
      readonly state: "answered";
      readonly selectedOptionId: string;
    }
  | {
      readonly questionId: string;
      readonly kind: "multipleChoice";
      readonly state: "answered";
      readonly selectedOptionIds: readonly string[];
    };

export const MIN_QUESTIONS_V1 = 1;
export const MAX_QUESTIONS_V1 = 16;
export const DEFAULT_TEXT_ANSWER_MAX_LENGTH_V1 = 4000;
export const MAX_QUESTION_SET_CANONICAL_BYTES_V1 = 256 * 1024;
export const MIN_OPTIONS_V1 = 2;
export const MAX_OPTIONS_V1 = 32;
export const MAX_ANSWER_SUBMISSION_CANONICAL_BYTES_V1 = 128 * 1024;

/**
 * Bounded ASCII identifier: printable, non-whitespace, 1-128 characters.
 * Exported so verify:structured-questions can prove the checked-in JSON
 * Schemas carry the identical pattern.
 */
export const STABLE_ID_PATTERN_V1 = /^[\x21-\x7E]{1,128}$/;

function isStableId(value: unknown): value is string {
  return typeof value === "string" && STABLE_ID_PATTERN_V1.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface StructuredQuestionValidationResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly questions?: readonly StructuredQuestionV1[];
}

function rejectUnknownFields(
  raw: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string
): string | undefined {
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      return `${label} has an unknown field: ${key}`;
    }
  }
  return undefined;
}

function decodeOption(raw: unknown): QuestionOptionV1 | undefined {
  if (!isPlainRecord(raw)) {
    return undefined;
  }
  if (!isStableId(raw.optionId) || !isNonEmptyString(raw.label)) {
    return undefined;
  }
  if (raw.description !== undefined && typeof raw.description !== "string") {
    return undefined;
  }
  if (rejectUnknownFields(raw, new Set(["optionId", "label", "description"]), "option")) {
    return undefined;
  }
  const option: QuestionOptionV1 = { optionId: raw.optionId, label: raw.label };
  return raw.description !== undefined ? { ...option, description: raw.description } : option;
}

function decodeOptions(raw: unknown): readonly QuestionOptionV1[] | undefined {
  if (!Array.isArray(raw) || raw.length < MIN_OPTIONS_V1 || raw.length > MAX_OPTIONS_V1) {
    return undefined;
  }
  const options: QuestionOptionV1[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const option = decodeOption(entry);
    if (!option || seen.has(option.optionId)) {
      return undefined;
    }
    seen.add(option.optionId);
    options.push(option);
  }
  return options;
}

function decodeQuestion(raw: unknown): StructuredQuestionV1 | string {
  if (!isPlainRecord(raw)) {
    return "question is not an object";
  }
  if (!isStableId(raw.questionId)) {
    return "question is missing a valid \"questionId\"";
  }
  if (!isNonEmptyString(raw.prompt)) {
    return `question "${String(raw.questionId)}" is missing a non-empty "prompt"`;
  }
  if (raw.helpText !== undefined && typeof raw.helpText !== "string") {
    return `question "${String(raw.questionId)}" has a non-string "helpText"`;
  }
  if (typeof raw.required !== "boolean") {
    return `question "${String(raw.questionId)}" is missing a boolean "required"`;
  }
  const base = {
    questionId: raw.questionId,
    prompt: raw.prompt,
    required: raw.required,
    ...(raw.helpText !== undefined ? { helpText: raw.helpText } : {}),
  };

  switch (raw.kind) {
    case "text": {
      if (raw.allowBlank !== undefined && typeof raw.allowBlank !== "boolean") {
        return `text question "${raw.questionId}" has a non-boolean "allowBlank"`;
      }
      if (
        raw.maxLength !== undefined &&
        (typeof raw.maxLength !== "number" || !Number.isInteger(raw.maxLength) || raw.maxLength < 0)
      ) {
        return `text question "${raw.questionId}" has an invalid "maxLength"`;
      }
      const unknownField = rejectUnknownFields(
        raw,
        new Set(["questionId", "kind", "prompt", "helpText", "required", "allowBlank", "maxLength"]),
        `text question "${raw.questionId}"`
      );
      if (unknownField) {
        return unknownField;
      }
      return {
        ...base,
        kind: "text",
        allowBlank: raw.allowBlank ?? !base.required,
        maxLength: raw.maxLength ?? DEFAULT_TEXT_ANSWER_MAX_LENGTH_V1,
      };
    }
    case "singleChoice": {
      const options = decodeOptions(raw.options);
      if (!options) {
        return `singleChoice question "${raw.questionId}" has invalid or out-of-range "options"`;
      }
      const unknownField = rejectUnknownFields(
        raw,
        new Set(["questionId", "kind", "prompt", "helpText", "required", "options"]),
        `singleChoice question "${raw.questionId}"`
      );
      if (unknownField) {
        return unknownField;
      }
      return { ...base, kind: "singleChoice", options };
    }
    case "multipleChoice": {
      const options = decodeOptions(raw.options);
      if (!options) {
        return `multipleChoice question "${raw.questionId}" has invalid or out-of-range "options"`;
      }
      if (
        typeof raw.minSelections !== "number" || !Number.isInteger(raw.minSelections) ||
        typeof raw.maxSelections !== "number" || !Number.isInteger(raw.maxSelections)
      ) {
        return `multipleChoice question "${raw.questionId}" has non-integer selection bounds`;
      }
      if (
        raw.minSelections < 0 ||
        raw.maxSelections < raw.minSelections ||
        raw.maxSelections > options.length
      ) {
        return `multipleChoice question "${raw.questionId}" has selection bounds outside its option count`;
      }
      const unknownField = rejectUnknownFields(
        raw,
        new Set(["questionId", "kind", "prompt", "helpText", "required", "options", "minSelections", "maxSelections"]),
        `multipleChoice question "${raw.questionId}"`
      );
      if (unknownField) {
        return unknownField;
      }
      return {
        ...base,
        kind: "multipleChoice",
        options,
        minSelections: raw.minSelections,
        maxSelections: raw.maxSelections,
      };
    }
    default:
      return `question "${String(raw.questionId)}" has an unrecognized "kind": ${JSON.stringify(raw.kind)}`;
  }
}

/**
 * Validate a raw `questions` array against every §3.6 rule: 1-16 questions,
 * unique bounded IDs, and per-kind option/cardinality bounds. Canonical byte
 * size is checked by the caller (it has the original serialized block).
 */
export function decodeStructuredQuestionsV1(raw: unknown): StructuredQuestionValidationResult {
  if (!Array.isArray(raw)) {
    return { ok: false, reason: "\"questions\" is not an array" };
  }
  if (raw.length < MIN_QUESTIONS_V1 || raw.length > MAX_QUESTIONS_V1) {
    return {
      ok: false,
      reason: `"questions" must contain ${MIN_QUESTIONS_V1}-${MAX_QUESTIONS_V1} entries, found ${raw.length}`,
    };
  }
  const questions: StructuredQuestionV1[] = [];
  const seenIds = new Set<string>();
  for (const entry of raw) {
    const decoded = decodeQuestion(entry);
    if (typeof decoded === "string") {
      return { ok: false, reason: decoded };
    }
    if (seenIds.has(decoded.questionId)) {
      return { ok: false, reason: `duplicate "questionId": ${decoded.questionId}` };
    }
    seenIds.add(decoded.questionId);
    questions.push(decoded);
  }
  return { ok: true, questions };
}

/**
 * Validate a raw answer submission against its matching question set:
 * exactly one answer per question, matching kinds, skip only where
 * optional, blank text only where allowed, and selections referencing real
 * option IDs.
 */
export function validateStructuredAnswersV1(
  questions: readonly StructuredQuestionV1[],
  answers: readonly StructuredAnswerV1[]
): { ok: boolean; reason?: string } {
  if (answers.length !== questions.length) {
    return { ok: false, reason: `expected ${questions.length} answer(s), found ${answers.length}` };
  }
  const byId = new Map(questions.map((q) => [q.questionId, q] as const));
  const answeredIds = new Set<string>();
  for (const answer of answers) {
    if (answeredIds.has(answer.questionId)) {
      return { ok: false, reason: `duplicate answer for questionId ${answer.questionId}` };
    }
    answeredIds.add(answer.questionId);
    const question = byId.get(answer.questionId);
    if (!question) {
      return { ok: false, reason: `answer references unknown questionId ${answer.questionId}` };
    }
    if (question.kind !== answer.kind) {
      return { ok: false, reason: `answer kind mismatch for questionId ${answer.questionId}` };
    }
    if (answer.state === "skipped") {
      if (question.required) {
        return { ok: false, reason: `required question ${question.questionId} was skipped` };
      }
      continue;
    }
    if (question.kind === "text" && answer.kind === "text") {
      if (answer.value.length === 0 && !question.allowBlank) {
        return { ok: false, reason: `question ${question.questionId} does not allow a blank answer` };
      }
      if (answer.value.length > question.maxLength) {
        return { ok: false, reason: `answer for ${question.questionId} exceeds maxLength` };
      }
    } else if (question.kind === "singleChoice" && answer.kind === "singleChoice") {
      if (!question.options.some((o) => o.optionId === answer.selectedOptionId)) {
        return { ok: false, reason: `answer for ${question.questionId} selects an unknown option` };
      }
    } else if (question.kind === "multipleChoice" && answer.kind === "multipleChoice") {
      const optionIds = new Set(question.options.map((o) => o.optionId));
      const selected = new Set(answer.selectedOptionIds);
      if (selected.size !== answer.selectedOptionIds.length) {
        return { ok: false, reason: `answer for ${question.questionId} selects a duplicate option` };
      }
      for (const id of selected) {
        if (!optionIds.has(id)) {
          return { ok: false, reason: `answer for ${question.questionId} selects an unknown option` };
        }
      }
      if (selected.size < question.minSelections || selected.size > question.maxSelections) {
        return { ok: false, reason: `answer for ${question.questionId} violates selection bounds` };
      }
    }
  }
  for (const question of questions) {
    if (!answeredIds.has(question.questionId)) {
      return { ok: false, reason: `missing answer for questionId ${question.questionId}` };
    }
  }
  return { ok: true };
}

/**
 * Strictly decode a raw unknown value as an array of structured answers.
 * Rejects unknown fields per answer variant and validates the shape-level
 * structure: a 1-16 entry array (one record per question), plain-object
 * records, string enums for kind/state, bounded-ASCII identifiers for
 * questionId and every selected option id, and duplicate-free selections of
 * at most MAX_OPTIONS_V1 entries. Anything failing these rules could never
 * validate against a legal question set, so rejecting it here keeps this
 * decoder in exact parity with structured-answer-v1.schema.json (enforced
 * by verify:structured-questions). The resulting typed answers must still
 * be validated against their question set via
 * {@link validateStructuredAnswersV1}.
 */
export type DecodeAnswersResultV1 =
  | { readonly ok: true; readonly answers: readonly StructuredAnswerV1[] }
  | { readonly ok: false; readonly reason: string };

const ANSWER_KINDS_V1 = new Set(["text", "singleChoice", "multipleChoice"]);

export function decodeStructuredAnswersArrayV1(raw: unknown): DecodeAnswersResultV1 {
  if (!Array.isArray(raw)) {
    return { ok: false, reason: "\"answers\" is not an array" };
  }
  if (raw.length < MIN_QUESTIONS_V1 || raw.length > MAX_QUESTIONS_V1) {
    return {
      ok: false,
      reason:
        `"answers" must contain ${MIN_QUESTIONS_V1}-${MAX_QUESTIONS_V1} entries ` +
        `(one per question), found ${raw.length}`,
    };
  }
  const answers: StructuredAnswerV1[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry: unknown = raw[i];
    if (!isPlainRecord(entry)) {
      return { ok: false, reason: `answer at index ${i} is not an object` };
    }
    if (typeof entry.questionId !== "string" || typeof entry.kind !== "string" || typeof entry.state !== "string") {
      return { ok: false, reason: `answer at index ${i} is missing required string fields` };
    }
    if (!isStableId(entry.questionId)) {
      return {
        ok: false,
        reason: `answer at index ${i} has an invalid "questionId" (bounded ASCII identifier required)`,
      };
    }
    const questionId: string = entry.questionId;
    const kind: string = entry.kind;
    const state: string = entry.state;

    if (!ANSWER_KINDS_V1.has(kind)) {
      return { ok: false, reason: `answer at index ${i} has an unrecognized kind: ${kind}` };
    }

    if (state === "skipped") {
      const unknownField = rejectUnknownFields(
        entry,
        new Set(["questionId", "kind", "state"]),
        `answer at index ${i}`
      );
      if (unknownField) {
        return { ok: false, reason: unknownField };
      }
      answers.push({ questionId, kind: kind as "text" | "singleChoice" | "multipleChoice", state: "skipped" });
    } else if (state === "answered") {
      switch (kind) {
        case "text": {
          if (typeof entry.value !== "string") {
            return { ok: false, reason: `text answer for "${questionId}" is missing a string "value"` };
          }
          const unknownField = rejectUnknownFields(
            entry,
            new Set(["questionId", "kind", "state", "value"]),
            `text answer for "${questionId}"`
          );
          if (unknownField) {
            return { ok: false, reason: unknownField };
          }
          answers.push({ questionId, kind: "text", state: "answered", value: entry.value });
          break;
        }
        case "singleChoice": {
          if (typeof entry.selectedOptionId !== "string") {
            return { ok: false, reason: `singleChoice answer for "${questionId}" is missing a string "selectedOptionId"` };
          }
          if (!isStableId(entry.selectedOptionId)) {
            return {
              ok: false,
              reason:
                `singleChoice answer for "${questionId}" has an invalid "selectedOptionId" ` +
                "(bounded ASCII identifier required)",
            };
          }
          const unknownField = rejectUnknownFields(
            entry,
            new Set(["questionId", "kind", "state", "selectedOptionId"]),
            `singleChoice answer for "${questionId}"`
          );
          if (unknownField) {
            return { ok: false, reason: unknownField };
          }
          answers.push({ questionId, kind: "singleChoice", state: "answered", selectedOptionId: entry.selectedOptionId });
          break;
        }
        case "multipleChoice": {
          if (
            !Array.isArray(entry.selectedOptionIds) ||
            !(entry.selectedOptionIds as unknown[]).every((id: unknown) => typeof id === "string")
          ) {
            return { ok: false, reason: `multipleChoice answer for "${questionId}" has an invalid "selectedOptionIds"` };
          }
          const selectedIds = entry.selectedOptionIds as readonly string[];
          if (selectedIds.length > MAX_OPTIONS_V1) {
            return {
              ok: false,
              reason: `multipleChoice answer for "${questionId}" selects more than ${MAX_OPTIONS_V1} options`,
            };
          }
          if (!selectedIds.every((id) => isStableId(id))) {
            return {
              ok: false,
              reason:
                `multipleChoice answer for "${questionId}" has an invalid selected option id ` +
                "(bounded ASCII identifier required)",
            };
          }
          if (new Set(selectedIds).size !== selectedIds.length) {
            return { ok: false, reason: `multipleChoice answer for "${questionId}" selects a duplicate option` };
          }
          const unknownField = rejectUnknownFields(
            entry,
            new Set(["questionId", "kind", "state", "selectedOptionIds"]),
            `multipleChoice answer for "${questionId}"`
          );
          if (unknownField) {
            return { ok: false, reason: unknownField };
          }
          answers.push({
            questionId,
            kind: "multipleChoice",
            state: "answered",
            selectedOptionIds: [...selectedIds],
          });
          break;
        }
      }
    } else {
      return { ok: false, reason: `answer at index ${i} has an unrecognized state: ${state}` };
    }
  }
  return { ok: true, answers };
}

/**
 * Thrown when a value has no canonical JSON form: cyclic references,
 * non-finite numbers, or non-JSON types (undefined, function, symbol,
 * bigint). Callers measuring raw untrusted values catch this and convert it
 * into a clean validation failure instead of letting a stack overflow or a
 * silently wrong canonical form escape.
 */
export class CanonicalJsonErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonErrorV1";
  }
}

/**
 * Render a value's canonical JSON text (sorted keys, no insignificant
 * whitespace). This is the serialization the §5.5 Chat interaction
 * transaction record persists for input snapshots and digests. Throws
 * {@link CanonicalJsonErrorV1} for cyclic or non-JSON values. (Canonical
 * JSON V1 proper — plan §7.1 — lands with the preflight cohort; this covers
 * the closed question/answer/transaction shapes.)
 */
export function canonicalJsonTextV1(value: unknown): string {
  return canonicalJsonStringifyV1(value, new Set());
}

/**
 * Compute the canonical JSON byte length of a value (sorted keys, no
 * insignificant whitespace). Used to enforce the 256 KiB question-set and
 * 128 KiB answer-submission limits defined in §3.6. Throws
 * {@link CanonicalJsonErrorV1} for cyclic or non-JSON values.
 */
export function canonicalJsonByteLengthV1(value: unknown): number {
  return utf8ByteLengthV1(canonicalJsonTextV1(value));
}

function canonicalJsonStringifyV1(value: unknown, ancestors: Set<object>): string {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonErrorV1("non-finite numbers have no canonical JSON form");
      }
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new CanonicalJsonErrorV1(`values of type ${typeof value} have no canonical JSON form`);
  }
  if (ancestors.has(value)) {
    throw new CanonicalJsonErrorV1("cyclic values have no canonical JSON form");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return "[" + value.map((entry) => canonicalJsonStringifyV1(entry, ancestors)).join(",") + "]";
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const pairs = keys.map((k) => JSON.stringify(k) + ":" + canonicalJsonStringifyV1(record[k], ancestors));
    return "{" + pairs.join(",") + "}";
  } finally {
    ancestors.delete(value);
  }
}
