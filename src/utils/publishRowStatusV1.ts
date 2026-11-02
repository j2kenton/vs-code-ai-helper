/**
 * bugs5 Steps 11 and 18: what the Tasks pane's Publish row says before a Publish review score exists.
 *
 * Publish is two parts (checks, then an AI review that gives the score). Until the review has scored,
 * the row says where Publish has got to instead of "—/10", and a checks run whose process is gone is
 * "Checks interrupted", never "running".
 */
import * as os from "node:os";
import { processAliveV1 } from "./publishChecksOutcomeV1";
import type { PublishChecksOutcomeV1 } from "./publishChecksOutcomeV1";

export const PUBLISH_ROW_TOOLTIP_V1 =
  "Publish has two parts: checks (lint, types, tests), then an AI review that gives the score.";

export interface PublishRowStatusInputV1 {
  readonly outcome: PublishChecksOutcomeV1 | undefined;
  /** True once the Publish review has produced a readable score; the row then shows the score. */
  readonly hasScore: boolean;
  /** True while a Publish Checks operation of this window is registered for the task. */
  readonly checksOperationLive: boolean;
  /** True while the Publish AI review is running. */
  readonly reviewRunning: boolean;
  readonly hostname?: string;
  readonly isProcessAlive?: (pid: number) => boolean;
}

function checksFailedLabel(failedCommands: readonly string[] | undefined): string {
  const count = failedCommands?.length ?? 0;
  return count > 0 ? `Checks failed: ${count}` : "Checks failed";
}

const CHECKS_PASSED_LABEL_V1 = "Checks passed · AI review not run yet";

/** The Publish row text, or undefined when the score (or the usual "—/10") should show. */
export function describePublishRowStatusV1(input: PublishRowStatusInputV1): string | undefined {
  if (input.hasScore) {
    return undefined;
  }
  if (input.checksOperationLive) {
    return "Checks running";
  }
  if (input.reviewRunning) {
    return "AI review running";
  }
  const record = input.outcome;
  if (record === undefined) {
    return undefined;
  }
  switch (record.outcome) {
    case "running": {
      const sameMachine = record.hostname === (input.hostname ?? os.hostname());
      if (!sameMachine) {
        // Another machine's run cannot be judged from here.
        return "Checks running";
      }
      if (record.pid === process.pid) {
        // This process wrote it and no operation of its own is live: abandoned.
        return "Checks interrupted";
      }
      return (input.isProcessAlive ?? processAliveV1)(record.pid) ? "Checks running" : "Checks interrupted";
    }
    case "interrupted":
      return "Checks interrupted";
    case "failed":
      return checksFailedLabel(record.failedCommands);
    case "passed":
      // bugs5 Step 17: a pass that does not cover the tree as it is now is not "passed" to the owner.
      return (record.changedDuringRun?.length ?? 0) > 0 ? "Checks passed · files changed during the run" : CHECKS_PASSED_LABEL_V1;
    case "cancelled":
      if (record.lastCompleted?.outcome === "passed") {
        return CHECKS_PASSED_LABEL_V1;
      }
      if (record.lastCompleted?.outcome === "failed") {
        return checksFailedLabel(record.lastCompleted.failedCommands);
      }
      return undefined;
  }
}
