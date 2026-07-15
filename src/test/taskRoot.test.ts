import * as assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import {
  DEFAULT_TASK_ROOT,
  getConfiguredTaskRoot,
  resolveTaskRootCandidates,
} from "../utils/taskRoot";

function installWorkspaceStub(
  workspaceRoot: string,
  configValue?: string
): { restore: () => void } {
  const originalFolders = vscode.workspace.workspaceFolders;
  const originalGetConfiguration = (vscode.workspace as unknown as Record<string, unknown>).getConfiguration;

  (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = [
    { name: "repo", index: 0, uri: vscode.Uri.file(workspaceRoot) },
  ];
  (vscode.workspace as unknown as Record<string, unknown>).getConfiguration = () => ({
    get: (_key: string, defaultValue?: unknown): unknown => configValue ?? defaultValue,
    inspect: () => configValue === undefined
      ? undefined
      : { workspaceValue: configValue, globalValue: undefined, workspaceFolderValue: undefined },
  });

  return {
    restore: (): void => {
      (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = originalFolders;
      (vscode.workspace as unknown as Record<string, unknown>).getConfiguration = originalGetConfiguration;
    },
  };
}

void describe("taskRoot defaults", () => {
  void it("defaults new task roots to .ensemble", () => {
    const stub = installWorkspaceStub("/workspace/repo");
    try {
      assert.equal(DEFAULT_TASK_ROOT, ".ensemble");
      assert.equal(getConfiguredTaskRoot(), ".ensemble");
    } finally {
      stub.restore();
    }
  });

  void it("discovers current and legacy implicit task roots", () => {
    const workspaceRoot = "/workspace/repo";
    const stub = installWorkspaceStub(workspaceRoot);
    try {
      const candidates = resolveTaskRootCandidates().map((candidate) =>
        candidate.absolutePath
      );

      assert.deepEqual(
        candidates,
        [
          path.normalize(path.join(workspaceRoot, ".ensemble")),
          path.normalize(path.join(workspaceRoot, ".helper", "plans")),
          path.normalize(path.join(workspaceRoot, "plans")),
        ]
      );
    } finally {
      stub.restore();
    }
  });
});
