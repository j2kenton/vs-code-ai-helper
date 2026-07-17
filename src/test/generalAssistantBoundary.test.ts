/**
 * openGeneralAssistant is a thin entry point that delegates straight into
 * `vs-code-ai-helper.chatWithStage` (see openGeneralAssistant.ts's own
 * docstring) — it does not build its own prompt or write files. The C4
 * chat-edit boundary (resolveMarkdownUpdateTarget in chatWithStage.ts) is
 * therefore already enforced for the general assistant surface, because it
 * is the same code path. A file-level grep for UPDATE_FILE/writeTextFile in
 * openGeneralAssistant.ts will always come up empty even though the
 * boundary applies — this test asserts the delegation contract directly so
 * that fact doesn't have to be re-derived by reading the source each time.
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { after, describe, it } from "node:test";
import * as vscode from "vscode";

import { openGeneralAssistant } from "../commands/openGeneralAssistant";
import { TaskInventory, TaskWithProgress } from "../state/taskInventory";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import type { TaskProgress } from "../types/taskProgress";

const REAL_TASK_ROOT = nodeFs.mkdtempSync(
  nodePath.join(nodeOs.tmpdir(), "ensemble-general-assistant-test-")
);
after(() => {
  nodeFs.rmSync(REAL_TASK_ROOT, { recursive: true, force: true });
});

function makeTaskFolder(name: string): string {
  const dir = nodePath.join(REAL_TASK_ROOT, ".ensemble", name);
  nodeFs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeInventoryStub(canonicalId: string, taskFolderPath: string): TaskInventory {
  const inv = Object.create(TaskInventory.prototype) as TaskInventory;
  const task: TaskWithProgress = {
    canonicalId,
    taskFolderPath,
    folderName: nodePath.basename(taskFolderPath),
    sourceScopeKey: canonicalId,
    progress: {
      taskFolder: nodePath.basename(taskFolderPath),
      currentStage: "impl" as const,
      status: "active",
      createdAt: "2026-07-08T00:00:00.000Z",
      updatedAt: "2026-07-08T00:00:00.000Z",
    } as TaskProgress,
  };
  // @ts-expect-error — direct field init on stub
  inv.visibleTasks = [task];
  inv.refresh = async (): Promise<void> => { /* no-op */ };
  inv.getTasks = (): TaskWithProgress[] => [task];
  inv.getTaskById = (id: string): TaskWithProgress | undefined => (id === canonicalId ? task : undefined);
  inv.getTaskByPath = (p: string): TaskWithProgress | undefined => (p === taskFolderPath ? task : undefined);
  inv.getVisibleTaskForSuppressedId = (): undefined => undefined;
  inv.getVisibleTaskForSuppressedPath = (): undefined => undefined;
  return inv;
}

function makeCurrentTaskStoreStub(persistedId?: string): CurrentTaskStore {
  const store = Object.create(CurrentTaskStore.prototype) as CurrentTaskStore;
  store.get = (): string | undefined => persistedId;
  store.set = async (): Promise<void> => { /* no-op */ };
  store.clear = async (): Promise<void> => { /* no-op */ };
  return store;
}

void describe("openGeneralAssistant delegation (C4 boundary inheritance)", () => {
  void it("dispatches vs-code-ai-helper.chatWithStage with the resolved task's own taskFolderPath", async () => {
    const folderPath = makeTaskFolder("general-assistant-delegation");
    const canonicalId = folderPath;
    const inv = makeInventoryStub(canonicalId, folderPath);
    const currentStore = makeCurrentTaskStoreStub(canonicalId);

    if (!(vscode as unknown as Record<string, unknown>).commands) {
      (vscode as unknown as Record<string, unknown>).commands = {};
    }
    const origExec = (vscode.commands as unknown as Record<string, unknown>).executeCommand;
    const origWs = (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders;
    const captured: Array<{ command: string; arg: unknown }> = [];
    (vscode.commands as unknown as Record<string, unknown>).executeCommand = async (
      command: string,
      arg?: unknown
    ): Promise<undefined> => {
      captured.push({ command, arg });
      return Promise.resolve(undefined);
    };
    (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = [
      { uri: vscode.Uri.file(REAL_TASK_ROOT), name: "real-task-root", index: 0 },
    ];

    try {
      await openGeneralAssistant(inv, currentStore);

      const dispatch = captured.find((e) => e.command === "vs-code-ai-helper.chatWithStage");
      assert.ok(dispatch, "openGeneralAssistant must dispatch vs-code-ai-helper.chatWithStage");
      const arg = dispatch.arg as { taskFolderPath?: string; canonicalId?: string };
      assert.strictEqual(
        arg.taskFolderPath,
        folderPath,
        "dispatch must carry the resolved task's own taskFolderPath — the same value " +
          "chatWithStage's resolveMarkdownUpdateTarget scopes markdown edits to, so the " +
          "general assistant is bound to the active task exactly like stage chat"
      );
    } finally {
      (vscode.commands as unknown as Record<string, unknown>).executeCommand = origExec;
      (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = origWs;
    }
  });
});
