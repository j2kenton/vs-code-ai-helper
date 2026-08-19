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
import { TaskStage } from "../types/taskProgress";

/**
 * Set `taskFolderPath`'s stage to `reviewStage`, then invoke that stage's
 * Apply Review command. Returns false when the stage change failed, in which
 * case the apply is NOT attempted — running it out of stage would only
 * reproduce the warning this function exists to avoid.
 */
export async function goToReviewAndApplyV1(input: {
  readonly taskFolderPath: string;
  readonly reviewStage: TaskStage;
}): Promise<boolean> {
  try {
    await vscode.commands.executeCommand("vs-code-ai-helper.setTaskStage", {
      taskFolderPath: input.taskFolderPath,
      stage: input.reviewStage,
    });
  } catch {
    return false;
  }
  await vscode.commands.executeCommand(
    input.reviewStage === "impl-high-review"
      ? "vs-code-ai-helper.applyHighLevelReviewChanges"
      : "vs-code-ai-helper.applyLowLevelReviewChanges",
    { taskFolderPath: input.taskFolderPath }
  );
  return true;
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
