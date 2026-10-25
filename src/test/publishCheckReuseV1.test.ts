import * as assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import {
  checkPublishChecksFreshnessV1,
  checkPublishChecksReuseEligibilityV1,
  computeTreeFingerprintV1,
  isFingerprintExcludedPathV1,
  isReusedPublishChecksRunStillCurrentV1,
  renderPublishChecksFreshnessStamp,
  parsePublishChecksFreshnessStamp,
  writePublishChecksFreshnessStampV1,
  classifyPublishChecksFreshnessV1,
  computePublishScopeId,
  readPublishChecksFile,
  PublishChecksFreshnessStampV1,
} from "../utils/publishChecksFreshness";
import { checkAndReviewPublishV1 } from "../commands/checkAndReviewPublish";
import { createPublishFixReleaseCoordinatorV1 } from "../commands/runLintingFixes";
import {
  CompletionLintResult,
  parseRecordedCompletionChecksEvidenceV1,
  upsertCompletionChecksReportV1,
} from "../utils/completionLint";
import { buildVerifiedChecksVariable } from "../commands/reviewActions";
import { revalidatePublishFreshnessOrThrowV1, ReviewPromotionErrorV1 } from "../actions/rows/reviewRowV1";
import { safeRemoveDir } from "./testFsUtils";

