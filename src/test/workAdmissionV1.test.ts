import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import {
  acquireEarlyWorkAdmissionForCandidatePathV1,
  acquireOrAdoptWorkAdmissionV1,
  acquireWorkAdmissionV1,
  advancePauseFenceForRevocationV1,
  advancePauseFenceGenerationV1,
  authorizeWorkAdmissionHandoffV1,
  beginTargetResolutionV1,
  describeWorkAdmissionBlockerV1,
  endTargetResolutionV1,
  finishPauseRevocationBarrierV1,
  removePauseRevocationBarrierV1,
  hasDurableResolutionInFlightV1,
  hasLiveWorkAdmissionBestEffortV1,
  hasLiveWorkAdmissionExcludingOwnerV1,
  hasResolutionInFlightBestEffortV1,
  isPathOutsideAllTaskRootsV1,
  isWatchdogPauseFenceCurrentV1,
  listPendingPauseRevocationBarriersV1,
  readOrInitPauseFenceGenerationV1,
  resetTargetResolutionForTestV1,
  revokeStalePauseCommitClaimV1,
  revokeWorkAdmissionHandoffV1,
  setWorkAdmissionClockForTestV1,
  setWorkAdmissionFsFailureInjectionForTestV1,
  ADMISSION_DIRNAME_V1,
  PAUSE_COMMIT_LIKELY_STALE_MS_V1,
  PAUSE_REVOCATION_FINISH_LOCK_STALE_MS_V1,
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

// ── isPathOutsideAllTaskRootsV1 / early-admission containment diagnostic ────
// (2026-09-11 review architectural blocker `d620c877...-1`, narrowed)

void test("isPathOutsideAllTaskRootsV1 fails open (false) when no root candidates are known", () => {
  const task = freshTaskFolder("containment-no-roots-known");
  assert.equal(isPathOutsideAllTaskRootsV1(task, []), false);
});

void test("isPathOutsideAllTaskRootsV1 is false for a path nested under a known root, and for the root itself", () => {
  const root = freshTaskFolder("containment-root");
  const nested = path.join(root, "2026-09-11_task_1");
  assert.equal(isPathOutsideAllTaskRootsV1(nested, [root]), false);
  assert.equal(isPathOutsideAllTaskRootsV1(root, [root]), false);
});

void test("isPathOutsideAllTaskRootsV1 is true for a path that is a sibling of, not nested under, every known root", () => {
  const root = freshTaskFolder("containment-root-2");
  const sibling = freshTaskFolder("containment-sibling-2");
  assert.equal(isPathOutsideAllTaskRootsV1(sibling, [root]), true);
});

void test("isPathOutsideAllTaskRootsV1 does not false-positive on a root name that is merely a string prefix of the candidate (e.g. '.ensemble' vs '.ensemble-extra')", () => {
  const root = path.join(TEST_ROOT, "containment-prefix", ".ensemble");
  const lookalike = path.join(TEST_ROOT, "containment-prefix", ".ensemble-extra", "task_1");
  assert.equal(isPathOutsideAllTaskRootsV1(lookalike, [root]), true);
});

void test("acquireEarlyWorkAdmissionForCandidatePathV1 skips early admission for a candidate positively known to be outside every task root, logging a diagnostic (2026-09-11 review architectural blocker d620c877...-1, fixed)", async () => {
  const root = freshTaskFolder("early-admission-containment-root");
  const outOfRootTask = freshTaskFolder("early-admission-containment-outside");
  fs.writeFileSync(path.join(outOfRootTask, "task.md"), "# Test task\n");
  const realWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]): void => {
    warnings.push(args);
  };
  try {
    const result = await acquireEarlyWorkAdmissionForCandidatePathV1({
      candidatePath: outOfRootTask,
      purpose: "admission",
      commandId: "test-command",
      taskRootCandidatePaths: [root],
    });
    assert.equal(
      result,
      undefined,
      "early admission must be skipped (never create admission-v1/ bookkeeping) for a candidate known to be outside every current task root"
    );
    assert.ok(
      warnings.some((args) => String(args[0]).includes("outside every currently known task root")),
      "the containment gap must be logged for investigation"
    );
    assert.equal(
      fs.existsSync(path.join(outOfRootTask, ADMISSION_DIRNAME_V1)),
      false,
      "no admission bookkeeping must be created beneath the out-of-root candidate"
    );
  } finally {
    console.warn = realWarn;
  }
});

void test("acquireEarlyWorkAdmissionForCandidatePathV1 still acquires admission for an out-of-root candidate when containment is not knowable (no taskRootCandidatePaths) — fail-open is preserved", async () => {
  const outOfRootTask = freshTaskFolder("early-admission-containment-unknowable");
  fs.writeFileSync(path.join(outOfRootTask, "task.md"), "# Test task\n");
  const result = await acquireEarlyWorkAdmissionForCandidatePathV1({
    candidatePath: outOfRootTask,
    purpose: "admission",
    commandId: "test-command",
  });
  assert.equal(
    result?.outcome,
    "acquired",
    "admission must still be granted when containment cannot be evaluated — never skipped just because no root list was passed"
  );
  if (result?.outcome === "acquired") {
    await result.handle.release();
  }
});

void test("acquireEarlyWorkAdmissionForCandidatePathV1 logs no containment diagnostic for an in-root candidate", async () => {
  const root = freshTaskFolder("early-admission-containment-root-2");
  const inRootTask = path.join(root, "2026-09-11_task_2");
  fs.mkdirSync(inRootTask, { recursive: true });
  fs.writeFileSync(path.join(inRootTask, "task.md"), "# Test task\n");
  const realWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]): void => {
    warnings.push(args);
  };
  try {
    const result = await acquireEarlyWorkAdmissionForCandidatePathV1({
      candidatePath: inRootTask,
      purpose: "admission",
      commandId: "test-command",
      taskRootCandidatePaths: [root],
    });
    assert.equal(result?.outcome, "acquired");
    assert.ok(
      !warnings.some((args) => String(args[0]).includes("outside every currently known task root")),
      "no containment diagnostic should fire for a properly-nested candidate"
    );
    if (result?.outcome === "acquired") {
      await result.handle.release();
    }
  } finally {
    console.warn = realWarn;
  }
});

