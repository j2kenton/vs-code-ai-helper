/**
 * Coverage for the publish pre-check contract (C3): the conventional `lint`
 * and `test` package.json scripts are run when configured and skipped (with
 * guidance, not a false failure) when absent, and a `test` script's failure
 * output — which names the *test* file, not the source file — is still
 * correctly attributed to a task's tracked source files via the same
 * src/**\/x.ts -> src/test/x.test.ts mapping used for review context packs.
 *
 * These tests spawn real `npm run <script>` child processes against a
 * throwaway temp package.json (no lockfile, so packageManager() resolves to
 * "npm"), matching how collectCompletionLint actually runs in production —
 * mocking child_process would leave the script-detection/attribution wiring
 * itself unverified.
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { after, describe, it } from "node:test";
import * as vscode from "vscode";

import {
  collectCompletionLint,
  readPackageScripts,
  mergeCompletionChecksSection,
  truncateCheckOutput,
  upsertCompletionChecksInPublishReview,
  CompletionLintResult,
} from "../utils/completionLint";

const TEST_ROOT = nodeFs.mkdtempSync(
  nodePath.join(nodeOs.tmpdir(), "ensemble-completion-lint-test-")
);
after(() => {
  nodeFs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

function makeWorkspace(name: string, packageJson: unknown): string {
  const dir = nodePath.join(TEST_ROOT, name);
  nodeFs.mkdirSync(dir, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(dir, "package.json"), JSON.stringify(packageJson, null, 2), "utf8");
  return dir;
}

void describe("readPackageScripts", () => {
  void it("returns the scripts map when package.json exists", () => {
    const dir = makeWorkspace("read-scripts-present", { name: "x", scripts: { lint: "eslint .", test: "node test.js" } });
    assert.deepEqual(readPackageScripts(dir), { lint: "eslint .", test: "node test.js" });
  });

  void it("returns undefined for a workspace without package.json", () => {
    const dir = nodePath.join(TEST_ROOT, "read-scripts-missing-file");
    nodeFs.mkdirSync(dir, { recursive: true });
    assert.equal(readPackageScripts(dir), undefined);
  });

  void it("returns undefined when package.json has no scripts key", () => {
    const dir = makeWorkspace("read-scripts-no-scripts-key", { name: "x" });
    assert.equal(readPackageScripts(dir), undefined);
  });
});

void describe("collectCompletionLint — publish pre-check schema (lint/test scripts)", () => {
  void it("skips a missing test script with guidance instead of failing, while still running lint", async () => {
    const dir = makeWorkspace("missing-test-script", {
      name: "x",
      scripts: {
        lint: "node -e \"process.exit(0)\"",
        "check-types": "node -e \"process.exit(0)\"",
        build: "node -e \"process.exit(0)\"",
      },
    });

    const result = await collectCompletionLint(dir, []);

    assert.deepEqual(result.missingScripts, ["test"]);
    assert.match(result.summary, /test script\(s\) not configured/);
    assert.equal(
      result.failedChecks.some((c) => c.command.includes("run test")),
      false,
      "an unconfigured test script must never appear as a failed check"
    );
  });

  void it("reports inconclusive (never passed) when neither lint nor test is configured", async () => {
    const dir = makeWorkspace("missing-both-scripts", {
      name: "x",
      scripts: {
        "check-types": "node -e \"process.exit(0)\"",
        build: "node -e \"process.exit(0)\"",
      },
    });

    const result = await collectCompletionLint(dir, []);

    assert.deepEqual(result.missingScripts.sort(), ["lint", "test"]);
    assert.equal(
      result.passed,
      false,
      "an undetected toolchain is never a pass — required checks that could not run leave the result inconclusive"
    );
    assert.equal(result.issueCount, 0, "inconclusive is not a failure: nothing that ran failed");
    assert.match(result.summary, /inconclusive/i);
  });

  void it("runs explicitly configured verification commands with precedence over script detection", async () => {
    const dir = makeWorkspace("explicit-commands", {
      name: "x",
      // A lint script that would fail if the conventional path ran it.
      scripts: { lint: "node -e \"process.exit(1)\"" },
    });

    const result = await collectCompletionLint(dir, [], {
      explicitCommands: ["node -e \"process.exit(0)\""],
    });

    assert.deepEqual(result.missingScripts, [], "explicit commands bypass missing-script reporting");
    assert.deepEqual(result.failedChecks, [], "only the explicit command runs, and it passed");
    assert.equal(result.passed, true);
  });

  void it("reports a failing explicit verification command as a failed check", async () => {
    const dir = makeWorkspace("explicit-commands-fail", { name: "x" });

    const result = await collectCompletionLint(dir, [], {
      explicitCommands: ["node -e \"console.error('boom'); process.exit(3)\""],
    });

    assert.equal(result.passed, false);
    assert.equal(result.failedChecks.length, 1);
    assert.equal(result.failedChecks[0]!.exitCode, 3);
    assert.match(result.failedChecks[0]!.output, /boom/);
  });

  void it("runs the test script when configured and reports a real failure", async () => {
    const dir = makeWorkspace("configured-failing-test", {
      name: "x",
      scripts: {
        lint: "node -e \"process.exit(0)\"",
        "check-types": "node -e \"process.exit(0)\"",
        test: "node -e \"console.log('FAIL src/test/widget.test.ts'); process.exit(1)\"",
        build: "node -e \"process.exit(0)\"",
      },
    });

    // relevantFiles names the *source* file, not the test file that the
    // (fabricated) test-runner output above actually references — this is
    // exactly the attribution gap a naive `outputReferencesFile` check
    // against relevantFiles alone would miss.
    const result = await collectCompletionLint(dir, ["src/commands/widget.ts"]);

    assert.deepEqual(result.missingScripts, []);
    assert.equal(
      result.failedChecks.some((c) => c.command.includes("run test")),
      true,
      "a configured test script's failure must be attributed via the mapped test file, not dropped"
    );
    assert.equal(result.passed, false);
  });

  void it("blocks publish when a configured check fails without naming a tracked file", async () => {
    const dir = makeWorkspace("configured-runner-failure", {
      name: "x",
      scripts: {
        lint: "node -e \"process.exit(0)\"",
        "check-types": "node -e \"process.exit(0)\"",
        test: "node -e \"console.error('Test runner failed to load configuration'); process.exit(1)\"",
      },
    });

    const result = await collectCompletionLint(dir, ["src/commands/widget.ts"]);

    assert.equal(result.passed, false, "a non-zero configured check must never be treated as a pass");
    assert.equal(result.issueCount, 1);
    assert.deepEqual(result.failedChecks.map((check) => check.command), ["npm run test"]);
    assert.match(result.failedChecks[0]!.output, /failed to load configuration/);
  });
});

// ---------------------------------------------------------------------------
// C3: writing completion-check results into publish-review.md
// ---------------------------------------------------------------------------

function fakeResult(overrides: Partial<CompletionLintResult> = {}): CompletionLintResult {
  return {
    runAt: "2026-01-01T00:00:00.000Z",
    passed: false,
    summary: "1 completion check(s) failed.",
    issueCount: 1,
    failedChecks: [{ command: "npm run lint", exitCode: 1, output: "widget.ts: unused variable" }],
    missingScripts: [],
    ...overrides,
  };
}

void describe("mergeCompletionChecksSection", () => {
  void it("appends the section when the file has no managed section yet", () => {
    const merged = mergeCompletionChecksSection(
      "# Publish Review\n\nAI-authored readiness notes.\n",
      "<!-- completion-checks:start -->\nnew\n<!-- completion-checks:end -->"
    );
    assert.match(merged, /AI-authored readiness notes\./);
    assert.match(merged, /new/);
  });

  void it("replaces a previous managed section in place, preserving surrounding content", () => {
    const existing =
      "# Publish Review\n\nAI notes above.\n\n" +
      "<!-- completion-checks:start -->\nold section\n<!-- completion-checks:end -->\n\n" +
      "AI notes below.\n";
    const merged = mergeCompletionChecksSection(
      existing,
      "<!-- completion-checks:start -->\nnew section\n<!-- completion-checks:end -->"
    );
    assert.match(merged, /AI notes above\./);
    assert.match(merged, /AI notes below\./);
    assert.match(merged, /new section/);
    assert.doesNotMatch(merged, /old section/);
  });

  void it("writes just the section when the file was empty", () => {
    const merged = mergeCompletionChecksSection(
      "",
      "<!-- completion-checks:start -->\nsection\n<!-- completion-checks:end -->"
    );
    assert.equal(merged, "<!-- completion-checks:start -->\nsection\n<!-- completion-checks:end -->\n");
  });
});

void describe("upsertCompletionChecksInPublishReview", () => {
  void it("creates publish-review.md with a Completion Checks section when it doesn't exist", async () => {
    const dir = makeWorkspace("publish-review-create", { name: "x" });
    await upsertCompletionChecksInPublishReview(vscode.Uri.file(dir), fakeResult());

    const content = nodeFs.readFileSync(nodePath.join(dir, "publish-review.md"), "utf8");
    assert.match(content, /## Completion Checks/);
    assert.match(content, /Status: Failed/);
    assert.match(content, /npm run lint/);
  });

  void it("preserves pre-existing AI review content and updates only the managed section on rerun", async () => {
    const dir = makeWorkspace("publish-review-preserve", { name: "x" });
    nodeFs.writeFileSync(
      nodePath.join(dir, "publish-review.md"),
      "Readiness: 8/10\n\nSummary verdict: ready to publish.\n",
      "utf8"
    );

    await upsertCompletionChecksInPublishReview(vscode.Uri.file(dir), fakeResult());
    await upsertCompletionChecksInPublishReview(
      vscode.Uri.file(dir),
      fakeResult({ passed: true, summary: "No linting issues found.", failedChecks: [] })
    );

    const content = nodeFs.readFileSync(nodePath.join(dir, "publish-review.md"), "utf8");
    assert.match(content, /Readiness: 8\/10/);
    assert.match(content, /Status: Passed/);
    assert.doesNotMatch(content, /Status: Failed/);
  });

  void it("records the override reason when a user publishes anyway", async () => {
    const dir = makeWorkspace("publish-review-override", { name: "x" });
    await upsertCompletionChecksInPublishReview(vscode.Uri.file(dir), fakeResult(), {
      reason: "user chose Publish Anyway",
    });

    const content = nodeFs.readFileSync(nodePath.join(dir, "publish-review.md"), "utf8");
    assert.match(content, /Published anyway despite failing checks — user chose Publish Anyway\./);
  });
});

void describe("truncateCheckOutput", () => {
  void it("returns short output unchanged", () => {
    assert.strictEqual(truncateCheckOutput("all good", 1500), "all good");
  });

  void it("keeps the FAILING tail of a node --test log, not just the passing head", () => {
    // The real regression (observed 2026-07-26): `node --test` streams its
    // passes first and prints the failing test name plus the `fail N`
    // summary last. A head-only slice preserved the passes and discarded
    // the failure, leaving the reviewer with a red run it could not
    // attribute and the implementer with no test to fix.
    const passes = Array.from({ length: 400 }, (_, i) => `  ok ${i} - passing test ${i}`).join("\n");
    const failure = [
      "  not ok 401 - startNewTask reserves the folder",
      "    error: Expected values to be strictly equal",
      "ℹ tests 401",
      "ℹ pass 400",
      "ℹ fail 1",
    ].join("\n");
    const log = `${passes}\n${failure}`;

    const truncated = truncateCheckOutput(log, 1500);

    assert.ok(truncated.length < log.length, "long output should be truncated");
    assert.match(truncated, /not ok 401 - startNewTask reserves the folder/);
    assert.match(truncated, /fail 1/);
    assert.match(truncated, /truncated \d+ characters/);
  });

  void it("also keeps the head, where fail-fast tools like tsc report errors first", () => {
    const head = "src/a.ts(1,1): error TS2304: Cannot find name \x27foo\x27.";
    const log = `${head}\n${"filler line\n".repeat(500)}`;

    const truncated = truncateCheckOutput(log, 1500);

    assert.match(truncated, /error TS2304: Cannot find name/);
  });

  void it("stays within the requested cap", () => {
    const log = "x".repeat(50_000);
    assert.ok(truncateCheckOutput(log, 1500).length <= 1500);
  });
});
