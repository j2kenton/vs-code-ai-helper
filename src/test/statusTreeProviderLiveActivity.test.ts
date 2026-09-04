/**
 * Notifications in-flight visibility (Part IV, Step 9 remainder): the pieces
 * of the live-activity row that `runTrackedOperation.test.ts` and
 * `operationIndicators.test.ts` do not already cover — the view-local elapsed
 * tick timer's start/stop/dispose contract (with a fake clock, so a tick
 * never touches the registry or persistence), elapsed-time boundary
 * formatting, that two roots sharing an identical display name still render
 * as two separate rows, and that no observation ever shows both a live
 * operation row and its terminal Notifications entry for the same root at
 * once — including once a late, post-end activity report arrives.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import {
  StatusTreeProvider,
  StatusTreeNode,
  StatusOperationNode,
  formatElapsedForDisplay,
} from "../views/statusView";
import {
  runTrackedOperation,
  taskOperations,
  TaskOperationHandle,
  reportStageStartingV1,
  reportStageRunningV1,
} from "../utils/taskOperations";
import {
  initNotificationRouter,
  deactivateNotificationRouter,
} from "../utils/notificationRouter";
import { installOperationNotificationBridge } from "../utils/operationNotificationBridge";

function operationNodes(provider: StatusTreeProvider): StatusOperationNode[] {
  const children = (provider.getChildren() ?? []) as StatusTreeNode[];
  return children.filter(
    (node): node is StatusOperationNode => "kind" in node && node.kind === "operation"
  );
}

/**
 * Stands in for a real provider dispatch (e.g. `runImplementationOrSealedV1`)
 * that resolves or rejects after a genuine event-loop tick — not a
 * synchronous throw — so tests exercising it await real asynchronous work the
 * same shape production dispatch sites await, rather than merely wrapping a
 * thrown Error in a Promise.
 */
function scriptedFakeProviderCall(options: { rejectWith?: Error }): Promise<void> {
  return new Promise((resolve, reject) => {
    setImmediate(() => {
      if (options.rejectWith) {
        reject(options.rejectWith);
      } else {
        resolve();
      }
    });
  });
}

void describe("formatElapsedForDisplay (elapsed-time boundary formatting)", () => {
  void it("renders bare seconds below one minute", () => {
    assert.equal(formatElapsedForDisplay(1000, 1000), "0s");
    assert.equal(formatElapsedForDisplay(1000, 1000 + 45_000), "45s");
    assert.equal(formatElapsedForDisplay(1000, 1000 + 59_000), "59s");
  });

  void it("renders Xm Ys from one minute up to (not including) one hour", () => {
    assert.equal(formatElapsedForDisplay(0, 60_000), "1m 0s");
    assert.equal(formatElapsedForDisplay(0, 168_000), "2m 48s");
    assert.equal(formatElapsedForDisplay(0, 3_599_000), "59m 59s");
  });

  void it("renders Xh Ym from one hour onward, dropping the seconds component", () => {
    assert.equal(formatElapsedForDisplay(0, 3_600_000), "1h 0m");
    assert.equal(formatElapsedForDisplay(0, 7_320_000), "2h 2m");
  });

  void it("never returns a negative duration when now is (spuriously) before the origin", () => {
    assert.equal(formatElapsedForDisplay(10_000, 5_000), "0s");
  });
});

