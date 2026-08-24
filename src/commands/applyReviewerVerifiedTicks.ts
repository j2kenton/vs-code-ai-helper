import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { IncompleteTask } from "../types/incompleteTask";
import { NotificationRouter } from "../utils/notificationRouter";
import { TaskCreationStartupReconcilerV1 } from "../state/taskCreationStartupReconcilerV1";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import {
  getCanonicalImplementationUri,
  readPlanOfRecordV1,
} from "../utils/implementationArtifactResolver";
import {
  filterUncheckedPlanItemsV1,
  mergeChecklistProgressV1,
} from "../utils/implementationChecklist";
import { parseReviewVerifiedCompleteV1 } from "../utils/reviewReadiness";
import { writeTextFile } from "../utils/fileUtils";
import { STAGE_ARTIFACT_FILENAMES, TaskStage, isReviewStage } from "../types/taskProgress";
import { postWorkflowDecisionV1 } from "../utils/workflowDecisionDispatchV1";
import { ChatTarget } from "../views/chatView";

type ApplyArg =
  | { task?: IncompleteTask }
  | { canonicalId?: string; taskFolderPath?: string; reviewStage?: TaskStage };

function normalizeArg(
  arg: ApplyArg | undefined
): { canonicalId?: string; taskFolderPath?: string; reviewStage?: TaskStage } | undefined {
  if (!arg) {
    return undefined;
  }
  // Same shape tolerance as reconcilePlanChecklist's normalizer: explicit ids
  // first, and the tree-node branch guarded against a partial `task` that
  // carries only `progress` (no `folderUri`).
  const explicit = arg as { canonicalId?: string; taskFolderPath?: string; reviewStage?: TaskStage };
  if (explicit.canonicalId || explicit.taskFolderPath) {
    return {
      canonicalId: explicit.canonicalId,
      taskFolderPath: explicit.taskFolderPath,
      reviewStage: explicit.reviewStage,
    };
  }
  if ("task" in arg && arg.task?.folderUri) {
    return { taskFolderPath: arg.task.folderUri.fsPath };
  }
  return undefined;
}

/**
 * Builds a synthetic round-summary shape carrying the reviewer's ticks as
 * retroactive claims, so they can be applied through the exact same monotonic
 * merge path (`mergeChecklistProgressV1`) an implementation round's own echo
 * uses, rather than a parallel ticking mechanism that could disagree with it.
 *
 * The leading `## Files Changed` heading with no checkbox items under it is
 * what `filesChangedIsSummaryBoundary` requires to treat everything after it
 * as the round's "own" text (`splitSummaryAtEchoV1`) — where
 * `collectRetroactiveTickClaimsV1` reads claims from.
 */
export function buildSyntheticVerifiedCompleteSummaryV1(
  items: readonly string[],
  evidence: string
): string {
  const lines = [
    "## Files Changed",
    "",
    "(no files — ticks applied from a reviewer's Verified Complete list)",
    "",
    "## Plan Item Checklist",
    "",
    ...items.map((item) => `- ${item} — done <!-- ensemble:retroactive --> — ${evidence}`),
    "",
  ];
  return lines.join("\n");
}

export interface VerifiedTicksDerivationV1 {
  readonly reviewStage: TaskStage;
  readonly reviewFilename: string;
  readonly applicable: readonly string[];
}

export type DeriveVerifiedTicksResultV1 =
  | { readonly kind: "ok"; readonly derivation: VerifiedTicksDerivationV1 }
  | { readonly kind: "blocked"; readonly message: string; readonly severity: "info" | "warning" };

/**
 * Re-derives, from disk, exactly which unchecked plan items the current
 * review names as verified complete — the single source of truth both the
 * decision-posting path and the confirmed-execution path read from, so they
 * can never disagree about what "applicable" means. Called fresh at BOTH
 * points (module doc comment on `applyReviewerVerifiedTicks` below) rather
 * than threaded through the decision's args.
 *
 * Also exported for `notifyReviewerVerifiedTicksV1` (reviewActions.ts): the
 * post-review notifier needs the SAME derivation to silently decide whether
 * there is anything to offer, reusing this rather than a second copy of the
 * matching logic (task: "reuse the text-matching tolerance… do not introduce
 * a second normaliser").
 */
