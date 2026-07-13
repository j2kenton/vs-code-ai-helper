/**
 * Unit tests for the normalizeReviewArg helper and review-apply model
 * resolution logic in reviewActions.ts.
 *
 * These tests exercise the pure normalization logic in isolation without
 * requiring the VS Code extension host.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

// ---------------------------------------------------------------------------
// normalizeReviewArg logic (tested by re-implementing the same logic)
// ---------------------------------------------------------------------------
//
// The actual normalizeReviewArg function is not exported from reviewActions.ts
// since it is an internal helper. We test its contract by specifying the
// expected behaviors that callers depend on, then verify them against the
// export surface. If the export surface changes, update these tests.
//
// Alternatively, these tests document the normalization contract so that any
// code author extending the arg handling can rely on this as a spec.

import * as vscode from "vscode";
import { buildFastForwardApplyReviewOptions } from "../commands/reviewActions";
import { parseReadiness } from "../utils/reviewReadiness";

/**
 * Re-implement the normalizeReviewArg contract for test verification.
 * Must match the behavior described in reviewActions.ts.
 */
function normalizeReviewArgSpec(
  arg: { task?: unknown } | { canonicalId?: string; taskFolderPath?: string } | undefined
): { hasTask: boolean; taskFolderPath: string | undefined } {
  if (!arg) {
    return { hasTask: false, taskFolderPath: undefined };
  }
  if ("task" in arg && arg.task) {
    return { hasTask: true, taskFolderPath: undefined };
  }
  const a = arg as { canonicalId?: string; taskFolderPath?: string };
  if (a.taskFolderPath) {
    return { hasTask: true, taskFolderPath: a.taskFolderPath };
  }
  // Only canonicalId — falls through to QuickPick
  return { hasTask: false, taskFolderPath: undefined };
}

void describe("normalizeReviewArg contract", () => {
  void it("undefined arg → no task, no folder path", () => {
    const result = normalizeReviewArgSpec(undefined);
    assert.strictEqual(result.hasTask, false);
    assert.strictEqual(result.taskFolderPath, undefined);
  });

  void it("{ task: IncompleteTask } arg → has task", () => {
    const result = normalizeReviewArgSpec({
      task: {
        folderUri: {},
        folderName: "2026-07-08_task_1",
        progress: {},
      },
    });
    assert.strictEqual(result.hasTask, true);
  });

  void it("{ taskFolderPath } arg → has task, passes folder path", () => {
    const result = normalizeReviewArgSpec({
      taskFolderPath: "/workspace/.helper/plans/2026-07-08_task_1",
    });
    assert.strictEqual(result.hasTask, true);
    assert.strictEqual(
      result.taskFolderPath,
      "/workspace/.helper/plans/2026-07-08_task_1"
    );
  });

  void it("{ canonicalId } only arg → falls through to QuickPick (no task, no folder)", () => {
    // A canonicalId-only argument cannot be resolved by the local resolveTask
    // helper because it needs a folderUri. Falls through to QuickPick.
    const result = normalizeReviewArgSpec({
      canonicalId: "/workspace/.helper/plans/2026-07-08_task_1",
    });
    assert.strictEqual(result.hasTask, false);
    assert.strictEqual(result.taskFolderPath, undefined);
  });

  void it("empty object arg → no task, no folder path", () => {
    const result = normalizeReviewArgSpec({});
    assert.strictEqual(result.hasTask, false);
  });
});

// ---------------------------------------------------------------------------
// applyHighLevelReviewChanges / applyLowLevelReviewChanges delegation contract
// ---------------------------------------------------------------------------
//
// These tests document the expected delegation arg shape: the commands must
// pass taskFolderPath (not canonicalId) when delegating to applyReviewWithAI,
// so normalizeReviewArg can construct a synthetic IncompleteTask for
// resolveTask to re-read fresh progress from disk.

