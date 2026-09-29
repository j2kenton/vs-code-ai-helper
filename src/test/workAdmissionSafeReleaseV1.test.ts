/**
 * Coverage for the shared safe-release bookkeeping in `workAdmissionV1.ts`
 * (item 2 / Step 57): `createSafeAdmissionReleaseStateV1`,
 * `trySafeAdmissionReleaseV1`, and `requestSafeAdmissionReleaseV1`. These
 * back the TERMINAL admission release in `draftTaskWithAI.ts`,
 * `renameTask.ts`, `commitAndPushTask.ts`, and `chatView.ts`'s local Chat
 * Resume — each of which wraps a real provider invocation, so releasing the
 * marker must go through `decideAdmissionReleaseSafetyV1` rather than
 * unlinking it unconditionally. `decideAdmissionReleaseSafetyV1` itself is
 * covered by `recordedCliStopV1.test.ts`; here the bookkeeping ON TOP of it
 * — idempotent release requests, the held/warn-once/retry loop — is
 * exercised directly against a fake handle, recording real round processes
 * and using the same `deps.classify` injection seam
 * `decideAdmissionReleaseSafetyV1` already exposes for tests.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import {
  beginProcessSpawnAttemptV1,
  beginRoundProcessRecordingV1,
  hasRoundProcessRecordV1,
  listRoundProcessesV1,
  recordRoundProcessV1,
  type RecordedProviderProcessV1,
} from "../state/roundProcessRecordV1";
import {
  ADMISSION_DIRNAME_V1,
  acquireWorkAdmissionV1,
  confirmNoProcessAndReleaseHeldAdmissionMarkerV1,
  createSafeAdmissionReleaseStateV1,
  deriveAdmissionReleaseTriggerV1,
  describeWorkAdmissionBlockerV1,
  readHeldAdmissionMarkerForTaskV1,
  recordAdmissionReleaseTriggerV1,
  requestSafeAdmissionReleaseV1,
  stopHeldAdmissionMarkerAndReleaseV1,
  trySafeAdmissionReleaseV1,
  type WorkAdmissionHandleV1,
} from "../state/workAdmissionV1";
import { safeRemoveDir } from "./testFsUtils";

const DISK_TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-work-admission-safe-release-test-"));
after(() => {
  safeRemoveDir(DISK_TEST_ROOT);
});

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
    keys(): readonly string[] {
      return [...values.keys()];
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

const TASK = "/tasks/.ensemble/2026-01-01_task_safe_release";
const CLAIM = "claim-safe-release-1";

async function withRecordedProcesses<T>(
  processes: readonly RecordedProviderProcessV1[],
  body: () => Promise<T>
): Promise<T> {
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

function makeFakeHandle(releaseCalls: { count: number }): WorkAdmissionHandleV1 {
  return {
    ownerToken: "owner-1",
    claimId: CLAIM,
    taskFolderPath: TASK,
    commandId: "test",
    purpose: "admission",
    heartbeat: (): Promise<void> => Promise.resolve(),
    release: (): Promise<void> => {
      releaseCalls.count += 1;
      return Promise.resolve();
    },
    handover: (): Promise<void> => Promise.resolve(),
  };
}

void test("trySafeAdmissionReleaseV1: no recorded processes for this claim releases immediately, calls onReleased, never onHeld", async () => {
  const restore = installFakeExtensionContextV1();
  try {
    const releaseCalls = { count: 0 };
    const handle = makeFakeHandle(releaseCalls);
    const state = createSafeAdmissionReleaseStateV1();
    let heldCalls = 0;
    let releasedCalls = 0;
    await trySafeAdmissionReleaseV1(
      state,
      handle,
      () => {
        heldCalls += 1;
      },
      () => {
        releasedCalls += 1;
      }
    );
    assert.equal(state.released, true);
    assert.equal(releasedCalls, 1);
    assert.equal(heldCalls, 0);
    assert.equal(releaseCalls.count, 1);
  } finally {
    restore();
  }
});

void test("trySafeAdmissionReleaseV1: a still-running recorded process keeps the marker held, warns once with the reason, never releases, then releases once confirmed gone", async () => {
  await withRecordedProcesses([makeProcess(503)], async () => {
    const releaseCalls = { count: 0 };
    const handle = makeFakeHandle(releaseCalls);
    const state = createSafeAdmissionReleaseStateV1();
    const heldReasons: string[] = [];
    let releasedCalls = 0;
    const onHeld = (_taskFolderPath: string, reason: string): void => {
      heldReasons.push(reason);
    };
    const onReleased = (): void => {
      releasedCalls += 1;
    };
    await trySafeAdmissionReleaseV1(state, handle, onHeld, onReleased, { classify: () => Promise.resolve("alive") });
    assert.equal(state.released, false);
    assert.equal(releaseCalls.count, 0);
    assert.equal(releasedCalls, 0);
    assert.equal(heldReasons.length, 1);
    assert.match(heldReasons[0] ?? "", /pid 503/);

    // A second attempt while still held must not warn a second time.
    await trySafeAdmissionReleaseV1(state, handle, onHeld, onReleased, { classify: () => Promise.resolve("alive") });
    assert.equal(heldReasons.length, 1);
    assert.equal(releaseCalls.count, 0);

    // Once the process is confirmed gone, a later attempt (the heartbeat
    // retry's shape) releases and reports it.
    await trySafeAdmissionReleaseV1(state, handle, onHeld, onReleased, { classify: () => Promise.resolve("gone") });
    assert.equal(state.released, true);
    assert.equal(releaseCalls.count, 1);
    assert.equal(releasedCalls, 1);
  });
});

void test("requestSafeAdmissionReleaseV1: idempotent — a second call is a no-op once requested", async () => {
  const restore = installFakeExtensionContextV1();
  try {
    const releaseCalls = { count: 0 };
    const handle = makeFakeHandle(releaseCalls);
    const state = createSafeAdmissionReleaseStateV1();
    let releasedCalls = 0;
    const onHeld = (): void => assert.fail("should not be held");
    const onReleased = (): void => {
      releasedCalls += 1;
    };
    await requestSafeAdmissionReleaseV1(state, handle, onHeld, onReleased);
    await requestSafeAdmissionReleaseV1(state, handle, onHeld, onReleased);
    assert.equal(releaseCalls.count, 1);
    assert.equal(releasedCalls, 1);
  } finally {
    restore();
  }
});

void test("requestSafeAdmissionReleaseV1: held on first request, then a heartbeat-tick retry (trySafeAdmissionReleaseV1) releases once safe", async () => {
  await withRecordedProcesses([makeProcess(701)], async () => {
    const releaseCalls = { count: 0 };
    const handle = makeFakeHandle(releaseCalls);
    const state = createSafeAdmissionReleaseStateV1();
    let heldCalls = 0;
    let releasedCalls = 0;
    const onHeld = (): void => {
      heldCalls += 1;
    };
    const onReleased = (): void => {
      releasedCalls += 1;
    };
    await requestSafeAdmissionReleaseV1(state, handle, onHeld, onReleased, { classify: () => Promise.resolve("alive") });
    assert.equal(state.released, false);
    assert.equal(state.releaseRequested, true);
    assert.equal(heldCalls, 1);

    // Mirrors each site's heartbeat tick: only retries via
    // trySafeAdmissionReleaseV1 (never requestSafeAdmissionReleaseV1 again,
    // which would no-op since releaseRequested is already true).
    assert.equal(state.releaseRequested && !state.released, true);
    await trySafeAdmissionReleaseV1(state, handle, onHeld, onReleased, { classify: () => Promise.resolve("gone") });
    assert.equal(state.released, true);
    assert.equal(releaseCalls.count, 1);
    assert.equal(releasedCalls, 1);
    assert.equal(heldCalls, 1);
  });
});

void test("trySafeAdmissionReleaseV1 / requestSafeAdmissionReleaseV1: an undefined handle never calls release() or onHeld", async () => {
  const state1 = createSafeAdmissionReleaseStateV1();
  await trySafeAdmissionReleaseV1(
    state1,
    undefined,
    () => assert.fail("should not be held"),
    () => assert.fail("should not be released")
  );
  assert.equal(state1.released, false); // no-op: nothing to decide a release against

  const state2 = createSafeAdmissionReleaseStateV1();
  await requestSafeAdmissionReleaseV1(
    state2,
    undefined,
    () => assert.fail("should not be held"),
    () => assert.fail("should not be released")
  );
  assert.equal(state2.released, true);
  assert.equal(state2.releaseRequested, true);
});

void test("trySafeAdmissionReleaseV1 (item 2 / Step 57): a held marker durably names the outstanding reason to a fresh reader, and clears it once released", async () => {
  const restore = installFakeExtensionContextV1();
  try {
    const taskFolderPath = fs.mkdtempSync(path.join(DISK_TEST_ROOT, "held-reason-"));
    const acquired = await acquireWorkAdmissionV1({
      taskFolderPath,
      purpose: "admission",
      commandId: "test-held-reason",
    });
    if (acquired.outcome !== "acquired") {
      throw new Error(`expected admission to be acquired, got ${acquired.outcome}`);
    }
    const handle = acquired.handle;

    await beginRoundProcessRecordingV1(taskFolderPath, handle.claimId);
    await recordRoundProcessV1(taskFolderPath, handle.claimId, makeProcess(909));

    const state = createSafeAdmissionReleaseStateV1();
    await trySafeAdmissionReleaseV1(
      state,
      handle,
      () => undefined,
      () => assert.fail("should not release while the recorded process is still alive"),
      { classify: () => Promise.resolve("alive") }
    );
    assert.equal(state.released, false);

    // A DIFFERENT reader (e.g. a fresh acquisition attempt in another
    // process) must see the same outstanding reason `decideAdmissionReleaseSafetyV1`
    // computed in the releasing call above — durably, from disk, not from
    // any in-memory state shared with this test.
    const blocker = describeWorkAdmissionBlockerV1(taskFolderPath);
    assert.equal(blocker?.outcome, "busy");
    assert.match(blocker?.outstandingReason ?? "", /pid 909/);
    assert.match(blocker?.outstandingReason ?? "", /did not exit/);

    const heldReasonPath = path.join(
      taskFolderPath,
      ADMISSION_DIRNAME_V1,
      `admission-held.${handle.claimId}.json`
    );
    assert.equal(fs.existsSync(heldReasonPath), true, "the held reason is written durably next to the marker");

    let released = false;
    await trySafeAdmissionReleaseV1(
      state,
      handle,
      () => undefined,
      () => {
        released = true;
      },
      { classify: () => Promise.resolve("gone") }
    );
    assert.equal(state.released, true);
    assert.equal(released, true);
    assert.equal(fs.existsSync(heldReasonPath), false, "the held-reason sidecar is cleared once release proceeds");
    assert.equal(describeWorkAdmissionBlockerV1(taskFolderPath), undefined, "the marker itself is gone too");
  } finally {
    restore();
  }
});

void test("trySafeAdmissionReleaseV1: onHeld fires only after the held-reason sidecar is durable, so a card-posting onHeld that reads it back synchronously finds it (2026-09-29 review, RC2 item 2 / Step 57a)", async () => {
  const restore = installFakeExtensionContextV1();
  try {
    const taskFolderPath = fs.mkdtempSync(path.join(DISK_TEST_ROOT, "held-onheld-ordering-"));
    const acquired = await acquireWorkAdmissionV1({
      taskFolderPath,
      purpose: "admission",
      commandId: "test-held-onheld-ordering",
    });
    if (acquired.outcome !== "acquired") {
      throw new Error(`expected admission to be acquired, got ${acquired.outcome}`);
    }
    const handle = acquired.handle;

    await beginRoundProcessRecordingV1(taskFolderPath, handle.claimId);
    await recordRoundProcessV1(taskFolderPath, handle.claimId, makeProcess(910));

    const state = createSafeAdmissionReleaseStateV1();
    let sawMarkerInsideOnHeld: ReturnType<typeof readHeldAdmissionMarkerForTaskV1> | undefined;
    await trySafeAdmissionReleaseV1(
      state,
      handle,
      // Mirrors `postHeldAdmissionMarkerCardV1`: reads the sidecar back
      // synchronously, from inside `onHeld` itself, exactly as the proactive
      // card's notifier does. Before the 2026-09-29 fix, `onHeld` fired
      // BEFORE the write below, so this read found nothing.
      () => {
        sawMarkerInsideOnHeld = readHeldAdmissionMarkerForTaskV1(taskFolderPath);
      },
      () => assert.fail("should not release while the recorded process is still alive"),
      { classify: () => Promise.resolve("alive") }
    );
    assert.equal(state.released, false);
    assert.notEqual(sawMarkerInsideOnHeld, undefined, "onHeld must see the sidecar it is reporting on, not a not-yet-written one");
    assert.match(sawMarkerInsideOnHeld?.outstandingReason ?? "", /pid 910/);
  } finally {
    restore();
  }
});

// Step 57a: `readHeldAdmissionMarkerForTaskV1`, `stopHeldAdmissionMarkerAndReleaseV1`,
// and `confirmNoProcessAndReleaseHeldAdmissionMarkerV1` — the owner's way out
// for a marker held past its owner's own terminal release.

void test("readHeldAdmissionMarkerForTaskV1: reports the structured processState and pids once a marker is held, undefined once released", async () => {
  const restore = installFakeExtensionContextV1();
  try {
    const taskFolderPath = fs.mkdtempSync(path.join(DISK_TEST_ROOT, "held-marker-info-"));
    const acquired = await acquireWorkAdmissionV1({
      taskFolderPath,
      purpose: "admission",
      commandId: "test-held-marker-info",
    });
    if (acquired.outcome !== "acquired") {
      throw new Error(`expected admission to be acquired, got ${acquired.outcome}`);
    }
    const handle = acquired.handle;

    assert.equal(readHeldAdmissionMarkerForTaskV1(taskFolderPath), undefined, "not held before any release attempt");

    await beginRoundProcessRecordingV1(taskFolderPath, handle.claimId);
    await recordRoundProcessV1(taskFolderPath, handle.claimId, makeProcess(910));

    const state = createSafeAdmissionReleaseStateV1();
    await trySafeAdmissionReleaseV1(state, handle, () => undefined, () => assert.fail("should stay held"), {
      classify: () => Promise.resolve("alive"),
    });

    const info = readHeldAdmissionMarkerForTaskV1(taskFolderPath);
    assert.ok(info, "held marker info is readable once the release attempt is held");
    assert.equal(info?.claimId, handle.claimId);
    assert.equal(info?.processState, "stillRunning");
    assert.deepEqual(info?.pids, [910]);
    assert.match(info?.outstandingReason ?? "", /pid 910/);

    await trySafeAdmissionReleaseV1(state, handle, () => undefined, () => undefined, {
      classify: () => Promise.resolve("gone"),
    });
    assert.equal(readHeldAdmissionMarkerForTaskV1(taskFolderPath), undefined, "no longer held once released");
  } finally {
    restore();
  }
});

void test("stopHeldAdmissionMarkerAndReleaseV1: stops the recorded process and releases the marker once confirmed gone", async () => {
  const restore = installFakeExtensionContextV1();
  try {
    const taskFolderPath = fs.mkdtempSync(path.join(DISK_TEST_ROOT, "stop-held-release-"));
    const acquired = await acquireWorkAdmissionV1({
      taskFolderPath,
      purpose: "admission",
      commandId: "test-stop-held-release",
    });
    if (acquired.outcome !== "acquired") {
      throw new Error(`expected admission to be acquired, got ${acquired.outcome}`);
    }
    const handle = acquired.handle;
    await beginRoundProcessRecordingV1(taskFolderPath, handle.claimId);
    await recordRoundProcessV1(taskFolderPath, handle.claimId, makeProcess(911));

    const state = createSafeAdmissionReleaseStateV1();
    await trySafeAdmissionReleaseV1(state, handle, () => undefined, () => assert.fail("should stay held"), {
      classify: () => Promise.resolve("alive"),
    });
    assert.ok(readHeldAdmissionMarkerForTaskV1(taskFolderPath), "held before the stop attempt");

    let classifyCalls = 0;
    const signalled: number[] = [];
    const outcome = await stopHeldAdmissionMarkerAndReleaseV1(taskFolderPath, handle.claimId, {
      classify: () => {
        classifyCalls += 1;
        return Promise.resolve(classifyCalls === 1 ? "alive" : "gone");
      },
      signal: (pid) => {
        signalled.push(pid);
      },
      sleep: () => Promise.resolve(),
    });

    assert.equal(outcome.outcome, "released");
    assert.deepEqual(signalled, [911]);
    assert.equal(describeWorkAdmissionBlockerV1(taskFolderPath), undefined, "the marker is gone");
    assert.equal(readHeldAdmissionMarkerForTaskV1(taskFolderPath), undefined, "the held-reason sidecar is cleared too");
  } finally {
    restore();
  }
});

void test("stopHeldAdmissionMarkerAndReleaseV1: a survivor keeps the marker held and is reported, not released", async () => {
  const restore = installFakeExtensionContextV1();
  try {
    const taskFolderPath = fs.mkdtempSync(path.join(DISK_TEST_ROOT, "stop-held-survivor-"));
    const acquired = await acquireWorkAdmissionV1({
      taskFolderPath,
      purpose: "admission",
      commandId: "test-stop-held-survivor",
    });
    if (acquired.outcome !== "acquired") {
      throw new Error(`expected admission to be acquired, got ${acquired.outcome}`);
    }
    const handle = acquired.handle;
    await beginRoundProcessRecordingV1(taskFolderPath, handle.claimId);
    await recordRoundProcessV1(taskFolderPath, handle.claimId, makeProcess(912));

    const state = createSafeAdmissionReleaseStateV1();
    await trySafeAdmissionReleaseV1(state, handle, () => undefined, () => assert.fail("should stay held"), {
      classify: () => Promise.resolve("alive"),
    });

    const outcome = await stopHeldAdmissionMarkerAndReleaseV1(taskFolderPath, handle.claimId, {
      classify: () => Promise.resolve("alive"),
      signal: () => undefined,
      sleep: () => Promise.resolve(),
      waitMs: 1,
    });

    assert.equal(outcome.outcome, "stillRunning");
    if (outcome.outcome === "stillRunning") {
      assert.equal(outcome.survivors.length, 1);
      assert.equal(outcome.survivors[0]?.pid, 912);
    }
    assert.ok(readHeldAdmissionMarkerForTaskV1(taskFolderPath), "still held: nothing was actually stopped");
    assert.notEqual(describeWorkAdmissionBlockerV1(taskFolderPath), undefined, "the marker itself was never unlinked");
  } finally {
    restore();
  }
});

void test("confirmNoProcessAndReleaseHeldAdmissionMarkerV1: releases an unconfirmed-spawn hold on explicit owner confirmation, without attempting a stop", async () => {
  const restore = installFakeExtensionContextV1();
  try {
    const taskFolderPath = fs.mkdtempSync(path.join(DISK_TEST_ROOT, "confirm-unconfirmed-spawn-"));
    const acquired = await acquireWorkAdmissionV1({
      taskFolderPath,
      purpose: "admission",
      commandId: "test-confirm-unconfirmed-spawn",
    });
    if (acquired.outcome !== "acquired") {
      throw new Error(`expected admission to be acquired, got ${acquired.outcome}`);
    }
    const handle = acquired.handle;
    await beginRoundProcessRecordingV1(taskFolderPath, handle.claimId);
    await beginProcessSpawnAttemptV1(taskFolderPath, handle.claimId);

    const state = createSafeAdmissionReleaseStateV1();
    await trySafeAdmissionReleaseV1(state, handle, () => undefined, () => assert.fail("should stay held"), {
      classify: () => assert.fail("nothing durably recorded to classify"),
    });

    const info = readHeldAdmissionMarkerForTaskV1(taskFolderPath);
    assert.equal(info?.processState, "unconfirmedSpawn");
    assert.deepEqual(info?.pids, []);

    const outcome = await confirmNoProcessAndReleaseHeldAdmissionMarkerV1(taskFolderPath, handle.claimId);
    assert.equal(outcome.outcome, "released");
    assert.equal(describeWorkAdmissionBlockerV1(taskFolderPath), undefined, "the marker is gone");
    assert.equal(readHeldAdmissionMarkerForTaskV1(taskFolderPath), undefined, "the held-reason sidecar is cleared too");
    assert.equal(hasRoundProcessRecordV1(taskFolderPath, handle.claimId), false, "the round's process record is cleared too");
  } finally {
    restore();
  }
});

void test("stopHeldAdmissionMarkerAndReleaseV1 / confirmNoProcessAndReleaseHeldAdmissionMarkerV1: a marker already gone reports markerGone, not an error", async () => {
  const restore = installFakeExtensionContextV1();
  try {
    const taskFolderPath = fs.mkdtempSync(path.join(DISK_TEST_ROOT, "already-released-"));
    const outcomeA = await stopHeldAdmissionMarkerAndReleaseV1(taskFolderPath, "no-such-claim");
    assert.equal(outcomeA.outcome, "markerGone");
    const outcomeB = await confirmNoProcessAndReleaseHeldAdmissionMarkerV1(taskFolderPath, "no-such-claim");
    assert.equal(outcomeB.outcome, "markerGone");
  } finally {
    restore();
  }
});

// 2026-09-29 review (RC2 item 2, Step 57a): two concurrency defects found in
// `confirmNoProcessAndReleaseHeldAdmissionMarkerV1` / `unlinkCurrentMarkerForClaimV1`.

void test("confirmNoProcessAndReleaseHeldAdmissionMarkerV1: a stale confirmation for a superseded claim never touches the newer claim's process record or marker", async () => {
  const restore = installFakeExtensionContextV1();
  try {
    const taskFolderPath = fs.mkdtempSync(path.join(DISK_TEST_ROOT, "confirm-stale-superseded-"));
    const acquiredA = await acquireWorkAdmissionV1({
      taskFolderPath,
      purpose: "admission",
      commandId: "test-confirm-stale-a",
    });
    if (acquiredA.outcome !== "acquired") {
      throw new Error(`expected admission to be acquired, got ${acquiredA.outcome}`);
    }
    const staleClaimId = acquiredA.handle.claimId;
    await beginRoundProcessRecordingV1(taskFolderPath, staleClaimId);
    await beginProcessSpawnAttemptV1(taskFolderPath, staleClaimId);

    // A releases normally (its own safe-release decided release was fine) —
    // exactly what frees the task for a fresh acquisition, and what makes a
    // LATER "I have checked, release the task" click against A's old
    // claimId stale.
    await acquiredA.handle.release();

    const acquiredB = await acquireWorkAdmissionV1({
      taskFolderPath,
      purpose: "admission",
      commandId: "test-confirm-stale-b",
    });
    if (acquiredB.outcome !== "acquired") {
      throw new Error(`expected a fresh admission to be acquired for B, got ${acquiredB.outcome}`);
    }
    const handleB = acquiredB.handle;
    await beginRoundProcessRecordingV1(taskFolderPath, handleB.claimId);
    await recordRoundProcessV1(taskFolderPath, handleB.claimId, makeProcess(913));

    // The stale owner-confirmation card for A (pressed after B has already
    // taken over the task) must be a complete no-op against B's state: it
    // must not clear B's recorded provider process (which would let Step 57
    // later mistake "no record" for proof B's own CLI is not running), and
    // must not touch B's marker.
    const outcome = await confirmNoProcessAndReleaseHeldAdmissionMarkerV1(taskFolderPath, staleClaimId);
    assert.equal(outcome.outcome, "markerGone");
    assert.equal(
      hasRoundProcessRecordV1(taskFolderPath, handleB.claimId),
      true,
      "B's round-process record must survive a stale confirmation for A"
    );
    assert.deepEqual(
      listRoundProcessesV1(taskFolderPath, handleB.claimId).map((process) => process.pid),
      [913],
      "B's recorded process must survive too"
    );
    assert.notEqual(
      describeWorkAdmissionBlockerV1(taskFolderPath),
      undefined,
      "B's marker itself must still be present"
    );
  } finally {
    restore();
  }
});

void test("confirmNoProcessAndReleaseHeldAdmissionMarkerV1: a heartbeat rename racing the removal never falsely reports released while a marker for the claim survives", async () => {
  const restore = installFakeExtensionContextV1();
  try {
    const taskFolderPath = fs.mkdtempSync(path.join(DISK_TEST_ROOT, "confirm-heartbeat-race-"));
    const acquired = await acquireWorkAdmissionV1({
      taskFolderPath,
      purpose: "admission",
      commandId: "test-confirm-heartbeat-race",
    });
    if (acquired.outcome !== "acquired") {
      throw new Error(`expected admission to be acquired, got ${acquired.outcome}`);
    }
    const handle = acquired.handle;

    const originalRename = fs.promises.rename.bind(fs.promises);
    let intercepted = false;
    const mockRename = async (src: fs.PathLike, dest: fs.PathLike): Promise<void> => {
      if (!intercepted && typeof src === "string" && !src.includes(".tombstone")) {
        intercepted = true;
        // Simulate a concurrent heartbeat winning the race: it renames the
        // CURRENT generation's marker to a NEW generation before this call's
        // own rename (targeting the SAME source path) can land — restore the
        // real `rename` first so the heartbeat's own call is real, then
        // report ENOENT for the stale source path, exactly as a real racing
        // rename would.
        (fs.promises as { rename: typeof fs.promises.rename }).rename = originalRename;
        await handle.heartbeat();
        const enoent = new Error("ENOENT (simulated race)") as NodeJS.ErrnoException;
        enoent.code = "ENOENT";
        throw enoent;
      }
      return originalRename(src, dest);
    };
    (fs.promises as { rename: typeof fs.promises.rename }).rename = mockRename;

    let outcome: Awaited<ReturnType<typeof confirmNoProcessAndReleaseHeldAdmissionMarkerV1>>;
    try {
      outcome = await confirmNoProcessAndReleaseHeldAdmissionMarkerV1(taskFolderPath, handle.claimId);
    } finally {
      (fs.promises as { rename: typeof fs.promises.rename }).rename = originalRename;
    }

    assert.equal(intercepted, true, "the simulated race was actually exercised");
    assert.equal(
      outcome.outcome,
      "released",
      "the NEW generation (post-heartbeat) marker for this claim was still found and removed"
    );
    assert.equal(
      describeWorkAdmissionBlockerV1(taskFolderPath),
      undefined,
      "no marker for this claim remains after the race — never a false 'released' beside a survivor"
    );
  } finally {
    restore();
  }
});

// 2026-09-29 (RC2 item 2, Step 57a): `deriveAdmissionReleaseTriggerV1` /
// `recordAdmissionReleaseTriggerV1` — the `heldAfterTimeoutV1.operationId`/
// `.trigger` metadata a call site records from its own coordinator outcome
// BEFORE requesting the terminal release, so a held sidecar names which
// bounded trigger (Step 54/55) ended the invocation.

void test("deriveAdmissionReleaseTriggerV1: recognizes a deadline and both cancellation codes on a failed outcome, with the outcome's operationId", () => {
  assert.deepEqual(
    deriveAdmissionReleaseTriggerV1({
      kind: "failed",
      code: "invocationDeadlineExceeded",
      correlation: { operationId: "op-1" },
    }),
    { operationId: "op-1", trigger: "timedOut" }
  );
  assert.deepEqual(
    deriveAdmissionReleaseTriggerV1({
      kind: "failed",
      code: "callerCancelled",
      correlation: { operationId: "op-2" },
    }),
    { operationId: "op-2", trigger: "cancelled" }
  );
  assert.deepEqual(
    deriveAdmissionReleaseTriggerV1({
      kind: "failed",
      code: "providerCancelled",
      correlation: { operationId: "op-3" },
    }),
    { operationId: "op-3", trigger: "cancelled" }
  );
});

void test("deriveAdmissionReleaseTriggerV1: undefined for a successful, malformed, or ordinary transport-failure outcome — never mislabels an unrelated hold", () => {
  assert.equal(deriveAdmissionReleaseTriggerV1({ kind: "completed", code: "completed" }), undefined);
  assert.equal(deriveAdmissionReleaseTriggerV1({ kind: "malformedResult", code: "invalidFrame" }), undefined);
  assert.equal(
    deriveAdmissionReleaseTriggerV1({ kind: "failed", code: "copilotRequestFailed" }),
    undefined
  );
});

void test("recordAdmissionReleaseTriggerV1 / trySafeAdmissionReleaseV1: a held sidecar carries the recorded operationId and trigger, readable back by readHeldAdmissionMarkerForTaskV1", async () => {
  const restore = installFakeExtensionContextV1();
  try {
    const taskFolderPath = fs.mkdtempSync(path.join(DISK_TEST_ROOT, "held-trigger-metadata-"));
    const acquired = await acquireWorkAdmissionV1({
      taskFolderPath,
      purpose: "admission",
      commandId: "test-held-trigger-metadata",
    });
    if (acquired.outcome !== "acquired") {
      throw new Error(`expected admission to be acquired, got ${acquired.outcome}`);
    }
    const handle = acquired.handle;
    await beginRoundProcessRecordingV1(taskFolderPath, handle.claimId);
    await recordRoundProcessV1(taskFolderPath, handle.claimId, makeProcess(914));

    const state = createSafeAdmissionReleaseStateV1();
    recordAdmissionReleaseTriggerV1(state, {
      kind: "failed",
      code: "invocationDeadlineExceeded",
      correlation: { operationId: "op-held-1" },
    });
    assert.equal(state.heldOperationId, "op-held-1");
    assert.equal(state.heldTrigger, "timedOut");

    await trySafeAdmissionReleaseV1(state, handle, () => undefined, () => assert.fail("should stay held"), {
      classify: () => Promise.resolve("alive"),
    });

    const info = readHeldAdmissionMarkerForTaskV1(taskFolderPath);
    assert.equal(info?.operationId, "op-held-1");
    assert.equal(info?.trigger, "timedOut");
  } finally {
    restore();
  }
});

void test("recordAdmissionReleaseTriggerV1: a no-op for an unrelated outcome never clears an already-recorded trigger from an earlier call", () => {
  const state = createSafeAdmissionReleaseStateV1();
  recordAdmissionReleaseTriggerV1(state, {
    kind: "failed",
    code: "callerCancelled",
    correlation: { operationId: "op-first" },
  });
  assert.equal(state.heldOperationId, "op-first");
  assert.equal(state.heldTrigger, "cancelled");

  recordAdmissionReleaseTriggerV1(state, { kind: "completed", code: "completed" });
  assert.equal(state.heldOperationId, "op-first", "unrelated outcome must not clear the prior trigger");
  assert.equal(state.heldTrigger, "cancelled");

  recordAdmissionReleaseTriggerV1(state, undefined);
  assert.equal(state.heldOperationId, "op-first", "an undefined outcome (no round dispatched) is a no-op");
});

void test("confirmNoProcessAndReleaseHeldAdmissionMarkerV1: exhausting every bounded attempt against a marker that never actually moves reports stillHeld (not markerGone), and keeps the sidecar for a retry", async () => {
  const restore = installFakeExtensionContextV1();
  try {
    const taskFolderPath = fs.mkdtempSync(path.join(DISK_TEST_ROOT, "confirm-heartbeat-exhausted-"));
    const acquired = await acquireWorkAdmissionV1({
      taskFolderPath,
      purpose: "admission",
      commandId: "test-confirm-heartbeat-exhausted",
    });
    if (acquired.outcome !== "acquired") {
      throw new Error(`expected admission to be acquired, got ${acquired.outcome}`);
    }
    const handle = acquired.handle;
    await beginRoundProcessRecordingV1(taskFolderPath, handle.claimId);
    await beginProcessSpawnAttemptV1(taskFolderPath, handle.claimId);

    const state = createSafeAdmissionReleaseStateV1();
    await trySafeAdmissionReleaseV1(state, handle, () => undefined, () => assert.fail("should stay held"), {
      classify: () => assert.fail("nothing durably recorded to classify"),
    });
    assert.ok(readHeldAdmissionMarkerForTaskV1(taskFolderPath), "the held sidecar exists before the race");

    const originalRename = fs.promises.rename.bind(fs.promises);
    let attempts = 0;
    const mockRename = async (src: fs.PathLike, dest: fs.PathLike): Promise<void> => {
      if (typeof src === "string" && !src.includes(".tombstone")) {
        // Every single bounded attempt loses the race: the real marker file
        // never actually moves, so this is a genuine survivor — not a
        // benign "someone else already removed it" ENOENT.
        attempts++;
        const enoent = new Error("ENOENT (simulated repeated race)") as NodeJS.ErrnoException;
        enoent.code = "ENOENT";
        throw enoent;
      }
      return originalRename(src, dest);
    };
    (fs.promises as { rename: typeof fs.promises.rename }).rename = mockRename;

    let outcome: Awaited<ReturnType<typeof confirmNoProcessAndReleaseHeldAdmissionMarkerV1>>;
    try {
      outcome = await confirmNoProcessAndReleaseHeldAdmissionMarkerV1(taskFolderPath, handle.claimId);
    } finally {
      (fs.promises as { rename: typeof fs.promises.rename }).rename = originalRename;
    }

    assert.equal(attempts, 5, "every bounded attempt was exercised, all lost");
    assert.equal(
      outcome.outcome,
      "stillHeld",
      "a marker proven to survive every attempt must never be reported as released or gone"
    );
    assert.notEqual(describeWorkAdmissionBlockerV1(taskFolderPath), undefined, "the marker itself is untouched");
    assert.ok(
      readHeldAdmissionMarkerForTaskV1(taskFolderPath),
      "the held-reason sidecar must survive too, so a retry sees the same held state rather than a vanished card"
    );
  } finally {
    restore();
  }
});
