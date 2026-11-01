/**
 * bugs4 item 3: a review refused BEFORE any provider was invoked.
 *
 * The scope guard in `runReviewForFolder` used to write a run file, raise a
 * notification and `return;` — a normally returned function that every caller
 * (manual, automatic, resumed, Fast Forward) could only read as "the review
 * ran". This is the typed refusal that replaces those bare returns. It is not
 * a review outcome: it carries no verdict, score, readiness or stage advance,
 * and it is distinct from a provider failure, a cancellation and a completed
 * review. It names the missing evidence and the concrete recovery, so the one
 * chat terminal line (and the recovery card) can say both.
 */
export type ReviewPreflightRefusalCauseV1 =
  | "progress-unreadable"
  | "ledger-unproven"
  | "ledger-proves-empty";

export interface ReviewPreflightRecoveryV1 {
  /** Short action label, e.g. "Run Implementation". */
  readonly label: string;
  /** What to do and why repeating the review unchanged does not help. */
  readonly detail: string;
  /** Command the chat card runs; absent when the recovery is a manual check. */
  readonly command?: string;
  /**
   * A file in the task folder the recovery is about. When there is no
   * `command`, the chat card opens it, so even a manual repair is one click
   * away in chat rather than described only in prose.
   */
  readonly openTaskFile?: string;
}

export interface ReviewPreflightRefusalV1 {
  readonly kind: "not-run";
  readonly cause: ReviewPreflightRefusalCauseV1;
  /** Display name of the review that did not run, e.g. "High-Level Code Review". */
  readonly stageLabel: string;
  /** The missing evidence, in plain words. */
  readonly reason: string;
  readonly recovery: ReviewPreflightRecoveryV1;
}

const RUN_IMPLEMENTATION_COMMAND_V1 = "vs-code-ai-helper.runImplementationWithAI";

export function buildReviewPreflightRefusalV1(input: {
  readonly cause: ReviewPreflightRefusalCauseV1;
  readonly stageLabel: string;
  /** The task-owned ledger's own reason (for `ledger-unproven`). */
  readonly ledgerReason?: string;
}): ReviewPreflightRefusalV1 {
  switch (input.cause) {
    case "progress-unreadable":
      return {
        kind: "not-run",
        cause: input.cause,
        stageLabel: input.stageLabel,
        reason:
          "this task's changed-file scope could not be established because its progress record is missing or unreadable, and open editors are never used as a substitute",
        recovery: {
          label: "Restore the progress record",
          detail:
            "Open task-progress.json in the task folder and restore it from task-progress_prev.json if it is damaged, then run the review again. Running the review again without repairing the record refuses the same way.",
          openTaskFile: "task-progress.json",
        },
      };
    case "ledger-proves-empty":
      return {
        kind: "not-run",
        cause: input.cause,
        stageLabel: input.stageLabel,
        reason: "the task ledger proves that no reviewable implementation files changed, so there is nothing to review",
        recovery: {
          label: "Run Implementation",
          detail:
            "Run an Implementation round so the ledger records the files it changes. Running the review again unchanged refuses the same way.",
          command: RUN_IMPLEMENTATION_COMMAND_V1,
        },
      };
    case "ledger-unproven":
      return {
        kind: "not-run",
        cause: input.cause,
        stageLabel: input.stageLabel,
        reason:
          "no changed files are tracked for this task and its round ledger could not prove a complete set" +
          (input.ledgerReason ? ` (${input.ledgerReason.replace(/^ledger skipped:\s*/i, "")})` : "") +
          ", so open editors were not used",
        recovery: {
          label: "Run Implementation",
          detail:
            "Run an Implementation round so a change list is recorded for this task; the review can then rebuild its scope from it. Running the review again unchanged refuses the same way.",
          command: RUN_IMPLEMENTATION_COMMAND_V1,
        },
      };
  }
}

/** The one-sentence terminal text: what did not run, why, and what to do. */
export function describeReviewPreflightRefusalV1(refusal: ReviewPreflightRefusalV1): string {
  const reason = refusal.reason.replace(/[.\s]+$/, "");
  return `${refusal.stageLabel} was not run (no reviewer was invoked): ${reason}. ${refusal.recovery.detail}`;
}

/**
 * Whether Fast Forward's generic "did not produce a new, comparable result ...
 * run Implementation" stalled warning applies. A re-review refused before any
 * reviewer ran has already settled its own typed not-run outcome and chat
 * line (the loop sees it as `review() === null`, i.e. "stalled"), so the
 * generic warning would name the wrong cause and give the wrong advice. The
 * open-items probe is a thunk because reading it consumes the card marker; it
 * is evaluated only for a stalled run, in the order the call site always had.
 */
export function shouldWarnFastForwardStalledV1(input: {
  readonly stalled: boolean;
  readonly openItemsCardPostedSinceRunStart: () => boolean;
  readonly preflightRefused: boolean;
}): boolean {
  return input.stalled && !input.openItemsCardPostedSinceRunStart() && !input.preflightRefused;
}
