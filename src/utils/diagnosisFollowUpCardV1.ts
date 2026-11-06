/**
 * review1 Step 49: the card that follows a diagnostic round. The diagnosis (`evidence/diagnosis-<n>.md`, written by
 * Ensemble from the round's answer) names the files its suggested fix touches; the owner decides, here, whether a
 * separate Apply Review applies it to exactly those files (recorded in task.md as an owner-approved out-of-plan
 * change), takes it from there, or accepts the failure as environmental.
 *
 * The round itself ran in the provider's enforced read-only mode (owner decision 2026-11-05), so it cannot have
 * changed the working tree and the card offers the fix options directly.
 *
 * Pure builder: the caller reads the diagnosis and posts the result.
 */
import { STAGE_DISPLAY_NAMES, STAGE_ORDER, TaskStage } from "../types/taskProgress";
import { WorkflowDecisionOptionV1, WorkflowDecisionRecommendationV1 } from "../types/workflowDecisionV1";
import { PostWorkflowDecisionInputV1 } from "./workflowDecisionDispatchV1";
import { buildAdvanceOptionV1 } from "./reviewEscalation";
import { parseDiagnosisFilesToChangeV1 } from "./investigateFailureV1";

/** The most files a one-click approval will cover; a larger change is the owner's to make. */
export const APPROVED_FIX_MAX_FILES_V1 = 5;

const CAUSE_EXCERPT_MAX_CHARS = 700;

/** The diagnosis's `Cause` section (or its first paragraph), bounded. */
export function extractDiagnosisCauseV1(diagnosis: string): string {
  const lines = diagnosis.split(/\r?\n/);
  const start = lines.findIndex((line) => /^#{1,6}\s*\**\s*cause\b/i.test(line) || /^\**\s*cause\**\s*:/i.test(line));
  const body: string[] = [];
  if (start !== -1) {
    const inline = lines[start]!.replace(/^#{1,6}\s*|\**/g, "").replace(/^cause\s*:?\s*/i, "").trim();
    if (inline.length > 0) body.push(inline);
    for (let i = start + 1; i < lines.length; i++) {
      if (/^#{1,6}\s/.test(lines[i]!) || /^\**(evidence|suggested fix|confidence)\**\s*:?\s*$/i.test(lines[i]!.trim())) break;
      body.push(lines[i]!);
    }
  } else {
    body.push(...diagnosis.split(/\r?\n\r?\n/)[0]!.split(/\r?\n/));
  }
  const text = body.join("\n").trim();
  return text.length <= CAUSE_EXCERPT_MAX_CHARS ? text : `${text.slice(0, CAUSE_EXCERPT_MAX_CHARS)}…`;
}

function nextStageOf(stage: TaskStage): TaskStage | undefined {
  const index = STAGE_ORDER.indexOf(stage);
  return index >= 0 && index + 1 < STAGE_ORDER.length ? STAGE_ORDER[index + 1] : undefined;
}

export function buildDiagnosisFollowUpDecisionV1(input: {
  readonly stage: TaskStage;
  readonly target: { canonicalId: string; taskFolderPath: string; taskName?: string };
  readonly diagnosisPath: string;
  readonly diagnosis: string | undefined;
  readonly failure: string;
  readonly planItemsOpen?: number;
}): PostWorkflowDecisionInputV1 {
  const { stage, target, diagnosisPath } = input;
  const files = input.diagnosis === undefined ? [] : parseDiagnosisFilesToChangeV1(input.diagnosis);
  const bounded = files.length > 0 && files.length <= APPROVED_FIX_MAX_FILES_V1;
  const cause = input.diagnosis === undefined ? "" : extractDiagnosisCauseV1(input.diagnosis);
  const nextStage = nextStageOf(stage);

  const apply: WorkflowDecisionOptionV1 | undefined = bounded
    ? {
        optionId: "applyDiagnosisFix",
        label: `Apply the suggested fix (outside the plan: ${files.join(", ")})`,
        resumeKind: "continue",
        consequence:
          "Records your approval in task.md under Owner decisions as an owner-approved out-of-plan change limited to " +
          `${files.join(", ")}, then runs one Apply Review that may edit only those files, and re-reviews. It ticks ` +
          "no plan item and is not a plan deviation.",
        effect: {
          kind: "command",
          command: "vs-code-ai-helper.resumeAndApplyCurrentStageAction",
          args: [{ taskFolderPath: target.taskFolderPath, applyDiagnosisFix: { diagnosisPath, files, failure: input.failure } }],
          recordedNext: `An Apply Review is applying the suggested fix to ${files.join(", ")} only.`,
        },
      }
    : undefined;
  const takeOver: WorkflowDecisionOptionV1 = {
    optionId: "takeItFromHere",
    label: "I'll take it from here",
    resumeKind: "unpause",
    consequence:
      `Leaves the task paused and dispatches nothing. The diagnosis stays in ${diagnosisPath}. Resume the task, or ` +
      "choose Keep iterating, once you've dealt with it.",
    effect: { kind: "doNothing", recordedNext: "The task stays paused while you take it from here." },
  };
  const accept: WorkflowDecisionOptionV1 | undefined = nextStage
    ? {
        ...buildAdvanceOptionV1(
          nextStage,
          target.taskFolderPath,
          `Accepts that this failure is environmental and moves the task to ${STAGE_DISPLAY_NAMES[nextStage]}. ` +
            "It stays on record and will gate Publish until it is fixed or you publish over it.",
          stage,
          input.planItemsOpen
        ),
        label: "Accept as environmental",
      }
    : undefined;

  const options: WorkflowDecisionOptionV1[] = [...(apply ? [apply] : []), takeOver, ...(accept ? [accept] : [])];
  const recommendation: WorkflowDecisionRecommendationV1 = apply
    ? {
        kind: "option",
        optionId: "applyDiagnosisFix",
        reasoning:
          `The diagnosis names a bounded change to ${files.length === 1 ? "one file" : `${files.length} files`}. The ` +
          "round that applies it may edit only those, and the re-review that follows checks the result.",
      }
    : {
        kind: "none",
        reasoning:
          input.diagnosis === undefined
            ? "The diagnostic round left no diagnosis, so there is nothing to apply."
            : files.length > APPROVED_FIX_MAX_FILES_V1
            ? `The suggested fix touches ${files.length} files, which is more than a one-click approval covers.`
            : "The diagnosis names no file to change, so what to do next is your judgement.",
      };

  return {
    decisionKey: "diagnosisFollowUp",
    taskCanonicalId: target.canonicalId,
    stage,
    whatHappened:
      input.diagnosis === undefined
        ? `The diagnostic round finished, but ${diagnosisPath} was not written.`
        : `The diagnostic round finished. Its findings are in ${diagnosisPath}.`,
    whyUserNeeded:
      "A fix to this failure sits outside the plan, so only you can approve it. The diagnosis ran in a read-only mode, " +
      "so it changed none of your files.",
    options,
    recommendation,
    evidence: [
      ...(cause ? [{ label: "What the diagnosis found", detail: cause }] : []),
      {
        label: "Files the suggested fix touches",
        detail: files.length > 0 ? files.join("\n") : "none named",
      },
    ],
    gating: {
      holdsTaskPaused: true,
      unblocksProgress: true,
      detail: "This decision is holding the task paused until you choose how to proceed.",
    },
  };
}