void test("acquireEarlyWorkAdmissionForCandidatePathV1 still acquires admission when taskRootCandidatePaths is explicitly empty, but now logs a diagnostic naming the ambiguity (2026-09-11 review architectural blocker `d620c877...-1`, narrowed)", async () => {
  const task = freshTaskFolder("early-admission-containment-empty-root-list");
  fs.writeFileSync(path.join(task, "task.md"), "# Test task\n");
  const realWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]): void => {
    warnings.push(args);
  };
  try {
    const result = await acquireEarlyWorkAdmissionForCandidatePathV1({
      candidatePath: task,
      purpose: "admission",
      commandId: "test-command",
      taskRootCandidatePaths: [],
    });
    assert.equal(
      result?.outcome,
      "acquired",
      "an explicitly empty root list is still treated as 'cannot evaluate containment', not as 'outside every root' — see the call site's doc comment for why"
    );
    assert.ok(
      warnings.some(
        (args) =>
          String(args[0]).includes("task-root candidate list was empty") && String(args[0]).includes(task)
      ),
      `the unresolved ambiguity must now be diagnosable — got warnings: ${JSON.stringify(warnings)}`
    );
    if (result?.outcome === "acquired") {
      await result.handle.release();
    }
  } finally {
    console.warn = realWarn;
  }
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

    void beginTargetResolutionV1();
    assert.equal(hasResolutionInFlightBestEffortV1(), true);

    // A second, concurrent resolution (a different command in the same
    // window) must keep the gate up until BOTH have ended — nesting must not
    // let the inner end() clear a still-outstanding outer resolution.
    void beginTargetResolutionV1();
    assert.equal(hasResolutionInFlightBestEffortV1(), true);

    void endTargetResolutionV1();
    assert.equal(hasResolutionInFlightBestEffortV1(), true, "one of two concurrent resolutions ending must not clear the gate");

    void endTargetResolutionV1();
    assert.equal(hasResolutionInFlightBestEffortV1(), false);
  } finally {
    resetTargetResolutionForTestV1();
  }
});

void test("endTargetResolutionV1 clamps at zero — an extra end() (e.g. a caller with no matching begin()) never makes the counter negative or 'more ended than begun'", () => {
  resetTargetResolutionForTestV1();
  try {
    void endTargetResolutionV1();
    void endTargetResolutionV1();
    assert.equal(hasResolutionInFlightBestEffortV1(), false);

    void beginTargetResolutionV1();
    assert.equal(hasResolutionInFlightBestEffortV1(), true);
    void endTargetResolutionV1();
    void endTargetResolutionV1();
    assert.equal(hasResolutionInFlightBestEffortV1(), false);
  } finally {
    resetTargetResolutionForTestV1();
  }
});

/**
 * 2026-09-10 review completion blocker (new): the same-process
 * `resolutionInFlightCountV1` counter above is invisible to a different
 * window sweeping the same workspace. `beginTargetResolutionV1`'s optional
 * `taskRootPaths` parameter closes that gap with a real, durable, on-disk
 * marker per root — this is what `hasDurableResolutionInFlightV1` (the
 * cross-window counterpart the watchdog sweep also now consults) reads.
 */
void test("beginTargetResolutionV1 with root paths publishes a durable marker hasDurableResolutionInFlightV1 observes, released by the matching endTargetResolutionV1", async () => {
  const root = freshTaskFolder("resolution-in-flight-root");
  assert.equal(hasDurableResolutionInFlightV1([root]), false);

  const handle = await beginTargetResolutionV1([root]);
  try {
    assert.deepEqual(handle.rootPaths, [root]);
    assert.equal(hasDurableResolutionInFlightV1([root]), true);
    // A root this call did NOT ask for stays unaffected.
    assert.equal(hasDurableResolutionInFlightV1([freshTaskFolder("unrelated-root")]), false);
  } finally {
    await endTargetResolutionV1(handle);
  }
  assert.equal(hasDurableResolutionInFlightV1([root]), false);
});

void test("beginTargetResolutionV1 root markers are reference-counted per process: the marker survives until every concurrent same-window holder has ended", async () => {
  const root = freshTaskFolder("resolution-in-flight-refcount");
  const first = await beginTargetResolutionV1([root]);
  const second = await beginTargetResolutionV1([root]);
  try {
    assert.equal(hasDurableResolutionInFlightV1([root]), true);
    // Both calls observed (or reused) the same root — the marker directory
    // holds exactly one marker file, not two, regardless of how many
    // concurrent resolutions are sharing it.
    const dir = path.join(root, ADMISSION_DIRNAME_V1);
    assert.equal(fs.readdirSync(dir).length, 1);

    await endTargetResolutionV1(first);
    assert.equal(
      hasDurableResolutionInFlightV1([root]),
      true,
      "one of two concurrent resolutions ending must not remove the shared marker"
    );
  } finally {
    await endTargetResolutionV1(second);
  }
  assert.equal(hasDurableResolutionInFlightV1([root]), false);
});

void test("beginTargetResolutionV1 root marker acquisition is best-effort: a root it cannot acquire (already busy) is retried but never blocks or throws, and (2026-09-11 review completion blocker `b5a1f851...-0`, narrowed) the resulting unprotected window is now logged rather than silent", async () => {
  const root = freshTaskFolder("resolution-in-flight-busy-root");
  const otherOwner = await acquireWorkAdmissionV1({
    taskFolderPath: root,
    purpose: "admission",
    commandId: "unrelated-admission-holder",
  });
  assert.equal(otherOwner.outcome, "acquired");
  const realWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]): void => {
    warnings.push(args);
  };
  try {
    const handle = await beginTargetResolutionV1([root]);
    try {
      // The root marker was already held by an unrelated real admission
      // acquisition (a normal per-task marker, not another resolution) — this
      // call must not have been granted its own, and must not throw.
      assert.deepEqual(handle.rootPaths, []);
    } finally {
      await endTargetResolutionV1(handle);
    }
    // The other owner's marker must be untouched by the failed attempt.
    assert.equal(hasDurableResolutionInFlightV1([root]), true);
    // The still-contended-after-retries case must now be diagnosable, the
    // same way a real write failure already was — previously nothing was
    // logged for ordinary contention at all.
    assert.ok(
      warnings.some((args) => String(args[0]).includes("still contended after") && String(args[0]).includes(root)),
      `the unprotected-after-retries window must be logged — got warnings: ${JSON.stringify(warnings)}`
    );
  } finally {
    console.warn = realWarn;
    if (otherOwner.outcome === "acquired") {
      await otherOwner.handle.release();
    }
  }
});

void test("beginTargetResolutionV1's durable root marker path is classified workflowControl", () => {
  const root = freshTaskFolder("resolution-in-flight-classification");
  const markerPath = path.join(root, ADMISSION_DIRNAME_V1, "admission.some-owner.g1.abc123");
  assert.equal(classifyWorkflowPathV1(markerPath), "workflowControl");
});

// ── Part 1b: durable pause-fence generation allocator ───────────────────────

