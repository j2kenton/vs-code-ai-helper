/**
 * Coverage for `recordedCliStopV1.ts` — stopping the provider CLIs a dead lock
 * owner left running, and confirming them gone before the lock may be released
 * (1.0 RC1, Part B, item 2). Classification itself is covered by
 * `processLivenessClassifierV1.test.ts`; here it is injected so each of the
 * three outcomes (gone / alive / inconclusive) can be driven directly.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import {
  beginProcessSpawnAttemptV1,
  beginRoundProcessRecordingV1,
  listRoundProcessesV1,
  recordRoundProcessV1,
  type RecordedProviderProcessV1,
} from "../state/roundProcessRecordV1";
import type { ProcessLivenessClassificationV1 } from "../state/processLivenessClassifierV1";
import { describeSurvivingRecordedProcessV1, stopRecordedCliProcessesV1 } from "../state/recordedCliStopV1";

function installFakeExtensionContextV1(): () => void {
  const values = new Map<string, unknown>();
  const memento = {
    get<T>(key: string, defaultValue: T): T {
      return (values.has(key) ? values.get(key) : defaultValue) as T;
    },
    update(key: string, value: unknown): Promise<void> {
      if (value === undefined) {
        values.delete(key);
      } else {
        values.set(key, value);
      }
      return Promise.resolve();
    },
  } as unknown as import("vscode").Memento;
  __extensionContextV1TestOnly.set({ workspaceState: memento } as unknown as import("vscode").ExtensionContext);
  return () => __extensionContextV1TestOnly.reset();
}

function makeProcess(pid: number, overrides: Partial<RecordedProviderProcessV1> = {}): RecordedProviderProcessV1 {
  return {
    pid,
    processStartTime: Date.parse("2026-01-01T00:00:00.000Z"),
    providerId: "codex",
    providerLabel: "Codex CLI",
    command: "codex exec --json <prompt omitted>",
    recordedAt: Date.parse("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

const TASK = "/tasks/.ensemble/2026-01-01_task_1";
const CLAIM = "claim-1";

async function withRecordedProcesses<T>(processes: readonly RecordedProviderProcessV1[], body: () => Promise<T>): Promise<T> {
  const restore = installFakeExtensionContextV1();
  try {
    await beginRoundProcessRecordingV1(TASK, CLAIM);
    for (const process of processes) {
      await recordRoundProcessV1(TASK, CLAIM, process);
    }
    return await body();
  } finally {
    restore();
  }
}

const noSleep = (): Promise<void> => Promise.resolve();

void test("a recorded CLI whose pid was reused (classified gone) is never signalled, and the record is cleared", async () => {
  await withRecordedProcesses([makeProcess(111)], async () => {
    const signalled: number[] = [];
    const outcome = await stopRecordedCliProcessesV1(TASK, CLAIM, {
      classify: () => Promise.resolve("gone"),
      signal: (pid) => signalled.push(pid),
      sleep: noSleep,
    });
    assert.deepEqual(outcome, { outcome: "allGone" });
    assert.deepEqual(signalled, [], "a pid proven reused is not Ensemble's process and must never be signalled");
    assert.deepEqual(listRoundProcessesV1(TASK), [], "the record is cleared once every process is confirmed gone");
  });
});

void test("a verified-alive recorded CLI is signalled once, re-checked, and the lock may be released once it is gone", async () => {
  await withRecordedProcesses([makeProcess(222)], async () => {
    const signalled: number[] = [];
    let checks = 0;
    const outcome = await stopRecordedCliProcessesV1(TASK, CLAIM, {
      classify: () => Promise.resolve<ProcessLivenessClassificationV1>(++checks === 1 ? "alive" : "gone"),
      signal: (pid) => signalled.push(pid),
      sleep: noSleep,
    });
    assert.deepEqual(outcome, { outcome: "allGone" });
    assert.deepEqual(signalled, [222]);
    assert.deepEqual(listRoundProcessesV1(TASK), []);
  });
});

void test("a recorded CLI whose identity is unreadable (inconclusive) is not signalled, keeps the lock, and keeps its record", async () => {
  await withRecordedProcesses([makeProcess(333, { processStartTime: Number.NaN })], async () => {
    const signalled: number[] = [];
    const outcome = await stopRecordedCliProcessesV1(TASK, CLAIM, {
      classify: () => Promise.resolve("inconclusive"),
      signal: (pid) => signalled.push(pid),
      sleep: noSleep,
    });
    assert.equal(outcome.outcome, "survivors");
    if (outcome.outcome === "survivors") {
      assert.equal(outcome.survivors.length, 1);
      assert.equal(outcome.survivors[0]!.pid, 333);
      assert.equal(outcome.survivors[0]!.classification, "inconclusive");
    }
    assert.deepEqual(signalled, [], "an unverifiable pid must never be signalled");
    assert.equal(listRoundProcessesV1(TASK).length, 1, "the record must survive so a later sweep can re-check");
  });
});

void test("a verified-alive CLI that outlives the signal is reported as a survivor and the lock is kept", async () => {
  await withRecordedProcesses([makeProcess(444)], async () => {
    const signalled: number[] = [];
    const outcome = await stopRecordedCliProcessesV1(TASK, CLAIM, {
      classify: () => Promise.resolve("alive"),
      signal: (pid) => signalled.push(pid),
      sleep: noSleep,
      waitMs: 500,
    });
    assert.equal(outcome.outcome, "survivors");
    if (outcome.outcome === "survivors") {
      assert.equal(outcome.survivors[0]!.classification, "alive");
    }
    assert.deepEqual(signalled, [444], "signalled exactly once, not on every re-check");
    assert.equal(listRoundProcessesV1(TASK).length, 1);
  });
});

void test("a mix of gone, alive and inconclusive: only the alive one is signalled and only the unconfirmed ones survive", async () => {
  await withRecordedProcesses([makeProcess(1), makeProcess(2), makeProcess(3)], async () => {
    const signalled: number[] = [];
    const seen = new Map<number, number>();
    const outcome = await stopRecordedCliProcessesV1(TASK, CLAIM, {
      classify: (recorded) => {
        seen.set(recorded.pid, (seen.get(recorded.pid) ?? 0) + 1);
        if (recorded.pid === 1) return Promise.resolve("gone");
        if (recorded.pid === 2) return Promise.resolve(seen.get(2)! === 1 ? "alive" : "gone");
        return Promise.resolve("inconclusive");
      },
      signal: (pid) => signalled.push(pid),
      sleep: noSleep,
    });
    assert.deepEqual(signalled, [2]);
    assert.equal(outcome.outcome, "survivors");
    if (outcome.outcome === "survivors") {
      assert.deepEqual(
        outcome.survivors.map((s) => s.pid),
        [3]
      );
    }
  });
});

void test("a record that belongs to a different lock generation is not this lock's: nothing is classified or signalled", async () => {
  await withRecordedProcesses([makeProcess(555)], async () => {
    let classified = 0;
    const outcome = await stopRecordedCliProcessesV1(TASK, "some-other-claim", {
      classify: () => {
        classified++;
        return Promise.resolve("alive");
      },
      signal: () => assert.fail("must not signal another generation's process"),
      sleep: noSleep,
    });
    assert.deepEqual(outcome, { outcome: "allGone" });
    assert.equal(classified, 0);
  });
});

void test("a spawn attempt begun but never confirmed recorded (the crash-window defect blocker) blocks allGone even with zero known processes, and the record is kept", async () => {
  const restore = installFakeExtensionContextV1();
  try {
    // Simulates a crash between cp.spawn() handing back a pid and the
    // post-spawn recordRoundProcessV1 append landing: processes is empty,
    // exactly like "nothing was ever spawned", but the spawn counter proves
    // otherwise. Before this fix, stopRecordedCliProcessesV1 would read
    // listRoundProcessesV1as [] and report allGone here, letting a
    // dead-owner cleanup release the lock while that CLI might still be
    // running and editing the workspace.
    await beginRoundProcessRecordingV1(TASK, CLAIM);
    await beginProcessSpawnAttemptV1(TASK, CLAIM);
    assert.deepEqual(listRoundProcessesV1(TASK), []);

    let classified = 0;
    const outcome = await stopRecordedCliProcessesV1(TASK, CLAIM, {
      classify: () => {
        classified++;
        return Promise.resolve("gone");
      },
      signal: () => assert.fail("there is no pid to signal for an unconfirmed spawn"),
      sleep: noSleep,
    });
    assert.equal(classified, 0, "nothing was recorded to classify");
    assert.equal(outcome.outcome, "survivors");
    if (outcome.outcome === "survivors") {
      assert.equal(outcome.survivors.length, 1);
      assert.equal(outcome.survivors[0]!.pid, undefined);
      assert.equal(outcome.survivors[0]!.classification, "inconclusive");
    }
  } finally {
    restore();
  }
});

void test("an unconfirmed spawn attempt combines with a real known survivor, reporting both", async () => {
  await withRecordedProcesses([makeProcess(999)], async () => {
    // withRecordedProcesses records pid 999 via recordRoundProcessV1
    // directly, without going through beginProcessSpawnAttemptV1 first, so
    // two attempts must be marked begun here for the counter to reflect one
    // matched (999, already in `processes`) and one still unconfirmed.
    await beginProcessSpawnAttemptV1(TASK, CLAIM);
    await beginProcessSpawnAttemptV1(TASK, CLAIM);
    const outcome = await stopRecordedCliProcessesV1(TASK, CLAIM, {
      classify: () => Promise.resolve("inconclusive"),
      signal: () => assert.fail("must never signal an inconclusive identity"),
      sleep: noSleep,
    });
    assert.equal(outcome.outcome, "survivors");
    if (outcome.outcome === "survivors") {
      assert.equal(outcome.survivors.length, 2);
      assert.ok(outcome.survivors.some((s) => s.pid === 999));
      assert.ok(outcome.survivors.some((s) => s.pid === undefined));
    }
  });
});

void test("the survivor description for an unconfirmed spawn names no fake pid, points to manual recovery, and never tells the user to end an unverified process outright", () => {
  const unresolved = describeSurvivingRecordedProcessV1({
    pid: undefined,
    providerLabel: "Codex CLI",
    command: "(its process id was never durably recorded)",
    processStartTime: Number.NaN,
    classification: "inconclusive",
  });
  assert.ok(!/pid \d/.test(unresolved), `must never fabricate a pid number: ${unresolved}`);
  assert.ok(unresolved.includes("Codex CLI"));
  assert.ok(unresolved.includes("Release Stuck Admission Markers"));
});

void test("the survivor description names the pid, provider, command and start time, and never tells the user to kill an unverified pid", () => {
  const inconclusive = describeSurvivingRecordedProcessV1({
    pid: 777,
    providerLabel: "Codex CLI",
    command: "codex exec --json <prompt omitted>",
    processStartTime: Date.parse("2026-01-01T00:00:00.000Z"),
    classification: "inconclusive",
  });
  for (const expected of ["777", "Codex CLI", "codex exec --json", "2026-01-01T00:00:00.000Z", "could not confirm"]) {
    assert.ok(inconclusive.includes(expected), `expected "${expected}" in: ${inconclusive}`);
  }
  assert.ok(!/\bkill\b/i.test(inconclusive), "an unverified pid must not come with a kill instruction");
  assert.ok(/only if they match/.test(inconclusive), "the user is asked to verify identity before ending it");

  const unknownStart = describeSurvivingRecordedProcessV1({
    pid: 778,
    providerLabel: "Codex CLI",
    command: "codex",
    processStartTime: Number.NaN,
    classification: "alive",
  });
  assert.ok(unknownStart.includes("start time unknown"));
  assert.ok(unknownStart.includes("still running after being asked to stop"));
});
