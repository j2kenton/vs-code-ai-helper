import * as vscode from "vscode";

import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import { carryOwnerSettledLinesV1 } from "../utils/implementationChecklist";

/**
 * review2 Step 6 (bugs6 item 28): the issued ids of the items the owner settled (ticked or excluded) at or after
 * `since`, read from the owner decisions Ensemble recorded for them. A round that ran while the owner settled items
 * does not own those writes, so the end-of-round checklist check must keep them.
 */
export async function listOwnerSettledItemIdsSinceV1(folderUri: vscode.Uri, since: string): Promise<ReadonlySet<string>> {
  try {
    const read = await readTaskProgressStrictV1(folderUri);
    if (!read.ok) return new Set();
    const ids = new Set<string>();
    for (const row of read.decoded.progress.planItemOwnerDecisions ?? []) {
      if ((row.decision === "tick" || row.decision === "exclude") && row.itemId !== undefined && row.at >= since) {
        ids.add(row.itemId);
      }
    }
    return ids;
  } catch {
    return new Set();
  }
}

/**
 * The plan text to write back when a round changed the checklist's item set: the plan as it read at round start,
 * with the line of every item the owner settled during the round taken from the plan as it reads now. With no
 * `roundStartedAt`, or no owner write in the round, this is exactly `preRoundChecklistText`, as before.
 */
export async function restoreChecklistKeepingOwnerWritesV1(
  folderUri: vscode.Uri,
  preRoundChecklistText: string,
  currentPlanText: string,
  roundStartedAt: string | undefined
): Promise<string> {
  if (roundStartedAt === undefined) return preRoundChecklistText;
  const ownerIds = await listOwnerSettledItemIdsSinceV1(folderUri, roundStartedAt);
  return carryOwnerSettledLinesV1(preRoundChecklistText, currentPlanText, ownerIds);
}
