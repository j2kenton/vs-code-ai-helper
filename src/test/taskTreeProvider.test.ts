import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getStageNodeContextValue } from "../views/taskTreeProvider";
import {
  AI_MODEL_STAGES,
  STAGE_ORDER,
  migrateStage,
  type TaskStage,
} from "../types/taskProgress";
import { parseReadiness } from "../utils/reviewReadiness";
import { parseTaskDocument, buildTaskDocument, parseAIResponse } from "../commands/draftTaskWithAI";

// Mock dependencies before importing the module under test
import * as stageContextModule from "../utils/stageContext";
import * as taskProgressModule from "../types/taskProgress";

const mockComputeStageContext = (stage: TaskStage): string => `stage-${stage}`;
const mockIsReviewStage = (stage: string): boolean => stage.includes("review");

(stageContextModule as Record<string, unknown>).computeStageContext = mockComputeStageContext;
(taskProgressModule as Record<string, unknown>).isReviewStage = mockIsReviewStage as (
  stage: TaskStage
) => boolean;

void describe("getStageNodeContextValue", () => {
  const modelableStages: readonly TaskStage[] = AI_MODEL_STAGES;
  const nonModelableStages = STAGE_ORDER.filter(
    (s) => !AI_MODEL_STAGES.includes(s)
  );

  // Test cases for "current" status
  void describe('when status is "current"', () => {
    void it('should return "stage-task-description" for the "task-description" stage, without a modelable suffix', () => {
      assert.strictEqual(
        getStageNodeContextValue("task-description", "current"),
        "stage-task-description"
      );
    });

    void it('should return "stage-plan-current-modelable" for the "plan" stage (modelable)', () => {
      const result = getStageNodeContextValue("plan", "current");
      // plan is modelable so should have -modelable suffix
      assert.ok(
        result.includes("stage-plan-current"),
        `Expected ${result} to contain stage-plan-current`
      );
    });

    void it('should return "stage-impl-current" (modelable) for the "implementation" stage', () => {
      const result = getStageNodeContextValue("implementation", "current");
      assert.ok(
        result.includes("stage-impl-current"),
        `Expected ${result} to contain stage-impl-current`
      );
    });

    void it('should return "stage-review-current" for review stages', () => {
      const reviewStage: TaskStage = "plan-high-review";
      const result = getStageNodeContextValue(reviewStage, "current");
      assert.ok(
        result.includes("stage-review-current"),
        `Expected ${result} to contain stage-review-current`
      );
    });

    void it('should return "stage-current" for other non-special stages', () => {
      const otherStage = "completed" as TaskStage;
      const result = getStageNodeContextValue(otherStage, "current");
      assert.ok(
        result.includes("stage-current") || result.includes("stage-completed"),
        `Expected ${result} to contain stage-current or similar`
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
      if (stage === "task-description") { continue; }

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

void describe("Stage migration (migrateStage)", () => {
  void it('should migrate "created" to "task-description"', () => {
    assert.strictEqual(migrateStage("created"), "task-description");
  });

  void it('should migrate "plan-final" to "implementation"', () => {
    assert.strictEqual(migrateStage("plan-final"), "implementation");
  });

  void it('should keep "task-description" as-is', () => {
    assert.strictEqual(migrateStage("task-description"), "task-description");
  });

  void it('should keep "implementation" as-is', () => {
    assert.strictEqual(migrateStage("implementation"), "implementation");
  });

  void it('should keep "plan" as-is', () => {
    assert.strictEqual(migrateStage("plan"), "plan");
  });

  void it('should migrate "plan-review" to "plan-high-review"', () => {
    assert.strictEqual(migrateStage("plan-review"), "plan-high-review");
  });

  void it('should fallback unknown to "task-description"', () => {
    assert.strictEqual(migrateStage("unknown-stage"), "task-description");
  });
});

void describe("reviewReadiness.parseReadiness", () => {
  void it('should parse "Readiness: 9/10" and return green thumbsup', () => {
    const result = parseReadiness("Readiness: 9/10\nSome content");
    assert.strictEqual(result.score, 9);
    assert.strictEqual(result.label, "9/10");
    assert.strictEqual(result.icon, "thumbsup");
    assert.strictEqual(result.colorKey, "charts.green");
  });

  void it('should parse "Readiness: 10/10"', () => {
    const result = parseReadiness("Readiness: 10/10");
    assert.strictEqual(result.score, 10);
    assert.strictEqual(result.icon, "thumbsup");
  });

  void it('should parse "Readiness: 8/10" as green', () => {
    const result = parseReadiness("Readiness: 8/10");
    assert.strictEqual(result.score, 8);
    assert.strictEqual(result.icon, "thumbsup");
  });

  void it('should parse "Readiness: 7/10" as yellow question', () => {
    const result = parseReadiness("Readiness: 7/10");
    assert.strictEqual(result.score, 7);
    assert.strictEqual(result.icon, "question");
    assert.strictEqual(result.colorKey, "charts.yellow");
  });

  void it('should parse "Readiness: 5/10" as yellow', () => {
    const result = parseReadiness("Readiness: 5/10");
    assert.strictEqual(result.score, 5);
    assert.strictEqual(result.icon, "question");
  });

  void it('should parse "Readiness: 4/10" as red thumbsdown', () => {
    const result = parseReadiness("Readiness: 4/10");
    assert.strictEqual(result.score, 4);
    assert.strictEqual(result.icon, "thumbsdown");
    assert.strictEqual(result.colorKey, "charts.red");
  });

  void it('should parse "Readiness: 0/10" as red', () => {
    const result = parseReadiness("Readiness: 0/10");
    assert.strictEqual(result.score, 0);
    assert.strictEqual(result.icon, "thumbsdown");
  });

  void it('should use legacy fallback for case-insensitive readiness wording', () => {
    const result = parseReadiness("Overall readiness 7/10 based on analysis");
    assert.strictEqual(result.score, 7);
    assert.strictEqual(result.icon, "question");
  });

  void it('should return neutral icon for missing readiness', () => {
    const result = parseReadiness("No readiness score here");
    assert.strictEqual(result.score, null);
    assert.strictEqual(result.label, "—/10");
    assert.strictEqual(result.icon, "circle-outline");
  });

  void it('should return neutral icon for empty content', () => {
    const result = parseReadiness("");
    assert.strictEqual(result.score, null);
    assert.strictEqual(result.label, "—/10");
  });
});

void describe("draftTaskWithAI.parseTaskDocument", () => {
  void it('should parse a new-style task.md with all three sections', () => {
    const content = [
      "Briefly describe what changes you want to be made, and then use AI to help you clarify the plan.",
      "",
      "Shortcut: Apply Current Stage Action (Windows/Linux: Ctrl+Shift+Alt+I, macOS: Cmd+Shift+Alt+I).",
      "",
      "## Task Description",
      "",
      "Add dark mode support.",
      "",
      "## Draft with AI",
      "",
      "This task involves...",
      "",
      "## Open Questions",
      "",
      "- Which components need theming?",
      "",
    ].join("\n");

    const parsed = parseTaskDocument(content);
    assert.ok(parsed.introText.includes("Briefly describe"));
    assert.ok(parsed.introText.includes("Shortcut:"));
    assert.strictEqual(parsed.taskDescription, "Add dark mode support.");
    assert.strictEqual(parsed.draftWithAI, "This task involves...");
    assert.strictEqual(parsed.openQuestions, "- Which components need theming?");
  });

  void it('should move non-canonical top-level headers into Task Description', () => {
    const content = [
      "## Task Description",
      "",
      "Main description.",
      "",
      "## Background",
      "",
      "Some context.",
      "",
    ].join("\n");

    const parsed = parseTaskDocument(content);
    assert.ok(parsed.taskDescription.includes("Main description."));
    assert.ok(parsed.taskDescription.includes("## Background"));
    assert.ok(parsed.taskDescription.includes("Some context."));
  });

  void it('should move stray pre-header content into Task Description', () => {
    const content = "Some stray content\n\n## Task Description\n\nReal description.\n";
    const parsed = parseTaskDocument(content);
    assert.ok(parsed.taskDescription.includes("Some stray content"));
    assert.ok(parsed.taskDescription.includes("Real description."));
  });

  void it('should not treat content inside fenced code blocks as headers', () => {
    const content = [
      "## Task Description",
      "",
      "Description.",
      "",
      "```",
      "## not a header",
      "```",
      "",
    ].join("\n");

    const parsed = parseTaskDocument(content);
    assert.ok(parsed.taskDescription.includes("Description."));
    assert.ok(parsed.taskDescription.includes("## not a header"));
  });

  void it('should create empty sections when managed headers are missing', () => {
    const content = "## Task Description\n\nSome task.\n";
    const parsed = parseTaskDocument(content);
    assert.strictEqual(parsed.taskDescription, "Some task.");
    assert.strictEqual(parsed.draftWithAI, "");
    assert.strictEqual(parsed.openQuestions, "");
  });

  void it('should merge duplicate Task Description sections', () => {
    const content = [
      "## Task Description",
      "",
      "First part.",
      "",
      "## Draft with AI",
      "",
      "Draft content.",
      "",
      "## Task Description",
      "",
      "Second part.",
      "",
    ].join("\n");

    const parsed = parseTaskDocument(content);
    assert.ok(parsed.taskDescription.includes("First part."));
    assert.ok(parsed.taskDescription.includes("Second part."));
  });
});

void describe("draftTaskWithAI.buildTaskDocument", () => {
  void it('should produce canonical section order', () => {
    const doc = buildTaskDocument({
      introText: "Intro text.\n\nShortcut: note.",
      taskDescription: "My task.",
      draftWithAI: "Draft here.",
      openQuestions: "- Q1",
    });
    const introIdx = doc.indexOf("Intro text.");
    const taskIdx = doc.indexOf("## Task Description");
    const draftIdx = doc.indexOf("## Draft with AI");
    const questionsIdx = doc.indexOf("## Open Questions");

    assert.ok(introIdx < taskIdx);
    assert.ok(taskIdx < draftIdx);
    assert.ok(draftIdx < questionsIdx);
  });
});

void describe("draftTaskWithAI.parseAIResponse", () => {
  void it('should parse a valid AI response with both required sections', () => {
    const response = [
      "## Draft with AI",
      "",
      "This is the draft content.",
      "",
      "## Open Questions",
      "",
      "- What is the scope?",
      "- Which files?",
    ].join("\n");

    const result = parseAIResponse(response);
    assert.ok(result !== undefined);
    if (!result) {
      assert.fail("Expected parseAIResponse to return a result");
    }
    assert.strictEqual(result.draftWithAI, "This is the draft content.");
    assert.ok(result.openQuestions.includes("- What is the scope?"));
  });

  void it('should return undefined when Draft with AI header is missing', () => {
    const response = "## Open Questions\n\n- Some question.";
    assert.strictEqual(parseAIResponse(response), undefined);
  });

  void it('should return undefined when Open Questions header is missing', () => {
    const response = "## Draft with AI\n\nSome draft.";
    assert.strictEqual(parseAIResponse(response), undefined);
  });

  void it('should return undefined when headers are in wrong order', () => {
    const response = "## Open Questions\n\n- Q1\n\n## Draft with AI\n\nDraft.";
    assert.strictEqual(parseAIResponse(response), undefined);
  });

  void it('should return undefined when Draft with AI appears twice', () => {
    const response = "## Draft with AI\n\nDraft 1.\n\n## Open Questions\n\n- Q1\n\n## Draft with AI\n\nDraft 2.";
    assert.strictEqual(parseAIResponse(response), undefined);
  });

  void it('should return undefined when Open Questions appears twice', () => {
    const response = "## Draft with AI\n\nDraft.\n\n## Open Questions\n\n- Q1\n\n## Open Questions\n\n- Q2";
    assert.strictEqual(parseAIResponse(response), undefined);
  });

  void it('should parse "- None." as a valid empty open questions response', () => {
    const response = "## Draft with AI\n\nDraft.\n\n## Open Questions\n\n- None.";
    const result = parseAIResponse(response);
    assert.ok(result !== undefined);
    if (!result) {
      assert.fail("Expected parseAIResponse to return a result");
    }
    assert.strictEqual(result.openQuestions, "- None.");
  });
});

void describe("Stage order and STAGE_ORDER", () => {
  void it('should contain "task-description" as the first stage', () => {
    assert.strictEqual(STAGE_ORDER[0], "task-description");
  });

  void it('should NOT contain "created" stage', () => {
    assert.strictEqual(STAGE_ORDER.some((s) => String(s) === "created"), false);
  });

  void it('should NOT contain "plan-final" stage', () => {
    assert.strictEqual(STAGE_ORDER.some((s) => String(s) === "plan-final"), false);
  });

  void it('should contain exactly one "implementation" entry', () => {
    const count = STAGE_ORDER.filter(
      (s) => s === "implementation"
    ).length;
    assert.strictEqual(count, 1);
  });

  void it('should contain "completed" as the last stage', () => {
    assert.strictEqual(STAGE_ORDER[STAGE_ORDER.length - 1], "completed");
  });
});