export async function deriveApplicableVerifiedTicksV1(
  folderUri: vscode.Uri,
  reviewStage: TaskStage
): Promise<DeriveVerifiedTicksResultV1> {
  if (!isReviewStage(reviewStage)) {
    return {
      kind: "blocked",
      severity: "info",
      message: "This task is not on a review stage, so there is no reviewer verification to apply.",
    };
  }
  const reviewFilename = STAGE_ARTIFACT_FILENAMES[reviewStage];
  if (!reviewFilename) {
    return { kind: "blocked", severity: "info", message: "This review stage has no artifact to read verification from." };
  }
  const reviewUri = vscode.Uri.joinPath(folderUri, reviewFilename);
  let reviewContent: string;
  try {
    const bytes = await vscode.workspace.fs.readFile(reviewUri);
    reviewContent = new TextDecoder().decode(bytes);
  } catch {
    return { kind: "blocked", severity: "info", message: `No ${reviewFilename} was found for this task yet.` };
  }
  const verified = parseReviewVerifiedCompleteV1(reviewContent);
  if (verified.items.length === 0) {
    return { kind: "blocked", severity: "info", message: "This review named no items as verified complete." };
  }

  const plan = await readPlanOfRecordV1(folderUri);
  if (!plan.hasChecklist || !plan.text) {
    return {
      kind: "blocked",
      severity: "warning",
      message: "plan-final.md has no implementation checklist to tick, so there is nothing to apply.",
    };
  }

  const applicable = filterUncheckedPlanItemsV1(plan.text, verified.items);
  if (applicable.length === 0) {
    return {
      kind: "blocked",
      severity: "info",
      message: "Every item this review named as verified complete is already ticked in plan-final.md.",
    };
  }

  return { kind: "ok", derivation: { reviewStage, reviewFilename, applicable } };
}

export type ApplyTicksDecisionPostResultV1 =
  | { readonly kind: "posted" }
  | { readonly kind: "blocked"; readonly message: string; readonly severity: "info" | "warning" }
  | { readonly kind: "noContext" };

/**
 * Builds and posts the `applyReviewerVerifiedTicks` decision for an
 * already-resolved task/stage. Pulled out of the `applyReviewerVerifiedTicks`
 * command for the same reason `postReconcilePlanChecklistDecisionV1` was
 * pulled out of `reconcilePlanChecklist` (its doc comment): the post-review
 * notifier in reviewActions.ts (`notifyReviewerVerifiedTicksV1`) already has
 * `folderUri`/`targetStage` in hand from the round it just routed, with no
 * `TaskInventory` to resolve through, and dispatching via
 * `vscode.commands.executeCommand` there would require the command to be
 * registered in every caller/test harness.
 */
export async function postApplyReviewerVerifiedTicksDecisionV1(
  folderUri: vscode.Uri,
  canonicalId: string,
  taskFolderPath: string,
  reviewStage: TaskStage,
  displayName?: string
): Promise<ApplyTicksDecisionPostResultV1> {
  const derived = await deriveApplicableVerifiedTicksV1(folderUri, reviewStage);
  if (derived.kind === "blocked") {
    return { kind: "blocked", message: derived.message, severity: derived.severity };
  }
  const { reviewFilename, applicable } = derived.derivation;

  const target: ChatTarget = {
    canonicalId,
    taskFolderPath,
    stage: reviewStage,
    taskName: displayName,
  };

  const decision = await postWorkflowDecisionV1(
    {
      decisionKey: "applyReviewerVerifiedTicks",
      taskCanonicalId: canonicalId,
      stage: reviewStage,
      whatHappened:
        `${reviewFilename} named ${applicable.length} plan item(s) as verified complete that are still ` +
        "unticked in plan-final.md.",
      whyUserNeeded:
        "Applying re-arms the completeness gate on the reviewer's own word — a consequential enough change " +
        "to confirm once, even though the merge itself is monotonic (it can only tick items, never untick or " +
        "misfile one) and text-matched against the plan of record.",
      options: [
        {
          optionId: "apply",
          label: `Apply ${applicable.length} Reviewer-Verified Tick${applicable.length === 1 ? "" : "s"}`,
          consequence:
            `Ticks these ${applicable.length} item(s) in plan-final.md, sourced from ${reviewFilename}:\n` +
            applicable.map((item) => `- ${item}`).join("\n"),
          effect: {
            kind: "command",
            command: "vs-code-ai-helper.applyReviewerVerifiedTicksConfirmed",
            args: [{ taskFolderPath, canonicalId, reviewStage }],
          },
        },
        {
          optionId: "skip",
          label: "Not yet",
          consequence: "Does nothing. The items stay unticked until you apply this or tick them yourself.",
          effect: { kind: "doNothing" },
        },
      ],
      recommendation: {
        kind: "option",
        optionId: "apply",
        reasoning:
          "The reviewer already verified these items against the tree; applying only records that " +
          "verification as ticks, which cannot untick or misapply anything.",
      },
      gating: {
        holdsTaskPaused: false,
        unblocksProgress: false,
        detail:
          "This does not resume or unblock the task by itself. It only ticks items in plan-final.md; if the " +
          "task is currently paused, that pause comes from something else and answering this alone will not " +
          "resume it.",
      },
    },
    target
  );
  return decision ? { kind: "posted" } : { kind: "noContext" };
}

