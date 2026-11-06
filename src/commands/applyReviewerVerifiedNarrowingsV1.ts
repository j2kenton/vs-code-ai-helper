/**
 * review1 Step 43: the narrowings a review VERIFIED (its `## Verified narrowing` block) are applied to the plan of
 * record the way reviewer-verified ticks are: one card per task offers them ("Apply the N verified narrowings"),
 * and the owner's choice writes them (owner decision 2026-11-04: nothing is written to the plan without that card).
 *
 * A narrowing is a statement that part of a ticked plan item does not apply. The reviewer files it only with
 * checkable evidence ("file B never references X"); each one becomes a nested, already-excluded child of the item,
 * noted `narrowed (reviewer-verified): <evidence>`, so the part that was cut stays visible in the plan. A narrowing
 * the reviewer could not verify is still the owner's decision and still raises the owner card (the
 * "Narrowing needs an owner decision" blocker), so this never settles one the reviewer did not check.
 */
import * as vscode from "vscode";

import { appendChatMessageV1 } from "../utils/chatHistoryStore";
import { writeTextFileIfUnchangedV1 } from "../utils/fileUtils";
import {
  applyVerifiedNarrowingsToPlanV1,
  normalizeChecklistItemTextV1,
  stripPlanItemAnnotationsV1,
  type VerifiedNarrowingInputV1,
} from "../utils/implementationChecklist";
import { getCanonicalImplementationUri, readPlanOfRecordV1 } from "../utils/implementationArtifactResolver";
import { parseReviewVerifiedNarrowingsV1 } from "../utils/reviewReadiness";
import { withdrawStaleOpenItemsCardV1 } from "../utils/withdrawStaleOpenItemsCardV1";
import { postWorkflowDecisionV1 } from "../utils/workflowDecisionDispatchV1";
import { normalizePath } from "../utils/taskRoot";
import { STAGE_ARTIFACT_FILENAMES, isReviewStage, type TaskStage } from "../types/taskProgress";
import type { WorkflowDecisionCommandResultV1 } from "../types/workflowDecisionV1";
import { carryReviewerVerificationToNarrowedItemsV1, listReviewerVerifiedItemKeysV1 } from "./applyReviewerVerifiedTicks";
import { refreshPlanItemSettlementSnapshotV1 } from "./planItemSettlementNoticeV1";

/** The identity of one narrowing a card offered: the item, the part that does not apply and the evidence, compared loosely. */
function narrowingIdentityV1(narrowing: VerifiedNarrowingInputV1): string {
  const clean = (text: string): string => text.replace(/\s+/g, " ").trim().replace(/\.$/, "").toLowerCase();
  return [
    normalizeChecklistItemTextV1(stripPlanItemAnnotationsV1(narrowing.itemText)),
    clean(narrowing.notApplicable),
    clean(narrowing.evidence),
  ].join("\u0000");
}

export const APPLY_VERIFIED_NARROWINGS_COMMAND_V1 = "vs-code-ai-helper.applyReviewerVerifiedNarrowingsConfirmed";
export const APPLY_VERIFIED_NARROWINGS_DECISION_KEY_V1 = "applyReviewerVerifiedNarrowings";

/** The verified narrowings that would change the plan now (not yet applied, and placeable on a top-level item). */
export async function listPendingVerifiedNarrowingsV1(
  folderUri: vscode.Uri,
  reviewContent: string
): Promise<readonly { readonly itemText: string; readonly notApplicable: string; readonly evidence: string }[]> {
  const narrowings = parseReviewVerifiedNarrowingsV1(reviewContent);
  if (narrowings.length === 0) return [];
  const plan = await readPlanOfRecordV1(folderUri);
  if (!plan.hasChecklist || plan.text === undefined) return [];
  return applyVerifiedNarrowingsToPlanV1(plan.text, narrowings).applied;
}

/**
 * Raises the one card offering a review's verified narrowings, nothing written until the owner chooses. Returns
 * the number offered (0 when the review verified none, or they are already in the plan).
 */
