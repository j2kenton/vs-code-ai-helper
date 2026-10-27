import { captureRaisedNoticesV1, publishChecksDeclinedReasonV1 } from "./notificationTaskContextV1";
import {
  clearStageActionTerminalOutcomeV1,
  describeStageActionTerminalOutcomeV1,
  takeStageActionTerminalOutcomeV1,
} from "./stageActionRefusalV1";

export interface FastForwardPublishChecksDepsV1 {
  /** The task whose Publish Checks run; keys the terminal outcome the checks record. */
  readonly taskFolderPath: string;
  /** Runs Publish Checks through their own command. */
  readonly runChecks: () => Promise<unknown>;
  /** True when the freshness stamp is valid after the checks ran. */
  readonly isFreshAfterChecks: () => Promise<boolean>;
  readonly op: {
    settleAs(state: "refused" | "failed" | "cancelled" | "interrupted", reason: string): void;
    report(message: string): void;
  };
}

/**
 * Fast Forward's Publish branch: run Publish Checks, and when they leave no
 * fresh result settle the operation with what actually happened:
 *
 * - checks that started and were cancelled settle as `cancelled` (naming who
 *   cancelled them when known), never as a refusal;
 * - checks that started and failed to run settle as `failed` with the reason;
 * - checks that never started settle as `refused` with the reason the command
 *   stated (the last notice it raised), or a diagnostic saying that no reason
 *   was reported — never a bare "declined without saying why".
 *
 * Returns false when no fresh result exists.
 */
export async function runFastForwardPublishChecksV1(deps: FastForwardPublishChecksDepsV1): Promise<boolean> {
  clearStageActionTerminalOutcomeV1(deps.taskFolderPath);
  const { notices } = await captureRaisedNoticesV1(() => Promise.resolve(deps.runChecks()));
  if (await deps.isFreshAfterChecks()) {
    clearStageActionTerminalOutcomeV1(deps.taskFolderPath);
    return true;
  }
  const terminal = takeStageActionTerminalOutcomeV1(deps.taskFolderPath);
  if (terminal !== undefined) {
    const text = describeStageActionTerminalOutcomeV1(terminal);
    deps.op.settleAs(
      terminal.kind === "cancelled" ? "cancelled" : terminal.kind === "interrupted" ? "interrupted" : "failed",
      text
    );
    deps.op.report(text);
    return false;
  }
  const declinedReason = publishChecksDeclinedReasonV1(notices);
  deps.op.settleAs("refused", declinedReason);
  deps.op.report(declinedReason);
  return false;
}
