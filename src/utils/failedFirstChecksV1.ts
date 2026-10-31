/**
 * bugs3 Step 15 (reusing bugs2 Steps 29–30): the failed-first check run, shared by
 * Publish Checks and the post-fix re-check of Fix Linting & Code Errors.
 *
 * When the last full run failed and nothing it depends on has changed in kind
 * (same task, scope, commit, environment and command plan), only the checks that
 * failed are run first. If they still fail the run stops there and that partial
 * result is the outcome; if they pass, the complete selected check set runs ONCE
 * and its result is the outcome. Either way the caller consumes one result and
 * never starts a second full run on top of it.
 */
import type * as vscode from "vscode";
import type { CollectCompletionLintOptions } from "./completionLint";
import {
  describeCurrentPackageManagerV1,
  persistCompletionLintResultV1 as persistCompletionLintResultReal,
  resolveCurrentPublishCommandPlanV1,
  runCompletionLint as runCompletionLintReal,
} from "./completionLint";
import {
  buildFailedPublishFirstTargetsV1,
  buildFailedPublishRunSnapshotV1,
  isFailedPublishRunCompatibleV1,
  readFailedPublishRunSnapshotV1,
} from "./failedPublishRunV1";
import { computePublishScopeId } from "./publishChecksFreshness";

export type CompletionLintResultV1 = Awaited<ReturnType<typeof runCompletionLintReal>>;

export interface FailedFirstChecksOutcomeV1 {
  readonly result: CompletionLintResultV1;
  /**
   * True when only the previously failing checks ran and they still fail: the
   * remaining checks were not run, so the result is a partial failure and must
   * not be recorded as a complete run.
   */
  readonly failedFirst: boolean;
  /** Why the failed-first path was not used (absent when it was). For the progress line and tests. */
  readonly skippedReason?: string;
}

export async function runChecksFailedFirstV1(input: {
  readonly taskFolderUri: vscode.Uri;
  readonly relevantFiles: Parameters<typeof runCompletionLintReal>[1];
  readonly token: vscode.CancellationToken | undefined;
  /** The scope folder the checks will run in (a best-effort guess before they start). */
  readonly scopeFolder: string;
  readonly headCommit: string | null | undefined;
  /** Per-command lifecycle hooks, forwarded to every check run so each command is announced as it starts. */
  readonly onCheckEvent?: CollectCompletionLintOptions["onCheckEvent"];
  /** Test seams: the check runner, the result writer and the failed-run reader. */
  readonly deps?: {
    readonly runCompletionLint?: typeof runCompletionLintReal;
    readonly persist?: typeof persistCompletionLintResultReal;
    readonly readSnapshot?: typeof readFailedPublishRunSnapshotV1;
  };
}): Promise<FailedFirstChecksOutcomeV1> {
  const { taskFolderUri, relevantFiles, token, scopeFolder, headCommit } = input;
  const runCompletionLint = input.deps?.runCompletionLint ?? runCompletionLintReal;
  const persistCompletionLintResultV1 = input.deps?.persist ?? persistCompletionLintResultReal;
  const priorFailure = await (input.deps?.readSnapshot ?? readFailedPublishRunSnapshotV1)(taskFolderUri.fsPath);
  let skippedReason: string | undefined;
  let passNote: string | undefined;
  if (!priorFailure || priorFailure.failures.length === 0) {
    skippedReason = "no earlier failed run is recorded";
  } else if (!priorFailure.runner.packageManager) {
    skippedReason = "the earlier failed run did not record its package manager";
  } else {
    const currentCommands = resolveCurrentPublishCommandPlanV1(scopeFolder);
    const priorCommands = priorFailure.commands.map(({ command }) => command);
    const configuredPlanMatches =
      currentCommands !== null &&
      currentCommands.length === priorCommands.length &&
      currentCommands.every((command, index) => command.trim() === priorCommands[index]?.trim());
    // Rebuild the compatibility evidence using today's bound task, scope, HEAD,
    // environment and execution inputs. The old command plan is accepted only when
    // the current explicit override still agrees; default plans are revalidated by
    // current package scripts/configuration in the fingerprint.
    const currentProbe = buildFailedPublishRunSnapshotV1({
      taskFolder: taskFolderUri.fsPath,
      repositoryRoot: scopeFolder,
      verificationScopeId: computePublishScopeId(scopeFolder),
      headCommit: headCommit ?? undefined,
      result: {
        runAt: new Date().toISOString(),
        passed: false,
        summary: "compatibility probe",
        issueCount: 0,
        missingScripts: [],
        commandsRun: currentCommands ?? [],
        verifiedFolder: scopeFolder,
        verificationEnvironment: {
          cwd: scopeFolder,
          packageManager: describeCurrentPackageManagerV1(scopeFolder),
          envVarNames: Object.keys(process.env).sort(),
        },
        failedChecks: [],
      },
    });
    if (!configuredPlanMatches) {
      skippedReason = "the configured check commands differ from the earlier failed run";
    } else if (!isFailedPublishRunCompatibleV1(priorFailure, currentProbe)) {
      skippedReason = "the earlier failed run is not compatible with the current task, scope, commit or environment";
    } else {
      const targets = buildFailedPublishFirstTargetsV1(priorFailure);
      const targetChecks = targets.map((target) =>
        target.kind === "test-files"
          ? {
              command: `${target.prepareCommand} && ${target.command}`,
              executableCommand: `${target.prepareCommand} && ${target.command}`,
              cwd: target.cwd,
            }
          : {
              command: target.command,
              executableCommand: target.executableCommand,
              cwd: target.cwd,
            }
      );
      if (targetChecks.length === 0) {
        skippedReason = "the earlier failed run named nothing to re-run on its own";
      } else {
        const elapsedStart = Date.now();
        const failedFirst = await runCompletionLint(taskFolderUri, relevantFiles, {
          token,
          onCheckEvent: input.onCheckEvent,
          explicitChecks: targetChecks,
          persist: false,
          rawReportLocation: `runs/failed-first-source-${priorFailure.failedAt.replace(/[^0-9TZ]/g, "-")}-attempt-${new Date().toISOString().replace(/[^0-9TZ]/g, "-")}.log`,
        });
        if (!failedFirst.passed) {
          failedFirst.passed = false;
          failedFirst.passedModuloKnownFlakes = false;
          failedFirst.summary = `Rechecked ${targetChecks.length} previously failing check(s) from ${priorFailure.failedAt}; they still fail after ${Math.max(0, Date.now() - elapsedStart)} ms. Remaining Publish checks were not run. ${failedFirst.summary}`;
          await persistCompletionLintResultV1(taskFolderUri, failedFirst);
          return { result: failedFirst, failedFirst: true };
        }
        passNote = `Rechecked ${targetChecks.length} previously failing check(s) from ${priorFailure.failedAt}; they passed in ${Math.max(0, Date.now() - elapsedStart)} ms. Running the complete selected Publish check set now.`;
      }
    }
  }
  const result = await runCompletionLint(taskFolderUri, relevantFiles, { token, onCheckEvent: input.onCheckEvent });
  if (passNote) {
    result.summary = `${passNote} ${result.summary}`;
    await persistCompletionLintResultV1(taskFolderUri, result);
  }
  return { result, failedFirst: false, ...(skippedReason !== undefined ? { skippedReason } : {}) };
}
