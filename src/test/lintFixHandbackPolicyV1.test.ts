/**
 * bugs3 Step 15: the lint-fix hand-back measures the round and recommends a
 * step that can change the outcome. The 76 -> 74 and 74 -> 68 sequences are the
 * reported bugs2 cases (2026-10-27). A test that is absent from the rerun's
 * failures is passing only when its command ran again.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FailingTestSummaryV1 } from "../utils/failingTestsV1";
import {
  afterRoundChecksV1,
  decideFixHandbackV1,
  describeFixProgressV1,
  measureFixProgressV1,
} from "../utils/lintFixHandbackPolicyV1";

const VERIFY = "pnpm run verify";

function failing(file: string, count: number, from = 0): FailingTestSummaryV1["tests"] {
  return Array.from({ length: count }, (_, index) => ({ file, title: `case ${from + index}` }));
}

function check(
  tests: FailingTestSummaryV1["tests"],
  total = tests.length,
  command = VERIFY
): { command: string; failingTests: FailingTestSummaryV1 } {
  // A real run that finished printed the runner's closing summary, with its counts.
  return { command, failingTests: { total, tests, runCompleted: true, closingSummaries: 1, testsExecuted: 1000, executedDigest: "same" } };
}

/** The rerun executed `pnpm run verify` unless a test says otherwise. */
function measure(
  before: Parameters<typeof measureFixProgressV1>[0],
  after: Parameters<typeof measureFixProgressV1>[1],
  ran: readonly string[] | undefined = [VERIFY]
): ReturnType<typeof measureFixProgressV1> {
  return measureFixProgressV1(before, after, ran);
}

/** 76 failing: 38 in one file, 38 spread over two others. */
const BEFORE_76 = [
  ...failing("out/test/deferredRoundRecovery.test.js", 38),
  ...failing("out/test/a.test.js", 20),
  ...failing("out/test/b.test.js", 18),
];

