/**
 * bugs4 item 4: an auto-advance hand-over warning must agree with the round
 * ledger. Before it claims a round "did not start", it asks the ledger whether
 * a round at that stage ran to a terminal state moments ago. When one did, the
 * warning reports what happened to it instead; when the round completed and
 * the follow-up was withheld on purpose (a failing type-check, for example), it
 * carries the gate's own sentence rather than a reasonless "declined".
 *
 * Pure: no vscode, no I/O. `warnHandOverNotStartedV1` supplies the progress.
 */
import type { RoundLedgerEntryV1, TaskProgress, TaskStage } from "../types/taskProgress";
import { STAGE_DISPLAY_NAMES } from "../types/taskProgress";
import {
  describeImplementationNoFollowUpGateV1,
  type ImplementationNoFollowUpGateV1,
} from "./roundLedgerV1";
import type { WorkflowDecisionV1 } from "../types/workflowDecisionV1";
import { stepOutcomeNameV1 } from "./stepLabelsV1";

/**
 * How long after a round ended a hand-over for its stage is still about that
 * round. The hand-over fires seconds after the round ends; a round that ended
 * earlier than this belongs to a previous event and is not evidence about this
 * one.
 */
export const HAND_OVER_LEDGER_WINDOW_MS_V1 = 5 * 60 * 1000;

const LIVE_STATES_V1: ReadonlySet<string> = new Set(["scheduled", "open"]);

export type HandOverLedgerFindingV1 =
  | {
      /** The round completed and its follow-up was withheld on purpose. */
      readonly kind: "gated";
      readonly row: RoundLedgerEntryV1;
      readonly gate: ImplementationNoFollowUpGateV1;
    }
  | {
      /** A round at the stage ended terminally; nothing "never started". */
      readonly kind: "terminal-round";
      readonly row: RoundLedgerEntryV1;
    };

/**
 * The newest terminal round at `stage` that ended within the window, judged
 * against `progress`. `undefined` means nothing at that stage ran, so a
 * "did not start" claim is genuine.
 */
export function findHandOverRoundFindingV1(
  progress: TaskProgress | undefined,
  stage: TaskStage,
  options: { readonly now?: number; readonly windowMs?: number; readonly since?: string } = {}
): HandOverLedgerFindingV1 | undefined {
  if (!progress) {
    return undefined;
  }
  const now = options.now ?? Date.now();
  const windowMs = options.windowMs ?? HAND_OVER_LEDGER_WINDOW_MS_V1;
  const sinceMs = options.since !== undefined ? Date.parse(options.since) : undefined;
  let newest: RoundLedgerEntryV1 | undefined;
  let newestAt = -Infinity;
  for (const row of progress.roundLedger ?? []) {
    if (row.stage !== stage || LIVE_STATES_V1.has(row.state) || row.endedAt === undefined) {
      continue;
    }
    const endedAt = Date.parse(row.endedAt);
    if (Number.isNaN(endedAt) || endedAt > now + 60_000 || now - endedAt > windowMs) {
      continue;
    }
    if (sinceMs !== undefined && !Number.isNaN(sinceMs) && endedAt < sinceMs) {
      continue;
    }
    if (endedAt > newestAt) {
      newest = row;
      newestAt = endedAt;
    }
  }
  if (!newest) {
    return undefined;
  }
  const gate = describeImplementationNoFollowUpGateV1(newest, progress);
  return gate ? { kind: "gated", row: newest, gate } : { kind: "terminal-round", row: newest };
}

function describeRoundFilesV1(row: RoundLedgerEntryV1): string | undefined {
  const outcome = row.outcome;
  if (!outcome) {
    return undefined;
  }
  if (outcome.filesChangedUnknown) {
    return "files changed (exact set unknown)";
  }
  if (outcome.filesChanged !== undefined) {
    return outcome.filesChanged.length > 0 ? `${outcome.filesChanged.length} file(s) changed` : "no files changed";
  }
  return undefined;
}

/**
 * The truthful account of what happened at the stage: names the round, its
 * terminal state, what it changed, and — for a gated round — the gate's own
 * reason and next step. Never says a round "did not start".
 */
export function describeHandOverRoundFindingV1(finding: HandOverLedgerFindingV1): string {
  const row = finding.row;
  const stageName = STAGE_DISPLAY_NAMES[row.stage] ?? row.stage;
  const roundName = stepOutcomeNameV1(row.mode, stageName);
  const files = describeRoundFilesV1(row);
  const ended = `${roundName} ended ${row.state}${files ? ` — ${files}` : ""}.`;
  if (finding.kind === "gated") {
    return `${ended} No follow-up round was started, deliberately: ${finding.gate.sentence.replace(/^No follow-up was scheduled;\s*/i, "")}`;
  }
  return `${ended} No further round was started after it.`;
}

/**
 * bugs4 item 4: one event raises one decision. A pending decision that names the
 * round, or one raised at the same stage since the round started, is the card the
 * round's own ending produced. The hand-over defers to it instead of posting a
 * second, contradicting card seconds later.
 */
export function findPendingDecisionForRoundV1(
  pending: readonly WorkflowDecisionV1[],
  row: RoundLedgerEntryV1
): WorkflowDecisionV1 | undefined {
  const startedMs = Date.parse(row.startedAt);
  return pending.find((decision) => {
    if (decision.state !== "pending") {
      return false;
    }
    if (decision.liveReference?.roundId === row.roundId) {
      return true;
    }
    if (decision.stage !== row.stage) {
      return false;
    }
    const createdMs = Date.parse(decision.createdAt);
    return !Number.isNaN(startedMs) && !Number.isNaN(createdMs) && createdMs >= startedMs;
  });
}
