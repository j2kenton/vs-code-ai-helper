import type { TaskStatus } from "../types/taskProgress";

/**
 * bugs5 Step 6 / item 21: when the idle "checklist is flagged unreliable" card is built.
 *
 * The card is not a stored decision: the chat builds it on every render while the task is idle and
 * the flag is set, so Dismiss had nothing to record and the card came straight back. The owner's
 * dismissal is therefore remembered per task and per *generation* of the flag (when it was last
 * set), so it holds until a round sets the flag again. Pure of VS Code.
 */

/** The slice of a task's progress the card's rules read. */
export interface IdleReconcileProgressSliceV1 {
  readonly status?: TaskStatus;
  readonly currentStage: string;
  readonly checklistProgressUnreliable?: boolean;
  readonly checklistProgressUnreliableSetAt?: string;
  readonly checklistProgressUnreliableReason?: string;
}

/**
 * The flag's generation. A record written before `checklistProgressUnreliableSetAt` existed falls
 * back to its reason text, so a dismissal still holds there until the flag is set for a new reason.
 */
export function idleReconcileGenerationV1(progress: IdleReconcileProgressSliceV1): string {
  return progress.checklistProgressUnreliableSetAt ?? `legacy:${progress.checklistProgressUnreliableReason ?? "unrecorded"}`;
}

/** Remembered dismissals: task key (normalised folder path) to the generation that was dismissed. */
export type IdleReconcileDismissalsV1 = Readonly<Record<string, string>>;

export const IDLE_RECONCILE_DISMISSALS_STATE_KEY_V1 = "ensemble.idleReconcileDismissals";

export function recordIdleReconcileDismissalV1(
  dismissals: IdleReconcileDismissalsV1,
  taskKey: string,
  generation: string
): IdleReconcileDismissalsV1 {
  return { ...dismissals, [taskKey]: generation };
}

export interface IdleReconcileCardInputV1 {
  readonly progress: IdleReconcileProgressSliceV1;
  readonly dismissals: IdleReconcileDismissalsV1;
  readonly taskKey: string;
  /**
   * Whether the task's tracked files have uncommitted changes (`git status --porcelain --
   * <implReviewFiles>` is non-empty). Only consulted at Publish; `undefined` when it could not be
   * determined, which keeps the card (absence is never positive evidence of "committed").
   */
  readonly trackedFilesHaveUncommittedChanges?: boolean;
}

/**
 * Whether the idle card is built: the flag is set, the task is not completed or archived, no
 * dismissal matches the flag's current generation, and at Publish the task's work is not already
 * committed (the flag gates nothing there any more).
 */
export function shouldBuildIdleReconcileCardV1(input: IdleReconcileCardInputV1): boolean {
  const { progress } = input;
  if (progress.checklistProgressUnreliable !== true) {
    return false;
  }
  if (progress.status === "completed" || progress.status === "archived") {
    return false;
  }
  if (input.dismissals[input.taskKey] === idleReconcileGenerationV1(progress)) {
    return false;
  }
  if (progress.currentStage === "publish" && input.trackedFilesHaveUncommittedChanges === false) {
    return false;
  }
  return true;
}