void test("readOrInitPauseFenceGenerationV1 lazily publishes generation 0 for a task with no fence yet", async () => {
  const task = freshTaskFolder("pause-fence-lazy-init");
  const generation = await readOrInitPauseFenceGenerationV1(task);
  assert.equal(generation, 0);
  assert.equal(
    fs.existsSync(path.join(task, ADMISSION_DIRNAME_V1, "pause-fence.g0")),
    true,
    "generation 0 must be durably published on disk, not merely returned in memory"
  );
});

void test("readOrInitPauseFenceGenerationV1 returns the existing highest generation without creating a new one", async () => {
  const task = freshTaskFolder("pause-fence-read-existing");
  const dir = path.join(task, ADMISSION_DIRNAME_V1);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "pause-fence.g0"), "");
  fs.writeFileSync(path.join(dir, "pause-fence.g3"), "");
  const generation = await readOrInitPauseFenceGenerationV1(task);
  assert.equal(generation, 3);
  assert.equal(fs.existsSync(path.join(dir, "pause-fence.g4")), false);
});

void test("readOrInitPauseFenceGenerationV1 initialization races: concurrent first callers converge on one published generation, never throw", async () => {
  const task = freshTaskFolder("pause-fence-init-race");
  const results = await Promise.all(
    Array.from({ length: 6 }, () => readOrInitPauseFenceGenerationV1(task))
  );
  assert.ok(
    results.every((g) => g === 0),
    `every racing first-caller must observe the same published generation 0 — got ${JSON.stringify(results)}`
  );
  const dir = path.join(task, ADMISSION_DIRNAME_V1);
  const fenceFiles = fs.readdirSync(dir).filter((name) => /^pause-fence\.g\d+$/.test(name));
  assert.deepEqual(fenceFiles, ["pause-fence.g0"], "exactly one generation-0 file must exist, never duplicated");
});

void test("readOrInitPauseFenceGenerationV1 racing a concurrent advancePauseFenceGenerationV1 on a virgin directory never returns a stale generation (2026-09-11 review completion blocker)", async () => {
  const task = freshTaskFolder("pause-fence-init-advance-race");
  // Both calls see an empty directory and race their own exclusive-create:
  // `readOrInit` targets `g0`, `advance` targets `g1` — different filenames,
  // so both writes can succeed. Before the fix, `readOrInit` returned its own
  // successful `0` unconditionally, even when `advance`'s `g1` had already
  // landed as the true authoritative generation. An uncontrolled
  // `Promise.all` of the two calls might never actually sample that exact
  // ordering, so this forces it deterministically: `readOrInit` is held
  // immediately before its own `g0` write until `advance`'s `g1` has fully
  // landed on disk, then released — reproducing precisely the interleaving
  // the bug required.
  let releaseInit: (() => void) | undefined;
  const initHeld = new Promise<void>((resolve) => {
    releaseInit = resolve;
  });
  setWorkAdmissionFsFailureInjectionForTestV1({
    onBeforeFenceInitWriteAsync: async () => {
      await initHeld;
    },
  });
  try {
    const initPromise = readOrInitPauseFenceGenerationV1(task);
    const advanceResult = await advancePauseFenceGenerationV1(task);
    assert.equal(advanceResult, 1, "the lone advancer on a virgin directory must publish generation 1");
    releaseInit!();
    const initResult = await initPromise;
    assert.equal(
      initResult,
      1,
      `readOrInit must converge on the true current maximum (1), never report a stale 0 — got ${initResult}`
    );
  } finally {
    setWorkAdmissionFsFailureInjectionForTestV1(undefined);
  }
  // A second, later call must also observe the same durable maximum.
  assert.equal(await readOrInitPauseFenceGenerationV1(task), 1);
});

void test("readOrInitPauseFenceGenerationV1 called many times concurrently while a single advance races it converges on the advancer's generation", async () => {
  const task = freshTaskFolder("pause-fence-init-advance-race-many");
  let releaseInits: (() => void) | undefined;
  const initsHeld = new Promise<void>((resolve) => {
    releaseInits = resolve;
  });
  setWorkAdmissionFsFailureInjectionForTestV1({
    onBeforeFenceInitWriteAsync: async () => {
      await initsHeld;
    },
  });
  try {
    const initPromises = Array.from({ length: 5 }, () => readOrInitPauseFenceGenerationV1(task));
    const advanceResult = await advancePauseFenceGenerationV1(task);
    assert.equal(advanceResult, 1);
    releaseInits!();
    const initResults = await Promise.all(initPromises);
    assert.ok(
      initResults.every((g) => g === 1),
      `every readOrInit racing the advancer must converge on generation 1, never a stale 0 — got ${JSON.stringify(initResults)}`
    );
  } finally {
    setWorkAdmissionFsFailureInjectionForTestV1(undefined);
  }
  const dir = path.join(task, ADMISSION_DIRNAME_V1);
  assert.ok(fs.existsSync(path.join(dir, "pause-fence.g1")), "the advancer's generation 1 must be durably published");
});

void test("advancePauseFenceGenerationV1 publishes strictly the next generation past whatever currently exists", async () => {
  const task = freshTaskFolder("pause-fence-advance-basic");
  assert.equal(await readOrInitPauseFenceGenerationV1(task), 0);
  assert.equal(await advancePauseFenceGenerationV1(task), 1);
  assert.equal(await advancePauseFenceGenerationV1(task), 2);
  assert.equal(await readOrInitPauseFenceGenerationV1(task), 2);
});

void test("advancePauseFenceGenerationV1 lazily establishes generation 0 before publishing a later generation on a virgin directory (2026-09-11 review completion blocker)", async () => {
  const task = freshTaskFolder("pause-fence-advance-virgin-init");
  const dir = path.join(task, ADMISSION_DIRNAME_V1);
  // No `readOrInitPauseFenceGenerationV1` call at all — `advance` is the
  // FIRST fence operation this task ever sees, on a directory that does not
  // even exist yet. Before the fix, this published `pause-fence.g1` directly,
  // skipping the fence's own documented base state.
  const result = await advancePauseFenceGenerationV1(task);
  assert.equal(result, 1, "a lone advance on a virgin directory still publishes generation 1");
  assert.ok(
    fs.existsSync(path.join(dir, "pause-fence.g0")),
    "generation 0 must be durably established before generation 1 is published, not skipped"
  );
  assert.ok(fs.existsSync(path.join(dir, "pause-fence.g1")), "generation 1 must also be published");
  const fenceFiles = fs.readdirSync(dir).filter((name) => /^pause-fence\.g\d+$/.test(name));
  assert.deepEqual(
    [...fenceFiles].sort(),
    ["pause-fence.g0", "pause-fence.g1"],
    "exactly generations 0 and 1 must exist, nothing skipped or duplicated"
  );
});

