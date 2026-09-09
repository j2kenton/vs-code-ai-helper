/**
 * Move a task to one of its implementation review stages and run Apply Review
 * there.
 *
 * Apply Review is a review-stage action, and every entry point enforces that
 * independently: `applyLowLevelReviewChanges` refuses unless the task is at a
 * `*-low-review` stage, `applyHighLevelReviewChanges` the same for high, and
 * `applyReviewEditWithAI` resolves against `IMPL_REVIEW_STAGES`, which does
 * not include `impl`.
 *
 * That matters because every place worth OFFERING Apply Review is a place the
 * task is not at a review stage:
 *
 *  - the pre-run check on Implementation, and the stage action — the task is
 *    at `impl`, which is exactly why an Implementation button was available
 *    to press in the first place;
 *  - the zero-file-change warning after an Implementation round — same stage;
 *  - Fast Forward's sibling-stage notice — the task is at the stage Fast
 *    Forward targeted, so the SIBLING review's apply action is out of stage.
 *
 * Dispatching the apply command directly from any of those produced nothing
 * but "Task is not at a Low-Level Review stage" — an offer that could only be
 * made from the one stage where it could not be accepted (2026-08-19: a user
 * took the offered button and got exactly that warning).
 *
 * `kind: "jump"` matches a manual stage change: it does not auto-trigger a
 * fresh review, so this applies the review already on disk rather than
 * spending a round regenerating it.
 */

import * as vscode from "vscode";
import * as path from "path";
import { TaskStage } from "../types/taskProgress";
import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";

/**
 * Set `taskFolderPath`'s stage to `reviewStage`, then invoke that stage's
 * Apply Review command. Returns false when the stage change failed, in which
 * case the apply is NOT attempted — running it out of stage would only
 * reproduce the warning this function exists to avoid.
 */
export async function goToReviewAndApplyV1(input: {
  readonly taskFolderPath: string;
  readonly reviewStage: TaskStage;
  /**
   * Forwarded verbatim to whichever `applyHighLevelReviewChanges`/
   * `applyLowLevelReviewChanges` dispatch this function makes below. Set
   * ONLY by a caller that already holds live durable admission for this
   * exact task across this whole call (currently `runImplementationWithAI`'s
   * post-operation redirect, and `applyCurrentStageAction.ts`'s `impl`-stage
   * branch relaying a scheduler-supplied token) and wants this redirect to
   * adopt that marker instead of racing a fresh genesis against it and
   * self-blocking as `busy` (2026-09-09 review completion blocker, narrowed
   * — "the Implementation-stage Apply Review redirect can self-block in the
   * same way while its outer admission remains held"). See
   * `applyCurrentStageAction.ts`'s `ApplyArg.admissionHandoffTokenV1` doc
   * comment for the full token-handoff rationale.
   */
  readonly admissionHandoffTokenV1?: string;
}): Promise<boolean> {
  try {
    await vscode.commands.executeCommand("vs-code-ai-helper.setTaskStage", {
      taskFolderPath: input.taskFolderPath,
      stage: input.reviewStage,
    });
  } catch {
    return false;
  }
  // `setTaskStage` reports EVERY failure by notification and then returns —
  // it does not throw (setTaskStage.ts: the cancel-running-operations failure
  // and the transition failure both `showError`/`showWarning` then `return`).
  // So the catch above is nearly dead code, and the only trustworthy signal
  // that the stage moved is the persisted stage itself.
  //
  // This is not hypothetical. Observed 2026-08-19: a running operation would
  // not stop, `setTaskStage` reported "Could not set stage … The running
  // operation did not stop in time", returned normally, and this function
  // dispatched the apply anyway — which then warned "Task is not at a
  // Low-Level Review stage". The user saw two contradictory errors and no
  // work, from the exact out-of-stage dispatch this function exists to
  // prevent.
  const verified = await readTaskProgressStrictV1(
    vscode.Uri.file(input.taskFolderPath),
    { expectedTaskFolder: path.basename(input.taskFolderPath) }
  );
  if (!verified.ok || verified.decoded.progress.currentStage !== input.reviewStage) {
    // `setTaskStage` has already told the user why, in terms specific to the
    // real cause; adding a second notification here would only compete with
    // it. Returning false lets a caller that cares distinguish "did not run"
    // from "ran".
    return false;
  }
  // Both commands now report whether they actually dispatched the downstream
  // apply command (`true`) or refused on their own guard clauses (`false`) —
  // 2026-09-09 review completion blocker, narrowed. Relay that here instead
  // of assuming dispatch succeeded just because the stage moved: the stage
  // read above is a snapshot, and the apply command re-reads and re-checks
  // (paused, stage) independently.
  const applied = await vscode.commands.executeCommand<boolean>(
    input.reviewStage === "impl-high-review"
      ? "vs-code-ai-helper.applyHighLevelReviewChanges"
      : "vs-code-ai-helper.applyLowLevelReviewChanges",
    {
      taskFolderPath: input.taskFolderPath,
      admissionHandoffTokenV1: input.admissionHandoffTokenV1,
    }
  );
  return applied === true;
}

/**
 * Registered so notification action buttons can reach this — a
 * `NotificationRouter` action dispatches exactly one command with one
 * argument, and this is two commands in sequence.
 *
 * Not contributed to package.json's `commands`: it is a wiring detail behind
 * notification buttons, not something to offer in the command palette, where
 * it would read as a way to change a task's stage.
 */
export function registerGoToReviewAndApplyCommandV1(
  context: vscode.ExtensionContext
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "vs-code-ai-helper.goToReviewAndApply",
      (arg?: { taskFolderPath?: string; reviewStage?: TaskStage }) =>
        arg?.taskFolderPath && arg.reviewStage
          ? goToReviewAndApplyV1({
              taskFolderPath: arg.taskFolderPath,
              reviewStage: arg.reviewStage,
            })
          : Promise.resolve(false)
    )
  );
}
