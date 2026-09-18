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
  AgentExecutionModeV1,
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
  EMPTY_PLAN_WITHOUT_READS_NUDGE_MESSAGE_V1,
  isUninformedEmptyPreflightPlanV1,
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
  /** Per-call `countTokens` deadline override for tests. */
  readonly countTokensTimeoutMs?: number;
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
/**
 * How many times one session may be sent back for answering with an empty plan
 * having read nothing. One: the round is allowed to conclude there is nothing
 * to build, it just has to look first — a second push would be arguing with
 * it. See `isUninformedEmptyPreflightPlanV1`.
 */
const MAX_EMPTY_PLAN_NUDGES_V1 = 1;

/**
 * How many rounds before the cap a text or preflight session starts being told
 * how many remain.
 *
 * Without it the model has no idea the cap exists: on 2026-09-15 a Copilot
 * High-Level Code Review (gpt-5.6-sol) spent all 64 rounds reading, every
 * request succeeding, and ended in `toolRoundLimitExceeded` with nothing to
 * show for it (v1 fixes 2, item 26). Six gives room to finish a last batch of
 * reads and still answer.
 */
export const TOOL_ROUND_WIND_DOWN_NOTICE_ROUNDS_V1 = 6;

/**
 * The notice appended after a round when `roundsLeft` rounds remain.
 *
 * A preflight session gets its own wording: its "final result" is a plan of
 * operations, and the generic "answer from what you have read" was answered
 * on 2026-09-18 (v1 fixes 2, run 2060) with an EMPTY plan after 59 rounds of
 * successful reads — the model treated the notice as "stop", not "commit".
 * Everything it read gave it an observationId and exact text, which is all a
 * `patchFile` needs; the notice has to say so.
 */
export function toolRoundWindDownNoticeV1(roundsLeft: number, mode?: AgentExecutionModeV1): string {
  if (mode === "preflight") {
    if (roundsLeft <= 1) {
      return (
        "Tool round limit: your next reply is the LAST one this session allows. If it calls a tool, " +
        "the session ends with no result and everything you have read is lost. Reply now with your " +
        "`preflight-plan.v1`, authored from the observations you already hold: every file you read " +
        "gave you an observationId and exact text, which is all a `patchFile` needs. A smaller slice " +
        "than you intended is expected. An empty plan discards everything this session read."
      );
    }
    return (
      `Tool round limit: ${roundsLeft} rounds remain in this session. Stop exploring: choose the ` +
      "slice you can author from what you have already read, spend at most one more reply on reads " +
      "that slice still depends on, then reply with your `preflight-plan.v1`. A session that runs " +
      "out of rounds produces no result at all, and an empty plan is not a way to stop early."
    );
  }
  if (roundsLeft <= 1) {
    return (
      "Tool round limit: your next reply is the LAST one this session allows. If it calls a tool, " +
      "the session ends with no result and everything you have read is lost. Reply now with your " +
      "complete final result frame, as the result contract requires, based on what you have " +
      "already read. Where you could not verify something, say so in the result as a confidence " +
      "limitation."
    );
  }
  return (
    `Tool round limit: ${roundsLeft} rounds remain in this session. Read only what your answer ` +
    "still depends on, putting the remaining reads in as few replies as you can, then reply with " +
    "your complete final result frame. A session that runs out of rounds produces no result at all."
  );
}