void describe("measureFixProgressV1 / describeFixProgressV1", () => {
  void it("76 -> 74: two fixed, the largest cluster is named", () => {
    const after = BEFORE_76.slice(2); // the first two (in the 38-test file) now pass
    const progress = measure([check(BEFORE_76)], [check(after)])!;
    assert.equal(progress.exact, true);
    assert.equal(progress.before, 76);
    assert.equal(progress.after, 74);
    assert.equal(progress.fixed, 2);
    assert.deepEqual(progress.fixedTitles, ["case 0", "case 1"]);
    assert.deepEqual(progress.largestCluster, { file: "out/test/deferredRoundRecovery.test.js", count: 36 });
    const text = describeFixProgressV1(progress);
    assert.match(text, /2 of 76 failing tests now pass; 74 still fail, 36 of them in out\/test\/deferredRoundRecovery\.test\.js/);
    assert.match(text, /Fixed: case 0; case 1\./);
  });

  void it("does not claim progress when a failing check has no extracted test list", () => {
    assert.equal(measure([check(BEFORE_76)], [{ command: VERIFY }]), undefined);
    assert.equal(measure([{ command: "pnpm run lint" }], [check(BEFORE_76)]), undefined);
    assert.equal(measure([], [check(BEFORE_76)]), undefined);
  });

  void it("does not claim progress when the rerun's executed commands are unknown", () => {
    assert.equal(measureFixProgressV1([check(BEFORE_76)], [check(BEFORE_76.slice(2))], undefined), undefined);
  });

  void it("reports tests that passed before and now fail", () => {
    const after = [...BEFORE_76.slice(4), ...failing("out/test/new.test.js", 1)];
    const progress = measure([check(BEFORE_76)], [check(after)])!;
    assert.equal(progress.newlyFailing, 1);
    assert.equal(progress.fixed, 4);
    assert.match(describeFixProgressV1(progress), /1 test that passed before now fail/);
  });

  void it("a runner total above its list is reported as a count, never as named passes", () => {
    const progress = measure([check(BEFORE_76.slice(0, 10), 76)], [check(BEFORE_76.slice(0, 10), 60)])!;
    assert.equal(progress.exact, false);
    assert.equal(progress.before, 76);
    assert.equal(progress.after, 60);
    assert.deepEqual(progress.fixedTitles, []);
    const text = describeFixProgressV1(progress);
    assert.match(text, /counted 76 failing tests before the round and 60 after it/);
    assert.match(text, /which tests were fixed is not known/);
    assert.doesNotMatch(text, /now pass/);
  });

  void it("a check that was omitted from the rerun is untested, not fixed", () => {
    // verify failed with 3 tests and lint-tests failed with 2; only verify ran again and still fails with 3.
    const verifyTests = failing("out/test/a.test.js", 3);
    const omittedTests = failing("out/test/b.test.js", 2);
    const progress = measure(
      [check(verifyTests), check(omittedTests, 2, "pnpm run other")],
      [check(verifyTests)]
    )!;
    assert.equal(progress.before, 3, "the omitted command is outside the comparison");
    assert.equal(progress.fixed, 0);
    assert.deepEqual(progress.fixedTitles, []);
    assert.deepEqual(progress.notRerun, { commands: ["pnpm run other"], tests: 2 });
    const text = describeFixProgressV1(progress);
    assert.match(text, /0 of 3 failing tests now pass; 3 still fail/);
    assert.match(text, /2 failing tests in pnpm run other did not get re-tested .*so they are untested rather than passing/);
  });

  void it("an aggregate that fails again before its test phase leaves its tests untested, not fixed", () => {
    // `pnpm run verify` stopped at lint: it failed, but with no test output at all.
    const before = failing("out/test/a.test.js", 2);
    const stopped = { command: VERIFY, failingTests: { total: 0, tests: [] } };
    // Nothing comparable ran, so no claim is made and no recommendation is driven by it.
    assert.equal(measure([check(before)], [stopped]), undefined);
    const mixed = measure(
      [check(before), check(failing("out/test/b.test.js", 3), 3, "pnpm run other")],
      [stopped, check(failing("out/test/b.test.js", 3), 3, "pnpm run other")],
      [VERIFY, "pnpm run other"]
    )!;
    assert.equal(mixed.fixed, 0, "the two verify tests are not reported as fixed");
    assert.deepEqual(mixed.fixedTitles, []);
    // The baseline recorded its closing summary and the stopped re-run printed none, so it also ran less.
    assert.deepEqual(mixed.notRerun, { commands: [VERIFY], tests: 2, ranFewerTests: [VERIFY] });
    assert.equal(mixed.before, 3);
    assert.match(describeFixProgressV1(mixed), /2 failing tests in pnpm run verify did not get re-tested/);
  });

  void it("a command that failed before and ran again but is not among the failures passed", () => {
    const progress = measure([check(failing("out/test/a.test.js", 4))], [])!;
    assert.equal(progress.fixed, 4);
    assert.equal(progress.after, 0);
    assert.equal(progress.largestCluster, undefined);
  });

  void it("only omitted commands failed before: nothing comparable, no claim", () => {
    assert.equal(measure([check(failing("out/test/a.test.js", 4))], [], ["pnpm run unrelated"]), undefined);
  });

  void it("a command that failed only after is all new failures", () => {
    const progress = measure(
      [check(failing("out/test/a.test.js", 4))],
      [check(failing("out/test/a.test.js", 4)), check(failing("out/test/c.test.js", 2), 2, "pnpm run lint")],
      [VERIFY, "pnpm run lint"]
    )!;
    assert.equal(progress.after, 6);
    assert.equal(progress.newlyFailing, 2);
  });

  void it("a rerun that listed some failures but ended before finishing its tests leaves the rest untested, not passing", () => {
    // 10 tests failed before; the rerun printed 3 of them and was killed.
    const before = failing("out/test/a.test.js", 10);
    const cutShort = { command: VERIFY, failingTests: { total: 3, tests: failing("out/test/a.test.js", 3) } };
    assert.equal(measure([check(before)], [cutShort]), undefined, "nothing comparable ran, so no claim is made");
    const mixed = measure(
      [check(before), check(failing("out/test/b.test.js", 4), 4, "pnpm run other")],
      [cutShort, check(failing("out/test/b.test.js", 3), 3, "pnpm run other")],
      [VERIFY, "pnpm run other"]
    )!;
    assert.equal(mixed.before, 4, "only the comparable command counts");
    assert.equal(mixed.fixed, 1);
    assert.deepEqual(mixed.notRerun, { commands: [VERIFY], tests: 10, ranFewerTests: [VERIFY] });
    const text = describeFixProgressV1(mixed);
    assert.match(text, /10 failing tests in pnpm run verify did not get re-tested/);
    assert.doesNotMatch(text, /7 .*now pass/, "the seven tests that never ran are not reported as passing");
  });

  void it("a baseline that never reached its closing summary is reported as counts, never as named fixes", () => {
    const partialBefore = { command: VERIFY, failingTests: { total: 4, tests: failing("out/test/a.test.js", 4) } };
    const progress = measure([partialBefore], [check(failing("out/test/a.test.js", 1))])!;
    assert.equal(progress.exact, false);
    assert.deepEqual(progress.fixedTitles, []);
  });
});

