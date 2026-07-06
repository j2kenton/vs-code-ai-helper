import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getStageNodeContextValue } from "../views/taskTreeProvider";
import {
  AI_MODEL_STAGES,
  STAGE_ORDER,
  type TaskStage,
} from "../types/taskProgress";

// Mock dependencies before importing the module under test
import * as stageContextModule from "../utils/stageContext";
import * as taskProgressModule from "../types/taskProgress";

const mockComputeStageContext = (stage: TaskStage): string => `stage-${stage}`;
const mockIsReviewStage = (stage: string): boolean => stage.includes("review");

stageContextModule.computeStageContext = mockComputeStageContext;
taskProgressModule.isReviewStage = mockIsReviewStage as (
  stage: TaskStage
) => boolean;

void describe("getStageNodeContextValue", () => {
  const modelableStages: readonly TaskStage[] = AI_MODEL_STAGES;
  const nonModelableStages = STAGE_ORDER.filter(
    (s) => !AI_MODEL_STAGES.includes(s)
  );

  // Test cases for "current" status
  void describe('when status is "current"', () => {
    void it('should return "stage-created" for the "created" stage, without a modelable suffix', () => {
      // This is true even if "created" were to be added to AI_MODEL_STAGES
      assert.strictEqual(
        getStageNodeContextValue("created", "current"),
        "stage-created"
      );
    });

    void it('should return "stage-reviewable-current" for the "plan" stage', () => {
      const expected = modelableStages.includes("plan")
        ? "stage-reviewable-current-modelable"
        : "stage-reviewable-current";
      assert.strictEqual(getStageNodeContextValue("plan", "current"), expected);
    });

    void it('should return "stage-plan-final-current" for the "plan-final" stage', () => {
      const expected = modelableStages.includes("plan-final")
        ? "stage-plan-final-current-modelable"
        : "stage-plan-final-current";
      assert.strictEqual(
        getStageNodeContextValue("plan-final", "current"),
        expected
      );
    });

    void it('should return "stage-impl-current" for the "implementation" stage', () => {
      const expected = modelableStages.includes("implementation")
        ? "stage-impl-current-modelable"
        : "stage-impl-current";
      assert.strictEqual(
        getStageNodeContextValue("implementation", "current"),
        expected
      );
    });

    void it('should return "stage-review-current" for review stages', () => {
      const reviewStage = "plan-high-review"; // Example review stage
      const expected = modelableStages.includes(reviewStage)
        ? "stage-review-current-modelable"
        : "stage-review-current";
      assert.strictEqual(
        getStageNodeContextValue(reviewStage, "current"),
        expected
      );
    });

    void it('should return "stage-current" for other non-special stages', () => {
      // Find a stage that is not 'created', 'plan', 'plan-final', 'implementation', or a review stage
      const otherStage = "task" as TaskStage;
      const expected = modelableStages.includes(otherStage)
        ? "stage-current-modelable"
        : "stage-current";
      assert.strictEqual(
        getStageNodeContextValue(otherStage, "current"),
        expected
      );
    });
  });

  // Test cases for "done" and "outstanding" statuses
  void describe('when status is not "current"', () => {
    for (const status of ["done", "outstanding"] as const) {
      for (const stage of STAGE_ORDER) {
        void it(`should return computed context for stage "${stage}" with status "${status}"`, () => {
          const expectedBase = mockComputeStageContext(stage);
          const expected = modelableStages.includes(stage)
            ? `${expectedBase}-modelable`
            : expectedBase;
          assert.strictEqual(
            getStageNodeContextValue(stage, status),
            expected
          );
        });
      }
    }
  });

  // Test cases for modelable suffix
  void describe("modelable suffix handling", () => {
    for (const stage of modelableStages) {
      if (stage === "created") { continue; }

      void it(`should append "-modelable" for modelable stage "${stage}"`, () => {
        const context = getStageNodeContextValue(stage, "current");
        assert.ok(
          context.endsWith("-modelable"),
          `Expected ${context} to end with -modelable`
        );
      });
    }

    for (const stage of nonModelableStages) {
      void it(`should NOT append "-modelable" for non-modelable stage "${stage}"`, () => {
        const context = getStageNodeContextValue(stage, "current");
        assert.ok(
          !context.endsWith("-modelable"),
          `Expected ${context} not to end with -modelable`
        );
      });
    }
  });
});
