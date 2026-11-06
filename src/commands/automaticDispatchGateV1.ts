import * as crypto from "node:crypto";
import * as vscode from "vscode";

import { runWithAdmittedAutomaticDispatchV1 } from "../state/automationDispatchContextV1";
import { evaluateProgressWatchV1, registerAutomaticGateLimitsProviderV1 } from "../state/progressWatchGateV1";
import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import { getResilienceSettings } from "../config/settings";
import { STAGE_DISPLAY_NAMES, type ProgressWatchV1, type TaskProgress, type TaskStage } from "../types/taskProgress";
import type { WorkflowDecisionOptionV1, WorkflowDecisionRecommendationV1 } from "../types/workflowDecisionV1";
import { runGitCommand, resolveGitRepo } from "../utils/gitRepoInfo";
import { resolveEffectiveStageChainV1 } from "../utils/modelSelection";
import { normalizePath } from "../utils/taskRoot";
import {
  describeRoundEndingsV1,
  endingsAreRepeatedProviderFailuresV1,
  listModelsInEndingsV1,
  markProgressWatchHeldV1,
  recordOwnerActionInWatchV1,
} from "../utils/taskProgressWatchV1";
import { postWorkflowDecisionV1, type PostWorkflowDecisionInputV1 } from "../utils/workflowDecisionDispatchV1";

/**
 * review1 Steps 24 and 25: the one gate in front of every automatic dispatch, and the "This isn't moving" card it
 * raises. The decision itself is pure (`progressWatchGateV1.ts`); this file reads settings and task-progress, holds
 * the task when the gate trips, and posts the card.
 */

export type AutomaticDispatchKindV1 =
  | "automation-chain"
  | "fast-forward"
  | "fast-forward-publish-checks"
  | "recovery-sweep"
  | "scheduled-rerun"
  | "backup-retry"
  | "auto-continue";

export const PROGRESS_WATCH_DECISION_KEY_V1 = "progressWatch";
export const PROGRESS_WATCH_KEEP_GOING_COMMAND_V1 = "vs-code-ai-helper.progressWatchKeepGoingV1";
export const PROGRESS_WATCH_CHANGE_MODELS_COMMAND_V1 = "vs-code-ai-helper.progressWatchChangeModelsV1";
export const PROGRESS_WATCH_LEAVE_COMMAND_V1 = "vs-code-ai-helper.progressWatchLeaveWithMeV1";
export const PROGRESS_WATCH_TELL_STAGE_AI_COMMAND_V1 = "vs-code-ai-helper.progressWatchTellStageAiV1";

export type AutomaticDispatchAdmissionV1 =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly reason: "rounds" | "failed"; readonly cardPosted: boolean };

function describeElapsed(fromIso: string, now: Date): string {
  const ms = Math.max(0, now.getTime() - new Date(fromIso).getTime());
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 6) / 10;
  return `${hours} hours`;
}

function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export interface ThisIsntMovingCardInputV1 {
  readonly taskFolderPath: string;
  readonly stage: TaskStage;
  readonly displayName?: string;
  readonly watch: ProgressWatchV1;
  readonly reason: "rounds" | "failed";
  /** Stored model ids in the stage's chain (primary and backups), for "another model is enabled". */
  readonly chainModels: readonly string[];
  /** Working-tree files changed since the last review, when known. */
  readonly unreviewedFileCount?: number;
  readonly now?: Date;
  readonly createdAt?: string;
}

