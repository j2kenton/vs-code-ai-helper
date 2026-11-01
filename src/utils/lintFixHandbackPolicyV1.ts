/**
 * bugs3 Step 15: what a Fix Linting & Code Errors round achieved, and which
 * next step can still change the outcome.
 *
 * A fix round that leaves checks failing used to hand back "Run Publish
 * Checks (Recommended)" — a re-run of an unchanged tree that spends the same
 * minutes to reproduce the same failures — with a summary ("passing: …; still
 * failing: pnpm run verify") that hid how much was still broken. This module
 * measures the round from the failing-test lists before and after it and
 * decides the recommendation in one place.
 *
 * A test that is absent from the "after" list passed only if its command ran
 * again; an omitted command's tests are reported as not re-run, and a runner
 * count that exceeds its list is reported as a count, never as named passes.
 */
import type { FailingTestSummaryV1 } from "./failingTestsV1";
import type { FixChainBlockKindV1 } from "./lintFixChainBlockV1";

interface FailedCheckLikeV1 {
  readonly command: string;
  readonly failingTests?: FailingTestSummaryV1;
}

export interface FixProgressV1 {
  /** Failing tests before the round, and after it, over the comparable checks only. */
  readonly before: number;
  readonly after: number;
  /** Tests that failed before and no longer do (never negative). A count of tests only when `exact`. */
  readonly fixed: number;
  /** Failing tests that were not failing before the round. Zero (unknown) unless `exact`. */
  readonly newlyFailing: number;
  /** Titles of the tests the round fixed, in the order first seen (all of them; callers cap). Empty unless `exact`. */
  readonly fixedTitles: readonly string[];
  /** The test file holding the most remaining failures. */
  readonly largestCluster?: { readonly file: string; readonly count: number };
  /**
   * True when every compared check listed all of its failing tests on both
   * sides, so the title diff names exactly which tests now pass. When false only
   * the runner's own totals are known: they say how many failures were counted,
   * not which tests ran or passed.
   */
  readonly exact: boolean;
  /**
   * Compared commands for which equivalent execution could not be established:
   * the baseline or the re-run did not record how many test runners and tests it
   * executed (an older record, or a re-run that passed and so left no output), so
   * equal or lower failure counts do not show the same tests ran. Their numbers are
   * counts only, never named fixes. Empty when every compared command was proven
   * comparable.
   */
  readonly coverageUnverified: readonly string[];
  /**
   * Checks that failed before the round with a test list but did not run again
   * afterwards. Their tests are neither fixed nor still failing: untested.
   */
  readonly notRerun: {
    readonly commands: readonly string[];
    readonly tests: number;
    /** The subset of `commands` that did run again but executed fewer test runners or tests than before. */
    readonly ranFewerTests?: readonly string[];
  };
}

/**
 * Whether the re-run executed less than the baseline did: fewer runner closing
 * summaries (an aggregate stopped before a later runner) or fewer tests in all
 * (a reduced script under the same command). Unknown on either side is not
 * "less": older records carry neither count.
 */
function ranLessThanBaselineV1(baseline: FailingTestSummaryV1, rerun: FailingTestSummaryV1): boolean {
  if (baseline.closingSummaries !== undefined && (rerun.closingSummaries ?? 0) < baseline.closingSummaries) {
    return true;
  }
  return (
    baseline.testsExecuted !== undefined && rerun.testsExecuted !== undefined && rerun.testsExecuted < baseline.testsExecuted
  );
}

/**
 * Whether the baseline and the re-run both recorded what they executed (runner
 * closing summaries and tests counted), so that "fewer failures" can be read as
 * fixes. A re-run with no failing-test record (it passed) or an older record
 * without the counts gives no such evidence: unknown is not "the same".
 */
function executionCoverageComparableV1(baseline: FailingTestSummaryV1, rerun: FailingTestSummaryV1 | undefined): boolean {
  return (
    rerun !== undefined &&
    baseline.closingSummaries !== undefined &&
    baseline.testsExecuted !== undefined &&
    rerun.closingSummaries !== undefined &&
    rerun.testsExecuted !== undefined &&
    // Every runner of the aggregate must have reached its closing summary, as the
    // baseline's did: a later runner that stopped before opening one adds no
    // summary block, so the completion of the blocks that exist proves nothing.
    rerun.runCompleted === true &&
    rerun.closingSummaries === baseline.closingSummaries &&
    // Equal or higher counts do not show the same tests ran (a replaced suite of
    // the same size, a runner swapped for another): only an identical set of
    // executed test titles does. Without it a lower failure count stays a count.
    baseline.executedDigest !== undefined &&
    rerun.executedDigest === baseline.executedDigest
  );
}

