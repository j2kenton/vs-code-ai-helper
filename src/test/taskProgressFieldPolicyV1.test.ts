/**
 * Coverage for the exhaustive §3.11 field policy: every persisted field has
 * a table row, and the nextStage/markTaskDone/reopen transitions apply every
 * column rule (binding preserved, runtime state consumed, completion ticks a
 * canonical prefix, reopen clearing later-stage state). End-to-end
 * transition fixtures live under test-fixtures/task-progress/transitions/.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  PersistedTaskProgressV1,
  TASK_PROGRESS_PRODUCT_FIELD_NAMES_V1,
  decodeTaskProgressTextV1,
} from "../services/taskProgressDecoderV1";
import {
  TASK_PROGRESS_FIELD_POLICY_V1,
  applyMarkTaskDonePolicyV1,
  applyNextStagePolicyV1,
  applyReopenPolicyV1,
} from "../services/taskProgressFieldPolicyV1";
import { encodeTaskProgressV1 } from "../services/taskProgressWriterV1";
import { TaskStage } from "../types/taskProgress";

const NOW = "2026-07-10T09:00:00.000Z";
const TRANSITIONS_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  "test-fixtures",
  "task-progress",
  "transitions"
);

const OWNERSHIP = {
  metaRoot: "c:/proj/.vscode/ai-helper-meta",
  projectRoot: "c:/proj",
  boundAt: "2026-07-01T10:00:00.000Z",
  state: "resolved" as const,
};

function baseProgress(overrides: Partial<PersistedTaskProgressV1>): PersistedTaskProgressV1 {
  return {
    ensembleProgressVersion: 1,
    taskFolder: "2026-07-01_task_1",
    displayName: "ff for 1 pt 2",
    nameIsDefault: false,
    currentStage: "impl",
    status: "active",
    ownership: OWNERSHIP,
    createdAt: "2026-07-01T10:00:00.000Z",
    updatedAt: "2026-07-02T11:30:00.000Z",
    preImageDescription: "original description",
    completedStages: ["desc", "plan", "plan-high-review", "plan-low-review"],
    ...overrides,
  };
}

void describe("taskProgressFieldPolicyV1", () => {
  void it("has a policy row for every persisted field plus the version marker", () => {
    const expected = [
      ...TASK_PROGRESS_PRODUCT_FIELD_NAMES_V1,
      "ensembleProgressVersion",
    ].sort();
    assert.deepEqual(Object.keys(TASK_PROGRESS_FIELD_POLICY_V1).sort(), expected);
    for (const row of Object.values(TASK_PROGRESS_FIELD_POLICY_V1)) {
      for (const column of ["migration", "nextStage", "markTaskDone", "reopen"] as const) {
        assert.ok(row[column].length > 0, "every policy cell must be authored");
      }
    }
  });

  void it("nextStage applies every column rule", () => {
    const input = baseProgress({
      lintPayload: { runAt: NOW, passed: true },
      scheduledRun: { runAt: "2026-07-11T08:00:00.000Z", stage: "impl" },
      reviewAttemptId: "attempt-9",
      escalation: {
        stage: "impl",
        kind: "plateau",
        reason: "stuck",
        at: "2026-07-09T00:00:00.000Z",
      },
      fallbackActive: { plan: true, impl: true },
      fallbackModelId: { plan: "model-a", impl: "model-b" },
      implReviewFiles: ["src/a.ts"],
      reviewScoreHistory: [
        {
          stage: "impl",
          score: 7,
          attemptId: "attempt-8",
          at: "2026-07-08T00:00:00.000Z",
          blockerCount: 1,
          taskFixableCount: 1,
        },
      ],
      pinnedAt: "2026-07-05T00:00:00.000Z",
      publishScopePath: "packages/core",
    });
    const result = applyNextStagePolicyV1(input, { now: NOW });
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    const next = result.progress;
    assert.equal(next.currentStage, "impl-high-review");
    assert.equal(next.status, "active");
    assert.equal(next.updatedAt, NOW);
    assert.equal(next.completedAt, undefined);
    assert.deepEqual(next.completedStages, [
      "desc",
      "plan",
      "plan-high-review",
      "plan-low-review",
      "impl",
    ]);
    assert.equal(next.lintPayload, undefined);
    assert.equal(next.scheduledRun, undefined);
    assert.equal(next.scheduledResumeTime, undefined);
    assert.equal(next.reviewAttemptId, undefined);
    assert.equal(next.escalation, undefined);
    assert.deepEqual(next.fallbackActive, { plan: true, impl: false });
    assert.deepEqual(next.fallbackModelId, { plan: "model-a" });
    assert.deepEqual(next.implReviewFiles, ["src/a.ts"]);
    assert.deepEqual(next.reviewScoreHistory, input.reviewScoreHistory);
    // Binding, creation, and display metadata preserved exactly.
    assert.deepEqual(next.ownership, OWNERSHIP);
    assert.equal(next.taskFolder, input.taskFolder);
    assert.equal(next.createdAt, input.createdAt);
    assert.equal(next.displayName, input.displayName);
    assert.equal(next.nameIsDefault, input.nameIsDefault);
    assert.equal(next.preImageDescription, input.preImageDescription);
    assert.equal(next.pinnedAt, input.pinnedAt);
    assert.equal(next.publishScopePath, input.publishScopePath);
  });

  void it("nextStage rejects non-active tasks and the terminal stage", () => {
    const paused = applyNextStagePolicyV1(baseProgress({ status: "paused" }), { now: NOW });
    assert.equal(paused.ok, false);
    if (!paused.ok) {
      assert.equal(paused.code, "statusNotActive");
    }
    const terminal = applyNextStagePolicyV1(
      baseProgress({
        currentStage: "publish",
        completedStages: [
          "desc",
          "plan",
          "plan-high-review",
          "plan-low-review",
          "impl",
          "impl-high-review",
          "impl-low-review",
        ],
      }),
      { now: NOW }
    );
    assert.equal(terminal.ok, false);
    if (!terminal.ok) {
      assert.equal(terminal.code, "noNextStage");
    }
    const badClock = applyNextStagePolicyV1(baseProgress({}), { now: "yesterday" });
    assert.equal(badClock.ok, false);
    if (!badClock.ok) {
      assert.equal(badClock.code, "invalidTimestamp");
    }
  });

  void it("markTaskDone completes an active task exactly once from the coordinator clock", () => {
    const input = baseProgress({
      currentStage: "publish",
      completedStages: [
        "desc",
        "plan",
        "plan-high-review",
        "plan-low-review",
        "impl",
        "impl-high-review",
        "impl-low-review",
      ],
      lintPayload: { runAt: NOW, passed: true },
      reviewAttemptId: "attempt-3",
      fallbackActive: { impl: true, publish: true },
    });
    const result = applyMarkTaskDonePolicyV1(input, { now: NOW });
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    const done = result.progress;
    assert.equal(done.status, "completed");
    assert.equal(done.completedAt, NOW);
    assert.equal(done.updatedAt, NOW);
    assert.equal(done.currentStage, "publish");
    assert.deepEqual(done.completedStages?.at(-1), "publish");
    assert.equal(done.lintPayload, undefined);
    assert.equal(done.reviewAttemptId, undefined);
    // The current-stage entry flips to false where it exists; earlier
    // entries are retained untouched.
    assert.deepEqual(done.fallbackActive, { impl: true, publish: false });
    assert.deepEqual(done.ownership, OWNERSHIP);

    const notActive = applyMarkTaskDonePolicyV1(
      baseProgress({ status: "completed", completedAt: NOW }),
      { now: NOW }
    );
    assert.equal(notActive.ok, false);
    if (!notActive.ok) {
      assert.equal(notActive.code, "statusNotActive");
    }
  });

  void it("reopen reactivates a completed task and clears later-stage state", () => {
    const completedInput = baseProgress({
      status: "completed",
      currentStage: "publish",
      completedAt: "2026-07-09T00:00:00.000Z",
      completedStages: [
        "desc",
        "plan",
        "plan-high-review",
        "plan-low-review",
        "impl",
        "impl-high-review",
        "impl-low-review",
        "publish",
      ],
      implReviewFiles: ["src/a.ts"],
      lintPayload: { runAt: NOW, passed: true },
      fallbackActive: { plan: true, impl: true, publish: true },
      fallbackModelId: { plan: "model-a", impl: "model-b" },
    });

    const atImpl = applyReopenPolicyV1(completedInput, { now: NOW, selectedStage: "impl" });
    assert.equal(atImpl.ok, true);
    if (atImpl.ok) {
      const reopened = atImpl.progress;
      assert.equal(reopened.status, "active");
      assert.equal(reopened.currentStage, "impl");
      assert.equal(reopened.completedAt, undefined);
      assert.deepEqual(reopened.completedStages, [
        "desc",
        "plan",
        "plan-high-review",
        "plan-low-review",
      ]);
      // impl is not strictly before impl — review scope resets.
      assert.deepEqual(reopened.implReviewFiles, []);
      assert.equal(reopened.lintPayload, undefined);
      // Only existing entries at/after the selected stage flip to false;
      // stages with no reservation entry are not materialized.
      assert.deepEqual(reopened.fallbackActive, {
        plan: true,
        impl: false,
        publish: false,
      });
      assert.deepEqual(reopened.fallbackModelId, { plan: "model-a" });
      assert.deepEqual(reopened.ownership, OWNERSHIP);
      assert.equal(reopened.createdAt, completedInput.createdAt);
      assert.equal(reopened.displayName, completedInput.displayName);
    }

    const atImplHighReview = applyReopenPolicyV1(completedInput, {
      now: NOW,
      selectedStage: "impl-high-review",
    });
    assert.equal(atImplHighReview.ok, true);
    if (atImplHighReview.ok) {
      // impl IS strictly before impl-high-review — review scope survives.
      assert.deepEqual(atImplHighReview.progress.implReviewFiles, ["src/a.ts"]);
    }

    // A completed task with no fallback map stays without one — reopen must
    // not grow the persisted document with entries no reservation created.
    const noFallback = applyReopenPolicyV1(
      baseProgress({
        status: "completed",
        currentStage: "publish",
        completedAt: "2026-07-09T00:00:00.000Z",
        completedStages: [
          "desc",
          "plan",
          "plan-high-review",
          "plan-low-review",
          "impl",
          "impl-high-review",
          "impl-low-review",
          "publish",
        ],
        fallbackActive: undefined,
      }),
      { now: NOW, selectedStage: "publish" }
    );
    assert.equal(noFallback.ok, true);
    if (noFallback.ok) {
      assert.equal(noFallback.progress.fallbackActive, undefined);
    }

    const notCompleted = applyReopenPolicyV1(baseProgress({}), {
      now: NOW,
      selectedStage: "publish",
    });
    assert.equal(notCompleted.ok, false);
    if (!notCompleted.ok) {
      assert.equal(notCompleted.code, "statusNotCompleted");
    }
  });

  void it("advances and completes tasks whose completedStages was never written (real emitter state)", () => {
    // No production writer records a completion tick before the terminal
    // action — a normal mid-flight task carries no completedStages at all.
    // Advancing must backfill the prefix through the departing stage.
    const advanced = applyNextStagePolicyV1(
      baseProgress({ completedStages: undefined }),
      { now: NOW }
    );
    assert.equal(advanced.ok, true);
    if (advanced.ok) {
      assert.deepEqual(advanced.progress.completedStages, [
        "desc",
        "plan",
        "plan-high-review",
        "plan-low-review",
        "impl",
      ]);
      // A task that never had a fallback map does not acquire one on its
      // first advance — parity with reopen and clearStageFallbackReservation.
      assert.equal(advanced.progress.fallbackActive, undefined);
    }

    // markTaskDone on the real pre-completion shape (publish stage, no
    // ticks) — the installed base's completed tasks all came from this path.
    const done = applyMarkTaskDonePolicyV1(
      baseProgress({ currentStage: "publish", completedStages: undefined }),
      { now: NOW }
    );
    assert.equal(done.ok, true);
    if (done.ok) {
      assert.deepEqual(done.progress.completedStages, [
        "desc",
        "plan",
        "plan-high-review",
        "plan-low-review",
        "impl",
        "impl-high-review",
        "impl-low-review",
        "publish",
      ]);
      assert.equal(done.progress.fallbackActive, undefined);
    }
  });

  void it("applies every checked-in transition fixture end to end through decode → policy → encode", () => {
    const files = fs.readdirSync(TRANSITIONS_DIR).filter((f) => f.endsWith(".json")).sort();
    assert.ok(files.length >= 5, "transition fixtures must exist (plan §3.11)");
    for (const file of files) {
      const fixture = JSON.parse(
        fs.readFileSync(path.join(TRANSITIONS_DIR, file), "utf8")
      ) as {
        transition: "nextStage" | "markTaskDone" | "reopen";
        now: string;
        selectedStage?: string;
        input: Record<string, unknown>;
        expected: Record<string, unknown>;
      };
      const decoded = decodeTaskProgressTextV1(JSON.stringify(fixture.input, null, 2));
      assert.equal(decoded.ok, true, `${file}: fixture input must decode strictly`);
      if (!decoded.ok) {
        continue;
      }
      const progress = decoded.decoded.progress;
      const result =
        fixture.transition === "nextStage"
          ? applyNextStagePolicyV1(progress, { now: fixture.now })
          : fixture.transition === "markTaskDone"
            ? applyMarkTaskDonePolicyV1(progress, { now: fixture.now })
            : applyReopenPolicyV1(progress, {
                now: fixture.now,
                selectedStage: fixture.selectedStage as TaskStage,
              });
      assert.equal(result.ok, true, `${file}: transition must be valid`);
      if (!result.ok) {
        continue;
      }
      const persisted = JSON.parse(
        encodeTaskProgressV1(result.progress, decoded.decoded.entries)
      ) as Record<string, unknown>;
      assert.deepEqual(persisted, fixture.expected, `${file}: persisted output mismatch`);
    }
  });
});
