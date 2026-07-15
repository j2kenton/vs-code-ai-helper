import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { __testOnly, CliAgentRunner } from "../runners/cliAgentRunner";
import { CliProviderDefinition, getCliProvider } from "../runners/providers";
import { attributionHeader, withAttribution } from "../utils/fileUtils";
import { AgentRunRequest } from "../types/agentRunner";

void describe("CLI output normalization", () => {
  void it("extracts Kiro's final review text from a streamed transcript", () => {
    const transcript = [
      "\u001b[38;5;141m>\u001b[0m",
      "",
      "I'll analyze the implementation against the plan requirements.",
      "Batch fs_read operation with 3 operations",
      "Successfully read package.json",
      "I will run the following command: pnpm run test:unit",
      "",
      "Based on my analysis of the implementation files, here's my low-level review:",
      "",
      "## Summary Verdict",
      "",
      "Ready to complete.",
    ].join("\n");

    assert.strictEqual(
      __testOnly.extractKiroFinalOutput(transcript),
      [
        "Based on my analysis of the implementation files, here's my low-level review:",
        "",
        "## Summary Verdict",
        "",
        "Ready to complete.",
      ].join("\n")
    );
  });

  void it("loads Kiro's linked markdown artifact when stdout points to a file URI", () => {
    const tempFile = path.join(
      "/tmp",
      `vs-code-ai-helper-kiro-output-${Date.now()}.md`
    );
    fs.writeFileSync(tempFile, "# Review\n\nOn Track\n", "utf8");

    try {
      const stdout = [
        "I have completed a high-level review of the implementation.",
        "",
        `Please refer to the generated [high_level_review.md](${pathToFileURL(tempFile).toString()}) artifact for the full evaluation.`,
      ].join("\n");

      assert.strictEqual(
        __testOnly.extractKiroFinalOutput(stdout),
        "# Review\n\nOn Track"
      );
    } finally {
      fs.unlinkSync(tempFile);
    }
  });

  void it("normalizes Kiro output via provider-specific extraction", () => {
    const kiro = getCliProvider("kiro-cli");
    assert.ok(kiro, "expected kiro-cli provider definition");

    const output = __testOnly.normalizeCliOutput(
      kiro,
      "\u001b[0m## Summary Verdict\u001b[0m\n\nNeeds changes.\n",
      undefined
    );

    assert.strictEqual(output, "## Summary Verdict\n\nNeeds changes.");
  });

  void it("fails CLI implementation runs that report completion without file changes", () => {
    const codex = getCliProvider("codex-cli");
    assert.ok(codex, "expected codex-cli provider definition");

    const result = __testOnly.toCliImplementationRunResult(
      codex,
      {
        status: "completed",
        output: "Implemented the requested changes.",
      },
      [],
      false
    );

    assert.strictEqual(result.status, "failed");
    assert.match(result.errorMessage ?? "", /did not modify any workspace files/);
    assert.match(result.errorMessage ?? "", /Provider output:/);
  });

  void it("treats a no-file-change CLI completion as success when requireFileChange is false", () => {
    const codex = getCliProvider("codex-cli");
    assert.ok(codex, "expected codex-cli provider definition");

    const result = __testOnly.toCliImplementationRunResult(
      codex,
      {
        status: "completed",
        output: "Just answering the question, no edit was needed.",
      },
      [],
      false,
      false
    );

    assert.strictEqual(result.status, "completed");
    assert.strictEqual(result.summary, "Just answering the question, no edit was needed.");
  });

  void it("strips this extension's own Claude Code session identity from nested CLI env", () => {
    const original = { ...process.env };
    try {
      process.env.CLAUDECODE = "1";
      process.env.CLAUDE_CODE_ENTRYPOINT = "claude-vscode";
      process.env.CLAUDE_CODE_SESSION_ID = "abc123";
      process.env.CLAUDE_EFFORT = "xhigh";
      process.env.PATH = original.PATH ?? "";

      const env = __testOnly.sanitizedCliEnv();

      assert.strictEqual(env.CLAUDECODE, undefined);
      assert.strictEqual(env.CLAUDE_CODE_ENTRYPOINT, undefined);
      assert.strictEqual(env.CLAUDE_CODE_SESSION_ID, undefined);
      assert.strictEqual(env.CLAUDE_EFFORT, undefined);
      assert.strictEqual(env.PATH, original.PATH);
    } finally {
      process.env = original;
    }
  });

  void it("preserves other providers' own env vars (e.g. CODEX_HOME) rather than stripping their whole namespace", () => {
    // Regression test: an earlier version of sanitizedCliEnv also stripped
    // every CODEX_* and GEMINI_CLI_* variable, on the mistaken assumption
    // they were session-identity leaks like the CLAUDE_CODE_* ones. They're
    // not — CODEX_HOME etc. are the user's own legitimate CLI config/auth,
    // and this extension host has no comparable reason to itself be a
    // Codex or Gemini session the way it can be a Claude Code session.
    const original = { ...process.env };
    try {
      process.env.CODEX_HOME = "/home/user/.codex-custom-profile";
      process.env.GEMINI_CLI_API_KEY = "user-configured-key";

      const env = __testOnly.sanitizedCliEnv();

      assert.strictEqual(env.CODEX_HOME, "/home/user/.codex-custom-profile");
      assert.strictEqual(env.GEMINI_CLI_API_KEY, "user-configured-key");
    } finally {
      process.env = original;
    }
  });

  void it("propagates failureKind from a failed CLI run through to the AgentRunResult", async () => {
    const provider: CliProviderDefinition = {
      id: "claude-cli",
      label: "Fake Quota CLI",
      command: "node",
      installHint: "install",
      loginHint: "login",
      authErrorMarkers: ["login"],
      useShell: false,
      models: [{ model: undefined, name: "default" }],
      usesLastMessageFile: false,
      buildArgs(): string[] {
        // Exits non-zero with quota-flavored stderr, simulating Claude Code
        // reporting an exhausted session allocation.
        return [
          "-e",
          "process.stderr.write('Claude Code CLI failed: You\\'ve hit your session limit · resets 2:30am (Asia/Jerusalem).'); process.exit(1);",
        ];
      },
    };

    const runner = new CliAgentRunner(provider);
    const cts = new vscode.CancellationTokenSource();
    const request: AgentRunRequest = {
      taskFolderUri: vscode.Uri.file("/fake-task"),
      workspaceUri: vscode.Uri.file("/fake-workspace"),
      stage: "plan",
      prompt: "irrelevant",
      outputFile: vscode.Uri.file("/fake-task/plan.md"),
    };

    const result = await runner.run(request, cts.token);

    assert.strictEqual(result.status, "failed");
    assert.strictEqual(result.failureKind, "quota");
  });
});

void describe("output attribution", () => {
  void it("signs generated content with the provider and model that produced it", () => {
    const signed = withAttribution("Review body text.", "Claude Code", "sonnet");
    assert.strictEqual(
      signed,
      "<!-- Generated by Claude Code (sonnet) -->\n\nReview body text."
    );
  });

  void it("omits the model parens when no native model id is known", () => {
    assert.strictEqual(
      attributionHeader("Claude Code", undefined),
      "<!-- Generated by Claude Code -->"
    );
  });
});
