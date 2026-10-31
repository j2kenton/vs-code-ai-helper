/**
 * bugs3 Step 5: the oversized-prompt Kimi config offer is one chat decision per
 * task, and only its consent option can reach the config; declining or leaving
 * it open writes nothing.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import * as vscode from "vscode";

import {
  KIMI_READ_CONFIG_OFFER_KEY_V1,
  offerKimiReadConfigInChatV1,
  resetKimiReadConfigOfferStateV1,
  SET_KIMI_READ_MAX_CHARS_COMMAND_V1,
} from "../commands/kimiReadConfigOfferV1";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import { measureKimiPromptV1, resolveKimiReadCapacityV1 } from "../utils/kimiReadCapacityV1";
import { makeOwnedTaskFolder } from "./taskFolderFixture";

const BIG = measureKimiPromptV1(Array.from({ length: 1400 }, () => "y".repeat(99)).join("\n"));
const DEFAULT_2X = resolveKimiReadCapacityV1({ versionOutput: "kimi, version 2.3.2" });

function makeExtensionContext(): vscode.ExtensionContext {
  const backing = new Map<string, unknown>();
  const memento = {
    keys: (): readonly string[] => [...backing.keys()],
    get: <T>(key: string, defaultValue?: T): T | undefined => (backing.has(key) ? (backing.get(key) as T) : defaultValue),
    update: (key: string, value: unknown): Thenable<void> => {
      if (value === undefined) {
        backing.delete(key);
      } else {
        backing.set(key, value);
      }
      return Promise.resolve();
    },
  };
  return {
    subscriptions: [] as vscode.Disposable[],
    extensionUri: vscode.Uri.file("/tasks"),
    workspaceState: memento,
    globalState: memento,
  } as unknown as vscode.ExtensionContext;
}

function installRealFs(): { restore: () => void } {
  const stubFs = vscode.workspace.fs as unknown as Record<string, unknown>;
  const orig = { readFile: stubFs.readFile };
  stubFs.readFile = (uri: vscode.Uri): Promise<Uint8Array> => Promise.resolve(new Uint8Array(fs.readFileSync(uri.fsPath)));
  return {
    restore: (): void => {
      stubFs.readFile = orig.readFile;
    },
  };
}

let realFs: { restore: () => void } | undefined;

beforeEach(() => {
  resetKimiReadConfigOfferStateV1();
  realFs = installRealFs();
});

afterEach(() => {
  realFs?.restore();
  __extensionContextV1TestOnly.reset();
});

void describe("offerKimiReadConfigInChatV1 (bugs3 Step 5)", () => {
  void it("posts one consent card per task; a second oversized prompt does not repeat it", async () => {
    const fixture = makeOwnedTaskFolder("kimiOffer-once-");
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    const target = { taskFolderPath: fixture.folder, canonicalId: fixture.folder, stage: "impl" as const };

    assert.equal(await offerKimiReadConfigInChatV1(target, DEFAULT_2X, BIG), true);
    assert.equal(await offerKimiReadConfigInChatV1(target, DEFAULT_2X, BIG), false);

    const store = new WorkflowDecisionStoreV1(context.workspaceState);
    const cards = store.listPending(fixture.folder).filter((d) => d.decisionKey === KIMI_READ_CONFIG_OFFER_KEY_V1);
    assert.equal(cards.length, 1);
  });

  void it("offers again for a different task", async () => {
    const first = makeOwnedTaskFolder("kimiOffer-a-");
    const second = makeOwnedTaskFolder("kimiOffer-b-");
    __extensionContextV1TestOnly.set(makeExtensionContext());
    assert.equal(
      await offerKimiReadConfigInChatV1({ taskFolderPath: first.folder, canonicalId: first.folder, stage: "impl" }, DEFAULT_2X, BIG),
      true
    );
    assert.equal(
      await offerKimiReadConfigInChatV1({ taskFolderPath: second.folder, canonicalId: second.folder, stage: "impl" }, DEFAULT_2X, BIG),
      true
    );
  });

  void it("only the consent option reaches the config command; declining is a no-op with a plain consequence", async () => {
    const fixture = makeOwnedTaskFolder("kimiOffer-options-");
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    const target = { taskFolderPath: fixture.folder, canonicalId: fixture.folder, stage: "impl" as const };
    await offerKimiReadConfigInChatV1(target, DEFAULT_2X, BIG);

    const card = new WorkflowDecisionStoreV1(context.workspaceState)
      .listPending(fixture.folder)
      .find((d) => d.decisionKey === KIMI_READ_CONFIG_OFFER_KEY_V1);
    assert.ok(card);
    const consent = card.options.find((o) => o.optionId === "setKimiReadMaxChars");
    const decline = card.options.find((o) => o.optionId === "keepKimiDefault");
    assert.deepEqual(consent?.effect, { kind: "command", command: SET_KIMI_READ_MAX_CHARS_COMMAND_V1 });
    assert.deepEqual(decline?.effect, { kind: "doNothing" });
    assert.match(consent?.consequence ?? "", /all of your Kimi sessions/);
    assert.match(decline?.consequence ?? "", /Changes nothing/);
    assert.equal(card.recommendation.kind, "none", "the choice is the owner's: nothing is pre-selected");
    assert.equal(card.gating?.holdsTaskPaused, false);
  });

  void it("posts nothing where raising the setting could not help", async () => {
    const fixture = makeOwnedTaskFolder("kimiOffer-none-");
    __extensionContextV1TestOnly.set(makeExtensionContext());
    const target = { taskFolderPath: fixture.folder, canonicalId: fixture.folder, stage: "impl" as const };
    const alreadySet = resolveKimiReadCapacityV1({ versionOutput: "kimi, version 2.3.2", configToml: "[read]\ndefault_max_chars = 500000\n" });
    assert.equal(await offerKimiReadConfigInChatV1(target, alreadySet, BIG), false);
    assert.equal(await offerKimiReadConfigInChatV1(target, resolveKimiReadCapacityV1({ versionOutput: "0.29.2" }), BIG), false);
  });
});
