/**
 * bugs5 Step 16: the failure notice names the failing checks and tests per package and recommends the
 * fix round; a cancelled run keeps its raw output apart from the last completed run's; Fix Linting
 * says what became of the last run instead of "have not run yet".
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  describeNoUsableChecksResultV1,
  describePublishChecksFailureV1,
  PUBLISH_CHECKS_FIX_ACTION_LABEL_V1,
} from "../utils/publishChecksFailureNoticeV1";
import { renderFailingTestIndexV1, type FailingTestSummaryV1 } from "../utils/failingTestsV1";
import { DEFAULT_RAW_CHECK_REPORT_V1, planRawCheckReportV1 } from "../utils/rawCheckReportPathsV1";
import { isFingerprintExcludedPathV1 } from "../utils/publishChecksFreshness";

function failedTests(
  command: string,
  files: Array<string | undefined>,
  total = files.length
): { command: string; output: string; failingTests: FailingTestSummaryV1 } {
  return {
    command,
    output: "",
    failingTests: { total, tests: files.map((file, index) => ({ file, title: `t${index}` })) },
  };
}

void describe("describePublishChecksFailureV1", () => {
  void it("counts failing tests per package and recommends Fix Linting & Code Errors", () => {
    const text = describePublishChecksFailureV1({
      failedChecks: [
        failedTests("pnpm run verify", [
          "src/test/a.test.ts",
          "src/test/a.test.ts",
          "src/test/b.test.ts",
          "src/test/c.test.ts",
          "src/test/d.test.ts",
          "packages/ensemble-core/src/test/x.test.ts",
        ]),
      ],
    });
    assert.equal(
      text,
      "Publish Checks failed: 6 tests (5 in unit tests, 1 in ensemble-core). Recommended: Fix Linting & Code Errors."
    );
    assert.ok(text.includes(PUBLISH_CHECKS_FIX_ACTION_LABEL_V1));
  });

  void it("reads the counts back from a persisted payload, which keeps only the failing-test index in the output", () => {
    const output = renderFailingTestIndexV1({
      total: 3,
      tests: [
        { file: "src/test/a.test.ts", title: "one" },
        { file: "src/test/a.test.ts", title: "two: with colon" },
        { file: "packages/ensemble-core/src/test/x.test.ts", title: "three" },
      ],
    });
    const text = describePublishChecksFailureV1({
      failedChecks: [{ command: "pnpm run verify", output: `${output}\nraw tail` }],
    });
    assert.match(text, /^Publish Checks failed: 3 tests \(2 in unit tests, 1 in ensemble-core\)\./);
  });

  void it("never suggests Publish Anyway and has no doubled full stop", () => {
    const text = describePublishChecksFailureV1({ failedChecks: [failedTests("pnpm run test", ["src/test/a.test.ts"])] });
    assert.doesNotMatch(text, /Publish Anyway/);
    assert.doesNotMatch(text, /\.\./);
    assert.match(text, /^Publish Checks failed: 1 test \(1 in unit tests\)\./);
  });

  void it("names failing checks that carry no recognised failing test", () => {
    const text = describePublishChecksFailureV1({
      failedChecks: [
        { command: "pnpm run lint", output: "" },
        { command: "pnpm run check-types", output: "" },
      ],
    });
    assert.match(text, /^Publish Checks failed: lint, check-types\. Recommended: Fix Linting & Code Errors\.$/);
  });

  void it("attributes tests the runner counted but did not list to the check's own name", () => {
    const text = describePublishChecksFailureV1({
      failedChecks: [failedTests("pnpm run test", ["src/test/a.test.ts"], 3)],
    });
    assert.match(text, /3 tests \(1 in unit tests, 2 in test\)/);
  });
});

void describe("planRawCheckReportV1", () => {
  void it("a completed run writes its own file and replaces the canonical log", () => {
    const plan = planRawCheckReportV1({ cancelled: false, runId: "2026-11-01T17-13-00Z" });
    assert.deepEqual(plan.writes, ["runs/raw-check-output-2026-11-01T17-13-00Z.log", DEFAULT_RAW_CHECK_REPORT_V1]);
    assert.equal(plan.resultLocation, DEFAULT_RAW_CHECK_REPORT_V1);
  });

  void it("a cancelled run writes only its own file, leaving the canonical log alone", () => {
    const plan = planRawCheckReportV1({ cancelled: true, runId: "2026-11-01T17-18-00Z" });
    assert.deepEqual(plan.writes, ["runs/raw-check-output-2026-11-01T17-18-00Z.log"]);
    assert.ok(!plan.writes.includes(DEFAULT_RAW_CHECK_REPORT_V1));
    assert.equal(plan.resultLocation, "runs/raw-check-output-2026-11-01T17-18-00Z.log");
  });

  void it("a caller-chosen location is written as is", () => {
    const plan = planRawCheckReportV1({ requestedLocation: "runs/failed-first-x.log", cancelled: true, runId: "r" });
    assert.deepEqual(plan.writes, ["runs/failed-first-x.log"]);
  });

  void it("per-run logs never change the tree fingerprint", () => {
    assert.equal(isFingerprintExcludedPathV1("runs/raw-check-output-2026-11-01T17-18-00Z.log"), true);
    assert.equal(isFingerprintExcludedPathV1("task/runs/raw-check-output-abc.log"), true);
  });

  void it("the plan applied to a folder keeps the earlier canonical output after a cancelled run", () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "raw-report-"));
    try {
      fs.mkdirSync(path.join(folder, "runs"), { recursive: true });
      const apply = (plan: ReturnType<typeof planRawCheckReportV1>, text: string): void => {
        for (const rel of plan.writes) {
          fs.writeFileSync(path.join(folder, rel), text, "utf8");
        }
      };
      apply(planRawCheckReportV1({ cancelled: false, runId: "first" }), "complete failure");
      apply(planRawCheckReportV1({ cancelled: true, runId: "second" }), "partial output");
      assert.equal(fs.readFileSync(path.join(folder, DEFAULT_RAW_CHECK_REPORT_V1), "utf8"), "complete failure");
      assert.equal(fs.readFileSync(path.join(folder, "runs/raw-check-output-second.log"), "utf8"), "partial output");
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});

void describe("describeNoUsableChecksResultV1", () => {
  void it("says 'have not run yet' only when no run has happened", () => {
    assert.match(describeNoUsableChecksResultV1(undefined), /have not run yet/);
  });

  void it("names a cancelled run and the earlier run it left behind, never 'have not run yet'", () => {
    const text = describeNoUsableChecksResultV1({
      outcome: "cancelled",
      at: "2026-11-01T17:18:46.000Z",
      cause: "you cancelled it",
      lastCompleted: { outcome: "failed", at: "2026-11-01T17:13:13.000Z", failedCommands: ["pnpm run verify"] },
    });
    assert.match(text, /was cancelled at \d\d:\d\d \(you cancelled it\)/);
    assert.match(text, /earlier run \(failed at \d\d:\d\d\)/);
    assert.doesNotMatch(text, /have not run yet/);
  });

  void it("names an interrupted run and a run that is still going", () => {
    assert.match(
      describeNoUsableChecksResultV1({ outcome: "interrupted", at: "2026-11-01T17:18:46.000Z", finishedCommands: [], unknownCommands: [] }),
      /was interrupted at \d\d:\d\d/
    );
    assert.match(
      describeNoUsableChecksResultV1({
        outcome: "running",
        at: "2026-11-01T17:18:46.000Z",
        pid: 1,
        hostname: "h",
        finishedCommands: [],
        runningCommands: [],
      }),
      /still running/
    );
  });
});
