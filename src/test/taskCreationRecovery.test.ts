/**
 * Coverage for the plan §4.5 Retry/Open recovery commands
 * (commands/taskCreationRecovery.ts): Retry only proceeds for a
 * `retryWithoutAdoptionEligible` footprint (the verified-own-journal branch —
 * see taskCreationStartupReconcilerV1.test.ts's "prefers a verified §4.2 V1
 * journal" suite), always reclassifies immediately before writing, and never
 * overwrites a folder that no longer qualifies.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import {
  adoptAndRetryTaskCreation,
  openFailedTaskCreation,
  resumeStrandedTaskDeletionsV1,
  retryTaskCreation,
  safeDeleteFailedTaskCreation,
} from "../commands/taskCreationRecovery";
import { TaskInventory } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { TaskProgress } from "../types/taskProgress";
import { normalizePath } from "../utils/taskRoot";
import {
  deactivateNotificationRouter,
  initNotificationRouter,
  StatusSurface,
} from "../utils/notificationRouter";
import { TaskCreationStartupReconcilerV1 } from "../state/taskCreationStartupReconcilerV1";
import { resetWorkflowRuntimeServicesForTestV1 } from "../services/workflowRuntimeServicesV1";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import { offerActionInChatV1 } from "../utils/chatActionOfferV1";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import {
  loadTaskCreationJournalV1,
  recordFinalFolderClaimedV1,
  recordTaskCreationIntentV1,
  recordWorkMaterializedV1,
} from "../services/taskCreationIntentStoreV1";
import {
  listStrandedTaskDeletionJournalsV1,
  loadTaskDeletionJournalV1,
  recordFolderRemovedV1,
  recordTaskDeletionRequestedV1,
} from "../services/taskDeletionIntentStoreV1";
import { fileCreationIntentEntryV1 } from "../types/taskCreationIntentV1";
import { allocateHex128IdV1 } from "../types/actionCorrelationV1";
import { safeRemoveDir } from "./testFsUtils";

function installConfigStub(configuredTaskRoot: string): { restore: () => void } {
  const original = (vscode.workspace as unknown as Record<string, unknown>).getConfiguration;
  (vscode.workspace as unknown as Record<string, unknown>).getConfiguration = (): {
    get: (key: string, defaultValue?: unknown) => unknown;
    update: () => Promise<void>;
    inspect: () => undefined;
  } => ({
    get: (key: string, defaultValue?: unknown): unknown =>
      key === "metaResourcesPath" ? configuredTaskRoot : defaultValue,
    update: async (): Promise<void> => {},
    inspect: () => undefined,
  });
  return {
    restore: (): void => {
      (vscode.workspace as unknown as Record<string, unknown>).getConfiguration = original;
    },
  };
}

function installWorkspaceFoldersStub(roots: readonly string[]): { restore: () => void } {
  const target = vscode.workspace as unknown as Record<string, unknown>;
  const orig = target.workspaceFolders;
  target.workspaceFolders = roots.map((root, index) => ({
    uri: vscode.Uri.file(root),
    name: path.basename(root),
    index,
  }));
  return { restore: (): void => { target.workspaceFolders = orig; } };
}

function installRealFsBridge(): { restore: () => void } {
  const target = vscode.workspace.fs as unknown as Record<string, unknown>;
  const originals = {
    readFile: target.readFile,
    writeFile: target.writeFile,
    createDirectory: target.createDirectory,
    readDirectory: target.readDirectory,
    stat: target.stat,
    delete: target.delete,
  };
  target.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  target.writeFile = (uri: vscode.Uri, data: Uint8Array): Promise<void> =>
    fs.promises.writeFile(uri.fsPath, data);
  target.createDirectory = (uri: vscode.Uri): Promise<void> =>
    fs.promises.mkdir(uri.fsPath, { recursive: true }).then(() => undefined);
  target.readDirectory = async (uri: vscode.Uri): Promise<Array<[string, vscode.FileType]>> => {
    const entries = await fs.promises.readdir(uri.fsPath, { withFileTypes: true });
    return entries.map((entry) => [
      entry.name,
      entry.isDirectory() ? vscode.FileType.Directory : vscode.FileType.File,
    ]);
  };
  target.stat = (uri: vscode.Uri): Promise<vscode.FileStat> =>
    fs.promises.stat(uri.fsPath).then((s) => ({
      type: s.isDirectory() ? vscode.FileType.Directory : vscode.FileType.File,
      ctime: s.ctimeMs,
      mtime: s.mtimeMs,
      size: s.size,
    }));
  target.delete = async (uri: vscode.Uri, options?: { recursive?: boolean }): Promise<void> => {
    const s = await fs.promises.stat(uri.fsPath);
    if (s.isDirectory()) {
      await fs.promises.rmdir(uri.fsPath, { recursive: options?.recursive === true });
    } else {
      await fs.promises.unlink(uri.fsPath);
    }
  };
  return {
    restore: (): void => {
      target.readFile = originals.readFile;
      target.writeFile = originals.writeFile;
      target.createDirectory = originals.createDirectory;
      target.readDirectory = originals.readDirectory;
      target.stat = originals.stat;
      target.delete = originals.delete;
    },
  };
}

function makeMemento(): vscode.Memento {
  const store = new Map<string, unknown>();
  return {
    get: <T>(key: string, defaultValue?: T): T => (store.has(key) ? (store.get(key) as T) : (defaultValue as T)),
    update: (key: string, value: unknown): Promise<void> => {
      if (value === undefined) store.delete(key);
      else store.set(key, value);
      return Promise.resolve();
    },
    keys: (): readonly string[] => [...store.keys()],
  } as unknown as vscode.Memento;
}

function fakeInventory(): TaskInventory {
  return { refresh: () => Promise.resolve(undefined) } as unknown as TaskInventory;
}

function readProgress(taskFolderPath: string): TaskProgress {
  const raw = fs.readFileSync(path.join(taskFolderPath, "task-progress.json"), "utf8");
  return JSON.parse(raw) as TaskProgress;
}

function writeCreatingProgress(
  taskFolderPath: string,
  ownership?: { metaRoot: string; projectRoot: string; workspaceRoot: string }
): void {
  fs.mkdirSync(taskFolderPath, { recursive: true });
  const progress: TaskProgress = {
    taskFolder: path.basename(taskFolderPath),
    currentStage: "desc",
    status: "creating",
    createdAt: "2026-07-01T10:00:00.000Z",
    updatedAt: "2026-07-01T10:00:00.000Z",
    ...(ownership
      ? { ownership: { ...ownership, boundAt: "2026-07-01T10:00:00.000Z", state: "resolved" as const } }
      : {}),
  };
  fs.writeFileSync(path.join(taskFolderPath, "task-progress.json"), JSON.stringify(progress, null, 2));
}

function writeActiveTask(taskFolderPath: string): void {
  fs.mkdirSync(taskFolderPath, { recursive: true });
  const progress: TaskProgress = {
    taskFolder: path.basename(taskFolderPath),
    displayName: "Existing active task",
    currentStage: "impl",
    status: "active",
    createdAt: "2026-07-01T10:00:00.000Z",
    updatedAt: "2026-07-01T10:00:00.000Z",
  };
  fs.writeFileSync(path.join(taskFolderPath, "task-progress.json"), JSON.stringify(progress, null, 2));
}

async function assertPausedResumeDecisionAndUpdateDuplicate(
  harness: Harness,
  taskFolderPath: string,
  taskFolderName: string,
  noticeText: string
): Promise<void> {
  const store = new WorkflowDecisionStoreV1(harness.memento);
  const decision = store.listPending(taskFolderPath).find((item) => item.decisionKey === "chatActionOffer:resumeTask");
  assert.ok(decision, "a paused recovery must offer Resume in task chat");
  assert.equal(decision.whatHappened, noticeText);
  assert.deepEqual(decision.options.map((option) => option.label), ["Resume", "Not now"]);
  assert.equal(decision.recommendation.kind === "option" ? decision.recommendation.optionId : undefined, "runAction");
  assert.equal(decision.gating?.holdsTaskPaused, true, "the task remains paused until Resume is chosen");
  assert.deepEqual(decision.options[0]?.effect, {
    kind: "command",
    command: "vs-code-ai-helper.resumeTask",
    args: [{ taskFolderPath }],
  });

  await offerActionInChatV1({
    taskFolderPath,
    taskLabel: taskFolderName,
    actionLabel: "Resume",
    command: "vs-code-ai-helper.resumeTask",
    args: [{ taskFolderPath }],
    noticeText,
    holdsTaskPaused: true,
  });
  assert.equal(
    store.listPending(taskFolderPath).filter((item) => item.decisionKey === "chatActionOffer:resumeTask").length,
    1,
    "repeated paused-recovery reporting updates the existing Resume card"
  );
}

async function assertActiveDraftDecisionAndUpdateDuplicate(
  harness: Harness,
  taskFolderPath: string,
  taskFolderName: string,
  noticeText: string
): Promise<void> {
  const store = new WorkflowDecisionStoreV1(harness.memento);
  const decision = store.listPending(taskFolderPath).find((item) => item.decisionKey === "chatActionOffer:draftTaskWithAI");
  assert.ok(decision, "an active recovery must offer Draft with AI in task chat");
  assert.equal(decision.whatHappened, noticeText);
  assert.deepEqual(decision.options.map((option) => option.label), ["Draft with AI", "Not now"]);
  assert.equal(decision.recommendation.kind === "option" ? decision.recommendation.optionId : undefined, "runAction");
  assert.deepEqual(decision.options[0]?.effect, {
    kind: "command",
    command: "vs-code-ai-helper.draftTaskWithAI",
    args: [{ taskFolderPath }],
  });

  await offerActionInChatV1({
    taskFolderPath,
    taskLabel: taskFolderName,
    actionLabel: "Draft with AI",
    command: "vs-code-ai-helper.draftTaskWithAI",
    args: [{ taskFolderPath }],
    noticeText,
    optional: true,
  });
  assert.equal(
    store.listPending(taskFolderPath).filter((item) => item.decisionKey === "chatActionOffer:draftTaskWithAI").length,
    1,
    "repeated active-recovery reporting updates the existing Draft with AI card"
  );
}

interface Harness {
  workspaceRoot: string;
  metaFolderPath: string;
  inventory: TaskInventory;
  currentTaskStore: CurrentTaskStore;
  entries: Array<{ message: string; level: string; filePath?: string }>;
  memento: vscode.Memento;
  restore(): void;
}

function installHarness(): Harness {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-creation-recovery-"));
  const metaFolderPath = path.join(workspaceRoot, ".ensemble");
  fs.mkdirSync(metaFolderPath, { recursive: true });
  const configStub = installConfigStub(".ensemble");
  const wsStub = installWorkspaceFoldersStub([workspaceRoot]);
  const fsBridge = installRealFsBridge();
  const currentTaskStore = new CurrentTaskStore(makeMemento());
  const decisionMemento = makeMemento();
  __extensionContextV1TestOnly.set({
    subscriptions: [],
    extensionUri: vscode.Uri.file(workspaceRoot),
    workspaceState: decisionMemento,
    globalState: decisionMemento,
  } as unknown as vscode.ExtensionContext);
  const windowTarget = vscode.window as unknown as Record<string, unknown>;
  const originalShowWarningMessage = windowTarget.showWarningMessage;
  const originalExecuteCommand = (vscode.commands as unknown as Record<string, unknown>).executeCommand;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const chatChoiceModule = require("../utils/chatChoiceV1") as Record<string, unknown>;
  const originalAskChatChoiceV1 = chatChoiceModule.askChatChoiceV1;
  // Simulates the user clicking the confirmation's primary action option
  // (e.g. "Retry", "Adopt and Retry", "Delete"), echoing it back without
  // hardcoding a label.
  windowTarget.showWarningMessage = (...args: unknown[]): Promise<string | undefined> =>
    Promise.resolve(typeof args[args.length - 1] === "string" ? (args[args.length - 1] as string) : undefined);
  chatChoiceModule.askChatChoiceV1 = (input: { options: ReadonlyArray<{ optionId?: string; value?: unknown }> }): Promise<unknown> =>
    Promise.resolve(input.options[0]?.value ?? input.options[0]?.optionId);
  (vscode.commands as unknown as Record<string, unknown>).executeCommand = (): Promise<void> => Promise.resolve();
  TaskCreationStartupReconcilerV1.resetForTests();
  resetWorkflowRuntimeServicesForTestV1();

  const entries: Array<{ message: string; level: string; filePath?: string }> = [];
  const capturingSurface: StatusSurface = {
    addEntry(message, level, filePath): void {
      entries.push({ message, level, filePath });
    },
  };
  initNotificationRouter(capturingSurface);

  return {
    workspaceRoot,
    metaFolderPath,
    inventory: fakeInventory(),
    currentTaskStore,
    entries,
    memento: decisionMemento,
    restore(): void {
      configStub.restore();
      wsStub.restore();
      fsBridge.restore();
      windowTarget.showWarningMessage = originalShowWarningMessage;
      chatChoiceModule.askChatChoiceV1 = originalAskChatChoiceV1;
      (vscode.commands as unknown as Record<string, unknown>).executeCommand = originalExecuteCommand;
      deactivateNotificationRouter();
      __extensionContextV1TestOnly.reset();
      TaskCreationStartupReconcilerV1.resetForTests();
      resetWorkflowRuntimeServicesForTestV1();
      safeRemoveDir(workspaceRoot);
    },
  };
}

void describe("retryTaskCreation", () => {
  void it("resumes a journal-verified reconstructible folder: writes task.md, commits the sentinel, and activates the task", async () => {
    const harness = installHarness();
    try {
      const taskFolderName = "2026-01-01_task_1";
      const taskFolderPath = path.join(harness.metaFolderPath, taskFolderName);

      // Establish a §4.2 journal that has verified nothing but this
      // extension's own writes exist (no task.md yet — workMaterialized).
      const recorded = await recordTaskCreationIntentV1({
        metaFolderPath: harness.metaFolderPath,
        taskFolderPath,
        taskFolderName,
        ownership: {
          metaRoot: harness.metaFolderPath,
          projectRoot: harness.workspaceRoot,
          workspaceRoot: harness.workspaceRoot,
        },
      });
      assert.equal(recorded.kind, "ok");
      assert.equal((await recordWorkMaterializedV1(harness.metaFolderPath, taskFolderPath)).kind, "ok");
      writeCreatingProgress(taskFolderPath);

      const ok = await retryTaskCreation(
        harness.inventory,
        vscode.Uri.file(harness.workspaceRoot),
        harness.currentTaskStore,
        undefined,
        { task: { folderUri: vscode.Uri.file(taskFolderPath), folderName: taskFolderName, progress: readProgress(taskFolderPath) } }
      );
      assert.equal(ok, true, "retry should succeed for a journal-verified reconstructible folder");

      assert.ok(fs.existsSync(path.join(taskFolderPath, "task.md")), "task.md must be written");
      assert.ok(
        fs.existsSync(path.join(taskFolderPath, ".ensemble-creation-sentinel-v1.json")),
        "the creation sentinel must be committed"
      );
      const progress = readProgress(taskFolderPath);
      assert.equal(progress.status, "active", "the resumed task must become active (nothing else is active)");
      assert.equal(
        harness.currentTaskStore.get(),
        normalizePath(taskFolderPath),
        "an activated retry must become the current task"
      );
      assert.match(harness.entries.at(-1)?.message ?? "", /creation resumed and set as the active task/);
      const decision = new WorkflowDecisionStoreV1(harness.memento).listPending(taskFolderPath)
        .find((item) => item.decisionKey === "chatActionOffer:draftTaskWithAI");
      assert.ok(decision, "the successful recovery must render its next action in task chat");
      assert.match(decision.whatHappened, /creation resumed and set as the active task/);
      assert.deepEqual(decision.options.map((option) => option.label), ["Draft with AI", "Not now"]);
      assert.equal(decision.recommendation.kind === "option" ? decision.recommendation.optionId : undefined, "runAction");
      assert.deepEqual(decision.options[0]?.effect, {
        kind: "command",
        command: "vs-code-ai-helper.draftTaskWithAI",
        args: [{ taskFolderPath }],
      });
      await assertActiveDraftDecisionAndUpdateDuplicate(
        harness,
        taskFolderPath,
        taskFolderName,
        `${taskFolderName} creation resumed and set as the active task. Choose Draft with AI in Chat to continue.`
      );
    } finally {
      harness.restore();
    }
  });

  void it("keeps a retried task paused behind the active task and offers one actionable Resume card", async () => {
    const harness = installHarness();
    try {
      const taskFolderName = "2026-01-01_task_1";
      const taskFolderPath = path.join(harness.metaFolderPath, taskFolderName);
      writeActiveTask(path.join(harness.metaFolderPath, "2026-01-01_task_0"));
      const recorded = await recordTaskCreationIntentV1({
        metaFolderPath: harness.metaFolderPath,
        taskFolderPath,
        taskFolderName,
        ownership: defaultOwnership(harness),
      });
      assert.equal(recorded.kind, "ok");
      assert.equal((await recordWorkMaterializedV1(harness.metaFolderPath, taskFolderPath)).kind, "ok");
      writeCreatingProgress(taskFolderPath);

      const ok = await retryTaskCreation(
        harness.inventory,
        vscode.Uri.file(harness.workspaceRoot),
        harness.currentTaskStore,
        undefined,
        { task: { folderUri: vscode.Uri.file(taskFolderPath), folderName: taskFolderName, progress: readProgress(taskFolderPath) } }
      );
      assert.equal(ok, true);
      assert.equal(readProgress(taskFolderPath).status, "paused");
      assert.equal(harness.currentTaskStore.get(), undefined, "retry must not replace the current active task");
      assert.match(harness.entries.at(-1)?.message ?? "", /Task creation resumed in paused state/);
      await assertPausedResumeDecisionAndUpdateDuplicate(
        harness,
        taskFolderPath,
        taskFolderName,
        "Task creation resumed in paused state."
      );
    } finally {
      harness.restore();
    }
  });

  void it("refuses to retry (and does not write task.md) when the folder is not journal-verified", async () => {
    const harness = installHarness();
    try {
      const taskFolderName = "2026-01-01_task_1";
      const taskFolderPath = path.join(harness.metaFolderPath, taskFolderName);
      // No §4.2 journal at all -- classification falls back to the legacy
      // classifier, which is never retryWithoutAdoptionEligible.
      writeCreatingProgress(taskFolderPath);

      const ok = await retryTaskCreation(
        harness.inventory,
        vscode.Uri.file(harness.workspaceRoot),
        harness.currentTaskStore,
        undefined,
        { task: { folderUri: vscode.Uri.file(taskFolderPath), folderName: taskFolderName, progress: readProgress(taskFolderPath) } }
      );
      assert.equal(ok, false, "retry must refuse a non-journal-verified folder");
      assert.equal(fs.existsSync(path.join(taskFolderPath, "task.md")), false, "task.md must not be written");

      const progress = readProgress(taskFolderPath);
      assert.equal(progress.status, "creating", "the folder's status must be left exactly as found");
    } finally {
      harness.restore();
    }
  });

  void it("resumes a journal-verified folder that already has a hash-verified task.md WITHOUT overwriting it", async () => {
    const harness = installHarness();
    try {
      const taskFolderName = "2026-01-01_task_1";
      const taskFolderPath = path.join(harness.metaFolderPath, taskFolderName);

      const recorded = await recordTaskCreationIntentV1({
        metaFolderPath: harness.metaFolderPath,
        taskFolderPath,
        taskFolderName,
        ownership: {
          metaRoot: harness.metaFolderPath,
          projectRoot: harness.workspaceRoot,
          workspaceRoot: harness.workspaceRoot,
        },
      });
      assert.equal(recorded.kind, "ok");
      assert.equal((await recordWorkMaterializedV1(harness.metaFolderPath, taskFolderPath)).kind, "ok");
      writeCreatingProgress(taskFolderPath);

      // Simulates a crash between finalFolderClaimed and resolveTaskCreationV1:
      // task.md was already written and the journal has hash-verified it, but
      // the folder is still "creating". "Never overwrites an existing entry"
      // (plan §4.5) means retryTaskCreation must complete the remaining
      // journal steps without touching this already-verified content.
      fs.writeFileSync(path.join(taskFolderPath, "task.md"), "# Task\n\n## Task Description\n\nAlready written by the interrupted run.\n");
      const claimed = await recordFinalFolderClaimedV1(harness.metaFolderPath, taskFolderPath, [
        fileCreationIntentEntryV1("task.md", "createdV1", fs.readFileSync(path.join(taskFolderPath, "task.md"))),
        fileCreationIntentEntryV1(
          "task-progress.json",
          "createdV1",
          fs.readFileSync(path.join(taskFolderPath, "task-progress.json"))
        ),
      ]);
      assert.equal(claimed.kind, "ok");

      const beforeText = fs.readFileSync(path.join(taskFolderPath, "task.md"), "utf8");

      const ok = await retryTaskCreation(
        harness.inventory,
        vscode.Uri.file(harness.workspaceRoot),
        harness.currentTaskStore,
        undefined,
        { task: { folderUri: vscode.Uri.file(taskFolderPath), folderName: taskFolderName, progress: readProgress(taskFolderPath) } }
      );
      assert.equal(ok, true, "retry should complete the remaining journal steps for an already hash-verified folder");
      assert.equal(
        fs.readFileSync(path.join(taskFolderPath, "task.md"), "utf8"),
        beforeText,
        "an already hash-verified task.md must never be overwritten"
      );
      assert.equal(readProgress(taskFolderPath).status, "active");
    } finally {
      harness.restore();
    }
  });
});

void describe("openFailedTaskCreation", () => {
  void it("does not throw and does not mutate the folder when task.md is absent", async () => {
    const harness = installHarness();
    try {
      const taskFolderName = "2026-01-01_task_1";
      const taskFolderPath = path.join(harness.metaFolderPath, taskFolderName);
      writeCreatingProgress(taskFolderPath);

      await openFailedTaskCreation({
        task: { folderUri: vscode.Uri.file(taskFolderPath), folderName: taskFolderName, progress: readProgress(taskFolderPath) },
      });

      assert.equal(fs.existsSync(path.join(taskFolderPath, "task.md")), false, "Open must never create task.md");
      const progress = readProgress(taskFolderPath);
      assert.equal(progress.status, "creating", "Open must never change progress status");
    } finally {
      harness.restore();
    }
  });
});

/** A task.md body guaranteed to match no recorded historical seed (plan §4.3's "preservable" predicate). */
const PRESERVABLE_TASK_MD =
  "# Task\n\n## Task Description\n\nSome user-authored notes that match no recorded creation seed.\n";

