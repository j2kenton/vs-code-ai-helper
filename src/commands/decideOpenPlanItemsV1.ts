import * as vscode from "vscode";
import { STAGE_DISPLAY_NAMES, TaskStage } from "../types/taskProgress";
import {
  CreateWorkflowDecisionInputV1,
  WorkflowDecisionCommandResultV1,
  WorkflowDecisionOptionV1,
} from "../types/workflowDecisionV1";
import { getCanonicalImplementationUri } from "../utils/implementationArtifactResolver";
import { readTextIfExists, writeTextFileIfUnchangedV1 } from "../utils/fileUtils";
import { createHash, randomBytes } from "crypto";
import {
  appendOpenPlanItemsFormV1,
  OpenPlanItemsFormItemV1,
  readOpenPlanItemsFormsV1,
  setOpenPlanItemsFormStateV1,
} from "../utils/chatHistoryStore";
import {
  applyOpenPlanItemsFormV1,
  countChecklistProgressV1,
  listOpenPlanItemRecordsV1,
  normalizeChecklistItemTextV1,
  OpenPlanItemsFormAnswerV1,
  truncateChecklistItemTextV1,
} from "../utils/implementationChecklist";
import { NotificationRouter } from "../utils/notificationRouter";
import { formatNotificationTaskLabelV1 } from "../utils/notificationTaskContextV1";
import { FastForwardRunStateV1 } from "../utils/activeFastForwardRunsV1";
import { computeNextStage } from "../utils/stageTransition";
import { resolveConfiguredReviewStages } from "../utils/modelSelection";
import { postWorkflowDecisionV1 } from "../utils/workflowDecisionDispatchV1";
import { ChatTarget } from "../views/chatView";

const COMMAND = "vs-code-ai-helper.decideOpenPlanItems";

/** One open plan item as the "nothing more to build" card knows it: its text and the round's own reason (empty = none given). */
export interface OpenPlanItemReasonForDecisionV1 {
  readonly itemText: string;
  readonly reason: string;
}

export interface DecideOpenPlanItemsArgV1 {
  readonly taskFolderPath: string;
  readonly displayName?: string;
  readonly items: readonly OpenPlanItemReasonForDecisionV1[];
  /** The stage this card was raised against — needed to arrange the stage's
   * continuing action, or the follow-up Advance card, once decisions are
   * applied. */
  readonly stage: TaskStage;
  /**
   * RC2 item 13, Step 52: captured at card-build time (see
   * `buildOpenPlanItemsNeedDecisionCardInputV1`'s doc comment) — when set,
   * applying the owner's decisions resumes Fast Forward from Apply Review
   * with these live counters; otherwise it arranges the stage's own ordinary
   * continuing action.
   */
  readonly resumeFastForwardV1?: FastForwardRunStateV1;
}

/**
 * RC3 item 5, Step 10: the "Decide item by item" option's effect. It posts a
 * form into the task's chat (the `openPlanItemsFormV1` entry) — every open
 * item with its reason, Exclude / "I did it — tick it" / Leave open, and a
 * note field — and returns; nothing waits on a pop-up. The answers are
 * applied by {@link applyOpenPlanItemsFormSubmissionV1} when the owner
 * presses Apply in the chat.
 */
export async function decideOpenPlanItemsV1(
  arg?: DecideOpenPlanItemsArgV1
): Promise<WorkflowDecisionCommandResultV1 | boolean> {
  if (!arg?.taskFolderPath || arg.items.length === 0) {
    return false;
  }
  const taskName = formatNotificationTaskLabelV1(arg.displayName, arg.taskFolderPath);
  const planUri = getCanonicalImplementationUri(vscode.Uri.file(arg.taskFolderPath));
  const plan = await readTextIfExists(planUri);
  if (plan === undefined) {
    NotificationRouter.showWarning(`${taskName}: plan-final.md could not be read, so no form was posted.`);
    return false;
  }
  // Resolve each item the round named to the plan's own occurrence-aware
  // record, so two items with identical text get distinct ids.
  const records = listOpenPlanItemRecordsV1(plan);
  const used = new Set<string>();
  const formItems: OpenPlanItemsFormItemV1[] = [];
  for (const item of arg.items) {
    const key = normalizeChecklistItemTextV1(item.itemText);
    const record = records.find(
      (r) => !r.settled && !used.has(r.itemId) && normalizeChecklistItemTextV1(r.itemText) === key
    );
    if (!record) {
      continue;
    }
    used.add(record.itemId);
    formItems.push({
      itemId: record.itemId,
      itemText: record.itemText,
      occurrence: record.occurrence,
      reason: item.reason,
    });
  }
  if (formItems.length === 0) {
    NotificationRouter.showInformation(`${taskName}: none of these items is still open in the plan.`);
    return { outcome: "done" };
  }
  await appendOpenPlanItemsFormV1(arg.taskFolderPath, arg.taskFolderPath, {
    formId: randomBytes(16).toString("hex"),
    stage: arg.stage,
    items: formItems,
    planFingerprint: fingerprintPlanV1(plan),
    ...(arg.resumeFastForwardV1
      ? {
          resumeFastForwardV1: {
            attemptNumber: arg.resumeFastForwardV1.attemptNumber,
            maxAttempts: arg.resumeFastForwardV1.maxAttempts,
          },
        }
      : {}),
  });
  return { outcome: "done" };
}

