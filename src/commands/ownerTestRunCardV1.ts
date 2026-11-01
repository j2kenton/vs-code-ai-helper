import * as vscode from "vscode";
import { randomBytes } from "crypto";
import { TaskStage, STAGE_DISPLAY_NAMES } from "../types/taskProgress";
import type {
  CreateWorkflowDecisionInputV1,
  WorkflowDecisionCommandResultV1,
  WorkflowDecisionOptionV1,
} from "../types/workflowDecisionV1";
import { postWorkflowDecisionV1 } from "../utils/workflowDecisionDispatchV1";
import { formatNotificationTaskLabelV1 } from "../utils/notificationTaskContextV1";
import { recordOwnerTestRunV1 } from "./recordOwnerTestRunV1";
import type { ChatTarget } from "../views/chatView";

export const POST_OWNER_TEST_RUN_CARD_COMMAND_V1 = "vs-code-ai-helper.postOwnerTestRunCard";
export const RECORD_OWNER_TEST_RUN_COMMAND_V1 = "vs-code-ai-helper.recordOwnerTestRun";

const MAX_COMMAND_OPTIONS_V1 = 3;
const RUN_COMMAND_HINT_V1 = /\b(?:test|tests|vitest|jest|mocha|pytest|resilience|verify|check)\b/i;

/**
 * bugs4 item 21 / Step 19: the run commands the plan items themselves name in backticks
 * (for example `npm run resilience:test:portable -- --synthetic`), in first-seen order. These
 * become the card's choices, so the owner picks a command instead of typing one.
 */
