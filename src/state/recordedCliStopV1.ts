import * as cp from "node:child_process";
import {
  classifyRecordedProcessV1,
  type ProcessLivenessClassificationV1,
} from "./processLivenessClassifierV1";
import {
  clearRoundProcessesForClaimV1,
  hasRoundProcessRecordV1,
  listRoundProcessesV1,
  pendingSpawnInfoV1,
  unconfirmedProcessSpawnCountV1,
  type RecordedProviderProcessV1,
} from "./roundProcessRecordV1";
import type { RoundProcessStateV1 } from "../types/agentExecutionV1";

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

/** Per-entry result behind a {@link RoundProcessStateV1}, so a caller that
 * needs to name which recorded processes are actually outstanding (not just
 * the aggregate state) does not have to re-classify. */
interface RoundProcessClassificationV1 {
  readonly processState: RoundProcessStateV1;
  readonly entries: readonly {
    readonly entry: RecordedProviderProcessV1;
    readonly classification: ProcessLivenessClassificationV1;
  }[];
  /** Set only for `processState === "unconfirmedSpawn"` — see
   * `pendingSpawnInfoV1`'s doc comment for why `stillRunning`/`confirmedGone`
   * never need this (they have `entries`/`RecordedProviderProcessV1` instead). */
  readonly pendingSpawnLabel?: string;
  readonly pendingSpawnCommand?: string;
}

/**
 * Read-only classification of `taskFolderPath`'s recorded processes for lock
 * generation `claimId` (item 2 / Step 54) — never signals or stops anything,
 * unlike {@link stopRecordedCliProcessesV1}. Shared by
 * {@link classifyRoundProcessStateV1} (the aggregate state) and
 * {@link decideAdmissionReleaseSafetyV1} (which also needs to know which
 * individual recorded processes are not yet confirmed gone).
 *
 * `unconfirmedSpawn` takes precedence over any classified process: a spawn
 * attempt with no durably recorded outcome cannot be proven either way, so it
 * is reported distinctly rather than folded into `stillRunning`, matching
 * `stopRecordedCliProcessesV1`'s own treatment of the same gap.
 */
async function classifyRoundProcessesV1(
  taskFolderPath: string,
  claimId: string,
  deps: { readonly classify?: (recorded: RecordedProviderProcessV1) => Promise<ProcessLivenessClassificationV1> } = {}
): Promise<RoundProcessClassificationV1> {
  if (!hasRoundProcessRecordV1(taskFolderPath, claimId)) {
    // No record for this claim generation: this claim never began recording,
    // so it started no CLI of its own.
    return { processState: "confirmedGone", entries: [] };
  }
  if (unconfirmedProcessSpawnCountV1(taskFolderPath, claimId) > 0) {
    const pending = pendingSpawnInfoV1(taskFolderPath, claimId);
    return {
      processState: "unconfirmedSpawn",
      entries: [],
      pendingSpawnLabel: pending.providerLabel,
      pendingSpawnCommand: pending.command,
    };
  }
  const recorded = listRoundProcessesV1(taskFolderPath, claimId);
  if (recorded.length === 0) {
    return { processState: "confirmedGone", entries: [] };
  }
  const classify =
    deps.classify ??
    ((entry: RecordedProviderProcessV1): Promise<ProcessLivenessClassificationV1> => classifyRecordedProcessV1(entry));
  const entries = await Promise.all(recorded.map(async (entry) => ({ entry, classification: await classify(entry) })));
  // Fail open: "inconclusive" (like "alive") counts as still running — never
  // treated as proof of exit.
  const processState: RoundProcessStateV1 = entries.every((e) => e.classification === "gone") ? "confirmedGone" : "stillRunning";
  return { processState, entries };
}

/**
 * Read-only classification of `taskFolderPath`'s recorded processes for lock
 * generation `claimId` (item 2 / Step 54) — never signals or stops anything,
 * unlike {@link stopRecordedCliProcessesV1}. Used by the broker to attach a
 * `RoundProcessStateV1` to a timeout or cancellation outcome so a caller can
 * tell "definitely safe to release" apart from "a CLI may still be running"
 * without itself reaching into the process record.
 */
export async function classifyRoundProcessStateV1(
  taskFolderPath: string,
  claimId: string,
  deps: { readonly classify?: (recorded: RecordedProviderProcessV1) => Promise<ProcessLivenessClassificationV1> } = {}
): Promise<RoundProcessStateV1> {
  return (await classifyRoundProcessesV1(taskFolderPath, claimId, deps)).processState;
}

