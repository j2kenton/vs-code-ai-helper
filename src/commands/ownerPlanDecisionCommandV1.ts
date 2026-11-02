import * as vscode from "vscode";
import { createHash } from "crypto";
import {
  BlockerSupersessionRecordV1,
  IMPL_REVIEW_STAGES,
  TaskProgress,
  TaskStage,
  isReviewStage,
} from "../types/taskProgress";
import type { WorkflowDecisionCommandResultV1, WorkflowDecisionV1 } from "../types/workflowDecisionV1";
import { normalizePath } from "../utils/taskRoot";
import { hasLiveWorkAdmissionBestEffortV1 } from "../state/workAdmissionV1";
import { armDeferredOptionRunV1 } from "../utils/deferredOptionRunV1";
import { taskOperations } from "../utils/taskOperations";
import { withTaskLock } from "../state/taskStateStore";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import { recordPlanItemOwnerDecisionV1 } from "../utils/taskProgressTransforms";
import { getPlanRevisionV1, settleChecklistItemV1 } from "../utils/implementationChecklist";
import { getCanonicalImplementationUri } from "../utils/implementationArtifactResolver";
import { readTextIfExists, writeTextFileIfUnchangedV1 } from "../utils/fileUtils";
import { appendChatMessageV1 } from "../utils/chatHistoryStore";
import { postWorkflowDecisionV1, PostWorkflowDecisionInputV1 } from "../utils/workflowDecisionDispatchV1";
import {
  ParsedOwnerDecisionBlockV1,
  parseOwnerDecisionsNeededV1,
  parsePlanDeviationsV1,
} from "../utils/reviewReadiness";

export const RECORD_OWNER_PLAN_DECISION_COMMAND_V1 = "vs-code-ai-helper.recordOwnerPlanDecisionV1";

const OWNER_DECISIONS_HEADING_RE = /(?:^|\n)##[ \t]+Owner Decisions[ \t]*\n/i;
const MAX_SUPERSESSION_DESCRIPTION_LENGTH = 300;
const PLAN_WRITE_ATTEMPTS = 3;

export interface RecordOwnerPlanDecisionArgV1 {
  readonly taskFolderPath: string;
  readonly stage: TaskStage;
  readonly blockerId: string;
  readonly optionId: string;
  readonly optionLabel: string;
  readonly planAction?: {
    readonly kind: "exclude" | "reword" | "approveDeviation" | "note";
    readonly itemText?: string;
    readonly items?: readonly string[];
    readonly newText?: string;
  };
  /** The chosen option keeps the plan as written: record the decision, but do not set the blocker aside. */
  readonly rejects?: boolean;
  readonly rawContentHash?: string;
  readonly note?: string;
}

export interface OwnerPlanDecisionPlanChangeV1 {
  /** The plan text after the change (unchanged when the plan could not be read). */
  readonly planText: string | undefined;
  /** Checklist items the decision excluded or reworded, as they now read. */
  readonly settledItems: readonly string[];
}

/** The review stages an owner decision is shown to: a round's own stage maps to both implementation reviews. */
function stagesForOwnerDecisionV1(stage: TaskStage): readonly TaskStage[] {
  return isReviewStage(stage) ? [stage] : IMPL_REVIEW_STAGES;
}

/** The line a decision adds under `## Owner Decisions` when it names no checklist item. */
function ownerDecisionSectionLineV1(arg: RecordOwnerPlanDecisionArgV1, decisionNote: string): string {
  return `- ${decisionNote} (${arg.blockerId}${arg.rejects ? "; plan kept as written" : ""})`;
}

function addOwnerDecisionSectionLineV1(planText: string, line: string): string {
  if (planText.includes(line)) {
    return planText;
  }
  const heading = OWNER_DECISIONS_HEADING_RE.exec(planText);
  if (heading) {
    const insertAt = heading.index + heading[0].length;
    return `${planText.slice(0, insertAt)}${line}\n${planText.slice(insertAt)}`;
  }
  return `${planText.replace(/\s*$/, "")}\n\n## Owner Decisions\n\n${line}\n`;
}

/**
 * Applies the plan-final.md half of an owner decision: the named items are excluded (or reworded) with an
 * "Owner decision YYYY-MM-DD" note, or, when no item is named or the owner kept the plan, the decision is
 * written under `## Owner Decisions`. Uses the conditional plan writer, so a concurrent edit is retried rather
 * than overwritten.
 */
