import * as vscode from "vscode";

import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import { STAGE_ARTIFACT_FILENAMES, type TaskStage } from "../types/taskProgress";
import { nextStageAfterV1 } from "../utils/automationStopV1";
import {
  buildEvidenceGapCardInputV1,
  identifyItemTestFilesDetailV1,
  isEvidenceOnlyGapV1,
  matchPassedOutputToItemsV1,
  TICK_EVIDENCE_GAP_ITEMS_COMMAND_V1,
  type EvidenceGapAttemptV1,
} from "../utils/evidenceGapV1";
import { readTextIfExists } from "../utils/fileUtils";
import { classifyEvidenceRunFailuresV1, type ClassifiedEvidenceRunFailureV1 } from "../utils/evidenceRunFailuresV1";
import type { FailingTestSummaryV1 } from "../utils/failingTestsV1";
import { listChangedFilesSinceShaV1, resolveGitRepo } from "../utils/gitRepoInfo";
import type { ItemTestFilesContextV1 } from "../utils/itemTestFilesV1";
import { readTaskImplementationBaselineShaV1 } from "../utils/taskImplementationBaselineV1";
import { buildTestFailuresV1, formatTestFailuresV1, writeTestFailuresFileV1, type TestFailureV1 } from "../utils/testFailuresV1";
import { buildItemTestFilesContextV1, scanKnownTestFilesV1, type RoundLedgerIdsV1 } from "./itemTestFilesContextV1";
import { getCanonicalImplementationUri } from "../utils/implementationArtifactResolver";
import {
  getPlanRevisionV1,
  listProvisionalTickedItemsV1,
  listUncheckedChecklistItemTextsV1,
  normalizeChecklistItemTextV1,
} from "../utils/implementationChecklist";
import { collectCompletionLintPreview } from "../utils/completionLint";
import { runWithAdmittedAutomaticDispatchV1 } from "../state/automationDispatchContextV1";
import type { admitAutomaticDispatchV1 } from "./automaticDispatchGateV1";
import {
  clearPublishChecksPassedFilesV1,
  recordPublishChecksPassedFilesV1,
  takePublishChecksPassedFilesV1,
} from "../utils/publishChecksPassedFilesV1";
import { parseReviewBlockersDetailed } from "../utils/reviewReadiness";
import type { EvidenceGapOutcomeV1 } from "../utils/reviewScoreLoop";
import { recordPlanItemTestReportV1 } from "../utils/taskProgressTransforms";
import { computeTestDependencyStatesV1 } from "../utils/testDependencyStateV1";
import { normalizePath } from "../utils/taskRoot";
import { postWorkflowDecisionV1 } from "../utils/workflowDecisionDispatchV1";
import { applyOwnerTickToProvisionalItemV1 } from "./settleChecklistItem";
import type { StageReadyOutcomeV1 } from "./automationStoppedCardV1";
import { appendChatMessageV1 } from "../utils/chatHistoryStore";

/** What the caller's one Publish Checks attempt did: it ran, or it could not (refused, cancelled, gate closed). */
export interface EvidenceGapChecksRunV1 {
  readonly ran: boolean;
  readonly detail?: string;
  /** bugs7 item 5: the failed checks of the run (command, output, failing tests), when it ran and did not pass. */
  readonly failedChecks?: readonly {
    readonly command: string;
    readonly output: string;
    readonly failingTests?: FailingTestSummaryV1;
    readonly quarantined?: boolean;
  }[];
  readonly runAt?: string;
}

/** The files the task changed (workspace-relative), from the task-start baseline; empty when git cannot say. */
export async function readTaskChangedFilesV1(folderUri: vscode.Uri, workspaceRootFsPath: string): Promise<string[]> {
  try {
    const baselineSha = await readTaskImplementationBaselineShaV1(folderUri);
    const repoRoot = await resolveGitRepo(workspaceRootFsPath);
    if (!baselineSha || !repoRoot) return [];
    return (await listChangedFilesSinceShaV1(repoRoot, baselineSha, workspaceRootFsPath)).files;
  } catch {
    return [];
  }
}

