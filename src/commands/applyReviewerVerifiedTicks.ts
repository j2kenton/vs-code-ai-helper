import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { IncompleteTask } from "../types/incompleteTask";
import { NotificationRouter } from "../utils/notificationRouter";
import { TaskCreationStartupReconcilerV1 } from "../state/taskCreationStartupReconcilerV1";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import {
  getCanonicalImplementationUri,
  readPlanOfRecordV1,
} from "../utils/implementationArtifactResolver";
import {
  filterUncheckedPlanItemsV1,
  mergeChecklistProgressV1,
} from "../utils/implementationChecklist";
import { parseReviewVerifiedCompleteV1 } from "../utils/reviewReadiness";
import { writeTextFile } from "../utils/fileUtils";
import { STAGE_ARTIFACT_FILENAMES, TaskStage, isReviewStage } from "../types/taskProgress";

type ApplyArg =
  | { task?: IncompleteTask }
  | { canonicalId?: string; taskFolderPath?: string; reviewStage?: TaskStage };

function normalizeArg(
  arg: ApplyArg | undefined
): { canonicalId?: string; taskFolderPath?: string; reviewStage?: TaskStage } | undefined {
  if (!arg) {
    return undefined;
  }
  // Same shape tolerance as reconcilePlanChecklist's normalizer: explicit ids
  // first, and the tree-node branch guarded against a partial `task` that
  // carries only `progress` (no `folderUri`).
  const explicit = arg as { canonicalId?: string; taskFolderPath?: string; reviewStage?: TaskStage };
  if (explicit.canonicalId || explicit.taskFolderPath) {
    return {
      canonicalId: explicit.canonicalId,
      taskFolderPath: explicit.taskFolderPath,
      reviewStage: explicit.reviewStage,
    };
  }
  if ("task" in arg && arg.task?.folderUri) {
    return { taskFolderPath: arg.task.folderUri.fsPath };
  }
  return undefined;
}

/**
 * Builds a synthetic round-summary shape carrying the reviewer's ticks as
 * retroactive claims, so they can be applied through the exact same monotonic
 * merge path (`mergeChecklistProgressV1`) an implementation round's own echo
 * uses, rather than a parallel ticking mechanism that could disagree with it.
 *
 * The leading `## Files Changed` heading with no checkbox items under it is
 * what `filesChangedIsSummaryBoundary` requires to treat everything after it
 * as the round's "own" text (`splitSummaryAtEchoV1`) — where
 * `collectRetroactiveTickClaimsV1` reads claims from.
 */
function buildSyntheticVerifiedCompleteSummaryV1(
  items: readonly string[],
  evidence: string
): string {
  const lines = [
    "## Files Changed",
    "",
    "(no files — ticks applied from a reviewer's Verified Complete list)",
    "",
    "## Plan Item Checklist",
    "",
    ...items.map((item) => `- ${item} — done <!-- ensemble:retroactive --> — ${evidence}`),
    "",
  ];
  return lines.join("\n");
}

/**
 * Apply a reviewer's `## Verified Complete` list to plan-final.md as ticks —
 * the "Apply N reviewer-verified ticks" one-click path (workflow 3
 * continuation plan, Part 5). The reviewer already opened the relevant files
 * and confirmed specific unchecked plan items are actually done; this command
 * applies that assertion through the same monotonic, text-matched merge path
 * a round's own retroactive claim uses, so the operator is no longer asked to
 * retype a verification the reviewer already performed.
 *
 * Re-derives the verified-complete set from the review artifact and the plan
 * of record AT INVOCATION TIME (and again immediately before writing) rather
 * than trusting a list threaded through the triggering notification's command
 * args — both files may have changed since. This is simpler and safer than a
 * hard abort-on-race check: ticking is monotonic and matched by text
 * identity, so recomputing against whatever is on disk right now can never
 * lose a tick or apply the wrong one, unlike reconcilePlanChecklist's latch
 * clear, which approves a byte-exact human judgement and must abort rather
 * than silently re-target it.
 */
