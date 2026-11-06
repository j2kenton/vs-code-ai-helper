/**
 * review1 Step 44 (RC4 #4): owner evidence the plan asks for, gathered before Implementation instead of one
 * blocker at a time after reviews. Pure helpers: find the plan steps that need "Owner evidence:" the owner has not
 * given, and write the one chat question that lists them. Answers are recorded under `## Owner evidence` in
 * task.md with the existing writer; saving one never re-runs a review (none has run yet).
 */
import {
  DEFAULT_TEXT_ANSWER_MAX_LENGTH_V1,
  type StructuredAnswerV1,
  type StructuredQuestionV1,
} from "../types/structuredQuestionV1";

export interface OwnerEvidenceStepV1 {
  /** The plan item's own first line, without its checkbox. */
  readonly itemText: string;
  /** What the step asks the owner for (the text after "Owner evidence:"). */
  readonly evidence: string;
}

const CHECKBOX_LINE_RE = /^(\s*)[-*]\s+\[([ xX])\]\s+(.*)$/;
const BULLET_LINE_RE = /^(\s*)[-*]\s+(.*)$/;
const OWNER_EVIDENCE_LABEL_RE = /\*{0,2}owner[- ]evidence\*{0,2}\s*:\s*\*{0,2}\s*(.*)$/i;
const EXCLUDED_MARKER_RE = /<!--\s*ensemble:excluded\s*-->/i;

