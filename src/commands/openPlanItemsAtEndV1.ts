import * as vscode from "vscode";

import { type TaskStage } from "../types/taskProgress";
import { LATCHED_COUNT_NOTE_V1, readOpenPlanItemListV1 } from "../utils/effectiveReviewProgress";
import { readTaskPopUpLabelV1 } from "./confirmAdvanceOverOpenItemsV1";
import { awaitWorkflowDecisionAnswerV1, type AwaitedDecisionOutcomeV1 } from "../utils/workflowDecisionDispatchV1";

/**
 * review1 Step 61: before Commit & Push commits, and before Mark Done completes a task, plan items that are neither
 * ticked nor excluded are listed once, as one chat decision: "Continue anyway" or "Stop". Stop commits and completes
 * nothing. No card when nothing is open. The count comes from the same read as the Tasks pane (Step 5), so the list
 * matches what the owner sees there; while the checklist is flagged unreliable the card says the count may be behind.
 *
 * Nothing else in the Publish or Commit & Push flow changes (that stays with publish1).
 */

export const OPEN_PLAN_ITEMS_AT_END_DECISION_KEY_V1 = "openPlanItemsAtEnd";
export const OPEN_PLAN_ITEMS_CONTINUE_OPTION_ID_V1 = "continueAnyway";
export const OPEN_PLAN_ITEMS_STOP_OPTION_ID_V1 = "stop";

/** How many open item names the card and the Publish review prompt spell out before saying "and N more". */
const MAX_LISTED_ITEMS_V1 = 8;

export type EndOfWorkflowCommandV1 = "Commit & Push" | "Mark Done";

export interface OpenPlanItemsAtEndV1 {
  /** Top-level plan items neither ticked nor excluded, in plan order. */
  readonly items: readonly string[];
  /** Ticked items no review or owner has settled yet; mentioned, never a reason to ask. */
  readonly provisional: number;
  /** The checklist is flagged unreliable: the count may be behind. */
  readonly latched: boolean;
}

/**
 * The open items of a task's plan of record, read the way the Tasks pane reads them. `undefined` when the task has
 * no countable checklist (no plan-final.md, or one that never had a checklist), so nothing is asked.
 */
export async function readOpenPlanItemsAtEndV1(taskFolderUri: vscode.Uri): Promise<OpenPlanItemsAtEndV1 | undefined> {
  // The list comes from the same per-item settlement as the counts, so a ticked parent with unfinished children is
  // not hidden and a nested item is listed the way the Tasks pane counts it.
  const read = await readOpenPlanItemListV1(taskFolderUri, { policy: "lenient" });
  if (!read) return undefined;
  return { items: read.items, provisional: read.counts.provisional, latched: read.counts.latched };
}

function listItemsV1(items: readonly string[]): string {
  const shown = items.slice(0, MAX_LISTED_ITEMS_V1).map((item) => `- ${item}`);
  if (items.length > MAX_LISTED_ITEMS_V1) shown.push(`- … and ${items.length - MAX_LISTED_ITEMS_V1} more`);
  return shown.join("\n");
}

/** The sentence(s) the card opens with. Pure, for tests. */
export function describeOpenPlanItemsAtEndV1(open: OpenPlanItemsAtEndV1, command: EndOfWorkflowCommandV1): string {
  const count = open.items.length;
  const noun = count === 1 ? "plan item is" : "plan items are";
  const lines = [`${count} ${noun} still neither ticked nor excluded in plan-final.md:`, listItemsV1(open.items)];
  if (open.provisional > 0) {
    lines.push(`${open.provisional} more ticked item(s) have not been checked by a review yet.`);
  }
  if (open.latched) {
    lines.push(`The checklist is flagged unreliable (${LATCHED_COUNT_NOTE_V1}), so this count may be behind.`);
  }
  lines.push(`${command} does not need them to be settled, but nothing else in the workflow has said they were left.`);
  return lines.join("\n");
}

/**
 * The block added to the Publish review's verified-checks section, so its verdict mentions open plan items.
 * Empty when nothing is open.
 */
export function buildOpenPlanItemsPublishNoteV1(open: OpenPlanItemsAtEndV1 | undefined): string {
  if (!open || open.items.length === 0) return "";
  const lines = [
    "## Open plan items",
    "",
    `plan-final.md still has ${open.items.length} plan item(s) that are neither ticked nor excluded. ` +
      "Mention them in your verdict: say whether each one matters for shipping.",
    "",
    listItemsV1(open.items),
  ];
  if (open.latched) {
    lines.push("", `The checklist is flagged unreliable (${LATCHED_COUNT_NOTE_V1}), so this list may be behind.`);
  }
  return lines.join("\n");
}

