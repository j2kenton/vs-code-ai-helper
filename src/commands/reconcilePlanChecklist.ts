import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import { IncompleteTask } from "../types/incompleteTask";
import { NotificationRouter } from "../utils/notificationRouter";
import { TaskCreationStartupReconcilerV1 } from "../state/taskCreationStartupReconcilerV1";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import {
  getCanonicalImplementationUri,
  readPlanOfRecordV1,
} from "../utils/implementationArtifactResolver";
import { readTextIfExists, statIfExists } from "../utils/fileUtils";
import {
  listUncheckedChecklistItemTextsV1,
  filterUncheckedPlanItemsV1,
  MergeChecklistProgressResultV1,
} from "../utils/implementationChecklist";
import { parseReviewVerifiedCompleteV1, parseReadiness } from "../utils/reviewReadiness";
import { IMPL_REVIEW_STAGES, STAGE_ARTIFACT_FILENAMES, STAGE_DISPLAY_NAMES, TaskStage } from "../types/taskProgress";
import { postWorkflowDecisionV1 } from "../utils/workflowDecisionDispatchV1";
import { WorkflowDecisionEvidenceItemV1, WorkflowDecisionRecommendationV1 } from "../types/workflowDecisionV1";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import { getExtensionContextV1 } from "../utils/extensionContextV1";
import { ChatTarget } from "../views/chatView";

type ReconcileArg =
  | { task?: IncompleteTask }
  | { canonicalId?: string; taskFolderPath?: string; decisionId?: string };

function normalizeArg(
  arg: ReconcileArg | undefined
): { canonicalId?: string; taskFolderPath?: string; decisionId?: string } | undefined {
  if (!arg) {
    return undefined;
  }
  // Explicit ids first, and the tree-node branch guarded: a dispatcher can
  // hand over a partial `task` carrying only `progress`, which an unguarded
  // `arg.task.folderUri.fsPath` turns into a TypeError.
  const explicit = arg as { canonicalId?: string; taskFolderPath?: string; decisionId?: string };
  if (explicit.canonicalId || explicit.taskFolderPath) {
    return {
      canonicalId: explicit.canonicalId,
      taskFolderPath: explicit.taskFolderPath,
      decisionId: explicit.decisionId,
    };
  }
  if ("task" in arg && arg.task?.folderUri) {
    return { taskFolderPath: arg.task.folderUri.fsPath };
  }
  return undefined;
}

/**
 * Evidence the system already holds for a checklist-reconciliation decision
 * (case 4 — module doc comment on `reconcilePlanChecklist`): for each of the
 * implementation review stages, whether its `## Verified Complete` list (via
 * the SAME text-matching tolerance `applyReviewerVerifiedTicks.ts` already
 * uses — `parseReviewVerifiedCompleteV1` + `filterUncheckedPlanItemsV1` —
 * deliberately not a second normaliser) names any of the plan's currently
 * unticked items, plus the review's own readiness score, plus (when the
 * caller has one in scope) the outcome of merging the triggering round's own
 * summary against the plan via `mergeChecklistProgressV1` — the claim the
 * round itself made, separate from what the review later verified. Round-window
 * file mtimes are omitted: no durable field records the boundary of the round
 * that set the latch, and fabricating one would be worse than the honest
 * evidence this function does hold (risk note, plan.md). The round-summary
 * claim is the same shape of honesty: shown when the caller has it in scope
 * (the two reviewActions.ts call sites that already computed it for THIS
 * round), stated as unavailable otherwise (e.g. the command invoked directly
 * from the task tree, with no round in scope) — never fabricated.
 */
/**
 * Renders the triggering round's own `mergeChecklistProgressV1` outcome as
 * an evidence-block line, or states plainly that none is available for this
 * invocation. Never recomputed here from a stale summary — the caller passes
 * whatever it already computed for the SAME round the decision is about, or
 * nothing at all.
 */
