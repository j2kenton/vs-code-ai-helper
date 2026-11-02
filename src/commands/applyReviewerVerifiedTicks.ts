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
  isTestDependentChecklistItemV1,
  POST_EDIT_STATEMENT_V1,
  reportCommandCoversTestIdentityV1,
  TEST_EVIDENCE_SATISFYING_COMMAND_HINT_V1,
} from "../utils/implementationChecklist";
import { parseReviewVerifiedCompleteV1 } from "../utils/reviewReadiness";
import { writeTextFileIfUnchangedV1 } from "../utils/fileUtils";
import { PlanItemEvidenceV1, PlanItemOwnerTestRunV1, PlanItemTestReportV1, STAGE_ARTIFACT_FILENAMES, TaskStage, isReviewStage } from "../types/taskProgress";
import {
  openWorkflowDecisionStoreV1,
  postWorkflowDecisionV1,
  withdrawWorkflowDecisionsByKeyV1,
} from "../utils/workflowDecisionDispatchV1";
import {
  APPLY_TICKS_DECISION_KEY_V1,
  APPLY_TICKS_NOW_OPTION_ID_V1,
  buildHeldTicksAnswerOptionsV1,
} from "./verifiedTicksHeldOptionsV1";
import { appendChatMessageV1 } from "../utils/chatHistoryStore";
import type { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import { armDeferredOptionRunV1 } from "../utils/deferredOptionRunV1";
import { taskOperations } from "../utils/taskOperations";
import { hasLiveWorkAdmissionBestEffortV1 } from "../state/workAdmissionV1";
import { withdrawStaleOpenItemsCardV1 } from "../utils/withdrawStaleOpenItemsCardV1";
import { ChatTarget } from "../views/chatView";
import { normalizePath } from "../utils/taskRoot";
import { WorkflowDecisionCommandResultV1, WorkflowDecisionOptionV1 } from "../types/workflowDecisionV1";
import { getFastForwardRunStateV1 } from "../utils/activeFastForwardRunsV1";
import { fastForwardResumeSuffixV1, FastForwardResumeStateV1 } from "./fastForwardResumeSuffixV1";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import { invalidatePlanItemEvidenceForPlanRevisionV1 } from "../utils/taskProgressTransforms";
import { recordPlanItemReviewerVerificationV1 } from "../utils/taskProgressTransforms";
import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import { offerActionInChatV1 } from "../utils/chatActionOfferV1";
import { isFormContinuationPendingV1 } from "../utils/formPlanWriteMarkerV1";

/**
 * bugs5 Step 4: the name of the command that settles one checklist item by hand, as the Command
 * Palette shows it (the `package.json` title without its trailing ellipsis; a unit test keeps the two
 * in step).
 */
export const SETTLE_CHECKLIST_ITEM_COMMAND_TITLE_V1 = "Tick or Exclude a Checklist Item";

/** Said under the withheld items, so the owner knows they are not stuck with them. */
export const SETTLE_WITHHELD_ITEMS_HINT_V1 =
  `You can settle them yourself with ${SETTLE_CHECKLIST_ITEM_COMMAND_TITLE_V1}.`;

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
  /** Why each withheld item is held (normalized item key to a plain reason). */
  readonly withheldReasons: ReadonlyMap<string, string>;
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
      /** Items the review named verified that stay provisional for a missing test report (bugs4 item 32). */
      readonly withheldTestItems?: readonly string[];
      readonly withheldReasons?: ReadonlyMap<string, string>;
    };

// Shared with the reviewer-facing list (implementationChecklist.ts) so the review and the card
// name the same satisfying command (bugs4 item 11).
export { TEST_EVIDENCE_SATISFYING_COMMAND_HINT_V1 };

export const WITHHELD_NO_REPORT_REASON_V1 = "no test report is recorded for this item";
export const WITHHELD_REPORT_DOES_NOT_COUNT_REASON_V1 =
  "a test report is recorded but does not count (it did not pass cleanly, did not state it ran on the edited tree, or its command does not cover this item's test)";
