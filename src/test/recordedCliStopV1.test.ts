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
import {
  classifyRoundProcessStateV1,
  decideAdmissionReleaseSafetyV1,
  describeSurvivingRecordedProcessV1,
  stopRecordedCliProcessesV1,
} from "../state/recordedCliStopV1";

/** Backed by a plain `Map`, standing in for ONE VS Code window's in-memory
 * `workspaceState` cache — see `roundProcessRecordV1.test.ts`'s cross-window
 * test for why this distinction matters (2026-09-29 review, RC2 item 2 /
 * Step 57a). */
function makeFakeMementoV1(backing: Map<string, unknown>): import("vscode").Memento {
  return {
    get<T>(key: string, defaultValue: T): T {
      return (backing.has(key) ? backing.get(key) : defaultValue) as T;
    },
    update(key: string, value: unknown): Promise<void> {
      if (value === undefined) {
        backing.delete(key);
      } else {
        backing.set(key, value);
      }
      return Promise.resolve();
    },
    keys(): readonly string[] {
      return [...backing.keys()];
    },
  } as unknown as import("vscode").Memento;
}

function installFakeExtensionContextV1(): () => void {
  const values = new Map<string, unknown>();
  __extensionContextV1TestOnly.set({ workspaceState: makeFakeMementoV1(values) } as unknown as import("vscode").ExtensionContext);
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
    assert.deepEqual(listRoundProcessesV1(TASK, CLAIM), [], "the record is cleared once every process is confirmed gone");
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
    assert.deepEqual(listRoundProcessesV1(TASK, CLAIM), []);
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
    assert.equal(listRoundProcessesV1(TASK, CLAIM).length, 1, "the record must survive so a later sweep can re-check");
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
    assert.equal(listRoundProcessesV1(TASK, CLAIM).length, 1);
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

void test("a successor claim's record, written WHILE stopRecordedCliProcessesV1 is still stopping the stale claim's process, survives the stale claim's final clear (2026-09-29 review, RC2 item 2 / Step 57a: the successor-claim race)", async () => {
  await withRecordedProcesses([makeProcess(222)], async () => {
    const SUCCESSOR_CLAIM = "claim-2";
    let checks = 0;
    const outcome = await stopRecordedCliProcessesV1(TASK, CLAIM, {
      classify: () => Promise.resolve<ProcessLivenessClassificationV1>(++checks === 1 ? "alive" : "gone"),
      signal: () => undefined,
      sleep: async () => {
        // Simulates a successor claim's marker being released and
        // reacquired, and starting its OWN process recording, while THIS
        // stale claim is still mid-flight stopping and confirming its own
        // recorded process (the real-world gap: signalling, waiting,
        // re-classifying all await across turns). Before the fix, the
        // unconditional, task-wide clear this function calls once ITS OWN
        // process is confirmed gone would erase the successor's
        // just-written record too.
        await beginRoundProcessRecordingV1(TASK, SUCCESSOR_CLAIM);
        await recordRoundProcessV1(TASK, SUCCESSOR_CLAIM, makeProcess(999));
      },
    });
    assert.deepEqual(outcome, { outcome: "allGone" }, "the stale claim's own recorded process is confirmed gone");
    assert.equal(
      listRoundProcessesV1(TASK, SUCCESSOR_CLAIM).length,
      1,
      "the successor claim's record must survive the stale claim's clear, not be wiped by it"
    );
    assert.equal(listRoundProcessesV1(TASK, SUCCESSOR_CLAIM)[0]!.pid, 999);
  });
});

void test("cross-window: stopRecordedCliProcessesV1 stopping the stale claim in window A never erases a successor claim recorded through window B's OWN, independent workspaceState cache (2026-09-29 review — the review's own ask: 'a test using independent host/storage views')", async () => {
  // Two independent Mementos, each backed by its OWN Map — never a shared
  // object — modeling two separate VS Code windows/extension-host processes
  // on the same workspace. Window B's disk starts as a snapshot of window
  // A's disk at the moment window B "opens" (mid-test, inside the injected
  // `sleep`), exactly like a fresh window reading the shared storage file at
  // startup; after that, neither window's Memento is pushed the other's
  // writes — the same "another VS Code process cannot read the raising
  // window's workspaceState" limitation `hostDecisionMirrorV1.ts` documents.
  const windowADisk = new Map<string, unknown>();
  __extensionContextV1TestOnly.set({ workspaceState: makeFakeMementoV1(windowADisk) } as unknown as import("vscode").ExtensionContext);
  await beginRoundProcessRecordingV1(TASK, CLAIM);
  await recordRoundProcessV1(TASK, CLAIM, makeProcess(222));

  const SUCCESSOR_CLAIM = "claim-cross-window";
  let windowBDisk: Map<string, unknown> | undefined;
  let checks = 0;
  const outcome = await stopRecordedCliProcessesV1(TASK, CLAIM, {
    classify: () => Promise.resolve<ProcessLivenessClassificationV1>(++checks === 1 ? "alive" : "gone"),
    signal: () => undefined,
    sleep: async () => {
      // Window B opens (its cache starts as a snapshot of window A's disk
      // right now) and records its OWN successor claim — e.g. the owner
      // reopened the task in a different window after A's marker was
      // released as stale, while window A (this call) is still mid-flight
      // stopping and confirming its own recorded process.
      windowBDisk = new Map<string, unknown>(windowADisk);
      __extensionContextV1TestOnly.set({ workspaceState: makeFakeMementoV1(windowBDisk) } as unknown as import("vscode").ExtensionContext);
      await beginRoundProcessRecordingV1(TASK, SUCCESSOR_CLAIM);
      await recordRoundProcessV1(TASK, SUCCESSOR_CLAIM, makeProcess(999));
      // Window A resumes. Its own cache is untouched by window B's writes —
      // deliberately NOT resynced here, since a live, already-running window
      // never sees another window's concurrent update in the real product.
      __extensionContextV1TestOnly.set({ workspaceState: makeFakeMementoV1(windowADisk) } as unknown as import("vscode").ExtensionContext);
    },
  });
  try {
    assert.deepEqual(outcome, { outcome: "allGone" }, "window A's own recorded process is confirmed gone");
    // Window A's own disk is all its clear could ever have touched — confirm
    // the successor's key was never written there, so there was nothing for
    // the clear to hit even accidentally.
    assert.equal(
      [...windowADisk.keys()].some((key) => key.includes(SUCCESSOR_CLAIM)),
      false,
      "window A's own disk never even received the successor's write — nothing for its clear to have hit"
    );
    // Window B's disk (the real, current truth, written directly by B) must
    // still hold its own claim's record intact after A's clear ran.
    __extensionContextV1TestOnly.set({ workspaceState: makeFakeMementoV1(windowBDisk!) } as unknown as import("vscode").ExtensionContext);
    assert.deepEqual(
      listRoundProcessesV1(TASK, SUCCESSOR_CLAIM).map((p) => p.pid),
      [999],
      "the successor claim's record, on the window that actually wrote it, must survive the stale window's clear"
    );
  } finally {
    __extensionContextV1TestOnly.reset();
  }
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
    assert.deepEqual(listRoundProcessesV1(TASK, CLAIM), []);

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

void test("classifyRoundProcessStateV1: no record for this claim reports confirmedGone", async () => {
  const restore = installFakeExtensionContextV1();
  try {
    assert.equal(await classifyRoundProcessStateV1(TASK, CLAIM), "confirmedGone");
  } finally {
    restore();
  }
});

void test("classifyRoundProcessStateV1: a record for a different claim generation reports confirmedGone", async () => {
  const restore = installFakeExtensionContextV1();
  try {
    await beginRoundProcessRecordingV1(TASK, "a-stale-claim");
    await recordRoundProcessV1(TASK, "a-stale-claim", makeProcess(101));
    assert.equal(await classifyRoundProcessStateV1(TASK, CLAIM), "confirmedGone");
  } finally {
    restore();
  }
});

void test("classifyRoundProcessStateV1: recording begun with zero processes reports confirmedGone", async () => {
  const restore = installFakeExtensionContextV1();
  try {
    await beginRoundProcessRecordingV1(TASK, CLAIM);
    assert.equal(await classifyRoundProcessStateV1(TASK, CLAIM), "confirmedGone");
  } finally {
    restore();
  }
});

void test(
  "classifyRoundProcessStateV1: a spawn attempt with no durably recorded outcome reports unconfirmedSpawn",
  async () => {
    const restore = installFakeExtensionContextV1();
    try {
      await beginRoundProcessRecordingV1(TASK, CLAIM);
      await beginProcessSpawnAttemptV1(TASK, CLAIM);
      assert.equal(await classifyRoundProcessStateV1(TASK, CLAIM), "unconfirmedSpawn");
    } finally {
      restore();
    }
  }
);

void test("classifyRoundProcessStateV1: every recorded process classified gone reports confirmedGone", async () => {
  await withRecordedProcesses([makeProcess(201), makeProcess(202)], async () => {
    const classifications = new Map<number, ProcessLivenessClassificationV1>([
      [201, "gone"],
      [202, "gone"],
    ]);
    const state = await classifyRoundProcessStateV1(TASK, CLAIM, {
      classify: (entry) => Promise.resolve(classifications.get(entry.pid) ?? "gone"),
    });
    assert.equal(state, "confirmedGone");
  });
});

void test("classifyRoundProcessStateV1: one recorded process classified alive reports stillRunning", async () => {
  await withRecordedProcesses([makeProcess(301), makeProcess(302)], async () => {
    const classifications = new Map<number, ProcessLivenessClassificationV1>([
      [301, "gone"],
      [302, "alive"],
    ]);
    const state = await classifyRoundProcessStateV1(TASK, CLAIM, {
      classify: (entry) => Promise.resolve(classifications.get(entry.pid) ?? "gone"),
    });
    assert.equal(state, "stillRunning");
  });
});

void test(
  "classifyRoundProcessStateV1: an inconclusive classification fails open to stillRunning, never confirmedGone",
  async () => {
    await withRecordedProcesses([makeProcess(401)], async () => {
      const state = await classifyRoundProcessStateV1(TASK, CLAIM, {
        classify: () => Promise.resolve("inconclusive"),
      });
      assert.equal(state, "stillRunning");
    });
  }
);

// item 2 / Step 57: decideAdmissionReleaseSafetyV1 is the read-only gate a
// command's `finally` block asks before unlinking its admission marker.

void test("decideAdmissionReleaseSafetyV1: no recorded processes for this claim is safe to release", async () => {
  const restore = installFakeExtensionContextV1();
  try {
    const decision = await decideAdmissionReleaseSafetyV1(TASK, CLAIM);
    assert.deepEqual(decision, { processState: "confirmedGone", safe: true, pids: [] });
  } finally {
    restore();
  }
});

void test("decideAdmissionReleaseSafetyV1: every recorded process confirmed gone is safe to release", async () => {
  await withRecordedProcesses([makeProcess(501), makeProcess(502)], async () => {
    const decision = await decideAdmissionReleaseSafetyV1(TASK, CLAIM, {
      classify: () => Promise.resolve("gone"),
    });
    assert.deepEqual(decision, { processState: "confirmedGone", safe: true, pids: [] });
  });
});

void test("decideAdmissionReleaseSafetyV1: a still-running recorded process refuses release and names its pid", async () => {
  await withRecordedProcesses([makeProcess(503)], async () => {
    const decision = await decideAdmissionReleaseSafetyV1(TASK, CLAIM, {
      classify: () => Promise.resolve("alive"),
    });
    assert.equal(decision.safe, false);
    assert.equal(decision.processState, "stillRunning");
    assert.match(decision.outstandingReason ?? "", /pid 503/);
    assert.match(decision.outstandingReason ?? "", /did not exit/);
    assert.deepEqual(decision.pids, [503]);
  });
});

void test("decideAdmissionReleaseSafetyV1: with one gone and one still-alive recorded process, only the alive pid is named outstanding", async () => {
  await withRecordedProcesses([makeProcess(506), makeProcess(507)], async () => {
    const decision = await decideAdmissionReleaseSafetyV1(TASK, CLAIM, {
      classify: (entry) => Promise.resolve(entry.pid === 506 ? "gone" : "alive"),
    });
    assert.equal(decision.safe, false);
    assert.equal(decision.processState, "stillRunning");
    assert.match(decision.outstandingReason ?? "", /pid 507/);
    assert.doesNotMatch(decision.outstandingReason ?? "", /506/);
  });
});

void test("decideAdmissionReleaseSafetyV1: an inconclusive classification refuses release (fails open, like classifyRoundProcessStateV1)", async () => {
  await withRecordedProcesses([makeProcess(504)], async () => {
    const decision = await decideAdmissionReleaseSafetyV1(TASK, CLAIM, {
      classify: () => Promise.resolve("inconclusive"),
    });
    assert.equal(decision.safe, false);
    assert.equal(decision.processState, "stillRunning");
  });
});

void test("decideAdmissionReleaseSafetyV1: an unconfirmed spawn refuses release with the starting-process wording, never confirmedGone", async () => {
  const restore = installFakeExtensionContextV1();
  try {
    await beginRoundProcessRecordingV1(TASK, CLAIM);
    await beginProcessSpawnAttemptV1(TASK, CLAIM);
    const decision = await decideAdmissionReleaseSafetyV1(TASK, CLAIM, {
      classify: () => assert.fail("nothing was durably recorded to classify"),
    });
    assert.equal(decision.safe, false);
    assert.equal(decision.processState, "unconfirmedSpawn");
    assert.match(decision.outstandingReason ?? "", /may still be starting/);
    assert.deepEqual(decision.pids, []);
  } finally {
    restore();
  }
});

void test("decideAdmissionReleaseSafetyV1: an unconfirmed spawn carries the recorded provider and command (Step 57a: the held-marker card names them since there is no pid)", async () => {
  const restore = installFakeExtensionContextV1();
  try {
    await beginRoundProcessRecordingV1(TASK, CLAIM);
    await beginProcessSpawnAttemptV1(TASK, CLAIM, "Codex CLI", "codex exec --json <prompt omitted>");
    const decision = await decideAdmissionReleaseSafetyV1(TASK, CLAIM, {
      classify: () => assert.fail("nothing was durably recorded to classify"),
    });
    assert.equal(decision.processState, "unconfirmedSpawn");
    assert.equal(decision.providerLabel, "Codex CLI");
    assert.equal(decision.command, "codex exec --json <prompt omitted>");
  } finally {
    restore();
  }
});

void test("decideAdmissionReleaseSafetyV1: a still-running decision never carries providerLabel/command (that identity comes from pids instead)", async () => {
  await withRecordedProcesses([makeProcess(506)], async () => {
    const decision = await decideAdmissionReleaseSafetyV1(TASK, CLAIM, { classify: () => Promise.resolve("alive") });
    assert.equal(decision.processState, "stillRunning");
    assert.equal(decision.providerLabel, undefined);
    assert.equal(decision.command, undefined);
  });
});

void test("decideAdmissionReleaseSafetyV1: a different lock generation's record is not this claim's — safe to release", async () => {
  await withRecordedProcesses([makeProcess(505)], async () => {
    const decision = await decideAdmissionReleaseSafetyV1(TASK, "some-other-claim", {
      classify: () => assert.fail("must not classify another generation's process"),
    });
    assert.deepEqual(decision, { processState: "confirmedGone", safe: true, pids: [] });
  });
});