export async function postVerifiedNarrowingsDecisionV1(
  folderUri: vscode.Uri,
  stage: TaskStage,
  reviewContent: string,
  displayName?: string
): Promise<number> {
  const pending = await listPendingVerifiedNarrowingsV1(folderUri, reviewContent);
  if (pending.length === 0) return 0;
  const reviewFilename = isReviewStage(stage) ? STAGE_ARTIFACT_FILENAMES[stage] : "the review";
  const canonicalId = normalizePath(folderUri.fsPath);
  const count = pending.length;
  const posted = await postWorkflowDecisionV1(
    {
      decisionKey: APPLY_VERIFIED_NARROWINGS_DECISION_KEY_V1,
      taskCanonicalId: canonicalId,
      stage,
      whatHappened:
        `${reviewFilename} verified ${count === 1 ? "1 narrowing" : `${count} narrowings`}: part of a ticked plan item ` +
        "that the reviewer checked does not apply.",
      whyUserNeeded:
        "Recording a narrowing changes what a plan item says, so it is yours to confirm once. The reviewer gave " +
        "checkable evidence for each one, and each stays visible in the plan as an excluded sub-item.",
      options: [
        {
          optionId: "apply",
          label: `Apply ${count === 1 ? "the verified narrowing" : `the ${count} verified narrowings`}`,
          resumeKind: "unpause",
          consequence:
            `Adds ${count === 1 ? "this" : "these"} as excluded sub-item${count === 1 ? "" : "s"} noted "narrowed (reviewer-verified)" in plan-final.md; the item${count === 1 ? "" : "s"} keep${count === 1 ? "s" : ""} the reviewer's verification:\n` +
            pending
              .map((n) => `- “${n.itemText.slice(0, 120)}”: ${n.notApplicable.replace(/\.$/, "")} does not apply (${n.evidence.replace(/\.$/, "")}).`)
              .join("\n"),
          effect: {
            kind: "command",
            command: APPLY_VERIFIED_NARROWINGS_COMMAND_V1,
            // The card applies exactly what it offered; a review that changed since is not applied under it.
            args: [{ taskFolderPath: folderUri.fsPath, stage, offered: pending }],
          },
        },
        {
          optionId: "skip",
          label: "Not yet",
          resumeKind: "unpause",
          consequence: "Does nothing. The plan keeps the full wording of those items until you apply this or reword them yourself.",
          effect: { kind: "doNothing" },
        },
      ],
      recommendation: {
        kind: "option",
        optionId: "apply",
        reasoning: "The reviewer checked each narrowing against the code and cited the evidence; applying only records it.",
      },
      gating: {
        holdsTaskPaused: false,
        unblocksProgress: false,
        detail: "This records the reviewer's verified narrowings in the plan; nothing waits on it.",
      },
    },
    { canonicalId, taskFolderPath: folderUri.fsPath, stage, taskName: displayName }
  );
  return posted ? count : 0;
}

/** The "Apply" option: re-reads the review on disk and writes the narrowings it still verifies, then re-records the items' verification. */
export async function applyVerifiedNarrowingsConfirmedV1(arg: {
  readonly taskFolderPath: string;
  readonly stage: TaskStage;
  /** The narrowings the card offered; when given, only these are applied. */
  readonly offered?: readonly VerifiedNarrowingInputV1[];
}): Promise<WorkflowDecisionCommandResultV1> {
  const folderUri = vscode.Uri.file(arg.taskFolderPath);
  const reviewFilename = isReviewStage(arg.stage) ? STAGE_ARTIFACT_FILENAMES[arg.stage] : undefined;
  if (!reviewFilename) {
    return { outcome: "refused", message: "That stage has no review to take narrowings from." };
  }
  let content: string;
  try {
    content = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folderUri, reviewFilename)));
  } catch {
    return { outcome: "refused", message: "The review file could not be read, so nothing was changed." };
  }
  const result = await applyReviewerVerifiedNarrowingsV1(folderUri, arg.stage, content, arg.offered);
  if (result.applied.length === 0) {
    const why = result.skipped[0]?.reason;
    return why
      ? { outcome: "refused", message: `Nothing was changed: ${why}.` }
      : { outcome: "alreadyDone", message: "Already done: those narrowings are in the plan." };
  }
  return { outcome: "done" };
}

export function registerApplyReviewerVerifiedNarrowingsCommandV1(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      APPLY_VERIFIED_NARROWINGS_COMMAND_V1,
      (arg: { taskFolderPath: string; stage: TaskStage; offered?: readonly VerifiedNarrowingInputV1[] }) =>
        applyVerifiedNarrowingsConfirmedV1(arg)
    )
  );
}

