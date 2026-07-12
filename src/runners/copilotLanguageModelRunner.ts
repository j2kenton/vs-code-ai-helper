import * as vscode from "vscode";
import {
  buildCopilotRequestOptions,
  resolveCopilotModel,
} from "./copilotModelResolution";
import {
  AgentAvailability,
  AgentRunner,
  AgentRunnerCapabilities,
  AgentRunRequest,
  AgentRunResult,
} from "../types/agentRunner";
import { withAttribution, writeTextFile } from "../utils/fileUtils";
import { classifyFailure } from "../utils/quota";

/**
 * Runner that uses the user's existing GitHub Copilot access through
 * VS Code's Language Model API. Requires no API key: authentication,
 * entitlement, and quota are handled entirely by VS Code/Copilot.
 */
export class CopilotLanguageModelRunner implements AgentRunner {
  readonly id = "copilot-lm";
  readonly label = "GitHub Copilot (Language Model API)";
  readonly capabilities: AgentRunnerCapabilities = {
    planning: true,
    review: true,
  };

  async isAvailable(): Promise<AgentAvailability> {
    try {
      const models = await vscode.lm.selectChatModels({ vendor: "copilot" });
      if (models.length === 0) {
        return {
          available: false,
          reason:
            "No Copilot language models are available. Sign in to GitHub Copilot in VS Code to use this feature.",
        };
      }
      return { available: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        available: false,
        reason: `Copilot language models are unavailable: ${message}`,
      };
    }
  }

  async run(
    request: AgentRunRequest,
    token: vscode.CancellationToken
  ): Promise<AgentRunResult> {
    let models: vscode.LanguageModelChat[];
    try {
      models = await vscode.lm.selectChatModels({ vendor: "copilot" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return classifyFailure<AgentRunResult>({
        runnerId: this.id,
        status: "failed",
        errorMessage: `Failed to select a Copilot model: ${message}`,
      });
    }

    if (models.length === 0) {
      return classifyFailure<AgentRunResult>({
        runnerId: this.id,
        status: "failed",
        errorMessage:
          "No Copilot language models are available. Sign in to GitHub Copilot in VS Code and try again.",
      });
    }

    const resolved = resolveCopilotModel(models, request.modelId);
    if (!resolved.ok) {
      return {
        runnerId: this.id,
        status: "failed",
        failureKind: resolved.failureKind,
        errorMessage: resolved.errorMessage,
      };
    }
    const { model } = resolved;

    const messages = [vscode.LanguageModelChatMessage.User(request.prompt)];
    const requestOptions = buildCopilotRequestOptions(resolved.parsedModel);

    try {
      const response = await model.sendRequest(messages, requestOptions, token);

      let output = "";
      for await (const fragment of response.text) {
        output += fragment;
      }

      if (token.isCancellationRequested) {
        return { runnerId: this.id, status: "cancelled" };
      }

      const signedOutput = withAttribution(output, "GitHub Copilot", model.name);
      await writeTextFile(request.outputFile, signedOutput);

      return {
        runnerId: this.id,
        status: "completed",
        outputFile: request.outputFile,
        modelId: model.id,
        summary: `Generated ${output.length} characters using ${model.name}.`,
      };
    } catch (error) {
      if (
        error instanceof vscode.LanguageModelError ||
        error instanceof Error
      ) {
        if (token.isCancellationRequested) {
          return { runnerId: this.id, status: "cancelled" };
        }
        return classifyFailure<AgentRunResult>({
          runnerId: this.id,
          status: "failed",
          errorMessage: error.message,
        });
      }
      return classifyFailure<AgentRunResult>({
        runnerId: this.id,
        status: "failed",
        errorMessage: String(error),
      });
    }
  }
}
