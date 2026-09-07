/**
 * Coverage for round-ledger reconciliation pass (a) — "orphan starts" (wf
 * "make the stage chat a record of work" Part 4 step 14,
 * `roundLedgerReconciliationV1.ts`). A `roundLedger` row left `"scheduled"`/
 * `"open"` by a round whose process died before it could terminalize its own
 * row must eventually close as `"interrupted"`, but ONLY once nothing live
 * remains that could still terminalize it — never while a live operation or a
 * live scheduling-intent entry exists for the task.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { TaskProgress } from "../types/taskProgress";
import {
  reconcileOrphanedRoundLedgerRowsV1,
  reconcileRoundLedgerV1,
  repairMissingRoundOutcomeMessagesV1,
  synthesizeLegacyRoundLedgerRowsV1,
} from "../utils/roundLedgerReconciliationV1";
import { configureWorkflowPrivateStorageRootV1 } from "../services/workflowRuntimeServicesV1";
import { appendChatMessageV1, readChatHistory } from "../utils/chatHistoryStore";

const REAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-round-ledger-reconcile-"));
const PRIVATE_STORAGE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-round-ledger-reconcile-private-"));
configureWorkflowPrivateStorageRootV1(PRIVATE_STORAGE_ROOT);

function installFsBridge(): { restore: () => void } {
  const target = vscode.workspace.fs as unknown as Record<string, unknown>;
  const orig = { ...target };
  target.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  target.writeFile = async (uri: vscode.Uri, content: Uint8Array): Promise<void> => {
    await fs.promises.mkdir(path.dirname(uri.fsPath), { recursive: true });
    await fs.promises.writeFile(uri.fsPath, content);
  };
  target.rename = async (source: vscode.Uri, dest: vscode.Uri): Promise<void> => {
    await fs.promises.rm(dest.fsPath, { force: true });
    await fs.promises.rename(source.fsPath, dest.fsPath);
  };
  target.delete = (uri: vscode.Uri): Promise<void> =>
    fs.promises.rm(uri.fsPath, { force: true, recursive: true });
  target.createDirectory = (uri: vscode.Uri): Promise<void> =>
    fs.promises.mkdir(uri.fsPath, { recursive: true }).then(() => undefined);
  target.readDirectory = async (uri: vscode.Uri): Promise<[string, number][]> => {
    const entries = await fs.promises.readdir(uri.fsPath, { withFileTypes: true });
    return entries.map((entry) => [entry.name, entry.isDirectory() ? 2 : 1]);
  };
  target.stat = async (uri: vscode.Uri): Promise<{ type: number; size: number; ctime: number; mtime: number }> => {
    const stat = await fs.promises.stat(uri.fsPath);
    return { type: stat.isDirectory() ? 2 : 1, size: stat.size, ctime: stat.ctimeMs, mtime: stat.mtimeMs };
  };
  return {
    restore: (): void => {
      for (const key of ["readFile", "writeFile", "rename", "delete", "createDirectory", "readDirectory", "stat"]) {
        target[key] = orig[key];
      }
    },
  };
}

function installWorkspaceFoldersStub(): { restore: () => void } {
  const ws = vscode.workspace as unknown as Record<string, unknown>;
  const orig = ws.workspaceFolders;
  ws.workspaceFolders = [{ uri: vscode.Uri.file(REAL_ROOT), name: "root", index: 0 }];
  return { restore: (): void => { ws.workspaceFolders = orig; } };
}

function makeTaskFolder(name: string, roundLedger: TaskProgress["roundLedger"]): { folderPath: string; folderUri: vscode.Uri } {
  const folderPath = path.join(REAL_ROOT, "plans", name);
  fs.mkdirSync(folderPath, { recursive: true });
  const progress: TaskProgress & { ensembleProgressVersion: 1 } = {
    ensembleProgressVersion: 1,
    taskFolder: name,
    currentStage: "impl-high-review",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ownership: {
      metaRoot: path.join(REAL_ROOT, "plans"),
      projectRoot: REAL_ROOT,
      workspaceRoot: REAL_ROOT,
      boundAt: "2026-01-01T00:00:00.000Z",
    },
    roundLedger,
  };
  fs.writeFileSync(path.join(folderPath, "task-progress.json"), JSON.stringify(progress, null, 2), "utf8");
  return { folderPath, folderUri: vscode.Uri.file(folderPath) };
}

void describe("reconcileOrphanedRoundLedgerRowsV1 (Part 4 step 14, pass (a))", () => {
  void it("closes an open row as interrupted when nothing live remains", async () => {
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    try {
      const { folderPath, folderUri } = makeTaskFolder("orphan_basic", [
        {
          roundId: "attempt-orphan-1",
          attemptIds: ["attempt-orphan-1"],
          stage: "impl-high-review",
          mode: "review",
          startedAt: "2026-01-01T00:05:00.000Z",
          state: "open",
        },
      ]);

      const result = await reconcileOrphanedRoundLedgerRowsV1({
        taskFolderUri: folderUri,
        hasLiveOperation: false,
        hasLiveSchedulingIntent: false,
        liveOperationIds: [],
        liveSchedulingIntentIds: [],
      });
      assert.deepEqual(result.closed, ["attempt-orphan-1"]);

      const raw = JSON.parse(fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")) as TaskProgress;
      const row = raw.roundLedger?.find((r) => r.roundId === "attempt-orphan-1");
      assert.equal(row?.state, "interrupted");
      assert.ok(row?.endedAt);
      // The row's real start time must survive unchanged.
      assert.equal(row?.startedAt, "2026-01-01T00:05:00.000Z");

      const messages = await readChatHistory(folderPath, folderPath);
      const outcomeMessages = messages.filter((m) => m.kind === "outcome" && m.roundId === "attempt-orphan-1");
      assert.equal(outcomeMessages.length, 1, "an outcome message must be appended for the closed round");
      assert.ok(outcomeMessages[0]?.text.includes("interrupted"));
    } finally {
      wsStub.restore();
      fsBridge.restore();
    }
  });

  void it("does NOT close an open row while a live operation exists for the task", async () => {
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    try {
      const { folderPath, folderUri } = makeTaskFolder("orphan_live_operation", [
        {
          roundId: "attempt-live-op-1",
          attemptIds: ["attempt-live-op-1"],
          stage: "impl-high-review",
          mode: "review",
          startedAt: "2026-01-01T00:05:00.000Z",
          state: "open",
        },
      ]);

      const result = await reconcileOrphanedRoundLedgerRowsV1({
        taskFolderUri: folderUri,
        hasLiveOperation: true,
        hasLiveSchedulingIntent: false,
        // The row carries no operationId/intentId of its own, so this falls
        // back to the task-wide `hasLiveOperation` boolean above — the ids
        // lists are irrelevant to this row's protection.
        liveOperationIds: [],
        liveSchedulingIntentIds: [],
      });
      assert.deepEqual(result.closed, []);

      const raw = JSON.parse(fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")) as TaskProgress;
      assert.equal(raw.roundLedger?.find((r) => r.roundId === "attempt-live-op-1")?.state, "open");
    } finally {
      wsStub.restore();
      fsBridge.restore();
    }
  });

  void it("does NOT close a scheduled row while a live scheduling-intent entry exists for the task", async () => {
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    try {
      const { folderPath, folderUri } = makeTaskFolder("orphan_live_intent", [
        {
          roundId: "intent-live-1",
          intentId: "intent-live-1",
          attemptIds: [],
          stage: "impl",
          mode: "implementation",
          startedAt: "2026-01-01T00:05:00.000Z",
          state: "scheduled",
        },
      ]);

      const result = await reconcileOrphanedRoundLedgerRowsV1({
        taskFolderUri: folderUri,
        hasLiveOperation: false,
        hasLiveSchedulingIntent: true,
        liveOperationIds: [],
        // This row DOES carry its own `intentId`, so it is now checked
        // precisely against this list rather than the task-wide boolean.
        liveSchedulingIntentIds: ["intent-live-1"],
      });
      assert.deepEqual(result.closed, []);

      const raw = JSON.parse(fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")) as TaskProgress;
      assert.equal(raw.roundLedger?.find((r) => r.roundId === "intent-live-1")?.state, "scheduled");
    } finally {
      wsStub.restore();
      fsBridge.restore();
    }
  });

  void it("does NOT close an identity-less row (no operationId, no intentId) while its own roundId has a live round-lease entry (2026-09-04 review follow-up, architectural blocker: cross-window CLI round liveness)", async () => {
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    try {
      const { folderPath, folderUri } = makeTaskFolder("orphan_live_lease", [
        {
          roundId: "cli-round-live-1",
          attemptIds: [],
          stage: "impl",
          mode: "implementation",
          startedAt: "2026-01-01T00:05:00.000Z",
          state: "open",
        },
      ]);

      const result = await reconcileOrphanedRoundLedgerRowsV1({
        taskFolderUri: folderUri,
        // Both task-wide booleans false — simulating a DIFFERENT window
        // running this round, invisible to this window's own in-process
        // registries, protected only by the durable round-lease entry.
        hasLiveOperation: false,
        hasLiveSchedulingIntent: false,
        liveOperationIds: [],
        liveSchedulingIntentIds: [],
        liveRoundLeaseIds: ["cli-round-live-1"],
      });
      assert.deepEqual(result.closed, []);

      const raw = JSON.parse(fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")) as TaskProgress;
      assert.equal(raw.roundLedger?.find((r) => r.roundId === "cli-round-live-1")?.state, "open");
    } finally {
      wsStub.restore();
      fsBridge.restore();
    }
  });

  void it("does NOT close an operationId-carrying row (a manually-dispatched review round) while its own roundId has a live round-lease entry, even though the operationId is invisible to this window (2026-09-04 review follow-up, narrowed architectural blocker de9851ef…-0: cross-window liveness for MANUAL review rounds)", async () => {
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    try {
      const { folderPath, folderUri } = makeTaskFolder("orphan_manual_review_other_window", [
        {
          roundId: "manual-review-attempt-1",
          attemptIds: ["manual-review-attempt-1"],
          operationId: "op-from-a-different-window",
          stage: "impl-high-review",
          mode: "review",
          startedAt: "2026-01-01T00:05:00.000Z",
          state: "open",
        },
      ]);

      const result = await reconcileOrphanedRoundLedgerRowsV1({
        taskFolderUri: folderUri,
        // Both process-local signals false and no scheduling intent at all —
        // exactly the shape a manually-invoked "Review with AI" round in a
        // DIFFERENT VS Code window leaves this window's own registries in.
        hasLiveOperation: false,
        hasLiveSchedulingIntent: false,
        liveOperationIds: [],
        liveSchedulingIntentIds: [],
        liveRoundLeaseIds: ["manual-review-attempt-1"],
      });
      assert.deepEqual(result.closed, []);

      const raw = JSON.parse(fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")) as TaskProgress;
      assert.equal(raw.roundLedger?.find((r) => r.roundId === "manual-review-attempt-1")?.state, "open");
    } finally {
      wsStub.restore();
      fsBridge.restore();
    }
  });

  void it("closes an operationId-carrying row when its roundId is absent from liveRoundLeaseIds and no other liveness signal covers it (no lease is not fail-open for manual review rounds either)", async () => {
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    try {
      const { folderPath, folderUri } = makeTaskFolder("orphan_manual_review_dead", [
        {
          roundId: "manual-review-attempt-dead",
          attemptIds: ["manual-review-attempt-dead"],
          operationId: "op-from-a-crashed-window",
          stage: "impl-high-review",
          mode: "review",
          startedAt: "2026-01-01T00:05:00.000Z",
          state: "open",
        },
      ]);

      const result = await reconcileOrphanedRoundLedgerRowsV1({
        taskFolderUri: folderUri,
        hasLiveOperation: false,
        hasLiveSchedulingIntent: false,
        liveOperationIds: [],
        liveSchedulingIntentIds: [],
        liveRoundLeaseIds: ["some-other-round"],
      });
      assert.deepEqual(result.closed, ["manual-review-attempt-dead"]);

      const raw = JSON.parse(fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")) as TaskProgress;
      assert.equal(raw.roundLedger?.find((r) => r.roundId === "manual-review-attempt-dead")?.state, "interrupted");
    } finally {
      wsStub.restore();
      fsBridge.restore();
    }
  });

  void it("closes an identity-less row when its roundId is absent from liveRoundLeaseIds and both task-wide booleans are false (no lease is not fail-open)", async () => {
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    try {
      const { folderPath, folderUri } = makeTaskFolder("orphan_expired_lease", [
        {
          roundId: "cli-round-dead-1",
          attemptIds: [],
          stage: "impl",
          mode: "implementation",
          startedAt: "2026-01-01T00:05:00.000Z",
          state: "open",
        },
      ]);

      const result = await reconcileOrphanedRoundLedgerRowsV1({
        taskFolderUri: folderUri,
        hasLiveOperation: false,
        hasLiveSchedulingIntent: false,
        liveOperationIds: [],
        liveSchedulingIntentIds: [],
        // A different round's lease is live, but not this row's own —
        // must not protect it.
        liveRoundLeaseIds: ["some-other-round"],
      });
      assert.deepEqual(result.closed, ["cli-round-dead-1"]);

      const raw = JSON.parse(fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")) as TaskProgress;
      assert.equal(raw.roundLedger?.find((r) => r.roundId === "cli-round-dead-1")?.state, "interrupted");
    } finally {
      wsStub.restore();
      fsBridge.restore();
    }
  });

  void it("is a no-op for a task with no open/scheduled rows", async () => {
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    try {
      const { folderUri } = makeTaskFolder("orphan_none_open", [
        {
          roundId: "attempt-done-1",
          attemptIds: ["attempt-done-1"],
          stage: "impl-high-review",
          mode: "review",
          startedAt: "2026-01-01T00:05:00.000Z",
          endedAt: "2026-01-01T00:10:00.000Z",
          state: "completed",
        },
      ]);

      const result = await reconcileOrphanedRoundLedgerRowsV1({
        taskFolderUri: folderUri,
        hasLiveOperation: false,
        hasLiveSchedulingIntent: false,
        liveOperationIds: [],
        liveSchedulingIntentIds: [],
      });
      assert.deepEqual(result.closed, []);
    } finally {
      wsStub.restore();
      fsBridge.restore();
    }
  });

  void it("closes a stale row by its own identity even while a DIFFERENT round is live for the same task (2026-08-27 review regression)", async () => {
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    try {
      const { folderPath, folderUri } = makeTaskFolder("orphan_row_specific_identity", [
        {
          // A stale row left over from an earlier crash — its own intentId
          // is no longer live.
          roundId: "intent-stale-1",
          intentId: "intent-stale-1",
          attemptIds: [],
          stage: "impl",
          mode: "implementation",
          startedAt: "2026-01-01T00:05:00.000Z",
          state: "scheduled",
        },
      ]);

      // A task-wide boolean would protect the stale row too, since SOME
      // scheduling intent is live for the task — but it is a DIFFERENT
      // intent than the one the stale row itself carries.
      const result = await reconcileOrphanedRoundLedgerRowsV1({
        taskFolderUri: folderUri,
        hasLiveOperation: false,
        hasLiveSchedulingIntent: true,
        liveOperationIds: [],
        liveSchedulingIntentIds: ["intent-fresh-2"],
      });
      assert.deepEqual(result.closed, ["intent-stale-1"]);

      const raw = JSON.parse(fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")) as TaskProgress;
      assert.equal(raw.roundLedger?.find((r) => r.roundId === "intent-stale-1")?.state, "interrupted");
    } finally {
      wsStub.restore();
      fsBridge.restore();
    }
  });

  void it("protects a row via its own intentId even when the task-wide fallback booleans are false (indeterminate liveSchedulingIntentIds fails open)", async () => {
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    try {
      const { folderPath, folderUri } = makeTaskFolder("orphan_indeterminate_fails_open", [
        {
          roundId: "intent-indeterminate-1",
          intentId: "intent-indeterminate-1",
          attemptIds: [],
          stage: "impl",
          mode: "implementation",
          startedAt: "2026-01-01T00:05:00.000Z",
          state: "scheduled",
        },
      ]);

      const result = await reconcileOrphanedRoundLedgerRowsV1({
        taskFolderUri: folderUri,
        hasLiveOperation: false,
        hasLiveSchedulingIntent: false,
        liveOperationIds: [],
        // `undefined` means "could not be determined" — must fail open and
        // protect a row that carries an intentId, not treat it as orphaned.
        liveSchedulingIntentIds: undefined,
      });
      assert.deepEqual(result.closed, []);

      const raw = JSON.parse(fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")) as TaskProgress;
      assert.equal(raw.roundLedger?.find((r) => r.roundId === "intent-indeterminate-1")?.state, "scheduled");
    } finally {
      wsStub.restore();
      fsBridge.restore();
    }
  });

  void it("closes multiple orphaned rows for the same task in one call", async () => {
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    try {
      const { folderUri } = makeTaskFolder("orphan_multiple", [
        {
          roundId: "attempt-multi-1",
          attemptIds: ["attempt-multi-1"],
          stage: "impl-high-review",
          mode: "review",
          startedAt: "2026-01-01T00:05:00.000Z",
          state: "open",
        },
        {
          roundId: "attempt-multi-2",
          attemptIds: ["attempt-multi-2"],
          stage: "impl-low-review",
          mode: "review",
          startedAt: "2026-01-01T00:06:00.000Z",
          state: "scheduled",
        },
      ]);

      const result = await reconcileOrphanedRoundLedgerRowsV1({
        taskFolderUri: folderUri,
        hasLiveOperation: false,
        hasLiveSchedulingIntent: false,
        liveOperationIds: [],
        liveSchedulingIntentIds: [],
      });
      assert.deepEqual(new Set(result.closed), new Set(["attempt-multi-1", "attempt-multi-2"]));
    } finally {
      wsStub.restore();
      fsBridge.restore();
    }
  });

  void it("does NOT close an identity-less row within the just-opened grace window, even with every other liveness signal false (2026-09-06 review follow-up, architectural blocker de9851ef…-0: durable cross-window liveness when the round-lease write itself failed)", async () => {
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    try {
      const openedAt = "2026-03-01T00:00:00.000Z";
      const { folderPath, folderUri } = makeTaskFolder("orphan_grace_protected", [
        {
          roundId: "no-lease-just-opened",
          attemptIds: [],
          stage: "impl-high-review",
          mode: "review",
          startedAt: openedAt,
          state: "open",
        },
      ]);

      // Every signal a lease-write failure would leave unset: no operation,
      // no scheduling intent, no round-lease entry for this round at all —
      // simulating `claimReviewAttemptWithLiveLeaseV1` proceeding after
      // `markRoundLiveV1` returned `false`. Only 5 minutes have elapsed since
      // the row opened — well within the 90-minute grace.
      const result = await reconcileOrphanedRoundLedgerRowsV1({
        taskFolderUri: folderUri,
        hasLiveOperation: false,
        hasLiveSchedulingIntent: false,
        liveOperationIds: [],
        liveSchedulingIntentIds: [],
        liveRoundLeaseIds: [],
        now: Date.parse(openedAt) + 5 * 60 * 1000,
      });
      assert.deepEqual(result.closed, []);

      const raw = JSON.parse(fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")) as TaskProgress;
      assert.equal(raw.roundLedger?.find((r) => r.roundId === "no-lease-just-opened")?.state, "open");
    } finally {
      wsStub.restore();
      fsBridge.restore();
    }
  });

  void it("closes an identity-less row with no liveness signal once the just-opened grace window has elapsed (grace protects, it does not exempt forever)", async () => {
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    try {
      const openedAt = "2026-03-01T00:00:00.000Z";
      const { folderPath, folderUri } = makeTaskFolder("orphan_grace_expired", [
        {
          roundId: "no-lease-grace-expired",
          attemptIds: [],
          stage: "impl-high-review",
          mode: "review",
          startedAt: openedAt,
          state: "open",
        },
      ]);

      // 91 minutes elapsed — one minute past the 90-minute grace (the same
      // STALE_DISPATCH_GRACE_MS margin the rest of A1 uses), with no signal
      // ever having appeared. This is the genuinely-dead case: a round that
      // legitimately started here could never still be running.
      const result = await reconcileOrphanedRoundLedgerRowsV1({
        taskFolderUri: folderUri,
        hasLiveOperation: false,
        hasLiveSchedulingIntent: false,
        liveOperationIds: [],
        liveSchedulingIntentIds: [],
        liveRoundLeaseIds: [],
        now: Date.parse(openedAt) + 91 * 60 * 1000,
      });
      assert.deepEqual(result.closed, ["no-lease-grace-expired"]);

      const raw = JSON.parse(fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")) as TaskProgress;
      assert.equal(raw.roundLedger?.find((r) => r.roundId === "no-lease-grace-expired")?.state, "interrupted");
    } finally {
      wsStub.restore();
      fsBridge.restore();
    }
  });

  void it("the just-opened grace protects an operationId-carrying row too, before the coordinator has had a chance to attach an operation the caller's registries can see", async () => {
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    try {
      const openedAt = "2026-03-01T00:00:00.000Z";
      const { folderPath, folderUri } = makeTaskFolder("orphan_grace_protected_with_operation_id", [
        {
          roundId: "manual-review-just-opened",
          attemptIds: ["manual-review-just-opened"],
          operationId: "op-not-yet-visible-anywhere",
          stage: "impl-high-review",
          mode: "review",
          startedAt: openedAt,
          state: "open",
        },
      ]);

      const result = await reconcileOrphanedRoundLedgerRowsV1({
        taskFolderUri: folderUri,
        hasLiveOperation: false,
        hasLiveSchedulingIntent: false,
        liveOperationIds: [],
        liveSchedulingIntentIds: [],
        liveRoundLeaseIds: [],
        now: Date.parse(openedAt) + 1000,
      });
      assert.deepEqual(result.closed, []);

      const raw = JSON.parse(fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")) as TaskProgress;
      assert.equal(raw.roundLedger?.find((r) => r.roundId === "manual-review-just-opened")?.state, "open");
    } finally {
      wsStub.restore();
      fsBridge.restore();
    }
  });
});

void describe("repairMissingRoundOutcomeMessagesV1 (Part 4 step 14, pass (b))", () => {
  void it("appends exactly one outcome message for a terminal row that has none", async () => {
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    try {
      const { folderUri, folderPath } = makeTaskFolder("repair_missing_outcome", [
        {
          roundId: "attempt-repair-1",
          attemptIds: ["attempt-repair-1"],
          stage: "impl-high-review",
          mode: "review",
          startedAt: "2026-01-01T00:05:00.000Z",
          endedAt: "2026-01-01T00:10:00.000Z",
          state: "completed",
          outcome: { score: 8, reviewerBlockers: 1, mechanicalBlockers: 0 },
        },
      ]);

      const result = await repairMissingRoundOutcomeMessagesV1({ taskFolderUri: folderUri });
      assert.deepEqual(result.repaired, ["attempt-repair-1"]);

      const messages = await readChatHistory(folderPath, folderPath);
      const outcomeMessages = messages.filter(
        (m) => m.kind === "outcome" && m.roundId === "attempt-repair-1"
      );
      assert.equal(outcomeMessages.length, 1);
      assert.ok(outcomeMessages[0]?.text.includes("completed"));

      // Idempotent: a second call must not append a duplicate.
      const second = await repairMissingRoundOutcomeMessagesV1({ taskFolderUri: folderUri });
      assert.deepEqual(second.repaired, []);
      const messagesAfterSecond = await readChatHistory(folderPath, folderPath);
      assert.equal(
        messagesAfterSecond.filter((m) => m.kind === "outcome" && m.roundId === "attempt-repair-1").length,
        1
      );
    } finally {
      wsStub.restore();
      fsBridge.restore();
    }
  });

  void it("is a no-op when the terminal row already has its outcome message", async () => {
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    try {
      const { folderUri, folderPath } = makeTaskFolder("repair_already_present", [
        {
          roundId: "attempt-has-outcome-1",
          attemptIds: ["attempt-has-outcome-1"],
          stage: "impl",
          mode: "implementation",
          startedAt: "2026-01-01T00:05:00.000Z",
          endedAt: "2026-01-01T00:10:00.000Z",
          state: "completed",
          outcome: { filesChanged: ["a.ts"] },
        },
      ]);
      await appendChatMessageV1(
        folderPath,
        {
          role: "assistant",
          text: "_Ended: Implementation — completed — 1 file(s) changed_",
          stage: "impl",
          at: "2026-01-01T00:10:00.000Z",
          kind: "outcome",
          roundId: "attempt-has-outcome-1",
        },
        folderPath
      );

      const result = await repairMissingRoundOutcomeMessagesV1({ taskFolderUri: folderUri });
      assert.deepEqual(result.repaired, []);
      const messages = await readChatHistory(folderPath, folderPath);
      assert.equal(
        messages.filter((m) => m.kind === "outcome" && m.roundId === "attempt-has-outcome-1").length,
        1
      );
    } finally {
      wsStub.restore();
      fsBridge.restore();
    }
  });
});

void describe("synthesizeLegacyRoundLedgerRowsV1 (Part 4 step 14, pass (c))", () => {
  void it("synthesizes an interrupted row for a legacy auto-start message with no kind/intentId", async () => {
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    try {
      const { folderUri, folderPath } = makeTaskFolder("legacy_basic", []);
      await appendChatMessageV1(
        folderPath,
        {
          role: "assistant",
          text: "_Auto-starting: owed implementation continuation immediately after this round ended without a usable report (not setting-driven)._",
          stage: "impl",
          at: "2026-01-01T00:00:00.000Z",
        },
        folderPath
      );

      const result = await synthesizeLegacyRoundLedgerRowsV1({ taskFolderUri: folderUri });
      assert.equal(result.synthesized.length, 1);
      const roundId = result.synthesized[0] as string;
      assert.ok(roundId.startsWith("legacy:0:"));

      const raw = JSON.parse(fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")) as TaskProgress;
      const row = raw.roundLedger?.find((r) => r.roundId === roundId);
      assert.equal(row?.state, "interrupted");
      assert.equal(row?.mode, "implementation");
      assert.equal(row?.stage, "impl");
      assert.ok(row?.endedAt);
      assert.ok(row?.outcome?.rejectionReason?.includes("legacy transcript entry"));

      // Idempotent: re-running against the unchanged transcript must not
      // synthesize a second row for the same message.
      const second = await synthesizeLegacyRoundLedgerRowsV1({ taskFolderUri: folderUri });
      assert.deepEqual(second.synthesized, []);
    } finally {
      wsStub.restore();
      fsBridge.restore();
    }
  });

  void it("classifies a review-worded legacy announcement as mode 'review'", async () => {
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    try {
      const { folderUri, folderPath } = makeTaskFolder("legacy_review", []);
      await appendChatMessageV1(
        folderPath,
        {
          role: "assistant",
          text: "_Auto-starting: auto-review after implementation completes (controlled by `ensemble.autoReviewAfterImplementation`)._",
          stage: "impl-high-review",
          at: "2026-01-01T00:00:00.000Z",
        },
        folderPath
      );

      const result = await synthesizeLegacyRoundLedgerRowsV1({ taskFolderUri: folderUri });
      assert.equal(result.synthesized.length, 1);
      const raw = JSON.parse(fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")) as TaskProgress;
      const row = raw.roundLedger?.find((r) => r.roundId === result.synthesized[0]);
      assert.equal(row?.mode, "review");
    } finally {
      wsStub.restore();
      fsBridge.restore();
    }
  });

  void it("does NOT synthesize a row for a modern activity message that already carries kind", async () => {
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    try {
      const { folderUri, folderPath } = makeTaskFolder("legacy_modern_skip", []);
      await appendChatMessageV1(
        folderPath,
        {
          role: "assistant",
          text: "_Auto-starting: auto-review after implementation completes (not setting-driven)._",
          stage: "impl-high-review",
          at: "2026-01-01T00:00:00.000Z",
          kind: "activity",
          intentId: "intent-modern-1",
        },
        folderPath
      );

      const result = await synthesizeLegacyRoundLedgerRowsV1({ taskFolderUri: folderUri });
      assert.deepEqual(result.synthesized, []);
    } finally {
      wsStub.restore();
      fsBridge.restore();
    }
  });

  void it("synthesizes one row per legacy message when several exist", async () => {
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    try {
      const { folderUri, folderPath } = makeTaskFolder("legacy_multiple", []);
      for (let i = 0; i < 3; i++) {
        await appendChatMessageV1(
          folderPath,
          {
            role: "assistant",
            text: `_Auto-starting: owed implementation continuation re-armed by the periodic recovery sweep (not setting-driven)._`,
            stage: "impl",
            at: `2026-01-01T00:0${i}:00.000Z`,
          },
          folderPath
        );
      }

      const result = await synthesizeLegacyRoundLedgerRowsV1({ taskFolderUri: folderUri });
      assert.equal(result.synthesized.length, 3);
      assert.equal(new Set(result.synthesized).size, 3);
    } finally {
      wsStub.restore();
      fsBridge.restore();
    }
  });
});

void describe("reconcileRoundLedgerV1 (Part 4 step 14, orchestrator: (c) then (a) then (b))", () => {
  void it("synthesizes a legacy row and projects its outcome message in one call", async () => {
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    try {
      const { folderUri, folderPath } = makeTaskFolder("orchestrator_legacy_end_to_end", []);
      await appendChatMessageV1(
        folderPath,
        {
          role: "assistant",
          text: "_Auto-starting: owed implementation continuation immediately after this round ended without a usable report (not setting-driven)._",
          stage: "impl",
          at: "2026-01-01T00:00:00.000Z",
        },
        folderPath
      );

      const result = await reconcileRoundLedgerV1({
        taskFolderUri: folderUri,
        hasLiveOperation: false,
        hasLiveSchedulingIntent: false,
        liveOperationIds: [],
        liveSchedulingIntentIds: [],
      });
      assert.equal(result.synthesized.length, 1);
      assert.deepEqual(result.closed, []);
      assert.deepEqual(result.repaired, result.synthesized);

      const messages = await readChatHistory(folderPath, folderPath);
      const outcomeMessages = messages.filter((m) => m.kind === "outcome");
      assert.equal(outcomeMessages.length, 1);
      assert.equal(outcomeMessages[0]?.roundId, result.synthesized[0]);
      assert.ok(outcomeMessages[0]?.text.includes("interrupted"));

      // Running the whole orchestrator again against unchanged state changes
      // nothing — no new synthesis, no new close, no duplicate message.
      const second = await reconcileRoundLedgerV1({
        taskFolderUri: folderUri,
        hasLiveOperation: false,
        hasLiveSchedulingIntent: false,
        liveOperationIds: [],
        liveSchedulingIntentIds: [],
      });
      assert.deepEqual(second.synthesized, []);
      assert.deepEqual(second.closed, []);
      assert.deepEqual(second.repaired, []);
      const messagesAfterSecond = await readChatHistory(folderPath, folderPath);
      assert.equal(messagesAfterSecond.filter((m) => m.kind === "outcome").length, 1);
    } finally {
      wsStub.restore();
      fsBridge.restore();
    }
  });
});
