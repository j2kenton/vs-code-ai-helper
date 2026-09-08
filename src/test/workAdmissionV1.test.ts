import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { hostname } from "node:os";
import { after, test } from "node:test";
import {
  acquireWorkAdmissionV1,
  describeWorkAdmissionBlockerV1,
  hasLiveWorkAdmissionBestEffortV1,
  ADMISSION_DIRNAME_V1,
} from "../state/workAdmissionV1";
import { classifyWorkflowPathV1 } from "../services/workflowPrivacyClassifierV1";

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-work-admission-test-"));
after(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

function freshTaskFolder(name: string): string {
  const dir = path.join(TEST_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

void test("hasLiveWorkAdmissionBestEffortV1 is false before any acquisition and for a nonexistent task folder", () => {
  const task = freshTaskFolder("no-admission-yet");
  assert.equal(hasLiveWorkAdmissionBestEffortV1(task), false);
  assert.equal(hasLiveWorkAdmissionBestEffortV1(path.join(TEST_ROOT, "does-not-exist")), false);
});

void test("acquireWorkAdmissionV1 publishes exactly one marker file, written once", async () => {
  const task = freshTaskFolder("single-owner-writes-once");
  const result = await acquireWorkAdmissionV1({
    taskFolderPath: task,
    purpose: "commandDispatch",
    commandId: "test-command",
  });
  assert.equal(result.outcome, "acquired");
  if (result.outcome !== "acquired") return;

  const dir = path.join(task, ADMISSION_DIRNAME_V1);
  const entries = fs.readdirSync(dir);
  // Exactly one file: the published generation-1 marker. The staging
  // `admission.claim` file must have been renamed away, not left behind.
  assert.equal(entries.length, 1);
  assert.match(entries[0]!, /^admission\.[0-9a-z-]+\.g1\.[0-9a-z]+$/);
  assert.equal(hasLiveWorkAdmissionBestEffortV1(task), true);

  await result.handle.release();
});

void test("single-owner invariant: a second caller is refused busy while the marker is live, and can acquire after release", async () => {
  const task = freshTaskFolder("single-owner-invariant");
  const first = await acquireWorkAdmissionV1({
    taskFolderPath: task,
    purpose: "commandDispatch",
    commandId: "owner-a",
  });
  assert.equal(first.outcome, "acquired");
  if (first.outcome !== "acquired") return;

  const second = await acquireWorkAdmissionV1({
    taskFolderPath: task,
    purpose: "commandDispatch",
    commandId: "owner-b",
  });
  assert.equal(second.outcome, "busy");
  if (second.outcome === "busy") {
    assert.equal(second.owner?.commandId, "owner-a");
    assert.equal(second.owner?.pid, process.pid);
  }

  // The refused caller's own contention must never disturb the live owner's marker.
  assert.equal(hasLiveWorkAdmissionBestEffortV1(task), true);

  await first.handle.release();
  assert.equal(hasLiveWorkAdmissionBestEffortV1(task), false);

  const third = await acquireWorkAdmissionV1({
    taskFolderPath: task,
    purpose: "commandDispatch",
    commandId: "owner-c",
  });
  assert.equal(third.outcome, "acquired");
  if (third.outcome === "acquired") {
    await third.handle.release();
  }
});

void test("racing geneses: exactly one of several concurrent acquirers wins", async () => {
  const task = freshTaskFolder("racing-geneses");
  const attempts = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      acquireWorkAdmissionV1({ taskFolderPath: task, purpose: "commandDispatch", commandId: `racer-${i}` })
    )
  );
  const acquired = attempts.filter((a) => a.outcome === "acquired");
  const busy = attempts.filter((a) => a.outcome === "busy");
  assert.equal(acquired.length, 1);
  assert.equal(busy.length, attempts.length - 1);

  const dir = path.join(task, ADMISSION_DIRNAME_V1);
  assert.equal(fs.readdirSync(dir).length, 1);

  if (acquired[0]!.outcome === "acquired") {
    await acquired[0]!.handle.release();
  }
});

void test("heartbeat renews the marker across several generations without ever leaving zero or two files", async () => {
  const task = freshTaskFolder("heartbeat-renewal");
  const result = await acquireWorkAdmissionV1({
    taskFolderPath: task,
    purpose: "commandDispatch",
    commandId: "heartbeat-owner",
  });
  assert.equal(result.outcome, "acquired");
  if (result.outcome !== "acquired") return;

  const dir = path.join(task, ADMISSION_DIRNAME_V1);
  let lastBasename = fs.readdirSync(dir)[0]!;
  for (let generation = 2; generation <= 5; generation++) {
    await result.handle.heartbeat();
    const entries = fs.readdirSync(dir);
    assert.equal(entries.length, 1, `expected exactly one marker after heartbeat to generation ${generation}`);
    const basename = entries[0]!;
    assert.match(basename, new RegExp(`^admission\\.[0-9a-z-]+\\.g${generation}\\.[0-9a-z]+$`));
    assert.notEqual(basename, lastBasename, "heartbeat must mint a fresh epoch, not reuse the prior filename");
    lastBasename = basename;
  }
  assert.equal(hasLiveWorkAdmissionBestEffortV1(task), true);

  await result.handle.release();
  assert.equal(fs.readdirSync(dir).length, 0);
});

void test("release after an owner is displaced (marker already gone) does not throw", async () => {
  const task = freshTaskFolder("release-displaced");
  const result = await acquireWorkAdmissionV1({
    taskFolderPath: task,
    purpose: "commandDispatch",
    commandId: "displaced-owner",
  });
  assert.equal(result.outcome, "acquired");
  if (result.outcome !== "acquired") return;

  const dir = path.join(task, ADMISSION_DIRNAME_V1);
  // Simulate displacement: remove the marker out from under the handle,
  // exactly as 1c's future takeover mechanism would (nothing in v1a does
  // this on its own).
  for (const entry of fs.readdirSync(dir)) {
    fs.unlinkSync(path.join(dir, entry));
  }

  await assert.doesNotReject(() => result.handle.release());
});

void test("stale-state fail-open diagnostic: an old marker is reported busy with age/owner/path, never silently reclaimed", async () => {
  const task = freshTaskFolder("stale-fail-open");
  const result = await acquireWorkAdmissionV1({
    taskFolderPath: task,
    purpose: "commandDispatch",
    commandId: "stale-owner",
  });
  assert.equal(result.outcome, "acquired");
  if (result.outcome !== "acquired") return;

  const dir = path.join(task, ADMISSION_DIRNAME_V1);
  const markerPath = path.join(dir, fs.readdirSync(dir)[0]!);
  // Back-date the marker well past the diagnostic staleness threshold.
  const old = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(markerPath, old, old);

  const blocker = describeWorkAdmissionBlockerV1(task);
  assert.ok(blocker);
  assert.equal(blocker?.likelyStale, true);
  assert.equal(blocker?.owner?.commandId, "stale-owner");
  assert.equal(blocker?.markerPath, markerPath);
  assert.ok(blocker.ageMs >= 59 * 60 * 1000);

  // Interim policy: a second caller is still refused, never allowed to
  // reclaim, no matter how stale — and the watchdog exemption still holds.
  const second = await acquireWorkAdmissionV1({
    taskFolderPath: task,
    purpose: "commandDispatch",
    commandId: "would-be-reclaimer",
  });
  assert.equal(second.outcome, "busy");
  assert.equal(hasLiveWorkAdmissionBestEffortV1(task), true);

  // Cleanup — remove the marker directly since its owner-local handle has no
  // knowledge of the manual back-dating (release() still works via the exact
  // filename it tracks internally).
  await result.handle.release();
});

void test("host identity is populated on every claim", async () => {
  const task = freshTaskFolder("host-identity");
  const result = await acquireWorkAdmissionV1({
    taskFolderPath: task,
    purpose: "pauseCommit",
    commandId: "host-identity-command",
  });
  assert.equal(result.outcome, "acquired");
  if (result.outcome !== "acquired") return;

  const dir = path.join(task, ADMISSION_DIRNAME_V1);
  const markerPath = path.join(dir, fs.readdirSync(dir)[0]!);
  const info = JSON.parse(fs.readFileSync(markerPath, "utf8")) as {
    hostId: string;
    pid: number;
    processStartTime: number;
    purpose: string;
    commandId: string;
    claimId: string;
  };
  assert.equal(info.hostId, hostname());
  assert.equal(info.pid, process.pid);
  assert.equal(typeof info.processStartTime, "number");
  assert.equal(info.purpose, "pauseCommit");
  assert.equal(info.commandId, "host-identity-command");
  assert.equal(typeof info.claimId, "string");
  assert.ok(info.claimId.length > 0);

  await result.handle.release();
});

void test("admission-directory paths classify as workflowControl", () => {
  const relativeMarker = `${ADMISSION_DIRNAME_V1}/admission.abc.g1.def`;
  assert.equal(classifyWorkflowPathV1(relativeMarker), "workflowControl");
  assert.equal(classifyWorkflowPathV1(`${ADMISSION_DIRNAME_V1}/admission.claim`), "workflowControl");
});
