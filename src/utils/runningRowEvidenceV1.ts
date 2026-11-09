/**
 * run1 Step 18: what the Notifications running row says about whether a round is really alive, read
 * from the round's proof of life (`proofOfLifeV1`) and nothing else.
 *
 * - The last-activity line comes only from the round's `contact` (output) and `progress` (what it
 *   provably did) evidence. A workspace file that merely changed while it ran (`observed`) never
 *   updates that line and never hides the warning; it appears in the tooltip only, marked as not
 *   proven to be this round's.
 * - With no contact or progress for the warning time, the row says so plainly and offers Stop or Wait.
 * - A process that has gone is said at once, not after the warning time.
 *
 * Pure and VS Code-free so the wording is unit-tested directly.
 */
import type { ProofOfLifeV1 } from "./proofOfLifeV1";

export interface RunningRowEvidenceInputV1 {
  readonly proof: ProofOfLifeV1 | undefined;
  readonly startedAt: number;
  readonly now: number;
  /** `ensemble.resilience.noActivityWarningMinutes`. */
  readonly warningMinutes: number;
  /** The owner pressed Wait: the warning stays hidden until this time. */
  readonly warningHiddenUntil?: number;
  /** The provider's name, for the "reports only when it finishes" wording. */
  readonly providerLabel?: string;
  /** The round is waiting for the owner, so silence is expected. */
  readonly waitingForUser?: boolean;
}

export interface RunningRowEvidenceV1 {
  /** "last activity 20 s ago: edited `reviewActions.ts`", when the round has shown any. */
  readonly activityLine?: string;
  /** "no activity for 14 min (since 06:02) — may be stuck" and its provider-specific variants. */
  readonly warning?: string;
  /** True when the row should offer Stop and Wait for the warning. */
  readonly stuck: boolean;
  /** The process behind the round is gone. */
  readonly processEnded: boolean;
  /** Extra tooltip lines: last contact, the latest observed change, the process. */
  readonly tooltipLines: readonly string[];
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function clock(ms: number): string {
  const date = new Date(ms);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** "20 s", "14 min", "2 h 5 min". */
export function formatAgoV1(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}

export function describeRunningRowEvidenceV1(input: RunningRowEvidenceInputV1): RunningRowEvidenceV1 {
  const { proof, now } = input;
  const tooltipLines: string[] = [];
  if (proof === undefined) {
    // Nothing reported yet (a round that has not started a process, or a host that sends no proof).
    return { stuck: false, processEnded: false, tooltipLines };
  }

  const processEnded = proof.processState === "ended";
  const lastSignOfLife = Math.max(proof.lastContactAt ?? 0, proof.lastProgressAt ?? 0);

  // The last-activity line: progress when the round last did something provable, else when it last spoke.
  let activityLine: string | undefined;
  if (proof.lastProgressAt !== undefined && proof.lastProgressAt >= (proof.lastContactAt ?? 0)) {
    activityLine = `last activity ${formatAgoV1(now - proof.lastProgressAt)} ago${
      proof.lastProgressWhat ? `: ${proof.lastProgressWhat}` : ""
    }`;
  } else if (proof.lastContactAt !== undefined) {
    const progressNote =
      proof.lastProgressAt !== undefined && proof.lastProgressWhat
        ? `; last did: ${proof.lastProgressWhat} ${formatAgoV1(now - proof.lastProgressAt)} ago`
        : "";
    activityLine = `last output ${formatAgoV1(now - proof.lastContactAt)} ago${progressNote}`;
  }

  if (proof.lastContactAt !== undefined) {
    tooltipLines.push(`The model process last wrote output at ${clock(proof.lastContactAt)}.`);
  }
  if (proof.lastObservedChangeAt !== undefined) {
    tooltipLines.push(
      `Workspace file changed at ${clock(proof.lastObservedChangeAt)}${
        proof.lastObservedChangeWhat ? `: ${proof.lastObservedChangeWhat}` : ""
      } (not proven to be this round's).`
    );
  }
  if (proof.pid !== undefined) {
    tooltipLines.push(
      processEnded
        ? `The model process (pid ${proof.pid}) has ended.`
        : `The model process (pid ${proof.pid}) is ${proof.processState === "alive" ? "still there" : "not confirmed"}.`
    );
  }

  if (processEnded) {
    return {
      ...(activityLine !== undefined ? { activityLine } : {}),
      warning: "the model process has ended; Ensemble is closing the round",
      stuck: false,
      processEnded: true,
      tooltipLines,
    };
  }

  const warningMs = Math.max(1, input.warningMinutes) * 60_000;
  const sinceMs = lastSignOfLife > 0 ? lastSignOfLife : input.startedAt;
  const silentMs = now - sinceMs;
  const hidden = input.warningHiddenUntil !== undefined && now < input.warningHiddenUntil;
  if (input.waitingForUser === true || hidden || silentMs < warningMs) {
    return {
      ...(activityLine !== undefined ? { activityLine } : {}),
      stuck: false,
      processEnded: false,
      tooltipLines,
    };
  }

  const warning =
    proof.reportsOnlyAtEnd === true
      ? `no output for ${formatAgoV1(silentMs)} (since ${clock(sinceMs)}); ${
          input.providerLabel ?? "this provider"
        } reports only when it finishes${proof.processState === "alive" ? "; the process is still there" : ""}`
      : `no activity for ${formatAgoV1(silentMs)} (since ${clock(sinceMs)}) — may be stuck`;
  return {
    ...(activityLine !== undefined ? { activityLine } : {}),
    warning,
    stuck: true,
    processEnded: false,
    tooltipLines,
  };
}