/**
 * Present a reviewer's `## Verified Complete` list as a decision to apply it
 * to plan-final.md as ticks — the "Apply N reviewer-verified ticks" one-click
 * path (workflow 3 continuation plan, Part 5). The reviewer already opened
 * the relevant files and confirmed specific unchecked plan items are
 * actually done; this command applies that assertion through the same
 * monotonic, text-matched merge path a round's own retroactive claim uses,
 * so the operator is no longer asked to retype a verification the reviewer
 * already performed.
 *
 * **Classification: case 2** (module header, workflowDecisionV1.ts) — the
 * system knows exactly what to do (apply the reviewer's own verification),
 * but doing so re-arms the completeness gate on the reviewer's word, which is
 * consequential enough to need one explicit confirm. The merge itself is
 * monotonic and text-matched (module doc comment on
 * `buildSyntheticVerifiedCompleteSummaryV1`), which the decision text states,
 * so the recommendation is unconditionally "apply".
 */
export async function applyReviewerVerifiedTicks(
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore,
  explicitArg?: ApplyArg
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

  const folderUri = vscode.Uri.file(resolved.taskFolderPath);
  const reviewStage = normalized?.reviewStage ?? resolved.progress.currentStage;
  const result = await postApplyReviewerVerifiedTicksDecisionV1(
    folderUri,
    resolved.canonicalId,
    resolved.taskFolderPath,
    reviewStage,
    resolved.progress.displayName
  );
  if (result.kind === "blocked") {
    if (result.severity === "warning") {
      NotificationRouter.showWarning(result.message);
    } else {
      NotificationRouter.showInformation(result.message);
    }
  } else if (result.kind === "noContext") {
    NotificationRouter.showWarning(
      "Could not post the reviewer-verified-ticks decision to Chat With AI (no active extension context)."
    );
  }
}

/**
 * Executes the "Apply" option chosen for an `applyReviewerVerifiedTicks`
 * decision (case 2). Re-derives the review content, the verified-complete
 * set, and the plan of record entirely fresh (`deriveApplicableVerifiedTicksV1`)
 * rather than trusting anything carried in the decision's args — both files
 * may have changed since the decision was posted, and re-deriving is simpler
 * and safer than an abort-on-race check because ticking is monotonic and
 * text-matched (module doc comment above): recomputing against whatever is on
 * disk right now can never lose a tick or apply the wrong one.
 */
export async function applyReviewerVerifiedTicksConfirmedV1(
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore,
  explicitArg?: ApplyArg
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

  const folderUri = vscode.Uri.file(resolved.taskFolderPath);
  const reviewStage = normalized?.reviewStage ?? resolved.progress.currentStage;
  const derived = await deriveApplicableVerifiedTicksV1(folderUri, reviewStage);
  if (derived.kind === "blocked") {
    NotificationRouter.showInformation(derived.message);
    return;
  }
  const { reviewStage: resolvedStage, reviewFilename, applicable } = derived.derivation;

  const freshPlan = await readPlanOfRecordV1(folderUri);
  if (!freshPlan.hasChecklist || !freshPlan.text) {
    NotificationRouter.showWarning(
      "plan-final.md changed while this was being applied and no longer has a checklist to tick."
    );
    return;
  }

  const evidence = `verified by reviewer in ${resolvedStage} review (${reviewFilename})`;
  const synthetic = buildSyntheticVerifiedCompleteSummaryV1(applicable, evidence);
  const merged = mergeChecklistProgressV1(freshPlan.text, synthetic);
  if (merged.kind !== "merged") {
    NotificationRouter.showWarning(
      "Applying the reviewer's ticks did not change plan-final.md — the items no longer match the plan of record."
    );
    return;
  }

  await writeTextFile(getCanonicalImplementationUri(folderUri), merged.content);
  await inventory.refresh();
  NotificationRouter.showInformation(
    `Applied ${applicable.length} reviewer-verified tick(s) to plan-final.md.`
  );
}

export function registerApplyReviewerVerifiedTicksCommands(
  context: vscode.ExtensionContext,
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "vs-code-ai-helper.applyReviewerVerifiedTicks",
      (arg?: ApplyArg) => applyReviewerVerifiedTicks(inventory, currentTaskStore, arg)
    ),
    vscode.commands.registerCommand(
      "vs-code-ai-helper.applyReviewerVerifiedTicksConfirmed",
      (arg?: ApplyArg) => applyReviewerVerifiedTicksConfirmedV1(inventory, currentTaskStore, arg)
    )
  );
}
