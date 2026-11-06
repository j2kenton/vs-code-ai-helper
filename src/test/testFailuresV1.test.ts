/**
 * review1 Step 51: the failing tests of a Publish Checks run, parsed from the complete output and handed to the next
 * round as `{{testFailures}}`; the stop card's "Run Publish Checks now" option.
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { describe, it } from "node:test";

import { runPublishChecksNowV1 } from "../commands/runPublishChecksNowV1";
import { buildAutomationStoppedCardInputV1, type AutomationStopFactsV1 } from "../utils/automationStopV1";
import {
  buildTestFailuresV1,
  formatTestFailuresV1,
  isFailingTestsBlockerV1,
  readTestFailuresForPromptV1,
  RUN_PUBLISH_CHECKS_NOW_COMMAND_V1,
  TEST_FAILURES_FILE_V1,
  writeTestFailuresFileV1,
} from "../utils/testFailuresV1";

const OUTPUT = [
  "▶ order totals",
  "  ✖ rounds the total up (12ms)",
  "  ✔ adds tax (5ms)",
  "▶ refunds",
  "  ✖ refunds the full amount (3ms)",
  "✖ failing tests:",
  "test at out/test/orders.test.js:10:5",
  "✖ rounds the total up",
  "  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 41 !== 42",
  "      at TestContext.<anonymous> (/ws/out/test/orders.test.js:57:12)",
  "test at out/test/refunds.test.js:20:8",
  "✖ refunds the full amount",
  "  AssertionError: value mismatch",
  "ℹ tests 10",
  "ℹ pass 8",
  "ℹ fail 2",
].join("\n");

const FACTS: AutomationStopFactsV1 = {
  taskFolderPath: "/ws/.ensemble/t",
  stage: "impl-high-review",
  ending: "fast-forward-stalled",
  stopReason: "nothing moved",
  score: 6,
  previousScore: 6,
  blockers: { fixFirst: 1, buildToClear: 0, notThisRound: 0 },
  buildNext: [],
  dismissedDependencies: [],
  reviewClean: false,
  gateComplete: false,
  fastForwardWasRunning: true,
};

void describe("review1 Step 51: failing tests parsed for the next round", () => {
  void it("reads the test name, assertion, file and line of each failure from the complete output", () => {
    const failures = buildTestFailuresV1(OUTPUT);
    assert.equal(failures.length, 2);
    assert.equal(failures[0]!.name, "rounds the total up");
    assert.equal(failures[0]!.file, "out/test/orders.test.js");
    assert.equal(failures[0]!.line, 10);
    assert.match(failures[0]!.assertion ?? "", /41 !== 42|strictly equal/);
    assert.equal(failures[1]!.file, "out/test/refunds.test.js");
    assert.match(failures[1]!.assertion ?? "", /value mismatch/);
  });

  void it("formats them for the prompt with the run time, and says they may be out of date", () => {
    const text = formatTestFailuresV1(buildTestFailuresV1(OUTPUT), { runAt: "2026-11-04T12:00:00Z", command: "pnpm test" });
    assert.match(text, /Failing tests from the Publish Checks run at 2026-11-04T12:00:00Z \(`pnpm test`\): 2 failing\./);
    assert.match(text, /may be out of date for any file edited since/);
    assert.match(text, /- rounds the total up — out\/test\/orders\.test\.js:10/);
    assert.equal(formatTestFailuresV1([], { runAt: "x" }), "");
  });

  void it("recognises a blocker about failing tests and not one about missing ones", () => {
    assert.equal(isFailingTestsBlockerV1("The server tests still fail: 3 suites are red"), true);
    assert.equal(isFailingTestsBlockerV1("`pnpm test` failed (exit 1) — the order tests do not pass"), true);
    assert.equal(isFailingTestsBlockerV1("No tests were written for the new parser"), false);
    assert.equal(isFailingTestsBlockerV1("The retry logic drops the last row"), false);
  });

  void it("saves the failures where the apply prompt reads them, and a passing run clears them", async () => {
    const folder = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "test-failures-"));
    try {
      assert.equal(await readTestFailuresForPromptV1(folder), "");
      await writeTestFailuresFileV1(folder, formatTestFailuresV1(buildTestFailuresV1(OUTPUT), { runAt: "t" }));
      assert.ok(nodeFs.existsSync(nodePath.join(folder, ...TEST_FAILURES_FILE_V1.split("/"))));
      const prompt = await readTestFailuresForPromptV1(folder);
      assert.match(prompt, /^## Failing tests \(from Publish Checks\)/);
      assert.match(prompt, /rounds the total up/);
      await writeTestFailuresFileV1(folder, "");
      assert.equal(await readTestFailuresForPromptV1(folder), "");
    } finally {
      nodeFs.rmSync(folder, { recursive: true, force: true });
    }
  });

  void it("the apply prompt has a {{testFailures}} slot, filled from the saved failures", () => {
    const prompt = nodeFs.readFileSync(nodePath.resolve(__dirname, "../../resources/prompts/apply-impl-review-code.md"), "utf8");
    assert.ok(prompt.includes("{{testFailures}}"));
    const source = nodeFs.readFileSync(nodePath.resolve(__dirname, "../../src/commands/reviewActions.ts"), "utf8");
    assert.match(source, /testFailures: investigation \? "" : await readTestFailuresForPromptV1\(folderUri\.fsPath\)/);
  });
});

void describe("review1 Step 51: the stop card's 'Run Publish Checks now'", () => {
  void it("is offered when a blocker is about failing tests, and not otherwise", () => {
    const withTests = buildAutomationStoppedCardInputV1({ ...FACTS, failingTestsBlockers: 1 });
    const option = withTests.options.find((o) => o.optionId === "runPublishChecksNow");
    assert.ok(option);
    assert.equal(option.label, "Run Publish Checks now");
    assert.equal(option.effect.kind === "command" ? option.effect.command : undefined, RUN_PUBLISH_CHECKS_NOW_COMMAND_V1);
    assert.match(option.consequence, /no model round/);
    assert.match(option.consequence, /name, assertion, file and line/);
    assert.ok(!buildAutomationStoppedCardInputV1(FACTS).options.some((o) => o.optionId === "runPublishChecksNow"));
  });

  void it("running it parses the run's failures and saves them for the next round", async () => {
    const saved: string[] = [];
    const result = await runPublishChecksNowV1(
      { taskFolderPath: "/ws/.ensemble/t", stage: "impl-high-review" },
      {
        runChecks: () =>
          Promise.resolve({ runAt: "2026-11-04T12:00:00Z", passed: false, failedChecks: [{ command: "pnpm test", exitCode: 1, output: OUTPUT }] }),
        writeFailures: (_folder, formatted) => {
          saved.push(formatted);
          return Promise.resolve();
        },
      }
    );
    assert.equal((result as { outcome: string }).outcome, "done");
    assert.match((result as { message: string }).message, /2 failing tests/);
    assert.match(saved[0]!, /rounds the total up — out\/test\/orders\.test\.js:10/);
    assert.match(saved[0]!, /\(`pnpm test`\)/);
  });

  void it("a passing run clears the saved failures; a run that cannot start records nothing", async () => {
    const saved: string[] = [];
    const deps = (runChecks: () => Promise<{ runAt: string; passed: boolean; failedChecks: never[] }>) => ({
      runChecks,
      writeFailures: (_folder: string, formatted: string) => {
        saved.push(formatted);
        return Promise.resolve();
      },
    });
    const passed = await runPublishChecksNowV1(
      { taskFolderPath: "/ws/.ensemble/t" },
      deps(() => Promise.resolve({ runAt: "t", passed: true, failedChecks: [] }))
    );
    assert.match((passed as { message: string }).message, /passed/);
    assert.deepEqual(saved, [""]);
    const refused = await runPublishChecksNowV1(
      { taskFolderPath: "/ws/.ensemble/t" },
      deps(() => Promise.reject(new Error("no workspace folder")))
    );
    assert.equal((refused as { outcome: string }).outcome, "refused");
    assert.deepEqual(saved, [""]);
  });
});
