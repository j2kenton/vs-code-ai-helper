import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import {
  acquireWorkAdmissionV1,
  describeWorkAdmissionBlockerV1,
  hasLiveWorkAdmissionBestEffortV1,
  setWorkAdmissionFsFailureInjectionForTestV1,
  ADMISSION_DIRNAME_V1,
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