/** The outcome of {@link decideAdmissionReleaseSafetyV1}: whether a command's
 * `finally` block may release its admission marker right now (item 2 / Step
 * 57). */
export interface AdmissionReleaseSafetyDecisionV1 {
  readonly processState: RoundProcessStateV1;
  readonly safe: boolean;
  /** Set only when `safe` is `false` — names exactly what is outstanding, per
   * the plan's wording ("The provider process <pid> did not exit" / "A
   * provider process may still be starting and could not be confirmed
   * stopped"), for a refused-retry message or the held-marker card. */
  readonly outstandingReason?: string;
  /** The recorded pids not yet confirmed gone (Step 57a's `heldAfterTimeoutV1.pids`
   * on the held-marker card) — always `[]` for `confirmedGone` and
   * `unconfirmedSpawn` (an unconfirmed spawn has no recorded pid to name), and
   * populated only for `stillRunning`. */
  readonly pids: readonly number[];
  /** Set only for `processState === "unconfirmedSpawn"` — the provider and
   * display-only command line the held-marker card names for the owner to
   * check, since there is no recorded pid to identify the process by (Step
   * 57a: "lists the provider and command shown in the record"). */
  readonly providerLabel?: string;
  readonly command?: string;
}

/**
 * Decide whether it is safe to release `taskFolderPath`'s admission marker
 * for lock generation `claimId` right now (item 2 / Step 57): only when the
 * round's recorded processes are ALL confirmed gone. `stillRunning` and
 * `unconfirmedSpawn` both refuse release — an unconfirmed spawn is treated
 * exactly like a confirmed-running process, never like "nothing was
 * spawned", because it cannot be told apart from a real, un-recorded CLI.
 *
 * A caller that gets `safe: false` back must keep the marker held (never
 * unlink it) and re-check later, once at the next heartbeat interval — this
 * function is read-only and stops nothing itself, matching
 * {@link classifyRoundProcessStateV1}'s own contract.
 */
export async function decideAdmissionReleaseSafetyV1(
  taskFolderPath: string,
  claimId: string,
  deps: { readonly classify?: (recorded: RecordedProviderProcessV1) => Promise<ProcessLivenessClassificationV1> } = {}
): Promise<AdmissionReleaseSafetyDecisionV1> {
  const { processState, entries, pendingSpawnLabel, pendingSpawnCommand } = await classifyRoundProcessesV1(
    taskFolderPath,
    claimId,
    deps
  );
  if (processState === "confirmedGone") {
    return { processState, safe: true, pids: [] };
  }
  if (processState === "unconfirmedSpawn") {
    return {
      processState,
      safe: false,
      pids: [],
      outstandingReason: "A provider process may still be starting and could not be confirmed stopped.",
      providerLabel: pendingSpawnLabel,
      command: pendingSpawnCommand,
    };
  }
  // stillRunning: name only the recorded pid(s) not yet confirmed gone (a
  // "gone" entry already exited and must not be reported as outstanding),
  // so the refusal is specific rather than generic (Step 57's own wording
  // names a pid).
  const pids = entries.filter((e) => e.classification !== "gone").map((e) => e.entry.pid);
  const pidText = pids.length === 1 ? `pid ${pids[0]}` : `pids ${pids.join(", ")}`;
  return {
    processState,
    safe: false,
    pids,
    outstandingReason:
      pids.length > 0
        ? `The provider process (${pidText}) did not exit.`
        : "A provider process did not exit.",
  };
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
  if (!hasRoundProcessRecordV1(taskFolderPath, claimId)) {
    return { outcome: "allGone" };
  }
  const classify = deps.classify ?? ((recorded: RecordedProviderProcessV1) => classifyRecordedProcessV1(recorded));
  const signal = deps.signal ?? signalRecordedProcessV1;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const waitMs = deps.waitMs ?? RECORDED_CLI_STOP_WAIT_MS_V1;

  const recorded = listRoundProcessesV1(taskFolderPath, claimId);
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
  // Claim-scoped, not the task-wide `clearRoundProcessesV1`: everything above
  // (signalling, polling, re-classifying) awaits across multiple turns, long
  // enough for this claim's marker to be released and a successor claim to
  // start recording its own processes before this call lands. `claimId` has
  // its own storage key (`roundProcessRecordV1.ts`), so this delete can only
  // ever hit that one key — a successor's record, at a different key, is
  // structurally unreachable, not merely re-checked (2026-09-29 review, RC2
  // item 2 / Step 57a).
  await clearRoundProcessesForClaimV1(taskFolderPath, claimId);
  return { outcome: "allGone" };
}
