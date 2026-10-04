/**
 * RC4 item 3: the "Accept this narrowing" option's command. Records the
 * owner's decision to narrow one plan item as a dated entry under
 * `## Accepted Non-Goals` in plan-final.md, then resumes the task and re-runs
 * the stage's review with the unchanged-tree guard bypassed (the review's
 * input changed — Accepted Non-Goals — while the tree, with `.ensemble/`
 * gitignored, did not). It asks nothing: no QuickPick, input box or modal.
 */
import * as vscode from "vscode";
import * as path from "path";
import { isPlanReviewStage, STAGE_ARTIFACT_FILENAMES, TaskStage } from "../types/taskProgress";
import { WorkflowDecisionCommandResultV1 } from "../types/workflowDecisionV1";
import { TaskInventory } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { getCanonicalImplementationUri } from "../utils/implementationArtifactResolver";
import { readTextIfExists, writeTextFileIfUnchangedV1 } from "../utils/fileUtils";
import {
  appendAcceptedNonGoalV1,
  listCheckedChecklistItemTextsV1,
  listOpenPlanItemRecordsV1,
  normalizeChecklistItemTextV1,
} from "../utils/implementationChecklist";
import { NotificationRouter } from "../utils/notificationRouter";
import { formatNotificationTaskLabelV1 } from "../utils/notificationTaskContextV1";
import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import { REVIEW_TARGETS } from "../utils/reviewReadiness";
import { resumeAndRerunReviewV1 } from "./resumeTask";

const COMMAND = "vs-code-ai-helper.acceptPlanItemNarrowingV1";

export interface AcceptPlanItemNarrowingArgV1 {
  readonly taskFolderPath: string;
  /** The review stage the card was raised against. */
  readonly stage: TaskStage;
  readonly itemText: string;
  readonly reason: string;
  readonly blockerDescription: string;
}

export interface AcceptPlanItemNarrowingDepsV1 {
  /** Resolves the task's current stage, or undefined when progress cannot be read. */
  readonly readCurrentStage: (taskFolderPath: string) => Promise<TaskStage | undefined>;
  /**
   * Resumes the task and re-runs its review with the unchanged-tree guard
   * bypassed. Resolves true only when the review was actually dispatched.
   */
  readonly rerunReview: (taskFolderPath: string, stage: TaskStage) => Promise<boolean>;
}

const SETTLES_MARKER = "Settles the review blocker:";

function norm(text: string): string {
  return normalizeChecklistItemTextV1(text).replace(/\s+/g, " ").trim();
}

function isValidArg(arg: AcceptPlanItemNarrowingArgV1 | undefined): arg is AcceptPlanItemNarrowingArgV1 {
  return (
    !!arg &&
    typeof arg.taskFolderPath === "string" &&
    arg.taskFolderPath !== "" &&
    typeof arg.stage === "string" &&
    typeof arg.itemText === "string" &&
    arg.itemText.trim() !== "" &&
    typeof arg.reason === "string" &&
    typeof arg.blockerDescription === "string" &&
    arg.blockerDescription.trim() !== ""
  );
}

export async function acceptPlanItemNarrowingV1(
  arg: AcceptPlanItemNarrowingArgV1 | undefined,
  deps: AcceptPlanItemNarrowingDepsV1
): Promise<WorkflowDecisionCommandResultV1> {
  if (!isValidArg(arg)) {
    return { outcome: "refused", message: "This decision is missing its item or blocker; nothing was written." };
  }
  const taskName = formatNotificationTaskLabelV1(undefined, arg.taskFolderPath);
  // RC7 item 1: at a plan review the decision belongs in plan.md, the plan of
  // record at that point; plan-final.md does not exist yet.
  const atPlanStage = isPlanReviewStage(arg.stage);
  const planFileName = atPlanStage ? (STAGE_ARTIFACT_FILENAMES.plan ?? "plan.md") : "plan-final.md";
  const planUri = atPlanStage
    ? vscode.Uri.joinPath(vscode.Uri.file(arg.taskFolderPath), planFileName)
    : getCanonicalImplementationUri(vscode.Uri.file(arg.taskFolderPath));
  const plan = await readTextIfExists(planUri);
  const stalePlanMessage =
    "the plan changed since this card was posted, or the item is open again; nothing was written";
  if (plan === undefined) {
    return { outcome: "refused", message: `${planFileName} could not be read; ${stalePlanMessage}.` };
  }
  const wanted = norm(arg.itemText);
  const stillPresent = atPlanStage
    ? norm(plan).includes(wanted)
    : listOpenPlanItemRecordsV1(plan).some((r) => norm(r.itemText) === wanted) &&
      listCheckedChecklistItemTextsV1(plan).some((t) => norm(t) === wanted);
  if (!stillPresent) {
    return { outcome: "refused", message: `Plan changed, try again: ${stalePlanMessage}.` };
  }

  const settlesLine = `${SETTLES_MARKER} "${arg.blockerDescription}"`;
  const alreadyRecorded = plan.includes(settlesLine);
  let heading: string | undefined;
  if (!alreadyRecorded) {
    const date = new Date().toISOString().slice(0, 10);
    heading = `Narrowing accepted by the owner (owner decision, ${date})`;
    const reason = arg.reason.replace(/\s+/g, " ").trim();
    const updated = appendAcceptedNonGoalV1(
      plan,
      [{ itemText: arg.itemText, reason: `narrowed: ${reason}. ${settlesLine}` }],
      date,
      heading
    );
    if (!(await writeTextFileIfUnchangedV1(planUri, plan, updated))) {
      return { outcome: "refused", message: `Plan changed, try again: ${planFileName} changed while writing; nothing was written.` };
    }
  }

  // The decision is on record; arranging the re-review is best effort and
  // never turns the decision into a failure.
  try {
    const current = await deps.readCurrentStage(arg.taskFolderPath);
    if (current === undefined || REVIEW_TARGETS[current] !== arg.stage) {
      NotificationRouter.showWarning(
        `${taskName}: the decision was written to ${planFileName}, but the task has since moved past the stage this ` +
          "card was about, so the review was not re-run."
      );
    } else {
      if (!(await deps.rerunReview(arg.taskFolderPath, arg.stage))) {
        NotificationRouter.showWarning(
          `${taskName}: the decision was written to ${planFileName}, but the review was not re-run ` +
            "(the task could not be resumed or is busy). Run the review again to apply it."
        );
      }
    }
  } catch (error) {
    NotificationRouter.showWarning(
      `${taskName}: the decision was written to ${planFileName}, but re-running the review failed: ` +
        `${error instanceof Error ? error.message : String(error)}`
    );
  }
  return alreadyRecorded
    ? { outcome: "alreadyDone", message: "This narrowing was already on record." }
    : { outcome: "done", message: heading };
}

export function registerAcceptPlanItemNarrowingCommandV1(
  context: vscode.ExtensionContext,
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND, (arg?: AcceptPlanItemNarrowingArgV1) =>
      acceptPlanItemNarrowingV1(arg, {
        readCurrentStage: async (taskFolderPath) => {
          const read = await readTaskProgressStrictV1(vscode.Uri.file(taskFolderPath), {
            expectedTaskFolder: path.basename(taskFolderPath),
          });
          return read.ok ? read.decoded.progress.currentStage : undefined;
        },
        rerunReview: (taskFolderPath) =>
          resumeAndRerunReviewV1(inventory, currentTaskStore, { taskFolderPath }, { skipUnchangedTreeGuardV1: true }),
      })
    )
  );
}