export function extractNamedTestCommandsV1(itemTexts: readonly string[]): string[] {
  const seen = new Set<string>();
  const commands: string[] = [];
  for (const text of itemTexts) {
    for (const match of text.matchAll(/`([^`]+)`/g)) {
      const command = match[1]!.trim();
      if (command.length === 0 || command.length > 300) continue;
      if (!/^(?:npm|npx|pnpm|yarn|node|cd|docker|make|cargo|go|pytest|python)\b/.test(command)) continue;
      if (!RUN_COMMAND_HINT_V1.test(command)) continue;
      if (seen.has(command)) continue;
      seen.add(command);
      commands.push(command);
    }
  }
  return commands;
}

export interface OwnerTestRunCardArgV1 {
  readonly taskFolderPath: string;
  readonly displayName?: string;
  readonly stage: TaskStage;
  /** The open items held only for a passing test report. */
  readonly itemTexts: readonly string[];
}

export interface RecordOwnerTestRunArgV1 {
  readonly taskFolderPath: string;
  readonly displayName?: string;
  readonly command: string;
  /**
   * What the owner said happened. The card has no input boxes, so the exact exit code of a failed
   * run is never known: a pass is stored as exit code 0, and a failure is acknowledged but not
   * stored (storing "1" would misstate a code the owner never gave).
   */
  readonly outcome: "passed" | "failed";
  readonly itemTexts: readonly string[];
}

/** One run command and only the items whose own text names it. */
export interface OwnerTestRunGroupV1 {
  readonly command: string;
  readonly itemTexts: readonly string[];
}

function itemCountPhraseV1(count: number): string {
  return count === 1 ? "1 plan item" : `${count} plan items`;
}

function shortCommandV1(command: string): string {
  return command.length > 70 ? `${command.slice(0, 67)}...` : command;
}

/**
 * A run covers only the items that name it. An item that names exactly one run command goes under
 * that command. An item that names NO command is returned in `unnamed` and left out of every group:
 * the card has no input box, so the real command is unknowable and Ensemble will not invent one.
 * Those items are settled by Decide item by item, Tick all, or a round that runs the tests. An item
 * that names SEVERAL commands needs all of them, so no single-command run may cover it: it is
 * returned in `multiCommand` and left out of every group (it stays as it is until every command has
 * a report, or the owner settles it by hand). Choosing one command therefore never hands its
 * evidence to an item that required a different one, or to one that also required another run.
 */
export function partitionItemsByNamedCommandV1(itemTexts: readonly string[]): {
  readonly groups: OwnerTestRunGroupV1[];
  readonly multiCommand: string[];
  readonly unnamed: string[];
} {
  const byCommand = new Map<string, string[]>();
  const unnamed: string[] = [];
  const multiCommand: string[] = [];
  for (const text of itemTexts) {
    const commands = extractNamedTestCommandsV1([text]);
    if (commands.length === 0) {
      unnamed.push(text);
    } else if (commands.length > 1) {
      multiCommand.push(text);
    } else {
      const bucket = byCommand.get(commands[0]!) ?? [];
      bucket.push(text);
      byCommand.set(commands[0]!, bucket);
    }
  }
  const groups: OwnerTestRunGroupV1[] = [...byCommand].map(([command, items]) => ({ command, itemTexts: items }));
  return { groups, multiCommand, unnamed };
}

export function groupItemsByNamedCommandV1(itemTexts: readonly string[]): OwnerTestRunGroupV1[] {
  return partitionItemsByNamedCommandV1(itemTexts).groups;
}

/**
 * The owner-run test card: pure content, no input boxes. Each option names the command the owner
 * ran and records a PASSING run only for the items that name that command, with owner provenance.
 * "It failed" stores nothing (no exit code is invented), posts a chat note and settles nothing.
 */
export function buildOwnerTestRunCardInputV1(
  input: OwnerTestRunCardArgV1 & { readonly taskCanonicalId: string; readonly createdAt: string }
): Omit<CreateWorkflowDecisionInputV1, "decisionId"> {
  const partition = partitionItemsByNamedCommandV1(input.itemTexts);
  const groups = partition.groups.slice(0, MAX_COMMAND_OPTIONS_V1);
  const offered = new Set(groups.flatMap((group) => group.itemTexts));
  const notOffered = input.itemTexts.filter(
    (text) => !offered.has(text) && !partition.multiCommand.includes(text) && !partition.unnamed.includes(text)
  );
  const unnamedNote =
    partition.unnamed.length > 0
      ? ` ${itemCountPhraseV1(partition.unnamed.length)} name${partition.unnamed.length === 1 ? "s" : ""} no command, so no run can be recorded for ${partition.unnamed.length === 1 ? "it" : "them"} here; settle ${partition.unnamed.length === 1 ? "it" : "them"} with Decide item by item, or have a round run the tests.`
      : "";
  const multiNote =
    partition.multiCommand.length > 0
      ? ` ${itemCountPhraseV1(partition.multiCommand.length)} name${partition.multiCommand.length === 1 ? "s" : ""} several commands, so no single run covers ${partition.multiCommand.length === 1 ? "it" : "them"}; ${partition.multiCommand.length === 1 ? "it stays" : "they stay"} as ${partition.multiCommand.length === 1 ? "it is" : "they are"} until each command has a report, or you settle ${partition.multiCommand.length === 1 ? "it" : "them"} by hand with Decide item by item.`
      : "";
  const count = input.itemTexts.length;
  const several = groups.length > 1;
  const recordArg = (group: OwnerTestRunGroupV1, outcome: "passed" | "failed"): RecordOwnerTestRunArgV1 => ({
    taskFolderPath: input.taskFolderPath,
    displayName: input.displayName,
    command: group.command,
    outcome,
    itemTexts: group.itemTexts,
  });
  const passedOptions: WorkflowDecisionOptionV1[] = groups.map((group, index) => {
    const label = `I ran \`${shortCommandV1(group.command)}\` and it passed`;
    return {
      optionId: `passed${index + 1}`,
      label: several ? `${label} (${itemCountPhraseV1(group.itemTexts.length)})` : label,
      resumeKind: "unpause",
      consequence:
        `Records a passing run (exit code 0) of \`${group.command}\` ` +
        `as your test report for the ${itemCountPhraseV1(group.itemTexts.length)} that name it, marked as yours. ` +
        "It counts as test evidence for those items only; it does not tick anything by itself, and it is not a reviewer verification.",
      effect: { kind: "command", command: RECORD_OWNER_TEST_RUN_COMMAND_V1, args: [recordArg(group, "passed")] },
    };
  });
  const failedOptions: WorkflowDecisionOptionV1[] = groups.map((group, index) => ({
    optionId: several ? `failed${index + 1}` : "failed",
    label: !several ? "I ran it and it failed" : `I ran \`${shortCommandV1(group.command)}\` and it failed`,
    resumeKind: "unpause",
    consequence:
      "Notes in this chat that the run failed. Nothing is stored: you did not give an exit code, and a failing run never counts as test evidence, so the items stay as they are.",
    effect: { kind: "command", command: RECORD_OWNER_TEST_RUN_COMMAND_V1, args: [recordArg(group, "failed")] },
  }));
  const notNowOption: WorkflowDecisionOptionV1 = {
    optionId: "notNow",
    label: "Not now",
    resumeKind: "unpause",
    consequence: "Nothing is recorded. The items stay as they are until a round or you supply a passing test report.",
    effect: { kind: "doNothing" },
  };
  const notOfferedNote =
    notOffered.length > 0
      ? ` ${itemCountPhraseV1(notOffered.length)} name${notOffered.length === 1 ? "s" : ""} a command not offered here and stay${notOffered.length === 1 ? "s" : ""} as ${notOffered.length === 1 ? "it is" : "they are"}.`
      : "";
  return {
    decisionKey: "ownerTestRunRecord",
    taskCanonicalId: input.taskCanonicalId,
    stage: input.stage,
    whatHappened:
      `${itemCountPhraseV1(count)} ${count === 1 ? "is" : "are"} built but held back only because no passing test report is recorded. ` +
      "If you ran the tests yourself, you can record that run here." +
      (several ? " Each option covers only the items whose text names that command." : "") +
      notOfferedNote +
      unnamedNote +
      multiNote,
    whyUserNeeded:
      "Only you know whether the tests were run and passed outside Ensemble. Ensemble does not run them for you from this card and does not tick anything on its own.",
    options: [...passedOptions, ...failedOptions, notNowOption],
    recommendation: { kind: "none", reasoning: "Choose the option that matches what you actually ran." },
    gating: {
      holdsTaskPaused: false,
      unblocksProgress: false,
      detail: "This card does not pause the task; only its options act.",
    },
    createdAt: input.createdAt,
  } as Omit<CreateWorkflowDecisionInputV1, "decisionId">;
}