/** The failing tests of a failed run, classified against the task's changed files; saved for the next round to read. */
export async function describeEvidenceRunFailuresForTaskV1(input: {
  readonly folderUri: vscode.Uri;
  readonly workspaceRootFsPath: string;
  readonly run: EvidenceGapChecksRunV1;
  readonly readChangedFiles?: typeof readTaskChangedFilesV1;
}): Promise<ClassifiedEvidenceRunFailureV1[]> {
  const checks = input.run.failedChecks ?? [];
  const failures: TestFailureV1[] = [];
  const flakes: string[] = [];
  for (const check of checks) {
    const built = buildTestFailuresV1(check.output, check.failingTests);
    failures.push(...built);
    if (check.quarantined === true) for (const failure of built) flakes.push(failure.file ?? failure.name);
  }
  if (failures.length === 0) return [];
  const changedFiles = await (input.readChangedFiles ?? readTaskChangedFilesV1)(input.folderUri, input.workspaceRootFsPath);
  const classified = classifyEvidenceRunFailuresV1({ failures, changedFiles, knownFlakes: flakes });
  // The next Apply Review reads these (review1 Step 51's file), so "Fix the failing tests" has the failures in hand.
  await writeTestFailuresFileV1(
    input.folderUri.fsPath,
    formatTestFailuresV1(failures, { runAt: input.run.runAt ?? new Date().toISOString() })
  ).catch(() => undefined);
  return classified;
}

/**
 * review1 Step 34: the one Publish Checks attempt for an evidence-only gap at a review stage. `runPublishChecks`
 * refuses any stage but Publish and writes the Publish report, so this runs the same project verification underneath
 * it (`collectCompletionLintPreview`, the deterministic commands only: no model call, nothing written to
 * `publish-review.md` or the lint payload) and leaves the passing run's test files for the caller to read.
 * `gate` is Step 24's `admitAutomaticDispatchV1`; a refusal means the checks did not run.
 */