function defaultOwnership(harness: Harness): { metaRoot: string; projectRoot: string; workspaceRoot: string } {
  return { metaRoot: harness.metaFolderPath, projectRoot: harness.workspaceRoot, workspaceRoot: harness.workspaceRoot };
}

void describe("adoptAndRetryTaskCreation", () => {
  void it("preserves an existing user-edited task.md exactly and activates the task", async () => {
    const harness = installHarness();
    try {
      const taskFolderName = "2026-01-01_task_1";
      const taskFolderPath = path.join(harness.metaFolderPath, taskFolderName);
      writeCreatingProgress(taskFolderPath, defaultOwnership(harness));
      fs.writeFileSync(path.join(taskFolderPath, "task.md"), PRESERVABLE_TASK_MD);

      const ok = await adoptAndRetryTaskCreation(
        harness.inventory,
        vscode.Uri.file(harness.workspaceRoot),
        harness.currentTaskStore,
        undefined,
        { task: { folderUri: vscode.Uri.file(taskFolderPath), folderName: taskFolderName, progress: readProgress(taskFolderPath) } }
      );
      assert.equal(ok, true, "adopt-and-retry should succeed for a preservable folder");

      assert.equal(
        fs.readFileSync(path.join(taskFolderPath, "task.md"), "utf8"),
        PRESERVABLE_TASK_MD,
        "task.md must be preserved byte-for-byte"
      );
      assert.ok(
        fs.existsSync(path.join(taskFolderPath, ".ensemble-creation-sentinel-v1.json")),
        "the adoption sentinel must be committed"
      );
      const progress = readProgress(taskFolderPath);
      assert.equal(progress.status, "active");
      assert.equal(harness.currentTaskStore.get(), normalizePath(taskFolderPath));
      assert.match(harness.entries.at(-1)?.message ?? "", /creation resumed \(task\.md preserved\) and set as the active task/);
      const decision = new WorkflowDecisionStoreV1(harness.memento).listPending(taskFolderPath)
        .find((item) => item.decisionKey === "chatActionOffer:draftTaskWithAI");
      assert.ok(decision, "the adopted recovery must render its next action in task chat");
      assert.match(decision.whatHappened, /task\.md preserved/);
      assert.deepEqual(decision.options.map((option) => option.label), ["Draft with AI", "Not now"]);
      assert.equal(decision.recommendation.kind === "option" ? decision.recommendation.optionId : undefined, "runAction");
      assert.deepEqual(decision.options[0]?.effect, {
        kind: "command",
        command: "vs-code-ai-helper.draftTaskWithAI",
        args: [{ taskFolderPath }],
      });
      await assertActiveDraftDecisionAndUpdateDuplicate(
        harness,
        taskFolderPath,
        taskFolderName,
        `${taskFolderName} creation resumed (task.md preserved) and set as the active task. Choose Draft with AI in Chat to continue.`
      );
    } finally {
      harness.restore();
    }
  });

  void it("keeps an adopted task paused behind the active task and offers one actionable Resume card", async () => {
    const harness = installHarness();
    try {
      const taskFolderName = "2026-01-01_task_1";
      const taskFolderPath = path.join(harness.metaFolderPath, taskFolderName);
      writeActiveTask(path.join(harness.metaFolderPath, "2026-01-01_task_0"));
      writeCreatingProgress(taskFolderPath, defaultOwnership(harness));
      fs.writeFileSync(path.join(taskFolderPath, "task.md"), PRESERVABLE_TASK_MD);

      const ok = await adoptAndRetryTaskCreation(
        harness.inventory,
        vscode.Uri.file(harness.workspaceRoot),
        harness.currentTaskStore,
        undefined,
        { task: { folderUri: vscode.Uri.file(taskFolderPath), folderName: taskFolderName, progress: readProgress(taskFolderPath) } }
      );
      assert.equal(ok, true);
      assert.equal(readProgress(taskFolderPath).status, "paused");
      assert.equal(harness.currentTaskStore.get(), undefined, "adoption must not replace the current active task");
      assert.match(harness.entries.at(-1)?.message ?? "", /Task creation resumed in paused state; task\.md preserved/);
      await assertPausedResumeDecisionAndUpdateDuplicate(
        harness,
        taskFolderPath,
        taskFolderName,
        "Task creation resumed in paused state; task.md preserved."
      );
    } finally {
      harness.restore();
    }
  });

  void it("refuses when the folder is not preservable (e.g. no task.md at all)", async () => {
    const harness = installHarness();
    try {
      const taskFolderName = "2026-01-01_task_1";
      const taskFolderPath = path.join(harness.metaFolderPath, taskFolderName);
      writeCreatingProgress(taskFolderPath, defaultOwnership(harness));

      const ok = await adoptAndRetryTaskCreation(
        harness.inventory,
        vscode.Uri.file(harness.workspaceRoot),
        harness.currentTaskStore,
        undefined,
        { task: { folderUri: vscode.Uri.file(taskFolderPath), folderName: taskFolderName, progress: readProgress(taskFolderPath) } }
      );
      assert.equal(ok, false, "adopt-and-retry must refuse a non-preservable folder");
      assert.equal(readProgress(taskFolderPath).status, "creating");
    } finally {
      harness.restore();
    }
  });
});

