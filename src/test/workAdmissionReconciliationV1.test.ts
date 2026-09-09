import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { encodeTaskProgressV1 } from "../services/taskProgressWriterV1";
import { PersistedTaskProgressV1 } from "../services/taskProgressDecoderV1";
import { reconcileWatchdogPauseAgainstAdmissionV1 } from "../state/workAdmissionReconciliationV1";
import {
  STALLED_ACTIVE_TASK_PAUSE_REASON_V1,
  UNRECOVERABLE_RECOVERY_PAUSE_REASON_V1,
} from "../utils/taskWatchdogV1";

/**
 * Coverage for the admission-acquirer side of the resume/setup-phase race
 * (v1 fixes item 1, Part 1a): a command that has just published a durable
 * admission marker must re-read task status and reverse a watchdog-provenance
 * pause, never a user pause. See `workAdmissionReconciliationV1.ts`'s own doc
 * comment for why the sweep-side reversal in `scheduleTaskResume.ts` alone
 * does not close this — this is the acquirer-side half.
 */
void describe("workAdmissionReconciliationV1", () => {
  const TASK_FOLDER_NAME = "2026-09-08_reconciliation_task";

  function installReadFileBridge(): { restore: () => void } {
    const workspaceFs = (vscode.workspace as unknown as { fs: Record<string, unknown> }).fs;
    const original = workspaceFs.readFile;
    workspaceFs.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
      Promise.resolve(new Uint8Array(fs.readFileSync(uri.fsPath)));
    return {
      restore: (): void => {
        workspaceFs.readFile = original;
      },
    };
  }

  interface Harness {
    folderUri: vscode.Uri;
    progressPath: string;
    restore: () => void;
  }

  // Two levels below the mkdtemp container so withTaskLock's derived
  // session/meta lock paths stay private to this test (same isolation
  // rationale as taskProgressWriterV1.test.ts's installHarness).
  function installHarness(overrides: Partial<PersistedTaskProgressV1>): Harness {
    const container = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-admission-reconciliation-"));
    const root = path.join(container, "tasks");
    const folder = path.join(root, TASK_FOLDER_NAME);
    fs.mkdirSync(folder, { recursive: true });
    const bridge = installReadFileBridge();
    const initial = encodeTaskProgressV1({
      ensembleProgressVersion: 1,
      taskFolder: TASK_FOLDER_NAME,
      currentStage: "impl",
      status: "active",
      createdAt: "2026-09-08T09:00:00.000Z",
      updatedAt: "2026-09-08T09:00:00.000Z",
      ...overrides,
    });
    const progressPath = path.join(folder, "task-progress.json");
    fs.writeFileSync(progressPath, initial);
    return {
      folderUri: vscode.Uri.file(folder),
      progressPath,
      restore: (): void => {
        bridge.restore();
        fs.rmSync(container, { recursive: true, force: true });
      },
    };
  }

  void it("reverses a pause with the generic watchdog reason back to active, touching no other field", async () => {
    const h = installHarness({ status: "paused", pausedReason: STALLED_ACTIVE_TASK_PAUSE_REASON_V1 });
    try {
      const result = await reconcileWatchdogPauseAgainstAdmissionV1(h.folderUri);
      assert.equal(result.outcome, "reversed");
      if (result.outcome === "reversed") {
        assert.equal(result.progress.status, "active");
        assert.equal(result.progress.pausedReason, undefined);
        assert.equal(result.progress.currentStage, "impl");
      }
      const onDisk = JSON.parse(fs.readFileSync(h.progressPath, "utf8")) as { status: string; pausedReason?: string };
      assert.equal(onDisk.status, "active");
      assert.equal(onDisk.pausedReason, undefined);
    } finally {
      h.restore();
    }
  });

  void it("clears watchdogPauseClaimId alongside pausedReason on reversal (non-blocking review suggestion, 2026-09-09)", async () => {
    const h = installHarness({
      status: "paused",
      pausedReason: STALLED_ACTIVE_TASK_PAUSE_REASON_V1,
      watchdogPauseClaimId: "claim-abc-123",
    });
    try {
      const result = await reconcileWatchdogPauseAgainstAdmissionV1(h.folderUri);
      assert.equal(result.outcome, "reversed");
      if (result.outcome === "reversed") {
        assert.equal(result.progress.watchdogPauseClaimId, undefined);
      }
      const onDisk = JSON.parse(fs.readFileSync(h.progressPath, "utf8")) as { watchdogPauseClaimId?: string };
      assert.equal(onDisk.watchdogPauseClaimId, undefined);
    } finally {
      h.restore();
    }
  });

  void it("reverses a pause with the unrecoverable-recovery watchdog reason as well", async () => {
    const h = installHarness({ status: "paused", pausedReason: UNRECOVERABLE_RECOVERY_PAUSE_REASON_V1 });
    try {
      const result = await reconcileWatchdogPauseAgainstAdmissionV1(h.folderUri);
      assert.equal(result.outcome, "reversed");
    } finally {
      h.restore();
    }
  });

  void it("never reverses a user (non-watchdog) pause, and leaves it untouched on disk", async () => {
    const h = installHarness({ status: "paused", pausedReason: "Paused by the user for unrelated reasons." });
    try {
      const result = await reconcileWatchdogPauseAgainstAdmissionV1(h.folderUri);
      assert.equal(result.outcome, "userPaused");
      if (result.outcome === "userPaused") {
        assert.equal(result.progress.pausedReason, "Paused by the user for unrelated reasons.");
      }
      const onDisk = JSON.parse(fs.readFileSync(h.progressPath, "utf8")) as { status: string; pausedReason?: string };
      assert.equal(onDisk.status, "paused");
      assert.equal(onDisk.pausedReason, "Paused by the user for unrelated reasons.");
    } finally {
      h.restore();
    }
  });

  void it("never reverses a pause with no recorded reason at all (fail closed, not open)", async () => {
    const h = installHarness({ status: "paused" });
    try {
      const result = await reconcileWatchdogPauseAgainstAdmissionV1(h.folderUri);
      assert.equal(result.outcome, "userPaused");
      const onDisk = JSON.parse(fs.readFileSync(h.progressPath, "utf8")) as { status: string };
      assert.equal(onDisk.status, "paused");
    } finally {
      h.restore();
    }
  });

  void it("is a no-op for a task that is not paused at all", async () => {
    const h = installHarness({ status: "active" });
    try {
      const result = await reconcileWatchdogPauseAgainstAdmissionV1(h.folderUri);
      assert.equal(result.outcome, "notPaused");
      const onDiskBefore = fs.readFileSync(h.progressPath, "utf8");
      // A genuine no-op: re-running must not even rewrite the file.
      const again = await reconcileWatchdogPauseAgainstAdmissionV1(h.folderUri);
      assert.equal(again.outcome, "notPaused");
      assert.equal(fs.readFileSync(h.progressPath, "utf8"), onDiskBefore);
    } finally {
      h.restore();
    }
  });
});
