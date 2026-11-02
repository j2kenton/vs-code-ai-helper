/**
 * bugs5 Step 12: reads what the Publish checks have proved about the task's tree as it is right now,
 * so the recovery card after an interrupted run can recommend Commit & Push, the fix, or the checks.
 * Best-effort: any unreadable piece reads as "never ran or stale", the safe recommendation.
 */
import * as vscode from "vscode";
import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import { parseRecordedCompletionChecksEvidenceV1, resolveCurrentPublishCommandPlanV1, resolvePublishScopeFolder } from "./completionLint";
import { resolveHeadCommitSha } from "./gitRepoInfo";
import type { PublishChecksStateV1 } from "./interruptedRecoveryPlanV1";
import {
  checkPublishChecksReuseEligibilityV1,
  computeCommandIdentityV1,
} from "./publishChecksFreshness";
import {
  estimateChecksMinutesV1,
  failedCommandsAmongFinishedV1,
  lastCompletedPublishChecksV1,
  readPublishChecksOutcomeV1,
} from "./publishChecksOutcomeV1";
import type { TaskStage } from "../types/taskProgress";
import * as path from "node:path";

export interface InterruptedRecoveryStateV1 {
  readonly stage?: TaskStage;
  readonly checksState: PublishChecksStateV1;
  readonly lastRunCommands?: readonly string[];
  readonly lastRunMinutes?: number;
}

export async function readInterruptedRecoveryStateV1(taskFolderPath: string): Promise<InterruptedRecoveryStateV1> {
  const taskFolderUri = vscode.Uri.file(taskFolderPath);
  const outcome = readPublishChecksOutcomeV1(taskFolderPath);
  const lastRunMinutes = estimateChecksMinutesV1(outcome);
  const read = await readTaskProgressStrictV1(taskFolderUri, { expectedTaskFolder: path.basename(taskFolderPath) }).catch(() => undefined);
  const progress = read?.ok ? read.decoded.progress : undefined;
  const base = { ...(progress ? { stage: progress.currentStage } : {}), ...(lastRunMinutes !== undefined ? { lastRunMinutes } : {}) };
  const ownFailure = outcome?.outcome === "interrupted" && failedCommandsAmongFinishedV1(outcome.finishedCommands).length > 0;
  if (ownFailure || lastCompletedPublishChecksV1(outcome)?.outcome === "failed") {
    return { ...base, checksState: "failed" };
  }
  try {
    const scopeFolder = resolvePublishScopeFolder(taskFolderUri, progress).folder;
    const commands = resolveCurrentPublishCommandPlanV1(scopeFolder);
    const identity = computeCommandIdentityV1(commands ?? undefined);
    const withCommands = commands !== null && commands.length > 0 ? { lastRunCommands: commands } : {};
    if (identity === undefined) {
      return { ...base, ...withCommands, checksState: "neverRanOrStale" };
    }
    const eligibility = await checkPublishChecksReuseEligibilityV1(
      taskFolderUri,
      scopeFolder,
      await resolveHeadCommitSha(scopeFolder),
      (content) => parseRecordedCompletionChecksEvidenceV1(content)?.passed === true,
      identity
    );
    return { ...base, ...withCommands, checksState: eligibility.eligible ? "passedOnCurrentTree" : "neverRanOrStale" };
  } catch {
    return { ...base, checksState: "neverRanOrStale" };
  }
}
