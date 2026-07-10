import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { isQuotaError } from "../utils/quota";
import { parseReadiness } from "../utils/reviewReadiness";
import { StatusTreeProvider } from "../views/statusView";

const { discoverUnitTests } = createRequire(__filename)("../../test-stubs/run-unit-tests.js") as {
  discoverUnitTests: (root: string) => string[];
};

void describe("Stage 10 test infrastructure", () => {
  void it("discovers nested compiled tests deterministically", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-tests-"));
    fs.mkdirSync(path.join(root, "nested"));
    fs.writeFileSync(path.join(root, "z.test.js"), "");
    fs.writeFileSync(path.join(root, "nested", "a.test.js"), "");
    fs.writeFileSync(path.join(root, "nested", "ignored.js"), "");
    try {
      assert.deepEqual(discoverUnitTests(root), [
        path.join(root, "nested", "a.test.js"),
        path.join(root, "z.test.js"),
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  void it("supports activation tree events and reveal", async () => {
    interface TestTreeView extends vscode.TreeView<object> {
      fireExpand(element: object): void;
      fireCollapse(element: object): void;
      revealed: Array<{
        element: object;
        options: { select?: boolean; focus?: boolean; expand?: boolean | number };
      }>;
    }
    const tree = vscode.window.createTreeView("tasks", {
      treeDataProvider: {} as vscode.TreeDataProvider<object>,
    }) as unknown as TestTreeView;
    let expanded = false;
    let collapsed = false;
    tree.onDidExpandElement(() => { expanded = true; });
    tree.onDidCollapseElement(() => { collapsed = true; });
    const element = {};
    tree.fireExpand(element);
    tree.fireCollapse(element);
    await tree.reveal(element, { select: true });
    assert.equal(expanded, true);
    assert.equal(collapsed, true);
    assert.deepEqual(tree.revealed[0], { element, options: { select: true } });
  });

  void it("executes registered commands and disposes watcher listeners", async () => {
    const id = "test.command";
    const registration = vscode.commands.registerCommand(id, (value: string) => value);
    assert.equal(await vscode.commands.executeCommand(id, "ok"), "ok");
    registration.dispose();
    interface TestWatcher extends vscode.FileSystemWatcher {
      fireChange(uri: vscode.Uri): void;
    }
    const watcher = vscode.workspace.createFileSystemWatcher("**/*.json") as TestWatcher;
    let calls = 0;
    watcher.onDidChange(() => { calls++; });
    watcher.dispose();
    watcher.fireChange(vscode.Uri.file("file.json"));
    assert.equal(calls, 0);
  });

  void it("provides controllable picker and input-box results for command paths", async () => {
    const testWindow = vscode.window as typeof vscode.window & {
      _queueQuickPickResult: (value: unknown) => void;
      _queueInputBoxResult: (value: unknown) => void;
      _clearInteractionQueues: () => void;
    };
    testWindow._clearInteractionQueues();
    testWindow._queueQuickPickResult({ label: "Custom time" });
    testWindow._queueInputBoxResult("14:30");
    assert.deepEqual(await vscode.window.showQuickPick([{ label: "Custom time" }]), { label: "Custom time" });
    assert.equal(await vscode.window.showInputBox({ prompt: "time" }), "14:30");
  });

  void it("covers review readiness, quota classification, and status routing contracts", () => {
    assert.equal(parseReadiness("Readiness: 9/10").icon, "thumbsup");
    assert.equal(parseReadiness("Readiness: 3/10").colorKey, "charts.red");
    assert.equal(isQuotaError("provider rate limit reached"), true);
    assert.equal(isQuotaError("context length exceeded"), false);

    const statuses = new StatusTreeProvider();
    statuses.addEntry("x".repeat(151), "warning");
    assert.equal(statuses.getEntries()[0]?.level, "warning");
    assert.equal(statuses.getEntries()[0]?.message.endsWith("..."), true);
  });
});