export const WITHHELD_REPORT_STALE_REASON_V1 = "its test report predates later edits to the tested files, so it no longer applies";

/**
 * Readable list of items held provisional for a missing test report, with the
 * command that would satisfy each (one bullet per item, not one long paragraph).
 */
export function describeWithheldTestItemsV1(
  items: readonly string[],
  maxListed: number = 12,
  reasons?: ReadonlyMap<string, string>
): string {
  const listed = items.slice(0, maxListed);
  const more = items.length > listed.length ? `\n  - …and ${items.length - listed.length} more` : "";
  const bullets =
    listed
      .map((item) => {
        const reason = reasons?.get(normalizeChecklistItemTextV1(item));
        return reason ? `  - ${item} — ${reason}` : `  - ${item}`;
      })
      .join("\n") + more;
  return `${items.length} test-dependent item${items.length === 1 ? "" : "s"} wait${items.length === 1 ? "s" : ""} for a passing test report and stay provisional:\n${bullets}\n${TEST_EVIDENCE_SATISFYING_COMMAND_HINT_V1}`;
}

/**
 * bugs4 item 32: the "review named test-dependent items without a passing report" outcome
 * belongs in the task chat as a readable list with the report form that was needed, not in
 * one pop-up paragraph. Returns false when the chat could not take it (the caller then falls
 * back to the notification).
 */
export async function postWithheldTestEvidenceOutcomeInChatV1(
  taskFolderPath: string,
  taskLabel: string,
  withheldTestItems: readonly string[],
  withheldReasons?: ReadonlyMap<string, string>
): Promise<boolean> {
  const pointer = await offerActionInChatV1({
    taskFolderPath,
    taskLabel,
    actionLabel: "Run the next stage action",
    command: "vs-code-ai-helper.resumeAndApplyCurrentStageAction",
    args: [{ taskFolderPath }],
    noticeText:
      `The review named ${withheldTestItems.length} item${withheldTestItems.length === 1 ? "" : "s"} as verified, but no ticks were applied: ` +
      describeWithheldTestItemsV1(withheldTestItems, 12, withheldReasons),
    actionConsequence:
      "Dispatches this stage's next action. It only produces the missing report if that round can run the named tests and lists them under ## Verification.",
    recommend: {
      target: "none",
      reasoning:
        "A round that runs the named tests would produce the report. Run one only if its test command is allowed; otherwise record the run yourself or settle the items by hand.",
    },
    optional: true,
    doNothingOption: {
      label: "Not now",
      consequence: "Does nothing. The items stay provisional and the checklist is unchanged.",
    },
  }).catch(() => undefined);
  return pointer !== undefined;
}

