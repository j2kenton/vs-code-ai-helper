import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import {
  acquireOrAdoptWorkAdmissionV1,
  acquireWorkAdmissionV1,
  authorizeWorkAdmissionHandoffV1,
  beginTargetResolutionV1,
  describeWorkAdmissionBlockerV1,
  endTargetResolutionV1,
  hasLiveWorkAdmissionBestEffortV1,
  hasLiveWorkAdmissionExcludingOwnerV1,
  hasResolutionInFlightBestEffortV1,
  resetTargetResolutionForTestV1,
  revokeWorkAdmissionHandoffV1,
  setWorkAdmissionClockForTestV1,
  setWorkAdmissionFsFailureInjectionForTestV1,
  ADMISSION_DIRNAME_V1,
  WORK_ADMISSION_LIKELY_STALE_MS_V1,
} from "../state/workAdmissionV1";
import {
  configureHostIdentityRootV1,
  resetHostIdentityForTestV1,
  resolveDurableHostIdentityV1,
  resolveHostIdentityV1,
  setHostIdentityFsFailureInjectionForTestV1,
} from "../state/hostIdentityV1";
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
    purpose: "admission",
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
    purpose: "admission",
    commandId: "owner-a",
  });
  assert.equal(first.outcome, "acquired");
  if (first.outcome !== "acquired") return;

  const second = await acquireWorkAdmissionV1({
    taskFolderPath: task,
    purpose: "admission",
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
    purpose: "admission",
    commandId: "owner-c",
  });
  assert.equal(third.outcome, "acquired");
  if (third.outcome === "acquired") {
    await third.handle.release();
  }
});

void test("acquireOrAdoptWorkAdmissionV1 falls through to a fresh genesis when no local handle exists", async () => {
  const task = freshTaskFolder("adopt-falls-through-to-genesis");
  const result = await acquireOrAdoptWorkAdmissionV1({
    taskFolderPath: task,
    purpose: "admission",
    commandId: "solo-caller",
  });
  assert.equal(result.outcome, "acquired");
  if (result.outcome !== "acquired") return;
  assert.equal(hasLiveWorkAdmissionBestEffortV1(task), true);
  await result.handle.release();
  assert.equal(hasLiveWorkAdmissionBestEffortV1(task), false);
});

void test("same-process handoff: acquireOrAdoptWorkAdmissionV1 joins an already-live local marker when presented the authorized handoff token", async () => {
  const task = freshTaskFolder("adopt-joins-live-local-marker");
  const original = await acquireWorkAdmissionV1({
    taskFolderPath: task,
    purpose: "admission",
    commandId: "resume-flow",
  });
  assert.equal(original.outcome, "acquired");
  if (original.outcome !== "acquired") return;

  // A same-process caller acquiring fresh would be refused busy against this
  // exact marker (the invariant `acquireWorkAdmissionV1` still enforces for
  // any OTHER, non-adopting caller — proven by the "single-owner invariant"
  // test above and by the "refuses an unrelated same-process caller" test
  // below). The adopt-aware entry point joins ONLY when presented the token
  // the resume-flow-equivalent holder just authorized for this exact task
  // (2026-09-08 review architectural blocker fix).
  const handoffToken = authorizeWorkAdmissionHandoffV1(task);
  const adopted = await acquireOrAdoptWorkAdmissionV1({
    taskFolderPath: task,
    purpose: "admission",
    commandId: "downstream-command",
    handoffToken,
  });
  assert.equal(adopted.outcome, "acquired");
  if (adopted.outcome !== "acquired") return;

  // Exactly one marker file on disk throughout — adoption never creates a
  // second one.
  const dir = path.join(task, ADMISSION_DIRNAME_V1);
  assert.equal(fs.readdirSync(dir).length, 1);
  assert.equal(hasLiveWorkAdmissionBestEffortV1(task), true);

  // The downstream (adopted) view releasing first must NOT unlink the
  // marker — the original resume-flow handle still holds it.
  await adopted.handle.release();
  assert.equal(hasLiveWorkAdmissionBestEffortV1(task), true);
  assert.equal(fs.readdirSync(dir).length, 1);

  // Only once the ORIGINAL handle also releases is the marker actually gone.
  await original.handle.release();
  assert.equal(hasLiveWorkAdmissionBestEffortV1(task), false);
  assert.equal(fs.readdirSync(dir).length, 0);
});

void test("acquireOrAdoptWorkAdmissionV1 refuses an unrelated same-process caller with no matching handoff token (architectural blocker fix)", async () => {
  const task = freshTaskFolder("adopt-refuses-unrelated-caller");
  const original = await acquireWorkAdmissionV1({
    taskFolderPath: task,
    purpose: "admission",
    commandId: "resume-flow",
  });
  assert.equal(original.outcome, "acquired");
  if (original.outcome !== "acquired") return;

  // No token at all — an unrelated concurrent invocation in the same process
  // must fall through to the ordinary genesis path and be refused busy
  // against the live marker, exactly like a cross-process caller. This is
  // the fix for the 2026-09-08 review's architectural blocker: adoption used
  // to succeed for ANY same-process caller regardless of relationship to the
  // marker's owner.
  const noToken = await acquireOrAdoptWorkAdmissionV1({
    taskFolderPath: task,
    purpose: "admission",
    commandId: "unrelated-command",
  });
  assert.equal(noToken.outcome, "busy");

  // A stale/foreign token (never authorized for this task) must also be
  // refused, not just an absent one.
  const wrongToken = await acquireOrAdoptWorkAdmissionV1({
    taskFolderPath: task,
    purpose: "admission",
    commandId: "unrelated-command",
    handoffToken: "not-a-real-token",
  });
  assert.equal(wrongToken.outcome, "busy");

  await original.handle.release();
});

void test("a handoff token authorizes exactly one adoption and cannot be replayed", async () => {
  const task = freshTaskFolder("adopt-token-single-use");
  const original = await acquireWorkAdmissionV1({
    taskFolderPath: task,
    purpose: "admission",
    commandId: "resume-flow",
  });
  assert.equal(original.outcome, "acquired");
  if (original.outcome !== "acquired") return;

  const handoffToken = authorizeWorkAdmissionHandoffV1(task);
  const first = await acquireOrAdoptWorkAdmissionV1({
    taskFolderPath: task,
    purpose: "admission",
    commandId: "downstream-command",
    handoffToken,
  });
  assert.equal(first.outcome, "acquired");
  if (first.outcome !== "acquired") return;

  // Replaying the SAME token for a second, later call must not authorize a
  // second adoption — it was consumed by the first.
  const replay = await acquireOrAdoptWorkAdmissionV1({
    taskFolderPath: task,
    purpose: "admission",
    commandId: "another-downstream-command",
    handoffToken,
  });
  assert.equal(replay.outcome, "busy");

  await first.handle.release();
  await original.handle.release();
});

void test("revokeWorkAdmissionHandoffV1 invalidates an unconsumed token", async () => {
  const task = freshTaskFolder("adopt-token-revoked");
  const original = await acquireWorkAdmissionV1({
    taskFolderPath: task,
    purpose: "admission",
    commandId: "resume-flow",
  });
  assert.equal(original.outcome, "acquired");
  if (original.outcome !== "acquired") return;

  const handoffToken = authorizeWorkAdmissionHandoffV1(task);
  revokeWorkAdmissionHandoffV1(task);

  const afterRevoke = await acquireOrAdoptWorkAdmissionV1({
    taskFolderPath: task,
    purpose: "admission",
    commandId: "downstream-command",
    handoffToken,
  });
  assert.equal(afterRevoke.outcome, "busy");

  await original.handle.release();
});

