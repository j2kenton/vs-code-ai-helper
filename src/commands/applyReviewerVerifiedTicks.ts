import * as vscode from "vscode";
import { TaskInventory } from "../state/taskInventory";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { IncompleteTask } from "../types/incompleteTask";
import { NotificationRouter } from "../utils/notificationRouter";
import { formatNotificationTaskLabelV1 } from "../utils/notificationTaskContextV1";
import { TaskCreationStartupReconcilerV1 } from "../state/taskCreationStartupReconcilerV1";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import {
  getCanonicalImplementationUri,
  readPlanOfRecordV1,
} from "../utils/implementationArtifactResolver";
import {
  filterAlreadyCheckedPlanItemsV1,
  filterUncheckedPlanItemsV1,
  formatChecklistItemGlyphV1,
  mergeChecklistProgressV1,
  normalizeChecklistItemTextV1,
} from "../utils/implementationChecklist";
import { parseReviewVerifiedCompleteV1 } from "../utils/reviewReadiness";
import { writeTextFileIfUnchangedV1 } from "../utils/fileUtils";
import { STAGE_ARTIFACT_FILENAMES, TaskStage, isReviewStage } from "../types/taskProgress";
import { postWorkflowDecisionV1, withdrawWorkflowDecisionsByKeyV1 } from "../utils/workflowDecisionDispatchV1";
import { ChatTarget } from "../views/chatView";
import { normalizePath } from "../utils/taskRoot";
import { WorkflowDecisionCommandResultV1 } from "../types/workflowDecisionV1";

type ApplyArg =
  | { task?: IncompleteTask }
  | {
      canonicalId?: string;
      taskFolderPath?: string;
      reviewStage?: TaskStage;
      /**
       * RC2 item 8, Step 37 (implementation-review follow-up, 2026-09-28,
       * narrowed blocker `bbd42447-…-1`, re-narrowed 2026-09-28): the exact
       * item texts THIS card offered to apply, captured at post time
       * (`postApplyReviewerVerifiedTicksDecisionV1`'s own `applicable`).
       * Threaded through so both what confirming this card actually APPLIES
       * and the "already applied" count it reports are scoped to what this
       * specific card promised — never the review file's current raw item
       * set, which could include items unmatched to any real plan item,
       * items already checked before this card ever existed, or items newly
       * verified after this card was posted.
       */
      offeredItems?: readonly string[];
    };

