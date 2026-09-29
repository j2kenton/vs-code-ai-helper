/**
 * Shared, sanitized human/log text for a `TaskActionOutcomeV1` (plan §3.7).
 *
 * Every migrated action needs the same two strings when its coordinator
 * invocation settles: one status line for the run log, and one failure
 * clause for the user-facing error. These were first written inline in
 * `generatePlanWithAI.ts`; `reviewActions.ts` then shipped WITHOUT either,
 * which is what made a failed review silently produce no notification and no
 * run log at all (its `handleReviewOutcomeV1` had no branch for a
 * non-completed, non-questions outcome outside the Publish stage). Sharing
 * them here means a newly migrated action gets the diagnosable behavior by
 * default instead of having to remember to re-derive it.
 *
 * Both functions are exhaustive over the outcome union and carry no raw
 * provider output: plan §3.7's outcome contract is a closed set of stable
 * codes, and §2.2 forbids the model's free-text reply appearing in logs — so
 * these only ever emit kinds, codes, and ids that the contract itself
 * defines. `malformedResult.detail` (2026-08-06) is the one field that adds
 * free text, and it does not weaken this: the coordinator populates it only
 * from OUR OWN parser/schema diagnostics (e.g. "expected the frame to start
 * with <<<...>>>", "received content type X, expected Y") — the model's raw
 * reply text itself never reaches it, though a short, bounded (<=200 char),
 * escaped fragment of a specific field value the provider supplied (e.g. the
 * literal "X"/"Y" above) may, when that is what explains the mismatch.
 * Before this, a malformed result surfaced only its closed-union code (e.g.
 * "invalidFrame") with no way to say WHY, which cost real diagnosis time on
 * a live failure whose actual cause — a complete, correct model response
 * missing only the required output frame — was invisible until the raw
 * response was recovered by hand from the CLI provider's own session store.
 */
import {
  MalformedResultAttemptRecordV1,
  TaskActionOutcomeProviderV1,
  TaskActionOutcomeV1,
} from "../types/taskActionOutcomeV1";
import { attributionModelLabel } from "./fileUtils";

/**
 * Render the same provider/model identity artifact attribution headers use,
 * as a run-log line suffix — so a reader never has to learn two formats for
 * "what actually ran". Absent whenever the outcome carries no provider
 * (e.g. a pre-existing persisted outcome, or an outcome kind that never
 * reaches a provider invocation).
 */
function providerLogSuffix(provider: TaskActionOutcomeProviderV1 | undefined): string {
  if (!provider) {
    return "";
  }
  const model = attributionModelLabel(provider.storedModelId);
  return ` [${provider.providerLabel}${model ? ` (${model})` : ""}]`;
}

/**
 * Run-log suffix naming THIS outcome's own attempt id (2026-09-28
 * implementation-review follow-up to item 6): every prior attempt in a
 * rejection chain got its id on its own "Attempt X rejected" line, but the
 * chain's own FINAL attempt — the one the status line itself reports — had
 * no id anywhere in the run file. Absent for outcomes with no attemptId
 * (every pre-existing outcome, or a kind that never reaches an attempt).
 */
function attemptIdLogSuffix(attemptId: string | undefined): string {
  return attemptId ? ` [attempt=${attemptId}]` : "";
}

/**
 * One "Attempt X rejected (code: detail)" line per prior attempt, oldest
 * first — shared by every outcome kind whose rejection-advancement chain
 * carries `priorRejectedAttemptsV1` (item 6: both `malformedResult`, a bad
 * envelope/frame, and `failed`/`contentContractFailed`, a schema-valid
 * envelope that fails the row's own content rule, share this history shape).
 */
function priorRejectedAttemptLinesV1(
  priorRejectedAttemptsV1: readonly MalformedResultAttemptRecordV1[] | undefined
): string[] {
  if (!priorRejectedAttemptsV1 || priorRejectedAttemptsV1.length === 0) {
    return [];
  }
  return priorRejectedAttemptsV1.map(
    (attempt) =>
      `Attempt ${attempt.attemptId} rejected (${attempt.code}${attempt.detail ? `: ${attempt.detail}` : ""})`
  );
}

/**
 * Item 2 / Step 55: a plain `invocationDeadlineExceeded: provider invocation
 * exceeded 3600000ms` reads as a raw diagnostic code, not the "timed out
 * after N minutes" reason the round ledger and the user-facing failure
 * message are meant to carry. Parses the millisecond figure the broker
 * already puts in `detail` (`agentExecutionBrokerV1.ts`'s
 * `computeInvocationOutcomeV1`) rather than importing its timeout constant,
 * so this stays correct even when a caller overrides the deadline via
 * `AgentExecutionBrokerOptionsV1.invocationTimeoutMs`. Returns `undefined`
 * for every other code, so callers fall back to the existing generic
 * rendering unchanged.
 */