export async function applyOwnerPlanDecisionToPlanV1(
  planUri: vscode.Uri,
  arg: RecordOwnerPlanDecisionArgV1,
  decisionNote: string
): Promise<OwnerPlanDecisionPlanChangeV1> {
  const targetItems = arg.rejects
    ? []
    : arg.planAction?.items && arg.planAction.items.length > 0
      ? [...arg.planAction.items]
      : arg.planAction?.itemText
        ? [arg.planAction.itemText]
        : [];
  for (let attempt = 0; attempt < PLAN_WRITE_ATTEMPTS; attempt++) {
    const plan = await readTextIfExists(planUri);
    if (plan === undefined) {
      return { planText: undefined, settledItems: [] };
    }
    let next = plan;
    const settledItems: string[] = [];
    for (const itemText of targetItems) {
      if (arg.planAction?.kind === "reword" && arg.planAction.newText) {
        if (next.includes(itemText)) {
          const reworded = `${arg.planAction.newText} — ${decisionNote}`;
          next = next.replace(itemText, () => reworded);
          settledItems.push(arg.planAction.newText);
        }
        continue;
      }
      const settled = settleChecklistItemV1(next, itemText, "exclude", decisionNote);
      if (settled.settledItemText !== undefined) {
        next = settled.content;
        settledItems.push(settled.settledItemText);
      }
    }
    if (settledItems.length === 0) {
      next = addOwnerDecisionSectionLineV1(next, ownerDecisionSectionLineV1(arg, decisionNote));
    }
    if (next === plan || (await writeTextFileIfUnchangedV1(planUri, plan, next))) {
      return { planText: next, settledItems };
    }
  }
  throw new Error("plan-final.md kept changing while the owner decision was being recorded; choose the option again.");
}

/** Execute the plan-final.md and task-progress updates for an owner decision under the task lock. */
export async function executeOwnerPlanDecisionLockedV1(arg: RecordOwnerPlanDecisionArgV1): Promise<void> {
  const folderUri = vscode.Uri.file(arg.taskFolderPath);
  const today = new Date().toISOString().slice(0, 10);
  const decisionNote = arg.note ?? `Owner decision ${today}: ${arg.optionLabel}`;
  const nowIso = new Date().toISOString();

  const change = await applyOwnerPlanDecisionToPlanV1(getCanonicalImplementationUri(folderUri), arg, decisionNote);

  if (!arg.rejects) {
    // What the reviewer reads in `{{ownerDecisions}}`: the owner's answer, not only the blocker's id.
    const description = `${arg.blockerId}: the owner chose "${arg.optionLabel}"`.slice(0, MAX_SUPERSESSION_DESCRIPTION_LENGTH);
    const revision = change.planText !== undefined ? getPlanRevisionV1(change.planText) : undefined;
    await patchTaskProgressStrictV1(
      folderUri,
      (progress: TaskProgress) => {
        let next = progress;
        if (revision !== undefined) {
          for (const item of change.settledItems) {
            next = recordPlanItemOwnerDecisionV1(next, {
              planRevision: revision,
              itemText: item,
              at: nowIso,
              formId: `owner-decision:${arg.blockerId}`,
              decision: "exclude",
            });
          }
        }
        const stages = stagesForOwnerDecisionV1(arg.stage);
        const kept = (next.blockerSupersessions ?? []).filter(
          (s: BlockerSupersessionRecordV1) =>
            !(stages.includes(s.stage) && s.blockerDescription.startsWith(`${arg.blockerId}:`))
        );
        const added = stages.map(
          (stage): BlockerSupersessionRecordV1 => ({
            stage,
            blockerDescription: description,
            supersededAt: nowIso,
            planRelPath: "plan-final.md",
            source: "chat-confirmed",
          })
        );
        return { ...next, blockerSupersessions: [...kept, ...added] };
      },
      { skipLock: true }
    );
  }

  const outcome = arg.rejects
    ? `Recorded: "${arg.optionLabel}" for ${arg.blockerId}. The plan stays as written, and the next round builds it that way.`
    : change.settledItems.length > 0
      ? `Recorded: "${arg.optionLabel}" for ${arg.blockerId}. Excluded ${change.settledItems.length} plan item(s) in plan-final.md with your decision noted; the next review will not carry this blocker.`
      : `Recorded: "${arg.optionLabel}" for ${arg.blockerId}. Your decision is noted in plan-final.md; the next review will not carry this blocker.`;
  await appendChatMessageV1(arg.taskFolderPath, {
    role: "assistant",
    text: outcome,
    stage: arg.stage,
    at: nowIso,
  }).catch(() => undefined);
}

