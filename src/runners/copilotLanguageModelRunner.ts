import * as vscode from "vscode";
import {
  AgentAvailability,
  AgentRunner,
  AgentRunnerCapabilities,
  AgentRunRequest,
  AgentRunResult,
} from "../types/agentRunner";
import { writeTextFile } from "../utils/fileUtils";

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
      return {
        runnerId: this.id,
        status: "failed",
        errorMessage: `Failed to select a Copilot model: ${message}`,
      };
    }

    const requestedModel = request.modelId
      ? models.find((candidate) => candidate.id === request.modelId)
      : undefined;
    const model = requestedModel ?? models[0];
    if (!model) {
      return {
        runnerId: this.id,
        status: "failed",
        errorMessage:
          "No Copilot language models are available. Sign in to GitHub Copilot in VS Code and try again.",
      };
    }

    const messages = [vscode.LanguageModelChatMessage.User(request.prompt)];

    try {
      const response = await model.sendRequest(messages, {}, token);

      let output = "";
      for await (const fragment of response.text) {
        output += fragment;
      }

      if (token.isCancellationRequested) {
        return { runnerId: this.id, status: "cancelled" };
      }

      await writeTextFile(request.outputFile, output);

      const fallbackNote =
        request.modelId && !requestedModel
          ? ` Requested model ${request.modelId} was unavailable, so ${model.name} was used instead.`
          : "";

      return {
        runnerId: this.id,
        status: "completed",
        outputFile: request.outputFile,
        summary: `Generated ${output.length} characters using ${model.name}.${fallbackNote}`,
      };
    } catch (error) {
      if (
        error instanceof vscode.LanguageModelError ||
        error instanceof Error
      ) {
        if (token.isCancellationRequested) {
          return { runnerId: this.id, status: "cancelled" };
        }
        return {
          runnerId: this.id,
          status: "failed",
          errorMessage: error.message,
        };
      }
      return {
        runnerId: this.id,
        status: "failed",
        errorMessage: String(error),
      };
    }
  }
}
