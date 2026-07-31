import * as vscode from "vscode";
import { EscalationKind, STAGE_DISPLAY_NAMES, TaskProgress, TaskStage } from "../types/taskProgress";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import { recordEscalation, updateTaskStatus } from "./taskProgressTransforms";
import { NotificationRouter } from "./notificationRouter";
import { normalizePath } from "./taskRoot";

/** Minimal shape this module needs from ChatViewProvider — avoids importing
 * the view layer from a utils module (chatView.ts pulls in webview/vscode UI
 * machinery reviewActions.ts and its callers don't otherwise depend on). */
export interface EscalationChatTarget {
  ask(
    question: { canonicalId: string; taskFolderPath: string; stage: TaskStage; taskName?: string; question: string },
    forceOpen?: boolean,
    notify?: { blocking?: boolean; blockedReason?: string }
  ): Promise<void>;
}

let chatTarget: EscalationChatTarget | undefined;

/** Wire the Chat With AI provider so escalations can post a real question
 * there, not just a notification. Call once from extension.ts, mirroring
 * initNotificationRouter's singleton pattern. */
export function initReviewEscalationChat(provider: EscalationChatTarget): void {
  chatTarget = provider;
}

/**
 * Stop automated review iteration for this task and hand the decision to
 * the human: pause the task (the existing per-command paused guards then
 * starve the automation chain naturally — see stageTransition.ts and every
 * review command's entry check), record why, and surface it through every
 * channel a user might notice it from — Chat With AI (if wired), a
 * Notifications warning with a one-click way back in, and (via the
 * persisted `escalation` field) the task tree's stage description.
 *
 * Never throws: escalation is a best-effort notification path layered on
 * top of the existing review pipeline, and a failure here must not prevent
 * the review that triggered it from having already published successfully.
 *
 * Returns whether the pause/escalation record actually applied. Any of the
 * three write guards below (terminal-status, stage CAS, attempt CAS) can
 * silently decline the write — callers MUST check this before treating the
 * round as escalated: a declined write means no pause, no recorded reason,
 * no notification, and no chat question, so a caller that assumed success
 * anyway would suppress its own auto-advance/auto-publish dispatch for a
 * round that produced no visible outcome at all — a review that publishes,
 * records nothing, says nothing, and advances nothing.
 */
export async function escalateReviewToHuman(
  folderUri: vscode.Uri,
  stage: TaskStage,
  kind: EscalationKind,
  reason: string,
  reviewAttemptId: string,
  progressHint?: Pick<TaskProgress, "displayName">,
  secondOpinionAttempted = false
): Promise<boolean> {
  try {
    let applied = false;
    await patchTaskProgressStrictV1(folderUri, (current) => {
      // Terminal-status guard: a task the user has already completed or
      // archived must never be forced back to "paused" by an escalation
      // decision that was computed against an earlier, now-stale snapshot
      // (this callback can run well after the review round that triggered
      // it, e.g. after a second-opinion AI call). Idempotent on an
      // already-paused task — recording the (possibly updated) reason is
      // still useful there.
      if (current.status === "completed" || current.status === "archived") {
        return current;
      }
      // Stage CAS: only apply when the task is still on the stage this
      // escalation is about. If it has already advanced (or been reverted
      // to a different stage) since the review round that decided to
      // escalate, pausing it now — with a reason naming a stage it isn't on
      // anymore — would be confusing and would incorrectly halt progress
      // that has already legitimately moved on.
      if (current.currentStage !== stage) {
        return current;
      }
      // Attempt CAS: only apply when this is still the attempt that most
      // recently claimed the stage. claimReviewAttempt (reviewActions.ts)
      // overwrites `reviewAttemptId` at the START of every review round —
      // same stage or not — so a same-stage, cross-window race is
      // distinguishable from "nothing else happened": if window B started
      // a newer round on this same stage (e.g. while window A's escalation
      // was still mid-flight through its own second-opinion AI call),
      // `reviewAttemptId` has already moved on even though `currentStage`
      // hasn't. Applying window A's stale escalation in that case would
      // pause the task out from under window B's independent, still-live
      // attempt. Older tasks written before this field existed have no
      // `reviewAttemptId` at all — decline in that ambiguous case too
      // rather than assume it's safe.
      if (current.reviewAttemptId !== reviewAttemptId) {
        return current;
      }
      applied = true;
      return updateTaskStatus(
        recordEscalation(current, { stage, kind, reason, at: new Date().toISOString(), secondOpinionAttempted }),
        "paused"
      );
    });
    if (!applied) {
      return false;
    }

    const stageName = STAGE_DISPLAY_NAMES[stage];
    const question = {
      canonicalId: normalizePath(folderUri.fsPath),
      taskFolderPath: folderUri.fsPath,
      stage,
      taskName: progressHint?.displayName,
      question:
        `Automated review iteration is stuck on ${stageName} and paused the task: ${reason}\n\n` +
        "How would you like to proceed — keep iterating (resume the task and I'll try again), make manual changes yourself, " +
        "or accept the current state and advance anyway?",
    };

    // Genuinely blocking (not just "here's a question, work continues"): the
    // task is paused above and automated review iteration will not resume on
    // its own — error level, not warning, per the "can't proceed without
    // user feedback" contract for hard-blocked automation.
    const blockedReason = `${stageName} is stuck: ${reason} The task has been paused — resume it once you've decided how to proceed.`;
    if (chatTarget) {
      // "vs-code-ai-helper.postStageQuestion" (registered in chatWithStage.ts)
      // routes straight to chatViewProvider.ask(question) — this task's own
      // conversation, not the unrelated Global Assistant. ask() raises the
      // error notification itself (centralized there — see chatView.ts) with
      // that same command as its action button; it only force-opens the
      // panel when nothing else is already open or this task's chat is
      // already the one showing (ask()'s own no-steal-focus rule), and this
      // call already force-opens it once at escalation time, so the button
      // mainly matters for a user who dismissed that and comes back later.
      await chatTarget.ask(question, true, { blocking: true, blockedReason });
    } else {
      // No chat surface wired up (e.g. escalation running outside a full
      // extension host) — fall back to a standalone notification so the
      // escalation is still never silent.
      NotificationRouter.showError(
        `Can't proceed without user feedback — ${question.taskName ?? question.taskFolderPath}: ${blockedReason}`,
        undefined,
        undefined,
        undefined,
        {
          command: "vs-code-ai-helper.postStageQuestion",
          title: "Open Chat",
          args: [question],
        }
      );
    }
    return true;
  } catch (error) {
    NotificationRouter.showWarning(
      `${STAGE_DISPLAY_NAMES[stage]} needs your input (${reason}), but recording the escalation failed: ` +
        (error instanceof Error ? error.message : String(error))
    );
    // Whether the patchTaskProgress write itself landed before throwing is
    // not knowable from here. Report false (not escalated) rather than
    // guess true: the caller's fallback is to let its own independent
    // threshold-based advance/publish logic run, which is always safe,
    // whereas wrongly suppressing it because of an assumed-but-unconfirmed
    // pause would strand the round with no visible outcome at all.
    return false;
  }
}
