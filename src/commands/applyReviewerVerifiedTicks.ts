import * as vscode from "vscode";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
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
  getPlanRevisionV1,
} from "../utils/implementationChecklist";
import { parseReviewVerifiedCompleteV1 } from "../utils/reviewReadiness";
import { writeTextFileIfUnchangedV1 } from "../utils/fileUtils";
import { PlanItemEvidenceV1, PlanItemTestReportV1, STAGE_ARTIFACT_FILENAMES, TaskStage, isReviewStage } from "../types/taskProgress";
import { postWorkflowDecisionV1, withdrawWorkflowDecisionsByKeyV1 } from "../utils/workflowDecisionDispatchV1";
import { ChatTarget } from "../views/chatView";
import { normalizePath } from "../utils/taskRoot";
import { WorkflowDecisionCommandResultV1 } from "../types/workflowDecisionV1";
import { getFastForwardRunStateV1 } from "../utils/activeFastForwardRunsV1";
import { fastForwardResumeSuffixV1, FastForwardResumeStateV1 } from "./fastForwardResumeSuffixV1";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import { invalidatePlanItemEvidenceForPlanRevisionV1 } from "../utils/taskProgressTransforms";
import { recordPlanItemReviewerVerificationV1 } from "../utils/taskProgressTransforms";
import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";

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
      /**
       * RC3 item 4, Step 3: whether a Fast Forward run was genuinely active
       * for this task at the moment this card was POSTED, captured then
       * (`getFastForwardRunStateV1`) and baked into this option's own args —
       * mirrors `reviewEscalation.ts`'s `buildPlateauKeepIteratingOptionV1`
       * (RC2 item 12), the established "capture now, don't re-derive later"
       * pattern this reuses rather than duplicating. Present only when the
       * card should resume Fast Forward instead of running a single cycle.
       */
      resumeFastForwardV1?: FastForwardResumeStateV1;
    };