void describe("StatusTreeProvider live-activity tick timer", () => {
  void it("starts ticking once a root operation begins, ticks only refresh presentation, and stops once the last root ends", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    const provider = new StatusTreeProvider();
    let refreshCount = 0;
    const sub = provider.onDidChangeTreeData(() => { refreshCount++; });
    const registryEvents: boolean[] = [];
    const registrySub = taskOperations.onDidChange((e) => registryEvents.push(e.persistenceRelevant));

    const taskPath = `/dev/tick_task_${Math.floor(Math.random() * 1e9)}`;
    try {
      const op = taskOperations.begin(taskPath, { label: "Ticking Op", taskName: "tick_task" });
      assert.ok(op);
      // begin() itself triggers one refresh via the onDidChange subscription.
      await Promise.resolve();
      refreshCount = 0;
      registryEvents.length = 0;

      t.mock.timers.tick(1000);
      t.mock.timers.tick(1000);
      t.mock.timers.tick(1000);
      assert.ok(refreshCount >= 3, `expected at least 3 tick-driven refreshes, got ${refreshCount}`);
      assert.deepEqual(registryEvents, [], "a tick must never emit a registry onDidChange event");

      refreshCount = 0;
      taskOperations.end(op);
      await Promise.resolve();
      const afterEndRefreshCount = refreshCount;
      refreshCount = 0;

      // No live roots remain — further fake-clock advances must not keep
      // producing tick-driven refreshes.
      t.mock.timers.tick(5000);
      assert.equal(refreshCount, 0, "the timer must stop once no live root operations remain");
      void afterEndRefreshCount;
    } finally {
      registrySub.dispose();
      sub.dispose();
      provider.dispose();
    }
  });

  void it("disposes the timer with the provider, so no further ticks fire and the process is never kept alive", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    const provider = new StatusTreeProvider();
    let refreshCount = 0;
    const sub = provider.onDidChangeTreeData(() => { refreshCount++; });

    const taskPath = `/dev/tick_dispose_${Math.floor(Math.random() * 1e9)}`;
    const op = taskOperations.begin(taskPath, { label: "Disposed Op", taskName: "tick_dispose" });
    assert.ok(op);
    await Promise.resolve();

    provider.dispose();
    refreshCount = 0;
    t.mock.timers.tick(5000);
    assert.equal(refreshCount, 0, "a disposed provider's timer must never fire again");

    sub.dispose();
    taskOperations.end(op);
  });
});

