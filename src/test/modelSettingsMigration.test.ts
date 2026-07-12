import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { getModelSettings } from "../config/settings";

function installModelSettings(raw: Record<string, unknown>): { restore: () => void } {
  const original = (vscode.workspace as unknown as Record<string, unknown>).getConfiguration;
  (vscode.workspace as unknown as Record<string, unknown>).getConfiguration = (): {
    get: (key: string, defaultValue?: unknown) => unknown;
    inspect: () => undefined;
  } => ({
    get: (key: string, defaultValue?: unknown): unknown =>
      key === "modelSettings" ? raw : defaultValue,
    inspect: () => undefined,
  });

  return {
    restore: (): void => {
      (vscode.workspace as unknown as Record<string, unknown>).getConfiguration = original;
    },
  };
}

// Regression coverage for a Codex review finding: the removed "Use Backup
// Model" checkbox previously let a stage be saved as
// { strategy: "switch-to-backup", fallbackEnabled: false } — checkbox
// unchecked, but the strategy dropdown left on "Switch to Backup". That
// combination meant "don't use the backup". Now that strategy alone governs
// fallback, reading that persisted entry verbatim would silently start using
// the backup for workspaces that had explicitly opted out. getModelSettings
// must downgrade the strategy to "alert-and-wait" in that case.
void describe("getModelSettings — legacy fallbackEnabled migration", () => {
  void it("downgrades switch-to-backup to alert-and-wait when the legacy checkbox was unchecked", () => {
    const settings = installModelSettings({
      impl: {
        primary: "primary-model",
        backup: "backup-model",
        strategy: "switch-to-backup",
        fallbackEnabled: false,
      },
    });
    try {
      const result = getModelSettings();
      assert.strictEqual(result.impl?.strategy, "alert-and-wait");
      // Backup selection itself is preserved so re-enabling is reversible.
      assert.strictEqual(result.impl?.backup, "backup-model");
    } finally {
      settings.restore();
    }
  });

  void it("keeps switch-to-backup when the legacy checkbox was checked", () => {
    const settings = installModelSettings({
      impl: {
        primary: "primary-model",
        backup: "backup-model",
        strategy: "switch-to-backup",
        fallbackEnabled: true,
      },
    });
    try {
      const result = getModelSettings();
      assert.strictEqual(result.impl?.strategy, "switch-to-backup");
    } finally {
      settings.restore();
    }
  });

  void it("keeps switch-to-backup when fallbackEnabled is absent (new-format entries)", () => {
    const settings = installModelSettings({
      impl: {
        primary: "primary-model",
        backup: "backup-model",
        strategy: "switch-to-backup",
      },
    });
    try {
      const result = getModelSettings();
      assert.strictEqual(result.impl?.strategy, "switch-to-backup");
    } finally {
      settings.restore();
    }
  });
});
