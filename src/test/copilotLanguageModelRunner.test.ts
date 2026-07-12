import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { CopilotLanguageModelRunner } from "../runners/copilotLanguageModelRunner";

void describe("CopilotLanguageModelRunner", () => {
  void it("reports sign-in guidance when no Copilot models are available", async () => {
    const lm = (vscode as unknown as {
      lm: {
        selectChatModels: () => Promise<vscode.LanguageModelChat[]>;
      };
    }).lm;
    const originalSelectChatModels = lm.selectChatModels;

    lm.selectChatModels = (): Promise<vscode.LanguageModelChat[]> =>
      Promise.resolve([]);

    try {
      const runner = new CopilotLanguageModelRunner();
      const tokenSource = new vscode.CancellationTokenSource();
      const result = await runner.run(
        {
          taskFolderUri: vscode.Uri.file("/fake-task"),
          workspaceUri: vscode.Uri.file("/fake-workspace"),
          stage: "plan",
          prompt: "Create a plan.",
          outputFile: vscode.Uri.file("/fake-task/plan.md"),
          modelId: "copilot-gpt-5.6-sol",
        },
        tokenSource.token
      );

      assert.strictEqual(result.status, "failed");
      assert.match(result.errorMessage ?? "", /Sign in to GitHub Copilot/);
    } finally {
      lm.selectChatModels = originalSelectChatModels;
    }
  });

  void it("fails explicit unavailable models instead of falling back to auto", async () => {
    const lm = (vscode as unknown as {
      lm: {
        selectChatModels: () => Promise<vscode.LanguageModelChat[]>;
      };
    }).lm;
    const originalSelectChatModels = lm.selectChatModels;

    lm.selectChatModels = (): Promise<vscode.LanguageModelChat[]> =>
      Promise.resolve([
        {
          id: "auto",
          name: "Auto",
        } as vscode.LanguageModelChat,
      ]);

    try {
      const runner = new CopilotLanguageModelRunner();
      const tokenSource = new vscode.CancellationTokenSource();
      const result = await runner.run(
        {
          taskFolderUri: vscode.Uri.file("/fake-task"),
          workspaceUri: vscode.Uri.file("/fake-workspace"),
          stage: "plan",
          prompt: "Create a plan.",
          outputFile: vscode.Uri.file("/fake-task/plan.md"),
          modelId: "copilot-gpt-5.6-sol",
        },
        tokenSource.token
      );

      assert.strictEqual(result.status, "failed");
      assert.strictEqual(result.failureKind, "temporarily-unavailable");
      assert.match(
        result.errorMessage ?? "",
        /configured Copilot model "copilot-gpt-5\.6-sol" is not available/
      );
    } finally {
      lm.selectChatModels = originalSelectChatModels;
    }
  });
});
