/**
 * bugs3 standing blocker: fix-progress reporting must not call unexecuted
 * tests passing. A failing-test list carries `runCompleted` only when the
 * runner printed its closing summary, so a rerun cut short after printing some
 * failures is recognised as incomplete.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractFailingTestsV1 } from "../utils/failingTestsV1";

const SPEC_FAILURES = ["▶ suite", "  ✖ first failing test (12ms)", "  ✔ passing test (5ms)", "✖ suite (20ms)"];

void describe("failing-test run completion", () => {
  void it("marks a run complete only when the runner's closing summary was printed", () => {
    const complete = extractFailingTestsV1(
      [...SPEC_FAILURES, "ℹ tests 3", "ℹ pass 2", "ℹ fail 1", "ℹ cancelled 0"].join("\n")
    );
    assert.equal(complete.runCompleted, true);
    assert.equal(complete.tests.length, 1);
  });

  void it("does not mark output cut off after some failures as complete", () => {
    const cutShort = extractFailingTestsV1(SPEC_FAILURES.join("\n"));
    assert.equal(cutShort.runCompleted, undefined);
    assert.equal(cutShort.tests.length, 1, "the failures that were printed are still listed");
  });

  void it("does not mark a run with cancelled tests as complete", () => {
    const cancelled = extractFailingTestsV1(
      [...SPEC_FAILURES, "ℹ tests 5", "ℹ pass 2", "ℹ fail 1", "ℹ cancelled 2"].join("\n")
    );
    assert.equal(cancelled.runCompleted, undefined);
  });

  void it("reads the TAP closing summary as well", () => {
    const tap = extractFailingTestsV1(["not ok 1 - broken", "# tests 2", "# pass 1", "# fail 1"].join("\n"));
    assert.equal(tap.runCompleted, true);
  });
});

void describe("closing summaries are counted per runner (bugs3 Step 15)", () => {
  const summary = (tests: number, fail: number): string =>
    [`ℹ tests ${tests}`, "ℹ suites 1", `ℹ pass ${tests - fail}`, `ℹ fail ${fail}`, "ℹ cancelled 0", "ℹ skipped 0"].join("\n");

  void it("counts one closing summary and its tests for a single runner", () => {
    const result = extractFailingTestsV1(`✖ x (1ms)\n${summary(40, 1)}`);
    assert.equal(result.closingSummaries, 1);
    assert.equal(result.testsExecuted, 40);
  });

  void it("counts each runner an aggregate reached, and adds their tests", () => {
    const result = extractFailingTestsV1(`${summary(40, 1)}\n--- next runner ---\n${summary(10, 0)}`);
    assert.equal(result.closingSummaries, 2);
    assert.equal(result.testsExecuted, 50);
  });

  void it("an earlier runner's complete summary does not hide a later runner cut off mid-summary", () => {
    const result = extractFailingTestsV1(`✖ x (1ms)\n${summary(40, 1)}\n--- next runner ---\nℹ tests 10\nℹ suites 1`);
    assert.equal(result.closingSummaries, 2);
    assert.equal(result.runCompleted, undefined, "the second block never reached pass/fail");
  });

  void it("a cancelled count in any runner's block keeps the aggregate incomplete", () => {
    const cancelledSecond = ["ℹ tests 10", "ℹ pass 5", "ℹ fail 0", "ℹ cancelled 5"].join("\n");
    const result = extractFailingTestsV1(`✖ x (1ms)\n${summary(40, 1)}\n${cancelledSecond}`);
    assert.equal(result.runCompleted, undefined);
  });

  void it("records nothing when the output held no closing summary", () => {
    const result = extractFailingTestsV1("✖ x (1ms)\nsomething else");
    assert.equal(result.closingSummaries, undefined);
    assert.equal(result.testsExecuted, undefined);
  });
});

void describe("executed-test fingerprint (bugs3 Step 15)", () => {
  const closing = ["ℹ tests 3", "ℹ pass 2", "ℹ fail 1", "ℹ cancelled 0"];

  void it("is the same when a failing test later passes, with different durations", () => {
    const failed = extractFailingTestsV1(["▶ suite", "  ✖ one (12ms)", "  ✔ two (5ms)", "  ✔ three (1ms)", ...closing].join("\n"));
    const passed = extractFailingTestsV1(["▶ suite", "  ✔ three (9ms)", "  ✔ one (2ms)", "  ✔ two (8ms)", ...closing].join("\n"));
    assert.ok(failed.executedDigest);
    assert.equal(failed.executedDigest, passed.executedDigest);
  });

  void it("differs when the same number of tests ran but a different set did", () => {
    const original = extractFailingTestsV1(["  ✖ one (1ms)", "  ✔ two (1ms)", "  ✔ three (1ms)", ...closing].join("\n"));
    const replaced = extractFailingTestsV1(["  ✔ one (1ms)", "  ✔ two (1ms)", "  ✔ four (1ms)", ...closing].join("\n"));
    assert.equal(original.testsExecuted, replaced.testsExecuted);
    assert.notEqual(original.executedDigest, replaced.executedDigest);
  });

  void it("counts the later runners of an aggregate after an earlier runner's failing-tests section", () => {
    const firstRunner = [
      "✖ one (1ms)",
      "✔ two (1ms)",
      ...closing,
      "✖ failing tests:",
      "",
      "test at file:///a.test.js:1:1",
      "✖ one (1ms)",
      "  AssertionError: boom",
    ];
    const secondA = ["✔ engine-a (1ms)", "✔ engine-b (1ms)", ...closing];
    const secondB = ["✔ engine-a (1ms)", "✔ engine-c (1ms)", ...closing];
    const a = extractFailingTestsV1([...firstRunner, ...secondA].join("\n"));
    const b = extractFailingTestsV1([...firstRunner, ...secondB].join("\n"));
    const firstOnly = extractFailingTestsV1(firstRunner.join("\n"));
    assert.notEqual(a.executedDigest, b.executedDigest, "a replaced later runner of the same size is a different run");
    assert.notEqual(a.executedDigest, firstOnly.executedDigest, "a later runner that never ran is a different run");
  });

  void it("differs when a failing test is replaced by a same-titled test in another suite", () => {
    const original = extractFailingTestsV1(
      ["▶ alpha", "  ✖ shared title (1ms)", "✖ alpha (2ms)", "▶ beta", "  ✔ other (1ms)", "✔ beta (1ms)", ...closing].join("\n")
    );
    const moved = extractFailingTestsV1(
      ["▶ alpha", "  ✔ other (1ms)", "✔ alpha (2ms)", "▶ beta", "  ✔ shared title (1ms)", "✔ beta (1ms)", ...closing].join("\n")
    );
    assert.notEqual(original.executedDigest, moved.executedDigest, "the replacement does not keep the old identity");
    const sameShape = extractFailingTestsV1(
      ["▶ alpha", "  ✔ shared title (9ms)", "✔ alpha (2ms)", "▶ beta", "  ✔ other (1ms)", "✔ beta (1ms)", ...closing].join("\n")
    );
    assert.equal(original.executedDigest, sameShape.executedDigest, "the same test passing later keeps its identity");
  });

  void it("differs when the same title ran in a different runner", () => {
    const firstRunner = ["✔ one (1ms)", ...closing];
    const secondRunner = ["✔ one (1ms)", ...closing];
    const both = extractFailingTestsV1([...firstRunner, ...secondRunner].join("\n"));
    const reversed = extractFailingTestsV1(["✔ one (1ms)", "✔ two (1ms)", ...closing, ...closing].join("\n"));
    assert.notEqual(both.executedDigest, reversed.executedDigest);
  });

  void it("reads a TAP stream that follows a spec runner's failing-tests section", () => {
    const specRunner = ["✖ one (1ms)", ...closing, "✖ failing tests:", "", "test at file:///a.test.js:1:1", "✖ one (1ms)", "  AssertionError: boom"];
    const withTapA = extractFailingTestsV1([...specRunner, "ok 1 - tap-a", "ok 2 - tap-b", "# tests 2", "# pass 2", "# fail 0"].join("\n"));
    const withTapB = extractFailingTestsV1([...specRunner, "ok 1 - tap-a", "ok 2 - tap-c", "# tests 2", "# pass 2", "# fail 0"].join("\n"));
    const withoutTap = extractFailingTestsV1(specRunner.join("\n"));
    assert.notEqual(withTapA.executedDigest, withTapB.executedDigest, "the TAP runner's tests are part of the identity");
    assert.notEqual(withTapA.executedDigest, withoutTap.executedDigest);
  });

  void it("does not count a skipped test as executed", () => {
    const failed = extractFailingTestsV1(["  ✖ one (1ms)", "  ✔ two (1ms)", ...closing].join("\n"));
    const skipped = extractFailingTestsV1(["  ﹣ one (0ms) # SKIP", "  ✔ two (1ms)", ...closing].join("\n"));
    const tapSkipped = extractFailingTestsV1(["not ok 1 - one # SKIP", "ok 2 - two", ...closing].join("\n"));
    assert.notEqual(failed.executedDigest, skipped.executedDigest);
    assert.equal(skipped.executedDigest, tapSkipped.executedDigest);
  });

  void it("ignores the repeated failing-tests section and is absent without test lines", () => {
    const withSection = extractFailingTestsV1(["  ✖ one (1ms)", ...closing, "✖ failing tests:", "", "✖ one (1ms)"].join("\n"));
    const withoutSection = extractFailingTestsV1(["  ✖ one (1ms)", ...closing].join("\n"));
    assert.equal(withSection.executedDigest, withoutSection.executedDigest);
    assert.equal(extractFailingTestsV1("nothing here").executedDigest, undefined);
  });
});
