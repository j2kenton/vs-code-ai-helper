/**
 * Request-local Language Model tool-session transport (plan §7.2/§7.6) —
 * the Copilot LM adapter that makes `preflight`/`edit` modes selectable.
 *
 * Drives the multi-round tool-calling loop exclusively through the §1.6
 * compatibility boundary (`vscodeLmCompat.ts`): capability is probed before
 * any prompt is sent, tools are attached REQUEST-LOCALLY per sendRequest
 * (never registered globally), every neutral tool call is dispatched to the
 * per-attempt `RequestLocalToolHandlerV1`, and only a final round with zero
 * tool calls writes its text into the broker-owned bounded writer. The
 * transport never sees paths or file content semantics — the handler owns
 * all of that; this module owns only the round loop and its caps.
 *
 * Mirrors the round structure `copilotImplementationRunner.ts` proved in
 * production, re-seated on the V1 transport contract (§3.2): no artifact
 * destination, no result files — the broker owns capture and sealing.
 */
import * as vscode from "vscode";
import {
  buildCopilotRequestOptions,
  resolveCopilotModel,
} from "../runners/copilotModelResolution";
import { COPILOT_LM_RUNNER_ID } from "../runners/copilotLanguageModelRunner";
import {
  AgentExecutionRequestV1,
  AgentTransportExitV1,
  AgentTransportV1,
  BoundedResultWriterV1,
} from "../types/agentExecutionV1";
import {
  MAX_TOOL_PROTOCOL_VIOLATIONS_V1,
  MAX_TOOL_ROUNDS_V1,
} from "../types/workflowToolProtocolV1";
import { RequestLocalToolHandlerV1 } from "./requestLocalToolHandlerV1";
import {
  VscodeLmModuleV1,
  attachLmToolsV1,
  createLmToolResultPartV1,
  createLmAssistantMessageWithPartsV1,
  createLmUserMessageWithPartsV1,
  iterateLmResponsePartsV1,
  probeLmToolCallingHostCapabilityV1,
} from "./vscodeLmCompat";

export interface CopilotLmToolSessionOptionsV1 {
  /** Provider-native (unqualified) model id; undefined runs the provider default. */
  readonly model: string | undefined;
  readonly toolHandler: RequestLocalToolHandlerV1;
  /** Round cap override for tests; production uses MAX_TOOL_ROUNDS_V1. */
  readonly maxRounds?: number;
}

export function createCopilotLmToolSessionTransportV1(
  options: CopilotLmToolSessionOptionsV1
): AgentTransportV1 {
  const vscodeModule = vscode as unknown as VscodeLmModuleV1;
  const maxRounds = options.maxRounds ?? MAX_TOOL_ROUNDS_V1;

  return {
    runnerId: COPILOT_LM_RUNNER_ID,
    async invoke(
      request: AgentExecutionRequestV1,
      output: BoundedResultWriterV1
    ): Promise<AgentTransportExitV1> {
      // Fail closed BEFORE any prompt is sent (§1.6/§7.5): an old host must
      // produce one readable exit, never a mid-round constructor throw.
      const capability = probeLmToolCallingHostCapabilityV1(vscodeModule);
      if (!capability.supported) {
        return { kind: "transportFailure", code: "lmToolApiUnavailable" };
      }

      let models: vscode.LanguageModelChat[];
      try {
        models = await vscode.lm.selectChatModels({ vendor: "copilot" });
      } catch {
        return { kind: "transportFailure", code: "copilotModelSelectionFailed" };
      }
      if (models.length === 0) {
        return { kind: "transportFailure", code: "copilotNoModelsAvailable" };
      }
      const resolved = resolveCopilotModel(models, options.model);
      if (!resolved.ok) {
        return { kind: "transportFailure", code: "copilotModelUnresolved" };
      }

      const requestOptions = attachLmToolsV1(
        buildCopilotRequestOptions(resolved.parsedModel),
        options.toolHandler.descriptors
      );
      const messages: vscode.LanguageModelChatMessage[] = [
        vscode.LanguageModelChatMessage.User(request.prompt),
      ];

      for (let round = 0; round < maxRounds; round++) {
        if (request.cancellationToken.isCancellationRequested) {
          return { kind: "callerCancelled" };
        }

        let roundText = "";
        const assistantRawParts: unknown[] = [];
        const toolResultParts: unknown[] = [];
        let sawToolCall = false;

        try {
          const response = await resolved.model.sendRequest(
            messages,
            requestOptions,
            request.cancellationToken
          );
          for await (const { part, raw } of iterateLmResponsePartsV1(vscodeModule, response)) {
            assistantRawParts.push(raw);
            if (part.kind === "text") {
              roundText += part.value;
              continue;
            }
            sawToolCall = true;
            const resultText = await options.toolHandler.handleToolCall(part);
            toolResultParts.push(createLmToolResultPartV1(vscodeModule, part.callId, resultText));
            if (options.toolHandler.violationCount() > MAX_TOOL_PROTOCOL_VIOLATIONS_V1) {
              return { kind: "transportFailure", code: "toolProtocolViolation" };
            }
          }
        } catch {
          if (request.cancellationToken.isCancellationRequested) {
            return { kind: "callerCancelled" };
          }
          return { kind: "transportFailure", code: "copilotRequestFailed" };
        }

        if (!sawToolCall) {
          // Final round: only THIS round's text is the provider result —
          // interim narration between tool rounds is deliberately discarded.
          if (!output.write(roundText)) {
            // Overflowed; the broker reports the terminal overflow state.
          }
          if (request.cancellationToken.isCancellationRequested) {
            return { kind: "callerCancelled" };
          }
          return { kind: "completed" };
        }

        messages.push(createLmAssistantMessageWithPartsV1(vscodeModule, assistantRawParts));
        messages.push(createLmUserMessageWithPartsV1(vscodeModule, toolResultParts));
      }

      return { kind: "transportFailure", code: "toolRoundLimitExceeded" };
    },
  };
}
