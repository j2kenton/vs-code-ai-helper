import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { NotificationRouter } from "../utils/notificationRouter";
import { getCanonicalImplementationUri } from "../utils/implementationArtifactResolver";
import { readTextIfExists, writeTextFileIfUnchangedV1 } from "../utils/fileUtils";
import {
  classifyUncheckedChecklistItemsV1,
  tickHandoffChecksV1,
  truncateChecklistItemTextV1,
} from "../utils/implementationChecklist";
import { TaskStage } from "../types/taskProgress";
import { PostWorkflowDecisionInputV1, postWorkflowDecisionV1 } from "../utils/workflowDecisionDispatchV1";

/**
 * The hand-off card (v1 fixes 2, item 31, step 13): what the user meets when
 * Fast Forward stops because only hand-off checks remain. It lists the checks
 * and lets the user tick each one — with a note of what they saw — or accept the
 * rest, without editing `plan-final.md` by hand.
 *
 * A decision resolves the moment one option is chosen, so the card cannot stay
 * open across several ticks. Instead each command re-posts a successor card
 * listing whatever is still outstanding (on every path, including a cancelled
 * note prompt), so every check is reachable one after another.
 */

const TICK_COMMAND = "vs-code-ai-helper.tickHandoffCheck";
const ACCEPT_COMMAND = "vs-code-ai-helper.acceptHandoffChecks";
const KEEP_COMMAND = "vs-code-ai-helper.keepHandoffChecks";

/**
 * One card option per check, up to this many. The rest are not hidden: the
 * card is re-posted after every choice, so each check reaches the front in turn.
 */
const MAX_TICK_OPTIONS = 6;

/** Checks itemised as evidence on one card; the count of the rest is stated. */
const MAX_LISTED_CHECKS = 20;

/** The note recorded against a check settled through "accept the rest". */
export const ACCEPTED_WITHOUT_EVIDENCE_NOTE_V1 = "accepted by you from the hand-off card, without individual evidence";

export interface HandoffChecksArgV1 {
  readonly taskFolderPath: string;
  /** The check to tick (tick command only). */
  readonly itemText?: string;
  /**
   * The checks the card displayed (accept command only). "Accept" settles
   * exactly these, so a check added to the plan after the card was posted is
   * never accepted unseen.
   */
  readonly itemTexts?: readonly string[];
  /** What the card needs to post its successor once this choice has been applied. */
  readonly stage?: TaskStage;
  readonly displayName?: string;
}

/** Builds the decision. Pure. */
export function buildHandoffChecksDecisionInputV1(input: {
  readonly canonicalId: string;
  readonly taskFolderPath: string;
  readonly stage: TaskStage;
  readonly reason: string;
  readonly checks: readonly string[];
  readonly displayName?: string | undefined;
}): PostWorkflowDecisionInputV1 {
  const n = input.checks.length;
  const listed = input.checks.slice(0, MAX_TICK_OPTIONS);
  const carry = {
    stage: input.stage,
    ...(input.displayName ? { displayName: input.displayName } : {}),
  };
  return {
    decisionKey: "handoffChecks",
    taskCanonicalId: input.canonicalId,
    stage: input.stage,
    whatHappened: `Waiting for you: ${input.reason}`,
    whyUserNeeded:
      "These checks need a person (or Ensemble's own verification run) — no further Implementation round can " +
      "build them, and nothing here can confirm them on your behalf.",
    gating: {
      holdsTaskPaused: false,
      unblocksProgress: true,
      detail:
        "Ticking every remaining check completes the plan, which lets the task move on. The task is not paused — " +
        "it is waiting for you. This card comes back with what is left after each check you tick.",
    },
    options: [
      ...listed.map((check, index) => ({
        optionId: `tick-${index}`,
        resumeKind: "continue" as const,
        label: `Ticked: ${truncateChecklistItemTextV1(check, 80)}`,
        consequence:
          "Asks for a short note of what you saw, then ticks this check in plan-final.md with that note beside it. " +
          "Do the check first — this records that you did.",
        effect: {
          kind: "command" as const,
          command: TICK_COMMAND,
          args: [{ taskFolderPath: input.taskFolderPath, itemText: check, ...carry } satisfies HandoffChecksArgV1],
        },
      })),
      {
        optionId: "acceptRest",
        resumeKind: "continue",
        label: `Accept the ${n === 1 ? "remaining check" : `remaining ${n} checks`}`,
        consequence:
          `Ticks ${n === 1 ? "it" : `all ${n}`} in plan-final.md, noting that you accepted ${n === 1 ? "it" : "them"} ` +
          "without individual evidence. Use this when you have decided the checks are not worth doing.",
        effect: {
          kind: "command" as const,
          command: ACCEPT_COMMAND,
          args: [{ taskFolderPath: input.taskFolderPath, itemTexts: input.checks, ...carry } satisfies HandoffChecksArgV1],
        },
      },
      {
        optionId: "notYet",
        resumeKind: "unpause",
        label: "Not yet — I'll do the checks first",
        consequence: "Ticks nothing. The checks stay listed — this card comes straight back — and the task keeps waiting for you.",
        // A command, not `doNothing`: a decision resolves the moment an option
        // is chosen, so "do nothing" would leave the user with no card at all.
        effect: {
          kind: "command" as const,
          command: KEEP_COMMAND,
          args: [{ taskFolderPath: input.taskFolderPath, ...carry } satisfies HandoffChecksArgV1],
        },
      },
    ],
    recommendation: {
      kind: "none",
      reasoning:
        "No basis to recommend an option: whether these checks pass is something only you can observe, and " +
        "nothing recorded says either way.",
    },
    evidence: [
      ...input.checks.slice(0, MAX_LISTED_CHECKS).map((check, index) => ({
        label: `Check ${index + 1} of ${n}`,
        detail: truncateChecklistItemTextV1(check, 200),
      })),
      ...(n > MAX_LISTED_CHECKS
        ? [
            {
              label: "More checks",
              detail: `${n - MAX_LISTED_CHECKS} further checks are not itemised here; they reach this card as the ones above are ticked.`,
            },
          ]
        : []),
    ],
  };
}