/** Below this share of the prior failures fixed, the round is "low yield". */
export const LOW_YIELD_SHARE_V1 = 0.25;

function identityOf(test: { readonly file?: string; readonly title: string }): string {
  return `${test.file ?? ""}\u0000${test.title}`;
}

type TestLike = { file?: string; title: string };

function addTests(into: Map<string, TestLike>, summary: FailingTestSummaryV1): void {
  for (const test of summary.tests) {
    into.set(identityOf(test), test);
  }
}

/**
 * Measures the round from the failing-test lists of the checks that failed
 * before it and the ones that fail after it.
 *
 * Only a command that failed before AND ran again is compared: a command absent
 * from `rerunCommandsRun` was omitted, and one that failed again with no
 * recognised failing test stopped before its test phase (an aggregate failing at
 * lint, say); either way its tests are reported as untested rather than passing. `rerunCommandsRun` undefined means the rerun's
 * coverage is unknown and no claim is made. Undefined is also returned when a
 * failing check on either side has no extracted test list, or when no
 * comparable test failed before.
 */
export function measureFixProgressV1(
  before: readonly FailedCheckLikeV1[],
  after: readonly FailedCheckLikeV1[],
  rerunCommandsRun: readonly string[] | undefined
): FixProgressV1 | undefined {
  if (rerunCommandsRun === undefined) {
    return undefined;
  }
  const ran = new Set(rerunCommandsRun);
  const afterByCommand = new Map<string, FailingTestSummaryV1>();
  for (const check of after) {
    if (check.failingTests === undefined) {
      return undefined;
    }
    afterByCommand.set(check.command, check.failingTests);
  }
  let beforeTotal = 0;
  let afterTotal = 0;
  let exact = true;
  const priorTests = new Map<string, TestLike>();
  const currentTests = new Map<string, TestLike>();
  const notRerunCommands: string[] = [];
  const ranLess: string[] = [];
  const unverified: string[] = [];
  let notRerunTests = 0;
  const compared = new Set<string>();
  for (const check of before) {
    if (check.failingTests === undefined) {
      return undefined;
    }
    if (compared.has(check.command) || notRerunCommands.includes(check.command)) {
      continue;
    }
    const rerun = afterByCommand.get(check.command);
    // A command that ran again and failed without the runner's closing summary
    // gives no evidence about the tests it did not get to: they are untested,
    // not fixed. That covers `verify` stopping at lint before its test phase
    // (no test output at all) and a run that crashed, timed out or was
    // aborted after printing some failures — the failures it listed are real,
    // but a test missing from the list may simply never have run.
    const stoppedBeforeTests = rerun !== undefined && rerun.runCompleted !== true;
    // The same command string does not mean the same tests ran. An aggregate
    // prints one closing summary per runner it reached, so a re-run with fewer of
    // them stopped before a later runner whose failures it cannot report; and a
    // re-run that executed fewer tests than the baseline did ran a reduced
    // suite, whose absent failures may simply not have run. Either way those
    // tests are untested, not fixed.
    const lessExecuted = rerun !== undefined && ranLessThanBaselineV1(check.failingTests, rerun);
    if (!ran.has(check.command) || stoppedBeforeTests || lessExecuted) {
      notRerunCommands.push(check.command);
      notRerunTests += check.failingTests.total;
      if (lessExecuted) {
        ranLess.push(check.command);
      }
      continue;
    }
    compared.add(check.command);
    if (!executionCoverageComparableV1(check.failingTests, rerun)) {
      unverified.push(check.command);
      exact = false;
    }
    beforeTotal += check.failingTests.total;
    // The baseline must also have run to its end: from a partial baseline the
    // title diff would name fixes against a list that was never complete.
    exact &&= check.failingTests.tests.length === check.failingTests.total && check.failingTests.runCompleted === true;
    addTests(priorTests, check.failingTests);
    // A command that ran again and is not among the failures passed.
    if (rerun !== undefined) {
      afterTotal += rerun.total;
      exact &&= rerun.tests.length === rerun.total;
      addTests(currentTests, rerun);
    }
  }
  // A command that fails now but did not fail before: all of it is new.
  for (const [command, summary] of afterByCommand) {
    if (!compared.has(command) && !notRerunCommands.includes(command)) {
      afterTotal += summary.total;
      exact &&= summary.tests.length === summary.total;
      addTests(currentTests, summary);
    }
  }
  if (beforeTotal === 0) {
    return undefined;
  }
  const fixedTitles: string[] = [];
  for (const [key, test] of priorTests) {
    if (!currentTests.has(key)) {
      fixedTitles.push(test.title);
    }
  }
  let newlyFailing = 0;
  for (const key of currentTests.keys()) {
    if (!priorTests.has(key)) {
      newlyFailing++;
    }
  }
  const perFile = new Map<string, number>();
  for (const test of currentTests.values()) {
    if (test.file) {
      perFile.set(test.file, (perFile.get(test.file) ?? 0) + 1);
    }
  }
  let largest: { file: string; count: number } | undefined;
  for (const [file, count] of perFile) {
    if (largest === undefined || count > largest.count) {
      largest = { file, count };
    }
  }
  return {
    before: beforeTotal,
    after: afterTotal,
    // Exact lists: the title diff names what now passes. Otherwise only the
    // change in the runner's count is known, never which tests ran or passed.
    fixed: exact ? fixedTitles.length : Math.max(0, beforeTotal - afterTotal),
    newlyFailing: exact ? newlyFailing : 0,
    fixedTitles: exact ? fixedTitles : [],
    exact,
    coverageUnverified: unverified,
    notRerun: { commands: notRerunCommands, tests: notRerunTests, ...(ranLess.length > 0 ? { ranFewerTests: ranLess } : {}) },
    ...(largest !== undefined && afterTotal > 0 ? { largestCluster: largest } : {}),
  };
}

