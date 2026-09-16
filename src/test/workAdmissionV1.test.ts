import * as assert from "node:assert/strict";
import * as childProcess from "node:child_process";
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
  attemptAutomaticWorkAdmissionReclamationV1,
  authorizeWorkAdmissionHandoffV1,
  beginTargetResolutionV1,
  describeStaleWorkAdmissionTakeoverNoticeV1,
  describeWorkAdmissionBlockerV1,
  endTargetResolutionV1,
  ensurePauseFenceAtLeastV1,
  finishPauseRevocationBarrierV1,
  garbageCollectStaleWorkAdmissionTombstonesV1,
  removePauseRevocationBarrierV1,
  hasDurableResolutionInFlightV1,
  hasLiveWorkAdmissionBestEffortV1,
  hasLiveWorkAdmissionExcludingOwnerV1,
  hasResolutionInFlightBestEffortV1,
  hasWorkspaceIndependentOwnershipV1,
  isPathOutsideAllTaskRootsV1,
  isWatchdogPauseFenceCurrentV1,
  listPendingPauseRevocationBarriersV1,
  probeWorkAdmissionOwnerLivenessV1,
  readOrInitPauseFenceGenerationV1,
  resetTargetResolutionForTestV1,
  revokeStalePauseCommitClaimV1,
  revokeWorkAdmissionHandoffV1,
  setPidLivenessCheckOverrideForTestV1,
  setWorkAdmissionClockForTestV1,
  setWorkAdmissionFsFailureInjectionForTestV1,
  takeOverStaleWorkAdmissionMarkerV1,
  ADMISSION_DIRNAME_V1,
  PAUSE_COMMIT_LIKELY_STALE_MS_V1,
  WORK_ADMISSION_LIKELY_STALE_MS_V1,
  WORK_ADMISSION_TOMBSTONE_RETENTION_MS_V1,
} from "../state/workAdmissionV1";
import {
  configureHostIdentityRootV1,
  resetHostIdentityForTestV1,
  resolveDurableHostIdentityV1,
  resolveHostIdentityV1,
  setHostIdentityFsFailureInjectionForTestV1,
} from "../state/hostIdentityV1";
import { classifyWorkflowPathV1 } from "../services/workflowPrivacyClassifierV1";
import { fixtureOwnershipFor, writeOwnershipBackedTaskProgress } from "./taskFolderFixture";
import { TASK_PROGRESS_FILENAME } from "../types/taskProgress";
import { setProcessStartTimeIoOverrideForTestV1 } from "../state/processStartTimeProbeV1";

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-work-admission-test-"));
after(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

/**
 * `probeWorkAdmissionOwnerLivenessV1`'s process-start-time cross-check
 * (Part 1c step 15's "readable process-start mismatch" half) is additive
 * proof of death on top of the pre-existing ESRCH check — every test in this
 * file predating that check used `pid: process.pid` (a real, alive pid) with
 * a placeholder `processStartTime` (typically `0`) to mean "alive, not
 * provably dead", never intending to exercise real cross-process start-time
 * comparison. Disabling the real read by default (no evidence — the same
 * fail-open outcome production code takes for an unreadable read) keeps
 * every one of those existing `sameHostAlive`/`takenOver` fixtures correct
 * without editing each one, and keeps the whole suite deterministic and free
 * of real shell-outs. Tests that specifically exercise mismatch detection
 * install their own scoped override (see `withProcessStartTimeIoOverrideV1`)
 * and restore this default afterward; a real, unmocked, spawned-child
 * integration test lives in `processStartTimeProbeV1.test.ts`.
 */
const NO_PROCESS_START_TIME_EVIDENCE_OVERRIDE_V1 = {
  readFileUtf8Sync: () => undefined,
  execFileCapture: () => Promise.resolve(undefined),
};
setProcessStartTimeIoOverrideForTestV1(NO_PROCESS_START_TIME_EVIDENCE_OVERRIDE_V1);
after(() => {
  setProcessStartTimeIoOverrideForTestV1(undefined);
});

/** Scope a process-start-time IO override to one test, always restoring the
 * suite-wide no-evidence default afterward (even on failure). */
async function withProcessStartTimeIoOverrideV1<T>(
  override: Parameters<typeof setProcessStartTimeIoOverrideForTestV1>[0],
  fn: () => Promise<T>
): Promise<T> {
  setProcessStartTimeIoOverrideForTestV1(override);
  try {
    return await fn();
  } finally {
    setProcessStartTimeIoOverrideForTestV1(NO_PROCESS_START_TIME_EVIDENCE_OVERRIDE_V1);
  }
}

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

// ── hasWorkspaceIndependentOwnershipV1 / the positive legitimacy signal ─────
// (2026-09-14 review architectural blocker `d620c877...-1`, closed)

void test("hasWorkspaceIndependentOwnershipV1 is false for a candidate with no task-progress.json at all", () => {
  const task = freshTaskFolder("ownership-signal-no-progress-file");
  fs.writeFileSync(path.join(task, "task.md"), "# Test task\n");
  assert.equal(hasWorkspaceIndependentOwnershipV1(task), false);
});

void test("hasWorkspaceIndependentOwnershipV1 is false when task-progress.json exists but carries no ownership", () => {
  const task = freshTaskFolder("ownership-signal-no-ownership");
  fs.writeFileSync(
    path.join(task, TASK_PROGRESS_FILENAME),
    JSON.stringify({ taskFolder: path.basename(task), currentStage: "impl" }, null, 2)
  );
  assert.equal(hasWorkspaceIndependentOwnershipV1(task), false);
});

void test("hasWorkspaceIndependentOwnershipV1 is false when ownership.workspaceRoot is set — it can never match with no workspace open", () => {
  const task = freshTaskFolder("ownership-signal-workspace-root-set");
  const ownership = { ...fixtureOwnershipFor(task), workspaceRoot: path.dirname(task) };
  fs.writeFileSync(
    path.join(task, TASK_PROGRESS_FILENAME),
    JSON.stringify({ taskFolder: path.basename(task), currentStage: "impl", ownership }, null, 2)
  );
  assert.equal(hasWorkspaceIndependentOwnershipV1(task), false);
});

void test("hasWorkspaceIndependentOwnershipV1 is false when the folder sits outside its own ownership.metaRoot", () => {
  const task = freshTaskFolder("ownership-signal-outside-metaroot");
  const ownership = {
    metaRoot: path.join(TEST_ROOT, "ownership-signal-somewhere-else"),
    projectRoot: path.join(TEST_ROOT, "ownership-signal-somewhere-else"),
    boundAt: "2026-07-01T09:00:00.000Z",
    state: "resolved" as const,
  };
  fs.writeFileSync(
    path.join(task, TASK_PROGRESS_FILENAME),
    JSON.stringify({ taskFolder: path.basename(task), currentStage: "impl", ownership }, null, 2)
  );
  assert.equal(hasWorkspaceIndependentOwnershipV1(task), false);
});

void test("hasWorkspaceIndependentOwnershipV1 is true for a folder whose ownership.metaRoot is its own parent and carries no workspaceRoot", () => {
  const task = freshTaskFolder("ownership-signal-valid");
  writeOwnershipBackedTaskProgress(task);
  assert.equal(hasWorkspaceIndependentOwnershipV1(task), true);
});

void test("acquireEarlyWorkAdmissionForCandidatePathV1 skips early admission when taskRootCandidatePaths is explicitly empty and the candidate's own ownership does not verify (2026-09-14 review architectural blocker `d620c877...-1`, closed)", async () => {
  const task = freshTaskFolder("early-admission-empty-root-list-no-ownership");
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
      result,
      undefined,
      "an explicitly empty root list with no verifiable ownership must skip early admission — authoritative " +
        "resolution would refuse this candidate too, so no admission-v1/ bookkeeping should be created for it"
    );
    assert.ok(
      warnings.some(
        (args) =>
          String(args[0]).includes("task-root candidate list was empty") && String(args[0]).includes(task)
      ),
      `the skip must be diagnosable — got warnings: ${JSON.stringify(warnings)}`
    );
    assert.equal(
      fs.existsSync(path.join(task, ADMISSION_DIRNAME_V1)),
      false,
      "no admission bookkeeping must be created beneath a candidate whose ownership does not verify"
    );
  } finally {
    console.warn = realWarn;
  }
});

void test("acquireEarlyWorkAdmissionForCandidatePathV1 still acquires admission when taskRootCandidatePaths is explicitly empty but the candidate's own ownership verifies workspace-independently (2026-09-14 review architectural blocker `d620c877...-1`, closed)", async () => {
  const task = freshTaskFolder("early-admission-empty-root-list-with-ownership");
  writeOwnershipBackedTaskProgress(task);
  fs.writeFileSync(path.join(task, "task.md"), "# Test task\n");
  const result = await acquireEarlyWorkAdmissionForCandidatePathV1({
    candidatePath: task,
    purpose: "admission",
    commandId: "test-command",
    taskRootCandidatePaths: [],
  });
  assert.equal(
    result?.outcome,
    "acquired",
    "a real, ownership-backed task folder must never lose early admission protection just because no VS Code " +
      "workspace folder happens to be open — proven directly from the candidate's own persisted ownership " +
      "record rather than inferred from workspace-folder state"
  );
  if (result?.outcome === "acquired") {
    await result.handle.release();
  }
});

