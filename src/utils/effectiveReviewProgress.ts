/**
 * The effective plan-progress a review reports, reconciled against the plan
 * of record's checklist — the SAME value the stage-advance gates compute
 * (see reviewActions.ts), factored into one helper so read-only surfaces
 * (the Tasks tree's stage rows) can show exactly the count the workflow acts
 * on instead of re-deriving it — or trusting the review's raw
 * `<!-- progress: N/M -->` marker, whose self-chosen denominator can declare
 * a plan finished while most of its checklist remains unchecked.
 */
import * as path from "path";
import * as vscode from "vscode";

import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import { isPlanReviewStage, TaskProgress, TaskStage } from "../types/taskProgress";
import { ChecklistProgressV1 } from "./implementationChecklist";
import { readPlanOfRecordV1 } from "./implementationArtifactResolver";
import { NotificationRouter } from "./notificationRouter";
import {
  parseReviewProgress,
  reconcileProgressWithChecklistV1,
  ReviewProgress,
} from "./reviewReadiness";

/**
 * How an unreadable/corrupt task-progress file behaves mid-read:
 *
 * - `"strict"` — the stage-advance gate's behavior: notify and throw, so a
 *   gate never advances a stage on progress state it could not read.
 * - `"lenient"` (default) — for read-only renders (the Tasks tree): stand
 *   the checklist reconciliation down (checklist → `undefined`, the review's
 *   marker returned unchanged) so a tree render never throws or notifies.
 */
export type EffectiveReviewProgressPolicyV1 = "strict" | "lenient";

/**
 * Result of the advisory task-progress read behind the checklist read:
 * `"ok"` carries the decoded progress (or `undefined` for a simply-missing
 * file — nothing to stand down); `"unreadable"` is the lenient policy's
 * stand-down signal for a corrupt file, which must take the checklist down
 * with it rather than presenting counts the latch state cannot vouch for.
 */
type ChecklistAdvisoryReadV1 =
  | { readonly kind: "ok"; readonly progress: TaskProgress | undefined }
  | { readonly kind: "unreadable" };

/**
 * Strict-decode advisory read of task-progress.json. A missing file is
 * `ok`/`undefined`; any other decode failure notifies and throws under the
 * strict policy (byte-identical to the gate's historical behavior) but
 * reports `"unreadable"` silently under the lenient one.
 */
async function readTaskProgressForChecklistV1(
  folderUri: vscode.Uri,
  policy: EffectiveReviewProgressPolicyV1
): Promise<ChecklistAdvisoryReadV1> {
  const strict = await readTaskProgressStrictV1(folderUri, {
    expectedTaskFolder: path.basename(folderUri.fsPath),
  });
  if (strict.ok) {
    return { kind: "ok", progress: strict.decoded.progress };
  }
  if (strict.code === "missing") {
    return { kind: "ok", progress: undefined };
  }
  if (policy === "lenient") {
    return { kind: "unreadable" };
  }
  NotificationRouter.showError(
    `Task progress for ${path.basename(folderUri.fsPath)} could not be read (${strict.code}) and needs recovery: ${strict.reason}`
  );
  throw new Error(
    `Task progress recovery required for ${path.basename(folderUri.fsPath)} (${strict.code}): ${strict.reason}`
  );
}

/**
 * The plan of record's checklist state, for reconciling against a review's
 * self-reported progress marker (see reconcileProgressWithChecklistV1).
 * `undefined` whenever there is nothing authoritative to reconcile against:
 * no plan-final.md, one that never had a checklist generated, or a latched
 * `checklistProgressUnreliable` stand-down — and, under the lenient policy,
 * a progress file that could not be read at all.
 *
 * The checklist is only authoritative while something is maintaining it.
 * When the last round could not report checkbox state — any runner whose
 * result is runner-authored rather than model-authored — its counts are a
 * snapshot from some earlier round, not a live record of remaining work.
 * Presenting a frozen number as live is worse than presenting none: it would
 * block advancement forever on evidence that stopped updating.
 */
export async function readEffectivePlanChecklistProgressV1(
  folderUri: vscode.Uri,
  policy: EffectiveReviewProgressPolicyV1 = "lenient"
): Promise<ChecklistProgressV1 | undefined> {
  const plan = await readPlanOfRecordV1(folderUri);
  const counted = plan.counts;
  if (!plan.hasChecklist || !counted) {
    return undefined;
  }
  const advisory = await readTaskProgressForChecklistV1(folderUri, policy);
  if (advisory.kind === "unreadable" || advisory.progress?.checklistProgressUnreliable) {
    return undefined;
  }
  return counted;
}

/**
 * The progress a review effectively reports for `stage`:
 *
 * - Plan-review stages emit no implementation-progress marker of their own,
 *   so the raw marker passes through unreconciled — reconciling would
 *   substitute the implementation's outstanding count into the plan stage
 *   and block its advance when returning to implementation is precisely
 *   what would tick those items off.
 * - Every other review stage reconciles the marker against the plan of
 *   record's checklist, so the value shown to the user is the same
 *   checklist-reconciled count the advance gates act on.
 *
 * Parsing stays tolerant of AI-generated variation (see parseReviewProgress):
 * a missing or nonsensical marker yields `null` and callers render exactly
 * their pre-marker, score-only output.
 */
export async function effectiveReviewProgressV1(
  folderUri: vscode.Uri,
  stage: TaskStage,
  reviewText: string,
  policy: EffectiveReviewProgressPolicyV1 = "lenient"
): Promise<ReviewProgress | null> {
  const marker = parseReviewProgress(reviewText);
  if (isPlanReviewStage(stage)) {
    return marker;
  }
  const checklist = await readEffectivePlanChecklistProgressV1(folderUri, policy);
  return reconcileProgressWithChecklistV1(marker, checklist);
}
