import type { WorkflowDecisionOptionV1, WorkflowDecisionRecommendationV1 } from "../types/workflowDecisionV1";
import type { PostWorkflowDecisionInputV1 } from "./workflowDecisionDispatchV1";
import { STAGE_DISPLAY_NAMES, type TaskStage } from "../types/taskProgress";
import { normalizePath } from "./taskRoot";
import { describeEvidenceRunFailuresV1, type ClassifiedEvidenceRunFailureV1 } from "./evidenceRunFailuresV1";
import { extractTestFileTokensV1 } from "./testDependencyStateV1";
import {
  ambiguousTestNameReasonV1,
  commandCoversTestFileV1,
  resolveItemTestFilesV1,
  type AmbiguousTestNameV1,
  type ItemTestFilesContextV1,
  type ResolvedItemTestFilesV1,
} from "./itemTestFilesV1";

/**
 * review1 Step 34: the evidence-only gap. A review meets the stop level with no blockers and the only plan items
 * left are built items waiting for a passing test report. No editing round can close that gap (review1 item 1 and
 * bugs6 item 11 looped on polish edits and re-run tests), so Fast Forward runs Publish Checks once, records the
 * items whose test files the passing output names, and asks the owner about the rest.
 */

export const EVIDENCE_GAP_DECISION_KEY_V1 = "automationStopped";
export const TICK_EVIDENCE_GAP_ITEMS_COMMAND_V1 = "vs-code-ai-helper.tickEvidenceGapItems";

export interface EvidenceGapProvisionalItemV1 {
  readonly text: string;
  readonly testDependent: boolean;
}

/** True when a review at the stop level with no blockers leaves only provisional, test-dependent items. */
export function isEvidenceOnlyGapV1(input: {
  readonly score: number | null;
  readonly stopLevel: number;
  /** Blockers of any kind in the latest review; null when the review carried no parsable blocker block. */
  readonly blockerCount: number | null;
  readonly uncheckedCount: number;
  readonly provisional: readonly EvidenceGapProvisionalItemV1[];
}): boolean {
  if (input.score === null || input.score < input.stopLevel) return false;
  if (input.blockerCount !== 0) return false;
  if (input.uncheckedCount > 0 || input.provisional.length === 0) return false;
  return input.provisional.every((item) => item.testDependent);
}

/** A comparison key for a test file however the runner or the item spells it (`out/test/a.test.js` = `src/test/a.test.ts`). */
export function testFileKeyV1(file: string): string {
  const base = file.replace(/\\/g, "/").split("/").pop() ?? file;
  return base.replace(/\.(?:[cm]?[jt]sx?)$/i, "").toLowerCase();
}

/**
 * bugs7 item 1: the item's test files, from the one resolver the claim matcher also uses: the files its text names,
 * else the files its claim's evidence names, else the test files its rounds changed, else its rejected reports'
 * commands. Without `context` only names with a `.test.`/`.spec.` suffix count.
 */
export function identifyItemTestFilesDetailV1(
  itemText: string,
  rejectedReportTexts: readonly string[],
  context?: ItemTestFilesContextV1,
  evidenceText?: string
): ResolvedItemTestFilesV1 {
  return resolveItemTestFilesV1({
    itemText,
    rejectedReportTexts,
    ...(evidenceText !== undefined ? { evidenceText } : {}),
    ...(context ? { context } : {}),
  });
}

export function identifyItemTestFilesV1(
  itemText: string,
  rejectedReportTexts: readonly string[],
  context?: ItemTestFilesContextV1,
  evidenceText?: string
): string[] {
  return [...identifyItemTestFilesDetailV1(itemText, rejectedReportTexts, context, evidenceText).files];
}

export interface EvidenceGapMatchV1 {
  readonly recordable: readonly { readonly itemText: string; readonly testFiles: readonly string[] }[];
  readonly unidentified: readonly { readonly itemText: string; readonly reason: string }[];
}

/**
 * Splits the items into those a passing run can be recorded for (every test file the item resolves to is covered by
 * the output's file list, by file identity: two files that only share a stem are not one test) and those left
 * provisional, each with the reason. An item whose name fits several known files is listed with that reason.
 */