void describe("safeDeleteFailedTaskCreation", () => {
  void it("permanently removes a journal-verified (v1Recoverable) folder and clears the current-task checkpoint", async () => {
    const harness = installHarness();
    try {
      const taskFolderName = "2026-01-01_task_1";
      const taskFolderPath = path.join(harness.metaFolderPath, taskFolderName);

      const recorded = await recordTaskCreationIntentV1({
        metaFolderPath: harness.metaFolderPath,
        taskFolderPath,
        taskFolderName,
        ownership: {
          metaRoot: harness.metaFolderPath,
          projectRoot: harness.workspaceRoot,
          workspaceRoot: harness.workspaceRoot,
        },
      });
      assert.equal(recorded.kind, "ok");
      assert.equal((await recordWorkMaterializedV1(harness.metaFolderPath, taskFolderPath)).kind, "ok");
      writeCreatingProgress(taskFolderPath, defaultOwnership(harness));
      await harness.currentTaskStore.set(normalizePath(taskFolderPath));

      const ok = await safeDeleteFailedTaskCreation(
        harness.inventory,
        vscode.Uri.file(harness.workspaceRoot),
        harness.currentTaskStore,
        { task: { folderUri: vscode.Uri.file(taskFolderPath), folderName: taskFolderName, progress: readProgress(taskFolderPath) } }
      );
      assert.equal(ok, true, "safe delete should succeed for a journal-verified folder");

      assert.equal(fs.existsSync(taskFolderPath), false, "the task folder itself must be removed");
      assert.equal(
        harness.currentTaskStore.get(),
        undefined,
        "the current-task checkpoint must be cleared once it identified the deleted folder"
      );
    } finally {
      harness.restore();
    }
  });

  void it("adopts-for-deletion and removes a preservable folder, including its user-edited task.md", async () => {
    const harness = installHarness();
    try {
      const taskFolderName = "2026-01-01_task_1";
      const taskFolderPath = path.join(harness.metaFolderPath, taskFolderName);
      writeCreatingProgress(taskFolderPath, defaultOwnership(harness));
      fs.writeFileSync(path.join(taskFolderPath, "task.md"), PRESERVABLE_TASK_MD);

      const ok = await safeDeleteFailedTaskCreation(
        harness.inventory,
        vscode.Uri.file(harness.workspaceRoot),
        harness.currentTaskStore,
        { task: { folderUri: vscode.Uri.file(taskFolderPath), folderName: taskFolderName, progress: readProgress(taskFolderPath) } }
      );
      assert.equal(ok, true, "safe delete should succeed for a preservable folder via adoption-for-deletion");
      assert.equal(fs.existsSync(taskFolderPath), false, "the task folder itself must be removed");
    } finally {
      harness.restore();
    }
  });

  void it("refuses and touches nothing for an inspectionOnly folder", async () => {
    const harness = installHarness();
    try {
      const taskFolderName = "2026-01-01_task_1";
      const taskFolderPath = path.join(harness.metaFolderPath, taskFolderName);
      writeCreatingProgress(taskFolderPath, defaultOwnership(harness));
      // An unexpected extra entry forces inspectionOnly classification.
      fs.writeFileSync(path.join(taskFolderPath, "mystery.txt"), "unexpected");

      const ok = await safeDeleteFailedTaskCreation(
        harness.inventory,
        vscode.Uri.file(harness.workspaceRoot),
        harness.currentTaskStore,
        { task: { folderUri: vscode.Uri.file(taskFolderPath), folderName: taskFolderName, progress: readProgress(taskFolderPath) } }
      );
      assert.equal(ok, false, "safe delete must refuse an inspectionOnly folder");
      assert.equal(fs.existsSync(taskFolderPath), true, "the folder must be left untouched");
      assert.equal(fs.existsSync(path.join(taskFolderPath, "mystery.txt")), true);
    } finally {
      harness.restore();
    }
  });
});