/** Posts the card. Returns false when there is no activating extension context to post through. */
export async function postHandoffChecksDecisionV1(input: {
  readonly taskFolderPath: string;
  readonly stage: TaskStage;
  readonly displayName: string | undefined;
  readonly reason: string;
  readonly checks: readonly string[];
}): Promise<boolean> {
  const decision = await postWorkflowDecisionV1(
    buildHandoffChecksDecisionInputV1({ canonicalId: input.taskFolderPath, ...input }),
    {
      canonicalId: input.taskFolderPath,
      taskFolderPath: input.taskFolderPath,
      stage: input.stage,
      taskName: input.displayName,
    }
  );
  return decision !== undefined;
}

export type HandoffTickResultV1 =
  | { readonly kind: "ticked"; readonly count: number }
  | { readonly kind: "nothingToTick" }
  | { readonly kind: "noPlan" }
  | { readonly kind: "changedUnderneath" };

/**
 * Re-reads `plan-final.md` and ticks the requested hand-off checks. Everything
 * is re-derived from disk rather than trusted from the card, and the write is
 * revision-conditional, so a plan edited since the card was posted is refused
 * rather than overwritten.
 */
export async function applyHandoffTicksV1(
  taskFolderPath: string,
  ticks: readonly { readonly itemText: string; readonly note: string }[]
): Promise<HandoffTickResultV1> {
  const planUri = getCanonicalImplementationUri(vscode.Uri.file(taskFolderPath));
  const plan = await readTextIfExists(planUri);
  if (plan === undefined) {
    return { kind: "noPlan" };
  }
  const { content, tickedItemTexts } = tickHandoffChecksV1(plan, ticks);
  if (tickedItemTexts.length === 0) {
    return { kind: "nothingToTick" };
  }
  if (!(await writeTextFileIfUnchangedV1(planUri, plan, content))) {
    return { kind: "changedUnderneath" };
  }
  return { kind: "ticked", count: tickedItemTexts.length };
}

/** What the two commands need from their surroundings — injectable so the lifecycle is testable. */
export interface HandoffCommandIoV1 {
  askNote(itemText: string): Promise<string | undefined>;
  refresh(): Promise<void>;
  /** Posts the successor card listing what is still outstanding. */
  repost(arg: HandoffChecksArgV1, remaining: readonly string[]): Promise<void>;
  /**
   * "Try again" for a `continue` option once nothing remains outstanding
   * (pre-1.0.0 fixes register, Part 3 Step 2's inventory note for this file:
   * "Ensemble performs the adjustment, so continue under Step 5's rule" —
   * Step 5's rule is "after the adjustment succeeds, dispatch the current
   * stage's next action"). Ticking is itself real dispatched work (it writes
   * plan-final.md) whether or not this fires; this is what closes the loop
   * once the LAST hand-off check is settled, instead of leaving the task
   * sitting on a now-cleared gate with nothing running.
   */
  dispatchStageAction(arg: HandoffChecksArgV1): Promise<void>;
}

async function readRemainingV1(taskFolderPath: string): Promise<readonly string[]> {
  const plan = await readTextIfExists(getCanonicalImplementationUri(vscode.Uri.file(taskFolderPath)));
  return plan === undefined ? [] : classifyUncheckedChecklistItemsV1(plan).handoff;
}

/**
 * Reports the outcome, then makes sure the user is never left without the card:
 * whatever happened (ticked, cancelled, refused), any check still outstanding is
 * re-posted so it can be ticked next. Returns false when nothing was ticked so
 * the decision transcript does not leave "applying now" standing as its outcome.
 */
