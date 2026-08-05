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
 * Both functions are exhaustive over the outcome union and carry NO provider
 * text: plan §3.7's outcome contract is a closed set of stable codes, and
 * §2.2 forbids raw provider output in logs — so these only ever emit kinds,
 * codes, and ids that the contract itself defines.
 */
import { TaskActionOutcomeV1 } from "../types/taskActionOutcomeV1";

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
      return `Status: completed (${outcome.code})`;
    case "questions":
      return (
        `Status: questions (interactionId=${outcome.interactionId}) — the AI asked a clarifying ` +
        `question in Chat With AI${questionsArtifactNote ? ` instead of writing ${questionsArtifactNote}` : ""}.`
      );
    case "cancelled":
      return `Status: cancelled (${outcome.code})`;
    case "failed":
      return `Status: failed (code=${outcome.code}, retryable=${outcome.retryable})`;
    case "malformedResult":
      return `Status: malformed result (${outcome.code})`;
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
      return `${outcome.code}${outcome.retryable ? " (retryable)" : ""}`;
    case "malformedResult":
      return `the model's response was malformed (${outcome.code})`;
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
