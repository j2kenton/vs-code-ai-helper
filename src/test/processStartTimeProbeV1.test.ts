import * as assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import { test } from "node:test";
import {
  computeLinuxProcessStartEpochMsV1,
  isProcessStartTimeMismatchV1,
  LINUX_DEFAULT_CLOCK_TICKS_PER_SECOND_V1,
  parseLinuxProcStatStartTimeTicksV1,
  parseLinuxProcUptimeSecondsV1,
  parseProcessStartTimestampV1,
  PROCESS_START_TIME_MISMATCH_TOLERANCE_MS_V1,
  readOtherProcessStartEpochMsV1,
  resetProcessStartTimeProbeCacheForTestV1,
  setProcessStartTimeIoOverrideForTestV1,
} from "../state/processStartTimeProbeV1";

// ── Pure parsers — fixed, documented-format fixtures; runnable on any host OS ─

void test("parseLinuxProcStatStartTimeTicksV1: extracts field 22 from a normal /proc/<pid>/stat line", () => {
  // pid=1234 comm=(bash) state=S ppid=1 pgrp=1234 session=1234 tty_nr=0
  // tpgid=-1 flags=0 minflt..cstime=0 priority=20 nice=0 num_threads=1
  // itrealvalue=0 starttime=567890 vsize=0 ...
  const line = "1234 (bash) S 1 1234 1234 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 567890 0 0";
  assert.equal(parseLinuxProcStatStartTimeTicksV1(line), 567890);
});

void test("parseLinuxProcStatStartTimeTicksV1: tolerates spaces and parentheses inside comm", () => {
  const line = "1234 (my (weird) process name) S 1 1234 1234 0 -1 0 0 0 0 0 0 0 0 0 0 0 0 0 42 0";
  assert.equal(parseLinuxProcStatStartTimeTicksV1(line), 42);
});

void test("parseLinuxProcStatStartTimeTicksV1: returns undefined for unparseable or truncated content", () => {
  assert.equal(parseLinuxProcStatStartTimeTicksV1(""), undefined);
  assert.equal(parseLinuxProcStatStartTimeTicksV1("no parens here at all"), undefined);
  assert.equal(parseLinuxProcStatStartTimeTicksV1("1234 (bash) S 1"), undefined, "too few fields after comm");
  assert.equal(parseLinuxProcStatStartTimeTicksV1("1234 (bash) S 1 1234 1234 0 -1 0 0 0 0 0 0 0 0 0 0 0 0 0 notanumber 0"), undefined);
});

void test("parseLinuxProcUptimeSecondsV1: reads the first field of /proc/uptime", () => {
  assert.equal(parseLinuxProcUptimeSecondsV1("12345.67 9876.54"), 12345.67);
});

void test("parseLinuxProcUptimeSecondsV1: returns undefined for unparseable content", () => {
  assert.equal(parseLinuxProcUptimeSecondsV1(""), undefined);
  assert.equal(parseLinuxProcUptimeSecondsV1("not-a-number 0"), undefined);
});

void test("computeLinuxProcessStartEpochMsV1: a process that started exactly 'now' has starttime == uptime (in ticks)", () => {
  const uptimeSeconds = 10_000;
  const clockTicksPerSecond = LINUX_DEFAULT_CLOCK_TICKS_PER_SECOND_V1;
  const startTimeTicks = uptimeSeconds * clockTicksPerSecond; // started at boot+uptimeSeconds == now
  const nowMs = 1_700_000_000_000;
  assert.equal(computeLinuxProcessStartEpochMsV1(startTimeTicks, uptimeSeconds, nowMs, clockTicksPerSecond), nowMs);
});

void test("computeLinuxProcessStartEpochMsV1: a process that started at boot is nowMs - uptime", () => {
  const uptimeSeconds = 10_000;
  const clockTicksPerSecond = 100;
  const nowMs = 1_700_000_000_000;
  assert.equal(computeLinuxProcessStartEpochMsV1(0, uptimeSeconds, nowMs, clockTicksPerSecond), nowMs - uptimeSeconds * 1000);
});

void test("parseProcessStartTimestampV1: parses a Windows ISO 8601 StartTime string", () => {
  const ms = parseProcessStartTimestampV1("2026-09-15T08:23:11.1234567Z");
  assert.equal(typeof ms, "number");
  assert.ok(Number.isFinite(ms));
});

void test("parseProcessStartTimestampV1: parses a macOS 'ps -o lstart=' string", () => {
  const ms = parseProcessStartTimestampV1("Mon Sep 15 08:23:11 2026");
  assert.equal(typeof ms, "number");
  assert.ok(Number.isFinite(ms));
});