/** True when the owner recorded a passing (exit 0) hand-run covering this item in this plan revision. */
export function ownerRecordedPassingRunCoversItemV1(
  ownerTestRuns: readonly PlanItemOwnerTestRunV1[],
  planRevision: string,
  itemKey: string
): boolean {
  return ownerTestRuns.some(
    (run) => run.planRevision === planRevision && run.exitCode === 0 && run.itemKeys.includes(itemKey)
  );
}

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
  workspaceRoot: string | undefined,
  ownerTestRuns: readonly PlanItemOwnerTestRunV1[] = []
): Promise<{
  accepted: string[];
  testReportRoundIds: string[][];
  withheld: string[];
  /** Normalized item key to the plain reason that item is withheld (bugs4 Step 20). */
  withheldReasons: Map<string, string>;
}> {
  const accepted: string[] = [];
  const testReportRoundIds: string[][] = [];
  const withheld: string[] = [];
  const withheldReasons = new Map<string, string>();
  for (const itemText of items) {
    // bugs4 item 11/21: the SAME classifier the gate uses. A private word-regex copy here held
    // back every item that merely mentioned "test", so a populated Verified Complete block
    // produced zero verifications.
    if (!isTestDependentChecklistItemV1(itemText)) {
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
        // bugs4 item 21: the SAME statement the report parser accepted ("post-edit run", "final
        // source", a tree fingerprint). A narrower copy here withheld every report the parser had
        // just accepted when the round wrote "on the final source".
        POST_EDIT_STATEMENT_V1.test(report.sourceState) &&
        reportCommandCoversTestIdentityV1(report.command, report.testIdentity)
      );
    const currentReports: PlanItemTestReportV1[] = [];
    for (const report of candidateReports) {
      if (!(await reportSourceStateStillCurrentV1(report, workspaceRoot))) {
        continue;
      }
      currentReports.push(report);
    }
    if (currentReports.length === 0) {
      // bugs4 item 21 / Step 19: a passing run the owner recorded by hand is test evidence for
      // the items it names (an explicit owner decision, with owner provenance). Unlike an
      // editing round's report it is not tied to a source fingerprint: the owner ran it.
      if (ownerRecordedPassingRunCoversItemV1(ownerTestRuns, planRevision, itemKey)) {
        accepted.push(itemText);
        testReportRoundIds.push([]);
        continue;
      }
      withheld.push(itemText);
      // bugs4 Step 20: say which obstacle held this item, so the card never has to guess.
      const recordedReports = evidenceRecords
        .filter((record) => record.planRevision === planRevision && record.itemKey === itemKey)
        .flatMap((record) => record.testReports ?? []);
      withheldReasons.set(
        itemKey,
        recordedReports.length === 0
          ? WITHHELD_NO_REPORT_REASON_V1
          : candidateReports.length === 0
            ? WITHHELD_REPORT_DOES_NOT_COUNT_REASON_V1
            : WITHHELD_REPORT_STALE_REASON_V1
      );
      continue;
    }
    accepted.push(itemText);
    testReportRoundIds.push([...new Set(currentReports.map((report) => report.roundId))]);
  }
  return { accepted, testReportRoundIds, withheld, withheldReasons };
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
    resolveWorkspaceRootForTaskV1(folderUri),
    progressRead.decoded.progress.planItemOwnerTestRuns ?? []
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
    withheldReasons,
  } = await gateTestDependentItemsV1(
    candidates,
    evidenceRecords,
    planRevision,
    resolveWorkspaceRootForTaskV1(folderUri),
    progressRead.ok ? progressRead.decoded.progress.planItemOwnerTestRuns ?? [] : []
  );
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
        message: `The review named test-dependent item(s) without an applicable passing Implementation or Apply Review test report. ${describeWithheldTestItemsV1(withheldTestItems, 12, withheldReasons)}`,
        withheldTestItems,
        withheldReasons,
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
      withheldReasons,
    },
  };
}

/**
 * bugs5 Step 2: while a Fast Forward run is live, the card also offers the answer that only ticks.
 * Inserted before the trailing "Not yet", so that stays last.
 */
export function addTickOnlyOptionWhenFastForwardLiveV1(
  fastForwardLive: boolean,
  options: readonly WorkflowDecisionOptionV1[]
): readonly WorkflowDecisionOptionV1[] {
  if (!fastForwardLive) {
    return options;
  }
  const tickOnly = buildHeldTicksAnswerOptionsV1({ decisionKey: APPLY_TICKS_DECISION_KEY_V1, options }).find(
    (option) => option.optionId === APPLY_TICKS_NOW_OPTION_ID_V1
  );
  if (!tickOnly) {
    return options;
  }
  const notYetIndex = options.findIndex((option) => option.effect.kind === "doNothing");
  return notYetIndex === -1
    ? [...options, tickOnly]
    : [...options.slice(0, notYetIndex), tickOnly, ...options.slice(notYetIndex)];
}

