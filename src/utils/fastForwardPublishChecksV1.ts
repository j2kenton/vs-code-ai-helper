import { captureRaisedNoticesV1, publishChecksDeclinedReasonV1 } from "./notificationTaskContextV1";

export interface FastForwardPublishChecksDepsV1 {
  /** Runs Publish Checks through their own command. */
  readonly runChecks: () => Promise<unknown>;
  /** True when the freshness stamp is valid after the checks ran. */
  readonly isFreshAfterChecks: () => Promise<boolean>;
  readonly op: {
    settleAs(state: "refused", reason: string): void;
    report(message: string): void;
  };
}

/**
 * Fast Forward's Publish branch: run Publish Checks, and when they leave no
 * fresh result settle the operation as refused with a stated reason (the last
 * notice they raised, or a fixed fallback) so the terminal row never reads as
 * a bare "refused — nothing was started". Returns false when it refused.
 */
export async function runFastForwardPublishChecksV1(deps: FastForwardPublishChecksDepsV1): Promise<boolean> {
  const { notices } = await captureRaisedNoticesV1(() => Promise.resolve(deps.runChecks()));
  if (await deps.isFreshAfterChecks()) {
    return true;
  }
  const declinedReason = publishChecksDeclinedReasonV1(notices);
  deps.op.settleAs("refused", declinedReason);
  deps.op.report(declinedReason);
  return false;
}
