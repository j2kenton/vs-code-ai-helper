/**
 * The Supervised / Unattended switch: it sets real, contributed settings to
 * values they accept, removes workspace overrides that would otherwise keep
 * the old behaviour, and reports any key whose effective value still differs.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import {
  applyAutomationSettingsV1,
  SUPERVISED_SETTINGS_V1,
  UNATTENDED_SETTINGS_V1,
} from "../commands/chooseAutomationLevelV1";

type Props = Record<string, { enum?: unknown[]; default?: unknown }>;
const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "..", "package.json"), "utf8")) as {
  contributes: { commands: Array<{ command: string }>; configuration: { properties: Props } | Array<{ properties: Props }> };
};
const properties: Props = {};
for (const block of ([] as Array<{ properties: Props }>).concat(pkg.contributes.configuration)) {
  Object.assign(properties, block.properties);
}

/** A two-scope (user + workspace) configuration stub; workspace wins, as in VS Code. */
function installScopedConfig(
  workspace: Record<string, unknown>,
  global: Record<string, unknown>,
  lockedGlobal?: string,
  failGlobalKey?: string,
  failRestoreKey?: string
) {
  const ws = vscode.workspace as unknown as Record<string, unknown>;
  const original = ws.getConfiguration;
  ws.getConfiguration = () => ({
    get: (key: string): unknown => (workspace[key] !== undefined ? workspace[key] : global[key]),
    inspect: (key: string) => ({ key, workspaceValue: workspace[key], globalValue: global[key] }),
    update: (key: string, value: unknown, target: vscode.ConfigurationTarget): Promise<void> => {
      if (key === lockedGlobal && target === vscode.ConfigurationTarget.Global) {
        return Promise.resolve(); // e.g. a policy-managed value the write cannot change
      }
      if (key === failGlobalKey && target === vscode.ConfigurationTarget.Global && value !== undefined) {
        failGlobalKey = undefined; // fail once; the rollback's own writes succeed
        return Promise.reject(new Error("settings.json is read-only"));
      }
      if (key === failRestoreKey && failGlobalKey === undefined && target === vscode.ConfigurationTarget.Global) {
        return Promise.reject(new Error("restore failed too"));
      }
      const store = target === vscode.ConfigurationTarget.Global ? global : workspace;
      if (value === undefined) delete store[key];
      else store[key] = value;
      return Promise.resolve();
    },
  });
  return { restore: () => { ws.getConfiguration = original; } };
}

void describe("chooseAutomationLevelV1", () => {
  void it("is contributed as a command", () => {
    assert.ok(pkg.contributes.commands.some((c) => c.command === "vs-code-ai-helper.chooseAutomationLevel"));
  });

  for (const [key, value] of UNATTENDED_SETTINGS_V1) {
    void it(`sets ensemble.${key} to a value it accepts, and its default is off`, () => {
      const property = properties[`ensemble.${key}`];
      assert.ok(property, `ensemble.${key} is not a contributed setting`);
      if (property.enum) assert.ok(property.enum.includes(value), `${value} is not one of ${JSON.stringify(property.enum)}`);
      assert.notEqual(property.default, value, "the unattended value must not already be the default");
    });
  }

  void it("Supervised writes exactly the shipped defaults", () => {
    for (const [key, value] of SUPERVISED_SETTINGS_V1) {
      assert.equal(properties[`ensemble.${key}`]?.default, value, `ensemble.${key}`);
    }
  });

  void it("Supervised removes a workspace override that would keep automation on", async () => {
    const workspace: Record<string, unknown> = { autoAdvanceEnabled: "auto-fast-forward" };
    const global: Record<string, unknown> = { autoReviewAfterPlan: "auto-fast-forward" };
    const stub = installScopedConfig(workspace, global);
    try {
      const result = await applyAutomationSettingsV1(SUPERVISED_SETTINGS_V1);
      assert.equal(result.removedOverrides, 1);
      assert.deepEqual(result.notApplied, []);
      assert.equal(workspace.autoAdvanceEnabled, undefined);
      for (const [key, value] of SUPERVISED_SETTINGS_V1) assert.equal(global[key], value, key);
    } finally {
      stub.restore();
    }
  });

  void it("Unattended removes a workspace 'off' that would block it", async () => {
    const workspace: Record<string, unknown> = { autoReviewAfterImplementation: "off" };
    const global: Record<string, unknown> = {};
    const stub = installScopedConfig(workspace, global);
    try {
      const result = await applyAutomationSettingsV1(UNATTENDED_SETTINGS_V1);
      assert.equal(result.removedOverrides, 1);
      assert.deepEqual(result.notApplied, []);
    } finally {
      stub.restore();
    }
  });

  void it("a failed write puts every setting back, so Supervised is never left half unattended", async () => {
    const unattended = Object.fromEntries(UNATTENDED_SETTINGS_V1.map(([key, value]) => [key, value]));
    const global: Record<string, unknown> = { ...unattended };
    const workspace: Record<string, unknown> = { autoAdvanceEnabled: "auto-fast-forward" };
    const stub = installScopedConfig(workspace, global, undefined, "autoReviewAfterImplementation");
    try {
      const result = await applyAutomationSettingsV1(SUPERVISED_SETTINGS_V1);
      assert.match(result.failed ?? "", /read-only/);
      assert.deepEqual(global, unattended, "user settings are exactly as before");
      assert.deepEqual(workspace, { autoAdvanceEnabled: "auto-fast-forward" }, "the workspace override is restored too");
    } finally {
      stub.restore();
    }
  });

  void it("a failed rollback is reported, key by key, instead of claiming nothing changed", async () => {
    const unattended = Object.fromEntries(UNATTENDED_SETTINGS_V1.map(([key, value]) => [key, value]));
    const global: Record<string, unknown> = { ...unattended };
    // The first key is written "off", the second write fails, and putting the
    // first key back fails as well.
    const stub = installScopedConfig({}, global, undefined, "autoReviewAfterImplementation", "autoReviewAfterPlan");
    try {
      const result = await applyAutomationSettingsV1(SUPERVISED_SETTINGS_V1);
      assert.match(result.failed ?? "", /read-only/);
      assert.equal(global.autoReviewAfterPlan, "off");
      assert.equal(result.notRestored?.length, 1);
      assert.match(result.notRestored?.[0] ?? "", /ensemble\.autoReviewAfterPlan in user settings is now "off", was "auto-fast-forward"/);
    } finally {
      stub.restore();
    }
  });

  void it("reports a key whose effective value did not change instead of claiming success", async () => {
    const stub = installScopedConfig({}, { autoAdvanceEnabled: "off" }, "autoAdvanceEnabled");
    try {
      const result = await applyAutomationSettingsV1(UNATTENDED_SETTINGS_V1);
      assert.deepEqual(result.notApplied, ["autoAdvanceEnabled"]);
    } finally {
      stub.restore();
    }
  });
});