function describeRoundSummaryChecklistClaimV1(
  claim: MergeChecklistProgressResultV1 | undefined
): string {
  if (!claim) {
    return "Not available for this invocation — no triggering round's summary was in scope.";
  }
  switch (claim.kind) {
    case "no-report":
      return "The triggering round's summary echoed no checklist at all.";
    case "unchanged":
      return "The triggering round's summary echoed the checklist with no new ticks.";
    case "no-match":
      return claim.unmatchedSample.length > 0
        ? `The triggering round claimed ${claim.unmatchedSample.length} tick(s) that matched no plan item ` +
          `text:\n${claim.unmatchedSample.map((text) => `- ${text}`).join("\n")}`
        : "The triggering round claimed tick(s) that matched no plan item text.";
    case "merged":
      return claim.retroactiveTicks && claim.retroactiveTicks.length > 0
        ? `The triggering round's summary landed ${claim.retroactiveTicks.length} tick(s) with evidence:\n` +
          claim.retroactiveTicks.map((tick) => `- ${tick.itemText} — ${tick.evidence}`).join("\n")
        : "The triggering round's summary landed new tick(s) against the checklist.";
    default:
      return "Not available for this invocation — no triggering round's summary was in scope.";
  }
}

async function gatherReconcileEvidenceV1(
  folderUri: vscode.Uri,
  planOfRecord: string,
  pendingImplReviewFiles: readonly string[] | undefined,
  roundSummaryChecklistClaim: MergeChecklistProgressResultV1 | undefined
): Promise<{ evidence: WorkflowDecisionEvidenceItemV1[]; allUncheckedCovered: boolean }> {
  const evidence: WorkflowDecisionEvidenceItemV1[] = [];
  const unchecked = listUncheckedChecklistItemTextsV1(planOfRecord, Number.MAX_SAFE_INTEGER);
  evidence.push({
    label: "Unchecked plan items",
    detail:
      unchecked.total === 0
        ? "None — the checklist already shows every item complete."
        : `${unchecked.total} item(s) unticked:\n${unchecked.items.map((item) => `- ${item}`).join("\n")}`,
  });

  evidence.push({
    label: "pendingImplReviewFiles",
    detail:
      pendingImplReviewFiles !== undefined && pendingImplReviewFiles.length > 0
        ? `${pendingImplReviewFiles.length} file(s) changed by a round whose checklist state was not recorded:\n${pendingImplReviewFiles.map((f) => `- ${f}`).join("\n")}`
        : "None recorded.",
  });

  evidence.push({
    label: "Round-summary checklist claims",
    detail: describeRoundSummaryChecklistClaimV1(roundSummaryChecklistClaim),
  });

  const coveredKeys = new Set<string>();
  for (const stage of IMPL_REVIEW_STAGES) {
    const filename = STAGE_ARTIFACT_FILENAMES[stage];
    if (!filename) continue;
    const content = await readTextIfExists(vscode.Uri.joinPath(folderUri, filename));
    if (content === undefined) {
      evidence.push({ label: `${STAGE_DISPLAY_NAMES[stage]} verdict`, detail: "No review artifact found." });
      continue;
    }
    const readiness = parseReadiness(content);
    const verified = parseReviewVerifiedCompleteV1(content);
    const matches = filterUncheckedPlanItemsV1(planOfRecord, verified.items);
    matches.forEach((item) => coveredKeys.add(item));
    evidence.push({
      label: `${STAGE_DISPLAY_NAMES[stage]} verdict`,
      detail:
        `Readiness: ${readiness.label}. ` +
        (matches.length > 0
          ? `Names ${matches.length} of the unticked item(s) above as verified complete:\n${matches.map((item) => `- ${item}`).join("\n")}`
          : "Names none of the currently unticked items as verified complete."),
    });
  }

  const allUncheckedCovered = unchecked.total > 0 && unchecked.items.every((item) => coveredKeys.has(item));
  return { evidence, allUncheckedCovered };
}

