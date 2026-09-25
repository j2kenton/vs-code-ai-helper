import { isProcessStartTimeMismatchV1, readOtherProcessStartEpochMsV1 } from "./processStartTimeProbeV1";

/**
 * Shared (pid, processStartTime) → gone/alive/inconclusive classifier (1.0
 * RC1, Part B, item 2's "shared process-classification helper").
 *
 * Both a lock's recorded owner and a round's recorded provider CLI processes
 * are identified the same way — a same-host `pid` plus the start time it had
 * when it was recorded — and both need the same three-way answer the plan
 * spells out:
 *
 *   - **gone**: the pid does not exist, OR it exists but a readable current
 *     start time differs from the recorded one by more than
 *     {@link PROCESS_START_TIME_MISMATCH_TOLERANCE_MS_V1} (proven pid reuse).
 *   - **alive**: the pid exists and its readable start time is within
 *     tolerance of the recorded one.
 *   - **inconclusive**: the pid exists but either start time (recorded or
 *     current) could not be read. Callers must treat this as "alive" for
 *     cleanup/release decisions (fail open — never clean up, never signal on
 *     an inconclusive read) and as "surviving but not signalled" for
 *     recorded provider CLIs.
 *
 * This module only classifies; it never signals or acts. Reuses
 * `processStartTimeProbeV1.ts`'s existing tolerant, fail-open start-time
 * comparator wholesale rather than introducing a second one, per the plan's
 * "Process identity" assumption.
 */

export type ProcessLivenessClassificationV1 = "gone" | "alive" | "inconclusive";

export interface RecordedProcessIdentityV1 {
  readonly pid: number;
  /** Epoch ms, same basis as {@link readOtherProcessStartEpochMsV1}'s return value. */
  readonly processStartTime: number;
}

/**
 * Test-only override of the raw pid-existence check
 * (`process.kill(pid, 0)`). Mirrors the override seams already established
 * in `processStartTimeProbeV1.ts` and `workAdmissionV1.ts`. `undefined` (the
 * default) means production behavior is unchanged.
 */
let pidExistsCheckOverrideForTestV1: ((pid: number) => "exists" | "gone") | undefined;
export function setPidExistsCheckOverrideForTestV1(override: ((pid: number) => "exists" | "gone") | undefined): void {
  pidExistsCheckOverrideForTestV1 = override;
}

function checkPidExistsSyncV1(pid: number): "exists" | "gone" {
  if (pidExistsCheckOverrideForTestV1) {
    return pidExistsCheckOverrideForTestV1(pid);
  }
  try {
    // Signal 0 sends nothing — on every platform Node supports this only
    // performs the existence/permission check itself.
    process.kill(pid, 0);
    return "exists";
  } catch (error) {
    // ESRCH: no such process — proven gone. Any other errno (most commonly
    // EPERM: exists, but we lack permission to signal it) still proves the
    // pid is occupied, so it is NOT proof of death; fall through to the
    // start-time cross-check like a successful signal would.
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "exists";
  }
}

/**
 * Classify a single recorded (pid, processStartTime) pair. Caller is
 * responsible for the host-match check (a recorded process is only
 * meaningful to classify on the host that recorded it) — this function only
 * ever inspects local OS state for the given `pid`.
 */
export async function classifyRecordedProcessV1(
  recorded: RecordedProcessIdentityV1,
  now: number = Date.now()
): Promise<ProcessLivenessClassificationV1> {
  if (!Number.isInteger(recorded.pid) || recorded.pid <= 0) {
    return "gone";
  }
  if (checkPidExistsSyncV1(recorded.pid) === "gone") {
    return "gone";
  }
  if (!Number.isFinite(recorded.processStartTime)) {
    return "inconclusive";
  }
  const currentStartTime = await readOtherProcessStartEpochMsV1(recorded.pid, now);
  if (currentStartTime === undefined) {
    return "inconclusive";
  }
  return isProcessStartTimeMismatchV1(recorded.processStartTime, currentStartTime) ? "gone" : "alive";
}

/** Classify several recorded processes, e.g. every provider CLI recorded
 * next to one lock. Order matches `recorded`. */
export async function classifyRecordedProcessesV1(
  recorded: readonly RecordedProcessIdentityV1[],
  now: number = Date.now()
): Promise<readonly ProcessLivenessClassificationV1[]> {
  return Promise.all(recorded.map((entry) => classifyRecordedProcessV1(entry, now)));
}