export type ApplyTicksDecisionPostResultV1 =
  | { readonly kind: "posted" }
  | {
      readonly kind: "blocked";
      readonly message: string;
      readonly severity: "info" | "warning";
      readonly withheldTestItems?: readonly string[];
      readonly withheldReasons?: ReadonlyMap<string, string>;
    }
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
    return {
      kind: "blocked",
      message: derived.message,
      severity: derived.severity,
      ...(derived.withheldTestItems ? { withheldTestItems: derived.withheldTestItems } : {}),
      ...(derived.withheldReasons ? { withheldReasons: derived.withheldReasons } : {}),
    };
  }
  const { reviewFilename, applicable, applicableEvidence, withheldTestItems, withheldReasons } = derived.derivation;
  const withheldNote = withheldTestItems.length > 0
    ? `\nWithheld and still provisional because no applicable passing Implementation or Apply Review test report was found. ${describeWithheldTestItemsV1(withheldTestItems, 12, withheldReasons)}` +
      ` ${SETTLE_WITHHELD_ITEMS_HINT_V1}`
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
      options: addTickOnlyOptionWhenFastForwardLiveV1(ffResume.extraArgs.resumeFastForwardV1 !== undefined, [
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
      ]),
      recommendation:
        ffResume.extraArgs.resumeFastForwardV1 !== undefined
          ? {
              kind: "option",
              optionId: APPLY_TICKS_NOW_OPTION_ID_V1,
              reasoning:
                "Fast Forward is running and dispatching is its job; ticking only records the reviewer's " +
                "verification, which cannot untick or misapply anything.",
            }
          : {
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
    if (
      result.withheldTestItems &&
      result.withheldTestItems.length > 0 &&
      (await postWithheldTestEvidenceOutcomeInChatV1(
        resolved.taskFolderPath,
        taskLabel,
        result.withheldTestItems,
        result.withheldReasons
      ))
    ) {
      return;
    }
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
  await withdrawStaleOpenItemsCardV1(folderUri, merged.content);
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
    const postedInChat =
      derived.withheldTestItems !== undefined &&
      derived.withheldTestItems.length > 0 &&
      (await postWithheldTestEvidenceOutcomeInChatV1(
        resolved.taskFolderPath,
        taskLabel,
        derived.withheldTestItems,
        derived.withheldReasons
      ));
    if (!postedInChat) {
      NotificationRouter.showInformation(`${taskLabel}: ${derived.message}`);
    }
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
  //
  // bugs4 item 6: when the open-items form's own follow-up for this task is
  // still pending it owns the dispatch; a second one would race it for the
  // task's work admission and be refused. Stand down and say so.
  if (isFormContinuationPendingV1(folderUri.fsPath)) {
    NotificationRouter.showInformation(
      `${taskLabel}: the ticks are applied; the open-items form is already arranging what runs next, so no second dispatch was started.`
    );
    return;
  }
  await vscode.commands.executeCommand("vs-code-ai-helper.resumeAndApplyCurrentStageAction", {
    taskFolderPath: folderUri.fsPath,
    resumeFastForwardV1: normalized?.resumeFastForwardV1,
  });
}

async function postTicksChatLineV1(
  taskFolderPath: string,
  stage: TaskStage,
  text: string
): Promise<void> {
  try {
    await appendChatMessageV1(taskFolderPath, { role: "assistant", text, stage, at: new Date().toISOString() });
  } catch {
    // The ticks themselves are already written (or kept); the chat line is best-effort.
  }
}

function describeTicksNowResultV1(appliedCount: number, offeredCount: number): string {
  const already = offeredCount - appliedCount;
  const alreadyNote =
    already > 0 ? ` ${already} other item${already === 1 ? " was" : "s were"} already ticked and left as they are.` : "";
  return `Ticked ${appliedCount} item${appliedCount === 1 ? "" : "s"} in plan-final.md; Fast Forward's next round counts them.${alreadyNote}`;
}