/**
 * The re-run's per-command record: the commands that still fail, plus the
 * commands that PASSED with the execution they recorded (an empty failing list
 * and the runner counts). Without the passing side a command that went green
 * leaves no evidence of what it ran, so its fixes could only be reported as a
 * count.
 */
export function afterRoundChecksV1(
  failed: readonly FailedCheckLikeV1[],
  passedExecutions: ReadonlyArray<{ readonly command: string; readonly execution: FailingTestSummaryV1 }> | undefined
): FailedCheckLikeV1[] {
  const failedCommands = new Set(failed.map((check) => check.command));
  return [
    ...failed,
    ...(passedExecutions ?? [])
      .filter((entry) => !failedCommands.has(entry.command))
      .map((entry) => ({ command: entry.command, failingTests: entry.execution })),
  ];
}

/** "2 of 76 failing tests now pass; 74 still fail, 38 of them in x.test.js." */
export function describeFixProgressV1(progress: FixProgressV1): string {
  const cluster =
    progress.largestCluster !== undefined && progress.largestCluster.count > 1
      ? `, ${progress.largestCluster.count} of them in ${progress.largestCluster.file}`
      : "";
  let text: string;
  if (progress.exact) {
    text = `${progress.fixed} of ${progress.before} failing test${progress.before === 1 ? "" : "s"} now pass; ${progress.after} still fail${cluster}.`;
    if (progress.newlyFailing > 0) {
      text += ` ${progress.newlyFailing} test${progress.newlyFailing === 1 ? "" : "s"} that passed before now fail.`;
    }
    const shown = progress.fixedTitles.slice(0, 5);
    if (shown.length > 0) {
      text += ` Fixed: ${shown.join("; ")}${progress.fixedTitles.length > shown.length ? `; and ${progress.fixedTitles.length - shown.length} more` : ""}.`;
    }
  } else {
    // The runner counted more failures than it listed: the counts are real, but
    // which tests were fixed (and whether any new ones fail) is not known.
    text =
      `The runner counted ${progress.before} failing test${progress.before === 1 ? "" : "s"} before the round and ${progress.after} after it${cluster}, ` +
      "but did not list them all, so which tests were fixed is not known.";
  }
  if (progress.coverageUnverified.length > 0) {
    text +=
      ` For ${progress.coverageUnverified.join(", ")} it is not confirmed that the re-run executed the same tests as before ` +
      "(the earlier run or the re-run did not record how many tests it executed), so lower counts are not shown as fixed tests.";
  }
  if (progress.notRerun.commands.length > 0) {
    text +=
      ` ${progress.notRerun.tests} failing test${progress.notRerun.tests === 1 ? "" : "s"} in ` +
      `${progress.notRerun.commands.join(", ")} did not get re-tested (the command was not re-run, or stopped before its tests), so they are untested rather than passing.`;
    const reduced = progress.notRerun.ranFewerTests ?? [];
    if (reduced.length > 0) {
      text +=
        ` ${reduced.join(", ")} ran again but executed fewer test runners or tests than before, so the earlier failures it no longer ` +
        "lists may simply not have run.";
    }
  }
  return text;
}

