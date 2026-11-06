import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import {
  getEnabledProviders,
  isModelProviderEnabled,
  migrateEnabledProvidersForExistingModels,
} from "../config/settings";
import {
  OPENCODE_GO_ACCOUNT_ID,
  OPENCODE_ZEN_ACCOUNT_ID,
  PROVIDER_ACCOUNT_ENTRIES,
  providerAccountIdForModelId,
} from "../runners/providers";
import { __testOnly, getAvailableModels, openCodeConnectedProviderLabelV1 } from "../utils/modelSelection";

function installEnabledProviders(
  enabledProviders: Record<string, boolean> | undefined,
  modelSettings: Record<string, unknown> = {}
): { restore: () => void; updates: Array<{ key: string; value: unknown }> } {
  const workspace = vscode.workspace as unknown as Record<string, unknown>;
  const original = workspace.getConfiguration;
  const updates: Array<{ key: string; value: unknown }> = [];
  workspace.getConfiguration = (): unknown => ({
    get: (key: string, defaultValue?: unknown): unknown =>
      key === "enabledProviders" ? (enabledProviders ?? defaultValue) : key === "modelSettings" ? modelSettings : defaultValue,
    inspect: () => undefined,
    update: (key: string, value: unknown): Promise<void> => {
      updates.push({ key, value });
      return Promise.resolve();
    },
  });
  return { restore: (): void => { workspace.getConfiguration = original; }, updates };
}

async function openCodePickerIds(
  discovered: ReadonlyArray<{ model: string; name: string }>,
  includeModelDisabled = false
): Promise<Array<{ id: string; providerLabel?: string }>> {
  __testOnly.resetCliModelCache();
  __testOnly.setModelSelectionTestOverrides({
    getAvailableCopilotModels: () => Promise.resolve([]),
    cliCommandExists: (name) => Promise.resolve(name === "opencode"),
    getDiscoveredCliModels: (def) => Promise.resolve(def.id === "opencode-cli" ? discovered : []),
  });
  try {
    return (await getAvailableModels(includeModelDisabled))
      .filter((m) => m.id.startsWith("opencode-cli:"))
      .map((m) => ({ id: m.id, providerLabel: m.providerLabel }));
  } finally {
    __testOnly.clearModelSelectionTestOverrides();
    __testOnly.resetCliModelCache();
    __testOnly.restoreSeededCliModelCache();
  }
}

const DISCOVERED = [
  { model: "opencode/glm-5.3-flash", name: "GLM Flash" },
  { model: "opencode-go/kimi-k3", name: "Kimi K3" },
  { model: "anthropic/claude-opus-5-5", name: "Claude Opus 5.5" },
  { model: "anthropic/claude-haiku-5-5", name: "Claude Haiku 5.5" },
];

void describe("OpenCode connected providers (models from the owner's own provider keys)", () => {
  void it("gives them their own account, separate from Zen and Go", () => {
    const id = "opencode-cli:anthropic/claude-opus-5-5@high";
    assert.equal(providerAccountIdForModelId(id), "opencode-cli");
    assert.notEqual(providerAccountIdForModelId(id), OPENCODE_ZEN_ACCOUNT_ID);
    assert.notEqual(providerAccountIdForModelId(id), OPENCODE_GO_ACCOUNT_ID);
    assert.equal(providerAccountIdForModelId("opencode-cli:opencode-go/kimi-k3"), OPENCODE_GO_ACCOUNT_ID);
  });

  void it("has a Provider Selection row, off by default", () => {
    const row = PROVIDER_ACCOUNT_ENTRIES.find((entry) => entry.id === "opencode-cli");
    assert.ok(row, "the row exists");
    assert.equal(row.enabledByDefault, false);
    assert.match(row.label, /other connected providers/);
  });

  void it("lists discovered connected-provider models under their provider when the row is on", async () => {
    const settings = installEnabledProviders({ "opencode-zen": true, "opencode-go": true, "opencode-cli": true });
    try {
      const models = await openCodePickerIds(DISCOVERED);
      const opus = models.find((m) => m.id === "opencode-cli:anthropic/claude-opus-5-5");
      assert.ok(opus, "the discovered Anthropic model is offered");
      assert.equal(opus.providerLabel, "OpenCode · Anthropic (your own key)");
      assert.ok(models.some((m) => m.id === "opencode-cli:opencode/glm-5.3-flash"), "Zen still listed");
    } finally {
      settings.restore();
    }
  });

  void it("hides them while the row is off, even with Zen and Go on", async () => {
    const settings = installEnabledProviders({ "opencode-zen": true, "opencode-go": true, "opencode-cli": false });
    try {
      assert.equal(isModelProviderEnabled("opencode-cli:anthropic/claude-opus-5-5"), false);
      const models = await openCodePickerIds(DISCOVERED);
      assert.ok(!models.some((m) => m.id.startsWith("opencode-cli:anthropic/")));
      assert.ok(models.some((m) => m.id.startsWith("opencode-cli:opencode-go/")), "Go unaffected");
    } finally {
      settings.restore();
    }
  });

  void it("lists them with only the connected-providers row on (Zen and Go off)", async () => {
    const settings = installEnabledProviders({ "opencode-zen": false, "opencode-go": false, "opencode-cli": true });
    try {
      const models = await openCodePickerIds(DISCOVERED);
      assert.ok(models.some((m) => m.id === "opencode-cli:anthropic/claude-opus-5-5"), "Anthropic offered");
      assert.ok(!models.some((m) => m.id.startsWith("opencode-cli:opencode/")), "Zen stays off");
      assert.ok(!models.some((m) => m.id.startsWith("opencode-cli:opencode-go/")), "Go stays off");
    } finally {
      settings.restore();
    }
  });

  void it("never reads the pre-split single OpenCode checkbox as this row", async () => {
    const settings = installEnabledProviders({ "opencode-cli": true });
    try {
      assert.equal(getEnabledProviders()["opencode-cli"], false, "the row reads as off");
      assert.equal(getEnabledProviders()["opencode-zen"], true, "it still means Zen");
      assert.equal(getEnabledProviders()["opencode-go"], true, "and Go");
      const models = await openCodePickerIds(DISCOVERED);
      assert.ok(!models.some((m) => m.id.startsWith("opencode-cli:anthropic/")), "not offered in the picker");
      assert.equal(
        isModelProviderEnabled("opencode-cli:anthropic/claude-opus-5-5@high"),
        true,
        "a model already saved under the old checkbox keeps running, as before"
      );
    } finally {
      settings.restore();
    }
  });

  void it("first-run migration of a stored connected-provider model writes Zen and Go explicitly", async () => {
    const settings = installEnabledProviders(undefined, {
      impl: { primary: "opencode-cli:anthropic/claude-opus-5-5@high" },
    });
    try {
      await migrateEnabledProvidersForExistingModels();
      const written = settings.updates.find((u) => u.key === "enabledProviders")?.value as Record<string, boolean>;
      assert.deepEqual(written, { "opencode-cli": true, "opencode-zen": false, "opencode-go": false });
    } finally {
      settings.restore();
    }
  });

  void it("names unknown namespaces as written", () => {
    assert.equal(openCodeConnectedProviderLabelV1("openai/gpt-6-sol"), "OpenCode · OpenAI (your own key)");
    assert.equal(openCodeConnectedProviderLabelV1("acme/model-1"), "OpenCode · acme (your own key)");
  });
});