async function settleAndRepostV1(
  io: HandoffCommandIoV1,
  arg: HandoffChecksArgV1,
  result: HandoffTickResultV1 | { readonly kind: "cancelled" },
  what: string
): Promise<boolean> {
  switch (result.kind) {
    case "ticked":
      await io.refresh();
      NotificationRouter.showInformation(`${what}: ticked ${result.count} check${result.count === 1 ? "" : "s"} in plan-final.md.`);
      break;
    case "cancelled":
      NotificationRouter.showInformation("No check was ticked.");
      break;
    case "nothingToTick":
      NotificationRouter.showInformation("Nothing to tick — those checks are already settled or plan-final.md has changed.");
      break;
    case "noPlan":
      NotificationRouter.showWarning("plan-final.md could not be read, so no check was ticked.");
      break;
    case "changedUnderneath":
      NotificationRouter.showWarning("plan-final.md changed while this was being applied — nothing was written. Try again.");
      break;
  }
  const remaining = await readRemainingV1(arg.taskFolderPath);
  if (remaining.length > 0) {
    await io.repost(arg, remaining);
  } else if (result.kind === "ticked") {
    NotificationRouter.showInformation("Every hand-off check is settled — plan-final.md has nothing left for you to tick. Trying the stage's next action now.");
    await io.dispatchStageAction(arg);
  }
  return result.kind === "ticked";
}

/** "Ticked: <check>" — asks for a note of what the user saw, then ticks that one check. */
export async function tickHandoffCheckV1(arg: HandoffChecksArgV1 | undefined, io: HandoffCommandIoV1): Promise<boolean> {
  if (!arg?.taskFolderPath || !arg.itemText) {
    NotificationRouter.showWarning("Nothing to tick — no check was supplied.");
    return false;
  }
  const note = await io.askNote(arg.itemText);
  const result: HandoffTickResultV1 | { readonly kind: "cancelled" } =
    note === undefined
      ? { kind: "cancelled" }
      : await applyHandoffTicksV1(arg.taskFolderPath, [{ itemText: arg.itemText, note }]);
  return settleAndRepostV1(io, arg, result, "Hand-off check");
}

/** "Accept the remaining checks" — settles exactly the checks the card displayed that are still unticked. */
export async function acceptHandoffChecksV1(arg: HandoffChecksArgV1 | undefined, io: HandoffCommandIoV1): Promise<boolean> {
  if (!arg?.taskFolderPath) {
    NotificationRouter.showWarning("Nothing to accept — no task was supplied.");
    return false;
  }
  const outstanding = await readRemainingV1(arg.taskFolderPath);
  const displayed = arg.itemTexts ? new Set(arg.itemTexts) : undefined;
  const toAccept = displayed ? outstanding.filter((itemText) => displayed.has(itemText)) : outstanding;
  const result = await applyHandoffTicksV1(
    arg.taskFolderPath,
    toAccept.map((itemText) => ({ itemText, note: ACCEPTED_WITHOUT_EVIDENCE_NOTE_V1 }))
  );
  return settleAndRepostV1(io, arg, result, "Accepted the rest");
}

/**
 * "Not yet" — ticks nothing and re-posts the card with whatever is outstanding,
 * so choosing to wait never costs the user the card. Resolves true: the choice
 * itself succeeded, so the transcript must not report it as "did not complete".
 */
export async function keepHandoffChecksV1(arg: HandoffChecksArgV1 | undefined, io: HandoffCommandIoV1): Promise<boolean> {
  if (!arg?.taskFolderPath) {
    return false;
  }
  const remaining = await readRemainingV1(arg.taskFolderPath);
  if (remaining.length > 0) {
    await io.repost(arg, remaining);
  }
  return true;
}

export function registerHandoffChecksCommandsV1(context: vscode.ExtensionContext, inventory: TaskInventory): void {
  const io: HandoffCommandIoV1 = {
    askNote: (itemText) =>
      Promise.resolve(
        vscode.window.showInputBox({
          title: "Tick this check",
          prompt: `What did you see? Recorded beside the check: ${truncateChecklistItemTextV1(itemText, 100)}`,
          placeHolder: "e.g. clicked through the card in a live window; it read correctly",
          ignoreFocusOut: true,
        })
      ),
    refresh: () => inventory.refresh(),
    repost: async (arg, remaining) => {
      if (!arg.stage) {
        return;
      }
      const plural = remaining.length === 1;
      await postHandoffChecksDecisionV1({
        taskFolderPath: arg.taskFolderPath,
        stage: arg.stage,
        displayName: arg.displayName,
        reason: `${remaining.length} hand-off check${plural ? "" : "s"} still need${plural ? "s" : ""} you.`,
        checks: remaining,
      }).catch(() => false);
    },
    dispatchStageAction: async (arg) => {
      await vscode.commands.executeCommand("vs-code-ai-helper.resumeAndApplyCurrentStageAction", {
        taskFolderPath: arg.taskFolderPath,
      });
    },
  };
  context.subscriptions.push(
    vscode.commands.registerCommand(TICK_COMMAND, (arg?: HandoffChecksArgV1) => tickHandoffCheckV1(arg, io)),
    vscode.commands.registerCommand(ACCEPT_COMMAND, (arg?: HandoffChecksArgV1) => acceptHandoffChecksV1(arg, io)),
    vscode.commands.registerCommand(KEEP_COMMAND, (arg?: HandoffChecksArgV1) => keepHandoffChecksV1(arg, io))
  );
}
