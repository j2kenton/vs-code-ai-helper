/**
 * RC7 item 4: a notification's button only ever opens the chat. A notice that
 * used to run an action itself ("Run Publish Checks", "Run Publish Review",
 * "Run Review", "Resume") posts that action as a recommended option on a
 * `WorkflowDecisionV1` instead, and attaches the chat pointer this returns.
 * Choosing the option in the chat runs the action; "Not now" does nothing.
 */
import * as vscode from "vscode";
import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import { ChatTarget } from "../views/chatView";
import { postWorkflowDecisionV1 } from "./workflowDecisionDispatchV1";
import { formatNotificationTaskLabelV1 } from "./notificationTaskContextV1";
import * as path from "path";

export interface ChatActionOfferInputV1 {
  readonly taskFolderPath: string;
  /** Label of the action option, e.g. "Run Publish Checks". */
  readonly actionLabel: string;
  readonly command: string;
  readonly args?: readonly unknown[];
  /** The notification's own text; it becomes the decision's account of what happened and the recommendation's reason. */
  readonly noticeText: string;
  /** True only for a "Resume" offer: the task stays paused until the action is chosen. */
  readonly holdsTaskPaused?: boolean;
  /** The task name the notice already uses, when the caller has it; defaults to the one read from progress. */
  readonly taskLabel?: string;
}

export interface ChatPointerActionV1 {
  readonly command: "vs-code-ai-helper.openWorkflowDecision";
  readonly title: "Open in Chat";
  readonly args: [ChatTarget];
}

/**
 * Posts the offer and returns the pointer to attach to the notification, or
 * undefined when the decision cannot be posted (no extension context, or the
 * task's progress cannot be read) — the notice then carries no inline button.
 */
export async function offerActionInChatV1(
  input: ChatActionOfferInputV1
): Promise<ChatPointerActionV1 | undefined> {
  const read = await readTaskProgressStrictV1(vscode.Uri.file(input.taskFolderPath), {
    expectedTaskFolder: path.basename(input.taskFolderPath),
  });
  if (!read.ok) {
    return undefined;
  }
  const progress = read.decoded.progress;
  const target: ChatTarget = {
    canonicalId: input.taskFolderPath,
    taskFolderPath: input.taskFolderPath,
    stage: progress.currentStage,
    taskName: progress.displayName,
  };
  const taskLabel = input.taskLabel ?? formatNotificationTaskLabelV1(progress.displayName, input.taskFolderPath);
  const decision = await postWorkflowDecisionV1(
    {
      decisionKey: `chatActionOffer:${input.command.replace("vs-code-ai-helper.", "")}`,
      taskCanonicalId: input.taskFolderPath,
      stage: progress.currentStage,
      whatHappened: input.noticeText,
      whyUserNeeded: `${input.actionLabel} is the next step for ${taskLabel}; choose it here to run it now.`,
      options: [
        {
          optionId: "runAction",
          label: input.actionLabel,
          resumeKind: "continue",
          consequence: `Runs "${input.actionLabel}" for this task now.`,
          effect: { kind: "command", command: input.command, args: input.args ?? [] },
        },
        {
          optionId: "notNow",
          label: "Not now",
          resumeKind: "unpause",
          consequence: "Does nothing. The task stays as it is.",
          effect: { kind: "doNothing" },
        },
      ],
      recommendation: {
        kind: "option",
        optionId: "runAction",
        reasoning: input.noticeText,
      },
      gating: {
        holdsTaskPaused: input.holdsTaskPaused === true,
        unblocksProgress: true,
        detail: `Choosing "${input.actionLabel}" runs it now; "Not now" leaves the task as it is.`,
      },
    },
    target
  );
  if (decision === undefined) {
    return undefined;
  }
  return { command: "vs-code-ai-helper.openWorkflowDecision", title: "Open in Chat", args: [target] };
}
