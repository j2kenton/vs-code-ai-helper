import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import {
  isProviderSignInButtonsEnabled,
  isProviderUsageButtonsEnabled,
  migrateProviderAccountActionsSetting,
} from "../config/settings";

/**
 * Local variant of the `installConfigStub` helper in settingsScopeMigration.test.ts,
 * extended to record the ConfigurationTarget of every update() call and to let a
 * chosen call (by 1-based index across all recorded calls) reject once, so the
 * failure-then-retry migration behaviour can be exercised deterministically.
 */
function installConfigStub(
  initialWorkspace: Record<string, unknown> = {},
  initialGlobal: Record<string, unknown> = {}
): {
  workspaceValues: Record<string, unknown>;
  globalValues: Record<string, unknown>;
  updateCalls: Array<{ key: string; value: unknown; target: vscode.ConfigurationTarget }>;
  failUpdateAt: (index: number) => void;
  restore: () => void;
} {
  const workspaceValues: Record<string, unknown> = { ...initialWorkspace };
  const globalValues: Record<string, unknown> = { ...initialGlobal };
  const updateCalls: Array<{ key: string; value: unknown; target: vscode.ConfigurationTarget }> = [];
  let failAtIndex: number | undefined;
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
      const callIndex = updateCalls.length + 1;
      updateCalls.push({ key, value, target });
      if (callIndex === failAtIndex) {
        failAtIndex = undefined;
        return Promise.reject(new Error("simulated update failure"));
      }
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
    updateCalls,
    failUpdateAt: (index: number): void => {
      failAtIndex = index;
    },
    restore: (): void => {
      (vscode.workspace as unknown as Record<string, unknown>).getConfiguration = original;
    },
  };
}

function assertNoWorkspaceFolderTarget(
  updateCalls: Array<{ key: string; value: unknown; target: vscode.ConfigurationTarget }>
): void {
  for (const call of updateCalls) {
    assert.notEqual(
      call.target,
      vscode.ConfigurationTarget.WorkspaceFolder,
      `update("${call.key}") must never target WorkspaceFolder (window-scoped settings reject it)`
    );
    assert.ok(
      call.target === vscode.ConfigurationTarget.Global || call.target === vscode.ConfigurationTarget.Workspace,
      `update("${call.key}") used an unexpected target`
    );
  }
}

void describe("provider sign-in / usage button getters", () => {
  void it("return false when nothing is set", () => {
    const stub = installConfigStub();
    try {
      assert.equal(isProviderSignInButtonsEnabled(), false);
      assert.equal(isProviderUsageButtonsEnabled(), false);
    } finally {
      stub.restore();
    }
  });

  void it("return true only for the key that is explicitly true", () => {
    const stub = installConfigStub({}, { showProviderSignInButtons: true });
    try {
      assert.equal(isProviderSignInButtonsEnabled(), true);
      assert.equal(isProviderUsageButtonsEnabled(), false);
    } finally {
      stub.restore();
    }
  });

  void it("ignore the old combined key when migration has not run", () => {
    const stub = installConfigStub({}, { showProviderAccountActions: true });
    try {
      assert.equal(isProviderSignInButtonsEnabled(), false);
      assert.equal(isProviderUsageButtonsEnabled(), false);
    } finally {
      stub.restore();
    }
  });
});

