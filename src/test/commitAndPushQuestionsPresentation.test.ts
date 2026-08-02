/**
 * Coverage for a completion blocker found in the impl-high-review round after
 * `commitPushRowV1.ts`'s `mapCommitAndPushCoreResultToOutcomeV1` started
 * mapping the commit-message step's structured questions to the standard
 * `{ kind: "questions" }` coordinator outcome (see `commitPushRowV1.test.ts`):
 * the public helper that consumes that outcome, `invokeCommitPushRowV1`
 * (`commitAndPushTask.ts`), had no branch for `"questions"` and fell through
 * to its generic "Commit and push could not start: questions." error
 * notification — presenting a genuine, already-in-Chat questions outcome as a
 * failure. This proves the fix: a `"questions"` outcome must produce no
 * `NotificationRouter` error/warning from `invokeCommitPushRowV1` itself (the
 * real "answer in Chat With AI" warning was already shown earlier, from
 * inside `reviewCommitMessage`/`buildCommitMessage`, at the point the
 * question was actually generated — see `commitMessageReview.test.ts` for
 * that half of the flow).
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import { invokeCommitPushRowV1 } from "../commands/commitAndPushTask";
import { allocateHex128IdV1 } from "../types/actionCorrelationV1";
import { TaskActionOutcomeV1 } from "../types/taskActionOutcomeV1";
import { ResolvedTaskContext } from "../utils/resolveTaskContext";
import { TaskInventory } from "../state/taskInventory";
import {
  deactivateNotificationRouter,
  initNotificationRouter,
} from "../utils/notificationRouter";
import { fixtureOwnershipFor } from "./taskFolderFixture";

// Required (not `import`ed) so the exported function reference can be
// monkey-patched for the duration of a test — see the identical pattern and
// rationale in commitAndPushPublishGate.test.ts.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const productionRuntimeModule = require("../actions/productionTaskActionRuntimeV1") as {
  invokeLifecycleRowV1: (options: unknown) => Promise<TaskActionOutcomeV1>;
};

class RecordingSurface {
  entries: { message: string; level: "info" | "warning" | "error" }[] = [];
  addEntry(message: string, level: "info" | "warning" | "error"): void {
    this.entries.push({ message, level });
  }
}

function fakeResolvedTask(taskFolderPath: string): ResolvedTaskContext {
  return {
    taskRef: { canonicalId: taskFolderPath, taskFolderPath },
    canonicalId: taskFolderPath,
    taskFolderPath,
    folderName: "task_1",
    sourceScopeKey: "test",
    workspaceFolder: undefined,
    progress: {
      taskFolder: "task_1",
      currentStage: "publish",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      ownership: fixtureOwnershipFor(taskFolderPath),
    },
  } as unknown as ResolvedTaskContext;
}

void describe("invokeCommitPushRowV1 — questions outcome presentation", () => {
  void it("shows no error/warning notification when the row returns a questions outcome", async () => {
    const taskFolderPath = "C:\\fake\\plans\\task_1";
    const surface = new RecordingSurface();
    initNotificationRouter(surface);

    const originalInvokeLifecycleRowV1 = productionRuntimeModule.invokeLifecycleRowV1;
    const questionsOutcome: TaskActionOutcomeV1 = {
      kind: "questions",
      correlation: {
        actionKey: "commitPushMetadata.v1",
        operationId: allocateHex128IdV1(),
        attemptId: allocateHex128IdV1(),
        taskBindingId: "metadata-task-binding",
        chatDocumentId: "metadata-chat-doc",
      },
      interactionId: allocateHex128IdV1(),
    };
    productionRuntimeModule.invokeLifecycleRowV1 = (): Promise<TaskActionOutcomeV1> =>
      Promise.resolve(questionsOutcome);

    try {
      await invokeCommitPushRowV1(fakeResolvedTask(taskFolderPath), {
        inventory: {} as TaskInventory,
      });

      assert.deepEqual(
        surface.entries,
        [],
        `a questions outcome must not produce any notification here — the "answer in Chat With AI" ` +
          `warning already fired earlier, from inside reviewCommitMessage/buildCommitMessage; got: ${JSON.stringify(surface.entries)}`
      );
    } finally {
      productionRuntimeModule.invokeLifecycleRowV1 = originalInvokeLifecycleRowV1;
      deactivateNotificationRouter();
    }
  });

  void it("still shows the generic could-not-start error for an unrecognized pre-execute rejection", async () => {
    const taskFolderPath = "C:\\fake\\plans\\task_1";
    const surface = new RecordingSurface();
    initNotificationRouter(surface);

    const originalInvokeLifecycleRowV1 = productionRuntimeModule.invokeLifecycleRowV1;
    productionRuntimeModule.invokeLifecycleRowV1 = (): Promise<TaskActionOutcomeV1> =>
      Promise.resolve({ kind: "duplicateRejected", code: "operationAlreadyRunning" });

    try {
      await invokeCommitPushRowV1(fakeResolvedTask(taskFolderPath), {
        inventory: {} as TaskInventory,
      });

      assert.ok(
        surface.entries.some((e) => e.level === "error" && /could not start/.test(e.message)),
        `an unrecognized pre-execute rejection must still surface the generic error; got: ${JSON.stringify(surface.entries)}`
      );
    } finally {
      productionRuntimeModule.invokeLifecycleRowV1 = originalInvokeLifecycleRowV1;
      deactivateNotificationRouter();
    }
  });
});