void test("advancePauseFenceGenerationV1 never regresses or reuses a generation under concurrent advancers", async () => {
  const task = freshTaskFolder("pause-fence-advance-concurrent");
  await readOrInitPauseFenceGenerationV1(task);
  const CONCURRENT_ADVANCERS = 8;
  const published = await Promise.all(
    Array.from({ length: CONCURRENT_ADVANCERS }, () => advancePauseFenceGenerationV1(task))
  );
  const sorted = [...published].sort((a, b) => a - b);
  const expected = Array.from({ length: CONCURRENT_ADVANCERS }, (_, i) => i + 1);
  assert.deepEqual(sorted, expected, `concurrent advancers must publish a contiguous, non-duplicated run of generations — got ${JSON.stringify(sorted)}`);
  const dir = path.join(task, ADMISSION_DIRNAME_V1);
  const fenceFiles = fs.readdirSync(dir).filter((name) => /^pause-fence\.g\d+$/.test(name));
  assert.equal(fenceFiles.length, CONCURRENT_ADVANCERS + 1, "generation 0 plus one file per successful advance, no more");
});

void test("a partially-written pause-fence file is still a valid fence by existence alone (there is no content to corrupt)", async () => {
  const task = freshTaskFolder("pause-fence-existence-only");
  const dir = path.join(task, ADMISSION_DIRNAME_V1);
  fs.mkdirSync(dir, { recursive: true });
  // Even an empty file (the only content this primitive ever writes) counts
  // as a fully valid, currently-published generation — there is no partial-
  // write ambiguity the way there is for `admission.claim`'s JSON body.
  fs.writeFileSync(path.join(dir, "pause-fence.g2"), "");
  assert.equal(await readOrInitPauseFenceGenerationV1(task), 2);
});

// ── isWatchdogPauseFenceCurrentV1 (v1 fixes item 1, Part 1b step 1) ─────────

void test("isWatchdogPauseFenceCurrentV1 is true for an undefined recorded generation (pause predates the fence, or was never claim-bound)", async () => {
  const task = freshTaskFolder("pause-fence-current-undefined");
  assert.equal(await isWatchdogPauseFenceCurrentV1(task, undefined), true);
});

void test("isWatchdogPauseFenceCurrentV1 is true while the recorded generation still equals the current durable maximum", async () => {
  const task = freshTaskFolder("pause-fence-current-match");
  const generation = await readOrInitPauseFenceGenerationV1(task);
  assert.equal(await isWatchdogPauseFenceCurrentV1(task, generation), true);
});

void test("isWatchdogPauseFenceCurrentV1 is false once the durable generation has advanced past the recorded one", async () => {
  const task = freshTaskFolder("pause-fence-current-stale");
  const recorded = await readOrInitPauseFenceGenerationV1(task);
  await advancePauseFenceGenerationV1(task);
  assert.equal(await isWatchdogPauseFenceCurrentV1(task, recorded), false);
});

void test("isWatchdogPauseFenceCurrentV1 lazily initializes generation 0 for a task with no fence file at all yet, and treats a freshly-captured 0 as current", async () => {
  const task = freshTaskFolder("pause-fence-current-virgin");
  assert.equal(await isWatchdogPauseFenceCurrentV1(task, 0), true);
  assert.ok(fs.existsSync(path.join(task, ADMISSION_DIRNAME_V1, "pause-fence.g0")));
});

// ── revokeStalePauseCommitClaimV1 / pause-revocation barrier (Part 1b step 12) ─

function markerFilePathV1(task: string): string {
  const dir = path.join(task, ADMISSION_DIRNAME_V1);
  const marker = fs.readdirSync(dir).find((name) => name.startsWith("admission."));
  assert.ok(marker, "expected a live admission marker on disk");
  return path.join(dir, marker);
}

function backdateV1(filePath: string, ageMs: number): void {
  const old = new Date(Date.now() - ageMs);
  fs.utimesSync(filePath, old, old);
}

/** Test-only: lists `pause-fence.g<N>` files directly, WITHOUT the lazy
 * generation-0 initialization `readOrInitPauseFenceGenerationV1` performs as
 * a side effect — needed to assert "no fence file exists yet" without that
 * assertion itself creating one. */
function listPauseFenceGenerationsForTestV1(task: string): readonly string[] {
  const dir = path.join(task, ADMISSION_DIRNAME_V1);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries.filter((name) => /^pause-fence\.g\d+$/.test(name));
}

void test("revokeStalePauseCommitClaimV1 reports notApplicable when no marker exists at all", async () => {
  const task = freshTaskFolder("revoke-no-marker");
  const result = await revokeStalePauseCommitClaimV1(task, "revoker-1");
  assert.equal(result.outcome, "notApplicable");
});

void test("revokeStalePauseCommitClaimV1 reports notApplicable for a live admission-purpose marker — never touches it or the fence", async () => {
  const task = freshTaskFolder("revoke-admission-purpose");
  const acquired = await acquireWorkAdmissionV1({ taskFolderPath: task, purpose: "admission", commandId: "real-work" });
  assert.equal(acquired.outcome, "acquired");
  if (acquired.outcome !== "acquired") return;
  backdateV1(markerFilePathV1(task), PAUSE_COMMIT_LIKELY_STALE_MS_V1 + 60_000);

  const result = await revokeStalePauseCommitClaimV1(task, "revoker-1");
  assert.equal(result.outcome, "notApplicable");
  assert.equal(hasLiveWorkAdmissionBestEffortV1(task), true, "the admission marker must be untouched");
  assert.equal(
    listPauseFenceGenerationsForTestV1(task).length,
    0,
    "an admission-purpose marker must never advance the fence"
  );

  await acquired.handle.release();
});

void test("revokeStalePauseCommitClaimV1 reports notStale for a fresh pauseCommit marker", async () => {
  const task = freshTaskFolder("revoke-fresh-pausecommit");
  const acquired = await acquireWorkAdmissionV1({ taskFolderPath: task, purpose: "pauseCommit", commandId: "sweep" });
  assert.equal(acquired.outcome, "acquired");
  if (acquired.outcome !== "acquired") return;

  const result = await revokeStalePauseCommitClaimV1(task, "revoker-1");
  assert.equal(result.outcome, "notStale");

  await acquired.handle.release();
});

