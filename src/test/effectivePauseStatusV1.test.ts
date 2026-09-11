import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { encodeTaskProgressV1 } from "../services/taskProgressWriterV1";
import { PersistedTaskProgressV1 } from "../services/taskProgressDecoderV1";
import {
  isEffectivelyPausedV1,
  repairRevokedWatchdogPauseV1,
  resolveEffectivePauseStatusV1,
} from "../state/effectivePauseStatusV1";
import { advancePauseFenceGenerationV1, readOrInitPauseFenceGenerationV1 } from "../state/workAdmissionV1";

/**
 * v1 fixes item 1, Part 1b step 13 — the centralized effective-pause-status
 * resolver. See `effectivePauseStatusV1.ts`'s own doc comment: this module is
 * the read-side primitive ("is this pause still effective right now"), kept
 * separate from `workAdmissionReconciliationV1.ts`'s admission-driven
 * reversal, which answers a different question.
 */
void describe("effectivePauseStatusV1", () => {
  const TASK_FOLDER_NAME = "2026-09-11_effective_pause_task";

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
    folder: string;
    folderUri: vscode.Uri;
    progressPath: string;
    restore: () => void;
  }

  function installHarness(overrides: Partial<PersistedTaskProgressV1>): Harness {
    const container = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-effective-pause-"));
    const root = path.join(container, "tasks");
    const folder = path.join(root, TASK_FOLDER_NAME);
    fs.mkdirSync(folder, { recursive: true });
    const bridge = installReadFileBridge();
    const initial = encodeTaskProgressV1({
      ensembleProgressVersion: 1,
      taskFolder: TASK_FOLDER_NAME,
      currentStage: "impl",
      status: "active",
      createdAt: "2026-09-11T09:00:00.000Z",
      updatedAt: "2026-09-11T09:00:00.000Z",
      ...overrides,
    });
    const progressPath = path.join(folder, "task-progress.json");
    fs.writeFileSync(progressPath, initial);
    return {
      folder,
      folderUri: vscode.Uri.file(folder),
      progressPath,
      restore: (): void => {
        bridge.restore();
        fs.rmSync(container, { recursive: true, force: true });
      },
    };
  }

  void it("an active task resolves to notPaused", async () => {
    const h = installHarness({ status: "active" });
    try {
      const resolved = await resolveEffectivePauseStatusV1(h.folder, { status: "active" });
      assert.equal(resolved.kind, "notPaused");
      assert.equal(await isEffectivelyPausedV1(h.folder, { status: "active" }), false);
    } finally {
      h.restore();
    }
  });

  void it("a paused task with no watchdogPauseClaimId is always userPause (a real user pause, a quota park, or a pre-1b build)", async () => {
    const h = installHarness({ status: "paused", pausedReason: "manual" });
    try {
      const resolved = await resolveEffectivePauseStatusV1(h.folder, { status: "paused" });
      assert.equal(resolved.kind, "userPause");
      assert.equal(await isEffectivelyPausedV1(h.folder, { status: "paused" }), true);
    } finally {
      h.restore();
    }
  });

  void it("a watchdog pause whose recorded generation matches the current fence is currentWatchdogPause", async () => {
    const h = installHarness({ status: "paused" });
    try {
      const generation = await readOrInitPauseFenceGenerationV1(h.folder);
      const resolved = await resolveEffectivePauseStatusV1(h.folder, {
        status: "paused",
        watchdogPauseClaimId: "claim-1",
        watchdogPauseFenceGeneration: generation,
      });
      assert.equal(resolved.kind, "currentWatchdogPause");
      assert.equal(
        await isEffectivelyPausedV1(h.folder, {
          status: "paused",
          watchdogPauseClaimId: "claim-1",
          watchdogPauseFenceGeneration: generation,
        }),
        true
      );
    } finally {
      h.restore();
    }
  });

  void it("a watchdog pause whose recorded generation is behind the current fence is revokedWatchdogPause, never a real block", async () => {
    const h = installHarness({ status: "paused" });
    try {
      const staleGeneration = await readOrInitPauseFenceGenerationV1(h.folder);
      await advancePauseFenceGenerationV1(h.folder);
      const resolved = await resolveEffectivePauseStatusV1(h.folder, {
        status: "paused",
        watchdogPauseClaimId: "claim-stale",
        watchdogPauseFenceGeneration: staleGeneration,
      });
      assert.equal(resolved.kind, "revokedWatchdogPause");
      if (resolved.kind === "revokedWatchdogPause") {
        assert.equal(resolved.staleClaimId, "claim-stale");
      }
      assert.equal(
        await isEffectivelyPausedV1(h.folder, {
          status: "paused",
          watchdogPauseClaimId: "claim-stale",
          watchdogPauseFenceGeneration: staleGeneration,
        }),
        false,
        "a revoked watchdog pause must never gate a consumer"
      );
    } finally {
      h.restore();
    }
  });

  void it("a watchdog pause with no recorded generation at all (pre-1b build) is treated as current, never revoked", async () => {
    const h = installHarness({ status: "paused" });
    try {
      await advancePauseFenceGenerationV1(h.folder);
      const resolved = await resolveEffectivePauseStatusV1(h.folder, {
        status: "paused",
        watchdogPauseClaimId: "claim-preb1b",
        watchdogPauseFenceGeneration: undefined,
      });
      assert.equal(resolved.kind, "currentWatchdogPause");
    } finally {
      h.restore();
    }
  });

  void it("repairRevokedWatchdogPauseV1 clears the pause fields and reverts status to active, touching nothing else", async () => {
    const h = installHarness({
      status: "paused",
      pausedReason: "stalled-active-task",
      watchdogPauseClaimId: "claim-to-repair",
      watchdogPauseFenceGeneration: 0,
    });
    try {
      await repairRevokedWatchdogPauseV1(h.folderUri, "claim-to-repair");
      const onDisk = JSON.parse(fs.readFileSync(h.progressPath, "utf8")) as {
        status: string;
        pausedReason?: string;
        watchdogPauseClaimId?: string;
        watchdogPauseFenceGeneration?: number;
        currentStage: string;
      };
      assert.equal(onDisk.status, "active");
      assert.equal(onDisk.pausedReason, undefined);
      assert.equal(onDisk.watchdogPauseClaimId, undefined);
      assert.equal(onDisk.watchdogPauseFenceGeneration, undefined);
      assert.equal(onDisk.currentStage, "impl", "field-scoped: unrelated fields must survive untouched");
    } finally {
      h.restore();
    }
  });

  void it("repairRevokedWatchdogPauseV1 is a no-op when the on-disk claim no longer matches (already superseded)", async () => {
    const h = installHarness({
      status: "paused",
      pausedReason: "fresh-pause",
      watchdogPauseClaimId: "claim-fresh",
      watchdogPauseFenceGeneration: 1,
    });
    try {
      await repairRevokedWatchdogPauseV1(h.folderUri, "claim-stale-and-gone");
      const onDisk = JSON.parse(fs.readFileSync(h.progressPath, "utf8")) as {
        status: string;
        watchdogPauseClaimId?: string;
      };
      assert.equal(onDisk.status, "paused", "a fresh pause under a different claim must never be touched");
      assert.equal(onDisk.watchdogPauseClaimId, "claim-fresh");
    } finally {
      h.restore();
    }
  });

  void it("repairRevokedWatchdogPauseV1 is a no-op once the task is no longer paused at all", async () => {
    const h = installHarness({ status: "active" });
    try {
      await repairRevokedWatchdogPauseV1(h.folderUri, "claim-to-repair");
      const onDisk = JSON.parse(fs.readFileSync(h.progressPath, "utf8")) as { status: string };
      assert.equal(onDisk.status, "active");
    } finally {
      h.restore();
    }
  });
});
