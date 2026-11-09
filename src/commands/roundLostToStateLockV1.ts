/**
 * run1 Steps 22 and 23: what the owner sees when a round could not finish because another window held a
 * task-state lease for longer than Ensemble waits for it (about 30 s, see `taskStateStore.ts`).
 *
 * A round must never disappear silently (bugs6 item 24). When the wait runs out the round ends with its
 * ledger row closed, an "_Ended:" line that names the cause, and a card whose first option is "Retry now".
 * Nothing here writes task state itself: the ledger row is closed by the caller (its write may be the very
 * one that cannot get the lease), and `rowClosed` says whether that worked. When it did not, the line is
 * posted here, and the row is left to the orphan sweep.
 */
import { PrimarySessionLockHeldError } from "../state/primarySessionLock";
import type { ChatTarget } from "../views/chatView";
import type { TaskStage } from "../types/taskProgress";
import { STAGE_DISPLAY_NAMES } from "../types/taskProgress";
import * as vscode from "vscode";
import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import { formatNotificationTaskLabelV1 } from "../utils/notificationTaskContextV1";
import type { WorkflowDecisionOptionV1 } from "../types/workflowDecisionV1";
import type { PostWorkflowDecisionInputV1 } from "../utils/workflowDecisionDispatchV1";

/** The cause as the owner reads it. */
export const STATE_LOCK_EXHAUSTED_CAUSE_V1 = "another window was updating task state for more than 30 s";

/** True when the error is the state lease still being held after the bounded wait. */
export function isStateLockExhaustedErrorV1(error: unknown): boolean {
  return error instanceof PrimarySessionLockHeldError;
}

export interface RetryActionV1 {
  readonly command: string;
  readonly args: unknown[];
}

export interface RoundLostToStateLockInputV1 {
  readonly taskFolderPath: string;
  readonly stage: TaskStage;
  /** The plain step name, as in the ledger's "_Ended:" line ("High-Level Code Review"). */
  readonly stepName: string;
  /** Whether the caller managed to close the round's ledger row (which posts its own "_Ended:" line). */
  readonly rowClosed: boolean;
  readonly retry: RetryActionV1;
  /**
   * True only when the caller knows the round stopped before any model was started (the claim, the scope
   * rebuild). Only then may the owner be told nothing was changed. Any later stop may already have left
   * edits in the working tree, so the default wording says they are kept.
   */
  readonly beforeAnyWork?: boolean;
}

export interface RoundLostToStateLockDepsV1 {
  appendEndedLine(taskFolderPath: string, stage: TaskStage, text: string): Promise<void>;
  postCard(input: PostWorkflowDecisionInputV1, target: ChatTarget): Promise<unknown>;
  /** `taskLabel` is the quoted task name the notification leads with. */
  notify(message: string, retry: RetryActionV1, taskLabel: string): void;
}

/** The "_Ended:" line, in the ledger's own shape. */
export function formatStateLockEndedLineV1(stepName: string): string {
  return `_Ended: ${stepName} — failed — ${STATE_LOCK_EXHAUSTED_CAUSE_V1}_`;
}

/** What happens to the work already done, in plain words: it depends on whether a model had started. */
export function describeRetainedWorkV1(beforeAnyWork: boolean | undefined): {
  readonly retryConsequence: string;
  readonly notificationTail: string;
} {
  return beforeAnyWork === true
    ? {
        retryConsequence: "Nothing from the stopped round was kept or lost: it never got as far as changing the task.",
        notificationTail: "Nothing was changed; run it again.",
      }
    : {
        retryConsequence:
          "Anything the stopped round had already changed is still in the working tree, and nothing was undone. Running it again carries on from those changes.",
        notificationTail: "Any changes it already made are still in the working tree; run it again to carry on from them.",
      };
}

export function buildStateLockExhaustedCardV1(input: RoundLostToStateLockInputV1): PostWorkflowDecisionInputV1 {
  const stageName = STAGE_DISPLAY_NAMES[input.stage] ?? input.stage;
  const options: WorkflowDecisionOptionV1[] = [
    {
      optionId: "retry",
      resumeKind: "continue",
      label: "Retry now",
      consequence: `Runs ${input.stepName} again. ${describeRetainedWorkV1(input.beforeAnyWork).retryConsequence}`,
      effect: { kind: "command", command: input.retry.command, args: input.retry.args },
    },
    {
      optionId: "stay",
      resumeKind: "unpause",
      label: "Leave it",
      consequence: "Does nothing. You can run the step yourself later.",
      effect: { kind: "doNothing" },
    },
  ];
  return {
    decisionKey: "stateLockExhausted",
    taskCanonicalId: input.taskFolderPath,
    stage: input.stage,
    whatHappened: `${input.stepName} stopped: ${STATE_LOCK_EXHAUSTED_CAUSE_V1}.`,
    whyUserNeeded:
      `Another window kept the task state busy for longer than Ensemble waits, so the ${stageName} could not carry on. ` +
      "Running it again is safe once that window has finished what it was doing.",
    options,
    recommendation: {
      kind: "option",
      optionId: "retry",
      reasoning: "The other window's change is normally over within seconds, so running the step again should work.",
    },
    gating: {
      holdsTaskPaused: false,
      unblocksProgress: true,
      detail: "Nothing is paused by this card. \"Retry now\" runs the step again; \"Leave it\" does nothing.",
    },
  };
}

/**
 * Says that the round ended and why. Never throws: each surface is tried on its own, so one that
 * fails cannot hide the others.
 */
export async function reportRoundLostToStateLockV1(
  input: RoundLostToStateLockInputV1,
  deps: RoundLostToStateLockDepsV1
): Promise<{ readonly postedLine: boolean; readonly postedCard: boolean; readonly notified: boolean }> {
  let postedLine = false;
  if (!input.rowClosed) {
    try {
      await deps.appendEndedLine(input.taskFolderPath, input.stage, formatStateLockEndedLineV1(input.stepName));
      postedLine = true;
    } catch {
      // The notification below still says it.
    }
  }
  let postedCard = false;
  try {
    postedCard = (await deps.postCard(buildStateLockExhaustedCardV1(input), {
      canonicalId: input.taskFolderPath,
      taskFolderPath: input.taskFolderPath,
      stage: input.stage,
    })) !== undefined;
  } catch {
    postedCard = false;
  }
  let notified = false;
  if (!postedCard || !input.rowClosed) {
    // No card, or no ledger line behind it: a notification with the same Retry now is the floor.
    try {
      // The notification names its task; the stored display name may be unreadable, then the folder's own name is used.
      const stored = await readTaskProgressStrictV1(vscode.Uri.file(input.taskFolderPath)).catch(() => undefined);
      const displayName = stored?.ok ? stored.decoded.progress.displayName : undefined;
      deps.notify(
        `${input.stepName} stopped: ${STATE_LOCK_EXHAUSTED_CAUSE_V1}. ${describeRetainedWorkV1(input.beforeAnyWork).notificationTail}`,
        input.retry,
        formatNotificationTaskLabelV1(displayName, input.taskFolderPath)
      );
      notified = true;
    } catch {
      // Nothing left to try.
    }
  }
  return { postedLine, postedCard, notified };
}