function fingerprintPlanV1(plan: string): string {
  return createHash("sha256").update(plan, "utf8").digest("hex");
}

export type OpenPlanItemsFormSubmissionResultV1 =
  /** Validation or write failure: the form stays open and the webview keeps every selection. */
  | { readonly kind: "rejected"; readonly message: string }
  /** The form was already applied (or is gone): a repeat submit is a no-op. */
  | { readonly kind: "ignored"; readonly message: string }
  | { readonly kind: "applied"; readonly message: string };

function decodeFormAnswersV1(raw: unknown): OpenPlanItemsFormAnswerV1[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const answers: OpenPlanItemsFormAnswerV1[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      return undefined;
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.itemId !== "string" || typeof e.choice !== "string") {
      return undefined;
    }
    if (e.note !== undefined && typeof e.note !== "string") {
      return undefined;
    }
    answers.push({
      itemId: e.itemId,
      choice: e.choice as OpenPlanItemsFormAnswerV1["choice"],
      ...(typeof e.note === "string" ? { note: e.note } : {}),
    });
  }
  return answers;
}

/**
 * RC3 item 5, Step 10: applies one submission of an in-chat open-items form.
 * Answers already given are never lost — an item left as "Leave open" stays
 * open and the rest are written in ONE atomic plan write. A rejected
 * submission (validation or a plan that changed under the write) leaves the
 * form `open`, so the owner can press Apply again.
 */
export async function applyOpenPlanItemsFormSubmissionV1(input: {
  readonly taskFolderPath: string;
  readonly canonicalId: string;
  readonly displayName?: string;
  readonly formId: string;
  readonly answers: unknown;
}): Promise<OpenPlanItemsFormSubmissionResultV1> {
  const forms = await readOpenPlanItemsFormsV1(input.taskFolderPath, input.canonicalId);
  const form = forms.find((f) => f.formId === input.formId);
  if (!form) {
    return { kind: "ignored", message: "This form is no longer available." };
  }
  if (form.state !== "open") {
    return { kind: "ignored", message: "This form was already applied." };
  }
  const answers = decodeFormAnswersV1(input.answers);
  if (!answers) {
    return { kind: "rejected", message: "Could not apply: the submitted answers were malformed." };
  }
  const taskName = formatNotificationTaskLabelV1(input.displayName, input.taskFolderPath);
  const planUri = getCanonicalImplementationUri(vscode.Uri.file(input.taskFolderPath));
  const plan = await readTextIfExists(planUri);
  if (plan === undefined) {
    return { kind: "rejected", message: "plan-final.md could not be read, so nothing was applied. Try Apply again." };
  }
  const applied = applyOpenPlanItemsFormV1(
    plan,
    new Set(form.items.map((item) => item.itemId)),
    answers,
    new Date().toISOString().slice(0, 10)
  );
  if (!applied.ok) {
    return { kind: "rejected", message: applied.rejectionReason };
  }
  const changed = applied.ticked.length + applied.excluded.length > 0;
  if (changed && !(await writeTextFileIfUnchangedV1(planUri, plan, applied.content))) {
    return { kind: "rejected", message: "plan changed, try Apply again." };
  }
  await setOpenPlanItemsFormStateV1(input.taskFolderPath, input.canonicalId, form.formId, "applied");
  const textById = new Map(form.items.map((item) => [item.itemId, item.itemText]));
  const parts: string[] = [];
  if (applied.ticked.length > 0) {
    parts.push(`ticked ${applied.ticked.length}`);
  }
  if (applied.excluded.length > 0) {
    parts.push(`excluded ${applied.excluded.length}`);
  }
  const skippedLines = applied.skipped.map(
    (s) => `"${truncateChecklistItemTextV1(textById.get(s.itemId) ?? s.itemText, 60)}" — ${s.reason}`
  );
  const summary =
    (parts.length > 0 ? `${parts.join(", ")} in plan-final.md.` : "No items were changed.") +
    (skippedLines.length > 0 ? ` ${skippedLines.join("; ")}.` : "");
  NotificationRouter.showInformation(`${taskName}: ${summary}`);
  if (changed) {
    // RC2 item 13, Step 52: arrange whatever comes next (Fast Forward's own
    // remaining budget when it raised this round, an ordinary dispatch
    // otherwise, or the Advance offer once nothing is left open).
    await continueAfterOpenPlanItemDecisionsV1(
      {
        taskFolderPath: input.taskFolderPath,
        displayName: input.displayName,
        items: [],
        stage: form.stage,
        ...(form.resumeFastForwardV1 ? { resumeFastForwardV1: form.resumeFastForwardV1 } : {}),
      },
      taskName
    );
  }
  return { kind: "applied", message: summary };
}

