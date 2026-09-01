import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import {
  getEnabledProviders,
  getModelSettings,
  isModelProviderEnabled,
  isProviderEnabled,
  setModelSettings,
} from "../config/settings";
import { chooseFallback } from "../utils/modelFallback";

function installModelSettings(
  raw: Record<string, unknown>,
  extra: Record<string, unknown> = {}
): { restore: () => void; updates: Array<{ key: string; value: unknown }> } {
  const original = (vscode.workspace as unknown as Record<string, unknown>).getConfiguration;
  const updates: Array<{ key: string; value: unknown }> = [];
  (vscode.workspace as unknown as Record<string, unknown>).getConfiguration = (): {
    get: (key: string, defaultValue?: unknown) => unknown;
    inspect: () => undefined;
    update: (key: string, value: unknown) => Promise<void>;
  } => ({
    get: (key: string, defaultValue?: unknown): unknown =>
      key === "modelSettings" ? raw : key in extra ? extra[key] : defaultValue,
    inspect: () => undefined,
    update: (key: string, value: unknown): Promise<void> => {
      updates.push({ key, value });
      return Promise.resolve();
    },
  });

  return {
    restore: (): void => {
      (vscode.workspace as unknown as Record<string, unknown>).getConfiguration = original;
    },
    updates,
  };
}

// Regression coverage for a Codex review finding: the removed "Use Backup
// Model" checkbox previously let a stage be saved as
// { strategy: "switch-to-backup", fallbackEnabled: false } — checkbox
// unchecked, but the strategy dropdown left on "Switch to Backup". That
// combination meant "don't use the backup". Now that strategy alone governs
// fallback, reading that persisted entry verbatim would silently start using
// the backup for workspaces that had explicitly opted out. getModelSettings
// must downgrade the strategy to "never-switch" in that case.
void describe("getModelSettings — legacy fallbackEnabled migration", () => {
  void it("exposes only backup or stop after migration", () => {
    assert.strictEqual(
      chooseFallback({ primary: "primary-model", backups: ["backup-model"], strategy: "switch-to-backup" }),
      "backup"
    );
    assert.strictEqual(
      chooseFallback({ primary: "primary-model", backups: ["backup-model"], strategy: "never-switch" }),
      "stop"
    );
  });

  void it("downgrades switch-to-backup to never-switch when the legacy checkbox was unchecked", () => {
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
      assert.strictEqual(result.impl?.strategy, "never-switch");
      // Backup selection itself is preserved so re-enabling is reversible.
      assert.strictEqual(result.impl?.backup, "backup-model");
    } finally {
      settings.restore();
    }
  });

  void it("maps both removed three-way strategy values to never-switch", () => {
    for (const strategy of ["pause-and-resume", "alert-and-wait"]) {
      const settings = installModelSettings({
        impl: { primary: "primary-model", backup: "backup-model", strategy },
      });
      try {
        assert.strictEqual(getModelSettings().impl?.strategy, "never-switch");
      } finally {
        settings.restore();
      }
    }
  });

  void it("writes the canonical two-value strategy after a legacy read and remains stable on a second read", async () => {
    const settings = installModelSettings({
      impl: { primary: "primary-model", backup: "backup-model", strategy: "pause-and-resume" },
    });
    try {
      const migrated = getModelSettings();
      assert.strictEqual(migrated.impl?.strategy, "never-switch");
      await setModelSettings(migrated);
      const stored = settings.updates.find((update) => update.key === "modelSettings")?.value as {
        impl?: { strategy?: string };
      };
      assert.strictEqual(stored.impl?.strategy, "never-switch");
      assert.strictEqual(getModelSettings().impl?.strategy, "never-switch");
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

// Plan Workstream 1 coverage: removing the per-stage provider dropdowns must
// never collapse or migrate stage model assignments. A stage whose selected
// model belongs to a disabled provider keeps its stored value byte-for-byte
// (the UI surfaces "provider disabled" and run time treats the stage as
// unconfigured — see ensureStageModelConfigured); re-enabling the provider
// restores the exact same selection with no data loss.
void describe("getModelSettings — disabled-provider round trip", () => {
  const raw = {
    impl: {
      primary: "codex-cli:gpt-5.4-codex",
      backup: "claude-cli:sonnet@high",
      strategy: "switch-to-backup",
    },
  };

  void it("preserves a stage's stored model byte-for-byte while its provider is disabled", () => {
    const settings = installModelSettings(raw, {
      enabledProviders: { "claude-cli": true, "codex-cli": false },
    });
    try {
      assert.strictEqual(isProviderEnabled("codex-cli"), false);
      const result = getModelSettings();
      assert.strictEqual(result.impl?.primary, "codex-cli:gpt-5.4-codex");
      assert.strictEqual(result.impl?.backup, "claude-cli:sonnet@high");
      assert.strictEqual(result.impl?.strategy, "switch-to-backup");
    } finally {
      settings.restore();
    }
  });

  void it("returns the identical selection once the provider is re-enabled", () => {
    const settings = installModelSettings(raw, {
      enabledProviders: { "claude-cli": true, "codex-cli": true },
    });
    try {
      assert.strictEqual(isProviderEnabled("codex-cli"), true);
      const result = getModelSettings();
      assert.strictEqual(result.impl?.primary, "codex-cli:gpt-5.4-codex");
      assert.strictEqual(result.impl?.backup, "claude-cli:sonnet@high");
    } finally {
      settings.restore();
    }
  });
});

void describe("OpenCode Zen/Go provider-selection compatibility", () => {
  void it("maps the former single OpenCode checkbox to both explicit service rows", () => {
    const settings = installModelSettings({}, {
      enabledProviders: { "opencode-cli": true },
    });
    try {
      assert.deepEqual(getEnabledProviders(), {
        "opencode-cli": true,
        "opencode-zen": true,
        "opencode-go": true,
      });
      assert.strictEqual(isModelProviderEnabled("opencode-cli:opencode/glm-5.2"), true);
      assert.strictEqual(isModelProviderEnabled("opencode-cli:opencode-go/kimi-k3"), true);
      assert.strictEqual(isModelProviderEnabled("opencode-cli:openai/gpt-5"), true);
    } finally {
      settings.restore();
    }
  });

  void it("keeps Zen and Go independently enabled for their native model namespaces", () => {
    const settings = installModelSettings({}, {
      enabledProviders: { "opencode-zen": true, "opencode-go": false },
    });
    try {
      assert.strictEqual(isModelProviderEnabled("opencode-cli:opencode/glm-5.2"), true);
      assert.strictEqual(isModelProviderEnabled("opencode-cli:opencode-go/kimi-k3"), false);
      assert.strictEqual(
        isModelProviderEnabled("opencode-cli:openai/gpt-5"),
        false,
        "Zen must not authorize a saved external OpenCode CLI provider"
      );
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