/**
 * Asks the owner, in the task chat, when plan items are still open. `"proceed"` means nothing is open, the owner
 * chose Continue anyway, or no chat is available and the owner chose Continue anyway in a pop-up instead.
 * `"stop"` means the owner chose Stop, dismissed the card, or the wait ended without an answer: nothing is
 * committed or completed on a missing answer.
 */
export async function confirmOpenPlanItemsAtEndV1(args: {
  readonly taskFolderUri: vscode.Uri;
  readonly stage: TaskStage;
  readonly command: EndOfWorkflowCommandV1;
  readonly token?: vscode.CancellationToken;
  /** Test seam: replaces the chat wait. */
  readonly ask?: typeof awaitWorkflowDecisionAnswerV1;
  /** Test seam: replaces the pop-up asked when the chat is unavailable. Resolves true for Continue anyway. */
  readonly askFallback?: (message: string) => Promise<boolean>;
}): Promise<"proceed" | "stop"> {
  const open = await readOpenPlanItemsAtEndV1(args.taskFolderUri);
  if (!open || open.items.length === 0) return "proceed";
  const nothingDone = args.command === "Commit & Push" ? "committed" : "completed";
  let ended: AwaitedDecisionOutcomeV1 | undefined;
  const ask = args.ask ?? awaitWorkflowDecisionAnswerV1;
  const answer = await ask(
    {
      decisionKey: OPEN_PLAN_ITEMS_AT_END_DECISION_KEY_V1,
      taskCanonicalId: args.taskFolderUri.fsPath,
      stage: args.stage,
      whatHappened: describeOpenPlanItemsAtEndV1(open, args.command),
      whyUserNeeded: `${args.command} would go ahead with these left open. Only you can say whether they are done, not needed, or still to do.`,
      restartGuidance: `${args.command} was interrupted by a reload, so nothing was ${nothingDone}; choose ${args.command} again.`,
      options: [
        {
          optionId: OPEN_PLAN_ITEMS_CONTINUE_OPTION_ID_V1,
          label: "Continue anyway",
          resumeKind: "continue" as const,
          consequence: `You accept these items as done or not needed. ${args.command} carries on.`,
          recordedNext: `carrying on with ${args.command}`,
          effect: { kind: "doNothing" as const },
        },
        {
          optionId: OPEN_PLAN_ITEMS_STOP_OPTION_ID_V1,
          label: "Stop",
          resumeKind: "continue" as const,
          consequence: `Nothing is ${nothingDone}. Tick or exclude the items first (Tick or Exclude a Checklist Item…), then choose ${args.command} again.`,
          recordedNext: `stopped; nothing was ${nothingDone}`,
          effect: { kind: "doNothing" as const },
        },
      ],
      recommendation: {
        kind: "option",
        optionId: OPEN_PLAN_ITEMS_STOP_OPTION_ID_V1,
        reasoning: "Open plan items usually mean work was missed or a step was never recorded; settle them first.",
      },
      gating: {
        holdsTaskPaused: false,
        unblocksProgress: true,
        detail: `${args.command === "Commit & Push" ? "the commit and push" : "marking the task done"}`,
        waitingCommand: args.command,
        waitingNothingDone: nothingDone,
      },
    },
    { canonicalId: args.taskFolderUri.fsPath, taskFolderPath: args.taskFolderUri.fsPath, stage: args.stage },
    args.token,
    (outcome) => {
      ended = outcome;
    },
    { noTimeout: true }
  );
  if (answer === OPEN_PLAN_ITEMS_CONTINUE_OPTION_ID_V1) return "proceed";
  if (answer === undefined && ended?.kind === "unavailable") {
    // No chat to ask in: the owner clicked this command, so ask with a pop-up. A dismissed pop-up is a Stop; open
    // items are never carried past without an explicit answer.
    const fallback =
      args.askFallback ??
      (async (message: string): Promise<boolean> =>
        askOpenPlanItemsInPopUpV1(message, await readTaskPopUpLabelV1(args.taskFolderUri)));
    return (await fallback(describeOpenPlanItemsAtEndV1(open, args.command))) ? "proceed" : "stop";
  }
  return "stop";
}

/** The pop-up fallback for {@link confirmOpenPlanItemsAtEndV1} when the chat cannot ask. True = Continue anyway. */
async function askOpenPlanItemsInPopUpV1(message: string, taskLabel: string): Promise<boolean> {
  const continueLabel = "Continue anyway";
  const choice = await vscode.window.showWarningMessage(`${taskLabel}: ${message}`, { modal: true }, continueLabel);
  return choice === continueLabel;
}
