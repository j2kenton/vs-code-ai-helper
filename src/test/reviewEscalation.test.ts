/**
 * Coverage for escalateReviewToHuman's three write guards:
 *  - Terminal-status guard: a task the user already completed/archived must
 *    never be forced back to "paused" by an escalation decision computed
 *    against an earlier, now-stale snapshot.
 *  - Stage CAS: only pause when the task is still on the stage the
 *    escalation is about — if it already advanced (or was reverted)
 *    elsewhere, applying a stale escalation would pause it with a reason
 *    naming a stage it isn't on anymore.
 *  - Attempt CAS: only pause when `reviewAttemptId` still matches the round
 *    that decided to escalate. claimReviewAttempt overwrites this field at
 *    the START of every review round, same stage or not — so this catches
 *    the specific cross-window race the stage CAS alone cannot: window B
 *    claims a NEW attempt on the SAME stage while window A's escalation is
 *    still mid-flight (e.g. inside its own second-opinion AI call), and
 *    that new attempt publishes without advancing. `currentStage` never
 *    changes, so only the attempt id distinguishes "still window A's round"
 *    from "window B already superseded it".
 *
 * All three guards return the pre-existing `current` unchanged from inside
 * the patchTaskProgress callback, which patchTaskProgress's own
 * unchanged-value detection treats as "decline the write" (see
 * taskProgressUtils.ts) — so these tests assert the write never lands, not
 * just that no error is thrown.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import * as vscode from "vscode";
import { escalateReviewToHuman } from "../utils/reviewEscalation";
import { deactivateNotificationRouter, initNotificationRouter } from "../utils/notificationRouter";
import { TaskProgress } from "../types/taskProgress";

class RecordingSurface {
  entries: { message: string; level: "info" | "warning" | "error" }[] = [];
  addEntry(message: string, level: "info" | "warning" | "error"): void {
    this.entries.push({ message, level });
  }
}

type MemStore = Map<string, string>;

function installMemStore(store: MemStore): void {
  (vscode.workspace.fs as unknown as Record<string, unknown>).readFile = (
    uri: vscode.Uri
  ): Promise<Uint8Array> => {
    const content = store.get(uri.toString());
    if (content === undefined) {
      throw new Error(`ENOENT: ${uri.toString()}`);
    }
    return Promise.resolve(new TextEncoder().encode(content));
  };
  (vscode.workspace.fs as unknown as Record<string, unknown>).writeFile = (
    uri: vscode.Uri,
    data: Uint8Array
  ): Promise<void> => {
    store.set(uri.toString(), new TextDecoder().decode(data));
    return Promise.resolve();
  };
}

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-escalation-test-"));
after(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

function makeTaskFolderUri(name: string): vscode.Uri {
  return vscode.Uri.file(path.join(TEST_ROOT, ".ensemble", name));
}

function seedProgress(store: MemStore, folderUri: vscode.Uri, progress: TaskProgress): void {
  const uri = vscode.Uri.joinPath(folderUri, "task-progress.json");
  // The strict patch (§3.12 cutover) validates taskFolder self-names the
  // folder — fixtures must agree with the directory they are seeded into,
  // or every write declines for the wrong reason.
  const named: TaskProgress = { ...progress, taskFolder: path.basename(folderUri.fsPath) };
  store.set(uri.toString(), JSON.stringify(named, null, 2));
}

function readProgress(store: MemStore, folderUri: vscode.Uri): TaskProgress {
  const uri = vscode.Uri.joinPath(folderUri, "task-progress.json");
  // writeTaskProgress persists via writeAtomic, which always hits the real
  // filesystem (bypassing the vscode.workspace.fs stub above) — so once
  // escalateReviewToHuman's patchTaskProgress call actually writes, the
  // real file on disk is the current state, not the seeded mem-store
  // snapshot. Mirrors taskProgressUtils.test.ts's readStoredProgress.
  if (fs.existsSync(uri.fsPath)) {
    return JSON.parse(fs.readFileSync(uri.fsPath, "utf8")) as TaskProgress;
  }
  return JSON.parse(store.get(uri.toString())!) as TaskProgress;
}

function baseProgress(overrides: Partial<TaskProgress> = {}): TaskProgress {
  return {
    taskFolder: "task_1",
    currentStage: "impl-high-review",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

void describe("escalateReviewToHuman — terminal-status guard", () => {
  for (const terminalStatus of ["completed", "archived"] as const) {
    void it(`does not pause a ${terminalStatus} task`, async () => {
      const store = new Map<string, string>();
      installMemStore(store);
      const surface = new RecordingSurface();
      initNotificationRouter(surface);
      const folderUri = makeTaskFolderUri(`terminal-${terminalStatus}`);
      seedProgress(store, folderUri, baseProgress({ status: terminalStatus, reviewAttemptId: "attempt-1" }));

      try {
        const escalated = await escalateReviewToHuman(folderUri, "impl-high-review", "plateau", "stuck", "attempt-1");
        // The return value IS the contract callers rely on: handleReviewRoutingOutcome
        // (reviewActions.ts) uses it to decide whether to suppress its own
        // auto-publish/auto-advance blocks. Before this fix, all three call
        // sites reported `{ escalated: true }` unconditionally regardless of
        // whether any of the three write guards below actually declined —
        // producing a round that published the review, recorded nothing,
        // said nothing, and advanced nothing.
        assert.strictEqual(escalated, false, "a declined write must be reported as not escalated");
        const after = readProgress(store, folderUri);
        assert.strictEqual(after.status, terminalStatus, "status must not be forced to paused");
        assert.strictEqual(after.escalation, undefined, "no escalation should be recorded either");
      } finally {
        deactivateNotificationRouter();
      }
    });
  }

  void it("still pauses an active task on the same stage with a matching attempt id (sanity check the guards aren't overbroad)", async () => {
    const store = new Map<string, string>();
    installMemStore(store);
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const folderUri = makeTaskFolderUri("active-still-pauses");
    seedProgress(store, folderUri, baseProgress({ status: "active", currentStage: "impl-high-review", reviewAttemptId: "attempt-1" }));

    try {
      const escalated = await escalateReviewToHuman(folderUri, "impl-high-review", "plateau", "stuck", "attempt-1");
      assert.strictEqual(escalated, true, "an applied write must be reported as escalated");
      const after = readProgress(store, folderUri);
      assert.strictEqual(after.status, "paused");
      assert.strictEqual(after.escalation?.kind, "plateau");
      assert.strictEqual(after.escalation?.stage, "impl-high-review");
    } finally {
      deactivateNotificationRouter();
    }
  });
});

void describe("escalateReviewToHuman — stage CAS", () => {
  void it("does not pause when the task has already advanced past the stage the escalation is about", async () => {
    const store = new Map<string, string>();
    installMemStore(store);
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const folderUri = makeTaskFolderUri("already-advanced");
    // Escalation decided against "impl-high-review", but by write time the
    // task has already moved on to "impl-low-review" (e.g. a concurrent
    // manual advance while the second-opinion AI call was still running).
    seedProgress(store, folderUri, baseProgress({ status: "active", currentStage: "impl-low-review", reviewAttemptId: "attempt-1" }));

    try {
      const escalated = await escalateReviewToHuman(folderUri, "impl-high-review", "plateau", "stuck", "attempt-1");
      assert.strictEqual(escalated, false);
      const after = readProgress(store, folderUri);
      assert.strictEqual(after.status, "active", "must not pause a task that has moved to a different stage");
      assert.strictEqual(after.escalation, undefined);
      assert.strictEqual(after.currentStage, "impl-low-review", "stage itself must be untouched");
    } finally {
      deactivateNotificationRouter();
    }
  });
});

void describe("escalateReviewToHuman — attempt CAS (cross-window race)", () => {
  void it("does not pause when a newer attempt has already claimed the SAME stage", async () => {
    const store = new Map<string, string>();
    installMemStore(store);
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const folderUri = makeTaskFolderUri("newer-attempt-same-stage");
    // Window A decided to escalate for "attempt-A" on impl-high-review.
    // By write time (e.g. after A's own second-opinion AI call finished),
    // window B has already claimed and published a NEWER attempt on the
    // SAME stage — currentStage never changed, so the stage CAS alone
    // would not catch this.
    seedProgress(store, folderUri, baseProgress({
      status: "active",
      currentStage: "impl-high-review",
      reviewAttemptId: "attempt-B",
    }));

    try {
      const escalated = await escalateReviewToHuman(folderUri, "impl-high-review", "plateau", "stuck (window A)", "attempt-A");
      assert.strictEqual(escalated, false);
      const after = readProgress(store, folderUri);
      assert.strictEqual(after.status, "active", "must not pause a task a newer attempt already superseded");
      assert.strictEqual(after.escalation, undefined);
      assert.strictEqual(after.reviewAttemptId, "attempt-B", "window B's attempt id must survive untouched");
    } finally {
      deactivateNotificationRouter();
    }
  });

  void it("declines when the task has no recorded reviewAttemptId at all (ambiguous — treat as stale)", async () => {
    const store = new Map<string, string>();
    installMemStore(store);
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const folderUri = makeTaskFolderUri("no-attempt-id");
    seedProgress(store, folderUri, baseProgress({ status: "active", currentStage: "impl-high-review" }));

    try {
      await escalateReviewToHuman(folderUri, "impl-high-review", "plateau", "stuck", "attempt-A");
      const after = readProgress(store, folderUri);
      assert.strictEqual(after.status, "active");
      assert.strictEqual(after.escalation, undefined);
    } finally {
      deactivateNotificationRouter();
    }
  });
});

void describe("escalateReviewToHuman — records secondOpinionAttempted", () => {
  void it("persists secondOpinionAttempted when passed true", async () => {
    const store = new Map<string, string>();
    installMemStore(store);
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const folderUri = makeTaskFolderUri("second-opinion-attempted-true");
    seedProgress(store, folderUri, baseProgress({ reviewAttemptId: "attempt-1" }));

    try {
      await escalateReviewToHuman(folderUri, "impl-high-review", "reviewer-disagreement", "disagree", "attempt-1", undefined, true);
      const after = readProgress(store, folderUri);
      assert.strictEqual(after.escalation?.secondOpinionAttempted, true);
    } finally {
      deactivateNotificationRouter();
    }
  });

  void it("defaults secondOpinionAttempted to false for a direct escalation", async () => {
    const store = new Map<string, string>();
    installMemStore(store);
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const folderUri = makeTaskFolderUri("second-opinion-attempted-default");
    seedProgress(store, folderUri, baseProgress({ reviewAttemptId: "attempt-1" }));

    try {
      await escalateReviewToHuman(folderUri, "impl-high-review", "plateau", "stuck", "attempt-1");
      const after = readProgress(store, folderUri);
      assert.strictEqual(after.escalation?.secondOpinionAttempted, false);
    } finally {
      deactivateNotificationRouter();
    }
  });
});
