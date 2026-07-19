import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import {
  AutoImplementConfirmationController,
  getAutoImplementAfterReviewMode,
  resetAutoImplementConfirmationForTests,
  migrateSettingsNamespace,
  migrateSettingsScope,
  targetFor,
} from "../config/settings";

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
    for (const key of ["modelSettings", "enabledProviders", "autoAdvanceEnabled", "autoImplementAfterReview", "desktopNotifications"]) {
      assert.strictEqual(targetFor(key), vscode.ConfigurationTarget.Global, key);
    }
  });
});

void describe("migrateSettingsNamespace", () => {
  void it("copies explicit legacy values once without allowing an active schema default to mask them", async () => {
    const workspace = vscode.workspace as unknown as Record<string, unknown>;
    const original = workspace.getConfiguration;
    const legacyGlobal: Record<string, unknown> = { autoAdvanceEnabled: "auto" };
    const ensembleGlobal: Record<string, unknown> = {};
    const state = new Map<string, unknown>();
    workspace.getConfiguration = (section: string) => {
      const values = section === "ensemble" ? ensembleGlobal : legacyGlobal;
      return {
        inspect: (key: string) => ({ key, globalValue: values[key], workspaceValue: undefined }),
        update: (key: string, value: unknown): Promise<void> => {
          if (value === undefined) delete values[key]; else values[key] = value;
          return Promise.resolve();
        },
      };
    };
    const context = {
      globalState: {
        get: <T>(key: string, fallback?: T): T => (state.has(key) ? state.get(key) as T : fallback as T),
        update: (key: string, value: unknown): Promise<void> => { state.set(key, value); return Promise.resolve(); },
      },
    } as unknown as vscode.ExtensionContext;
    try {
      await migrateSettingsNamespace(context);
      assert.equal(ensembleGlobal.autoAdvanceEnabled, "auto");
      ensembleGlobal.autoAdvanceEnabled = "off";
      legacyGlobal.autoAdvanceEnabled = "auto-fast-forward";
      await migrateSettingsNamespace(context);
      assert.equal(ensembleGlobal.autoAdvanceEnabled, "off", "versioned migration is idempotent");
    } finally {
      workspace.getConfiguration = original;
    }
  });

  void it("copies global, workspace, and each folder override to the matching Ensemble scope", async () => {
    const workspace = vscode.workspace as unknown as Record<string, unknown>;
    const originalConfiguration = workspace.getConfiguration;
    const originalFolders = workspace.workspaceFolders;
    const first = vscode.Uri.file("/workspace-one");
    const second = vscode.Uri.file("/workspace-two");
    const legacy: {
      global: Record<string, unknown>;
      workspace: Record<string, unknown>;
      folders: Map<string, Record<string, unknown>>;
    } = {
      global: { autoAdvanceEnabled: "auto" },
      workspace: { autoReviewAfterPlan: "auto" },
      folders: new Map<string, Record<string, unknown>>([
        [first.toString(), { enabledProviders: { "codex-cli": true } }],
        [second.toString(), { enabledProviders: { "claude-cli": true } }],
      ]),
    };
    const ensemble: {
      global: Record<string, unknown>;
      workspace: Record<string, unknown>;
      folders: Map<string, Record<string, unknown>>;
    } = {
      global: {} as Record<string, unknown>,
      workspace: {} as Record<string, unknown>,
      folders: new Map<string, Record<string, unknown>>([
        [first.toString(), {}], [second.toString(), {}],
      ]),
    };
    workspace.workspaceFolders = [
      { uri: first, name: "one", index: 0 },
      { uri: second, name: "two", index: 1 },
    ];
    workspace.getConfiguration = (section: string, resource?: vscode.Uri) => {
      const store = section === "ensemble" ? ensemble : legacy;
      const folder = resource ? store.folders.get(resource.toString()) : undefined;
      return {
        inspect: (key: string) => ({
          key,
          globalValue: store.global[key],
          workspaceValue: store.workspace[key],
          workspaceFolderValue: folder?.[key],
        }),
        update: (key: string, value: unknown, target: vscode.ConfigurationTarget): Promise<void> => {
          const destination = target === vscode.ConfigurationTarget.Global
            ? store.global
            : target === vscode.ConfigurationTarget.Workspace
              ? store.workspace
              : store.folders.get(resource!.toString())!;
          if (value === undefined) delete destination[key]; else destination[key] = value;
          return Promise.resolve();
        },
      };
    };
    const state = new Map<string, unknown>();
    const context = {
      globalState: {
        get: <T>(key: string, fallback?: T): T => (state.has(key) ? state.get(key) as T : fallback as T),
        update: (key: string, value: unknown): Promise<void> => { state.set(key, value); return Promise.resolve(); },
      },
    } as unknown as vscode.ExtensionContext;
    try {
      await migrateSettingsNamespace(context);
      assert.equal(ensemble.global.autoAdvanceEnabled, "auto");
      assert.equal(ensemble.workspace.autoReviewAfterPlan, "auto");
      assert.deepEqual(ensemble.folders.get(first.toString())?.enabledProviders, { "codex-cli": true });
      assert.deepEqual(ensemble.folders.get(second.toString())?.enabledProviders, { "claude-cli": true });
    } finally {
      workspace.getConfiguration = originalConfiguration;
      workspace.workspaceFolders = originalFolders;
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

void describe("automatic implementation confirmation gate", () => {
  void it("treats an unconfirmed auto value as off and clears it when supervision is declined", async () => {
    const workspace = vscode.workspace as unknown as Record<string, unknown>;
    const originalConfiguration = workspace.getConfiguration;
    const originalWarning = vscode.window.showWarningMessage;
    let setting: unknown = "auto";
    let prompts = 0;
    workspace.getConfiguration = () => ({
      get: (_key: string, fallback?: unknown): unknown => setting ?? fallback,
      inspect: () => ({ globalValue: setting, workspaceValue: undefined }),
      update: (_key: string, value: unknown): Promise<void> => {
        setting = value;
        return Promise.resolve();
      },
    });
    (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage = (): Promise<undefined> => {
      prompts += 1;
      return Promise.resolve(undefined);
    };
    const state = new Map<string, unknown>();
    const context = {
      globalState: {
        get: <T>(_key: string, fallback?: T): T => fallback as T,
        update: (key: string, value: unknown): Promise<void> => { state.set(key, value); return Promise.resolve(); },
      },
    } as unknown as vscode.ExtensionContext;
    const controller = new AutoImplementConfirmationController(context);
    try {
      assert.equal(getAutoImplementAfterReviewMode(), "off", "raw auto must not arm implementation before confirmation");
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(prompts, 1);
      assert.equal(setting, undefined, "declining clears only the enabled scope");
      assert.equal(getAutoImplementAfterReviewMode(), "off");
    } finally {
      controller.dispose();
      resetAutoImplementConfirmationForTests();
      workspace.getConfiguration = originalConfiguration;
      (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage = originalWarning;
    }
  });

  void it("arms the gate only when the setting is auto and this machine has confirmed it", () => {
    const workspace = vscode.workspace as unknown as Record<string, unknown>;
    const originalConfiguration = workspace.getConfiguration;
    workspace.getConfiguration = () => ({
      get: (): unknown => "auto",
      inspect: () => ({ globalValue: "auto", workspaceValue: undefined }),
      update: (): Promise<void> => Promise.resolve(),
    });
    const context = {
      globalState: {
        get: <T>(_key: string, _fallback?: T): T => true as unknown as T,
        update: (): Promise<void> => Promise.resolve(),
      },
    } as unknown as vscode.ExtensionContext;
    const controller = new AutoImplementConfirmationController(context);
    try {
      assert.equal(getAutoImplementAfterReviewMode(), "auto");
    } finally {
      controller.dispose();
      resetAutoImplementConfirmationForTests();
      workspace.getConfiguration = originalConfiguration;
    }
  });

  void it("serializes changes made while a confirmation modal is open without losing the later scope", async () => {
    const workspace = vscode.workspace as unknown as Record<string, unknown>;
    const originalConfiguration = workspace.getConfiguration;
    const originalWarning = vscode.window.showWarningMessage;
    const global: Record<string, unknown> = {};
    const workspaceValues: Record<string, unknown> = {};
    workspace.getConfiguration = () => ({
      get: (_key: string, fallback?: unknown): unknown => workspaceValues.autoImplementAfterReview ?? global.autoImplementAfterReview ?? fallback,
      inspect: () => ({
        globalValue: global.autoImplementAfterReview,
        workspaceValue: workspaceValues.autoImplementAfterReview,
      }),
      update: (_key: string, value: unknown, target: vscode.ConfigurationTarget): Promise<void> => {
        const destination = target === vscode.ConfigurationTarget.Global ? global : workspaceValues;
        if (value === undefined) delete destination.autoImplementAfterReview;
        else destination.autoImplementAfterReview = value;
        return Promise.resolve();
      },
    });
    let firstPrompt: (() => void) | undefined;
    let promptCount = 0;
    (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage = (): Promise<undefined> => {
      promptCount += 1;
      if (promptCount > 1) return Promise.resolve(undefined);
      return new Promise((resolve) => { firstPrompt = () => resolve(undefined); });
    };
    const context = {
      globalState: { get: <T>(_key: string, fallback?: T): T => fallback as T, update: (): Promise<void> => Promise.resolve() },
    } as unknown as vscode.ExtensionContext;
    const controller = new AutoImplementConfirmationController(context);
    const changes = (vscode.workspace as unknown as {
      _configurationChanges: { fire(value: { affectsConfiguration(section: string): boolean }): void };
    })._configurationChanges;
    try {
      await controller.whenIdle();
      global.autoImplementAfterReview = "auto";
      changes.fire({ affectsConfiguration: () => true });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.ok(firstPrompt, "the global change should open the first modal");

      // This event occurs while the first modal is open. It must be handled
      // after the global cancellation, not absorbed by that cancellation's
      // post-write snapshot.
      workspaceValues.autoImplementAfterReview = "auto";
      changes.fire({ affectsConfiguration: () => true });
      firstPrompt?.();
      await controller.whenIdle();

      assert.equal(promptCount, 2);
      assert.equal(global.autoImplementAfterReview, undefined);
      assert.equal(workspaceValues.autoImplementAfterReview, undefined);
    } finally {
      controller.dispose();
      resetAutoImplementConfirmationForTests();
      workspace.getConfiguration = originalConfiguration;
      (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage = originalWarning;
    }
  });

  void it("cancels a folder-scoped auto value without clearing another scope", async () => {
    const workspace = vscode.workspace as unknown as Record<string, unknown>;
    const originalConfiguration = workspace.getConfiguration;
    const originalFolders = workspace.workspaceFolders;
    const originalWarning = vscode.window.showWarningMessage;
    const folder = vscode.Uri.file("/workspace-folder-scope");
    const global: Record<string, unknown> = { autoImplementAfterReview: "off" };
    const folderValues: Record<string, unknown> = {};
    workspace.workspaceFolders = [{ uri: folder, name: "folder", index: 0 }];
    workspace.getConfiguration = (_section: string, resource?: vscode.Uri) => ({
      get: (_key: string, fallback?: unknown): unknown => (resource ? folderValues.autoImplementAfterReview : global.autoImplementAfterReview) ?? fallback,
      inspect: () => ({
        globalValue: global.autoImplementAfterReview,
        workspaceValue: undefined,
        workspaceFolderValue: resource ? folderValues.autoImplementAfterReview : undefined,
      }),
      update: (_key: string, value: unknown, target: vscode.ConfigurationTarget): Promise<void> => {
        const destination = target === vscode.ConfigurationTarget.WorkspaceFolder ? folderValues : global;
        if (value === undefined) delete destination.autoImplementAfterReview;
        else destination.autoImplementAfterReview = value;
        return Promise.resolve();
      },
    });
    (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage = (): Promise<undefined> => Promise.resolve(undefined);
    const context = {
      globalState: { get: <T>(_key: string, fallback?: T): T => fallback as T, update: (): Promise<void> => Promise.resolve() },
    } as unknown as vscode.ExtensionContext;
    const controller = new AutoImplementConfirmationController(context);
    const changes = (vscode.workspace as unknown as {
      _configurationChanges: { fire(value: { affectsConfiguration(section: string): boolean }): void };
    })._configurationChanges;
    try {
      await controller.whenIdle();
      folderValues.autoImplementAfterReview = "auto";
      changes.fire({ affectsConfiguration: () => true });
      await controller.whenIdle();
      assert.equal(folderValues.autoImplementAfterReview, undefined);
      assert.equal(global.autoImplementAfterReview, "off");
    } finally {
      controller.dispose();
      resetAutoImplementConfirmationForTests();
      workspace.getConfiguration = originalConfiguration;
      workspace.workspaceFolders = originalFolders;
      (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage = originalWarning;
    }
  });
});
