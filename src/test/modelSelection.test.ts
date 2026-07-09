import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  __testOnly,
  getAvailableModels,
  type SelectableModel,
} from "../utils/modelSelection";

function antigravityModels(
  models: readonly SelectableModel[]
): SelectableModel[] {
  return models.filter(
    (model) => model.providerLabel === "Antigravity CLI (subscription CLI)"
  );
}

void describe("getAvailableModels", () => {
  void it("prefers discovered Antigravity models over stale fallback entries", async () => {
    __testOnly.resetCliModelCache();
    __testOnly.setModelSelectionTestOverrides({
      getAvailableCopilotModels() {
        return Promise.resolve([]);
      },
      cliCommandExists(command) {
        return Promise.resolve(command === "agy");
      },
      getDiscoveredCliModels(def) {
        if (def.id !== "antigravity-cli") {
          return Promise.resolve([]);
        }
        return Promise.resolve([
          { model: "gemini-3-pro", name: "Gemini 3 Pro" },
          { model: "gemini-3-flash", name: "Gemini 3 Flash" },
        ]);
      },
    });

    try {
      const models = antigravityModels(await getAvailableModels());
      assert.deepStrictEqual(models, [
        {
          id: "antigravity-cli:default",
          name: "Antigravity (CLI default)",
          providerLabel: "Antigravity CLI (subscription CLI)",
        },
        {
          id: "antigravity-cli:gemini-3-pro",
          name: "Gemini 3 Pro",
          providerLabel: "Antigravity CLI (subscription CLI)",
        },
        {
          id: "antigravity-cli:gemini-3-flash",
          name: "Gemini 3 Flash",
          providerLabel: "Antigravity CLI (subscription CLI)",
        },
      ]);
    } finally {
      __testOnly.clearModelSelectionTestOverrides();
      __testOnly.resetCliModelCache();
    }
  });

  void it("uses Antigravity fallback entries when discovery returns nothing", async () => {
    __testOnly.resetCliModelCache();
    __testOnly.setModelSelectionTestOverrides({
      getAvailableCopilotModels() {
        return Promise.resolve([]);
      },
      cliCommandExists(command) {
        return Promise.resolve(command === "agy");
      },
      getDiscoveredCliModels() {
        return Promise.resolve([]);
      },
    });

    try {
      const models = antigravityModels(await getAvailableModels());
      assert.deepStrictEqual(models, [
        {
          id: "antigravity-cli:default",
          name: "Antigravity (CLI default)",
          providerLabel: "Antigravity CLI (subscription CLI)",
        },
      ]);
    } finally {
      __testOnly.clearModelSelectionTestOverrides();
      __testOnly.resetCliModelCache();
    }
  });
});