export interface AppliedVerifiedNarrowingsV1 {
  /** The items whose narrowing was written to the plan. */
  readonly applied: readonly string[];
  /** Verified narrowings that could not be placed, each with the reason. */
  readonly skipped: readonly { readonly itemText: string; readonly reason: string }[];
}

/**
 * Writes the review's verified narrowings into `plan-final.md` (conditional write, so a concurrent edit is
 * refused rather than overwritten) and says so in the chat. A review without the block, or a task without a
 * checklist, changes nothing.
 */
export async function applyReviewerVerifiedNarrowingsV1(
  folderUri: vscode.Uri,
  stage: TaskStage,
  reviewContent: string,
  offered?: readonly VerifiedNarrowingInputV1[]
): Promise<AppliedVerifiedNarrowingsV1> {
  let narrowings = parseReviewVerifiedNarrowingsV1(reviewContent);
  if (offered !== undefined) {
    // Only what the card offered, and only while the review still verifies it.
    const offeredIdentities = new Set(offered.map(narrowingIdentityV1));
    narrowings = narrowings.filter((n) => offeredIdentities.has(narrowingIdentityV1(n)));
    if (narrowings.length === 0 && offered.length > 0) {
      return {
        applied: [],
        skipped: offered.map((n) => ({
          itemText: n.itemText,
          reason: "the review changed after this card was raised and no longer verifies what it offered",
        })),
      };
    }
  }
  if (narrowings.length === 0) {
    return { applied: [], skipped: [] };
  }
  const plan = await readPlanOfRecordV1(folderUri);
  if (!plan.hasChecklist || plan.text === undefined) {
    return { applied: [], skipped: narrowings.map((n) => ({ itemText: n.itemText, reason: "the task has no plan checklist" })) };
  }
  const result = applyVerifiedNarrowingsToPlanV1(plan.text, narrowings);
  if (result.content !== plan.text) {
    // A narrowing adds a nested child, which changes the item's content hash. The items the reviewer had verified
    // are noted first, so their verification can follow the new wording (with the narrowing's evidence as
    // provenance) instead of being dropped; an item that was not verified stays unverified.
    const verifiedBefore = await listReviewerVerifiedItemKeysV1(folderUri, plan.text);
    const written = await writeTextFileIfUnchangedV1(getCanonicalImplementationUri(folderUri), plan.text, result.content);
    if (!written) {
      return {
        applied: [],
        skipped: narrowings.map((n) => ({ itemText: n.itemText, reason: "the plan changed while the narrowing was being recorded" })),
      };
    }
    await withdrawStaleOpenItemsCardV1(folderUri, result.content).catch(() => undefined);
    await carryReviewerVerificationToNarrowedItemsV1(
      folderUri,
      result.content,
      result.applied
        .filter((n) => verifiedBefore.has(normalizeChecklistItemTextV1(stripPlanItemAnnotationsV1(n.itemText))))
        .map((n) => ({
          itemText: stripPlanItemAnnotationsV1(n.itemText),
          evidence: `reviewer-verified before the narrowing; narrowed (reviewer-verified): ${n.notApplicable.replace(/\.$/, "")} does not apply (${n.evidence.replace(/\.$/, "")})`,
        }))
    ).catch(() => 0);
    await refreshPlanItemSettlementSnapshotV1(folderUri);
    const lines = result.applied.map(
      (n) => `- “${n.itemText.slice(0, 120)}”: ${n.notApplicable.replace(/\.$/, "")} does not apply (${n.evidence.replace(/\.$/, "")}).`
    );
    try {
      await appendChatMessageV1(folderUri.fsPath, {
        role: "assistant",
        text:
          `As you chose, recorded ${result.applied.length === 1 ? "the narrowing" : `the ${result.applied.length} narrowings`} the review verified ` +
          `in plan-final.md as excluded sub-items:\n${lines.join("\n")}`,
        stage,
        at: new Date().toISOString(),
      });
    } catch {
      // The plan is already written; the chat line is best-effort.
    }
  }
  return { applied: result.applied.map((n) => n.itemText), skipped: result.skipped };
}
