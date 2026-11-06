import * as vscode from "vscode";
import { getCanonicalImplementationUri } from "../utils/implementationArtifactResolver";
import { readTextIfExists } from "../utils/fileUtils";
import {
  getPlanRevisionV1,
  listCheckedChecklistItemTextsV1,
  listUncheckedChecklistItemTextsV1,
  normalizeChecklistItemTextV1,
} from "../utils/implementationChecklist";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import { recordPlanItemOwnerTestRunV1 } from "../utils/taskProgressTransforms";
import { postStageReadyCardIfReadyV1 } from "./automationStoppedCardV1";
import { applyHeldVerifiedTicksAfterEvidenceV1 } from "./applyReviewerVerifiedTicks";
import { appendOwnerRunCommandV1 } from "../utils/ownerEvidenceV1";

/**
 * bugs4 item 21 / Step 19: the owner records a test run they ran by hand (a Docker drill, a full
 * suite) so the test-evidence rule can accept it for the items it covers. The record carries owner
 * provenance (who, when, which form), the command, the exit code and the owner's output or
 * summary. Only a passing run (exit 0) counts as evidence; a failing run is still recorded so the
 * trail shows it, but settles nothing. This does not loosen the rule for model claims: it is an
 * explicit owner decision, like an owner tick.
 */
export interface OwnerTestRunInputV1 {
  readonly taskFolderPath: string;
  readonly formId: string;
  readonly command: string;
  readonly exitCode: number;
  readonly summary: string;
  /**
   * Plan item texts the run covers; each must be a top-level item of the current plan. Optional when the run is
   * recorded against a blocker (`blockerLineageId`): review1 Step 50.
   */
  readonly itemTexts: readonly string[];
  /**
   * review1 Step 50: the lineage id of the blocker this run answers. The run is also recorded under
   * `## Owner evidence` in task.md, with attribution, so the next review sees it and a re-raise of the blocker
   * must cite it.
   */
  readonly blockerLineageId?: string;
  /** The blocker's text, as `## Owner evidence` shows what was answered. Required with `blockerLineageId`. */
  readonly blockerText?: string;
  /** The last lines of the output, as the owner pasted them. */
  readonly outputTail?: string;
}

export type OwnerTestRunResultV1 =
  | { readonly ok: true; readonly itemCount: number; readonly counts: boolean; readonly message: string }
  | { readonly ok: false; readonly reason: string };

export async function recordOwnerTestRunV1(input: OwnerTestRunInputV1): Promise<OwnerTestRunResultV1> {
  const command = input.command.trim();
  if (command.length === 0) return { ok: false, reason: "Say which command you ran." };
  if (!Number.isInteger(input.exitCode)) return { ok: false, reason: "The exit code must be a whole number (0 means the run passed)." };
  const boundToBlocker = input.blockerLineageId !== undefined && input.blockerLineageId.trim().length > 0;
  if (input.itemTexts.length === 0 && !boundToBlocker) {
    return { ok: false, reason: "Choose at least one plan item the run covers." };
  }
  if (boundToBlocker && (input.blockerText ?? "").trim().length === 0) {
    return { ok: false, reason: "Say which blocker the run answers, so the record can be shown against it." };
  }
  if (input.itemTexts.length === 0) {
    // review1 Step 50: a run recorded against a blocker alone covers no plan item.
    const recordedAt = new Date().toISOString();
    try {
      await appendOwnerRunCommandV1(input.taskFolderPath, input.blockerText!.trim(), {
        blockerLineageId: input.blockerLineageId!.trim(),
        command,
        exitCode: input.exitCode,
        recordedAt,
        ...(input.outputTail ? { outputTail: input.outputTail } : {}),
      });
    } catch {
      return { ok: false, reason: "task.md could not be updated, so nothing was recorded." };
    }
    return {
      ok: true,
      itemCount: 0,
      counts: input.exitCode === 0,
      message:
        `Recorded your run of \`${command}\` (exit code ${input.exitCode}) under Owner evidence in task.md, against the ` +
        "blocker it answers, with you as the source. The next review reads it; it may disagree, but it has to cite this record.",
    };
  }
  const plan = await readTextIfExists(getCanonicalImplementationUri(vscode.Uri.file(input.taskFolderPath)));
  if (plan === undefined) return { ok: false, reason: "plan-final.md could not be read, so nothing was recorded." };
  const known = new Set(
    [...listCheckedChecklistItemTextsV1(plan), ...listUncheckedChecklistItemTextsV1(plan, Number.MAX_SAFE_INTEGER).items].map(
      normalizeChecklistItemTextV1
    )
  );
  const unknown = input.itemTexts.filter((text) => !known.has(normalizeChecklistItemTextV1(text)));
  if (unknown.length > 0) {
    return { ok: false, reason: `${unknown.length} of the chosen items are not in the current plan, so nothing was recorded.` };
  }
  const planRevision = getPlanRevisionV1(plan);
  const at = new Date().toISOString();
  const patched = await patchTaskProgressStrictV1(vscode.Uri.file(input.taskFolderPath), (progress) =>
    recordPlanItemOwnerTestRunV1(progress, {
      planRevision,
      planText: plan,
      itemTexts: input.itemTexts,
      at,
      formId: input.formId,
      command,
      exitCode: input.exitCode,
      summary: input.summary,
    })
  );
  if (!patched) return { ok: false, reason: "The task's progress file could not be updated, so nothing was recorded." };
  if (boundToBlocker) {
    await appendOwnerRunCommandV1(input.taskFolderPath, input.blockerText!.trim(), {
      blockerLineageId: input.blockerLineageId.trim(),
      command,
      exitCode: input.exitCode,
      recordedAt: at,
      ...(input.outputTail ? { outputTail: input.outputTail } : {}),
    }).catch(() => undefined);
  }
  const counts = input.exitCode === 0;
  // review1 Step 31: a passing run can settle the last open item; say so at once if the stage is now ready.
  if (counts) {
    // The run is evidence the held review ticks were waiting for: apply them at once (best effort), then check
    // whether that left the stage ready.
    void applyHeldVerifiedTicksAfterEvidenceV1(input.taskFolderPath)
      .catch(() => undefined)
      .then(() => postStageReadyCardIfReadyV1(input.taskFolderPath, "After your test run"));
  }
  return {
    ok: true,
    itemCount: new Set(input.itemTexts.map(normalizeChecklistItemTextV1)).size,
    counts,
    message: counts
      ? `Recorded your passing run of \`${command}\` as test evidence for ${input.itemTexts.length} plan item(s), with you as the source. It still needs a review to verify them.`
      : `Recorded your run of \`${command}\` (exit code ${input.exitCode}). A failing run does not count as test evidence, so the items stay provisional.`,
  };
}
