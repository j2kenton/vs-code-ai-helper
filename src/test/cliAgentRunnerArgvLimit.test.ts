import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { CliAgentRunner, execCliAgent, runImplementationWithCli } from "../runners/cliAgentRunner";
import { CliProviderDefinition, getCliProvider } from "../runners/providers";

void describe("execCliAgent argv prompt limits", () => {
  void it("fails fast when argv prompt exceeds provider cap", async () => {
    const provider: CliProviderDefinition = {
      id: "kiro-cli",
      label: "Kiro CLI",
      command: "kiro-cli",
      installHint: "install",
      loginHint: "login",
      authErrorMarkers: ["login"],
      signInCommand: "login",
      signInLabel: "Sign in",
      promptTransport: "argv",
      useShell: false,
      maxArgvPromptBytes: 10,
      models: [{ model: undefined, name: "default" }],
      usesLastMessageFile: false,
      textModeResponseContractV1: "honours",
      buildArgs(): string[] {
        return ["chat", "--no-interactive"];
      },
    };

    const cts = new vscode.CancellationTokenSource();
    const result = await execCliAgent({
      def: provider,
      mode: "text",
      model: undefined,
      prompt: "this prompt is definitely longer than ten bytes",
      cwd: process.cwd(),
      token: cts.token,
    });

    assert.strictEqual(result.status, "failed");
    assert.match(result.errorMessage ?? "", /too large/i);
    assert.match(result.errorMessage ?? "", /max 10 bytes/i);
  });

  void it("Antigravity uses file transport so large context packs are allowed", () => {
    // agy's --print flag has no stdin-prompt mode: it only accepts the
    // prompt as its flag value, which would otherwise cap prompt size at
    // the OS argv-length limit. Routing it through a temp file keeps large
    // context packs working without that ceiling.
    const provider = getCliProvider("antigravity-cli");
    assert.ok(provider, "expected antigravity-cli provider definition");
    assert.strictEqual(provider.promptTransport, "file");
    assert.strictEqual(provider.maxArgvPromptBytes, undefined);
  });

  void it("file transport writes the prompt to a temp file, passes its path to buildArgs, and cleans up after", async () => {
    let capturedPromptFile: string | undefined;
    const provider: CliProviderDefinition = {
      id: "antigravity-cli",
      label: "Fake File-Transport CLI",
      command: "node",
      installHint: "install",
      loginHint: "login",
      authErrorMarkers: ["login"],
      signInCommand: "login",
      signInLabel: "Sign in",
      promptTransport: "file",
      useShell: false,
      models: [{ model: undefined, name: "default" }],
      usesLastMessageFile: false,
      textModeResponseContractV1: "honours",
      buildArgs(_mode, _model, context): string[] {
        capturedPromptFile = context?.promptFile;
        // Node script that reads the prompt file passed as its own argv and
        // prints its contents, standing in for `agy --print=<file>`.
        return [
          "-e",
          "process.stdout.write(require('fs').readFileSync(process.argv[1], 'utf8'))",
          context?.promptFile ?? "",
        ];
      },
    };

    const cts = new vscode.CancellationTokenSource();
    const result = await execCliAgent({
      def: provider,
      mode: "text",
      model: undefined,
      prompt: "large context pack contents",
      cwd: process.cwd(),
      token: cts.token,
    });

    assert.strictEqual(result.status, "completed");
    assert.strictEqual(result.output, "large context pack contents");
    assert.ok(capturedPromptFile, "expected buildArgs to receive a promptFile path");
    assert.strictEqual(
      fs.existsSync(capturedPromptFile),
      false,
      "expected the temp prompt file to be cleaned up after the run"
    );
  });

  void it("cleans up the temp prompt file even when the CLI command is not found", async () => {
    // Regression test: buildArgs (and therefore promptFile creation) runs
    // before the command-not-found check, so a provider whose command
    // isn't on PATH used to leave the prompt file (which can contain a
    // full context pack) orphaned on disk.
    let capturedPromptFile: string | undefined;
    const provider: CliProviderDefinition = {
      id: "antigravity-cli",
      label: "Fake Missing CLI",
      command: "definitely-not-a-real-cli-xyz123-nonexistent",
      installHint: "install",
      loginHint: "login",
      authErrorMarkers: ["login"],
      signInCommand: "login",
      signInLabel: "Sign in",
      promptTransport: "file",
      useShell: false,
      models: [{ model: undefined, name: "default" }],
      usesLastMessageFile: false,
      textModeResponseContractV1: "honours",
      buildArgs(_mode, _model, context): string[] {
        capturedPromptFile = context?.promptFile;
        return [`--print=${context?.promptFile ?? ""}`];
      },
    };

    const cts = new vscode.CancellationTokenSource();
    const result = await execCliAgent({
      def: provider,
      mode: "text",
      model: undefined,
      prompt: "sensitive context pack contents",
      cwd: process.cwd(),
      token: cts.token,
    });

    assert.strictEqual(result.status, "failed");
    assert.match(result.errorMessage ?? "", /command not found/i);
    assert.ok(capturedPromptFile, "expected buildArgs to receive a promptFile path");
    assert.strictEqual(
      fs.existsSync(capturedPromptFile),
      false,
      "expected the temp prompt file to be cleaned up even though the command was never found"
    );
  });

  void it("resumes an Antigravity-shaped implementation after the captured response timeout", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-agy-resume-"));
    const resumeFlags: Array<boolean | undefined> = [];
    const prompts: string[] = [];
    const continuationPrompt = "Continue the interrupted task from the existing workspace state.";
    const provider: CliProviderDefinition = {
      id: "antigravity-cli",
      label: "Fake Antigravity CLI",
      command: "node",
      installHint: "install",
      loginHint: "login",
      authErrorMarkers: ["login"],
      signInLabel: "Sign in",
      promptTransport: "file",
      useShell: false,
      models: [{ model: undefined, name: "default" }],
      usesLastMessageFile: false,
      textModeResponseContractV1: "honours",
      conversationResume: {
        errorMarkers: ["error: timeout waiting for response"],
        continuationPrompt,
      },
      buildArgs(_mode, _model, context): string[] {
        resumeFlags.push(context?.resumePreviousConversation);
        prompts.push(fs.readFileSync(context?.promptFile ?? "", "utf8"));
        return context?.resumePreviousConversation
          ? ["-e", "process.stdout.write('resumed successfully')"]
          : [
              "-e",
              "process.stderr.write('Error: timeout waiting for response'); process.exit(1)",
            ];
      },
    };

    try {
      const cts = new vscode.CancellationTokenSource();
      const result = await runImplementationWithCli({
        def: provider,
        model: undefined,
        prompt: "original implementation prompt",
        workspaceUri: vscode.Uri.file(workspace),
        token: cts.token,
        onProgress: () => undefined,
        requireFileChange: false,
        retryDelayMs: 0,
      });

      assert.strictEqual(result.status, "completed");
      assert.strictEqual(result.summary, "resumed successfully");
      assert.deepStrictEqual(resumeFlags, [undefined, true]);
      assert.deepStrictEqual(prompts, [
        "original implementation prompt",
        continuationPrompt,
      ]);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});

// (2j) A provider's argv-transport ceiling is a structural, guaranteed
// failure — never transient — so it must be caught BEFORE dispatch, not
// discovered by trying and failing. These tests assert that outcome
// directly: buildArgs is never called, proving no CLI dispatch (and no
// retry-loop attempt) was spent on a run that could never succeed.
void describe("pre-dispatch prompt-size skip (2j)", () => {
  function oversizedArgvProvider(buildArgsCalls: { count: number }): CliProviderDefinition {
    return {
      id: "kiro-cli",
      label: "Kiro CLI",
      command: "kiro-cli",
      installHint: "install",
      loginHint: "login",
      authErrorMarkers: ["login"],
      signInCommand: "login",
      signInLabel: "Sign in",
      promptTransport: "argv",
      useShell: false,
      maxArgvPromptBytes: 10,
      models: [{ model: undefined, name: "default" }],
      usesLastMessageFile: false,
      textModeResponseContractV1: "honours",
      buildArgs(): string[] {
        buildArgsCalls.count++;
        return ["chat", "--no-interactive"];
      },
    };
  }

  void it("CliAgentRunner.run (text mode) skips dispatch and returns a cascade-eligible failure with zero attempts spent", async () => {
    const buildArgsCalls = { count: 0 };
    const runner = new CliAgentRunner(oversizedArgvProvider(buildArgsCalls));
    const cts = new vscode.CancellationTokenSource();

    const result = await runner.run(
      {
        taskFolderUri: vscode.Uri.file(process.cwd()),
        workspaceUri: vscode.Uri.file(process.cwd()),
        stage: "impl",
        prompt: "this prompt is definitely longer than ten bytes",
        outputFile: vscode.Uri.file(path.join(os.tmpdir(), "cli-argv-limit-out.md")),
      },
      cts.token
    );

    assert.strictEqual(result.status, "failed");
    // Same classification the in-dispatch check would have produced — the
    // backup cascade in runnerRegistry.ts keys on this to try a different
    // provider, and that behavior must be unaffected by skipping earlier.
    assert.strictEqual(result.failureKind, "temporarily-unavailable");
    assert.match(result.errorMessage ?? "", /too large/i);
    assert.strictEqual(buildArgsCalls.count, 0, "expected the provider CLI to never be dispatched");
  });

  void it("runImplementationWithCli (edit mode) skips dispatch and reports a definitively clean (not unknown) tree", async () => {
    const buildArgsCalls = { count: 0 };
    const cts = new vscode.CancellationTokenSource();

    const result = await runImplementationWithCli({
      def: oversizedArgvProvider(buildArgsCalls),
      model: undefined,
      prompt: "this prompt is definitely longer than ten bytes",
      workspaceUri: vscode.Uri.file(process.cwd()),
      token: cts.token,
      onProgress: () => undefined,
    });

    assert.strictEqual(result.status, "failed");
    assert.strictEqual(result.failureKind, "temporarily-unavailable");
    assert.match(result.errorMessage ?? "", /too large/i);
    // Nothing ran, so this is KNOWN-clean rather than unknown — the dirty-tree
    // cascade gate in runnerRegistry.ts must be free to continue past it.
    assert.deepStrictEqual(result.filesChanged, []);
    assert.strictEqual(result.filesChangedUnknown, false);
    assert.strictEqual(buildArgsCalls.count, 0, "expected the provider CLI to never be dispatched");
  });
});
