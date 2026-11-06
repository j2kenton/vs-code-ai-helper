import { afterEach, beforeEach, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { recordReviewerVerificationOfTickedItemsV1 } from "../commands/applyReviewerVerifiedTicks";
import { setExtensionContextV1 } from "../utils/extensionContextV1";
import { listCheckedVerificationTargetsV1 } from "../utils/implementationChecklist";
import { makeOwnedTaskFolder } from "./taskFolderFixture";
import { safeRemoveDir } from "./testFsUtils";

// review1 (owner decision 2026-11-05): a reviewer's "Verified Complete" entry that matches more than one checked
// plan item verifies none of them, the chat names the entry, and the items stay as they were.

const reviewNaming = (...names: string[]): string =>
  ["Readiness: 9/10", "", "<!-- verified-complete:start -->", ...names.map((name) => `- ${name}`), "<!-- verified-complete:end -->", ""].join("\n");

const TOP_LEVEL_AND_CHILD = [
  "<!-- ensemble:implementation-checklist -->",
  "",
  "- [x] Step 1: Parent",
  "  - [x] Shared wording",
  "- [x] Shared wording",
  "",
].join("\n");

const TWO_COPIES = [
  "<!-- ensemble:implementation-checklist -->",
  "",
  "- [x] Step 1: Rename the helper",
  "- [x] Rename the helper",
  "- [x] Rename the helper",
  "",
].join("\n");

void describe("listCheckedVerificationTargetsV1 — ambiguity", () => {
  void it("reports an entry that fits a top-level item and a child as ambiguous, with no target", () => {
    const resolved = listCheckedVerificationTargetsV1(TOP_LEVEL_AND_CHILD, ["Shared wording"]);
    assert.deepEqual(resolved.targets, []);
    assert.deepEqual(resolved.ambiguous, [{ text: "Shared wording", matches: 2 }]);
  });

  void it("reports an entry that fits two same-level copies as ambiguous, with no target", () => {
    const resolved = listCheckedVerificationTargetsV1(TWO_COPIES, ["Rename the helper"]);
    assert.deepEqual(resolved.targets, []);
    assert.deepEqual(resolved.ambiguous, [{ text: "Rename the helper", matches: 2 }]);
  });

  void it("resolves an entry that fits exactly one checked item, and ignores an unticked twin", () => {
    const plan = TOP_LEVEL_AND_CHILD.replace("  - [x] Shared wording", "  - [ ] Shared wording");
    const resolved = listCheckedVerificationTargetsV1(plan, ["Shared wording", "Shared wording"]);
    assert.equal(resolved.targets.length, 1);
    assert.equal(resolved.targets[0]?.nested, false);
    assert.deepEqual(resolved.ambiguous, []);
  });

  void it("never fans one entry out to several items", () => {
    const resolved = listCheckedVerificationTargetsV1(TWO_COPIES, ["Step 1: Rename the helper", "Rename the helper"]);
    assert.deepEqual(
      resolved.targets.map((entry) => entry.text),
      ["Step 1: Rename the helper"]
    );
    assert.equal(resolved.ambiguous.length, 1);
  });
});

void describe("recordReviewerVerificationOfTickedItemsV1 — ambiguous entries say so in the chat", () => {
  const roots: string[] = [];
  const fsApi = vscode.workspace.fs as unknown as Record<string, unknown>;
  const original = { ...fsApi };

  beforeEach(() => {
    fsApi.readFile = (uri: vscode.Uri): Promise<Uint8Array> => fs.promises.readFile(uri.fsPath);
    fsApi.writeFile = (uri: vscode.Uri, data: Uint8Array): Promise<void> => fs.promises.writeFile(uri.fsPath, data);
    fsApi.createDirectory = (): Promise<void> => Promise.resolve();
    fsApi.readDirectory = (): Promise<Array<[string, number]>> => Promise.resolve([]);
    fsApi.stat = (uri: vscode.Uri): Promise<unknown> => fs.promises.stat(uri.fsPath);
    const backing = new Map<string, unknown>();
    const memento = {
      get: <T>(key: string, fallback?: T): T => (backing.has(key) ? (backing.get(key) as T) : (fallback as T)),
      update: (key: string, value: unknown): Promise<void> => {
        if (value === undefined) backing.delete(key);
        else backing.set(key, value);
        return Promise.resolve();
      },
      keys: () => [...backing.keys()],
    } as unknown as vscode.Memento;
    setExtensionContextV1({ globalState: memento, workspaceState: memento, subscriptions: [] } as unknown as vscode.ExtensionContext);
  });
  afterEach(() => {
    Object.assign(fsApi, original);
    setExtensionContextV1(undefined as unknown as vscode.ExtensionContext);
    for (const root of roots.splice(0)) safeRemoveDir(root);
  });

  function stage(plan: string, review: string): string {
    const { folder } = makeOwnedTaskFolder("ambiguous-verification-");
    roots.push(path.dirname(path.dirname(folder)));
    const progressPath = path.join(folder, "task-progress.json");
    const progress = JSON.parse(fs.readFileSync(progressPath, "utf8")) as Record<string, unknown>;
    progress.currentStage = "impl-high-review";
    progress.status = "active";
    fs.writeFileSync(progressPath, JSON.stringify(progress));
    fs.writeFileSync(path.join(folder, "plan-final.md"), plan);
    fs.writeFileSync(path.join(folder, "impl-high-review.md"), review);
    return folder;
  }

  const chatTexts = (folder: string): string[] => {
    const file = path.join(folder, "chat-v1.json");
    if (!fs.existsSync(file)) return [];
    return ((JSON.parse(fs.readFileSync(file, "utf8")) as { messages?: Array<{ text: string }> }).messages ?? []).map(
      (message) => message.text
    );
  };
  const evidenceRows = (folder: string): unknown[] =>
    (JSON.parse(fs.readFileSync(path.join(folder, "task-progress.json"), "utf8")) as { planItemEvidence?: unknown[] })
      .planItemEvidence ?? [];

  void it("a same-worded top-level item and child: no verification recorded, one chat line names the entry", async () => {
    const folder = stage(TOP_LEVEL_AND_CHILD, reviewNaming("Shared wording"));
    assert.equal(await recordReviewerVerificationOfTickedItemsV1(vscode.Uri.file(folder), "impl-high-review"), 0);
    assert.deepEqual(evidenceRows(folder), []);
    const lines = chatTexts(folder).filter((text) => /verified none of them/.test(text));
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /"Shared wording" \(matches 2 checked items\)/);
    assert.match(lines[0]!, /step number/);
    assert.match(lines[0]!, /impl-high-review\.md/);
  });

  void it("two same-level copies: no verification recorded, one chat line names the entry", async () => {
    const folder = stage(TWO_COPIES, reviewNaming("Rename the helper"));
    assert.equal(await recordReviewerVerificationOfTickedItemsV1(vscode.Uri.file(folder), "impl-high-review"), 0);
    assert.deepEqual(evidenceRows(folder), []);
    const lines = chatTexts(folder).filter((text) => /verified none of them/.test(text));
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /"Rename the helper" \(matches 2 checked items\)/);
  });

  void it("an unambiguous entry posts no ambiguity line", async () => {
    const folder = stage(TWO_COPIES, reviewNaming("Step 1: Rename the helper"));
    assert.equal(await recordReviewerVerificationOfTickedItemsV1(vscode.Uri.file(folder), "impl-high-review"), 1);
    assert.deepEqual(chatTexts(folder).filter((text) => /verified none of them/.test(text)), []);
  });
});
