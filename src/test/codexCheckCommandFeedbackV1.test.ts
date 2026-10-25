import * as assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import {
  extractCodexExecutedCommands,
  extractCodexSessionIdV1,
  isDeniedCommandExecution,
  matchConfiguredCheckCommand,
  runImplementationWithCli,
} from "../runners/cliAgentRunner";
import type { CliProviderDefinition } from "../runners/providers";
import { safeRemoveDir } from "./testFsUtils";

void describe("Codex Check Command Feedback (Step 27 / Defect 13)", () => {
  void it("extractCodexSessionIdV1 extracts thread_id from json stream", () => {
    const rawStdout =
      '{"type":"thread.started","thread_id":"th_abc123xyz"}\n{"type":"item.completed"}\n';
    const sessionId = extractCodexSessionIdV1(rawStdout);
    assert.strictEqual(sessionId, "th_abc123xyz");
  });

  void it("extractCodexExecutedCommands parses command execution records", () => {
    const rawStdout = [
      '{"type":"thread.started","thread_id":"th_1"}',
      '{"type":"item.completed","item":{"type":"command_execution","command":"pnpm run test","exit_code":0,"status":"completed","aggregated_output":"PASS"}}',
      '{"type":"item.completed","item":{"type":"command_execution","command":"git diff","exit_code":1,"status":"denied","aggregated_output":"spawnSync git EPERM"}}',
    ].join("\n");

    const records = extractCodexExecutedCommands(rawStdout);
    assert.strictEqual(records.length, 2);
    assert.strictEqual(records[0]?.command, "pnpm run test");
    assert.strictEqual(records[0]?.exitCode, 0);
    assert.strictEqual(records[0]?.status, "completed");
    assert.strictEqual(records[1]?.command, "git diff");
    assert.strictEqual(records[1]?.status, "denied");
  });

  void it("isDeniedCommandExecution detects sandbox denials and EPERM errors", () => {
    assert.strictEqual(
      isDeniedCommandExecution({
        command: "pnpm test",
        exitCode: 1,
        status: "denied",
        output: "permission denied",
      }),
      true
    );

    assert.strictEqual(
      isDeniedCommandExecution({
        command: "git status",
        exitCode: 1,
        status: "failed",
        output: "spawnSync git EPERM",
      }),
      true
    );

    assert.strictEqual(
      isDeniedCommandExecution({
        command: "pnpm test",
        exitCode: 1,
        status: "failed",
        output: "AssertionError: expected true to be false",
      }),
      false
    );

    assert.strictEqual(
      isDeniedCommandExecution({
        command: "pnpm test",
        exitCode: 0,
        status: "completed",
        output: "10 passed",
      }),
      false
    );
  });

  void it("matchConfiguredCheckCommand matches shell commands against configured checks", () => {
    const configured = ["pnpm run test:unit", "pnpm run check-types"];

    assert.strictEqual(
      matchConfiguredCheckCommand("pnpm run test:unit", configured)?.displayCommand,
      "pnpm run test:unit"
    );

    assert.strictEqual(
      matchConfiguredCheckCommand('/bin/bash -lc "pnpm run test:unit"', configured)?.displayCommand,
      "pnpm run test:unit"
    );

    assert.strictEqual(
      matchConfiguredCheckCommand("npm run build", configured),
      undefined
    );

    assert.strictEqual(
      matchConfiguredCheckCommand("git commit -m 'test'", configured),
      undefined
    );

    // Rejects substring match
    assert.strictEqual(
      matchConfiguredCheckCommand("pnpm", configured),
      undefined
    );
    assert.strictEqual(
      matchConfiguredCheckCommand("test:unit", configured),
      undefined
    );

    // Preserves member package prefix and resolves cwd when executed in member directory
    const memberChecks = ["[apps/mobile] pnpm run lint"];
    const matchedMember = matchConfiguredCheckCommand("cd apps/mobile && pnpm run lint", memberChecks, "/repo");
    assert.strictEqual(matchedMember?.displayCommand, "[apps/mobile] pnpm run lint");
    assert.strictEqual(matchedMember?.executableCommand, "pnpm run lint");
    assert.strictEqual(matchedMember?.cwd, path.resolve("/repo", "apps/mobile"));

    // Rejects execution in mismatched directory outside selected check's scope
    assert.strictEqual(
      matchConfiguredCheckCommand("cd /other-project && pnpm run lint", ["pnpm run lint"], "/repo"),
      undefined
    );
    assert.strictEqual(
      matchConfiguredCheckCommand("cd /other-project && pnpm run lint", memberChecks, "/repo"),
      undefined
    );

    // Disambiguates duplicate command names across root and member packages by directory identity
    const duplicateChecks = [
      { displayCommand: "pnpm run lint", executableCommand: "pnpm run lint", cwd: "/repo" },
      { displayCommand: "[packages/app] pnpm run lint", executableCommand: "pnpm run lint", cwd: "/repo/packages/app" },
    ];
    const matchMemberDup = matchConfiguredCheckCommand("cd packages/app && pnpm run lint", duplicateChecks, "/repo");
    assert.strictEqual(matchMemberDup?.displayCommand, "[packages/app] pnpm run lint");
    assert.strictEqual(matchMemberDup?.cwd, "/repo/packages/app");

    const matchRootDup = matchConfiguredCheckCommand("pnpm run lint", duplicateChecks, "/repo");
    assert.strictEqual(matchRootDup?.displayCommand, "pnpm run lint");
    assert.strictEqual(matchRootDup?.cwd, "/repo");

    assert.strictEqual(
      matchConfiguredCheckCommand("cd /other-dir && pnpm run lint", duplicateChecks, "/repo"),
      undefined
    );

    // Accepts structured ConfiguredCheckCommandV1
    const structuredChecks = [
      {
        displayCommand: "[packages/core] npm test",
        executableCommand: "npm test",
        cwd: "/repo/packages/core",
      },
    ];
    const matchedStructured = matchConfiguredCheckCommand("cd /repo/packages/core && npm test", structuredChecks, "/repo");
    assert.strictEqual(matchedStructured?.displayCommand, "[packages/core] npm test");
    assert.strictEqual(matchedStructured?.executableCommand, "npm test");
    assert.strictEqual(matchedStructured?.cwd, "/repo/packages/core");
  });

  void it("verifies fallback filtering for configured vs arbitrary denied commands", () => {
    const configuredChecks = ["pnpm run test:unit"];
    const executedRecords = [
      {
        command: "pnpm run test:unit",
        exitCode: 1,
        status: "failed",
        output: "spawnSync git EPERM (sandbox restriction)",
      },
      {
        command: "rm -rf /tmp/other",
        exitCode: 1,
        status: "denied",
        output: "operation not permitted",
      },
      {
        command: "pnpm run test:unit",
        exitCode: 0,
        status: "completed",
        output: "10 passing",
      },
    ];

    // Matched and denied -> falls back to host runner
    const matchedDenied = executedRecords.filter(
      (r) =>
        matchConfiguredCheckCommand(r.command, configuredChecks) !== undefined &&
        isDeniedCommandExecution(r)
    );
    assert.strictEqual(matchedDenied.length, 1);
    assert.strictEqual(matchedDenied[0]?.command, "pnpm run test:unit");

    // Matched and not denied -> runs in sandbox
    const matchedSuccess = executedRecords.filter(
      (r) =>
        matchConfiguredCheckCommand(r.command, configuredChecks) !== undefined &&
        !isDeniedCommandExecution(r)
    );
    assert.strictEqual(matchedSuccess.length, 1);
    assert.strictEqual(matchedSuccess[0]?.command, "pnpm run test:unit");

    // Denied but NOT configured -> blocked from host runner
    const unconfiguredDenied = executedRecords.filter(
      (r) =>
        matchConfiguredCheckCommand(r.command, configuredChecks) === undefined &&
        isDeniedCommandExecution(r)
    );
    assert.strictEqual(unconfiguredDenied.length, 1);
    assert.strictEqual(unconfiguredDenied[0]?.command, "rm -rf /tmp/other");
  });

  void it("executes host runner fallback in the member package cwd and returns model feedback", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-host-fallback-test-"));
    const memberDir = path.join(tmpDir, "apps", "mobile");
    fs.mkdirSync(memberDir, { recursive: true });
    childProcess.execSync("git init", { cwd: tmpDir, stdio: "ignore" });

    const executedHostRuns: { cwd: string; command: string }[] = [];
    const hostCheckRunner = (dir: string, cmd: string): Promise<{ code: number; output: string }> => {
      executedHostRuns.push({ cwd: dir, command: cmd });
      return Promise.resolve({ code: 0, output: "12 tests passed on host runner" });
    };

    const fakeProvider: CliProviderDefinition = {
      id: "codex-cli",
      label: "OpenAI Codex",
      command: "node",
      installHint: "install",
      loginHint: "login",
      authErrorMarkers: ["login"],
      signInLabel: "Sign in",
      promptTransport: "file",
      useShell: false,
      models: [{ model: undefined, name: "default" }],
      usesLastMessageFile: false,
      textModeResponseContractV1: "unproven",
      structuredEventStream: "codex",
      buildArgs(_mode, _model, context): string[] {
        const pFile = context?.promptFile ?? "";
        return [
          "-e",
          `
          const fs = require("fs");
          const prompt = fs.readFileSync(${JSON.stringify(pFile)}, "utf8");
          if (prompt.includes("The following project check commands were executed on the host system")) {
            fs.writeFileSync(${JSON.stringify(path.join(tmpDir, "feedback.txt"))}, prompt);
            fs.writeFileSync(${JSON.stringify(path.join(tmpDir, "done.txt"))}, "fixed");
            process.stdout.write("All checks fixed.\\n");
          } else {
            process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "th_test_session" }) + "\\n");
            process.stdout.write(JSON.stringify({
              type: "item.completed",
              item: {
                type: "command_execution",
                command: "cd apps/mobile && pnpm run lint",
                exit_code: 1,
                status: "failed",
                aggregated_output: "spawnSync git EPERM (sandbox restriction)"
              }
            }) + "\\n");
            fs.writeFileSync(${JSON.stringify(path.join(tmpDir, "done.txt"))}, "done");
          }
          `,
        ];
      },
    };

    try {
      const cts = new vscode.CancellationTokenSource();
      const result = await runImplementationWithCli({
        def: fakeProvider,
        model: undefined,
        prompt: "Fix the linting issues",
        workspaceUri: vscode.Uri.file(tmpDir),
        token: cts.token,
        onProgress: () => undefined,
        requireFileChange: false,
        configuredFailingCommands: [
          {
            displayCommand: "[apps/mobile] pnpm run lint",
            executableCommand: "pnpm run lint",
            cwd: memberDir,
          },
        ],
        hostCheckRunner,
        typeCheckRunner: () => Promise.resolve({ passed: true, output: "" }),
      });

      assert.strictEqual(result.status, "completed");
      assert.strictEqual(executedHostRuns.length, 1);
      assert.strictEqual(executedHostRuns[0]?.cwd, memberDir, "host check runner must run in member directory");
      assert.strictEqual(executedHostRuns[0]?.command, "pnpm run lint", "executable command must have member prefix stripped");
      assert.ok(result.executedChecks && result.executedChecks.length > 0);
      assert.strictEqual(result.executedChecks[0]?.outcome, "host-fallback");
      assert.strictEqual(result.executedChecks[0]?.command, "[apps/mobile] pnpm run lint");

      // Verify resume prompt received host output
      const feedbackPath = path.join(tmpDir, "feedback.txt");
      assert.ok(fs.existsSync(feedbackPath), "expected session to be resumed with feedback");
      const feedbackContent = fs.readFileSync(feedbackPath, "utf8");
      assert.ok(feedbackContent.includes("12 tests passed on host runner"));
    } finally {
      safeRemoveDir(tmpDir);
    }
  });
});
