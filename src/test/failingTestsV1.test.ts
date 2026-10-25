import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  composeCheckFailureOutputV1,
  extractFailingTestsV1,
  FAILING_TEST_INDEX_END_V1,
  FAILING_TEST_INDEX_MARKER_V1,
  splitFailingTestIndexV1,
  truncateKeepingFailingTestIndexV1,
} from "../utils/failingTestsV1";

void describe("failingTestsV1 (item 13 / Part 4, Step 26)", () => {
  const dummyTruncate = (text: string, max: number): string => {
    if (text.length <= max) {
      return text;
    }
    const half = Math.floor(max / 2);
    return `${text.slice(0, half)}\n... truncated ${text.length - max} characters ...\n${text.slice(text.length - half)}`;
  };

  void it("extracts failing test titles and locations from spec reporter output", () => {
    const rawOutput = [
      "▶ test suite 1",
      "  ✖ first failing test (12ms)",
      "  ✔ passing test (5ms)",
      "▶ test suite 2",
      "  ✖ second failing test (3ms)",
      "✖ failing tests:",
      "test at out/test/suite1.test.js:10:5",
      "✖ first failing test",
      "  AssertionError: expected true to be false",
      "test at out/test/suite2.test.js:20:8",
      "✖ second failing test",
      "  AssertionError: value mismatch",
      "ℹ tests 10",
      "ℹ pass 8",
      "ℹ fail 2",
    ].join("\n");

    const summary = extractFailingTestsV1(rawOutput);
    assert.equal(summary.total, 2);
    assert.equal(summary.tests.length, 2);
    assert.deepEqual(summary.tests[0], { file: "out/test/suite1.test.js", title: "first failing test" });
    assert.deepEqual(summary.tests[1], { file: "out/test/suite2.test.js", title: "second failing test" });
  });

  void it("extracts failing tests from TAP output", () => {
    const rawOutput = [
      "TAP version 13",
      "# Subtest: my-test",
      "not ok 1 - subtest failed",
      "  ---",
      "  location: 'out/test/tapSuite.test.js:42:3'",
      "  failureType: 'testCodeFailure'",
      "  ...",
      "not ok 2 - skipped test # SKIP reason",
      "ok 3 - passing test",
      "1..3",
      "# fail 1",
    ].join("\n");

    const summary = extractFailingTestsV1(rawOutput);
    assert.equal(summary.total, 1);
    assert.equal(summary.tests.length, 1);
    assert.deepEqual(summary.tests[0], { file: "out/test/tapSuite.test.js", title: "subtest failed" });
  });

  void it("preserves all failing test identities when raw output is truncated across 40 failures", () => {
    // Construct 40 failures with bulky error stack traces in the middle that would normally be truncated
    const lines: string[] = ["✖ failing tests:"];
    for (let i = 1; i <= 40; i++) {
      lines.push(`test at out/test/case${i}.test.js:${i * 5}:1`);
      lines.push(`✖ test case number ${i}`);
      lines.push("  AssertionError: expected something");
      lines.push(`    at Object.<anonymous> (out/test/case${i}.test.js:${i * 5}:1)`);
      lines.push("    at Module._compile (node:internal/modules/cjs/loader:1376:14)");
      lines.push(`    ${"long stack trace details ".repeat(20)}`);
    }
    lines.push("ℹ tests 100");
    lines.push("ℹ pass 60");
    lines.push("ℹ fail 40");
    const completeOutput = lines.join("\n");

    // Compose storage output with a tight maxChars (e.g. 1500 chars)
    const stored = composeCheckFailureOutputV1(completeOutput, 1500, dummyTruncate);
    assert.ok(stored.startsWith(FAILING_TEST_INDEX_MARKER_V1));
    assert.ok(stored.includes(FAILING_TEST_INDEX_END_V1));

    // Verify all 40 test files and titles are present in the index block
    for (let i = 1; i <= 40; i++) {
      assert.ok(
        stored.includes(`- out/test/case${i}.test.js: test case number ${i}`),
        `case ${i} must be preserved in the index block`
      );
    }

    // Now format for display / preview
    const displayed = truncateKeepingFailingTestIndexV1(stored, 800, dummyTruncate);
    const { index, rest } = splitFailingTestIndexV1(displayed);
    assert.ok(index.length > 0);
    assert.ok(rest.includes("... truncated"));
    assert.ok(index.includes("Failing tests (40)"));
  });

  void it("preserves complete failing test identities without truncation exceeding 24000 characters", () => {
    // Construct 300 failures, each with ~100 characters of path and test description (>30,000 chars total)
    const lines: string[] = ["✖ failing tests:"];
    for (let i = 1; i <= 300; i++) {
      lines.push(`test at out/test/longPackageName/subDirectory/moduleName/testFileCase${i}.test.js:${i * 10}:1`);
      lines.push(`✖ deeply nested scenario number ${i} with detailed description verifying edge conditions and parameters`);
      lines.push("  AssertionError: expected value to equal actual");
    }
    lines.push("ℹ tests 500");
    lines.push("ℹ pass 200");
    lines.push("ℹ fail 300");
    const completeOutput = lines.join("\n");

    const stored = composeCheckFailureOutputV1(completeOutput, 2000, dummyTruncate);
    const { index } = splitFailingTestIndexV1(stored);

    assert.ok(index.length > 24_000, `index length should exceed 24,000 chars (was ${index.length})`);
    assert.match(index, /raw report located/i);
    assert.doesNotMatch(index, /more not listed here/);

    for (let i = 1; i <= 300; i++) {
      assert.ok(
        index.includes(`testFileCase${i}.test.js: deeply nested scenario number ${i}`),
        `case ${i} must be preserved in the index`
      );
    }
  });

  void it("leaves output untouched when no failing tests are identified", () => {
    const rawOutput = "Build error: SyntaxError: Unexpected token in file.ts:1:1";
    const stored = composeCheckFailureOutputV1(rawOutput, 200, dummyTruncate);
    assert.equal(stored.startsWith(FAILING_TEST_INDEX_MARKER_V1), false);
    assert.equal(stored, rawOutput);

    const displayed = truncateKeepingFailingTestIndexV1(stored, 200, dummyTruncate);
    assert.equal(displayed, rawOutput);
  });
});