void test("revokeStalePauseCommitClaimV1 revokes a stale pauseCommit marker into a pending barrier, without advancing the fence itself", async () => {
  const task = freshTaskFolder("revoke-stale-pausecommit");
  const acquired = await acquireWorkAdmissionV1({ taskFolderPath: task, purpose: "pauseCommit", commandId: "sweep" });
  assert.equal(acquired.outcome, "acquired");
  if (acquired.outcome !== "acquired") return;
  const markerPath = markerFilePathV1(task);
  backdateV1(markerPath, PAUSE_COMMIT_LIKELY_STALE_MS_V1 + 60_000);

  const result = await revokeStalePauseCommitClaimV1(task, "revoker-1");
  assert.equal(result.outcome, "revoked");
  if (result.outcome !== "revoked") return;
  assert.equal(fs.existsSync(markerPath), false, "the original marker path must be gone");
  assert.equal(fs.existsSync(result.barrierPath), true, "the barrier file must exist at the returned path");
  assert.equal(path.basename(result.barrierPath), "pause-revocation.pending.revoker-1");
  assert.equal(result.revokedClaim.purpose, "pauseCommit");
  assert.equal(
    listPendingPauseRevocationBarriersV1(task).length,
    1,
    "the barrier must be discoverable for a later claimant"
  );
  assert.equal(
    listPauseFenceGenerationsForTestV1(task).length,
    0,
    "revoke alone must never advance the fence — only finishPauseRevocationBarrierV1 does"
  );

  // The original owner's own `release()` (simulating it eventually waking up)
  // must be a harmless no-op against its now-displaced marker — ENOENT is
  // "displaced", never an error, exactly like every other release path in
  // this module.
  await assert.doesNotReject(() => acquired.handle.release());
});

void test("revokeStalePauseCommitClaimV1 reports raced when the marker is released between observation and rename", async () => {
  const task = freshTaskFolder("revoke-raced-release");
  const acquired = await acquireWorkAdmissionV1({ taskFolderPath: task, purpose: "pauseCommit", commandId: "sweep" });
  assert.equal(acquired.outcome, "acquired");
  if (acquired.outcome !== "acquired") return;
  backdateV1(markerFilePathV1(task), PAUSE_COMMIT_LIKELY_STALE_MS_V1 + 60_000);

  setWorkAdmissionFsFailureInjectionForTestV1({
    onBeforeRevocationRenameAsync: async () => {
      await acquired.handle.release();
    },
  });
  try {
    const result = await revokeStalePauseCommitClaimV1(task, "revoker-1");
    assert.equal(result.outcome, "raced");
    assert.equal(
      listPendingPauseRevocationBarriersV1(task).length,
      0,
      "a raced revocation must never leave a barrier behind"
    );
  } finally {
    setWorkAdmissionFsFailureInjectionForTestV1(undefined);
  }
});

void test("finishPauseRevocationBarrierV1 advances the fence and removes the barrier file", async () => {
  const task = freshTaskFolder("finish-barrier-basic");
  const acquired = await acquireWorkAdmissionV1({ taskFolderPath: task, purpose: "pauseCommit", commandId: "sweep" });
  assert.equal(acquired.outcome, "acquired");
  if (acquired.outcome !== "acquired") return;
  backdateV1(markerFilePathV1(task), PAUSE_COMMIT_LIKELY_STALE_MS_V1 + 60_000);
  const revoked = await revokeStalePauseCommitClaimV1(task, "revoker-1");
  assert.equal(revoked.outcome, "revoked");
  if (revoked.outcome !== "revoked") return;
  const fenceBefore = await readOrInitPauseFenceGenerationV1(task);

  await finishPauseRevocationBarrierV1(task, revoked.barrierPath);

  assert.equal(await readOrInitPauseFenceGenerationV1(task), fenceBefore + 1);
  assert.equal(fs.existsSync(revoked.barrierPath), false);
  assert.equal(listPendingPauseRevocationBarriersV1(task).length, 0);
});

void test("a later claimant can help finish an abandoned revocation barrier via listPendingPauseRevocationBarriersV1", async () => {
  const task = freshTaskFolder("finish-barrier-abandoned");
  const acquired = await acquireWorkAdmissionV1({ taskFolderPath: task, purpose: "pauseCommit", commandId: "sweep" });
  assert.equal(acquired.outcome, "acquired");
  if (acquired.outcome !== "acquired") return;
  backdateV1(markerFilePathV1(task), PAUSE_COMMIT_LIKELY_STALE_MS_V1 + 60_000);
  const revoked = await revokeStalePauseCommitClaimV1(task, "dying-revoker");
  assert.equal(revoked.outcome, "revoked");
  // Simulate the revoker dying here, before it ever calls
  // `finishPauseRevocationBarrierV1` itself — the barrier is left pending.

  const pending = listPendingPauseRevocationBarriersV1(task);
  assert.equal(pending.length, 1);
  const fenceBefore = await readOrInitPauseFenceGenerationV1(task);

  // A completely different later claimant discovers and completes it.
  for (const barrierPath of pending) {
    await finishPauseRevocationBarrierV1(task, barrierPath);
  }

  assert.equal(await readOrInitPauseFenceGenerationV1(task), fenceBefore + 1);
  assert.equal(listPendingPauseRevocationBarriersV1(task).length, 0);
});

void test("finishPauseRevocationBarrierV1 is idempotent: calling it twice for the same barrier is harmless", async () => {
  const task = freshTaskFolder("finish-barrier-idempotent");
  const acquired = await acquireWorkAdmissionV1({ taskFolderPath: task, purpose: "pauseCommit", commandId: "sweep" });
  assert.equal(acquired.outcome, "acquired");
  if (acquired.outcome !== "acquired") return;
  backdateV1(markerFilePathV1(task), PAUSE_COMMIT_LIKELY_STALE_MS_V1 + 60_000);
  const revoked = await revokeStalePauseCommitClaimV1(task, "revoker-1");
  assert.equal(revoked.outcome, "revoked");
  if (revoked.outcome !== "revoked") return;

  await finishPauseRevocationBarrierV1(task, revoked.barrierPath);
  const fenceAfterFirst = await readOrInitPauseFenceGenerationV1(task);
  // The barrier file is already gone; a second call for the same path must
  // not throw (ENOENT on the unlink is tolerated) and must NOT advance the
  // fence again — a duplicate/delayed finish that outlives its own barrier
  // must be a true no-op, or it could invalidate a brand-new, unrelated
  // pause that captured the generation this barrier's completion already
  // published (2026-09-11 review completion blocker).
  await assert.doesNotReject(() => finishPauseRevocationBarrierV1(task, revoked.barrierPath));
  assert.equal(await readOrInitPauseFenceGenerationV1(task), fenceAfterFirst);
});

