import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { execCliAgent } from "../runners/cliAgentRunner";
import { CliProviderDefinition } from "../runners/providers";

void describe("execCliAgent argv prompt limits", () => {
  void it("fails fast when argv prompt exceeds provider cap", async () => {
    const provider: CliProviderDefinition = {
      id: "kiro-cli",
      label: "Kiro CLI",
      command: "kiro-cli",
      installHint: "install",
      loginHint: "login",
      authErrorMarkers: ["login"],
      promptTransport: "argv",
      useShell: false,
      maxArgvPromptBytes: 10,
      models: [{ model: undefined, name: "default" }],
      usesLastMessageFile: false,
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
});
