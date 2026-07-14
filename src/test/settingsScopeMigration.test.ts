import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { migrateSettingsScope, targetFor } from "../config/settings";

/**
 * Fake WorkspaceConfiguration backed by two plain maps (workspace/global),
 * mirroring the real merge behaviour (workspace wins on read) closely enough
 * for migrateSettingsScope()'s inspect()/update() calls.
 */
function installConfigStub(
  initialWorkspace: Record<string, unknown> = {},
  initialGlobal: Record<string, unknown> = {}
): {
  workspaceValues: Record<string, unknown>;
  globalValues: Record<string, unknown>;
  restore: () => void;
} {
  const workspaceValues: Record<string, unknown> = { ...initialWorkspace };
  const globalValues: Record<string, unknown> = { ...initialGlobal };
  const original = (vscode.workspace as unknown as Record<string, unknown>).getConfiguration;

  (vscode.workspace as unknown as Record<string, unknown>).getConfiguration = () => ({
    get: (key: string, defaultValue?: unknown): unknown =>
      workspaceValues[key] !== undefined
        ? workspaceValues[key]
        : globalValues[key] !== undefined
          ? globalValues[key]
          : defaultValue,
    inspect: (key: string) => ({
      key,
      workspaceValue: workspaceValues[key],
      globalValue: globalValues[key],
    }),
    update: (key: string, value: unknown, target: vscode.ConfigurationTarget): Promise<void> => {
      const store = target === vscode.ConfigurationTarget.Global ? globalValues : workspaceValues;
      if (value === undefined) {
        delete store[key];
      } else {
        store[key] = value;
      }
      return Promise.resolve();
    },
  });

  return {
    workspaceValues,
    globalValues,
    restore: (): void => {
      (vscode.workspace as unknown as Record<string, unknown>).getConfiguration = original;
    },
  };
}

function stubWarningMessage(response: string | undefined): {
  calls: unknown[][];
  restore: () => void;
} {
  const original = vscode.window.showWarningMessage;
  const calls: unknown[][] = [];
  (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage = (
    ...args: unknown[]
  ): Promise<string | undefined> => {
    calls.push(args);
    return Promise.resolve(response);
  };
  return {
    calls,
    restore: (): void => {
      (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage = original;
    },
  };
}

void describe("targetFor", () => {
  void it("keeps metaResourcesPath and metaFilesHidden workspace-scoped", () => {
    assert.strictEqual(targetFor("metaResourcesPath"), vscode.ConfigurationTarget.Workspace);
    assert.strictEqual(targetFor("metaFilesHidden"), vscode.ConfigurationTarget.Workspace);
  });

  void it("routes every other known key to Global", () => {
    for (const key of ["modelSettings", "enabledProviders", "autoAdvanceEnabled", "desktopNotifications"]) {
      assert.strictEqual(targetFor(key), vscode.ConfigurationTarget.Global, key);
    }
  });
});

void describe("migrateSettingsScope", () => {
  void it("lifts a workspace-only value to Global and clears it from the workspace", async () => {
    const stub = installConfigStub({ modelSettings: { impl: { primary: "a" } } });
    try {
      await migrateSettingsScope();
      assert.deepStrictEqual(stub.globalValues.modelSettings, { impl: { primary: "a" } });
      assert.strictEqual(stub.workspaceValues.modelSettings, undefined);
    } finally {
      stub.restore();
    }
  });

  void it("leaves metaResourcesPath and metaFilesHidden untouched even when set", async () => {
    const stub = installConfigStub({ metaResourcesPath: ".helper/plans", metaFilesHidden: true });
    try {
      await migrateSettingsScope();
      assert.strictEqual(stub.workspaceValues.metaResourcesPath, ".helper/plans");
      assert.strictEqual(stub.workspaceValues.metaFilesHidden, true);
      assert.strictEqual(stub.globalValues.metaResourcesPath, undefined);
      assert.strictEqual(stub.globalValues.metaFilesHidden, undefined);
    } finally {
      stub.restore();
    }
  });

  void it("clears a redundant workspace value that already matches Global, without prompting", async () => {
    const stub = installConfigStub(
      { autoAdvanceEnabled: true },
      { autoAdvanceEnabled: true }
    );
    const warning = stubWarningMessage(undefined);
    try {
      await migrateSettingsScope();
      assert.strictEqual(stub.workspaceValues.autoAdvanceEnabled, undefined);
      assert.strictEqual(stub.globalValues.autoAdvanceEnabled, true);
      assert.strictEqual(warning.calls.length, 0, "no prompt needed when values already agree");
    } finally {
      warning.restore();
      stub.restore();
    }
  });

  void it("does nothing when no workspace values are set", async () => {
    const stub = installConfigStub();
    const warning = stubWarningMessage(undefined);
    try {
      await migrateSettingsScope();
      assert.deepStrictEqual(stub.workspaceValues, {});
      assert.deepStrictEqual(stub.globalValues, {});
      assert.strictEqual(warning.calls.length, 0);
    } finally {
      warning.restore();
      stub.restore();
    }
  });

  void it("prompts on a real conflict and leaves both values in place when declined", async () => {
    const stub = installConfigStub(
      { fastForwardMaxIterations: 10 },
      { fastForwardMaxIterations: 5 }
    );
    const warning = stubWarningMessage("Keep Workspace Overrides");
    try {
      await migrateSettingsScope();
      assert.strictEqual(warning.calls.length, 1);
      assert.strictEqual(stub.workspaceValues.fastForwardMaxIterations, 10);
      assert.strictEqual(stub.globalValues.fastForwardMaxIterations, 5);
    } finally {
      warning.restore();
      stub.restore();
    }
  });

  void it("lifts the workspace value to Global on a conflict when the user opts in", async () => {
    const stub = installConfigStub(
      { fastForwardMaxIterations: 10 },
      { fastForwardMaxIterations: 5 }
    );
    const warning = stubWarningMessage("Use This Workspace's Settings Everywhere");
    try {
      await migrateSettingsScope();
      assert.strictEqual(stub.workspaceValues.fastForwardMaxIterations, undefined);
      assert.strictEqual(stub.globalValues.fastForwardMaxIterations, 10);
    } finally {
      warning.restore();
      stub.restore();
    }
  });
});