void test("same-process handoff: releasing in the reverse order (original first, then the adopted view) still ends fully released", async () => {
  const task = freshTaskFolder("adopt-reverse-release-order");
  const original = await acquireWorkAdmissionV1({
    taskFolderPath: task,
    purpose: "admission",
    commandId: "resume-flow",
  });
  assert.equal(original.outcome, "acquired");
  if (original.outcome !== "acquired") return;

  const adopted = await acquireOrAdoptWorkAdmissionV1({
    taskFolderPath: task,
    purpose: "admission",
    commandId: "downstream-command",
    handoffToken: authorizeWorkAdmissionHandoffV1(task),
  });
  assert.equal(adopted.outcome, "acquired");
  if (adopted.outcome !== "acquired") return;

  // The original handle releasing first must NOT unlink the marker while the
  // adopted view is still outstanding.
  await original.handle.release();
  assert.equal(hasLiveWorkAdmissionBestEffortV1(task), true);

  await adopted.handle.release();
  assert.equal(hasLiveWorkAdmissionBestEffortV1(task), false);

  const dir = path.join(task, ADMISSION_DIRNAME_V1);
  assert.equal(fs.readdirSync(dir).length, 0);
});

void test("an adopted view's heartbeat actually renews the marker after the original handle has already released (completion blocker fix, narrowed 2026-09-08)", async () => {
  const task = freshTaskFolder("adopt-heartbeat-after-original-release");
  const original = await acquireWorkAdmissionV1({
    taskFolderPath: task,
    purpose: "admission",
    commandId: "resume-flow",
  });
  assert.equal(original.outcome, "acquired");
  if (original.outcome !== "acquired") return;

  const adopted = await acquireOrAdoptWorkAdmissionV1({
    taskFolderPath: task,
    purpose: "admission",
    commandId: "downstream-command",
    handoffToken: authorizeWorkAdmissionHandoffV1(task),
  });
  assert.equal(adopted.outcome, "acquired");
  if (adopted.outcome !== "acquired") return;

  const dir = path.join(task, ADMISSION_DIRNAME_V1);
  const beforeRelease = fs.readdirSync(dir);
  assert.equal(beforeRelease.length, 1);
  const markerBeforeOriginalRelease = beforeRelease[0]!;
  assert.match(markerBeforeOriginalRelease, /\.g1\./, "starts at generation 1");

  // The original acquirer lets go first; the adopted view remains the sole
  // holder, and the marker itself must still be live (not unlinked, since a
  // holder remains).
  await original.handle.release();
  assert.equal(hasLiveWorkAdmissionBestEffortV1(task), true);

  // Before the fix, heartbeat() returned immediately once the BASE handle's
  // own `released` flag was set — which happens the moment `original`
  // released, regardless of whether any holder remains. That made every
  // subsequent heartbeat from the adopted view (or its own timer) a
  // permanent silent no-op: the marker would stop renewing the instant the
  // original resume flow let go, even though the downstream command (the
  // adopted view) was still legitimately working. Prove the opposite here:
  // the rename must actually happen.
  await adopted.handle.heartbeat();

  const afterHeartbeat = fs.readdirSync(dir);
  assert.equal(afterHeartbeat.length, 1, "still exactly one marker file — the old one renamed, not duplicated");
  assert.notEqual(
    afterHeartbeat[0],
    markerBeforeOriginalRelease,
    "heartbeat must actually rename the marker to a new generation, not silently no-op"
  );
  assert.match(afterHeartbeat[0]!, /\.g2\./, "advances to generation 2");
  assert.equal(hasLiveWorkAdmissionBestEffortV1(task), true);

  await adopted.handle.release();
  assert.equal(hasLiveWorkAdmissionBestEffortV1(task), false);
  assert.equal(fs.readdirSync(dir).length, 0);
});

void test("adopted view release is serialized with heartbeat through the same owner-local queue and cannot leak an orphaned marker (completion blocker fix)", async () => {
  const task = freshTaskFolder("adopt-release-serialized-with-heartbeat");
  const original = await acquireWorkAdmissionV1({
    taskFolderPath: task,
    purpose: "admission",
    commandId: "resume-flow",
  });
  assert.equal(original.outcome, "acquired");
  if (original.outcome !== "acquired") return;

  const adopted = await acquireOrAdoptWorkAdmissionV1({
    taskFolderPath: task,
    purpose: "admission",
    commandId: "downstream-command",
    handoffToken: authorizeWorkAdmissionHandoffV1(task),
  });
  assert.equal(adopted.outcome, "acquired");
  if (adopted.outcome !== "acquired") return;

  // Original releases first so the adopted view becomes the sole remaining
  // holder — its own release() is now the one that must actually unlink.
  await original.handle.release();
  assert.equal(hasLiveWorkAdmissionBestEffortV1(task), true);

  // Fire a heartbeat and the final release from the SAME (now sole) adopted
  // view back-to-back without awaiting the first. Before the fix, an adopted
  // view's release() unlinked by calling the finalizer directly, bypassing
  // the owner-local queue heartbeat/release already share on the base
  // handle — so a release could race an in-flight heartbeat rename and leave
  // the just-renamed marker behind forever (a permanent "busy" stranding
  // under v1a's interim never-reclaim policy). Routing both through the
  // shared queue (`localSerializersV1`) means whichever fires first fully
  // completes before the other starts, so the marker always ends in a
  // consistent, fully-unlinked state.
  await Promise.all([adopted.handle.heartbeat(), adopted.handle.release()]);

  assert.equal(hasLiveWorkAdmissionBestEffortV1(task), false);
  const dir = path.join(task, ADMISSION_DIRNAME_V1);
  assert.equal(fs.readdirSync(dir).length, 0, "no marker file must be left behind after release settles");
});

void test("an adopted view's release is idempotent, like any other handle", async () => {
  const task = freshTaskFolder("adopt-idempotent-release");
  const original = await acquireWorkAdmissionV1({
    taskFolderPath: task,
    purpose: "admission",
    commandId: "resume-flow",
  });
  assert.equal(original.outcome, "acquired");
  if (original.outcome !== "acquired") return;

  const adopted = await acquireOrAdoptWorkAdmissionV1({
    taskFolderPath: task,
    purpose: "admission",
    commandId: "downstream-command",
    handoffToken: authorizeWorkAdmissionHandoffV1(task),
  });
  assert.equal(adopted.outcome, "acquired");
  if (adopted.outcome !== "acquired") return;

  await adopted.handle.release();
  await adopted.handle.release(); // must not double-decrement the shared count
  assert.equal(hasLiveWorkAdmissionBestEffortV1(task), true);

  await original.handle.release();
  assert.equal(hasLiveWorkAdmissionBestEffortV1(task), false);
});

void test("racing geneses: exactly one of several concurrent acquirers wins", async () => {
  const task = freshTaskFolder("racing-geneses");
  const attempts = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      acquireWorkAdmissionV1({ taskFolderPath: task, purpose: "admission", commandId: `racer-${i}` })
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
    purpose: "admission",
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
    purpose: "admission",
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
    purpose: "admission",
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
    purpose: "admission",
    commandId: "would-be-reclaimer",
  });
  assert.equal(second.outcome, "busy");
  assert.equal(hasLiveWorkAdmissionBestEffortV1(task), true);

  // Cleanup — remove the marker directly since its owner-local handle has no
  // knowledge of the manual back-dating (release() still works via the exact
  // filename it tracks internally).
  await result.handle.release();
});