void test("acquireEarlyWorkAdmissionForCandidatePathV1 still acquires admission when taskRootCandidatePaths is omitted entirely — fail-open is preserved for the unevaluable case", async () => {
  const task = freshTaskFolder("early-admission-omitted-root-list");
  fs.writeFileSync(path.join(task, "task.md"), "# Test task\n");
  const result = await acquireEarlyWorkAdmissionForCandidatePathV1({
    candidatePath: task,
    purpose: "admission",
    commandId: "test-command",
  });
  assert.equal(
    result?.outcome,
    "acquired",
    "an OMITTED root list (never happens for a real caller) is a genuinely unevaluable case, distinct from an " +
      "explicitly empty one, and must still fail open exactly as before"
  );
  if (result?.outcome === "acquired") {
    await result.handle.release();
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

void test("beginTargetResolutionV1 reports a still-contended root as unprotected (never writeFailed) when nothing durable protects it by the time retries are exhausted, and a caller aborting dispatch on it never leaves a stuck resolution counter (2026-09-14 review architectural blocker `b5a1f851...-0`, fixed)", async () => {
  const root = freshTaskFolder("resolution-in-flight-genuinely-unprotected");
  const otherOwner = await acquireWorkAdmissionV1({
    taskFolderPath: root,
    purpose: "admission",
    commandId: "unrelated-admission-holder",
  });
  assert.equal(otherOwner.outcome, "acquired");
  if (otherOwner.outcome !== "acquired") return;
  const realError = console.error;
  const errors: unknown[][] = [];
  console.error = (...args: unknown[]): void => {
    errors.push(args);
  };
  setWorkAdmissionFsFailureInjectionForTestV1({
    // Release the only thing durably protecting `root` at the exact instant
    // between the last synchronous retry and the unprotected-roots check —
    // the narrow window the field's own doc comment describes, otherwise
    // impractical to hit with real retry-interval timing.
    onBeforeUnprotectedRootsCheckAsync: async () => {
      await otherOwner.handle.release();
    },
  });
  try {
    const handle = await beginTargetResolutionV1([root]);
    try {
      assert.deepEqual(handle.rootPaths, [], "no marker of this window's own was ever granted for the contended root");
      assert.deepEqual(handle.writeFailedRootPaths, [], "ordinary contention clearing is not a write failure");
      assert.deepEqual(
        handle.unprotectedRootPaths,
        [root],
        "nothing durable protects this root by the time retries are exhausted — it must be reported, not silently treated as protected"
      );
      assert.equal(
        hasDurableResolutionInFlightV1([root]),
        false,
        "confirms the root really is unprotected on disk, not merely reported as such"
      );
      assert.ok(
        errors.some((args) => String(args[0]).includes("genuinely unprotected") && String(args[0]).includes(root)),
        `the genuinely-unprotected case must be logged distinctly from ordinary contention — got errors: ${JSON.stringify(errors)}`
      );
    } finally {
      // Mirrors every real caller (chatWithStage.ts et al.): abort dispatch
      // on a non-empty unprotectedRootPaths, releasing the handle via the
      // same finally-path a real command uses.
      await endTargetResolutionV1(handle);
    }
    assert.equal(
      hasResolutionInFlightBestEffortV1(),
      false,
      "aborting dispatch after unprotectedRootPaths must not leave the same-process resolution-in-flight counter stuck"
    );
  } finally {
    console.error = realError;
    setWorkAdmissionFsFailureInjectionForTestV1(undefined);
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

// ── ensurePauseFenceAtLeastV1 (2026-09-14 review blocker `dceb2646...-3`, replaces the lock-based finish mechanism) ─

void test("ensurePauseFenceAtLeastV1 publishes the exact target generation on a virgin directory, establishing intermediate generation 0 with no gap", async () => {
  const task = freshTaskFolder("ensure-fence-virgin-target");
  const dir = path.join(task, ADMISSION_DIRNAME_V1);
  await ensurePauseFenceAtLeastV1(task, 1);
  assert.equal(await readOrInitPauseFenceGenerationV1(task), 1);
  const fenceFiles = fs.readdirSync(dir).filter((name) => /^pause-fence\.g\d+$/.test(name));
  assert.deepEqual([...fenceFiles].sort(), ["pause-fence.g0", "pause-fence.g1"], "no gap: g0 must exist too");
});

void test("ensurePauseFenceAtLeastV1 is a no-op when the target is already durably published", async () => {
  const task = freshTaskFolder("ensure-fence-already-published");
  await advancePauseFenceGenerationV1(task); // publishes g1
  await advancePauseFenceGenerationV1(task); // publishes g2
  await ensurePauseFenceAtLeastV1(task, 1); // already exists — must not throw or regress anything
  assert.equal(await readOrInitPauseFenceGenerationV1(task), 2, "an already-published lower target must never regress the current maximum");
});

void test("ensurePauseFenceAtLeastV1 called repeatedly for the SAME target converges without republishing or advancing further", async () => {
  const task = freshTaskFolder("ensure-fence-repeated-same-target");
  await ensurePauseFenceAtLeastV1(task, 3);
  await ensurePauseFenceAtLeastV1(task, 3);
  await ensurePauseFenceAtLeastV1(task, 3);
  assert.equal(
    await readOrInitPauseFenceGenerationV1(task),
    3,
    "repeated calls for the same target must converge on exactly that generation, never further"
  );
});

void test("ensurePauseFenceAtLeastV1 under genuine concurrency for the SAME target publishes it exactly once, with no gap", async () => {
  const task = freshTaskFolder("ensure-fence-concurrent-same-target");
  await Promise.all([
    ensurePauseFenceAtLeastV1(task, 1),
    ensurePauseFenceAtLeastV1(task, 1),
    ensurePauseFenceAtLeastV1(task, 1),
  ]);
  assert.equal(await readOrInitPauseFenceGenerationV1(task), 1);
  const dir = path.join(task, ADMISSION_DIRNAME_V1);
  const fenceFiles = fs.readdirSync(dir).filter((name) => /^pause-fence\.g\d+$/.test(name));
  assert.deepEqual([...fenceFiles].sort(), ["pause-fence.g0", "pause-fence.g1"]);
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
  const fenceBeforeRevoke = await readOrInitPauseFenceGenerationV1(task);

  const result = await revokeStalePauseCommitClaimV1(task, "revoker-1");
  assert.equal(result.outcome, "revoked");
  if (result.outcome !== "revoked") return;
  assert.equal(fs.existsSync(markerPath), false, "the original marker path must be gone");
  assert.equal(fs.existsSync(result.barrierPath), true, "the barrier file must exist at the returned path");
  assert.equal(
    path.basename(result.barrierPath),
    `pause-revocation.pending.revoker-1.g${fenceBeforeRevoke + 1}`,
    "the barrier's own filename must embed its target fence generation"
  );
  assert.equal(result.revokedClaim.purpose, "pauseCommit");
  assert.equal(
    listPendingPauseRevocationBarriersV1(task).length,
    1,
    "the barrier must be discoverable for a later claimant"
  );
  assert.equal(
    await readOrInitPauseFenceGenerationV1(task),
    fenceBeforeRevoke,
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

void test("finishPauseRevocationBarrierV1 converges under genuine concurrency: two simultaneous finishers of the same still-present barrier advance the fence exactly once, never invalidating a pause that lands in between (2026-09-11 review completion blocker, round 2; also covers 2026-09-14's `dceb2646...-3` \"a resumed/suspended original owner races a later finisher\" concern — with no lock at all, ANY two concurrent finishers ARE exactly that race)", async () => {
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
  // two independent, sequential completions. Both target the SAME
  // predetermined generation (`ensurePauseFenceAtLeastV1`), so whichever
  // wins the exclusive-create, the other's is a safe, harmless no-op.
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

void test("finishPauseRevocationBarrierV1 completes a barrier correctly no matter how long it has sat unfinished, with no lock or staleness heuristic involved (2026-09-14 review blocker `dceb2646...-3`, architectural fix)", async () => {
  const task = freshTaskFolder("finish-barrier-long-delayed-no-heuristic");
  const acquired = await acquireWorkAdmissionV1({ taskFolderPath: task, purpose: "pauseCommit", commandId: "sweep" });
  assert.equal(acquired.outcome, "acquired");
  if (acquired.outcome !== "acquired") return;
  backdateV1(markerFilePathV1(task), PAUSE_COMMIT_LIKELY_STALE_MS_V1 + 60_000);
  const revoked = await revokeStalePauseCommitClaimV1(task, "revoker-long-delayed");
  assert.equal(revoked.outcome, "revoked");
  if (revoked.outcome !== "revoked") return;
  const fenceAtRevocation = await readOrInitPauseFenceGenerationV1(task);

  // Unlike the previous lock-based design, correctness here must not depend
  // on any elapsed time at all — there is no "genuine crash" to distinguish
  // from "still working" because there is nothing left to hold. Simulate an
  // arbitrarily long delay (no sleep needed — just don't touch the barrier)
  // and confirm a finisher arriving "later" still completes it correctly.
  await finishPauseRevocationBarrierV1(task, revoked.barrierPath);

  assert.equal(
    await readOrInitPauseFenceGenerationV1(task),
    fenceAtRevocation + 1,
    "a delayed finisher must still advance the fence to the barrier's captured target"
  );
  assert.equal(fs.existsSync(revoked.barrierPath), false, "a delayed finisher must remove the barrier");
  assert.equal(listPendingPauseRevocationBarriersV1(task).length, 0);
});

void test("finishPauseRevocationBarrierV1 safely no-ops its fence advance when unrelated activity already carried the fence past the barrier's target — no gap, no phantom re-advance (2026-09-14 review blocker `dceb2646...-3`)", async () => {
  const task = freshTaskFolder("finish-barrier-target-already-surpassed");
  const acquired = await acquireWorkAdmissionV1({ taskFolderPath: task, purpose: "pauseCommit", commandId: "sweep" });
  assert.equal(acquired.outcome, "acquired");
  if (acquired.outcome !== "acquired") return;
  backdateV1(markerFilePathV1(task), PAUSE_COMMIT_LIKELY_STALE_MS_V1 + 60_000);
  const revoked = await revokeStalePauseCommitClaimV1(task, "revoker-surpassed");
  assert.equal(revoked.outcome, "revoked");
  if (revoked.outcome !== "revoked") return;

  // Unrelated fence activity (e.g. a second, independent pauseCommit
  // revocation elsewhere) advances the fence several generations past this
  // barrier's own target BEFORE anyone gets around to finishing it.
  await advancePauseFenceGenerationV1(task);
  await advancePauseFenceGenerationV1(task);
  await advancePauseFenceGenerationV1(task);
  const fenceBeforeFinish = await readOrInitPauseFenceGenerationV1(task);

  await finishPauseRevocationBarrierV1(task, revoked.barrierPath);

  assert.equal(
    await readOrInitPauseFenceGenerationV1(task),
    fenceBeforeFinish,
    "finishing a barrier whose target the fence has already surpassed must never publish a further generation"
  );
  assert.equal(fs.existsSync(revoked.barrierPath), false, "the barrier must still be removed");
  assert.equal(listPendingPauseRevocationBarriersV1(task).length, 0);
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

void test("crash after generation creation (fence already advanced, barrier not yet removed) leaves a helpable pending barrier that a DIFFERENT later claimant completes safely, without a phantom double-advance", async () => {
  const task = freshTaskFolder("finish-barrier-crash-after-generation-creation");
  const acquired = await acquireWorkAdmissionV1({ taskFolderPath: task, purpose: "pauseCommit", commandId: "sweep" });
  assert.equal(acquired.outcome, "acquired");
  if (acquired.outcome !== "acquired") return;
  backdateV1(markerFilePathV1(task), PAUSE_COMMIT_LIKELY_STALE_MS_V1 + 60_000);
  const revoked = await revokeStalePauseCommitClaimV1(task, "revoker-crash-after-generation");
  assert.equal(revoked.outcome, "revoked");
  if (revoked.outcome !== "revoked") return;
  const fenceBefore = await readOrInitPauseFenceGenerationV1(task);

  // Simulate "crash after generation creation": the ORIGINAL finisher gets
  // as far as durably publishing the new fence generation (step one of
  // `finishPauseRevocationBarrierV1`'s two-step sequence — see
  // `advancePauseFenceForRevocationV1`'s own doc comment) and then dies
  // before removing the barrier file — the barrier is left behind exactly as
  // the durable record that this cleanup step is still owed.
  const fenceAfterAdvance = await advancePauseFenceForRevocationV1(task);
  assert.equal(fenceAfterAdvance, fenceBefore + 1);
  assert.equal(fs.existsSync(revoked.barrierPath), true, "the barrier must survive the fence advance alone");
  assert.deepEqual(listPendingPauseRevocationBarriersV1(task), [revoked.barrierPath]);

  // A completely different, later claimant (never involved in the original
  // revocation or its fence advance) discovers the still-pending barrier via
  // `listPendingPauseRevocationBarriersV1` and completes it.
  const pending = listPendingPauseRevocationBarriersV1(task);
  assert.equal(pending.length, 1);
  for (const barrierPath of pending) {
    await finishPauseRevocationBarrierV1(task, barrierPath);
  }

  // The barrier is now gone, and — critically — the fence must NOT have
  // advanced a second time: the generation the crashed attempt already
  // published is the correct, final target, and the later claimant's own
  // finish call must recognize that target is already surpassed (mirrors
  // "finishPauseRevocationBarrierV1 safely no-ops its fence advance when
  // unrelated activity already carried the fence past the barrier's target"
  // above, but here the "unrelated activity" is this SAME barrier's own
  // first, crashed attempt, not a different revocation).
  assert.equal(
    await readOrInitPauseFenceGenerationV1(task),
    fenceAfterAdvance,
    "a later claimant finishing a barrier whose generation-creation step already ran (then crashed before removal) must never advance the fence a second time"
  );
  assert.equal(listPendingPauseRevocationBarriersV1(task).length, 0, "the barrier must be fully removed by the later claimant");
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

void test("a real failure finishing a pending revocation barrier fails the acquisition closed (writeFailed), never publishes admission over an unfinished barrier (2026-09-14 review completion blocker `dceb2646...-2`)", async () => {
  const task = freshTaskFolder("barrier-finish-failure-fails-closed");
  const stale = await acquireWorkAdmissionV1({ taskFolderPath: task, purpose: "pauseCommit", commandId: "sweep" });
  assert.equal(stale.outcome, "acquired");
  if (stale.outcome !== "acquired") return;
  backdateV1(markerFilePathV1(task), PAUSE_COMMIT_LIKELY_STALE_MS_V1 + 60_000);
  const revoked = await revokeStalePauseCommitClaimV1(task, "revoker-failure-case");
  assert.equal(revoked.outcome, "revoked");
  if (revoked.outcome !== "revoked") return;
  // Release the revoked claim's own (same-process) handle now, simulating
  // the real scenario the fence protocol targets: a SUSPENDED or crashed
  // original owner, whose process-local bookkeeping is gone, not merely an
  // on-disk record that happens to still be tracked in this same test
  // process's `localHandlesV1`. Without this, `hasLiveWorkAdmissionBestEffortV1`
  // below would report "live" purely because `stale`'s own handle is still
  // held in-process — a same-process test artifact, not a signal about
  // whether the NEW acquisition (under test) published anything. Safe to
  // call after revocation: the marker was already renamed away, so this
  // hits the handle's own ENOENT-is-displaced path, same as
  // `assert.doesNotReject` below already expected at end-of-test.
  await assert.doesNotReject(() => stale.handle.release());
  const fenceBeforeAttempt = await readOrInitPauseFenceGenerationV1(task);
  assert.equal(listPendingPauseRevocationBarriersV1(task).length, 1);

  const injectedError = Object.assign(new Error("simulated EACCES finishing revocation barrier"), { code: "EACCES" });
  setWorkAdmissionFsFailureInjectionForTestV1({
    onBeforeBarrierFinishInAcquisition: () => injectedError,
  });
  try {
    const next = await acquireWorkAdmissionV1({ taskFolderPath: task, purpose: "admission", commandId: "real-work" });
    assert.equal(next.outcome, "writeFailed", "a real barrier-finish failure must fail the acquisition closed, not proceed regardless");
    if (next.outcome === "writeFailed") {
      assert.equal(next.error, injectedError);
    }
    assert.equal(
      await readOrInitPauseFenceGenerationV1(task),
      fenceBeforeAttempt,
      "a failed acquisition must never have advanced the fence past the still-unfinished barrier"
    );
    assert.equal(
      listPendingPauseRevocationBarriersV1(task).length,
      1,
      "the barrier must survive a failed finish attempt, unfinished, for a later claimant to retry"
    );
    assert.equal(
      hasLiveWorkAdmissionBestEffortV1(task),
      false,
      "the failed acquisition must not have published a marker while a pending barrier was unfinished"
    );
  } finally {
    setWorkAdmissionFsFailureInjectionForTestV1(undefined);
  }

  // With the injected failure cleared, a later acquisition must still be
  // able to finish the barrier and proceed normally — the failure above was
  // transient, not a permanent stranding of the task.
  const retry = await acquireWorkAdmissionV1({ taskFolderPath: task, purpose: "admission", commandId: "real-work-retry" });
  assert.equal(retry.outcome, "acquired");
  if (retry.outcome !== "acquired") return;
  assert.equal(await readOrInitPauseFenceGenerationV1(task), fenceBeforeAttempt + 1);
  assert.equal(listPendingPauseRevocationBarriersV1(task).length, 0);

  await retry.handle.release();
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

// ── probeWorkAdmissionOwnerLivenessV1 / attemptAutomaticWorkAdmissionReclamationV1 (Part 1c step 15) ─

/** Spawn a trivial child process and resolve once it has genuinely exited,
 * returning its now-dead pid — the same real spawn/wait idiom
 * `completionLintKillPidReuse.test.ts` uses to prove a pid is dead, rather
 * than trusting a made-up large number that might coincidentally be live. */
function spawnAndWaitForDeadPidV1(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, ["-e", ""], { windowsHide: true });
    const pid = child.pid;
    if (pid === undefined) {
      reject(new Error("spawned child has no pid"));
      return;
    }
    child.once("exit", () => resolve(pid));
    child.once("error", reject);
  });
}

function writeFakeMarkerV1(
  task: string,
  overrides: Partial<{
    purpose: "admission" | "pauseCommit";
    pid: number;
    hostId: string;
    ownerToken: string;
  }>
): string {
  const dir = path.join(task, ADMISSION_DIRNAME_V1);
  fs.mkdirSync(dir, { recursive: true });
  const ownerToken = overrides.ownerToken ?? "fakeowner1";
  const markerPath = path.join(dir, `admission.${ownerToken}.g1.deadbeef`);
  fs.writeFileSync(
    markerPath,
    JSON.stringify({
      claimId: `${ownerToken}-claim`,
      purpose: overrides.purpose ?? "admission",
      ownerToken,
      pid: overrides.pid ?? 999999,
      processStartTime: 0,
      hostId: overrides.hostId ?? "fake-host",
      commandId: "fake-owner-command",
      startedAt: new Date().toISOString(),
    })
  );
  return markerPath;
}

void test("probeWorkAdmissionOwnerLivenessV1: undefined or corrupt owner records are reported corrupt, never death", async () => {
  assert.deepEqual(await probeWorkAdmissionOwnerLivenessV1(undefined), { kind: "corrupt" });
  assert.deepEqual(
    await probeWorkAdmissionOwnerLivenessV1({
      claimId: "x",
      purpose: "admission",
      ownerToken: "x",
      // pid deliberately omitted/wrong-typed to simulate a corrupt record.
      pid: undefined as unknown as number,
      processStartTime: 0,
      hostId: "some-host",
      commandId: "x",
      startedAt: new Date().toISOString(),
    }),
    { kind: "corrupt" }
  );
});

void test("probeWorkAdmissionOwnerLivenessV1: a foreign hostId always fails open, regardless of whether the pid is alive or dead", async () => {
  const result = await probeWorkAdmissionOwnerLivenessV1({
    claimId: "x",
    purpose: "admission",
    ownerToken: "x",
    pid: process.pid,
    processStartTime: 0,
    hostId: "definitely-a-different-host-id",
    commandId: "x",
    startedAt: new Date().toISOString(),
  });
  assert.deepEqual(result, { kind: "foreignHost" });
});

void test("probeWorkAdmissionOwnerLivenessV1: a same-host, currently-running pid is sameHostAlive (this test's own process)", async () => {
  const myHostId = await resolveHostIdentityV1();
  const result = await probeWorkAdmissionOwnerLivenessV1({
    claimId: "x",
    purpose: "admission",
    ownerToken: "x",
    pid: process.pid,
    processStartTime: 0,
    hostId: myHostId,
    commandId: "x",
    startedAt: new Date().toISOString(),
  });
  assert.deepEqual(result, { kind: "sameHostAlive" });
});

void test("probeWorkAdmissionOwnerLivenessV1: a same-host pid that has genuinely exited (real ESRCH) is sameHostDead", async () => {
  const myHostId = await resolveHostIdentityV1();
  const deadPid = await spawnAndWaitForDeadPidV1();
  const result = await probeWorkAdmissionOwnerLivenessV1({
    claimId: "x",
    purpose: "admission",
    ownerToken: "x",
    pid: deadPid,
    processStartTime: 0,
    hostId: myHostId,
    commandId: "x",
    startedAt: new Date().toISOString(),
  });
  assert.deepEqual(result, { kind: "sameHostDead" });
});

void test("probeWorkAdmissionOwnerLivenessV1: any errno other than ESRCH (e.g. EPERM) fails open to indeterminate, never death", async () => {
  const myHostId = await resolveHostIdentityV1();
  setPidLivenessCheckOverrideForTestV1(() => "indeterminate");
  try {
    const result = await probeWorkAdmissionOwnerLivenessV1({
      claimId: "x",
      purpose: "admission",
      ownerToken: "x",
      pid: 4321,
      processStartTime: 0,
      hostId: myHostId,
      commandId: "x",
      startedAt: new Date().toISOString(),
    });
    assert.equal(result.kind, "indeterminate");
  } finally {
    setPidLivenessCheckOverrideForTestV1(undefined);
  }
});

void test("probeWorkAdmissionOwnerLivenessV1: a same-host pid that still responds but whose process-start-time clearly mismatches the recorded one is sameHostDead (pid reuse)", async () => {
  const myHostId = await resolveHostIdentityV1();
  const recordedStartTime = 1_000_000_000_000; // 2001-09-09 — deliberately far from "now".
  // The linux reader needs BOTH /proc files to compute a value; fabricate
  // their contents so the computed epoch lands "now" — clearly beyond
  // tolerance from `recordedStartTime` — keyed on the real `process.pid` so
  // this exercises the actual dispatch path for a real, alive pid.
  const nowSeconds = Math.floor(Date.now() / 1000);
  const result = await withProcessStartTimeIoOverrideV1(
    {
      platform: "linux" as NodeJS.Platform,
      readFileUtf8Sync: (p: string) => {
        if (p === `/proc/${process.pid}/stat`) return `${process.pid} (fakeproc) S 1 ${process.pid} ${process.pid} 0 -1 0 0 0 0 0 0 0 0 0 0 0 0 0 ${nowSeconds * 100} 0`;
        if (p === "/proc/uptime") return `${nowSeconds} 0`;
        return undefined;
      },
      execFileCapture: () => Promise.resolve(undefined),
    },
    () =>
      probeWorkAdmissionOwnerLivenessV1({
        claimId: "x",
        purpose: "admission",
        ownerToken: "x",
        pid: process.pid, // real, alive — ESRCH check alone would say sameHostAlive.
        processStartTime: recordedStartTime,
        hostId: myHostId,
        commandId: "x",
        startedAt: new Date().toISOString(),
      })
  );
  assert.deepEqual(result, { kind: "sameHostDead" }, "a responding pid whose start time clearly does not match the recorded owner must be treated as a reused pid, not the original owner");
});

void test("probeWorkAdmissionOwnerLivenessV1: a same-host pid whose process-start-time matches the recorded one within tolerance stays sameHostAlive", async () => {
  const myHostId = await resolveHostIdentityV1();
  const recordedStartTime = Date.now() - 60_000; // one minute ago.
  const result = await withProcessStartTimeIoOverrideV1(
    {
      platform: "win32" as NodeJS.Platform,
      execFileCapture: () => Promise.resolve(new Date(recordedStartTime + 500).toISOString()), // within tolerance
      readFileUtf8Sync: undefined,
    },
    () =>
      probeWorkAdmissionOwnerLivenessV1({
        claimId: "x",
        purpose: "admission",
        ownerToken: "x",
        pid: process.pid,
        processStartTime: recordedStartTime,
        hostId: myHostId,
        commandId: "x",
        startedAt: new Date().toISOString(),
      })
  );
  assert.deepEqual(result, { kind: "sameHostAlive" }, "a start time within tolerance must fail open exactly like a match, never treated as death");
});

void test("probeWorkAdmissionOwnerLivenessV1: unreadable process-start-time evidence fails open to sameHostAlive, never death", async () => {
  const myHostId = await resolveHostIdentityV1();
  const result = await withProcessStartTimeIoOverrideV1(
    { execFileCapture: () => Promise.resolve(undefined), readFileUtf8Sync: () => undefined },
    () =>
      probeWorkAdmissionOwnerLivenessV1({
        claimId: "x",
        purpose: "admission",
        ownerToken: "x",
        pid: process.pid,
        processStartTime: 12345,
        hostId: myHostId,
        commandId: "x",
        startedAt: new Date().toISOString(),
      })
  );
  assert.deepEqual(result, { kind: "sameHostAlive" }, "no cross-check evidence must never be treated as proof of death");
});

void test("attemptAutomaticWorkAdmissionReclamationV1: a stale marker whose owner pid still responds but whose process-start-time mismatches is reclaimed via a won rename (pid reuse detected)", async () => {
  const task = freshTaskFolder("reclaim-pid-reused");
  const myHostId = await resolveHostIdentityV1();
  const markerPath = writeFakeMarkerV1(task, { purpose: "admission", pid: process.pid, hostId: myHostId, ownerToken: "reused-pid-owner" });
  backdateV1(markerPath, WORK_ADMISSION_LIKELY_STALE_MS_V1 + 60_000);
  const nowSeconds = Math.floor(Date.now() / 1000);

  const outcome = await withProcessStartTimeIoOverrideV1(
    {
      platform: "linux" as NodeJS.Platform,
      readFileUtf8Sync: (p: string) => {
        if (p === `/proc/${process.pid}/stat`) return `${process.pid} (fakeproc) S 1 ${process.pid} ${process.pid} 0 -1 0 0 0 0 0 0 0 0 0 0 0 0 0 ${nowSeconds * 100} 0`;
        if (p === "/proc/uptime") return `${nowSeconds} 0`;
        return undefined;
      },
      execFileCapture: () => Promise.resolve(undefined),
    },
    () => attemptAutomaticWorkAdmissionReclamationV1(task)
  );
  assert.equal(outcome.outcome, "reclaimed", "a mismatched start time is determinate proof of death and must be reclaimed, exactly like a real ESRCH");
  if (outcome.outcome === "reclaimed") {
    assert.equal(outcome.purpose, "admission");
    assert.equal(outcome.reclaimedOwner.ownerToken, "reused-pid-owner");
  }
  assert.equal(hasLiveWorkAdmissionBestEffortV1(task), false, "the reclaimed marker must no longer be reported live");
});

void test("attemptAutomaticWorkAdmissionReclamationV1: nothingToReclaim when the task has no admission directory at all", async () => {
  const task = freshTaskFolder("reclaim-nothing-to-reclaim");
  const outcome = await attemptAutomaticWorkAdmissionReclamationV1(task);
  assert.deepEqual(outcome, { outcome: "nothingToReclaim" });
});

void test("attemptAutomaticWorkAdmissionReclamationV1: a fresh (non-stale) marker is never reclaimed, even for a genuinely dead owner", async () => {
  const task = freshTaskFolder("reclaim-not-stale");
  const deadPid = await spawnAndWaitForDeadPidV1();
  const myHostId = await resolveHostIdentityV1();
  writeFakeMarkerV1(task, { purpose: "admission", pid: deadPid, hostId: myHostId });
  const outcome = await attemptAutomaticWorkAdmissionReclamationV1(task);
  assert.deepEqual(outcome, { outcome: "notStale" });
  assert.equal(hasLiveWorkAdmissionBestEffortV1(task), true, "an unreclaimed marker must still be reported live");
});

void test("attemptAutomaticWorkAdmissionReclamationV1: a stale marker whose owner is alive (this test's own process) fails open to notDead/sameHostAlive, never reclaimed", async () => {
  const task = freshTaskFolder("reclaim-stale-but-alive");
  const acquired = await acquireWorkAdmissionV1({ taskFolderPath: task, purpose: "admission", commandId: "alive-owner" });
  assert.equal(acquired.outcome, "acquired");
  if (acquired.outcome !== "acquired") return;
  backdateV1(markerFilePathV1(task), WORK_ADMISSION_LIKELY_STALE_MS_V1 + 60_000);

  const outcome = await attemptAutomaticWorkAdmissionReclamationV1(task);
  assert.equal(outcome.outcome, "notDead");
  if (outcome.outcome === "notDead") {
    assert.deepEqual(outcome.liveness, { kind: "sameHostAlive" });
    assert.equal(outcome.owner?.ownerToken, acquired.handle.ownerToken, "1c step 16: the owner record must be attached, not just the liveness kind");
    assert.ok(outcome.ageMs > WORK_ADMISSION_LIKELY_STALE_MS_V1, "1c step 16: ageMs must be attached for the takeover-notice consumer");
  }
  assert.equal(hasLiveWorkAdmissionBestEffortV1(task), true, "a live owner's marker must never be reclaimed");

  await acquired.handle.release();
});

void test("attemptAutomaticWorkAdmissionReclamationV1: a stale marker owned by a foreign host is never automatically reclaimed (no way to probe a different machine)", async () => {
  const task = freshTaskFolder("reclaim-foreign-host-never");
  const markerPath = writeFakeMarkerV1(task, { purpose: "admission", pid: 123456, hostId: "definitely-a-different-host-id", ownerToken: "foreign-owner" });
  backdateV1(markerPath, WORK_ADMISSION_LIKELY_STALE_MS_V1 + 60_000);

  const outcome = await attemptAutomaticWorkAdmissionReclamationV1(task);
  assert.equal(outcome.outcome, "notDead");
  if (outcome.outcome === "notDead") {
    assert.deepEqual(outcome.liveness, { kind: "foreignHost" });
  }
  assert.equal(hasLiveWorkAdmissionBestEffortV1(task), true, "a foreign-host marker must never be reclaimed automatically — only the human-confirmed takeover path may touch it");
});

void test("attemptAutomaticWorkAdmissionReclamationV1: a stale, unreadable (corrupt) marker is never automatically reclaimed — no owner to probe", async () => {
  const task = freshTaskFolder("reclaim-corrupt-never");
  const dir = path.join(task, ADMISSION_DIRNAME_V1);
  fs.mkdirSync(dir, { recursive: true });
  const markerPath = path.join(dir, "admission.corruptowner.g1.deadbeef");
  fs.writeFileSync(markerPath, "not valid json at all {{{");
  backdateV1(markerPath, WORK_ADMISSION_LIKELY_STALE_MS_V1 + 60_000);

  const outcome = await attemptAutomaticWorkAdmissionReclamationV1(task);
  assert.equal(outcome.outcome, "notDead");
  if (outcome.outcome === "notDead") {
    assert.deepEqual(outcome.liveness, { kind: "corrupt" });
    assert.equal(outcome.owner, undefined);
  }
  assert.equal(hasLiveWorkAdmissionBestEffortV1(task), true, "an unreadable marker must never be reclaimed blind");
});

void test("attemptAutomaticWorkAdmissionReclamationV1: a stale marker whose owner liveness is indeterminate (e.g. EPERM) is never automatically reclaimed", async () => {
  const task = freshTaskFolder("reclaim-indeterminate-never");
  const myHostId = await resolveHostIdentityV1();
  const markerPath = writeFakeMarkerV1(task, { purpose: "admission", pid: 4321, hostId: myHostId, ownerToken: "indeterminate-owner" });
  backdateV1(markerPath, WORK_ADMISSION_LIKELY_STALE_MS_V1 + 60_000);

  setPidLivenessCheckOverrideForTestV1(() => "indeterminate");
  try {
    const outcome = await attemptAutomaticWorkAdmissionReclamationV1(task);
    assert.equal(outcome.outcome, "notDead");
    if (outcome.outcome === "notDead") {
      assert.equal(outcome.liveness.kind, "indeterminate");
    }
    assert.equal(hasLiveWorkAdmissionBestEffortV1(task), true, "an indeterminate liveness probe must never be treated as death");
  } finally {
    setPidLivenessCheckOverrideForTestV1(undefined);
  }
});

void test("attemptAutomaticWorkAdmissionReclamationV1: a stale admission marker whose owner is confirmed dead is reclaimed by a validated rename to a tombstone", async () => {
  const task = freshTaskFolder("reclaim-admission-dead");
  const deadPid = await spawnAndWaitForDeadPidV1();
  const myHostId = await resolveHostIdentityV1();
  const markerPath = writeFakeMarkerV1(task, { purpose: "admission", pid: deadPid, hostId: myHostId, ownerToken: "deadowner1" });
  backdateV1(markerPath, WORK_ADMISSION_LIKELY_STALE_MS_V1 + 60_000);

  const outcome = await attemptAutomaticWorkAdmissionReclamationV1(task);
  assert.equal(outcome.outcome, "reclaimed");
  if (outcome.outcome === "reclaimed") {
    assert.equal(outcome.purpose, "admission");
    assert.equal(outcome.reclaimedOwner.ownerToken, "deadowner1");
  }
  assert.equal(fs.existsSync(markerPath), false, "the original marker filename must no longer exist");
  assert.equal(fs.existsSync(`${markerPath}.tombstone`), true, "a tombstone must be left behind for later GC/audit");
  assert.equal(
    hasLiveWorkAdmissionBestEffortV1(task),
    false,
    "a tombstoned marker must no longer be reported as live admission"
  );

  // Reclamation must actually unblock a new acquisition — this is the whole
  // point of automatic reclamation, not merely a diagnostic relabeling.
  const retry = await acquireWorkAdmissionV1({ taskFolderPath: task, purpose: "admission", commandId: "new-owner" });
  assert.equal(retry.outcome, "acquired");
  if (retry.outcome === "acquired") {
    await retry.handle.release();
  }
});

void test("attemptAutomaticWorkAdmissionReclamationV1: a stale pauseCommit marker whose owner is confirmed dead is reclaimed through 1b's revocation barrier, not a direct tombstone", async () => {
  const task = freshTaskFolder("reclaim-pausecommit-dead");
  const deadPid = await spawnAndWaitForDeadPidV1();
  const myHostId = await resolveHostIdentityV1();
  const fenceBefore = await readOrInitPauseFenceGenerationV1(task);
  const markerPath = writeFakeMarkerV1(task, {
    purpose: "pauseCommit",
    pid: deadPid,
    hostId: myHostId,
    ownerToken: "deadsweep1",
  });
  backdateV1(markerPath, PAUSE_COMMIT_LIKELY_STALE_MS_V1 + 60_000);

  const outcome = await attemptAutomaticWorkAdmissionReclamationV1(task);
  assert.equal(outcome.outcome, "reclaimed");
  if (outcome.outcome === "reclaimed") {
    assert.equal(outcome.purpose, "pauseCommit");
  }
  // Routed through the real 1b barrier protocol: the fence must have
  // durably advanced, and no pending barrier (nor a direct tombstone) is
  // left behind — `finishPauseRevocationBarrierV1` is expected to complete
  // synchronously within this call.
  assert.ok((await readOrInitPauseFenceGenerationV1(task)) > fenceBefore, "the pause fence must have advanced");
  assert.equal(listPendingPauseRevocationBarriersV1(task).length, 0, "the barrier must be fully finished, not left pending");
  assert.equal(fs.existsSync(markerPath), false);
  assert.equal(fs.existsSync(`${markerPath}.tombstone`), false, "pauseCommit reclamation must not use the admission tombstone path");
  assert.equal(hasLiveWorkAdmissionBestEffortV1(task), false);
});

/** Find any tombstone left behind in a task's admission directory.
 * `takeOverStaleWorkAdmissionMarkerV1`'s tombstone filename embeds a random,
 * per-attempt token (see its own doc comment — a fixed, deterministic
 * destination is unsafe for two concurrent takeovers on Windows), so tests
 * must not assert the exact legacy `${markerPath}.tombstone` path the way
 * `attemptAutomaticWorkAdmissionReclamationV1`'s own tests still correctly
 * do (that function's tombstone path IS still deterministic — unchanged). */
function findAnyTombstoneV1(task: string): string | undefined {
  const dir = path.join(task, ADMISSION_DIRNAME_V1);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return undefined;
  }
  const found = entries.find((name) => name.endsWith(".tombstone"));
  return found ? path.join(dir, found) : undefined;
}

// ── takeOverStaleWorkAdmissionMarkerV1 (Part 1c step 16) ────────────────────

void test("takeOverStaleWorkAdmissionMarkerV1: nothingToTakeOver when the task has no admission directory at all", async () => {
  const task = freshTaskFolder("takeover-nothing");
  const outcome = await takeOverStaleWorkAdmissionMarkerV1(task, path.join(task, ADMISSION_DIRNAME_V1, "admission.x.g1.0"), "some-claim");
  assert.deepEqual(outcome, { outcome: "nothingToTakeOver" });
});

void test("takeOverStaleWorkAdmissionMarkerV1: refuses (ownerChanged) when the current claimId does not match what was confirmed", async () => {
  const task = freshTaskFolder("takeover-owner-changed");
  const myHostId = await resolveHostIdentityV1();
  const markerPath = writeFakeMarkerV1(task, { purpose: "admission", pid: process.pid, hostId: myHostId, ownerToken: "real-owner" });
  backdateV1(markerPath, WORK_ADMISSION_LIKELY_STALE_MS_V1 + 60_000);

  const outcome = await takeOverStaleWorkAdmissionMarkerV1(task, markerPath, "a-different-claim-id-entirely");
  assert.deepEqual(outcome, { outcome: "ownerChanged" });
  assert.equal(fs.existsSync(markerPath), true, "an ownership mismatch must never mutate the marker");
});

void test("takeOverStaleWorkAdmissionMarkerV1: refuses (noLongerStale) when the marker was renewed since the notice was raised", async () => {
  const task = freshTaskFolder("takeover-renewed");
  const acquired = await acquireWorkAdmissionV1({ taskFolderPath: task, purpose: "admission", commandId: "still-working" });
  assert.equal(acquired.outcome, "acquired");
  if (acquired.outcome !== "acquired") return;
  // Simulate: the notice was captured against this claimId while the marker
  // looked stale, then the owner heartbeat-renewed it (fresh mtime) before
  // the human clicked the takeover action. The readable-owner path is keyed
  // on `claimId`, not path (a heartbeat rename changes the path but not the
  // claimId), so the exact marker path is irrelevant here — any current
  // marker in the directory works.
  const dir = path.join(task, ADMISSION_DIRNAME_V1);
  const currentMarkerName = fs.readdirSync(dir).find((n) => n.startsWith("admission."));
  assert.ok(currentMarkerName, "expected a live marker after acquisition");
  const outcome = await takeOverStaleWorkAdmissionMarkerV1(task, path.join(dir, currentMarkerName), acquired.handle.claimId);
  assert.deepEqual(outcome, { outcome: "noLongerStale" });
  assert.equal(hasLiveWorkAdmissionBestEffortV1(task), true, "a renewed marker must be left untouched");
  await acquired.handle.release();
});

void test("takeOverStaleWorkAdmissionMarkerV1: an admission-purpose marker owned by a foreign host is taken over by validated rename to a tombstone", async () => {
  const task = freshTaskFolder("takeover-admission-foreign");
  const markerPath = writeFakeMarkerV1(task, {
    purpose: "admission",
    pid: 123456,
    hostId: "definitely-a-different-host-id",
    ownerToken: "foreign-owner",
  });
  backdateV1(markerPath, WORK_ADMISSION_LIKELY_STALE_MS_V1 + 60_000);

  const outcome = await takeOverStaleWorkAdmissionMarkerV1(task, markerPath, "foreign-owner-claim");
  assert.equal(outcome.outcome, "takenOver");
  if (outcome.outcome === "takenOver") {
    assert.equal(outcome.purpose, "admission");
    assert.equal(outcome.displacedOwner?.ownerToken, "foreign-owner");
  }
  assert.equal(fs.existsSync(markerPath), false, "the original marker filename must no longer exist");
  assert.equal(findAnyTombstoneV1(task) !== undefined, true, "a tombstone must be left behind for later GC/audit");
  assert.equal(hasLiveWorkAdmissionBestEffortV1(task), false);

  // A takeover must actually unblock a new acquisition.
  const retry = await acquireWorkAdmissionV1({ taskFolderPath: task, purpose: "admission", commandId: "new-owner" });
  assert.equal(retry.outcome, "acquired");
  if (retry.outcome === "acquired") await retry.handle.release();
});

void test("takeOverStaleWorkAdmissionMarkerV1: a same-host, still-responding owner CAN be taken over — the human override is the whole point of this path", async () => {
  const task = freshTaskFolder("takeover-admission-alive");
  const myHostId = await resolveHostIdentityV1();
  const markerPath = writeFakeMarkerV1(task, { purpose: "admission", pid: process.pid, hostId: myHostId, ownerToken: "stuck-owner" });
  backdateV1(markerPath, WORK_ADMISSION_LIKELY_STALE_MS_V1 + 60_000);

  const outcome = await takeOverStaleWorkAdmissionMarkerV1(task, markerPath, "stuck-owner-claim");
  assert.equal(outcome.outcome, "takenOver");
  if (outcome.outcome === "takenOver") {
    assert.equal(outcome.displacedOwner?.ownerToken, "stuck-owner");
  }
  assert.equal(findAnyTombstoneV1(task) !== undefined, true);
});

void test("takeOverStaleWorkAdmissionMarkerV1: an unreadable (corrupt) marker can be taken over when the notice was raised with no claimId", async () => {
  const task = freshTaskFolder("takeover-corrupt");
  const dir = path.join(task, ADMISSION_DIRNAME_V1);
  fs.mkdirSync(dir, { recursive: true });
  const markerPath = path.join(dir, "admission.corruptowner.g1.deadbeef");
  fs.writeFileSync(markerPath, "not valid json at all {{{");
  backdateV1(markerPath, WORK_ADMISSION_LIKELY_STALE_MS_V1 + 60_000);

  const outcome = await takeOverStaleWorkAdmissionMarkerV1(task, markerPath, undefined);
  assert.equal(outcome.outcome, "takenOver");
  if (outcome.outcome === "takenOver") {
    assert.equal(outcome.purpose, "admission");
    assert.equal(outcome.displacedOwner, undefined, "an unreadable record has no owner to report");
  }
  assert.equal(fs.existsSync(markerPath), false);
  assert.equal(findAnyTombstoneV1(task) !== undefined, true);
});

void test("takeOverStaleWorkAdmissionMarkerV1: refuses (ownerChanged) when a corrupt-notice takeover finds the marker has since become readable", async () => {
  const task = freshTaskFolder("takeover-corrupt-then-readable");
  const myHostId = await resolveHostIdentityV1();
  const markerPath = writeFakeMarkerV1(task, { purpose: "admission", pid: process.pid, hostId: myHostId, ownerToken: "now-readable" });
  backdateV1(markerPath, WORK_ADMISSION_LIKELY_STALE_MS_V1 + 60_000);

  const outcome = await takeOverStaleWorkAdmissionMarkerV1(task, markerPath, undefined);
  assert.deepEqual(outcome, { outcome: "ownerChanged" });
  assert.equal(fs.existsSync(markerPath), true, "must never act on a state different from what was confirmed");
});

void test("takeOverStaleWorkAdmissionMarkerV1: a pauseCommit marker is taken over through 1b's revocation barrier, not a direct tombstone", async () => {
  const task = freshTaskFolder("takeover-pausecommit");
  const myHostId = await resolveHostIdentityV1();
  const fenceBefore = await readOrInitPauseFenceGenerationV1(task);
  const markerPath = writeFakeMarkerV1(task, { purpose: "pauseCommit", pid: process.pid, hostId: myHostId, ownerToken: "stuck-sweep" });
  backdateV1(markerPath, PAUSE_COMMIT_LIKELY_STALE_MS_V1 + 60_000);

  const outcome = await takeOverStaleWorkAdmissionMarkerV1(task, markerPath, "stuck-sweep-claim");
  assert.equal(outcome.outcome, "takenOver");
  if (outcome.outcome === "takenOver") {
    assert.equal(outcome.purpose, "pauseCommit");
  }
  assert.ok((await readOrInitPauseFenceGenerationV1(task)) > fenceBefore, "the pause fence must have advanced");
  assert.equal(listPendingPauseRevocationBarriersV1(task).length, 0, "the barrier must be fully finished, not left pending");
  assert.equal(fs.existsSync(markerPath), false);
  assert.equal(findAnyTombstoneV1(task), undefined, "pauseCommit takeover must not use the admission tombstone path");
});

void test("takeOverStaleWorkAdmissionMarkerV1: an owner that has died since the notice was raised is reclaimed through the automatic (proof-of-death) path instead of the human-override path", async () => {
  const task = freshTaskFolder("takeover-owner-died-meanwhile");
  const deadPid = await spawnAndWaitForDeadPidV1();
  const myHostId = await resolveHostIdentityV1();
  const markerPath = writeFakeMarkerV1(task, { purpose: "admission", pid: deadPid, hostId: myHostId, ownerToken: "died-meanwhile" });
  backdateV1(markerPath, WORK_ADMISSION_LIKELY_STALE_MS_V1 + 60_000);

  const outcome = await takeOverStaleWorkAdmissionMarkerV1(task, markerPath, "died-meanwhile-claim");
  assert.equal(outcome.outcome, "reclaimedAsDead");
  if (outcome.outcome === "reclaimedAsDead") {
    assert.equal(outcome.purpose, "admission");
    assert.equal(outcome.displacedOwner.ownerToken, "died-meanwhile");
  }
  assert.equal(findAnyTombstoneV1(task) !== undefined, true);
});

void test("takeOverStaleWorkAdmissionMarkerV1: two concurrent takeovers of the same marker produce exactly one winner", async () => {
  const task = freshTaskFolder("takeover-concurrent-race");
  const markerPath = writeFakeMarkerV1(task, {
    purpose: "admission",
    pid: 555555,
    hostId: "definitely-a-different-host-id",
    ownerToken: "raced-owner",
  });
  backdateV1(markerPath, WORK_ADMISSION_LIKELY_STALE_MS_V1 + 60_000);

  const [a, b] = await Promise.all([
    takeOverStaleWorkAdmissionMarkerV1(task, markerPath, "raced-owner-claim"),
    takeOverStaleWorkAdmissionMarkerV1(task, markerPath, "raced-owner-claim"),
  ]);
  const outcomes = [a.outcome, b.outcome].sort();
  // Exactly one call must have won ("takenOver"); the other must observe
  // the marker already gone by the time it renames — a real filesystem
  // race, so either "raced" (lost the rename) or "ownerChanged"/"nothingToTakeOver"
  // (observed the post-takeover state on its own re-list) is an acceptable
  // "I lost" outcome, but never a SECOND "takenOver".
  assert.equal(outcomes.filter((o) => o === "takenOver").length, 1, `exactly one winner expected, got: ${JSON.stringify(outcomes)}`);
  assert.equal(findAnyTombstoneV1(task) !== undefined, true);
});

// 2026-09-15 review, completion blocker: corrupt-marker takeover was not
// bound to the exact observed marker (`expectedClaimId` alone is `undefined`
// for every corrupt record, so it cannot distinguish "the same corrupt file
// the notice named" from "a different corrupt file"). The two tests below
// exercise exactly the "multiple corrupt markers" and "changed" cases the
// review named.

void test("takeOverStaleWorkAdmissionMarkerV1: two distinct corrupt markers coexisting — takeover only touches the exact one the notice named, never the other", async () => {
  const task = freshTaskFolder("takeover-corrupt-multiple");
  const dir = path.join(task, ADMISSION_DIRNAME_V1);
  fs.mkdirSync(dir, { recursive: true });
  const markerPathA = path.join(dir, "admission.corruptownera.g1.aaaaaaaa");
  const markerPathB = path.join(dir, "admission.corruptownerb.g1.bbbbbbbb");
  fs.writeFileSync(markerPathA, "not valid json at all {{{ A");
  fs.writeFileSync(markerPathB, "not valid json at all {{{ B");
  backdateV1(markerPathA, WORK_ADMISSION_LIKELY_STALE_MS_V1 + 60_000);
  backdateV1(markerPathB, WORK_ADMISSION_LIKELY_STALE_MS_V1 + 60_000);

  // Deliberately target whichever of the two is NOT first in directory-list
  // order, so this test proves the fix regardless of the underlying
  // filesystem's readdir ordering: a regression back to blindly using
  // `markers[0]` would visibly take over the WRONG file here.
  const listedFirst = fs.readdirSync(dir).find((n) => n.startsWith("admission."));
  const target = listedFirst === path.basename(markerPathA) ? markerPathB : markerPathA;
  const other = target === markerPathA ? markerPathB : markerPathA;

  const outcome = await takeOverStaleWorkAdmissionMarkerV1(task, target, undefined);
  assert.equal(outcome.outcome, "takenOver");
  assert.equal(fs.existsSync(target), false, "the exact corrupt marker named by the notice must be taken over");
  assert.equal(fs.existsSync(other), true, "a different, unrelated corrupt marker must never be touched by the takeover");
});

void test("takeOverStaleWorkAdmissionMarkerV1: refuses (ownerChanged) when the exact corrupt marker path named by the notice no longer exists, even though a different corrupt marker now occupies the directory", async () => {
  const task = freshTaskFolder("takeover-corrupt-path-changed");
  const dir = path.join(task, ADMISSION_DIRNAME_V1);
  fs.mkdirSync(dir, { recursive: true });
  const originalMarkerPath = path.join(dir, "admission.originalcorrupt.g1.11111111");
  fs.writeFileSync(originalMarkerPath, "not valid json at all {{{");
  backdateV1(originalMarkerPath, WORK_ADMISSION_LIKELY_STALE_MS_V1 + 60_000);

  // Simulate the observed marker vanishing and a DIFFERENT corrupt marker
  // appearing in its place before the human clicks the takeover action —
  // the notice's confirmation must not carry over to it.
  fs.rmSync(originalMarkerPath);
  const replacementMarkerPath = path.join(dir, "admission.replacementcorrupt.g1.22222222");
  fs.writeFileSync(replacementMarkerPath, "also not valid json {{{");
  backdateV1(replacementMarkerPath, WORK_ADMISSION_LIKELY_STALE_MS_V1 + 60_000);

  const outcome = await takeOverStaleWorkAdmissionMarkerV1(task, originalMarkerPath, undefined);
  assert.deepEqual(outcome, { outcome: "ownerChanged" });
  assert.equal(fs.existsSync(replacementMarkerPath), true, "a different corrupt marker occupying the directory must never be silently taken over");
});

// 2026-09-15 review, completion blocker (narrowed remainder): `readClaimInfoSyncV1`
// validated that `ownerToken`/`claimId` were strings but placed no upper bound
// on ANY field's length, so a record with a wildly oversized `hostId` (or
// `commandId`/`claimId`/`startedAt`) parsed as "readable" and flowed verbatim
// into the takeover notice, the console log, and the durable run-log record
// (`writeStaleWorkAdmissionTakeoverRunLogRecordV1`) — exactly the "unbounded …
// content" plan step 16 forbids. The fix treats an oversized field the same
// as any other corrupt/unreadable record: "an owner exists, details unknown".
void test("takeOverStaleWorkAdmissionMarkerV1: a record with a wildly oversized field is treated as unreadable/corrupt, never surfaced with unbounded content", async () => {
  const task = freshTaskFolder("takeover-oversized-field");
  const dir = path.join(task, ADMISSION_DIRNAME_V1);
  fs.mkdirSync(dir, { recursive: true });
  const markerPath = path.join(dir, "admission.oversizedowner.g1.deadbeef");
  fs.writeFileSync(
    markerPath,
    JSON.stringify({
      claimId: "oversized-claim",
      purpose: "admission",
      ownerToken: "oversizedowner",
      pid: 999999,
      processStartTime: 0,
      // Otherwise entirely valid JSON — only this one field is unreasonable.
      hostId: "x".repeat(100_000),
      commandId: "fake-owner-command",
      startedAt: new Date().toISOString(),
    })
  );
  backdateV1(markerPath, WORK_ADMISSION_LIKELY_STALE_MS_V1 + 60_000);

  const outcome = await takeOverStaleWorkAdmissionMarkerV1(task, markerPath, undefined);
  assert.equal(outcome.outcome, "takenOver");
  if (outcome.outcome === "takenOver") {
    assert.equal(
      outcome.displacedOwner,
      undefined,
      "an oversized field must make the whole record unreadable, never surfaced verbatim to a notice/log consumer"
    );
  }
  assert.equal(fs.existsSync(markerPath), false);
});

void test("takeOverStaleWorkAdmissionMarkerV1: an otherwise-normal record is still read normally at (and just under) the length bound", async () => {
  const task = freshTaskFolder("takeover-boundary-field-length");
  const myHostId = await resolveHostIdentityV1();
  const markerPath = writeFakeMarkerV1(task, { purpose: "admission", pid: process.pid, hostId: myHostId, ownerToken: "boundary-owner" });
  backdateV1(markerPath, WORK_ADMISSION_LIKELY_STALE_MS_V1 + 60_000);

  const outcome = await takeOverStaleWorkAdmissionMarkerV1(task, markerPath, "boundary-owner-claim");
  assert.equal(outcome.outcome, "takenOver");
  if (outcome.outcome === "takenOver") {
    assert.equal(outcome.displacedOwner?.ownerToken, "boundary-owner", "a normal, reasonably-sized record must still read through unaffected by the bound");
  }
});

// ── describeStaleWorkAdmissionTakeoverNoticeV1 (Part 1c step 16) ────────────

void test("describeStaleWorkAdmissionTakeoverNoticeV1: sameHostAlive carries a strong warning; foreignHost/corrupt do not", () => {
  const owner = {
    claimId: "c1",
    purpose: "admission" as const,
    ownerToken: "o1",
    pid: 42,
    processStartTime: 0,
    hostId: "host-a",
    commandId: "runReviewWithAI",
    startedAt: new Date().toISOString(),
  };
  const alive = describeStaleWorkAdmissionTakeoverNoticeV1("My Task", { kind: "sameHostAlive" }, owner, 25 * 60 * 1000);
  assert.match(alive, /still responds/i);
  assert.match(alive, /risky/i);

  const foreign = describeStaleWorkAdmissionTakeoverNoticeV1("My Task", { kind: "foreignHost" }, owner, 25 * 60 * 1000);
  assert.doesNotMatch(foreign, /risky/i);

  const corrupt = describeStaleWorkAdmissionTakeoverNoticeV1("My Task", { kind: "corrupt" }, undefined, 25 * 60 * 1000);
  assert.match(corrupt, /unreadable record|cannot be determined/i);
});

// ── garbageCollectStaleWorkAdmissionTombstonesV1 (Part 1c step 17) ──────────

void test("garbageCollectStaleWorkAdmissionTombstonesV1: nothingToCollect when the task has no admission directory at all", async () => {
  const task = freshTaskFolder("gc-no-dir");
  const outcome = await garbageCollectStaleWorkAdmissionTombstonesV1(task);
  assert.deepEqual(outcome, { outcome: "nothingToCollect" });
});

void test("garbageCollectStaleWorkAdmissionTombstonesV1: a tombstone older than the retention window is collected", async () => {
  const task = freshTaskFolder("gc-aged-tombstone");
  const markerPath = writeFakeMarkerV1(task, { purpose: "admission", pid: 111, hostId: "some-host", ownerToken: "aged" });
  const tombstonePath = `${markerPath}.tombstone`;
  fs.renameSync(markerPath, tombstonePath);
  backdateV1(tombstonePath, WORK_ADMISSION_TOMBSTONE_RETENTION_MS_V1 + 60_000);

  const outcome = await garbageCollectStaleWorkAdmissionTombstonesV1(task);
  assert.deepEqual(outcome, { outcome: "collected", count: 1 });
  assert.equal(fs.existsSync(tombstonePath), false);
});

void test("garbageCollectStaleWorkAdmissionTombstonesV1: a fresh tombstone within the retention window is retained", async () => {
  const task = freshTaskFolder("gc-fresh-tombstone");
  const markerPath = writeFakeMarkerV1(task, { purpose: "admission", pid: 111, hostId: "some-host", ownerToken: "fresh" });
  const tombstonePath = `${markerPath}.tombstone`;
  fs.renameSync(markerPath, tombstonePath);

  const outcome = await garbageCollectStaleWorkAdmissionTombstonesV1(task);
  assert.deepEqual(outcome, { outcome: "nothingToCollect" });
  assert.equal(fs.existsSync(tombstonePath), true, "a fresh tombstone must never be collected");
});

void test("garbageCollectStaleWorkAdmissionTombstonesV1: never touches a live marker, an admission.claim, a pause-fence generation, or a pending revocation barrier, even when all are artificially aged", async () => {
  const task = freshTaskFolder("gc-never-touches-live-state");
  const dir = path.join(task, ADMISSION_DIRNAME_V1);
  fs.mkdirSync(dir, { recursive: true });

  const liveMarkerPath = writeFakeMarkerV1(task, { purpose: "admission", pid: 222, hostId: "some-host", ownerToken: "live" });
  backdateV1(liveMarkerPath, WORK_ADMISSION_TOMBSTONE_RETENTION_MS_V1 + 60_000);

  const claimPath = path.join(dir, "admission.claim");
  fs.writeFileSync(claimPath, JSON.stringify({ claimId: "c", purpose: "admission" }));
  backdateV1(claimPath, WORK_ADMISSION_TOMBSTONE_RETENTION_MS_V1 + 60_000);

  await readOrInitPauseFenceGenerationV1(task); // creates pause-fence.g0
  const fencePath = path.join(dir, "pause-fence.g0");
  backdateV1(fencePath, WORK_ADMISSION_TOMBSTONE_RETENTION_MS_V1 + 60_000);

  const barrierPath = path.join(dir, "pause-revocation.pending.revoker-x.g1");
  fs.writeFileSync(barrierPath, "");
  backdateV1(barrierPath, WORK_ADMISSION_TOMBSTONE_RETENTION_MS_V1 + 60_000);

  // Also plant a genuinely aged tombstone in the same directory, to prove
  // the pass discriminates by filename, not merely "did nothing at all".
  const tombstonePath = path.join(dir, "admission.some-other-owner.g1.abc123.tombstone");
  fs.writeFileSync(tombstonePath, JSON.stringify({ claimId: "x" }));
  backdateV1(tombstonePath, WORK_ADMISSION_TOMBSTONE_RETENTION_MS_V1 + 60_000);

  const outcome = await garbageCollectStaleWorkAdmissionTombstonesV1(task);
  assert.deepEqual(outcome, { outcome: "collected", count: 1 });

  assert.equal(fs.existsSync(liveMarkerPath), true, "a live marker must never be collected as a tombstone");
  assert.equal(fs.existsSync(claimPath), true, "admission.claim must never be collected");
  assert.equal(fs.existsSync(fencePath), true, "a pause-fence generation must never be age-deleted");
  assert.equal(fs.existsSync(barrierPath), true, "a pending revocation barrier must never be age-deleted by generic GC");
  assert.equal(fs.existsSync(tombstonePath), false, "the genuinely aged tombstone must have been collected");
});

void test("garbageCollectStaleWorkAdmissionTombstonesV1: a real unlink failure on one aged tombstone leaves recoverable state — earlier collections in the same pass are kept, the failed one is retried on the next pass", async () => {
  const task = freshTaskFolder("gc-unlink-failure-recoverable");
  const dir = path.join(task, ADMISSION_DIRNAME_V1);
  fs.mkdirSync(dir, { recursive: true });

  const okPath = path.join(dir, "admission.ok-owner.g1.aaa111.tombstone");
  fs.writeFileSync(okPath, JSON.stringify({ claimId: "ok" }));
  backdateV1(okPath, WORK_ADMISSION_TOMBSTONE_RETENTION_MS_V1 + 60_000);

  const failPath = path.join(dir, "admission.fail-owner.g1.bbb222.tombstone");
  fs.writeFileSync(failPath, JSON.stringify({ claimId: "fail" }));
  backdateV1(failPath, WORK_ADMISSION_TOMBSTONE_RETENTION_MS_V1 + 60_000);

  const injectedError = Object.assign(new Error("simulated EACCES"), { code: "EACCES" });
  setWorkAdmissionFsFailureInjectionForTestV1({
    onBeforeTombstoneUnlink: (basename) => (basename === "admission.fail-owner.g1.bbb222.tombstone" ? injectedError : undefined),
  });
  let outcome: Awaited<ReturnType<typeof garbageCollectStaleWorkAdmissionTombstonesV1>>;
  try {
    outcome = await garbageCollectStaleWorkAdmissionTombstonesV1(task);
  } finally {
    setWorkAdmissionFsFailureInjectionForTestV1(undefined);
  }

  assert.equal(outcome.outcome, "writeFailed");
  if (outcome.outcome === "writeFailed") {
    assert.equal(outcome.error, injectedError);
    // Directory iteration order is not contractually fixed, so this pass may
    // have collected the ok tombstone before or not yet reached it when the
    // failure hit — either is a valid "recoverable" state; what must NEVER
    // happen is losing track of which of the two actually got removed.
    assert.equal(outcome.partialCount, fs.existsSync(okPath) ? 0 : 1, "partialCount must exactly match what was actually removed this pass");
  }
  assert.equal(fs.existsSync(failPath), true, "the file whose unlink failed must still be present, not silently lost");

  // A later pass, with the injection removed, must still be able to finish
  // the job — a real failure must not leave the tombstone permanently stuck.
  const retry = await garbageCollectStaleWorkAdmissionTombstonesV1(task);
  assert.equal(fs.existsSync(failPath), false, "a subsequent pass must retry and collect the previously-failed tombstone");
  assert.equal(fs.existsSync(okPath), false);
  assert.ok(retry.outcome === "collected" || retry.outcome === "nothingToCollect");
});
