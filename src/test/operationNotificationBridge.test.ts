/**
 * The centralized operation → terminal-Notifications-entry policy (contract
 * C1 / operationTaxonomy): every root operation leaves exactly one persistent
 * entry when it ends, children leave none, and chat-response kinds record
 * only failures/cancellations. terminalEntryFor is the pure policy;
 * installOperationNotificationBridge is the activation-time subscription that
 * routes it through the NotificationRouter surface.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  installOperationNotificationBridge,
  terminalEntryFor,
} from "../utils/operationNotificationBridge";
import {
  runTrackedOperation,
  TaskOperationSnapshot,
  TaskOperationState,
} from "../utils/taskOperations";
import {
  initNotificationRouter,
  deactivateNotificationRouter,
} from "../utils/notificationRouter";
import { OperationKind } from "../utils/operationTaxonomy";

function snap(overrides: {
  state: TaskOperationState;
  kind?: OperationKind;
  parentId?: string;
  detail?: string;
  label?: string;
  taskName?: string;
}): TaskOperationSnapshot {
  return {
    id: "op-1",
    key: "/dev/task_1",
    label: overrides.label ?? "Review",
    taskName: overrides.taskName ?? "task_1",
    startedAt: 1,
    finishedAt: 2,
    exclusive: true,
    cancellable: false,
    state: overrides.state,
    kind: overrides.kind,
    parentId: overrides.parentId,
    detail: overrides.detail,
    waitingForUser: false,
  };
}

void describe("terminalEntryFor (taxonomy policy)", () => {
  void it("records succeeded roots as info 'completed' entries", () => {
    const entry = terminalEntryFor(snap({ state: "succeeded", kind: "review" }));
    assert.deepEqual(entry, { message: "Review — \"task_1\": completed", level: "info", sourceOperationId: "op-1" });
  });

  void it("quotes the human display name in the rendered message, unquoted in the snapshot", () => {
    const source = snap({ state: "succeeded", kind: "review", taskName: "ff for 1 pt 2" });
    const entry = terminalEntryFor(source);
    assert.equal(entry?.message, 'Review — "ff for 1 pt 2": completed');
    // Quoting is a render-time decision only — the semantic taskName that
    // snapshots (and persisted entries) carry stays quote-free.
    assert.equal(source.taskName.includes('"'), false);
  });

  void it("quotes the folder-name fallback the same way when no display name exists", () => {
    const entry = terminalEntryFor(snap({ state: "succeeded", kind: "review", taskName: "2026-08-14_task_3" }));
    assert.equal(entry?.message, 'Review — "2026-08-14_task_3": completed');
  });

  void it("appends the settled live detail (e.g. iteration x/y, a created folder name)", () => {
    const entry = terminalEntryFor(
      snap({ state: "succeeded", kind: "fast-forward", label: "Fast Forward Review", detail: "iteration 3/5" })
    );
    assert.equal(entry?.message, "Fast Forward Review — \"task_1\": completed (iteration 3/5)");
  });

  void it("records failed roots as error entries", () => {
    const entry = terminalEntryFor(snap({ state: "failed", kind: "generate-plan", label: "Generate Plan" }));
    assert.deepEqual(entry, { message: "Generate Plan — \"task_1\": failed", level: "error", sourceOperationId: "op-1" });
  });

  void it("records cancelled roots as warnings and drops the transient 'cancelling…' detail", () => {
    const entry = terminalEntryFor(snap({ state: "cancelled", kind: "review", detail: "cancelling…" }));
    assert.deepEqual(entry, { message: "Review — \"task_1\": cancelled", level: "warning", sourceOperationId: "op-1" });
  });

  void it("records instant mutations (terminal-always) on success", () => {
    const entry = terminalEntryFor(
      snap({ state: "succeeded", kind: "pause-task", label: "Pause Task" })
    );
    assert.deepEqual(entry, { message: "Pause Task — \"task_1\": completed", level: "info", sourceOperationId: "op-1" });
  });

  void it("skips chat-response successes (terminal-on-failure-only) but records their failures", () => {
    assert.equal(terminalEntryFor(snap({ state: "succeeded", kind: "chat-send", label: "Chat" })), undefined);
    const failed = terminalEntryFor(snap({ state: "failed", kind: "chat-send", label: "Chat" }));
    assert.deepEqual(failed, { message: "Chat — \"task_1\": failed", level: "error", sourceOperationId: "op-1" });
  });

  void it("never records child operations — the root's entry covers the composite", () => {
    assert.equal(
      terminalEntryFor(snap({ state: "succeeded", kind: "apply-review", parentId: "op-0" })),
      undefined
    );
    assert.equal(
      terminalEntryFor(snap({ state: "failed", kind: "apply-review", parentId: "op-0" })),
      undefined
    );
  });

  void it("records kind-less roots (defensive default: nothing disappears silently)", () => {
    const entry = terminalEntryFor(snap({ state: "succeeded" }));
    assert.equal(entry?.level, "info");
  });

  void it("passes through resultTargetUri (D11) when the snapshot carries one", () => {
    const withTarget = terminalEntryFor({
      ...snap({ state: "succeeded", kind: "generate-plan", label: "Generate Plan" }),
      resultTargetUri: "file:///dev/task_1/runs/001-plan.md",
    });
    assert.equal(withTarget?.resultTargetUri, "file:///dev/task_1/runs/001-plan.md");
  });

  void it("omits resultTargetUri entirely (no stray undefined key) when the snapshot has none", () => {
    const entry = terminalEntryFor(snap({ state: "succeeded", kind: "generate-plan" }));
    assert.equal("resultTargetUri" in (entry ?? {}), false);
  });
});

void describe("installOperationNotificationBridge (activation subscription)", () => {
  void it("routes real runTrackedOperation terminal states into the router surface", async () => {
    const captured: Array<{ message: string; level: string }> = [];
    initNotificationRouter({
      addEntry(message, level) {
        captured.push({ message, level });
      },
    });
    const bridge = installOperationNotificationBridge();
    const folder = `/dev/bridge_task_${Math.floor(Math.random() * 1e9)}`;

    try {
      await runTrackedOperation(
        folder,
        { label: "Pause Task", taskName: "bridge_task", kind: "pause-task" },
        () => Promise.resolve()
      );
      await runTrackedOperation(
        folder,
        { label: "Generate Plan", taskName: "bridge_task", kind: "generate-plan" },
        () => Promise.reject(new Error("provider exploded"))
      ).catch(() => undefined);

      assert.deepEqual(captured, [
        { message: "Pause Task — \"bridge_task\": completed", level: "info" },
        { message: "Generate Plan — \"bridge_task\": failed", level: "error" },
      ]);
    } finally {
      bridge.dispose();
      deactivateNotificationRouter();
    }
  });
});
