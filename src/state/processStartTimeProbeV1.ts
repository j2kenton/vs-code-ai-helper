import * as fs from "fs";
import * as cp from "child_process";

/**
 * Cross-process start-time reading (v1 fixes item 1, Part 1c step 15 — the
 * second half of "determinate owner death via ESRCH OR a readable
 * process-start mismatch"; `workAdmissionV1.ts`'s own doc comment on
 * {@link WorkAdmissionOwnerLivenessV1} previously recorded this primitive as
 * not yet existing).
 *
 * A same-host pid that responds to `process.kill(pid, 0)` is not proof the
 * ORIGINAL claim owner is still alive — the OS can reuse a pid for an
 * unrelated process once the original has exited, and a busy machine can
 * reuse one quickly. This module reads the CURRENT occupant's own start time
 * — independent of whatever the claim recorded — so `workAdmissionV1.ts`'s
 * liveness probe can tell "same process, still running" (fail open) apart
 * from "different process, pid reused" (determinate death).
 *
 * Every reader below fails open to `undefined` on ANY error: missing binary,
 * unreadable `/proc` entry, unparseable output, permission denial, timeout,
 * or an unsupported platform. `undefined` is read by the caller
 * (`probeWorkAdmissionOwnerLivenessV1`) as "no mismatch evidence", which
 * resolves to `sameHostAlive` — this module can only ever ADD proof of
 * death, never proof of life, so any uncertainty here must default to the
 * safer "still alive" conclusion, matching the asymmetric-safety design the
 * rest of the probe already uses (`process.kill`'s own `EPERM`/other-errno
 * handling).
 *
 * The three platform readers are deliberately unverifiable as a whole on any
 * single development machine (this module was authored and its integration
 * tested on Windows only) — so the parsing/comparison logic that decides
 * "mismatch or not" is factored into pure, platform-labelled functions that
 * are exercised directly with fixed, documented-format fixtures regardless
 * of host OS, and the IO seam ({@link setProcessStartTimeIoOverrideForTestV1})
 * lets a test drive the full `readOtherProcessStartEpochMsV1` dispatch for
 * every platform with synthetic raw output, without actually running on that
 * OS. Only the Windows path additionally has a real, unmocked
 * spawn-a-child-and-compare integration test.
 */

export interface ProcessStartTimeIoOverrideV1 {
  /** Mirrors `fs.readFileSync(path, "utf8")`: returns the file's contents, or
   * `undefined` for any read failure (ENOENT, EACCES, ...). */
  readonly readFileUtf8Sync?: (path: string) => string | undefined;
  /** Mirrors a successful `child_process.execFile` capture of stdout, or
   * `undefined` for any failure (missing binary, non-zero exit, timeout,
   * ...). */
  readonly execFileCapture?: (command: string, args: readonly string[]) => Promise<string | undefined>;
  readonly platform?: NodeJS.Platform;
}
let ioOverrideForTestV1: ProcessStartTimeIoOverrideV1 | undefined;
/** `undefined` (the default) means production behavior (real `fs`/`child_process`
 * calls, real `process.platform`) is unchanged. */
export function setProcessStartTimeIoOverrideForTestV1(override: ProcessStartTimeIoOverrideV1 | undefined): void {
  ioOverrideForTestV1 = override;
}