function normalizeArg(arg: ApplyArg | undefined):
  | {
      canonicalId?: string;
      taskFolderPath?: string;
      reviewStage?: TaskStage;
      offeredItems?: readonly string[];
      resumeFastForwardV1?: FastForwardResumeStateV1;
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
    resumeFastForwardV1?: FastForwardResumeStateV1;
  };
  if (explicit.canonicalId || explicit.taskFolderPath) {
    return {
      canonicalId: explicit.canonicalId,
      taskFolderPath: explicit.taskFolderPath,
      reviewStage: explicit.reviewStage,
      offeredItems: explicit.offeredItems,
      resumeFastForwardV1: explicit.resumeFastForwardV1,
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
  /**
   * RC3 item 1, Step 2c: the reviewer's own `evidence:` sentence for each
   * entry in `applicable`, same order/index, `undefined` when the review
   * carries no evidence line for that item (an older review, or one where
   * the reviewer omitted it) — the card shows the fixed "older review
   * format" fallback in that case rather than inventing or searching for
   * one.
   */
  readonly applicableEvidence: readonly (string | undefined)[];
  /** Passing editing-round reports accepted for each applicable item. */
  readonly applicableTestReportRoundIds: readonly (readonly string[])[];
  readonly withheldTestItems: readonly string[];
}

function isTestDependentItemV1(itemText: string): boolean {
  return /\b(?:tests?|test cases?|fixtures?|regressions?|coverage)\b/i.test(itemText);
}

function commandRunsTestV1(command: string, testIdentity: string): boolean {
  const normalized = testIdentity.replace(/\\/g, "/").replace(/^\.\//, "");
  const basename = normalized.split("/").pop() ?? normalized;
  return command.split(/[\s'"`;=,]+/).some((part) => {
    const token = part.replace(/^[([{]+|[),\]}]+$/g, "").replace(/\\/g, "/").replace(/^\.\//, "");
    return token === normalized || token.split("/").pop() === basename;
  });
}

/**
 * Resolve the workspace folder that owns a task folder, preferring the deepest
 * open workspace folder that contains it and falling back to the first open
 * workspace. Used to resolve the workspace-root-relative paths a test report's
 * `sourceFileStates` snapshots were captured against.
 */
function resolveWorkspaceRootForTaskV1(folderUri: vscode.Uri): string | undefined {
  const taskPath = path.resolve(folderUri.fsPath);
  const folders = vscode.workspace.workspaceFolders ?? [];
  const containing = folders
    .map((folder) => path.resolve(folder.uri.fsPath))
    .find((root) => taskPath === root || taskPath.startsWith(root + path.sep));
  return containing ?? (folders[0] ? path.resolve(folders[0].uri.fsPath) : undefined);
}

/**
 * bugs2 Step 21: a test report's captured source snapshot must still match the
 * files it exercised before its result may support reviewer verification.
 * A report is usable only when every declared source file has a captured hash
 * and every hash still matches the working tree. Legacy or partial snapshots
 * cannot establish source applicability, so they remain provisional.
 */
async function reportSourceStateStillCurrentV1(
  report: PlanItemTestReportV1,
  workspaceRoot: string | undefined
): Promise<boolean> {
  if (report.sourceFilesTruncated) {
    return false;
  }
  const declared = [...new Set((report.sourceFiles ?? []).map((file) => file.replace(/\\/g, "/").replace(/^\.\//, "")))];
  const states = report.sourceFileStates ?? [];
  if (declared.length === 0 || states.length === 0 || !workspaceRoot) {
    return false;
  }
  const stateByPath = new Map(states.map((state) => [state.path.replace(/\\/g, "/").replace(/^\.\//, ""), state]));
  if (declared.some((file) => !stateByPath.has(file)) || stateByPath.size !== declared.length || states.length !== declared.length) {
    return false;
  }
  for (const state of states) {
    const absolute = path.resolve(workspaceRoot, state.path);
    const relative = path.relative(workspaceRoot, absolute);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !/^[a-f0-9]{64}$/i.test(state.sha256)) {
      return false;
    }
    try {
      const contents = await fs.promises.readFile(absolute);
      const current = crypto.createHash("sha256").update(contents).digest("hex");
      if (current !== state.sha256) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
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
 * The test-evidence gate a reviewer's verification passes through: an item
 * that is not test-dependent is accepted as is; a test-dependent one only
 * with a passing post-edit test report from an editing round that still
 * matches the current source. Shared by applying verified ticks and by
 * recording verification of already-ticked items.
 */
async function gateTestDependentItemsV1(
  items: readonly string[],
  evidenceRecords: readonly PlanItemEvidenceV1[],
  planRevision: string,
  workspaceRoot: string | undefined
): Promise<{ accepted: string[]; testReportRoundIds: string[][]; withheld: string[] }> {
  const accepted: string[] = [];
  const testReportRoundIds: string[][] = [];
  const withheld: string[] = [];
  for (const itemText of items) {
    if (!isTestDependentItemV1(itemText)) {
      accepted.push(itemText);
      testReportRoundIds.push([]);
      continue;
    }
    const itemKey = normalizeChecklistItemTextV1(itemText);
    const candidateReports = evidenceRecords
      .filter((record) => record.planRevision === planRevision && record.itemKey === itemKey)
      .flatMap((record) => record.testReports ?? [])
      .filter((report) =>
        report.passed > 0 &&
        report.failed === 0 &&
        /post[- ]edit/i.test(report.sourceState) &&
        commandRunsTestV1(report.command, report.testIdentity)
      );
    const currentReports: PlanItemTestReportV1[] = [];
    for (const report of candidateReports) {
      if (!(await reportSourceStateStillCurrentV1(report, workspaceRoot))) {
        continue;
      }
      currentReports.push(report);
    }
    if (currentReports.length === 0) {
      withheld.push(itemText);
      continue;
    }
    accepted.push(itemText);
    testReportRoundIds.push([...new Set(currentReports.map((report) => report.roundId))]);
  }
  return { accepted, testReportRoundIds, withheld };
}

/**
 * Records a review's verification of plan items it names verified complete
 * that are ALREADY ticked — typically ticked by an Implementation round, so
 * still provisional. Applying verified ticks only covers unticked items, and
 * no other path can verify a tick, so without this an implementation-ticked
 * item could never count as settled and a clean review could never advance
 * the stage. Writes evidence only, never plan-final.md; test-dependent items
 * pass the same test-evidence gate as applied ticks. Returns how many items
 * gained a verification.
 */
export async function recordReviewerVerificationOfTickedItemsV1(
  folderUri: vscode.Uri,
  reviewStage: TaskStage
): Promise<number> {
  const reviewFilename = isReviewStage(reviewStage) ? STAGE_ARTIFACT_FILENAMES[reviewStage] : undefined;
  if (!reviewFilename) return 0;
  let reviewContent: string;
  try {
    reviewContent = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folderUri, reviewFilename)));
  } catch {
    return 0;
  }
  const verified = parseReviewVerifiedCompleteV1(reviewContent);
  if (verified.items.length === 0) return 0;
  const plan = await readPlanOfRecordV1(folderUri);
  if (!plan.hasChecklist || !plan.text) return 0;
  const planRevision = getPlanRevisionV1(plan.text);
  const progressRead = await readTaskProgressStrictV1(folderUri);
  if (!progressRead.ok) return 0;
  const evidenceRecords = progressRead.decoded.progress.planItemEvidence ?? [];
  const alreadyVerified = new Set(evidenceRecords
    .filter((record) => record.planRevision === planRevision && (record.verifications?.length ?? 0) > 0)
    .map((record) => record.itemKey));
  const ticked = filterAlreadyCheckedPlanItemsV1(plan.text, verified.items)
    .filter((item) => !alreadyVerified.has(normalizeChecklistItemTextV1(item)));
  if (ticked.length === 0) return 0;
  const { accepted, testReportRoundIds } = await gateTestDependentItemsV1(
    ticked,
    evidenceRecords,
    planRevision,
    resolveWorkspaceRootForTaskV1(folderUri)
  );
  if (accepted.length === 0) return 0;
  const evidenceByKey = new Map<string, string | undefined>(
    verified.entries.map((entry) => [normalizeChecklistItemTextV1(entry.text), entry.evidence])
  );
  const verifiedAt = new Date().toISOString();
  await patchTaskProgressStrictV1(folderUri, (progress) =>
    accepted.reduce((next, itemText, index) => {
      const roundIds = testReportRoundIds[index] ?? [];
      return recordPlanItemReviewerVerificationV1(next, {
        planRevision,
        itemText,
        at: verifiedAt,
        evidence: evidenceByKey.get(normalizeChecklistItemTextV1(itemText)) ??
          `verified by reviewer in ${reviewStage} review (${reviewFilename})`,
        ...(roundIds.length ? { testReportRoundIds: roundIds } : {}),
      });
    }, progress)
  );
  return accepted.length;
}

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
  const candidates = offeredKeys
    ? applicableFromReview.filter((item) => offeredKeys.has(normalizeChecklistItemTextV1(item)))
    : applicableFromReview;
  const planRevision = getPlanRevisionV1(plan.text);
  const progressRead = await readTaskProgressStrictV1(folderUri);
  const evidenceRecords = progressRead.ok ? progressRead.decoded.progress.planItemEvidence ?? [] : [];
  const {
    accepted: applicable,
    testReportRoundIds: applicableTestReportRoundIds,
    withheld: withheldTestItems,
  } = await gateTestDependentItemsV1(candidates, evidenceRecords, planRevision, resolveWorkspaceRootForTaskV1(folderUri));
  const evidenceByKeyV1 = new Map<string, string | undefined>(
    verified.entries.map((entry) => [normalizeChecklistItemTextV1(entry.text), entry.evidence])
  );
  const applicableEvidence = applicable.map((item) => evidenceByKeyV1.get(normalizeChecklistItemTextV1(item)));
  if (applicable.length === 0) {
    const alreadyAppliedCount = filterAlreadyCheckedPlanItemsV1(plan.text, offeredItems ?? verified.items).length;
    if (withheldTestItems.length > 0) {
      return {
        kind: "blocked",
        severity: "warning",
        message: "The review named test-dependent item(s) without an applicable passing Implementation or Apply Review test report. " +
          `They remain provisional: ${withheldTestItems.join("; ")}`,
      };
    }
    return {
      kind: "blocked",
      severity: "info",
      message: "Every item this review named as verified complete is already ticked in plan-final.md.",
      alreadyAppliedCount: alreadyAppliedCount > 0 ? alreadyAppliedCount : undefined,
    };
  }

  return {
    kind: "ok",
    derivation: {
      reviewStage,
      reviewFilename,
      applicable,
      applicableEvidence,
      applicableTestReportRoundIds,
      withheldTestItems,
    },
  };
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
  const { reviewFilename, applicable, applicableEvidence, withheldTestItems } = derived.derivation;
  const withheldNote = withheldTestItems.length > 0
    ? `\nWithheld and still provisional because no applicable passing Implementation or Apply Review test report was found: ${withheldTestItems.join("; ")}`
    : "";

  const target: ChatTarget = {
    canonicalId,
    taskFolderPath,
    stage: reviewStage,
    taskName: displayName,
  };

  // RC3 item 4, Step 3: captured now, at post time — see
  // `fastForwardResumeSuffixV1`'s doc comment for why this can't be
  // re-derived when the option is later chosen.
  const fastForwardState = getFastForwardRunStateV1(taskFolderPath);
  const ffResume = fastForwardResumeSuffixV1(taskFolderPath, fastForwardState);

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
          label: `Apply ${applicable.length} Reviewer-Verified Tick${applicable.length === 1 ? "" : "s"}${ffResume.labelSuffix}`,
          resumeKind: "continue",
          consequence:
            `Ticks these ${applicable.length} item(s) in plan-final.md, sourced from ${reviewFilename}, then ` +
            "dispatches this stage's next action:\n" +
            applicable
              .map((item, index) => {
                const evidence = applicableEvidence[index];
                // RC3 item 1, Step 2c: shows the reviewer's own evidence
                // sentence under each item so the card carries WHY the tick
                // is safe, never a sentence pulled from elsewhere in the
                // review.
                const evidenceLine = evidence
                  ? `\n  evidence: ${evidence}`
                  : "\n  evidence: No evidence line in this review (older review format)";
                return `- ${formatChecklistItemGlyphV1({ checked: false, excluded: false })} ${item}${evidenceLine}`;
              })
              .join("\n") +
            withheldNote +
            ffResume.consequenceSuffix,
          effect: {
            kind: "command",
            command: "vs-code-ai-helper.applyReviewerVerifiedTicksConfirmed",
            args: [{ taskFolderPath, canonicalId, reviewStage, offeredItems: applicable, ...ffResume.extraArgs }],
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

export type WriteVerifiedTicksResultV1 =
  | { readonly kind: "applied"; readonly count: number }
  | { readonly kind: "noChecklist" }
  | { readonly kind: "notMerged" }
  | { readonly kind: "refused" };

/**
 * The write half of applying the reviewer's verified-complete ticks, shared by
 * the confirmed command above and by the review router when the checklist is
 * flagged unreliable (RC8 item 4: ticks the review already confirmed are
 * counted before the stage decision). Reads the plan of record fresh, merges
 * the synthetic summary, writes through the unchanged-content primitive and
 * withdraws the pending card. Never notifies; the caller words the outcome.
 */
export async function writeVerifiedTicksToPlanV1(
  folderUri: vscode.Uri,
  derivation: VerifiedTicksDerivationV1
): Promise<WriteVerifiedTicksResultV1> {
  const { reviewStage: resolvedStage, reviewFilename, applicable } = derivation;
  const freshPlan = await readPlanOfRecordV1(folderUri);
  if (!freshPlan.hasChecklist || !freshPlan.text) {
    return { kind: "noChecklist" };
  }
  const evidence = `verified by reviewer in ${resolvedStage} review (${reviewFilename})`;
  const synthetic = buildSyntheticVerifiedCompleteSummaryV1(applicable, evidence);
  const merged = mergeChecklistProgressV1(freshPlan.text, synthetic, { reviewerVerified: true });
  if (merged.kind !== "merged") {
    return { kind: "notMerged" };
  }
  const written = await writeTextFileIfUnchangedV1(
    getCanonicalImplementationUri(folderUri),
    freshPlan.text,
    merged.content
  );
  if (!written) {
    return { kind: "refused" };
  }
  const planRevision = getPlanRevisionV1(freshPlan.text);
  const verifiedAt = new Date().toISOString();
  await patchTaskProgressStrictV1(folderUri, (progress) => {
    const currentRevision = invalidatePlanItemEvidenceForPlanRevisionV1(progress, planRevision);
    return applicable.reduce((next, itemText, index) => {
      const testReportRoundIds = derivation.applicableTestReportRoundIds[index] ?? [];
      return recordPlanItemReviewerVerificationV1(next, {
        planRevision,
        itemText,
        at: verifiedAt,
        evidence: derivation.applicableEvidence[index] ?? `verified by reviewer in ${resolvedStage} review (${reviewFilename})`,
        ...(testReportRoundIds.length ? { testReportRoundIds } : {}),
      });
    }, currentRevision);
  });
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
  return { kind: "applied", count: applicable.length };
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
 * The final write goes through {@link writeTextFileIfUnchangedV1}
 * (`writeVerifiedTicksToPlanV1`) rather than an unconditional `writeTextFile`
 * (review-flagged 2026-08-25, task-fixable blocker `739cfbbb-…-1`: this was
 * the one remaining in-process writer of `plan-final.md` that bypassed that
 * primitive's FIFO queue and revision check, named explicitly in
 * `reconcilePlanChecklist.ts`'s Guard 3 comment as the known gap). The text
 * read as the basis for the merge is passed as the expected content, so the
 * write queues behind any other in-process writer of the same uri and is
 * refused — rather than silently overwriting — if the file changed
 * underneath it.
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
  const { applicable } = derived.derivation;

  const applied = await writeVerifiedTicksToPlanV1(folderUri, derived.derivation);
  if (applied.kind === "noChecklist") {
    NotificationRouter.showWarning(
      `${taskLabel}: plan-final.md changed while this was being applied and no longer has a checklist to tick.`
    );
    return;
  }
  if (applied.kind === "notMerged") {
    NotificationRouter.showWarning(
      `${taskLabel}: applying the reviewer's ticks did not change plan-final.md — the items no longer match the plan of record.`
    );
    return;
  }
  if (applied.kind === "refused") {
    NotificationRouter.showWarning(
      `${taskLabel}: plan-final.md changed while these ticks were being applied — nothing was written. Re-open the decision ` +
        "and try again."
    );
    return;
  }
  await inventory.refresh();
  NotificationRouter.showInformation(
    `${taskLabel}: Applied ${applicable.length} reviewer-verified tick(s) to plan-final.md.`
  );
  // Part 3, Step 5 (owner's ruling: "Ensemble performs it -> say so and do
  // it") — same note as reconcilePlanChecklist.ts's identical dispatch.
  // RC3 item 4, Step 3: forwards the provenance baked into this card at post
  // time — present only when Fast Forward was genuinely active then.
  await vscode.commands.executeCommand("vs-code-ai-helper.resumeAndApplyCurrentStageAction", {
    taskFolderPath: folderUri.fsPath,
    resumeFastForwardV1: normalized?.resumeFastForwardV1,
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
