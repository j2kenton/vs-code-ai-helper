import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyRecordedProcessV1,
  classifyRecordedProcessesV1,
  setPidExistsCheckOverrideForTestV1,
} from "../state/processLivenessClassifierV1";
import {
  PROCESS_START_TIME_MISMATCH_TOLERANCE_MS_V1,
  resetProcessStartTimeProbeCacheForTestV1,
  setProcessStartTimeIoOverrideForTestV1,
} from "../state/processStartTimeProbeV1";

function withOverrides(
  pidExists: "exists" | "gone",
  startTime: { readFileUtf8Sync?: (p: string) => string | undefined; execFileCapture?: () => Promise<string | undefined> }
): void {
  setPidExistsCheckOverrideForTestV1(() => pidExists);
  setProcessStartTimeIoOverrideForTestV1({ platform: "linux", ...startTime });
}

function clearOverrides(): void {
  setPidExistsCheckOverrideForTestV1(undefined);
  setProcessStartTimeIoOverrideForTestV1(undefined);
  resetProcessStartTimeProbeCacheForTestV1();
}

const LINUX_TICKS_PER_SEC = 100;

function fixtureLinuxStat(pid: number, startTimeTicks: number): string {
  return `${pid} (node) S 1 ${pid} ${pid} 0 -1 0 0 0 0 0 0 0 0 0 0 0 0 0 ${startTimeTicks} 0`;
}

void test("classifyRecordedProcessV1: pid does not exist -> gone, without touching start-time IO", async () => {
  let touched = false;
  withOverrides("gone", {
    readFileUtf8Sync: () => {
      touched = true;
      return undefined;
    },
  });
  try {
    const result = await classifyRecordedProcessV1({ pid: 4242, processStartTime: 1_000_000 });
    assert.equal(result, "gone");
    assert.equal(touched, false, "a proven-gone pid must never reach the start-time cross-check");
  } finally {
    clearOverrides();
  }
});

void test("classifyRecordedProcessV1: pid exists, start times match within tolerance -> alive", async () => {
  const nowMs = 1_700_000_000_000;
  const uptimeSeconds = 5000;
  const startTicks = 4000 * LINUX_TICKS_PER_SEC;
  const currentStartMs = nowMs - (uptimeSeconds - 4000) * 1000;
  withOverrides("exists", {
    readFileUtf8Sync: (p) => {
      if (p === "/proc/4242/stat") {return fixtureLinuxStat(4242, startTicks);}
      if (p === "/proc/uptime") {return `${uptimeSeconds} 0`;}
      return undefined;
    },
    execFileCapture: () => Promise.resolve(undefined),
  });
  try {
    const result = await classifyRecordedProcessV1({ pid: 4242, processStartTime: currentStartMs }, nowMs);
    assert.equal(result, "alive");
  } finally {
    clearOverrides();
  }
});

void test("classifyRecordedProcessV1: pid exists, start times differ beyond tolerance -> gone (proven reuse)", async () => {
  const nowMs = 1_700_000_000_000;
  const uptimeSeconds = 5000;
  const startTicks = 4000 * LINUX_TICKS_PER_SEC;
  const currentStartMs = nowMs - (uptimeSeconds - 4000) * 1000;
  const recordedStartMs = currentStartMs - PROCESS_START_TIME_MISMATCH_TOLERANCE_MS_V1 - 1;
  withOverrides("exists", {
    readFileUtf8Sync: (p) => {
      if (p === "/proc/4242/stat") {return fixtureLinuxStat(4242, startTicks);}
      if (p === "/proc/uptime") {return `${uptimeSeconds} 0`;}
      return undefined;
    },
    execFileCapture: () => Promise.resolve(undefined),
  });
  try {
    const result = await classifyRecordedProcessV1({ pid: 4242, processStartTime: recordedStartMs }, nowMs);
    assert.equal(result, "gone");
  } finally {
    clearOverrides();
  }
});

void test("classifyRecordedProcessV1: pid exists but current start time is unreadable -> inconclusive", async () => {
  withOverrides("exists", {
    readFileUtf8Sync: () => undefined,
    execFileCapture: () => Promise.resolve(undefined),
  });
  try {
    const result = await classifyRecordedProcessV1({ pid: 4242, processStartTime: 1_000_000 });
    assert.equal(result, "inconclusive");
  } finally {
    clearOverrides();
  }
});

void test("classifyRecordedProcessV1: pid exists but the recorded start time itself is not finite -> inconclusive", async () => {
  let touched = false;
  withOverrides("exists", {
    readFileUtf8Sync: () => {
      touched = true;
      return undefined;
    },
  });
  try {
    const result = await classifyRecordedProcessV1({ pid: 4242, processStartTime: Number.NaN });
    assert.equal(result, "inconclusive");
    assert.equal(touched, false, "an unreadable recorded start time should short-circuit before the IO read");
  } finally {
    clearOverrides();
  }
});

void test("classifyRecordedProcessV1: EPERM (exists, unsignalable) is not proof of death — falls through to the start-time check", async () => {
  const nowMs = 1_700_000_000_000;
  const uptimeSeconds = 5000;
  const startTicks = 4000 * LINUX_TICKS_PER_SEC;
  const currentStartMs = nowMs - (uptimeSeconds - 4000) * 1000;
  withOverrides("exists", {
    readFileUtf8Sync: (p) => {
      if (p === "/proc/4242/stat") {return fixtureLinuxStat(4242, startTicks);}
      if (p === "/proc/uptime") {return `${uptimeSeconds} 0`;}
      return undefined;
    },
    execFileCapture: () => Promise.resolve(undefined),
  });
  try {
    const result = await classifyRecordedProcessV1({ pid: 4242, processStartTime: currentStartMs }, nowMs);
    assert.equal(result, "alive");
  } finally {
    clearOverrides();
  }
});

void test("classifyRecordedProcessV1: invalid pid (non-positive or non-integer) -> gone without touching IO", async () => {
  let touched = false;
  setPidExistsCheckOverrideForTestV1(() => {
    touched = true;
    return "exists";
  });
  try {
    assert.equal(await classifyRecordedProcessV1({ pid: 0, processStartTime: 1 }), "gone");
    assert.equal(await classifyRecordedProcessV1({ pid: -5, processStartTime: 1 }), "gone");
    assert.equal(await classifyRecordedProcessV1({ pid: 1.5, processStartTime: 1 }), "gone");
    assert.equal(touched, false, "an invalid pid must never reach the existence check");
  } finally {
    clearOverrides();
  }
});

void test("classifyRecordedProcessesV1: classifies a list in order", async () => {
  withOverrides("gone", {});
  try {
    const results = await classifyRecordedProcessesV1([
      { pid: 111, processStartTime: 1 },
      { pid: 222, processStartTime: 2 },
    ]);
    assert.deepEqual(results, ["gone", "gone"]);
  } finally {
    clearOverrides();
  }
});
