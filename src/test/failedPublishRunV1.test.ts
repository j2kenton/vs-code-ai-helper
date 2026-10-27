import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { CompletionLintResult } from "../utils/completionLint";
import { buildFailedPublishFirstTargetsV1, buildFailedPublishRunSnapshotV1, isFailedPublishRunCompatibleV1, writeFailedPublishRunSnapshotV1, type FailedPublishRunSnapshotV1 } from "../utils/failedPublishRunV1";

void describe("failed Publish run evidence", () => {
  void it("persists command, runner, scope, HEAD, and failing test-file identities", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-failed-publish-")).replace(/\\/g, "/");
    const task = path.join(root, ".ensemble", "task-a");
    const member = path.join(root, "packages", "core");
    fs.mkdirSync(member, { recursive: true });
    fs.mkdirSync(task, { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
      packageManager: "pnpm@10.34.5",
      scripts: {
        "test:unit": 'node -e "require(\'fs\').rmSync(\'out/test\',{recursive:true,force:true})" && tsc --project tsconfig.test.json && node test-stubs/run-unit-tests.js',
        test: "npm run test:unit",
        verify: "npm-run-all -s check-types lint test verify:workflow-safety",
      },
    }));
    fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    fs.writeFileSync(path.join(root, "tsconfig.test.json"), "{}\n");
    fs.writeFileSync(path.join(root, "tsconfig.vscode-1.93-compat.json"), "{\"compilerOptions\":{}}\n");
    fs.writeFileSync(path.join(root, ".eslintrc.json"), "{}\n");
    fs.mkdirSync(path.join(root, "test-stubs", "vscode"), { recursive: true });
    fs.writeFileSync(path.join(root, "test-stubs/register.js"), "// test harness\n");
    fs.writeFileSync(path.join(root, "test-stubs/run-unit-tests.js"), "// test harness\n");
    fs.writeFileSync(path.join(root, "test-stubs/repoLeakCheck.js"), "// leak guard\n");
    fs.writeFileSync(path.join(root, "test-stubs", "vscode", "index.js"), "// VS Code stub\n");
    fs.writeFileSync(path.join(member, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    const result: CompletionLintResult = {
      runAt: "2026-10-26T20:00:00.000Z",
      passed: false,
      summary: "one test failed",
      issueCount: 1,
      missingScripts: [],
      commandsRun: ["pnpm run verify", "[packages/core] pnpm test"],
      verifiedFolder: root,
      verificationEnvironment: { cwd: root, packageManager: "pnpm 10.18.1", envVarNames: ["CI"] },
      failedChecks: [{
        command: "[packages/core] pnpm test",
        exitCode: 1,
        output: "Failing tests (1): bounded display output",
        failingTests: { total: 1, tests: [{ file: "packages/core/out/test/core.test.js", title: "fails" }] },
      }],
    };
    try {
      const snapshot = buildFailedPublishRunSnapshotV1({
        taskFolder: task,
        repositoryRoot: root,
        verificationScopeId: "scope-1",
        headCommit: "a".repeat(40),
        result,
      });
      assert.equal(snapshot.headCommit, "a".repeat(40));
      assert.equal(snapshot.verificationScopeId, "scope-1");
      assert.equal(snapshot.commands[1]?.cwd, member);
      assert.deepEqual(snapshot.failures[0]?.testFiles, ["packages/core/out/test/core.test.js"]);
      assert.ok(snapshot.observedInputFingerprint);
      assert.equal(snapshot.compatibilityUnknownReason, null, "complete command/runner/toolchain evidence authorizes comparison on a later run");
      assert.ok(snapshot.compatibilityFingerprint);
      assert.equal(isFailedPublishRunCompatibleV1(snapshot, snapshot), true);
      assert.equal(isFailedPublishRunCompatibleV1(snapshot, {
        ...snapshot,
        configuredCommands: ["pnpm run verify"],
      }), false, "an explicit verification command setting change requires a full run");
      assert.equal(isFailedPublishRunCompatibleV1(snapshot, {
        ...snapshot,
        configuredCommands: undefined,
      }), false, "legacy evidence without selected-command provenance is unknown");

      const ordinarySource = path.join(root, "src", "feature.ts");
      fs.mkdirSync(path.dirname(ordinarySource), { recursive: true });
      fs.writeFileSync(ordinarySource, "export const before = true;\n");
      const ordinarySourceEdit = buildFailedPublishRunSnapshotV1({
        taskFolder: task, repositoryRoot: root, verificationScopeId: "scope-1", headCommit: "a".repeat(40), result,
      });
      fs.writeFileSync(ordinarySource, "export const after = true;\n");
      const laterOrdinarySourceEdit = buildFailedPublishRunSnapshotV1({
        taskFolder: task, repositoryRoot: root, verificationScopeId: "scope-1", headCommit: "a".repeat(40), result,
      });
      assert.equal(isFailedPublishRunCompatibleV1(snapshot, ordinarySourceEdit), true);
      assert.equal(isFailedPublishRunCompatibleV1(snapshot, laterOrdinarySourceEdit), true,
        "ordinary application-source edits at the same HEAD do not invalidate failed-first eligibility");

      const changedRunnerVersion = buildFailedPublishRunSnapshotV1({
        taskFolder: task, repositoryRoot: root, verificationScopeId: "scope-1", headCommit: "a".repeat(40),
        result: {
          ...result,
          verificationEnvironment: { ...result.verificationEnvironment!, packageManager: "pnpm 10.18.2" },
        },
      });
      assert.equal(isFailedPublishRunCompatibleV1(snapshot, changedRunnerVersion), false,
        "the current package-manager version, not the saved version, controls compatibility");

      const reorderedCommands = buildFailedPublishRunSnapshotV1({
        taskFolder: task, repositoryRoot: root, verificationScopeId: "scope-1", headCommit: "a".repeat(40),
        result: { ...result, commandsRun: [...(result.commandsRun ?? [])].reverse() },
      });
      assert.equal(isFailedPublishRunCompatibleV1(snapshot, reorderedCommands), false,
        "the ordered command plan is part of compatibility");
      const otherMember = path.join(root, "packages", "other");
      fs.mkdirSync(otherMember, { recursive: true });
      fs.writeFileSync(path.join(otherMember, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
      const changedWorkingDirectory = buildFailedPublishRunSnapshotV1({
        taskFolder: task, repositoryRoot: root, verificationScopeId: "scope-1", headCommit: "a".repeat(40),
        result: { ...result, commandsRun: ["pnpm run verify", "[packages/other] pnpm test"] },
      });
      assert.equal(isFailedPublishRunCompatibleV1(snapshot, changedWorkingDirectory), false,
        "a member command's working directory is part of compatibility");

      await writeFailedPublishRunSnapshotV1(task, snapshot);
      const stored = JSON.parse(fs.readFileSync(path.join(task, "runs", "failed-publish-run-v1.json"), "utf8")) as FailedPublishRunSnapshotV1;
      assert.equal(stored.observedInputFingerprint, snapshot.observedInputFingerprint);
      assert.equal(stored.failures[0]?.testFiles[0], "packages/core/out/test/core.test.js");

      fs.appendFileSync(path.join(root, "pnpm-lock.yaml"), "settings: changed\n");
      const changedInputs = buildFailedPublishRunSnapshotV1({
        taskFolder: task,
        repositoryRoot: root,
        verificationScopeId: "scope-1",
        headCommit: "a".repeat(40),
        result,
      });
      assert.notEqual(changedInputs.observedInputFingerprint, snapshot.observedInputFingerprint);
      assert.notEqual(changedInputs.compatibilityFingerprint, snapshot.compatibilityFingerprint);
      assert.equal(isFailedPublishRunCompatibleV1(snapshot, changedInputs), false);
      fs.writeFileSync(path.join(root, "tsconfig.test.json"), '{"outDir":"different-output"}\n');
      const changedPreparation = buildFailedPublishRunSnapshotV1({
        taskFolder: task,
        repositoryRoot: root,
        verificationScopeId: "scope-1",
        headCommit: "a".repeat(40),
        result,
      });
      assert.notEqual(changedPreparation.compatibilityFingerprint, changedInputs.compatibilityFingerprint,
        "the test compilation/output mapping is part of failed-first compatibility");
      fs.writeFileSync(path.join(root, "tsconfig.vscode-1.93-compat.json"), "{\"compilerOptions\":{\"strict\":true}}\n");
      const changedCompatConfig = buildFailedPublishRunSnapshotV1({
        taskFolder: task,
        repositoryRoot: root,
        verificationScopeId: "scope-1",
        headCommit: "a".repeat(40),
        result,
      });
      assert.notEqual(changedCompatConfig.compatibilityFingerprint, changedPreparation.compatibilityFingerprint,
        "a compatibility tsconfig consumed by verify:workflow-safety invalidates failed-first reuse");
      fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
      fs.writeFileSync(path.join(root, "scripts", "verify-checks.mjs"), "// original\n");
      const withScript = buildFailedPublishRunSnapshotV1({
        taskFolder: task,
        repositoryRoot: root,
        verificationScopeId: "scope-1",
        headCommit: "a".repeat(40),
        result,
      });
      fs.writeFileSync(path.join(root, "scripts", "verify-checks.mjs"), "// changed execution behavior\n");
      const changedScript = buildFailedPublishRunSnapshotV1({
        taskFolder: task,
        repositoryRoot: root,
        verificationScopeId: "scope-1",
        headCommit: "a".repeat(40),
        result,
      });
      assert.notEqual(changedScript.compatibilityFingerprint, withScript.compatibilityFingerprint,
        "transitive repository verification scripts invalidate failed-first reuse");
      fs.writeFileSync(path.join(root, ".eslintrc.json"), "{\"rules\":{}}\n");
      const changedLintConfig = buildFailedPublishRunSnapshotV1({
        taskFolder: task, repositoryRoot: root, verificationScopeId: "scope-1", headCommit: "a".repeat(40), result,
      });
      assert.notEqual(changedLintConfig.compatibilityFingerprint, changedScript.compatibilityFingerprint,
        "lint configuration consumed by the aggregate verify script invalidates failed-first reuse");
      fs.writeFileSync(path.join(root, "test-stubs", "vscode", "index.js"), "// changed VS Code stub\n");
      const changedVsCodeStub = buildFailedPublishRunSnapshotV1({
        taskFolder: task, repositoryRoot: root, verificationScopeId: "scope-1", headCommit: "a".repeat(40), result,
      });
      assert.notEqual(changedVsCodeStub.compatibilityFingerprint, changedLintConfig.compatibilityFingerprint,
        "the preload used by targeted tests invalidates failed-first reuse");
      fs.writeFileSync(path.join(root, "test-stubs/repoLeakCheck.js"), "// changed loaded leak guard\n");
      const changedLeakGuard = buildFailedPublishRunSnapshotV1({
        taskFolder: task, repositoryRoot: root, verificationScopeId: "scope-1", headCommit: "a".repeat(40), result,
      });
      assert.notEqual(changedLeakGuard.compatibilityFingerprint, changedVsCodeStub.compatibilityFingerprint,
        "the helper loaded by the unit harness invalidates failed-first reuse");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  void it("keeps failed identities but marks compatibility unknown when runner evidence is incomplete", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-failed-publish-unknown-")).replace(/\\/g, "/");
    try {
      const result: CompletionLintResult = {
        runAt: "2026-10-26T20:00:00.000Z",
        passed: false,
        summary: "failed",
        issueCount: 1,
        missingScripts: [],
        failedChecks: [{ command: "verify", exitCode: 1, output: "no structured test output" }],
      };
      const snapshot = buildFailedPublishRunSnapshotV1({
        taskFolder: path.join(root, "task"),
        repositoryRoot: root,
        verificationScopeId: "scope-1",
        result,
      });
      assert.equal(snapshot.observedInputFingerprint, null);
      assert.equal(snapshot.compatibilityFingerprint, null);
      assert.equal(snapshot.failures[0]?.command, "verify");
      const unknownVersion = buildFailedPublishRunSnapshotV1({
        taskFolder: path.join(root, "task"),
        repositoryRoot: root,
        verificationScopeId: "scope-1",
        headCommit: "a".repeat(40),
        result: {
          ...result,
          commandsRun: ["npm run verify"],
          verifiedFolder: root,
          verificationEnvironment: { cwd: root, packageManager: null, envVarNames: [] },
        },
      });
      assert.equal(unknownVersion.runner.packageManager, null);
      assert.equal(unknownVersion.compatibilityFingerprint, null,
        "an undiscovered package-manager version cannot authorize failed-first reuse");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  void it("builds a package-safe current-source test target and falls back to the whole failed command when unmappable", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-failed-publish-target-"));
    const source = path.join(root, "src", "test", "a.test.ts");
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, "// fixture\n");
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
      packageManager: "pnpm@10.34.5",
      scripts: {
        "test:unit": 'node -e "require(\'fs\').rmSync(\'out/test\',{recursive:true,force:true})" && tsc --project tsconfig.test.json && node test-stubs/run-unit-tests.js',
        test: "npm run test:unit",
        verify: "npm-run-all -s check-types lint test verify:workflow-safety",
      },
    }));
    fs.writeFileSync(path.join(root, "tsconfig.test.json"), "{}\n");
    fs.mkdirSync(path.join(root, "test-stubs"), { recursive: true });
    fs.writeFileSync(path.join(root, "test-stubs/register.js"), "// test harness\n");
    fs.writeFileSync(path.join(root, "test-stubs/run-unit-tests.js"), "// test harness\n");
    const snapshot: FailedPublishRunSnapshotV1 = {
      schemaVersion: 1,
      taskFolder: path.join(root, ".ensemble", "task"),
      repositoryRoot: root,
      verificationScopeId: "scope",
      headCommit: "a".repeat(40),
      failedAt: "2026-10-26T20:00:00.000Z",
      runner: { platform: "linux", nodeVersion: "v22", packageManager: "pnpm 10" },
      commands: [{ command: "pnpm run test:unit", cwd: root, phase: "test", exitCode: 1 }],
      configuredCommands: [],
      failures: [{ command: "pnpm run test:unit", exitCode: 1, testFiles: ["out/test/a.test.js"], failureCount: 1, completeFailureIdentities: true, unidentifiedFailureCount: 0 }],
      observedInputFingerprint: "observed",
      compatibilityUnknownReason: null,
      compatibilityFingerprint: "compatible",
    };
    try {
      const target = buildFailedPublishFirstTargetsV1(snapshot)[0];
      assert.deepEqual(target, {
        kind: "test-files",
        cwd: root,
        testFiles: ["out/test/a.test.js"],
        prepareCommand: "pnpm exec tsc --project tsconfig.test.json",
        command: "node --require ./test-stubs/register.js --test 'out/test/a.test.js'",
      });
      const secondSource = path.join(root, "src", "test", "b.test.ts");
      fs.writeFileSync(secondSource, "// second fixture\n");
      const multiple = buildFailedPublishFirstTargetsV1({
        ...snapshot,
        failures: [{
          ...snapshot.failures[0]!,
          testFiles: ["out/test/a.test.js", "out/test/b.test.js"],
          failureCount: 2,
        }],
      })[0];
      assert.deepEqual(multiple?.kind === "test-files" ? multiple.testFiles : undefined,
        ["out/test/a.test.js", "out/test/b.test.js"]);
      assert.equal(multiple?.kind === "test-files" ? multiple.command : undefined,
        "node --require ./test-stubs/register.js --test 'out/test/a.test.js' 'out/test/b.test.js'");
      fs.rmSync(source);
      const fallback = buildFailedPublishFirstTargetsV1(snapshot)[0];
      assert.equal(fallback?.kind, "failed-command");
      assert.equal(fallback?.command, "pnpm run test:unit");
      assert.equal(isFailedPublishRunCompatibleV1(snapshot, { ...snapshot, headCommit: "b".repeat(40) }), false);
      assert.equal(isFailedPublishRunCompatibleV1(snapshot, { ...snapshot, compatibilityFingerprint: null }), false);
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
        packageManager: "pnpm@10.34.5",
        scripts: { "test:unit": "custom-test-runner --changed", test: "npm run test:unit", verify: "custom-verify" },
      }));
      const unsupported = buildFailedPublishFirstTargetsV1(snapshot)[0];
      assert.equal(unsupported?.kind, "failed-command",
        "a familiar command name alone cannot authorize the repository-specific current-source runner");

      const member = path.join(root, "packages", "core");
      const memberSnapshot: FailedPublishRunSnapshotV1 = {
        ...snapshot,
        commands: [{ command: "[packages/core] pnpm test", cwd: member, phase: "test", exitCode: 1 }],
        failures: [{
          command: "[packages/core] pnpm test", exitCode: 1, testFiles: [], failureCount: 1,
          completeFailureIdentities: false, unidentifiedFailureCount: 1,
        }],
      };
      assert.deepEqual(buildFailedPublishFirstTargetsV1(memberSnapshot)[0], {
        kind: "failed-command",
        command: "[packages/core] pnpm test",
        executableCommand: "pnpm test",
        cwd: member,
        reason: "The failed command uses an unsupported runner or package scope; rerun the complete failed command first.",
      }, "whole-command fallback preserves the member cwd and never executes its display prefix");

      const partialSnapshot: FailedPublishRunSnapshotV1 = {
        ...snapshot,
        failures: [{
          command: "pnpm run test:unit", exitCode: 1, testFiles: ["out/test/a.test.js"], failureCount: 2,
          completeFailureIdentities: false, unidentifiedFailureCount: 1,
        }],
      };
      assert.equal(buildFailedPublishFirstTargetsV1(partialSnapshot)[0]?.kind, "failed-command",
        "a partial file list must never omit the unidentified prior failure");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
