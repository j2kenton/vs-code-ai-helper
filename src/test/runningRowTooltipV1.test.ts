/**
 * bugs6 item 43 (ported to 1.18): every running row in Ensemble Status has a hover that lists, one labelled fact per
 * line, what the row's grey line holds (stage, what it is doing, model, provider, elapsed time), plus the start time.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StatusTreeProvider, StatusTreeNode, StatusOperationNode } from "../views/statusView";
import { taskOperations } from "../utils/taskOperations";
import { buildRunningRowTooltipV1, formatClockWithUtcV1, formatDurationV1 } from "../views/runningRowTooltipV1";

function operationNodes(provider: StatusTreeProvider): StatusOperationNode[] {
  const children = (provider.getChildren() ?? []) as StatusTreeNode[];
  return children.filter((node): node is StatusOperationNode => "kind" in node && node.kind === "operation");
}

void describe("running row hover (bugs6 item 43)", () => {
  void it("lists stage, doing, model, provider, start and elapsed, and every fact on the row's line", () => {
    const provider = new StatusTreeProvider();
    const taskPath = `/dev/hover_plain_${Math.floor(Math.random() * 1e9)}`;
    const op = taskOperations.begin(taskPath, {
      label: "Apply Review",
      taskName: "hover_plain",
      stage: "impl",
      cancellable: true,
    });
    assert.ok(op);
    try {
      op.reportActivity("editing files", { resetElapsedOrigin: true });
      op.setModel?.("claude-cli:sonnet@high");
      const node = operationNodes(provider).find((n) => n.taskName === "hover_plain");
      assert.ok(node);
      const item = provider.getTreeItem(node);
      const tooltip = String(item.tooltip ?? "");
      assert.match(tooltip, /^Apply Review — /);
      assert.match(tooltip, /^Stage: Implementation$/m);
      assert.match(tooltip, /^Doing: editing files$/m);
      assert.match(tooltip, /^Model: sonnet@high$/m);
      assert.match(tooltip, /^Provider: Claude Code$/m);
      assert.match(tooltip, /^Started: \d\d:\d\d \(\d\d:\d\d UTC\)$/m);
      assert.match(tooltip, /^Running for: \d+s$/m);
      assert.match(tooltip, /^Stop button \(on this row\): cancels this round\.$/m);
      // Every fact the grey line shows is in the hover too.
      for (const fact of String(item.description).split(" · ")) {
        if (fact.includes("(Claude Code)")) {
          continue; // shown as separate Model and Provider lines
        }
        assert.ok(tooltip.includes(fact), `hover is missing "${fact}" from the row's line`);
      }
    } finally {
      taskOperations.end(op);
      provider.dispose();
    }
  });

  void it("a row with no model yet says so, and still names its stage and doing", () => {
    const provider = new StatusTreeProvider();
    const taskPath = `/dev/hover_nomodel_${Math.floor(Math.random() * 1e9)}`;
    const op = taskOperations.begin(taskPath, { label: "Review", taskName: "hover_nomodel", stage: "impl", cancellable: false });
    assert.ok(op);
    try {
      const node = operationNodes(provider).find((n) => n.taskName === "hover_nomodel");
      assert.ok(node);
      const item = provider.getTreeItem(node);
      const tooltip = String(item.tooltip ?? "");
      assert.match(tooltip, /^Model: not reported yet$/m);
      assert.match(tooltip, /^Doing: /m);
      assert.doesNotMatch(tooltip, /button/i, "a row that cannot be stopped names no buttons");
      for (const fact of String(item.description).split(" · ")) {
        assert.ok(tooltip.includes(fact), `hover is missing "${fact}" from the row's line`);
      }
    } finally {
      taskOperations.end(op);
      provider.dispose();
    }
  });

  void it("shows the current step's time separately, and the checks-running model segment", () => {
    const start = Date.UTC(2026, 10, 9, 12, 0, 0);
    const tooltip = buildRunningRowTooltipV1({
      label: "Fast Forward Review — review2",
      stageLabel: "High-Level Code Review",
      doing: "running checks",
      modelSegment: "checks running; model not started yet",
      startedAt: start,
      activityStartedAt: start + 10 * 60_000,
      now: start + 12 * 60_000 + 5_000,
      cancellable: true,
    });
    assert.match(tooltip, /^Stage: High-Level Code Review$/m);
    assert.match(tooltip, /^Model: checks running; model not started yet$/m);
    assert.match(tooltip, /^Running for: 12m 5s$/m);
    assert.match(tooltip, /^This step: 2m 5s, since \d\d:\d\d \(12:10 UTC\)$/m);
    assert.match(tooltip, /^Stop button \(on this row\): /m);
  });

  void it("a row that cannot be stopped names no buttons", () => {
    const tooltip = buildRunningRowTooltipV1({
      label: "Plan — t",
      doing: "running",
      startedAt: 0,
      now: 1_000,
      cancellable: false,
    });
    assert.doesNotMatch(tooltip, /button/i);
    assert.doesNotMatch(tooltip, /^Stage:/m);
  });

  void it("formats clocks with UTC and durations like the row", () => {
    assert.match(formatClockWithUtcV1(Date.UTC(2026, 10, 9, 7, 5)), /^\d\d:\d\d \(07:05 UTC\)$/);
    assert.equal(formatDurationV1(45_000), "45s");
    assert.equal(formatDurationV1(168_000), "2m 48s");
    assert.equal(formatDurationV1(7_320_000), "2h 2m");
    assert.equal(formatDurationV1(-5), "0s");
  });
});
