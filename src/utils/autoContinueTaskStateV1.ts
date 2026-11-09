import * as vscode from "vscode";

import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import type { AutoContinueTaskStateV1 } from "./autoContinueV1";

/**
 * review1 Step 53: the two task facts a countdown is armed against and later compared with. A task whose progress
 * cannot be read yields an empty state, which never cancels (and never arms a comparison) on its own.
 */
export async function readAutoContinueTaskStateV1(taskFolderPath: string): Promise<AutoContinueTaskStateV1> {
  try {
    const read = await readTaskProgressStrictV1(vscode.Uri.file(taskFolderPath));
    if (!read.ok) return {};
    const progress = read.decoded.progress;
    return {
      ...(typeof progress.progressVersion === "number" ? { progressVersion: progress.progressVersion } : {}),
      roundCount: progress.roundLedger?.length ?? 0,
      // Only the owner's own Pause stops a countdown: a pause raised by an escalation is what its card's
      // countdown is for.
      ...(progress.status === "paused" && progress.ownerPausedAt !== undefined ? { paused: true } : {}),
    };
  } catch {
    return {};
  }
}