/**
 * Share of the model's advertised `maxInputTokens` this session lets its own
 * conversation occupy before it starts shedding old tool results.
 *
 * Why the session must police this itself (v1 fixes 2, item 17): Copilot's LM
 * provider renders every request through prompt-tsx under the model's prompt
 * budget, and when the conversation is over budget it does NOT fail — it
 * prunes, oldest message first. The first casualty is the original prompt;
 * the next is the first assistant turn, whose tool calls vanish while their
 * tool results survive. The Responses API then rejects the orphaned result:
 * `400 No tool call found for function call output with call_id …`.
 * Observed 2026-09-11 on two consecutive High-Level Code Reviews
 * (gpt-5.6-sol@high) of a change spanning ~1.3 MB of source; the same model
 * had succeeded 45 minutes earlier on a review that read less. It looked
 * like quota and was not.
 *
 * The remainder of the limit is headroom for what the provider adds on top
 * of these messages. In Copilot's provider that is its own system prompt,
 * the tool schemas and a 3-token constant (`modelMaxPromptTokens − base −
 * 3 − tool tokens`, Copilot Chat 0.65.0) — a few thousand tokens at most.
 *
 * Was 0.7 against a pessimistic byte estimate, which together cut at roughly
 * 55% of the real window: on 2026-09-11 16:50 a review whose third round read
 * several large files was refused at ~108k *estimated* tokens — about 80k
 * real, comfortably inside the window. Sizes now come from the provider's own
 * tokenizer (`countTokensV1`), so the margin can be the provider's overhead
 * rather than the estimate's error.
 */
export const TOOL_SESSION_CONTEXT_BUDGET_FRACTION_V1 = 0.85;

/**
 * Ceiling on the input size the budget above is taken from, whatever the
 * model advertises.
 *
 * `maxInputTokens` is NOT the limit Copilot enforces. For a model with
 * long-context pricing, Copilot's model configuration offers a "Context
 * Size" whose default is the smaller standard window; VS Code core
 * (`sendChatRequest` → `getModelConfiguration`) fills schema defaults into
 * every request, extension requests included, and Copilot's provider clones
 * the endpoint down to that size before rendering. `maxInputTokens`, though,
 * reports the full long-context maximum. Budgeting 70% of the advertised
 * figure therefore still overran the real window, and the 2026-09-11 15:42
 * review failed exactly as before, after 15 rounds, on a build that shed
 * against the advertised number.
 *
 * The extension API exposes no way to read the effective window, so this
 * is a fixed ceiling every Copilot chat model's default window clears.
 *
 * It applies to `@…+long` selections too, deliberately. That suffix becomes
 * `modelOptions.model_context_window` (`buildCopilotRequestOptions`), but
 * Copilot's LM provider never reads it: the window comes only from the
 * request's `modelConfiguration.contextSize`, and the provider passes on just
 * `stop`/`temperature`/`max_tokens`/penalty keys from `modelOptions`
 * (checked in Copilot Chat 0.65.0). A `+long` session therefore runs in the
 * default window like any other, and must be budgeted like one.
 */
export const MAX_TOOL_SESSION_CONTEXT_TOKENS_V1 = 128_000;

/**
 * How many times one round may be re-sent after the provider rejects it for
 * an orphaned tool result. That rejection means the conversation was over
 * the provider's real window despite the budget, so each retry first sheds
 * down to half the conversation's current size.
 */
const MAX_ORPHANED_RESULT_RETRIES_V1 = 2;

/**
 * The provider's rejection when its own over-budget pruning removed a tool
 * call but kept that call's result — see TOOL_SESSION_CONTEXT_BUDGET_FRACTION_V1.
 */
export function isOrphanedToolResultRejectionV1(detail: string | undefined): boolean {
  return detail !== undefined && /No tool call found for function call output/i.test(detail);
}

/**
 * Deliberately pessimistic bytes-per-token, used only when the model cannot
 * count for itself (see `countTokensV1`). Source code and JSON-escaped file
 * content tokenize at roughly 3.5–4 bytes per token; assuming 3 overestimates.
 */
const ESTIMATED_BYTES_PER_TOKEN_V1 = 3;

export function estimateLmTokensV1(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / ESTIMATED_BYTES_PER_TOKEN_V1);
}

/**
 * Size `text` with the model's own tokenizer, falling back to the
 * pessimistic estimate when the model offers no `countTokens` or it fails.
 *
 * Strings only, on purpose: Copilot's `provideTokenCount` for a whole
 * message counts text, image and PDF parts and silently skips tool-call and
 * tool-result parts, so a message holding a 150 KB file read counts as
 * almost nothing. Counting the result text directly is the accurate route.
 */
