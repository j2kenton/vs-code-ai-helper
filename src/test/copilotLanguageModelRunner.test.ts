import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { CopilotLanguageModelRunner, copilotIgnoredVariantNoteV1, createCopilotLmTextTransportV1 } from "../runners/copilotLanguageModelRunner";
import { buildCopilotRequestOptions, resolveCopilotModel } from "../runners/copilotModelResolution";
import { createBoundedResultWriterV1 } from "../services/agentExecutionBrokerV1";
import type { AgentExecutionRequestV1 } from "../types/agentExecutionV1";
import type { AgentRunResult } from "../types/agentRunner";
import { safeRemoveDir } from "./testFsUtils";

async function invokeTextTransportWithReplyV1(fragments: readonly string[]) {
  const lm = (vscode as unknown as {
    lm: { selectChatModels: () => Promise<vscode.LanguageModelChat[]> };
  }).lm;
  const original = lm.selectChatModels;
  lm.selectChatModels = (): Promise<vscode.LanguageModelChat[]> =>
    Promise.resolve([
      {
        id: "auto",
        name: "Auto",
        sendRequest: () =>
          Promise.resolve({
            text: (async function* () {
              await Promise.resolve();
              for (const fragment of fragments) {
                yield fragment;
              }
            })(),
          }),
      } as unknown as vscode.LanguageModelChat,
    ]);
  try {
    const source = new vscode.CancellationTokenSource();
    const writer = createBoundedResultWriterV1(1024);
    const exit = await createCopilotLmTextTransportV1({ model: undefined }).invoke(
      { prompt: "Say something.", cancellationToken: source.token } as unknown as AgentExecutionRequestV1,
      writer
    );
    return exit;
  } finally {
    lm.selectChatModels = original;
  }
}

void describe("Copilot text transport empty response (v1 fixes 2, item 27)", () => {
  void it("reports an empty reply as a retryable network fault, not a completed answer", async () => {
    const exit = await invokeTextTransportWithReplyV1([]);
    assert.equal(exit.kind, "transportFailure");
    if (exit.kind === "transportFailure") {
      assert.equal(exit.code, "copilotEmptyResponse");
      assert.equal(exit.networkFault, true);
      assert.match(exit.detail ?? "", /empty response/);
    }
  });

  void it("still completes a reply that carried text", async () => {
    const exit = await invokeTextTransportWithReplyV1(["hello"]);
    assert.equal(exit.kind, "completed");
  });
});

void describe("Copilot request options (v1 fixes 2, item 19)", () => {
  void it("resolves a legacy @effort+long selection to its base model but sends no ignored options", () => {
    const model = { id: "gpt-5.4", name: "GPT-5.4" } as vscode.LanguageModelChat;
    const resolved = resolveCopilotModel([model], "gpt-5.4@high+long");
    assert.equal(resolved.ok, true);
    if (resolved.ok) {
      assert.equal(resolved.model.id, "gpt-5.4");
      assert.deepEqual(buildCopilotRequestOptions(resolved.parsedModel), {});
      assert.match(copilotIgnoredVariantNoteV1(resolved.parsedModel), /was not applied: Copilot ignores it/);
    }
  });

  void it("adds no run-log note for a bare Copilot model id", () => {
    const model = { id: "gpt-5.4", name: "GPT-5.4" } as vscode.LanguageModelChat;
    const resolved = resolveCopilotModel([model], "gpt-5.4");
    assert.equal(resolved.ok, true);
    if (resolved.ok) {
      assert.equal(copilotIgnoredVariantNoteV1(resolved.parsedModel), "");
    }
  });
});

void describe("CopilotLanguageModelRunner reported model id (v1 fixes 2, item 19)", () => {
  async function runWithRequestedModelV1(requested: string | undefined): Promise<AgentRunResult> {
    const lm = (vscode as unknown as {
      lm: { selectChatModels: () => Promise<vscode.LanguageModelChat[]> };
    }).lm;
    const original = lm.selectChatModels;
    lm.selectChatModels = (): Promise<vscode.LanguageModelChat[]> =>
      Promise.resolve([
        {
          // With no requested model the runner picks Copilot's "auto" model.
          id: requested === undefined ? "auto" : "gpt-5.4",
          name: requested === undefined ? "Auto" : "GPT-5.4",
          sendRequest: () =>
            Promise.resolve({
              text: (async function* () {
                await Promise.resolve();
                yield "hello";
              })(),
            }),
        } as unknown as vscode.LanguageModelChat,
      ]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-run-model-id-"));
    // The runner writes its output through `workspace.fs`, which the stub does
    // not implement; bridge it to the real temp directory for this run.
    const fsTarget = vscode.workspace.fs as unknown as { writeFile: unknown };
    const originalWriteFile = fsTarget.writeFile;
    fsTarget.writeFile = (uri: vscode.Uri, bytes: Uint8Array): Promise<void> => {
      fs.writeFileSync(uri.fsPath, Buffer.from(bytes));
      return Promise.resolve();
    };
    try {
      const source = new vscode.CancellationTokenSource();
      return await new CopilotLanguageModelRunner().run(
        {
          taskFolderUri: vscode.Uri.file(dir),
          workspaceUri: vscode.Uri.file(dir),
          stage: "plan",
          prompt: "Create a plan.",
          outputFile: vscode.Uri.file(path.join(dir, "plan.md")),
          modelId: requested,
        },
        source.token
      );
    } finally {
      lm.selectChatModels = original;
      fsTarget.writeFile = originalWriteFile;
      safeRemoveDir(dir);
    }
  }

  void it("reports the base model, not the ignored @effort+long suffix, for a legacy saved selection", async () => {
    const result = await runWithRequestedModelV1("gpt-5.4@high+long");
    assert.equal(result.status, "completed", result.errorMessage);
    assert.equal(result.modelId, "gpt-5.4");
    assert.match(result.summary ?? "", /was not applied: Copilot ignores it/);
  });

  void it("reports a bare requested id unchanged, and the resolved model when none was requested", async () => {
    assert.equal((await runWithRequestedModelV1("gpt-5.4")).modelId, "gpt-5.4");
    assert.equal((await runWithRequestedModelV1(undefined)).modelId, "auto");
  });
});

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
