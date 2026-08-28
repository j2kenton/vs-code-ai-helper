/**
 * Coverage for the round-identity sidecar log (`roundIdentityLogV1.ts`) —
 * the allocation-time durability route for the coordinator's
 * `operationId`/`attemptId`, added 2026-08-28 to close the architectural
 * blocker "coordinator allocation sites still do not attach operation and
 * attempt identities to a round-ledger row ... at allocation time" without
 * reproducing the `publishOwnershipMatrix.test.ts` regression two prior
 * direct-attach attempts hit (see that module's own doc comment).
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { TaskProgress, RoundLedgerEntryV1 } from "../types/taskProgress";
import {
  appendRoundIdentityLogEntryBestEffortV1,
  backfillRoundIdentityFromLogV1,
  readRoundIdentityLogV1,
  ROUND_IDENTITY_LOG_FILENAME,
  ROUND_IDENTITY_LOG_MAX_ENTRIES,
} from "../utils/roundIdentityLogV1";
import { configureWorkflowPrivateStorageRootV1 } from "../services/workflowRuntimeServicesV1";

const REAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-round-identity-log-"));
const PRIVATE_STORAGE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-round-identity-log-private-"));
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

function makeTaskFolder(
  name: string,
  roundLedger: TaskProgress["roundLedger"]
): { folderPath: string; folderUri: vscode.Uri } {
  const folderPath = path.join(REAL_ROOT, "plans", name);
  fs.mkdirSync(folderPath, { recursive: true });
  const progress: TaskProgress & { ensembleProgressVersion: 1 } = {
    ensembleProgressVersion: 1,
    taskFolder: name,
    currentStage: "impl",
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

function readProgress(folderPath: string): TaskProgress {
  return JSON.parse(fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")) as TaskProgress;
}

void describe("roundIdentityLogV1 — allocation-time durable identity, independent of task-progress.json", () => {
  void it("appendRoundIdentityLogEntryBestEffortV1 / readRoundIdentityLogV1 round-trip, oldest first", async () => {
    const fsBridge = installFsBridge();
    const ws = installWorkspaceFoldersStub();
    try {
      const { folderUri } = makeTaskFolder("append-read-roundtrip", undefined);
      await appendRoundIdentityLogEntryBestEffortV1(folderUri, {
        roundId: "round-1",
        operationId: "op-1",
        attemptId: "attempt-1",
        at: "2026-08-28T00:00:00.000Z",
      });
      await appendRoundIdentityLogEntryBestEffortV1(folderUri, {
        roundId: "round-1",
        operationId: "op-1",
        attemptId: "attempt-2",
        at: "2026-08-28T00:00:01.000Z",
      });
      const entries = await readRoundIdentityLogV1(folderUri);
      assert.deepEqual(
        entries.map((e) => e.attemptId),
        ["attempt-1", "attempt-2"]
      );
      assert.equal(entries[0]?.roundId, "round-1");
      assert.equal(entries[0]?.operationId, "op-1");
    } finally {
      ws.restore();
      fsBridge.restore();
    }
  });

  void it("appending never touches task-progress.json — the write this module exists to avoid racing", async () => {
    const fsBridge = installFsBridge();
    const ws = installWorkspaceFoldersStub();
    try {
      const { folderUri, folderPath } = makeTaskFolder("no-progress-write", undefined);
      const before = fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8");
      await appendRoundIdentityLogEntryBestEffortV1(folderUri, {
        roundId: "round-1",
        operationId: "op-1",
        attemptId: "attempt-1",
        at: "2026-08-28T00:00:00.000Z",
      });
      const after = fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8");
      assert.equal(after, before, "task-progress.json must be byte-identical after an identity-log append");
      assert.ok(
        fs.existsSync(path.join(folderPath, ROUND_IDENTITY_LOG_FILENAME)),
        "expected the sidecar log file to exist"
      );
    } finally {
      ws.restore();
      fsBridge.restore();
    }
  });

  void it("readRoundIdentityLogV1 skips a malformed trailing line instead of discarding the whole log", async () => {
    const fsBridge = installFsBridge();
    const ws = installWorkspaceFoldersStub();
    try {
      const { folderUri, folderPath } = makeTaskFolder("malformed-line", undefined);
      const goodLine = JSON.stringify({
        roundId: "round-1",
        operationId: "op-1",
        attemptId: "attempt-1",
        at: "2026-08-28T00:00:00.000Z",
      });
      fs.writeFileSync(
        path.join(folderPath, ROUND_IDENTITY_LOG_FILENAME),
        `${goodLine}\n{"roundId":"round-2",broken\n`,
        "utf8"
      );
      const entries = await readRoundIdentityLogV1(folderUri);
      assert.equal(entries.length, 1);
      assert.equal(entries[0]?.roundId, "round-1");
    } finally {
      ws.restore();
      fsBridge.restore();
    }
  });

  void it("caps retained entries at ROUND_IDENTITY_LOG_MAX_ENTRIES, dropping oldest first", async () => {
    const fsBridge = installFsBridge();
    const ws = installWorkspaceFoldersStub();
    try {
      const { folderUri } = makeTaskFolder("capped-log", undefined);
      const total = ROUND_IDENTITY_LOG_MAX_ENTRIES + 5;
      for (let i = 0; i < total; i++) {
        await appendRoundIdentityLogEntryBestEffortV1(folderUri, {
          roundId: `round-${i}`,
          operationId: `op-${i}`,
          attemptId: `attempt-${i}`,
          at: `2026-08-28T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
        });
      }
      const entries = await readRoundIdentityLogV1(folderUri);
      assert.equal(entries.length, ROUND_IDENTITY_LOG_MAX_ENTRIES);
      assert.equal(entries[0]?.roundId, "round-5", "expected the oldest 5 entries to have been dropped");
      assert.equal(entries[entries.length - 1]?.roundId, `round-${total - 1}`);
    } finally {
      ws.restore();
      fsBridge.restore();
    }
  });

  void it("backfillRoundIdentityFromLogV1 attaches operationId/attemptId onto a live row missing them", async () => {
    const fsBridge = installFsBridge();
    const ws = installWorkspaceFoldersStub();
    try {
      const row: RoundLedgerEntryV1 = {
        roundId: "review-attempt-1",
        attemptIds: [],
        stage: "impl-high-review",
        mode: "review",
        startedAt: "2026-08-28T00:00:00.000Z",
        state: "open",
      };
      const { folderUri, folderPath } = makeTaskFolder("backfill-live-row", [row]);
      // Simulates the exact crash window this closes: the attempt was
      // allocated (and logged) but the process died before `onPromptAssembled`
      // could ever attach the identity directly.
      await appendRoundIdentityLogEntryBestEffortV1(folderUri, {
        roundId: "review-attempt-1",
        operationId: "op-1",
        attemptId: "attempt-1",
        at: "2026-08-28T00:00:00.500Z",
      });

      await backfillRoundIdentityFromLogV1(folderUri);

      const progress = readProgress(folderPath);
      const backfilled = progress.roundLedger?.find((r) => r.roundId === "review-attempt-1");
      assert.equal(backfilled?.operationId, "op-1");
      assert.deepEqual(backfilled?.attemptIds, ["attempt-1"]);
      // Only the identity fields changed — state/stage/mode/startedAt are untouched.
      assert.equal(backfilled?.state, "open");
      assert.equal(backfilled?.stage, "impl-high-review");
    } finally {
      ws.restore();
      fsBridge.restore();
    }
  });

  void it("backfillRoundIdentityFromLogV1 never overwrites an operationId the row already carries", async () => {
    const fsBridge = installFsBridge();
    const ws = installWorkspaceFoldersStub();
    try {
      const row: RoundLedgerEntryV1 = {
        roundId: "review-attempt-2",
        attemptIds: ["attempt-real"],
        operationId: "op-real",
        stage: "impl-high-review",
        mode: "review",
        startedAt: "2026-08-28T00:00:00.000Z",
        state: "open",
      };
      const { folderUri, folderPath } = makeTaskFolder("backfill-no-overwrite", [row]);
      await appendRoundIdentityLogEntryBestEffortV1(folderUri, {
        roundId: "review-attempt-2",
        operationId: "op-stale-or-wrong",
        attemptId: "attempt-real",
        at: "2026-08-28T00:00:00.500Z",
      });

      await backfillRoundIdentityFromLogV1(folderUri);

      const progress = readProgress(folderPath);
      const untouched = progress.roundLedger?.find((r) => r.roundId === "review-attempt-2");
      assert.equal(untouched?.operationId, "op-real", "operationId must never be reassigned once set");
      assert.deepEqual(untouched?.attemptIds, ["attempt-real"]);
    } finally {
      ws.restore();
      fsBridge.restore();
    }
  });

  void it("backfillRoundIdentityFromLogV1 attaches identity onto an already-terminal row without touching state/outcome", async () => {
    const fsBridge = installFsBridge();
    const ws = installWorkspaceFoldersStub();
    try {
      const row: RoundLedgerEntryV1 = {
        roundId: "review-attempt-3",
        attemptIds: [],
        stage: "impl-high-review",
        mode: "review",
        startedAt: "2026-08-28T00:00:00.000Z",
        state: "interrupted",
        endedAt: "2026-08-28T00:05:00.000Z",
        outcome: { rejectionReason: "started 00:00; no ending was recorded — the extension host stopped or the round was lost" },
      };
      const { folderUri, folderPath } = makeTaskFolder("backfill-terminal-row", [row]);
      await appendRoundIdentityLogEntryBestEffortV1(folderUri, {
        roundId: "review-attempt-3",
        operationId: "op-late",
        attemptId: "attempt-late",
        at: "2026-08-28T00:00:00.500Z",
      });

      await backfillRoundIdentityFromLogV1(folderUri);

      const progress = readProgress(folderPath);
      const backfilled = progress.roundLedger?.find((r) => r.roundId === "review-attempt-3");
      assert.equal(backfilled?.operationId, "op-late");
      assert.deepEqual(backfilled?.attemptIds, ["attempt-late"]);
      assert.equal(backfilled?.state, "interrupted", "backfill must never amend a terminal row's state");
      assert.equal(backfilled?.endedAt, "2026-08-28T00:05:00.000Z");
      assert.equal(
        backfilled?.outcome?.rejectionReason,
        "started 00:00; no ending was recorded — the extension host stopped or the round was lost"
      );
    } finally {
      ws.restore();
      fsBridge.restore();
    }
  });

  void it("backfillRoundIdentityFromLogV1 is a no-op when nothing in the log resolves to a row", async () => {
    const fsBridge = installFsBridge();
    const ws = installWorkspaceFoldersStub();
    try {
      const { folderUri, folderPath } = makeTaskFolder("backfill-no-match", undefined);
      const before = fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8");
      await appendRoundIdentityLogEntryBestEffortV1(folderUri, {
        roundId: "no-such-round",
        operationId: "op-1",
        attemptId: "attempt-1",
        at: "2026-08-28T00:00:00.000Z",
      });

      await backfillRoundIdentityFromLogV1(folderUri);

      const after = fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8");
      assert.equal(after, before, "task-progress.json must be untouched when nothing in the log resolves");
    } finally {
      ws.restore();
      fsBridge.restore();
    }
  });

  void it("backfillRoundIdentityFromLogV1 is idempotent — running it twice changes nothing on the second run", async () => {
    const fsBridge = installFsBridge();
    const ws = installWorkspaceFoldersStub();
    try {
      const row: RoundLedgerEntryV1 = {
        roundId: "review-attempt-4",
        attemptIds: [],
        stage: "impl-high-review",
        mode: "review",
        startedAt: "2026-08-28T00:00:00.000Z",
        state: "open",
      };
      const { folderUri, folderPath } = makeTaskFolder("backfill-idempotent", [row]);
      await appendRoundIdentityLogEntryBestEffortV1(folderUri, {
        roundId: "review-attempt-4",
        operationId: "op-1",
        attemptId: "attempt-1",
        at: "2026-08-28T00:00:00.500Z",
      });

      await backfillRoundIdentityFromLogV1(folderUri);
      const afterFirst = fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8");
      await backfillRoundIdentityFromLogV1(folderUri);
      const afterSecond = fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8");

      assert.equal(afterSecond, afterFirst, "a second backfill run against unchanged state must be a true no-op");
    } finally {
      ws.restore();
      fsBridge.restore();
    }
  });
});
