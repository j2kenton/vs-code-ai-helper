import * as vscode from "vscode";

import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import type { TaskStage } from "../types/taskProgress";
import {
  describeReviewedLineV1,
  filesPhraseV1,
  parseFilesNotFullyInspectedV1,
  recordReviewCoverageV1,
  statesIncompleteInspectionV1,
  REVIEW_SCOPE_CHANGE_SET_VARIABLE_V1,
} from "../utils/reviewCoverageV1";
import { batchFilesFromVariablesV1 } from "../utils/reviewBatchPassV1";
import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import { appendChatMessageV1 } from "../utils/chatHistoryStore";
import {
  hashWorkspaceFilesV1,
  readFilesReadAtCurrentContentV1,
  readReviewCoverageSummaryV1,
} from "../utils/reviewCoverageIoV1";
import { resolveWorkspaceRootForTaskV1 } from "./applyReviewerVerifiedTicks";

/**
 * review2 Step 17: after an implementation review ends, record which changed files it read in full.
 *
 * The review ran against `variables[reviewScopeChangeSet]` (the change set at dispatch). Files outside its pack
 * (`missingFiles`: not in the list, or cut by the size limit with no file access) were not shown; the rest were
 * shown, embedded or as a "read natively" stanza. A shown file counts unless the reviewer listed it under
 * "## Files not fully inspected". Best effort: a failed write never blocks the review's routing.
 */
export async function recordReviewCoverageAfterReviewV1(input: {
  readonly folderUri: vscode.Uri;
  readonly variables: Readonly<Record<string, string>>;
  readonly reviewContent: string;
  readonly missingFiles: readonly string[];
  readonly runId: string;
  readonly stage: TaskStage;
}): Promise<void> {
  const changedFiles = (input.variables[REVIEW_SCOPE_CHANGE_SET_VARIABLE_V1] ?? "").split("\n").filter((file) => file.length > 0);
  if (changedFiles.length === 0) return;
  const missing = new Set(input.missingFiles.map((file) => file.replace(/\\/g, "/")));
  // review2 Step 29: a batch pass was shown only its own batch; the other batches' files are read by later passes.
  const batchFiles = batchFilesFromVariablesV1(input.variables);
  const inBatch = batchFiles === undefined ? undefined : new Set(batchFiles.map((file) => file.replace(/\\/g, "/")));
  const shown = changedFiles.filter((file) => !missing.has(file) && (inBatch === undefined || inBatch.has(file)));
  const workspaceRoot = resolveWorkspaceRootForTaskV1(input.folderUri);
  if (workspaceRoot === undefined) return;
  const hashes = await hashWorkspaceFilesV1(workspaceRoot, shown);
  const listedNotInspected = parseFilesNotFullyInspectedV1(input.reviewContent);
  // review2 Step 31: a batch pass that says in prose it did not inspect its batch declines all of it.
  const notInspected =
    batchFiles !== undefined && listedNotInspected.length === 0 && statesIncompleteInspectionV1(input.reviewContent)
      ? shown
      : listedNotInspected;
  const now = new Date().toISOString();
  await patchTaskProgressStrictV1(input.folderUri, (current) => ({
    ...current,
    reviewCoverage: recordReviewCoverageV1({
      record: current.reviewCoverage,
      changedFiles,
      shownFiles: shown,
      notInspected,
      hashes,
      runId: input.runId,
      stage: input.stage,
      now,
    }),
  }));
}

/**
 * review2 Step 18: the chat line a finished implementation review leaves about how much of the change it read:
 * "Reviewed: N of M changed files", plus the number still unread when N < M. Best effort; nothing is posted when no
 * coverage is recorded.
 */
export async function postReviewedLineAfterReviewV1(folderUri: vscode.Uri, stage: TaskStage): Promise<void> {
  try {
    const strict = await readTaskProgressStrictV1(folderUri);
    const workspaceRoot = resolveWorkspaceRootForTaskV1(folderUri);
    if (!strict.ok || workspaceRoot === undefined) return;
    const summary = await readReviewCoverageSummaryV1(workspaceRoot, strict.decoded.progress);
    if (summary === undefined) return;
    const missing = summary.changedCount - summary.reviewedCount;
    await appendChatMessageV1(folderUri.fsPath, {
      role: "assistant",
      text:
        missing > 0
          ? `${describeReviewedLineV1(summary)}. ${filesPhraseV1(missing)} not yet read at their current content.`
          : `${describeReviewedLineV1(summary)}.`,
      stage,
      at: new Date().toISOString(),
    });
  } catch {
    // Best effort: the line is information, never a gate.
  }
}

/**
 * review2 Step 22: of `files`, those an earlier review read in full at their current content, for the scope card.
 * Best effort: an unreadable record or workspace gives an empty set, and the card then says no earlier review read them.
 */
export async function readFilesReadEarlierV1(
  folderUri: vscode.Uri,
  files: readonly string[]
): Promise<ReadonlySet<string> | undefined> {
  try {
    const strict = await readTaskProgressStrictV1(folderUri);
    const workspaceRoot = resolveWorkspaceRootForTaskV1(folderUri);
    if (!strict.ok || workspaceRoot === undefined || strict.decoded.progress.reviewCoverage === undefined) {
      return undefined;
    }
    return await readFilesReadAtCurrentContentV1(workspaceRoot, strict.decoded.progress.reviewCoverage, files);
  } catch {
    return undefined;
  }
}
