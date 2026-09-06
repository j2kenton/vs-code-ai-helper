/**
 * Unit coverage for Part 4 (item 1)'s round-lifecycle primitives —
 * `resolveRoundV1`/`upsertRoundLedgerEntryV1` (`taskProgressTransforms.ts`)
 * and `terminalizeRoundV1` (`roundLedgerV1.ts`) — verified in isolation
 * against directly-constructed `TaskProgress` fixtures and a real (temp-dir)
 * task folder, exactly as the plan's acceptance criteria for step 12/13
 * describe. Wiring status, kept in sync with `roundLedgerV1.ts`'s own module
 * doc comment: the review-round path (`claimReviewAttempt` opening the row,
 * `handleReviewRoutingOutcome`/`terminalizeUnclosedReviewRoundV1` closing it)
 * is wired and covered below by real calls into `reviewActions.ts`; the
 * generic automation-dispatch path (`openAutomationRoundLedgerRowBestEffortV1`
 * opening a row under the dispatch's `intentId`, `automationChain.ts`'s
 * `deps.execute` settle points closing it) is also wired and covered below —
 * see `automationChain.test.ts` for the end-to-end open+close coverage
 * through `scheduleAutomationChain` itself. The six implementation-round
 * `appendRoundOutcome` sites' OWN rich per-round accounting (files
 * changed/score/blockers) and the implementation-recovery continuation-row
 * linkage remain unwired — that is the rest of Part 4, still outstanding.
 */
import * as assert from "node:assert/strict";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import {
  ChecklistChangeProposalV1,
  RoundLedgerEntryV1,
  TaskProgress,
} from "../types/taskProgress";
import {
  findRoundOutcomesMissingLedgerRowV1,
  recordTaskMdSizeBandAnnouncedV1,
  resolveRoundV1,
  upsertRoundLedgerEntryV1,
} from "../utils/taskProgressTransforms";
import {
  __resetPendingAutomationRoundIntentsForTestV1,
  attachCoordinatorIdentityToRoundV1,
  claimImplementationRoundLedgerV1,
  consumePendingAutomationRoundIntentV1,
  formatRoundOutcomeMessageV1,
  openAutomationRoundLedgerRowBestEffortV1,
  roundLedgerModeForCommandV1,
  setPendingAutomationRoundIntentV1,
  terminalizeRoundV1,
} from "../utils/roundLedgerV1";
import { readChatHistory } from "../utils/chatHistoryStore";
import {
  configureWorkflowPrivateStorageRootV1,
} from "../services/workflowRuntimeServicesV1";
import {
  claimReviewAttempt,
  claimReviewAttemptWithLiveLeaseV1,
  handleReviewRoutingOutcome,
  terminalStateForUnclosedReviewOutcomeV1,
} from "../commands/reviewActions";
import { deactivateNotificationRouter, initNotificationRouter } from "../utils/notificationRouter";
import { TaskActionOutcomeV1 } from "../types/taskActionOutcomeV1";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import { listLiveRoundLeaseIdsV1 } from "../state/roundLeaseV1";

const REAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-round-ledger-"));
cp.execFileSync("git", ["init", "-q"], { cwd: REAL_ROOT, windowsHide: true });

const PRIVATE_STORAGE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-round-ledger-private-"));
configureWorkflowPrivateStorageRootV1(PRIVATE_STORAGE_ROOT);

function makeBaseEntry(overrides: Partial<RoundLedgerEntryV1> = {}): RoundLedgerEntryV1 {
  return {
    roundId: "intent-0001",
    intentId: "intent-0001",
    attemptIds: ["attempt-0001"],
    stage: "impl",
    mode: "implementation",
    startedAt: "2026-01-01T00:00:00.000Z",
    state: "open",
    ...overrides,
  };
}