/**
 * bugs5 Step 2: "Apply the N ticks now". Only the monotonic tick merge: nothing is dispatched, so
 * Fast Forward keeps its own next step. With no round open the ticks are merged at once; with one
 * open (a write to plan-final.md could trip the round's foreign-write containment) the accepted
 * ticks are kept on the decision record and merged as soon as the round ends, before Fast
 * Forward's next decision ({@link applyAcceptedTicksNowV1}).
 */
export async function applyReviewerVerifiedTicksNowV1(
  inventory: TaskInventory,
  currentTaskStore: CurrentTaskStore,
  explicitArg?: ApplyArg
): Promise<WorkflowDecisionCommandResultV1 | void> {
  await TaskCreationStartupReconcilerV1.waitUntilReady();
  const normalized = normalizeArg(explicitArg);
  const resolved = await resolveTaskContext(inventory, normalized, { allowPaused: true }, currentTaskStore);
  if (!resolved) {
    NotificationRouter.showError("The task could not be found. Refresh the Tasks panel and try again.");
    return;
  }
  const folderUri = vscode.Uri.file(resolved.taskFolderPath);
  const reviewStage = normalized?.reviewStage ?? resolved.progress.currentStage;
  const offered = normalized?.offeredItems ?? [];
  const derived = await deriveApplicableVerifiedTicksV1(folderUri, reviewStage, normalized?.offeredItems);
  if (derived.kind === "blocked") {
    const count = derived.alreadyAppliedCount ?? 0;
    return {
      outcome: "alreadyDone",
      message:
        count > 0
          ? `Already done: the ${count} reviewer-verified tick${count === 1 ? "" : "s"} ${count === 1 ? "is" : "are"} applied.`
          : derived.message,
    };
  }
  const { applicable } = derived.derivation;

  if (hasLiveWorkAdmissionBestEffortV1(resolved.taskFolderPath)) {
    const store = openWorkflowDecisionStoreV1();
    const answered = store?.findLatestResolvedForOption(
      resolved.taskFolderPath,
      APPLY_TICKS_DECISION_KEY_V1,
      APPLY_TICKS_NOW_OPTION_ID_V1
    );
    if (store && answered && answered.deferredAnswer === undefined) {
      await store.recordDeferredAnswer(answered.decisionId, {
        kind: "ticksOnly",
        optionId: APPLY_TICKS_NOW_OPTION_ID_V1,
        acceptedAt: new Date().toISOString(),
        itemKeys: applicable,
      });
      armDeferredOptionRunV1({
        key: `ticks-now:${normalizePath(resolved.taskFolderPath)}`,
        isTaskBusy: () => hasLiveWorkAdmissionBestEffortV1(resolved.taskFolderPath),
        subscribeToTaskFree: (listener) => taskOperations.onDidEnd(() => listener()),
        carryOut: async () => {
          await applyAcceptedTicksNowV1(resolved.taskFolderPath);
          return { kind: "done" };
        },
        report: () => Promise.resolve(),
      });
      // The chat shows a "done" result's message nowhere, so the line is posted here.
      await postTicksChatLineV1(
        resolved.taskFolderPath,
        reviewStage,
        `These ${applicable.length} ticks are applied as soon as the current ${describeRoundNounV1(reviewStage)} ends, before Fast ` +
          "Forward's next decision."
      );
      return { outcome: "done" };
    }
  }

  const applied = await writeVerifiedTicksToPlanV1(folderUri, derived.derivation);
  if (applied.kind !== "applied") {
    return {
      outcome: "refused",
      message:
        "plan-final.md changed while these ticks were being applied, so nothing was written. " +
        "The card is back; choose it again.",
      reopenCard: true,
    };
  }
  await inventory.refresh();
  await postTicksChatLineV1(
    resolved.taskFolderPath,
    reviewStage,
    describeTicksNowResultV1(applied.count, offered.length || applicable.length)
  );
  return { outcome: "done" };
}

