/**
 * bugs4 Step 16 (item 11): test dependence follows what an item requires, not the
 * word "test" anywhere in its text. The fixtures paraphrase the five plan lines
 * quoted in item 11 (task "Align Deletion Messaging With Data Retention").
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeWithheldTestItemsV1 } from "../commands/applyReviewerVerifiedTicks";
import {
  isTestDependentChecklistItemV1,
  listProvisionalTestDependentChecklistItemsV1,
} from "../utils/implementationChecklist";

// plan-final.md line 16: the filename is the only mention.
const LINE_16 =
  "Keep the string style and the first 20 characters of the message in `processor.close-account.test.ts` unchanged.";
// line 43: tests are a search location.
const LINE_43 = 'Search `apps/server` and `apps/web`, including tests, for the old phrases.';
// line 44: genuinely about tests.
const LINE_44 = "Update any test that asserts a removed phrase.";
// line 50: a scope check that mentions tests in passing.
const LINE_50 = "Confirm no file other than the three changed, plus any test found by the search.";
// line 59: a note recording that no test work was needed.
const LINE_59 = "Record the Step 4 outcome in the summary (no test changes needed).";

void describe("items held only for missing test evidence name the command that would satisfy them (bugs4 item 11)", () => {
  void it("lists each withheld item on its own line and names the options the card has", () => {
    const text = describeWithheldTestItemsV1(["Add a parser table test.", "Add tests for the Cancel branch."]);
    assert.match(text, /^2 test-dependent items wait for a passing test report and stay provisional:/);
    assert.equal(text.split("\n").filter((line) => line.startsWith("  - ")).length, 2);
    assert.match(text, /To settle them: run Publish Checks, record a test run you did, or tick them\./);
    assert.doesNotMatch(text, /pnpm run test:unit -- /);
    assert.doesNotMatch(text, /; Add tests/, "no more one-paragraph '; '-joined list");
  });

  void it("uses the singular for one item", () => {
    assert.match(describeWithheldTestItemsV1(["Add a test."]), /^1 test-dependent item waits for/);
  });
});

void describe("test dependence is classified by what the item requires (bugs4 item 11)", () => {
  void it("lines 16, 43, 50 and 59 are not test-dependent", () => {
    for (const line of [LINE_16, LINE_43, LINE_50, LINE_59]) {
      assert.equal(isTestDependentChecklistItemV1(line), false, line);
    }
  });

  void it("line 44, which asks for tests to be updated, still is", () => {
    assert.equal(isTestDependentChecklistItemV1(LINE_44), true);
  });

  void it("items that add, run or pass tests, or need coverage, are test-dependent", () => {
    for (const line of [
      "Add a regression test for the terminal emitter.",
      "Add tests covering the View Full List branch.",
      "All unit tests pass after the change.",
      "Run `pnpm run test:unit -- src/test/foo.test.ts` and confirm it passes.",
      "Cover the new branch (coverage must not drop).",
      "Add fixtures for the Windows path forms.",
      "Add a replay test using data copied into `src/test/fixtures/`.",
    ]) {
      assert.equal(isTestDependentChecklistItemV1(line), true, line);
    }
  });

  void it("a test mentioned only through a path or a negation is not a requirement", () => {
    assert.equal(isTestDependentChecklistItemV1("Move the helper out of `src/test/helpers/shared.ts`."), false);
    assert.equal(isTestDependentChecklistItemV1("Ship the change without tests."), false);
    assert.equal(isTestDependentChecklistItemV1("This step does not need any tests."), false);
    assert.equal(isTestDependentChecklistItemV1("No test changes are needed for the rename."), false);
  });

  void it("descriptive uses of the word (test evidence, test report, failed tests) are not requirements", () => {
    // Plan items that talk about tests as a subject but need no test to be added, updated or run.
    for (const line of [
      "Treat a source `.ts` test file and its compiled `out/…js` counterpart as the same test.",
      "Store it as a test report with owner provenance that counts as test evidence for the named items.",
      "Record a `testsRefused` result separate from failed tests, and make the card name the cause and the remedies.",
      "Make test filenames (`*.test.*` tokens), tests mentioned as a search location, and statements such as “no test changes needed” not test-dependent, and keep uncertain cases verifiable by reviewer evidence or the owner.",
      "`isTestDependentChecklistItemV1` no longer matches on the bare word “test”.",
      "When an item is held only for missing test evidence, make the review and the card name the command that would satisfy it.",
      "Add prompt text saying a refused test command never stops a round from building: build the work, report the commands that could not run.",
      "Add a chat form with no input boxes where the owner records a test run: command, exit code, output or summary, and the items it covers.",
      "When missing test evidence is the only obstacle, recommend an editing round that runs the named tests.",
      "In the round prompt builders, name an allowed targeted test command (for this repo `pnpm run test:unit -- <test files>`).",
      "Count owner-decided items as settled, while test-dependent model claims still need a passing report.",
      "Replace the word regex with a classifier that is test-dependent only when the item requires adding, updating or running tests, tests passing, or coverage.",
    ]) {
      assert.equal(isTestDependentChecklistItemV1(line), false, line);
    }
  });

  void it("requirements to add, extend or run tests mid-sentence are still test-dependent", () => {
    for (const line of [
      "Copy the needed data into `src/test/fixtures/` and add a replay test: the three paths are attributed.",
      "Add a parser table test covering plain and backticked entries.",
      "Add an integration test through the real completed-Implementation hand-off.",
      "Add unit tests: narrowing declared does not pause.",
      "Rerun the unit tests after the rename.",
    ]) {
      assert.equal(isTestDependentChecklistItemV1(line), true, line);
    }
  });

  void it("ticked non-test items are no longer held provisional for a missing test report", () => {
    const plan = [`- [x] ${LINE_16}`, `- [x] ${LINE_43}`, `- [x] ${LINE_44}`, `- [x] ${LINE_50}`, `- [x] ${LINE_59}`, ""].join("\n");
    const held = listProvisionalTestDependentChecklistItemsV1(plan);
    assert.deepEqual(held, [LINE_44]);
  });
});