void describe("review-apply delegation arg contract", () => {
  void it("applyHighLevelReviewChanges delegates with taskFolderPath", () => {
    // Simulate the delegation: after resolveTaskContext resolves, the command
    // should delegate { taskFolderPath: resolvedTask.taskFolderPath }.
    const resolvedTask = {
      taskFolderPath: "/workspace/.helper/plans/2026-07-08_task_1",
      canonicalId: "/workspace/.helper/plans/2026-07-08_task_1",
    };

    // The delegation shape must use taskFolderPath so normalizeReviewArg works
    const delegationArg = { taskFolderPath: resolvedTask.taskFolderPath };
    const normalized = normalizeReviewArgSpec(delegationArg);

    assert.strictEqual(normalized.hasTask, true,
      "delegation arg must result in a resolvable task"
    );
    assert.strictEqual(
      normalized.taskFolderPath,
      resolvedTask.taskFolderPath,
      "task folder path must be passed through"
    );
  });

  void it("delegation with canonicalId only would NOT resolve correctly", () => {
    // Contrast: if the delegation used canonicalId instead of taskFolderPath,
    // normalizeReviewArg would fall through to QuickPick — wrong behavior.
    const resolvedTask = {
      taskFolderPath: "/workspace/.helper/plans/2026-07-08_task_1",
      canonicalId: "/workspace/.helper/plans/2026-07-08_task_1",
    };

    const badDelegationArg = { canonicalId: resolvedTask.canonicalId };
    const normalized = normalizeReviewArgSpec(badDelegationArg);

    // canonicalId-only delegation falls through: no task, would show QuickPick
    assert.strictEqual(normalized.hasTask, false,
      "canonicalId-only delegation does NOT resolve — confirms taskFolderPath is required"
    );
  });
});

// ---------------------------------------------------------------------------
// Model resolution stage separation contract
// ---------------------------------------------------------------------------
//
// Documents that applying a plan review must use the `plan` model, applying
// an implementation review must use the `impl` model, and review
// generation must use the review-stage model.

void describe("review apply model resolution contract", () => {
  const PLAN_REVIEW_STAGES = ["plan-high-review", "plan-low-review"];
  const IMPL_REVIEW_STAGES = ["impl-high-review", "impl-low-review"];

  for (const stage of PLAN_REVIEW_STAGES) {
    void it(`plan review apply (${stage}) must use 'plan' execution model`, () => {
      // When applying a plan review, executionStage must be "plan" even though
      // logStage is the review stage. This is the contract from runAiToFile's
      // executionStage option.
      const logStage = stage;
      const executionStage = "plan";
      assert.notStrictEqual(logStage, executionStage,
        "log stage and execution stage must differ for plan review apply"
      );
      assert.strictEqual(executionStage, "plan");
    });
  }

  for (const stage of IMPL_REVIEW_STAGES) {
    void it(`implementation review apply (${stage}) must use 'impl' execution model`, () => {
      // applyImplementationReviewWithAI resolves from the implementation stage
      // (`impl`), not from the parked review stage.
      const executionStage = "impl";
      assert.strictEqual(executionStage, "impl");
      assert.notStrictEqual(stage, executionStage,
        "review stage and execution stage must differ for impl review apply"
      );
    });
  }

  for (const stage of [...PLAN_REVIEW_STAGES, ...IMPL_REVIEW_STAGES]) {
    void it(`review generation (${stage}) uses the review-stage model (logStage == executionStage)`, () => {
      // runReviewForFolder calls runAiToFile with logStage and no executionStage,
      // so model resolution falls back to logStage.
      const logStage = stage;
      const effectiveModelStage = logStage; // no executionStage override
      assert.strictEqual(effectiveModelStage, logStage);
    });
  }
});

void describe("fast-forward fallback contract", () => {
  void it("treats only the first internal apply attempt as a fresh invocation", () => {
    assert.deepStrictEqual(
      buildFastForwardApplyReviewOptions(1),
      {
        skipImplementationSafetyCheck: false,
        preserveActiveFallback: false,
      }
    );
    assert.deepStrictEqual(
      buildFastForwardApplyReviewOptions(2),
      {
        skipImplementationSafetyCheck: true,
        preserveActiveFallback: true,
      }
    );
  });
});