void describe("migrateProviderAccountActionsSetting", () => {
  void it("migrates a user(global)-scoped old value to both new keys at global scope and clears the old key", async () => {
    const stub = installConfigStub({}, { showProviderAccountActions: true });
    try {
      await migrateProviderAccountActionsSetting();
      assert.equal(stub.globalValues.showProviderSignInButtons, true);
      assert.equal(stub.globalValues.showProviderUsageButtons, true);
      assert.equal(stub.globalValues.showProviderAccountActions, undefined);
      assertNoWorkspaceFolderTarget(stub.updateCalls);
    } finally {
      stub.restore();
    }
  });

  void it("migrates a workspace-scoped old value to the new keys at workspace scope, not global", async () => {
    const stub = installConfigStub({ showProviderAccountActions: true });
    try {
      await migrateProviderAccountActionsSetting();
      assert.equal(stub.workspaceValues.showProviderSignInButtons, true);
      assert.equal(stub.workspaceValues.showProviderUsageButtons, true);
      assert.equal(stub.workspaceValues.showProviderAccountActions, undefined);
      assert.equal(stub.globalValues.showProviderSignInButtons, undefined);
      assert.equal(stub.globalValues.showProviderUsageButtons, undefined);
      assertNoWorkspaceFolderTarget(stub.updateCalls);
    } finally {
      stub.restore();
    }
  });

  void it("preserves an already-explicit false on one new key and only fills in the other", async () => {
    const stub = installConfigStub(
      {},
      { showProviderAccountActions: true, showProviderUsageButtons: false }
    );
    try {
      await migrateProviderAccountActionsSetting();
      assert.equal(stub.globalValues.showProviderSignInButtons, true);
      assert.equal(stub.globalValues.showProviderUsageButtons, false, "pre-existing explicit false must survive");
      assert.equal(stub.globalValues.showProviderAccountActions, undefined);
      assertNoWorkspaceFolderTarget(stub.updateCalls);
    } finally {
      stub.restore();
    }
  });

  void it("migrates an explicit false old value to both new keys as false", async () => {
    const stub = installConfigStub({}, { showProviderAccountActions: false });
    try {
      await migrateProviderAccountActionsSetting();
      assert.equal(stub.globalValues.showProviderSignInButtons, false);
      assert.equal(stub.globalValues.showProviderUsageButtons, false);
      assert.equal(stub.globalValues.showProviderAccountActions, undefined);
      assertNoWorkspaceFolderTarget(stub.updateCalls);
    } finally {
      stub.restore();
    }
  });

  void it("does nothing when the old key is unset", async () => {
    const stub = installConfigStub();
    try {
      await migrateProviderAccountActionsSetting();
      assert.deepStrictEqual(stub.updateCalls, []);
    } finally {
      stub.restore();
    }
  });

  void it("does nothing when the old key is malformed (not a boolean)", async () => {
    const stub = installConfigStub({}, { showProviderAccountActions: "yes" });
    try {
      await migrateProviderAccountActionsSetting();
      assert.deepStrictEqual(stub.updateCalls, []);
      assert.equal(stub.globalValues.showProviderAccountActions, "yes", "malformed old value is left in place");
    } finally {
      stub.restore();
    }
  });

  void it("leaves the old key set if a write fails partway, then completes migration on retry", async () => {
    const stub = installConfigStub({}, { showProviderAccountActions: true });
    // Global scope's update sequence is: write signIn (1), write usage (2),
    // clear old (3). Fail the second call so the first (sign-in) succeeds
    // but the migration aborts before clearing the old key.
    stub.failUpdateAt(2);
    try {
      await assert.rejects(() => migrateProviderAccountActionsSetting());
      assert.equal(stub.globalValues.showProviderSignInButtons, true, "the first write must have landed");
      assert.equal(stub.globalValues.showProviderUsageButtons, undefined, "the failed write must not have landed");
      assert.equal(stub.globalValues.showProviderAccountActions, true, "old key must survive a partial failure");

      // Retry: sign-in is already explicit, so only usage is written this time.
      await migrateProviderAccountActionsSetting();
      assert.equal(stub.globalValues.showProviderSignInButtons, true);
      assert.equal(stub.globalValues.showProviderUsageButtons, true);
      assert.equal(stub.globalValues.showProviderAccountActions, undefined);
    } finally {
      stub.restore();
    }
  });

  void it("is idempotent: running twice matches running once", async () => {
    const stub = installConfigStub({}, { showProviderAccountActions: true });
    try {
      await migrateProviderAccountActionsSetting();
      const afterFirst = { ...stub.globalValues };
      await migrateProviderAccountActionsSetting();
      assert.deepStrictEqual(stub.globalValues, afterFirst);
    } finally {
      stub.restore();
    }
  });

  void it("lets a later Settings UI reset of one new key take effect without reviving the other", async () => {
    const stub = installConfigStub({}, { showProviderAccountActions: true });
    try {
      await migrateProviderAccountActionsSetting();
      assert.equal(stub.globalValues.showProviderSignInButtons, true);
      assert.equal(stub.globalValues.showProviderUsageButtons, true);

      // Simulate the user clearing (resetting) just the sign-in key from the
      // Settings UI after migration.
      delete stub.globalValues.showProviderSignInButtons;

      assert.equal(isProviderSignInButtonsEnabled(), false);
      assert.equal(isProviderUsageButtonsEnabled(), true);
    } finally {
      stub.restore();
    }
  });
});
