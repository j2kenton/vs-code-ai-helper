/**
 * Coverage for the §4.2 creation intent/journal/sentinel store: exclusive-
 * create semantics for the immutable intent, forward-only journal
 * transitions with idempotent crash-resume, and the sentinel commit's own
 * crash-resume/conflict handling.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import {
  commitCreationSentinelV1,
  loadTaskCreationJournalV1,
  recordFinalFolderClaimedV1,
  recordProgressCommittedV1,
  recordTaskCreationIntentV1,
  recordWorkMaterializedV1,
  resolveTaskCreationV1,
  taskCreationIntentDigestV1,
} from "../services/taskCreationIntentStoreV1";
import { CREATION_SENTINEL_FILENAME_V1 } from "../services/workflowPrivacyClassifierV1";
import { resetWorkflowRuntimeServicesForTestV1 } from "../services/workflowRuntimeServicesV1";
import {
  decodeTaskCreationSentinelV1,
  encodeTaskCreationSentinelV1,
  fileCreationIntentEntryV1,
  TaskCreationIntentEntryV1,
  TaskCreationSentinelV1,
} from "../types/taskCreationIntentV1";
import { writeOwnershipBackedTaskProgress } from "./taskFolderFixture";
import { safeRemoveDir } from "./testFsUtils";

function installConfigStub(configuredTaskRoot: string): { restore: () => void } {
  const original = (vscode.workspace as unknown as Record<string, unknown>).getConfiguration;
  (vscode.workspace as unknown as Record<string, unknown>).getConfiguration = (): {
    get: (key: string, defaultValue?: unknown) => unknown;
    update: () => Promise<void>;
    inspect: () => undefined;
  } => ({
    get: (key: string, defaultValue?: unknown): unknown => (key === "metaResourcesPath" ? configuredTaskRoot : defaultValue),
    update: async (): Promise<void> => {},
    inspect: () => undefined,
  });
  return { restore: (): void => { (vscode.workspace as unknown as Record<string, unknown>).getConfiguration = original; } };
}

function installWorkspaceFoldersStub(roots: readonly string[]): { restore: () => void } {
  const target = vscode.workspace as unknown as Record<string, unknown>;
  const orig = target.workspaceFolders;
  target.workspaceFolders = roots.map((root, index) => ({ uri: vscode.Uri.file(root), name: path.basename(root), index }));
  return { restore: (): void => { target.workspaceFolders = orig; } };
}

interface Harness {
  workspaceRoot: string;
  metaFolderPath: string;
  taskFolderPath: string;
  taskFolderName: string;
  restore(): void;
}

/** Registers `.ensemble` under a fresh temp workspace root as a resolvable meta-root candidate. */
function installHarness(): Harness {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-creation-intent-store-"));
  const metaFolderPath = path.join(workspaceRoot, ".ensemble");
  fs.mkdirSync(metaFolderPath, { recursive: true });
  const taskFolderName = "2026-07-30_task_1";
  const taskFolderPath = path.join(metaFolderPath, taskFolderName);
  const configStub = installConfigStub(".ensemble");
  const wsStub = installWorkspaceFoldersStub([workspaceRoot]);
  resetWorkflowRuntimeServicesForTestV1();
  return {
    workspaceRoot,
    metaFolderPath,
    taskFolderPath,
    taskFolderName,
    restore(): void {
      configStub.restore();
      wsStub.restore();
      resetWorkflowRuntimeServicesForTestV1();
      safeRemoveDir(workspaceRoot);
    },
  };
}

function ownershipInputFor(h: Harness): { metaRoot: string; projectRoot: string; workspaceRoot: string } {
  return { metaRoot: h.metaFolderPath, projectRoot: h.workspaceRoot, workspaceRoot: h.workspaceRoot };
}

const CREATED_ENTRIES: readonly TaskCreationIntentEntryV1[] = [
  { relativePath: "task-progress.json", kind: "file", entryClass: "createdV1", contentSha256: "a".repeat(64), sizeBytes: 2 },
  { relativePath: "task.md", kind: "file", entryClass: "createdV1", contentSha256: "b".repeat(64), sizeBytes: 7 },
];