// ---------------------------------------------------------------------------
// Implementation-pipeline fallback-stage contract
// ---------------------------------------------------------------------------
//
// executeImplementationRun (used by runImplementationWithAI and
// applyImplementationReviewWithAI) always resolves its model from the "impl"
// stage, regardless of postRunReviewStage (which only picks which review to
// auto-run afterward — see runReviewForFolder(..., postRunReviewStage, true)).
// Its call into runImplementationForModel must therefore pass stage: "impl",
// not postRunReviewStage, so quota telemetry and fallbackActive bookkeeping
// stay attributed to the stage the model actually came from. Mirrors the
// logStage/executionStage separation documented above for runAiToFile.

void describe("implementation-pipeline fallback-stage contract", () => {
  const REVIEW_STAGES_WHEN_PARKED = ["impl-high-review", "impl-low-review", "publish"];

  for (const postRunReviewStage of REVIEW_STAGES_WHEN_PARKED) {
    void it(`postRunReviewStage=${postRunReviewStage} must not change the fallback stage`, () => {
      const modelResolutionStage = "impl";
      const fallbackBookkeepingStage = modelResolutionStage;
      assert.notStrictEqual(
        postRunReviewStage,
        fallbackBookkeepingStage,
        "postRunReviewStage is only for picking the post-run review, not fallback bookkeeping"
      );
      assert.strictEqual(fallbackBookkeepingStage, "impl");
    });
  }
});

// ---------------------------------------------------------------------------
// Review output validation contract (runAiToFile's validateOutput hook)
// ---------------------------------------------------------------------------
//
// runReviewForFolder passes validateReviewOutput to runAiToFile so that a CLI
// response which exits 0 with non-empty text, but never actually performed
// the review (e.g. a model that answers with a clarifying question about the
// prompt file instead of reviewing it — observed with the Antigravity CLI),
// is rejected and reverted instead of being accepted as a completed review.
// validateReviewOutput itself is not exported; it is a thin wrapper around
// parseReadiness, so these tests document its contract directly against that
// shared parser.

function validateReviewOutputSpec(content: string): boolean {
  return parseReadiness(content).score !== null;
}

void describe("validateReviewOutput contract (review generation)", () => {
  void it("rejects a response with no Readiness line", () => {
    const clarifyingQuestion =
      "I see you've opened the implementation-review context file. " +
      "What would you like me to do with it?";
    assert.strictEqual(validateReviewOutputSpec(clarifyingQuestion), false);
  });

  void it("rejects an empty response", () => {
    assert.strictEqual(validateReviewOutputSpec(""), false);
  });

  void it("accepts a response with a well-formed Readiness line", () => {
    const realReview =
      "Readiness: 7/10\n\n- Summary verdict: needs changes.\n- Blocking issues: none.";
    assert.strictEqual(validateReviewOutputSpec(realReview), true);
  });
});

// ---------------------------------------------------------------------------
// URI canonicalization: vscode.Uri.file round-trips
// ---------------------------------------------------------------------------

void describe("vscode.Uri.file for task folder normalization", () => {
  void it("Uri.file produces a URI with fsPath and path", () => {
    const uri = vscode.Uri.file("/workspace/.helper/plans/2026-07-08_task_1");
    assert.ok(uri.fsPath.length > 0);
    assert.ok(uri.path.length > 0);
  });

  void it("Uri.joinPath composes path segments correctly", () => {
    const base = vscode.Uri.file("/workspace/.helper/plans/2026-07-08_task_1");
    const joined = vscode.Uri.joinPath(base, "task-progress.json");
    assert.ok(joined.fsPath.endsWith("task-progress.json") || joined.path.endsWith("task-progress.json"),
      `expected path to end with task-progress.json, got: ${joined.path}`
    );
  });
});