/** The card's text and options: facts, not a diagnosis. Pure, so the wording is testable. */
export function buildThisIsntMovingCardInputV1(
  input: ThisIsntMovingCardInputV1
): Omit<PostWorkflowDecisionInputV1, "createdAt"> {
  const now = input.now ?? new Date();
  const { watch } = input;
  const rounds = watch.endings.filter((ending) => ending.automatic).length;
  const roundWord = `${rounds} automatic round${rounds === 1 ? "" : "s"}`;
  const models = listModelsInEndingsV1(watch.endings);
  const lines = [
    `Automation on this task stopped: ${roundWord} ran in the ${describeElapsed(watch.lastProgressAt, now)} since the last sign of progress, and nothing moved.`,
    `The last thing that moved: ${watch.lastProgressWhat} (${formatClock(watch.lastProgressAt)}).`,
    watch.endings.length > 0 ? `How the rounds ended: ${describeRoundEndingsV1(watch.endings)}.` : undefined,
    models.length > 0 ? `Models that ran: ${models.join(", ")}.` : undefined,
    input.unreviewedFileCount !== undefined && input.unreviewedFileCount > 0
      ? `${input.unreviewedFileCount} changed file${input.unreviewedFileCount === 1 ? " is" : "s are"} in the working tree and not yet reviewed.`
      : undefined,
  ].filter((line): line is string => line !== undefined);

  const failedModels = new Set(
    watch.endings.filter((ending) => ending.kind !== "completed" && ending.model !== undefined).map((ending) => ending.model as string)
  );
  const otherModelEnabled = input.chainModels.some((model) => !failedModels.has(model));
  const providerFailures = endingsAreRepeatedProviderFailuresV1(watch.endings);

  const stageName = STAGE_DISPLAY_NAMES[input.stage] ?? input.stage;
  const taskArg = { taskFolderPath: input.taskFolderPath, stage: input.stage };
  const options: WorkflowDecisionOptionV1[] = [
    {
      optionId: "keepGoing",
      label: "Keep going",
      consequence:
        `Lets automation run another ${input.reason === "failed" ? "few" : "batch of"} rounds and starts ${stageName} again from where it is. If it stops again you will be asked again.`,
      resumeKind: "continue",
      effect: { kind: "command", command: PROGRESS_WATCH_KEEP_GOING_COMMAND_V1, args: [taskArg] },
      recordedNext: `automation runs another batch of rounds on ${stageName}`,
    },
    {
      optionId: "changeModels",
      label: "Change models",
      consequence: `Opens AI Models on the ${stageName} stage so you can switch the model. Nothing runs until you start it again.`,
      resumeKind: "unpause",
      effect: { kind: "command", command: PROGRESS_WATCH_CHANGE_MODELS_COMMAND_V1, args: [taskArg] },
      recordedNext: "AI Models is open on this stage",
    },
    {
      optionId: "leaveWithMe",
      label: "Leave it with me",
      consequence: "Pauses the task. Nothing runs until you resume it.",
      resumeKind: "unpause",
      effect: { kind: "command", command: PROGRESS_WATCH_LEAVE_COMMAND_V1, args: [taskArg] },
      recordedNext: "the task is paused",
    },
    {
      optionId: "tellStageAi",
      label: "Tell the stage AI in my own words…",
      consequence:
        `Asks for your message here, then sends it to the ${stageName} AI as a chat message. Automation stays stopped; the AI answers you and nothing else runs until you start it again.`,
      resumeKind: "unpause",
      effect: { kind: "command", command: PROGRESS_WATCH_TELL_STAGE_AI_COMMAND_V1, args: [taskArg] },
      recordedNext: `your message goes to the ${stageName} AI`,
    },
    {
      optionId: "notNow",
      label: "Not now",
      consequence: "Does nothing. Automation stays stopped for this task until you answer or start something yourself.",
      resumeKind: "unpause",
      effect: { kind: "doNothing", recordedNext: "automation stays stopped" },
    },
  ];
  const recommendation: WorkflowDecisionRecommendationV1 =
    providerFailures && otherModelEnabled
      ? {
          kind: "option",
          optionId: "changeModels",
          reasoning: "The rounds kept failing on the provider side and another model is enabled for this stage, so switching is the step most likely to get things moving.",
        }
      : {
          kind: "none",
          reasoning: "Ensemble can't tell a weaker model from a strict reviewer, an owner-only blocker or a provider limit, and doesn't guess. Which of these is right is your call.",
        };

  return {
    decisionKey: PROGRESS_WATCH_DECISION_KEY_V1,
    taskCanonicalId: normalizePath(input.taskFolderPath),
    stage: input.stage,
    whatHappened: lines.join(" "),
    whyUserNeeded:
      "Nothing is getting settled, fixed or scored higher, and more automatic rounds are unlikely to change that on their own. A person needs to decide whether to keep going, change models or take over.",
    options,
    recommendation,
    gating: {
      holdsTaskPaused: false,
      unblocksProgress: true,
      detail: "Automation for this task is stopped until you answer",
    },
  };
}

