import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { firstActiveInDisplayOrder, getStageNodeContextValue, orderTasksForDisplay, StageNode, TaskNode, TaskTreeProvider, tryReadReadiness } from "../views/taskTreeProvider";
import type { IncompleteTask } from "../types/incompleteTask";
import { buildTaskContextValue, buildStageContextValue, CREATION_RECOVERY_CONTEXT_V1 } from "../utils/contextTokens";
import {
  AI_MODEL_STAGES,
  STAGE_ARTIFACT_FILENAMES,
  STAGE_ORDER,
  migrateStage,
  type TaskStage,
} from "../types/taskProgress";
import { parseReadiness } from "../utils/reviewReadiness";
import { parseTaskDocument, buildTaskDocument } from "../utils/taskDescriptionDocument";
import { shortcutHint } from "../utils/shortcutHints";
import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import type { CreateWorkflowDecisionInputV1, WorkflowDecisionOptionV1 } from "../types/workflowDecisionV1";

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

  void it("has no status description for a done review stage — the tick icon conveys it", () => {
    const task = makeTask("impl");
    const readiness = { label: "7/10" };
    const node = new StageNode(task, "plan-low-review", "done", undefined, readiness);

    assert.strictEqual(
      node.description,
      undefined,
      `Expected no description for a done review stage, got "${node.description}"`
    );
  });

  void it('renders the readiness label without the "current" status word for a current review stage', () => {
    const task = makeTask("plan-low-review");
    const readiness = { label: "4/10" };
    const node = new StageNode(task, "plan-low-review", "current", undefined, readiness);

    assert.strictEqual(node.description, "4/10");
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

  void it("buildTaskContextValue emits the checklistUnreliable token only for latched tasks, keeping pinned trailing", () => {
    // The token gates the reconcilePlanChecklist menu entry (package.json
    // matches /-checklistUnreliable/): it must appear exactly when the task's
    // checklistProgressUnreliable latch is set, and never move the pinned
    // token off the end (menus match /-pinned$/).
    assert.strictEqual(
      buildTaskContextValue({ status: "active", currentStage: "impl", checklistProgressUnreliable: true }),
      "task-active-checklistUnreliable"
    );
    assert.strictEqual(
      buildTaskContextValue({ status: "active", currentStage: "impl" }),
      "task-active",
      "a healthy task must not carry the token — its menu entry stays hidden"
    );
    assert.strictEqual(
      buildTaskContextValue({ status: "active", currentStage: "impl", checklistProgressUnreliable: false }),
      "task-active",
      "an explicitly-cleared latch must not carry the token either"
    );
    assert.strictEqual(
      buildTaskContextValue({ status: "active", currentStage: "impl", checklistProgressUnreliable: true, isPinned: true }),
      "task-active-checklistUnreliable-pinned",
      "pinned stays in the trailing position so /-pinned$/ menu clauses keep matching"
    );
    assert.strictEqual(
      buildTaskContextValue({
        status: "paused",
        currentStage: "publish",
        isScheduled: true,
        isMetaManaged: true,
        checklistProgressUnreliable: true,
        isPinned: true,
      }),
      "task-paused-scheduled-meta-managed-checklistUnreliable-pinned"
    );
    // A creating row returns its single recovery context before any suffix is
    // applied — the latch token must never blend into it.
    assert.strictEqual(
      buildTaskContextValue({
        status: "creating",
        currentStage: "desc",
        checklistProgressUnreliable: true,
        creationFootprint: { footprintClass: "inspectionOnly", retryWithoutAdoptionEligible: false, deletionPending: false },
      }),
      CREATION_RECOVERY_CONTEXT_V1.inspectionOnly
    );
  });

  void it("gates the reconcilePlanChecklist menu entry on the checklistUnreliable token", () => {
    // Same package.json-reading contract pattern as stage3ActionMatrix /
    // stageRevertContract: the menu contribution is the whole point of the
    // token, so the entry's when-clause is pinned here against accidental
    // broadening back to every /^task/ row.
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8")
    ) as {
      contributes?: {
        menus?: Record<string, Array<{ command: string; when?: string }>>;
      };
    };
    const contextMenus = packageJson.contributes?.menus?.["view/item/context"] ?? [];
    const entries = contextMenus.filter(
      (entry) => entry.command === "vs-code-ai-helper.reconcilePlanChecklist"
    );
    assert.ok(entries.length > 0, "Expected menu entries for reconcilePlanChecklist");
    for (const entry of entries) {
      assert.ok(
        (entry.when ?? "").includes("viewItem =~ /-checklistUnreliable/"),
        `reconcilePlanChecklist menu entry must be gated on the checklistUnreliable token: ${entry.when}`
      );
      assert.ok(
        (entry.when ?? "").includes("viewItem =~ /^task/"),
        `reconcilePlanChecklist menu entry must remain scoped to task rows: ${entry.when}`
      );
    }
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
      assert.strictEqual(node.description, "9/10 · 1 of 5 steps");
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
      assert.strictEqual(node.description, "9/10");
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
      assert.strictEqual(node.description, "9/10");
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
      assert.strictEqual(node.description, "9/10 · 2 of 5 steps");
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
      assert.strictEqual(node.description, "8/10 · 3 of 5 steps");
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

// ---------------------------------------------------------------------------
// TaskTreeProvider — refresh-scoped HEAD cache (review freshness)
//
// The plan's task-tree freshness contract is one resolveHeadCommitSha call
// per refresh cycle, no matter how many expanded tasks sit on a current
// review stage. The provider keys an in-flight-promise cache by workspace
// folder — falling back to the task folder's parent directory for tasks
// outside every workspace folder (an absolute configured task root), so
// sibling tasks under one such root still share a resolution — and clears
// it at every root render, so a refresh shares one git call across tasks
// while the next refresh still observes external HEAD moves (pull/rebase
// in a terminal).
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-var-requires */
const gitRepoInfoModule = require("../utils/gitRepoInfo") as Record<string, unknown>;
/* eslint-enable @typescript-eslint/no-var-requires */

void describe("TaskTreeProvider — refresh-scoped HEAD cache", () => {
  const REVIEWED_SHA = "a".repeat(40);
  const HEAD_SHA = "b".repeat(40);

  const STALE_REVIEW = [
    "# Implementation Review",
    "",
    "Readiness: 6/10",
    "",
    "Body prose.",
    "",
    `<!-- reviewed-commit: ${REVIEWED_SHA} -->`,
    "",
  ].join("\n");

  /** readFile + stat backed by an in-memory map, keyed by fsPath. */
  function installFsStubs(files: Map<string, string>): () => void {
    const fsRecord = vscode.workspace.fs as unknown as Record<string, unknown>;
    const originalRead = fsRecord.readFile;
    const originalStat = fsRecord.stat;
    fsRecord.readFile = (uri: vscode.Uri): Promise<Uint8Array> => {
      const text = files.get(uri.fsPath);
      if (text === undefined) {
        return Promise.reject(new Error(`ENOENT: no such file: ${uri.fsPath}`));
      }
      return Promise.resolve(new TextEncoder().encode(text));
    };
    fsRecord.stat = (uri: vscode.Uri): Promise<vscode.FileStat> =>
      files.has(uri.fsPath)
        ? Promise.resolve({ type: vscode.FileType.File, ctime: 0, mtime: 0, size: 1 })
        : Promise.reject(new Error(`ENOENT: no such file: ${uri.fsPath}`));
    return (): void => {
      fsRecord.readFile = originalRead;
      fsRecord.stat = originalStat;
    };
  }

  /** getChildren() fires setContext via executeCommand; the stub throws on unregistered commands. */
  async function withStubbedCommands<T>(callback: () => Promise<T>): Promise<T> {
    const commandsStub = vscode.commands as typeof vscode.commands & {
      _executeCommandOverride?: (id: string, ...args: unknown[]) => Promise<unknown>;
    };
    const previous = commandsStub._executeCommandOverride;
    commandsStub._executeCommandOverride = (): Promise<unknown> => Promise.resolve(undefined);
    try {
      return await callback();
    } finally {
      commandsStub._executeCommandOverride = previous;
    }
  }

  function makeInventoryWithReviewTasks(
    fsPaths: string[]
  ): import("../state/taskInventory").TaskInventory {
    return {
      getTasks: () =>
        fsPaths.map((fsPath) => ({
          taskFolderPath: fsPath,
          folderName: path.basename(fsPath),
          progress: {
            currentStage: "impl-high-review" as TaskStage,
            status: "active",
            taskFolder: path.basename(fsPath),
            createdAt: "2026-08-14T00:00:00.000Z",
            updatedAt: "2026-08-14T00:00:00.000Z",
          },
          canonicalId: fsPath,
        })),
      refresh: async (): Promise<void> => {},
      onDidChange: (_handler: () => void): { dispose: () => void } => ({ dispose(): void {} }),
    } as unknown as import("../state/taskInventory").TaskInventory;
  }

  void it("resolves HEAD once per refresh across multiple expanded review tasks, and again on the next refresh", async () => {
    const folderA = vscode.Uri.file("/workspace/tasks/head-cache-a");
    const folderB = vscode.Uri.file("/workspace/tasks/head-cache-b");
    const reviewName = STAGE_ARTIFACT_FILENAMES["impl-high-review"]!;
    const restoreFs = installFsStubs(
      new Map([
        [vscode.Uri.joinPath(folderA, reviewName).fsPath, STALE_REVIEW],
        [vscode.Uri.joinPath(folderB, reviewName).fsPath, STALE_REVIEW],
      ])
    );

    const workspaceRecord = vscode.workspace as unknown as Record<string, unknown>;
    const originalFolders = workspaceRecord.workspaceFolders;
    workspaceRecord.workspaceFolders = [
      { uri: vscode.Uri.file("/workspace"), name: "workspace", index: 0 },
    ];

    const originalResolve = gitRepoInfoModule.resolveHeadCommitSha;
    let resolutions = 0;
    gitRepoInfoModule.resolveHeadCommitSha = (): Promise<string | undefined> => {
      resolutions += 1;
      return Promise.resolve(HEAD_SHA);
    };

    const provider = new TaskTreeProvider(
      makeInventoryWithReviewTasks([folderA.fsPath, folderB.fsPath])
    );
    try {
      const roots = await withStubbedCommands(() => provider.getChildren());
      const taskNodes = roots.filter((n): n is TaskNode => n instanceof TaskNode);
      assert.equal(taskNodes.length, 2);

      const stagesA = await provider.getChildren(taskNodes[0]);
      await provider.getChildren(taskNodes[1]);
      assert.equal(
        resolutions,
        1,
        "both expanded review tasks must share one HEAD resolution within a refresh"
      );

      const reviewNode = stagesA.find(
        (n): n is StageNode => n instanceof StageNode && n.stage === "impl-high-review"
      );
      assert.ok(reviewNode, "the current review stage renders a StageNode");
      assert.ok(
        String(reviewNode.description).includes("stale"),
        "the cached path still flags a behind-HEAD review"
      );

      await withStubbedCommands(() => provider.getChildren());
      await provider.getChildren(taskNodes[0]);
      assert.equal(
        resolutions,
        2,
        "a root render starts a new refresh cycle, so HEAD is re-resolved and external moves stay visible"
      );
    } finally {
      provider.dispose();
      gitRepoInfoModule.resolveHeadCommitSha = originalResolve;
      workspaceRecord.workspaceFolders = originalFolders;
      restoreFs();
    }
  });

  void it("shares one HEAD resolution across sibling tasks under an out-of-workspace absolute task root", async () => {
    // Absolute configured task roots outside every workspace folder are a
    // supported configuration (taskRoot.ts resolveTaskRootCandidates). The
    // cache must not fall back to per-task keys there: siblings under one
    // root share the root as their parent directory, while a task under an
    // unrelated root still resolves on its own.
    const siblingA = vscode.Uri.file("/external-root/head-cache-a");
    const siblingB = vscode.Uri.file("/external-root/head-cache-b");
    const unrelated = vscode.Uri.file("/other-root/head-cache-c");
    const reviewName = STAGE_ARTIFACT_FILENAMES["impl-high-review"]!;
    const restoreFs = installFsStubs(
      new Map([
        [vscode.Uri.joinPath(siblingA, reviewName).fsPath, STALE_REVIEW],
        [vscode.Uri.joinPath(siblingB, reviewName).fsPath, STALE_REVIEW],
        [vscode.Uri.joinPath(unrelated, reviewName).fsPath, STALE_REVIEW],
      ])
    );

    const workspaceRecord = vscode.workspace as unknown as Record<string, unknown>;
    const originalFolders = workspaceRecord.workspaceFolders;
    workspaceRecord.workspaceFolders = [
      { uri: vscode.Uri.file("/workspace"), name: "workspace", index: 0 },
    ];

    const originalResolve = gitRepoInfoModule.resolveHeadCommitSha;
    let resolutions = 0;
    gitRepoInfoModule.resolveHeadCommitSha = (): Promise<string | undefined> => {
      resolutions += 1;
      return Promise.resolve(HEAD_SHA);
    };

    const provider = new TaskTreeProvider(
      makeInventoryWithReviewTasks([siblingA.fsPath, siblingB.fsPath, unrelated.fsPath])
    );
    try {
      const roots = await withStubbedCommands(() => provider.getChildren());
      const taskNodes = roots.filter((n): n is TaskNode => n instanceof TaskNode);
      assert.equal(taskNodes.length, 3);

      const stageLists = [];
      for (const node of taskNodes) {
        stageLists.push(await provider.getChildren(node));
      }
      assert.equal(
        resolutions,
        2,
        "sibling tasks under one out-of-workspace root share a resolution; the unrelated root gets its own"
      );

      for (const stages of stageLists) {
        const reviewNode = stages.find(
          (n): n is StageNode => n instanceof StageNode && n.stage === "impl-high-review"
        );
        assert.ok(reviewNode, "each task's current review stage renders a StageNode");
        assert.ok(
          String(reviewNode.description).includes("stale"),
          "the shared-cache path still flags every behind-HEAD review"
        );
      }
    } finally {
      provider.dispose();
      gitRepoInfoModule.resolveHeadCommitSha = originalResolve;
      workspaceRecord.workspaceFolders = originalFolders;
      restoreFs();
    }
  });

  void it("consults the injected resolver lazily — only when the artifact carries a reviewed-commit marker", async () => {
    const folderUri = vscode.Uri.file("/workspace/tasks/lazy-head");
    const reviewUri = vscode.Uri.joinPath(folderUri, "impl-high-review.md");

    let restore = installFsStubs(new Map([[reviewUri.fsPath, STALE_REVIEW]]));
    try {
      let calls = 0;
      const readiness = await tryReadReadiness(reviewUri, "impl-high-review", folderUri, () => {
        calls += 1;
        return Promise.resolve(HEAD_SHA);
      });
      assert.equal(calls, 1, "a marker-bearing artifact resolves HEAD through the resolver");
      assert.equal(readiness?.staleReviewedSha, REVIEWED_SHA);
    } finally {
      restore();
    }

    const noMarker = ["# Implementation Review", "", "Readiness: 9/10", ""].join("\n");
    restore = installFsStubs(new Map([[reviewUri.fsPath, noMarker]]));
    try {
      let calls = 0;
      const readiness = await tryReadReadiness(reviewUri, "impl-high-review", folderUri, () => {
        calls += 1;
        return Promise.resolve(HEAD_SHA);
      });
      assert.equal(calls, 0, "no reviewed-commit marker means no git resolution at all");
      assert.ok(readiness, "the artifact still yields readiness");
      assert.equal(readiness.staleReviewedSha, undefined);
    } finally {
      restore();
    }
  });
});

void describe("TaskTreeProvider — pending workflow decisions (task: hidden-button decisions)", () => {
  /** Minimal in-memory stand-in for `vscode.Memento`, mirroring workflowDecisionStoreV1.test.ts. */
  class FakeMemento {
    private readonly values = new Map<string, unknown>();
    get<T>(key: string, defaultValue: T): T {
      return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
    }
    update(key: string, value: unknown): Promise<void> {
      this.values.set(key, value);
      return Promise.resolve();
    }
  }

  const TASK_FS_PATH = "/workspace/tasks/decision-task";

  function makeSingleTaskInventory(): import("../state/taskInventory").TaskInventory {
    return {
      getTasks: () => [
        {
          taskFolderPath: TASK_FS_PATH,
          folderName: "decision-task",
          progress: {
            currentStage: "impl" as TaskStage,
            status: "active",
            taskFolder: "decision-task",
            createdAt: "2026-08-19T00:00:00.000Z",
            updatedAt: "2026-08-19T00:00:00.000Z",
          },
          canonicalId: TASK_FS_PATH,
        },
      ],
      refresh: async (): Promise<void> => {},
      onDidChange: (_handler: () => void): { dispose: () => void } => ({ dispose(): void {} }),
    } as unknown as import("../state/taskInventory").TaskInventory;
  }

  /** getChildren() fires setContext via executeCommand; the stub throws on unregistered commands. */
  async function withStubbedCommands<T>(callback: () => Promise<T>): Promise<T> {
    const commandsStub = vscode.commands as typeof vscode.commands & {
      _executeCommandOverride?: (id: string, ...args: unknown[]) => Promise<unknown>;
    };
    const previous = commandsStub._executeCommandOverride;
    commandsStub._executeCommandOverride = (): Promise<unknown> => Promise.resolve(undefined);
    try {
      return await callback();
    } finally {
      commandsStub._executeCommandOverride = previous;
    }
  }

  function option(overrides: Partial<WorkflowDecisionOptionV1> = {}): WorkflowDecisionOptionV1 {
    return {
      optionId: "restore",
      label: "Restore Prior Round",
      consequence: "Overwrites the current summary/review with the previous round's backup, discarding the completed round.",
      destructive: true,
      effect: { kind: "command", command: "vs-code-ai-helper.restoreRejectedImplementationRound" },
      ...overrides,
    };
  }

  let counter = 0;
  function decisionInput(overrides: Partial<CreateWorkflowDecisionInputV1> = {}): CreateWorkflowDecisionInputV1 {
    counter += 1;
    return {
      decisionId: `decision-${counter}`,
      decisionKey: "restoreRejectedRound",
      taskCanonicalId: TASK_FS_PATH,
      stage: "impl",
      whatHappened: "The scheduled round's summary was rejected.",
      whyUserNeeded: "The system cannot tell whether to retry or restore the prior round.",
      options: [option()],
      recommendation: { kind: "option", optionId: "restore", reasoning: "Nothing else is scheduled." },
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  async function firstTaskNode(provider: TaskTreeProvider): Promise<TaskNode> {
    const roots = await withStubbedCommands(() => provider.getChildren());
    const node = roots.find((n): n is TaskNode => n instanceof TaskNode);
    assert.ok(node, "the single task renders a TaskNode");
    return node;
  }

  void it("surfaces a pending decision as a persistent tooltip line, context token, and pendingDecision field", async () => {
    const memento = new FakeMemento() as unknown as vscode.Memento;
    const store = new WorkflowDecisionStoreV1(memento);
    const posted = await store.post(decisionInput());
    assert.equal(posted.ok, true);

    const provider = new TaskTreeProvider(makeSingleTaskInventory(), undefined, memento);
    try {
      const node = await firstTaskNode(provider);
      assert.ok(node.contextValue?.includes("decisionPending"), "contextValue carries the decisionPending token");
      const tooltipValue = (node.tooltip as vscode.MarkdownString).value;
      assert.ok(tooltipValue.includes("Decision waiting"), "tooltip includes the decision-waiting line");
      assert.ok(
        tooltipValue.includes("The scheduled round's summary was rejected."),
        "tooltip surfaces the decision's whatHappened text"
      );
      assert.ok(posted.ok && node.pendingDecision?.decisionId === posted.decision.decisionId);
    } finally {
      provider.dispose();
    }
  });

  // Task "Actionable Hand-offs" PART 5: the tooltip's gating line must match
  // Chat With AI's — real content when the decision supplies `gating`, an
  // explicit "not recorded" statement when it does not.
  void it("tooltip renders a decision's own gating claim, or an explicit not-recorded fallback", async () => {
    const memento = new FakeMemento() as unknown as vscode.Memento;
    const store = new WorkflowDecisionStoreV1(memento);
    await store.post(
      decisionInput({
        gating: { holdsTaskPaused: true, unblocksProgress: true, detail: "Resuming answers the paused escalation." },
      })
    );

    const provider = new TaskTreeProvider(makeSingleTaskInventory(), undefined, memento);
    try {
      const node = await firstTaskNode(provider);
      const tooltipValue = (node.tooltip as vscode.MarkdownString).value;
      assert.match(tooltipValue, /Resuming answers the paused escalation\./);
      assert.doesNotMatch(tooltipValue, /not recorded/i);
    } finally {
      provider.dispose();
    }
  });

  void it("tooltip renders an explicit not-recorded gating line for a decision that omits it", async () => {
    const memento = new FakeMemento() as unknown as vscode.Memento;
    const store = new WorkflowDecisionStoreV1(memento);
    await store.post(decisionInput());

    const provider = new TaskTreeProvider(makeSingleTaskInventory(), undefined, memento);
    try {
      const node = await firstTaskNode(provider);
      const tooltipValue = (node.tooltip as vscode.MarkdownString).value;
      assert.match(tooltipValue, /not recorded — unknown/i);
    } finally {
      provider.dispose();
    }
  });

  void it("shows no decision state for a task with nothing pending", async () => {
    const memento = new FakeMemento() as unknown as vscode.Memento;
    const provider = new TaskTreeProvider(makeSingleTaskInventory(), undefined, memento);
    try {
      const node = await firstTaskNode(provider);
      assert.ok(!node.contextValue?.includes("decisionPending"));
      const tooltipValue = (node.tooltip as vscode.MarkdownString).value;
      assert.ok(!tooltipValue.includes("Decision waiting"));
      assert.equal(node.pendingDecision, undefined);
    } finally {
      provider.dispose();
    }
  });

  void it("stays visible across repeated renders until the decision is resolved, then disappears", async () => {
    const memento = new FakeMemento() as unknown as vscode.Memento;
    const store = new WorkflowDecisionStoreV1(memento);
    const posted = await store.post(decisionInput());
    assert.equal(posted.ok, true);

    const provider = new TaskTreeProvider(makeSingleTaskInventory(), undefined, memento);
    try {
      // Two unrelated renders in a row — the decision must not be a one-shot
      // toast that vanishes after the first read.
      const first = await firstTaskNode(provider);
      assert.ok(first.contextValue?.includes("decisionPending"));
      const second = await firstTaskNode(provider);
      assert.ok(second.contextValue?.includes("decisionPending"));

      assert.ok(posted.ok);
      if (posted.ok) {
        const resolved = await store.resolve(posted.decision.decisionId, "restore");
        assert.equal(resolved.kind, "resolved");
      }

      const afterResolve = await firstTaskNode(provider);
      assert.ok(!afterResolve.contextValue?.includes("decisionPending"), "a resolved decision no longer renders");
      assert.equal(afterResolve.pendingDecision, undefined);
    } finally {
      provider.dispose();
    }
  });

  void it("fires onDidChangeTreeData when a decision is posted or resolved on a store sharing the same Memento", async () => {
    const memento = new FakeMemento() as unknown as vscode.Memento;
    const store = new WorkflowDecisionStoreV1(memento);
    const provider = new TaskTreeProvider(makeSingleTaskInventory(), undefined, memento);
    try {
      let fires = 0;
      const sub = provider.onDidChangeTreeData(() => { fires += 1; });
      try {
        const posted = await store.post(decisionInput());
        assert.equal(posted.ok, true);
        assert.ok(fires > 0, "posting through an independently-constructed store over the same Memento refreshes the tree");

        const firedAfterPost = fires;
        assert.ok(posted.ok);
        if (posted.ok) {
          await store.resolve(posted.decision.decisionId, "restore");
        }
        assert.ok(fires > firedAfterPost, "resolving also refreshes the tree");
      } finally {
        sub.dispose();
      }
    } finally {
      provider.dispose();
    }
  });
});

// Review-flagged 2026-08-23 (twice): the task-tree tooltip's scheduling
// posture used to derive the owed-continuation fact directly from the live
// `TaskProgress` read rather than the scheduling-intent ledger, an
// unapproved substitute for the plan's "rendered only from the ledger"
// contract. `getChildren` is `async`, so the fix awaits the same
// push-then-read-back sequence `chatView.ts`'s chat-header already uses.
void describe("TaskTreeProvider — scheduling posture reads back from the ledger (task: actionable hand-offs)", () => {
  class FakeMemento {
    private readonly values = new Map<string, unknown>();
    get<T>(key: string, defaultValue: T): T {
      return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
    }
    update(key: string, value: unknown): Promise<void> {
      this.values.set(key, value);
      return Promise.resolve();
    }
  }

  const TASK_FS_PATH = "/workspace/tasks/owed-continuation-task";

  function makeOwedTaskInventory(): import("../state/taskInventory").TaskInventory {
    return {
      getTasks: () => [
        {
          taskFolderPath: TASK_FS_PATH,
          folderName: "owed-continuation-task",
          progress: {
            currentStage: "impl" as TaskStage,
            status: "active",
            taskFolder: "owed-continuation-task",
            createdAt: "2026-08-19T00:00:00.000Z",
            updatedAt: "2026-08-19T00:00:00.000Z",
            implRecovery: {
              sourceAttemptId: "attempt-1",
              reason: "the round's report was unusable",
              trigger: "roundIncomplete",
              mode: "unconstrained",
              dispatch: "pending",
              at: "2026-08-21T08:33:00.000Z",
            },
            pendingImplReviewFiles: ["src/a.ts", "src/b.ts"],
          },
          canonicalId: TASK_FS_PATH,
        },
      ],
      refresh: async (): Promise<void> => {},
      onDidChange: (_handler: () => void): { dispose: () => void } => ({ dispose(): void {} }),
    } as unknown as import("../state/taskInventory").TaskInventory;
  }

  /** getChildren() fires setContext via executeCommand; the stub throws on unregistered commands. */
  async function withStubbedCommands<T>(callback: () => Promise<T>): Promise<T> {
    const commandsStub = vscode.commands as typeof vscode.commands & {
      _executeCommandOverride?: (id: string, ...args: unknown[]) => Promise<unknown>;
    };
    const previous = commandsStub._executeCommandOverride;
    commandsStub._executeCommandOverride = (): Promise<unknown> => Promise.resolve(undefined);
    try {
      return await callback();
    } finally {
      commandsStub._executeCommandOverride = previous;
    }
  }

  async function firstTaskNode(provider: TaskTreeProvider): Promise<TaskNode> {
    const roots = await withStubbedCommands(() => provider.getChildren());
    const node = roots.find((n): n is TaskNode => n instanceof TaskNode);
    assert.ok(node, "the single task renders a TaskNode");
    return node;
  }

  void it("renders the owed-continuation posture derived from the task's live implRecovery record", async () => {
    // dispatch: "pending" -> `deriveSchedulingPostureV1` routes this to the
    // "scheduled" posture (a pending record is retried automatically by the
    // periodic sweep), not "owedWillNotRetry" — see that function's own
    // review-flagged 2026-08-23 comment on why a retryable record must not
    // be described as needing manual intervention.
    const memento = new FakeMemento() as unknown as vscode.Memento;
    const provider = new TaskTreeProvider(makeOwedTaskInventory(), undefined, memento);
    try {
      const node = await firstTaskNode(provider);
      const tooltipValue = (node.tooltip as vscode.MarkdownString).value;
      assert.match(tooltipValue, /owed implementation continuation is queued and will be retried automatically/i);
    } finally {
      provider.dispose();
    }
  });

  void it("reads the posture BACK from the scheduling-intent ledger rather than the raw live read (proves the render is ledger-authoritative)", async () => {
    const memento = new FakeMemento() as unknown as vscode.Memento;
    const provider = new TaskTreeProvider(makeOwedTaskInventory(), undefined, memento);
    try {
      // Force the ledger read-back to disagree with the task's own live
      // `implRecovery.dispatch` ("pending" -> would-retry). If the render
      // still derives directly from the live read (the defect this test
      // guards against), the spy below is never consulted and the tooltip
      // shows the "pending" text regardless. If the render genuinely reads
      // the ledger back after pushing, this override — which fires on every
      // `getOwedContinuation` call, including the one this render performs
      // right after its own push — is what the posture is built from.
      const store = (provider as unknown as {
        schedulingIntentStore?: { getOwedContinuation: (id: string) => unknown };
      }).schedulingIntentStore;
      assert.ok(store, "provider built a schedulingIntentStore from the supplied Memento");
      store.getOwedContinuation = (): unknown => ({
        reason: "a different, ledger-only reason",
        at: "2026-08-21T09:00:00.000Z",
        leaseUntil: "2026-08-21T09:45:00.000Z",
        quarantinedFiles: ["ledger-only-file.ts"],
        dispatch: "dispatched",
      });

      const node = await firstTaskNode(provider);
      const tooltipValue = (node.tooltip as vscode.MarkdownString).value;
      assert.match(
        tooltipValue,
        /a different, ledger-only reason/i,
        "posture text reflects the ledger read-back, not the raw task.progress.implRecovery record"
      );
      assert.match(
        tooltipValue,
        /will not re-fire automatically/i,
        "dispatch state comes from the ledger's read-back value (\"dispatched\"), not the live record's (\"pending\")"
      );
    } finally {
      provider.dispose();
    }
  });
});