void describe("resumeStrandedTaskDeletionsV1", () => {
  void it(
    "resumes a deletion journal stuck at folderRemoved after a crash: settles externalStateResolved, " +
      "marks the source creation journal resolvedDeleted, and clears a matching checkpoint — without recreating the folder",
    async () => {
      const harness = installHarness();
      try {
        const taskFolderName = "2026-01-01_task_1";
        const taskFolderPath = path.join(harness.metaFolderPath, taskFolderName);
        const ownership = defaultOwnership(harness);

        const recorded = await recordTaskCreationIntentV1({
          metaFolderPath: harness.metaFolderPath,
          taskFolderPath,
          taskFolderName,
          ownership,
        });
        assert.equal(recorded.kind, "ok");
        assert.equal((await recordWorkMaterializedV1(harness.metaFolderPath, taskFolderPath)).kind, "ok");
        writeCreatingProgress(taskFolderPath, ownership);
        await harness.currentTaskStore.set(normalizePath(taskFolderPath));

        // Simulate Safe Delete having journaled deleteRequested and
        // physically removed the folder, then crashing BEFORE
        // externalStateResolved (plan §4.6's forward-only tail; AC-CREATE-
        // DELETE-02: "a crash after folder removal must resume cleanup").
        const progressBytes = fs.readFileSync(path.join(taskFolderPath, "task-progress.json"));
        const requested = await recordTaskDeletionRequestedV1({
          metaFolderPath: harness.metaFolderPath,
          taskFolderPath,
          taskFolderName,
          ownership,
          sourceIntentIds: [recorded.kind === "ok" ? recorded.intent.intentId : ""],
          confirmationReceiptId: allocateHex128IdV1(),
          entries: [fileCreationIntentEntryV1("task-progress.json", "createdV1", progressBytes)],
          currentTaskCheckpointObserved: true,
        });
        assert.equal(requested.kind, "ok");
        safeRemoveDir(taskFolderPath);
        const folderRemoved = await recordFolderRemovedV1(harness.metaFolderPath, taskFolderPath);
        assert.equal(folderRemoved.kind, "ok");

        // Precondition: the independent, path-free sweep finds exactly this
        // stranded journal (TaskCreationStartupReconcilerV1's own scan never
        // would — the folder is already gone).
        const stranded = await listStrandedTaskDeletionJournalsV1(harness.metaFolderPath);
        assert.equal(stranded.length, 1, "the sweep must find the journal stuck at folderRemoved");
        assert.equal(normalizePath(stranded[0]?.taskFolderPath ?? ""), normalizePath(taskFolderPath));

        await resumeStrandedTaskDeletionsV1(harness.metaFolderPath, harness.currentTaskStore, harness.inventory);

        const resolvedJournal = await loadTaskDeletionJournalV1(harness.metaFolderPath, taskFolderPath);
        assert.equal(resolvedJournal.kind, "ok");
        assert.equal(
          resolvedJournal.kind === "ok" ? resolvedJournal.journal.state : undefined,
          "externalStateResolved",
          "the deletion journal must resume to its terminal state"
        );

        const creationJournal = await loadTaskCreationJournalV1(harness.metaFolderPath, taskFolderPath);
        assert.equal(creationJournal.kind, "ok");
        assert.equal(
          creationJournal.kind === "ok" ? creationJournal.journal.state : undefined,
          "resolvedDeleted",
          "the source creation journal must be marked resolvedDeleted"
        );

        assert.equal(
          harness.currentTaskStore.get(),
          undefined,
          "the checkpoint must be cleared once it identified the deleted folder"
        );
        assert.equal(
          fs.existsSync(taskFolderPath),
          false,
          "resuming a stranded deletion must never recreate the folder"
        );

        // Idempotent: nothing is left for a second sweep to resume, and
        // re-running the resume function is a safe no-op.
        const strandedAfter = await listStrandedTaskDeletionJournalsV1(harness.metaFolderPath);
        assert.equal(strandedAfter.length, 0, "a resolved journal must no longer be reported as stranded");
        await resumeStrandedTaskDeletionsV1(harness.metaFolderPath, harness.currentTaskStore, harness.inventory);
      } finally {
        harness.restore();
      }
    }
  );

  void it("does not report a deletion journal that already reached externalStateResolved", async () => {
    const harness = installHarness();
    try {
      const taskFolderName = "2026-01-01_task_1";
      const taskFolderPath = path.join(harness.metaFolderPath, taskFolderName);
      const ownership = defaultOwnership(harness);
      writeCreatingProgress(taskFolderPath, ownership);
      const progressBytes = fs.readFileSync(path.join(taskFolderPath, "task-progress.json"));

      const requested = await recordTaskDeletionRequestedV1({
        metaFolderPath: harness.metaFolderPath,
        taskFolderPath,
        taskFolderName,
        ownership,
        sourceIntentIds: [allocateHex128IdV1()],
        confirmationReceiptId: allocateHex128IdV1(),
        entries: [fileCreationIntentEntryV1("task-progress.json", "createdV1", progressBytes)],
        currentTaskCheckpointObserved: false,
      });
      assert.equal(requested.kind, "ok");
      safeRemoveDir(taskFolderPath);
      assert.equal((await recordFolderRemovedV1(harness.metaFolderPath, taskFolderPath)).kind, "ok");

      await resumeStrandedTaskDeletionsV1(harness.metaFolderPath, harness.currentTaskStore, harness.inventory);
      // A second, independent sweep call must be a safe no-op — nothing left
      // stranded, no error thrown.
      const stranded = await listStrandedTaskDeletionJournalsV1(harness.metaFolderPath);
      assert.equal(stranded.length, 0);
    } finally {
      harness.restore();
    }
  });
});