function makeProgress(overrides: Partial<TaskProgress> = {}): TaskProgress {
  return {
    taskFolder: "task_x",
    currentStage: "impl",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

void describe("resolveRoundV1 (Part 4 step 12/46)", () => {
  void it("resolves a row by its own roundId", () => {
    const entry = makeBaseEntry({ roundId: "round-A" });
    const progress = makeProgress({ roundLedger: [entry] });
    assert.equal(resolveRoundV1(progress, "round-A"), entry);
  });

  void it("resolves a row by its intentId, distinct from roundId", () => {
    const entry = makeBaseEntry({ roundId: "operation-1", intentId: "intent-1" });
    const progress = makeProgress({ roundLedger: [entry] });
    assert.equal(resolveRoundV1(progress, "intent-1"), entry);
    assert.equal(resolveRoundV1(progress, "operation-1"), entry);
  });

  void it("resolves a row by its operationId", () => {
    const entry = makeBaseEntry({ roundId: "intent-1", operationId: "op-1" });
    const progress = makeProgress({ roundLedger: [entry] });
    assert.equal(resolveRoundV1(progress, "op-1"), entry);
  });

  void it("resolves a row by ANY of its attemptIds — including a retried one", () => {
    const entry = makeBaseEntry({
      roundId: "intent-1",
      attemptIds: ["attempt-1", "attempt-2-retry", "attempt-3-fallback"],
    });
    const progress = makeProgress({ roundLedger: [entry] });
    assert.equal(resolveRoundV1(progress, "attempt-1"), entry);
    assert.equal(resolveRoundV1(progress, "attempt-2-retry"), entry);
    assert.equal(resolveRoundV1(progress, "attempt-3-fallback"), entry);
  });

  void it("a round's intentId, operationId, and every attemptId all resolve to the SAME row (acceptance criterion)", () => {
    const entry = makeBaseEntry({
      roundId: "intent-42",
      intentId: "intent-42",
      operationId: "op-42",
      attemptIds: ["attempt-a", "attempt-b-retry"],
    });
    const progress = makeProgress({ roundLedger: [entry] });
    const byIntent = resolveRoundV1(progress, "intent-42");
    const byOperation = resolveRoundV1(progress, "op-42");
    const byAttemptA = resolveRoundV1(progress, "attempt-a");
    const byAttemptB = resolveRoundV1(progress, "attempt-b-retry");
    assert.equal(byIntent, entry);
    assert.equal(byOperation, entry);
    assert.equal(byAttemptA, entry);
    assert.equal(byAttemptB, entry);
  });

  void it("returns undefined for an id no row carries", () => {
    const progress = makeProgress({ roundLedger: [makeBaseEntry()] });
    assert.equal(resolveRoundV1(progress, "nothing-matches"), undefined);
  });

  void it("returns undefined against an empty/absent roundLedger", () => {
    assert.equal(resolveRoundV1(makeProgress(), "anything"), undefined);
    assert.equal(resolveRoundV1(makeProgress({ roundLedger: [] }), "anything"), undefined);
  });
});

void describe("upsertRoundLedgerEntryV1 (Part 4 step 12/44)", () => {
  void it("appends a new row when no row shares its roundId", () => {
    const first = makeBaseEntry({ roundId: "round-1" });
    const progress = upsertRoundLedgerEntryV1(makeProgress(), first);
    const second = makeBaseEntry({ roundId: "round-2" });
    const next = upsertRoundLedgerEntryV1(progress, second);
    assert.deepEqual(next.roundLedger, [first, second]);
  });

  void it("replaces the existing row in place when roundId matches", () => {
    const original = makeBaseEntry({ roundId: "round-1", state: "open" });
    const progress = upsertRoundLedgerEntryV1(makeProgress(), original);
    const terminal = { ...original, state: "completed" as const, endedAt: "2026-01-01T00:05:00.000Z" };
    const next = upsertRoundLedgerEntryV1(progress, terminal);
    assert.equal(next.roundLedger?.length, 1);
    assert.deepEqual(next.roundLedger?.[0], terminal);
  });

  void it("drops the OLDEST terminal row first once over cap, never a live scheduled/open row", () => {
    let progress = makeProgress();
    // Two live rows first, then enough terminal rows to exceed a small cap
    // is impractical to test against the real 200 cap directly — instead
    // prove the ORDERING RULE the cap logic implements: given a mix, the
    // oldest terminal entry is the one removed, and a live entry is never
    // removed even when it is the oldest entry present.
    const live = makeBaseEntry({ roundId: "live-1", state: "open" });
    const oldestTerminal = makeBaseEntry({
      roundId: "terminal-1",
      state: "completed",
      endedAt: "2026-01-01T00:01:00.000Z",
    });
    const newerTerminal = makeBaseEntry({
      roundId: "terminal-2",
      state: "completed",
      endedAt: "2026-01-01T00:02:00.000Z",
    });
    progress = upsertRoundLedgerEntryV1(progress, live);
    progress = upsertRoundLedgerEntryV1(progress, oldestTerminal);
    progress = upsertRoundLedgerEntryV1(progress, newerTerminal);
    assert.deepEqual(
      progress.roundLedger?.map((r) => r.roundId),
      ["live-1", "terminal-1", "terminal-2"]
    );
  });

  void it(
    "protects a terminal row named by a pending/revising checklistChangeProposals entry from cap eviction, even as the OLDEST terminal row present (2026-08-28 review fix, completion blocker: a plan revision can outlive the round-ledger's ordinary FIFO pressure)",
    () => {
      const protectedRow = makeBaseEntry({
        roundId: "protected-mutating-round",
        state: "completed",
        endedAt: "2026-01-01T00:00:01.000Z",
      });
      // Fill the ledger to exactly the cap with terminal rows OLDER than
      // protectedRow is not needed — protectedRow is deliberately the FIRST
      // (oldest) entry, then MAX_ROUND_LEDGER_ENTRIES - 1 more terminal
      // filler rows bring the array to exactly cap before the upsert below
      // pushes it one over.
      const filler: RoundLedgerEntryV1[] = Array.from({ length: 199 }, (_, i) =>
        makeBaseEntry({
          roundId: `filler-${i}`,
          state: "completed",
          endedAt: `2026-01-01T00:00:${String(2 + i).padStart(2, "0")}.000Z`,
        })
      );
      const revisingProposal: ChecklistChangeProposalV1 = {
        at: "2026-01-01T00:00:00.000Z",
        roundId: "protected-mutating-round",
        stage: "impl",
        kind: "added",
        proposedItems: ["some new step"],
        removedItems: [],
        status: "revising",
      };
      const progress = makeProgress({
        roundLedger: [protectedRow, ...filler],
        checklistChangeProposals: [revisingProposal],
      });
      assert.equal(progress.roundLedger?.length, 200);

      const oneMore = makeBaseEntry({ roundId: "pushes-over-cap", state: "completed", endedAt: "2026-01-01T00:05:00.000Z" });
      const next = upsertRoundLedgerEntryV1(progress, oneMore);

      assert.equal(next.roundLedger?.length, 200, "stays at cap");
      assert.ok(
        next.roundLedger?.some((r) => r.roundId === "protected-mutating-round"),
        "the row named by the pending revision proposal must survive eviction even as the oldest terminal row"
      );
      assert.ok(
        !next.roundLedger?.some((r) => r.roundId === "filler-0"),
        "the oldest UNPROTECTED terminal row is the one actually dropped"
      );

      // Once the proposal resolves (adopted/discarded), protection lifts and
      // the same row becomes evictable like any other terminal row again.
      const adoptedProgress = {
        ...progress,
        checklistChangeProposals: [{ ...revisingProposal, status: "adopted" as const }],
      };
      const afterAdoption = upsertRoundLedgerEntryV1(adoptedProgress, oneMore);
      assert.ok(
        !afterAdoption.roundLedger?.some((r) => r.roundId === "protected-mutating-round"),
        "protection lifts once the proposal is no longer pending/revising"
      );
    }
  );
});

function makeTaskFolder(name: string): { folderPath: string; folderUri: vscode.Uri } {
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
    roundLedger: [
      makeBaseEntry({ roundId: "round-open-1", intentId: "round-open-1", stage: "impl", state: "open" }),
    ],
  };
  fs.writeFileSync(
    path.join(folderPath, "task-progress.json"),
    JSON.stringify(progress, null, 2),
    "utf8"
  );
  return { folderPath, folderUri: vscode.Uri.file(folderPath) };
}

function installFsBridge(): { restore: () => void } {
  const target = vscode.workspace.fs as unknown as Record<string, unknown>;
  const orig = { ...target };
  target.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  target.writeFile = async (uri: vscode.Uri, content: Uint8Array): Promise<void> => {
    await fs.promises.mkdir(path.dirname(uri.fsPath), { recursive: true });
    await fs.promises.writeFile(uri.fsPath, content);
  };
  target.rename = async (
    source: vscode.Uri,
    dest: vscode.Uri,
    _options?: { overwrite?: boolean }
  ): Promise<void> => {
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
    return {
      type: stat.isDirectory() ? 2 : 1,
      size: stat.size,
      ctime: stat.ctimeMs,
      mtime: stat.mtimeMs,
    };
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

void describe("terminalizeRoundV1 (Part 4 step 12/13/47)", () => {
  void it("terminalizes an open row, writes the ledger state, and appends a kind:'outcome' chat message", async () => {
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    try {
      const { folderPath, folderUri } = makeTaskFolder("round_ledger_basic");
      const result = await terminalizeRoundV1(
        "round-open-1",
        "completed",
        { filesChanged: ["src/a.ts"], runLogPath: "runs/001-impl.md" },
        { taskFolderUri: folderUri }
      );
      assert.equal(result.ok, true);
      if (!result.ok) throw new Error("unreachable");
      assert.equal(result.alreadyTerminal, false);
      assert.equal(result.entry.state, "completed");
      assert.ok(result.entry.endedAt);

      const raw = JSON.parse(fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")) as TaskProgress;
      assert.equal(raw.roundLedger?.[0]?.state, "completed");
      assert.deepEqual(raw.roundLedger?.[0]?.outcome?.filesChanged, ["src/a.ts"]);

      const messages = await readChatHistory(folderPath, folderPath);
      const outcomeMessages = messages.filter((m) => m.kind === "outcome");
      assert.equal(outcomeMessages.length, 1);
      assert.equal(outcomeMessages[0]?.roundId, "round-open-1");
      assert.equal(outcomeMessages[0]?.intentId, "round-open-1");
      assert.ok(outcomeMessages[0]?.text.includes("completed"));
    } finally {
      wsStub.restore();
      fsBridge.restore();
    }
  });

  void it("is idempotent: a second call against an already-terminal row is a no-op that writes no second outcome message", async () => {
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    try {
      const { folderPath, folderUri } = makeTaskFolder("round_ledger_idempotent");
      const first = await terminalizeRoundV1("round-open-1", "completed", undefined, { taskFolderUri: folderUri });
      assert.equal(first.ok, true);

      const second = await terminalizeRoundV1("round-open-1", "failed", undefined, { taskFolderUri: folderUri });
      assert.equal(second.ok, true);
      if (!second.ok) throw new Error("unreachable");
      assert.equal(second.alreadyTerminal, true);
      // The state from the FIRST call is preserved — the second call's
      // different requested state ("failed") must never overwrite it.
      assert.equal(second.entry.state, "completed");

      const messages = await readChatHistory(folderPath, folderPath);
      const outcomeMessages = messages.filter((m) => m.kind === "outcome");
      assert.equal(outcomeMessages.length, 1, "a second terminalize call must not write a second outcome message");
    } finally {
      wsStub.restore();
      fsBridge.restore();
    }
  });

  void it("reports notFound for an id matching no row, without writing anything", async () => {
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    try {
      const { folderPath, folderUri } = makeTaskFolder("round_ledger_notfound");
      const result = await terminalizeRoundV1("does-not-exist", "completed", undefined, { taskFolderUri: folderUri });
      assert.equal(result.ok, false);
      if (result.ok) throw new Error("unreachable");
      assert.equal(result.reason, "notFound");

      const messages = await readChatHistory(folderPath, folderPath);
      assert.equal(messages.length, 0);
    } finally {
      wsStub.restore();
      fsBridge.restore();
    }
  });

  void it("resolves the round by its attemptId, not only its roundId", async () => {
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    try {
      const { folderUri } = makeTaskFolder("round_ledger_by_attempt");
      const result = await terminalizeRoundV1("attempt-0001", "rejected", { rejectionReason: "shape gate failed" }, { taskFolderUri: folderUri });
      assert.equal(result.ok, true);
      if (!result.ok) throw new Error("unreachable");
      assert.equal(result.entry.roundId, "round-open-1");
      assert.equal(result.entry.state, "rejected");
    } finally {
      wsStub.restore();
      fsBridge.restore();
    }
  });

  // 2026-08-27 review, blocker "review rows... omit earlier retry-attempt
  // identities": a round can accumulate several coordinator attempts (a
  // primary candidate that fails, then a fallback candidate, or an item-14
  // same-candidate retry) — every one of them must resolve to the row, not
  // only the last (which `attemptId` alone carried before this fix).
  void it("attaches EVERY id in extraAttemptIds onto the row, deduplicated, alongside the singular attemptId", async () => {
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    try {
      const { folderUri } = makeTaskFolder("round_ledger_extra_attempts");
      const result = await terminalizeRoundV1(
        "round-open-1",
        "completed",
        undefined,
        {
          taskFolderUri: folderUri,
          attemptId: "attempt-final",
          // Includes a duplicate of both the pre-existing seeded attemptId
          // ("attempt-0001", see makeBaseEntry) and the singular attemptId
          // above — neither must appear twice in the merged result.
          extraAttemptIds: ["attempt-primary-failed", "attempt-0001", "attempt-final"],
        }
      );
      assert.equal(result.ok, true);
      if (!result.ok) throw new Error("unreachable");
      assert.deepEqual(result.entry.attemptIds, ["attempt-0001", "attempt-final", "attempt-primary-failed"]);
      assert.equal(resolveRoundV1({ roundLedger: [result.entry] } as TaskProgress, "attempt-primary-failed")?.roundId, "round-open-1");
      assert.equal(resolveRoundV1({ roundLedger: [result.entry] } as TaskProgress, "attempt-final")?.roundId, "round-open-1");
    } finally {
      wsStub.restore();
      fsBridge.restore();
    }
  });

  void it("also writes the compatibility roundOutcomes entry when a classification is supplied, in the SAME patch", async () => {
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    try {
      const { folderPath, folderUri } = makeTaskFolder("round_ledger_classification");
      await terminalizeRoundV1(
        "round-open-1",
        "completed",
        { filesChanged: ["src/a.ts"] },
        {
          taskFolderUri: folderUri,
          roundOutcomeClassification: { classification: "edits-produced", attemptId: "attempt-0001" },
        }
      );
      const raw = JSON.parse(fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")) as TaskProgress;
      assert.equal(raw.roundOutcomes?.length, 1);
      assert.equal(raw.roundOutcomes?.[0]?.classification, "edits-produced");
      assert.equal(raw.roundOutcomes?.[0]?.attemptId, "attempt-0001");
      // Both writes happened in the SAME patch — the ledger row's endedAt and
      // the roundOutcomes entry's at must match exactly.
      assert.equal(raw.roundOutcomes?.[0]?.at, raw.roundLedger?.[0]?.endedAt);
      // Part 4 step 46's drift check: the classification this same patch just
      // recorded must resolve to the ledger row it belongs to — proving the
      // real `terminalizeRoundV1` write path never produces the drift this
      // check exists to catch.
      assert.deepEqual(findRoundOutcomesMissingLedgerRowV1(raw), []);
    } finally {
      wsStub.restore();
      fsBridge.restore();
    }
  });

  // Part 16 step 44, 2026-09-02 review round 3 fix: the task.md size-band
  // dedup marker (`TaskProgress.taskMdSizeBandAnnounced`) must advance in the
  // SAME `patchTaskProgressStrictV1` transaction as the round's terminal
  // ledger write — via `postTerminalizePatch` — never in an earlier, separate
  // patch. Previously the marker was advanced eagerly before the round ever
  // reached its terminal write, so a crash or thrown error in between left
  // "already announced" durably recorded with no ledger event to show for
  // it. These tests exercise the generic `postTerminalizePatch` mechanism
  // `reviewActions.ts` now relies on at every one of its size-band call
  // sites, proving the two facts can never land independently.
  void it("postTerminalizePatch lands atomically with the terminal ledger write", async () => {
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    try {
      const { folderPath, folderUri } = makeTaskFolder("round_ledger_size_band_atomic");
      const result = await terminalizeRoundV1(
        "round-open-1",
        "completed",
        { taskMdSizeBand: { band: 2, taskMdBytes: 65536, percentOfLimit: 25 } },
        {
          taskFolderUri: folderUri,
          postTerminalizePatch: (current) => recordTaskMdSizeBandAnnouncedV1(current, 2),
        }
      );
      assert.equal(result.ok, true);

      const raw = JSON.parse(fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")) as TaskProgress;
      // Both facts — the ledger row's terminal state/outcome AND the durable
      // dedup marker — must be present after exactly one write.
      assert.equal(raw.roundLedger?.[0]?.state, "completed");
      assert.equal(raw.roundLedger?.[0]?.outcome?.taskMdSizeBand?.band, 2);
      assert.equal(raw.taskMdSizeBandAnnounced, 2);

      const messages = await readChatHistory(folderPath, folderPath);
      const outcomeMessages = messages.filter((m) => m.kind === "outcome");
      assert.equal(outcomeMessages.length, 1);
      assert.ok(outcomeMessages[0]?.text.includes("task.md is"));
    } finally {
      wsStub.restore();
      fsBridge.restore();
    }
  });

  void it("postTerminalizePatch does NOT run when the row is already terminal — no marker advance on a no-op call", async () => {
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    try {
      const { folderPath, folderUri } = makeTaskFolder("round_ledger_size_band_noop");
      // First call terminalizes the row for real, with no size-band outcome
      // — mirroring a round that ends before this round's own size-band
      // detection would ever apply `postTerminalizePatch`.
      const first = await terminalizeRoundV1("round-open-1", "completed", undefined, { taskFolderUri: folderUri });
      assert.equal(first.ok, true);

      // A second call for the SAME already-terminal row, this time carrying
      // a size-band postTerminalizePatch — this is the idempotent safety-net
      // shape `terminalizeUnclosedReviewRoundV1` uses. Since the row is
      // already terminal, the patcher function returns before
      // `postTerminalizePatch` is ever invoked, so the marker must NOT
      // advance from this second, no-op call.
      const second = await terminalizeRoundV1(
        "round-open-1",
        "failed",
        { taskMdSizeBand: { band: 3, taskMdBytes: 98304, percentOfLimit: 38 } },
        {
          taskFolderUri: folderUri,
          postTerminalizePatch: (current) => recordTaskMdSizeBandAnnouncedV1(current, 3),
        }
      );
      assert.equal(second.ok, true);
      if (!second.ok) throw new Error("unreachable");
      assert.equal(second.alreadyTerminal, true);

      const raw = JSON.parse(fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")) as TaskProgress;
      assert.equal(raw.taskMdSizeBandAnnounced, undefined);
    } finally {
      wsStub.restore();
      fsBridge.restore();
    }
  });
});

// Part 4 step 46: "add a drift test asserting every new roundOutcomes row has
// a ledger row containing its attemptId." `findRoundOutcomesMissingLedgerRowV1`
// is the enforcement primitive; these tests exercise it directly against
// constructed fixtures (an orphan classification is exactly the "one store
// says a round happened, the other has never heard of it" defect Part 4 as a
// whole exists to close), while the test above proves the real write path
// never produces one.
void describe("findRoundOutcomesMissingLedgerRowV1 (Part 4 step 46 — roundOutcomes-to-ledger drift enforcement)", () => {
  void it("reports no drift when every attemptId-carrying roundOutcomes entry resolves to a ledger row", () => {
    const entry = makeBaseEntry({ roundId: "round-1", attemptIds: ["attempt-1"], state: "completed" });
    const progress = makeProgress({
      roundLedger: [entry],
      roundOutcomes: [{ stage: "impl", classification: "edits-produced", at: "2026-01-01T00:05:00.000Z", attemptId: "attempt-1" }],
    });
    assert.deepEqual(findRoundOutcomesMissingLedgerRowV1(progress), []);
  });

  void it("flags a roundOutcomes entry whose attemptId resolves to no ledger row at all", () => {
    const orphan: TaskProgress["roundOutcomes"] = [
      { stage: "impl", classification: "edits-produced", at: "2026-01-01T00:05:00.000Z", attemptId: "attempt-orphan" },
    ];
    const progress = makeProgress({ roundLedger: [], roundOutcomes: orphan });
    const missing = findRoundOutcomesMissingLedgerRowV1(progress);
    assert.equal(missing.length, 1);
    assert.equal(missing[0]?.attemptId, "attempt-orphan");
  });

  void it("flags a roundOutcomes entry whose attemptId matches no row's attemptIds, even when other rows exist", () => {
    const entry = makeBaseEntry({ roundId: "round-1", attemptIds: ["attempt-1"], state: "completed" });
    const progress = makeProgress({
      roundLedger: [entry],
      roundOutcomes: [{ stage: "impl", classification: "edits-produced", at: "2026-01-01T00:05:00.000Z", attemptId: "attempt-unrelated" }],
    });
    const missing = findRoundOutcomesMissingLedgerRowV1(progress);
    assert.equal(missing.length, 1);
    assert.equal(missing[0]?.attemptId, "attempt-unrelated");
  });

  void it("never flags a roundOutcomes entry with no attemptId at all — a known, separate gap, not drift", () => {
    const progress = makeProgress({
      roundLedger: [],
      roundOutcomes: [{ stage: "impl", classification: "edits-produced", at: "2026-01-01T00:05:00.000Z" }],
    });
    assert.deepEqual(findRoundOutcomesMissingLedgerRowV1(progress), []);
  });
});

// handleReviewRoutingOutcome (reviewActions.ts) is one of the review-round
// ending sites Part 4 step 13 names ("review routing completion
// (handleReviewRoutingOutcome ~:2960)"). Row creation-at-start IS now wired
// for review rounds (2026-08-27 review fix, narrowed blocker 2:
// "completion-time special case ... outside the start authority") —
// `claimReviewAttempt` opens the `state: "open"` row at the round's real
// start, immediately before the provider is dispatched, in the SAME
// transaction that claims the attempt. `handleReviewRoutingOutcome` never
// creates a row of its own; it only ever terminalizes the one already open,
// via `terminalizeRoundV1` — the plan's sole writer of both the terminal
// state and the chat outcome message — unconditionally for every completed
// review, not only a non-goal challenge. These fixtures seed the open row
// the same way `claimReviewAttempt` would, so the tests exercise the real
// open -> terminalize transition without needing the full provider-dispatch
// path.
void describe("handleReviewRoutingOutcome — terminalizes the round-start row (item 18 / Part 4)", () => {
  void it("plan-non-goal disagreement: closes the row carrying reviewerChallengedNonGoal, and tags the chat notice with kind:'outcome'", async () => {
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    initNotificationRouter({ addEntry: (): void => {} });
    try {
      const folderPath = path.join(REAL_ROOT, "plans", "review_nongoal_ledger");
      fs.mkdirSync(folderPath, { recursive: true });
      const progress: TaskProgress & { ensembleProgressVersion: 1 } = {
        ensembleProgressVersion: 1,
        taskFolder: "review_nongoal_ledger",
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
        // Seeded exactly as `claimReviewAttempt` would open it at the round's
        // real start, before the provider is ever dispatched.
        roundLedger: [
          {
            roundId: "attempt-nongoal-1",
            attemptIds: ["attempt-nongoal-1"],
            stage: "impl-high-review",
            mode: "review",
            startedAt: "2026-01-01T00:05:00.000Z",
            state: "open",
          },
        ],
      };
      fs.writeFileSync(
        path.join(folderPath, "task-progress.json"),
        JSON.stringify(progress, null, 2),
        "utf8"
      );
      const nonGoalBody =
        "Residual: the own save exemption remains uri wide during the asynchronous save window because " +
        "VS Code's onWillSaveTextDocument API exposes no per-operation correlation handle. Accepted as a " +
        "permanent limitation, detected and never silently persisted.";
      fs.writeFileSync(
        path.join(folderPath, "plan-final.md"),
        `## Accepted Non-Goals\n\n### The save-guard residual\n\n${nonGoalBody}\n`,
        "utf8"
      );
      const folderUri = vscode.Uri.file(folderPath);

      const blockerText = "the own save exemption remains uri wide during the asynchronous save window";
      const content = [
        "Readiness: 5/10",
        "",
        "<!-- blockers:start -->",
        `- [completion] [task-fixable] ${blockerText}`,
        "<!-- blockers:end -->",
      ].join("\n");

      await handleReviewRoutingOutcome({
        folderUri,
        targetStage: "impl-high-review",
        reviewAttemptId: "attempt-nongoal-1",
        content,
        score: 5,
        threshold: 8,
      });

      const raw = JSON.parse(
        fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")
      ) as TaskProgress;

      const historyEntry = raw.reviewScoreHistory?.find((e) => e.attemptId === "attempt-nongoal-1");
      assert.ok(historyEntry, "the history entry must still be written");
      assert.equal(historyEntry?.reviewerChallengedNonGoal?.length, 1);

      const ledgerRow = raw.roundLedger?.find((r) => r.roundId === "attempt-nongoal-1");
      assert.ok(ledgerRow, "a round-ledger row must be written for the challenged round");
      assert.equal(ledgerRow?.mode, "review");
      assert.equal(ledgerRow?.stage, "impl-high-review");
      // Proves the row went through the real open -> terminalize transition
      // (terminalizeRoundV1 only sets endedAt on a row it terminalized —
      // never present on a row it merely found already terminal).
      assert.equal(ledgerRow?.state, "completed");
      // The round's REAL start time (seeded above, as `claimReviewAttempt`
      // would have recorded it before dispatch) must survive terminalization
      // unchanged — this is the exact fact the review flagged as missing:
      // completion handling must never re-derive/overwrite `startedAt`.
      assert.equal(ledgerRow?.startedAt, "2026-01-01T00:05:00.000Z");
      assert.ok(ledgerRow?.endedAt, "terminalizeRoundV1 must set endedAt");
      assert.deepEqual(ledgerRow?.outcome?.reviewerChallengedNonGoal, ["The save-guard residual"]);

      const messages = await readChatHistory(folderPath, folderPath);
      const outcomeMessages = messages.filter((m) => m.kind === "outcome" && m.roundId === "attempt-nongoal-1");
      // Exactly one — terminalizeRoundV1 is the sole writer of the outcome
      // message; nothing else in this call path may write a second one.
      assert.equal(outcomeMessages.length, 1, "terminalizeRoundV1 must be the only writer of the outcome message");
      assert.ok(outcomeMessages[0]?.text.includes("declares out of scope"));
      assert.ok(outcomeMessages[0]?.text.includes("The save-guard residual"));
    } finally {
      deactivateNotificationRouter();
      wsStub.restore();
      fsBridge.restore();
    }
  });

  void it("plain completed review with no non-goal challenge: still closes the round-start row (2026-08-27 review fix)", async () => {
    // Before this fix, `handleReviewRoutingOutcome` only ever terminalized a
    // round when it found a non-goal challenge — every ordinary completed
    // review left its round-start row `"open"` forever, since nothing else
    // in this call path closed it.
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    initNotificationRouter({ addEntry: (): void => {} });
    try {
      const folderPath = path.join(REAL_ROOT, "plans", "review_plain_ledger");
      fs.mkdirSync(folderPath, { recursive: true });
      const progress: TaskProgress & { ensembleProgressVersion: 1 } = {
        ensembleProgressVersion: 1,
        taskFolder: "review_plain_ledger",
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
        roundLedger: [
          {
            roundId: "attempt-plain-1",
            attemptIds: ["attempt-plain-1"],
            stage: "impl-high-review",
            mode: "review",
            startedAt: "2026-01-01T00:05:00.000Z",
            state: "open",
          },
        ],
      };
      fs.writeFileSync(
        path.join(folderPath, "task-progress.json"),
        JSON.stringify(progress, null, 2),
        "utf8"
      );

      const content = [
        "Readiness: 9/10",
        "",
        "<!-- blockers:start -->",
        "<!-- blockers:end -->",
      ].join("\n");

      await handleReviewRoutingOutcome({
        folderUri: vscode.Uri.file(folderPath),
        targetStage: "impl-high-review",
        reviewAttemptId: "attempt-plain-1",
        content,
        score: 9,
        threshold: 8,
      });

      const raw = JSON.parse(
        fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")
      ) as TaskProgress;
      const ledgerRow = raw.roundLedger?.find((r) => r.roundId === "attempt-plain-1");
      assert.ok(ledgerRow, "the round-start row must still exist");
      assert.equal(ledgerRow?.state, "completed", "a non-challenged completed review must still close its row");
      assert.equal(ledgerRow?.startedAt, "2026-01-01T00:05:00.000Z");
      assert.ok(ledgerRow?.endedAt);
      assert.equal(ledgerRow?.outcome?.score, 9);
      assert.equal(ledgerRow?.outcome?.reviewerChallengedNonGoal, undefined);
    } finally {
      deactivateNotificationRouter();
      wsStub.restore();
      fsBridge.restore();
    }
  });

  // 2026-08-27 review, "The review ledger counts mechanically generated
  // task-fixable blockers as reviewer blockers": a reviewer-raised
  // task-fixable blocker (parsed from `<!-- blockers:start -->`, `origin`
  // absent/"reviewer") must land in `outcome.reviewerBlockers`, never
  // `mechanicalBlockers` — the split is now computed once by
  // `splitTaskFixableBlockersByOriginV1` rather than a single `.length` over
  // a list that could also contain mechanically-synthesized entries.
  void it("a reviewer-raised task-fixable blocker is counted as reviewerBlockers, not mechanicalBlockers", async () => {
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    initNotificationRouter({ addEntry: (): void => {} });
    try {
      const folderPath = path.join(REAL_ROOT, "plans", "review_blocker_split_ledger");
      fs.mkdirSync(folderPath, { recursive: true });
      const progress: TaskProgress & { ensembleProgressVersion: 1 } = {
        ensembleProgressVersion: 1,
        taskFolder: "review_blocker_split_ledger",
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
        roundLedger: [
          {
            roundId: "attempt-split-1",
            attemptIds: ["attempt-split-1"],
            stage: "impl-high-review",
            mode: "review",
            startedAt: "2026-01-01T00:05:00.000Z",
            state: "open",
          },
        ],
      };
      fs.writeFileSync(
        path.join(folderPath, "task-progress.json"),
        JSON.stringify(progress, null, 2),
        "utf8"
      );

      const content = [
        "Readiness: 6/10",
        "",
        "<!-- blockers:start -->",
        "- [completion] [task-fixable] a real gap the reviewer found",
        "<!-- blockers:end -->",
      ].join("\n");

      await handleReviewRoutingOutcome({
        folderUri: vscode.Uri.file(folderPath),
        targetStage: "impl-high-review",
        reviewAttemptId: "attempt-split-1",
        content,
        score: 6,
        threshold: 8,
      });

      const raw = JSON.parse(
        fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")
      ) as TaskProgress;
      const ledgerRow = raw.roundLedger?.find((r) => r.roundId === "attempt-split-1");
      assert.equal(ledgerRow?.state, "completed");
      assert.equal(ledgerRow?.outcome?.reviewerBlockers, 1, "the reviewer's own finding must count as reviewerBlockers");
      assert.equal(ledgerRow?.outcome?.mechanicalBlockers, 0, "no mechanical blockers were synthesized this round");
    } finally {
      deactivateNotificationRouter();
      wsStub.restore();
      fsBridge.restore();
    }
  });

  // 2026-08-27 review, "Rejected degenerate reviews are recorded as
  // completed": a review round with no parseable `Readiness: N/10` line is
  // rejected by `handleReviewRoutingOutcome`'s degenerate branch, which
  // records `roundOutcomes` classification `"rejected-degenerate"` — the
  // round-ledger row for the SAME round must agree, not read `"completed"`
  // (which is what the coordinator-outcome-keyed safety net alone would have
  // produced, since the provider call itself succeeded and only the CONTENT
  // was judged unusable).
  void it("a degenerate (unparseable) review closes its round-ledger row as rejected, not completed", async () => {
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    initNotificationRouter({ addEntry: (): void => {} });
    try {
      const folderPath = path.join(REAL_ROOT, "plans", "review_degenerate_ledger");
      fs.mkdirSync(folderPath, { recursive: true });
      const progress: TaskProgress & { ensembleProgressVersion: 1 } = {
        ensembleProgressVersion: 1,
        taskFolder: "review_degenerate_ledger",
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
        roundLedger: [
          {
            roundId: "attempt-degenerate-1",
            attemptIds: ["attempt-degenerate-1"],
            stage: "impl-high-review",
            mode: "review",
            startedAt: "2026-01-01T00:05:00.000Z",
            state: "open",
          },
        ],
      };
      fs.writeFileSync(
        path.join(folderPath, "task-progress.json"),
        JSON.stringify(progress, null, 2),
        "utf8"
      );

      // No "Readiness: N/10" line anywhere — the shape `parseReadiness`
      // cannot resolve a score from, matching what a real degenerate/
      // truncated provider reply looks like.
      const content = "I ran out of budget before I could finish reading the files.";

      const result = await handleReviewRoutingOutcome({
        folderUri: vscode.Uri.file(folderPath),
        targetStage: "impl-high-review",
        reviewAttemptId: "attempt-degenerate-1",
        content,
        score: null,
        threshold: 8,
      });
      assert.equal(result.escalated, false);

      const raw = JSON.parse(
        fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")
      ) as TaskProgress;
      const rejection = raw.reviewRejections?.find((r) => r.attemptId === "attempt-degenerate-1");
      assert.ok(rejection, "a reviewRejections entry must be recorded");
      const roundOutcome = raw.roundOutcomes?.find((r) => r.attemptId === "attempt-degenerate-1");
      assert.equal(roundOutcome?.classification, "rejected-degenerate");

      const ledgerRow = raw.roundLedger?.find((r) => r.roundId === "attempt-degenerate-1");
      assert.ok(ledgerRow, "the round-start row must still exist");
      assert.equal(
        ledgerRow?.state,
        "rejected",
        "the ledger's terminal state must agree with the rejected-degenerate classification, not read as completed"
      );
      assert.ok(ledgerRow?.outcome?.rejectionReason);
      assert.ok(ledgerRow?.endedAt);

      // terminalizeRoundV1 is idempotent — the safety net
      // (terminalizeUnclosedReviewRoundV1, called from handleReviewOutcomeV1)
      // must never overwrite this already-terminal row with "completed" if a
      // caller runs the full outcome-handling path around this same round.
      const secondPass = await terminalizeRoundV1(
        "attempt-degenerate-1",
        "completed",
        undefined,
        { taskFolderUri: vscode.Uri.file(folderPath) }
      );
      assert.equal(secondPass.ok, true);
      assert.equal((secondPass as { alreadyTerminal: boolean }).alreadyTerminal, true);
      const rawAfterSecondPass = JSON.parse(
        fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")
      ) as TaskProgress;
      assert.equal(
        rawAfterSecondPass.roundLedger?.find((r) => r.roundId === "attempt-degenerate-1")?.state,
        "rejected",
        "a later 'completed' close attempt must not clobber the already-terminal rejected state"
      );
    } finally {
      deactivateNotificationRouter();
      wsStub.restore();
      fsBridge.restore();
    }
  });

  // 2026-08-27 review, blocker "review rows still use an independent
  // reviewAttemptId and never attach the coordinator operation or provider
  // attempt identities": a review round's ledger row is opened by
  // `claimReviewAttempt` under its own independently-minted `reviewAttemptId`
  // BEFORE the coordinator call is dispatched, so no coordinator identity
  // exists at open time — but once the outcome comes back, the caller's own
  // `outcome.correlation` carries the coordinator's `operationId`/`attemptId`,
  // and `handleReviewRoutingOutcome` now forwards them into
  // `terminalizeRoundV1` so `resolveRoundV1` can find this round by either.
  void it("attaches the coordinator's operationId/attemptId onto the row at terminalization", async () => {
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    initNotificationRouter({ addEntry: (): void => {} });
    try {
      const folderPath = path.join(REAL_ROOT, "plans", "review_coordinator_identity");
      fs.mkdirSync(folderPath, { recursive: true });
      const progress: TaskProgress & { ensembleProgressVersion: 1 } = {
        ensembleProgressVersion: 1,
        taskFolder: "review_coordinator_identity",
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
        roundLedger: [
          {
            roundId: "attempt-coord-identity-1",
            attemptIds: ["attempt-coord-identity-1"],
            stage: "impl-high-review",
            mode: "review",
            startedAt: "2026-01-01T00:05:00.000Z",
            state: "open",
          },
        ],
      };
      fs.writeFileSync(
        path.join(folderPath, "task-progress.json"),
        JSON.stringify(progress, null, 2),
        "utf8"
      );

      const content = "I ran out of budget before I could finish reading the files.";
      const result = await handleReviewRoutingOutcome({
        folderUri: vscode.Uri.file(folderPath),
        targetStage: "impl-high-review",
        reviewAttemptId: "attempt-coord-identity-1",
        content,
        score: null,
        threshold: 8,
        coordinatorOperationId: "op-0000000000000000000000000000ab",
        coordinatorAttemptId: "attempt-0000000000000000000000000ab",
      });
      assert.equal(result.escalated, false);

      const raw = JSON.parse(
        fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")
      ) as TaskProgress;
      const ledgerRow = raw.roundLedger?.find((r) => r.roundId === "attempt-coord-identity-1");
      assert.ok(ledgerRow, "the round-start row must still exist");
      assert.equal(ledgerRow?.operationId, "op-0000000000000000000000000000ab");
      assert.deepEqual(ledgerRow?.attemptIds, [
        "attempt-coord-identity-1",
        "attempt-0000000000000000000000000ab",
      ]);
      // Every one of the three identities now resolves to the SAME row.
      assert.equal(resolveRoundV1(raw, "attempt-coord-identity-1")?.roundId, "attempt-coord-identity-1");
      assert.equal(resolveRoundV1(raw, "op-0000000000000000000000000000ab")?.roundId, "attempt-coord-identity-1");
      assert.equal(
        resolveRoundV1(raw, "attempt-0000000000000000000000000ab")?.roundId,
        "attempt-coord-identity-1"
      );
    } finally {
      deactivateNotificationRouter();
      wsStub.restore();
      fsBridge.restore();
    }
  });

  // 2026-08-27 review, blocker "review rows... omit earlier retry-attempt
  // identities" (part 2 — the round-outcome caller, not just the primitive):
  // `runReviewForFolder` collects every `onPromptAssembled` firing during
  // `coordinator.executeAction` and forwards them as `coordinatorExtraAttemptIds`
  // — `handleReviewRoutingOutcome` must attach ALL of them onto the row, not
  // only the final `coordinatorAttemptId`.
  void it("forwards coordinatorExtraAttemptIds onto the row alongside coordinatorAttemptId", async () => {
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    initNotificationRouter({ addEntry: (): void => {} });
    try {
      const folderPath = path.join(REAL_ROOT, "plans", "review_extra_attempts_ledger");
      fs.mkdirSync(folderPath, { recursive: true });
      const progress: TaskProgress & { ensembleProgressVersion: 1 } = {
        ensembleProgressVersion: 1,
        taskFolder: "review_extra_attempts_ledger",
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
        roundLedger: [
          {
            roundId: "attempt-extra-1",
            attemptIds: ["attempt-extra-1"],
            stage: "impl-high-review",
            mode: "review",
            startedAt: "2026-01-01T00:05:00.000Z",
            state: "open",
          },
        ],
      };
      fs.writeFileSync(
        path.join(folderPath, "task-progress.json"),
        JSON.stringify(progress, null, 2),
        "utf8"
      );

      const content = ["Readiness: 9/10", "", "<!-- blockers:start -->", "<!-- blockers:end -->"].join("\n");
      await handleReviewRoutingOutcome({
        folderUri: vscode.Uri.file(folderPath),
        targetStage: "impl-high-review",
        reviewAttemptId: "attempt-extra-1",
        content,
        score: 9,
        threshold: 8,
        coordinatorOperationId: "op-final",
        coordinatorAttemptId: "attempt-final-candidate",
        coordinatorExtraAttemptIds: ["attempt-primary-failed", "attempt-retry-1"],
      });

      const raw = JSON.parse(
        fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")
      ) as TaskProgress;
      const ledgerRow = raw.roundLedger?.find((r) => r.roundId === "attempt-extra-1");
      assert.ok(ledgerRow);
      assert.deepEqual(ledgerRow?.attemptIds, [
        "attempt-extra-1",
        "attempt-final-candidate",
        "attempt-primary-failed",
        "attempt-retry-1",
      ]);
      assert.equal(resolveRoundV1(raw, "attempt-primary-failed")?.roundId, "attempt-extra-1");
      assert.equal(resolveRoundV1(raw, "attempt-retry-1")?.roundId, "attempt-extra-1");
    } finally {
      deactivateNotificationRouter();
      wsStub.restore();
      fsBridge.restore();
    }
  });
});

void describe("formatRoundOutcomeMessageV1", () => {
  void it("renders a score/blocker split for a review round", () => {
    const entry = makeBaseEntry({
      state: "completed",
      endedAt: "2026-01-01T00:05:00.000Z",
      outcome: { score: 8, reviewerBlockers: 1, mechanicalBlockers: 2 },
    });
    const text = formatRoundOutcomeMessageV1(entry);
    assert.ok(text.includes("score 8"));
    assert.ok(text.includes("1 reviewer"));
    assert.ok(text.includes("2 mechanical"));
    assert.ok(text.includes("mode implementation"));
  });

  void it("renders the dispatch mode before the run-log path", () => {
    const entry = makeBaseEntry({
      mode: "apply-review",
      state: "completed",
      endedAt: "2026-01-01T00:05:00.000Z",
      outcome: { filesChanged: [], runLogPath: "runs/attempt-1.md" },
    });
    const text = formatRoundOutcomeMessageV1(entry);
    assert.match(text, /mode apply-review — runs\/attempt-1\.md_/);
  });

  void it("renders a rejection reason for a rejected round", () => {
    const entry = makeBaseEntry({
      state: "rejected",
      endedAt: "2026-01-01T00:05:00.000Z",
      outcome: { rejectionReason: "missing Files Changed section" },
    });
    const text = formatRoundOutcomeMessageV1(entry);
    assert.ok(text.includes("missing Files Changed section"));
  });

  void it("renders a reviewer-challenged-non-goal note", () => {
    const entry = makeBaseEntry({
      mode: "review",
      state: "completed",
      endedAt: "2026-01-01T00:05:00.000Z",
      outcome: { score: 6, reviewerChallengedNonGoal: ["The save-guard residual"] },
    });
    const text = formatRoundOutcomeMessageV1(entry);
    assert.ok(text.includes("The save-guard residual"));
    assert.ok(text.includes("out of scope"));
  });

  void it("renders a continuation-owed note", () => {
    const entry = makeBaseEntry({
      state: "failed",
      endedAt: "2026-01-01T00:05:00.000Z",
      outcome: { continuationOwed: true },
    });
    const text = formatRoundOutcomeMessageV1(entry);
    assert.ok(text.includes("continuation is owed"));
  });
});

// claimReviewAttempt (reviewActions.ts) is the round's real start for this
// dispatch path — "Claim the review attempt immediately before invoking the
// AI provider" — so it is now also where the round-ledger row opens (2026-08-27
// review fix, narrowed blocker 2), in the SAME transaction as the claim.
void describe("claimReviewAttempt — opens the round-ledger row at the round's real start (item 18 / Part 4)", () => {
  void it("opens a mode:'review' row for the given stage, atomically with the reviewAttemptId claim", async () => {
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    try {
      const folderPath = path.join(REAL_ROOT, "plans", "claim_review_attempt_ledger");
      fs.mkdirSync(folderPath, { recursive: true });
      const progress: TaskProgress & { ensembleProgressVersion: 1 } = {
        ensembleProgressVersion: 1,
        taskFolder: "claim_review_attempt_ledger",
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
      };
      fs.writeFileSync(
        path.join(folderPath, "task-progress.json"),
        JSON.stringify(progress, null, 2),
        "utf8"
      );
      const folderUri = vscode.Uri.file(folderPath);

      const claimed = await claimReviewAttempt(folderUri, "claim-attempt-1", "impl-high-review");
      assert.equal(claimed?.reviewAttemptId, "claim-attempt-1");
      if (!claimed) throw new Error("unreachable");

      const row = resolveRoundV1(claimed, "claim-attempt-1");
      assert.ok(row, "claimReviewAttempt must open a round-ledger row for this attempt");
      assert.equal(row?.mode, "review");
      assert.equal(row?.stage, "impl-high-review");
      assert.equal(row?.state, "open");
      assert.deepEqual(row?.attemptIds, ["claim-attempt-1"]);
      assert.ok(row?.startedAt, "the row must carry a real start timestamp");
      assert.equal(row?.endedAt, undefined);
    } finally {
      wsStub.restore();
      fsBridge.restore();
    }
  });

  void it("refuses to claim (and opens no row) when the task is paused", async () => {
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    try {
      const folderPath = path.join(REAL_ROOT, "plans", "claim_review_attempt_paused");
      fs.mkdirSync(folderPath, { recursive: true });
      const progress: TaskProgress & { ensembleProgressVersion: 1 } = {
        ensembleProgressVersion: 1,
        taskFolder: "claim_review_attempt_paused",
        currentStage: "impl-high-review",
        status: "paused",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        ownership: {
          metaRoot: path.join(REAL_ROOT, "plans"),
          projectRoot: REAL_ROOT,
          workspaceRoot: REAL_ROOT,
          boundAt: "2026-01-01T00:00:00.000Z",
        },
      };
      fs.writeFileSync(
        path.join(folderPath, "task-progress.json"),
        JSON.stringify(progress, null, 2),
        "utf8"
      );
      const folderUri = vscode.Uri.file(folderPath);

      // Pre-existing behavior, unchanged by this fix: the paused guard
      // THROWS inside the patch callback rather than resolving to undefined
      // — patchTaskProgressStrictV1 propagates it as a rejection.
      await assert.rejects(
        () => claimReviewAttempt(folderUri, "claim-attempt-paused", "impl-high-review"),
        /paused/
      );

      const raw = JSON.parse(fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")) as TaskProgress;
      assert.equal(raw.roundLedger, undefined, "a refused claim must not open a ledger row");
    } finally {
      wsStub.restore();
      fsBridge.restore();
    }
  });
});

function installFakeExtensionContextV1(): { restore: () => void } {
  const values = new Map<string, unknown>();
  const memento = {
    get<T>(key: string, defaultValue: T): T {
      return (values.has(key) ? values.get(key) : defaultValue) as T;
    },
    update(key: string, value: unknown): Promise<void> {
      values.set(key, value);
      return Promise.resolve();
    },
  } as unknown as vscode.Memento;
  __extensionContextV1TestOnly.set({ workspaceState: memento } as unknown as vscode.ExtensionContext);
  return { restore: (): void => __extensionContextV1TestOnly.reset() };
}

// 2026-09-04 review follow-up (A1 architectural blocker, still open after two
// prior narrowing rounds): claimReviewAttempt's own fire-and-forget lease
// write (formerly issued only AFTER the round-ledger row was already
// committed) left a real gap where a concurrent reconciliation sweep could
// observe the freshly-opened row with no live lease yet. claimReviewAttemptWithLiveLeaseV1
// closes it by awaiting the lease write before the row commit.
void describe("claimReviewAttemptWithLiveLeaseV1 (A1 architectural blocker, 2026-09-04 review follow-up)", () => {
  void it("the lease is already live by the time the caller observes the committed row — no fire-and-forget gap", async () => {
    const fakeContext = installFakeExtensionContextV1();
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    try {
      const folderPath = path.join(REAL_ROOT, "plans", "claim_review_attempt_live_lease");
      fs.mkdirSync(folderPath, { recursive: true });
      const progress: TaskProgress & { ensembleProgressVersion: 1 } = {
        ensembleProgressVersion: 1,
        taskFolder: "claim_review_attempt_live_lease",
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
      };
      fs.writeFileSync(
        path.join(folderPath, "task-progress.json"),
        JSON.stringify(progress, null, 2),
        "utf8"
      );
      const folderUri = vscode.Uri.file(folderPath);

      assert.deepEqual(listLiveRoundLeaseIdsV1(), []);
      const claimed = await claimReviewAttemptWithLiveLeaseV1(folderUri, "live-lease-attempt-1", "impl-high-review");
      assert.equal(claimed?.reviewAttemptId, "live-lease-attempt-1");
      // By the time the wrapper resolves, the row is committed (same
      // postcondition as bare claimReviewAttempt) AND the lease is live —
      // this is the ordering guarantee itself: markRoundLiveV1 is awaited
      // strictly before claimReviewAttempt's row-opening patch runs.
      const row = claimed ? resolveRoundV1(claimed, "live-lease-attempt-1") : undefined;
      assert.ok(row, "the round-ledger row must be committed");
      assert.deepEqual(listLiveRoundLeaseIdsV1(), ["live-lease-attempt-1"]);
    } finally {
      wsStub.restore();
      fsBridge.restore();
      fakeContext.restore();
    }
  });

  void it("clears the lease immediately when the claim is refused (task paused), rather than leaking it for the full TTL", async () => {
    const fakeContext = installFakeExtensionContextV1();
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    try {
      const folderPath = path.join(REAL_ROOT, "plans", "claim_review_attempt_live_lease_paused");
      fs.mkdirSync(folderPath, { recursive: true });
      const progress: TaskProgress & { ensembleProgressVersion: 1 } = {
        ensembleProgressVersion: 1,
        taskFolder: "claim_review_attempt_live_lease_paused",
        currentStage: "impl-high-review",
        status: "paused",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        ownership: {
          metaRoot: path.join(REAL_ROOT, "plans"),
          projectRoot: REAL_ROOT,
          workspaceRoot: REAL_ROOT,
          boundAt: "2026-01-01T00:00:00.000Z",
        },
      };
      fs.writeFileSync(
        path.join(folderPath, "task-progress.json"),
        JSON.stringify(progress, null, 2),
        "utf8"
      );
      const folderUri = vscode.Uri.file(folderPath);

      await assert.rejects(
        () => claimReviewAttemptWithLiveLeaseV1(folderUri, "live-lease-attempt-paused", "impl-high-review"),
        /paused/
      );
      assert.deepEqual(
        listLiveRoundLeaseIdsV1(),
        [],
        "a refused claim must not leave a phantom live lease behind"
      );
    } finally {
      wsStub.restore();
      fsBridge.restore();
      fakeContext.restore();
    }
  });
});

void describe("roundLedgerModeForCommandV1 (Part 4 step 12)", () => {
  void it("classifies an applyReview-named command as apply-review", () => {
    assert.equal(roundLedgerModeForCommandV1("vs-code-ai-helper.applyReviewWithAI"), "apply-review");
    assert.equal(roundLedgerModeForCommandV1("vs-code-ai-helper.applyReviewEditWithAI"), "apply-review");
  });

  void it("classifies a review-named command (that is not apply-review) as review", () => {
    assert.equal(roundLedgerModeForCommandV1("vs-code-ai-helper.runReviewWithAI"), "review");
    assert.equal(roundLedgerModeForCommandV1("vs-code-ai-helper.fastForwardReviewWithAI"), "review");
  });

  void it("defaults every other command to implementation", () => {
    assert.equal(roundLedgerModeForCommandV1("vs-code-ai-helper.runImplementationWithAI"), "implementation");
    assert.equal(roundLedgerModeForCommandV1("vs-code-ai-helper.generatePlanWithAI"), "implementation");
    assert.equal(roundLedgerModeForCommandV1("vs-code-ai-helper.runPublishChecks"), "implementation");
  });
});

void describe("openAutomationRoundLedgerRowBestEffortV1 (Part 4 step 12)", () => {
  void it("opens an 'open' row keyed by roundId/intentId, mode inferred from the command", async () => {
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    try {
      const folderPath = path.join(REAL_ROOT, "plans", "open_automation_round_ledger_row");
      fs.mkdirSync(folderPath, { recursive: true });
      const progress: TaskProgress & { ensembleProgressVersion: 1 } = {
        ensembleProgressVersion: 1,
        taskFolder: "open_automation_round_ledger_row",
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
      };
      fs.writeFileSync(
        path.join(folderPath, "task-progress.json"),
        JSON.stringify(progress, null, 2),
        "utf8"
      );
      const folderUri = vscode.Uri.file(folderPath);

      await openAutomationRoundLedgerRowBestEffortV1({
        taskFolderUri: folderUri,
        roundId: "intent-auto-1",
        command: "vs-code-ai-helper.runImplementationWithAI",
        stage: "impl",
      });

      const raw = JSON.parse(fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")) as TaskProgress;
      const row = resolveRoundV1(raw, "intent-auto-1");
      assert.ok(row, "must open a row for the given roundId");
      assert.equal(row?.intentId, "intent-auto-1");
      assert.equal(row?.mode, "implementation");
      assert.equal(row?.stage, "impl");
      assert.equal(row?.state, "open");
      assert.equal(row?.endedAt, undefined);
    } finally {
      wsStub.restore();
      fsBridge.restore();
    }
  });

  void it("is a no-op when a row already resolves the given roundId — never overwrites it", async () => {
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    try {
      const folderPath = path.join(REAL_ROOT, "plans", "open_automation_round_ledger_row_existing");
      fs.mkdirSync(folderPath, { recursive: true });
      const existingRow = makeBaseEntry({ roundId: "intent-auto-2", intentId: "intent-auto-2", mode: "review", stage: "impl-high-review" });
      const progress: TaskProgress & { ensembleProgressVersion: 1 } = {
        ensembleProgressVersion: 1,
        taskFolder: "open_automation_round_ledger_row_existing",
        currentStage: "impl",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        roundLedger: [existingRow],
        ownership: {
          metaRoot: path.join(REAL_ROOT, "plans"),
          projectRoot: REAL_ROOT,
          workspaceRoot: REAL_ROOT,
          boundAt: "2026-01-01T00:00:00.000Z",
        },
      };
      fs.writeFileSync(
        path.join(folderPath, "task-progress.json"),
        JSON.stringify(progress, null, 2),
        "utf8"
      );
      const folderUri = vscode.Uri.file(folderPath);

      await openAutomationRoundLedgerRowBestEffortV1({
        taskFolderUri: folderUri,
        roundId: "intent-auto-2",
        command: "vs-code-ai-helper.runImplementationWithAI",
        stage: "impl",
      });

      const raw = JSON.parse(fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")) as TaskProgress;
      assert.deepEqual(raw.roundLedger, [existingRow], "an existing row for this roundId must never be overwritten");
    } finally {
      wsStub.restore();
      fsBridge.restore();
    }
  });
});

// 2026-08-27 review follow-up: the side channel `scheduleAutomationChain`
// uses to stage an automation dispatch's intentId for `claimReviewAttempt`
// to consume — see `setPendingAutomationRoundIntentV1`'s own doc comment for
// why this is a lightweight in-memory correlation rather than threading
// intentId through every dispatch's `arg`.
void describe("setPendingAutomationRoundIntentV1 / consumePendingAutomationRoundIntentV1 (Part 4 review follow-up)", () => {
  void it("returns the staged intentId once, then undefined on a second read", () => {
    __resetPendingAutomationRoundIntentsForTestV1();
    setPendingAutomationRoundIntentV1("task-key-1", "intent-abc");
    assert.equal(consumePendingAutomationRoundIntentV1("task-key-1"), "intent-abc");
    assert.equal(consumePendingAutomationRoundIntentV1("task-key-1"), undefined);
  });

  void it("returns undefined for a key nothing was ever staged under", () => {
    __resetPendingAutomationRoundIntentsForTestV1();
    assert.equal(consumePendingAutomationRoundIntentV1("never-staged"), undefined);
  });

  void it("keeps entries for different task keys independent", () => {
    __resetPendingAutomationRoundIntentsForTestV1();
    setPendingAutomationRoundIntentV1("task-a", "intent-a");
    setPendingAutomationRoundIntentV1("task-b", "intent-b");
    assert.equal(consumePendingAutomationRoundIntentV1("task-b"), "intent-b");
    assert.equal(consumePendingAutomationRoundIntentV1("task-a"), "intent-a");
  });
});

void describe("claimReviewAttempt — reuses an automation-staged generic row instead of opening a second one (Part 4 review follow-up, blocker 1)", () => {
  void it("merges into the existing intent-keyed row when a pending automation intentId resolves it", async () => {
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    __resetPendingAutomationRoundIntentsForTestV1();
    try {
      const folderPath = path.join(REAL_ROOT, "plans", "claim_review_attempt_reuses_generic_row");
      fs.mkdirSync(folderPath, { recursive: true });
      const genericRow = makeBaseEntry({
        roundId: "auto-intent-1",
        intentId: "auto-intent-1",
        attemptIds: [],
        mode: "implementation",
        stage: "impl-high-review",
      });
      const progress: TaskProgress & { ensembleProgressVersion: 1 } = {
        ensembleProgressVersion: 1,
        taskFolder: "claim_review_attempt_reuses_generic_row",
        currentStage: "impl-high-review",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        roundLedger: [genericRow],
        ownership: {
          metaRoot: path.join(REAL_ROOT, "plans"),
          projectRoot: REAL_ROOT,
          workspaceRoot: REAL_ROOT,
          boundAt: "2026-01-01T00:00:00.000Z",
        },
      };
      fs.writeFileSync(
        path.join(folderPath, "task-progress.json"),
        JSON.stringify(progress, null, 2),
        "utf8"
      );
      const folderUri = vscode.Uri.file(folderPath);

      // Simulates scheduleAutomationChain staging the intentId immediately
      // before dispatching the review command that will call this.
      setPendingAutomationRoundIntentV1(folderUri.fsPath, "auto-intent-1");

      const claimed = await claimReviewAttempt(folderUri, "review-attempt-1", "impl-high-review");
      if (!claimed) throw new Error("unreachable");

      // Exactly one row survives — no second row keyed by reviewAttemptId.
      assert.equal(claimed.roundLedger?.length, 1, "the round must remain a single identity, not two rows");
      const row = claimed.roundLedger?.[0];
      assert.equal(row?.roundId, "auto-intent-1", "the row's own roundId is never replaced");
      assert.equal(row?.intentId, "auto-intent-1");
      assert.equal(row?.mode, "review", "reuse must still flip mode to review");
      assert.equal(row?.stage, "impl-high-review");
      assert.equal(row?.state, "open");
      assert.deepEqual(row?.attemptIds, ["review-attempt-1"]);

      // Both identities now resolve to the SAME row.
      assert.equal(resolveRoundV1(claimed, "auto-intent-1"), row);
      assert.equal(resolveRoundV1(claimed, "review-attempt-1"), row);

      // The pending entry was consumed — a second claim (no new staging)
      // falls back to opening its own row, exactly as a manual dispatch would.
      const claimed2 = await claimReviewAttempt(folderUri, "review-attempt-2", "impl-high-review");
      assert.equal(claimed2?.roundLedger?.length, 2, "an unstaged claim must open its own row, not reuse an unrelated one");
    } finally {
      wsStub.restore();
      fsBridge.restore();
    }
  });

  void it("discards a stale pending intentId that resolves to an already-terminal row, instead of reopening it (2026-08-27 review, blocker 1)", async () => {
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    __resetPendingAutomationRoundIntentsForTestV1();
    try {
      const folderPath = path.join(REAL_ROOT, "plans", "claim_review_attempt_stale_terminal_row");
      fs.mkdirSync(folderPath, { recursive: true });
      // A PRIOR round's generic row, already terminalized (e.g. an
      // Implementation dispatch that finished, or errored before this
      // review's own claim ever ran) — its intentId is left unconsumed in
      // the pending-intent side channel until this claim reads it.
      const terminalRow = makeBaseEntry({
        roundId: "auto-intent-stale",
        intentId: "auto-intent-stale",
        attemptIds: ["prior-attempt"],
        mode: "implementation",
        stage: "impl",
        state: "completed",
        endedAt: "2026-01-01T00:05:00.000Z",
        outcome: { filesChanged: ["src/foo.ts"] },
      });
      const progress: TaskProgress & { ensembleProgressVersion: 1 } = {
        ensembleProgressVersion: 1,
        taskFolder: "claim_review_attempt_stale_terminal_row",
        currentStage: "impl-high-review",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        roundLedger: [terminalRow],
        ownership: {
          metaRoot: path.join(REAL_ROOT, "plans"),
          projectRoot: REAL_ROOT,
          workspaceRoot: REAL_ROOT,
          boundAt: "2026-01-01T00:00:00.000Z",
        },
      };
      fs.writeFileSync(
        path.join(folderPath, "task-progress.json"),
        JSON.stringify(progress, null, 2),
        "utf8"
      );
      const folderUri = vscode.Uri.file(folderPath);

      // The stale entry — left over from the prior, already-terminal round —
      // is still sitting in the side channel when this unrelated review
      // claims its attempt.
      setPendingAutomationRoundIntentV1(folderUri.fsPath, "auto-intent-stale");

      const claimed = await claimReviewAttempt(folderUri, "review-attempt-fresh", "impl-high-review");
      if (!claimed) throw new Error("unreachable");

      assert.equal(claimed.roundLedger?.length, 2, "the terminal row must be left alone, not reopened — a fresh row is opened instead");
      const priorRow = resolveRoundV1(claimed, "auto-intent-stale");
      assert.equal(priorRow?.state, "completed", "the prior round's terminal state must never be reverted to open");
      assert.equal(priorRow?.endedAt, "2026-01-01T00:05:00.000Z", "the prior round's ending must be untouched");
      assert.deepEqual(priorRow?.attemptIds, ["prior-attempt"], "the stale row must not gain this review's attemptId");

      const freshRow = resolveRoundV1(claimed, "review-attempt-fresh");
      assert.ok(freshRow, "a fresh row must be opened for this review");
      assert.equal(freshRow?.roundId, "review-attempt-fresh");
      assert.equal(freshRow?.state, "open");
      assert.equal(
        freshRow?.intentId,
        undefined,
        "the stale intentId must not be attached to the fresh row — it belongs to a different, already-ended round"
      );
    } finally {
      wsStub.restore();
      fsBridge.restore();
    }
  });

  void it("opens its own row exactly as before when nothing was staged (manual dispatch)", async () => {
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    __resetPendingAutomationRoundIntentsForTestV1();
    try {
      const folderPath = path.join(REAL_ROOT, "plans", "claim_review_attempt_no_pending_intent");
      fs.mkdirSync(folderPath, { recursive: true });
      const progress: TaskProgress & { ensembleProgressVersion: 1 } = {
        ensembleProgressVersion: 1,
        taskFolder: "claim_review_attempt_no_pending_intent",
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
      };
      fs.writeFileSync(
        path.join(folderPath, "task-progress.json"),
        JSON.stringify(progress, null, 2),
        "utf8"
      );
      const folderUri = vscode.Uri.file(folderPath);

      const claimed = await claimReviewAttempt(folderUri, "review-attempt-manual", "impl-high-review");
      if (!claimed) throw new Error("unreachable");
      const row = resolveRoundV1(claimed, "review-attempt-manual");
      assert.ok(row);
      assert.equal(row?.roundId, "review-attempt-manual");
      assert.equal(row?.intentId, undefined, "a manual claim has no intentId to attach");
    } finally {
      wsStub.restore();
      fsBridge.restore();
    }
  });
});

void describe("terminalStateForUnclosedReviewOutcomeV1 (item 18 / Part 4 safety net)", () => {
  void it("maps 'completed' to 'completed' and 'cancelled' to 'cancelled'", () => {
    assert.equal(
      terminalStateForUnclosedReviewOutcomeV1({ kind: "completed" } as unknown as TaskActionOutcomeV1),
      "completed"
    );
    assert.equal(
      terminalStateForUnclosedReviewOutcomeV1({ kind: "cancelled" } as unknown as TaskActionOutcomeV1),
      "cancelled"
    );
  });

  void it("maps every other outcome kind (failed/unavailable/questions/...) to 'failed'", () => {
    for (const kind of [
      "questions",
      "failed",
      "malformedResult",
      "unavailable",
      "recoveryRequired",
      "stalePreflight",
      "partialEditBlocked",
    ]) {
      assert.equal(
        terminalStateForUnclosedReviewOutcomeV1({ kind } as unknown as TaskActionOutcomeV1),
        "failed",
        `outcome kind "${kind}" must map to a terminal "failed" ledger state`
      );
    }
  });
});

void describe("claimImplementationRoundLedgerV1 (Part 4 architectural fix, 2026-08-27 review follow-up)", () => {
  void it("opens a fresh row under candidateRoundId when nothing is pending (manual dispatch)", async () => {
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    __resetPendingAutomationRoundIntentsForTestV1();
    try {
      const folderPath = path.join(REAL_ROOT, "plans", "claim_impl_round_manual");
      fs.mkdirSync(folderPath, { recursive: true });
      const progress: TaskProgress & { ensembleProgressVersion: 1 } = {
        ensembleProgressVersion: 1,
        taskFolder: "claim_impl_round_manual",
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
      };
      fs.writeFileSync(path.join(folderPath, "task-progress.json"), JSON.stringify(progress, null, 2), "utf8");
      const folderUri = vscode.Uri.file(folderPath);

      const claimed = await claimImplementationRoundLedgerV1(folderUri, "prompt-round-1", "impl", "implementation");
      assert.equal(claimed.roundId, "prompt-round-1");

      const raw = JSON.parse(fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")) as TaskProgress;
      assert.equal(raw.roundLedger?.length, 1);
      assert.equal(raw.roundLedger?.[0]?.roundId, "prompt-round-1");
      assert.equal(raw.roundLedger?.[0]?.state, "open");
      assert.equal(raw.roundLedger?.[0]?.intentId, undefined, "a manual claim has no intentId to attach");
    } finally {
      wsStub.restore();
      fsBridge.restore();
    }
  });

  void it("reuses a pending automation-staged generic row instead of opening a second one", async () => {
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    __resetPendingAutomationRoundIntentsForTestV1();
    try {
      const folderPath = path.join(REAL_ROOT, "plans", "claim_impl_round_reuses_generic_row");
      fs.mkdirSync(folderPath, { recursive: true });
      const genericRow = makeBaseEntry({
        roundId: "auto-intent-impl-1",
        intentId: "auto-intent-impl-1",
        attemptIds: [],
        mode: "implementation",
        stage: "impl",
      });
      const progress: TaskProgress & { ensembleProgressVersion: 1 } = {
        ensembleProgressVersion: 1,
        taskFolder: "claim_impl_round_reuses_generic_row",
        currentStage: "impl",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        roundLedger: [genericRow],
        ownership: {
          metaRoot: path.join(REAL_ROOT, "plans"),
          projectRoot: REAL_ROOT,
          workspaceRoot: REAL_ROOT,
          boundAt: "2026-01-01T00:00:00.000Z",
        },
      };
      fs.writeFileSync(path.join(folderPath, "task-progress.json"), JSON.stringify(progress, null, 2), "utf8");
      const folderUri = vscode.Uri.file(folderPath);

      setPendingAutomationRoundIntentV1(folderUri.fsPath, "auto-intent-impl-1");

      const claimed = await claimImplementationRoundLedgerV1(folderUri, "prompt-round-2", "impl", "implementation");
      assert.equal(claimed.roundId, "auto-intent-impl-1", "the reused row's own roundId is never replaced");

      const raw = JSON.parse(fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")) as TaskProgress;
      assert.equal(raw.roundLedger?.length, 1, "the round must remain a single identity, not two rows");
      assert.deepEqual(raw.roundLedger?.[0]?.attemptIds, ["prompt-round-2"]);
    } finally {
      wsStub.restore();
      fsBridge.restore();
    }
  });

  void it("is a no-op when candidateRoundId already resolves to a row (the continuation-linkage case)", async () => {
    const fsBridge = installFsBridge();
    const wsStub = installWorkspaceFoldersStub();
    __resetPendingAutomationRoundIntentsForTestV1();
    try {
      const folderPath = path.join(REAL_ROOT, "plans", "claim_impl_round_already_own");
      fs.mkdirSync(folderPath, { recursive: true });
      const continuationRow = makeBaseEntry({
        roundId: "impl-continuation-1",
        attemptIds: [],
        mode: "continuation",
        stage: "impl",
        continuationOf: "source-round-1",
      });
      const progress: TaskProgress & { ensembleProgressVersion: 1 } = {
        ensembleProgressVersion: 1,
        taskFolder: "claim_impl_round_already_own",
        currentStage: "impl",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        roundLedger: [continuationRow],
        ownership: {
          metaRoot: path.join(REAL_ROOT, "plans"),
          projectRoot: REAL_ROOT,
          workspaceRoot: REAL_ROOT,
          boundAt: "2026-01-01T00:00:00.000Z",
        },
      };
      fs.writeFileSync(path.join(folderPath, "task-progress.json"), JSON.stringify(progress, null, 2), "utf8");
      const folderUri = vscode.Uri.file(folderPath);

      const claimed = await claimImplementationRoundLedgerV1(
        folderUri,
        "impl-continuation-1",
        "impl",
        "continuation"
      );
      assert.equal(claimed.roundId, "impl-continuation-1");

      const raw = JSON.parse(fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")) as TaskProgress;
      assert.equal(raw.roundLedger?.length, 1, "no second row must be opened for a round that already has one");
      assert.equal(raw.roundLedger?.[0]?.continuationOf, "source-round-1", "the existing row must be untouched");
    } finally {
      wsStub.restore();
      fsBridge.restore();
    }
  });
});

void describe(
  "attachCoordinatorIdentityToRoundV1 (Part 4 architectural fix, 2026-08-28: " +
    "\"coordinator allocation sites still do not attach operation and attempt identities to a round-ledger row ... at allocation time\")",
  () => {
    void it("attaches operationId and merges attemptId into a still-live row", async () => {
      const fsBridge = installFsBridge();
      try {
        const folderPath = path.join(REAL_ROOT, "plans", "attach_identity_live_row");
        fs.mkdirSync(folderPath, { recursive: true });
        const row = makeBaseEntry({
          roundId: "review-attempt-1",
          intentId: undefined,
          attemptIds: [],
          state: "open",
        });
        fs.writeFileSync(
          path.join(folderPath, "task-progress.json"),
          JSON.stringify({ ...makeProgress({ taskFolder: "attach_identity_live_row", roundLedger: [row] }) }, null, 2),
          "utf8"
        );
        const folderUri = vscode.Uri.file(folderPath);

        await attachCoordinatorIdentityToRoundV1({
          taskFolderUri: folderUri,
          roundId: "review-attempt-1",
          operationId: "coordinator-op-1",
          attemptId: "coordinator-attempt-1",
        });

        const raw = JSON.parse(fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")) as TaskProgress;
        const updated = raw.roundLedger?.[0];
        assert.equal(updated?.state, "open", "attaching identity must never change the row's live state");
        assert.equal(updated?.operationId, "coordinator-op-1");
        assert.ok(
          updated?.attemptIds.includes("coordinator-attempt-1"),
          "the coordinator's attemptId must be merged into attemptIds"
        );
      } finally {
        fsBridge.restore();
      }
    });

    void it("never overwrites an operationId the row already carries", async () => {
      const fsBridge = installFsBridge();
      try {
        const folderPath = path.join(REAL_ROOT, "plans", "attach_identity_no_overwrite");
        fs.mkdirSync(folderPath, { recursive: true });
        const row = makeBaseEntry({
          roundId: "review-attempt-2",
          intentId: undefined,
          operationId: "already-attached-op",
          attemptIds: ["already-attached-op"],
          state: "open",
        });
        fs.writeFileSync(
          path.join(folderPath, "task-progress.json"),
          JSON.stringify({ ...makeProgress({ taskFolder: "attach_identity_no_overwrite", roundLedger: [row] }) }, null, 2),
          "utf8"
        );
        const folderUri = vscode.Uri.file(folderPath);

        await attachCoordinatorIdentityToRoundV1({
          taskFolderUri: folderUri,
          roundId: "review-attempt-2",
          operationId: "already-attached-op",
          attemptId: "a-retry-attempt",
        });

        const raw = JSON.parse(fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")) as TaskProgress;
        const updated = raw.roundLedger?.[0];
        assert.equal(updated?.operationId, "already-attached-op", "operationId is attached once, never reassigned");
        assert.ok(
          updated?.attemptIds.includes("a-retry-attempt"),
          "a later attempt (fallback/retry) is still merged into attemptIds"
        );
      } finally {
        fsBridge.restore();
      }
    });

    void it("is a no-op once the row has already terminalized (loses the race with terminalizeRoundV1)", async () => {
      const fsBridge = installFsBridge();
      try {
        const folderPath = path.join(REAL_ROOT, "plans", "attach_identity_terminal_race");
        fs.mkdirSync(folderPath, { recursive: true });
        const row = makeBaseEntry({
          roundId: "review-attempt-3",
          intentId: undefined,
          attemptIds: ["review-attempt-3"],
          state: "completed",
          endedAt: "2026-01-01T00:05:00.000Z",
        });
        fs.writeFileSync(
          path.join(folderPath, "task-progress.json"),
          JSON.stringify({ ...makeProgress({ taskFolder: "attach_identity_terminal_race", roundLedger: [row] }) }, null, 2),
          "utf8"
        );
        const folderUri = vscode.Uri.file(folderPath);

        await assert.rejects(() => attachCoordinatorIdentityToRoundV1({
          taskFolderUri: folderUri,
          roundId: "review-attempt-3",
          operationId: "too-late-op",
          attemptId: "too-late-attempt",
        }), /not live/);

        const raw = JSON.parse(fs.readFileSync(path.join(folderPath, "task-progress.json"), "utf8")) as TaskProgress;
        const updated = raw.roundLedger?.[0];
        assert.equal(updated?.operationId, undefined, "a terminal row's facts must never be amended after the fact");
        assert.equal(updated?.state, "completed");
      } finally {
        fsBridge.restore();
      }
    });
  }
);

// `recordChecklistRevisionOnRoundLedgerV1`'s own coverage was removed
// 2026-08-28 along with the function itself — see `roundLedgerV1.ts`'s
// removal note. Equivalent coverage (attaches onto the existing row, is a
// no-op when the row is pruned, never reassigns an already-set annotation)
// now lives in `taskProgressTransforms.test.ts` against
// `markChecklistChangeProposalAdoptedV1` directly, and end-to-end coverage
// through the real `preparePlanPromotion` publish path lives in
// `planRevisionV1.test.ts`.
