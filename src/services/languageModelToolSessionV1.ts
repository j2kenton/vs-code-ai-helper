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
import {
  RESULT_FRAME_NUDGE_MESSAGE_V1,
  roundDeliverableContractV1,
  shouldNudgeForMissingResultFrameV1,
} from "../types/aiResultEnvelope";
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
  /**
   * Per-round wall-clock deadline override for tests; production uses
   * MAX_TOOL_ROUND_WALL_CLOCK_MS_V1.
   */
  readonly roundTimeoutMs?: number;
  /** Model-enumeration deadline override for tests. */
  readonly modelSelectionTimeoutMs?: number;
}

/**
 * Wall-clock deadline for a single tool-session round (workflow-6 Item 18).
 *
 * The LM API offers no timeout of its own: a `sendRequest` that is accepted
 * and never answered leaves the round awaiting forever. There is no error, no
 * log line, and no state transition — the Chat transaction simply stays at
 * `invocationPending` holding the task's chain guard, indistinguishable in the
 * UI from a round that is working. Observed twice on 2026-08-19 (22 and 30+
 * minutes, both `applyReviewEdit.v1`), roughly one round in three, each ending
 * only because the user gave up and cancelled.
 *
 * Six minutes is deliberately loose: the slowest healthy round observed on a
 * large workload (a 107 KB context pack over a 20-file tree) completed in about
 * four. The point is not to police slow rounds — it is to convert an unbounded
 * silent wait into a reported, retryable failure so an unattended Fast Forward
 * loop keeps going instead of parking for hours.
 *
 * This deadline alone does NOT diagnose the underlying cause — it only proves
 * a round didn't finish in time, not where it got stuck. Item 18 fix 2 (the
 * `LmToolSessionRequestIssuedV1` marker below, fired synchronously right
 * after `sendRequest` is called) is what makes that diagnosable: its presence
 * or absence in the log for a timed-out round tells a later investigation
 * whether the hang was before `sendRequest` was ever reached, or after the
 * provider had already accepted the request.
 */
export const MAX_TOOL_ROUND_WALL_CLOCK_MS_V1 = 6 * 60_000;

/**
 * Deadline for enumerating Copilot models — a local capability query that
 * should answer in milliseconds. Generous only so a genuinely busy host is
 * never cut off; anything approaching this is a hang, not slowness.
 */
export const MAX_MODEL_SELECTION_WALL_CLOCK_MS_V1 = 60_000;

/**
 * Await `work`, giving up after `ms`. Returns `{ ok: false }` on expiry rather
 * than throwing, so a caller distinguishes "timed out" from "rejected" without
 * inspecting error shapes.
 *
 * The abandoned promise keeps running — unavoidable for an API that takes no
 * cancellation token. Only use this where the caller exits regardless, so
 * nothing downstream depends on the result; where a token IS available,
 * cancel it instead (see the per-round deadline).
 */
async function raceDeadlineV1<T>(
  // `Thenable`, not `Promise`: the VS Code API returns its own thenable, which
  // lacks `catch`/`finally`. Only `then` is used here.
  work: Thenable<T>,
  ms: number
): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve(work).then((value) => ({ ok: true as const, value })),
      new Promise<{ readonly ok: false }>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false }), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
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

/**
 * How many times a tool-free round with no result frame may be sent back for
 * the real answer. Two is enough for a model that narrated once and then
 * complied; more would just spend rounds arguing with a model that cannot
 * produce the frame at all.
 */
const MAX_NARRATION_NUDGES_V1 = 2;


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

/**
 * One round's pre-request boundary (workflow-6 Item 18, fix 2). Fired the
 * instant `sendRequest` is called — synchronously, before its Thenable is
 * awaited — so a later hang investigation can tell "never reached the
 * provider" (this line is absent) from "the provider accepted the request
 * and then never answered" (this line is present but the round's own
 * completion/timeout line never follows). Fix 1's per-round deadline
 * (`MAX_TOOL_ROUND_WALL_CLOCK_MS_V1` above) already converts that second
 * case into a reported failure; this marker is what makes the two
 * distinguishable after the fact, which fix 1 alone does not.
 */
export interface LmToolSessionRequestIssuedV1 {
  /** 1-based round number. */
  readonly round: number;
  readonly maxRounds: number;
}

export type LmToolSessionRequestIssuedObserverV1 = (event: LmToolSessionRequestIssuedV1) => void;