export function matchPassedOutputToItemsV1(
  items: readonly {
    readonly itemText: string;
    readonly testFiles: readonly string[];
    readonly ambiguous?: readonly AmbiguousTestNameV1[];
  }[],
  passedTestFiles: readonly string[],
  context?: ItemTestFilesContextV1
): EvidenceGapMatchV1 {
  const recordable: { itemText: string; testFiles: readonly string[] }[] = [];
  const unidentified: { itemText: string; reason: string }[] = [];
  for (const item of items) {
    if (item.testFiles.length === 0) {
      unidentified.push({
        itemText: item.itemText,
        reason: item.ambiguous && item.ambiguous.length > 0 ? ambiguousTestNameReasonV1(item.ambiguous) : "no test file could be identified for it",
      });
      continue;
    }
    const missing = item.testFiles.filter((file) => !commandCoversTestFileV1(passedTestFiles, file, context));
    if (missing.length > 0) {
      unidentified.push({ itemText: item.itemText, reason: `the passing output does not name ${missing.map((f) => `\`${f}\``).join(", ")}` });
    } else {
      recordable.push(item);
    }
  }
  return { recordable, unidentified };
}

/** The test files a run's output names, as written, bounded. */
export function extractPassedTestFilesFromOutputV1(output: string, max = 300): string[] {
  return extractTestFileTokensV1(output).slice(0, max);
}

export type EvidenceGapAttemptV1 = "passed" | "failed" | "could-not-run";

export interface EvidenceGapCardFactsV1 {
  readonly taskFolderPath: string;
  readonly stage: TaskStage;
  readonly attempt: EvidenceGapAttemptV1;
  /** Why the attempt did not produce a pass (checks failed, refused, cancelled), when known. */
  readonly attemptDetail?: string;
  readonly score: number | null;
  /** Items still provisional, with the passing runs on record for each (a report with 0 failed). */
  readonly items: readonly { readonly itemText: string; readonly passingRuns: number; readonly reason?: string }[];
  readonly recordedCount: number;
  readonly planItems?: { readonly total: number; readonly settled: number };
  readonly nextStage?: TaskStage;
  /** bugs7 item 5: the failing tests of a failed run, each classified against the task's changed files. */
  readonly failures?: readonly ClassifiedEvidenceRunFailureV1[];
}

export type EvidenceGapRecommendationV1 = "tickThese" | "runChecksAgain" | "recordRun" | "fixFailingTests" | "none";

export const FIX_FAILING_TESTS_OPTION_ID_V1 = "fixFailingTests";

/**
 * After a failed run, the suite fails: ticking and recording a run are never recommended. A failure that touches the
 * task's changes is the task's own breakage, and a round fixes it; only failures on the known-flake record recommend
 * running again; anything else is not recommended either way, because Ensemble cannot tell whether the task caused it.
 * Otherwise: tick when every listed item has a passing run on record, rerun if the attempt could not run, else record a run.
 */
export function recommendEvidenceGapOptionV1(facts: EvidenceGapCardFactsV1): EvidenceGapRecommendationV1 {
  if (facts.attempt === "failed") {
    const failures = facts.failures ?? [];
    if (failures.some((failure) => failure.classification === "touches-task")) return "fixFailingTests";
    if (failures.length > 0 && failures.every((failure) => failure.classification === "probable-flake")) return "runChecksAgain";
    return "none";
  }
  if (facts.items.length > 0 && facts.items.every((item) => item.passingRuns > 0)) return "tickThese";
  if (facts.attempt === "could-not-run") return "runChecksAgain";
  return "recordRun";
}

const shorten = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

export function buildEvidenceGapCardInputV1(facts: EvidenceGapCardFactsV1): Omit<PostWorkflowDecisionInputV1, "createdAt"> {
  const stageName = STAGE_DISPLAY_NAMES[facts.stage] ?? facts.stage;
  const nextStageName = facts.nextStage !== undefined ? STAGE_DISPLAY_NAMES[facts.nextStage] : undefined;
  const taskArg = { taskFolderPath: facts.taskFolderPath };
  const count = facts.items.length;
  const failures = facts.attempt === "failed" ? facts.failures ?? [] : [];
  const attemptLine =
    facts.attempt === "passed"
      ? `Publish Checks ran once and passed${facts.recordedCount > 0 ? `, and ${facts.recordedCount} item${facts.recordedCount === 1 ? " was" : "s were"} recorded from their output` : ""}, but ${count} item${count === 1 ? "" : "s"} could not be matched to a test file in it.`
      : facts.attempt === "failed"
        ? `Publish Checks ran once and failed${facts.attemptDetail ? ` (${shorten(facts.attemptDetail, 200)})` : ""}, so nothing was recorded. The suite is failing, so a recorded run or a tick would not settle these items yet.` +
          (failures.length > 0 ? `\nFailing tests:\n${describeEvidenceRunFailuresV1(failures).join("\n")}` : "")
        : `Publish Checks could not run${facts.attemptDetail ? `: ${shorten(facts.attemptDetail, 200)}` : ""}.`;
  const lines = [
    `Automation stopped on ${stageName}: the review is clean${typeof facts.score === "number" ? ` (${facts.score}/10)` : ""} and only test evidence is missing for ${count} built plan item${count === 1 ? "" : "s"}.`,
    failures.length > 0
      ? "No editing round was dispatched for the missing evidence itself, because another round cannot produce a test report that counts; a failing test is different, and a round can fix it."
      : "No editing round was dispatched for it, because another round cannot produce a test report that counts.",
    attemptLine,
    ...facts.items.slice(0, 8).map(
      (item) => `- ${shorten(item.itemText, 140)} (${item.passingRuns > 0 ? `${item.passingRuns} passing run${item.passingRuns === 1 ? "" : "s"} on record` : "no passing run on record"}${item.reason ? `; ${item.reason}` : ""})`
    ),
    count > 8 ? `…and ${count - 8} more.` : undefined,
  ].filter((line): line is string => line !== undefined);

  const options: WorkflowDecisionOptionV1[] = [
    {
      optionId: "tickThese",
      label: count === 1 ? "I've checked it, tick it now" : "I've checked them, tick them now",
      consequence: `Ensemble records your tick for ${count === 1 ? "this item" : "these items"} now, as the person who accepts the passing runs on record. The plan lines are not changed, and the next review sees your tick.`,
      resumeKind: "continue",
      effect: { kind: "command", command: TICK_EVIDENCE_GAP_ITEMS_COMMAND_V1, args: [{ ...taskArg, itemTexts: facts.items.map((item) => item.itemText) }] },
      recordedNext: "your ticks are recorded",
    },
    {
      optionId: "runChecksAgain",
      label: "Run Publish Checks again",
      consequence: "Runs the project's Publish Checks once more, now and in this window. Nothing else is dispatched.",
      resumeKind: "continue",
      effect: { kind: "command", command: "vs-code-ai-helper.runPublishChecks", args: [taskArg] },
      recordedNext: "Publish Checks run",
    },
    {
      optionId: "recordRun",
      label: "Record a run I did",
      consequence: "Opens the form for a test run you did yourself (the command, whether it passed). A passing run counts for the items you choose.",
      resumeKind: "continue",
      effect: {
        kind: "command",
        command: "vs-code-ai-helper.postOwnerTestRunCard",
        args: [{ ...taskArg, stage: facts.stage, itemTexts: facts.items.map((item) => item.itemText) }],
      },
      recordedNext: "the test-run form is open",
    },
  ];
  if (failures.length > 0) {
    options.unshift({
      // A literal (the same text as FIX_FAILING_TESTS_OPTION_ID_V1) so the decision-option inventory sees this option.
      optionId: "fixFailingTests",
      label: "Fix the failing tests",
      consequence:
        "Runs one Apply Review round that is given the failing tests above (name, assertion, file and line), then re-reviews. " +
        "Nothing is ticked or recorded for you.",
      resumeKind: "continue",
      effect: { kind: "command", command: "vs-code-ai-helper.resumeAndApplyCurrentStageAction", args: [taskArg] },
      recordedNext: "an Apply Review round runs on the failing tests, then the review",
    });
  }
  if (nextStageName !== undefined) {
    options.push({
      optionId: "moveOn",
      label: `Move on to ${nextStageName}`,
      consequence:
        `Advances to ${nextStageName} with ${count} plan item${count === 1 ? "" : "s"} still counted as provisional (built, but no passing test report counted). ` +
        (facts.attempt === "failed"
          ? "The test suite is failing, and moving on carries the failing tests with it. "
          : "") +
        "Publish Checks run every test before Commit & Push.",
      resumeKind: "continue",
      effect: { kind: "command", command: "vs-code-ai-helper.nextStage", args: [taskArg] },
      recordedNext: `${nextStageName} starts`,
    });
  }
  const recommended = recommendEvidenceGapOptionV1(facts);
  const reasoning: Record<EvidenceGapRecommendationV1, string> = {
    tickThese: "Every item listed has a passing run on record, so ticking them settles the evidence gap without another run.",
    runChecksAgain: "The last attempt could not run, so nothing has been tried yet.",
    recordRun: "Publish Checks did not give evidence for these items, so a run you did is the way to settle them.",
    fixFailingTests: "A failing test touches this task's own changes, so the task most likely broke it; one round can fix it, and the suite has to pass before any run or tick counts.",
    none: "Ensemble cannot tell whether this task caused the failing tests. Fixing them and running the checks again are both open; the choice is yours, and a recorded run or a tick is not recommended while the suite fails.",
  };
  const recommendation: WorkflowDecisionRecommendationV1 =
    recommended === "none"
      ? { kind: "none", reasoning: reasoning.none }
      : { kind: "option", optionId: recommended, reasoning: reasoning[recommended] };
  return {
    decisionKey: EVIDENCE_GAP_DECISION_KEY_V1,
    taskCanonicalId: normalizePath(facts.taskFolderPath),
    stage: facts.stage,
    whatHappened: lines.join("\n"),
    whyUserNeeded: "Only test evidence is missing, and no further editing round can supply it. How to settle it is your call.",
    options,
    recommendation,
    gating: { holdsTaskPaused: false, unblocksProgress: true, detail: "Settle the missing test evidence" },
  };
}