async function countUnreviewedFilesV1(taskFolderPath: string): Promise<number | undefined> {
  try {
    const repo = await resolveGitRepo(taskFolderPath);
    if (!repo) return undefined;
    const { stdout } = await runGitCommand(repo, "status", ["--porcelain", "--untracked-files=all"]);
    return stdout
      .split(/\r?\n/)
      .filter((line) => line.length > 3 && !line.slice(3).replace(/\\/g, "/").includes(".ensemble/")).length;
  } catch {
    return undefined;
  }
}

function chainModelsForStageV1(stage: TaskStage): string[] {
  try {
    const chain = resolveEffectiveStageChainV1(stage);
    return [...(chain.primary ? [chain.primary] : []), ...chain.backups];
  } catch {
    return [];
  }
}

/**
 * The gate in front of every automatic dispatch (Fast Forward before each `apply()` and before its Publish Checks,
 * the automation chain, the recovery sweep, scheduled quota reruns, backup retries, auto-continue). Admits unless the
 * task's progress watch says automation has run N rounds with no progress or M rounds in a row that failed; then it
 * holds the task (every later automatic dispatch is refused until the owner answers) and raises one card.
 */
export async function admitAutomaticDispatchV1(input: {
  readonly taskFolderPath: string;
  readonly kind: AutomaticDispatchKindV1;
  readonly stage?: TaskStage;
  readonly displayName?: string;
}): Promise<AutomaticDispatchAdmissionV1> {
  const folderUri = vscode.Uri.file(input.taskFolderPath);
  const read = await readTaskProgressStrictV1(folderUri).catch(() => undefined);
  if (!read || !read.ok) return { admitted: true };
  const progress = read.decoded.progress;
  const decision = evaluateProgressWatchV1(progress.progressWatch, getResilienceSettings());
  if (!decision.trip) return { admitted: true };
  if (decision.alreadyHeld) return { admitted: false, reason: decision.reason, cardPosted: false };

  let held: TaskProgress | undefined;
  try {
    held = await patchTaskProgressStrictV1(folderUri, (current) => {
      if (current.progressWatch?.heldAt !== undefined) return undefined;
      return markProgressWatchHeldV1(current, decision.reason);
    });
  } catch {
    held = undefined;
  }
  const watch = (held ?? progress).progressWatch;
  if (!watch) return { admitted: false, reason: decision.reason, cardPosted: false };
  const stage = input.stage ?? progress.currentStage;
  let cardPosted = false;
  try {
    const unreviewedFileCount = await countUnreviewedFilesV1(input.taskFolderPath);
    const card = buildThisIsntMovingCardInputV1({
      taskFolderPath: input.taskFolderPath,
      stage,
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      watch,
      reason: decision.reason,
      chainModels: chainModelsForStageV1(stage),
      ...(unreviewedFileCount !== undefined ? { unreviewedFileCount } : {}),
    });
    const posted = await postWorkflowDecisionV1(card, {
      canonicalId: normalizePath(input.taskFolderPath),
      taskFolderPath: input.taskFolderPath,
      stage,
      taskName: input.displayName,
    });
    cardPosted = posted !== undefined;
  } catch {
    cardPosted = false;
  }
  return { admitted: false, reason: decision.reason, cardPosted };
}

/**
 * Run `body` as an automatic dispatch that has passed the gate, or return `undefined` without running it when the
 * gate holds the task. The call tree under `body` is marked as having passed, so the work-admission layer admits it.
 */
export async function runIfAutomaticDispatchAdmittedV1<T>(
  input: Parameters<typeof admitAutomaticDispatchV1>[0],
  body: () => Promise<T>
): Promise<{ readonly ran: true; readonly value: T } | { readonly ran: false; readonly admission: AutomaticDispatchAdmissionV1 }> {
  const admission = await admitAutomaticDispatchV1(input);
  if (!admission.admitted) return { ran: false, admission };
  return { ran: true, value: await runWithAdmittedAutomaticDispatchV1(body) };
}