function normalizeForMatchV1(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function stripMarkdownV1(text: string): string {
  return text.replace(/\*\*|__|`/g, "").replace(/<!--.*?-->/g, "").replace(/\s+/g, " ").trim();
}

/**
 * The open (neither ticked nor excluded) top-level plan items that ask the owner for evidence, in plan order.
 * An "Owner evidence:" label counts on the item's own line or on a line nested under it. Prose that merely
 * explains the rule (not inside an open checklist item) is ignored.
 */
export function listOwnerEvidenceStepsV1(planText: string): OwnerEvidenceStepV1[] {
  const steps: OwnerEvidenceStepV1[] = [];
  let current: { itemText: string; open: boolean; indent: number; found: boolean } | undefined;
  for (const line of planText.split(/\r?\n/)) {
    const checkbox = CHECKBOX_LINE_RE.exec(line);
    if (checkbox && (current === undefined || checkbox[1]!.length <= current.indent)) {
      const ticked = checkbox[2] !== " ";
      const excluded = EXCLUDED_MARKER_RE.test(line);
      current = {
        itemText: stripMarkdownV1(checkbox[3]!),
        open: !ticked && !excluded,
        indent: checkbox[1]!.length,
        found: false,
      };
      const own = OWNER_EVIDENCE_LABEL_RE.exec(checkbox[3]!);
      if (own && current.open) {
        const evidence = stripMarkdownV1(own[1]!);
        if (evidence.length > 0) {
          steps.push({ itemText: current.itemText, evidence });
          current.found = true;
        }
      }
      continue;
    }
    if (current === undefined || !current.open || current.found) continue;
    if (line.trim().length === 0) continue;
    // A line that is not indented deeper than the item ends it.
    const indent = /^(\s*)/.exec(line)![1]!.length;
    if (indent <= current.indent && !BULLET_LINE_RE.test(line)) {
      current = undefined;
      continue;
    }
    const label = OWNER_EVIDENCE_LABEL_RE.exec(line);
    if (label) {
      const evidence = stripMarkdownV1(label[1]!);
      if (evidence.length > 0) {
        steps.push({ itemText: current.itemText, evidence });
        current.found = true;
      }
    }
  }
  return steps;
}

/** The text of the `## Owner evidence` section of task.md ("" when there is none). */
function ownerEvidenceSectionV1(taskMd: string): string {
  const heading = /^## Owner evidence[ \t]*$/im.exec(taskMd);
  if (!heading) return "";
  const rest = taskMd.slice(heading.index + heading[0].length);
  const next = /^## /m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

/** The steps whose evidence task.md's `## Owner evidence` section does not yet quote as answered. */
export function listUnansweredOwnerEvidenceStepsV1(planText: string, taskMd: string): OwnerEvidenceStepV1[] {
  const answered = normalizeForMatchV1(ownerEvidenceSectionV1(taskMd));
  return listOwnerEvidenceStepsV1(planText).filter((step) => {
    const key = normalizeForMatchV1(step.evidence).slice(0, 80).trim();
    return key.length === 0 || !answered.includes(key);
  });
}

/**
 * The unanswered steps that come AFTER `afterEvidence` in plan order. A form holds at most
 * {@link MAX_OWNER_EVIDENCE_UP_FRONT_FIELDS_V1} fields; once it is submitted, the steps it had no room for are
 * asked next. Moving forward from the last field shown (rather than re-listing everything unanswered) means a
 * step the owner skipped is not asked again by the continuation.
 */
export function listUnansweredOwnerEvidenceStepsAfterV1(
  planText: string,
  taskMd: string,
  afterEvidence: string
): OwnerEvidenceStepV1[] {
  const all = listOwnerEvidenceStepsV1(planText);
  const lastShown = all.findIndex((step) => step.evidence === afterEvidence);
  if (lastShown < 0) return [];
  const later = new Set(all.slice(lastShown + 1).map((step) => step.evidence));
  return listUnansweredOwnerEvidenceStepsV1(planText, taskMd).filter((step) => later.has(step.evidence));
}

/** One stable fingerprint of a set of steps, so the same question is not asked twice. */
export function ownerEvidenceStepsKeyV1(steps: readonly OwnerEvidenceStepV1[]): string {
  return steps.map((step) => normalizeForMatchV1(step.evidence).slice(0, 80)).join("|");
}

/** Question ids of the up-front form start with this; the chat settles such a form by writing task.md. */
export const OWNER_EVIDENCE_UP_FRONT_QUESTION_ID_PREFIX_V1 = "owner-evidence-up-front-";

/** A form holds at most this many questions (`MAX_QUESTIONS_V1`); steps beyond it are asked once these are answered. */
export const MAX_OWNER_EVIDENCE_UP_FRONT_FIELDS_V1 = 16;

/** The steps one form asks about, in plan order. */
export function ownerEvidenceFormStepsV1(steps: readonly OwnerEvidenceStepV1[]): OwnerEvidenceStepV1[] {
  return steps.slice(0, MAX_OWNER_EVIDENCE_UP_FRONT_FIELDS_V1);
}

/**
 * review1 Step 44 (owner decision 2026-11-04: a field for each step): the form for the unanswered steps, one
 * optional text question per step. `helpText` carries the exact evidence text, which is what task.md records as
 * the blocker answered (so the answered-check above finds it later).
 */
export function buildOwnerEvidenceUpFrontQuestionsV1(steps: readonly OwnerEvidenceStepV1[]): StructuredQuestionV1[] {
  return ownerEvidenceFormStepsV1(steps).map((step, index) => ({
    questionId: `${OWNER_EVIDENCE_UP_FRONT_QUESTION_ID_PREFIX_V1}${index + 1}`,
    kind: "text" as const,
    prompt: `${step.itemText}\nNeeds: ${step.evidence}`,
    helpText: step.evidence,
    required: false,
    allowBlank: true,
    maxLength: DEFAULT_TEXT_ANSWER_MAX_LENGTH_V1,
  }));
}

/** Whether a question set is the up-front owner-evidence form. */
export function isOwnerEvidenceUpFrontFormV1(questions: readonly StructuredQuestionV1[]): boolean {
  return (
    questions.length > 0 &&
    questions.every((q) => q.questionId.startsWith(OWNER_EVIDENCE_UP_FRONT_QUESTION_ID_PREFIX_V1))
  );
}

/** The answered (non-blank) fields of the form, each with the evidence text it answers. Skipped or blank fields are left for later. */
export function collectOwnerEvidenceFormAnswersV1(
  questions: readonly StructuredQuestionV1[],
  answers: readonly StructuredAnswerV1[]
): Array<{ readonly blocker: string; readonly answer: string }> {
  if (!isOwnerEvidenceUpFrontFormV1(questions)) return [];
  const collected: Array<{ blocker: string; answer: string }> = [];
  for (const question of questions) {
    if (question.kind !== "text" || question.helpText === undefined) continue;
    const answer = answers.find((a) => a.questionId === question.questionId);
    if (answer?.kind === "text" && answer.state === "answered" && answer.value.trim().length > 0) {
      collected.push({ blocker: question.helpText, answer: answer.value.trim() });
    }
  }
  return collected;
}
