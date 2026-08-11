/**
 * Coverage for TaskCreationStartupReconcilerV1 (plan §4.1/§4.3): strict
 * classification of `status: "creating"` folders into the four conservative
 * recovery classes, and the activation-order barrier this module now IS
 * (the retired LegacyCreatingStartupGateV0's real-fs bridge and fixture
 * conventions carried over unchanged).
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { TaskCreationStartupReconcilerV1 } from "../state/taskCreationStartupReconcilerV1";
import { resetCreationSeedHistoryCacheForTests } from "../services/taskCreationSeedHistoryV1";
import {
  commitCreationSentinelV1,
  recordFinalFolderClaimedV1,
  recordProgressCommittedV1,
  recordTaskCreationIntentV1,
  recordWorkMaterializedV1,
  resolveTaskCreationV1,
} from "../services/taskCreationIntentStoreV1";
import { resetWorkflowRuntimeServicesForTestV1 } from "../services/workflowRuntimeServicesV1";
import { fileCreationIntentEntryV1, TaskCreationIntentEntryV1 } from "../types/taskCreationIntentV1";

/** Reads a file's actual on-disk bytes and builds its `createdV1` journal entry from them, matching startNewTask.ts's own read-back-after-write pattern. */
function entryForV1(taskFolderPath: string, relativePath: string): TaskCreationIntentEntryV1 {
  return fileCreationIntentEntryV1(relativePath, "createdV1", fs.readFileSync(path.join(taskFolderPath, relativePath)));
}

// The repo root doubles as a fake "extension root" in tests: it genuinely
// contains resources/prompts/task-template.md and the
// resources/prompts/creation-seed-legacy-*.md copies the seed matcher reads.
const REPO_ROOT_URI = vscode.Uri.file(path.resolve(__dirname, "..", ".."));

function installRealFsBridge(): { restore: () => void } {
  const target = vscode.workspace.fs as unknown as Record<string, unknown>;
  const originals = {
    readFile: target.readFile,
    readDirectory: target.readDirectory,
    stat: target.stat,
    writeFile: target.writeFile,
  };
  target.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  target.readDirectory = async (uri: vscode.Uri): Promise<Array<[string, vscode.FileType]>> => {
    const entries = await fs.promises.readdir(uri.fsPath, { withFileTypes: true });
    return entries.map((entry) => [
      entry.name,
      entry.isDirectory() ? vscode.FileType.Directory : vscode.FileType.File,
    ]);
  };
  target.stat = async (uri: vscode.Uri): Promise<vscode.FileStat> => {
    const s = await fs.promises.stat(uri.fsPath);
    return {
      type: s.isDirectory() ? vscode.FileType.Directory : vscode.FileType.File,
      ctime: s.ctimeMs,
      mtime: s.mtimeMs,
      size: s.size,
    };
  };
  target.writeFile = (): Promise<void> => {
    throw new Error("TaskCreationStartupReconcilerV1 must never write");
  };
  return {
    restore: (): void => {
      target.readFile = originals.readFile;
      target.readDirectory = originals.readDirectory;
      target.stat = originals.stat;
      target.writeFile = originals.writeFile;
    },
  };
}

/**
 * `ensureWorkflowMetaRootV1` (behind `loadTaskCreationJournalV1`, used by the
 * reconciler's journal-preference check) requires `resolveTaskRootCandidates()`
 * to resolve to the exact meta folder under test — these mirror
 * `startNewTaskLifecycle.test.ts`'s own stubs for that same requirement. An
 * ABSOLUTE configured root sidesteps needing the stubbed workspace folder's
 * path to line up with anything; only its non-empty presence matters.
 */
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

function writeCreatingProgress(taskFolderPath: string, overrides: Record<string, unknown> = {}): void {
  fs.mkdirSync(taskFolderPath, { recursive: true });
  fs.writeFileSync(
    path.join(taskFolderPath, "task-progress.json"),
    JSON.stringify({
      taskFolder: path.basename(taskFolderPath),
      currentStage: "desc",
      status: "creating",
      createdAt: "2026-07-01T10:00:00.000Z",
      updatedAt: "2026-07-01T10:00:00.000Z",
      ...overrides,
    })
  );
}