function invocationTerminalReasonTextV1(code: string, detail: string | undefined): string | undefined {
  if (code === "invocationDeadlineExceeded") {
    const match = detail?.match(/(\d+)ms\s*$/);
    if (!match) {
      return "timed out";
    }
    const minutes = Math.max(1, Math.round(Number(match[1]) / 60_000));
    return `timed out after ${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  // Item 2 / Step 55: a cancellation of an invocation that reached the
  // provider (see `taskActionCoordinatorV1.ts`'s `runProviderRow`) settles as
  // `failed` with this code precisely so the round ledger's rejection reason
  // and the user-facing notification read "cancelled — <what's outstanding>"
  // instead of the raw `callerCancelled`/`providerCancelled` code.
  if (code === "callerCancelled" || code === "providerCancelled") {
    return detail ? `cancelled — ${detail}` : "cancelled";
  }
  return undefined;
}

/**
 * Summarize every attempt's own reason, not only the last — e.g. "attempt 1:
 * invalidFrame; attempt 2: invalidFrame: ...; final attempt: invalidFrame:
 * ..." so a reader sees the whole chain without opening the run file (item
 * 6). Shared by `malformedResult` and `failed`/`contentContractFailed`.
 */
function summarizeRejectedAttemptChainV1(
  finalReason: string,
  priorRejectedAttemptsV1: readonly MalformedResultAttemptRecordV1[] | undefined
): string {
  if (!priorRejectedAttemptsV1 || priorRejectedAttemptsV1.length === 0) {
    return finalReason;
  }
  return [
    ...priorRejectedAttemptsV1.map(
      (attempt, index) => `attempt ${index + 1}: ${attempt.code}${attempt.detail ? `: ${attempt.detail}` : ""}`
    ),
    `final attempt: ${finalReason}`,
  ].join("; ");
}

/**
 * One short status line for a run log.
 *
 * `questionsArtifactNote` names what the action would otherwise have written
 * (e.g. "plan.md"), so a "questions" settlement records that the artifact was
 * deliberately left untouched rather than looking like a silent no-op.
 */
export function describeTaskActionOutcomeForLogV1(
  outcome: TaskActionOutcomeV1,
  questionsArtifactNote?: string
): string {
  switch (outcome.kind) {
    case "completed": {
      // A detected deferred/cut-short round settled as a successful provider
      // invocation but is NOT a completed round — the log line must say so,
      // or the durable record claims a finish that never happened (the
      // 2026-08-13 round-014 failure).
      const statusLine =
        outcome.code === "roundDeferredIncomplete" || outcome.code === "roundIncomplete"
          ? `Status: incomplete (${outcome.code})${providerLogSuffix(outcome.provider)}`
          : `Status: completed (${outcome.code})${providerLogSuffix(outcome.provider)}`;
      // Item 5: a repaired lookalike end marker is a tolerance, and must be
      // visible in the round's own run file, not only in the extension host
      // console (setRepairedFrameEndObserverV1's sink).
      return outcome.frameRepairV1
        ? `${statusLine}\nFrame: end marker repaired (one substituted character at index ${outcome.frameRepairV1.index})`
        : statusLine;
    }
    case "questions":
      return (
        `Status: questions (interactionId=${outcome.interactionId}) — the AI asked a clarifying ` +
        `question in Chat With AI${questionsArtifactNote ? ` instead of writing ${questionsArtifactNote}` : ""}.` +
        providerLogSuffix(outcome.provider)
      );
    case "cancelled":
      return `Status: cancelled (${outcome.code})${providerLogSuffix(outcome.provider)}`;
    case "failed":
      // Pre-1.0.0 fixes register, Part 4 Step 8: an `attemptIdentityAttachmentFailed`
      // failure's `.detail` (see `formatIdentityAttachmentFailureDetailV1`,
      // taskActionCoordinatorV1.ts, and the `wrongOwner` message built in
      // `attachCoordinatorIdentityToRoundV1`, roundLedgerV1.ts) already names
      // both operation ids for a `wrongOwner` failure; append this failing
      // (second) attempt's own `actionKey`/`operationId` from `correlation`
      // here so a run log line records that too, without requiring a reader
      // to cross-reference the round ledger by hand.
      {
        // Item 6, 2026-09-26 field report, and its 2026-09-28
        // implementation-review follow-up: an exhausted rejection chain used
        // to discard every earlier attempt's own reason once a later
        // attempt's outcome overwrote it, AND the chain's own final attempt
        // id was never recorded at all — the run file named every OTHER
        // attempt but not the one the status line itself is about. One line
        // per prior attempt, oldest first, plus `[attempt=ID]` on the status
        // line itself, keeps every attempt's own reason and id on disk.
        const statusLine = `Status: failed (code=${outcome.code}${
          outcome.detail ? `: ${outcome.detail}` : ""
        }, retryable=${outcome.retryable})${
          outcome.code === "attemptIdentityAttachmentFailed" && outcome.correlation
            ? ` [actionKey=${outcome.correlation.actionKey}, operationId=${outcome.correlation.operationId}]`
            : ""
        }${attemptIdLogSuffix(outcome.attemptId)}${providerLogSuffix(outcome.provider)}`;
        const priorLines = priorRejectedAttemptLinesV1(outcome.priorRejectedAttemptsV1);
        return priorLines.length > 0 ? [statusLine, ...priorLines].join("\n") : statusLine;
      }
    case "malformedResult": {
      // Item 6, 2026-09-26 field report, and its 2026-09-28
      // implementation-review follow-up: see the identical comment on the
      // `failed` case above — this is the same fix for the sibling outcome
      // kind the original chain-history fix was written against.
      const statusLine = `Status: malformed result (${outcome.code}${outcome.detail ? `: ${outcome.detail}` : ""})${attemptIdLogSuffix(outcome.attemptId)}${providerLogSuffix(outcome.provider)}`;
      const priorLines = priorRejectedAttemptLinesV1(outcome.priorRejectedAttemptsV1);
      return priorLines.length > 0 ? [statusLine, ...priorLines].join("\n") : statusLine;
    }
    case "unavailable":
      return outcome.code === "candidatesDeferred"
        ? `Status: unavailable (${outcome.code}) — every remaining candidate is currently ` +
          "quota/entitlement-limited, not tried-and-failed; the task is being parked with the " +
          "earliest known reset time rather than treated as exhausted."
        : `Status: unavailable (${outcome.code})`;
    case "recoveryRequired":
      return `Status: recovery required (${outcome.code})`;
    case "duplicateRejected":
      return "Status: duplicate rejected (another operation is already running for this task)";
    case "stalePreflight":
      return `Status: stale preflight (${outcome.planId})`;
    case "partialEditBlocked":
      return `Status: partial edit blocked (${outcome.executionId})`;
    default:
      return `Status: ${(outcome as TaskActionOutcomeV1).kind}`;
  }
}

/** User-facing failure clause for a non-completed, non-cancelled, non-questions outcome. */
export function describeTaskActionFailureV1(outcome: TaskActionOutcomeV1): string {
  switch (outcome.kind) {
    case "failed": {
      // Item 6 follow-up: a content-contract candidate-advancement chain
      // (code `contentContractFailed`) settles as `failed`, not
      // `malformedResult`, but shares the exact same history shape — its
      // failure message must summarize every attempt's own reason too, not
      // only the last, for the same reason the malformedResult case below
      // does.
      //
      // Item 2 / Step 55: `invocationDeadlineExceeded` gets the plan's own
      // "timed out after N minutes" wording instead of the raw code, since
      // this is the string that reaches the round ledger's rejection reason
      // and the user-facing notification (both read via this function).
      const terminalReasonV1 = invocationTerminalReasonTextV1(outcome.code, outcome.detail);
      const finalReason = terminalReasonV1 ?? `${outcome.code}${outcome.detail ? `: ${outcome.detail}` : ""}`;
      const allReasons = summarizeRejectedAttemptChainV1(finalReason, outcome.priorRejectedAttemptsV1);
      return `${allReasons}${outcome.retryable ? " (retryable)" : ""}${providerLogSuffix(outcome.provider)}`;
    }
    case "malformedResult": {
      const finalReason = `${outcome.code}${outcome.detail ? `: ${outcome.detail}` : ""}`;
      // Item 6: summarize every attempt's own reason, not only the last —
      // e.g. "attempt 1: invalidFrame; attempt 2: invalidFrame: ...; final
      // attempt: invalidFrame: ..." so a reader sees the whole chain without
      // opening the run file.
      const allReasons = summarizeRejectedAttemptChainV1(finalReason, outcome.priorRejectedAttemptsV1);
      return `the model's response was malformed (${allReasons})${providerLogSuffix(outcome.provider)}`;
    }
    case "unavailable":
      return outcome.code;
    case "recoveryRequired":
      return outcome.code;
    case "duplicateRejected":
      return "another operation is already running for this task";
    case "stalePreflight":
      return "a stale preflight plan was rejected";
    case "partialEditBlocked":
      return "a partial edit was blocked";
    default:
      return outcome.kind;
  }
}