void describe("Publish Check Fingerprinting & Reuse (Steps 29-31 / Part 5)", () => {
  void it("round-trips treeFingerprint in freshness stamp", () => {
    const stamp: PublishChecksFreshnessStampV1 = {
      formatVersion: 1,
      runId: "test-run-123",
      verifiedCommitSha: "abc1234567890abcdef1234567890abcdef1234",
      completedAt: new Date().toISOString(),
      scopeId: "0123456789abcdef",
      treeFingerprint: "deadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678",
    };
    const rendered = renderPublishChecksFreshnessStamp(stamp);
    assert.ok(rendered.includes("tree-fingerprint: deadbeef"));
    const parsed = parsePublishChecksFreshnessStamp(rendered);
    assert.deepEqual(parsed, stamp);
  });

  void it("keeps older stamps without treeFingerprint readable and classifies them valid for existing behavior", () => {
    const olderStamp: PublishChecksFreshnessStampV1 = {
      formatVersion: 1,
      runId: "older-run-456",
      verifiedCommitSha: "abc1234567890abcdef1234567890abcdef1234",
      completedAt: new Date().toISOString(),
      scopeId: computePublishScopeId("/repo"),
    };
    const rendered = renderPublishChecksFreshnessStamp(olderStamp);
    assert.ok(!rendered.includes("tree-fingerprint"));
    const parsed = parsePublishChecksFreshnessStamp(rendered);
    assert.strictEqual(parsed?.treeFingerprint, undefined);

    const check = classifyPublishChecksFreshnessV1(parsed, "/repo", olderStamp.verifiedCommitSha);
    assert.strictEqual(check.status, "valid");
  });

  void it("correctly identifies fingerprint-excluded paths and preserves source paths", () => {
    assert.strictEqual(isFingerprintExcludedPathV1(".ensemble/task/task.md"), true);
    assert.strictEqual(isFingerprintExcludedPathV1("dist/index.js"), true);
    assert.strictEqual(isFingerprintExcludedPathV1("out/test.js"), true);
    assert.strictEqual(isFingerprintExcludedPathV1("packages/app/dist/bundle.js"), true);
    assert.strictEqual(isFingerprintExcludedPathV1("runs/raw-check-output.log"), true);
    assert.strictEqual(isFingerprintExcludedPathV1("task/runs/raw-check-output.log"), true);
    assert.strictEqual(isFingerprintExcludedPathV1("publish-review.md"), true);
    assert.strictEqual(isFingerprintExcludedPathV1("publish-checks.md"), true);

    // Source paths must NOT be excluded even if containing colliding names or nested in member packages
    assert.strictEqual(isFingerprintExcludedPathV1("packages/app/src/dist/parser.ts"), false);
    assert.strictEqual(isFingerprintExcludedPathV1("packages/app/src/out/writer.ts"), false);
    assert.strictEqual(isFingerprintExcludedPathV1("apps/mobile/src/dist/component.tsx"), false);
    assert.strictEqual(isFingerprintExcludedPathV1("packages/pkg-b/src/out/index.ts"), false);
    assert.strictEqual(isFingerprintExcludedPathV1("src/dist/parser.ts"), false);
    assert.strictEqual(isFingerprintExcludedPathV1("src/out/writer.ts"), false);
    assert.strictEqual(isFingerprintExcludedPathV1("src/runs/runner.ts"), false);
    assert.strictEqual(isFingerprintExcludedPathV1("runs/runner.ts"), false);
    assert.strictEqual(isFingerprintExcludedPathV1("src/.scratch/foo.ts"), false);
    assert.strictEqual(isFingerprintExcludedPathV1(".scratch/temp.ts"), false);
    assert.strictEqual(isFingerprintExcludedPathV1("src/extension.ts"), false);
    assert.strictEqual(isFingerprintExcludedPathV1("package.json"), false);
  });

  void it("computes tree fingerprint and detects working-tree edits, staged changes, and untracked files", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-tree-fp-test-"));
    try {
      childProcess.execSync("git init", { cwd: tmpDir, stdio: "ignore" });
      childProcess.execSync("git config user.name 'Test User'", { cwd: tmpDir, stdio: "ignore" });
      childProcess.execSync("git config user.email 'test@example.com'", { cwd: tmpDir, stdio: "ignore" });

      fs.writeFileSync(path.join(tmpDir, "file1.txt"), "hello\n", "utf8");
      childProcess.execSync("git add file1.txt", { cwd: tmpDir, stdio: "ignore" });
      childProcess.execSync("git commit -m 'initial'", { cwd: tmpDir, stdio: "ignore" });

      const fpBaseline = await computeTreeFingerprintV1(tmpDir);
      assert.ok(fpBaseline, "expected baseline fingerprint");

      // Repeated computation is deterministic
      const fpBaseline2 = await computeTreeFingerprintV1(tmpDir);
      assert.strictEqual(fpBaseline, fpBaseline2);

      // Excluded paths (build output, logs) do not change fingerprint
      fs.mkdirSync(path.join(tmpDir, "dist"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "dist", "bundle.js"), "compiled output\n", "utf8");
      fs.mkdirSync(path.join(tmpDir, "runs"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "runs", "raw-check-output.log"), "check output\n", "utf8");
      const fpAfterExcluded = await computeTreeFingerprintV1(tmpDir);
      assert.strictEqual(fpAfterExcluded, fpBaseline, "excluded paths must not alter fingerprint");

      // Colliding source paths (e.g. src/runs/runner.ts) MUST alter fingerprint
      fs.mkdirSync(path.join(tmpDir, "src", "runs"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "src", "runs", "runner.ts"), "export const run = 1;\n", "utf8");
      childProcess.execSync("git add src/runs/runner.ts && git commit -m 'add runner'", { cwd: tmpDir, stdio: "ignore" });
      const fpWithRunner = await computeTreeFingerprintV1(tmpDir);
      assert.notStrictEqual(fpWithRunner, fpBaseline);

      fs.writeFileSync(path.join(tmpDir, "src", "runs", "runner.ts"), "export const run = 2;\n", "utf8");
      const fpRunnerEdited = await computeTreeFingerprintV1(tmpDir);
      assert.notStrictEqual(fpRunnerEdited, fpWithRunner, "edits to src/runs/runner.ts must alter fingerprint");
      fs.writeFileSync(path.join(tmpDir, "src", "runs", "runner.ts"), "export const run = 1;\n", "utf8");

      // 1. Uncommitted working-tree edit to tracked file changes fingerprint
      fs.writeFileSync(path.join(tmpDir, "file1.txt"), "hello modified\n", "utf8");
      const fpModified = await computeTreeFingerprintV1(tmpDir);
      assert.notStrictEqual(fpModified, fpBaseline, "working-tree edit must alter fingerprint");

      // Revert edit
      fs.writeFileSync(path.join(tmpDir, "file1.txt"), "hello\n", "utf8");
      const fpReverted = await computeTreeFingerprintV1(tmpDir);
      assert.strictEqual(fpReverted, fpWithRunner);

      // 2. Staged change changes fingerprint
      fs.writeFileSync(path.join(tmpDir, "file2.txt"), "staged file\n", "utf8");
      childProcess.execSync("git add file2.txt", { cwd: tmpDir, stdio: "ignore" });
      const fpStaged = await computeTreeFingerprintV1(tmpDir);
      assert.notStrictEqual(fpStaged, fpWithRunner, "staged change must alter fingerprint");

      // Unstage and remove file2
      childProcess.execSync("git rm -f file2.txt", { cwd: tmpDir, stdio: "ignore" });
      const fpUnstaged = await computeTreeFingerprintV1(tmpDir);
      assert.strictEqual(fpUnstaged, fpWithRunner);

      // 3. Untracked non-ignored file changes fingerprint
      fs.writeFileSync(path.join(tmpDir, "untracked.ts"), "const a = 1;\n", "utf8");
      const fpUntracked = await computeTreeFingerprintV1(tmpDir);
      assert.notStrictEqual(fpUntracked, fpWithRunner, "untracked non-ignored file must alter fingerprint");

      // Gitignored untracked file does not change fingerprint
      fs.unlinkSync(path.join(tmpDir, "untracked.ts"));
      fs.writeFileSync(path.join(tmpDir, ".gitignore"), "*.ignored\n", "utf8");
      childProcess.execSync("git add .gitignore && git commit -m 'add gitignore'", { cwd: tmpDir, stdio: "ignore" });
      const fpWithIgnore = await computeTreeFingerprintV1(tmpDir);
      fs.writeFileSync(path.join(tmpDir, "foo.ignored"), "ignore me\n", "utf8");
      const fpIgnored = await computeTreeFingerprintV1(tmpDir);
      assert.strictEqual(fpIgnored, fpWithIgnore, "ignored untracked file must not alter fingerprint");
    } finally {
      safeRemoveDir(tmpDir);
    }
  });

  void it("checkPublishChecksReuseEligibilityV1 verifies reuse eligibility correctly", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-reuse-eligibility-"));
    try {
      childProcess.execSync("git init", { cwd: tmpDir, stdio: "ignore" });
      childProcess.execSync("git config user.name 'Test User'", { cwd: tmpDir, stdio: "ignore" });
      childProcess.execSync("git config user.email 'test@example.com'", { cwd: tmpDir, stdio: "ignore" });
      fs.writeFileSync(path.join(tmpDir, "index.ts"), "export const x = 42;\n", "utf8");
      childProcess.execSync("git add index.ts && git commit -m 'init'", { cwd: tmpDir, stdio: "ignore" });
      const headSha = childProcess.execSync("git rev-parse HEAD", { cwd: tmpDir, encoding: "utf8" }).trim();

      const taskFolder = path.join(tmpDir, ".ensemble", "2026-10-24_task_1");
      fs.mkdirSync(taskFolder, { recursive: true });
      const taskFolderUri = vscode.Uri.file(taskFolder);
      const fp = await computeTreeFingerprintV1(tmpDir);

      // 1. Fresh stamp with matching fingerprint -> eligible
      await writePublishChecksFreshnessStampV1(taskFolderUri, {
        formatVersion: 1,
        runId: "run-abc",
        verifiedCommitSha: headSha,
        completedAt: new Date().toISOString(),
        scopeId: computePublishScopeId(tmpDir),
        treeFingerprint: fp,
      });

      const eligible = await checkPublishChecksReuseEligibilityV1(taskFolderUri, tmpDir, headSha);
      assert.strictEqual(eligible.eligible, true);
      assert.strictEqual(eligible.stamp?.runId, "run-abc");

      // 2. Working tree edited -> ineligible
      fs.writeFileSync(path.join(tmpDir, "index.ts"), "export const x = 99;\n", "utf8");
      const ineligibleDirty = await checkPublishChecksReuseEligibilityV1(taskFolderUri, tmpDir, headSha);
      assert.strictEqual(ineligibleDirty.eligible, false);
      assert.match(ineligibleDirty.reason ?? "", /Working tree fingerprint has changed/);

      // Revert edit
      fs.writeFileSync(path.join(tmpDir, "index.ts"), "export const x = 42;\n", "utf8");

      // 3. Older stamp without treeFingerprint -> ineligible for reuse
      await writePublishChecksFreshnessStampV1(taskFolderUri, {
        formatVersion: 1,
        runId: "run-older",
        verifiedCommitSha: headSha,
        completedAt: new Date().toISOString(),
        scopeId: computePublishScopeId(tmpDir),
      });

      const ineligibleNoFp = await checkPublishChecksReuseEligibilityV1(taskFolderUri, tmpDir, headSha);
      assert.strictEqual(ineligibleNoFp.eligible, false);
      assert.match(ineligibleNoFp.reason ?? "", /ineligible for reuse/);
    } finally {
      safeRemoveDir(tmpDir);
    }
  });

  void it("checkAndReviewPublish skips Publish Checks when fresh and goes straight to review", async () => {
    const executedCommands: { command: string; args: unknown[] }[] = [];
    const deps = {
      isPublishChecksFresh: (): Promise<boolean> => Promise.resolve(true),
      executeCommand: (command: string, ...args: unknown[]): Promise<unknown> => {
        executedCommands.push({ command, args });
        return Promise.resolve(undefined);
      },
    };

    const outcome = await checkAndReviewPublishV1({ taskFolderPath: "/dummy/task" }, deps);
    assert.strictEqual(outcome, "review-dispatched");
    assert.strictEqual(executedCommands.length, 1);
    assert.strictEqual(executedCommands[0]?.command, "vs-code-ai-helper.runReviewWithAI");
  });

  void it("checkAndReviewPublish runs Publish Checks first when checks are not fresh", async () => {
    const executedCommands: { command: string; args: unknown[] }[] = [];
    let checksFresh = false;
    const deps = {
      isPublishChecksFresh: (): Promise<boolean> => Promise.resolve(checksFresh),
      executeCommand: (command: string, ...args: unknown[]): Promise<unknown> => {
        executedCommands.push({ command, args });
        if (command === "vs-code-ai-helper.runPublishChecks") {
          checksFresh = true;
        }
        return Promise.resolve(undefined);
      },
    };

    const outcome = await checkAndReviewPublishV1({ taskFolderPath: "/dummy/task" }, deps);
    assert.strictEqual(outcome, "review-dispatched");
    assert.strictEqual(executedCommands.length, 2);
    assert.strictEqual(executedCommands[0]?.command, "vs-code-ai-helper.runPublishChecks");
    assert.strictEqual(executedCommands[1]?.command, "vs-code-ai-helper.runReviewWithAI");
  });

  void it("parseRecordedCompletionChecksEvidenceV1 parses and preserves evidence fields", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-parse-evidence-"));
    try {
      const taskFolderUri = vscode.Uri.file(tmpDir);
      const mockResult: CompletionLintResult = {
        passed: true,
        passedModuloKnownFlakes: true,
        issueCount: 0,
        summary: "All 15 checks passed.",
        failedChecks: [],
        missingScripts: ["test:perf"],
        retriedPasses: [{ command: "pnpm run test:flaky", retryCount: 1 }],
        commandsRun: ["pnpm run lint", "pnpm run test"],
        monorepoDetected: true,
        monorepoChecks: [
          { packageDir: "apps/mobile", command: "pnpm run lint", passed: true, exitCode: 0 },
        ],
        verificationEnvironment: {
          cwd: "/workspace/project",
          packageManager: "pnpm 9.1.0",
          envVarNames: ["CI", "NODE_ENV"],
        },
        checkSet: "full",
        runAt: "2026-10-24T18:00:00.000Z",
        verifiedFolder: "/workspace/project",
      };

      await upsertCompletionChecksReportV1(taskFolderUri, mockResult);
      const content = await readPublishChecksFile(taskFolderUri);
      const parsed = parseRecordedCompletionChecksEvidenceV1(content);
      assert.ok(parsed, "expected parsed result");
      assert.strictEqual(parsed.passed, true);
      assert.strictEqual(parsed.runAt, mockResult.runAt);
      assert.strictEqual(parsed.verifiedFolder, mockResult.verifiedFolder);
      assert.deepEqual(parsed.commandsRun, ["pnpm run lint", "pnpm run test"]);
      assert.deepEqual(parsed.missingScripts, ["test:perf"]);
      assert.deepEqual(parsed.retriedPasses, [{ command: "pnpm run test:flaky", retryCount: 1 }]);
      assert.strictEqual(parsed.verificationEnvironment?.cwd, "/workspace/project");
      assert.strictEqual(parsed.verificationEnvironment?.packageManager, "pnpm 9.1.0");
      assert.deepEqual(parsed.verificationEnvironment?.envVarNames, ["CI", "NODE_ENV"]);
      assert.strictEqual(parsed.monorepoDetected, true);
      assert.strictEqual(parsed.monorepoChecks?.length, 1);
      assert.strictEqual(parsed.monorepoChecks[0]?.packageDir, "apps/mobile");
    } finally {
      safeRemoveDir(tmpDir);
    }
  });

  void it("parseRecordedCompletionChecksEvidenceV1 handles missing or failing evidence", () => {
    assert.strictEqual(parseRecordedCompletionChecksEvidenceV1("no section here"), undefined);

    const failingSection =
      "<!-- completion-checks:start -->\n" +
      "### Completion Checks\n\n" +
      "- Status: Failed\n" +
      "- Last run: 2026-10-24T18:00:00.000Z\n" +
      "- Summary: 1 check failed.\n" +
      "<!-- completion-checks:end -->\n";
    const parsedFailing = parseRecordedCompletionChecksEvidenceV1(failingSection);
    assert.ok(parsedFailing);
    assert.strictEqual(parsedFailing.passed, false);
    assert.strictEqual(parsedFailing.passedModuloKnownFlakes, false);
  });

  void it("buildVerifiedChecksVariable reuses fresh passing Publish Checks and cites run", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-reuse-verified-"));
    const origReadFile = (vscode.workspace.fs as unknown as Record<string, unknown>).readFile;
    (vscode.workspace.fs as unknown as Record<string, unknown>).readFile = (
      uri: vscode.Uri
    ): Promise<Uint8Array> =>
      fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
    try {
      childProcess.execSync("git init", { cwd: tmpDir, stdio: "ignore" });
      childProcess.execSync("git config user.name 'Test User'", { cwd: tmpDir, stdio: "ignore" });
      childProcess.execSync("git config user.email 'test@example.com'", { cwd: tmpDir, stdio: "ignore" });
      fs.writeFileSync(path.join(tmpDir, "file.ts"), "export const a = 1;\n", "utf8");
      childProcess.execSync("git add file.ts && git commit -m 'init'", { cwd: tmpDir, stdio: "ignore" });
      const headSha = childProcess.execSync("git rev-parse HEAD", { cwd: tmpDir, encoding: "utf8" }).trim();

      const taskFolder = path.join(tmpDir, ".ensemble", "2026-10-24_task_1");
      fs.mkdirSync(taskFolder, { recursive: true });
      const taskFolderUri = vscode.Uri.file(taskFolder);
      const fp = await computeTreeFingerprintV1(tmpDir);

      // Write task-progress.json with stage: publish and projectRoot: tmpDir
      fs.writeFileSync(
        path.join(taskFolder, "task-progress.json"),
        JSON.stringify({
          taskFolder: "2026-10-24_task_1",
          currentStage: "publish",
          status: "active",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          ownership: {
            metaRoot: path.dirname(taskFolder),
            projectRoot: tmpDir,
            boundAt: "2026-07-01T09:00:00.000Z",
            state: "resolved",
          },
        }, null, 2),
        "utf8"
      );

      // Write passing completion checks to publish-review.md
      const passingResult: CompletionLintResult = {
        passed: true,
        passedModuloKnownFlakes: true,
        issueCount: 0,
        summary: "All checks passed.",
        failedChecks: [],
        missingScripts: [],
        commandsRun: ["pnpm run verify"],
        verificationEnvironment: {
          cwd: tmpDir,
          packageManager: "pnpm 9.1.0",
          envVarNames: ["NODE_ENV"],
        },
        checkSet: "full",
        runAt: "2026-10-24T18:00:00.000Z",
        verifiedFolder: tmpDir,
      };
      await upsertCompletionChecksReportV1(taskFolderUri, passingResult);

      // Write freshness stamp with matching fingerprint
      await writePublishChecksFreshnessStampV1(taskFolderUri, {
        formatVersion: 1,
        runId: "publish-run-999",
        verifiedCommitSha: headSha,
        completedAt: new Date().toISOString(),
        scopeId: computePublishScopeId(tmpDir),
        treeFingerprint: fp,
      });

      // 1. Entry gate checkPublishChecksFreshnessV1 is valid
      const gate = await checkPublishChecksFreshnessV1(taskFolderUri, tmpDir, headSha);
      assert.strictEqual(gate.status, "valid");

      // 2. buildVerifiedChecksVariable reuses results and cites run
      const checks = await buildVerifiedChecksVariable(taskFolderUri, [], undefined, false, "publish", headSha);
      assert.ok(checks.reusedPublishChecks, "expected checks to be reused");
      assert.strictEqual(checks.reusedPublishChecks.runId, "publish-run-999");
      assert.strictEqual(checks.reusedPublishChecks.treeFingerprint, fp);
      assert.ok(checks.verifiedChecks.includes("Reused recorded passing Publish Checks run `publish-run-999`"));
      assert.ok(checks.verifiedChecks.includes("pnpm run verify"));

      // 3. Uncommitted working tree edit causes fallback to running suite (reuse is not eligible, but entry gate still passes)
      fs.writeFileSync(path.join(tmpDir, "file.ts"), "export const a = 2;\n", "utf8");
      // Entry gate still reports valid because commit SHA matches
      const gateAfterEdit = await checkPublishChecksFreshnessV1(taskFolderUri, tmpDir, headSha);
      assert.strictEqual(gateAfterEdit.status, "valid");

      // Reuse eligibility check reflects dirty tree
      const eligibilityAfterEdit = await checkPublishChecksReuseEligibilityV1(taskFolderUri, tmpDir, headSha);
      assert.strictEqual(eligibilityAfterEdit.eligible, false);

      // 4. Missing or failed completion checks report in publish-review.md causes fallback
      fs.writeFileSync(path.join(tmpDir, "file.ts"), "export const a = 1;\n", "utf8"); // revert edit
      // Overwrite publish-review.md with no completion checks section
      fs.writeFileSync(path.join(taskFolder, "publish-review.md"), "# Publish Review\n\nNo checks section\n", "utf8");
      // Add valid stamp back
      await writePublishChecksFreshnessStampV1(taskFolderUri, {
        formatVersion: 1,
        runId: "publish-run-999",
        verifiedCommitSha: headSha,
        completedAt: new Date().toISOString(),
        scopeId: computePublishScopeId(tmpDir),
        treeFingerprint: fp,
      });
      const checksWithoutEvidence = await buildVerifiedChecksVariable(taskFolderUri, [], undefined, false, "publish", headSha);
      // Because evidence is missing, reusedPublishChecks is undefined (falls back to running suite)
      assert.strictEqual(checksWithoutEvidence.reusedPublishChecks, undefined);
    } finally {
      (vscode.workspace.fs as unknown as Record<string, unknown>).readFile = origReadFile;
      safeRemoveDir(tmpDir);
    }
  });

  void it("revalidatePublishFreshnessOrThrowV1 detects working tree fingerprint changes before promotion", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-reval-fp-test-"));
    const origReadFile = (vscode.workspace.fs as unknown as Record<string, unknown>).readFile;
    (vscode.workspace.fs as unknown as Record<string, unknown>).readFile = (
      uri: vscode.Uri
    ): Promise<Uint8Array> =>
      fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
    try {
      childProcess.execSync("git init", { cwd: tmpDir, stdio: "ignore" });
      childProcess.execSync("git config user.name 'Test User'", { cwd: tmpDir, stdio: "ignore" });
      childProcess.execSync("git config user.email 'test@example.com'", { cwd: tmpDir, stdio: "ignore" });
      fs.writeFileSync(path.join(tmpDir, "file.ts"), "export const a = 1;\n", "utf8");
      childProcess.execSync("git add file.ts && git commit -m 'init'", { cwd: tmpDir, stdio: "ignore" });
      const headSha = childProcess.execSync("git rev-parse HEAD", { cwd: tmpDir, encoding: "utf8" }).trim();

      const taskFolder = path.join(tmpDir, ".ensemble", "2026-10-24_task_1");
      fs.mkdirSync(taskFolder, { recursive: true });
      const taskFolderUri = vscode.Uri.file(taskFolder);
      const fp = await computeTreeFingerprintV1(tmpDir);

      const runId = "test-reval-run-1";
      await writePublishChecksFreshnessStampV1(taskFolderUri, {
        formatVersion: 1,
        runId,
        verifiedCommitSha: headSha,
        completedAt: new Date().toISOString(),
        scopeId: computePublishScopeId(tmpDir),
        treeFingerprint: fp,
      });

      const guard = {
        taskFolderPath: taskFolder,
        scopeFolderPath: tmpDir,
        runId,
        verifiedCommitSha: headSha,
        treeFingerprint: fp,
      };

      // 1. Revalidation succeeds when fingerprint unchanged
      await assert.doesNotReject(() => revalidatePublishFreshnessOrThrowV1(guard));

      // 2. Working tree changed before promotion -> throws ReviewPromotionErrorV1
      fs.writeFileSync(path.join(tmpDir, "file.ts"), "export const a = 2;\n", "utf8");
      await assert.rejects(
        () => revalidatePublishFreshnessOrThrowV1(guard),
        (err) => err instanceof ReviewPromotionErrorV1 && err.message.includes("working tree changed")
      );
    } finally {
      (vscode.workspace.fs as unknown as Record<string, unknown>).readFile = origReadFile;
      safeRemoveDir(tmpDir);
    }
  });

  void it("rejects reuse when recorded Completion Checks evidence failed or has no commands run", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-failed-evidence-test-"));
    const origReadFile = (vscode.workspace.fs as unknown as Record<string, unknown>).readFile;
    (vscode.workspace.fs as unknown as Record<string, unknown>).readFile = (
      uri: vscode.Uri
    ): Promise<Uint8Array> =>
      fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
    try {
      childProcess.execSync("git init", { cwd: tmpDir, stdio: "ignore" });
      childProcess.execSync("git config user.name 'Test User'", { cwd: tmpDir, stdio: "ignore" });
      childProcess.execSync("git config user.email 'test@example.com'", { cwd: tmpDir, stdio: "ignore" });
      fs.writeFileSync(path.join(tmpDir, "file.ts"), "export const a = 1;\n", "utf8");
      childProcess.execSync("git add file.ts && git commit -m 'init'", { cwd: tmpDir, stdio: "ignore" });
      const headSha = childProcess.execSync("git rev-parse HEAD", { cwd: tmpDir, encoding: "utf8" }).trim();

      const taskFolder = path.join(tmpDir, ".ensemble", "2026-10-24_task_1");
      fs.mkdirSync(taskFolder, { recursive: true });
      const taskFolderUri = vscode.Uri.file(taskFolder);
      const fp = await computeTreeFingerprintV1(tmpDir);

      // Write failing completion checks
      const failingResult: CompletionLintResult = {
        passed: false,
        passedModuloKnownFlakes: false,
        issueCount: 1,
        summary: "1 check failed.",
        failedChecks: [{ command: "npm test", exitCode: 1, output: "FAIL" }],
        missingScripts: [],
        commandsRun: ["npm test"],
        checkSet: "full",
        runAt: new Date().toISOString(),
        verifiedFolder: tmpDir,
      };
      await upsertCompletionChecksReportV1(taskFolderUri, failingResult);

      await writePublishChecksFreshnessStampV1(taskFolderUri, {
        formatVersion: 1,
        runId: "run-failed-evidence",
        verifiedCommitSha: headSha,
        completedAt: new Date().toISOString(),
        scopeId: computePublishScopeId(tmpDir),
        treeFingerprint: fp,
      });

      const eligibility = await checkPublishChecksReuseEligibilityV1(
        taskFolderUri,
        tmpDir,
        headSha,
        (content) => {
          const recorded = parseRecordedCompletionChecksEvidenceV1(content);
          return Boolean(
            recorded &&
            recorded.passed === true &&
            (recorded.passedModuloKnownFlakes ?? recorded.passed) &&
            recorded.commandsRun &&
            recorded.commandsRun.length > 0 &&
            (!recorded.failedChecks || recorded.failedChecks.length === 0)
          );
        }
      );

      assert.strictEqual(eligibility.eligible, false);
      assert.match(eligibility.reason ?? "", /Recorded Completion Checks evidence is missing, failed, or unreadable/);
    } finally {
      (vscode.workspace.fs as unknown as Record<string, unknown>).readFile = origReadFile;
      safeRemoveDir(tmpDir);
    }
  });

  void it("revalidates a hand-built fix stamp through hand-off, review reuse and intervening changes (the connected fix-rerun path is in publishFixToReviewReuseV1.test.ts)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-combined-fix-reuse-test-"));
    const origReadFile = (vscode.workspace.fs as unknown as Record<string, unknown>).readFile;
    (vscode.workspace.fs as unknown as Record<string, unknown>).readFile = (
      uri: vscode.Uri
    ): Promise<Uint8Array> =>
      fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
    try {
      childProcess.execSync("git init", { cwd: tmpDir, stdio: "ignore" });
      childProcess.execSync("git config user.name 'Test User'", { cwd: tmpDir, stdio: "ignore" });
      childProcess.execSync("git config user.email 'test@example.com'", { cwd: tmpDir, stdio: "ignore" });
      fs.writeFileSync(path.join(tmpDir, "file.ts"), "export const a = 1;\n", "utf8");
      childProcess.execSync("git add file.ts && git commit -m 'init'", { cwd: tmpDir, stdio: "ignore" });
      const headSha = childProcess.execSync("git rev-parse HEAD", { cwd: tmpDir, encoding: "utf8" }).trim();

      const taskFolder = path.join(tmpDir, ".ensemble", "2026-10-24_task_1");
      fs.mkdirSync(taskFolder, { recursive: true });
      const taskFolderUri = vscode.Uri.file(taskFolder);
      const fp = await computeTreeFingerprintV1(tmpDir);

      // Write task-progress.json with stage: publish and projectRoot: tmpDir
      fs.writeFileSync(
        path.join(taskFolder, "task-progress.json"),
        JSON.stringify({
          taskFolder: "2026-10-24_task_1",
          currentStage: "publish",
          status: "active",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          ownership: {
            metaRoot: path.dirname(taskFolder),
            projectRoot: tmpDir,
            boundAt: "2026-07-01T09:00:00.000Z",
            state: "resolved",
          },
        }, null, 2),
        "utf8"
      );

      // 1. Successful fix execution: drives coordinator with passing checks and fix success
      let scheduledCommand: string | undefined;
      const coordinator = createPublishFixReleaseCoordinatorV1({
        getTaskFolderUri: () => taskFolderUri,
        getLockKey: () => taskFolder,
        getHandle: () => undefined,
        onAdmissionHeld: () => undefined,
        onAdmissionReleased: () => undefined,
        safeReleaseState: { released: true, releaseRequested: false, releaseHeldWarned: false },
        getFinalChecks: () => ({ passed: true, failedChecks: [] }),
        getFixSucceeded: () => true,
        scheduleChain: (dispatch) => {
          scheduledCommand = dispatch.command;
          return Promise.resolve(true);
        },
        showInformation: () => undefined,
        showWarning: () => undefined,
      });

      await coordinator.finishPublishFix();
      assert.strictEqual(coordinator.isPublishReviewOwed(), false);
      assert.strictEqual(scheduledCommand, "vs-code-ai-helper.checkAndReviewPublish");

      // Write passing completion checks evidence and matching freshness stamp
      const passingResult: CompletionLintResult = {
        passed: true,
        passedModuloKnownFlakes: true,
        issueCount: 0,
        summary: "All checks passed.",
        failedChecks: [],
        missingScripts: [],
        commandsRun: ["pnpm run test:unit"],
        verificationEnvironment: {
          cwd: tmpDir,
          packageManager: "pnpm 9.1.0",
          envVarNames: ["NODE_ENV"],
        },
        checkSet: "full",
        runAt: new Date().toISOString(),
        verifiedFolder: tmpDir,
      };
      await upsertCompletionChecksReportV1(taskFolderUri, passingResult);

      const runId = "fix-rerun-pass-789";
      await writePublishChecksFreshnessStampV1(taskFolderUri, {
        formatVersion: 1,
        runId,
        verifiedCommitSha: headSha,
        completedAt: new Date().toISOString(),
        scopeId: computePublishScopeId(tmpDir),
        treeFingerprint: fp,
      });

      // 2. checkAndReviewPublish skips Publish Checks when fresh and goes straight to review
      const executedCommands: string[] = [];
      const outcome = await checkAndReviewPublishV1(
        { taskFolderPath: taskFolder },
        {
          isPublishChecksFresh: () => Promise.resolve(true),
          executeCommand: (cmd) => {
            executedCommands.push(cmd);
            return Promise.resolve(undefined);
          },
        }
      );
      assert.strictEqual(outcome, "review-dispatched");
      assert.strictEqual(
        executedCommands.includes("vs-code-ai-helper.runPublishChecks"),
        false,
        "intermediate Publish Checks must NOT run when fresh passing results exist"
      );
      assert.strictEqual(
        executedCommands.includes("vs-code-ai-helper.runReviewWithAI"),
        true,
        "must dispatch review directly"
      );

      // 3. buildVerifiedChecksVariable reuses recorded passing results without running suite
      const verified = await buildVerifiedChecksVariable(taskFolderUri, [], undefined, false, "publish", headSha);
      assert.ok(verified.reusedPublishChecks, "must reuse recorded passing Publish Checks");
      assert.strictEqual(verified.reusedPublishChecks?.runId, runId);
      assert.strictEqual(verified.reusedPublishChecks?.treeFingerprint, fp);
      assert.ok(verified.verifiedChecks.includes(runId), "review prompt must cite reused run ID");
      assert.ok(verified.verifiedChecks.includes("Reused recorded passing Publish Checks run"));

      // 4. Retain and revalidate consumed run identity through dispatch and save
      const guard = {
        taskFolderPath: taskFolder,
        scopeFolderPath: tmpDir,
        runId: verified.reusedPublishChecks.runId,
        verifiedCommitSha: headSha,
        treeFingerprint: verified.reusedPublishChecks.treeFingerprint,
      };

      // Clean tree with matching runId -> save-time validation succeeds
      await revalidatePublishFreshnessOrThrowV1(guard);

      // Intervening run ID mismatch: if another run finished with a different runId,
      // dispatch revalidation prevents citing the old run
      assert.strictEqual(
        isReusedPublishChecksRunStillCurrentV1(verified.reusedPublishChecks.runId, "new-run-999"),
        false
      );
      assert.strictEqual(
        isReusedPublishChecksRunStillCurrentV1(verified.reusedPublishChecks.runId, undefined),
        false
      );
      assert.strictEqual(
        isReusedPublishChecksRunStillCurrentV1(verified.reusedPublishChecks.runId, runId),
        true
      );

      // Intervening tracked edit invalidates fingerprint -> save-time promotion throws ReviewPromotionErrorV1
      fs.writeFileSync(path.join(tmpDir, "file.ts"), "export const a = 42;\n", "utf8");
      await assert.rejects(
        () => revalidatePublishFreshnessOrThrowV1(guard),
        ReviewPromotionErrorV1
      );

      // Intervening commit -> checkPublishChecksFreshnessV1 returns staleCommit refusal
      childProcess.execSync("git add file.ts && git commit -m 'intervening edit commit'", {
        cwd: tmpDir,
        stdio: "ignore",
      });
      const newHeadSha = childProcess.execSync("git rev-parse HEAD", {
        cwd: tmpDir,
        encoding: "utf8",
      }).trim();
      const checkStale = await checkPublishChecksFreshnessV1(taskFolderUri, tmpDir, newHeadSha);
      assert.strictEqual(checkStale.status, "staleCommit");
    } finally {
      (vscode.workspace.fs as unknown as Record<string, unknown>).readFile = origReadFile;
      safeRemoveDir(tmpDir);
    }
  });
});
