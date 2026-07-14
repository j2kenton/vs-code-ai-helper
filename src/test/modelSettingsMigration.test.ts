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

// Regression coverage for a Codex review finding: Antigravity's stored model
// ID format changed from kebab-case slugs to the CLI's own display-name
// strings. parseModelSelection aliases the old slugs at the execution-path
// read site, but getModelSettings feeds the settings webview too, which
// matches a stage's stored ID against getAvailableModels() by exact string —
// without normalizing here as well, a previously-saved slug would run fine
// but render as "Unknown model" and reset to default on the next save.
void describe("getModelSettings — Antigravity legacy model ID migration", () => {
  void it("rewrites a legacy Antigravity slug in primary/backup/backups to its current display-name ID", () => {
    const settings = installModelSettings({
      impl: {
        primary: "antigravity-cli:gpt-oss-120b-medium",
        backup: "antigravity-cli:gemini-3.1-pro-high",
        backups: ["antigravity-cli:gemini-3.1-pro-high", "antigravity-cli:claude-opus-4.6-thinking"],
        strategy: "switch-to-backup",
      },
    });
    try {
      const result = getModelSettings();
      assert.strictEqual(result.impl?.primary, "antigravity-cli:GPT-OSS 120B (Medium)");
      assert.strictEqual(result.impl?.backup, "antigravity-cli:Gemini 3.1 Pro (High)");
      assert.deepStrictEqual(result.impl?.backups, [
        "antigravity-cli:Gemini 3.1 Pro (High)",
        "antigravity-cli:Claude Opus 4.6 (Thinking)",
      ]);
    } finally {
      settings.restore();
    }
  });

  void it("leaves current-format IDs and other providers' IDs unchanged", () => {
    const settings = installModelSettings({
      impl: {
        primary: "antigravity-cli:Gemini 3.5 Flash (Medium)",
        backup: "claude-cli:sonnet@high",
        strategy: "switch-to-backup",
      },
    });
    try {
      const result = getModelSettings();
      assert.strictEqual(result.impl?.primary, "antigravity-cli:Gemini 3.5 Flash (Medium)");
      assert.strictEqual(result.impl?.backup, "claude-cli:sonnet@high");
    } finally {
      settings.restore();
    }
  });
});
