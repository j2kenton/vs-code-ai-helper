import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { encodeTaskProgressV1 } from "../services/taskProgressWriterV1";
import { PersistedTaskProgressV1 } from "../services/taskProgressDecoderV1";
import {
  flushScheduledRevokedWatchdogPauseCleanupsV1,
  isEffectivelyPausedSyncV1,
  isEffectivelyPausedV1,
  repairRevokedWatchdogPauseV1,
  resolveEffectivePauseStatusSyncV1,
  resolveEffectivePauseStatusV1,
  resolveEffectiveStageTaskStatusV1,
} from "../state/effectivePauseStatusV1";
import {
  ADMISSION_DIRNAME_V1,
  advancePauseFenceGenerationV1,
  readOrInitPauseFenceGenerationV1,
} from "../state/workAdmissionV1";
import { safeRemoveDir } from "./testFsUtils";

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
        safeRemoveDir(container);
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
      // Both calls above scheduled a background repair for a claim id that
      // was never actually written to this harness's on-disk record (the
      // harness never sets `watchdogPauseClaimId` at all here) — a harmless,
      // guaranteed no-op once it runs. Flush it before `h.restore()` deletes
      // the temp directory out from under it, so the failed-mkdir-on-a-
      // deleted-directory error this would otherwise log stays out of test
      // output.
      await flushScheduledRevokedWatchdogPauseCleanupsV1();
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

  /**
   * 2026-09-14 review completion blocker: the resolver only REPORTED a
   * revoked pause; nothing scheduled its durable repair beyond the one-shot
   * barrier-completion hook, which can fire before a suspended old writer's
   * raw pause write even lands on disk. These two tests cover the fix:
   * `resolveEffectivePauseStatusV1` (and therefore `isEffectivelyPausedV1`,
   * which calls it) now schedules a best-effort repair on every observation
   * of a revoked pause, while the read-only synchronous twin still never
   * does.
   */
  void it("resolveEffectivePauseStatusV1 schedules a durable repair of a revoked pause it observes on disk", async () => {
    const h = installHarness({
      status: "paused",
      pausedReason: "stalled-active-task",
      watchdogPauseClaimId: "claim-late-writer",
      watchdogPauseFenceGeneration: 0,
    });
    try {
      // Simulate the exact late-writer race: the on-disk record was written
      // under generation 0, but the durable fence has since advanced past it
      // (a revocation this stale pause's own writer never observed).
      await readOrInitPauseFenceGenerationV1(h.folder);
      await advancePauseFenceGenerationV1(h.folder);
      const resolved = await resolveEffectivePauseStatusV1(h.folder, {
        status: "paused",
        watchdogPauseClaimId: "claim-late-writer",
        watchdogPauseFenceGeneration: 0,
      });
      assert.equal(resolved.kind, "revokedWatchdogPause");
      await flushScheduledRevokedWatchdogPauseCleanupsV1();
      const onDisk = JSON.parse(fs.readFileSync(h.progressPath, "utf8")) as {
        status: string;
        pausedReason?: string;
        watchdogPauseClaimId?: string;
        watchdogPauseFenceGeneration?: number;
      };
      assert.equal(
        onDisk.status,
        "active",
        "observing a revoked pause must schedule its own durable repair, not just report it as ineffective"
      );
      assert.equal(onDisk.pausedReason, undefined);
      assert.equal(onDisk.watchdogPauseClaimId, undefined);
      assert.equal(onDisk.watchdogPauseFenceGeneration, undefined);
    } finally {
      h.restore();
    }
  });

  void it("isEffectivelyPausedV1 also schedules the same durable repair, since it resolves through the same function", async () => {
    const h = installHarness({
      status: "paused",
      pausedReason: "unrecoverable-recovery",
      watchdogPauseClaimId: "claim-late-writer-2",
      watchdogPauseFenceGeneration: 0,
    });
    try {
      await readOrInitPauseFenceGenerationV1(h.folder);
      await advancePauseFenceGenerationV1(h.folder);
      const paused = await isEffectivelyPausedV1(h.folder, {
        status: "paused",
        watchdogPauseClaimId: "claim-late-writer-2",
        watchdogPauseFenceGeneration: 0,
      });
      assert.equal(paused, false);
      await flushScheduledRevokedWatchdogPauseCleanupsV1();
      const onDisk = JSON.parse(fs.readFileSync(h.progressPath, "utf8")) as { status: string };
      assert.equal(onDisk.status, "active");
    } finally {
      h.restore();
    }
  });

  void it("resolveEffectivePauseStatusSyncV1 (render path) schedules the same durable repair as the async resolver — a task only ever rendered must not strand a stale pause forever", async () => {
    const h = installHarness({
      status: "paused",
      pausedReason: "stalled-active-task",
      watchdogPauseClaimId: "claim-render-path-only",
      watchdogPauseFenceGeneration: 0,
    });
    try {
      await readOrInitPauseFenceGenerationV1(h.folder);
      await advancePauseFenceGenerationV1(h.folder);
      const resolved = resolveEffectivePauseStatusSyncV1(h.folder, {
        status: "paused",
        watchdogPauseClaimId: "claim-render-path-only",
        watchdogPauseFenceGeneration: 0,
      });
      assert.equal(resolved.kind, "revokedWatchdogPause");
      await flushScheduledRevokedWatchdogPauseCleanupsV1();
      const onDisk = JSON.parse(fs.readFileSync(h.progressPath, "utf8")) as {
        status: string;
        watchdogPauseClaimId?: string;
      };
      assert.equal(
        onDisk.status,
        "active",
        "a render-path observation of a revoked pause must schedule its own durable repair, exactly like the async resolver"
      );
      assert.equal(onDisk.watchdogPauseClaimId, undefined);
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

  /**
   * Part 1b step 13 wiring: `resolveEffectivePauseStatusSyncV1` /
   * `isEffectivelyPausedSyncV1` are the synchronous twins consumed by
   * render-path readers (`taskTreeProvider.ts`, `taskStatusBar.ts`) that
   * cannot await mid-render. Every branch below mirrors the async resolver's
   * own test cases above one-for-one — the two must never diverge, since a
   * paused task's tree row and its command-level gate must always agree on
   * whether the pause is still effective.
   */
  void describe("synchronous twins (resolveEffectivePauseStatusSyncV1 / isEffectivelyPausedSyncV1)", () => {
    void it("an active task resolves to notPaused", () => {
      const resolved = resolveEffectivePauseStatusSyncV1("irrelevant-unused-path", { status: "active" });
      assert.equal(resolved.kind, "notPaused");
      assert.equal(isEffectivelyPausedSyncV1("irrelevant-unused-path", { status: "active" }), false);
    });

    void it("a paused task with no watchdogPauseClaimId is always userPause, with no disk access at all", () => {
      // Deliberately uses a path with no admission directory / no fence ever
      // initialized — a real user pause must resolve without ever touching
      // the fence, exactly like the async resolver.
      const resolved = resolveEffectivePauseStatusSyncV1("Z:\\definitely\\does\\not\\exist", {
        status: "paused",
      });
      assert.equal(resolved.kind, "userPause");
      assert.equal(
        isEffectivelyPausedSyncV1("Z:\\definitely\\does\\not\\exist", { status: "paused" }),
        true
      );
    });

    void it("a watchdog pause whose recorded generation matches the current fence is currentWatchdogPause", async () => {
      const h = installHarness({ status: "paused" });
      try {
        const generation = await readOrInitPauseFenceGenerationV1(h.folder);
        const resolved = resolveEffectivePauseStatusSyncV1(h.folder, {
          status: "paused",
          watchdogPauseClaimId: "claim-1",
          watchdogPauseFenceGeneration: generation,
        });
        assert.equal(resolved.kind, "currentWatchdogPause");
        assert.equal(
          isEffectivelyPausedSyncV1(h.folder, {
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
        const resolved = resolveEffectivePauseStatusSyncV1(h.folder, {
          status: "paused",
          watchdogPauseClaimId: "claim-stale",
          watchdogPauseFenceGeneration: staleGeneration,
        });
        assert.equal(resolved.kind, "revokedWatchdogPause");
        if (resolved.kind === "revokedWatchdogPause") {
          assert.equal(resolved.staleClaimId, "claim-stale");
        }
        assert.equal(
          isEffectivelyPausedSyncV1(h.folder, {
            status: "paused",
            watchdogPauseClaimId: "claim-stale",
            watchdogPauseFenceGeneration: staleGeneration,
          }),
          false,
          "a revoked watchdog pause must never gate a render-path consumer either"
        );
        // Both calls above scheduled a background repair for a claim id that
        // was never actually written to this harness's on-disk record — a
        // harmless, guaranteed no-op once it runs. Flush it before
        // `h.restore()` deletes the temp directory out from under it, same as
        // the async resolver's equivalent test above.
        await flushScheduledRevokedWatchdogPauseCleanupsV1();
      } finally {
        h.restore();
      }
    });

    void it("a watchdog pause with no recorded generation at all (pre-1b build) is treated as current, never revoked", async () => {
      const h = installHarness({ status: "paused" });
      try {
        await advancePauseFenceGenerationV1(h.folder);
        const resolved = resolveEffectivePauseStatusSyncV1(h.folder, {
          status: "paused",
          watchdogPauseClaimId: "claim-pre-1b",
          watchdogPauseFenceGeneration: undefined,
        });
        assert.equal(resolved.kind, "currentWatchdogPause");
      } finally {
        h.restore();
      }
    });

    void it("never writes anything to disk — a purely read-only render-path check", () => {
      const h = installHarness({ status: "paused" });
      try {
        const before = fs.existsSync(path.join(h.folder, ADMISSION_DIRNAME_V1));
        assert.equal(before, false, "no admission directory should exist before the check");
        resolveEffectivePauseStatusSyncV1(h.folder, {
          status: "paused",
          watchdogPauseClaimId: "claim-1",
          watchdogPauseFenceGeneration: 0,
        });
        assert.equal(
          fs.existsSync(path.join(h.folder, ADMISSION_DIRNAME_V1)),
          false,
          "the sync check must never lazily create the admission/fence directory as a render-path side effect"
        );
      } finally {
        h.restore();
      }
    });
  });

  /**
   * 2026-09-15 review completion blocker: Part 1b's status-resolution
   * invariant requires dedicated coverage of the ADVANCEMENT GATES —
   * `commitAndPushTask.ts`'s "Complete, Commit and Push" flow and
   * `reviewActions.ts`'s `advanceStageViaNextStageRowV1` — not just of the
   * general-purpose resolver above. Both call sites previously inlined an
   * identical computation (each commented "same fix as" the other); it is now
   * `resolveEffectiveStageTaskStatusV1` below, called verbatim by both, so
   * these tests are dedicated coverage of exactly the logic gating
   * `nextStage.v1`'s eligibility check at both advancement points, not merely
   * of the shared resolver they both build on.
   */
  void describe("resolveEffectiveStageTaskStatusV1 (the two advancement gates: commitAndPushTask.ts and reviewActions.ts's advanceStageViaNextStageRowV1)", () => {
    void it("an older-generation (revoked) watchdog pause resolves to active, so the advancement gate is not tripped", async () => {
      const h = installHarness({ status: "paused" });
      try {
        const staleGeneration = await readOrInitPauseFenceGenerationV1(h.folder);
        await advancePauseFenceGenerationV1(h.folder);
        const effective = await resolveEffectiveStageTaskStatusV1(h.folder, {
          status: "paused",
          watchdogPauseClaimId: "claim-stale-gate",
          watchdogPauseFenceGeneration: staleGeneration,
        });
        assert.equal(
          effective,
          "active",
          "a revoked watchdog pause must never trip nextStage.v1's eligibility.statuses:[\"active\"] gate"
        );
        await flushScheduledRevokedWatchdogPauseCleanupsV1();
      } finally {
        h.restore();
      }
    });

    void it("a current-generation watchdog pause resolves to paused, so the advancement gate still blocks", async () => {
      const h = installHarness({ status: "paused" });
      try {
        const generation = await readOrInitPauseFenceGenerationV1(h.folder);
        const effective = await resolveEffectiveStageTaskStatusV1(h.folder, {
          status: "paused",
          watchdogPauseClaimId: "claim-current-gate",
          watchdogPauseFenceGeneration: generation,
        });
        assert.equal(effective, "paused", "a still-current watchdog pause must continue to block advancement");
      } finally {
        h.restore();
      }
    });

    void it("a genuine user pause resolves to paused and is never bypassed, regardless of fence state", async () => {
      const h = installHarness({ status: "paused", pausedReason: "manual" });
      try {
        // No watchdogPauseClaimId at all — a real user pause. Even though a
        // fence generation is supplied here (as a caller reading a stale
        // snapshot object might), the absence of a claim id must win.
        await advancePauseFenceGenerationV1(h.folder);
        const effective = await resolveEffectiveStageTaskStatusV1(h.folder, { status: "paused" });
        assert.equal(effective, "paused", "a user pause must never be second-guessed by the fence check");
      } finally {
        h.restore();
      }
    });

    void it("an active task resolves to active", async () => {
      const h = installHarness({ status: "active" });
      try {
        const effective = await resolveEffectiveStageTaskStatusV1(h.folder, { status: "active" });
        assert.equal(effective, "active");
      } finally {
        h.restore();
      }
    });

    void it("an undefined snapshot (a caller that could not resolve one) falls back to active, matching both call sites' pre-existing ?? \"active\" fallback", async () => {
      const effective = await resolveEffectiveStageTaskStatusV1("irrelevant-unused-path", undefined);
      assert.equal(effective, "active");
    });
  });
});
