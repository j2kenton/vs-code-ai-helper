/**
 * Coverage for `commitPushRowV1.ts`'s coordinator-owned presentation
 * boundary (plan §3.8: "the coordinator owns ... presentation" — the
 * implementation-review blocker "full Commit/Push coordinator ownership").
 *
 * None of the coordinator-native step functions in `commitAndPushTask.ts`
 * (`checkCommitPushIndexPrivacyV1` through `pushCommitPushV1`) show their own
 * outcome notification; each returns a plain `CommitAndPushCoreResultV1`-
 * shaped result instead. `presentCommitPushCoreResultV1` is the single choke
 * point that turns that result into the notification the user sees, and
 * `deriveCommitPushOperationEndStateV1` is the single choke point that turns
 * it into the tracked operation's terminal Notifications-row state. This
 * file proves both directly, for every `CommitAndPushCoreResultV1` shape —
 * completed, noChanges, questionsPosted, and every
 * `CommitAndPushNotCompletedReasonV1` — rather than relying only on the
 * source-order assertions in `commitAndPushIndexGuard.test.ts` or the single
 * behavioral case (`gitNotReady`) in `commitPushRowV1GitReadiness.test.ts`.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as vscode from "vscode";

import {
  presentCommitPushCoreResultV1,
  deriveCommitPushOperationEndStateV1,
} from "../actions/rows/commitPushRowV1";
import { CommitAndPushCoreResultV1, CommitAndPushNotCompletedReasonV1 } from "../commands/commitAndPushTask";
import { TaskOperationHandle } from "../utils/taskOperations";
import {
  deactivateNotificationRouter,
  initNotificationRouter,
} from "../utils/notificationRouter";

class RecordingSurface {
  entries: { message: string; level: "info" | "warning" | "error" }[] = [];
  addEntry(message: string, level: "info" | "warning" | "error"): void {
    this.entries.push({ message, level });
  }
}

/** Runs `fn` with a fresh recording NotificationRouter surface, always deactivating afterward. */
function withRecordingSurface(fn: (surface: RecordingSurface) => void): RecordingSurface {
  const surface = new RecordingSurface();
  initNotificationRouter(surface);
  try {
    fn(surface);
  } finally {
    deactivateNotificationRouter();
  }
  return surface;
}

function fakeOp(cancelled: boolean): TaskOperationHandle {
  return {
    id: "op-test",
    key: "c:/tasks/task_1",
    label: "Commit and Push",
    report: () => {},
    token: { isCancellationRequested: cancelled } as vscode.CancellationToken,
  } as unknown as TaskOperationHandle;
}

// Every `CommitAndPushNotCompletedReasonV1` member that represents the user
// explicitly declining/deferring a prompt — must present at "information"
// level and end the tracked operation as "cancelled", exactly like
// `userCancelled`.
const DECLINED_REASONS: readonly CommitAndPushNotCompletedReasonV1[] = [
  "checksDeclined",
  "taskFolderChangesDeclined",
  "runArtifactsDeclined",
  "viewedFullFileList",
  "commitMessageCancelled",
];

// Every remaining reason — a genuine error, not a decline — must present at
// its fixed level and end the tracked operation as "failed".
const FAILURE_REASONS: readonly {
  reason: CommitAndPushNotCompletedReasonV1;
  level: "error" | "warning";
}[] = [
  { reason: "ineligibleStage", level: "warning" },
  { reason: "noGitRepository", level: "error" },
  { reason: "gitIndexReadFailed", level: "error" },
  { reason: "privateContentStaged", level: "error" },
  { reason: "gitNotReady", level: "error" },
  { reason: "fixWithAiUnavailable", level: "warning" },
  { reason: "saveFailed", level: "error" },
  { reason: "gitCommitFailed", level: "error" },
  { reason: "pushFailed", level: "error" },
  { reason: "unexpectedError", level: "error" },
];