void describe("TaskCreationStartupReconcilerV1", () => {
  void it("classifies a creating folder with no task.md as reconstructible", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-reconciler-reconstructible-"));
    const fsBridge = installRealFsBridge();
    TaskCreationStartupReconcilerV1.resetForTests();
    resetCreationSeedHistoryCacheForTests();
    try {
      writeCreatingProgress(path.join(root, "2026-01-01_task_1"));

      const footprints = await TaskCreationStartupReconcilerV1.getClassifiedFootprints(root, REPO_ROOT_URI);
      assert.equal(footprints.length, 1);
      assert.equal(footprints[0]?.footprintClass, "reconstructible");
      assert.equal(footprints[0]?.hasTaskMd, false);
      assert.equal(
        footprints[0]?.retryWithoutAdoptionEligible,
        false,
        "no §4.2 journal exists for this folder, so this reconstructible classification came from the legacy fallback, not a verified journal"
      );
    } finally {
      fsBridge.restore();
      TaskCreationStartupReconcilerV1.resetForTests();
      resetCreationSeedHistoryCacheForTests();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  void it("classifies a creating folder whose task.md is byte-exact to a legacy seed as pristine", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-reconciler-pristine-"));
    const fsBridge = installRealFsBridge();
    TaskCreationStartupReconcilerV1.resetForTests();
    resetCreationSeedHistoryCacheForTests();
    try {
      const taskFolder = path.join(root, "2026-01-01_task_1");
      writeCreatingProgress(taskFolder);
      const seedText = fs.readFileSync(
        path.join(REPO_ROOT_URI.fsPath, "resources", "prompts", "creation-seed-legacy-single-body-task.md")
      );
      fs.writeFileSync(path.join(taskFolder, "task.md"), seedText);

      const footprints = await TaskCreationStartupReconcilerV1.getClassifiedFootprints(root, REPO_ROOT_URI);
      assert.equal(footprints.length, 1);
      assert.equal(footprints[0]?.footprintClass, "pristine");
      assert.equal(footprints[0]?.matchedSeed?.seedId, "legacy-single-body-task-v0");
      assert.equal(footprints[0]?.matchedSeed?.version, "v0");
    } finally {
      fsBridge.restore();
      TaskCreationStartupReconcilerV1.resetForTests();
      resetCreationSeedHistoryCacheForTests();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  void it("classifies a creating folder whose task.md is byte-exact to the current v1 template as pristine", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-reconciler-pristine-v1-"));
    const fsBridge = installRealFsBridge();
    TaskCreationStartupReconcilerV1.resetForTests();
    resetCreationSeedHistoryCacheForTests();
    try {
      const taskFolder = path.join(root, "2026-01-01_task_1");
      writeCreatingProgress(taskFolder);
      const seedText = fs.readFileSync(
        path.join(REPO_ROOT_URI.fsPath, "resources", "prompts", "task-template.md")
      );
      fs.writeFileSync(path.join(taskFolder, "task.md"), seedText);

      const footprints = await TaskCreationStartupReconcilerV1.getClassifiedFootprints(root, REPO_ROOT_URI);
      assert.equal(footprints.length, 1);
      assert.equal(footprints[0]?.footprintClass, "pristine");
      assert.equal(footprints[0]?.matchedSeed?.version, "v1");
    } finally {
      fsBridge.restore();
      TaskCreationStartupReconcilerV1.resetForTests();
      resetCreationSeedHistoryCacheForTests();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  void it("classifies a creating folder matching the retracted, unpinnable pre-draft-cutover reconstruction as preservable, not pristine", async () => {
    // Regression coverage for dropping the fabricated `legacy-pre-draft-cutover-v0`
    // seed from the corpus (test-fixtures/creation-seeds/README.md's "Removed"
    // section): its content was never a byte-for-byte match to any real
    // historical artifact, so it must never be able to earn `pristine`
    // (and, later, Safe-Delete eligibility) again.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-reconciler-retracted-seed-"));
    const fsBridge = installRealFsBridge();
    TaskCreationStartupReconcilerV1.resetForTests();
    resetCreationSeedHistoryCacheForTests();
    try {
      const taskFolder = path.join(root, "2026-01-01_task_1");
      writeCreatingProgress(taskFolder);
      fs.writeFileSync(
        path.join(taskFolder, "task.md"),
        "# Task\n\n## Task Description\n\nBriefly describe what changes you want to be made, and then use AI to help you clarify the plan.\n\nShortcut: Apply Current Stage Action (Ctrl+Shift+Alt+I).\n\n## Draft with AI\n\n## Open Questions\n"
      );

      const footprints = await TaskCreationStartupReconcilerV1.getClassifiedFootprints(root, REPO_ROOT_URI);
      assert.equal(footprints.length, 1);
      assert.equal(footprints[0]?.footprintClass, "preservable");
      assert.equal(footprints[0]?.matchedSeed, undefined);
      assert.equal(
        fs.existsSync(path.join(REPO_ROOT_URI.fsPath, "resources", "prompts", "creation-seed-legacy-pre-draft-cutover.md")),
        false,
        "the shipped resource copy of the retracted seed must not exist"
      );
    } finally {
      fsBridge.restore();
      TaskCreationStartupReconcilerV1.resetForTests();
      resetCreationSeedHistoryCacheForTests();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  void it("classifies a creating folder with user-edited task.md as preservable", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-reconciler-preservable-"));
    const fsBridge = installRealFsBridge();
    TaskCreationStartupReconcilerV1.resetForTests();
    resetCreationSeedHistoryCacheForTests();
    try {
      const taskFolder = path.join(root, "2026-01-01_task_1");
      writeCreatingProgress(taskFolder);
      fs.writeFileSync(
        path.join(taskFolder, "task.md"),
        "# Task\n\n## Task Description\n\nActually I already started writing real notes here.\n\n## Draft with AI\n"
      );

      const footprints = await TaskCreationStartupReconcilerV1.getClassifiedFootprints(root, REPO_ROOT_URI);
      assert.equal(footprints.length, 1);
      assert.equal(footprints[0]?.footprintClass, "preservable");
      assert.equal(footprints[0]?.matchedSeed, undefined);
    } finally {
      fsBridge.restore();
      TaskCreationStartupReconcilerV1.resetForTests();
      resetCreationSeedHistoryCacheForTests();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  void it("classifies a creating folder with an unexpected extra entry as inspectionOnly", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-reconciler-inspection-extra-"));
    const fsBridge = installRealFsBridge();
    TaskCreationStartupReconcilerV1.resetForTests();
    resetCreationSeedHistoryCacheForTests();
    try {
      const taskFolder = path.join(root, "2026-01-01_task_1");
      writeCreatingProgress(taskFolder);
      fs.writeFileSync(path.join(taskFolder, "task.md"), "# Task\n");
      // plan.md should never exist alongside a genuinely stuck "creating"
      // folder — its presence means this folder is not safely reconstructible.
      fs.writeFileSync(path.join(taskFolder, "plan.md"), "# Plan\n");

      const footprints = await TaskCreationStartupReconcilerV1.getClassifiedFootprints(root, REPO_ROOT_URI);
      assert.equal(footprints.length, 1);
      assert.equal(footprints[0]?.footprintClass, "inspectionOnly");
      assert.match(footprints[0]?.inspectionReason ?? "", /unexpected additional entry/);
      assert.doesNotMatch(footprints[0]?.inspectionReason ?? "", /plan\.md/, "diagnostics must carry a count, not raw entry names");
    } finally {
      fsBridge.restore();
      TaskCreationStartupReconcilerV1.resetForTests();
      resetCreationSeedHistoryCacheForTests();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  void it("classifies a creating folder whose progress fails strict decoding as inspectionOnly when otherwise minimal", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-reconciler-inspection-invalid-"));
    const fsBridge = installRealFsBridge();
    TaskCreationStartupReconcilerV1.resetForTests();
    resetCreationSeedHistoryCacheForTests();
    try {
      const taskFolder = path.join(root, "2026-01-01_task_1");
      fs.mkdirSync(taskFolder, { recursive: true });
      // ensembleProgressVersion 2 is neither absent nor exactly 1 -> strict recovery.
      fs.writeFileSync(
        path.join(taskFolder, "task-progress.json"),
        JSON.stringify({
          taskFolder: "2026-01-01_task_1",
          currentStage: "desc",
          status: "creating",
          createdAt: "2026-07-01T10:00:00.000Z",
          updatedAt: "2026-07-01T10:00:00.000Z",
          ensembleProgressVersion: 2,
        })
      );

      const footprints = await TaskCreationStartupReconcilerV1.getClassifiedFootprints(root, REPO_ROOT_URI);
      assert.equal(footprints.length, 1);
      assert.equal(footprints[0]?.footprintClass, "inspectionOnly");
      assert.match(footprints[0]?.inspectionReason ?? "", /failed strict decoding/);
    } finally {
      fsBridge.restore();
      TaskCreationStartupReconcilerV1.resetForTests();
      resetCreationSeedHistoryCacheForTests();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  void it("skips a folder whose progress fails strict decoding but holds unrelated real-task content", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-reconciler-inspection-skip-"));
    const fsBridge = installRealFsBridge();
    TaskCreationStartupReconcilerV1.resetForTests();
    resetCreationSeedHistoryCacheForTests();
    try {
      const taskFolder = path.join(root, "2026-01-01_task_1");
      fs.mkdirSync(taskFolder, { recursive: true });
      fs.writeFileSync(
        path.join(taskFolder, "task-progress.json"),
        JSON.stringify({
          taskFolder: "2026-01-01_task_1",
          currentStage: "desc",
          status: "creating",
          createdAt: "2026-07-01T10:00:00.000Z",
          updatedAt: "2026-07-01T10:00:00.000Z",
          ensembleProgressVersion: 2,
        })
      );
      fs.writeFileSync(path.join(taskFolder, "plan.md"), "# Plan\n");

      const footprints = await TaskCreationStartupReconcilerV1.getClassifiedFootprints(root, REPO_ROOT_URI);
      assert.equal(footprints.length, 0, "a real task with unrelated content must not be misclassified as stuck creation");
    } finally {
      fsBridge.restore();
      TaskCreationStartupReconcilerV1.resetForTests();
      resetCreationSeedHistoryCacheForTests();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  void it("ignores active/paused/completed folders entirely", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-reconciler-ignore-"));
    const fsBridge = installRealFsBridge();
    TaskCreationStartupReconcilerV1.resetForTests();
    resetCreationSeedHistoryCacheForTests();
    try {
      writeCreatingProgress(path.join(root, "2026-01-01_task_1"), { status: "active" });
      writeCreatingProgress(path.join(root, "2026-01-01_task_2"), { status: "paused" });
      writeCreatingProgress(path.join(root, "2026-01-01_task_3"), { status: "completed" });

      const footprints = await TaskCreationStartupReconcilerV1.getClassifiedFootprints(root, REPO_ROOT_URI);
      assert.equal(footprints.length, 0);
    } finally {
      fsBridge.restore();
      TaskCreationStartupReconcilerV1.resetForTests();
      resetCreationSeedHistoryCacheForTests();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  void it("classifies a creating folder whose task-progress.json exists but cannot be read as a file, as inspectionOnly", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-reconciler-inspection-unreadable-"));
    const fsBridge = installRealFsBridge();
    TaskCreationStartupReconcilerV1.resetForTests();
    resetCreationSeedHistoryCacheForTests();
    try {
      const taskFolder = path.join(root, "2026-01-01_task_1");
      // A directory in place of task-progress.json: stat/readdir see it exist,
      // but reading it as a file fails (EISDIR) — this must not be treated
      // the same as "no progress file at all".
      fs.mkdirSync(path.join(taskFolder, "task-progress.json"), { recursive: true });

      const footprints = await TaskCreationStartupReconcilerV1.getClassifiedFootprints(root, REPO_ROOT_URI);
      assert.equal(footprints.length, 1);
      assert.equal(footprints[0]?.footprintClass, "inspectionOnly");
      assert.match(footprints[0]?.inspectionReason ?? "", /exists but could not be read/);
      assert.doesNotMatch(footprints[0]?.inspectionReason ?? "", new RegExp(taskFolder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    } finally {
      fsBridge.restore();
      TaskCreationStartupReconcilerV1.resetForTests();
      resetCreationSeedHistoryCacheForTests();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  void it("skips a folder whose task-progress.json cannot be read as a file but holds unrelated real-task content", async () => {
    // Mirrors "skips a folder whose progress fails strict decoding but holds
    // unrelated real-task content" above: an unreadable progress file (e.g. a
    // transient lock) must get the same "don't guess" treatment as a
    // strict-decode failure when the folder otherwise looks like a real,
    // already-in-use task rather than a stuck creation.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-reconciler-inspection-unreadable-skip-"));
    const fsBridge = installRealFsBridge();
    TaskCreationStartupReconcilerV1.resetForTests();
    resetCreationSeedHistoryCacheForTests();
    try {
      const taskFolder = path.join(root, "2026-01-01_task_1");
      // A directory in place of task-progress.json: stat/readdir see it exist,
      // but reading it as a file fails (EISDIR).
      fs.mkdirSync(path.join(taskFolder, "task-progress.json"), { recursive: true });
      fs.writeFileSync(path.join(taskFolder, "plan.md"), "# Plan\n");

      const footprints = await TaskCreationStartupReconcilerV1.getClassifiedFootprints(root, REPO_ROOT_URI);
      assert.equal(footprints.length, 0, "a real task with unrelated content must not be misclassified as stuck creation");
    } finally {
      fsBridge.restore();
      TaskCreationStartupReconcilerV1.resetForTests();
      resetCreationSeedHistoryCacheForTests();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  void it("returns no footprints for a root that does not exist yet, without throwing", async () => {
    const root = path.join(os.tmpdir(), "ensemble-reconciler-missing-" + Math.random().toString(36).slice(2));
    const fsBridge = installRealFsBridge();
    TaskCreationStartupReconcilerV1.resetForTests();
    try {
      const footprints = await TaskCreationStartupReconcilerV1.getClassifiedFootprints(root, REPO_ROOT_URI);
      assert.deepEqual(footprints, []);
    } finally {
      fsBridge.restore();
      TaskCreationStartupReconcilerV1.resetForTests();
    }
  });

  void it("getClassifiedFootprints re-scans on every call instead of serving a permanently stale cache", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-reconciler-rescan-"));
    const fsBridge = installRealFsBridge();
    TaskCreationStartupReconcilerV1.resetForTests();
    resetCreationSeedHistoryCacheForTests();
    try {
      // Nothing stuck yet — activation-time scan (or an on-demand scan) sees no footprints.
      const before = await TaskCreationStartupReconcilerV1.getClassifiedFootprints(root, REPO_ROOT_URI);
      assert.equal(before.length, 0);

      // A creation gets interrupted later in the same window's lifetime.
      writeCreatingProgress(path.join(root, "2026-02-02_task_1"));

      const after = await TaskCreationStartupReconcilerV1.getClassifiedFootprints(root, REPO_ROOT_URI);
      assert.equal(after.length, 1, "a later call must see a folder that became stuck after the first scan");
    } finally {
      fsBridge.restore();
      TaskCreationStartupReconcilerV1.resetForTests();
      resetCreationSeedHistoryCacheForTests();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  void it("blocks a caller's read until the classification pass completes (activation-order barrier)", async () => {
    TaskCreationStartupReconcilerV1.resetForTests();
    const target = vscode.workspace.fs as unknown as Record<string, unknown>;
    const originalReadDirectory = target.readDirectory;

    let releaseScan: (() => void) | undefined;
    const scanGate = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    let scanStarted = false;
    target.readDirectory = async (): Promise<Array<[string, vscode.FileType]>> => {
      scanStarted = true;
      await scanGate;
      return [];
    };

    try {
      const barrier = TaskCreationStartupReconcilerV1.beginClassification(["/fake/meta/root"], REPO_ROOT_URI);
      assert.ok(scanStarted, "beginClassification should start the scan synchronously-ish (microtask)");

      let raced = false;
      const callerRead = TaskCreationStartupReconcilerV1.waitUntilReady().then(() => {
        raced = true;
      });

      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(raced, false, "a caller must not observe readiness before classification finishes");

      releaseScan?.();
      await barrier;
      await callerRead;
      assert.equal(raced, true, "a caller must unblock once classification publishes its snapshot");
    } finally {
      target.readDirectory = originalReadDirectory;
      TaskCreationStartupReconcilerV1.resetForTests();
    }
  });

  void describe("shipped seed resources stay byte-identical to their test-fixture provenance copies", () => {
    // production cannot read test-fixtures/** (see taskCreationSeedHistoryV1.ts's
    // header), so every legacy seed ships its own resources/prompts/*.md copy.
    // Nothing else fences that pair from drifting apart — and if it did, a
    // missing/mismatched shipped resource degrades matchCreationSeedV1
    // silently (loadSeedText swallows the read failure and the folder just
    // falls through to `preservable`) rather than failing loudly. This is
    // that fence.
    const SHIPPED_TO_FIXTURE_PAIRS: ReadonlyArray<readonly [string, string]> = [
      ["creation-seed-legacy-instructions-user-description.md", "legacy-instructions-user-description-seed.md"],
      ["creation-seed-legacy-single-body-task.md", "legacy-single-body-task-seed.md"],
      ["creation-seed-legacy-early-inline-fallback.md", "legacy-early-inline-fallback-seed.md"],
      ["creation-seed-legacy-v1-bare.md", "legacy-v1-bare-seed.md"],
    ];

    for (const [resourceFileName, fixtureFileName] of SHIPPED_TO_FIXTURE_PAIRS) {
      void it(`${resourceFileName} matches ${fixtureFileName}`, () => {
        const shipped = fs.readFileSync(path.join(REPO_ROOT_URI.fsPath, "resources", "prompts", resourceFileName));
        const fixture = fs.readFileSync(path.join(REPO_ROOT_URI.fsPath, "test-fixtures", "creation-seeds", fixtureFileName));
        assert.ok(shipped.equals(fixture), `${resourceFileName} must be byte-identical to test-fixtures/creation-seeds/${fixtureFileName}`);
      });
    }

    void it("task-template.md matches v1-canonical-seed.md", () => {
      const shipped = fs.readFileSync(path.join(REPO_ROOT_URI.fsPath, "resources", "prompts", "task-template.md"));
      const fixture = fs.readFileSync(path.join(REPO_ROOT_URI.fsPath, "test-fixtures", "creation-seeds", "v1-canonical-seed.md"));
      assert.ok(shipped.equals(fixture), "task-template.md must be byte-identical to test-fixtures/creation-seeds/v1-canonical-seed.md");
    });
  });

  void describe("prefers a verified §4.2 V1 journal over the conservative §4.3 classifier", () => {
    void it("reclassifies as reconstructible when the journal's recorded entries fully account for disk, even for otherwise-preservable-looking task.md text", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-reconciler-verified-journal-"));
      const fsBridge = installRealFsBridge();
      const configStub = installConfigStub(root);
      const wsStub = installWorkspaceFoldersStub([root]);
      TaskCreationStartupReconcilerV1.resetForTests();
      resetCreationSeedHistoryCacheForTests();
      resetWorkflowRuntimeServicesForTestV1();
      try {
        const taskFolderName = "2026-01-01_task_1";
        const taskFolderPath = path.join(root, taskFolderName);

        const recorded = await recordTaskCreationIntentV1({
          metaFolderPath: root,
          taskFolderPath,
          taskFolderName,
          ownership: { metaRoot: root, projectRoot: root, workspaceRoot: root },
        });
        assert.equal(recorded.kind, "ok");
        assert.equal((await recordWorkMaterializedV1(root, taskFolderPath)).kind, "ok");

        writeCreatingProgress(taskFolderPath);
        // Without a journal, this exact text classifies as "preservable" (see
        // "classifies a creating folder with user-edited task.md as preservable"
        // above) — it matches no recorded historical seed.
        fs.writeFileSync(path.join(taskFolderPath, "task.md"), "# Task\n\n## Task Description\n\nSome unrecognized text.\n");

        const claimed = await recordFinalFolderClaimedV1(root, taskFolderPath, [
          entryForV1(taskFolderPath, "task-progress.json"),
          entryForV1(taskFolderPath, "task.md"),
        ]);
        assert.equal(claimed.kind, "ok");

        const footprints = await TaskCreationStartupReconcilerV1.getClassifiedFootprints(root, REPO_ROOT_URI);
        assert.equal(footprints.length, 1);
        assert.equal(
          footprints[0]?.footprintClass,
          "reconstructible",
          "a verified journal whose recorded content hashes match disk overrides the legacy seed-matching guess"
        );
        assert.equal(
          footprints[0]?.retryWithoutAdoptionEligible,
          true,
          "the verified-own-journal path proves every byte is extension-written, so Retry may proceed without adoption"
        );
      } finally {
        fsBridge.restore();
        configStub.restore();
        wsStub.restore();
        TaskCreationStartupReconcilerV1.resetForTests();
        resetCreationSeedHistoryCacheForTests();
        resetWorkflowRuntimeServicesForTestV1();
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    void it("falls back to the legacy classifier when task.md was edited after the journal recorded its hash (content, not just name, must match)", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-reconciler-verified-journal-edited-"));
      const fsBridge = installRealFsBridge();
      const configStub = installConfigStub(root);
      const wsStub = installWorkspaceFoldersStub([root]);
      TaskCreationStartupReconcilerV1.resetForTests();
      resetCreationSeedHistoryCacheForTests();
      resetWorkflowRuntimeServicesForTestV1();
      try {
        const taskFolderName = "2026-01-01_task_1";
        const taskFolderPath = path.join(root, taskFolderName);

        await recordTaskCreationIntentV1({
          metaFolderPath: root,
          taskFolderPath,
          taskFolderName,
          ownership: { metaRoot: root, projectRoot: root, workspaceRoot: root },
        });
        await recordWorkMaterializedV1(root, taskFolderPath);

        writeCreatingProgress(taskFolderPath);
        fs.writeFileSync(path.join(taskFolderPath, "task.md"), "# Task\n\n## Task Description\n\nOriginal extension-authored text.\n");
        await recordFinalFolderClaimedV1(root, taskFolderPath, [
          entryForV1(taskFolderPath, "task-progress.json"),
          entryForV1(taskFolderPath, "task.md"),
        ]);

        // The user edits task.md after creation -- same name, different bytes.
        // The journal still recalls the ORIGINAL hash, so it must no longer be
        // trusted for this path; classification must fall back to the legacy
        // classifier's protective `preservable` (never silently overwritable).
        fs.writeFileSync(path.join(taskFolderPath, "task.md"), "# Task\n\n## Task Description\n\nUser-edited text.\n");

        const footprints = await TaskCreationStartupReconcilerV1.getClassifiedFootprints(root, REPO_ROOT_URI);
        assert.equal(footprints.length, 1);
        assert.equal(
          footprints[0]?.footprintClass,
          "preservable",
          "a hash mismatch against the journal's recorded content must never be classified reconstructible"
        );
        assert.equal(
          footprints[0]?.retryWithoutAdoptionEligible,
          false,
          "falling back to the legacy classifier means Retry cannot proceed without adoption"
        );
      } finally {
        fsBridge.restore();
        configStub.restore();
        wsStub.restore();
        TaskCreationStartupReconcilerV1.resetForTests();
        resetCreationSeedHistoryCacheForTests();
        resetWorkflowRuntimeServicesForTestV1();
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    void it("falls back to the legacy classifier when task.md exists on disk before the journal reaches finalFolderClaimed", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-reconciler-verified-journal-premature-"));
      const fsBridge = installRealFsBridge();
      const configStub = installConfigStub(root);
      const wsStub = installWorkspaceFoldersStub([root]);
      TaskCreationStartupReconcilerV1.resetForTests();
      resetCreationSeedHistoryCacheForTests();
      resetWorkflowRuntimeServicesForTestV1();
      try {
        const taskFolderName = "2026-01-01_task_1";
        const taskFolderPath = path.join(root, taskFolderName);

        await recordTaskCreationIntentV1({
          metaFolderPath: root,
          taskFolderPath,
          taskFolderName,
          ownership: { metaRoot: root, projectRoot: root, workspaceRoot: root },
        });
        // Journal stays at workMaterialized -- it has NOT yet claimed task.md
        // exists. If task.md is nevertheless present (e.g. a crash right after
        // the real write but before the journal's finalFolderClaimed
        // transition committed), this journal cannot vouch for it.
        await recordWorkMaterializedV1(root, taskFolderPath);

        writeCreatingProgress(taskFolderPath);
        fs.writeFileSync(path.join(taskFolderPath, "task.md"), "# Task\n\n## Task Description\n\nSome unrecognized text.\n");

        const footprints = await TaskCreationStartupReconcilerV1.getClassifiedFootprints(root, REPO_ROOT_URI);
        assert.equal(footprints.length, 1);
        assert.equal(
          footprints[0]?.footprintClass,
          "preservable",
          "task.md present before the journal claims finalFolderClaimed must not be trusted as reconstructible"
        );
      } finally {
        fsBridge.restore();
        configStub.restore();
        wsStub.restore();
        TaskCreationStartupReconcilerV1.resetForTests();
        resetCreationSeedHistoryCacheForTests();
        resetWorkflowRuntimeServicesForTestV1();
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    void it("falls back to the legacy classifier when disk holds content the verified journal does not account for", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-reconciler-verified-journal-extra-"));
      const fsBridge = installRealFsBridge();
      const configStub = installConfigStub(root);
      const wsStub = installWorkspaceFoldersStub([root]);
      TaskCreationStartupReconcilerV1.resetForTests();
      resetCreationSeedHistoryCacheForTests();
      resetWorkflowRuntimeServicesForTestV1();
      try {
        const taskFolderName = "2026-01-01_task_1";
        const taskFolderPath = path.join(root, taskFolderName);

        await recordTaskCreationIntentV1({
          metaFolderPath: root,
          taskFolderPath,
          taskFolderName,
          ownership: { metaRoot: root, projectRoot: root, workspaceRoot: root },
        });
        await recordWorkMaterializedV1(root, taskFolderPath);

        writeCreatingProgress(taskFolderPath);
        fs.writeFileSync(path.join(taskFolderPath, "task.md"), "# Task\n");
        await recordFinalFolderClaimedV1(root, taskFolderPath, [
          entryForV1(taskFolderPath, "task-progress.json"),
          entryForV1(taskFolderPath, "task.md"),
        ]);
        // Content the journal never recorded — e.g. a plugin or the user
        // dropped a file into the folder mid-creation.
        fs.writeFileSync(path.join(taskFolderPath, "plan.md"), "# Plan\n");

        const footprints = await TaskCreationStartupReconcilerV1.getClassifiedFootprints(root, REPO_ROOT_URI);
        assert.equal(footprints.length, 1);
        assert.equal(
          footprints[0]?.footprintClass,
          "inspectionOnly",
          "unaccounted-for disk content must fall back to the conservative classifier rather than being trusted"
        );
      } finally {
        fsBridge.restore();
        configStub.restore();
        wsStub.restore();
        TaskCreationStartupReconcilerV1.resetForTests();
        resetCreationSeedHistoryCacheForTests();
        resetWorkflowRuntimeServicesForTestV1();
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    void it("does not trust a resolved journal found alongside an on-disk creating status", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-reconciler-verified-journal-resolved-"));
      const fsBridge = installRealFsBridge();
      const configStub = installConfigStub(root);
      const wsStub = installWorkspaceFoldersStub([root]);
      TaskCreationStartupReconcilerV1.resetForTests();
      resetCreationSeedHistoryCacheForTests();
      resetWorkflowRuntimeServicesForTestV1();
      try {
        const taskFolderName = "2026-01-01_task_1";
        const taskFolderPath = path.join(root, taskFolderName);

        await recordTaskCreationIntentV1({
          metaFolderPath: root,
          taskFolderPath,
          taskFolderName,
          ownership: { metaRoot: root, projectRoot: root, workspaceRoot: root },
        });
        await recordWorkMaterializedV1(root, taskFolderPath);
        // commitCreationSentinelV1 requires an ownership-backed task-folder
        // root (plan §3.9) — unlike the other "creating" fixtures in this
        // file, this one needs a real `ownership` record.
        writeCreatingProgress(taskFolderPath, {
          ownership: { metaRoot: root, projectRoot: root, boundAt: "2026-01-01T00:00:00.000Z", state: "resolved" },
        });
        fs.writeFileSync(path.join(taskFolderPath, "task.md"), "# Task\n");
        await recordFinalFolderClaimedV1(root, taskFolderPath, [
          entryForV1(taskFolderPath, "task-progress.json"),
          entryForV1(taskFolderPath, "task.md"),
        ]);
        const sentinelCommit = await commitCreationSentinelV1(root, taskFolderPath);
        assert.equal(sentinelCommit.kind, "ok");
        assert.equal((await recordProgressCommittedV1(root, taskFolderPath)).kind, "ok");
        // The real task-progress.json is deliberately left at "creating" —
        // this store's own transitions never touch it — simulating the
        // anomaly of a resolved journal whose folder still shows "creating".
        assert.equal((await resolveTaskCreationV1(root, taskFolderPath)).kind, "ok");

        const footprints = await TaskCreationStartupReconcilerV1.getClassifiedFootprints(root, REPO_ROOT_URI);
        assert.equal(footprints.length, 1);
        assert.notEqual(
          footprints[0]?.footprintClass,
          "reconstructible",
          "a resolved journal must never be trusted merely because the folder still shows status: creating"
        );
      } finally {
        fsBridge.restore();
        configStub.restore();
        wsStub.restore();
        TaskCreationStartupReconcilerV1.resetForTests();
        resetCreationSeedHistoryCacheForTests();
        resetWorkflowRuntimeServicesForTestV1();
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  void it("fires onDidChange after publishing a classification snapshot", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-reconciler-change-event-"));
    const fsBridge = installRealFsBridge();
    TaskCreationStartupReconcilerV1.resetForTests();
    resetCreationSeedHistoryCacheForTests();
    try {
      let fired = 0;
      const subscription = TaskCreationStartupReconcilerV1.onDidChange(() => {
        fired += 1;
      });
      await TaskCreationStartupReconcilerV1.getClassifiedFootprints(root, REPO_ROOT_URI);
      assert.ok(fired >= 1);
      subscription.dispose();
    } finally {
      fsBridge.restore();
      TaskCreationStartupReconcilerV1.resetForTests();
      resetCreationSeedHistoryCacheForTests();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