export async function postOwnerTestRunCardV1(arg?: OwnerTestRunCardArgV1): Promise<WorkflowDecisionCommandResultV1 | boolean> {
  if (!arg?.taskFolderPath || arg.itemTexts.length === 0) return false;
  const partition = partitionItemsByNamedCommandV1(arg.itemTexts);
  if (partition.groups.length === 0) {
    return {
      outcome: "refused",
      message:
        partition.multiCommand.length > 0
          ? "Every listed item names several run commands or none, so no single recorded run can cover any of them. Settle them with Decide item by item, or have a round run each command."
          : "None of the listed items names the command that would satisfy it, so there is no command to record a run of. Settle them with Decide item by item, or have a round run the tests.",
    };
  }
  const target: ChatTarget = {
    canonicalId: arg.taskFolderPath,
    taskFolderPath: arg.taskFolderPath,
    stage: arg.stage,
    taskName: arg.displayName,
  };
  const posted = await postWorkflowDecisionV1(
    buildOwnerTestRunCardInputV1({ ...arg, taskCanonicalId: arg.taskFolderPath, createdAt: new Date().toISOString() }),
    target
  );
  return posted
    ? { outcome: "done", message: `The test-run card is in this chat (${STAGE_DISPLAY_NAMES[arg.stage]}).` }
    : { outcome: "refused", message: "The test-run card could not be posted; nothing was recorded." };
}

export async function recordOwnerTestRunFromCardV1(arg?: RecordOwnerTestRunArgV1): Promise<WorkflowDecisionCommandResultV1 | boolean> {
  if (!arg?.taskFolderPath) return false;
  const taskName = formatNotificationTaskLabelV1(arg.displayName, arg.taskFolderPath);
  if (arg.outcome === "failed") {
    return {
      outcome: "done",
      message: `${taskName}: noted that \`${arg.command}\` failed. Nothing was recorded and the ${itemCountPhraseV1(arg.itemTexts.length)} stay as they are.`,
    };
  }
  const result = await recordOwnerTestRunV1({
    taskFolderPath: arg.taskFolderPath,
    formId: randomBytes(16).toString("hex"),
    command: arg.command,
    exitCode: 0,
    summary: "Recorded by the owner from the test-run chat card: the owner said the run passed.",
    itemTexts: arg.itemTexts,
  });
  if (!result.ok) return { outcome: "refused", message: `${taskName}: ${result.reason}` };
  return { outcome: "done", message: result.message };
}

export function registerOwnerTestRunCommandsV1(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(POST_OWNER_TEST_RUN_CARD_COMMAND_V1, (arg?: OwnerTestRunCardArgV1) => postOwnerTestRunCardV1(arg)),
    vscode.commands.registerCommand(RECORD_OWNER_TEST_RUN_COMMAND_V1, (arg?: RecordOwnerTestRunArgV1) => recordOwnerTestRunFromCardV1(arg))
  );
}
