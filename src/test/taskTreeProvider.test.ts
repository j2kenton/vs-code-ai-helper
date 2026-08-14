import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { firstActiveInDisplayOrder, getStageNodeContextValue, orderTasksForDisplay, StageNode, tryReadReadiness } from "../views/taskTreeProvider";
import type { IncompleteTask } from "../types/incompleteTask";
import { buildTaskContextValue, buildStageContextValue, CREATION_RECOVERY_CONTEXT_V1 } from "../utils/contextTokens";
import {
  AI_MODEL_STAGES,
  STAGE_ORDER,
  migrateStage,
  type TaskStage,
} from "../types/taskProgress";
import { parseReadiness } from "../utils/reviewReadiness";
import { parseTaskDocument, buildTaskDocument } from "../utils/taskDescriptionDocument";
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

void describe("orderTasksForDisplay", () => {
  function taskEntry(
    name: string,
    overrides: { pinnedAt?: string; updatedAt?: string; displayName?: string } = {}
  ): IncompleteTask {
    return {
      folderUri: vscode.Uri.file(`/workspace/tasks/${name}`),
      folderName: name,
      progress: {
        currentStage: "impl",
        status: "active",
        taskFolder: name,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
        pinnedAt: overrides.pinnedAt,
        displayName: overrides.displayName,
      },
    } as unknown as IncompleteTask;
  }

  void it("puts pinned tasks first, most recently pinned first", () => {
    const ordered = orderTasksForDisplay([
      taskEntry("plain", { updatedAt: "2026-06-01T00:00:00.000Z" }),
      taskEntry("pinned-old", { pinnedAt: "2026-02-01T00:00:00.000Z" }),
      taskEntry("pinned-new", { pinnedAt: "2026-03-01T00:00:00.000Z" }),
    ]);
    assert.deepEqual(
      ordered.map((t) => t.folderName),
      ["pinned-new", "pinned-old", "plain"]
    );
  });

  void it("sorts unpinned tasks by recency then task name as tiebreaker", () => {
    const ordered = orderTasksForDisplay([
      taskEntry("zeta", { updatedAt: "2026-05-01T00:00:00.000Z" }),
      taskEntry("alpha", { updatedAt: "2026-05-01T00:00:00.000Z" }),
      taskEntry("older-but-b", { updatedAt: "2026-04-01T00:00:00.000Z" }),
    ]);
    assert.deepEqual(
      ordered.map((t) => t.folderName),
      ["alpha", "zeta", "older-but-b"],
      "equal updatedAt must fall back to the display name for a deterministic order"
    );
  });

  void it("uses displayName over folderName for the tiebreaker when present", () => {
    const ordered = orderTasksForDisplay([
      taskEntry("2026-01-01_task_1", { displayName: "zz rename" }),
      taskEntry("2026-01-01_task_2", { displayName: "aa rename" }),
    ]);
    assert.deepEqual(
      ordered.map((t) => t.progress.displayName),
      ["aa rename", "zz rename"]
    );
  });
});

