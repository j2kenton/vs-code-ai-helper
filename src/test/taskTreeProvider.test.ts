import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { getStageNodeContextValue, StageNode } from "../views/taskTreeProvider";
import { buildTaskContextValue, buildStageContextValue } from "../utils/contextTokens";
import {
  AI_MODEL_STAGES,
  STAGE_ORDER,
  migrateStage,
  type TaskStage,
} from "../types/taskProgress";
import { parseReadiness } from "../utils/reviewReadiness";
import { parseTaskDocument, buildTaskDocument, parseAIResponse } from "../commands/draftTaskWithAI";
import { shortcutHint } from "../utils/shortcutHints";

// Mock dependencies before importing the module under test
import * as stageContextModule from "../utils/stageContext";
import * as taskProgressModule from "../types/taskProgress";


const mockComputeStageContext = (stage: TaskStage): string => `stage-${stage}`;
const mockIsReviewStage = (stage: string): boolean => stage.includes("review");

(stageContextModule as Record<string, unknown>).computeStageContext = mockComputeStageContext;
(taskProgressModule as Record<string, unknown>).isReviewStage = mockIsReviewStage as (
  stage: TaskStage
) => boolean;

// No buildStageContextValue mock here, use the real one.


/** Minimal IncompleteTask stub for StageNode construction */
function makeTask(currentStage: TaskStage = "impl"): {
  folderUri: vscode.Uri;
  folderName: string;
  progress: {
    currentStage: TaskStage;
    status: "active";
    taskFolder: string;
    createdAt: string;
    updatedAt: string;
  };
} {
  return {
    folderUri: vscode.Uri.file("/workspace/tasks/my-task"),
    folderName: "my-task",
    progress: {
      currentStage,
      status: "active" as const,
      taskFolder: "my-task",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  };
}

void describe("getStageNodeContextValue", () => {
  const modelableStages: readonly TaskStage[] = AI_MODEL_STAGES;
  const nonModelableStages = STAGE_ORDER.filter(
    (s) => !AI_MODEL_STAGES.includes(s)
  );

  // Test cases for "current" status
  void describe('when status is "current"', () => {
    // task-description IS in AI_MODEL_STAGES, so the context value has
    // the -modelable suffix appended.
    void it('should return "stage-desc-current-modelable" for the "desc" stage', () => {
      assert.strictEqual(
        getStageNodeContextValue("desc", "current"),
        "stage-desc-current-modelable"
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

    void it('should return "stage-impl-current" (modelable) for the "impl" stage', () => {
      const result = getStageNodeContextValue("impl", "current");
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

    void it('should return "stage-publish-current-modelable" for publish stage', () => {
      // publish is in AI_MODEL_STAGES (Set Model + chat-with-AI on Publish),
      // so it gets the -modelable suffix like desc/plan/impl.
      const otherStage = "publish" as TaskStage;
      const result = getStageNodeContextValue(otherStage, "current");
      assert.strictEqual(result, "stage-publish-current-modelable");
    });

    void it('should return paused suffix if isPaused is true', () => {
      assert.strictEqual(
        getStageNodeContextValue("desc", "current", true),
        "stage-desc-current-paused-modelable"
      );
    });

    void it('should return lint-known suffix if hasLintPayload is true on final review stage', () => {
      assert.strictEqual(
        getStageNodeContextValue("impl-low-review", "current", false, true),
        "stage-impl-low-review-current-lint-known-modelable"
      );
    });

    void it('should combine paused and lint-known suffixes', () => {
      assert.strictEqual(
        getStageNodeContextValue("impl-low-review", "current", true, true),
        "stage-impl-low-review-current-paused-lint-known-modelable"
      );
    });
  });

  // Test cases for "done" and "outstanding" statuses
  void describe('when status is not "current"', () => {
    for (const status of ["done", "outstanding"] as const) {
      for (const stage of STAGE_ORDER) {
        void it(`should return computed context for stage "${stage}" with status "${status}"`, () => {
          let expectedBase: string;
          if (stage === "desc") {
            expectedBase = "stage-desc";
          } else if (stage === "plan") {
            expectedBase = "stage-plan";
          } else {
            expectedBase = "stage";
          }
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

// ---------------------------------------------------------------------------
// StageNode rendering — done review stage with readiness data
// ---------------------------------------------------------------------------
// Regression coverage for the blocking review finding:
//   A completed ("done") review stage with readiness data MUST render with the
//   green "check" tick icon, not with the readiness thumbsup/question/thumbsdown
//   icon. Overwriting the tick with a readiness icon made completed stages
//   visually ambiguous after a refresh.
// ---------------------------------------------------------------------------

void describe("StageNode — done review stage icon", () => {
  void it('renders green "check" tick when status is "done" and readiness data is present', () => {
    const task = makeTask("impl"); // current stage is after plan-high-review
    const readiness = { label: "9/10", icon: "thumbsup", colorKey: "charts.green" };
    const node = new StageNode(task, "plan-high-review", "done", undefined, readiness);

    // The icon must be "check" regardless of readiness data
    const icon = node.iconPath as import("vscode").ThemeIcon;
    assert.strictEqual(
      icon.id,
      "check",
      `Expected icon "check" for done review stage, got "${icon.id}"`
    );
    // The color must be the green theme color
    const color = icon.color as import("vscode").ThemeColor;
    assert.strictEqual(
      color.id,
      "charts.green",
      `Expected color "charts.green" for done tick, got "${color.id}"`
    );
  });

  void it('renders green "check" tick when status is "done" and readiness data is absent', () => {
    const task = makeTask("impl");
    const node = new StageNode(task, "plan-high-review", "done", undefined, undefined);

    const icon = node.iconPath as import("vscode").ThemeIcon;
    assert.strictEqual(icon.id, "check");
  });

  void it('renders readiness icon when status is "current" and readiness data is present', () => {
    const task = makeTask("plan-high-review");
    const readiness = { label: "9/10", icon: "thumbsup", colorKey: "charts.green" };
    const node = new StageNode(task, "plan-high-review", "current", undefined, readiness);

    const icon = node.iconPath as import("vscode").ThemeIcon;
    assert.strictEqual(
      icon.id,
      "thumbsup",
      `Expected readiness icon "thumbsup" for current review stage, got "${icon.id}"`
    );
  });

  void it('renders blue arrow when status is "current" and readiness data is absent', () => {
    const task = makeTask("plan-high-review");
    const node = new StageNode(task, "plan-high-review", "current", undefined, undefined);

    const icon = node.iconPath as import("vscode").ThemeIcon;
    assert.strictEqual(icon.id, "arrow-right");
  });

  void it('has description "done" for a done review stage with readiness', () => {
    const task = makeTask("impl");
    const readiness = { label: "7/10", icon: "question", colorKey: "charts.yellow" };
    const node = new StageNode(task, "plan-low-review", "done", undefined, readiness);

    assert.strictEqual(
      node.description,
      "done",
      `Expected description "done" for done review stage, got "${node.description}"`
    );
  });

  void it('has description including "current" for a current review stage with readiness', () => {
    const task = makeTask("plan-low-review");
    const readiness = { label: "4/10", icon: "thumbsdown", colorKey: "charts.red" };
    const node = new StageNode(task, "plan-low-review", "current", undefined, readiness);

    assert.ok(
      String(node.description).includes("current"),
      `Expected description to include "current", got "${node.description}"`
    );
  });
});

void describe("Stage migration (migrateStage)", () => {
  void it('should migrate "created" to "desc"', () => {
    assert.strictEqual(migrateStage("created"), "desc");
  });

  void it('should migrate "plan-final" to "impl"', () => {
    assert.strictEqual(migrateStage("plan-final"), "impl");
  });

  void it('should keep "desc" as-is', () => {
    assert.strictEqual(migrateStage("desc"), "desc");
  });

  void it('should migrate "implementation" to "impl"', () => {
    assert.strictEqual(migrateStage("implementation"), "impl");
  });

  void it('should keep "plan" as-is', () => {
    assert.strictEqual(migrateStage("plan"), "plan");
  });

  void it('should migrate "plan-review" to "plan-high-review"', () => {
    assert.strictEqual(migrateStage("plan-review"), "plan-high-review");
  });

  void it('should fallback unknown to "desc"', () => {
    assert.strictEqual(migrateStage("unknown-stage"), "desc");
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
    const shortcutNote = `Shortcut: Apply Current Stage Action${shortcutHint("vs-code-ai-helper.applyCurrentStageAction")}.`;
    const content = [
      "Briefly describe what changes you want to be made, and then use AI to help you clarify the plan.",
      "",
      shortcutNote,
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
  void it('should contain "desc" as the first stage', () => {
    assert.strictEqual(STAGE_ORDER[0], "desc");
  });

  void it('should NOT contain "created" stage', () => {
    assert.strictEqual(STAGE_ORDER.some((s) => String(s) === "created"), false);
  });

  void it('should NOT contain "plan-final" stage', () => {
    assert.strictEqual(STAGE_ORDER.some((s) => String(s) === "plan-final"), false);
  });

  void it('should contain exactly one "impl" entry', () => {
    const count = STAGE_ORDER.filter(
      (s) => s === "impl"
    ).length;
    assert.strictEqual(count, 1);
  });

  void it('should contain "publish" as the last stage', () => {
    assert.strictEqual(STAGE_ORDER[STAGE_ORDER.length - 1], "publish");
  });
});

void describe("Context Tokens Emission", () => {
  void it("buildTaskContextValue returns expected lifecycle and feature flags", () => {
    assert.strictEqual(
      buildTaskContextValue({ status: "active", currentStage: "plan" }),
      "task-active"
    );
    assert.strictEqual(
      buildTaskContextValue({ status: "paused", currentStage: "plan" }),
      "task-paused"
    );
    assert.strictEqual(
      buildTaskContextValue({ status: "active", currentStage: "plan-high-review" }),
      "task-active-review"
    );
    assert.strictEqual(
      buildTaskContextValue({ status: "completed", currentStage: "publish" }),
      "task-completed"
    );

    assert.strictEqual(
      buildTaskContextValue({ status: "completed", currentStage: "publish", isScheduled: true }),
      "task-completed-scheduled",
      "Legacy schedule metadata must not prevent completed tasks from rendering"
    );
    assert.strictEqual(
      buildTaskContextValue({ status: "completed", currentStage: "publish", hasLintPayload: true }),
      "task-completed-lint-known"
    );
    assert.strictEqual(
      buildTaskContextValue({ status: "paused", currentStage: "plan", isScheduled: true, isMetaManaged: true }),
      "task-paused-scheduled-meta-managed"
    );
  });

  void it("buildStageContextValue returns expected lifecycle and feature flags", () => {
    assert.strictEqual(
      buildStageContextValue({ stage: "plan", status: "current", isPaused: false }),
      "stage-plan-current-modelable"
    );
    assert.strictEqual(
      buildStageContextValue({ stage: "plan", status: "current", isPaused: true }),
      "stage-plan-current-paused-modelable"
    );
    assert.strictEqual(
      buildStageContextValue({ stage: "impl-low-review", status: "current", isPaused: true, hasLintPayload: true }),
      "stage-impl-low-review-current-paused-lint-known-modelable"
    );
    assert.strictEqual(
      buildStageContextValue({ stage: "impl", status: "done", isPaused: false }),
      "stage-modelable"
    );
    assert.strictEqual(
      buildStageContextValue({ stage: "publish", status: "outstanding" }),
      "stage-modelable"
    );
    assert.strictEqual(
      buildStageContextValue({ stage: "plan", status: "current", isScheduled: true, isMetaManaged: true }),
      "stage-plan-current-scheduled-meta-managed-modelable"
    );
  });
});

void describe("Icon selection in StageNode", () => {
  const mockTask = {
    folderUri: vscode.Uri.file("/workspace/tasks/t1"),
    folderName: "t1",
    progress: {
      currentStage: "impl" as const,
      status: "active" as const,
      taskFolder: "t1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  };

  void it("uses check icon for done status", () => {
    const node = new StageNode(mockTask, "plan", "done", undefined);
    assert.strictEqual((node.iconPath as vscode.ThemeIcon).id, "check");
  });

  void it("uses arrow-right icon for current status when no readiness is set", () => {
    const node = new StageNode(mockTask, "plan", "current", undefined);
    assert.strictEqual((node.iconPath as vscode.ThemeIcon).id, "arrow-right");
  });

  void it("uses readiness icon for current status when readiness is set", () => {
    const readiness = { label: "Perfect", icon: "thumbsup", colorKey: "charts.green" };
    const node = new StageNode(mockTask, "plan-high-review", "current", undefined, readiness);
    assert.strictEqual((node.iconPath as vscode.ThemeIcon).id, "thumbsup");
  });

  void it("uses circle-large-outline for outstanding status", () => {
    const node = new StageNode(mockTask, "impl-low-review", "outstanding", undefined);
    assert.strictEqual((node.iconPath as vscode.ThemeIcon).id, "circle-large-outline");
  });
});
