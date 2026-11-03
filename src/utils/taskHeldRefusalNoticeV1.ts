/**
 * chat1 Steps 18 and 19: when another action holds the task and a command is refused as a duplicate,
 * the owner gets ONE Notifications warning that says what holds the task, since when, and what to do,
 * with a way into Chat With AI and (when the holder is a live operation) the row's Stop. The
 * operation that was refused settles as `refused` with the same sentence and is marked as already
 * reported, so the end-of-operation entry is not a second message.
 */
import type { TaskActionOutcomeV1 } from "../types/taskActionOutcomeV1";
import type { TaskProgress } from "../types/taskProgress";
import type { ChatTarget } from "../views/chatView";
import { getLiveTaskOperationV1 } from "./liveTaskOperationLookupV1";
import { NotificationRouter } from "./notificationRouter";
import { describeTaskHeldRefusalV1 } from "./taskActionOutcomeTextV1";
import { formatNotificationTaskLabelV1 } from "./notificationTaskContextV1";
import { listPendingWorkflowDecisionsForTaskV1 } from "./workflowDecisionDispatchV1";

export interface TaskHeldRefusalReportInputV1 {
  readonly outcome: TaskActionOutcomeV1;
  readonly taskFolderPath: string;
  readonly canonicalId: string;
  readonly progress: Pick<TaskProgress, "displayName" | "currentStage">;
  readonly folderName: string;
  /** The refused operation, so it is never named as its own holder. */
  readonly op: {
    readonly id: string;
    settleAs(state: "refused", reason?: string, options?: { readonly reportedByCommand?: boolean }): void;
  };
  /** "Complete Task" and "complete". */
  readonly attemptedAction: string;
  readonly attemptedVerb: string;
}

export interface TaskHeldRefusalMessageInputV1 {
  readonly outcome: TaskActionOutcomeV1;
  readonly taskFolderPath: string;
  readonly canonicalId: string;
  readonly progress: Pick<TaskProgress, "displayName" | "currentStage">;
  readonly folderName: string;
  /** The refused operation's id, so it is never named as its own holder. */
  readonly refusedOperationId?: string;
  /** "Complete Task" and "complete". */
  readonly attemptedAction: string;
  readonly attemptedVerb: string;
}

export interface TaskHeldRefusalMessageV1 {
  readonly message: string;
  /** The live operation holding the task, when the registry has one: the row that can stop it. */
  readonly holderOperationId?: string;
}

/**
 * The owner-facing sentence for a `duplicateRejected` outcome, or undefined for any other outcome.
 * Names what holds the task, since when, and what to do. Never the bare outcome code.
 */
export function buildTaskHeldRefusalMessageV1(
  input: TaskHeldRefusalMessageInputV1
): TaskHeldRefusalMessageV1 | undefined {
  if (input.outcome.kind !== "duplicateRejected") {
    return undefined;
  }
  const taskLabel = formatNotificationTaskLabelV1(input.progress.displayName, input.folderName);
  const registered = getLiveTaskOperationV1(input.taskFolderPath);
  const live = registered !== undefined && registered.operationId !== input.refusedOperationId ? registered : undefined;
  const pending = listPendingWorkflowDecisionsForTaskV1(input.canonicalId);
  const message = describeTaskHeldRefusalV1({
    outcome: input.outcome,
    taskLabel,
    attemptedAction: input.attemptedAction,
    attemptedVerb: input.attemptedVerb,
    ...(live !== undefined ? { live: { label: live.label, ...(live.startedAt !== undefined ? { startedAt: live.startedAt } : {}) } } : {}),
    waitsOnOwner: pending.length > 0,
  });
  return { message, ...(live !== undefined ? { holderOperationId: live.operationId } : {}) };
}

/** The Notifications warning for a held-task refusal: opens the task's chat, and carries the holder's row. */
export function showTaskHeldRefusalWarningV1(
  held: TaskHeldRefusalMessageV1,
  input: Pick<TaskHeldRefusalMessageInputV1, "taskFolderPath" | "canonicalId" | "progress">
): void {
  const target: ChatTarget = {
    canonicalId: input.canonicalId,
    taskFolderPath: input.taskFolderPath,
    stage: input.progress.currentStage,
    taskName: input.progress.displayName,
  };
  NotificationRouter.showWarning(
    held.message,
    undefined,
    undefined,
    held.holderOperationId,
    { command: "vs-code-ai-helper.openWorkflowDecision", title: "Open in Chat", args: [target] }
  );
}

/**
 * Report a `duplicateRejected` outcome. Returns true when it was one (and has been reported), false
 * when the caller should handle the outcome itself.
 */
export function reportTaskHeldRefusalV1(input: TaskHeldRefusalReportInputV1): boolean {
  const held = buildTaskHeldRefusalMessageV1({ ...input, refusedOperationId: input.op.id });
  if (held === undefined) {
    return false;
  }
  input.op.settleAs("refused", held.message, { reportedByCommand: true });
  showTaskHeldRefusalWarningV1(held, input);
  return true;
}