/** "Apply Review" for a review stage (the round whose end the ticks wait for), "round" otherwise. */
function describeRoundNounV1(stage: TaskStage): string {
  return isReviewStage(stage) ? "Apply Review" : "round";
}

/**
 * bugs5 Step 2: merges the ticks the owner accepted while a round was open, now that it has ended.
 * Called at Fast Forward's iteration boundary (after an Apply Review ends, before its next
 * decision reads the checklist), when the task becomes free, and on activation. Re-derives against
 * the plan on disk, so an item ticked in the meantime is reported as already ticked and never
 * ticked twice. Returns the number of items ticked.
 */
export async function applyAcceptedTicksNowV1(taskFolderPath: string): Promise<number> {
  const store = openWorkflowDecisionStoreV1();
  if (!store) {
    return 0;
  }
  const accepted = store
    .listWithPendingDeferredAnswer(taskFolderPath)
    .filter((decision) => decision.deferredAnswer?.kind === "ticksOnly");
  let total = 0;
  for (const decision of accepted) {
    const answer = decision.deferredAnswer!;
    const folderUri = vscode.Uri.file(taskFolderPath);
    const derived = await deriveApplicableVerifiedTicksV1(folderUri, decision.stage, answer.itemKeys);
    if (derived.kind === "blocked") {
      await store.clearDeferredAnswer(decision.decisionId, true);
      await postTicksChatLineV1(
        taskFolderPath,
        decision.stage,
        `The ${answer.itemKeys.length} ticks you accepted were already in plan-final.md when the round ended; nothing more to tick.`
      );
      continue;
    }
    const written = await writeVerifiedTicksToPlanV1(folderUri, derived.derivation);
    if (written.kind === "applied") {
      total += written.count;
      await store.clearDeferredAnswer(decision.decisionId, true);
      await postTicksChatLineV1(
        taskFolderPath,
        decision.stage,
        `The round has ended: ticked ${written.count} of the ${answer.itemKeys.length} items you accepted in plan-final.md. ` +
          "Fast Forward's next decision counts them."
      );
    } else {
      await postTicksChatLineV1(
        taskFolderPath,
        decision.stage,
        "The ticks you accepted could not be written because plan-final.md changed; choose the card again if it is still shown."
      );
      await store.clearDeferredAnswer(decision.decisionId, true);
    }
  }
  return total;
}

/**
 * bugs5 Step 2 / item 10: after a reload, ticks accepted while a round was open are merged once the
 * task has no round (the waiter that did it is memory only).
 */
export async function rearmAcceptedTicksV1(store: WorkflowDecisionStoreV1): Promise<void> {
  const tasks = new Set(
    store
      .listWithPendingDeferredAnswer()
      .filter((decision) => decision.deferredAnswer?.kind === "ticksOnly")
      .map((decision) => decision.taskCanonicalId)
  );
  for (const taskPath of tasks) {
    if (hasLiveWorkAdmissionBestEffortV1(taskPath)) {
      armDeferredOptionRunV1({
        key: `ticks-now:${normalizePath(taskPath)}`,
        isTaskBusy: () => hasLiveWorkAdmissionBestEffortV1(taskPath),
        subscribeToTaskFree: (listener) => taskOperations.onDidEnd(() => listener()),
        carryOut: async () => {
          await applyAcceptedTicksNowV1(taskPath);
          return { kind: "done" };
        },
        report: () => Promise.resolve(),
      });
    } else {
      await applyAcceptedTicksNowV1(taskPath).catch(() => 0);
    }
  }
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
    ),
    vscode.commands.registerCommand(
      "vs-code-ai-helper.applyReviewerVerifiedTicksNow",
      (arg?: ApplyArg) => applyReviewerVerifiedTicksNowV1(inventory, currentTaskStore, arg)
    )
  );
}