async function countTokensV1(
  model: { countTokens?: unknown },
  text: string,
  abortTokens: readonly vscode.CancellationToken[],
  deadlineMs: number
): Promise<{ readonly tokens: number; readonly timedOut: boolean }> {
  // Neither caller cancellation nor a round deadline is a tokenizer failure:
  // the caller re-checks both right after every count and exits on its own
  // terms. This only has to stop waiting promptly when either fires.
  const alreadyAborted = abortTokens.some((token) => token.isCancellationRequested);
  if (typeof model.countTokens === "function" && !alreadyAborted) {
    // `countTokens` is a cancellable Thenable with no completion guarantee,
    // and the caller's own deadlines cancel tokens this call would otherwise
    // never observe (the prompt is sized before round 1 exists; the round
    // timer cancels the round's token, not the caller's). Bound it here, stop
    // waiting the moment any of them fires — a tokenizer that ignores its
    // token must not delay that — and cancel what it abandons.
    const countCts = new vscode.CancellationTokenSource();
    const subscriptions: vscode.Disposable[] = [];
    const aborted = new Promise<"aborted">((resolve) => {
      for (const token of abortTokens) {
        subscriptions.push(
          token.onCancellationRequested(() => {
            countCts.cancel();
            resolve("aborted");
          })
        );
      }
    });
    try {
      const counted = await raceDeadlineV1(
        Promise.race([
          Promise.resolve(
            (model.countTokens as (text: string, token: vscode.CancellationToken) => Thenable<number>).call(
              model,
              text,
              countCts.token
            )
          ),
          aborted,
        ]),
        deadlineMs
      );
      if (!counted.ok) {
        countCts.cancel();
        return { tokens: estimateLmTokensV1(text), timedOut: true };
      }
      if (typeof counted.value === "number" && Number.isFinite(counted.value) && counted.value >= 0) {
        return { tokens: counted.value, timedOut: false };
      }
    } catch {
      // Fall through to the estimate: sizing must never fail the session.
    } finally {
      for (const subscription of subscriptions) {
        subscription.dispose();
      }
      countCts.dispose();
    }
  }
  return { tokens: estimateLmTokensV1(text), timedOut: false };
}

/**
 * Deadline for one `countTokens` call. Tokenizing is local and takes
 * milliseconds even for a 500 KB file; anything near this is a hang.
 */
export const MAX_COUNT_TOKENS_WALL_CLOCK_MS_V1 = 10_000;

/**
 * Resolved in place of a round's work when the round is abandoned — its
 * deadline fired, or the caller cancelled. A symbol so it can never collide
 * with a tool handler's own string result.
 */
const ROUND_ABANDONED_V1 = Symbol("roundAbandoned");

/**
 * Replacement for a tool result shed to keep the conversation under budget.
 * It keeps the result's `callId`, so the call/result pairing the provider
 * validates stays intact — only the payload is gone, and the model is told
 * how to get it back.
 */
export function elidedToolResultTextV1(originalBytes: number): string {
  return (
    `[Ensemble removed this tool result (${originalBytes} bytes) from the conversation ` +
    "to stay within the model's input limit. Call the tool again if you still need it.]"
  );
}

/**
 * Replacement for a result the model has NOT yet seen, withheld because the
 * round it belongs to read more than fits at once.
 */
export function deferredToolResultTextV1(originalBytes: number): string {
  return (
    `[Ensemble did not include this tool result (${originalBytes} bytes): together with the other ` +
    "files you read in the same step it would exceed the model's input limit. Read it again on its " +
    "own, after you have finished with the others.]"
  );
}

/** One tool result as sent, tracked so it can be shed later. */
interface TrackedToolResultV1 {
  readonly callId: string;
  readonly text: string;
  /** Size of `text` as the model counts it. */
  readonly tokens: number;
  elided: boolean;
  /** Withheld before the model ever saw it (newest round), not shed after. */
  deferred?: boolean;
}