/** Advances a fresh journal through intentRecorded -> finalFolderClaimed, writing the real task folder content along the way (mirroring startNewTask.ts's own order). */
async function advanceToFinalFolderClaimed(h: Harness): Promise<void> {
  const recorded = await recordTaskCreationIntentV1({
    metaFolderPath: h.metaFolderPath,
    taskFolderPath: h.taskFolderPath,
    taskFolderName: h.taskFolderName,
    ownership: ownershipInputFor(h),
  });
  assert.equal(recorded.kind, "ok");
  const materialized = await recordWorkMaterializedV1(h.metaFolderPath, h.taskFolderPath);
  assert.equal(materialized.kind, "ok");

  fs.mkdirSync(h.taskFolderPath, { recursive: true });
  writeOwnershipBackedTaskProgress(h.taskFolderPath);
  fs.writeFileSync(path.join(h.taskFolderPath, "task.md"), "# Task\n");

  const claimed = await recordFinalFolderClaimedV1(h.metaFolderPath, h.taskFolderPath, CREATED_ENTRIES);
  assert.equal(claimed.kind, "ok");
}

void describe("taskCreationIntentStoreV1", () => {
  void it("recordTaskCreationIntentV1 is exclusive-create: a second call for the same folder is rejected", async () => {
    const h = installHarness();
    try {
      const first = await recordTaskCreationIntentV1({
        metaFolderPath: h.metaFolderPath,
        taskFolderPath: h.taskFolderPath,
        taskFolderName: h.taskFolderName,
        ownership: ownershipInputFor(h),
      });
      assert.equal(first.kind, "ok");
      const second = await recordTaskCreationIntentV1({
        metaFolderPath: h.metaFolderPath,
        taskFolderPath: h.taskFolderPath,
        taskFolderName: h.taskFolderName,
        ownership: ownershipInputFor(h),
      });
      assert.equal(second.kind, "rejected");
    } finally {
      h.restore();
    }
  });

  void it("loadTaskCreationJournalV1 returns missing for a folder never recorded", async () => {
    const h = installHarness();
    try {
      const result = await loadTaskCreationJournalV1(h.metaFolderPath, h.taskFolderPath);
      assert.equal(result.kind, "missing");
    } finally {
      h.restore();
    }
  });

  void it("rejects an illegal transition (skipping ahead) and leaves the journal unchanged", async () => {
    const h = installHarness();
    try {
      const recorded = await recordTaskCreationIntentV1({
        metaFolderPath: h.metaFolderPath,
        taskFolderPath: h.taskFolderPath,
        taskFolderName: h.taskFolderName,
        ownership: ownershipInputFor(h),
      });
      assert.equal(recorded.kind, "ok");

      const illegal = await recordProgressCommittedV1(h.metaFolderPath, h.taskFolderPath);
      assert.equal(illegal.kind, "rejected");

      const stillAt = await loadTaskCreationJournalV1(h.metaFolderPath, h.taskFolderPath);
      assert.equal(stillAt.kind, "ok");
      if (stillAt.kind === "ok") {
        assert.equal(stillAt.journal.state, "intentRecorded");
      }
    } finally {
      h.restore();
    }
  });

  void it("walks the full six-state chain, is idempotent on a repeated call at the current state, and writes a decodable sentinel", async () => {
    const h = installHarness();
    try {
      await advanceToFinalFolderClaimed(h);

      // Crash-resume: repeating the just-completed transition is a no-op success.
      const repeatFinalClaim = await recordFinalFolderClaimedV1(h.metaFolderPath, h.taskFolderPath, CREATED_ENTRIES);
      assert.equal(repeatFinalClaim.kind, "ok");
      if (repeatFinalClaim.kind === "ok") {
        assert.equal(repeatFinalClaim.journal.state, "finalFolderClaimed");
      }

      const sentinelResult = await commitCreationSentinelV1(h.metaFolderPath, h.taskFolderPath);
      assert.equal(sentinelResult.kind, "ok");
      if (sentinelResult.kind === "ok") {
        assert.equal(sentinelResult.journal.state, "sentinelCommitted");
      }

      const sentinelPath = path.join(h.taskFolderPath, CREATION_SENTINEL_FILENAME_V1);
      assert.ok(fs.existsSync(sentinelPath), "the sentinel file must actually exist in the task folder");
      const decodedSentinel = decodeTaskCreationSentinelV1(fs.readFileSync(sentinelPath, "utf8"));
      assert.equal(decodedSentinel.ok, true);
      if (decodedSentinel.ok) {
        assert.equal(decodedSentinel.sentinel.taskFolderName, h.taskFolderName);
        const paths = decodedSentinel.sentinel.entries.map((e) => e.relativePath).sort();
        assert.deepEqual(paths, ["task-progress.json", "task.md"]);
      }

      // Crash-resume: re-committing the sentinel after it already succeeded is a no-op success.
      const sentinelAgain = await commitCreationSentinelV1(h.metaFolderPath, h.taskFolderPath);
      assert.equal(sentinelAgain.kind, "ok");

      const progressCommitted = await recordProgressCommittedV1(h.metaFolderPath, h.taskFolderPath);
      assert.equal(progressCommitted.kind, "ok");
      if (progressCommitted.kind === "ok") {
        assert.equal(progressCommitted.journal.state, "progressCommitted");
      }

      const resolved = await resolveTaskCreationV1(h.metaFolderPath, h.taskFolderPath);
      assert.equal(resolved.kind, "ok");
      if (resolved.kind === "ok") {
        assert.equal(resolved.journal.state, "resolved");
      }

      // Crash-resume: re-resolving an already-resolved journal is a no-op success.
      const resolvedAgain = await resolveTaskCreationV1(h.metaFolderPath, h.taskFolderPath);
      assert.equal(resolvedAgain.kind, "ok");

      const loaded = await loadTaskCreationJournalV1(h.metaFolderPath, h.taskFolderPath);
      assert.equal(loaded.kind, "ok");
      if (loaded.kind === "ok") {
        assert.equal(loaded.journal.state, "resolved");
        assert.equal(loaded.journal.transitions.length, 6);
      }
    } finally {
      h.restore();
    }
  });

  void it("commitCreationSentinelV1 resumes past a crash that wrote the sentinel but not yet the journal transition", async () => {
    const h = installHarness();
    try {
      await advanceToFinalFolderClaimed(h);

      const beforeCommit = await loadTaskCreationJournalV1(h.metaFolderPath, h.taskFolderPath);
      assert.equal(beforeCommit.kind, "ok");
      if (beforeCommit.kind !== "ok") return;

      // Simulate: an earlier process wrote the exact sentinel bytes this call
      // would produce, then crashed before the journal's replaceFileExact.
      const sentinel: TaskCreationSentinelV1 = {
        schemaVersion: 1,
        intentId: beforeCommit.journal.intentId,
        taskFolderName: h.taskFolderName,
        createdAt: beforeCommit.journal.createdAt,
        entries: beforeCommit.journal.entries,
      };
      fs.writeFileSync(path.join(h.taskFolderPath, CREATION_SENTINEL_FILENAME_V1), encodeTaskCreationSentinelV1(sentinel));

      const result = await commitCreationSentinelV1(h.metaFolderPath, h.taskFolderPath);
      assert.equal(result.kind, "ok");
      if (result.kind === "ok") {
        assert.equal(result.journal.state, "sentinelCommitted");
      }
    } finally {
      h.restore();
    }
  });

  void it("commitCreationSentinelV1 returns recoveryRequired when a conflicting sentinel already occupies the path", async () => {
    const h = installHarness();
    try {
      await advanceToFinalFolderClaimed(h);

      const conflicting: TaskCreationSentinelV1 = {
        schemaVersion: 1,
        intentId: "0".repeat(32),
        taskFolderName: "some-other-folder",
        createdAt: "2020-01-01T00:00:00.000Z",
        entries: [fileCreationIntentEntryV1("unexpected.md", "createdV1", Buffer.from("unexpected content", "utf8"))],
      };
      fs.writeFileSync(path.join(h.taskFolderPath, CREATION_SENTINEL_FILENAME_V1), encodeTaskCreationSentinelV1(conflicting));

      const result = await commitCreationSentinelV1(h.metaFolderPath, h.taskFolderPath);
      assert.equal(result.kind, "recoveryRequired");

      // The conflicting sentinel must be left exactly as found — never silently overwritten.
      const decoded = decodeTaskCreationSentinelV1(fs.readFileSync(path.join(h.taskFolderPath, CREATION_SENTINEL_FILENAME_V1), "utf8"));
      assert.equal(decoded.ok, true);
      if (decoded.ok) {
        assert.equal(decoded.sentinel.taskFolderName, "some-other-folder");
      }
    } finally {
      h.restore();
    }
  });

  void it("loadTaskCreationJournalV1 returns recoveryRequired for a corrupt journal file", async () => {
    const h = installHarness();
    try {
      const recorded = await recordTaskCreationIntentV1({
        metaFolderPath: h.metaFolderPath,
        taskFolderPath: h.taskFolderPath,
        taskFolderName: h.taskFolderName,
        ownership: ownershipInputFor(h),
      });
      assert.equal(recorded.kind, "ok");

      const digest = taskCreationIntentDigestV1(h.taskFolderPath);
      const journalPath = path.join(h.metaFolderPath, "creation-intents-v1", `journal-${digest}.json`);
      assert.ok(fs.existsSync(journalPath));
      fs.writeFileSync(journalPath, "{not valid json");

      const result = await loadTaskCreationJournalV1(h.metaFolderPath, h.taskFolderPath);
      assert.equal(result.kind, "recoveryRequired");
    } finally {
      h.restore();
    }
  });

  void it("recordProgressCommittedV1's entries param replaces the earlier finalFolderClaimed-time hash for the same path", async () => {
    const h = installHarness();
    try {
      await advanceToFinalFolderClaimed(h);
      await commitCreationSentinelV1(h.metaFolderPath, h.taskFolderPath);

      const beforeFinal = await loadTaskCreationJournalV1(h.metaFolderPath, h.taskFolderPath);
      assert.equal(beforeFinal.kind, "ok");
      if (beforeFinal.kind !== "ok") return;
      const initialProgressEntry = beforeFinal.journal.entries.find((e) => e.relativePath === "task-progress.json");
      assert.equal(initialProgressEntry?.contentSha256, "a".repeat(64));

      const finalProgressEntry: TaskCreationIntentEntryV1 = {
        relativePath: "task-progress.json",
        kind: "file",
        entryClass: "createdV1",
        contentSha256: "c".repeat(64),
        sizeBytes: 99,
      };
      const progressCommitted = await recordProgressCommittedV1(h.metaFolderPath, h.taskFolderPath, [finalProgressEntry]);
      assert.equal(progressCommitted.kind, "ok");
      if (progressCommitted.kind === "ok") {
        const updated = progressCommitted.journal.entries.find((e) => e.relativePath === "task-progress.json");
        assert.equal(updated?.contentSha256, "c".repeat(64), "the final write's hash must replace the finalFolderClaimed-time hash");
        const taskMdEntry = progressCommitted.journal.entries.find((e) => e.relativePath === "task.md");
        assert.equal(taskMdEntry?.contentSha256, "b".repeat(64), "unrelated entries must be preserved");
      }
    } finally {
      h.restore();
    }
  });

  void it("keeps independent journals for different task folders under the same meta root", async () => {
    const h = installHarness();
    const secondTaskFolderPath = path.join(h.metaFolderPath, "2026-07-30_task_2");
    try {
      await recordTaskCreationIntentV1({
        metaFolderPath: h.metaFolderPath,
        taskFolderPath: h.taskFolderPath,
        taskFolderName: h.taskFolderName,
        ownership: ownershipInputFor(h),
      });
      await recordTaskCreationIntentV1({
        metaFolderPath: h.metaFolderPath,
        taskFolderPath: secondTaskFolderPath,
        taskFolderName: "2026-07-30_task_2",
        ownership: ownershipInputFor(h),
      });

      const first = await loadTaskCreationJournalV1(h.metaFolderPath, h.taskFolderPath);
      const second = await loadTaskCreationJournalV1(h.metaFolderPath, secondTaskFolderPath);
      assert.equal(first.kind, "ok");
      assert.equal(second.kind, "ok");
      if (first.kind === "ok" && second.kind === "ok") {
        assert.notEqual(first.intent.intentId, second.intent.intentId);
      }
    } finally {
      h.restore();
    }
  });
});
