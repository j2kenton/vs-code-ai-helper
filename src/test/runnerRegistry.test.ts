import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { resolveRunnerForModel } from "../runners/runnerRegistry";

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

void describe("resolveRunnerForModel", () => {
  void it("preserves runner availability checks when quota observation is enabled", async () => {
    const settings = installModelSettings({});
    try {
      const { runner } = resolveRunnerForModel("auto", "impl-low-review");

      assert.equal(typeof runner.isAvailable, "function");
      const availability = await runner.isAvailable();
      assert.equal(availability.available, false);
    } finally {
      settings.restore();
    }
  });

  void it("preserves runner availability checks when fallback switching is enabled", async () => {
    const settings = installModelSettings({
      "impl-low-review": {
        primary: "auto",
        backup: "copilot-gpt-5.6-sol",
        fallbackEnabled: true,
        strategy: "switch-to-backup",
      },
    });
    try {
      const { runner } = resolveRunnerForModel("auto", "impl-low-review");

      assert.equal(typeof runner.isAvailable, "function");
      const availability = await runner.isAvailable();
      assert.equal(availability.available, false);
    } finally {
      settings.restore();
    }
  });
});
