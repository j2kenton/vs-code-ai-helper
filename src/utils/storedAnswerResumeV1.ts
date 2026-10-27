/**
 * Wording for a Resume that did not settle its interaction (bugs2 finding 1).
 *
 * A submitted answer is stored durably and cannot be changed, so when the
 * Resume that should have used it is refused or does not complete (paused
 * task, busy runner, restart, failed round) the user is told the real reason
 * and that the answer is kept: pressing Confirm again re-submits the same
 * answer harmlessly and retries the Resume.
 */
import type { TaskActionOutcomeV1 } from "../types/taskActionOutcomeV1";

/** Appended to a resume-failure message whenever the answer is already stored. */
export const STORED_ANSWER_KEPT_NOTE_V1 =
  "Your answer is saved and will be used — press Confirm again, or Resume the task, to continue with it. You do not need to answer again.";

/** The concrete reason a coordinator Resume ended without settling the interaction. */
export function describeResumeNotSettledV1(outcome: TaskActionOutcomeV1 | undefined): string {
  if (outcome === undefined) {
    return "the Resume did not run (no outcome was recorded for it)";
  }
  switch (outcome.kind) {
    case "duplicateRejected":
      return "another operation is already running for this task, so the Resume could not start";
    case "cancelled":
      return outcome.code === "userCancelled"
        ? "the resumed round was cancelled before it finished"
        : "the provider cancelled the resumed round before it finished";
    case "failed":
      if (outcome.code === "actionNotEligibleForStatus") {
        return "the task is paused";
      }
      return `the resumed round failed (${outcome.code}${outcome.detail ? `: ${outcome.detail}` : ""})`;
    case "questions":
      return "the resumed round asked a further question, which is waiting for your answer";
    case "completed":
      return "the resumed round finished, but the interaction was not marked resolved";
    default:
      return `the Resume ended with "${outcome.kind}" before the interaction was marked resolved`;
  }
}

/** Full user-facing refusal text for a Resume that failed to settle, including the kept-answer note. */
export function describeResumeFailureWithStoredAnswerV1(reason: string): string {
  return `${reason.trim().replace(/[.\s]+$/, "")}. ${STORED_ANSWER_KEPT_NOTE_V1}`;
}