/**
 * RC2 item 13, Step 52's continuation: arrange whatever comes next for a task
 * whose open-item decisions were just written to plan-final.md. Never throws
 * on a downstream refusal — the plan write above already succeeded and is
 * reported; a failure to arrange the next step is a `NotificationRouter`
 * warning, not a reason to make this command's own outcome look failed.
 */
async function continueAfterOpenPlanItemDecisionsV1(
  arg: DecideOpenPlanItemsArgV1,
  taskName: string
): Promise<void> {
  try {
    await continueAfterOpenPlanItemDecisionsInnerV1(arg, taskName);
  } catch (error) {
    NotificationRouter.showWarning(
      `${taskName}: your decisions were written to plan-final.md, but arranging what runs next failed: ` +
        `${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function continueAfterOpenPlanItemDecisionsInnerV1(
  arg: DecideOpenPlanItemsArgV1,
  taskName: string
): Promise<void> {
  const planUri = getCanonicalImplementationUri(vscode.Uri.file(arg.taskFolderPath));
  const freshPlan = await readTextIfExists(planUri);
  const remaining = freshPlan === undefined ? undefined : countChecklistProgressV1(freshPlan)?.remaining;
  if (remaining === undefined) {
    return;
  }
  if (remaining > 0) {
    await vscode.commands.executeCommand("vs-code-ai-helper.resumeAndApplyCurrentStageAction", {
      taskFolderPath: arg.taskFolderPath,
      displayName: arg.displayName,
      ...(arg.resumeFastForwardV1 ? { resumeFastForwardV1: arg.resumeFastForwardV1 } : {}),
    });
    return;
  }
  const configuredStages = await resolveConfiguredReviewStages(vscode.Uri.file(arg.taskFolderPath));
  const nextStage = computeNextStage(arg.stage, configuredStages);
  if (!nextStage) {
    NotificationRouter.showInformation(`${taskName}: every plan item is now settled — there is no further stage to advance to.`);
    return;
  }
  const target: ChatTarget = {
    canonicalId: arg.taskFolderPath,
    taskFolderPath: arg.taskFolderPath,
    stage: arg.stage,
    taskName: arg.displayName,
  };
  const resumeFastForward = arg.resumeFastForwardV1 !== undefined;
  const nextStageName = STAGE_DISPLAY_NAMES[nextStage];
  const posted = await postWorkflowDecisionV1(
    {
      decisionKey: "openPlanItemsSettledOfferAdvance",
      taskCanonicalId: arg.taskFolderPath,
      stage: arg.stage,
      whatHappened: "Every plan checklist item is now settled — none are left open.",
      whyUserNeeded: "Advancing the stage is your call, not something Ensemble decides on its own.",
      options: [
        {
          optionId: "advance",
          label: `Advance to ${nextStageName}`,
          resumeKind: "continue",
          consequence:
            (resumeFastForward
              ? `Moves the task to ${nextStageName} and continues fast-forwarding there.`
              : `Moves the task to ${nextStageName} and dispatches its own next action there — starting its ` +
                "review, or applying an existing review's findings — unless that stage's next step is yours.") +
            " The plan checklist has nothing open, so nothing will be left unbuilt.",
          effect: {
            kind: "command",
            command: "vs-code-ai-helper.resumeAndSetTaskStage",
            args: [
              {
                taskFolderPath: arg.taskFolderPath,
                stage: nextStage,
                resumeFastForward,
                expectedSourceStage: arg.stage,
              },
            ],
          },
        },
        {
          optionId: "notNow",
          label: "Not now",
          resumeKind: "unpause",
          consequence: "Does nothing. Advance to the next stage yourself whenever you are ready.",
          effect: { kind: "doNothing" },
        },
      ],
      recommendation: {
        kind: "option",
        optionId: "advance",
        reasoning: "Nothing is left open at this stage, so there is nothing more for another round here to build.",
      },
      gating: {
        holdsTaskPaused: false,
        unblocksProgress: true,
        detail: "This card does not pause the task; choosing Advance is what moves it forward.",
      },
    },
    target
  );
  if (!posted) {
    NotificationRouter.showInformation(
      `${taskName}: every plan item is now settled. Advance to ${nextStageName} when you are ready.`
    );
  }
}

export function registerDecideOpenPlanItemsCommandV1(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND, (arg?: DecideOpenPlanItemsArgV1) => decideOpenPlanItemsV1(arg))
  );
}

/**
 * RC2 item 13, Steps 50–51: the "nothing more to build" decision card's pure
 * content — built independently of WHERE it gets raised so its contract
 * (options, recommendation, gating) is directly testable. Wiring this into
 * the zero-file round-routing branch in `reviewActions.ts` (Step 50's other
 * half — an accepted report, no files changed, `remaining > 0`) is tracked
 * separately in plan-final.md and not done by this function.
 *
 * Per the requirement: three options, no bulk-exclude, "Decide item by item"
 * recommended, and `gating.holdsTaskPaused: false` — the card does not pause
 * the task.
 */
export function buildOpenPlanItemsNeedDecisionCardInputV1(input: {
  readonly taskFolderPath: string;
  readonly taskCanonicalId: string;
  readonly stage: TaskStage;
  readonly displayName?: string;
  readonly items: readonly OpenPlanItemReasonForDecisionV1[];
  readonly createdAt: string;
  /**
   * RC2 item 13, Step 52: captured NOW, at card-build time — see this
   * module's `decideOpenPlanItemsV1` doc comment for why the same "capture
   * now" rule `buildAdvanceOptionV1`/`buildPlateauKeepIteratingOptionV1` use
   * applies here too. Baked into the "Decide item by item" option's own args
   * so applying the owner's decisions later knows, without guessing, whether
   * to resume Fast Forward or arrange an ordinary continuing action.
   */
  readonly resumeFastForwardV1?: FastForwardRunStateV1;
}): Omit<CreateWorkflowDecisionInputV1, "decisionId"> {
  const { taskFolderPath, taskCanonicalId, stage, displayName, items, createdAt, resumeFastForwardV1 } = input;
  const count = items.length;
  const plural = count === 1 ? "item" : "items";
  const evidenceLines = items
    .map((item) => `- ${item.itemText} — ${item.reason || "no reason given"}`)
    .join("\n");
  const decideOption: WorkflowDecisionOptionV1 = {
    optionId: "decideItemByItem",
    label: "Decide item by item",
    resumeKind: "unpause",
    consequence:
      "Shows a form in this chat with every open item — exclude it with a reason, tick it because you already " +
      "did it, or leave it open — and writes your choices to plan-final.md in one pass when you press Apply, " +
      "with a dated Accepted Non-Goals entry for anything excluded. Items you leave open stay open. Then " +
      "builds whatever is still open, or offers Advance once nothing is.",
    effect: {
      kind: "command",
      command: "vs-code-ai-helper.decideOpenPlanItems",
      args: [
        {
          taskFolderPath,
          displayName,
          items,
          stage,
          ...(resumeFastForwardV1 ? { resumeFastForwardV1 } : {}),
        },
      ],
    },
  };
  const openPlanOption: WorkflowDecisionOptionV1 = {
    optionId: "openPlanFinal",
    label: "Open plan-final.md",
    resumeKind: "unpause",
    consequence: "Opens plan-final.md so you can review or edit the open items yourself. Nothing is applied for you.",
    effect: {
      kind: "command",
      command: "vs-code-ai-helper.openPlanNonGoals",
      args: [{ taskFolderPath }],
    },
  };
  const leaveOption: WorkflowDecisionOptionV1 = {
    optionId: "leaveOpen",
    label: "Leave them open",
    resumeKind: "unpause",
    consequence: "No change. This card does not pause the task, so it can keep working on anything else it still can.",
    effect: { kind: "doNothing" },
  };
  return {
    decisionKey: "openPlanItemsNeedDecision",
    taskCanonicalId,
    stage,
    whatHappened:
      `This round changed no files. The plan checklist still has ${count} open ${plural} the round could not ` +
      `build:\n\n${evidenceLines}`,
    whyUserNeeded:
      "None of the open items look buildable by another round right now — each needs your decision: excluded, " +
      "already done, or genuinely still open.",
    options: [decideOption, openPlanOption, leaveOption],
    recommendation: {
      kind: "option",
      optionId: "decideItemByItem",
      reasoning:
        "Settling each item by hand is the only way to make real progress here instead of re-running the same " +
        "empty round.",
    },
    gating: {
      holdsTaskPaused: false,
      unblocksProgress: false,
      detail: "This card does not pause the task and dispatches nothing on its own; only its options act.",
    },
    createdAt,
  };
}
