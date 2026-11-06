/**
 * review1 Step 51: "Run Publish Checks now" on the stop card for a blocker about failing tests. Runs the project's
 * deterministic verification through the same runner Step 34 uses (`collectCompletionLintPreview`: no model call,
 * nothing written to `publish-review.md`), parses the failing tests from the complete output, and saves them so the
 * next round gets them as `{{testFailures}}`. A passing run clears the saved failures.
 *
 * The owner chose this option, so it is an owner-origin run and does not go through the automatic-dispatch gate.
 */
import * as vscode from "vscode";
import { TaskStage } from "../types/taskProgress";
import { WorkflowDecisionCommandResultV1 } from "../types/workflowDecisionV1";
import { collectCompletionLintPreview } from "../utils/completionLint";
import { formatNotificationTaskLabelV1 } from "../utils/notificationTaskContextV1";
import {
  buildTestFailuresV1,
  formatTestFailuresV1,
  RUN_PUBLISH_CHECKS_NOW_COMMAND_V1,
  TEST_FAILURES_MAX_LISTED_V1,
  writeTestFailuresFileV1,
  type TestFailureV1,
} from "../utils/testFailuresV1";

export interface RunPublishChecksNowArgV1 {
  readonly taskFolderPath: string;
  readonly stage?: TaskStage;
  readonly displayName?: string;
}

export interface RunPublishChecksNowDepsV1 {
  readonly runChecks: (folderUri: vscode.Uri) => Promise<{
    readonly runAt: string;
    readonly passed: boolean;
    readonly failedChecks: ReadonlyArray<{ command: string; exitCode: number; output: string }>;
  }>;
  readonly writeFailures: (taskFolderPath: string, formatted: string) => Promise<void>;
}

/** The failures of every failed command in one run, with the run's totals. */
export function collectRunFailuresV1(
  failedChecks: ReadonlyArray<{ command: string; output: string }>
): { failures: TestFailureV1[]; command?: string } {
  const failures: TestFailureV1[] = [];
  let command: string | undefined;
  for (const check of failedChecks) {
    const found = buildTestFailuresV1(check.output, undefined, TEST_FAILURES_MAX_LISTED_V1 - failures.length);
    if (found.length > 0 && command === undefined) command = check.command;
    failures.push(...found);
    if (failures.length >= TEST_FAILURES_MAX_LISTED_V1) break;
  }
  return { failures, ...(command !== undefined ? { command } : {}) };
}

export async function runPublishChecksNowV1(
  arg: RunPublishChecksNowArgV1 | undefined,
  deps: RunPublishChecksNowDepsV1
): Promise<WorkflowDecisionCommandResultV1 | boolean> {
  if (!arg?.taskFolderPath) return false;
  const taskName = formatNotificationTaskLabelV1(arg.displayName, arg.taskFolderPath);
  let result: Awaited<ReturnType<RunPublishChecksNowDepsV1["runChecks"]>>;
  try {
    result = await deps.runChecks(vscode.Uri.file(arg.taskFolderPath));
  } catch (error) {
    return {
      outcome: "refused",
      message: `${taskName}: Publish Checks could not run (${error instanceof Error ? error.message : String(error)}); no failures were recorded.`,
    };
  }
  if (result.passed) {
    await deps.writeFailures(arg.taskFolderPath, "").catch(() => undefined);
    return { outcome: "done", message: `${taskName}: Publish Checks passed, so no failing tests are on record for the next round.` };
  }
  const { failures, command } = collectRunFailuresV1(result.failedChecks);
  if (failures.length === 0) {
    await deps.writeFailures(arg.taskFolderPath, "").catch(() => undefined);
    return {
      outcome: "done",
      message:
        `${taskName}: Publish Checks failed (${result.failedChecks.map((check) => `\`${check.command}\``).join(", ") || "no command named"}), ` +
        "but no individual failing test could be read from the output, so the next round is given none. The failure report is the one to read.",
    };
  }
  await deps.writeFailures(
    arg.taskFolderPath,
    formatTestFailuresV1(failures, { runAt: result.runAt, ...(command !== undefined ? { command } : {}) })
  );
  return {
    outcome: "done",
    message:
      `${taskName}: Publish Checks failed with ${failures.length} failing test${failures.length === 1 ? "" : "s"}. ` +
      "They are saved as evidence/test-failures.md and the next Apply Review is given them.",
  };
}

export function registerRunPublishChecksNowCommandV1(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(RUN_PUBLISH_CHECKS_NOW_COMMAND_V1, (arg?: RunPublishChecksNowArgV1) =>
      runPublishChecksNowV1(arg, {
        runChecks: (folderUri) =>
          Promise.resolve(
            vscode.window.withProgress(
              { location: vscode.ProgressLocation.Notification, title: "Running Publish Checks…", cancellable: true },
              (_progress, token) =>
                collectCompletionLintPreview(folderUri, undefined, {
                  allowScopePrompt: false,
                  includeAiPlanVerification: false,
                  token,
                })
            )
          ).then((preview) => ({
            runAt: preview.runAt,
            passed: preview.passedModuloKnownFlakes ?? preview.passed,
            failedChecks: preview.failedChecks,
          })),
        writeFailures: writeTestFailuresFileV1,
      })
    )
  );
}