/** Command handler for recording an owner plan decision. */
export async function recordOwnerPlanDecisionV1(
  arg: RecordOwnerPlanDecisionArgV1
): Promise<WorkflowDecisionCommandResultV1> {
  if (hasLiveWorkAdmissionBestEffortV1(arg.taskFolderPath)) {
    // A round is open: a write to plan-final.md now would be a foreign write to it. Carry the answer out
    // as soon as the task is free.
    armDeferredOptionRunV1({
      key: `owner-plan-decision:${normalizePath(arg.taskFolderPath)}:${arg.blockerId}`,
      isTaskBusy: () => hasLiveWorkAdmissionBestEffortV1(arg.taskFolderPath),
      subscribeToTaskFree: (listener) => taskOperations.onDidEnd(() => listener()),
      carryOut: async () => {
        await withTaskLock(arg.taskFolderPath, () => executeOwnerPlanDecisionLockedV1(arg));
        return { kind: "done" };
      },
      report: () => Promise.resolve(),
    });

    await appendChatMessageV1(arg.taskFolderPath, {
      role: "assistant",
      text: `Your choice "${arg.optionLabel}" for ${arg.blockerId} is recorded. It is written to plan-final.md as soon as the running round ends.`,
      stage: arg.stage,
      at: new Date().toISOString(),
    }).catch(() => undefined);

    return { outcome: "done" };
  }

  await withTaskLock(arg.taskFolderPath, () => executeOwnerPlanDecisionLockedV1(arg));
  return { outcome: "done" };
}

export function registerOwnerPlanDecisionCommandV1(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      RECORD_OWNER_PLAN_DECISION_COMMAND_V1,
      async (arg: RecordOwnerPlanDecisionArgV1) => recordOwnerPlanDecisionV1(arg)
    )
  );
}

/**
 * bugs5 Step 23: Post a workflow decision card for a single parsed owner-decision block. The card is
 * keyed on the blocker id and carries a hash of the block's content, so the same block is not raised
 * again unless its content changes.
 */
export async function postOwnerPlanDecisionCardV1(options: {
  taskFolderPath: string;
  stage: TaskStage;
  block: ParsedOwnerDecisionBlockV1;
  taskDisplayName?: string;
}): Promise<WorkflowDecisionV1 | undefined> {
  const { taskFolderPath, stage, block } = options;
  const canonicalId = normalizePath(taskFolderPath);

  const recommended = block.recommendation ?? {
    optionId: block.options[0]?.id ?? "approve",
    reason: "Recommended option.",
  };

  const cardInput: PostWorkflowDecisionInputV1 = {
    decisionKey: `ownerPlanDecision:${block.id}`,
    taskCanonicalId: canonicalId,
    stage,
    whatHappened: block.problem,
    whyUserNeeded: block.planPurpose,
    suppressWhileAnswered: {
      conditionFingerprint: block.rawContentHash,
      answeredOptionIds: block.options.map((o) => o.id),
    },
    // Technical detail is labelled "Details", which the chat card renders behind a collapsed toggle.
    evidence: block.technicalDetails ? [{ label: "Details", detail: block.technicalDetails }] : [],
    options: block.options.map((opt) => ({
      optionId: opt.id,
      label: opt.label,
      consequence: opt.consequence,
      resumeKind: "unpause",
      effect: {
        kind: "command",
        command: RECORD_OWNER_PLAN_DECISION_COMMAND_V1,
        args: [
          {
            taskFolderPath,
            stage,
            blockerId: block.id,
            optionId: opt.id,
            optionLabel: opt.label,
            planAction: opt.planAction,
            ...(opt.rejects ? { rejects: true } : {}),
            rawContentHash: block.rawContentHash,
          } satisfies RecordOwnerPlanDecisionArgV1,
        ],
      },
    })),
    recommendation: {
      kind: "option",
      optionId: recommended.optionId,
      reasoning: recommended.reason,
    },
    gating: {
      holdsTaskPaused: true,
      unblocksProgress: true,
      detail: `Waiting for your decision: ${block.id}`,
    },
  };

  return postWorkflowDecisionV1(cardInput, { canonicalId, taskFolderPath, stage });
}

