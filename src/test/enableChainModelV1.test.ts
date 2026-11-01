/**
 * bugs4 Step 32 (item 31, plan item 66): switching a configured-but-switched-off chain model back
 * on, as the "Enable <model> and rerun the fix" card option does. Pure edits of a copy.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import { enableChainModelV1, partitionSwitchedOffBackupsByReadinessV1 } from "../utils/enableChainModelV1";

const chain = {
  primary: "antigravity-cli:claude-sonnet-5-5-high",
  backups: ["devpass-cli:llmgateway-devpass/claude-sonnet-5-5@high", "codex-cli:gpt-6.1-terra@high"],
  backupsEnabled: [true, false],
  strategy: "switch-to-backup" as const,
};

void describe("enableChainModelV1", () => {
  void it("switches on the switched-off backup the label names, and nothing else", () => {
    const result = enableChainModelV1(chain, "gpt-6.1-terra@high");
    assert.equal(result.kind, "enabled");
    if (result.kind !== "enabled") return;
    assert.equal(result.row, "backup");
    assert.equal(result.modelId, "codex-cli:gpt-6.1-terra@high");
    // Every row is on now, so the flags are dropped rather than stored as all-true.
    assert.equal(result.setting.backupsEnabled, undefined);
    assert.deepEqual(result.setting.backups, chain.backups);
    assert.equal(result.setting.primary, chain.primary);
    assert.deepEqual(chain.backupsEnabled, [true, false], "the input setting is not mutated");
  });

  void it("matches a provider-prefixed chain label and keeps other switched-off rows off", () => {
    const result = enableChainModelV1({ ...chain, backupsEnabled: [false, false] }, "devpass-code llmgateway-devpass/claude-sonnet-5-5@high");
    assert.equal(result.kind, "enabled");
    if (result.kind !== "enabled") return;
    assert.deepEqual(result.setting.backupsEnabled, [true, false]);
  });

  void it("switches on a switched-off primary", () => {
    const result = enableChainModelV1({ ...chain, primaryEnabled: false }, "antigravity-cli:claude-sonnet-5-5-high");
    assert.equal(result.kind, "enabled");
    if (result.kind !== "enabled") return;
    assert.equal(result.row, "primary");
    assert.equal(result.setting.primaryEnabled, undefined);
  });

  void it("a row that is already on is reported, not changed: the cause lies outside the row flag", () => {
    assert.equal(enableChainModelV1(chain, "devpass-code llmgateway-devpass/claude-sonnet-5-5@high").kind, "already-enabled");
  });

  void it("an unknown label or no setting is not-found", () => {
    assert.equal(enableChainModelV1(chain, "nothing@high").kind, "not-found");
    assert.equal(enableChainModelV1(undefined, "gpt-6.1-terra@high").kind, "not-found");
  });
});

void describe("partitionSwitchedOffBackupsByReadinessV1 (plan item 66)", () => {
  void it("offers only a switched-off backup whose provider is ready, and gives the reason for the others", async () => {
    const probed: string[] = [];
    const result = await partitionSwitchedOffBackupsByReadinessV1(chain, ["gpt-6.1-terra@high"], (modelId) => {
      probed.push(modelId);
      return Promise.resolve({ ready: true });
    });
    assert.deepEqual(probed, ["codex-cli:gpt-6.1-terra@high"]);
    assert.deepEqual(result.ready, ["gpt-6.1-terra@high"]);
    assert.deepEqual(result.notReady, []);

    const notSignedIn = await partitionSwitchedOffBackupsByReadinessV1(chain, ["gpt-6.1-terra@high"], () =>
      Promise.resolve({ ready: false, reason: "Codex: not signed in" })
    );
    assert.deepEqual(notSignedIn.ready, []);
    assert.deepEqual(notSignedIn.notReady, [{ label: "gpt-6.1-terra@high", reason: "Codex: not signed in" }]);
  });

  void it("treats a probe error, an already-on row and an unknown label as not ready, never as ready", async () => {
    const throwing = await partitionSwitchedOffBackupsByReadinessV1(chain, ["gpt-6.1-terra@high"], () => Promise.reject(new Error("boom")));
    assert.deepEqual(throwing.ready, []);
    assert.match(throwing.notReady[0]?.reason ?? "", /could not be checked \(boom\)/);
    let probeCalls = 0;
    const probe = (): Promise<{ ready: boolean }> => {
      probeCalls += 1;
      return Promise.resolve({ ready: true });
    };
    const others = await partitionSwitchedOffBackupsByReadinessV1(
      chain,
      ["devpass-code llmgateway-devpass/claude-sonnet-5-5@high", "nothing@high"],
      probe
    );
    assert.deepEqual(others.ready, []);
    assert.equal(others.notReady.length, 2);
    assert.equal(probeCalls, 0, "a row that is not a switched-off one is never probed");
  });
});
