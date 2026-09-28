import * as cp from "node:child_process";
import {
  classifyRecordedProcessV1,
  type ProcessLivenessClassificationV1,
} from "./processLivenessClassifierV1";
import {
  clearRoundProcessesV1,
  listRoundProcessesV1,
  recordedClaimIdForTaskV1,
  unconfirmedProcessSpawnCountV1,
  type RecordedProviderProcessV1,
} from "./roundProcessRecordV1";

/**
 * Stop-then-confirm for the provider CLIs a dead lock owner left behind (1.0
 * RC1, Part B, item 2: "When the lock's owner is dead, stop any of those
 * recorded processes that are still running, then release the lock").
 *
 * The lock safety rule this serves: a lock is released only when every
 * provider CLI recorded against it is CONFIRMED gone. Each recorded process is
 * classified by (`pid`, `processStartTime`) — never by `pid` alone:
 *
 *   - gone         → already stopped; never signalled (a readable start-time
 *                    mismatch is proven pid reuse, so the pid is not ours).
 *   - alive        → signalled once, then re-classified after a short wait.
 *   - inconclusive → NOT signalled (Ensemble cannot prove it is still the
 *                    recorded CLI) and counted as surviving.
 *
 * Any survivor keeps the lock held; the caller reports it (task, pid,
 * provider, command line) and the next sweep re-checks, so a process the user
 * ends by hand clears the lock without another step. A record that belongs to
 * a different lock generation (`claimId`) is not this lock's: its claim never
 * began recording, so it started no CLI (see `roundProcessRecordV1.ts`,
 * "NO-RECORD AMBIGUITY").
 */

export const RECORDED_CLI_STOP_WAIT_MS_V1 = 3000;
const RECORDED_CLI_STOP_POLL_MS_V1 = 250;

export interface SurvivingRecordedProcessV1 {
  /** `undefined` only for a spawn attempt whose pid was never durably
   * recorded before a crash (`unconfirmedProcessSpawnCountV1`) — there is no
   * identity to classify or signal, so it is reported, never acted on. */
  readonly pid: number | undefined;
  readonly providerLabel: string;
  /** Display-only command line recorded at spawn (the prompt is redacted). */
  readonly command: string;
  /** Epoch ms, or NaN when it could not be read at spawn time. */
  readonly processStartTime: number;
  /** `alive` = identity verified and it survived the signal; `inconclusive` = identity could not be confirmed. */
  readonly classification: Exclude<ProcessLivenessClassificationV1, "gone">;
}

export type RecordedCliStopOutcomeV1 =
  | { readonly outcome: "allGone" }
  | { readonly outcome: "survivors"; readonly survivors: readonly SurvivingRecordedProcessV1[] };

export interface RecordedCliStopDepsV1 {
  readonly classify?: (recorded: RecordedProviderProcessV1) => Promise<ProcessLivenessClassificationV1>;
  readonly signal?: (pid: number) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly waitMs?: number;
}

/** Ends `pid` and, where the platform allows, its process group / tree. Never throws. */
function signalRecordedProcessV1(pid: number): void {
  try {
    if (process.platform === "win32") {
      cp.spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => undefined);
      return;
    }
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    // Already gone, or not ours to signal — the re-classification below decides.
  }
}

/** The wording shared by the sweep's notice: says exactly what is known about a survivor. */
export function describeSurvivingRecordedProcessV1(survivor: SurvivingRecordedProcessV1): string {
  if (survivor.pid === undefined) {
    // A spawn attempt whose pid was never durably recorded — never a real
    // process to name, so never a pid to tell the user to check, and never
    // one Ensemble can confirm gone on its own (there is no pid left to
    // re-check), unlike an ordinary survivor.
    return (
      `${survivor.providerLabel}: was starting when the window closed and its process id was never recorded, ` +
      "so Ensemble cannot identify, stop, or confirm it gone by itself, and this lock will stay held until you act — " +
      "check your running processes for a leftover CLI for this task and end it, then use the " +
      '"Release Stuck Admission Markers" command (only once you are sure no such CLI is still running for this task)'
    );
  }
  const started = Number.isFinite(survivor.processStartTime)
    ? `started ${new Date(survivor.processStartTime).toISOString()}`
    : "start time unknown";
  const identity =
    survivor.classification === "alive"
      ? "still running after being asked to stop"
      : "Ensemble could not confirm this pid is still that CLI (it may have been reused), so it was not stopped — " +
        "check your process list for this pid, command line and start time and end it only if they match";
  return `${survivor.providerLabel} (pid ${survivor.pid}, ${started}, ${survivor.command}): ${identity}`;
}

/**
 * Stops and confirms every provider CLI recorded for `taskFolderPath`'s lock
 * generation `claimId`. Clears the record when all are confirmed gone.
 */
export async function stopRecordedCliProcessesV1(
  taskFolderPath: string,
  claimId: string,
  deps: RecordedCliStopDepsV1 = {}
): Promise<RecordedCliStopOutcomeV1> {
  if (recordedClaimIdForTaskV1(taskFolderPath) !== claimId) {
    return { outcome: "allGone" };
  }
  const classify = deps.classify ?? ((recorded: RecordedProviderProcessV1) => classifyRecordedProcessV1(recorded));
  const signal = deps.signal ?? signalRecordedProcessV1;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const waitMs = deps.waitMs ?? RECORDED_CLI_STOP_WAIT_MS_V1;

  const recorded = listRoundProcessesV1(taskFolderPath);
  const first = await Promise.all(recorded.map(async (entry) => ({ entry, classification: await classify(entry) })));
  const toSignal = first.filter((item) => item.classification === "alive");
  for (const item of toSignal) {
    signal(item.entry.pid);
  }

  let waited = 0;
  let current = first;
  while (toSignal.length > 0 && waited < waitMs) {
    // Only re-classify what was signalled; an inconclusive entry stays inconclusive by rule.
    const stillAlive = current.some((item) => item.classification === "alive");
    if (!stillAlive) {
      break;
    }
    await sleep(RECORDED_CLI_STOP_POLL_MS_V1);
    waited += RECORDED_CLI_STOP_POLL_MS_V1;
    current = await Promise.all(
      current.map(async (item) =>
        item.classification === "alive" ? { entry: item.entry, classification: await classify(item.entry) } : item
      )
    );
  }

  const survivors: SurvivingRecordedProcessV1[] = [];
  for (const item of current) {
    if (item.classification === "gone") {
      continue;
    }
    survivors.push({
      pid: item.entry.pid,
      providerLabel: item.entry.providerLabel,
      command: item.entry.command,
      processStartTime: item.entry.processStartTime,
      classification: item.classification,
    });
  }

  // A spawn attempt this lock generation began but never durably confirmed
  // (an append that never landed before a crash) — see
  // `unconfirmedProcessSpawnCountV1`'s doc comment. `processes` alone cannot
  // tell this apart from "nothing was ever spawned", so it must be reported
  // and must block `allGone`, exactly like a real survivor, even though
  // there is no pid to classify or signal.
  const unconfirmed = unconfirmedProcessSpawnCountV1(taskFolderPath, claimId);
  for (let i = 0; i < unconfirmed; i += 1) {
    survivors.push({
      pid: undefined,
      providerLabel: "a provider CLI",
      command: "(its process id was never durably recorded)",
      processStartTime: Number.NaN,
      classification: "inconclusive",
    });
  }

  if (survivors.length > 0) {
    return { outcome: "survivors", survivors };
  }
  await clearRoundProcessesV1(taskFolderPath);
  return { outcome: "allGone" };
}