/**
 * bugs5 Step 22: Fast Forward has stopped because every blocker holding the score needs the owner, but the
 * review wrote no `## Owner decisions needed` block to build a card from. Raise one card naming those blockers
 * in plain words, so the stop is a question the owner can act on, not only a chat line. Posted once per set of
 * blockers (the decision key carries a hash of their text).
 */
export async function postOwnerOnlyBlockersCardV1(options: {
  taskFolderPath: string;
  stage: TaskStage;
  blockerDescriptions: readonly string[];
}): Promise<WorkflowDecisionV1 | undefined> {
  const { taskFolderPath, stage, blockerDescriptions } = options;
  if (blockerDescriptions.length === 0) {
    return undefined;
  }
  const canonicalId = normalizePath(taskFolderPath);
  const fingerprint = createHash("sha256").update(blockerDescriptions.join("\n")).digest("hex").slice(0, 16);
  const cardInput: PostWorkflowDecisionInputV1 = {
    decisionKey: `ownerOnlyBlockers:${fingerprint}`,
    taskCanonicalId: canonicalId,
    stage,
    whatHappened:
      `Fast Forward stopped. ${blockerDescriptions.length === 1 ? "The one thing" : `All ${blockerDescriptions.length} things`} ` +
      "holding this review's score can only be settled by you, so another Apply Review round would not help.",
    whyUserNeeded:
      "These are decisions or evidence that only you can give: " +
      blockerDescriptions.map((d) => `“${d}”`).join("; "),
    evidence: [],
    options: [
      {
        optionId: "settleItem",
        label: "Tick or Exclude a Checklist Item…",
        consequence:
          "Opens the form to tick an item you have checked yourself, or exclude one you have decided not to build, " +
          "with a dated note the next review can read. Fast Forward does not restart by itself; run the review again afterwards.",
        resumeKind: "unpause",
        effect: {
          kind: "command",
          command: "vs-code-ai-helper.settleChecklistItem",
          args: [{ canonicalId, taskFolderPath }],
        },
      },
      {
        optionId: "notNow",
        label: "Not now",
        consequence: "Does nothing. The task stays as it is until you settle these.",
        resumeKind: "unpause",
        effect: { kind: "doNothing" },
      },
    ],
    recommendation: {
      kind: "option",
      optionId: "settleItem",
      reasoning: "Only your answer changes the score; running another Apply Review against these would repeat the same result.",
    },
    gating: {
      holdsTaskPaused: false,
      unblocksProgress: true,
      detail: "the next review round",
    },
  };
  return postWorkflowDecisionV1(cardInput, { canonicalId, taskFolderPath, stage });
}

/** bugs5 Step 23: Parse `## Owner decisions needed` blocks from review content and raise a card for each. */
export async function raiseOwnerDecisionCardsFromReviewV1(
  taskFolderPath: string,
  stage: TaskStage,
  reviewContent: string
): Promise<readonly WorkflowDecisionV1[]> {
  const posted: WorkflowDecisionV1[] = [];
  for (const block of parseOwnerDecisionsNeededV1(reviewContent)) {
    const decision = await postOwnerPlanDecisionCardV1({ taskFolderPath, stage, block });
    if (decision) {
      posted.push(decision);
    }
  }
  return posted;
}

/** bugs5 Step 23: Parse the `## Plan deviations` section of a round's summary and raise a card for each. */
export async function raisePlanDeviationCardsV1(
  taskFolderPath: string,
  stage: TaskStage,
  summaryContent: string
): Promise<readonly WorkflowDecisionV1[]> {
  const posted: WorkflowDecisionV1[] = [];
  for (const deviation of parsePlanDeviationsV1(summaryContent)) {
    const decision = await postOwnerPlanDecisionCardV1({ taskFolderPath, stage, block: deviation });
    if (decision) {
      posted.push(decision);
    }
  }
  return posted;
}