void describe("commitPushRowV1 — presentCommitPushCoreResultV1 (coordinator-owned presentation)", () => {
  void it("presents completed with its own detail text at information level, exactly once", () => {
    const surface = withRecordingSurface((s) => {
      presentCommitPushCoreResultV1({ kind: "completed", detail: "Successfully committed and pushed task_1 to origin/main" });
      void s;
    });
    assert.equal(surface.entries.length, 1);
    assert.equal(surface.entries[0]!.level, "info");
    assert.equal(surface.entries[0]!.message, "Successfully committed and pushed task_1 to origin/main");
  });

  void it("presents completed with no detail using the default success text, exactly once", () => {
    const surface = withRecordingSurface(() => {
      presentCommitPushCoreResultV1({ kind: "completed" });
    });
    assert.equal(surface.entries.length, 1);
    assert.equal(surface.entries[0]!.level, "info");
    assert.equal(surface.entries[0]!.message, "Committed and pushed successfully.");
  });

  void it("presents noChanges at information level, exactly once", () => {
    const surface = withRecordingSurface(() => {
      presentCommitPushCoreResultV1({ kind: "noChanges" });
    });
    assert.equal(surface.entries.length, 1);
    assert.equal(surface.entries[0]!.level, "info");
    assert.equal(surface.entries[0]!.message, "No changes to commit — the repository is clean.");
  });

  void it("presents nothing for questionsPosted — the question already reached Chat With AI from inside the metadata step", () => {
    const surface = withRecordingSurface(() => {
      presentCommitPushCoreResultV1({
        kind: "questionsPosted",
        interactionId: "interaction-1",
        correlation: {
          actionKey: "commitPushMetadata.v1",
          operationId: "op-1",
          attemptId: "attempt-1",
          taskBindingId: "task-binding-1",
          chatDocumentId: "chat-doc-1",
        },
      });
    });
    assert.equal(surface.entries.length, 0);
  });

  void it(`presents every declined-prompt reason (${DECLINED_REASONS.length} total) at information level, exactly once`, () => {
    for (const reason of DECLINED_REASONS) {
      const surface = withRecordingSurface(() => {
        presentCommitPushCoreResultV1({ kind: "notCompleted", reason });
      });
      assert.equal(surface.entries.length, 1, `reason ${reason} must present exactly one entry`);
      assert.equal(surface.entries[0]!.level, "info", `reason ${reason} must present at information level`);
    }
  });

  void it(`presents every remaining notCompleted reason (${FAILURE_REASONS.length} total) at its fixed level, exactly once, using detail when supplied`, () => {
    for (const { reason, level } of FAILURE_REASONS) {
      // No detail: falls back to the fixed default text for this reason.
      const withoutDetail = withRecordingSurface(() => {
        presentCommitPushCoreResultV1({ kind: "notCompleted", reason });
      });
      assert.equal(withoutDetail.entries.length, 1, `reason ${reason} (no detail) must present exactly one entry`);
      assert.equal(withoutDetail.entries[0]!.level, level, `reason ${reason} must present at ${level} level`);

      // With detail: the caller-supplied text wins over the fixed default.
      const detailText = `dynamic detail for ${reason}`;
      const withDetail = withRecordingSurface(() => {
        presentCommitPushCoreResultV1({ kind: "notCompleted", reason, detail: detailText });
      });
      assert.equal(withDetail.entries.length, 1, `reason ${reason} (with detail) must present exactly one entry`);
      assert.equal(withDetail.entries[0]!.level, level);
      assert.equal(withDetail.entries[0]!.message, detailText);
    }
  });

  void it("presents userCancelled at information level, exactly once", () => {
    const surface = withRecordingSurface(() => {
      presentCommitPushCoreResultV1({ kind: "notCompleted", reason: "userCancelled" });
    });
    assert.equal(surface.entries.length, 1);
    assert.equal(surface.entries[0]!.level, "info");
  });
});

void describe("commitPushRowV1 — deriveCommitPushOperationEndStateV1 (coordinator-owned tracked-operation settlement)", () => {
  void it("ends as succeeded for completed/noChanges/questionsPosted when the token was not cancelled", () => {
    const results: CommitAndPushCoreResultV1[] = [
      { kind: "completed" },
      { kind: "noChanges" },
      {
        kind: "questionsPosted",
        interactionId: "interaction-1",
        correlation: {
          actionKey: "commitPushMetadata.v1",
          operationId: "op-1",
          attemptId: "attempt-1",
          taskBindingId: "task-binding-1",
          chatDocumentId: "chat-doc-1",
        },
      },
    ];
    for (const result of results) {
      assert.equal(deriveCommitPushOperationEndStateV1(fakeOp(false), result), "succeeded");
    }
  });

  void it(`ends as cancelled for userCancelled and every declined-prompt reason (${DECLINED_REASONS.length + 1} total)`, () => {
    for (const reason of ["userCancelled" as const, ...DECLINED_REASONS]) {
      const result: CommitAndPushCoreResultV1 = { kind: "notCompleted", reason };
      assert.equal(
        deriveCommitPushOperationEndStateV1(fakeOp(false), result),
        "cancelled",
        `reason ${reason} must end the operation as cancelled`
      );
    }
  });

  void it(`ends as failed for every remaining notCompleted reason (${FAILURE_REASONS.length} total)`, () => {
    for (const { reason } of FAILURE_REASONS) {
      const result: CommitAndPushCoreResultV1 = { kind: "notCompleted", reason };
      assert.equal(
        deriveCommitPushOperationEndStateV1(fakeOp(false), result),
        "failed",
        `reason ${reason} must end the operation as failed`
      );
    }
  });

  void it("ends as cancelled whenever the operation's own token was cancelled, regardless of the result", () => {
    // Real token-based cancellation wins outright, even over a result that
    // would otherwise map to "succeeded" or "failed".
    assert.equal(deriveCommitPushOperationEndStateV1(fakeOp(true), { kind: "completed" }), "cancelled");
    assert.equal(
      deriveCommitPushOperationEndStateV1(fakeOp(true), { kind: "notCompleted", reason: "gitCommitFailed", detail: "x" }),
      "cancelled"
    );
  });
});
