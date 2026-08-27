/**
 * Coverage for Part 4 / item 1's "source/continuation linkage" —
 * `beginImplementationRecoveryV1` terminalizing the round that triggered
 * recovery in the SAME patch that records `implRecovery`, and
 * `claimImplRecoveryDispatchV1` linking the continuation round's own
 * `roundLedger` row back to it via `continuationOf` (`implementationRecoveryV1.ts`).
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import { TaskProgress } from "../types/taskProgress";
import {
  beginImplementationRecoveryV1,
  claimImplRecoveryDispatchV1,
} from "../commands/implementationRecoveryV1";
import { configureWorkflowPrivateStorageRootV1 } from "../services/workflowRuntimeServicesV1";
import { readChatHistory } from "../utils/chatHistoryStore";

const REAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-impl-recovery-ledger-"));
const PRIVATE_STORAGE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-impl-recovery-ledger-private-"));
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

void describe("beginImplementationRecoveryV1 — source round terminalization (Part 4 / item 1)", () => {
  void it("synthesizes and terminalizes a source row when the task had no live row", async () => {
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    try {
      const { folderUri, folderPath } = makeTaskFolder("no_live_row", undefined);

      const begun = await beginImplementationRecoveryV1(folderUri, {
        trigger: "summaryRejected",
        reason: "the provider did not return a usable summary",
        terminatedExternally: false,
        filesChanged: ["src/a.ts"],
        filesChangedUnknown: false,
        postRunReviewStage: "impl",
      });

      const raw = readProgress(folderPath);
      assert.equal(raw.implRecovery?.sourceRoundId, begun.sourceAttemptId);
      const row = raw.roundLedger?.find((r) => r.roundId === begun.sourceAttemptId);
      assert.ok(row, "a source row must be synthesized under sourceAttemptId");
      assert.equal(row?.state, "rejected");
      assert.equal(row?.outcome?.continuationOwed, true);
      assert.equal(row?.outcome?.rejectionReason, "the provider did not return a usable summary");
      assert.deepEqual(row?.outcome?.filesChanged, ["src/a.ts"]);

      const messages = await readChatHistory(folderPath, folderPath);
      const outcomeMessages = messages.filter((m) => m.kind === "outcome" && m.roundId === begun.sourceAttemptId);
      assert.equal(outcomeMessages.length, 1);
      assert.match(outcomeMessages[0]?.text ?? "", /rejected/);
    } finally {
      wsStub.restore();
      fsBridge.restore();
    }
  });

  void it("terminalizes the task's existing live row instead of opening a second one", async () => {
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    try {
      const { folderUri, folderPath } = makeTaskFolder("existing_live_row", [
        {
          roundId: "attempt-generic-1",
          intentId: "intent-generic-1",
          attemptIds: [],
          stage: "impl",
          mode: "implementation",
          startedAt: "2026-01-01T00:05:00.000Z",
          state: "open",
        },
      ]);

      const begun = await beginImplementationRecoveryV1(folderUri, {
        trigger: "roundIncomplete",
        reason: "the round ended without a usable report",
        terminatedExternally: false,
        filesChanged: [],
        filesChangedUnknown: false,
        postRunReviewStage: "impl",
      });

      const raw = readProgress(folderPath);
      // No second row was synthesized under sourceAttemptId.
      assert.equal(raw.roundLedger?.find((r) => r.roundId === begun.sourceAttemptId), undefined);
      const row = raw.roundLedger?.find((r) => r.roundId === "attempt-generic-1");
      assert.equal(row?.state, "failed");
      assert.equal(row?.outcome?.continuationOwed, true);
      assert.equal(row?.intentId, "intent-generic-1", "the row's own identity must survive being terminalized");
      assert.equal(raw.implRecovery?.sourceRoundId, "attempt-generic-1");
      assert.equal(raw.roundLedger?.length, 1, "the live row must be reused, not duplicated");
    } finally {
      wsStub.restore();
      fsBridge.restore();
    }
  });

  void it("resolves the source row by sourceRoundIdHint, not the first live row, when more than one row is live (2026-08-27 review follow-up)", async () => {
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    try {
      const { folderUri, folderPath } = makeTaskFolder("hinted_source_row", [
        {
          roundId: "unrelated-live-row",
          attemptIds: [],
          stage: "impl",
          mode: "implementation",
          startedAt: "2026-01-01T00:01:00.000Z",
          state: "open",
        },
        {
          roundId: "the-actual-triggering-round",
          attemptIds: [],
          stage: "impl",
          mode: "implementation",
          startedAt: "2026-01-01T00:02:00.000Z",
          state: "open",
        },
      ]);

      const begun = await beginImplementationRecoveryV1(folderUri, {
        trigger: "summaryRejected",
        reason: "the provider did not return a usable summary",
        terminatedExternally: false,
        filesChanged: ["src/a.ts"],
        filesChangedUnknown: false,
        postRunReviewStage: "impl",
        sourceRoundIdHint: "the-actual-triggering-round",
      });

      const raw = readProgress(folderPath);
      assert.equal(raw.implRecovery?.sourceRoundId, "the-actual-triggering-round");
      const hintedRow = raw.roundLedger?.find((r) => r.roundId === "the-actual-triggering-round");
      assert.equal(hintedRow?.state, "rejected", "the HINTED row must be terminalized");
      const unrelatedRow = raw.roundLedger?.find((r) => r.roundId === "unrelated-live-row");
      assert.equal(unrelatedRow?.state, "open", "an unrelated live row must be left untouched");
      assert.equal(raw.roundLedger?.find((r) => r.roundId === begun.sourceAttemptId), undefined);
    } finally {
      wsStub.restore();
      fsBridge.restore();
    }
  });

  void it("terminalizes as interrupted for an externally-terminated round", async () => {
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    try {
      const { folderUri, folderPath } = makeTaskFolder("externally_terminated", undefined);

      const begun = await beginImplementationRecoveryV1(folderUri, {
        trigger: "externallyTerminated",
        reason: "timed out and was stopped before returning a final response",
        terminatedExternally: true,
        filesChanged: [],
        filesChangedUnknown: true,
        postRunReviewStage: "impl",
      });

      const raw = readProgress(folderPath);
      const row = raw.roundLedger?.find((r) => r.roundId === begun.sourceAttemptId);
      assert.equal(row?.state, "interrupted");
      assert.equal(row?.outcome?.filesChangedUnknown, true);
    } finally {
      wsStub.restore();
      fsBridge.restore();
    }
  });
});

void describe("claimImplRecoveryDispatchV1 — continuation row linkage (Part 4 / item 1)", () => {
  void it("synthesizes a continuation row linked to the source when the task has no live row (manual rerun)", async () => {
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    try {
      const { folderUri, folderPath } = makeTaskFolder("claim_no_live_row", [
        {
          roundId: "source-round-1",
          attemptIds: [],
          stage: "impl",
          mode: "implementation",
          startedAt: "2026-01-01T00:00:00.000Z",
          endedAt: "2026-01-01T00:05:00.000Z",
          state: "rejected",
          outcome: { rejectionReason: "unusable summary", continuationOwed: true },
        },
      ]);
      fs.writeFileSync(
        path.join(folderPath, "task-progress.json"),
        JSON.stringify(
          {
            ...readProgress(folderPath),
            implRecovery: {
              sourceAttemptId: "impl-recovery-1",
              sourceRoundId: "source-round-1",
              reason: "unusable summary",
              trigger: "summaryRejected",
              mode: "unconstrained",
              dispatch: "pending",
              at: "2026-01-01T00:05:00.000Z",
            },
          },
          null,
          2
        ),
        "utf8"
      );

      const claimed = await claimImplRecoveryDispatchV1(folderUri);
      assert.equal(claimed.record?.dispatch, "dispatched");
      const continuationAttemptId = claimed.record?.attemptId as string;

      const raw = readProgress(folderPath);
      const continuationRow = raw.roundLedger?.find((r) => r.roundId === continuationAttemptId);
      assert.ok(continuationRow, "a continuation row must be synthesized");
      assert.equal(continuationRow?.mode, "continuation");
      assert.equal(continuationRow?.continuationOf, "source-round-1");
      assert.equal(continuationRow?.state, "open");

      // The source row's own terminal state must survive unchanged.
      const sourceRow = raw.roundLedger?.find((r) => r.roundId === "source-round-1");
      assert.equal(sourceRow?.state, "rejected");
    } finally {
      wsStub.restore();
      fsBridge.restore();
    }
  });

  void it("reuses the task's existing live row (an auto-dispatched continuation's own generic row) rather than opening a second one", async () => {
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    try {
      const { folderUri, folderPath } = makeTaskFolder("claim_reuses_live_row", [
        {
          roundId: "source-round-2",
          attemptIds: [],
          stage: "impl",
          mode: "implementation",
          startedAt: "2026-01-01T00:00:00.000Z",
          endedAt: "2026-01-01T00:05:00.000Z",
          state: "failed",
          outcome: { rejectionReason: "round incomplete", continuationOwed: true },
        },
        {
          roundId: "intent-continuation-2",
          intentId: "intent-continuation-2",
          attemptIds: [],
          stage: "impl",
          mode: "implementation",
          startedAt: "2026-01-01T00:06:00.000Z",
          state: "open",
        },
      ]);
      fs.writeFileSync(
        path.join(folderPath, "task-progress.json"),
        JSON.stringify(
          {
            ...readProgress(folderPath),
            implRecovery: {
              sourceAttemptId: "impl-recovery-2",
              sourceRoundId: "source-round-2",
              reason: "round incomplete",
              trigger: "roundIncomplete",
              mode: "unconstrained",
              dispatch: "pending",
              at: "2026-01-01T00:05:00.000Z",
            },
          },
          null,
          2
        ),
        "utf8"
      );

      const claimed = await claimImplRecoveryDispatchV1(folderUri);
      assert.equal(claimed.record?.dispatch, "dispatched");

      const raw = readProgress(folderPath);
      // No new row was synthesized under the continuation attemptId — the
      // existing generic row (opened by the automation dispatch) was reused.
      assert.equal(raw.roundLedger?.length, 2);
      const continuationRow = raw.roundLedger?.find((r) => r.roundId === "intent-continuation-2");
      assert.equal(continuationRow?.mode, "continuation");
      assert.equal(continuationRow?.continuationOf, "source-round-2");
      assert.equal(continuationRow?.intentId, "intent-continuation-2", "the reused row's own identity must survive");
      // 2026-08-27 review follow-up: the continuation's own `attemptId` must
      // ALSO resolve to this reused row — a later caller (e.g.
      // `executeImplementationRun`'s own `claimImplementationRoundLedgerV1`
      // call, or a further recovery transition's `sourceRoundIdHint`) holds
      // only `claimed.record?.attemptId`, never the row's own pre-existing
      // `roundId`.
      assert.ok(
        continuationRow?.attemptIds.includes(claimed.record?.attemptId as string),
        "the reused row must carry the continuation's own attemptId so callers holding only that id can resolve it"
      );
    } finally {
      wsStub.restore();
      fsBridge.restore();
    }
  });
});