/**
 * Clear a task's `checklistProgressUnreliable` latch after the user has brought
 * `plan-final.md`'s checkboxes back in line with the tree.
 *
 * The latch is set under two conditions (workflow 3 continuation, second
 * item — the widened trigger): (1) a round changes files without its
 * checklist state being recorded — a runner-authored summary (the sealed
 * edit pipeline returns verified receipts, not prose) or a rejected one; or
 * (2) a completed round changes NO files and lands no new checklist ticks
 * (a sterile round) immediately after the most recent qualifying-stage
 * review scored at or above the auto-advance threshold with zero blockers —
 * proof the checklist's own counts are under-reporting finished work, even
 * though nothing here can point at which lines are wrong. Those completions
 * can never be recovered automatically: no later round knows what an
 * unrecorded round did, and inferring it would tick items nobody verified.
 * So the counts stay understated until a human fixes them (or a later
 * round's own prose claim resolves them — see `hasPlanItemChecklistClaimV1`
 * / `mergeChecklistProgressV1`, the other, automatic exit from this same
 * state), and while they are understated the completeness gate stands down
 * rather than hold a finished plan short of its total.
 *
 * **Classification: case 4** (module header, workflowDecisionV1.ts) — the
 * system genuinely cannot make this judgement: ticking a box cannot be
 * distinguished from ticking the LAST box, so no file-watch heuristic can
 * tell a partial edit from a finished reconciliation. Confirming is the user
 * asserting the checklist now matches the work, which stays a human decision.
 * What changes here is the blindness around it: this function now posts a
 * `WorkflowDecisionV1` carrying the evidence the system DOES hold
 * (`gatherReconcileEvidenceV1`) instead of a blind confirmation modal, and
 * only recommends "Mark reconciled" when that evidence covers every
 * outstanding item.
 */
export type ReconcileDecisionPostResultV1 =
  | { readonly kind: "posted" }
  | { readonly kind: "noChecklist" }
  | { readonly kind: "noContext" };

/**
 * Builds the evidence and posts the `reconcilePlanChecklist` decision for an
 * already-resolved task. Pulled out of the `reconcilePlanChecklist` command
 * so the checklist-latch call sites in reviewActions.ts (which already have
 * `folderUri` and a freshly-patched `TaskProgress` in hand from the round
 * they just finished writing) can post the SAME decision directly, without
 * going through `resolveTaskContext`/`vscode.commands.executeCommand` — a
 * command dispatch from deep inside the round-completion write path would
 * require the command to be registered in every caller, which unit-test
 * harnesses that only stub the write path do not do.
 */
