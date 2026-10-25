/**
 * Post-1.0 fixes, item 12: while any operation ran, the Notifications tree was
 * fully repainted once a second, re-sending every stored notification (each
 * with its complete message) to the window's UI process — the renderer grew
 * about 2 GB an hour during a long Fix Linting & Code Errors or Publish
 * Checks run. The elapsed-time tick now repaints only the running-operation
 * rows, and a notification's stored text and tooltip are bounded. Report and
 * run-log files are not touched by any of this.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import {
  MAX_STATUS_MESSAGE_CHARS,
  StatusOperationNode,
  StatusTreeNode,
  StatusTreeProvider,
  TOOLTIP_MESSAGE_MAX_CHARS,
} from "../views/statusView";
import { taskOperations } from "../utils/taskOperations";

void describe("Notifications tree payload during a long operation (item 12)", () => {
  void it("the 1 Hz tick repaints only the running-operation rows, never the stored notifications", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    const provider = new StatusTreeProvider();
    // A pile of large notifications, like a long check run leaves behind.
    for (let i = 0; i < 50; i++) {
      provider.addEntry(`Check failure ${i}: ${"x".repeat(15_000)}`, "error");
    }
    const events: unknown[] = [];
    const sub = provider.onDidChangeTreeData((payload) => { events.push(payload); });
    const taskPath = `/dev/renderer_payload_${Math.floor(Math.random() * 1e9)}`;
    try {
      const op = taskOperations.begin(taskPath, { label: "Fix Linting", taskName: "payload_task" });
      assert.ok(op);
      await Promise.resolve();
      // The view asks for its children once, as VS Code does when it renders.
      const children = (provider.getChildren() ?? []) as StatusTreeNode[];
      assert.ok(children.some((node) => "kind" in node && node.kind === "operation"));
      events.length = 0;

      t.mock.timers.tick(1000);
      t.mock.timers.tick(1000);
      t.mock.timers.tick(1000);

      assert.equal(events.length, 3, "one repaint per tick");
      for (const payload of events) {
        assert.ok(Array.isArray(payload), "a tick names the rows to repaint instead of re-sending the whole tree");
        const rows = payload as StatusTreeNode[];
        assert.ok(rows.length >= 1);
        assert.ok(
          rows.every((row) => "kind" in row && row.kind === "operation"),
          "only running-operation rows are repainted"
        );
      }
      // The repainted row is the same object the tree already holds.
      const heldRow = (provider.getChildren() as StatusTreeNode[]).find(
        (node): node is StatusOperationNode => "kind" in node && node.kind === "operation"
      );
      assert.ok(heldRow);
      assert.ok((events[0] as StatusTreeNode[]).includes(heldRow));
      taskOperations.end(op);
    } finally {
      sub.dispose();
      provider.dispose();
    }
  });

  void it("a very large notification is bounded in storage and in its hover text", () => {
    const provider = new StatusTreeProvider();
    const huge = "y".repeat(MAX_STATUS_MESSAGE_CHARS * 3);
    provider.addEntry(huge, "error");
    const stored = provider.getEntries()[0]!;
    assert.ok(stored.message.length < huge.length);
    assert.ok(stored.message.length <= MAX_STATUS_MESSAGE_CHARS + 200);
    const item = provider.getTreeItem(stored);
    const tooltip = item.tooltip instanceof vscode.MarkdownString ? item.tooltip.value : String(item.tooltip);
    assert.ok(tooltip.length < TOOLTIP_MESSAGE_MAX_CHARS + 500, `tooltip stays small (was ${tooltip.length})`);
    provider.dispose();
  });
});