/** One plain sentence naming a chain-level block, for the card's recommendation reason. */
export function describeFixChainBlockV1(kind: FixChainBlockKindV1): string {
  switch (kind) {
    case "quota":
      return "every enabled Publish model is out of quota";
    case "payment-required":
      return "the Publish model's account needs credits";
    case "auth":
      return "the Publish model needs a new sign-in";
  }
}

export type FixHandbackRecommendationV1 = "fixAgain" | "backToImplementation" | "chooseModel";

export interface FixHandbackDecisionV1 {
  readonly recommended: FixHandbackRecommendationV1;
  /** True when the round fixed too small a share (or made things worse). */
  readonly lowYield: boolean;
  /** Why this option, in the owner's words. */
  readonly reason: string;
}

/**
 * Chooses the recommendation after a fix round that left checks failing. Both
 * choices can change the outcome; "Run Publish Checks" is never recommended,
 * because nothing changed since the last run unless the owner changes it.
 *
 * - Progress unknown, or only a count change (the runner did not list every
 *   failing test): another fix round, which re-reads the current failures.
 * - A healthy share fixed: another fix round on the remainder.
 * - Only a small share fixed, nothing fixed, or tests newly failing: the
 *   failures look like unfinished or regressed work, so Back to Implementation
 *   (or a stronger Publish model chosen in AI Models) is recommended instead of
 *   the same round again.
 */
export function decideFixHandbackV1(
  progress: FixProgressV1 | undefined,
  chainBlock?: FixChainBlockKindV1
): FixHandbackDecisionV1 {
  if (chainBlock !== undefined) {
    // The round could not run at all, so its yield says nothing about the failures. Another fix
    // round, or a re-run of the checks, would meet the same unavailable chain.
    return {
      recommended: "chooseModel",
      lowYield: false,
      reason:
        `The fix round could not finish because ${describeFixChainBlockV1(chainBlock)}, so another round on the same models ` +
        "would fail the same way, and re-running Publish Checks would repeat the failing result. Choose a different Publish model, " +
        "then run Fix Linting & Code Errors again.",
    };
  }
  if (progress === undefined || !progress.exact) {
    return {
      recommended: "fixAgain",
      lowYield: false,
      reason: "Another fix round re-reads the current failures; re-running Publish Checks would only repeat this result.",
    };
  }
  const share = progress.before === 0 ? 0 : progress.fixed / progress.before;
  const regressed = progress.after > progress.before || progress.newlyFailing > progress.fixed;
  if (regressed || share < LOW_YIELD_SHARE_V1) {
    return {
      recommended: "backToImplementation",
      lowYield: true,
      reason:
        `This round fixed only ${progress.fixed} of ${progress.before} failing tests` +
        `${regressed ? " and left more failing than before" : ""}, so the same round again is unlikely to clear the rest. ` +
        "The failures look like unfinished or regressed plan work: go back to Implementation, or pick a stronger " +
        "Publish model in AI Models and run Fix Linting & Code Errors again.",
    };
  }
  return {
    recommended: "fixAgain",
    lowYield: false,
    reason: `This round made real progress (${progress.fixed} of ${progress.before} failing tests now pass); another fix round targets the remaining ${progress.after}.`,
  };
}

/**
 * bugs4 item 31: the hand-back for a Fix Linting & Code Errors run that was cancelled. When a check
 * run in this fix had already shown failing checks, the cancel leaves them failing and unverified,
 * so the card is the left-failing card (another fix round, or a model change), not "Run Publish
 * Checks" on a tree nobody re-checked. `leftFailing` is passed through to the card as-is.
 */
export function cancelledFixHandbackV1(
  detail: string,
  checksKnownFailing: boolean
): { readonly noticeText: string; readonly leftFailing: { readonly progress?: FixProgressV1 } | undefined } {
  if (checksKnownFailing) {
    return {
      noticeText: `Fix Linting & Code Errors was cancelled.${detail} The checks that failed before this run have not been re-verified.`,
      leftFailing: {},
    };
  }
  return {
    noticeText: `Fix Linting & Code Errors was cancelled.${detail} Review any retained edits, then run Publish Checks to verify the current workspace.`,
    leftFailing: undefined,
  };
}
