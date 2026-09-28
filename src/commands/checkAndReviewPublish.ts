import * as path from "node:path";
import * as vscode from "vscode";
import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import { resolvePublishScopeFolder } from "../utils/completionLint";
import { resolveHeadCommitSha } from "../utils/gitRepoInfo";
import { checkPublishChecksFreshnessV1 } from "../utils/publishChecksFreshness";

/** The single Publish-row "Check and review" command (1.0 item 13). */
export const CHECK_AND_REVIEW_PUBLISH_COMMAND_ID_V1 = "vs-code-ai-helper.checkAndReviewPublish";

export type CheckAndReviewPublishArgV1 =
  | { task?: { folderUri?: vscode.Uri }; taskFolderPath?: string }
  | undefined;

export interface CheckAndReviewPublishDepsV1 {
  /** True when `publish-review.md` carries a valid freshness stamp for the current scope and HEAD. */
  isPublishChecksFresh(taskFolderPath: string): Promise<boolean>;
  executeCommand(command: string, ...args: unknown[]): Thenable<unknown>;
}

function folderPathOfArgV1(arg: CheckAndReviewPublishArgV1): string | undefined {
  if (!arg) {
    return undefined;
  }
  if (arg.taskFolderPath) {
    return arg.taskFolderPath;
  }
  return arg.task?.folderUri?.fsPath;
}

/**
 * Runs the Publish checks when they are missing or stale, then the Publish
 * review. The two steps run one after the other through their own commands, so
 * each acquires and releases its own admission: nothing is handed between them
 * and no new lock state exists. A run that leaves the checks still not fresh
 * (refused, cancelled, unreadable HEAD) stops here without a second warning;
 * the checks command has already said why, and the review command is still
 * available from the palette to retry on its own.
 */
export async function checkAndReviewPublishV1(
  arg: CheckAndReviewPublishArgV1,
  deps: CheckAndReviewPublishDepsV1
): Promise<"reviewed" | "checks-not-fresh"> {
  const taskFolderPath = folderPathOfArgV1(arg);
  // No resolvable folder (command palette without a row): the review command
  // owns the task picker and its own freshness refusal, so hand straight to it.
  if (!taskFolderPath) {
    await deps.executeCommand("vs-code-ai-helper.runReviewWithAI", arg);
    return "reviewed";
  }
  const target = { taskFolderPath };
  if (!(await deps.isPublishChecksFresh(taskFolderPath))) {
    await deps.executeCommand("vs-code-ai-helper.runPublishChecks", target);
    if (!(await deps.isPublishChecksFresh(taskFolderPath))) {
      return "checks-not-fresh";
    }
  }
  await deps.executeCommand("vs-code-ai-helper.runReviewWithAI", target);
  return "reviewed";
}

async function isPublishChecksFreshOnDiskV1(taskFolderPath: string): Promise<boolean> {
  const folderUri = vscode.Uri.file(taskFolderPath);
  const strict = await readTaskProgressStrictV1(folderUri, { expectedTaskFolder: path.basename(taskFolderPath) });
  const progress = strict.ok ? strict.decoded.progress : undefined;
  const { folder } = resolvePublishScopeFolder(folderUri, progress);
  const head = await resolveHeadCommitSha(folder);
  const check = await checkPublishChecksFreshnessV1(folderUri, folder, head);
  return check.status === "valid";
}

export function registerCheckAndReviewPublishCommand(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(CHECK_AND_REVIEW_PUBLISH_COMMAND_ID_V1, (arg?: CheckAndReviewPublishArgV1) =>
      checkAndReviewPublishV1(arg, {
        isPublishChecksFresh: isPublishChecksFreshOnDiskV1,
        executeCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args),
      })
    )
  );
}