void describe("decideFixHandbackV1", () => {
  void it("a round that fixed 2 of 76 is low yield: recommend Back to Implementation, never the same round or a re-run", () => {
    const progress = measure([check(BEFORE_76)], [check(BEFORE_76.slice(2))])!;
    const decision = decideFixHandbackV1(progress);
    assert.equal(decision.recommended, "backToImplementation");
    assert.equal(decision.lowYield, true);
    assert.match(decision.reason, /only 2 of 76/);
    assert.match(decision.reason, /stronger Publish model/);
  });

  void it("a round that fixed a healthy share recommends another fix round on the remainder", () => {
    const decision = decideFixHandbackV1(measure([check(BEFORE_76)], [check(BEFORE_76.slice(40))]));
    assert.equal(decision.recommended, "fixAgain");
    assert.equal(decision.lowYield, false);
    assert.match(decision.reason, /40 of 76/);
  });

  void it("a round that left more failing than before is low yield", () => {
    const worse = [...BEFORE_76, ...failing("out/test/new.test.js", 5)];
    const decision = decideFixHandbackV1(measure([check(BEFORE_76)], [check(worse)]));
    assert.equal(decision.recommended, "backToImplementation");
    assert.match(decision.reason, /more failing than before/);
  });

  void it("a count-only change is not treated as measured yield", () => {
    // 76 -> 74 by totals alone would read as low yield; the lists are incomplete, so no judgement is made.
    const decision = decideFixHandbackV1(measure([check(BEFORE_76.slice(0, 10), 76)], [check(BEFORE_76.slice(0, 10), 74)]));
    assert.equal(decision.recommended, "fixAgain");
    assert.equal(decision.lowYield, false);
  });

  void it("unknown progress still never recommends re-running unchanged checks", () => {
    const decision = decideFixHandbackV1(undefined);
    assert.equal(decision.recommended, "fixAgain");
    assert.match(decision.reason, /only repeat this result/);
  });
});

/**
 * A command string is not an execution identity: `pnpm run verify` can run two
 * test runners one time and one the next, or a reduced script. The summaries
 * carry how many closing summaries and tests the output held.
 */