export async function applyReviewerVerifiedTicks(
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore,
  explicitArg?: ApplyArg
): Promise<void> {
  await TaskCreationStartupReconcilerV1.waitUntilReady();
  const normalized = normalizeArg(explicitArg);
  const resolved = await resolveTaskContext(
    inventory,
    normalized,
    { allowPaused: true },
    currentTaskStore
  );
  if (!resolved) {
    NotificationRouter.showError(
      "The task could not be found. Refresh the Tasks panel and try again."
    );
    return;
  }

  const folderUri = vscode.Uri.file(resolved.taskFolderPath);
  const reviewStage = normalized?.reviewStage ?? resolved.progress.currentStage;
  if (!isReviewStage(reviewStage)) {
    NotificationRouter.showInformation(
      "This task is not on a review stage, so there is no reviewer verification to apply."
    );
    return;
  }
  const reviewFilename = STAGE_ARTIFACT_FILENAMES[reviewStage];
  if (!reviewFilename) {
    NotificationRouter.showInformation(
      "This review stage has no artifact to read verification from."
    );
    return;
  }
  const reviewUri = vscode.Uri.joinPath(folderUri, reviewFilename);
  let reviewContent: string;
  try {
    const bytes = await vscode.workspace.fs.readFile(reviewUri);
    reviewContent = new TextDecoder().decode(bytes);
  } catch {
    NotificationRouter.showInformation(`No ${reviewFilename} was found for this task yet.`);
    return;
  }
  const verified = parseReviewVerifiedCompleteV1(reviewContent);
  if (verified.items.length === 0) {
    NotificationRouter.showInformation("This review named no items as verified complete.");
    return;
  }

  const plan = await readPlanOfRecordV1(folderUri);
  if (!plan.hasChecklist || !plan.text) {
    NotificationRouter.showWarning(
      "plan-final.md has no implementation checklist to tick, so there is nothing to apply."
    );
    return;
  }

  const applicable = filterUncheckedPlanItemsV1(plan.text, verified.items);
  if (applicable.length === 0) {
    NotificationRouter.showInformation(
      "Every item this review named as verified complete is already ticked in plan-final.md."
    );
    return;
  }

  const preview = applicable.slice(0, 10).map((t) => `- ${t}`).join("\n");
  const more = applicable.length > 10 ? `\n…and ${applicable.length - 10} more.` : "";
  const confirmed = await vscode.window.showWarningMessage(
    `Apply ${applicable.length} reviewer-verified tick(s) to plan-final.md?\n\n${preview}${more}\n\n` +
      `Source: ${reviewFilename}. These items are ticked on the strength of the review's own verification ` +
      "against the tree — confirm only if you trust that assessment.",
    { modal: true },
    "Apply Ticks"
  );
  if (confirmed !== "Apply Ticks") {
    return;
  }

  const freshPlan = await readPlanOfRecordV1(folderUri);
  if (!freshPlan.hasChecklist || !freshPlan.text) {
    NotificationRouter.showWarning(
      "plan-final.md changed while the confirmation was open and no longer has a checklist to tick."
    );
    return;
  }
  const freshApplicable = filterUncheckedPlanItemsV1(freshPlan.text, verified.items);
  if (freshApplicable.length === 0) {
    NotificationRouter.showInformation(
      "These items were already ticked by the time this was applied."
    );
    return;
  }

  const evidence = `verified by reviewer in ${reviewStage} review (${reviewFilename})`;
  const synthetic = buildSyntheticVerifiedCompleteSummaryV1(freshApplicable, evidence);
  const merged = mergeChecklistProgressV1(freshPlan.text, synthetic);
  if (merged.kind !== "merged") {
    NotificationRouter.showWarning(
      "Applying the reviewer's ticks did not change plan-final.md — the items no longer match the plan of record."
    );
    return;
  }

  await writeTextFile(getCanonicalImplementationUri(folderUri), merged.content);
  await inventory.refresh();
  NotificationRouter.showInformation(
    `Applied ${freshApplicable.length} reviewer-verified tick(s) to plan-final.md.`
  );
}

export function registerApplyReviewerVerifiedTicksCommands(
  context: vscode.ExtensionContext,
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "vs-code-ai-helper.applyReviewerVerifiedTicks",
      (arg?: ApplyArg) => applyReviewerVerifiedTicks(inventory, currentTaskStore, arg)
    )
  );
}
