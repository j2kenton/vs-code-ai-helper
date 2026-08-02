/**
 * Coverage for `commitPushRowV1.ts`'s `mapCommitAndPushCoreResultToOutcomeV1`
 * (plan §3.8/§10.2, implementation-review round: "detailed outcome"
 * ownership): `commitAndPushTaskCore` now returns a discriminated
 * `CommitAndPushCoreResultV1` whose `notCompleted` case carries a specific
 * `CommitAndPushNotCompletedReasonV1` (ineligible stage, declined
 * confirmation, failed git command, ...) instead of one undifferentiated
 * signal. This proves that mapping — not the real git/UI flow inside
 * `commitAndPushTaskCore`, which is exercised by the other
 * commitAndPush*.test.ts files — turns each reason into a distinct
 * `commitPush.<reason>` coordinator outcome code, and that `completed`/
 * `noChanges` still produce the expected `{ kind: "completed" }` outcome.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  COMMIT_PUSH_ACTION_KEY_V1,
  mapCommitAndPushCoreResultToOutcomeV1,
} from "../actions/rows/commitPushRowV1";
import { LifecycleExecutionContextV1 } from "../actions/taskActionRegistryV1";
import { allocateHex128IdV1 } from "../types/actionCorrelationV1";
import { CommitAndPushCoreResultV1 } from "../commands/commitAndPushTask";

function contextFor(): Pick<
  LifecycleExecutionContextV1,
  "actionKey" | "operationId" | "taskBindingId" | "chatDocumentId"
> {
  return {
    actionKey: COMMIT_PUSH_ACTION_KEY_V1,
    operationId: allocateHex128IdV1(),
    taskBindingId: "test-task-binding",
    chatDocumentId: "test-chat-doc",
  };
}

void describe("commitPushRowV1 — mapCommitAndPushCoreResultToOutcomeV1", () => {
  void it("maps completed to a completed outcome carrying the code and full correlation", () => {
    const context = contextFor();
    const outcome = mapCommitAndPushCoreResultToOutcomeV1({ kind: "completed" }, context);
    assert.equal(outcome.kind, "completed");
    if (outcome.kind !== "completed") return;
    assert.equal(outcome.code, "completed");
    assert.equal(outcome.correlation.actionKey, context.actionKey);
    assert.equal(outcome.correlation.operationId, context.operationId);
    assert.equal(outcome.correlation.taskBindingId, context.taskBindingId);
    assert.equal(outcome.correlation.chatDocumentId, context.chatDocumentId);
    assert.equal(typeof outcome.correlation.attemptId, "string");
    assert.ok(outcome.correlation.attemptId.length > 0);
  });

  void it("maps noChanges to a completed outcome with code noChanges", () => {
    const outcome = mapCommitAndPushCoreResultToOutcomeV1({ kind: "noChanges" }, contextFor());
    assert.equal(outcome.kind, "completed");
    if (outcome.kind !== "completed") return;
    assert.equal(outcome.code, "noChanges");
  });

  void it("maps userCancelled to the standard cancelled outcome, not a retryable failure", () => {
    const context = contextFor();
    const outcome = mapCommitAndPushCoreResultToOutcomeV1(
      { kind: "notCompleted", reason: "userCancelled" },
      context
    );
    assert.equal(outcome.kind, "cancelled");
    if (outcome.kind !== "cancelled") return;
    assert.equal(outcome.code, "userCancelled");
    assert.ok(outcome.correlation);
    assert.equal(outcome.correlation?.actionKey, context.actionKey);
    assert.equal(outcome.correlation?.operationId, context.operationId);
    assert.equal(outcome.correlation?.taskBindingId, context.taskBindingId);
    assert.equal(outcome.correlation?.chatDocumentId, context.chatDocumentId);
  });

  // Every reason that represents the user explicitly declining or deferring
  // a prompt — not an error — must map to the same standard `cancelled`
  // outcome as `userCancelled`, not a retryable `failed` code. Each of these
  // reasons is set at a commitAndPushTask.ts call site that already shows an
  // information-level "cancelled" notice, exactly like the userCancelled
  // sites above.
  const declinedReasons = [
    "checksDeclined",
    "taskFolderChangesDeclined",
    "runArtifactsDeclined",
    "viewedFullFileList",
    "commitMessageCancelled",
  ] as const satisfies ReadonlyArray<
    Exclude<Extract<CommitAndPushCoreResultV1, { kind: "notCompleted" }>["reason"], "userCancelled">
  >;

  void it(`maps every declined-prompt reason (${declinedReasons.length} total) to the standard cancelled outcome`, () => {
    for (const reason of declinedReasons) {
      const context = contextFor();
      const outcome = mapCommitAndPushCoreResultToOutcomeV1(
        { kind: "notCompleted", reason },
        context
      );
      assert.equal(outcome.kind, "cancelled", `reason ${reason} should map to cancelled`);
      if (outcome.kind !== "cancelled") continue;
      assert.equal(outcome.code, "userCancelled");
      assert.equal(outcome.correlation?.actionKey, context.actionKey);
      assert.equal(outcome.correlation?.operationId, context.operationId);
    }
  });

  void it("maps questionsPosted to the standard questions outcome, carrying the metadata attempt's own correlation", () => {
    const metadataCorrelation = {
      actionKey: "commitPushMetadata.v1",
      operationId: allocateHex128IdV1(),
      attemptId: allocateHex128IdV1(),
      taskBindingId: "metadata-task-binding",
      chatDocumentId: "metadata-chat-doc",
    };
    const interactionId = allocateHex128IdV1();
    const context = contextFor();
    const outcome = mapCommitAndPushCoreResultToOutcomeV1(
      { kind: "questionsPosted", interactionId, correlation: metadataCorrelation },
      context
    );
    assert.equal(outcome.kind, "questions");
    if (outcome.kind !== "questions") return;
    assert.equal(outcome.interactionId, interactionId);
    // Uses the REAL metadata attempt's correlation, not commitPush.v1's own
    // context — the persisted Chat interaction transaction is keyed on it.
    assert.equal(outcome.correlation.actionKey, metadataCorrelation.actionKey);
    assert.equal(outcome.correlation.operationId, metadataCorrelation.operationId);
    assert.equal(outcome.correlation.taskBindingId, metadataCorrelation.taskBindingId);
    assert.notEqual(outcome.correlation.actionKey, context.actionKey);
  });

  // One row per remaining CommitAndPushNotCompletedReasonV1 member that is
  // a genuine error (not a decline) — must round-trip to its own distinct,
  // stable, retryable commitPush.<reason> code; none may collapse back onto
  // a shared generic string, and none may be a declined-prompt reason
  // (covered separately above) or userCancelled (covered above).
  const failureReasons: ReadonlyArray<
    Exclude<
      Extract<CommitAndPushCoreResultV1, { kind: "notCompleted" }>["reason"],
      "userCancelled" | (typeof declinedReasons)[number]
    >
  > = [
    "ineligibleStage",
    "noGitRepository",
    "gitIndexReadFailed",
    "privateContentStaged",
    "gitNotReady",
    "fixWithAiUnavailable",
    "saveFailed",
    "gitCommitFailed",
    "pushFailed",
    "unexpectedError",
  ];

  void it(`maps every remaining notCompleted reason (${failureReasons.length} total) to its own retryable commitPush.<reason> code`, () => {
    const seenCodes = new Set<string>();
    for (const reason of failureReasons) {
      const outcome = mapCommitAndPushCoreResultToOutcomeV1(
        { kind: "notCompleted", reason },
        contextFor()
      );
      assert.equal(outcome.kind, "failed");
      if (outcome.kind !== "failed") continue;
      assert.equal(outcome.code, `commitPush.${reason}`);
      assert.equal(outcome.retryable, true);
      assert.ok(!seenCodes.has(outcome.code), `duplicate code for reason ${reason}`);
      seenCodes.add(outcome.code);
    }
    assert.equal(seenCodes.size, failureReasons.length);
  });
});