/** What the conversation actually carries for this result right now. */
function sentResultTextV1(result: TrackedToolResultV1): string {
  if (!result.elided) {
    return result.text;
  }
  const bytes = Buffer.byteLength(result.text, "utf8");
  return result.deferred ? deferredToolResultTextV1(bytes) : elidedToolResultTextV1(bytes);
}

/** The user message carrying one round's tool results, by index into `messages`. */
interface TrackedToolResultMessageV1 {
  readonly messageIndex: number;
  readonly results: TrackedToolResultV1[];
}


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
  const countTokensTimeoutMs = options.countTokensTimeoutMs ?? MAX_COUNT_TOKENS_WALL_CLOCK_MS_V1;

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
      let emptyPlanNudges = 0;

      // Conversation-size budget (see TOOL_SESSION_CONTEXT_BUDGET_FRACTION_V1
      // and MAX_TOOL_SESSION_CONTEXT_TOKENS_V1). The advertised limit only
      // ever lowers the ceiling, never raises it.
      const advertisedRaw = (resolved.model as { maxInputTokens?: unknown }).maxInputTokens;
      const advertisedInputTokens =
        typeof advertisedRaw === "number" && advertisedRaw > 0 ? advertisedRaw : undefined;
      const budgetBasisTokens = Math.min(
        advertisedInputTokens ?? MAX_TOOL_SESSION_CONTEXT_TOKENS_V1,
        MAX_TOOL_SESSION_CONTEXT_TOKENS_V1
      );
      let contextBudgetTokens = Math.floor(budgetBasisTokens * TOOL_SESSION_CONTEXT_BUDGET_FRACTION_V1);
      let orphanedResultRetries = 0;
      // After one timeout the tokenizer is treated as unavailable for the rest
      // of the session: otherwise every later result would wait out the same
      // deadline before falling back.
      let tokenizerUnavailable = false;
      // `roundAbortToken` is the active round's own token, so a count made
      // inside a round stops when that round's deadline fires instead of
      // running on under the tokenizer's separate, longer deadline.
      const count = async (text: string, roundAbortToken?: vscode.CancellationToken): Promise<number> => {
        if (tokenizerUnavailable) {
          return estimateLmTokensV1(text);
        }
        const abortTokens =
          roundAbortToken === undefined
            ? [request.cancellationToken]
            : [request.cancellationToken, roundAbortToken];
        const counted = await countTokensV1(resolved.model, text, abortTokens, countTokensTimeoutMs);
        if (counted.timedOut) {
          tokenizerUnavailable = true;
        }
        return counted.tokens;
      };
      // Everything except tool results, which are the only thing ever shed.
      let fixedTokens = await count(request.prompt);
      if (request.cancellationToken.isCancellationRequested) {
        return { kind: "callerCancelled" };
      }
      const trackedResultMessages: TrackedToolResultMessageV1[] = [];

      const conversationTokens = (): number =>
        trackedResultMessages.reduce(
          (sum, message) =>
            sum +
            message.results.reduce(
              (inner, result) =>
                inner + (result.elided ? estimateLmTokensV1(sentResultTextV1(result)) : result.tokens),
              0
            ),
          fixedTokens
        );

      const contextBudgetExceededExit = (estimate: number, rounds: number): AgentTransportExitV1 => ({
        kind: "transportFailure",
        code: "toolSessionContextBudgetExceeded",
        detail:
          `the conversation is ~${estimate} tokens after ${rounds} round(s) even with every earlier ` +
          `tool result removed — over this session's ~${contextBudgetTokens}-token budget ` +
          `(from a ${budgetBasisTokens}-token input limit). Sending it anyway would let ` +
          "the provider silently drop the start of the conversation. Narrow the prompt or pick a " +
          "model with a larger context.",
      });

      const rebuildResultMessage = (tracked: TrackedToolResultMessageV1): void => {
        messages[tracked.messageIndex] = createLmUserMessageWithPartsV1(
          vscodeModule,
          tracked.results.map((result) =>
            createLmToolResultPartV1(vscodeModule, result.callId, sentResultTextV1(result))
          )
        );
      };

      /**
       * Shed tool results until the conversation fits the budget: whole older
       * rounds first, oldest first. If the newest round alone is still too
       * big — the model asked for several large files at once — its largest
       * results are deferred with a note to re-read them separately, keeping
       * at least one. Returns false when even that is not enough.
       */
      const fitConversationToBudget = (): boolean => {
        for (let i = 0; i < trackedResultMessages.length - 1; i++) {
          if (conversationTokens() <= contextBudgetTokens) {
            return true;
          }
          const tracked = trackedResultMessages[i]!;
          if (tracked.results.every((result) => result.elided)) {
            continue;
          }
          for (const result of tracked.results) {
            result.elided = true;
          }
          rebuildResultMessage(tracked);
        }
        const newest = trackedResultMessages[trackedResultMessages.length - 1];
        if (newest && conversationTokens() > contextBudgetTokens) {
          const byLargest = newest.results
            .filter((result) => !result.elided)
            .sort((a, b) => b.tokens - a.tokens);
          for (const result of byLargest.slice(0, -1)) {
            if (conversationTokens() <= contextBudgetTokens) {
              break;
            }
            result.elided = true;
            result.deferred = true;
          }
          rebuildResultMessage(newest);
        }
        return conversationTokens() <= contextBudgetTokens;
      };

      if (!fitConversationToBudget()) {
        return contextBudgetExceededExit(conversationTokens(), 0);
      }

      for (let round = 0; round < maxRounds; round++) {
        if (request.cancellationToken.isCancellationRequested) {
          return { kind: "callerCancelled" };
        }
        if (!fitConversationToBudget()) {
          return contextBudgetExceededExit(conversationTokens(), round);
        }

        let roundText = "";
        const assistantRawParts: unknown[] = [];
        const toolResultParts: unknown[] = [];
        const roundResults: TrackedToolResultV1[] = [];
        let roundToolCallBytes = 0;
        let orphanedRejectionDetail: string | undefined;
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
        // `RequestLocalToolHandlerV1.handleToolCall` takes no cancellation
        // token, so the round deadline — which works by cancelling `roundCts`
        // — cannot reach inside it: a wedged workspace read or edit would park
        // the round indefinitely, the exact unbounded silent wait this
        // deadline exists to convert into a reported failure. Racing the
        // handler against this settles that. The abandoned handler keeps
        // running (see `raceDeadlineV1`'s note on the same trade-off), which
        // is acceptable only because every path that observes it exits the
        // whole transport rather than continuing the round.
        const roundAbandoned = new Promise<typeof ROUND_ABANDONED_V1>((resolve) => {
          roundCts.token.onCancellationRequested(() => resolve(ROUND_ABANDONED_V1));
        });
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
            // A response can carry several tool calls, already buffered, and
            // the edit broker's tools mutate the workspace. Nothing may be
            // dispatched once the caller has cancelled or the round's deadline
            // has passed — including after an await earlier in this loop
            // (the previous call's handler, or sizing its result).
            if (roundTimedOut) {
              return timedOutExit();
            }
            if (request.cancellationToken.isCancellationRequested) {
              return { kind: "callerCancelled" };
            }
            // Racing the handler bounds a wedged READ, but a MUTATION must
            // never be abandoned. Losing the race does not stop the handler:
            // it runs on, and its write can land after this transport has
            // reported a timeout and `taskActionCoordinatorV1` has already
            // moved to the next ranked candidate. The store's revision-exact
            // primitives (`replaceFileExact`/`deleteFileExact` against the
            // preflight revision, `createFileExclusive`) do stop that stale
            // write clobbering the newer attempt's work — it loses
            // atomically and settles the execution `stalePreflight`. What
            // they cannot prevent is the case where the newer attempt has not
            // touched that path yet: one late write lands, with a receipt, on
            // an execution the coordinator has abandoned. Files changing
            // after Ensemble said "timed out" is its own trust problem.
            //
            // RESIDUAL, recorded in `v1 fixes 2` item 17: an edit handler
            // that genuinely wedges holds its round past the deadline.
            //
            // The obvious fix — a cancellation token on
            // `RequestLocalToolHandlerV1.handleToolCall`, checked at each
            // commit point — does NOT close this, and has been proposed and
            // rejected here twice. `workflowFileStoreV1` is raw `fs.promises`
            // (`open`/`lstat`/`readdir` and the write helpers) with no
            // cancellation at any level, so a token could only stop the
            // handler STARTING the next operation; it can never unwedge one
            // already in flight. Bounding an in-flight syscall requires
            // abandoning it — which is exactly the late-write hazard the
            // branch above exists to prevent. The two options at this layer
            // are therefore "bounded, with possible late writes" and "safe,
            // with a possible unbounded wait"; edits take the second.
            //
            // A real fix lives below this file: cancellation plumbed through
            // the file store (which Node cannot do for an in-flight write
            // without a worker/process boundary). Until then this is a latent
            // gap, not a live defect: no handler hang has ever been observed,
            // the documented hangs were LM requests (already covered by the
            // round deadline), and CLI providers never reach this branch —
            // `cliAgentRunner` runs its own `mode: "edit"` path.
            const handled =
              request.mode === "edit"
                ? await options.toolHandler.handleToolCall(part)
                : await Promise.race([
                    Promise.resolve(options.toolHandler.handleToolCall(part)),
                    roundAbandoned,
                  ]);
            if (handled === ROUND_ABANDONED_V1) {
              return roundTimedOut ? timedOutExit() : { kind: "callerCancelled" };
            }
            const resultText = handled;
            roundToolNames.push(part.name);
            const resultBytes = Buffer.byteLength(resultText, "utf8");
            roundResultBytes += resultBytes;
            totalResultBytes += resultBytes;
            toolResultParts.push(createLmToolResultPartV1(vscodeModule, part.callId, resultText));
            // Sized against the round's own token. Both terminal signals are
            // then re-checked, in the same precedence the catch block uses:
            // this single point covers BOTH preceding awaits (the handler and
            // the sizing call), either of which can span a deadline or a
            // cancel. Without it, a round that expired or was cancelled while
            // a result was in flight would fall through to the protocol and
            // result-budget exits below and be reported as one of those —
            // and `callerCancelled` is not a provider fault downstream
            // (`taskActionCoordinatorV1` treats it differently from a
            // transport failure), so mislabelling it burns a candidate for
            // something the user chose to stop.
            const resultTokens = await count(resultText, roundCts.token);
            if (roundTimedOut) {
              return timedOutExit();
            }
            if (request.cancellationToken.isCancellationRequested) {
              return { kind: "callerCancelled" };
            }
            roundResults.push({
              callId: part.callId,
              text: resultText,
              tokens: resultTokens,
              elided: false,
            });
            roundToolCallBytes += Buffer.byteLength(part.name + JSON.stringify(part.input), "utf8");
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
          // The provider pruned this conversation itself and orphaned a tool
          // result (see MAX_TOOL_SESSION_CONTEXT_TOKENS_V1): the request, not
          // the account, was the problem. Retryable only while nothing from
          // this round has been acted on yet.
          if (
            isOrphanedToolResultRejectionV1(detail) &&
            assistantRawParts.length === 0 &&
            orphanedResultRetries < MAX_ORPHANED_RESULT_RETRIES_V1
          ) {
            orphanedRejectionDetail = detail;
          } else {
            return {
              kind: "transportFailure",
              code: "copilotRequestFailed",
              ...(detail !== undefined ? { detail } : {}),
            };
          }
        } finally {
          clearTimeout(roundTimer);
          callerCancelSub.dispose();
          roundCts.dispose();
        }
        if (orphanedRejectionDetail !== undefined) {
          // Halve the budget and shed to it, then resend the same round. If
          // nothing could be shed the retry would send the identical request,
          // so report the rejection instead.
          orphanedResultRetries += 1;
          const before = conversationTokens();
          contextBudgetTokens = Math.floor(before / 2);
          fitConversationToBudget();
          const after = conversationTokens();
          if (after >= before) {
            return { kind: "transportFailure", code: "copilotRequestFailed", detail: orphanedRejectionDetail };
          }
          // Keep the tighter budget for the rest of the session, but no lower
          // than what could actually be reached — otherwise the check at the
          // top of the loop would reject the conversation just shed.
          contextBudgetTokens = Math.max(contextBudgetTokens, after);
          round -= 1;
          continue;
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
            fixedTokens += (await count(roundText)) + (await count(RESULT_FRAME_NUDGE_MESSAGE_V1));
            continue;
          }
          // The frame IS present, and says "no operations" — from a session
          // that never opened a file, so it cannot have been a judgement about
          // the code. Send it back once, with somewhere to go. Sibling of the
          // nudge above and bounded the same way; `attemptsRemaining` matters
          // for the same reason (see that comment).
          if (
            isUninformedEmptyPreflightPlanV1({
              responseText: roundText,
              exactPathObservations: options.toolHandler.exactPathObservationCount?.() ?? 1,
              nudgesUsed: emptyPlanNudges,
              maxNudges: MAX_EMPTY_PLAN_NUDGES_V1,
              attemptsRemaining: round + 1 < maxRounds,
            })
          ) {
            emptyPlanNudges += 1;
            messages.push(createLmAssistantMessageWithPartsV1(vscodeModule, assistantRawParts));
            messages.push(
              vscode.LanguageModelChatMessage.User(EMPTY_PLAN_WITHOUT_READS_NUDGE_MESSAGE_V1)
            );
            fixedTokens +=
              (await count(roundText)) + (await count(EMPTY_PLAN_WITHOUT_READS_NUDGE_MESSAGE_V1));
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
        // Tool-call arguments are a path or two; the estimate is close enough.
        fixedTokens += (await count(roundText)) + Math.ceil(roundToolCallBytes / ESTIMATED_BYTES_PER_TOKEN_V1);
        trackedResultMessages.push({ messageIndex: messages.length - 1, results: roundResults });

        // Warn before the round cap, so the session ends in an answer rather
        // than in `toolRoundLimitExceeded` with everything it read discarded
        // (v1 fixes 2, item 26). Never for an edit session: it is executing
        // sealed steps, and telling it to stop would leave a plan half-applied.
        const roundsLeft = maxRounds - (round + 1);
        if (
          request.mode !== "edit" &&
          roundDeliverableContractV1(request.mode).requiresResultFrame &&
          roundsLeft > 0 &&
          roundsLeft <= TOOL_ROUND_WIND_DOWN_NOTICE_ROUNDS_V1
        ) {
          const notice = toolRoundWindDownNoticeV1(roundsLeft, request.mode);
          messages.push(vscode.LanguageModelChatMessage.User(notice));
          fixedTokens += await count(notice);
        }
      }

      // The loop's own cancellation check is at the TOP of the next
      // iteration, which the final allowed round never reaches — so a cancel
      // landing during that round's post-round accounting would be reported
      // as "too many tool rounds", a provider fault, rather than as the
      // cancellation it was.
      if (request.cancellationToken.isCancellationRequested) {
        return { kind: "callerCancelled" };
      }
      // The detail is what reaches the run log after the closed phrase. Without
      // it this read "the transport failed before any response arrived" after
      // every one of the rounds had in fact been answered.
      return {
        kind: "transportFailure",
        code: "toolRoundLimitExceeded",
        detail: `used all ${maxRounds} tool rounds without replying with a final answer`,
      };
    },
  };
}