void test("finishPauseRevocationBarrierV1 never advances the fence for a barrier it did not itself observe present (no unrelated-pause invalidation)", async () => {
  const task = freshTaskFolder("finish-barrier-no-phantom-advance");
  const acquired = await acquireWorkAdmissionV1({ taskFolderPath: task, purpose: "pauseCommit", commandId: "sweep" });
  assert.equal(acquired.outcome, "acquired");
  if (acquired.outcome !== "acquired") return;
  backdateV1(markerFilePathV1(task), PAUSE_COMMIT_LIKELY_STALE_MS_V1 + 60_000);
  const revoked = await revokeStalePauseCommitClaimV1(task, "revoker-phantom");
  assert.equal(revoked.outcome, "revoked");
  if (revoked.outcome !== "revoked") return;

  // A prompt claimant finishes the barrier for real.
  await finishPauseRevocationBarrierV1(task, revoked.barrierPath);
  const fenceAfterRealFinish = await readOrInitPauseFenceGenerationV1(task);

  // A brand-new, unrelated pauseCommit acquisition now captures the current
  // (post-revocation) generation, exactly as a legitimate late pause would.
  const newPauseCommit = await acquireWorkAdmissionV1({
    taskFolderPath: task,
    purpose: "pauseCommit",
    commandId: "sweep-2",
  });
  assert.equal(newPauseCommit.outcome, "acquired");

  // A stray, delayed finish call for the ORIGINAL (already-gone) barrier path
  // must not advance the fence past the generation the new pause just relied
  // on being current.
  await finishPauseRevocationBarrierV1(task, revoked.barrierPath);
  assert.equal(
    await readOrInitPauseFenceGenerationV1(task),
    fenceAfterRealFinish,
    "a finish call for an already-completed barrier must never advance the fence further"
  );

  if (newPauseCommit.outcome === "acquired") {
    await newPauseCommit.handle.release();
  }
});

void test("finishPauseRevocationBarrierV1 is exclusive under genuine concurrency: two simultaneous finishers of the same still-present barrier advance the fence exactly once, never invalidating a pause that lands in between (2026-09-11 review completion blocker, round 2)", async () => {
  const task = freshTaskFolder("finish-barrier-concurrent-exclusive");
  const acquired = await acquireWorkAdmissionV1({ taskFolderPath: task, purpose: "pauseCommit", commandId: "sweep" });
  assert.equal(acquired.outcome, "acquired");
  if (acquired.outcome !== "acquired") return;
  backdateV1(markerFilePathV1(task), PAUSE_COMMIT_LIKELY_STALE_MS_V1 + 60_000);
  const revoked = await revokeStalePauseCommitClaimV1(task, "revoker-concurrent");
  assert.equal(revoked.outcome, "revoked");
  if (revoked.outcome !== "revoked") return;
  const fenceBefore = await readOrInitPauseFenceGenerationV1(task);

  // Two genuinely concurrent finishers race for the SAME still-present
  // barrier — the case an `existsSync`-only guard cannot distinguish from
  // two independent, sequential completions. Only one may ever win the
  // exclusive rename and perform the advance.
  await Promise.all([
    finishPauseRevocationBarrierV1(task, revoked.barrierPath),
    finishPauseRevocationBarrierV1(task, revoked.barrierPath),
  ]);

  assert.equal(
    await readOrInitPauseFenceGenerationV1(task),
    fenceBefore + 1,
    "concurrent finishers of the same barrier must advance the fence exactly once, not twice"
  );
  assert.equal(listPendingPauseRevocationBarriersV1(task).length, 0, "the barrier must be fully removed exactly once");

  // A brand-new, legitimate pauseCommit that captured the post-revocation
  // generation right after the winning finisher's advance must survive —
  // proving the losing finisher's no-op never invalidates it.
  const freshPause = await acquireWorkAdmissionV1({ taskFolderPath: task, purpose: "pauseCommit", commandId: "sweep-3" });
  assert.equal(freshPause.outcome, "acquired");
  if (freshPause.outcome === "acquired") {
    assert.equal(
      await isWatchdogPauseFenceCurrentV1(task, fenceBefore + 1),
      true,
      "the fresh pause's captured generation must still be current — no phantom second advance behind it"
    );
    await freshPause.handle.release();
  }
});

void test("finishPauseRevocationBarrierV1 takes over when a prior finisher released its lock without completing the barrier (2026-09-11 review completion blocker `dceb2646...-2`)", async () => {
  const task = freshTaskFolder("finish-barrier-takeover-after-abandoned-lock");
  const acquired = await acquireWorkAdmissionV1({ taskFolderPath: task, purpose: "pauseCommit", commandId: "sweep" });
  assert.equal(acquired.outcome, "acquired");
  if (acquired.outcome !== "acquired") return;
  backdateV1(markerFilePathV1(task), PAUSE_COMMIT_LIKELY_STALE_MS_V1 + 60_000);
  const revoked = await revokeStalePauseCommitClaimV1(task, "revoker-abandoned-lock");
  assert.equal(revoked.outcome, "revoked");
  if (revoked.outcome !== "revoked") return;
  const fenceBefore = await readOrInitPauseFenceGenerationV1(task);

  // Simulate a winner that crashed (or threw) strictly between winning the
  // finish-lock and completing the advance/cleanup/remove sequence: it
  // unlinked its lock in `finally` (matching this module's own documented
  // behavior on that path) but never advanced the fence or removed the
  // barrier. Pre-create the lock, then release it shortly after — while the
  // barrier is still present — to reproduce exactly that observable state
  // for a waiter.
  const lockPath = `${revoked.barrierPath}.finish-lock`;
  fs.writeFileSync(lockPath, "");
  setTimeout(() => {
    fs.unlinkSync(lockPath);
  }, 150);

  // A previous implementation treated "lock gone" alone as "finished" and
  // would have conceded here without ever advancing the fence or removing
  // the barrier. The fix must instead notice the barrier is still present
  // and take over.
  await finishPauseRevocationBarrierV1(task, revoked.barrierPath);

  assert.equal(
    await readOrInitPauseFenceGenerationV1(task),
    fenceBefore + 1,
    "a waiter that takes over after an abandoned lock must still advance the fence"
  );
  assert.equal(fs.existsSync(revoked.barrierPath), false, "a waiter that takes over must remove the barrier");
  assert.equal(listPendingPauseRevocationBarriersV1(task).length, 0);
});

