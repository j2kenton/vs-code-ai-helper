/**
 * review1 Step 49: reads the saved diagnosis, builds the follow-up card (`buildDiagnosisFollowUpDecisionV1`) and posts
 * it. Throws on failure; callers treat it as best effort.
 */
import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { TaskStage } from "../types/taskProgress";
import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import { buildDiagnosisFollowUpDecisionV1 } from "../utils/diagnosisFollowUpCardV1";
import { postWorkflowDecisionV1 } from "../utils/workflowDecisionDispatchV1";
import { normalizePath } from "../utils/taskRoot";

export interface DiagnosisCardInputV1 {
  readonly stage: TaskStage;
  readonly diagnosisPath: string;
  readonly failure: string;
}

export async function postDiagnosisFollowUpCardV1(taskFolderPath: string, input: DiagnosisCardInputV1): Promise<void> {
  const diagnosis = await fs
    .readFile(path.join(taskFolderPath, ...input.diagnosisPath.split("/")), "utf8")
    .catch(() => undefined);
  const read = await readTaskProgressStrictV1(vscode.Uri.file(taskFolderPath), {
    expectedTaskFolder: path.basename(taskFolderPath),
  }).catch(() => undefined);
  const taskName = read && read.ok ? read.decoded.progress.displayName : undefined;
  const canonicalId = normalizePath(taskFolderPath);
  const card = buildDiagnosisFollowUpDecisionV1({
    stage: input.stage,
    target: { canonicalId, taskFolderPath, taskName },
    diagnosisPath: input.diagnosisPath,
    diagnosis,
    failure: input.failure,
  });
  await postWorkflowDecisionV1(card, { canonicalId, taskFolderPath, stage: input.stage, taskName });
}
