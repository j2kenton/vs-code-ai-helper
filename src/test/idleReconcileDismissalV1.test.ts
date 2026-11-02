/**
 * bugs5 Step 6 / item 21: the idle "checklist is flagged unreliable" card stays dismissed for the
 * flag's generation, is not built for a finished task, and is not built at Publish once the task's
 * tracked files have nothing uncommitted.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  idleReconcileGenerationV1,
  recordIdleReconcileDismissalV1,
  shouldBuildIdleReconcileCardV1,
  type IdleReconcileProgressSliceV1,
} from "../utils/idleReconcileCardV1";
import { trackedFilesHaveUncommittedChangesV1 } from "../utils/idleReconcileGitV1";
import { decodeTaskProgressTextV1 } from "../services/taskProgressDecoderV1";

const TASK = "/w/.ensemble/2026-10-28_task_1";

function flagged(overrides: Partial<IdleReconcileProgressSliceV1> = {}): IdleReconcileProgressSliceV1 {
  return {
    status: "active",
    currentStage: "impl",
    checklistProgressUnreliable: true,
    checklistProgressUnreliableSetAt: "2026-11-01T18:00:00.000Z",
    ...overrides,
  };
}

void describe("shouldBuildIdleReconcileCardV1 (bugs5 Step 6)", () => {
  void it("builds the card while the flag is set and nothing was dismissed", () => {
    assert.equal(shouldBuildIdleReconcileCardV1({ progress: flagged(), dismissals: {}, taskKey: TASK }), true);
  });

  void it("does not build it when the flag is not set", () => {
    assert.equal(
      shouldBuildIdleReconcileCardV1({ progress: flagged({ checklistProgressUnreliable: false }), dismissals: {}, taskKey: TASK }),
      false
    );
  });

  void it("a dismissal holds for that generation, including after a reload (the map is the stored state)", () => {
    const dismissals = recordIdleReconcileDismissalV1({}, TASK, idleReconcileGenerationV1(flagged()));
    assert.equal(shouldBuildIdleReconcileCardV1({ progress: flagged(), dismissals, taskKey: TASK }), false);
  });

  void it("a round that sets the flag again starts a new generation, so the card comes back", () => {
    const dismissals = recordIdleReconcileDismissalV1({}, TASK, idleReconcileGenerationV1(flagged()));
    const again = flagged({ checklistProgressUnreliableSetAt: "2026-11-01T19:30:00.000Z" });
    assert.equal(shouldBuildIdleReconcileCardV1({ progress: again, dismissals, taskKey: TASK }), true);
  });

  void it("a dismissal of one task does not hide another task's card", () => {
    const dismissals = recordIdleReconcileDismissalV1({}, "/w/.ensemble/other", idleReconcileGenerationV1(flagged()));
    assert.equal(shouldBuildIdleReconcileCardV1({ progress: flagged(), dismissals, taskKey: TASK }), true);
  });

  void it("a record that predates the timestamp falls back to its reason as the generation", () => {
    const legacy = flagged({ checklistProgressUnreliableSetAt: undefined, checklistProgressUnreliableReason: "claims did not match" });
    const dismissals = recordIdleReconcileDismissalV1({}, TASK, idleReconcileGenerationV1(legacy));
    assert.equal(shouldBuildIdleReconcileCardV1({ progress: legacy, dismissals, taskKey: TASK }), false);
    const changed = { ...legacy, checklistProgressUnreliableReason: "a different reason" };
    assert.equal(shouldBuildIdleReconcileCardV1({ progress: changed, dismissals, taskKey: TASK }), true);
  });

  void it("is not built for a completed or archived task", () => {
    for (const status of ["completed", "archived"] as const) {
      assert.equal(shouldBuildIdleReconcileCardV1({ progress: flagged({ status }), dismissals: {}, taskKey: TASK }), false, status);
    }
  });

  void it("at Publish it is not built once the tracked files have nothing uncommitted", () => {
    const progress = flagged({ currentStage: "publish" });
    assert.equal(
      shouldBuildIdleReconcileCardV1({ progress, dismissals: {}, taskKey: TASK, trackedFilesHaveUncommittedChanges: false }),
      false
    );
    assert.equal(
      shouldBuildIdleReconcileCardV1({ progress, dismissals: {}, taskKey: TASK, trackedFilesHaveUncommittedChanges: true }),
      true
    );
  });

  void it("at Publish an unknown answer keeps the card; the rule does not apply at other stages", () => {
    assert.equal(shouldBuildIdleReconcileCardV1({ progress: flagged({ currentStage: "publish" }), dismissals: {}, taskKey: TASK }), true);
    assert.equal(
      shouldBuildIdleReconcileCardV1({ progress: flagged(), dismissals: {}, taskKey: TASK, trackedFilesHaveUncommittedChanges: false }),
      true
    );
  });
});

void describe("trackedFilesHaveUncommittedChangesV1 (bugs5 Step 6)", () => {
  void it("says nothing (undefined) when there are no tracked files, so the card stays", async () => {
    assert.equal(await trackedFilesHaveUncommittedChangesV1(TASK, undefined), undefined);
    assert.equal(await trackedFilesHaveUncommittedChangesV1(TASK, []), undefined);
  });
});

void describe("checklistProgressUnreliableSetAt in the decoder (bugs5 Step 6)", () => {
  void it("round-trips an ISO timestamp and rejects anything else", () => {
    const doc = (setAt: unknown): string =>
      JSON.stringify({
        taskFolder: "2026-07-01_task_1",
        currentStage: "impl",
        createdAt: "2026-07-01T10:00:00.000Z",
        updatedAt: "2026-07-02T11:30:00.000Z",
        checklistProgressUnreliable: true,
        checklistProgressUnreliableSetAt: setAt,
      });
    const ok = decodeTaskProgressTextV1(doc("2026-11-01T18:00:00.000Z"));
    assert.equal(ok.ok, true, ok.ok ? "" : ok.reason);
    const bad = decodeTaskProgressTextV1(doc("yesterday"));
    assert.equal(bad.ok, false);
    if (!bad.ok) {
      assert.equal(bad.code, "invalidFieldValue");
    }
  });
});
