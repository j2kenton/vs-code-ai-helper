import * as vscode from "vscode";

import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import { IMPLEMENTATION_SUMMARY_FILENAME } from "../types/taskProgress";
import type { WorkflowDecisionCommandResultV1 } from "../types/workflowDecisionV1";
import { ACCEPT_ROUND_TEST_RUNS_COMMAND_V1 } from "../utils/acceptRoundTestRunsCommandIdV1";
import { readTextIfExists } from "../utils/fileUtils";
import { getCanonicalImplementationUri } from "../utils/implementationArtifactResolver";
import {
  diagnoseApplicablePassingTestReportForItemV1,
  getPlanRevisionV1,
  normalizeChecklistItemTextV1,
  type ApplicablePlanItemTestReportV1,
} from "../utils/implementationChecklist";
import { formatNotificationTaskLabelV1 } from "../utils/notificationTaskContextV1";
import { recordPlanItemClaimEvidenceV1, recordPlanItemTestReportV1 } from "../utils/taskProgressTransforms";
import { computeTestDependencyStatesV1 } from "../utils/testDependencyStateV1";
import type { ItemTestFilesContextV1 } from "../utils/itemTestFilesV1";
import { resolveWorkspaceRootForTaskV1 } from "./applyReviewerVerifiedTicks";
import { buildItemTestFilesContextV1 } from "./itemTestFilesContextV1";

/**
 * review2 Step 6 (bugs6 item 25): "Accept the round's test runs". The open-items card offers it for items whose
 * round claim was dropped because the round's report contradicted itself (no checklist change, but items done).
 * It records what the round's own report already shows: a built claim and, where the report's Verification names a
 * passing test command covering the item, that passing test report. It ticks nothing; the next review verifies, or
 * the owner ticks. An item the report gives no passing command for is listed with the reason, never recorded.
 */

export interface AcceptRoundTestRunsArgV1 {
  readonly taskFolderPath?: string;
  readonly displayName?: string;
  readonly itemTexts?: readonly string[];
  /** The run file the report came from, for the message (for example `runs/161-claude-cli-impl.md`). */
  readonly runFile?: string;
}

export interface RoundTestRunAcceptancePlanV1 {
  readonly accepted: readonly { readonly itemText: string; readonly report: ApplicablePlanItemTestReportV1 }[];
  readonly notRecorded: readonly { readonly itemText: string; readonly reason: string }[];
}

/** Pure: which of the items the round's report backs with a passing test command, and why the others are not. */
export function planRoundTestRunAcceptanceV1(
  planText: string,
  roundReport: string,
  itemTexts: readonly string[],
  context?: ItemTestFilesContextV1
): RoundTestRunAcceptancePlanV1 {
  const accepted: { itemText: string; report: ApplicablePlanItemTestReportV1 }[] = [];
  const notRecorded: { itemText: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const itemText of itemTexts) {
    const key = normalizeChecklistItemTextV1(itemText);
    if (seen.has(key)) continue;
    seen.add(key);
    const diagnosis = diagnoseApplicablePassingTestReportForItemV1(planText, itemText, roundReport, context);
    if (diagnosis.kind === "applicable") accepted.push({ itemText, report: diagnosis.report });
    else notRecorded.push({ itemText, reason: diagnosis.reason });
  }
  return { accepted, notRecorded };
}

export async function acceptRoundTestRunsV1(
  arg: AcceptRoundTestRunsArgV1 | undefined
): Promise<WorkflowDecisionCommandResultV1 | boolean> {
  if (!arg?.taskFolderPath || !arg.itemTexts || arg.itemTexts.length === 0) return false;
  const taskName = formatNotificationTaskLabelV1(arg.displayName, arg.taskFolderPath);
  const folderUri = vscode.Uri.file(arg.taskFolderPath);
  const planText = await readTextIfExists(getCanonicalImplementationUri(folderUri)).catch(() => undefined);
  const roundReport = await readTextIfExists(vscode.Uri.joinPath(folderUri, IMPLEMENTATION_SUMMARY_FILENAME)).catch(() => undefined);
  const read = await readTaskProgressStrictV1(folderUri).catch(() => undefined);
  if (planText === undefined || roundReport === undefined || !read || !read.ok) {
    return {
      outcome: "refused",
      message: `${taskName}: plan-final.md, the round's report or the progress file could not be read, so nothing was recorded.`,
    };
  }
  const contextRoot = resolveWorkspaceRootForTaskV1(folderUri) ?? arg.taskFolderPath;
  const testFilesContext = await buildItemTestFilesContextV1({
    workspaceRoot: contextRoot,
    taskFolderPath: arg.taskFolderPath,
    planItemEvidence: read.decoded.progress.planItemEvidence ?? [],
    roundLedger: read.decoded.progress.roundLedger ?? [],
  }).catch(() => undefined);
  const plan = planRoundTestRunAcceptanceV1(planText, roundReport, arg.itemTexts, testFilesContext);
  const source = arg.runFile ? `the round's run ${arg.runFile}` : "the round's last report";
  if (plan.accepted.length > 0) {
    const workspaceRoot = resolveWorkspaceRootForTaskV1(folderUri) ?? arg.taskFolderPath;
    const at = new Date().toISOString();
    const planRevision = getPlanRevisionV1(planText);
    const states = await Promise.all(
      plan.accepted.map((entry) => computeTestDependencyStatesV1(workspaceRoot, [entry.report.testIdentity, entry.report.command]).catch(() => []))
    );
    const roundId = `accepted-round-report-${at}`;
    const patched = await patchTaskProgressStrictV1(folderUri, (current) =>
      plan.accepted.reduce((next, entry, index) => {
        const withClaim = recordPlanItemClaimEvidenceV1(next, {
          planRevision,
          itemText: entry.itemText,
          source: "implementation",
          at,
          roundId,
          planText,
          evidence: `built claim accepted by you from ${source}`,
        });
        return recordPlanItemTestReportV1(withClaim, {
          planRevision,
          planText,
          itemText: entry.itemText,
          report: {
            at,
            roundId,
            testIdentity: entry.report.testIdentity,
            command: entry.report.command,
            workingDirectory: entry.report.workingDirectory ?? workspaceRoot,
            passed: entry.report.passed,
            failed: entry.report.failed,
            sourceState: `Accepted by you from ${source}: ${entry.report.sourceState}`,
            ...((states[index]?.length ?? 0) > 0 ? { testDependencyStates: states[index] } : {}),
          },
        });
      }, current)
    );
    if (!patched) {
      return { outcome: "refused", message: `${taskName}: the progress file changed while recording, so nothing was recorded. Try again.` };
    }
  }
  const n = plan.accepted.length;
  const lines = [
    `${taskName}: accepted ${source} for ${n} of ${arg.itemTexts.length} item${arg.itemTexts.length === 1 ? "" : "s"}: ` +
      `${n === 1 ? "its built claim and passing test report are" : "their built claims and passing test reports are"} recorded as yours. Nothing was ticked; the next review verifies ${n === 1 ? "it" : "them"}.`,
    ...plan.notRecorded.slice(0, 5).map((entry) => `Not recorded: ${entry.itemText.slice(0, 100)} — ${entry.reason}.`),
  ];
  if (plan.notRecorded.length > 0) lines.push("Re-run the round to record those, or settle them item by item.");
  return { outcome: "done", message: lines.join(" ") };
}

export function registerAcceptRoundTestRunsCommandV1(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(ACCEPT_ROUND_TEST_RUNS_COMMAND_V1, (arg?: AcceptRoundTestRunsArgV1) => acceptRoundTestRunsV1(arg))
  );
}
