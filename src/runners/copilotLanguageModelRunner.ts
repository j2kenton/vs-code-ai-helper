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
import {
  AgentExecutionRequestV1,
  AgentTransportExitV1,
  AgentTransportV1,
  boundedTransportDetailV1,
  BoundedResultWriterV1,
  classifyNetworkFaultV1,
} from "../types/agentExecutionV1";
import { withAttribution, writeTextFile } from "../utils/fileUtils";
import { classifyFailure } from "../utils/quota";

/** Stable runner identity shared by the legacy runner and the V1 transport. */
export const COPILOT_LM_RUNNER_ID = "copilot-lm";

/**
 * V1 transport (plan §3.2/§3.4) for the Copilot Language Model text path:
 * streams the model's response fragments straight into the broker-owned
 * bounded writer and reports only how the provider exited. Unlike the legacy
 * runner below it receives no artifact destination and writes no file — the
 * broker (`agentExecutionBrokerV1.ts`) owns all result capture, sealing, and
 * hashing (AC-RUNNER-01). Selection happens in `runnerRegistry.ts`
 * (`openV1RunnerSelection`); this factory only binds the reserved
 * provider-native model id into a transport, which is not an invocation.
 */
export function createCopilotLmTextTransportV1(options: {
  /** Provider-native (unqualified) model id; undefined runs the provider default. */
  model: string | undefined;
}): AgentTransportV1 {
  return {
    runnerId: COPILOT_LM_RUNNER_ID,
    async invoke(
      request: AgentExecutionRequestV1,
      output: BoundedResultWriterV1
    ): Promise<AgentTransportExitV1> {
      let models: vscode.LanguageModelChat[];
      try {
        models = await vscode.lm.selectChatModels({ vendor: "copilot" });
      } catch (error) {
        // Was a bare `catch {}` — see the identical fix below for
        // `sendRequest`'s failure path and its reasoning.
        const detail = boundedTransportDetailV1(error);
        return {
          kind: "transportFailure",
          code: "copilotModelSelectionFailed",
          ...(detail !== undefined ? { detail } : {}),
        };
      }
      if (models.length === 0) {
        return { kind: "transportFailure", code: "copilotNoModelsAvailable" };
      }
      const resolved = resolveCopilotModel(models, options.model);
      if (!resolved.ok) {
        return { kind: "transportFailure", code: "copilotModelUnresolved" };
      }
      const messages = [vscode.LanguageModelChatMessage.User(request.prompt)];
      const requestOptions = buildCopilotRequestOptions(resolved.parsedModel);
      try {
        const response = await resolved.model.sendRequest(
          messages,
          requestOptions,
          request.cancellationToken
        );
        for await (const fragment of response.text) {
          if (!output.write(fragment)) {
            // Overflowed: the writer has discarded everything and accepts no
            // more; the broker reports the terminal overflow state.
            break;
          }
        }
      } catch (error) {
        if (request.cancellationToken.isCancellationRequested) {
          return { kind: "callerCancelled" };
        }
        // See the identical site in languageModelToolSessionV1.ts: this was a
        // bare `catch {}`, so whatever `sendRequest` threw was unrecoverable
        // and the run record settled at 74 bytes with nothing but a code.
        // `sendRequest` relays the upstream provider's own error body
        // verbatim (observed: a Fireworks-hosted structured JSON payload, a
        // firewall/HTTP2 message) — the default 200-char bound cut those
        // mid-sentence, so this site gets a wider allowance.
        const detail = boundedTransportDetailV1(error, 800);
        // Item 14: a dropped HTTP/2 connection (net::ERR_HTTP2_PROTOCOL_ERROR,
        // observed 2026-08-18) is a fault of the pipe, not the model — flag it
        // so the broker treats it as fallback/retry-eligible even though
        // `output.write` may already have captured partial fragments above.
        const networkFault = classifyNetworkFaultV1(error);
        return {
          kind: "transportFailure",
          code: "copilotRequestFailed",
          ...(detail !== undefined ? { detail } : {}),
          ...(networkFault ? { networkFault: true } : {}),
        };
      }
      if (request.cancellationToken.isCancellationRequested) {
        return { kind: "callerCancelled" };
      }
      return { kind: "completed" };
    },
  };
}

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
    assistant: true,
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
        // Prefer echoing back exactly what was requested, not the resolved
        // vscode.LanguageModelChat's own `.id`: parseCopilotModelSelection
        // strips a "@reasoningEffort" suffix (e.g. "gpt-5.4@high") before
        // matching it to a model by base id, so `model.id` alone would
        // silently drop that suffix — making a stage's own configured
        // variant look, to a caller reconciling "what model actually ran"
        // against stored qualified ids (e.g. qualifiedRanModelId in
        // reviewActions.ts), like a completely different model just ran.
        // Falls back to `model.id` only when no specific model was
        // requested (the provider's own default ran), so that case still
        // names a real, concrete model instead of reporting nothing.
        modelId: request.modelId ?? model.id,
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
