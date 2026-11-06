import * as vscode from "vscode";

import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import type { TaskStage } from "../types/taskProgress";
import type { WorkflowDecisionCommandResultV1 } from "../types/workflowDecisionV1";
import { collectCompletionLintPreview } from "../utils/completionLint";
import { readTextIfExists } from "../utils/fileUtils";
import { getCanonicalImplementationUri } from "../utils/implementationArtifactResolver";
import { normalizeChecklistItemTextV1 } from "../utils/implementationChecklist";
import { formatNotificationTaskLabelV1 } from "../utils/notificationTaskContextV1";
import {
  RUN_CHECKS_FOR_WITHHELD_ITEMS_COMMAND_V1,
  TICK_WITHHELD_TEST_ITEMS_COMMAND_V1,
} from "../utils/withheldTestEvidenceCardV1";
import { applyHeldVerifiedTicksAfterEvidenceV1, resolveWorkspaceRootForTaskV1 } from "./applyReviewerVerifiedTicks";
import { recordPublishChecksReportsForItemsV1 } from "./evidenceGapChecksV1";
import { applySettleChecklistItemV1 } from "./settleChecklistItem";

/**
 * review1 Step 34 / Step 53: the options of the withheld-test-evidence card. Both are owner-origin (the owner chose
 * them on the card), so neither passes the automatic-dispatch gate, and neither dispatches a model round.
 */

export interface RunChecksForWithheldItemsArgV1 {
  readonly taskFolderPath: string;
  readonly stage?: TaskStage;
  readonly itemTexts: readonly string[];
  readonly displayName?: string;
}

export interface RunChecksForWithheldItemsDepsV1 {
  /** One Publish Checks run (no model call): whether it passed and the test files its output names. */
  readonly runChecks: (folderUri: vscode.Uri) => Promise<{ readonly passed: boolean; readonly passedTestFiles: readonly string[] }>;
}

export async function runChecksForWithheldItemsV1(
  arg: RunChecksForWithheldItemsArgV1 | undefined,
  deps: RunChecksForWithheldItemsDepsV1
): Promise<WorkflowDecisionCommandResultV1 | boolean> {
  if (!arg?.taskFolderPath || !arg.itemTexts || arg.itemTexts.length === 0) return false;
  const taskName = formatNotificationTaskLabelV1(arg.displayName, arg.taskFolderPath);
  const folderUri = vscode.Uri.file(arg.taskFolderPath);
  let result: Awaited<ReturnType<RunChecksForWithheldItemsDepsV1["runChecks"]>>;
  try {
    result = await deps.runChecks(folderUri);
  } catch (error) {
    return {
      outcome: "refused",
      message: `${taskName}: Publish Checks could not run (${error instanceof Error ? error.message : String(error)}); nothing was recorded or ticked.`,
    };
  }
  if (!result.passed) {
    return {
      outcome: "done",
      message: `${taskName}: Publish Checks ran and did not pass, so no test report was recorded and nothing was ticked. The ${arg.itemTexts.length} item${arg.itemTexts.length === 1 ? "" : "s"} stay${arg.itemTexts.length === 1 ? "s" : ""} provisional; you can record a run you did, or tick them yourself.`,
    };
  }
  const planText = await readTextIfExists(getCanonicalImplementationUri(folderUri)).catch(() => undefined);
  const read = await readTaskProgressStrictV1(folderUri).catch(() => undefined);
  if (planText === undefined || !read || !read.ok) {
    return { outcome: "refused", message: `${taskName}: plan-final.md or the progress file could not be read, so nothing was recorded.` };
  }
  const recorded = await recordPublishChecksReportsForItemsV1({
    folderUri,
    workspaceRootFsPath: resolveWorkspaceRootForTaskV1(folderUri) ?? arg.taskFolderPath,
    planText,
    progress: read.decoded.progress,
    itemTexts: arg.itemTexts,
    passedTestFiles: result.passedTestFiles,
  });
  const applied = recorded.recordedItems.length > 0 ? await applyHeldVerifiedTicksAfterEvidenceV1(arg.taskFolderPath, taskName) : { ticked: 0, stillWithheld: [] };
  const unmatched = arg.itemTexts.filter((item) => recorded.reasonByItem.has(normalizeChecklistItemTextV1(item)));
  const lines = [
    `${taskName}: Publish Checks passed once. ${recorded.recordedItems.length} of ${arg.itemTexts.length} item${arg.itemTexts.length === 1 ? "" : "s"} had a passing report recorded from their output; ${applied.ticked} ${applied.ticked === 1 ? "was" : "were"} ticked.`,
    ...unmatched.slice(0, 5).map((item) => `Not recorded: ${item.slice(0, 100)} — ${recorded.reasonByItem.get(normalizeChecklistItemTextV1(item))}.`),
  ];
  if (unmatched.length > 0) lines.push("Record a run you did, or tick those items yourself.");
  return { outcome: "done", message: lines.join(" ") };
}

export interface TickWithheldTestItemsArgV1 {
  readonly taskFolderPath?: string;
  readonly itemTexts?: readonly string[];
}

/** "Tick these myself": ticks each item in plan-final.md and records the owner's tick (the settle command's tick mode). */
export async function tickWithheldTestItemsV1(arg: TickWithheldTestItemsArgV1 | undefined): Promise<WorkflowDecisionCommandResultV1 | boolean> {
  if (!arg?.taskFolderPath || !arg.itemTexts || arg.itemTexts.length === 0) return false;
  let ticked = 0;
  for (const itemText of arg.itemTexts) {
    const outcome = await applySettleChecklistItemV1(arg.taskFolderPath, itemText, "tick", "ticked by you: accepted the review's verification without a test report");
    if (outcome.kind === "settled" || outcome.kind === "ownerTickRecorded") ticked += 1;
  }
  const taskName = formatNotificationTaskLabelV1(undefined, arg.taskFolderPath);
  return ticked === arg.itemTexts.length
    ? { outcome: "done", message: `${taskName}: ticked ${ticked} item${ticked === 1 ? "" : "s"} as yours.` }
    : {
        outcome: "done",
        message: `${taskName}: ticked ${ticked} of ${arg.itemTexts.length} item${arg.itemTexts.length === 1 ? "" : "s"}; the rest were settled or changed since the card was posted.`,
      };
}

export function registerWithheldTestEvidenceCommandsV1(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(RUN_CHECKS_FOR_WITHHELD_ITEMS_COMMAND_V1, (arg?: RunChecksForWithheldItemsArgV1) =>
      runChecksForWithheldItemsV1(arg, {
        runChecks: async (folderUri) => {
          const preview = await Promise.resolve(
            vscode.window.withProgress(
              { location: vscode.ProgressLocation.Notification, title: "Running Publish Checks…", cancellable: true },
              (_progress, token) =>
                collectCompletionLintPreview(folderUri, undefined, { allowScopePrompt: false, includeAiPlanVerification: false, token })
            )
          );
          return { passed: preview.passedModuloKnownFlakes ?? preview.passed, passedTestFiles: preview.passedTestFiles ?? [] };
        },
      })
    ),
    vscode.commands.registerCommand(TICK_WITHHELD_TEST_ITEMS_COMMAND_V1, (arg?: TickWithheldTestItemsArgV1) => tickWithheldTestItemsV1(arg))
  );
}