void describe("StatusTreeProvider row identity and lifecycle exclusivity", () => {
  void it("renders two roots sharing an identical display name as two separate rows, keyed by operation id", () => {
    const provider = new StatusTreeProvider();
    const opA = taskOperations.begin("/dev/dup_name_a", { label: "Run Implementation", taskName: "same name" });
    const opB = taskOperations.begin("/dev/dup_name_b", { label: "Run Implementation", taskName: "same name" });
    assert.ok(opA && opB);

    try {
      const nodes = operationNodes(provider).filter((n) => n.taskName === "same name");
      assert.equal(nodes.length, 2, "two distinct root operations with the same display name must render as two rows");
      const ids = new Set(nodes.map((n) => n.id));
      assert.equal(ids.size, 2, "the two rows must carry distinct ids");

      const items = nodes.map((n) => provider.getTreeItem(n));
      const itemIds = new Set(items.map((i) => i.id));
      assert.equal(itemIds.size, 2, "the two tree items must carry distinct `running:${id}` keys");
      for (const item of items) {
        assert.ok(item.id?.startsWith("running:"), `expected a stable running: row key, got ${item.id}`);
      }
    } finally {
      taskOperations.end(opA);
      taskOperations.end(opB);
      provider.dispose();
    }
  });

  void it("omits the model segment cleanly (no stray '·' delimiters) when no model is known", () => {
    const provider = new StatusTreeProvider();
    const taskPath = `/dev/no_model_${Math.floor(Math.random() * 1e9)}`;
    const op = taskOperations.begin(taskPath, { label: "No Model Op", taskName: "no_model", stage: "impl" });
    assert.ok(op);
    try {
      op.reportActivity("running", { resetElapsedOrigin: true });
      const node = operationNodes(provider).find((n) => n.taskName === "no_model");
      assert.ok(node);
      const description = String(provider.getTreeItem(node).description ?? "");
      assert.equal(description, "Implementation · running · 0s");
      assert.ok(!description.includes("· ·"), `expected no stray double-delimiter, got: ${description}`);
      assert.ok(!description.startsWith("·") && !description.endsWith("·"), `expected no leading/trailing delimiter, got: ${description}`);

      // Once a model does arrive, it slots in between the activity and elapsed segments.
      op.setModel?.("claude-cli:sonnet@high");
      const nodeWithModel = operationNodes(provider).find((n) => n.taskName === "no_model");
      assert.ok(nodeWithModel);
      const withModel = String(provider.getTreeItem(nodeWithModel).description ?? "");
      assert.equal(withModel, "Implementation · running · claude-cli:sonnet@high · 0s");
    } finally {
      taskOperations.end(op);
      provider.dispose();
    }
  });

  void it("ten repeated activity reports to one root still collapse to exactly one row", () => {
    const provider = new StatusTreeProvider();
    const taskPath = `/dev/repeat_reports_${Math.floor(Math.random() * 1e9)}`;
    const op = taskOperations.begin(taskPath, { label: "Repeated Op", taskName: "repeat_reports" });
    assert.ok(op);
    try {
      for (let i = 0; i < 10; i++) {
        op.reportActivity(`step ${i}`, { resetElapsedOrigin: i === 0 });
      }
      const nodes = operationNodes(provider).filter((n) => n.taskName === "repeat_reports");
      assert.equal(nodes.length, 1, "ten updates to one root must still be exactly one row");
      assert.equal(nodes[0]?.activity, "step 9");
    } finally {
      taskOperations.end(op);
      provider.dispose();
    }
  });

  void it("never shows both a live operation row and its terminal notification for the same root at once, including across a mid-run activity report", async () => {
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const bridge = installOperationNotificationBridge();
    const folder = `/dev/exclusivity_task_${Math.floor(Math.random() * 1e9)}`;

    try {
      await runTrackedOperation(
        folder,
        { label: "Exclusive Row Op", taskName: "exclusivity_task", stage: "impl", kind: "run-implementation" },
        async (op) => {
          op.reportActivity("running", { resetElapsedOrigin: true });
          const liveNodes = operationNodes(provider).filter((n) => n.taskName === "exclusivity_task");
          assert.equal(liveNodes.length, 1, "exactly one live row while the operation runs");
          const terminalEntriesWhileRunning = provider
            .getEntries()
            .filter((e) => e.message.includes("exclusivity_task"));
          assert.equal(terminalEntriesWhileRunning.length, 0, "no terminal entry may exist while the operation is still live");
          return Promise.resolve();
        }
      );

      const liveNodesAfter = operationNodes(provider).filter((n) => n.taskName === "exclusivity_task");
      assert.equal(liveNodesAfter.length, 0, "the live row must disappear once the operation ends");
      const terminalEntriesAfter = provider
        .getEntries()
        .filter((e) => e.message.includes("exclusivity_task"));
      assert.equal(terminalEntriesAfter.length, 1, "exactly one terminal entry must exist once the operation ends");
    } finally {
      bridge.dispose();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("never shows both a live row and a terminal notification on FAILURE, and a late post-failure activity report is ignored — exercised via an AWAITED scripted provider call that rejects (not a synchronous throw), reported through the real reportStageStartingV1/reportStageRunningV1 wrappers exactly as executeImplementationRun does, so the registry's single catch-and-cleanup path (taskOperations.ts's runTrackedOperation) is proven to also cover a genuine asynchronous unexpected provider exit — see the sibling source-shape test below pinning that executeImplementationRun's try block around runImplementationOrSealedV1 has no intervening catch, so such a rejection is guaranteed to reach this same path unaltered", async () => {
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const bridge = installOperationNotificationBridge();
    const folder = `/dev/exclusivity_fail_${Math.floor(Math.random() * 1e9)}`;
    let escapedHandle: TaskOperationHandle | undefined;

    try {
      await assert.rejects(
        runTrackedOperation(
          folder,
          { label: "Failing Op", taskName: "exclusivity_fail", stage: "impl", kind: "run-implementation" },
          async (op) => {
            escapedHandle = op;
            const stageToken = reportStageStartingV1(op, "claude-cli:sonnet@high");
            reportStageRunningV1(op, stageToken);
            const liveNodes = operationNodes(provider).filter((n) => n.taskName === "exclusivity_fail");
            assert.equal(liveNodes.length, 1, "exactly one live row while the operation is still failing to complete");
            assert.equal(
              taskOperations.getTaskOperations(folder)[0]?.activity,
              "running",
              "reportStageRunningV1 must have applied 'running' before the provider call is awaited"
            );
            await scriptedFakeProviderCall({ rejectWith: new Error("provider exited unexpectedly") });
          }
        ),
        /provider exited unexpectedly/
      );

      assert.equal(
        operationNodes(provider).filter((n) => n.taskName === "exclusivity_fail").length,
        0,
        "the live row must disappear once the operation fails"
      );
      const terminalEntries = provider.getEntries().filter((e) => e.message.includes("exclusivity_fail"));
      assert.equal(terminalEntries.length, 1, "exactly one terminal entry must exist once the operation fails");
      assert.equal(terminalEntries[0]?.level, "error", "a failed root must record an error-level terminal entry");
      assert.ok(terminalEntries[0]?.message.includes("failed"), "terminal message must match the pre-change failure taxonomy");

      assert.ok(escapedHandle);
      escapedHandle.reportActivity("reading context (500 KB)", { resetElapsedOrigin: true });
      assert.equal(
        operationNodes(provider).filter((n) => n.taskName === "exclusivity_fail").length,
        0,
        "a late activity report after failure must never resurrect a row, and must not add a second terminal entry"
      );
      assert.equal(
        provider.getEntries().filter((e) => e.message.includes("exclusivity_fail")).length,
        1,
        "a late activity report must not duplicate or alter the terminal entry"
      );
    } finally {
      bridge.dispose();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("never shows both a live row and a terminal notification on CANCELLATION, and a late post-cancellation activity report is ignored", async () => {
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const bridge = installOperationNotificationBridge();
    const folder = `/dev/exclusivity_cancel_${Math.floor(Math.random() * 1e9)}`;
    let escapedHandle: TaskOperationHandle | undefined;

    try {
      await assert.rejects(
        runTrackedOperation(
          folder,
          { label: "Cancelling Op", taskName: "exclusivity_cancel", stage: "impl", kind: "run-implementation", cancellable: true },
          async (op) => {
            escapedHandle = op;
            const stageToken = reportStageStartingV1(op, "claude-cli:sonnet@high");
            reportStageRunningV1(op, stageToken);
            const liveNodes = operationNodes(provider).filter((n) => n.taskName === "exclusivity_cancel");
            assert.equal(liveNodes.length, 1, "exactly one live row while the operation is still cancelling");
            taskOperations.cancelOperation(op.id);
            // Awaited, exactly like the FAILURE case above — cancellation
            // during a real provider dispatch surfaces as this same awaited
            // call rejecting with a CancellationError once the linked token
            // trips, not as a synchronous throw in the callback body.
            await scriptedFakeProviderCall({ rejectWith: new vscode.CancellationError() });
          }
        )
      );

      assert.equal(
        operationNodes(provider).filter((n) => n.taskName === "exclusivity_cancel").length,
        0,
        "the live row must disappear once the operation is cancelled"
      );
      const terminalEntries = provider.getEntries().filter((e) => e.message.includes("exclusivity_cancel"));
      assert.equal(terminalEntries.length, 1, "exactly one terminal entry must exist once the operation is cancelled");
      assert.equal(terminalEntries[0]?.level, "warning", "a cancelled root must record a warning-level terminal entry");
      assert.ok(terminalEntries[0]?.message.includes("cancelled"), "terminal message must match the pre-change cancellation taxonomy");

      assert.ok(escapedHandle);
      escapedHandle.reportActivity("running", { resetElapsedOrigin: true });
      assert.equal(
        operationNodes(provider).filter((n) => n.taskName === "exclusivity_cancel").length,
        0,
        "a late activity report after cancellation must never resurrect a row, and must not add a second terminal entry"
      );
      assert.equal(
        provider.getEntries().filter((e) => e.message.includes("exclusivity_cancel")).length,
        1,
        "a late activity report must not duplicate or alter the terminal entry"
      );
    } finally {
      bridge.dispose();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("a late activity report arriving after the operation has ended never resurrects a view row", async () => {
    const provider = new StatusTreeProvider();
    const folder = `/dev/late_activity_${Math.floor(Math.random() * 1e9)}`;
    let escapedHandle: TaskOperationHandle | undefined;

    await runTrackedOperation(
      folder,
      { label: "Late Report Op", taskName: "late_activity" },
      (op) => {
        escapedHandle = op;
        return Promise.resolve();
      }
    );

    assert.equal(
      operationNodes(provider).filter((n) => n.taskName === "late_activity").length,
      0,
      "no row exists once the operation has already ended"
    );

    // A callback captured the (now-ended) handle before termination and only
    // resolves afterward — mirrors a slow context-size probe or check
    // callback landing late.
    assert.ok(escapedHandle);
    escapedHandle.reportActivity("reading context (500 KB)", {
      resetElapsedOrigin: true,
    });

    assert.equal(
      operationNodes(provider).filter((n) => n.taskName === "late_activity").length,
      0,
      "a late activity report must never resurrect a row for an already-ended operation"
    );
    provider.dispose();
  });
});

void describe("reportStageStartingV1 / reportStageRunningV1 behavioral contract (not source-order inspection)", () => {
  // reviewActionsStageActivity.test.ts pins that reviewActions.ts's dispatch
  // sites CALL these two wrappers in the right order via source-text
  // inspection (driving the full dispatch needs the coordinator, CLI runner,
  // workspace fs, and git — mocked elsewhere in the suite at high cost, the
  // same tradeoff legacyAiActionSafetyGateWiring.test.ts documents for an
  // identical class of 1000+ line command-module dependency graph). These
  // tests instead behaviorally exercise what those wrappers actually DO
  // against a real, registry-issued TaskOperationHandle — no source text
  // involved — closing the review's "fake providers" gap for the
  // starting/running/model-reporting contract itself.
  void it("reportStageStartingV1 sets the model, resets the elapsed origin, and reports 'starting'", () => {
    const taskPath = `/tmp/stage-starting-${Math.random()}`;
    const op = taskOperations.begin(taskPath, { label: "Root" });
    assert.ok(op);
    try {
      const before = taskOperations.getTaskOperations(taskPath)[0];
      assert.equal(before?.modelId, undefined);
      assert.equal(before?.activity, undefined);

      const token = reportStageStartingV1(op, "claude-cli:sonnet@high");
      assert.equal(typeof token, "number");

      const after = taskOperations.getTaskOperations(taskPath)[0];
      assert.equal(after?.modelId, "claude-cli:sonnet@high", "the stored provider-qualified model id must be recorded");
      assert.equal(after?.activity, "starting");
      assert.ok(after?.activityStartedAt !== undefined, "resetElapsedOrigin must set a fresh origin");
    } finally {
      taskOperations.end(op);
    }
  });

  void it("reportStageRunningV1 reports 'running' while preserving the origin reportStageStartingV1 set", () => {
    const taskPath = `/tmp/stage-running-${Math.random()}`;
    const op = taskOperations.begin(taskPath, { label: "Root" });
    assert.ok(op);
    try {
      const token = reportStageStartingV1(op, "claude-cli:sonnet@high");
      const origin = taskOperations.getTaskOperations(taskPath)[0]?.activityStartedAt;
      assert.ok(origin !== undefined);

      reportStageRunningV1(op, token);

      const after = taskOperations.getTaskOperations(taskPath)[0];
      assert.equal(after?.activity, "running");
      assert.equal(after?.modelId, "claude-cli:sonnet@high", "the model set by reportStageStartingV1 must survive");
      assert.equal(after?.activityStartedAt, origin, "reportStageRunningV1 must not restart the elapsed timer");
    } finally {
      taskOperations.end(op);
    }
  });

  void it("reportStageRunningV1's stageToken guard drops a late report from a superseded stage, exactly the late-callback scenario the plan calls out", () => {
    const taskPath = `/tmp/stage-running-stale-${Math.random()}`;
    const op = taskOperations.begin(taskPath, { label: "Root" });
    assert.ok(op);
    try {
      // Implementation stage starts and captures its token...
      const implementationToken = reportStageStartingV1(op, "claude-cli:sonnet@high");
      // ...but before its "running" report lands, the root has already moved
      // to a newer stage (e.g. Review) with its own starting/running pair.
      reportStageStartingV1(op, "codex-cli:gpt-5.6-sol@high");
      reportStageRunningV1(op);

      const beforeStaleReport = taskOperations.getTaskOperations(taskPath)[0];
      assert.equal(beforeStaleReport?.activity, "running");
      assert.equal(beforeStaleReport?.modelId, "codex-cli:gpt-5.6-sol@high");

      // The stale Implementation-stage "running" report finally arrives,
      // carrying the token it captured before the transition.
      reportStageRunningV1(op, implementationToken);

      const after = taskOperations.getTaskOperations(taskPath)[0];
      assert.equal(after?.activity, "running", "still 'running', but from the CURRENT stage, not overwritten text");
      assert.equal(
        after?.modelId,
        "codex-cli:gpt-5.6-sol@high",
        "a stale reportStageRunningV1 call must not resurrect the superseded stage's model"
      );
    } finally {
      taskOperations.end(op);
    }
  });
});

void describe("provider-exit propagation shape (source-shape proof backing the FAILURE lifecycle test above)", () => {
  // Confirms, by construction rather than assertion, that the FAILURE
  // lifecycle test's framing is accurate: an unexpected rejection from the
  // CLI-resolved implementation dispatch (runImplementationOrSealedV1) has NO
  // intervening catch between its call site and runTrackedOperation's own
  // single cleanup path (taskOperations.ts:973) — only a `finally` that
  // disposes the linked cancellation token. A caught-and-converted rejection
  // here would silently leave a stale live row instead of reaching cleanup.
  const reviewActionsSource = fs.readFileSync(
    path.join(process.cwd(), "src", "commands", "reviewActions.ts"),
    "utf8"
  );

  void it("executeImplementationRun's try block around runImplementationOrSealedV1 has no catch, only finally — a provider rejection is guaranteed to propagate unmodified", () => {
    const fnStart = reviewActionsSource.indexOf("async function executeImplementationRun(");
    assert.ok(fnStart >= 0, "expected executeImplementationRun");

    const dispatchIdx = reviewActionsSource.indexOf(
      "result = await runImplementationOrSealedV1({",
      fnStart
    );
    assert.ok(dispatchIdx >= 0, "expected the runImplementationOrSealedV1 dispatch");

    // The try block this dispatch sits inside starts at the nearest
    // preceding "try {" and must close with "} finally {", not "} catch".
    const tryIdx = reviewActionsSource.lastIndexOf("try {", dispatchIdx);
    assert.ok(tryIdx > fnStart, "expected a try block wrapping the dispatch");

    const finallyIdx = reviewActionsSource.indexOf("} finally {", dispatchIdx);
    assert.ok(finallyIdx > dispatchIdx, "expected the wrapping try block to close with finally");

    const catchIdx = reviewActionsSource.indexOf("} catch", dispatchIdx);
    assert.ok(
      catchIdx === -1 || catchIdx > finallyIdx,
      "no catch may sit between runImplementationOrSealedV1's dispatch and its wrapping finally — " +
        "a catch there would swallow or convert a provider rejection before it reaches " +
        "runTrackedOperation's single cleanup path, leaving a stale live row on an unexpected provider exit"
    );
  });
});

void describe("in-flight activity reporting stays out of chat and introduces no new persistence", () => {
  const taskOperationsSource = fs.readFileSync(
    path.join(process.cwd(), "src", "utils", "taskOperations.ts"),
    "utf8"
  );
  const statusViewSource = fs.readFileSync(
    path.join(process.cwd(), "src", "views", "statusView.ts"),
    "utf8"
  );

  void it("taskOperations.ts's activity-reporting path never references a chat surface or writer", () => {
    const reportActivityStart = taskOperationsSource.indexOf("reportActivity(\n    id: string,");
    assert.ok(reportActivityStart >= 0, "expected the registry's reportActivity method");
    const nextMethodStart = taskOperationsSource.indexOf("\n  report(taskPath: string", reportActivityStart);
    assert.ok(nextMethodStart > reportActivityStart);
    const body = taskOperationsSource.slice(reportActivityStart, nextMethodStart);
    assert.ok(
      !/chat/i.test(body),
      "reportActivity's implementation must never reference chat — in-flight status is a Notifications-only concern"
    );
  });

  void it("statusView.ts's persist paths write to exactly the two known, pre-existing workspace-state keys, and no new one", () => {
    const stateUpdateCalls = [...statusViewSource.matchAll(/this\.state!\.update\(([A-Z_]+)/g)].map((m) => m[1]);
    const uniqueKeys = new Set(stateUpdateCalls);
    assert.deepEqual(
      [...uniqueKeys].sort(),
      ["RUNNING_OPERATIONS_STATE_KEY", "STATUS_STATE_KEY"].sort(),
      "no new persistence key may be introduced for in-flight activity — activity/activityStartedAt must remain ephemeral"
    );
  });

  void it("SerializedOperation's Pick list excludes activity and activityStartedAt by construction", () => {
    const pickMatch = /type SerializedOperation = Pick<\s*TaskOperationSnapshot,\s*([\s\S]*?)>;/.exec(statusViewSource);
    assert.ok(pickMatch, "expected the SerializedOperation Pick type declaration");
    const fields = pickMatch[1]!;
    assert.ok(!fields.includes("activity"), "SerializedOperation must not pick the ephemeral activity field");
    assert.ok(!fields.includes("activityStartedAt"), "SerializedOperation must not pick the ephemeral activityStartedAt field");
  });

  void it("cliAgentRunner.ts — the module that streams provider frames — never calls reportActivity, so a CLI frame or tool call can never become a Notifications entry", () => {
    const cliAgentRunnerSource = fs.readFileSync(
      path.join(process.cwd(), "src", "runners", "cliAgentRunner.ts"),
      "utf8"
    );
    assert.ok(
      !cliAgentRunnerSource.includes("reportActivity"),
      "the frame-streaming runner must stay unaware of in-flight activity reporting — only coarse, explicit boundaries in reviewActions.ts may report activity"
    );
  });
});
