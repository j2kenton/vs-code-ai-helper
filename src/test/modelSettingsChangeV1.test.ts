import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cancelLocalModelSettingsWriteV1,
  changedModelSettingStagesV1,
  consumeLocalModelSettingsWriteV1,
  markLocalModelSettingsWriteV1,
  modelSettingsFingerprintV1,
} from "../utils/modelSettingsChangeV1";
import { ModelSettings } from "../utils/modelFallback";

void describe("model settings change notices", () => {
  const before: ModelSettings = {
    impl: { primary: "antigravity-cli:one", backups: ["codex-cli:backup"], backupsEnabled: [true], strategy: "switch-to-backup" },
    "impl-high-review": { primary: "copilot:review", strategy: "never-switch" },
  };

  void it("compares normalized stage chains and coalesces changed stages", () => {
    assert.deepEqual(changedModelSettingStagesV1(before, {
      ...before,
      impl: { ...before.impl, primary: "antigravity-cli:two", strategy: "switch-to-backup" },
      "impl-high-review": { primary: "copilot:other", strategy: "never-switch" },
    }), ["impl", "impl-high-review"]);
    assert.deepEqual(changedModelSettingStagesV1(before, before), []);
    assert.equal(modelSettingsFingerprintV1(before), modelSettingsFingerprintV1({
      ...before,
      impl: { ...before.impl, backup: "codex-cli:backup", backups: ["codex-cli:backup"], strategy: "switch-to-backup" },
    }));
  });

  void it("suppresses only the matching local write and preserves overlapping external changes", () => {
    const local: ModelSettings = { ...before, impl: { ...before.impl, primary: "antigravity-cli:local", strategy: "switch-to-backup" } };
    const fingerprint = markLocalModelSettingsWriteV1(local);
    assert.equal(consumeLocalModelSettingsWriteV1(local), true);
    assert.equal(consumeLocalModelSettingsWriteV1(local), false);
    assert.equal(changedModelSettingStagesV1(before, local).length, 1);

    const pending = markLocalModelSettingsWriteV1(local);
    const overlap: ModelSettings = { ...local, "impl-high-review": { primary: "copilot:external", strategy: "never-switch" } };
    assert.equal(consumeLocalModelSettingsWriteV1(overlap), false);
    assert.deepEqual(changedModelSettingStagesV1(before, overlap), ["impl", "impl-high-review"]);
    cancelLocalModelSettingsWriteV1(pending);
    assert.equal(consumeLocalModelSettingsWriteV1(local), false);
    assert.equal(typeof fingerprint, "string");
  });
});