void describe("comparing what the re-run executed (bugs3 Step 15)", () => {
  function executed(
    tests: FailingTestSummaryV1["tests"],
    summaries: number | undefined,
    testsExecuted: number | undefined,
    digest: string | null = "same"
  ): { command: string; failingTests: FailingTestSummaryV1 } {
    return {
      command: VERIFY,
      failingTests: {
        total: tests.length,
        tests,
        runCompleted: true,
        ...(summaries !== undefined ? { closingSummaries: summaries } : {}),
        ...(testsExecuted !== undefined ? { testsExecuted } : {}),
        ...(summaries !== undefined && testsExecuted !== undefined && digest !== null ? { executedDigest: digest } : {}),
      },
    };
  }

  void it("equal counts over a different set of executed tests are not named as fixes", () => {
    const before = executed(failing("out/test/a.test.js", 3), 1, 5000, "suite-a");
    const after = executed(failing("out/test/a.test.js", 3).slice(1), 1, 5000, "suite-b");
    const progress = measure([before], [after])!;
    assert.equal(progress.exact, false);
    assert.deepEqual(progress.fixedTitles, []);
    assert.deepEqual(progress.coverageUnverified, [VERIFY]);
  });

  void it("a re-run with a different number of runner summaries is not verified even with an equal fingerprint", () => {
    const before = executed(failing("out/test/a.test.js", 3), 2, 5000, "same");
    const after = executed(failing("out/test/a.test.js", 3).slice(1), 3, 5100, "same");
    const progress = measure([before], [after])!;
    assert.deepEqual(progress.coverageUnverified, [VERIFY]);
    assert.deepEqual(progress.fixedTitles, []);
  });

  void it("a baseline without an executed-test fingerprint (older record) stays unverified", () => {
    const before = executed(failing("out/test/a.test.js", 3), 1, 5000, null);
    const after = executed(failing("out/test/a.test.js", 3).slice(1), 1, 5000);
    assert.deepEqual(measure([before], [after])!.coverageUnverified, [VERIFY]);
  });

  void it("an aggregate that stopped before its second runner leaves that runner's failures untested, not fixed", () => {
    // Baseline: the unit runner (2 failures) and the engine runner (1 failure). The re-run's unit runner
    // still fails, so the aggregate stopped there and the engine runner never ran.
    const before = executed([...failing("out/test/a.test.js", 2), ...failing("engine/b.test.js", 1)], 2, 4300);
    const after = executed(failing("out/test/a.test.js", 1), 1, 4200);
    const progress = measure([before], [after]);
    // The only failing command is not comparable, so no claim is made about it.
    assert.equal(progress, undefined);
  });

  void it("alongside a comparable command, the untested one is named and nothing of it counts as fixed", () => {
    const OTHER = "pnpm run other";
    const before = executed([...failing("out/test/a.test.js", 2), ...failing("engine/b.test.js", 1)], 2, 4300);
    const after = executed(failing("out/test/a.test.js", 1), 1, 4200);
    const progress = measure(
      [before, check(failing("out/test/c.test.js", 2), 2, OTHER)],
      [after, check(failing("out/test/c.test.js", 1), 1, OTHER)],
      [VERIFY, OTHER]
    )!;
    assert.deepEqual(progress.notRerun.commands, [VERIFY]);
    assert.deepEqual(progress.notRerun.ranFewerTests, [VERIFY]);
    assert.equal(progress.before, 2);
    assert.equal(progress.fixed, 1, "only the comparable command's fix counts");
    assert.match(describeFixProgressV1(progress), /executed fewer test runners or tests than before/);
  });

  void it("a reduced suite under the same command is not read as the missing failures being fixed", () => {
    const before = executed(failing("out/test/a.test.js", 4), 1, 5000);
    const after = executed(failing("out/test/a.test.js", 1), 1, 1200);
    assert.equal(measure([before], [after]), undefined);
    const withOther = measure(
      [before, check(failing("out/test/c.test.js", 1), 1, "pnpm run other")],
      [after, check([], 0, "pnpm run other")],
      [VERIFY, "pnpm run other"]
    );
    assert.deepEqual(withOther?.notRerun.ranFewerTests, [VERIFY]);
    assert.equal(withOther?.fixed, 1);
  });

  void it("compares normally when the re-run executed as much or more", () => {
    const before = executed(failing("out/test/a.test.js", 4), 2, 5000);
    const after = executed(failing("out/test/a.test.js", 1), 2, 5100);
    const progress = measure([before], [after])!;
    assert.equal(progress.fixed, 3);
    assert.equal(progress.notRerun.ranFewerTests, undefined);
  });

  void it("older records without the counts are never called reduced, but their lower counts are not named fixes", () => {
    const before = executed(failing("out/test/a.test.js", 4), undefined, undefined);
    const after = executed(failing("out/test/a.test.js", 1), 1, 100);
    const progress = measure([before], [after])!;
    assert.equal(progress.notRerun.ranFewerTests, undefined);
    assert.equal(progress.exact, false, "equivalent execution is unknown, so no test is named as fixed");
    assert.deepEqual(progress.fixedTitles, []);
    assert.deepEqual(progress.coverageUnverified, [VERIFY]);
    assert.match(describeFixProgressV1(progress), /not confirmed that the re-run executed the same tests/);
    assert.equal(decideFixHandbackV1(progress).lowYield, false, "no yield judgement from unverified coverage");
  });

  void it("a re-run that passed leaves no execution record, so its fixes are counts, not named tests", () => {
    const before = executed(failing("out/test/a.test.js", 4), 1, 5000);
    const progress = measure([before], [])!;
    assert.equal(progress.exact, false);
    assert.deepEqual(progress.fixedTitles, []);
    assert.deepEqual(progress.coverageUnverified, [VERIFY]);
  });

  void it("equal executed counts with fewer failures stay comparable and exact", () => {
    const before = executed(failing("out/test/a.test.js", 3), 1, 5000);
    const after = executed(failing("out/test/a.test.js", 3).slice(1), 1, 5000);
    const progress = measure([before], [after])!;
    assert.equal(progress.exact, true);
    assert.deepEqual(progress.coverageUnverified, []);
    assert.equal(progress.fixed, 1);
  });
});