function normalizeArg(arg: ApplyArg | undefined):
  | {
      canonicalId?: string;
      taskFolderPath?: string;
      reviewStage?: TaskStage;
      offeredItems?: readonly string[];
    }
  | undefined {
  if (!arg) {
    return undefined;
  }
  // Same shape tolerance as reconcilePlanChecklist's normalizer: explicit ids
  // first, and the tree-node branch guarded against a partial `task` that
  // carries only `progress` (no `folderUri`).
  const explicit = arg as {
    canonicalId?: string;
    taskFolderPath?: string;
    reviewStage?: TaskStage;
    offeredItems?: readonly string[];
  };
  if (explicit.canonicalId || explicit.taskFolderPath) {
    return {
      canonicalId: explicit.canonicalId,
      taskFolderPath: explicit.taskFolderPath,
      reviewStage: explicit.reviewStage,
      offeredItems: explicit.offeredItems,
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
  | {
      readonly kind: "blocked";
      readonly message: string;
      readonly severity: "info" | "warning";
      /**
       * RC2 item 8, Step 37: set only for the "already ticked" blocked case —
       * the review named this many items verified complete, and every one is
       * already checked in plan-final.md. Lets the confirmed-execution
       * command report a precise, idempotent "Already done" result instead
       * of a bare information message.
       */
      readonly alreadyAppliedCount?: number;
    };

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
 *
 * `offeredItems` (RC2 item 8, Step 37 follow-up, narrowed blocker
 * `bbd42447-…-1`, re-narrowed 2026-09-28: the first fix only scoped the
 * "already applied" COUNT, leaving the actual apply operation itself
 * unscoped — a card could still be confirmed into applying a DIFFERENT item
 * than the one it offered, if the review file changed between post and
 * confirm to newly verify something else while the original offered item
 * became already-checked in the meantime). When a caller passes the specific
 * candidates its own card offered, the applicable set itself is restricted to
 * the intersection of "currently unchecked and verified" with "offered by
 * this card" (matched by {@link normalizeChecklistItemTextV1}, tolerant of
 * plan-text drift the same way every other matcher in this file is) — never
 * a newly-surfaced item this card never promised. Only the "already applied"
 * count falls back further, to `offeredItems` itself, once the intersection
 * is empty.
 */
export async function deriveApplicableVerifiedTicksV1(
  folderUri: vscode.Uri,
  reviewStage: TaskStage,
  offeredItems?: readonly string[]
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

  const applicableFromReview = filterUncheckedPlanItemsV1(plan.text, verified.items);
  // Scope to exactly what this card offered, when it offered anything: a
  // review file that changed between post and confirm (newly verifying a
  // DIFFERENT item, say) must never let a stale card apply something it
  // never promised — see this function's doc comment.
  const offeredKeys = offeredItems ? new Set(offeredItems.map(normalizeChecklistItemTextV1)) : undefined;
  const applicable = offeredKeys
    ? applicableFromReview.filter((item) => offeredKeys.has(normalizeChecklistItemTextV1(item)))
    : applicableFromReview;
  if (applicable.length === 0) {
    // `verified.items` is the review's raw named text: it can include
    // entries that match no real plan item at all, which is never
    // legitimate evidence of already-done work (same reasoning as
    // `filterAlreadyCheckedPlanItemsV1`'s own doc comment). Scoping to
    // `offeredItems` when a caller supplies them additionally excludes
    // matched-and-checked items that this card never offered in the first
    // place (e.g. checked before the card existed, unrelated to it).
    const alreadyAppliedCount = filterAlreadyCheckedPlanItemsV1(plan.text, offeredItems ?? verified.items).length;
    return {
      kind: "blocked",
      severity: "info",
      message: "Every item this review named as verified complete is already ticked in plan-final.md.",
      alreadyAppliedCount: alreadyAppliedCount > 0 ? alreadyAppliedCount : undefined,
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
          label: `Apply ${applicable.length} Reviewer-Verified Tick${applicable.length === 1 ? "" : "s"} and resume the task`,
          resumeKind: "continue",
          consequence:
            `Ticks these ${applicable.length} item(s) in plan-final.md, sourced from ${reviewFilename}, then ` +
            "dispatches this stage's next action:\n" +
            applicable
              .map((item) => `- ${formatChecklistItemGlyphV1({ checked: false, excluded: false })} ${item}`)
              .join("\n"),
          effect: {
            kind: "command",
            command: "vs-code-ai-helper.applyReviewerVerifiedTicksConfirmed",
            args: [{ taskFolderPath, canonicalId, reviewStage, offeredItems: applicable }],
          },
        },
        {
          optionId: "skip",
          label: "Not yet",
          resumeKind: "unpause",
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
        unblocksProgress: true,
        detail:
          "Applying ticks these items in plan-final.md and then dispatches this stage's next action, so it can " +
          "move the task forward; if the task is currently paused for a reason unrelated to these ticks, that " +
          "pause is not this decision's to clear.",
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

  const taskLabel = formatNotificationTaskLabelV1(resolved.progress.displayName, resolved.folderName);
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
      NotificationRouter.showWarning(`${taskLabel}: ${result.message}`);
    } else {
      NotificationRouter.showInformation(`${taskLabel}: ${result.message}`);
    }
  } else if (result.kind === "noContext") {
    NotificationRouter.showWarning(
      `${taskLabel}: could not post the reviewer-verified-ticks decision to Chat With AI (no active extension context).`
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
 *
 * The final write goes through {@link writeTextFileIfUnchangedV1} rather than
 * an unconditional `writeTextFile` (review-flagged 2026-08-25, task-fixable
 * blocker `739cfbbb-…-1`: this was the one remaining in-process writer of
 * `plan-final.md` that bypassed that primitive's FIFO queue and revision
 * check, named explicitly in `reconcilePlanChecklist.ts`'s Guard 3 comment as
 * the known gap). `freshPlan.text`, already read immediately above as the
 * basis for the merge, is passed as the expected content, so this call now
 * queues behind any other in-process writer of the same uri and is refused —
 * rather than silently overwriting — if the file changed underneath it.
 */
export async function applyReviewerVerifiedTicksConfirmedV1(
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore,
  explicitArg?: ApplyArg
): Promise<WorkflowDecisionCommandResultV1 | void> {
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

  const taskLabel = formatNotificationTaskLabelV1(resolved.progress.displayName, resolved.folderName);
  const folderUri = vscode.Uri.file(resolved.taskFolderPath);
  const reviewStage = normalized?.reviewStage ?? resolved.progress.currentStage;
  const derived = await deriveApplicableVerifiedTicksV1(folderUri, reviewStage, normalized?.offeredItems);
  if (derived.kind === "blocked") {
    NotificationRouter.showInformation(`${taskLabel}: ${derived.message}`);
    // RC2 item 8, Step 37: idempotent re-press (e.g. via the reconcile
    // card's duplicate option, or clicking Apply twice) reports structurally
    // so the SAME card's thread says "Already done", not just a bare
    // notification (Step 31's `WorkflowDecisionCommandResultV1` protocol).
    if (derived.alreadyAppliedCount !== undefined) {
      const n = derived.alreadyAppliedCount;
      return {
        outcome: "alreadyDone",
        message: `Already done: the ${n} reviewer-verified tick${n === 1 ? "" : "s"} ${n === 1 ? "is" : "are"} applied.`,
      };
    }
    return;
  }
  const { reviewStage: resolvedStage, reviewFilename, applicable } = derived.derivation;

  const freshPlan = await readPlanOfRecordV1(folderUri);
  if (!freshPlan.hasChecklist || !freshPlan.text) {
    NotificationRouter.showWarning(
      `${taskLabel}: plan-final.md changed while this was being applied and no longer has a checklist to tick.`
    );
    return;
  }

  const evidence = `verified by reviewer in ${resolvedStage} review (${reviewFilename})`;
  const synthetic = buildSyntheticVerifiedCompleteSummaryV1(applicable, evidence);
  const merged = mergeChecklistProgressV1(freshPlan.text, synthetic);
  if (merged.kind !== "merged") {
    NotificationRouter.showWarning(
      `${taskLabel}: applying the reviewer's ticks did not change plan-final.md — the items no longer match the plan of record.`
    );
    return;
  }

  const written = await writeTextFileIfUnchangedV1(
    getCanonicalImplementationUri(folderUri),
    freshPlan.text,
    merged.content
  );
  if (!written) {
    NotificationRouter.showWarning(
      `${taskLabel}: plan-final.md changed while these ticks were being applied — nothing was written. Re-open the decision ` +
        "and try again."
    );
    return;
  }
  // Part 11 item 13c (event-driven half): the normal path here is the
  // decision option's own effect command, which the resolve flow already
  // takes off "pending" before this runs — but this command is ALSO
  // independently registered (e.g. reachable from the Command Palette
  // without ever clicking the card), so a pending `applyReviewerVerifiedTicks`
  // card for this task may still exist and now describes a tick state that
  // no longer holds. Best-effort withdraw covers that path; it is a no-op
  // when the decision was already resolved by the normal click.
  await withdrawWorkflowDecisionsByKeyV1(
    { taskFolderPath: folderUri.fsPath, canonicalId: normalizePath(folderUri.fsPath) },
    "applyReviewerVerifiedTicks",
    "plan-final.md's checklist ticks changed, superseding the pending tick-application card"
  );
  await inventory.refresh();
  NotificationRouter.showInformation(
    `${taskLabel}: Applied ${applicable.length} reviewer-verified tick(s) to plan-final.md.`
  );
  // Part 3, Step 5 (owner's ruling: "Ensemble performs it -> say so and do
  // it") — same note as reconcilePlanChecklist.ts's identical dispatch.
  await vscode.commands.executeCommand("vs-code-ai-helper.resumeAndApplyCurrentStageAction", {
    taskFolderPath: folderUri.fsPath,
  });
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