export async function postReconcilePlanChecklistDecisionV1(
  folderUri: vscode.Uri,
  canonicalId: string,
  taskFolderPath: string,
  progress: { currentStage: TaskStage; displayName?: string; pendingImplReviewFiles?: string[] },
  roundSummaryChecklistClaim?: MergeChecklistProgressResultV1
): Promise<ReconcileDecisionPostResultV1> {
  // Reads durable bytes, saving the user's unsaved ticks first — the shared
  // resolver owns that rule so this command and the completeness gate can
  // never disagree about what the plan says.
  const plan = await readPlanOfRecordV1(folderUri);
  const counted = plan.counts;
  // Nothing to reconcile against. Clearing the latch here would report that
  // completeness gating is restored while readPlanOfRecordV1 keeps returning no
  // counts and the gate stays down — telling the user a safety net is back when
  // it is not, which is the failure this whole mechanism exists to prevent.
  if (!plan.hasChecklist || !counted || plan.text === undefined) {
    return { kind: "noChecklist" };
  }

  const { evidence, allUncheckedCovered } = await gatherReconcileEvidenceV1(
    folderUri,
    plan.text,
    progress.pendingImplReviewFiles,
    roundSummaryChecklistClaim
  );

  const recommendation: WorkflowDecisionRecommendationV1 = allUncheckedCovered
    ? {
        kind: "option",
        optionId: "reconcile",
        reasoning:
          "Every currently unticked item is named as verified complete by at least one implementation " +
          "review, so the evidence this task holds covers the whole gap.",
      }
    : {
        kind: "none",
        reasoning:
          "At least one unticked item is not named as verified complete by any implementation review " +
          "on file — the system has no basis to recommend reconciling until you have checked it yourself.",
      };

  const target: ChatTarget = {
    canonicalId,
    taskFolderPath,
    stage: progress.currentStage,
    taskName: progress.displayName,
  };

  // Pre-generated so it can be embedded in the "reconcile" option's own
  // command args: the confirmed-execution side looks this decision back up
  // by id to compare plan-final.md's mtime against the decision's
  // `createdAt`, preserving the at-write byte-freshness guard the old modal
  // had (module doc comment on `reconcilePlanChecklistConfirmedV1`) without
  // caching the plan's CONTENT into args — only the reference travels.
  const decisionId = crypto.randomUUID();

  const decision = await postWorkflowDecisionV1(
    {
      decisionId,
      decisionKey: "reconcilePlanChecklist",
      taskCanonicalId: canonicalId,
      stage: progress.currentStage,
      whatHappened:
        `This task's plan checklist is flagged unreliable: plan-final.md currently reads ` +
        `${counted.checked}/${counted.total} items complete, with ${counted.remaining} outstanding, but a ` +
        "round changed work the checklist could not record, so its counts may understate what is actually done.",
      whyUserNeeded:
        "Ticking a box cannot be distinguished from ticking the LAST box, so no automatic check can tell a " +
        "partial edit from a finished reconciliation — only a human confirming the checklist now matches the " +
        "work can safely restore the completeness gate.",
      options: [
        {
          optionId: "reconcile",
          label: "Mark reconciled",
          consequence:
            "Clears the unreliable-checklist flag. Plan completeness will gate stage advancement again from " +
            "these counts, so an item left unticked will hold the task open, and one ticked in error can let " +
            "unfinished work advance.",
          effect: {
            kind: "command",
            command: "vs-code-ai-helper.reconcilePlanChecklistConfirmed",
            args: [{ taskFolderPath, canonicalId, decisionId }],
          },
        },
        {
          optionId: "notYet",
          label: "Not yet — keep the gate down",
          consequence:
            "Does nothing. Completeness stays stood down until you tick the missed items in plan-final.md " +
            "and run this again.",
          effect: { kind: "doNothing" },
        },
      ],
      recommendation,
      evidence,
    },
    target
  );
  return decision ? { kind: "posted" } : { kind: "noContext" };
}

export async function reconcilePlanChecklist(
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore,
  explicitArg?: ReconcileArg
): Promise<void> {
  // Activation-order barrier (plan §1.4) — same rationale as pinTask.
  await TaskCreationStartupReconcilerV1.waitUntilReady();
  // The store is what makes this reachable from the Command Palette, which
  // passes no argument: without it resolveTaskContext has nothing to fall back
  // on and always returns undefined, so the command contributed to fix a false
  // promise was itself unusable from the surface it was advertised on.
  const resolved = await resolveTaskContext(
    inventory,
    normalizeArg(explicitArg),
    { allowPaused: true },
    currentTaskStore
  );
  if (!resolved) {
    NotificationRouter.showError(
      "The task could not be found. Refresh the Tasks panel and try again."
    );
    return;
  }
  if (!resolved.progress.checklistProgressUnreliable) {
    NotificationRouter.showInformation(
      "This task's plan checklist is already treated as a complete record."
    );
    return;
  }

  const folderUri = vscode.Uri.file(resolved.taskFolderPath);
  const result = await postReconcilePlanChecklistDecisionV1(
    folderUri,
    resolved.canonicalId,
    resolved.taskFolderPath,
    resolved.progress
  );
  if (result.kind === "noChecklist") {
    NotificationRouter.showWarning(
      "plan-final.md has no implementation checklist to reconcile, so completeness cannot gate " +
        "this task. Generate or restore the checklist first, then run this again."
    );
  } else if (result.kind === "noContext") {
    NotificationRouter.showWarning(
      "Could not post the checklist-reconciliation decision to Chat With AI (no active extension context)."
    );
  }
}