void test("finishPauseRevocationBarrierV1 reclaims a stale finish-lock left behind by a genuine process crash — the lock is never removed at all, only its age proves abandonment (2026-09-11 review completion blocker `dceb2646...-3`)", async () => {
  const task = freshTaskFolder("finish-barrier-reclaim-crashed-lock");
  const acquired = await acquireWorkAdmissionV1({ taskFolderPath: task, purpose: "pauseCommit", commandId: "sweep" });
  assert.equal(acquired.outcome, "acquired");
  if (acquired.outcome !== "acquired") return;
  backdateV1(markerFilePathV1(task), PAUSE_COMMIT_LIKELY_STALE_MS_V1 + 60_000);
  const revoked = await revokeStalePauseCommitClaimV1(task, "revoker-crashed-lock");
  assert.equal(revoked.outcome, "revoked");
  if (revoked.outcome !== "revoked") return;
  const fenceBefore = await readOrInitPauseFenceGenerationV1(task);

  // Simulate a genuine OS-level crash (kill -9, power loss): the winner's
  // lock is created and NEVER removed — no `finally` ever runs, unlike an
  // in-process throw (already covered by the "abandoned lock" test above,
  // which relies on the lock eventually being unlinked). Backdate it well
  // past the reclaim staleness threshold so this test does not sleep for it.
  const lockPath = `${revoked.barrierPath}.finish-lock`;
  fs.writeFileSync(lockPath, "");
  backdateV1(lockPath, PAUSE_REVOCATION_FINISH_LOCK_STALE_MS_V1 + 5_000);

  // A previous implementation waited out its bounded poll (~2s) and then
  // conceded forever, since nothing ever removes a crashed process's lock.
  // The fix must instead recognize the lock's age as proof of abandonment
  // and reclaim it itself.
  await finishPauseRevocationBarrierV1(task, revoked.barrierPath);

  assert.equal(
    await readOrInitPauseFenceGenerationV1(task),
    fenceBefore + 1,
    "reclaiming a crashed lock must still advance the fence"
  );
  assert.equal(fs.existsSync(revoked.barrierPath), false, "reclaiming a crashed lock must remove the barrier");
  assert.equal(fs.existsSync(lockPath), false, "the stale lock itself must be removed by the reclaimer");
  assert.equal(listPendingPauseRevocationBarriersV1(task).length, 0);
});

void test("finishPauseRevocationBarrierV1 never reclaims a finish-lock that is merely young, even after its bounded wait — a live-but-slow winner is never mistaken for a crashed one (2026-09-11 review completion blocker `dceb2646...-3`)", async () => {
  const task = freshTaskFolder("finish-barrier-no-reclaim-of-fresh-lock");
  const acquired = await acquireWorkAdmissionV1({ taskFolderPath: task, purpose: "pauseCommit", commandId: "sweep" });
  assert.equal(acquired.outcome, "acquired");
  if (acquired.outcome !== "acquired") return;
  backdateV1(markerFilePathV1(task), PAUSE_COMMIT_LIKELY_STALE_MS_V1 + 60_000);
  const revoked = await revokeStalePauseCommitClaimV1(task, "revoker-fresh-lock");
  assert.equal(revoked.outcome, "revoked");
  if (revoked.outcome !== "revoked") return;
  const fenceBefore = await readOrInitPauseFenceGenerationV1(task);

  // A lock created "now" (never backdated) is well within a plausible live
  // hold window even after the ~2s bounded wait elapses — it must be left
  // alone rather than reclaimed out from under a winner that may still be
  // working.
  const lockPath = `${revoked.barrierPath}.finish-lock`;
  fs.writeFileSync(lockPath, "");
  try {
    await finishPauseRevocationBarrierV1(task, revoked.barrierPath);

    assert.equal(
      await readOrInitPauseFenceGenerationV1(task),
      fenceBefore,
      "a fresh, still-plausibly-live lock must never be reclaimed — the fence must not advance"
    );
    assert.equal(fs.existsSync(revoked.barrierPath), true, "the barrier must remain pending, not be removed");
    assert.equal(fs.existsSync(lockPath), true, "the fresh lock itself must be left in place, not reclaimed");
  } finally {
    fs.unlinkSync(lockPath);
  }
});

void test("finishPauseRevocationBarrierV1's stale-lock reclaim is exclusive under genuine concurrency: two simultaneous reclaimers of the same crashed lock advance the fence exactly once (2026-09-11 review completion blocker `dceb2646...-3`)", async () => {
  const task = freshTaskFolder("finish-barrier-reclaim-concurrent-exclusive");
  const acquired = await acquireWorkAdmissionV1({ taskFolderPath: task, purpose: "pauseCommit", commandId: "sweep" });
  assert.equal(acquired.outcome, "acquired");
  if (acquired.outcome !== "acquired") return;
  backdateV1(markerFilePathV1(task), PAUSE_COMMIT_LIKELY_STALE_MS_V1 + 60_000);
  const revoked = await revokeStalePauseCommitClaimV1(task, "revoker-reclaim-concurrent");
  assert.equal(revoked.outcome, "revoked");
  if (revoked.outcome !== "revoked") return;
  const fenceBefore = await readOrInitPauseFenceGenerationV1(task);

  const lockPath = `${revoked.barrierPath}.finish-lock`;
  fs.writeFileSync(lockPath, "");
  backdateV1(lockPath, PAUSE_REVOCATION_FINISH_LOCK_STALE_MS_V1 + 5_000);

  // Two callers race to reclaim the SAME crashed lock. Only one may ever win
  // the reclaim gate's exclusive create — this is the property that keeps
  // the fence from being advanced twice for one barrier (which would
  // silently invalidate a fresh, legitimate pause that captured the
  // in-between generation — see the section doc comment above).
  await Promise.all([
    finishPauseRevocationBarrierV1(task, revoked.barrierPath),
    finishPauseRevocationBarrierV1(task, revoked.barrierPath),
  ]);

  assert.equal(
    await readOrInitPauseFenceGenerationV1(task),
    fenceBefore + 1,
    "two concurrent reclaimers of the same crashed lock must advance the fence exactly once, not twice"
  );
  assert.equal(listPendingPauseRevocationBarriersV1(task).length, 0, "the barrier must be fully removed exactly once");
  assert.equal(fs.existsSync(lockPath), false, "the crashed lock must be removed by whichever reclaimer won");

  const freshPause = await acquireWorkAdmissionV1({ taskFolderPath: task, purpose: "pauseCommit", commandId: "sweep-4" });
  assert.equal(freshPause.outcome, "acquired");
  if (freshPause.outcome === "acquired") {
    assert.equal(
      await isWatchdogPauseFenceCurrentV1(task, fenceBefore + 1),
      true,
      "the fresh pause's captured generation must still be current — no phantom second advance from the reclaim race"
    );
    await freshPause.handle.release();
  }
});

