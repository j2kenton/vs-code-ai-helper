import * as vscode from "vscode";
import { STAGE_DISPLAY_NAMES, TaskStage } from "../types/taskProgress";
import {
  CreateWorkflowDecisionInputV1,
  WorkflowDecisionCommandResultV1,
  WorkflowDecisionOptionV1,
} from "../types/workflowDecisionV1";
import { getCanonicalImplementationUri } from "../utils/implementationArtifactResolver";
import { readTextIfExists, writeTextFileIfUnchangedV1 } from "../utils/fileUtils";
import {
  applyOpenPlanItemDecisionsV1,
  countChecklistProgressV1,
  OpenPlanItemDecisionV1,
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
 * RC2 item 13, Step 51: the "Decide item by item" option's effect. One
 * QuickPick per open item — Exclude (with a one-line reason, prefilled from
 * the round's own reason when it gave one), "I did it — tick it", or "Leave
 * open" — applied in one atomic write via
 * {@link applyOpenPlanItemDecisionsV1}. There is deliberately no bulk-exclude:
 * the owner sees and confirms every item on its own, per the requirement.
 * Cancelling anywhere in the flow (Escape on a QuickPick or an input box, or
 * leaving the reason blank on Exclude) applies nothing — a half-decided flow
 * is not committed.
 */
export async function decideOpenPlanItemsV1(
  arg?: DecideOpenPlanItemsArgV1
): Promise<WorkflowDecisionCommandResultV1 | boolean> {
  if (!arg?.taskFolderPath || arg.items.length === 0) {
    return false;
  }
  const taskName = formatNotificationTaskLabelV1(arg.displayName, arg.taskFolderPath);
  const decisions: OpenPlanItemDecisionV1[] = [];
  for (const item of arg.items) {
    const truncated = truncateChecklistItemTextV1(item.itemText, 100);
    const choice = await vscode.window.showQuickPick(
      [
        {
          label: "Exclude",
          detail: item.reason
            ? `Reason from the round: ${item.reason}`
            : "No reason given by the round — you will need to type one.",
          mode: "exclude" as const,
        },
        { label: "I did it — tick it", detail: "Ticks the box and records your note.", mode: "tick" as const },
        { label: "Leave open", detail: "No change to this item.", mode: "leave" as const },
      ],
      { title: truncated, placeHolder: "Decide this plan item", ignoreFocusOut: true }
    );
    if (!choice) {
      return false;
    }
    if (choice.mode === "leave") {
      continue;
    }
    if (choice.mode === "exclude") {
      const typed = await vscode.window.showInputBox({
        title: "Exclude this item",
        prompt: "Why does it not apply? Recorded beside the item.",
        value: item.reason.length > 0 ? item.reason : undefined,
        ignoreFocusOut: true,
      });
      if (typed === undefined) {
        return false;
      }
      if (typed.trim().length === 0) {
        NotificationRouter.showWarning(
          `${taskName}: a reason is required to exclude "${truncated}". Nothing was applied.`
        );
        return false;
      }
      decisions.push({ itemText: item.itemText, mode: "exclude", reason: typed });
      continue;
    }
    const typed = await vscode.window.showInputBox({
      title: "Tick this item",
      prompt: "What did you see? Recorded beside the item.",
      ignoreFocusOut: true,
    });
    if (typed === undefined) {
      return false;
    }
    decisions.push({ itemText: item.itemText, mode: "tick", reason: typed });
  }
  if (decisions.length === 0) {
    // Implementation review round 2 (review commit c66cbc9): completing the
    // whole flow with "Leave open" chosen for every item is a valid,
    // deliberate no-op — the owner looked at each item and decided none of
    // them need a change — not a cancellation or a refusal. Only an actual
    // Escape (handled above, before `decisions` is ever populated) or a
    // blank Exclude reason (also handled above) is a real "did not
    // complete"; returning bare `false` here made ChatView render this valid
    // choice as a command failure (`"${option.label}" did not complete`).
    NotificationRouter.showInformation(`${taskName}: no items were changed — everything was left open.`);
    return { outcome: "done" };
  }
  const planUri = getCanonicalImplementationUri(vscode.Uri.file(arg.taskFolderPath));
  const plan = await readTextIfExists(planUri);
  if (plan === undefined) {
    NotificationRouter.showWarning(`${taskName}: plan-final.md could not be read, so nothing was applied.`);
    return false;
  }
  const applied = applyOpenPlanItemDecisionsV1(plan, decisions, new Date().toISOString().slice(0, 10));
  if (!(await writeTextFileIfUnchangedV1(planUri, plan, applied.content))) {
    NotificationRouter.showWarning(
      `${taskName}: plan-final.md changed while this was being applied — nothing was written. Try again.`
    );
    return false;
  }
  const parts: string[] = [];
  if (applied.ticked.length > 0) {
    parts.push(`ticked ${applied.ticked.length}`);
  }
  if (applied.excluded.length > 0) {
    parts.push(`excluded ${applied.excluded.length}`);
  }
  NotificationRouter.showInformation(
    parts.length > 0 ? `${taskName}: ${parts.join(", ")} in plan-final.md.` : `${taskName}: no items were changed.`
  );
  // RC2 item 13, Step 52: the write above is not the end of the story — the
  // task was left active with nothing further arranged when this card was
  // raised (its own gating: "dispatches nothing on its own"). Now that the
  // owner has settled every item they were going to settle, either there is
  // still open work (arrange the stage's continuing action — Fast Forward's
  // own remaining budget when it raised this round, an ordinary dispatch
  // otherwise) or there is none left (offer Advance instead of leaving the
  // task to stall again on the same empty-round path that raised this card).
  await continueAfterOpenPlanItemDecisionsV1(arg, taskName);
  return true;
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
      "Opens one QuickPick per open item — exclude it with a reason, tick it because you already did it, or " +
      "leave it open — and writes your choices to plan-final.md in one pass, with a dated Accepted Non-Goals " +
      "entry for anything excluded. Then builds whatever is still open, or offers Advance once nothing is.",
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
