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
  collectAiVerifiedPlanItems,
  collectCompletionLint,
  readPackageScripts,
  mergeCompletionChecksSection,
  truncateCheckOutput,
  upsertCompletionChecksReportV1,
  CompletionLintResult,
} from "../utils/completionLint";
import {
  ensurePublishReviewArtifactExistsV1,
  readPublishChecksFreshnessStampV1,
  renderPublishChecksFreshnessStamp,
  writePublishChecksFreshnessStampV1,
} from "../utils/publishChecksFreshness";
import { PUBLISH_CHECKS_FILENAME, STAGE_ARTIFACT_FILENAMES } from "../types/taskProgress";

const PUBLISH_REVIEW_FILENAME = STAGE_ARTIFACT_FILENAMES.publish!;

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
// C3: writing completion-check results into publish-review.md (unified
// Publish artifact — plan item 17, step 20)
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

void describe("upsertCompletionChecksReportV1", () => {
  void it("creates publish-review.md with a Completion Checks section when it doesn't exist", async () => {
    const dir = makeWorkspace("publish-review-create", { name: "x" });
    await upsertCompletionChecksReportV1(vscode.Uri.file(dir), fakeResult());

    const content = nodeFs.readFileSync(nodePath.join(dir, PUBLISH_REVIEW_FILENAME), "utf8");
    assert.match(content, /## Completion Checks/);
    assert.match(content, /Status: Failed/);
    assert.match(content, /npm run lint/);
    assert.equal(
      nodeFs.existsSync(nodePath.join(dir, PUBLISH_CHECKS_FILENAME)),
      false,
      "no new publish-checks.md is ever written"
    );
  });

  void it("preserves pre-existing AI review content and updates only the managed section on rerun", async () => {
    const dir = makeWorkspace("publish-review-preserve", { name: "x" });
    nodeFs.writeFileSync(
      nodePath.join(dir, PUBLISH_REVIEW_FILENAME),
      "Readiness: 8/10\n\nSummary verdict: ready to publish.\n",
      "utf8"
    );

    await upsertCompletionChecksReportV1(vscode.Uri.file(dir), fakeResult());
    await upsertCompletionChecksReportV1(
      vscode.Uri.file(dir),
      fakeResult({ passed: true, summary: "No linting issues found.", failedChecks: [] })
    );

    const content = nodeFs.readFileSync(nodePath.join(dir, PUBLISH_REVIEW_FILENAME), "utf8");
    assert.match(content, /Readiness: 8\/10/);
    assert.match(content, /Status: Passed/);
    assert.doesNotMatch(content, /Status: Failed/);
  });

  void it("ensurePublishReviewArtifactExistsV1 imports a legacy publish-checks.md's sections, with its original stamp, when publish-review.md doesn't exist yet", async () => {
    // Plan item 17, step 20(b): a task that upgraded mid-Publish still has
    // its most recent Scope Check and freshness stamp available under the
    // unified artifact, imported once with a provenance note, rather than
    // silently losing them because the new file starts empty — and, unlike
    // a fresh checks run, mere creation must not invalidate that stamp.
    const dir = makeWorkspace("publish-review-legacy-import", { name: "x" });
    const originalStamp = {
      formatVersion: 1 as const,
      runId: "22222222-2222-4222-8222-222222222222",
      verifiedCommitSha: "b".repeat(40),
      completedAt: "2026-08-20T00:00:00.000Z",
      scopeId: "fedcba9876543210",
    };
    const legacyContent = [
      "<!-- completion-checks:start -->",
      "## Completion Checks",
      "",
      "- Status: Passed",
      "<!-- completion-checks:end -->",
      "",
      "<!-- scope-check:start -->",
      "## Scope Check",
      "",
      "No files the plan doesn't mention.",
      "<!-- scope-check:end -->",
      "",
      renderPublishChecksFreshnessStamp(originalStamp),
      "",
    ].join("\n");
    nodeFs.writeFileSync(nodePath.join(dir, PUBLISH_CHECKS_FILENAME), legacyContent, "utf8");
    assert.equal(nodeFs.existsSync(nodePath.join(dir, PUBLISH_REVIEW_FILENAME)), false);

    await ensurePublishReviewArtifactExistsV1(vscode.Uri.file(dir));

    const content = nodeFs.readFileSync(nodePath.join(dir, PUBLISH_REVIEW_FILENAME), "utf8");
    // Both legacy sections survived the import.
    assert.match(content, /Status: Passed/);
    assert.match(content, /No files the plan doesn't mention\./);
    // The legacy freshness stamp's fields survived the import verbatim —
    // creation alone (no fresh check run) must not invalidate it.
    assert.match(content, new RegExp(originalStamp.runId));
    assert.match(content, new RegExp(originalStamp.verifiedCommitSha));
    assert.notEqual(await readPublishChecksFreshnessStampV1(vscode.Uri.file(dir)), undefined);
    // Imported content is explicitly attributed, not silently merged in.
    assert.match(content, /Imported once from the legacy publish-checks\.md/);
    // The legacy file itself is untouched.
    assert.equal(
      nodeFs.readFileSync(nodePath.join(dir, PUBLISH_CHECKS_FILENAME), "utf8"),
      legacyContent
    );

    // Idempotent: calling again once the file exists never re-imports or
    // duplicates the section.
    await ensurePublishReviewArtifactExistsV1(vscode.Uri.file(dir));
    const contentAfterSecondCall = nodeFs.readFileSync(nodePath.join(dir, PUBLISH_REVIEW_FILENAME), "utf8");
    assert.equal(contentAfterSecondCall, content);
  });

  void it("ensurePublishReviewArtifactExistsV1 creates a plain stub when no legacy publish-checks.md exists", async () => {
    const dir = makeWorkspace("publish-review-stub", { name: "x" });
    await ensurePublishReviewArtifactExistsV1(vscode.Uri.file(dir));

    const content = nodeFs.readFileSync(nodePath.join(dir, PUBLISH_REVIEW_FILENAME), "utf8");
    assert.match(content, /Not yet reviewed/);
  });

  void it("renders Status: Passed when every failure is a quarantined known flake, not Status: Failed", async () => {
    // The jester task 5 observation this fixes: passed=false (raw verdict,
    // never adjusted) but passedModuloKnownFlakes=true (every failure
    // quarantined) previously still rendered "Status: Failed" because the
    // headline read result.passed instead of the modulo-known-flakes field.
    const dir = makeWorkspace("publish-review-known-flake-headline", { name: "x" });
    await upsertCompletionChecksReportV1(
      vscode.Uri.file(dir),
      fakeResult({
        passed: false,
        passedModuloKnownFlakes: true,
        issueCount: 1,
        failedChecks: [{ command: "npm run test", exitCode: 1, output: "EPERM: rmdir race" }],
        knownFlakeFailures: [{ command: "npm run test", exitCode: 1, reason: "pre-existing cleanup race" }],
      })
    );

    const content = nodeFs.readFileSync(nodePath.join(dir, PUBLISH_REVIEW_FILENAME), "utf8");
    assert.match(content, /Status: Passed/);
    assert.doesNotMatch(content, /Status: Failed/);
    // The quarantined failure stays fully visible in the body.
    assert.match(content, /known flake: pre-existing cleanup race/);
  });

  void it("never renders a Plan Item Verification section — the AI-assisted pass is retired and gated off", async () => {
    // jester task 5, 2026-08-23: "0 passed, 3 failed, 44 inconclusive" plus a
    // blocking-sounding instruction demanding justification for items that
    // were already declared out of scope. With no working AI verification
    // path, collectAiVerifiedPlanItems always returns undefined and this
    // section must never appear in the artifact at all.
    const dir = makeWorkspace("publish-review-no-plan-item-verification", { name: "x" });
    nodeFs.writeFileSync(
      nodePath.join(dir, "plan-final.md"),
      "# Plan\n\n- [x] Done step\n- [ ] Not done step\n- [ ] Deferred step <!-- ensemble:excluded -->\n",
      "utf8"
    );

    assert.equal(
      collectAiVerifiedPlanItems(vscode.Uri.file(dir), dir),
      undefined,
      "the AI-assisted pass is gated off entirely — it must never re-derive a verdict from the checklist"
    );

    await upsertCompletionChecksReportV1(vscode.Uri.file(dir), fakeResult());
    const content = nodeFs.readFileSync(nodePath.join(dir, PUBLISH_REVIEW_FILENAME), "utf8");
    assert.doesNotMatch(content, /Plan Item Verification/);
    assert.doesNotMatch(content, /failed verification/);
  });

  void it("records the override reason when a user publishes anyway", async () => {
    const dir = makeWorkspace("publish-review-override", { name: "x" });
    await upsertCompletionChecksReportV1(vscode.Uri.file(dir), fakeResult(), {
      reason: "user chose Publish Anyway",
    });

    const content = nodeFs.readFileSync(nodePath.join(dir, PUBLISH_REVIEW_FILENAME), "utf8");
    assert.match(content, /Published anyway despite failing checks — user chose Publish Anyway\./);
  });

  void it("invalidates a previous freshness stamp on a refresh of this section alone", async () => {
    const dir = makeWorkspace("publish-review-invalidate-stamp", { name: "x" });
    const targetUri = vscode.Uri.file(dir);
    await upsertCompletionChecksReportV1(targetUri, fakeResult());
    await writePublishChecksFreshnessStampV1(targetUri, {
      formatVersion: 1,
      runId: "11111111-1111-4111-8111-111111111111",
      verifiedCommitSha: "a".repeat(40),
      completedAt: new Date().toISOString(),
      scopeId: "0123456789abcdef",
    });
    assert.notEqual(await readPublishChecksFreshnessStampV1(targetUri), undefined);

    // A follow-up refresh of the Completion Checks section alone (e.g. the
    // linting-fix loop re-running the lint, without also re-running the
    // Scope Check) must not leave that stamp looking current.
    await upsertCompletionChecksReportV1(targetUri, fakeResult());
    assert.equal(await readPublishChecksFreshnessStampV1(targetUri), undefined);
  });

  void it("serializes concurrent refreshes of the same report without a torn or corrupted write", async () => {
    const dir = makeWorkspace("publish-review-concurrent", { name: "x" });
    const targetUri = vscode.Uri.file(dir);

    // Two closely triggered refreshes racing on the same publish-review.md
    // (plan PART 2, step 6's concurrency requirement) must each land a
    // complete, well-formed Completion Checks section — never an
    // interleaved half-write from one call clobbering the other's.
    await Promise.all([
      upsertCompletionChecksReportV1(targetUri, fakeResult({ summary: "run A" })),
      upsertCompletionChecksReportV1(targetUri, fakeResult({ summary: "run B" })),
    ]);

    const content = nodeFs.readFileSync(nodePath.join(dir, PUBLISH_REVIEW_FILENAME), "utf8");
    const starts = content.split("<!-- completion-checks:start -->").length - 1;
    const ends = content.split("<!-- completion-checks:end -->").length - 1;
    assert.equal(starts, 1, "exactly one Completion Checks section, no duplicated/torn section markers");
    assert.equal(ends, 1);
    assert.match(content, /run [AB]/);
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