/** The owner did something on this task: progress by definition, and it answers a held gate. Best-effort. */
export async function recordOwnerActionForTaskV1(taskFolderPath: string, what: string): Promise<void> {
  try {
    await patchTaskProgressStrictV1(vscode.Uri.file(taskFolderPath), (current) => recordOwnerActionInWatchV1(current, what));
  } catch {
    // The owner's action itself already happened; the watch is a courtesy record.
  }
}

interface ProgressWatchCommandArgV1 {
  readonly taskFolderPath?: string;
  readonly stage?: TaskStage;
}

export function registerAutomaticDispatchGateV1(context: vscode.ExtensionContext): void {
  registerAutomaticGateLimitsProviderV1(() => {
    const settings = getResilienceSettings();
    return { askOwnerAfterRounds: settings.askOwnerAfterRounds, askOwnerAfterFailedRounds: settings.askOwnerAfterFailedRounds };
  });
  context.subscriptions.push(
    { dispose: () => registerAutomaticGateLimitsProviderV1(undefined) },
    vscode.commands.registerCommand(PROGRESS_WATCH_KEEP_GOING_COMMAND_V1, async (arg?: ProgressWatchCommandArgV1) => {
      if (!arg?.taskFolderPath) return { outcome: "refused", message: "No task was given." };
      await recordOwnerActionForTaskV1(arg.taskFolderPath, "you chose Keep going");
      await vscode.commands.executeCommand("vs-code-ai-helper.applyCurrentStageAction", { taskFolderPath: arg.taskFolderPath });
      return { outcome: "done" };
    }),
    vscode.commands.registerCommand(PROGRESS_WATCH_CHANGE_MODELS_COMMAND_V1, async (arg?: ProgressWatchCommandArgV1) => {
      if (!arg?.taskFolderPath) return { outcome: "refused", message: "No task was given." };
      await recordOwnerActionForTaskV1(arg.taskFolderPath, "you opened AI Models");
      await vscode.commands.executeCommand("vs-code-ai-helper.openAiModels", arg.stage);
      return { outcome: "done" };
    }),
    vscode.commands.registerCommand(PROGRESS_WATCH_TELL_STAGE_AI_COMMAND_V1, async (arg?: ProgressWatchCommandArgV1) => {
      if (!arg?.taskFolderPath) return { outcome: "refused", message: "No task was given." };
      // A clicked-here input, as the owner-decision card's "Answer in my own words…" uses. No text sends nothing and
      // the card comes back.
      const typed = await vscode.window.showInputBox({
        title: "Message for the stage AI",
        prompt: "What should the AI know or do? It is sent as a chat message; automation stays stopped.",
        ignoreFocusOut: true,
      });
      const text = typed?.trim();
      if (!text) {
        return { outcome: "refused", message: "No message was entered, so nothing was sent. The question is open again.", reopenCard: true };
      }
      await recordOwnerActionForTaskV1(arg.taskFolderPath, "you wrote to the stage AI");
      await vscode.commands.executeCommand("vs-code-ai-helper.chatWithStage", {
        taskFolderPath: arg.taskFolderPath,
        ...(arg.stage !== undefined ? { stage: arg.stage } : {}),
        message: text,
        sendId: crypto.randomBytes(16).toString("hex"),
      });
      return { outcome: "done" };
    }),
    vscode.commands.registerCommand(PROGRESS_WATCH_LEAVE_COMMAND_V1, async (arg?: ProgressWatchCommandArgV1) => {
      if (!arg?.taskFolderPath) return { outcome: "refused", message: "No task was given." };
      await recordOwnerActionForTaskV1(arg.taskFolderPath, "you took the task over");
      await vscode.commands.executeCommand("vs-code-ai-helper.pauseTask", { taskFolderPath: arg.taskFolderPath });
      return { outcome: "done" };
    })
  );
}
