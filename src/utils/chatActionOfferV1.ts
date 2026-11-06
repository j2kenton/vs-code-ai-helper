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
import type { TaskProgress } from "../types/taskProgress";
import * as path from "path";

export interface ChatActionOfferInputV1 {
  readonly taskFolderPath: string;
  readonly progress?: TaskProgress;
  /** Label of the action option, e.g. "Run Publish Checks". */
  readonly actionLabel: string;
  readonly command: string;
  readonly args?: readonly unknown[];
  /** Explicit alternatives shown on the same card, after the recommended action. */
  readonly alternatives?: readonly {
    readonly label: string;
    readonly command: string;
    readonly args?: readonly unknown[];
    readonly consequence?: string;
    /**
     * How choosing this alternative relates to the task's pause. Defaults to
     * `"continue"` (the dispatched command resumes the task) to preserve the
     * pre-existing behavior; an inspect-only alternative whose effect does not
     * resume work (e.g. `vscode.open` for a run log) must set `"unpause"` so
     * the acknowledgement does not claim a resume it never performs.
     */
    readonly resumeKind?: "unpause" | "continue";
  }[];
  /** The notification's own text; it becomes the decision's account of what happened and the recommendation's reason. */
  readonly noticeText: string;
  /**
   * Which option the card recommends. Defaults to the action itself. A caller
   * whose action cannot change the outcome (a re-run of unchanged checks) names
   * an alternative instead, or `none`, and gives the reason shown on the card.
   */
  readonly recommend?: {
    readonly target: "none" | "action" | { readonly alternativeIndex: number };
    readonly reasoning: string;
  };
  /** Replaces the generic "<action> is the next step for <task>" line, for an action that is not the next step. */
  readonly whyUserNeeded?: string;
  /** Consequence text for the action option, replacing the generic "Runs …" line. */
  readonly actionConsequence?: string;
  /** True only for a "Resume" offer: the task stays paused until the action is chosen. */
  readonly holdsTaskPaused?: boolean;
  /** RC9 item 3: an optional offer holds nothing and blocks nothing; it is only a convenience. */
  readonly optional?: true;
  /** The task name the notice already uses, when the caller has it; defaults to the one read from progress. */
  readonly taskLabel?: string;
  /** How choosing the action relates to the task's pause; defaults to `"continue"`. A cancel does not resume anything: `"unpause"`. */
  readonly actionResumeKind?: "unpause" | "continue";
  /** Wording for the closing do-nothing option, when "Not now" would misdescribe it (bugs3 Step 12: "Wait"). */
  readonly doNothingOption?: { readonly label: string; readonly consequence: string };
  /** Secondary information shown on the card, such as technical details kept out of the main text. */
  readonly evidence?: readonly { readonly label: string; readonly detail: string }[];
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
  let progress: TaskProgress | undefined = input.progress;
  if (!progress) {
    const read = await readTaskProgressStrictV1(vscode.Uri.file(input.taskFolderPath), {
      expectedTaskFolder: path.basename(input.taskFolderPath),
    });
    if (read.ok) {
      progress = read.decoded.progress;
    }
  }
  if (!progress) {
    return undefined;
  }
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
      whyUserNeeded: input.whyUserNeeded ?? `${input.actionLabel} is the next step for ${taskLabel}; choose it here to run it now.`,
      options: [
        {
          optionId: "runAction",
          label: input.actionLabel,
          resumeKind: input.actionResumeKind ?? "continue",
          consequence: input.actionConsequence ?? `Runs "${input.actionLabel}" for this task now.`,
          effect: { kind: "command", command: input.command, args: input.args ?? [] },
        },
        ...(input.alternatives ?? []).map((alternative, index) => ({
          optionId: `alternative${index + 1}`,
          label: alternative.label,
          resumeKind: (alternative.resumeKind ?? "continue") as "unpause" | "continue",
          consequence: alternative.consequence ?? `Runs "${alternative.label}" for this task now.`,
          effect: {
            kind: "command" as const,
            command: alternative.command,
            args: alternative.args ?? [],
          },
        })),
        {
          optionId: "notNow",
          label: input.doNothingOption?.label ?? "Not now",
          resumeKind: "unpause",
          consequence: input.doNothingOption?.consequence ?? "Does nothing. The task stays as it is.",
          effect: { kind: "doNothing" },
        },
      ],
      ...(input.evidence !== undefined && input.evidence.length > 0 ? { evidence: input.evidence } : {}),
      recommendation:
        input.recommend === undefined
          ? { kind: "option", optionId: "runAction", reasoning: input.noticeText }
          : input.recommend.target === "none"
            ? { kind: "none", reasoning: input.recommend.reasoning }
            : input.recommend.target === "action"
              ? { kind: "option", optionId: "runAction", reasoning: input.recommend.reasoning }
              : {
                  kind: "option",
                  optionId: `alternative${input.recommend.target.alternativeIndex + 1}`,
                  reasoning: input.recommend.reasoning,
                },
      gating: {
        holdsTaskPaused: input.holdsTaskPaused === true,
        unblocksProgress: input.optional !== true,
        detail: `Choosing "${input.actionLabel}" runs it now; "Not now" leaves the task as it is.`,
      },
      suppressNotification: true,
    },
    target
  );
  if (decision === undefined) {
    return undefined;
  }
  return { command: "vs-code-ai-helper.openWorkflowDecision", title: "Open in Chat", args: [target] };
}