void test("host identity is populated on every claim, and is a stable per-install id (not the raw hostname)", async () => {
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
  // Unconfigured (this test's process never calls configureHostIdentityRootV1)
  // falls open to a process-local ephemeral id rather than the raw
  // `os.hostname()` — see hostIdentityV1.ts's module doc comment for why a
  // bare hostname is not a safe cross-process owner identity.
  assert.equal(typeof info.hostId, "string");
  assert.ok(info.hostId.length > 0);
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

// ── Completion-blocker coverage added 2026-09-08 review round ──────────────

void test("a real filesystem failure surfaces as writeFailed, distinct from an ordinary busy outcome", async () => {
  const task = freshTaskFolder("write-failure-distinct-from-busy");
  // Make the admission directory's OWN path a plain file, so
  // `fs.promises.mkdir(dir, { recursive: true })` fails with a real
  // filesystem error (ENOTDIR / EEXIST-as-file) rather than "someone else
  // already owns admission" — this must never be reported as `busy`.
  fs.writeFileSync(path.join(task, ADMISSION_DIRNAME_V1), "not a directory");

  const result = await acquireWorkAdmissionV1({
    taskFolderPath: task,
    purpose: "admission",
    commandId: "write-failure-command",
  });
  assert.equal(result.outcome, "writeFailed");
  if (result.outcome === "writeFailed") {
    assert.ok(result.error instanceof Error);
    assert.ok(result.error.message.length > 0, "the real underlying error must be preserved, not a byte count or generic message");
  }
});

void test("a displaced owner's heartbeat and release never mutate or remove a successor generation's marker", async () => {
  const task = freshTaskFolder("successor-generation-protected");
  const result = await acquireWorkAdmissionV1({
    taskFolderPath: task,
    purpose: "admission",
    commandId: "original-owner",
  });
  assert.equal(result.outcome, "acquired");
  if (result.outcome !== "acquired") return;

  const dir = path.join(task, ADMISSION_DIRNAME_V1);
  const originalMarkerPath = path.join(dir, fs.readdirSync(dir)[0]!);

  // Simulate a takeover (1c's future job, not anything v1a does on its own):
  // the original marker is removed and replaced by a DIFFERENT owner's
  // marker file — a "successor generation" this handle never tracked.
  fs.unlinkSync(originalMarkerPath);
  const successorPath = path.join(dir, "admission.successor-owner.g1.zzzz9999");
  const successorContent = JSON.stringify({ ownerToken: "successor-owner", commandId: "successor-command" });
  fs.writeFileSync(successorPath, successorContent);
  const successorStatBefore = fs.statSync(successorPath);

  // Both operations on the ORIGINAL (displaced) handle must be safe no-ops —
  // they address only the exact filename this handle tracked, which is gone
  // (ENOENT), and must never discover or touch the successor's file by
  // scanning the directory.
  await assert.doesNotReject(() => result.handle.heartbeat());
  await assert.doesNotReject(() => result.handle.release());

  const successorStatAfter = fs.statSync(successorPath);
  assert.equal(fs.readFileSync(successorPath, "utf8"), successorContent, "successor marker content must be untouched");
  assert.equal(successorStatAfter.mtimeMs, successorStatBefore.mtimeMs, "successor marker must not have been rewritten");
  assert.equal(fs.readdirSync(dir).length, 1, "exactly the successor marker must remain");
});

void test("heartbeat and release are serialized through the same owner-local queue, including handover", async () => {
  const task = freshTaskFolder("serialized-heartbeat-release-handover");
  const result = await acquireWorkAdmissionV1({
    taskFolderPath: task,
    purpose: "admission",
    commandId: "serialization-owner",
  });
  assert.equal(result.outcome, "acquired");
  if (result.outcome !== "acquired") return;

  const dir = path.join(task, ADMISSION_DIRNAME_V1);
  // Fire a heartbeat and an immediate release WITHOUT awaiting the first —
  // if they were not serialized through one queue, the release could race
  // the heartbeat's rename (unlinking the pre-rename path while the rename
  // is in flight, or vice versa) and either throw or leave two files behind.
  await assert.doesNotReject(() => Promise.all([result.handle.heartbeat(), result.handle.release()]));
  assert.equal(fs.readdirSync(dir).length, 0, "release must win cleanly after the queued heartbeat, leaving no marker behind");

  // handover() must be interchangeable with release() in the SAME queue: a
  // fresh handle, heartbeat-then-handover must leave the directory empty too.
  const second = await acquireWorkAdmissionV1({
    taskFolderPath: task,
    purpose: "admission",
    commandId: "serialization-owner-2",
  });
  assert.equal(second.outcome, "acquired");
  if (second.outcome !== "acquired") return;
  await assert.doesNotReject(() => Promise.all([second.handle.heartbeat(), second.handle.handover()]));
  assert.equal(fs.readdirSync(dir).length, 0);
});

void test("exclusive-create host-identity initialization converges under racing first runs", async () => {
  resetHostIdentityForTestV1();
  const root = fs.mkdtempSync(path.join(TEST_ROOT, "host-identity-race-"));
  configureHostIdentityRootV1(root);
  try {
    const ids = await Promise.all(Array.from({ length: 12 }, () => resolveHostIdentityV1()));
    const distinct = new Set(ids);
    assert.equal(distinct.size, 1, "every racing first-run caller must converge on exactly one id");

    const files = fs.readdirSync(root);
    assert.equal(files.length, 1, "exactly one durable host-identity record must be written, never one per racer");
    const record = JSON.parse(fs.readFileSync(path.join(root, files[0]!), "utf8")) as { hostId: string };
    assert.equal(record.hostId, ids[0]);

    // Resolving again (with a cold cache, simulating a second process reading
    // the same install's durable identity) must read back the SAME winner,
    // not mint a second one.
    resetHostIdentityForTestV1();
    configureHostIdentityRootV1(root);
    const again = await resolveHostIdentityV1();
    assert.equal(again, ids[0]);
    assert.equal(fs.readdirSync(root).length, 1);
  } finally {
    resetHostIdentityForTestV1();
  }
});

void test("resolveDurableHostIdentityV1 itself (no in-process cache) resolves a genuine exclusive-create filesystem race to one winner", async () => {
  const root = fs.mkdtempSync(path.join(TEST_ROOT, "host-identity-fs-race-"));
  // Calling the uncached primitive directly, concurrently, exercises the
  // real `{ flag: "wx" }` exclusive-create-then-read-fallback race at the
  // filesystem layer — the same style of proof the admission module's own
  // "racing geneses" test above uses for its claim file.
  const ids = await Promise.all(Array.from({ length: 8 }, () => resolveDurableHostIdentityV1(root)));
  const distinct = new Set(ids);
  assert.equal(distinct.size, 1, "every racer against the same root must converge on exactly one durable id");
  assert.equal(fs.readdirSync(root).length, 1, "exactly one durable host-identity record must survive the race");
});

// ── Completion-blocker coverage added 2026-09-08 review round, 2nd pass ────

void test("a leftover, incomplete temp file from a crashed writer is never adopted as the durable host identity", async () => {
  const root = fs.mkdtempSync(path.join(TEST_ROOT, "host-identity-torn-temp-"));
  // Simulate a process that crashed AFTER creating its private temp file but
  // BEFORE the write completed — the exact window the temp-file+link design
  // exists to keep off the shared final path. Because nothing ever links
  // this temp file to the final path, it must be completely inert: not read
  // as a record, not mistaken for the final file, and not an obstacle to a
  // fresh resolution converging normally.
  fs.writeFileSync(path.join(root, "host-identity-v1.json.tmp-deadbeef-crashed"), '{"hostId":"AB');

  const id = await resolveDurableHostIdentityV1(root);
  assert.equal(typeof id, "string");
  assert.ok(id.length > 0);
  assert.notEqual(id, "", "must never surface the torn content as (part of) an identity");

  const finalPath = path.join(root, "host-identity-v1.json");
  const record = JSON.parse(fs.readFileSync(finalPath, "utf8")) as { hostId: string };
  assert.equal(record.hostId, id, "the published final record must be the complete one just resolved, never the torn leftover");

  // Resolving again must read the same, now-published record back — the
  // leftover torn temp file (still present; nothing in this path claims to
  // garbage-collect it) never gets preferred over the real final file.
  const again = await resolveDurableHostIdentityV1(root);
  assert.equal(again, id);
});

void test("a leftover temp file that WAS fully written but never linked is never adopted as the durable host identity", async () => {
  const root = fs.mkdtempSync(path.join(TEST_ROOT, "host-identity-orphaned-temp-"));
  // A subtler crash window: the writer finished writing its COMPLETE temp
  // file but crashed before (or while) calling `link()`. Even though this
  // temp file's content is perfectly valid JSON, it must never be treated as
  // the durable identity — only content actually reachable at the exact
  // final filename counts. If this were adopted, two processes that each
  // independently reached this state (each writing their own complete-but-
  // unlinked temp file with a DIFFERENT hostId) would never converge.
  const orphanedId = "11111111-1111-1111-1111-111111111111";
  fs.writeFileSync(
    path.join(root, "host-identity-v1.json.tmp-orphan-1"),
    JSON.stringify({ hostId: orphanedId, hostname: "orphan-host", createdAt: new Date().toISOString() })
  );

  const id = await resolveDurableHostIdentityV1(root);
  assert.notEqual(id, orphanedId, "an unlinked temp file's content must never be adopted, however complete/valid it is");

  const finalPath = path.join(root, "host-identity-v1.json");
  assert.ok(fs.existsSync(finalPath), "resolution must publish its own record rather than silently adopting the orphan");
  const record = JSON.parse(fs.readFileSync(finalPath, "utf8")) as { hostId: string };
  assert.equal(record.hostId, id);
});

void test("a genuine claim-create failure (not EEXIST) surfaces as writeFailed and creates no orphan claim file", async () => {
  const task = freshTaskFolder("claim-create-genuine-failure");
  const injectedError = Object.assign(new Error("simulated EACCES on claim create"), { code: "EACCES" });
  setWorkAdmissionFsFailureInjectionForTestV1({
    onBeforeClaimWrite: () => injectedError,
  });
  try {
    const result = await acquireWorkAdmissionV1({
      taskFolderPath: task,
      purpose: "admission",
      commandId: "claim-create-failure-command",
    });
    assert.equal(result.outcome, "writeFailed");
    if (result.outcome === "writeFailed") {
      assert.match(result.error.message, /simulated EACCES on claim create/);
    }
    // The write never actually happened (it was intercepted before the real
    // fs call), so there is nothing to clean up and nothing left behind.
    const dir = path.join(task, ADMISSION_DIRNAME_V1);
    assert.equal(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0, 0);
  } finally {
    setWorkAdmissionFsFailureInjectionForTestV1(undefined);
  }
});

void test("a marker-rename failure cleans up the claim file it created, leaving the directory empty", async () => {
  const task = freshTaskFolder("rename-failure-cleans-up-claim");
  const injectedError = Object.assign(new Error("simulated EPERM on marker rename"), { code: "EPERM" });
  setWorkAdmissionFsFailureInjectionForTestV1({
    onBeforeMarkerRename: () => injectedError,
  });
  try {
    const result = await acquireWorkAdmissionV1({
      taskFolderPath: task,
      purpose: "admission",
      commandId: "rename-failure-command",
    });
    assert.equal(result.outcome, "writeFailed");
    if (result.outcome === "writeFailed") {
      assert.match(result.error.message, /simulated EPERM on marker rename/);
      assert.doesNotMatch(
        result.error.message,
        /could not be removed during cleanup/,
        "cleanup succeeded in this test, so the message must not falsely claim it also failed"
      );
    }
    const dir = path.join(task, ADMISSION_DIRNAME_V1);
    assert.equal(fs.readdirSync(dir).length, 0, "the claim file created before the failed rename must have been cleaned up");
    assert.equal(hasLiveWorkAdmissionBestEffortV1(task), false, "a cleaned-up failure must never leave the task looking admitted");
  } finally {
    setWorkAdmissionFsFailureInjectionForTestV1(undefined);
  }
});

void test("when cleanup ALSO fails after a rename failure, the claim is left behind but the error names both failures", async () => {
  const task = freshTaskFolder("rename-and-cleanup-both-fail");
  const renameError = Object.assign(new Error("simulated EPERM on marker rename"), { code: "EPERM" });
  const cleanupError = Object.assign(new Error("simulated EBUSY on claim unlink"), { code: "EBUSY" });
  setWorkAdmissionFsFailureInjectionForTestV1({
    onBeforeMarkerRename: () => renameError,
    onBeforeClaimCleanupUnlink: () => cleanupError,
  });
  try {
    const result = await acquireWorkAdmissionV1({
      taskFolderPath: task,
      purpose: "admission",
      commandId: "double-failure-command",
    });
    assert.equal(result.outcome, "writeFailed");
    if (result.outcome === "writeFailed") {
      // Completion blocker fix: the ORIGINAL failure and the fact that
      // cleanup could not remove the stranded claim must BOTH be named —
      // this is the diagnosed-instead-of-silent behavior the review asked for.
      assert.match(result.error.message, /simulated EPERM on marker rename/);
      assert.match(result.error.message, /could not be removed during cleanup/);
      assert.match(result.error.message, /simulated EBUSY on claim unlink/);
      assert.match(result.error.message, /removed manually/);
    }
    // The claim file genuinely could not be removed in this scenario — it is
    // still on disk, and the task correctly reads as admitted/busy (v1a's
    // interim policy: presence is live) rather than silently vanishing.
    const dir = path.join(task, ADMISSION_DIRNAME_V1);
    assert.equal(fs.readdirSync(dir).length, 1);
    assert.equal(hasLiveWorkAdmissionBestEffortV1(task), true);
  } finally {
    setWorkAdmissionFsFailureInjectionForTestV1(undefined);
    // Manual cleanup so this test doesn't leak a stranded claim file into
    // TEST_ROOT's teardown expectations (the injected failure is gone now).
    const dir = path.join(task, ADMISSION_DIRNAME_V1);
    for (const entry of fs.readdirSync(dir)) {
      fs.unlinkSync(path.join(dir, entry));
    }
  }
});

// ── Review-round coverage added 2026-09-08 (blockers `…-0`/`…-1`/`…-2`, and
// the non-blocking heartbeat-queue suggestion) ─────────────────────────────

void test("a non-EEXIST link failure still converges on a record someone else published moments before, instead of minting an independent ephemeral id", async () => {
  const root = fs.mkdtempSync(path.join(TEST_ROOT, "host-identity-link-failure-converge-"));
  const publishedId = "22222222-2222-2222-2222-222222222222";
  const finalPath = path.join(root, "host-identity-v1.json");
  setHostIdentityFsFailureInjectionForTestV1({
    onBeforeLink: () => {
      // Simulate a concurrent racer publishing the durable record at the
      // exact moment this caller's own link() attempt runs, then report a
      // REAL (non-EEXIST) failure for THIS caller's own attempt — e.g. a
      // transient handle/locking issue, not ordinary contention.
      fs.writeFileSync(
        finalPath,
        JSON.stringify({ hostId: publishedId, hostname: "other-host", createdAt: new Date().toISOString() })
      );
      return Object.assign(new Error("simulated EPERM on link"), { code: "EPERM" });
    },
  });
  try {
    const id = await resolveDurableHostIdentityV1(root);
    assert.equal(
      id,
      publishedId,
      "must read back and converge on the record that actually got published, not mint its own ephemeral id"
    );
    assert.ok(!id.startsWith("ephemeral-"), "a readable durable record must never be abandoned for an ephemeral fallback");
  } finally {
    setHostIdentityFsFailureInjectionForTestV1(undefined);
  }
});

void test("persistent link failures still converge on the same machine+rootDir-derived id across independent calls, instead of each minting its own random ephemeral id", async () => {
  const root = fs.mkdtempSync(path.join(TEST_ROOT, "host-identity-persistent-failure-"));
  setHostIdentityFsFailureInjectionForTestV1({
    // Unlike the transient-glitch test above, no one ever actually publishes
    // a durable record here — this simulates storage that is genuinely
    // unwritable for the whole outage, not a momentary hiccup.
    onBeforeLink: () => Object.assign(new Error("simulated persistent EPERM on link"), { code: "EPERM" }),
  });
  try {
    const first = await resolveDurableHostIdentityV1(root, "machine-guid-a");
    const second = await resolveDurableHostIdentityV1(root, "machine-guid-a");
    assert.equal(
      first,
      second,
      "two independent calls for the same install (same rootDir AND machineId) must converge on the same fallback id even though nothing was ever durably published — this is what two extension host processes hitting the same outage need to agree on"
    );
    assert.ok(
      first.startsWith("derived-"),
      "a persistent-failure fallback must be recognizable as deterministically derived, not the random `ephemeral-` id used when no root is configured at all"
    );

    const otherRoot = fs.mkdtempSync(path.join(TEST_ROOT, "host-identity-persistent-failure-other-install-"));
    const otherInstallResult = await resolveDurableHostIdentityV1(otherRoot, "machine-guid-a");
    assert.notEqual(first, otherInstallResult, "different installs (different rootDir) must not derive the same fallback id");
  } finally {
    setHostIdentityFsFailureInjectionForTestV1(undefined);
  }
});

void test("persistent-failure fallback distinguishes two machines that happen to share an identical rootDir string", async () => {
  // 2026-09-08 review, third pass: a path string is not an installation
  // identity — containers built from the same image, or two machines with
  // otherwise-identical profile layouts, can report the exact same
  // `context.globalStorageUri.fsPath`. This reproduces exactly that: same
  // rootDir, different `vscode.env.machineId`, and asserts the derived
  // fallback must NOT collide, which a rootDir-only hash would have done.
  const sharedRoot = fs.mkdtempSync(path.join(TEST_ROOT, "host-identity-shared-path-"));
  setHostIdentityFsFailureInjectionForTestV1({
    onBeforeLink: () => Object.assign(new Error("simulated persistent EPERM on link"), { code: "EPERM" }),
  });
  try {
    const machineA = await resolveDurableHostIdentityV1(sharedRoot, "machine-guid-a");
    const machineB = await resolveDurableHostIdentityV1(sharedRoot, "machine-guid-b");
    assert.notEqual(
      machineA,
      machineB,
      "two machines sharing an identical rootDir string but distinct vscode.env.machineId values must never derive the same fallback id — otherwise Part 1c's same-host liveness probing could treat two unrelated machines as one"
    );

    // Without any machineId at all (this module's own out-of-extension-host
    // unit tests, or a genuinely absent `vscode.env.machineId`), the fallback
    // must still be deterministic across repeated calls for the SAME
    // (rootDir, undefined machineId) pair rather than throwing or reverting
    // to a random ephemeral id.
    const noMachineIdFirst = await resolveDurableHostIdentityV1(sharedRoot, undefined);
    const noMachineIdSecond = await resolveDurableHostIdentityV1(sharedRoot, undefined);
    assert.equal(noMachineIdFirst, noMachineIdSecond, "omitting machineId must still converge deterministically, not randomly");
    assert.notEqual(noMachineIdFirst, machineA, "a call with no machineId must not accidentally collide with one that has a real machineId");
  } finally {
    setHostIdentityFsFailureInjectionForTestV1(undefined);
  }
});

void test("a live marker plus a cleanup failure on the losing claim escalates to writeFailed, naming both the real owner and the stranded claim", async () => {
  const task = freshTaskFolder("existing-marker-cleanup-failure");
  const first = await acquireWorkAdmissionV1({
    taskFolderPath: task,
    purpose: "admission",
    commandId: "owner-a",
  });
  assert.equal(first.outcome, "acquired");
  if (first.outcome !== "acquired") return;

  const cleanupError = Object.assign(new Error("simulated EBUSY on claim unlink"), { code: "EBUSY" });
  setWorkAdmissionFsFailureInjectionForTestV1({
    onBeforeClaimCleanupUnlink: () => cleanupError,
  });
  try {
    const second = await acquireWorkAdmissionV1({
      taskFolderPath: task,
      purpose: "admission",
      commandId: "owner-b",
    });
    // Completion blocker fix, narrowed (2026-09-08 review): a cleanup
    // failure on the LOSING caller's own claim must never be reported as a
    // plain "busy" — that would hide that owner-b's OWN admission.claim file
    // is now stranded on disk too, on top of owner-a's real live marker.
    assert.equal(second.outcome, "writeFailed");
    if (second.outcome === "writeFailed") {
      assert.match(second.error.message, /owner-a/, "the real owner's identity must still be named");
      assert.match(second.error.message, /could not be removed during cleanup/);
      assert.match(second.error.message, /simulated EBUSY on claim unlink/);
    }
    // owner-a's live marker itself is untouched by owner-b's failed cleanup.
    assert.equal(hasLiveWorkAdmissionBestEffortV1(task), true);
  } finally {
    setWorkAdmissionFsFailureInjectionForTestV1(undefined);
    // Manual cleanup of owner-b's stranded claim.claim so this test doesn't
    // leak it into TEST_ROOT's teardown expectations (the injected failure
    // is gone now).
    const dir = path.join(task, ADMISSION_DIRNAME_V1);
    for (const entry of fs.readdirSync(dir)) {
      if (entry === "admission.claim") {
        fs.unlinkSync(path.join(dir, entry));
      }
    }
    await first.handle.release();
  }
});

void test("a failed heartbeat does not poison the owner-local queue: release() afterward still removes the marker", async () => {
  const task = freshTaskFolder("heartbeat-failure-does-not-poison-release");
  const result = await acquireWorkAdmissionV1({
    taskFolderPath: task,
    purpose: "admission",
    commandId: "heartbeat-poison-test",
  });
  assert.equal(result.outcome, "acquired");
  if (result.outcome !== "acquired") return;

  const injectedError = Object.assign(new Error("simulated EBUSY on heartbeat rename"), { code: "EBUSY" });
  setWorkAdmissionFsFailureInjectionForTestV1({
    onBeforeHeartbeatRename: () => injectedError,
  });
  try {
    await assert.rejects(() => result.handle.heartbeat(), /simulated EBUSY on heartbeat rename/);
  } finally {
    setWorkAdmissionFsFailureInjectionForTestV1(undefined);
  }

  // Non-blocking review suggestion (2026-09-08): before the fix, a rejected
  // heartbeat step became the new `queue`, and every LATER queued step
  // (release/handover) chained onto it via a bare `.then()` with no
  // rejection handler — passing the same rejection through forever without
  // ever actually running. release() must still unlink the marker.
  await result.handle.release();
  assert.equal(
    hasLiveWorkAdmissionBestEffortV1(task),
    false,
    "release() after a failed heartbeat must still remove the marker, not silently no-op"
  );
  const dir = path.join(task, ADMISSION_DIRNAME_V1);
  assert.equal(fs.readdirSync(dir).length, 0);
});

// ── Architectural-blocker coverage added 2026-09-09 review round: "starting
// admission can still lose to pauseCommit" ──────────────────────────────────

void test("pending pre-genesis intent makes hasLiveWorkAdmissionBestEffortV1 true before any durable write lands", async () => {
  const task = freshTaskFolder("pending-intent-closes-pre-genesis-gap");
  assert.equal(hasLiveWorkAdmissionBestEffortV1(task), false);

  // acquireWorkAdmissionV1 runs synchronously up to its first `await`
  // (resolveHostIdentityV1()) before returning a pending promise — the
  // pending-intent registration happens in that synchronous prefix, so it
  // must already be visible the instant this call returns, well before any
  // durable claim/marker file exists on disk.
  const promise = acquireWorkAdmissionV1({
    taskFolderPath: task,
    purpose: "admission",
    commandId: "pending-intent-caller",
  });
  assert.equal(
    hasLiveWorkAdmissionBestEffortV1(task),
    true,
    "a same-process caller mid-genesis must already read as live, closing the pre-write race"
  );
  assert.equal(fs.existsSync(path.join(task, ADMISSION_DIRNAME_V1)), false, "nothing durable has been written yet");

  const result = await promise;
  assert.equal(result.outcome, "acquired");
  assert.equal(hasLiveWorkAdmissionBestEffortV1(task), true, "now backed by the durable marker instead");
  if (result.outcome === "acquired") {
    await result.handle.release();
  }
  assert.equal(hasLiveWorkAdmissionBestEffortV1(task), false);
});

void test("pending intent is cleared even when genesis settles busy or writeFailed", async () => {
  const task = freshTaskFolder("pending-intent-cleared-on-every-exit");
  const holder = await acquireWorkAdmissionV1({
    taskFolderPath: task,
    purpose: "admission",
    commandId: "holder",
  });
  assert.equal(holder.outcome, "acquired");
  if (holder.outcome !== "acquired") return;

  // A second caller for the same purpose is refused busy against the live
  // marker — its own pending-intent entry must still be cleared afterward,
  // not leaked forever (which would wrongly make every later check see
  // permanently "live" admission for this task).
  const refused = await acquireWorkAdmissionV1({
    taskFolderPath: task,
    purpose: "admission",
    commandId: "refused-caller",
  });
  assert.equal(refused.outcome, "busy");

  await holder.handle.release();
  assert.equal(
    hasLiveWorkAdmissionBestEffortV1(task),
    false,
    "the refused caller's pending intent must not outlive its own settled call"
  );
});

void test("a live pauseCommit marker does not block a new admission-purpose acquisition, and both markers coexist", async () => {
  const task = freshTaskFolder("pause-commit-marker-does-not-block-admission");
  const sweepClaim = await acquireWorkAdmissionV1({
    taskFolderPath: task,
    purpose: "pauseCommit",
    commandId: "watchdog-sweep",
  });
  assert.equal(sweepClaim.outcome, "acquired");
  if (sweepClaim.outcome !== "acquired") return;

  // Contract (v1 fixes item 1): "the loser should be the pause, not the
  // round" — a command starting real work must not be turned away just
  // because the sweep is mid-commit.
  const commandAdmission = await acquireWorkAdmissionV1({
    taskFolderPath: task,
    purpose: "admission",
    commandId: "runReviewWithAI",
  });
  assert.equal(commandAdmission.outcome, "acquired");
  if (commandAdmission.outcome !== "acquired") return;

  // Both markers now coexist on disk under distinct owner tokens.
  const dir = path.join(task, ADMISSION_DIRNAME_V1);
  const markers = fs.readdirSync(dir).filter((name) => name !== "admission.claim");
  assert.equal(markers.length, 2);

  // The sweep's own exclusion check must still see the command's marker as
  // unrelated live work, so its pre-write/post-write reconciliation can
  // catch and reverse an in-flight pause.
  assert.equal(hasLiveWorkAdmissionExcludingOwnerV1(task, sweepClaim.handle.ownerToken), true);

  await commandAdmission.handle.release();
  await sweepClaim.handle.release();
  assert.equal(hasLiveWorkAdmissionBestEffortV1(task), false);
});

void test("a live admission-purpose marker still blocks a new pauseCommit acquisition (the sweep backs off)", async () => {
  const task = freshTaskFolder("admission-marker-still-blocks-pause-commit");
  const commandAdmission = await acquireWorkAdmissionV1({
    taskFolderPath: task,
    purpose: "admission",
    commandId: "runReviewWithAI",
  });
  assert.equal(commandAdmission.outcome, "acquired");
  if (commandAdmission.outcome !== "acquired") return;

  const sweepClaim = await acquireWorkAdmissionV1({
    taskFolderPath: task,
    purpose: "pauseCommit",
    commandId: "watchdog-sweep",
  });
  assert.equal(sweepClaim.outcome, "busy");

  await commandAdmission.handle.release();
});

void test("a live pauseCommit marker still blocks a second pauseCommit acquisition (no double sweep commit)", async () => {
  const task = freshTaskFolder("pause-commit-marker-blocks-another-pause-commit");
  const first = await acquireWorkAdmissionV1({
    taskFolderPath: task,
    purpose: "pauseCommit",
    commandId: "watchdog-sweep-a",
  });
  assert.equal(first.outcome, "acquired");
  if (first.outcome !== "acquired") return;

  const second = await acquireWorkAdmissionV1({
    taskFolderPath: task,
    purpose: "pauseCommit",
    commandId: "watchdog-sweep-b",
  });
  assert.equal(second.outcome, "busy");

  await first.handle.release();
});

void test("hasLiveWorkAdmissionExcludingOwnerV1 sees another caller's pending intent but not its own", async () => {
  const task = freshTaskFolder("exclude-owner-sees-others-pending-intent");
  const sweepClaim = await acquireWorkAdmissionV1({
    taskFolderPath: task,
    purpose: "pauseCommit",
    commandId: "watchdog-sweep",
  });
  assert.equal(sweepClaim.outcome, "acquired");
  if (sweepClaim.outcome !== "acquired") return;

  // The sweep excluding its own token sees no unrelated live admission yet.
  assert.equal(hasLiveWorkAdmissionExcludingOwnerV1(task, sweepClaim.handle.ownerToken), false);

  // A command starts its own genesis concurrently; its pending intent must be
  // visible to the sweep's exclusion check before any durable marker exists.
  const commandPromise = acquireWorkAdmissionV1({
    taskFolderPath: task,
    purpose: "admission",
    commandId: "runReviewWithAI",
  });
  assert.equal(hasLiveWorkAdmissionExcludingOwnerV1(task, sweepClaim.handle.ownerToken), true);

  const commandAdmission = await commandPromise;
  assert.equal(commandAdmission.outcome, "acquired");
  if (commandAdmission.outcome === "acquired") {
    await commandAdmission.handle.release();
  }
  await sweepClaim.handle.release();
});

// ── Narrowed remainder of the same blocker (2026-09-09 review round): the
// SHARED `admission.claim` file itself, held briefly during a `pauseCommit`
// genesis BEFORE it becomes a marker, was still purpose-blind — an
// `admission`-purpose acquirer that lost the exclusive-create race against it
// was refused `busy` immediately, with no retry, reproducing "the pause wins"
// at the claim stage even though the marker-stage fix above already prevents
// it once a marker exists. ─────────────────────────────────────────────────

function writeFakePauseCommitClaimV1(task: string, ownerToken: string): string {
  const dir = path.join(task, ADMISSION_DIRNAME_V1);
  fs.mkdirSync(dir, { recursive: true });
  const claimPath = path.join(dir, "admission.claim");
  fs.writeFileSync(
    claimPath,
    JSON.stringify({
      claimId: `${ownerToken}-claim`,
      purpose: "pauseCommit",
      ownerToken,
      pid: 999999,
      processStartTime: 0,
      hostId: "fake-host",
      commandId: "watchdog-sweep",
      startedAt: new Date().toISOString(),
    }),
    { flag: "wx" }
  );
  return claimPath;
}

void test("an admission-purpose acquisition retries past a pauseCommit claim that is still mid-genesis, then proceeds once it resolves to a marker", async () => {
  const task = freshTaskFolder("admission-retries-past-in-flight-pause-commit-claim");
  const claimPath = writeFakePauseCommitClaimV1(task, "fake-sweep-owner");

  const admissionPromise = acquireWorkAdmissionV1({
    taskFolderPath: task,
    purpose: "admission",
    commandId: "runReviewWithAI",
  });

  // Give the retry loop a couple of ticks to observe the still-live claim —
  // it must not have given up yet.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fs.existsSync(claimPath), true, "the fake pauseCommit claim should still be in place at this point");

  // Simulate the sweep's own genesis completing its rename-to-marker step
  // (`acquireWorkAdmissionCoreV1`'s real behavior once no blocking marker is
  // found) — this frees the shared claim filename.
  const dir = path.join(task, ADMISSION_DIRNAME_V1);
  const markerPath = path.join(dir, "admission.fake-sweep-owner.g1.deadbeef");
  fs.renameSync(claimPath, markerPath);

  const result = await admissionPromise;
  assert.equal(
    result.outcome,
    "acquired",
    "a work-starting admission attempt must retry past a resolving pauseCommit claim rather than losing immediately"
  );
  if (result.outcome === "acquired") {
    await result.handle.release();
  }
  fs.rmSync(markerPath, { force: true });
});

// 2026-09-09 review architectural blocker (fourth round): the previous fix
// bounded the claim-contention retry loop by a fixed ~1 second delay
// schedule — an arbitrary timeout, not the plan's "the pause loses
// regardless of ordinary filesystem timing" invariant, since ordinary
// (non-crashed) contention can plausibly outlast a second under real
// disk/AV-scan conditions. The loop now waits out an ambiguous claim for as
// long as it would not yet be judged STALE (`WORK_ADMISSION_LIKELY_STALE_MS_V1`
// — the same threshold `describeClaimAsBlockerV1` already uses), rather than
// a short, unrelated wall-clock guess. `setWorkAdmissionClockForTestV1` lets
// the tests below exercise the "genuinely stale" branch deterministically,
// without an actual ~20-minute wait.
function fakeClockJumpingPastStalenessV1(): () => number {
  const base = Date.now();
  let calls = 0;
  return () => {
    calls += 1;
    // The very first call establishes the retry loop's own start time; every
    // call after that reports a time already past the staleness threshold,
    // so the loop gives up on its first freshness check instead of polling.
    return calls === 1 ? base : base + WORK_ADMISSION_LIKELY_STALE_MS_V1 + 1000;
  };
}

void test(
  "an admission-purpose acquisition waits out a pauseCommit claim held far longer than the previous fixed ~1 " +
    "second retry budget, then proceeds once it resolves to a marker",
  async () => {
    const task = freshTaskFolder("admission-waits-past-old-fixed-retry-budget");
    const claimPath = writeFakePauseCommitClaimV1(task, "slow-sweep-owner");

    const admissionPromise = acquireWorkAdmissionV1({
      taskFolderPath: task,
      purpose: "admission",
      commandId: "runReviewWithAI",
    });

    // The module's previous fix bounded this wait to a fixed ~980ms retry
    // schedule; hold the claim well past that (1.2s of REAL time, no fake
    // clock here) to prove the current elapsed-time-against-staleness bound
    // rides out ordinary, non-crashed contention regardless of how long it
    // actually takes, rather than giving up on an arbitrary short timer.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(fs.existsSync(claimPath), true, "the fake pauseCommit claim should still be in place at this point");

    const dir = path.join(task, ADMISSION_DIRNAME_V1);
    const markerPath = path.join(dir, "admission.slow-sweep-owner.g1.deadbeef");
    fs.renameSync(claimPath, markerPath);

    const result = await admissionPromise;
    assert.equal(
      result.outcome,
      "acquired",
      "an admission attempt must keep waiting out an ordinary (non-stale) claim past the old ~1s budget, not give up"
    );
    if (result.outcome === "acquired") {
      await result.handle.release();
    }
    fs.rmSync(markerPath, { force: true });
  }
);

void test("an admission-purpose acquisition against a permanently stuck pauseCommit claim eventually reports busy rather than retrying forever", async () => {
  const task = freshTaskFolder("admission-busy-against-stuck-pause-commit-claim");
  writeFakePauseCommitClaimV1(task, "stuck-sweep-owner");

  setWorkAdmissionClockForTestV1(fakeClockJumpingPastStalenessV1());
  try {
    const result = await acquireWorkAdmissionV1({
      taskFolderPath: task,
      purpose: "admission",
      commandId: "runReviewWithAI",
    });
    assert.equal(
      result.outcome,
      "busy",
      "a claim that never resolves must still be bounded (by staleness, not a short arbitrary timer) and surface " +
        "the interim busy diagnostic"
    );
  } finally {
    setWorkAdmissionClockForTestV1(undefined);
  }
});

void test("a pauseCommit-purpose acquisition does not retry past another pauseCommit claim (immediate busy)", async () => {
  const task = freshTaskFolder("pause-commit-does-not-retry-past-another-pause-commit-claim");
  writeFakePauseCommitClaimV1(task, "other-sweep-owner");

  const started = Date.now();
  const result = await acquireWorkAdmissionV1({
    taskFolderPath: task,
    purpose: "pauseCommit",
    commandId: "watchdog-sweep",
  });
  const elapsedMs = Date.now() - started;
  assert.equal(result.outcome, "busy");
  assert.ok(elapsedMs < 500, `a pauseCommit-vs-pauseCommit claim conflict must not retry (took ${elapsedMs}ms)`);
});

// ── Further narrowed remainder (2026-09-09 review, second round): the retry
// decision above reads the current claim's `purpose` via `readClaimInfoSyncV1`,
// which returns `undefined` both when the claim has vanished AND when it is
// present but its JSON is mid-write/corrupt — a real, if narrow, window every
// exclusive-create writer passes through. Feeding that `undefined` straight
// into `markerBlocksAcquisitionV1` treated "unreadable" the same as
// "positively confirmed to conflict", so a claim caught mid-initialization
// was refused immediately, with no retry at all — even though the write
// finishing (as it does within milliseconds in practice) would very likely
// have revealed a harmless, non-blocking `pauseCommit` purpose. ────────────

function writeCorruptClaimV1(task: string): string {
  const dir = path.join(task, ADMISSION_DIRNAME_V1);
  fs.mkdirSync(dir, { recursive: true });
  const claimPath = path.join(dir, "admission.claim");
  // Simulates a claim caught mid-write: present on disk, but not yet valid
  // JSON — exactly the window a reader can observe between a writer's file
  // create and its buffer actually landing.
  fs.writeFileSync(claimPath, '{"ownerToken":"partial', { flag: "wx" });
  return claimPath;
}

void test("an admission-purpose acquisition retries past a claim that is transiently unreadable (mid-write/corrupt), then proceeds once it resolves to a marker", async () => {
  const task = freshTaskFolder("admission-retries-past-unreadable-claim");
  const claimPath = writeCorruptClaimV1(task);

  const admissionPromise = acquireWorkAdmissionV1({
    taskFolderPath: task,
    purpose: "admission",
    commandId: "runReviewWithAI",
  });

  // Give the retry loop a couple of ticks to observe the still-unreadable
  // claim — it must not have given up yet.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fs.existsSync(claimPath), true, "the corrupt claim should still be in place at this point");

  // The real writer finishes its genesis: the claim resolves into a live,
  // readable, non-blocking `pauseCommit` marker.
  const dir = path.join(task, ADMISSION_DIRNAME_V1);
  const markerPath = path.join(dir, "admission.fake-sweep-owner.g1.deadbeef");
  fs.writeFileSync(
    markerPath,
    JSON.stringify({
      claimId: "fake-sweep-owner-claim",
      purpose: "pauseCommit",
      ownerToken: "fake-sweep-owner",
      pid: 999999,
      processStartTime: 0,
      hostId: "fake-host",
      commandId: "watchdog-sweep",
      startedAt: new Date().toISOString(),
    })
  );
  fs.unlinkSync(claimPath);

  const result = await admissionPromise;
  assert.equal(
    result.outcome,
    "acquired",
    "a transiently unreadable (mid-write) claim must be retried, not treated as an immediate, unresolvable blocker"
  );
  if (result.outcome === "acquired") {
    await result.handle.release();
  }
  fs.rmSync(markerPath, { force: true });
});

void test("an admission-purpose acquisition against a permanently corrupt claim eventually reports busy (not writeFailed) rather than assuming it is free", async () => {
  const task = freshTaskFolder("admission-busy-against-permanently-corrupt-claim");
  const claimPath = writeCorruptClaimV1(task);

  setWorkAdmissionClockForTestV1(fakeClockJumpingPastStalenessV1());
  try {
    const result = await acquireWorkAdmissionV1({
      taskFolderPath: task,
      purpose: "admission",
      commandId: "runReviewWithAI",
    });
    assert.equal(
      result.outcome,
      "busy",
      "a claim still physically present once it is judged stale must be reported busy, even though its content " +
        "was never readable"
    );
  } finally {
    setWorkAdmissionClockForTestV1(undefined);
  }
  fs.rmSync(claimPath, { force: true });
});

// ── Further narrowed remainder (2026-09-09 review, third round): even after
// the fixes above, the retry loop's own EXHAUSTION diagnostic
// (`describeClaimRetryExhaustedBlockerV1`) could itself be raced — if the
// contended claim resolved into a non-blocking marker in the narrow,
// synchronous window between the loop's last failed exclusive-create and
// that diagnostic call, the diagnostic correctly found nothing blocking
// (`undefined`), but the loop then treated that as a terminal `writeFailed`
// instead of simply retrying the now-unobstructed write — reproducing "the
// pause wins" one boundary later than the first two rounds' fixes cover. This
// window has no `await` in it, so no real timer can ever land inside it; the
// module exposes `onBeforeClaimRetryExhaustionDiagnosis` (a side-effect-only
// test seam, not a failure injection) specifically to reproduce it
// deterministically. ─────────────────────────────────────────────────────

void test(
  "an admission-purpose acquisition retries the write when its own exhaustion diagnostic is raced by the claim " +
    "resolving into a non-blocking marker, instead of surfacing a terminal writeFailed",
  async () => {
    const task = freshTaskFolder("admission-retries-past-exhaustion-diagnosis-race");
    const claimPath = writeFakePauseCommitClaimV1(task, "fake-sweep-owner-raced");
    const dir = path.join(task, ADMISSION_DIRNAME_V1);
    const markerPath = path.join(dir, "admission.fake-sweep-owner-raced.g1.deadbeef");

    let fired = false;
    setWorkAdmissionFsFailureInjectionForTestV1({
      onBeforeClaimRetryExhaustionDiagnosis: () => {
        // Simulate the sweep's own genesis completing its rename-to-marker
        // step at exactly the instant the retry loop is about to diagnose
        // the (by-then already-vanished) claim as its terminal blocker.
        if (!fired && fs.existsSync(claimPath)) {
          fired = true;
          fs.renameSync(claimPath, markerPath);
        }
      },
    });
    // Without this, reaching the exhaustion diagnostic at all requires
    // waiting out the real WORK_ADMISSION_LIKELY_STALE_MS_V1 window (20
    // real minutes) before the injected hook ever fires — the same fake
    // clock the other two tests in this file use to reach their "stale"
    // branches deterministically and quickly.
    setWorkAdmissionClockForTestV1(fakeClockJumpingPastStalenessV1());
    try {
      const result = await acquireWorkAdmissionV1({
        taskFolderPath: task,
        purpose: "admission",
        commandId: "runReviewWithAI",
      });
      assert.equal(fired, true, "the injected race must actually have fired for this test to be meaningful");
      assert.equal(
        result.outcome,
        "acquired",
        "the exhaustion diagnostic finding nothing blocking must retry the write, not surface a terminal writeFailed"
      );
      if (result.outcome === "acquired") {
        await result.handle.release();
      }
    } finally {
      setWorkAdmissionFsFailureInjectionForTestV1(undefined);
      setWorkAdmissionClockForTestV1(undefined);
      fs.rmSync(markerPath, { force: true });
    }
  }
);

/**
 * 2026-09-10 review completion blocker (narrowed further): per-task admission
 * cannot protect a target whose identity is not yet known — the coarse,
 * same-process "resolution in flight" gate that stands the watchdog's whole
 * pause pass down for that window (see `beginTargetResolutionV1`'s doc
 * comment).
 */
void test("hasResolutionInFlightBestEffortV1 reflects begin/end pairing, including nested calls", () => {
  resetTargetResolutionForTestV1();
  try {
    assert.equal(hasResolutionInFlightBestEffortV1(), false);

    beginTargetResolutionV1();
    assert.equal(hasResolutionInFlightBestEffortV1(), true);

    // A second, concurrent resolution (a different command in the same
    // window) must keep the gate up until BOTH have ended — nesting must not
    // let the inner end() clear a still-outstanding outer resolution.
    beginTargetResolutionV1();
    assert.equal(hasResolutionInFlightBestEffortV1(), true);

    endTargetResolutionV1();
    assert.equal(hasResolutionInFlightBestEffortV1(), true, "one of two concurrent resolutions ending must not clear the gate");

    endTargetResolutionV1();
    assert.equal(hasResolutionInFlightBestEffortV1(), false);
  } finally {
    resetTargetResolutionForTestV1();
  }
});

void test("endTargetResolutionV1 clamps at zero — an extra end() (e.g. a caller with no matching begin()) never makes the counter negative or 'more ended than begun'", () => {
  resetTargetResolutionForTestV1();
  try {
    endTargetResolutionV1();
    endTargetResolutionV1();
    assert.equal(hasResolutionInFlightBestEffortV1(), false);

    beginTargetResolutionV1();
    assert.equal(hasResolutionInFlightBestEffortV1(), true);
    endTargetResolutionV1();
    endTargetResolutionV1();
    assert.equal(hasResolutionInFlightBestEffortV1(), false);
  } finally {
    resetTargetResolutionForTestV1();
  }
});
