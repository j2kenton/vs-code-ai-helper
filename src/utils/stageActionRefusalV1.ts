import type { CancelSourceV1 } from "./taskOperations";

/**
 * Why the most recent `applyCurrentStageAction` call for a task returned
 * `false`, keyed by task folder (never a "current task" — concurrent calls for
 * different tasks cannot cross). A caller that got `false` reads it once with
 * `takeStageActionRefusalReasonV1` to name the real cause instead of guessing.
 */
const stageActionRefusalReasonsV1 = new Map<string, string>();

export function recordStageActionRefusalReasonV1(taskFolderPath: string, reason: string): void {
  stageActionRefusalReasonsV1.set(taskFolderPath, reason);
}

export function clearStageActionRefusalReasonV1(taskFolderPath: string): void {
  stageActionRefusalReasonsV1.delete(taskFolderPath);
}

export function takeStageActionRefusalReasonV1(taskFolderPath: string): string | undefined {
  const reason = stageActionRefusalReasonsV1.get(taskFolderPath);
  stageActionRefusalReasonsV1.delete(taskFolderPath);
  return reason;
}

/**
 * What happened to an action that DID start (bugs2 finding 5 / plan Step 2).
 * A refusal means nothing started; these mean work started and then ended
 * without a pass, and callers must not describe them as "declined to start":
 *
 * - `cancelled`: someone stopped it (the source is carried when known);
 * - `failed`: it ran and failed with a stated reason;
 * - `interrupted`: the runner stopped reporting, so the outcome is unknown.
 *
 * Keyed by task folder like the refusal reason, written by the action at its
 * terminal path and read once by the caller that dispatched it.
 */
export type StageActionTerminalOutcomeV1 =
  | {
      readonly kind: "cancelled";
      /** Display name of the action that was cancelled, e.g. "Publish Checks". */
      readonly actionLabel: string;
      readonly source?: CancelSourceV1;
      readonly operationId?: string;
      /** Workspace files the action had already changed when it was stopped. */
      readonly changedFiles?: readonly string[];
    }
  | {
      readonly kind: "failed";
      readonly actionLabel: string;
      readonly reason: string;
      readonly operationId?: string;
    }
  | {
      readonly kind: "interrupted";
      readonly actionLabel: string;
      readonly reason: string;
      readonly operationId?: string;
    };

const stageActionTerminalOutcomesV1 = new Map<string, StageActionTerminalOutcomeV1>();

export function recordStageActionTerminalOutcomeV1(
  taskFolderPath: string,
  outcome: StageActionTerminalOutcomeV1
): void {
  stageActionTerminalOutcomesV1.set(taskFolderPath, outcome);
}

export function clearStageActionTerminalOutcomeV1(taskFolderPath: string): void {
  stageActionTerminalOutcomesV1.delete(taskFolderPath);
}

/** Returns the recorded terminal outcome without consuming it. */
export function peekStageActionTerminalOutcomeV1(
  taskFolderPath: string
): StageActionTerminalOutcomeV1 | undefined {
  return stageActionTerminalOutcomesV1.get(taskFolderPath);
}

/** Reads the recorded terminal outcome once; a second read returns `undefined`. */
export function takeStageActionTerminalOutcomeV1(
  taskFolderPath: string
): StageActionTerminalOutcomeV1 | undefined {
  const outcome = stageActionTerminalOutcomesV1.get(taskFolderPath);
  stageActionTerminalOutcomesV1.delete(taskFolderPath);
  return outcome;
}

/** "from the Notifications row" etc.; empty when the source is unknown. */
export function describeCancelSourceV1(source: CancelSourceV1 | undefined): string {
  switch (source) {
    case "notifications":
      return " from the Notifications row";
    case "viewer":
      return " from a viewer";
    case "chat":
      return " from the task chat";
    case "command":
      return " by a command";
    default:
      return "";
  }
}

/** One sentence naming what happened to an action that started, for Fast Forward and cards. */
export function describeStageActionTerminalOutcomeV1(outcome: StageActionTerminalOutcomeV1): string {
  switch (outcome.kind) {
    case "cancelled": {
      const files =
        outcome.changedFiles !== undefined && outcome.changedFiles.length > 0
          ? ` Files it had already changed: ${outcome.changedFiles.join(", ")}.`
          : "";
      return `${outcome.actionLabel} was cancelled${describeCancelSourceV1(outcome.source)} after it started; nothing was recorded for the run.${files}`;
    }
    case "failed":
      return `${outcome.actionLabel} started and failed: ${outcome.reason}`;
    case "interrupted":
      return `${outcome.actionLabel} was interrupted and its outcome is unknown: ${outcome.reason}`;
  }
}
