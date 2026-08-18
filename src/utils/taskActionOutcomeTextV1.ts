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
import { TaskActionOutcomeProviderV1, TaskActionOutcomeV1 } from "../types/taskActionOutcomeV1";
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
    case "completed":
      // A detected deferred/cut-short round settled as a successful provider
      // invocation but is NOT a completed round — the log line must say so,
      // or the durable record claims a finish that never happened (the
      // 2026-08-13 round-014 failure).
      return outcome.code === "roundDeferredIncomplete" || outcome.code === "roundIncomplete"
        ? `Status: incomplete (${outcome.code})${providerLogSuffix(outcome.provider)}`
        : `Status: completed (${outcome.code})${providerLogSuffix(outcome.provider)}`;
    case "questions":
      return (
        `Status: questions (interactionId=${outcome.interactionId}) — the AI asked a clarifying ` +
        `question in Chat With AI${questionsArtifactNote ? ` instead of writing ${questionsArtifactNote}` : ""}.` +
        providerLogSuffix(outcome.provider)
      );
    case "cancelled":
      return `Status: cancelled (${outcome.code})${providerLogSuffix(outcome.provider)}`;
    case "failed":
      return `Status: failed (code=${outcome.code}${
        outcome.detail ? `: ${outcome.detail}` : ""
      }, retryable=${outcome.retryable})${providerLogSuffix(outcome.provider)}`;
    case "malformedResult":
      return `Status: malformed result (${outcome.code}${outcome.detail ? `: ${outcome.detail}` : ""})${providerLogSuffix(outcome.provider)}`;
    case "unavailable":
      return `Status: unavailable (${outcome.code})`;
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
    case "failed":
      return `${outcome.code}${outcome.detail ? `: ${outcome.detail}` : ""}${
        outcome.retryable ? " (retryable)" : ""
      }${providerLogSuffix(outcome.provider)}`;
    case "malformedResult":
      return `the model's response was malformed (${outcome.code}${outcome.detail ? `: ${outcome.detail}` : ""})${providerLogSuffix(outcome.provider)}`;
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