void describe("firstActiveInDisplayOrder", () => {
  function statusEntry(name: string, status?: string): IncompleteTask {
    return {
      folderUri: vscode.Uri.file(`/workspace/tasks/${name}`),
      folderName: name,
      progress: {
        currentStage: "impl",
        completedStages: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        status,
      },
    } as unknown as IncompleteTask;
  }

  void it("skips leading completed/archived rows and picks the first active task", () => {
    const first = firstActiveInDisplayOrder([
      statusEntry("pinned-done", "completed"),
      statusEntry("archived-old", "archived"),
      statusEntry("working", "active"),
      statusEntry("working-later", "active"),
    ]);
    assert.strictEqual(first?.folderName, "working");
  });

  void it("treats a task without a status as active", () => {
    const first = firstActiveInDisplayOrder([
      statusEntry("done", "completed"),
      statusEntry("legacy-no-status", undefined),
    ]);
    assert.strictEqual(first?.folderName, "legacy-no-status");
  });

  void it("returns undefined when every task is completed or archived", () => {
    const first = firstActiveInDisplayOrder([
      statusEntry("done", "completed"),
      statusEntry("gone", "archived"),
    ]);
    assert.strictEqual(first, undefined);
  });
});

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
    const readiness = { label: "9/10" };
    const node = new StageNode(task, "plan-high-review", "done", undefined, readiness);

    // The icon must be "check" regardless of readiness data
    const icon = node.iconPath as import("vscode").ThemeIcon;
    assert.strictEqual(
      icon.id,
      "check",
      `Expected icon "check" for done review stage, got "${icon.id}"`
    );
    // The color must be the green theme color. The pinned 1.93 ThemeColor
    // declaration is opaque (no `id` member), so read the stub's id through a
    // structural cast.
    const color = icon.color as unknown as { id: string };
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

  void it('renders plain arrow-right icon when status is "current", even with readiness data present', () => {
    const task = makeTask("plan-high-review");
    const readiness = { label: "9/10" };
    const node = new StageNode(task, "plan-high-review", "current", undefined, readiness);

    const icon = node.iconPath as import("vscode").ThemeIcon;
    assert.strictEqual(
      icon.id,
      "arrow-right",
      `Expected plain "arrow-right" for current stage regardless of readiness, got "${icon.id}"`
    );
    const color = icon.color as unknown as { id: string };
    assert.strictEqual(color.id, "charts.blue");
  });

  void it('renders plain arrow-right icon when status is "current" and readiness score is low', () => {
    const task = makeTask("plan-low-review");
    const readiness = { label: "4/10" };
    const node = new StageNode(task, "plan-low-review", "current", undefined, readiness);

    const icon = node.iconPath as import("vscode").ThemeIcon;
    assert.strictEqual(
      icon.id,
      "arrow-right",
      `A low review score must not turn the current-stage icon into a down arrow, got "${icon.id}"`
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
    const readiness = { label: "7/10" };
    const node = new StageNode(task, "plan-low-review", "done", undefined, readiness);

    assert.strictEqual(
      node.description,
      "done",
      `Expected description "done" for done review stage, got "${node.description}"`
    );
  });

  void it('has description including "current" for a current review stage with readiness', () => {
    const task = makeTask("plan-low-review");
    const readiness = { label: "4/10" };
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
  void it('should parse "Readiness: 9/10"', () => {
    const result = parseReadiness("Readiness: 9/10\nSome content");
    assert.strictEqual(result.score, 9);
    assert.strictEqual(result.label, "9/10");
  });

  void it('should parse "Readiness: 10/10"', () => {
    const result = parseReadiness("Readiness: 10/10");
    assert.strictEqual(result.score, 10);
    assert.strictEqual(result.label, "10/10");
  });

  void it('should parse "Readiness: 8/10"', () => {
    const result = parseReadiness("Readiness: 8/10");
    assert.strictEqual(result.score, 8);
    assert.strictEqual(result.label, "8/10");
  });

  void it('should parse "Readiness: 7/10"', () => {
    const result = parseReadiness("Readiness: 7/10");
    assert.strictEqual(result.score, 7);
    assert.strictEqual(result.label, "7/10");
  });

  void it('should parse "Readiness: 5/10"', () => {
    const result = parseReadiness("Readiness: 5/10");
    assert.strictEqual(result.score, 5);
    assert.strictEqual(result.label, "5/10");
  });

  void it('should parse "Readiness: 4/10"', () => {
    const result = parseReadiness("Readiness: 4/10");
    assert.strictEqual(result.score, 4);
    assert.strictEqual(result.label, "4/10");
  });

  void it('should parse "Readiness: 0/10"', () => {
    const result = parseReadiness("Readiness: 0/10");
    assert.strictEqual(result.score, 0);
    assert.strictEqual(result.label, "0/10");
  });

  void it('should use legacy fallback for case-insensitive readiness wording', () => {
    const result = parseReadiness("Overall readiness 7/10 based on analysis");
    assert.strictEqual(result.score, 7);
    assert.strictEqual(result.label, "7/10");
  });

  void it('should return null score and neutral label for missing readiness', () => {
    const result = parseReadiness("No readiness score here");
    assert.strictEqual(result.score, null);
    assert.strictEqual(result.label, "—/10");
  });

  void it('should return neutral label for empty content', () => {
    const result = parseReadiness("");
    assert.strictEqual(result.score, null);
    assert.strictEqual(result.label, "—/10");
  });
});

void describe("draftTaskWithAI.parseTaskDocument", () => {
  void it('should parse a new-style task.md with all three sections', () => {
    const shortcutNote = `Shortcut: Apply Current Stage Action${shortcutHint("vs-code-ai-helper.applyCurrentStageAction")}.`;
    const content = [
      "Describe the work you want to do here in as much detail as is useful. When",
      "you're ready, use **Draft with AI** to turn these notes into a structured task",
      "description. Questions from the stage AI appear in the **Chat With AI** panel.",
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
    assert.ok(parsed.introText.includes("Describe the work you want to do here"));
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
    const headerIdx = doc.indexOf("# Task");
    const taskIdx = doc.indexOf("## Task Description");
    const draftIdx = doc.indexOf("## Draft with AI");
    const questionsIdx = doc.indexOf("## Open Questions");

    assert.ok(headerIdx < taskIdx);
    assert.ok(taskIdx < draftIdx);
    assert.strictEqual(questionsIdx, -1);
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

  void it("buildTaskContextValue emits exactly one plan §4.7 recovery context for a creating row, never a suffix blend", () => {
    // AC-CREATE-UI-01: a live deletion journal wins outright, regardless of
    // the underlying footprintClass — Open/Retry/Adopt-and-Retry/Safe Delete
    // must all be hidden while a deletion is in flight.
    assert.strictEqual(
      buildTaskContextValue({
        status: "creating",
        currentStage: "desc",
        creationFootprint: { footprintClass: "reconstructible", retryWithoutAdoptionEligible: true, deletionPending: true },
      }),
      CREATION_RECOVERY_CONTEXT_V1.deletionPending
    );
    // A verified §4.2 journal (retryWithoutAdoptionEligible) overrides the
    // conservative footprintClass, even though the classifier only ever
    // produces "reconstructible" for it today.
    assert.strictEqual(
      buildTaskContextValue({
        status: "creating",
        currentStage: "desc",
        creationFootprint: { footprintClass: "reconstructible", retryWithoutAdoptionEligible: true, deletionPending: false },
      }),
      CREATION_RECOVERY_CONTEXT_V1.v1Recoverable
    );
    // Without a verified journal, each footprintClass gets its own distinct
    // context — critically, "preservable" and "inspectionOnly" must NEVER
    // resolve to "v1Recoverable" (the only context Retry's menu matches).
    for (const footprintClass of ["reconstructible", "pristine", "preservable", "inspectionOnly"] as const) {
      assert.strictEqual(
        buildTaskContextValue({
          status: "creating",
          currentStage: "desc",
          creationFootprint: { footprintClass, retryWithoutAdoptionEligible: false, deletionPending: false },
        }),
        CREATION_RECOVERY_CONTEXT_V1[footprintClass],
        `footprintClass "${footprintClass}" must map to its own context, not v1Recoverable`
      );
    }
    // No classification published yet falls back to the most restrictive
    // context (Open only), never to something more permissive.
    assert.strictEqual(
      buildTaskContextValue({ status: "creating", currentStage: "desc" }),
      CREATION_RECOVERY_CONTEXT_V1.inspectionOnly
    );
    // A creating row must never carry any of the normal suffix tokens
    // (scheduled/meta-managed/pinned) blended into its recovery context.
    assert.strictEqual(
      buildTaskContextValue({
        status: "creating",
        currentStage: "desc",
        isScheduled: true,
        isMetaManaged: true,
        isPinned: true,
        creationFootprint: { footprintClass: "preservable", retryWithoutAdoptionEligible: false, deletionPending: false },
      }),
      CREATION_RECOVERY_CONTEXT_V1.preservable
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

  void it("still uses the plain arrow-right icon for current status when readiness is set", () => {
    const readiness = { label: "Perfect" };
    const node = new StageNode(mockTask, "plan-high-review", "current", undefined, readiness);
    assert.strictEqual((node.iconPath as vscode.ThemeIcon).id, "arrow-right");
  });

  void it("uses circle-large-outline for outstanding status", () => {
    const node = new StageNode(mockTask, "impl-low-review", "outstanding", undefined);
    assert.strictEqual((node.iconPath as vscode.ThemeIcon).id, "circle-large-outline");
  });
});

// ---------------------------------------------------------------------------
// Review score + step progress visibility (tryReadReadiness / StageNode)
//
// The at-a-glance score (9/10) now sits next to the checklist-reconciled step
// progress (1 of 5 steps) so a loop back into implementation no longer reads
// as a bug. The counts come from effectiveReviewProgressV1 under the lenient
// policy — the same value the advance gates act on.
// ---------------------------------------------------------------------------

void describe("StageNode — review score and step progress", () => {
  const folderUri = vscode.Uri.file("/workspace/tasks/progress-task");
  const reviewUri = vscode.Uri.joinPath(folderUri, "review-impl-high.md");
  const planUri = vscode.Uri.joinPath(folderUri, "plan-final.md");
  const progressUri = vscode.Uri.joinPath(folderUri, "task-progress.json");

  const PLAN_TWO_OF_FIVE = [
    "# Final Plan",
    "",
    "<!-- ensemble:implementation-checklist -->",
    "",
    "- [x] One",
    "- [x] Two",
    "- [ ] Three",
    "- [ ] Four",
    "- [ ] Five",
    "",
  ].join("\n");

  const PROGRESS_JSON = JSON.stringify({
    taskFolder: "progress-task",
    currentStage: "impl-high-review",
    status: "active",
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
  });

  function reviewContent(score: string, marker?: string): string {
    return [
      "# Implementation Review",
      "",
      `Readiness: ${score}/10`,
      "",
      ...(marker ? [`<!-- progress: ${marker} -->`, ""] : []),
    ].join("\n");
  }

  /** In-memory workspace.fs.readFile, keyed by fsPath (the stub is notImplemented). */
  function installReadFileStub(files: Map<string, string>): () => void {
    const fsRecord = vscode.workspace.fs as unknown as Record<string, unknown>;
    const original = fsRecord.readFile;
    fsRecord.readFile = (uri: vscode.Uri): Promise<Uint8Array> => {
      const text = files.get(uri.fsPath);
      if (text === undefined) {
        return Promise.reject(new Error(`ENOENT: no such file: ${uri.fsPath}`));
      }
      return Promise.resolve(new TextEncoder().encode(text));
    };
    return (): void => {
      fsRecord.readFile = original;
    };
  }

  void it("renders the score and the step progress in the description, with a divided tooltip", async () => {
    const restore = installReadFileStub(new Map([[reviewUri.fsPath, reviewContent("9", "1/5")]]));
    try {
      const readiness = await tryReadReadiness(reviewUri, "impl-high-review", folderUri);
      assert.ok(readiness, "a readable review artifact must yield readiness");
      assert.equal(readiness.label, "9/10");
      assert.deepEqual(readiness.progress, { complete: 1, total: 5 });

      const node = new StageNode(makeTask("impl-high-review"), "impl-high-review", "current", reviewUri, readiness);
      assert.strictEqual(node.description, "current · 9/10 · 1 of 5 steps");
      const tooltip = (node.tooltip as vscode.MarkdownString).value;
      assert.ok(tooltip.includes("Review score: 9/10"), "score line leads the tooltip block");
      assert.ok(tooltip.includes("\n\n---\n\n"), "a divider sits between score and progress");
      assert.ok(tooltip.includes("1 of 5 steps completed"));
    } finally {
      restore();
    }
  });

  void it("renders score-only when the review carries no marker", async () => {
    const restore = installReadFileStub(new Map([[reviewUri.fsPath, reviewContent("9")]]));
    try {
      const readiness = await tryReadReadiness(reviewUri, "impl-high-review", folderUri);
      assert.ok(readiness);
      assert.equal(readiness.progress, undefined);

      const node = new StageNode(makeTask("impl-high-review"), "impl-high-review", "current", reviewUri, readiness);
      assert.strictEqual(node.description, "current · 9/10");
      const tooltip = (node.tooltip as vscode.MarkdownString).value;
      assert.ok(!tooltip.includes("steps completed"), "no progress block without a marker");
    } finally {
      restore();
    }
  });

  void it("renders score-only when the marker is malformed (progress: 7/5)", async () => {
    const restore = installReadFileStub(new Map([[reviewUri.fsPath, reviewContent("9", "7/5")]]));
    try {
      const readiness = await tryReadReadiness(reviewUri, "impl-high-review", folderUri);
      assert.ok(readiness);
      assert.equal(readiness.progress, undefined, "a nonsensical marker parses to no progress");

      const node = new StageNode(makeTask("impl-high-review"), "impl-high-review", "current", reviewUri, readiness);
      assert.strictEqual(node.description, "current · 9/10");
    } finally {
      restore();
    }
  });

  void it("displays the checklist-reconciled counts, never the marker's false completion", async () => {
    // The review claims 5/5 done, but the plan of record's checklist still
    // lists three unchecked items — the tree must show the checklist's 2 of
    // 5, exactly what the advance gate reconciles to.
    const restore = installReadFileStub(
      new Map([
        [reviewUri.fsPath, reviewContent("9", "5/5")],
        [planUri.fsPath, PLAN_TWO_OF_FIVE],
        [progressUri.fsPath, PROGRESS_JSON],
      ])
    );
    try {
      const readiness = await tryReadReadiness(reviewUri, "impl-high-review", folderUri);
      assert.ok(readiness);
      assert.deepEqual(
        readiness.progress,
        { complete: 2, total: 5 },
        "the reconciled checklist counts win over the false 5/5 completion"
      );

      const node = new StageNode(makeTask("impl-high-review"), "impl-high-review", "current", reviewUri, readiness);
      assert.strictEqual(node.description, "current · 9/10 · 2 of 5 steps");
      assert.ok(!String(node.description).includes("5 of 5"));
      assert.ok((node.tooltip as vscode.MarkdownString).value.includes("2 of 5 steps completed"));
    } finally {
      restore();
    }
  });

  void it("renders a plan-review stage's raw marker unreconciled", async () => {
    // The checklist (2 of 5) belongs to the implementation; a plan review's
    // own marker (3/5) passes through untouched.
    const planReviewUri = vscode.Uri.joinPath(folderUri, "review-plan-high.md");
    const restore = installReadFileStub(
      new Map([
        [planReviewUri.fsPath, reviewContent("8", "3/5")],
        [planUri.fsPath, PLAN_TWO_OF_FIVE],
        [progressUri.fsPath, PROGRESS_JSON],
      ])
    );
    try {
      const readiness = await tryReadReadiness(planReviewUri, "plan-high-review", folderUri);
      assert.ok(readiness);
      assert.deepEqual(readiness.progress, { complete: 3, total: 5 });

      const node = new StageNode(makeTask("plan-high-review"), "plan-high-review", "current", planReviewUri, readiness);
      assert.strictEqual(node.description, "current · 8/10 · 3 of 5 steps");
    } finally {
      restore();
    }
  });

  void it("returns undefined readiness when the artifact cannot be read", async () => {
    const restore = installReadFileStub(new Map());
    try {
      const readiness = await tryReadReadiness(reviewUri, "impl-high-review", folderUri);
      assert.equal(readiness, undefined);
    } finally {
      restore();
    }
  });
});


