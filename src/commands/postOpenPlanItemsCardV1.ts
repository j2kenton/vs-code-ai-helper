import * as vscode from "vscode";

import { IMPLEMENTATION_SUMMARY_FILENAME, STAGE_ARTIFACT_FILENAMES, type TaskProgress, type TaskStage } from "../types/taskProgress";
import { resolveAllowedTargetedTestCommandV1 } from "../utils/allowedTestCommandV1";
import { getFastForwardRunStateV1 } from "../utils/activeFastForwardRunsV1";
import { readTextIfExists } from "../utils/fileUtils";
import {
  collectPlanItemReasonsV1,
  describeOpenAndHandOffsV1,
  getPlanRevisionV1,
  listUncheckedChecklistItemTextsV1,
  normalizeChecklistItemTextV1,
} from "../utils/implementationChecklist";
import { parseReviewVerifiedCompleteV1 } from "../utils/reviewReadiness";
import { detectTestsRefusedV1 } from "../utils/testsRefusedV1";
import { postWorkflowDecisionV1 } from "../utils/workflowDecisionDispatchV1";
import type { ChatTarget } from "../views/chatView";
import { buildOpenPlanItemsNeedDecisionCardInputV1 } from "./decideOpenPlanItemsV1";

/**
 * bugs4 Step 20 / item 46: the open-items decision card for a plan checklist with unsettled
 * items, built from the newest review and the last editing round's summary. Shared by the
 * "round changed no files" path and the Fast Forward hold for test evidence no round can
 * produce, so both raise the same classified card (no "no reason given", the test-evidence
 * cause named, refused test commands pointing at the permission setup).
 *
 * Returns whether a decision was persisted; the caller supplies its own fallback text.
 */
export async function postOpenPlanItemsCardV1(input: {
  readonly folderUri: vscode.Uri;
  readonly workspaceRootFsPath: string;
  readonly planChecklist: string;
  readonly stage: TaskStage;
  readonly displayName: string | undefined;
  readonly planItemEvidence: TaskProgress["planItemEvidence"] | undefined;
  /** The round summary whose per-item reasons label the items; the newest implementation summary when absent. */
  readonly roundSummary?: string;
}): Promise<{ readonly posted: boolean; readonly openItemCount: number }> {
  const { folderUri, planChecklist } = input;
  const target: ChatTarget = {
    canonicalId: folderUri.fsPath,
    taskFolderPath: folderUri.fsPath,
    stage: input.stage,
    taskName: input.displayName,
  };
  const openItemTexts = listUncheckedChecklistItemTextsV1(planChecklist, Number.MAX_SAFE_INTEGER).items;
  const lastEditingSummary = await readTextIfExists(
    vscode.Uri.joinPath(folderUri, IMPLEMENTATION_SUMMARY_FILENAME)
  ).catch(() => undefined);
  const roundReasonsByKey = new Map(
    collectPlanItemReasonsV1(input.roundSummary ?? lastEditingSummary ?? "").map((entry) => [
      normalizeChecklistItemTextV1(entry.itemText),
      entry.reason,
    ])
  );
  // bugs4 items 5 and 27: the items the newest review verified built, so the card says so
  // instead of printing "no reason given". Only the newest review counts: an older review's
  // verification may predate edits and must not label items as verified now.
  const reviewVerifiedKeys = new Set<string>();
  let newestReview: { readonly text: string; readonly mtime: number } | undefined;
  for (const reviewStage of ["impl-high-review", "impl-low-review"] as const) {
    const reviewName = STAGE_ARTIFACT_FILENAMES[reviewStage];
    if (!reviewName) continue;
    const reviewUri = vscode.Uri.joinPath(folderUri, reviewName);
    const reviewText = await readTextIfExists(reviewUri).catch(() => undefined);
    if (!reviewText) continue;
    const mtime = await vscode.workspace.fs.stat(reviewUri).then((stat) => stat.mtime, () => 0);
    if (!newestReview || mtime > newestReview.mtime) newestReview = { text: reviewText, mtime };
  }
  for (const verifiedText of newestReview ? parseReviewVerifiedCompleteV1(newestReview.text).items : []) {
    reviewVerifiedKeys.add(normalizeChecklistItemTextV1(verifiedText));
  }
  // The built signal for test-dependent items: a durable round claim for the current plan
  // revision. No claim, no "waiting for a test report".
  const builtClaimedKeys = new Set<string>();
  const claimRevision = getPlanRevisionV1(planChecklist);
  for (const entry of input.planItemEvidence ?? []) {
    if (entry.planRevision === claimRevision && entry.claims.length > 0) builtClaimedKeys.add(entry.itemKey);
  }
  // bugs4 Step 20: did the last editing round report its test commands refused? The newest
  // implementation summary says so; the card then points at the permission or tool setup
  // instead of recommending another round that would be refused the same way.
  const lastRoundTestsRefused = lastEditingSummary ? detectTestsRefusedV1(lastEditingSummary) : undefined;
  const allowedTestCommand = resolveAllowedTargetedTestCommandV1(input.workspaceRootFsPath);
  const openSummary = describeOpenAndHandOffsV1(planChecklist);
  const cardInput = buildOpenPlanItemsNeedDecisionCardInputV1({
    ...(lastRoundTestsRefused
      ? { testsRefused: lastRoundTestsRefused, ...(allowedTestCommand ? { allowedTestCommand } : {}) }
      : {}),
    taskFolderPath: folderUri.fsPath,
    taskCanonicalId: folderUri.fsPath,
    stage: input.stage,
    displayName: input.displayName,
    items: openItemTexts.map((itemText) => ({
      itemText,
      reason: roundReasonsByKey.get(normalizeChecklistItemTextV1(itemText)) ?? "",
    })),
    reviewVerifiedKeys,
    builtClaimedKeys,
    ...(openSummary ? { openSummary } : {}),
    createdAt: new Date().toISOString(),
    // RC2 item 13, Step 52: captured NOW, at card-build time, because by the time the owner
    // answers the "Decide item by item" form the Fast Forward call stack that may have raised
    // this card is long gone. When set, applying the owner's decisions resumes Fast Forward
    // from Apply Review with these live counters.
    resumeFastForwardV1: getFastForwardRunStateV1(folderUri.fsPath),
  });
  const posted = await postWorkflowDecisionV1(cardInput, target);
  return { posted: posted !== undefined, openItemCount: openItemTexts.length };
}