void test("parseProcessStartTimestampV1: returns undefined for empty or garbage input", () => {
  assert.equal(parseProcessStartTimestampV1(""), undefined);
  assert.equal(parseProcessStartTimestampV1("   "), undefined);
  assert.equal(parseProcessStartTimestampV1("definitely not a date"), undefined);
});

// ── isProcessStartTimeMismatchV1 ────────────────────────────────────────────

void test("isProcessStartTimeMismatchV1: unreadable current value is never a mismatch (fail open)", () => {
  assert.equal(isProcessStartTimeMismatchV1(12345, undefined), false);
});

void test("isProcessStartTimeMismatchV1: an exact match is never a mismatch", () => {
  assert.equal(isProcessStartTimeMismatchV1(12345, 12345), false);
});

void test("isProcessStartTimeMismatchV1: within tolerance is never a mismatch", () => {
  assert.equal(isProcessStartTimeMismatchV1(1_000_000, 1_000_000 + PROCESS_START_TIME_MISMATCH_TOLERANCE_MS_V1), false);
});

void test("isProcessStartTimeMismatchV1: just beyond tolerance is a mismatch, in either direction", () => {
  assert.equal(isProcessStartTimeMismatchV1(1_000_000, 1_000_000 + PROCESS_START_TIME_MISMATCH_TOLERANCE_MS_V1 + 1), true);
  assert.equal(isProcessStartTimeMismatchV1(1_000_000, 1_000_000 - PROCESS_START_TIME_MISMATCH_TOLERANCE_MS_V1 - 1), true);
});

// ── readOtherProcessStartEpochMsV1 platform dispatch (IO-overridden, any host OS) ─

void test("readOtherProcessStartEpochMsV1: rejects a non-positive or non-integer pid without touching IO", async () => {
  let touched = false;
  setProcessStartTimeIoOverrideForTestV1({
    readFileUtf8Sync: () => {
      touched = true;
      return undefined;
    },
    execFileCapture: () => {
      touched = true;
      return Promise.resolve(undefined);
    },
    platform: "linux",
  });
  try {
    assert.equal(await readOtherProcessStartEpochMsV1(0), undefined);
    assert.equal(await readOtherProcessStartEpochMsV1(-5), undefined);
    assert.equal(await readOtherProcessStartEpochMsV1(1.5), undefined);
    assert.equal(touched, false, "an invalid pid must never reach the IO layer");
  } finally {
    setProcessStartTimeIoOverrideForTestV1(undefined);
  }
});

void test("readOtherProcessStartEpochMsV1: linux — combines /proc/<pid>/stat and /proc/uptime via the exclusive-create-free platform reader", async () => {
  resetProcessStartTimeProbeCacheForTestV1();
  const nowMs = 1_700_000_000_000;
  const uptimeSeconds = 5000;
  const startTicks = 4000 * 100; // started 1000s after boot, at 100 ticks/sec
  setProcessStartTimeIoOverrideForTestV1({
    platform: "linux",
    readFileUtf8Sync: (p) => {
      if (p === "/proc/4242/stat") return `4242 (node) S 1 4242 4242 0 -1 0 0 0 0 0 0 0 0 0 0 0 0 0 ${startTicks} 0`;
      if (p === "/proc/uptime") return `${uptimeSeconds} 0`;
      return undefined;
    },
    execFileCapture: () => Promise.resolve(undefined), // getconf unavailable -> default 100 ticks/sec
  });
  try {
    const result = await readOtherProcessStartEpochMsV1(4242, nowMs);
    assert.equal(result, nowMs - (uptimeSeconds - 4000) * 1000);
  } finally {
    setProcessStartTimeIoOverrideForTestV1(undefined);
    resetProcessStartTimeProbeCacheForTestV1();
  }
});

void test("readOtherProcessStartEpochMsV1: linux — missing /proc entries fail open to undefined", async () => {
  setProcessStartTimeIoOverrideForTestV1({ platform: "linux", readFileUtf8Sync: () => undefined, execFileCapture: () => Promise.resolve(undefined) });
  try {
    assert.equal(await readOtherProcessStartEpochMsV1(4242), undefined);
  } finally {
    setProcessStartTimeIoOverrideForTestV1(undefined);
  }
});

