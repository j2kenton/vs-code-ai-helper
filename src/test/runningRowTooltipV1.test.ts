/**
 * bugs6 item 43: every running row in Ensemble Status has a hover that lists, one labelled fact per line, what the
 * row's grey line holds (stage, what it is doing, model, provider, start time, elapsed time, last activity, held
 * answer), with or without proof-of-life evidence.
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
  void it("lists stage, doing, model, provider, start and elapsed on a row with no proof-of-life evidence", () => {
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
      assert.doesNotMatch(tooltip, /Wait button/, "Wait is offered only on a row that shows no activity");
      // Every fact the grey line shows is in the hover too.
      for (const segment of String(item.description).split(" · ")) {
        const fact = segment.replace(/^started /, "");
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

  void it("adds the last activity, evidence lines and the Wait button on a silent row", () => {
    const provider = new StatusTreeProvider();
    const taskPath = `/dev/hover_silent_${Math.floor(Math.random() * 1e9)}`;
    const op = taskOperations.begin(taskPath, { label: "Review", taskName: "hover_silent", stage: "impl", cancellable: true });
    assert.ok(op);
    try {
      const now = Date.now();
      taskOperations.reportProofOfLifeForTask(taskPath, {
        pid: 42,
        processState: "alive",
        lastContactAt: now - 15 * 60_000,
        lastProgressAt: now - 15 * 60_000,
        lastProgressWhat: "ran `pnpm run lint`",
        lastObservedChangeAt: now - 5_000,
        lastObservedChangeWhat: "`src/other.ts`",
      });
      const node = operationNodes(provider).find((n) => n.taskName === "hover_silent");
      assert.ok(node);
      const tooltip = String(provider.getTreeItem(node).tooltip ?? "");
      assert.match(tooltip, /^Warning: no activity for 15 min/m);
      assert.match(tooltip, /src\/other\.ts.*not proven to be this round's/);
      assert.match(tooltip, /^Wait button: /m);
      assert.match(tooltip, /^Model: not reported yet$/m);
    } finally {
      taskOperations.end(op);
      provider.dispose();
    }
  });

  void it("shows the current step's time separately, the held answer and its buttons", () => {
    const start = Date.UTC(2026, 10, 9, 12, 0, 0);
    const tooltip = buildRunningRowTooltipV1({
      label: "Fast Forward Review — review2",
      stageLabel: "High-Level Code Review",
      doing: "running checks",
      modelSegment: "checks running; model not started yet",
      startedAt: start,
      activityStartedAt: start + 10 * 60_000,
      now: start + 12 * 60_000 + 5_000,
      activityLine: "last output 1 min ago",
      evidenceLines: [],
      heldAnswer: "your answer runs after this round",
      cancellable: true,
      stuck: false,
    });
    assert.match(tooltip, /^Model: checks running; model not started yet$/m);
    assert.match(tooltip, /^Running for: 12m 5s$/m);
    assert.match(tooltip, /^This step: 2m 5s, since \d\d:\d\d \(12:10 UTC\)$/m);
    assert.match(tooltip, /^Last output 1 min ago$/m);
    assert.match(tooltip, /^Held answer: your answer runs after this round$/m);
    assert.match(tooltip, /^Run held answer now: /m);
  });

  void it("a row that cannot be stopped names no buttons", () => {
    const tooltip = buildRunningRowTooltipV1({
      label: "Plan — t",
      doing: "running",
      startedAt: 0,
      now: 1_000,
      evidenceLines: [],
      cancellable: false,
      stuck: false,
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