let lmToolSessionRequestIssuedObserverV1: LmToolSessionRequestIssuedObserverV1 | undefined;

/** Wire a sink for the pre-request boundary marker. Same optional-seam pattern as the round observer above. */
export function setLmToolSessionRequestIssuedObserverV1(
  observer: LmToolSessionRequestIssuedObserverV1 | undefined
): void {
  lmToolSessionRequestIssuedObserverV1 = observer;
}

/** Report, never affect. A throwing observer must not change session behaviour. */
function recordLmToolSessionRequestIssuedV1(event: LmToolSessionRequestIssuedV1): void {
  try {
    lmToolSessionRequestIssuedObserverV1?.(event);
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
  const roundTimeoutMs = options.roundTimeoutMs ?? MAX_TOOL_ROUND_WALL_CLOCK_MS_V1;
  const modelSelectionTimeoutMs =
    options.modelSelectionTimeoutMs ?? MAX_MODEL_SELECTION_WALL_CLOCK_MS_V1;

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

      // Model enumeration is awaited BEFORE the round loop, so the per-round
      // deadline below does not cover it — and it is every bit as unbounded.
      // A hang here is indistinguishable from a hang in `sendRequest` from
      // the outside (transaction pinned at `invocationPending`, no round, no
      // run log, no context pack), which is exactly the state observed at
      // 16:55 on 2026-08-19 while a per-round deadline was already shipped.
      //
      // Raced rather than cancelled: `selectChatModels` takes no cancellation
      // token, so abandoning the promise is the only option available. That
      // is acceptable here precisely because the whole transport exits — no
      // later code depends on the abandoned promise.
      let models: vscode.LanguageModelChat[];
      try {
        const selection = await raceDeadlineV1(
          vscode.lm.selectChatModels({ vendor: "copilot" }),
          modelSelectionTimeoutMs
        );
        if (!selection.ok) {
          return {
            kind: "transportFailure",
            code: "copilotModelSelectionTimedOut",
            detail:
              `enumerating Copilot models did not answer within ` +
              `${Math.round(modelSelectionTimeoutMs / 1000)}s`,
          };
        }
        models = selection.value;
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
      let narrationNudges = 0;

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

        // Wall-clock deadline for THIS round (workflow-6 Item 18). Without
        // it a round that never answers waits forever: the Chat transaction
        // sits at `invocationPending` with one transition and no log, the
        // task's chain guard is held, and the only exit is a human noticing
        // and cancelling. Observed twice on 2026-08-19 (22 and 30+ minutes,
        // both `applyReviewEdit.v1`) — roughly one round in three.
        //
        // Per-round rather than per-session on purpose: the failure is a
        // single request that never returns, and a session cap generous
        // enough for many legitimate tool rounds would be far too loose to
        // catch it. A healthy round on this workload completes in ~4 minutes.
        //
        // Cancelling a token the request is already listening to (rather than
        // racing promises) means the in-flight request and its stream are
        // actually abandoned — a `Promise.race` would leave the `for await`
        // below running against a response nobody reads.
        const roundCts = new vscode.CancellationTokenSource();
        const callerCancelSub = request.cancellationToken.onCancellationRequested(() =>
          roundCts.cancel()
        );
        let roundTimedOut = false;
        const roundTimer = setTimeout(() => {
          roundTimedOut = true;
          roundCts.cancel();
        }, roundTimeoutMs);
        const timedOutExit = (): AgentTransportExitV1 => {
          recordLmToolSessionRoundV1({
            round: round + 1,
            maxRounds,
            toolNames: roundToolNames,
            roundResultBytes,
            totalResultBytes,
          });
          return {
            kind: "transportFailure",
            code: "copilotRequestTimedOut",
            // NOT "produced no response": this deadline spans the whole round
            // — request, full stream, and tool-call handling — so it can fire
            // mid-stream on a round that produced plenty of text and tool
            // calls but never finished. Describing that as "no response"
            // would be the same species of misdiagnosis this module rejects
            // elsewhere (see the catch-ordering note below).
            detail:
              `round ${round + 1} exceeded the ${Math.round(roundTimeoutMs / 1000)}s wall-clock ` +
              "deadline and was abandoned",
          };
        };
        try {
          const sendRequestThenable = resolved.model.sendRequest(
            messages,
            requestOptions,
            roundCts.token
          );
          // Synchronous, before the await below: proves the call actually
          // reached `vscode.lm`'s request path for this round, independent of
          // whether the Thenable it returned ever settles.
          recordLmToolSessionRequestIssuedV1({ round: round + 1, maxRounds });
          const response = await sendRequestThenable;
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
              // Report BEFORE returning: a terminal round is the most
              // diagnostically valuable one, and returning straight out left
              // it absent from telemetry entirely.
              recordLmToolSessionRoundV1({
                round: round + 1,
                maxRounds,
                toolNames: roundToolNames,
                roundResultBytes,
                totalResultBytes,
              });
              return { kind: "transportFailure", code: "toolProtocolViolation" };
            }
            // Stop before the NEXT round resends everything accumulated so
            // far. Checked inside the part loop rather than at the round
            // boundary so a single round that reads far too much cannot blow
            // straight past the cap.
            if (totalResultBytes > maxResultBytes) {
              // Likewise — and this is the round that MOST needs recording,
              // since the observer exists to make runaway usage visible.
              recordLmToolSessionRoundV1({
                round: round + 1,
                maxRounds,
                toolNames: roundToolNames,
                roundResultBytes,
                totalResultBytes,
              });
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
          // Order matters: the deadline cancels `roundCts`, so the throw here
          // looks exactly like a cancellation. Check the timeout FIRST, or a
          // timed-out round is misreported as the user cancelling — the same
          // silent-misdiagnosis this item exists to remove.
          if (roundTimedOut) {
            return timedOutExit();
          }
          if (request.cancellationToken.isCancellationRequested) {
            return { kind: "callerCancelled" };
          }
          // Bind and carry the cause. This was a bare `catch {}`: the error
          // object was discarded without even reaching a variable, so
          // `copilotRequestFailed` surfaced with nothing behind it and a
          // prompt-too-large, a quota refusal and a transient API fault were
          // indistinguishable — each needing a different remedy.
          // `sendRequest` relays the upstream provider's own error body
          // verbatim (observed: a Fireworks-hosted structured JSON payload,
          // a firewall/HTTP2 message) — the default 200-char bound cut those
          // mid-sentence, so this site gets a wider allowance.
          const detail = boundedTransportDetailV1(error, 800);
          return {
            kind: "transportFailure",
            code: "copilotRequestFailed",
            ...(detail !== undefined ? { detail } : {}),
          };
        } finally {
          clearTimeout(roundTimer);
          callerCancelSub.dispose();
          roundCts.dispose();
        }
        // A stream that ENDS on cancellation rather than throwing would fall
        // through the try with a truncated round and no error, so the
        // deadline has to be re-checked outside the catch as well.
        if (roundTimedOut) {
          return timedOutExit();
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
          // A round with no tool calls ENDS the session, so a model that uses
          // one to think out loud loses its real answer. Observed 2026-08-18
          // (jester review): after reading the files it wrote a paragraph of
          // findings ending "Now I'll write the re-review frame." — and the
          // session closed, recording that narration as the review. The round
          // was rejected for having no `Readiness: N/10` line, and the work it
          // had just correctly verified was thrown away.
          //
          // A response that carries no result frame is not an answer. Nudge
          // once per remaining round, bounded, before accepting it: cheap
          // compared to discarding a completed round, and it cannot loop
          // forever because `maxRounds` still governs.
          // `round + 1 < maxRounds` matters: nudging on the LAST round spends
          // the loop's final iteration and falls through to
          // `toolRoundLimitExceeded`, reporting "too many tool rounds" for
          // what was actually "no result frame" — a misdiagnosis worse than
          // simply accepting the text. With no round left, accept and let the
          // envelope parser reject it with an accurate reason.
          if (
            shouldNudgeForMissingResultFrameV1({
              responseText: roundText,
              requiresResultFrame: roundDeliverableContractV1(request.mode).requiresResultFrame,
              nudgesUsed: narrationNudges,
              maxNudges: MAX_NARRATION_NUDGES_V1,
              attemptsRemaining: round + 1 < maxRounds,
            })
          ) {
            narrationNudges += 1;
            messages.push(createLmAssistantMessageWithPartsV1(vscodeModule, assistantRawParts));
            messages.push(
              vscode.LanguageModelChatMessage.User(RESULT_FRAME_NUDGE_MESSAGE_V1)
            );
            continue;
          }
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