void test("readOtherProcessStartEpochMsV1: win32 — parses PowerShell's ISO StartTime", async () => {
  setProcessStartTimeIoOverrideForTestV1({
    platform: "win32",
    execFileCapture: (command, args) => {
      assert.match(command, /powershell/i);
      assert.ok(args.some((a) => a.includes("Get-Process")));
      return Promise.resolve("2026-09-15T08:23:11.0000000Z\r\n");
    },
  });
  try {
    const result = await readOtherProcessStartEpochMsV1(4242);
    assert.equal(result, Date.parse("2026-09-15T08:23:11.0000000Z"));
  } finally {
    setProcessStartTimeIoOverrideForTestV1(undefined);
  }
});

void test("readOtherProcessStartEpochMsV1: win32 — Get-Process failure (process gone) fails open to undefined", async () => {
  setProcessStartTimeIoOverrideForTestV1({ platform: "win32", execFileCapture: () => Promise.resolve(undefined) });
  try {
    assert.equal(await readOtherProcessStartEpochMsV1(4242), undefined);
  } finally {
    setProcessStartTimeIoOverrideForTestV1(undefined);
  }
});

void test("readOtherProcessStartEpochMsV1: darwin — parses 'ps -o lstart=' output", async () => {
  setProcessStartTimeIoOverrideForTestV1({
    platform: "darwin",
    execFileCapture: (command, args) => {
      assert.equal(command, "ps");
      assert.deepEqual([...args], ["-o", "lstart=", "-p", "4242"]);
      return Promise.resolve("Mon Sep 15 08:23:11 2026\n");
    },
  });
  try {
    const result = await readOtherProcessStartEpochMsV1(4242);
    assert.equal(result, Date.parse("Mon Sep 15 08:23:11 2026"));
  } finally {
    setProcessStartTimeIoOverrideForTestV1(undefined);
  }
});

void test("readOtherProcessStartEpochMsV1: an unsupported platform fails open to undefined without touching IO", async () => {
  let touched = false;
  setProcessStartTimeIoOverrideForTestV1({
    platform: "aix" as NodeJS.Platform,
    execFileCapture: () => {
      touched = true;
      return Promise.resolve(undefined);
    },
    readFileUtf8Sync: () => {
      touched = true;
      return undefined;
    },
  });
  try {
    assert.equal(await readOtherProcessStartEpochMsV1(4242), undefined);
    assert.equal(touched, false);
  } finally {
    setProcessStartTimeIoOverrideForTestV1(undefined);
  }
});

void test("readOtherProcessStartEpochMsV1: a thrown IO override never escapes — fails open to undefined", async () => {
  setProcessStartTimeIoOverrideForTestV1({
    platform: "win32",
    execFileCapture: () => Promise.reject(new Error("simulated IO failure")),
  });
  try {
    assert.equal(await readOtherProcessStartEpochMsV1(4242), undefined);
  } finally {
    setProcessStartTimeIoOverrideForTestV1(undefined);
  }
});

// ── Real, unmocked integration (this sandbox runs on win32 — see module doc
// comment for why the linux/darwin readers are covered by fixture tests
// above instead of real cross-OS execution) ────────────────────────────────

void test("readOtherProcessStartEpochMsV1: real end-to-end read of a genuinely spawned child process's start time", { skip: process.platform !== "win32" }, async () => {
  const spawnedAtMs = Date.now();
  const child = childProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { windowsHide: true });
  const pid = child.pid;
  assert.ok(pid !== undefined, "spawned child must have a pid");
  try {
    // Give the OS a brief moment to make the process queryable.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const result = await readOtherProcessStartEpochMsV1(pid);
    assert.equal(typeof result, "number");
    assert.ok(Number.isFinite(result), "a real, live pid on the real platform must yield a readable start time");
    // The child was spawned moments ago — its reported start time must be
    // close to "now", not some unrelated value.
    assert.ok(
      Math.abs((result as number) - spawnedAtMs) < 15_000,
      `expected the spawned child's start time (${result}) to be within 15s of when it was spawned (${spawnedAtMs})`
    );
  } finally {
    child.kill();
  }
});

void test("readOtherProcessStartEpochMsV1: real read of a pid that has genuinely exited fails open to undefined, not a stale/garbage value", { skip: process.platform !== "win32" }, async () => {
  const child = childProcess.spawn(process.execPath, ["-e", ""], { windowsHide: true });
  const pid = child.pid;
  assert.ok(pid !== undefined);
  await new Promise<void>((resolve, reject) => {
    child.once("exit", () => resolve());
    child.once("error", reject);
  });
  const result = await readOtherProcessStartEpochMsV1(pid);
  assert.equal(result, undefined, "a dead pid must never resolve to a fabricated start time");
});
