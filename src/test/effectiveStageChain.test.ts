import * as assert from "node:assert/strict";
import * as os from "node:os";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import {
  GENERAL_MODEL_STAGE,
  buildResolvedModelSnapshotV1,
  resolveEffectiveStageChainV1,
  resolveModelForStage,
} from "../utils/modelSelection";
import { normalizeBackupChain } from "../utils/modelFallback";
import { getModelSettings, setModelSettings } from "../config/settings";
import {
  backupModelsForStage,
  getConfiguredBackupModelsForStage,
} from "../runners/runnerRegistry";

/**
 * Config stub in the same shape the other settings tests use: `get` answers
 * modelSettings/aiModelDefaults (plus anything in `extra`), `inspect` stays
 * undefined so explicit-value precedence and the provider-selection guard
 * stay inactive. `updates` records configuration writes for round-trip tests.
 */
function installConfig(
  raw: {
    modelSettings?: Record<string, unknown>;
    aiModelDefaults?: Record<string, unknown>;
    extra?: Record<string, unknown>;
  }
): { restore: () => void; updates: Array<{ key: string; value: unknown }> } {
  const updates: Array<{ key: string; value: unknown }> = [];
  const original = (vscode.workspace as unknown as Record<string, unknown>).getConfiguration;
  (vscode.workspace as unknown as Record<string, unknown>).getConfiguration = (): {
    get: (key: string, defaultValue?: unknown) => unknown;
    inspect: () => undefined;
    update: (key: string, value: unknown) => Promise<void>;
  } => ({
    get: (key: string, defaultValue?: unknown): unknown =>
      key === "modelSettings"
        ? (raw.modelSettings ?? defaultValue)
        : key === "aiModelDefaults"
          ? (raw.aiModelDefaults ?? defaultValue)
          : raw.extra && key in raw.extra
            ? raw.extra[key]
            : defaultValue,
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

void describe("resolveEffectiveStageChainV1 — tier order", () => {
  void it("uses the stage's own chain when it has an enabled primary", () => {
    const stub = installConfig({
      modelSettings: {
        impl: { primary: "codex-cli:gpt-5", backups: ["claude-cli:sonnet"], strategy: "switch-to-backup" },
        desc: { primary: "gemini-cli:default", strategy: "alert-and-wait" },
      },
    });
    try {
      const chain = resolveEffectiveStageChainV1("impl");
      assert.equal(chain.source, "stage");
      assert.equal(chain.originStage, "impl");
      assert.equal(chain.primary, "codex-cli:gpt-5");
      assert.deepEqual(chain.backups, ["claude-cli:sonnet"]);
      assert.equal(chain.strategy, "switch-to-backup");
    } finally {
      stub.restore();
    }
  });

  void it("falls back to the general (desc) chain — backups AND strategy included — for a blank stage", () => {
    const stub = installConfig({
      modelSettings: {
        desc: {
          primary: "gemini-cli:default",
          backups: ["claude-cli:sonnet", "codex-cli:gpt-5"],
          strategy: "switch-to-backup",
        },
      },
    });
    try {
      const chain = resolveEffectiveStageChainV1("impl");
      assert.equal(chain.source, "general");
      assert.equal(chain.originStage, GENERAL_MODEL_STAGE);
      assert.equal(chain.primary, "gemini-cli:default");
      assert.deepEqual(chain.backups, ["claude-cli:sonnet", "codex-cli:gpt-5"]);
      assert.equal(chain.strategy, "switch-to-backup");
    } finally {
      stub.restore();
    }
  });

  void it("reports source none when neither the stage nor the general model is configured", () => {
    const stub = installConfig({ modelSettings: {} });
    try {
      const chain = resolveEffectiveStageChainV1("impl");
      assert.equal(chain.source, "none");
      assert.equal(chain.originStage, "impl");
      assert.equal(chain.primary, undefined);
      assert.deepEqual(chain.backups, []);
    } finally {
      stub.restore();
    }
  });

  void it("treats the general stage's own chain as source stage, not general", () => {
    const stub = installConfig({
      modelSettings: { desc: { primary: "gemini-cli:default", strategy: "alert-and-wait" } },
    });
    try {
      const chain = resolveEffectiveStageChainV1(GENERAL_MODEL_STAGE);
      assert.equal(chain.source, "stage");
      assert.equal(chain.originStage, GENERAL_MODEL_STAGE);
    } finally {
      stub.restore();
    }
  });
});

void describe("resolveEffectiveStageChainV1 — skip filtering", () => {
  void it("drops disabled backups while keeping order", () => {
    const stub = installConfig({
      modelSettings: {
        impl: {
          primary: "codex-cli:gpt-5",
          backups: ["a-cli:one", "b-cli:two", "c-cli:three"],
          backupsEnabled: [true, false, true],
          strategy: "switch-to-backup",
        },
      },
    });
    try {
      const chain = resolveEffectiveStageChainV1("impl");
      assert.deepEqual(chain.backups, ["a-cli:one", "c-cli:three"]);
    } finally {
      stub.restore();
    }
  });

  void it("promotes the first ENABLED backup when the primary is skipped, keeping the rest in order", () => {
    const stub = installConfig({
      modelSettings: {
        impl: {
          primary: "codex-cli:gpt-5",
          primaryEnabled: false,
          backups: ["a-cli:one", "b-cli:two", "c-cli:three"],
          backupsEnabled: [false, true, true],
          strategy: "switch-to-backup",
        },
      },
    });
    try {
      const chain = resolveEffectiveStageChainV1("impl");
      assert.equal(chain.source, "stage", "an own chain with an enabled backup must not fall to general");
      assert.equal(chain.primary, "b-cli:two");
      assert.deepEqual(chain.backups, ["c-cli:three"]);
    } finally {
      stub.restore();
    }
  });

  void it("falls through to the general model when every row of the stage's chain is skipped", () => {
    const stub = installConfig({
      modelSettings: {
        impl: {
          primary: "codex-cli:gpt-5",
          primaryEnabled: false,
          backups: ["a-cli:one"],
          backupsEnabled: [false],
          strategy: "switch-to-backup",
        },
        desc: { primary: "gemini-cli:default", strategy: "alert-and-wait" },
      },
    });
    try {
      const chain = resolveEffectiveStageChainV1("impl");
      assert.equal(chain.source, "general");
      assert.equal(chain.primary, "gemini-cli:default");
    } finally {
      stub.restore();
    }
  });

  void it("reports none when the stage is fully skipped and the general chain is fully skipped too", () => {
    const stub = installConfig({
      modelSettings: {
        impl: { primary: "codex-cli:gpt-5", primaryEnabled: false, strategy: "alert-and-wait" },
        desc: { primary: "gemini-cli:default", primaryEnabled: false, strategy: "alert-and-wait" },
      },
    });
    try {
      assert.equal(resolveEffectiveStageChainV1("impl").source, "none");
    } finally {
      stub.restore();
    }
  });
});

void describe("resolveEffectiveStageChainV1 — clear semantics vs legacy defaults", () => {
  void it("an explicitly cleared stage (empty modelSettings entry) suppresses its legacy aiModelDefaults value", () => {
    const stub = installConfig({
      modelSettings: {
        impl: { backups: [], strategy: "alert-and-wait" },
        desc: { primary: "gemini-cli:default", strategy: "alert-and-wait" },
      },
      aiModelDefaults: { impl: "codex-cli:legacy-model" },
    });
    try {
      const chain = resolveEffectiveStageChainV1("impl");
      assert.equal(chain.source, "general", "the cleared model must not be resurrected from aiModelDefaults");
      assert.equal(chain.primary, "gemini-cli:default");
    } finally {
      stub.restore();
    }
  });

  void it("a never-configured stage still receives its legacy aiModelDefaults value as its own chain", () => {
    const stub = installConfig({
      modelSettings: { desc: { primary: "gemini-cli:default", strategy: "alert-and-wait" } },
      aiModelDefaults: { impl: "codex-cli:legacy-model" },
    });
    try {
      const chain = resolveEffectiveStageChainV1("impl");
      assert.equal(chain.source, "stage");
      assert.equal(chain.primary, "codex-cli:legacy-model");
    } finally {
      stub.restore();
    }
  });

  void it("clearing the primary with backups remaining promotes the first backup (stage does not fall to general)", () => {
    const stub = installConfig({
      modelSettings: {
        impl: { backups: ["a-cli:one", "b-cli:two"], strategy: "switch-to-backup" },
        desc: { primary: "gemini-cli:default", strategy: "alert-and-wait" },
      },
    });
    try {
      const chain = resolveEffectiveStageChainV1("impl");
      assert.equal(chain.source, "stage");
      assert.equal(chain.primary, "a-cli:one");
      assert.deepEqual(chain.backups, ["b-cli:two"]);
    } finally {
      stub.restore();
    }
  });

  void it("a promoted backup carries its own enabled flag: a skipped first backup is passed over", () => {
    const stub = installConfig({
      modelSettings: {
        impl: {
          backups: ["a-cli:one", "b-cli:two"],
          backupsEnabled: [false, true],
          strategy: "switch-to-backup",
        },
        desc: { primary: "gemini-cli:default", strategy: "alert-and-wait" },
      },
    });
    try {
      const chain = resolveEffectiveStageChainV1("impl");
      assert.equal(chain.source, "stage");
      assert.equal(chain.primary, "b-cli:two");
    } finally {
      stub.restore();
    }
  });
});

void describe("normalizeBackupChain — index alignment", () => {
  void it("keeps flags index-aligned through a dedup: the dropped duplicate's flag is dropped with it", () => {
    const result = normalizeBackupChain(
      ["a-cli:one", "b-cli:two", "a-cli:one"],
      [true, false, true]
    );
    assert.deepEqual(result.backups, ["a-cli:one", "b-cli:two"]);
    assert.deepEqual(result.backupsEnabled, [true, false]);
  });

  void it("keeps flags aligned when an empty entry is dropped mid-list", () => {
    const result = normalizeBackupChain(["a-cli:one", "  ", "b-cli:two"], [true, true, false]);
    assert.deepEqual(result.backups, ["a-cli:one", "b-cli:two"]);
    assert.deepEqual(result.backupsEnabled, [true, false]);
  });

  void it("treats missing flag indexes as enabled and omits backupsEnabled when every row is enabled", () => {
    const result = normalizeBackupChain(["a-cli:one", "b-cli:two"], [true]);
    assert.deepEqual(result.backups, ["a-cli:one", "b-cli:two"]);
    assert.equal(result.backupsEnabled, undefined);
  });

  void it("caps the chain at 10 with flags truncated in lock-step", () => {
    const backups = Array.from({ length: 12 }, (_, i) => `p-cli:m${i}`);
    const flags = backups.map((_, i) => i !== 11);
    const result = normalizeBackupChain(backups, flags);
    assert.equal(result.backups.length, 10);
    assert.equal(
      result.backupsEnabled,
      undefined,
      "the only disabled row (index 11) is beyond the cap, so all surviving rows are enabled"
    );
  });
});

void describe("getModelSettings / setModelSettings — extended shape round trip", () => {
  void it("reads primaryEnabled and index-aligned backupsEnabled from stored settings", () => {
    const stub = installConfig({
      modelSettings: {
        impl: {
          primary: "codex-cli:gpt-5",
          primaryEnabled: false,
          backups: ["a-cli:one", "a-cli:one", "b-cli:two"],
          backupsEnabled: [false, true, true],
          strategy: "switch-to-backup",
        },
      },
    });
    try {
      const settings = getModelSettings();
      assert.equal(settings.impl?.primaryEnabled, false);
      assert.deepEqual(settings.impl?.backups, ["a-cli:one", "b-cli:two"]);
      assert.deepEqual(settings.impl?.backupsEnabled, [false, true]);
    } finally {
      stub.restore();
    }
  });

  void it("saves skip flags only when they say something and mirrors backup to backups[0]", async () => {
    const stub = installConfig({ modelSettings: {} });
    try {
      await setModelSettings({
        impl: {
          primary: "codex-cli:gpt-5",
          backups: ["a-cli:one", "b-cli:two"],
          backupsEnabled: [true, false],
          strategy: "switch-to-backup",
        },
        plan: {
          primary: "codex-cli:gpt-5",
          backups: ["a-cli:one"],
          backupsEnabled: [true],
          strategy: "alert-and-wait",
        },
      });
      const written = stub.updates.find((u) => u.key === "modelSettings")?.value as Record<
        string,
        { backup?: string; backups?: string[]; backupsEnabled?: boolean[]; primaryEnabled?: boolean }
      >;
      assert.ok(written);
      assert.deepEqual(written.impl?.backupsEnabled, [true, false]);
      assert.equal(written.impl?.backup, "a-cli:one", "legacy backup mirror equals backups[0]");
      assert.equal(written.plan?.backupsEnabled, undefined, "all-enabled flags are not persisted");
      assert.equal(written.impl?.primaryEnabled, undefined, "enabled primary flag is not persisted");
    } finally {
      stub.restore();
    }
  });

  void it("writes an explicitly cleared stage as an empty entry rather than dropping the key", async () => {
    const stub = installConfig({ modelSettings: {} });
    try {
      await setModelSettings({
        impl: { primary: undefined, backup: undefined, backups: [], strategy: "alert-and-wait" },
      });
      const written = stub.updates.find((u) => u.key === "modelSettings")?.value as Record<string, unknown>;
      assert.ok(
        written.impl && typeof written.impl === "object",
        "the cleared stage's key must be written so the legacy-defaults import stays suppressed"
      );
    } finally {
      stub.restore();
    }
  });
});

void describe("buildResolvedModelSnapshotV1 — provenance", () => {
  void it("records general provenance (source/originStage) for a blank stage", () => {
    const stub = installConfig({
      modelSettings: {
        desc: {
          primary: "gemini-cli:default",
          backups: ["claude-cli:sonnet"],
          strategy: "switch-to-backup",
        },
      },
    });
    try {
      const snapshot = buildResolvedModelSnapshotV1();
      assert.equal(snapshot.schemaVersion, 1);
      const impl = snapshot.stages.impl;
      assert.equal(impl?.source, "general");
      assert.equal(impl?.originStage, GENERAL_MODEL_STAGE);
      assert.equal(impl?.primary, "gemini-cli:default");
      assert.deepEqual(impl?.backups, ["claude-cli:sonnet"]);
      assert.equal(impl?.strategy, "switch-to-backup");
      const desc = snapshot.stages.desc;
      assert.equal(desc?.source, "workspace");
      assert.equal(desc?.originStage, GENERAL_MODEL_STAGE);
    } finally {
      stub.restore();
    }
  });

  void it("records source none with an empty chain when nothing is configured anywhere", () => {
    const stub = installConfig({ modelSettings: {} });
    try {
      const snapshot = buildResolvedModelSnapshotV1();
      assert.equal(snapshot.stages.impl?.source, "none");
      assert.deepEqual(snapshot.stages.impl?.backups, []);
    } finally {
      stub.restore();
    }
  });
});

void describe("runnerRegistry — blank stage inherits the general chain", () => {
  void it("backupModelsForStage returns the general chain's backups under its switch-to-backup strategy", () => {
    const stub = installConfig({
      modelSettings: {
        desc: {
          primary: "gemini-cli:default",
          backups: ["claude-cli:sonnet", "codex-cli:gpt-5"],
          strategy: "switch-to-backup",
        },
      },
    });
    try {
      assert.deepEqual(backupModelsForStage("impl", "gemini-cli:default"), [
        "claude-cli:sonnet",
        "codex-cli:gpt-5",
      ]);
    } finally {
      stub.restore();
    }
  });

  void it("backupModelsForStage honors the general chain's non-switch strategy (returns nothing)", () => {
    const stub = installConfig({
      modelSettings: {
        desc: {
          primary: "gemini-cli:default",
          backups: ["claude-cli:sonnet"],
          strategy: "alert-and-wait",
        },
      },
    });
    try {
      assert.deepEqual(backupModelsForStage("impl", "gemini-cli:default"), []);
    } finally {
      stub.restore();
    }
  });

  void it("backupModelsForStage passes over skipped rows in the stage's own chain", () => {
    const stub = installConfig({
      modelSettings: {
        impl: {
          primary: "codex-cli:gpt-5",
          backups: ["a-cli:one", "b-cli:two"],
          backupsEnabled: [false, true],
          strategy: "switch-to-backup",
        },
      },
    });
    try {
      assert.deepEqual(backupModelsForStage("impl", "codex-cli:gpt-5"), ["b-cli:two"]);
    } finally {
      stub.restore();
    }
  });

  void it("getConfiguredBackupModelsForStage inherits the general chain regardless of strategy", () => {
    const stub = installConfig({
      modelSettings: {
        desc: {
          primary: "gemini-cli:default",
          backups: ["claude-cli:sonnet"],
          strategy: "alert-and-wait",
        },
      },
    });
    try {
      assert.deepEqual(getConfiguredBackupModelsForStage("impl", "gemini-cli:default"), [
        "claude-cli:sonnet",
      ]);
    } finally {
      stub.restore();
    }
  });
});

void describe("resolveModelForStage — general fallback (intentional behavior change)", () => {
  void it("a formerly-blank stage now resolves through the general model with source general", async () => {
    const stub = installConfig({
      modelSettings: { desc: { primary: "gemini-cli:default", strategy: "alert-and-wait" } },
    });
    try {
      const resolved = await resolveModelForStage(vscode.Uri.file(os.tmpdir()), "impl", {
        ignoreActiveFallback: true,
      });
      assert.equal(resolved.modelId, "gemini-cli:default");
      assert.equal(resolved.source, "general");
    } finally {
      stub.restore();
    }
  });

  void it("still reports source none when nothing is configured anywhere", async () => {
    const stub = installConfig({ modelSettings: {} });
    try {
      const resolved = await resolveModelForStage(vscode.Uri.file(os.tmpdir()), "impl", {
        ignoreActiveFallback: true,
      });
      assert.equal(resolved.modelId, undefined);
      assert.equal(resolved.source, "none");
    } finally {
      stub.restore();
    }
  });
});
