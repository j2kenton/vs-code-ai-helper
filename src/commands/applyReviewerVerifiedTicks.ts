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
  formatChecklistItemGlyphV1,
  mergeChecklistProgressV1,
  normalizeChecklistItemTextV1,
  getPlanRevisionV1,
  findPlanItemHashEntryV1,
  indexPlanItemRowsV1,
  listCheckedVerificationTargetsV1,
  listUncheckedVerificationTargetsV1,
  resolveVerifiedCompleteEntryTextsV1,
  listPlanItemIdsV1,
  type AmbiguousVerificationEntryV1,
  type UnknownVerificationIdV1,
  listItemsTickedBetweenV1,
  listPlanItemContentHashesV1,
  type PlanItemHashEntryV1,
  planItemRowAppliesV1,
  stripPlanItemAnnotationsV1,
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
  SETTLE_REST_ITEM_BY_ITEM_COMMAND_V1,
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
import { prunePlanItemEvidenceForPlanV1 } from "../utils/taskProgressTransforms";
import { testDependencyStatesStillCurrentV1 } from "../utils/testDependencyStateV1";
import { recordPlanItemReviewerVerificationV1 } from "../utils/taskProgressTransforms";
import { refreshPlanItemSettlementSnapshotV1 } from "./planItemSettlementNoticeV1";
import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import { buildWithheldTestEvidenceCardInputV1 } from "../utils/withheldTestEvidenceCardV1";
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
       * Owner decision 2026-11-05 (item identity by design): the issued item id of each entry in `offeredItems`
       * (same index; `null` where the review named the item by its text). With it, confirming the card applies only
       * the exact items it offered, never a same-worded twin.
       */
      offeredItemIds?: readonly (string | null)[];
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
      offeredItemIds?: readonly (string | null)[];
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
    offeredItemIds?: readonly (string | null)[];
    resumeFastForwardV1?: FastForwardResumeStateV1;
  };
  if (explicit.canonicalId || explicit.taskFolderPath) {
    return {
      canonicalId: explicit.canonicalId,
      taskFolderPath: explicit.taskFolderPath,
      reviewStage: explicit.reviewStage,
      offeredItems: explicit.offeredItems,
      offeredItemIds: explicit.offeredItemIds,
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
   * Owner decision 2026-11-05 (item identity by design): the issued id of the exact item for each entry in
   * `applicable`, same order/index, `undefined` where the review named the item by its text. An entry with an id
   * ticks and verifies exactly that item, even when another item shares its wording.
   */
  readonly applicableItemIds?: readonly (string | undefined)[];
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
export function resolveWorkspaceRootForTaskV1(folderUri: vscode.Uri): string | undefined {
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
  // review1 Step 15: a report that recorded what it depends on (its test files, their direct imports and the
  // test-run config) is current while those are unchanged; the rest of the tree may have moved on.
  if (report.testDependencyStates?.length) {
    return testDependencyStatesStillCurrentV1(report.testDependencyStates, workspaceRoot);
  }
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
  // review1 Step 34 / Step 53: no option dispatches a model round to produce the report (it may be refused the test
  // command, and tends to make edits). The card offers Ensemble's own Publish Checks run, the owner's recorded run,
  // and the owner's tick.
  const read = await readTaskProgressStrictV1(vscode.Uri.file(taskFolderPath)).catch(() => undefined);
  if (!read || !read.ok) {
    return false;
  }
  const stage = read.decoded.progress.currentStage;
  const reasonByKey = withheldReasons;
  const card = buildWithheldTestEvidenceCardInputV1({
    taskFolderPath,
    stage,
    taskLabel,
    items: withheldTestItems,
    reasonFor: (item) => reasonByKey?.get(normalizeChecklistItemTextV1(item)),
  });
  const posted = await postWorkflowDecisionV1(
    { ...card, suppressNotification: true },
    {
      canonicalId: normalizePath(taskFolderPath),
      taskFolderPath,
      stage,
      taskName: read.decoded.progress.displayName,
    }
  ).catch(() => undefined);
  return posted !== undefined;
}

/**
 * review1 Step 34 / Step 53: after evidence arrives (a Publish Checks report recorded for an item, or the owner's
 * passing run), applies the review's held ticks at once, through the same derivation and monotonic merge. Returns
 * how many were ticked and which items are still held, so the caller can say so. Does nothing off a review stage.
 */
export async function applyHeldVerifiedTicksAfterEvidenceV1(
  taskFolderPath: string,
  taskLabel?: string
): Promise<{ readonly ticked: number; readonly stillWithheld: readonly string[] }> {
  const folderUri = vscode.Uri.file(taskFolderPath);
  const read = await readTaskProgressStrictV1(folderUri).catch(() => undefined);
  if (!read || !read.ok || !isReviewStage(read.decoded.progress.currentStage)) {
    return { ticked: 0, stillWithheld: [] };
  }
  const derived = await deriveApplicableVerifiedTicksV1(folderUri, read.decoded.progress.currentStage);
  if (derived.kind !== "ok") {
    return { ticked: 0, stillWithheld: derived.withheldTestItems ?? [] };
  }
  const applied = await applyVerifiedTicksAtOnceV1(folderUri, derived.derivation, taskLabel);
  return {
    ticked: applied.kind === "applied" ? applied.count : 0,
    stillWithheld: derived.derivation.withheldTestItems,
  };
}

/**
 * True when the owner recorded a passing (exit 0) hand-run covering this item. review1 Step 2: the run applies
 * while the item is unchanged (its content hash, when the run stored one), not while the plan revision is.
 */
export function ownerRecordedPassingRunCoversItemV1(
  ownerTestRuns: readonly PlanItemOwnerTestRunV1[],
  itemKey: string,
  itemContentHash?: string,
  itemOccurrence?: number
): boolean {
  return ownerTestRuns.some((run) => {
    if (run.exitCode !== 0 || !run.itemKeys.includes(itemKey)) return false;
    const stored = run.itemContentHashes?.[itemKey];
    if (stored !== undefined && itemContentHash !== undefined && stored !== itemContentHash) return false;
    // A run recorded for one copy of identical items covers that copy only.
    const storedOccurrence = run.itemOccurrences?.[itemKey];
    return storedOccurrence === undefined || itemOccurrence === undefined || storedOccurrence === itemOccurrence;
  });
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
  planText: string,
  workspaceRoot: string | undefined,
  ownerTestRuns: readonly PlanItemOwnerTestRunV1[] = [],
  /** review1 (review fix): the plan item each of `items` means, by position; falls back to naming it by text. */
  itemEntries: readonly (PlanItemHashEntryV1 | undefined)[] = []
): Promise<{
  accepted: string[];
  /** Positions in `items` of the accepted ones, aligned with `accepted` and `testReportRoundIds`. */
  acceptedIndices: number[];
  testReportRoundIds: string[][];
  withheld: string[];
  /** Normalized item key to the plain reason that item is withheld (bugs4 Step 20). */
  withheldReasons: Map<string, string>;
}> {
  const accepted: string[] = [];
  const acceptedIndices: number[] = [];
  const testReportRoundIds: string[][] = [];
  const withheld: string[] = [];
  const withheldReasons = new Map<string, string>();
  for (const [itemIndex, itemText] of items.entries()) {
    // bugs4 item 11/21: the SAME classifier the gate uses. A private word-regex copy here held
    // back every item that merely mentioned "test", so a populated Verified Complete block
    // produced zero verifications.
    if (!isTestDependentChecklistItemV1(itemText)) {
      accepted.push(itemText);
      acceptedIndices.push(itemIndex);
      testReportRoundIds.push([]);
      continue;
    }
    const itemKey = normalizeChecklistItemTextV1(itemText);
    // review1 Step 2: rows for this item (by content hash, or text for legacy rows), whatever plan revision
    // they were recorded at.
    const itemEntry = itemEntries[itemIndex] ?? findPlanItemHashEntryV1(planText, itemText);
    const itemRows = evidenceRecords.filter((record) =>
      itemEntry !== undefined ? planItemRowAppliesV1(record, itemEntry) : record.itemKey === itemKey
    );
    const candidateReports = itemRows
      .flatMap((record) => record.testReports ?? [])
      .filter((report) =>
        report.passed > 0 &&
        report.failed === 0 &&
        // bugs4 item 21: the SAME statement the report parser accepted ("post-edit run", "final
        // source", a tree fingerprint). A narrower copy here withheld every report the parser had
        // just accepted when the round wrote "on the final source".
        // review1 Step 34: a Publish Checks report is Ensemble's own run on the tree as it stands, not a round's
        // claim, so it needs no post-edit sentence (it still goes through the source-state check below).
        // Likewise its test files came from the run's own output, not from a command line to match them against.
        (report.source === "publishChecks" ||
          (POST_EDIT_STATEMENT_V1.test(report.sourceState) &&
            reportCommandCoversTestIdentityV1(report.command, report.testIdentity)))
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
      if (ownerRecordedPassingRunCoversItemV1(ownerTestRuns, itemKey, itemEntry?.hash, itemEntry?.occurrence)) {
        accepted.push(itemText);
        acceptedIndices.push(itemIndex);
        testReportRoundIds.push([]);
        continue;
      }
      withheld.push(itemText);
      // bugs4 Step 20: say which obstacle held this item, so the card never has to guess.
      const recordedReports = itemRows.flatMap((record) => record.testReports ?? []);
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
    acceptedIndices.push(itemIndex);
    testReportRoundIds.push([...new Set(currentReports.map((report) => report.roundId))]);
  }
  return { accepted, acceptedIndices, testReportRoundIds, withheld, withheldReasons };
}

/**
 * review1 Step 43: the normalised keys of the plan items that carry a reviewer verification that still applies to
 * them. Read BEFORE a narrowing is written, so the verification the item had can be carried to its new wording.
 */
export async function listReviewerVerifiedItemKeysV1(
  folderUri: vscode.Uri,
  planText: string
): Promise<ReadonlySet<string>> {
  const progressRead = await readTaskProgressStrictV1(folderUri);
  if (!progressRead.ok) return new Set();
  const evidenceFor = indexPlanItemRowsV1(progressRead.decoded.progress.planItemEvidence ?? []);
  return new Set(
    listPlanItemContentHashesV1(planText)
      // A narrowing adds a nested child to a top-level item, so only a top-level verification is carried: a
      // verified child of the same wording says nothing about the item being narrowed.
      .filter((entry) => !entry.nested && evidenceFor(entry).some((record) => (record.verifications?.length ?? 0) > 0))
      .map((entry) => entry.key)
  );
}

/**
 * review1 Step 43: after a narrowing changed an item (its content hash moved with the new nested child), records
 * the reviewer's verification again under the new plan, with the narrowing's evidence as provenance. Only items
 * that were verified before are passed in, so a narrowing never turns an unverified item into a verified one.
 */
export async function carryReviewerVerificationToNarrowedItemsV1(
  folderUri: vscode.Uri,
  newPlanText: string,
  items: readonly { readonly itemText: string; readonly evidence: string }[]
): Promise<number> {
  if (items.length === 0) return 0;
  const planRevision = getPlanRevisionV1(newPlanText);
  const at = new Date().toISOString();
  await patchTaskProgressStrictV1(folderUri, (progress) =>
    items.reduce(
      (next, item) =>
        recordPlanItemReviewerVerificationV1(next, {
          planRevision,
          planText: newPlanText,
          itemText: item.itemText,
          at,
          evidence: item.evidence,
        }),
      progress
    )
  );
  return items.length;
}

/**
 * review1 (owner decision 2026-11-05): says in the chat which reviewer entries named several checked plan items
 * and therefore verified none of them, so the owner knows those items stay as they were until a reviewer names
 * one unambiguously (for example by step number).
 */
async function postAmbiguousVerificationChatLineV1(
  taskFolderPath: string,
  stage: TaskStage,
  reviewFilename: string,
  ambiguous: readonly AmbiguousVerificationEntryV1[],
  unknownIds: readonly UnknownVerificationIdV1[] = []
): Promise<void> {
  if (ambiguous.length > 0) {
    const lines = ambiguous.map((entry) => `- "${entry.text}" (matches ${entry.matches} checked items)`);
    await postTicksChatLineV1(
      taskFolderPath,
      stage,
      `${reviewFilename} named ${ambiguous.length === 1 ? "an item" : `${ambiguous.length} items`} as verified complete ` +
        `with wording that fits more than one checked plan item, so it verified none of them:\n${lines.join("\n")}\n` +
        `Those items stay as they were. They count once a review names the one it means unambiguously, for example by its [item:<id>] or step number.`
    );
  }
  if (unknownIds.length > 0) {
    const lines = unknownIds.map((entry) => `- item:${entry.id}${entry.text === `item:${entry.id}` ? "" : ` ("${entry.text}")`}`);
    await postTicksChatLineV1(
      taskFolderPath,
      stage,
      `${reviewFilename} cited ${unknownIds.length === 1 ? "an item id" : `${unknownIds.length} item ids`} Ensemble did not issue for this plan, ` +
        `so nothing was recorded for ${unknownIds.length === 1 ? "it" : "them"} (the plan may have changed since the list was shown):\n${lines.join("\n")}\n` +
        `The next review can name the item again by its current [item:<id>].`
    );
  }
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
  // review1 Step 2: verified means a verification on a row that still applies to the item.
  const evidenceFor = indexPlanItemRowsV1(evidenceRecords);
  // review1 (owner decision 2026-11-05): a reviewer names an item by its text, which a top-level item and a
  // nested child, or two copies at one level, can share. An entry that names exactly one checked item verifies
  // it; an entry that names several verifies none of them and is said so in the chat, never fanned out.
  // Owner decision 2026-11-05 (item identity by design): an entry may cite the `[item:<id>]` Ensemble issued, or a
  // `Step N` that names one item; a verification is recorded only for an id Ensemble issued.
  const resolved = listCheckedVerificationTargetsV1(plan.text, verified.entries);
  await postAmbiguousVerificationChatLineV1(
    folderUri.fsPath,
    reviewStage,
    reviewFilename,
    resolved.ambiguous,
    resolved.unknownIds
  );
  const ticked = resolved.targets.filter(
    (entry) => !evidenceFor(entry).some((record) => (record.verifications?.length ?? 0) > 0)
  );
  if (ticked.length === 0) return 0;
  const { acceptedIndices, testReportRoundIds } = await gateTestDependentItemsV1(
    ticked.map((entry) => entry.text),
    evidenceRecords,
    plan.text,
    resolveWorkspaceRootForTaskV1(folderUri),
    progressRead.decoded.progress.planItemOwnerTestRuns ?? [],
    ticked
  );
  if (acceptedIndices.length === 0) return 0;
  const verifiedAt = new Date().toISOString();
  await patchTaskProgressStrictV1(folderUri, (progress) =>
    acceptedIndices.reduce((next, tickedIndex, index) => {
      const entry = ticked[tickedIndex]!;
      const roundIds = testReportRoundIds[index] ?? [];
      return recordPlanItemReviewerVerificationV1(next, {
        planRevision,
        planText: plan.text,
        itemText: entry.text,
        itemOccurrence: entry.occurrence,
        itemNested: entry.nested,
        at: verifiedAt,
        evidence: resolved.sources.get(entry)?.evidence ??
          `verified by reviewer in ${reviewStage} review (${reviewFilename})`,
        ...(roundIds.length ? { testReportRoundIds: roundIds } : {}),
      });
    }, progress)
  );
  return acceptedIndices.length;
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
  offeredItems?: readonly string[],
  offeredItemIds?: readonly (string | null | undefined)[]
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

  // Owner decision 2026-11-05 (item identity by design): an entry that cites an issued `[item:<id>]` (or a
  // `Step N` naming one item) targets exactly that item, whichever other item shares its wording; an unissued id
  // or an item already ticked drops out. A plain text entry matches by wording, as before.
  const allTargets = listUncheckedVerificationTargetsV1(plan.text, verified.entries);
  const namedTexts = resolveVerifiedCompleteEntryTextsV1(plan.text, verified.entries).entries.map((entry) => entry.text);
  // Scope to exactly what this card offered, when it offered anything: a
  // review file that changed between post and confirm (newly verifying a
  // DIFFERENT item, say) must never let a stale card apply something it
  // never promised — see this function's doc comment. Offered items are texts, so two same-worded targets pass
  // only as many times as the card offered that wording.
  //
  // When the card also recorded the issued id of each item it offered (same index as `offeredItems`), an id target
  // passes only if its own id was offered, whatever its wording; only text-only targets are matched by wording, and
  // only against text-only offers. So a card that offered the first of two same-worded items can never apply the
  // second, even when a newer review now verifies only the second.
  const idsAligned = offeredItems !== undefined && offeredItemIds !== undefined && offeredItemIds.length === offeredItems.length;
  const offeredIdSet = new Set<string>();
  const offeredBudget = new Map<string, number>();
  (offeredItems ?? []).forEach((offered, index) => {
    const offeredId = idsAligned ? offeredItemIds[index] : undefined;
    if (offeredId) {
      offeredIdSet.add(offeredId);
      return;
    }
    const key = normalizeChecklistItemTextV1(offered);
    offeredBudget.set(key, (offeredBudget.get(key) ?? 0) + 1);
  });
  const scopedTargets = offeredItems
    ? allTargets.filter((target) => {
        if (idsAligned && target.itemId) return offeredIdSet.has(target.itemId);
        const key = normalizeChecklistItemTextV1(target.text);
        const left = offeredBudget.get(key) ?? 0;
        if (left <= 0) return false;
        offeredBudget.set(key, left - 1);
        return true;
      })
    : allTargets;
  const planTextForIds = plan.text;
  const hashEntries = listPlanItemContentHashesV1(planTextForIds);
  const idEntries = listPlanItemIdsV1(planTextForIds);
  // The hash list and the id list walk the same rendering, so an index names the same item in both.
  const candidateEntries = scopedTargets.map((target) =>
    target.itemId && hashEntries.length === idEntries.length
      ? hashEntries[idEntries.findIndex((entry) => entry.itemId === target.itemId)]
      : undefined
  );
  const progressRead = await readTaskProgressStrictV1(folderUri);
  const evidenceRecords = progressRead.ok ? progressRead.decoded.progress.planItemEvidence ?? [] : [];
  const gated = await gateTestDependentItemsV1(
    scopedTargets.map((target) => target.text),
    evidenceRecords,
    plan.text,
    resolveWorkspaceRootForTaskV1(folderUri),
    progressRead.ok ? progressRead.decoded.progress.planItemOwnerTestRuns ?? [] : [],
    candidateEntries
  );
  const { accepted: applicable, testReportRoundIds: applicableTestReportRoundIds, withheld: withheldTestItems, withheldReasons } = gated;
  const applicableItemIds = gated.acceptedIndices.map((index) => scopedTargets[index]?.itemId);
  const applicableEvidence = gated.acceptedIndices.map((index) => scopedTargets[index]?.evidence);
  if (applicable.length === 0) {
    const alreadyAppliedCount = filterAlreadyCheckedPlanItemsV1(plan.text, offeredItems ?? namedTexts).length;
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
      applicableItemIds,
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
  // The issued id of each offered item (`null` for a text-only entry), recorded on the card so confirming it later
  // ticks exactly these items.
  const offeredItemIds = applicable.map((_, index) => derived.derivation.applicableItemIds?.[index] ?? null);
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

  // review1 Step 10: one checklist card per task. This card carries the reconcile card's actions (apply the
  // reviewer-verified ticks, settle the rest item by item, not yet), so a pending reconcile card is withdrawn.
  await withdrawWorkflowDecisionsByKeyV1(
    { taskFolderPath, canonicalId },
    "reconcilePlanChecklist",
    "superseded by the task's single checklist card (the reviewer-verified ticks card)"
  );

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
          // review1 Step 53: a monotonic tick merge (it can only tick items the review verified) then the stage's
          // next action; safe to run when the owner does not answer.
          unattendedSafe: true,
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
            args: [{ taskFolderPath, canonicalId, reviewStage, offeredItems: applicable, offeredItemIds, ...ffResume.extraArgs }],
          },
        },
        // review1 Step 10: this is the task's one checklist card. The rest of the open items are settled from here,
        // item by item, in the open-items form (read at choice time, minus the items "apply" ticks).
        {
          optionId: "settleRest",
          label: "Settle the other open items one by one",
          resumeKind: "unpause",
          consequence:
            "Shows a form in this chat with every other plan item that is still open, so you can tick or exclude " +
            `each one (the ${applicable.length} reviewer-verified item(s) above are left out; apply them with ` +
            "the first option). Nothing is ticked or run until you press Apply on that form.",
          effect: {
            kind: "command",
            command: SETTLE_REST_ITEM_BY_ITEM_COMMAND_V1,
            args: [
              {
                taskFolderPath,
                ...(displayName ? { displayName } : {}),
                stage: reviewStage,
                exceptItems: applicable,
                ...(ffResume.extraArgs.resumeFastForwardV1
                  ? { resumeFastForwardV1: ffResume.extraArgs.resumeFastForwardV1 }
                  : {}),
              },
            ],
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
  selected: VerifiedTicksDerivationV1
): Promise<WriteVerifiedTicksResultV1> {
  const { reviewStage: resolvedStage, reviewFilename } = selected;
  const freshPlan = await readPlanOfRecordV1(folderUri);
  if (!freshPlan.hasChecklist || !freshPlan.text) {
    return { kind: "noChecklist" };
  }
  const evidence = `verified by reviewer in ${resolvedStage} review (${reviewFilename})`;
  // Owner decision 2026-11-05 (item identity by design): an entry that carries the id of the exact item ticks that
  // item through an `item:<id>` claim, so a same-worded item is never ticked in its place. When the plan moved on
  // and that item is no longer open (ticked or excluded in the meantime, or reworded so its id is gone), the entry is
  // dropped: it never falls back to the item's wording, which could tick a still-open twin. The card is re-derived
  // from the review the next time instead.
  const freshIdEntries = listPlanItemIdsV1(freshPlan.text);
  const keptIndices = selected.applicable
    .map((_, index) => index)
    .filter((index) => {
      const itemId = selected.applicableItemIds?.[index];
      return itemId === undefined || freshIdEntries.some((entry) => entry.itemId === itemId && !entry.checked && !entry.excluded);
    });
  if (keptIndices.length === 0) {
    return { kind: "refused" };
  }
  const pick = <T>(values: readonly T[]): T[] => keptIndices.map((index) => values[index] as T);
  const derivation: VerifiedTicksDerivationV1 = {
    ...selected,
    applicable: pick(selected.applicable),
    applicableItemIds: selected.applicableItemIds ? pick(selected.applicableItemIds) : undefined,
    applicableEvidence: pick(selected.applicableEvidence),
    applicableTestReportRoundIds: pick(selected.applicableTestReportRoundIds),
  };
  const { applicable } = derivation;
  const claimTexts = applicable.map((itemText, index) => {
    const itemId = derivation.applicableItemIds?.[index];
    return itemId !== undefined ? `item:${itemId}` : itemText;
  });
  const synthetic = buildSyntheticVerifiedCompleteSummaryV1(claimTexts, evidence);
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
  const freshPlanText = freshPlan.text;
  const planRevision = getPlanRevisionV1(freshPlanText);
  const verifiedAt = new Date().toISOString();
  await patchTaskProgressStrictV1(folderUri, (progress) => {
    const currentRevision = prunePlanItemEvidenceForPlanV1(progress, freshPlanText);
    // review1 (review fix): record each verification for the exact item the merge ticked, at its own level and
    // copy, so a verification for a child never lands on a same-worded top-level item (or the reverse).
    const tickedItems = listItemsTickedBetweenV1(freshPlanText, merged.content);
    if (tickedItems !== undefined && tickedItems.length > 0) {
      const freshHashEntries = listPlanItemContentHashesV1(freshPlanText);
      const usedIndices = new Set<number>();
      // An entry whose claim went through `item:<id>` belongs to that id's item only, never to a wording match.
      const claimedById = (candidateIndex: number): boolean => claimTexts[candidateIndex]?.startsWith("item:") === true;
      return tickedItems.reduce((next, entry) => {
        // The entry that named this exact item by id wins; otherwise the first unused entry with its wording.
        const position = freshHashEntries.findIndex(
          (candidate) =>
            candidate.nested === entry.nested &&
            candidate.occurrence === entry.occurrence &&
            candidate.annotationFreeKey === entry.annotationFreeKey
        );
        const entryItemId = position >= 0 && freshHashEntries.length === freshIdEntries.length ? freshIdEntries[position]?.itemId : undefined;
        let index = entryItemId !== undefined ? (derivation.applicableItemIds ?? []).findIndex((id) => id === entryItemId) : -1;
        if (index < 0) {
          index = applicable.findIndex(
            (itemText, candidateIndex) =>
              !usedIndices.has(candidateIndex) &&
              !claimedById(candidateIndex) &&
              normalizeChecklistItemTextV1(stripPlanItemAnnotationsV1(itemText)) === entry.annotationFreeKey
          );
        }
        if (index < 0) return next;
        usedIndices.add(index);
        const testReportRoundIds = derivation.applicableTestReportRoundIds[index] ?? [];
        return recordPlanItemReviewerVerificationV1(next, {
          planRevision,
          planText: freshPlanText,
          itemText: entry.text,
          itemOccurrence: entry.occurrence,
          itemNested: entry.nested,
          at: verifiedAt,
          evidence: derivation.applicableEvidence[index] ?? `verified by reviewer in ${resolvedStage} review (${reviewFilename})`,
          ...(testReportRoundIds.length ? { testReportRoundIds } : {}),
        });
      }, currentRevision);
    }
    return applicable.reduce((next, itemText, index) => {
      const testReportRoundIds = derivation.applicableTestReportRoundIds[index] ?? [];
      return recordPlanItemReviewerVerificationV1(next, {
        planRevision,
        planText: freshPlanText,
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
  // review1 Step 8: the applied ticks changed the count; keep the settlement snapshot (and the tooltip note) current.
  await refreshPlanItemSettlementSnapshotV1(folderUri);
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
  const derived = await deriveApplicableVerifiedTicksV1(
    folderUri,
    reviewStage,
    normalized?.offeredItems,
    normalized?.offeredItemIds
  );
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
  const derived = await deriveApplicableVerifiedTicksV1(
    folderUri,
    reviewStage,
    normalized?.offeredItems,
    normalized?.offeredItemIds
  );
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
        itemIds: applicable.map((_, index) => derived.derivation.applicableItemIds?.[index] ?? null),
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

/** review1 Step 53 (owner, 2026-11-05): the Undo of an at-once tick, run from the notification's button. */
export const UNDO_REVIEWER_VERIFIED_TICKS_COMMAND_V1 = "vs-code-ai-helper.undoReviewerVerifiedTicks";

/** One plan line as it was before an at-once tick and as the tick wrote it. */
export interface TickLineRestoreV1 {
  readonly before: string;
  readonly after: string;
}

/**
 * The lines an at-once tick changed. The merge only edits lines in place; if the line count differs the
 * change is not a plain per-line tick and no exact undo can be offered (`undefined`).
 */
export function diffTickedLinesV1(before: string, after: string): TickLineRestoreV1[] | undefined {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length !== b.length) {
    return undefined;
  }
  const changed: TickLineRestoreV1[] = [];
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) {
      changed.push({ before: a[index]!, after: b[index]! });
    }
  }
  return changed;
}

/** The one chat line and notification for an at-once tick: the items, the review and its evidence per item. */
export function describeTicksAppliedAtOnceV1(derivation: VerifiedTicksDerivationV1): string {
  const parts = derivation.applicable.map((item, index) => {
    const evidence = derivation.applicableEvidence[index];
    return `${item} — ${evidence ?? "no evidence line in this review (older review format)"}`;
  });
  return `Ticked ${derivation.applicable.length === 1 ? "1 item" : `${derivation.applicable.length} items`} (verified by ${derivation.reviewFilename}): ${parts.join("; ")}`;
}

export type ApplyTicksAtOnceResultV1 =
  | { readonly kind: "applied"; readonly count: number; readonly undoable: boolean }
  | { readonly kind: "notApplied" };

/**
 * review1 Step 53 (owner, 2026-11-05): a review that names unticked plan items as verified complete has them
 * ticked as soon as it ends, with no card and no countdown. The merge is the same monotonic one "Apply the N
 * ticks now" uses, and test items without a valid report were already withheld by the derivation. One chat
 * line and one notification say what was ticked and why; the notification carries an Undo that restores exactly
 * those lines. Nothing is dispatched: a Fast Forward run goes on to its own next round, and without one the task
 * waits where it was.
 */
export async function applyVerifiedTicksAtOnceV1(
  folderUri: vscode.Uri,
  derivation: VerifiedTicksDerivationV1,
  taskLabel?: string
): Promise<ApplyTicksAtOnceResultV1> {
  const planBefore = (await readPlanOfRecordV1(folderUri)).text;
  const written = await writeVerifiedTicksToPlanV1(folderUri, derivation);
  if (written.kind !== "applied") {
    return { kind: "notApplied" };
  }
  const planAfter = (await readPlanOfRecordV1(folderUri)).text;
  const restores = planBefore !== undefined && planAfter !== undefined ? diffTickedLinesV1(planBefore, planAfter) : undefined;
  const undoable = restores !== undefined && restores.length > 0;
  const text = describeTicksAppliedAtOnceV1(derivation);
  await postTicksChatLineV1(folderUri.fsPath, derivation.reviewStage, text);
  NotificationRouter.showInformation(
    taskLabel ? `${taskLabel} — ${text}` : text,
    undefined,
    undefined,
    undefined,
    undoable
      ? {
          command: UNDO_REVIEWER_VERIFIED_TICKS_COMMAND_V1,
          title: "Undo",
          args: [{ taskFolderPath: folderUri.fsPath, restores, ...(taskLabel ? { taskLabel } : {}) }],
        }
      : undefined
  );
  return { kind: "applied", count: written.count, undoable };
}

/**
 * Undo of {@link applyVerifiedTicksAtOnceV1}: puts back exactly the lines the tick wrote. A line the owner has
 * edited since is left alone and reported; nothing else in the plan changes.
 */
export async function undoReviewerVerifiedTicksV1(arg?: {
  taskFolderPath?: string;
  restores?: readonly TickLineRestoreV1[];
  /** The task's quoted label, carried from the notification the Undo sits on. */
  taskLabel?: string;
}): Promise<{ restored: number; skipped: number }> {
  if (!arg?.taskFolderPath || !arg.restores || arg.restores.length === 0) {
    return { restored: 0, skipped: 0 };
  }
  const folderUri = vscode.Uri.file(arg.taskFolderPath);
  const taskLabel = arg.taskLabel ?? formatNotificationTaskLabelV1(undefined, arg.taskFolderPath);
  const plan = await readPlanOfRecordV1(folderUri);
  if (!plan.text) {
    NotificationRouter.showWarning(`${taskLabel} — The ticks could not be undone: plan-final.md was not found.`);
    return { restored: 0, skipped: arg.restores.length };
  }
  const lines = plan.text.split("\n");
  let restored = 0;
  for (const { before, after } of arg.restores) {
    const index = lines.indexOf(after);
    if (index === -1) {
      continue;
    }
    lines[index] = before;
    restored++;
  }
  const skipped = arg.restores.length - restored;
  if (restored > 0) {
    const written = await writeTextFileIfUnchangedV1(getCanonicalImplementationUri(folderUri), plan.text, lines.join("\n"));
    if (!written) {
      NotificationRouter.showWarning(`${taskLabel} — plan-final.md changed while the ticks were being undone, so nothing was written. Try Undo again.`);
      return { restored: 0, skipped: arg.restores.length };
    }
    await refreshPlanItemSettlementSnapshotV1(folderUri);
  }
  const text =
    skipped === 0
      ? `Undid the reviewer-verified tick${restored === 1 ? "" : "s"}: ${restored} line${restored === 1 ? "" : "s"} restored in plan-final.md.`
      : `Undid ${restored} of ${arg.restores.length} reviewer-verified ticks; ${skipped} line${skipped === 1 ? " was" : "s were"} edited since and left as they are.`;
  NotificationRouter.showInformation(`${taskLabel} — ${text}`);
  return { restored, skipped };
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
    const derived = await deriveApplicableVerifiedTicksV1(folderUri, decision.stage, answer.itemKeys, answer.itemIds);
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
    ),
    vscode.commands.registerCommand(UNDO_REVIEWER_VERIFIED_TICKS_COMMAND_V1, (arg?: {
      taskFolderPath?: string;
      restores?: readonly TickLineRestoreV1[];
    }) => undoReviewerVerifiedTicksV1(arg))
  );
}