void describe("a command that passed after the round leaves its execution record (bugs3 Step 15)", () => {
  const passedExecution: FailingTestSummaryV1 = {
    total: 0,
    tests: [],
    runCompleted: true,
    closingSummaries: 1,
    testsExecuted: 1000,
    executedDigest: "same",
  };

  void it("names the fixed tests when the command went green and recorded what it ran", () => {
    const before = [check(failing("out/test/a.test.js", 3))];
    const after = afterRoundChecksV1([], [{ command: VERIFY, execution: passedExecution }]);
    const progress = measure(before, after)!;
    assert.equal(progress.exact, true);
    assert.equal(progress.fixed, 3);
    assert.deepEqual(progress.fixedTitles, ["case 0", "case 1", "case 2"]);
    assert.deepEqual(progress.coverageUnverified, []);
  });

  void it("without the passing record the fixes are only a count", () => {
    const progress = measure([check(failing("out/test/a.test.js", 3))], afterRoundChecksV1([], undefined))!;
    assert.equal(progress.exact, false);
    assert.equal(progress.fixed, 3);
    assert.deepEqual(progress.fixedTitles, []);
  });

  void it("a green command that ran fewer tests than before is not read as fixing the rest", () => {
    const reduced = { ...passedExecution, testsExecuted: 10, executedDigest: "other" };
    // The only failing command ran a reduced suite, so nothing is comparable: no progress claim at all.
    const progress = measure(
      [check(failing("out/test/a.test.js", 3))],
      afterRoundChecksV1([], [{ command: VERIFY, execution: reduced }])
    );
    assert.equal(progress, undefined);
    // With a second, comparable command the reduced one is reported as untested, never as fixed.
    const OTHER = "pnpm run other";
    const mixed = measure(
      [check(failing("out/test/a.test.js", 3)), check(failing("out/test/b.test.js", 2), 2, OTHER)],
      afterRoundChecksV1([], [
        { command: VERIFY, execution: reduced },
        { command: OTHER, execution: passedExecution },
      ]),
      [VERIFY, OTHER]
    )!;
    assert.deepEqual(mixed.notRerun.ranFewerTests, [VERIFY]);
    assert.equal(mixed.fixed, 2);
  });

  void it("a command that still fails keeps its failure list rather than the passing record", () => {
    const stillFailing = check(failing("out/test/a.test.js", 2));
    const after = afterRoundChecksV1([stillFailing], [{ command: VERIFY, execution: passedExecution }]);
    assert.equal(after.length, 1);
    assert.equal(after[0]?.failingTests?.total, 2);
  });
});
