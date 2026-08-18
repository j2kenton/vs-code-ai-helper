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
  boundedTransportDetailV1,
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
  /**
   * Cumulative tool-result byte budget override for tests; production uses
   * MAX_TOOL_SESSION_RESULT_BYTES_V1.
   */
  readonly maxResultBytes?: number;
}

/**
 * Cumulative cap on tool-result bytes fed back into one session.
 *
 * The round loop re-sends the ENTIRE message history every round, so every
 * tool result is paid for again on each subsequent round: cost grows roughly
 * quadratically in rounds, not linearly. With `MAX_TOOL_ROUNDS_V1` at 64 and
 * `MAX_READ_FILE_BYTES_V1` at 512 KB per read, an unlucky session can bill for
 * hundreds of MB of resent context while producing nothing.
 *
 * Observed 2026-08-17: a Copilot session ran long enough that the operator
 * cancelled it on suspicion of being wedged, having no way to tell spend from
 * a hang. It was working. There was no budget and no signal.
 *
 * 8 MB of accumulated tool results is far above any legitimate edit-planning
 * session (the largest observed real plan read well under 1 MB) and far below
 * the runaway case.
 */
export const MAX_TOOL_SESSION_RESULT_BYTES_V1 = 8 * 1024 * 1024;

/** One round's activity, reported for observability. Never affects behaviour. */
export interface LmToolSessionRoundV1 {
  /** 1-based round number. */
  readonly round: number;
  readonly maxRounds: number;
  /** Tool names called this round, in call order. */
  readonly toolNames: readonly string[];
  /** Bytes of tool results produced this round. */
  readonly roundResultBytes: number;
  /** Cumulative tool-result bytes across the session so far. */
  readonly totalResultBytes: number;
}

export type LmToolSessionObserverV1 = (round: LmToolSessionRoundV1) => void;

let lmToolSessionObserverV1: LmToolSessionObserverV1 | undefined;

/**
 * Wire a sink for per-round session activity. Optional seam rather than a
 * direct logger import, matching `setInertTrailingObserverV1`'s pattern: a
 * tool session previously emitted NOTHING for up to 64 rounds, so a working
 * run and a wedged one were indistinguishable from outside.
 */
export function setLmToolSessionObserverV1(observer: LmToolSessionObserverV1 | undefined): void {
  lmToolSessionObserverV1 = observer;
}

/** Report, never affect. A throwing observer must not change session behaviour. */
function recordLmToolSessionRoundV1(round: LmToolSessionRoundV1): void {
  try {
    lmToolSessionObserverV1?.(round);
  } catch {
    // Observation is a side channel; session correctness cannot depend on it.
  }
}

export function createCopilotLmToolSessionTransportV1(
  options: CopilotLmToolSessionOptionsV1
): AgentTransportV1 {
  const vscodeModule = vscode as unknown as VscodeLmModuleV1;
  const maxRounds = options.maxRounds ?? MAX_TOOL_ROUNDS_V1;
  const maxResultBytes = options.maxResultBytes ?? MAX_TOOL_SESSION_RESULT_BYTES_V1;

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

      const requestOptions = attachLmToolsV1(
        buildCopilotRequestOptions(resolved.parsedModel),
        options.toolHandler.descriptors
      );
      const messages: vscode.LanguageModelChatMessage[] = [
        vscode.LanguageModelChatMessage.User(request.prompt),
      ];

      let totalResultBytes = 0;

      for (let round = 0; round < maxRounds; round++) {
        if (request.cancellationToken.isCancellationRequested) {
          return { kind: "callerCancelled" };
        }

        let roundText = "";
        const assistantRawParts: unknown[] = [];
        const toolResultParts: unknown[] = [];
        const roundToolNames: string[] = [];
        let roundResultBytes = 0;
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
            roundToolNames.push(part.name);
            const resultBytes = Buffer.byteLength(resultText, "utf8");
            roundResultBytes += resultBytes;
            totalResultBytes += resultBytes;
            toolResultParts.push(createLmToolResultPartV1(vscodeModule, part.callId, resultText));
            if (options.toolHandler.violationCount() > MAX_TOOL_PROTOCOL_VIOLATIONS_V1) {
              return { kind: "transportFailure", code: "toolProtocolViolation" };
            }
            // Stop before the NEXT round resends everything accumulated so
            // far. Checked inside the part loop rather than at the round
            // boundary so a single round that reads far too much cannot blow
            // straight past the cap.
            if (totalResultBytes > maxResultBytes) {
              return {
                kind: "transportFailure",
                code: "toolSessionResultBudgetExceeded",
                detail:
                  `tool results reached ${totalResultBytes} bytes across ${round + 1} round(s), ` +
                  `over the ${maxResultBytes}-byte session budget`,
              };
            }
          }
        } catch (error) {
          if (request.cancellationToken.isCancellationRequested) {
            return { kind: "callerCancelled" };
          }
          // Bind and carry the cause. This was a bare `catch {}`: the error
          // object was discarded without even reaching a variable, so
          // `copilotRequestFailed` surfaced with nothing behind it and a
          // prompt-too-large, a quota refusal and a transient API fault were
          // indistinguishable — each needing a different remedy.
          const detail = boundedTransportDetailV1(error);
          return {
            kind: "transportFailure",
            code: "copilotRequestFailed",
            ...(detail !== undefined ? { detail } : {}),
          };
        }

        // Report AFTER the round settles so the record is complete, and
        // unconditionally — a round with zero tool calls is the final one and
        // is exactly as interesting as a busy one for "what is it doing?".
        recordLmToolSessionRoundV1({
          round: round + 1,
          maxRounds,
          toolNames: roundToolNames,
          roundResultBytes,
          totalResultBytes,
        });

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