export async function runEvidenceGapChecksV1(input: {
  readonly folderUri: vscode.Uri;
  readonly stage: TaskStage;
  readonly displayName?: string;
  readonly token?: vscode.CancellationToken;
  readonly gate: typeof admitAutomaticDispatchV1;
  readonly runPreview?: typeof collectCompletionLintPreview;
}): Promise<EvidenceGapChecksRunV1> {
  const admission = await input.gate({
    taskFolderPath: input.folderUri.fsPath,
    kind: "fast-forward-publish-checks",
    stage: input.stage,
    ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
  });
  if (!admission.admitted) {
    return { ran: false, detail: "automation is waiting for your decision, so the checks were not started" };
  }
  try {
    const result = await runWithAdmittedAutomaticDispatchV1(() =>
      (input.runPreview ?? collectCompletionLintPreview)(input.folderUri, undefined, {
        allowScopePrompt: false,
        includeAiPlanVerification: false,
        ...(input.token !== undefined ? { token: input.token } : {}),
      })
    );
    recordPublishChecksPassedFilesV1(input.folderUri.fsPath, {
      runAt: result.runAt,
      passed: result.passedModuloKnownFlakes ?? result.passed,
      testFiles: result.passedTestFiles ?? [],
    });
    const failed = (result.failedChecks ?? []).map((check) => ({
      command: check.command,
      output: check.output,
      ...(check.failingTests !== undefined ? { failingTests: check.failingTests } : {}),
      quarantined: check.quarantine !== undefined,
    }));
    return { ran: true, runAt: result.runAt, ...(failed.length > 0 ? { failedChecks: failed } : {}) };
  } catch (error) {
    if (error instanceof vscode.CancellationError) throw error;
    return { ran: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * review1 Step 34: Fast Forward's answer to an evidence-only gap. Runs Publish Checks ONCE (through the caller's
 * `runChecks`, which is `runEvidenceGapChecksV1`: it passes the automatic-dispatch gate and runs the project's
 * deterministic verification through `collectCompletionLintPreview`, per the owner's step-34-checks-runner decision),
 * records a test-report row (source Publish Checks, with Step 15's hashes) for each provisional item whose test
 * files the passing output names, and raises one card for what is left. No Apply Review or Implementation round is
 * dispatched for the gap, and the caller never asks twice in a run.
 */
export async function closeEvidenceGapWithPublishChecksV1(input: {
  readonly folderUri: vscode.Uri;
  readonly workspaceRootFsPath: string;
  readonly stage: TaskStage;
  readonly displayName?: string;
  readonly score: number | null;
  readonly stopLevel: number;
  readonly runChecks: () => Promise<EvidenceGapChecksRunV1>;
}): Promise<EvidenceGapOutcomeV1> {
  const taskFolderPath = input.folderUri.fsPath;
  const planText = await readTextIfExists(getCanonicalImplementationUri(input.folderUri)).catch(() => undefined);
  const read = await readTaskProgressStrictV1(input.folderUri).catch(() => undefined);
  const reviewName = STAGE_ARTIFACT_FILENAMES[input.stage];
  const reviewText = reviewName ? await readTextIfExists(vscode.Uri.joinPath(input.folderUri, reviewName)).catch(() => undefined) : undefined;
  if (planText === undefined || !read || !read.ok || reviewText === undefined) return { kind: "not-applicable" };
  const progress = read.decoded.progress;
  const blockers = parseReviewBlockersDetailed(reviewText);
  const provisional = listProvisionalTickedItemsV1(planText, progress.planItemEvidence ?? [], progress.planItemOwnerDecisions ?? []);
  if (
    !isEvidenceOnlyGapV1({
      score: input.score,
      stopLevel: input.stopLevel,
      blockerCount: blockers.blockPresent ? blockers.blockers.length : null,
      uncheckedCount: listUncheckedChecklistItemTextsV1(planText, 1).total,
      provisional,
    })
  ) {
    return { kind: "not-applicable" };
  }

  clearPublishChecksPassedFilesV1(taskFolderPath);
  const run = await input.runChecks();
  const passedFiles = takePublishChecksPassedFilesV1(taskFolderPath);
  const attempt: EvidenceGapAttemptV1 = !run.ran ? "could-not-run" : passedFiles?.passed === true ? "passed" : "failed";

  let recordedCount = 0;
  let reasonByItem = new Map<string, string>();
  if (attempt === "passed" && passedFiles) {
    const recorded = await recordPublishChecksReportsForItemsV1({
      folderUri: input.folderUri,
      workspaceRootFsPath: input.workspaceRootFsPath,
      planText,
      progress,
      itemTexts: provisional.map((item) => item.text),
      passedTestFiles: passedFiles.testFiles,
    });
    recordedCount = recorded.recordedItems.length;
    reasonByItem = recorded.reasonByItem;
  }

  // What is left, with the passing runs now on record for each (a report with 0 failed).
  const fresh = await readTaskProgressStrictV1(input.folderUri).catch(() => undefined);
  const freshProgress = fresh && fresh.ok ? fresh.decoded.progress : progress;
  const remaining = listProvisionalTickedItemsV1(planText, freshProgress.planItemEvidence ?? [], freshProgress.planItemOwnerDecisions ?? []);
  if (remaining.length === 0) return { kind: "closed" };
  const items = remaining.map((item) => {
    const key = normalizeChecklistItemTextV1(item.text);
    const row = (freshProgress.planItemEvidence ?? []).find((entry) => entry.itemKey === key);
    const passingRuns = (row?.testReports ?? []).filter((report) => report.failed === 0 && report.passed > 0).length;
    const reason = reasonByItem.get(key);
    return { itemText: item.text, passingRuns, ...(reason !== undefined ? { reason } : {}) };
  });
  const nextStage = nextStageAfterV1(input.stage);
  const failures =
    attempt === "failed"
      ? await describeEvidenceRunFailuresForTaskV1({
          folderUri: input.folderUri,
          workspaceRootFsPath: input.workspaceRootFsPath,
          run,
        }).catch(() => [])
      : [];
  const card = buildEvidenceGapCardInputV1({
    taskFolderPath,
    stage: input.stage,
    attempt,
    ...(failures.length > 0 ? { failures } : {}),
    ...(run.detail !== undefined ? { attemptDetail: run.detail } : {}),
    score: input.score,
    items,
    recordedCount,
    ...(nextStage !== undefined ? { nextStage } : {}),
  });
  await postWorkflowDecisionV1(card, {
    canonicalId: normalizePath(taskFolderPath),
    taskFolderPath,
    stage: input.stage,
    taskName: input.displayName,
  }).catch(() => undefined);
  const count = items.length;
  const detail =
    attempt === "passed"
      ? `Publish Checks passed once; ${recordedCount} item${recordedCount === 1 ? "" : "s"} recorded from their output and ${count} still wait${count === 1 ? "s" : ""} for you to settle them`
      : attempt === "failed"
        ? `Publish Checks ran once and did not pass, so ${count} built item${count === 1 ? "" : "s"} still wait${count === 1 ? "s" : ""} for test evidence`
        : `Publish Checks could not run${run.detail ? ` (${run.detail})` : ""}, so ${count} built item${count === 1 ? "" : "s"} still wait${count === 1 ? "s" : ""} for test evidence`;
  return { kind: "stopped", detail };
}

/**
 * review1 Step 34: records a passing Publish Checks report (source `publishChecks`, with Step 15's hashes) for each
 * item whose test files the passing output names. An item whose test file cannot be identified, or is not named in
 * the output, is not recorded and gets the reason. Shared by Fast Forward's evidence-gap attempt and by the owner's
 * "Run Publish Checks now" on the withheld-evidence card.
 */
export async function recordPublishChecksReportsForItemsV1(input: {
  readonly folderUri: vscode.Uri;
  readonly workspaceRootFsPath: string;
  readonly planText: string;
  readonly progress: {
    readonly planItemEvidence?: readonly {
      readonly itemKey: string;
      readonly claims?: readonly { readonly roundId?: string; readonly evidence?: string }[];
      readonly verifications?: readonly { readonly roundId?: string }[];
      readonly testReports?: readonly { readonly testIdentity: string; readonly command: string; readonly roundId?: string }[];
    }[];
    readonly roundLedger?: readonly RoundLedgerIdsV1[];
  };
  readonly itemTexts: readonly string[];
  /** The passing output's test files; a member command's names are already qualified with its folder. */
  readonly passedTestFiles: readonly string[];
}): Promise<{ readonly recordedItems: readonly string[]; readonly reasonByItem: Map<string, string> }> {
  const reasonByItem = new Map<string, string>();
  // bugs7 item 1: one resolver for the item's test files; its rounds' changed test files come from their run records.
  const known = await scanKnownTestFilesV1(input.workspaceRootFsPath).catch(() => ({ files: [] as string[], capped: false }));
  const itemsWithFiles = await Promise.all(
    input.itemTexts.map(async (itemText) => {
      const row = (input.progress.planItemEvidence ?? []).find((entry) => entry.itemKey === normalizeChecklistItemTextV1(itemText));
      const rejectedCommands = (row?.testReports ?? []).slice(-5).map((report) => `${report.testIdentity} ${report.command}`);
      const itemContext = await buildItemTestFilesContextV1({
        workspaceRoot: input.workspaceRootFsPath,
        taskFolderPath: input.folderUri.fsPath,
        ...(row ? { evidenceRow: row } : {}),
        ...(input.progress.roundLedger ? { roundLedger: input.progress.roundLedger } : {}),
        known,
      }).catch(() => undefined);
      const claimEvidence = (row?.claims ?? []).map((claim) => claim.evidence ?? "").join(" ");
      const resolved = identifyItemTestFilesDetailV1(itemText, rejectedCommands, itemContext, claimEvidence);
      return { itemText, testFiles: resolved.files, ambiguous: resolved.ambiguous };
    })
  );
  const context: ItemTestFilesContextV1 = { knownTestFiles: known.files, knownFilesCapped: known.capped };
  const matched = matchPassedOutputToItemsV1(itemsWithFiles, input.passedTestFiles, context);
  for (const entry of matched.unidentified) reasonByItem.set(normalizeChecklistItemTextV1(entry.itemText), entry.reason);
  if (matched.recordable.length === 0) return { recordedItems: [], reasonByItem };
  const at = new Date().toISOString();
  const planRevision = getPlanRevisionV1(input.planText);
  const states = await Promise.all(
    matched.recordable.map((entry) => computeTestDependencyStatesV1(input.workspaceRootFsPath, entry.testFiles).catch(() => []))
  );
  const patched = await patchTaskProgressStrictV1(input.folderUri, (current) =>
    matched.recordable.reduce(
      (next, entry, index) =>
        recordPlanItemTestReportV1(next, {
          planRevision,
          planText: input.planText,
          itemText: entry.itemText,
          report: {
            at,
            roundId: `publish-checks-${at}`,
            testIdentity: entry.testFiles.join(", ").slice(0, 1000),
            command: "Publish Checks (passing run; test files named in its output)",
            workingDirectory: input.workspaceRootFsPath,
            // Counts the test files the output named; Publish Checks print no per-file test total here.
            passed: entry.testFiles.length,
            failed: 0,
            sourceState: "Publish Checks ran on the working tree as it stands now, after every edit of the round.",
            source: "publishChecks",
            ...((states[index]?.length ?? 0) > 0 ? { testDependencyStates: states[index] } : {}),
          },
        }),
      current
    )
  );
  return { recordedItems: patched ? matched.recordable.map((entry) => entry.itemText) : [], reasonByItem };
}

/**
 * bugs8 item 4 (Step 8): a tick that raised no "is done" card says why in the chat, with the click that carries on.
 * Nothing is written when the card was raised (or is already waiting): the card is the message.
 */
export async function sayWhyNoStageReadyCardV1(taskFolderPath: string, ready: StageReadyOutcomeV1): Promise<void> {
  if (ready.posted || ready.whyNot === undefined || ready.stage === undefined) return;
  await appendChatMessageV1(taskFolderPath, {
    role: "assistant",
    text: `Your tick is recorded. ${ready.whyNot}`,
    stage: ready.stage,
    at: new Date().toISOString(),
  }).catch(() => undefined);
}

/** `vs-code-ai-helper.tickEvidenceGapItems`: the stop card's "Tick these N items", recording the owner's tick for each. */
export function registerTickEvidenceGapItemsCommandV1(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      TICK_EVIDENCE_GAP_ITEMS_COMMAND_V1,
      async (arg?: { readonly taskFolderPath?: string; readonly itemTexts?: readonly string[] }): Promise<number> => {
        if (!arg?.taskFolderPath || !arg.itemTexts?.length) return 0;
        let recorded = 0;
        // The stage-ready check each tick starts (it raises the "is done" card when the stage is clean and settled).
        // The last one sees every tick, so its answer is the one the owner is told when no card was raised.
        let lastStageReady: Promise<StageReadyOutcomeV1> | undefined;
        for (const itemText of arg.itemTexts) {
          const outcome = await applyOwnerTickToProvisionalItemV1(arg.taskFolderPath, itemText);
          if (outcome.kind === "ownerTickRecorded") {
            recorded += 1;
            lastStageReady = outcome.stageReady ?? lastStageReady;
          }
        }
        if (recorded > 0 && lastStageReady !== undefined) {
          await sayWhyNoStageReadyCardV1(arg.taskFolderPath, await lastStageReady);
        }
        return recorded;
      }
    )
  );
}
