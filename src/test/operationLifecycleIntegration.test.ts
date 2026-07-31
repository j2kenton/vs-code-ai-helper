/**
 * Harness-level integration coverage of the C1 lifecycle chain across the
 * real registry, tree, and notifications surfaces (toward acceptance
 * criterion 11's press → indicator → … → persistent-notification test):
 *
 *   invoke → synchronous registration (in-progress Notifications row with a
 *   cancel affordance, stage-row spinner) → composite children repositioning
 *   the spinner onto the actively running sub-stage and feeding
 *   "iteration x/y" detail to the root row → terminal state observed via
 *   onDidEnd → the operation-notification bridge (the same subscription
 *   extension.ts installs at activation) converting it into a persistent
 *   Notifications entry after the operation row disappears.
 *
 * The command-layer leg of the criterion — a real registered command driving
 * a stage transition that auto-starts a review, publishes the artifact, and
 * leaves the persistent terminal entry — is covered end-to-end in
 * nextStageAutoReviewCommandChain.test.ts. The only remaining gap is running
 * the same chain inside a packaged extension host (@vscode/test-electron),
 * which would additionally exercise package.json activation/menu wiring.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { StageNode } from "../views/taskTreeProvider";
import { StatusTreeProvider, StatusTreeNode, StatusOperationNode, StatusEntry } from "../views/statusView";
import {
  runTrackedOperation,
  taskOperations,
  TaskOperationSnapshot,
} from "../utils/taskOperations";
import {
  initNotificationRouter,
  deactivateNotificationRouter,
} from "../utils/notificationRouter";
import { installOperationNotificationBridge } from "../utils/operationNotificationBridge";
import { IncompleteTask } from "../types/incompleteTask";

function makeTask(folder: string): IncompleteTask {
  return {
    folderUri: vscode.Uri.file(folder),
    folderName: folder.split("/").pop() ?? folder,
    progress: {
      taskFolder: folder.split("/").pop() ?? folder,
      createdAt: new Date().toISOString(),
      currentStage: "plan-low-review",
      completedStages: ["desc", "plan", "plan-high-review"],
      updatedAt: new Date().toISOString(),
      status: "active",
    },
    canonicalId: folder,
  };
}

function operationNodes(provider: StatusTreeProvider): StatusOperationNode[] {
  const children = (provider.getChildren() ?? []) as StatusTreeNode[];
  return children.filter(
    (node): node is StatusOperationNode => "kind" in node && node.kind === "operation"
  );
}

void describe("operation lifecycle integration (C1 chain)", () => {
  void it("runs the invoke → indicator → nested spinner → terminal state → persistent entry chain", async () => {
    const folder = `/dev/lifecycle_task_${Math.floor(Math.random() * 1e9)}`;
    const task = makeTask(folder);
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    // The same central subscription extension.ts installs during activation:
    // root operations' terminal states become persistent Notifications entries.
    const bridge = installOperationNotificationBridge();

    const terminalStates: TaskOperationSnapshot[] = [];
    const endSub = taskOperations.onDidEnd((snap) => {
      if (snap.key.includes("lifecycle_task")) {terminalStates.push(snap);}
    });

    try {
      await runTrackedOperation(
        folder,
        { label: "Fast Forward Review", stage: "plan-low-review", kind: "fast-forward", cancellable: true },
        async (op) => {
          // 1. Registration is synchronous and optimistic: the Notifications
          //    row and stage-row spinner exist before any I/O.
          const rows = operationNodes(provider).filter((n) => n.label === "Fast Forward Review");
          assert.equal(rows.length, 1, "exactly one in-progress row for the composite root");
          assert.equal(rows[0]!.cancellable, true, "the row exposes the cancel affordance");

          const rowItem = provider.getTreeItem(rows[0]!);
          assert.equal(
            rowItem.contextValue,
            "ensemble-operation-cancellable",
            "the tree item is keyed for the inline cancel button"
          );

          const reviewRow = new StageNode(task, "plan-low-review", "current", undefined);
          assert.equal(
            reviewRow.iconPath instanceof vscode.ThemeIcon ? reviewRow.iconPath.id : "",
            "loading~spin",
            "the review stage row spins while the root is the leaf operation"
          );

          // 2. A nested child (the apply phase) moves the spinner to the
          //    actively running sub-stage and stays off the Notifications view.
          op.report("iteration 1/5");
          await runTrackedOperation(
            folder,
            { parent: op, label: "Applying review to plan.md", stage: "plan", kind: "apply-review" },
            () => {
              const planRow = new StageNode(task, "plan", "done", undefined);
              const reviewRowDuringApply = new StageNode(task, "plan-low-review", "current", undefined);
              assert.equal(
                planRow.iconPath instanceof vscode.ThemeIcon ? planRow.iconPath.id : "",
                "loading~spin",
                "the plan row spins while the apply child is the leaf"
              );
              assert.notEqual(
                reviewRowDuringApply.iconPath instanceof vscode.ThemeIcon
                  ? reviewRowDuringApply.iconPath.id
                  : "",
                "loading~spin",
                "the review row stops spinning while the child runs elsewhere"
              );
              assert.equal(
                operationNodes(provider).filter((n) => n.taskName.includes("lifecycle_task")).length,
                1,
                "children never add Notifications rows"
              );
              return Promise.resolve();
            }
          );

          // 3. Iteration detail from the root is visible on its row.
          const rowWithDetail = operationNodes(provider).find((n) => n.label === "Fast Forward Review");
          assert.equal(rowWithDetail?.detail, "iteration 1/5");
        }
      );

      // 4. Terminal states were recorded child-then-root, both succeeded.
      assert.deepEqual(
        terminalStates.map((snap) => [snap.label, snap.state]),
        [
          ["Applying review to plan.md", "succeeded"],
          ["Fast Forward Review", "succeeded"],
        ]
      );

      // 5. The in-progress row is gone; the operation-notification bridge —
      //    the real activation-time onDidEnd subscription, with no manual
      //    entry added by the test — recorded the persistent terminal entry
      //    (child operations recorded none).
      const after = (provider.getChildren() ?? []) as StatusTreeNode[];
      assert.equal(
        after.some((n) => "kind" in n && n.kind === "operation" && n.taskName.includes("lifecycle_task")),
        false,
        "no operation row survives completion"
      );
      const terminalEntries = after.filter(
        (n): n is StatusEntry => !("kind" in n) && n.message.includes("lifecycle_task")
      );
      assert.equal(
        terminalEntries.length,
        1,
        "exactly one lifecycle-backed terminal entry per root operation (children add none)"
      );
      assert.ok(
        terminalEntries[0]!.message.includes("Fast Forward Review") &&
          terminalEntries[0]!.message.includes("completed") &&
          terminalEntries[0]!.message.includes("iteration 1/5"),
        "the terminal entry records the root's label, outcome, and last iteration detail"
      );
    } finally {
      endSub.dispose();
      bridge.dispose();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });

  void it("cancel requested from the Notifications row aborts the underlying run and ends as cancelled", async () => {
    const folder = `/dev/lifecycle_cancel_${Math.floor(Math.random() * 1e9)}`;
    const provider = new StatusTreeProvider();
    initNotificationRouter(provider);
    const bridge = installOperationNotificationBridge();

    const terminalStates: string[] = [];
    const endSub = taskOperations.onDidEnd((snap) => {
      if (snap.key.includes("lifecycle_cancel")) {terminalStates.push(snap.state);}
    });

    try {
      await runTrackedOperation(
        folder,
        { label: "Review", stage: "plan-low-review", kind: "review", cancellable: true },
        (op) => {
          // What the inline cancel button invokes (extension.ts →
          // cancelOperation), addressed exactly as the tree node carries it.
          const row = operationNodes(provider).find((n) => n.label === "Review");
          assert.ok(row, "the running row exists");
          assert.equal(taskOperations.cancelOperation(row.id), true);

          // The run observes the operation token — this is what runAiToFile's
          // linked token does with the real provider process.
          assert.equal(op.token?.isCancellationRequested, true);
          return Promise.resolve();
        }
      );

      assert.deepEqual(terminalStates, ["cancelled"]);

      // The bridge converts the cancelled run into a persistent warning entry.
      const cancelledEntry = provider
        .getEntries()
        .find((e) => e.message.includes("lifecycle_cancel"));
      assert.ok(cancelledEntry, "the cancelled operation leaves a terminal entry");
      assert.equal(cancelledEntry.level, "warning");
      assert.ok(
        cancelledEntry.message.includes("Review") && cancelledEntry.message.includes("cancelled"),
        "the terminal entry records the label and the cancelled outcome"
      );
    } finally {
      endSub.dispose();
      bridge.dispose();
      provider.dispose();
      deactivateNotificationRouter();
    }
  });
});
