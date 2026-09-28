/**
 * 1.0 RC1, Part B, item 10 (first bullet): after a restart, a task waiting on
 * automation with nothing running or scheduled shows as stalled, with the
 * action that continues it.
 *
 * A window crash leaves two things behind: the task's `automation` claim (all
 * in-memory bookkeeping is gone) and, if the round was mid-flight, a dead
 * owner's admission lock. The lock used to shield the task from the watchdog
 * until it aged out; the startup sweep now clears a dead owner's lock first, so
 * the very next check sees the stall. This drives that sequence end to end on
 * a real (temporary) task folder with a real dead pid.
 */
import * as assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { buildStalledTaskEscalationDecisionV1 } from "../commands/scheduleTaskResume";
import { resolveHostIdentityV1 } from "../state/hostIdentityV1";
import { setProcessStartTimeIoOverrideForTestV1 } from "../state/processStartTimeProbeV1";
import { ADMISSION_DIRNAME_V1, attemptAutomaticWorkAdmissionReclamationV1 } from "../state/workAdmissionV1";
import type { RoundLedgerEntryV1, TaskProgress } from "../types/taskProgress";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import { isImpossibleActiveStateV1, STALLED_TASK_QUIET_PERIOD_MS } from "../utils/taskWatchdogV1";
import { safeRemoveDir } from "./testFsUtils";

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-restart-stall-test-"));

function spawnAndWaitForDeadPid(): Promise<number> {
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

function stalledAutomationProgress(): TaskProgress {
  const finishedRound: RoundLedgerEntryV1 = {
    roundId: "round-1",
    attemptIds: [],
    stage: "impl-high-review",
    mode: "review",
    startedAt: "2026-09-20T10:00:00.000Z",
    endedAt: "2026-09-20T10:05:00.000Z",
    state: "completed",
    outcome: { score: 8, reviewerBlockers: 1, mechanicalBlockers: 0 },
  };
  return {
    taskFolder: "t",
    currentStage: "impl-high-review",
    status: "active",
    nextActor: "automation",
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T10:05:00.000Z",
    roundLedger: [finishedRound],
  } as TaskProgress;
}

void describe("a restarted task waiting on automation (RC1 item 10)", () => {
  before(() => {
    const values = new Map<string, unknown>();
    const memento = {
      get<T>(key: string, defaultValue: T): T {
        return (values.has(key) ? values.get(key) : defaultValue) as T;
      },
      update(key: string, value: unknown): Promise<void> {
        values.set(key, value);
        return Promise.resolve();
      },
    } as unknown as import("vscode").Memento;
    __extensionContextV1TestOnly.set({ workspaceState: memento } as unknown as import("vscode").ExtensionContext);
    setProcessStartTimeIoOverrideForTestV1({ readFileUtf8Sync: () => undefined, execFileCapture: () => Promise.resolve(undefined) });
  });
  after(() => {
    __extensionContextV1TestOnly.reset();
    setProcessStartTimeIoOverrideForTestV1(undefined);
    safeRemoveDir(TEST_ROOT);
  });

  const now = Date.parse("2026-09-20T10:05:00.000Z") + STALLED_TASK_QUIET_PERIOD_MS + 60_000;

  void it("is reported stalled once nothing is running, owed or scheduled and the quiet period has passed", () => {
    const folder = path.join(TEST_ROOT, "no-lock");
    fs.mkdirSync(folder, { recursive: true });
    assert.equal(isImpossibleActiveStateV1({ progress: stalledAutomationProgress(), taskCanonicalId: folder, now }), true);
    // The same task explicitly waiting on the human is not stalled.
    assert.equal(
      isImpossibleActiveStateV1({ progress: { ...stalledAutomationProgress(), nextActor: "human" }, taskCanonicalId: folder, now }),
      false
    );
  });

  void it("a crashed window's dead lock shields the task until the sweep clears it; then the stall shows and the card names the continuing action", async () => {
    const folder = path.join(TEST_ROOT, "dead-lock");
    const dir = path.join(folder, ADMISSION_DIRNAME_V1);
    fs.mkdirSync(dir, { recursive: true });
    const deadPid = await spawnAndWaitForDeadPid();
    fs.writeFileSync(
      path.join(dir, "admission.crashedowner.g1.deadbeef"),
      JSON.stringify({
        claimId: "crashedowner-claim",
        purpose: "admission",
        ownerToken: "crashedowner",
        pid: deadPid,
        processStartTime: 0,
        hostId: await resolveHostIdentityV1(),
        commandId: "runReviewWithAI",
        startedAt: new Date().toISOString(),
      })
    );

    const progress = stalledAutomationProgress();
    assert.equal(
      isImpossibleActiveStateV1({ progress, taskCanonicalId: folder, now }),
      false,
      "before the sweep, the dead owner's lock still reads as live work"
    );

    // Startup sweep: the owner is provably dead and no recorded CLI survives, so the lock goes at once.
    const swept = await attemptAutomaticWorkAdmissionReclamationV1(folder, Date.now(), () => Promise.resolve([]));
    assert.equal(swept.outcome, "reclaimed");

    assert.equal(isImpossibleActiveStateV1({ progress, taskCanonicalId: folder, now }), true);

    const decision = buildStalledTaskEscalationDecisionV1(
      false,
      { canonicalId: "task-id", taskFolderPath: folder, stage: "impl-high-review", taskName: "Task A" },
      { kind: "run-review", label: "Resume and run the review again (Copilot)" },
      progress
    );
    assert.match(decision.whatHappened, /finished \(score 8\/10, 1 blockers?\)/);
    assert.match(decision.whatHappened, /The obvious next step: Resume and run the review again \(Copilot\)/);
  });

  void it("a dead lock whose recorded CLI still runs is NOT cleared, so the task does not look free while a process may edit it", async () => {
    const folder = path.join(TEST_ROOT, "dead-lock-live-cli");
    const dir = path.join(folder, ADMISSION_DIRNAME_V1);
    fs.mkdirSync(dir, { recursive: true });
    const deadPid = await spawnAndWaitForDeadPid();
    fs.writeFileSync(
      path.join(dir, "admission.crashedowner2.g1.deadbeef"),
      JSON.stringify({
        claimId: "crashedowner2-claim",
        purpose: "admission",
        ownerToken: "crashedowner2",
        pid: deadPid,
        processStartTime: 0,
        hostId: await resolveHostIdentityV1(),
        commandId: "runReviewWithAI",
        startedAt: new Date().toISOString(),
      })
    );
    const swept = await attemptAutomaticWorkAdmissionReclamationV1(folder, Date.now(), () =>
      Promise.resolve([{ pid: 999, providerLabel: "Codex CLI", command: "codex", processStartTime: Number.NaN, classification: "inconclusive" as const }])
    );
    assert.equal(swept.outcome, "cliSurvivors");
    assert.equal(isImpossibleActiveStateV1({ progress: stalledAutomationProgress(), taskCanonicalId: folder, now }), false);
  });
});