/**
 * Executes the "Mark reconciled" option chosen for a `reconcilePlanChecklist`
 * decision (case 4). Re-derives everything fresh rather than trusting
 * anything carried in the decision's args — a decision may sit for hours, so
 * the byte-exact freshness guard the old modal used (comparing plan-final.md
 * against a snapshot captured moments before the modal closed) is replaced by
 * an mtime check against the decision's own `createdAt`: when a `decisionId`
 * is present in args (the normal dispatch path — see the option's `effect`
 * in `postReconcilePlanChecklistDecisionV1`), the decision is looked back up
 * from the store and plan-final.md's on-disk mtime is compared against when
 * the decision was posted. This still never caches the plan's CONTENT into
 * args (architecture note, plan.md) — only the decision's own id, a routing
 * reference, travels; the comparison re-reads both sides fresh.
 */
export async function reconcilePlanChecklistConfirmedV1(
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore,
  explicitArg?: ReconcileArg
): Promise<void> {
  await TaskCreationStartupReconcilerV1.waitUntilReady();
  const normalized = normalizeArg(explicitArg);
  const resolved = await resolveTaskContext(
    inventory,
    normalized,
    { allowPaused: true },
    currentTaskStore
  );
  if (!resolved) {
    NotificationRouter.showError(
      "The task could not be found. Refresh the Tasks panel and try again."
    );
    return;
  }
  if (!resolved.progress.checklistProgressUnreliable) {
    NotificationRouter.showInformation(
      "This task's plan checklist is already treated as a complete record."
    );
    return;
  }

  const folderUri = vscode.Uri.file(resolved.taskFolderPath);
  const planUri = getCanonicalImplementationUri(folderUri);
  const plan = await readTextIfExists(planUri);
  if (plan === undefined) {
    NotificationRouter.showWarning(
      "plan-final.md could not be read, so there is nothing to reconcile against."
    );
    return;
  }

  if (normalized?.decisionId) {
    const context = getExtensionContextV1();
    const decision = context && new WorkflowDecisionStoreV1(context.workspaceState).get(normalized.decisionId);
    if (decision) {
      const stat = await statIfExists(planUri);
      if (stat && stat.mtime > Date.parse(decision.createdAt)) {
        NotificationRouter.showWarning(
          "plan-final.md changed since this decision was posted, so the evidence it showed may be stale. " +
            "Re-check plan-final.md and run this again."
        );
        return;
      }
    }
  }

  let raced = false;
  await patchTaskProgressStrictV1(folderUri, (current) => {
    if (current.updatedAt !== resolved.progress.updatedAt) {
      raced = true;
      return current;
    }
    return { ...current, checklistProgressUnreliable: undefined };
  });
  if (raced) {
    NotificationRouter.showWarning(
      "The task changed while this was being applied — a round may have landed work the checklist " +
        "does not record. Re-check plan-final.md and run this again."
    );
    return;
  }
  await inventory.refresh();
  NotificationRouter.showInformation(
    "Plan checklist marked as reconciled — completeness now gates advancement again."
  );
}

export function registerReconcilePlanChecklistCommands(
  context: vscode.ExtensionContext,
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "vs-code-ai-helper.reconcilePlanChecklist",
      (arg?: ReconcileArg) => reconcilePlanChecklist(inventory, currentTaskStore, arg)
    ),
    vscode.commands.registerCommand(
      "vs-code-ai-helper.reconcilePlanChecklistConfirmed",
      (arg?: ReconcileArg) => reconcilePlanChecklistConfirmedV1(inventory, currentTaskStore, arg)
    )
  );
}