function readFileUtf8SyncV1(filePath: string): string | undefined {
  if (ioOverrideForTestV1?.readFileUtf8Sync) {
    return ioOverrideForTestV1.readFileUtf8Sync(filePath);
  }
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function execFileCaptureV1(command: string, args: readonly string[]): Promise<string | undefined> {
  if (ioOverrideForTestV1?.execFileCapture) {
    return ioOverrideForTestV1.execFileCapture(command, args);
  }
  return new Promise((resolve) => {
    try {
      cp.execFile(command, args as string[], { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        resolve(error ? undefined : stdout);
      });
    } catch {
      // A synchronous throw from execFile itself (e.g. an invalid argument)
      // is exactly as fail-open as an async error.
      resolve(undefined);
    }
  });
}

function currentPlatformV1(): NodeJS.Platform {
  return ioOverrideForTestV1?.platform ?? process.platform;
}

// ── Pure parsers — unit-testable on any host OS with fixed fixtures ────────

/**
 * `/proc/<pid>/stat` field 22 (`starttime`, clock ticks since boot). Field 2
 * (`comm`, the executable name in parentheses) can itself contain spaces and
 * parentheses, so this locates the LAST `)` rather than naively splitting on
 * whitespace — the standard, documented way to parse this file safely
 * (see `proc(5)`).
 */
export function parseLinuxProcStatStartTimeTicksV1(statContents: string): number | undefined {
  const closeParen = statContents.lastIndexOf(")");
  if (closeParen === -1) {
    return undefined;
  }
  const fieldsFrom3 = statContents
    .slice(closeParen + 1)
    .trim()
    .split(/\s+/);
  // fieldsFrom3[0] is field 3 (state); field N is therefore fieldsFrom3[N - 3].
  const raw = fieldsFrom3[22 - 3];
  if (raw === undefined) {
    return undefined;
  }
  const ticks = Number(raw);
  return Number.isFinite(ticks) && ticks >= 0 ? ticks : undefined;
}

/** `/proc/uptime`'s first field: seconds since boot. */
export function parseLinuxProcUptimeSecondsV1(uptimeContents: string): number | undefined {
  const first = uptimeContents.trim().split(/\s+/)[0];
  // `Number("")` is `0`, not `NaN` — an empty/whitespace-only first field must
  // not be silently read as "zero seconds since boot".
  if (!first) {
    return undefined;
  }
  const seconds = Number(first);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/** `USER_HZ` has been fixed at 100 on every mainstream Linux kernel/arch for
 * over a decade; used only as a fallback when `getconf CLK_TCK` (see
 * `readLinuxClockTicksPerSecondV1`) is unavailable. */
export const LINUX_DEFAULT_CLOCK_TICKS_PER_SECOND_V1 = 100;

export function computeLinuxProcessStartEpochMsV1(
  startTimeTicks: number,
  uptimeSeconds: number,
  nowMs: number,
  clockTicksPerSecond: number = LINUX_DEFAULT_CLOCK_TICKS_PER_SECOND_V1
): number {
  const startSecondsSinceBoot = startTimeTicks / clockTicksPerSecond;
  const elapsedSinceStartSeconds = uptimeSeconds - startSecondsSinceBoot;
  return nowMs - elapsedSinceStartSeconds * 1000;
}

/** Windows `(Get-Process).StartTime.ToUniversalTime().ToString('o')` (ISO
 * 8601) and macOS `ps -o lstart=` (e.g. `"Mon Sep 15 08:23:11 2026"`) are
 * both parseable by `Date.parse` — the former exactly, the latter as local
 * time, which is consistent with this process's own `Date.now()` basis. */
export function parseProcessStartTimestampV1(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : undefined;
}

// ── Platform readers ────────────────────────────────────────────────────

let cachedLinuxClockTicksPerSecondV1: number | undefined;

async function readLinuxClockTicksPerSecondV1(): Promise<number> {
  if (cachedLinuxClockTicksPerSecondV1 !== undefined) {
    return cachedLinuxClockTicksPerSecondV1;
  }
  const stdout = await execFileCaptureV1("getconf", ["CLK_TCK"]);
  const parsed = stdout === undefined ? undefined : Number(stdout.trim());
  const resolved = parsed !== undefined && Number.isFinite(parsed) && parsed > 0 ? parsed : LINUX_DEFAULT_CLOCK_TICKS_PER_SECOND_V1;
  cachedLinuxClockTicksPerSecondV1 = resolved;
  return resolved;
}

async function readLinuxProcessStartEpochMsV1(pid: number, nowMs: number): Promise<number | undefined> {
  const stat = readFileUtf8SyncV1(`/proc/${pid}/stat`);
  const uptime = readFileUtf8SyncV1("/proc/uptime");
  if (stat === undefined || uptime === undefined) {
    return undefined;
  }
  const ticks = parseLinuxProcStatStartTimeTicksV1(stat);
  const uptimeSeconds = parseLinuxProcUptimeSecondsV1(uptime);
  if (ticks === undefined || uptimeSeconds === undefined) {
    return undefined;
  }
  const clockTicksPerSecond = await readLinuxClockTicksPerSecondV1();
  return computeLinuxProcessStartEpochMsV1(ticks, uptimeSeconds, nowMs, clockTicksPerSecond);
}

async function readWindowsProcessStartEpochMsV1(pid: number): Promise<number | undefined> {
  const stdout = await execFileCaptureV1("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
  ]);
  return stdout === undefined ? undefined : parseProcessStartTimestampV1(stdout);
}

async function readMacProcessStartEpochMsV1(pid: number): Promise<number | undefined> {
  const stdout = await execFileCaptureV1("ps", ["-o", "lstart=", "-p", String(pid)]);
  return stdout === undefined ? undefined : parseProcessStartTimestampV1(stdout);
}

/**
 * Read the CURRENT occupant of `pid`'s own start time, in epoch ms — the
 * same basis `WorkAdmissionClaimInfoV1.processStartTime` uses for a
 * process's self-recorded start time, so the two are directly comparable.
 * `undefined` on any failure or unsupported platform (see module doc
 * comment) — a caller must treat that as "no mismatch evidence", never as
 * proof of anything.
 */
export async function readOtherProcessStartEpochMsV1(pid: number, nowMs: number = Date.now()): Promise<number | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return undefined;
  }
  try {
    const platform = currentPlatformV1();
    if (platform === "linux") {
      return await readLinuxProcessStartEpochMsV1(pid, nowMs);
    }
    if (platform === "win32") {
      return await readWindowsProcessStartEpochMsV1(pid);
    }
    if (platform === "darwin") {
      return await readMacProcessStartEpochMsV1(pid);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Generous cross-platform tolerance for comparing a claim's recorded
 * `processStartTime` against a fresh {@link readOtherProcessStartEpochMsV1}
 * read. POSIX `ps -o lstart=` has only whole-second resolution, and the read
 * itself carries shell-out/scheduling latency; a delta within this window is
 * "no mismatch evidence" (fail open to `sameHostAlive`). Only a delta clearly
 * larger than that sampling noise counts as proof of pid reuse.
 */
export const PROCESS_START_TIME_MISMATCH_TOLERANCE_MS_V1 = 5000;

/**
 * `true` only when both timestamps are readable and differ by more than
 * {@link PROCESS_START_TIME_MISMATCH_TOLERANCE_MS_V1} — i.e. the pid
 * currently running is provably NOT the process that originally recorded
 * `recordedStartTimeMs`. `false` for a match OR for any unreadable input —
 * the caller's fail-open direction is the same either way (`sameHostAlive`),
 * this only distinguishes them for callers that want to log why.
 */
export function isProcessStartTimeMismatchV1(recordedStartTimeMs: number, currentStartTimeMs: number | undefined): boolean {
  if (currentStartTimeMs === undefined) {
    return false;
  }
  return Math.abs(currentStartTimeMs - recordedStartTimeMs) > PROCESS_START_TIME_MISMATCH_TOLERANCE_MS_V1;
}

/** Test isolation. Production never calls this. */
export function resetProcessStartTimeProbeCacheForTestV1(): void {
  cachedLinuxClockTicksPerSecondV1 = undefined;
}