void test("advancePauseFenceForRevocationV1 + removePauseRevocationBarrierV1 give a caller a seam to run cleanup between fence-advance and barrier-removal", async () => {
  const task = freshTaskFolder("revocation-two-step-seam");
  const acquired = await acquireWorkAdmissionV1({ taskFolderPath: task, purpose: "pauseCommit", commandId: "sweep" });
  assert.equal(acquired.outcome, "acquired");
  if (acquired.outcome !== "acquired") return;
  backdateV1(markerFilePathV1(task), PAUSE_COMMIT_LIKELY_STALE_MS_V1 + 60_000);
  const revoked = await revokeStalePauseCommitClaimV1(task, "revoker-seam");
  assert.equal(revoked.outcome, "revoked");
  if (revoked.outcome !== "revoked") return;
  const fenceBefore = await readOrInitPauseFenceGenerationV1(task);

  const fenceAfterAdvance = await advancePauseFenceForRevocationV1(task);
  assert.equal(fenceAfterAdvance, fenceBefore + 1);
  // The fence has advanced, but the barrier must still be present — this is
  // the seam a real caller uses to perform its own stale-pause cleanup in
  // `task-progress.json` (plan step 12's required ordering) before the
  // barrier — the only durable record that cleanup was still owed —
  // disappears.
  assert.equal(fs.existsSync(revoked.barrierPath), true, "barrier must survive the fence advance alone");
  assert.deepEqual(listPendingPauseRevocationBarriersV1(task), [revoked.barrierPath]);

  // Caller's cleanup would run here.

  await removePauseRevocationBarrierV1(revoked.barrierPath);
  assert.equal(fs.existsSync(revoked.barrierPath), false);
  assert.equal(listPendingPauseRevocationBarriersV1(task).length, 0);
  // The fence must not have moved again — removal alone never advances it.
  assert.equal(await readOrInitPauseFenceGenerationV1(task), fenceAfterAdvance);
});

void test("removePauseRevocationBarrierV1 tolerates an already-removed barrier (ENOENT)", async () => {
  const task = freshTaskFolder("revocation-remove-idempotent");
  const acquired = await acquireWorkAdmissionV1({ taskFolderPath: task, purpose: "pauseCommit", commandId: "sweep" });
  assert.equal(acquired.outcome, "acquired");
  if (acquired.outcome !== "acquired") return;
  backdateV1(markerFilePathV1(task), PAUSE_COMMIT_LIKELY_STALE_MS_V1 + 60_000);
  const revoked = await revokeStalePauseCommitClaimV1(task, "revoker-remove-twice");
  assert.equal(revoked.outcome, "revoked");
  if (revoked.outcome !== "revoked") return;

  await removePauseRevocationBarrierV1(revoked.barrierPath);
  await assert.doesNotReject(() => removePauseRevocationBarrierV1(revoked.barrierPath));
});

void test("a new acquisition automatically finishes a pending revocation barrier — advances the fence AND removes it (Part 1b step 12 wiring)", async () => {
  const task = freshTaskFolder("acquire-advances-pending-barrier");
  const stale = await acquireWorkAdmissionV1({ taskFolderPath: task, purpose: "pauseCommit", commandId: "sweep" });
  assert.equal(stale.outcome, "acquired");
  if (stale.outcome !== "acquired") return;
  backdateV1(markerFilePathV1(task), PAUSE_COMMIT_LIKELY_STALE_MS_V1 + 60_000);
  const revoked = await revokeStalePauseCommitClaimV1(task, "revoker-wiring");
  assert.equal(revoked.outcome, "revoked");
  if (revoked.outcome !== "revoked") return;
  const fenceBeforeNewAcquisition = await readOrInitPauseFenceGenerationV1(task);
  assert.equal(listPendingPauseRevocationBarriersV1(task).length, 1);

  // A completely unrelated later acquisition — neither the revoker nor an
  // explicit `finishPauseRevocationBarrierV1` caller — must still see the
  // barrier fully COMPLETED as a side effect of it starting, per plan step
  // 12: "every later claimant must complete the barrier ... before
  // publishing admission or starting another pause." Completing means both
  // halves (advance + remove) — see the acquisition-loop doc comment for why
  // leaving the barrier behind (the previous, buggy behavior this test used
  // to assert) lets every SUBSEQUENT acquisition re-advance the fence and
  // invalidate a later legitimate pause.
  const next = await acquireWorkAdmissionV1({ taskFolderPath: task, purpose: "admission", commandId: "real-work" });
  assert.equal(next.outcome, "acquired");
  if (next.outcome !== "acquired") return;

  assert.equal(
    await readOrInitPauseFenceGenerationV1(task),
    fenceBeforeNewAcquisition + 1,
    "the new acquisition must advance the fence past the pending barrier's generation before publishing"
  );
  assert.equal(
    listPendingPauseRevocationBarriersV1(task).length,
    0,
    "acquisition must fully finish (advance AND remove) the barrier, not merely advance and leave it dangling"
  );

  await next.handle.release();
  await assert.doesNotReject(() => stale.handle.release());
});

void test("purpose-aware likelyStale threshold: a pauseCommit marker is flagged stale at 5 minutes; an admission marker at the same age is not", async () => {
  const pauseCommitTask = freshTaskFolder("likely-stale-pausecommit");
  const pcAcquired = await acquireWorkAdmissionV1({ taskFolderPath: pauseCommitTask, purpose: "pauseCommit", commandId: "sweep" });
  assert.equal(pcAcquired.outcome, "acquired");
  if (pcAcquired.outcome !== "acquired") return;
  backdateV1(markerFilePathV1(pauseCommitTask), 10 * 60 * 1000);
  const pcBlocker = describeWorkAdmissionBlockerV1(pauseCommitTask);
  assert.equal(pcBlocker?.likelyStale, true, "10 minutes exceeds the 5-minute pauseCommit threshold");
  await pcAcquired.handle.release();

  const admissionTask = freshTaskFolder("likely-stale-admission");
  const admAcquired = await acquireWorkAdmissionV1({ taskFolderPath: admissionTask, purpose: "admission", commandId: "real-work" });
  assert.equal(admAcquired.outcome, "acquired");
  if (admAcquired.outcome !== "acquired") return;
  backdateV1(markerFilePathV1(admissionTask), 10 * 60 * 1000);
  const admBlocker = describeWorkAdmissionBlockerV1(admissionTask);
  assert.equal(admBlocker?.likelyStale, false, "10 minutes is well under the 20-minute admission threshold");
  await admAcquired.handle.release();
});
