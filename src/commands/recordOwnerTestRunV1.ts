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
  /** Plan item texts the run covers; each must be a top-level item of the current plan. */
  readonly itemTexts: readonly string[];
}

export type OwnerTestRunResultV1 =
  | { readonly ok: true; readonly itemCount: number; readonly counts: boolean; readonly message: string }
  | { readonly ok: false; readonly reason: string };

export async function recordOwnerTestRunV1(input: OwnerTestRunInputV1): Promise<OwnerTestRunResultV1> {
  const command = input.command.trim();
  if (command.length === 0) return { ok: false, reason: "Say which command you ran." };
  if (!Number.isInteger(input.exitCode)) return { ok: false, reason: "The exit code must be a whole number (0 means the run passed)." };
  if (input.itemTexts.length === 0) return { ok: false, reason: "Choose at least one plan item the run covers." };
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
      itemTexts: input.itemTexts,
      at,
      formId: input.formId,
      command,
      exitCode: input.exitCode,
      summary: input.summary,
    })
  );
  if (!patched) return { ok: false, reason: "The task's progress file could not be updated, so nothing was recorded." };
  const counts = input.exitCode === 0;
  return {
    ok: true,
    itemCount: new Set(input.itemTexts.map(normalizeChecklistItemTextV1)).size,
    counts,
    message: counts
      ? `Recorded your passing run of \`${command}\` as test evidence for ${input.itemTexts.length} plan item(s), with you as the source. It still needs a review to verify them.`
      : `Recorded your run of \`${command}\` (exit code ${input.exitCode}). A failing run does not count as test evidence, so the items stay provisional.`,
  };
}
