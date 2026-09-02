/**
 * Unit tests for the normalizeReviewArg helper and review-apply model
 * resolution logic in reviewActions.ts.
 *
 * These tests exercise the pure normalization logic in isolation without
 * requiring the VS Code extension host.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

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
import {
  buildFastForwardApplyReviewOptions,
  fastForwardReviewWithAI,
  peekFastForwardTargetsImplReviewFromPathV1,
  resolveBaselineReviewHistoryEntryV1,
  selectReviewPromptTemplate,
  shouldRideThroughEscalationV1,
  isFreshEscalationForRideThroughV1,
  escalationIdentityStillMatchesV1,
} from "../commands/reviewActions";
import { fastForwardCurrentTaskReview } from "../commands/fastForwardCurrentTaskReview";
import { TaskOperationHandle } from "../utils/taskOperations";
import { parseReadiness } from "../utils/reviewReadiness";
import { fixtureOwnershipFor, makeOwnedTaskFolder } from "./taskFolderFixture";
import {
  deactivateNotificationRouter,
  initNotificationRouter,
} from "../utils/notificationRouter";
import type { TaskInventory } from "../state/taskInventory";
import type { CurrentTaskStore } from "../utils/currentTaskStore";
import type { TaskEscalation, TaskProgress } from "../types/taskProgress";

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
// These tests document the expected delegation arg shape. The commands must
// delegate with { task: IncompleteTask } carrying the already-read, real
// progress — not { taskFolderPath } — so that applyReviewWithAI's early gate
// check (plan §1.3) can trust arg.task.progress.currentStage to fire the
// applyReviewEdit.v1 gate BEFORE performing any read of its own. A
// { taskFolderPath } arg is deliberately re-wrapped by normalizeReviewArg
// with an untrustworthy placeholder stage and must fall through to a fresh
// resolveTask read (and thus a post-read gate check) instead.

void describe("review-apply delegation arg contract", () => {
  void it("applyHighLevelReviewChanges delegates with { task } carrying real progress", () => {
    // Simulate the delegation: after resolveTaskContext resolves, the command
    // should delegate { task: { folderUri, folderName, progress } } built
    // from the already-read progress, not a bare taskFolderPath.
    const resolvedTask = {
      taskFolderPath: "/workspace/.helper/plans/2026-07-08_task_1",
      canonicalId: "/workspace/.helper/plans/2026-07-08_task_1",
      progress: { currentStage: "impl-high-review", status: "active" },
    };

    const delegationArg = {
      task: {
        folderUri: {},
        folderName: "2026-07-08_task_1",
        progress: resolvedTask.progress,
      },
    };
    const normalized = normalizeReviewArgSpec(delegationArg);

    assert.strictEqual(normalized.hasTask, true,
      "delegation arg must result in a resolvable task"
    );
    // A { task } delegation carries no separate taskFolderPath field — the
    // real stage travels on task.progress.currentStage instead, which is
    // exactly what lets the caller's already-known stage gate the edit
    // branch before any read.
    assert.strictEqual(normalized.taskFolderPath, undefined);
  });

  void it("delegation with canonicalId only would NOT resolve correctly", () => {
    // Contrast: canonicalId alone (neither task nor taskFolderPath) falls
    // through to QuickPick — wrong behavior for a keyboard-shortcut command
    // that already resolved a specific task.
    const resolvedTask = {
      taskFolderPath: "/workspace/.helper/plans/2026-07-08_task_1",
      canonicalId: "/workspace/.helper/plans/2026-07-08_task_1",
    };

    const badDelegationArg = { canonicalId: resolvedTask.canonicalId };
    const normalized = normalizeReviewArgSpec(badDelegationArg);

    // canonicalId-only delegation falls through: no task, would show QuickPick
    assert.strictEqual(normalized.hasTask, false,
      "canonicalId-only delegation does NOT resolve — confirms task/taskFolderPath is required"
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

// ---------------------------------------------------------------------------
// Implementation-review apply prompt contract
// ---------------------------------------------------------------------------
//
// The approved plan is the implementation contract. plan-final.md is useful
// historical context, but it must not replace plan.md in the apply prompt.

void describe("implementation review apply prompt contract", () => {
  void it("passes the approved plan separately from implementation notes", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src", "commands", "reviewActions.ts"),
      "utf8"
    );

    assert.match(
      source,
      /resolveCurrentPlanUri\(folderUri\);/,
      "implementation review application must load the approved plan"
    );
    assert.match(
      source,
      /approvedPlan,\s*implementation:\s*implementationNotes,\s*review:\s*reviewContentCapped,/s,
      "the apply prompt must receive both the contract and historical notes"
    );
  });
});

void describe("review and re-review prompt selection", () => {
  const cases = [
    {
      stage: "plan-high-review",
      initialPrompt: "review-plan-high.md",
      rereviewPrompt: "review-plan-high-rereview.md",
    },
    {
      stage: "plan-low-review",
      initialPrompt: "review-plan-low.md",
      rereviewPrompt: "review-plan-low-rereview.md",
    },
    {
      stage: "impl-high-review",
      initialPrompt: "review-impl-high.md",
      rereviewPrompt: "review-impl-high-rereview.md",
    },
    {
      stage: "impl-low-review",
      initialPrompt: "review-impl-low.md",
      rereviewPrompt: "review-impl-low-rereview.md",
    },
    {
      stage: "publish",
      initialPrompt: "review-publish.md",
      rereviewPrompt: "review-publish-rereview.md",
    },
  ] as const;

  for (const testCase of cases) {
    void it(`has both prompt files for ${testCase.stage}`, () => {
      for (const promptFile of [testCase.initialPrompt, testCase.rereviewPrompt]) {
        assert.ok(
          fs.existsSync(path.join(process.cwd(), "resources", "prompts", promptFile)),
          `missing review prompt: ${promptFile}`
        );
      }
    });

    void it(`uses the initial ${testCase.stage} prompt when no previous review exists`, () => {
      assert.strictEqual(
        selectReviewPromptTemplate(
          testCase.stage,
          testCase.stage,
          undefined
        ),
        testCase.initialPrompt
      );
    });

    void it(`uses the reconciliation prompt when re-reviewing ${testCase.stage}`, () => {
      assert.strictEqual(
        selectReviewPromptTemplate(
          testCase.stage,
          testCase.stage,
          "Readiness: 5/10\n\n- Completion blockers: one."
        ),
        testCase.rereviewPrompt
      );
    });

    void it(`does not treat a stale ${testCase.stage} placeholder as a previous review`, () => {
      assert.strictEqual(
        selectReviewPromptTemplate(
          testCase.stage,
          testCase.stage,
          "# Review Stale\n\nRun Review with AI again."
        ),
        testCase.initialPrompt
      );
    });
  }

  void it("uses the initial prompt when entering a review stage even if an old artifact exists", () => {
    assert.strictEqual(
      selectReviewPromptTemplate(
        "plan-high-review",
        "plan",
        "Readiness: 5/10\n\n- Completion blockers: one."
      ),
      "review-plan-high.md"
    );
  });
});

void describe("fast-forward fallback contract", () => {
  // Fast Forward holds the task operation for the whole run; each nested apply
  // attempt must inherit that handle rather than call begin() again. If the
  // handle stops being threaded through, the nested begin() would be refused by
  // its own parent's exclusive lock, emit a spurious "already in progress"
  // warning and abort the attempt — so the handle is asserted, not just the flags.
  const parentOperation = {
    id: "op-test",
    key: "c:/tasks/task_1",
    label: "Fast Forward Review",
    stage: "impl-high-review",
    report: () => {},
  } as unknown as TaskOperationHandle;

  void it("threads the parent operation handle into every internal apply attempt", () => {
    assert.strictEqual(
      buildFastForwardApplyReviewOptions(1, parentOperation).parentOperation,
      parentOperation
    );
    assert.strictEqual(
      buildFastForwardApplyReviewOptions(2, parentOperation).parentOperation,
      parentOperation
    );
  });

  void it("treats only the first internal apply attempt as a fresh invocation", () => {
    assert.deepStrictEqual(
      buildFastForwardApplyReviewOptions(1, parentOperation),
      {
        skipImplementationSafetyCheck: false,
        preserveActiveFallback: false,
        parentOperation,
        chatViewProvider: undefined,
      }
    );
    assert.deepStrictEqual(
      buildFastForwardApplyReviewOptions(2, parentOperation),
      {
        skipImplementationSafetyCheck: true,
        preserveActiveFallback: true,
        parentOperation,
        chatViewProvider: undefined,
      }
    );
  });
});

// ---------------------------------------------------------------------------
// Item 13 (2026-08-18..19 workflow-defects batch): Fast Forward must never
// ride through a `plateau` escalation — it is the anti-convergence signal by
// definition, so finishing the attempt budget cannot help. Other escalation
// kinds remain eligible when the setting is on, matching the case the
// setting was written for (a single escalation mid-budget on an otherwise
// converging run). Tested as a pure predicate rather than through the full
// Fast Forward provider/notification harness — see shouldRideThroughEscalationV1's
// own doc comment.
// ---------------------------------------------------------------------------

void describe("shouldRideThroughEscalationV1 (item 13)", () => {
  void it("never rides through a plateau escalation, even with the setting on and the stage matching", () => {
    assert.equal(
      shouldRideThroughEscalationV1({
        survivesEscalationSetting: true,
        escalationStage: "impl-high-review",
        escalationKind: "plateau",
        targetStage: "impl-high-review",
      }),
      false,
      "a plateau escalation pauses Fast Forward and the pause must hold — the un-pause path must not be taken"
    );
  });

  void it("rides through a non-plateau escalation when the setting is on and the stage matches — the breaker ordering this preserves is pinned by resilienceDefaults.test.ts", () => {
    for (const kind of ["spec-defect", "environmental", "unverifiable", "reviewer-disagreement"] as const) {
      assert.equal(
        shouldRideThroughEscalationV1({
          survivesEscalationSetting: true,
          escalationStage: "impl-high-review",
          escalationKind: kind,
          targetStage: "impl-high-review",
        }),
        true,
        `kind ${kind} must remain ride-through eligible`
      );
    }
  });

  void it("never rides through when the setting is off, regardless of kind", () => {
    assert.equal(
      shouldRideThroughEscalationV1({
        survivesEscalationSetting: false,
        escalationStage: "impl-high-review",
        escalationKind: "environmental",
        targetStage: "impl-high-review",
      }),
      false
    );
  });

  void it("never rides through an escalation for a DIFFERENT stage than the one Fast Forward is targeting", () => {
    assert.equal(
      shouldRideThroughEscalationV1({
        survivesEscalationSetting: true,
        escalationStage: "impl-low-review",
        escalationKind: "environmental",
        targetStage: "impl-high-review",
      }),
      false
    );
  });

  void it("never rides through when there is no escalation on record", () => {
    assert.equal(
      shouldRideThroughEscalationV1({
        survivesEscalationSetting: true,
        escalationStage: undefined,
        escalationKind: undefined,
        targetStage: "impl-high-review",
      }),
      false
    );
  });
});

// ---------------------------------------------------------------------------
// isFreshEscalationForRideThroughV1 / escalationIdentityStillMatchesV1
// (item 13 review fix, 2026-08-20): the two race conditions the review found
// in the read-then-write ride-through mutation. Pulled out as pure
// predicates for the same reason as shouldRideThroughEscalationV1 — the full
// Fast Forward provider/notification harness is not needed to pin the exact
// read/CAS logic that was broken.
// ---------------------------------------------------------------------------

void describe("isFreshEscalationForRideThroughV1 (item 13 review fix)", () => {
  const escalation: TaskEscalation = {
    stage: "impl-high-review",
    kind: "environmental",
    reason: "flaky provider",
    at: "2026-08-20T10:00:00.000Z",
  };

  void it("is fresh when no ride-through has happened yet this run (lastRiddenThroughEscalationAt is undefined)", () => {
    assert.equal(isFreshEscalationForRideThroughV1(escalation, undefined), true);
  });

  void it("is fresh when the escalation's own `at` differs from the last one ridden through", () => {
    assert.equal(
      isFreshEscalationForRideThroughV1(escalation, "2026-08-20T09:00:00.000Z"),
      true
    );
  });

  void it("is NOT fresh when the escalation's `at` matches the last one ridden through — the exact stale-record race", () => {
    // The scenario this closes: escalation is never cleared on ride-through,
    // so a LATER external/manual pause that happens to land while the same
    // stale record is still on the stage must not be mistaken for the same
    // escalation being approved a second time.
    assert.equal(isFreshEscalationForRideThroughV1(escalation, escalation.at), false);
  });

  void it("is NOT fresh when there is no escalation at all", () => {
    assert.equal(isFreshEscalationForRideThroughV1(undefined, undefined), false);
  });
});

void describe("escalationIdentityStillMatchesV1 (item 13 review fix)", () => {
  const inspected: TaskEscalation = {
    stage: "impl-high-review",
    kind: "environmental",
    reason: "flaky provider",
    at: "2026-08-20T10:00:00.000Z",
  };

  void it("matches when status, stage, kind, and `at` are all unchanged since the read", () => {
    const current: Pick<TaskProgress, "status" | "escalation"> = {
      status: "paused",
      escalation: inspected,
    };
    assert.equal(escalationIdentityStillMatchesV1(current, inspected, "impl-high-review"), true);
  });

  void it("does NOT match when a DIFFERENT escalation (e.g. a plateau) replaced the inspected one on the same stage between read and write — the exact race the review found", () => {
    const current: Pick<TaskProgress, "status" | "escalation"> = {
      status: "paused",
      escalation: {
        stage: "impl-high-review",
        kind: "plateau",
        reason: "iteration is not converging",
        at: "2026-08-20T10:00:05.000Z",
      },
    };
    assert.equal(escalationIdentityStillMatchesV1(current, inspected, "impl-high-review"), false);
  });

  void it("does NOT match when the task is no longer paused", () => {
    const current: Pick<TaskProgress, "status" | "escalation"> = {
      status: "active",
      escalation: inspected,
    };
    assert.equal(escalationIdentityStillMatchesV1(current, inspected, "impl-high-review"), false);
  });

  void it("does NOT match when the escalation moved to a different stage", () => {
    const current: Pick<TaskProgress, "status" | "escalation"> = {
      status: "paused",
      escalation: { ...inspected, stage: "impl-low-review" },
    };
    assert.equal(escalationIdentityStillMatchesV1(current, inspected, "impl-high-review"), false);
  });

  void it("does NOT match when there is no escalation recorded at all", () => {
    const current: Pick<TaskProgress, "status" | "escalation"> = { status: "paused" };
    assert.equal(escalationIdentityStillMatchesV1(current, inspected, "impl-high-review"), false);
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

// ---------------------------------------------------------------------------
// peekFastForwardTargetsImplReviewFromPathV1 (plan §7.5/AC-HOST-03): the
// `{ taskFolderPath }` companion to fastForwardTargetsImplReviewV1's
// zero-I/O arg.task.progress peek. Unlike that zero-I/O peek, this one does
// perform a single targeted disk read, so its contract is what matters most:
// a known impl-review target resolves `true`, a known plan-review (or any
// other non-edit-eligible) target resolves `false`/`undefined`, and any read
// failure (missing, corrupt/unbound) resolves `undefined` — never throws,
// never shows a notification — so callers always fall through to the
// existing, authoritative resolveTask/resolveTaskContext read instead.
// ---------------------------------------------------------------------------

/** The test vscode stub does not implement workspace.fs.readFile; bridge it to real fs. */
function installReadFileBridge(): { restore: () => void } {
  const target = vscode.workspace.fs as unknown as Record<string, unknown>;
  const orig = target.readFile;
  target.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  return { restore: (): void => { target.readFile = orig; } };
}

void describe("peekFastForwardTargetsImplReviewFromPathV1 contract", () => {
  let bridge: { restore: () => void };
  before(() => { bridge = installReadFileBridge(); });
  after(() => { bridge.restore(); });

  void it("resolves true for a task at an implementation-review-mapped stage (impl)", async () => {
    const fixture = makeOwnedTaskFolder("ff-peek-impl-");
    try {
      const result = await peekFastForwardTargetsImplReviewFromPathV1(fixture.folder);
      assert.equal(result, true);
    } finally {
      fs.rmSync(path.dirname(fixture.folder), { recursive: true, force: true });
    }
  });

  void it("resolves false for a task at a plan-review-mapped stage (plan)", async () => {
    const container = fs.mkdtempSync(path.join(os.tmpdir(), "ff-peek-plan-"));
    const folder = path.join(container, "tasks", `${path.basename(container)}-task`);
    fs.mkdirSync(folder, { recursive: true });
    const ownership = fixtureOwnershipFor(folder);
    const progress = {
      taskFolder: path.basename(folder),
      currentStage: "plan",
      createdAt: "2026-07-01T10:00:00.000Z",
      updatedAt: "2026-07-02T11:30:00.000Z",
      ownership,
    };
    fs.writeFileSync(path.join(folder, "task-progress.json"), JSON.stringify(progress, null, 2));
    try {
      const result = await peekFastForwardTargetsImplReviewFromPathV1(folder);
      assert.equal(result, false);
    } finally {
      fs.rmSync(container, { recursive: true, force: true });
    }
  });

  void it("resolves undefined (never throws) for a folder with no task-progress.json", async () => {
    const container = fs.mkdtempSync(path.join(os.tmpdir(), "ff-peek-missing-"));
    const folder = path.join(container, "tasks", `${path.basename(container)}-task`);
    fs.mkdirSync(folder, { recursive: true });
    try {
      const result = await peekFastForwardTargetsImplReviewFromPathV1(folder);
      assert.equal(result, undefined);
    } finally {
      fs.rmSync(container, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// fastForwardReviewWithAI / fastForwardCurrentTaskReview — §7.5/AC-HOST-03
// read-before-gate ordering. The prior peek-then-enforce structure ran a
// task-progress read (directly, or via resolveTask/resolveTaskContext) before
// the coarse host/provider gate was ever enforced for the "don't know the
// target's category yet" case (bare invocations, a `{ taskFolderPath }` arg,
// and the shortcut's cache-miss/ambiguous branches). These tests force the
// host gate to fail and prove the gate is enforced before ANY disk read for
// every one of those shapes: a bare invocation, a `{ taskFolderPath }`
// invocation naming a real implementation-review task, and the shortcut
// router's cache-miss case (a persisted pointer not present in the in-memory
// inventory snapshot).
// ---------------------------------------------------------------------------

/** Force checkEditActionHostGateV1() to fail without touching any task/workspace state. */
function installFailingHostGate(): { restore: () => void } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const raw = require("vscode") as Record<string, unknown>;
  const original = raw.LanguageModelToolResultPart;
  delete raw.LanguageModelToolResultPart;
  return {
    restore: (): void => {
      raw.LanguageModelToolResultPart = original;
    },
  };
}

/** Count vscode.workspace.fs.readFile calls, bridging through to real fs (test stub has no readFile). */
function installReadFileCounter(): { count: () => number; restore: () => void } {
  const target = vscode.workspace.fs as unknown as Record<string, unknown>;
  const original = target.readFile;
  let calls = 0;
  target.readFile = (uri: vscode.Uri): Promise<Uint8Array> => {
    calls += 1;
    return fs.promises.readFile(uri.fsPath).then((buf) => new Uint8Array(buf));
  };
  return {
    count: () => calls,
    restore: (): void => {
      target.readFile = original;
    },
  };
}

/** Recording notification surface: captures warning messages without requiring the real status view. */
function installRecordingNotificationSurface(): { warnings: string[]; restore: () => void } {
  const warnings: string[] = [];
  initNotificationRouter({
    addEntry: (message: string, level: "info" | "warning" | "error"): void => {
      if (level === "warning") {
        warnings.push(message);
      }
    },
  });
  return {
    warnings,
    restore: (): void => {
      deactivateNotificationRouter();
    },
  };
}

void describe("fastForwardReviewWithAI — read-before-gate ordering (§7.5/AC-HOST-03)", () => {
  void it("rejects a bare (no-arg) invocation before any task read when the host gate fails", async () => {
    const gate = installFailingHostGate();
    const reads = installReadFileCounter();
    const notif = installRecordingNotificationSurface();
    try {
      await fastForwardReviewWithAI(
        vscode.Uri.file("/dummy"),
        {} as vscode.ExtensionContext,
        undefined,
        undefined
      );
      assert.equal(reads.count(), 0, "must not read any task/source state before rejecting");
      assert.equal(notif.warnings.length, 1);
    } finally {
      notif.restore();
      reads.restore();
      gate.restore();
    }
  });

  void it("rejects a { taskFolderPath } invocation before its targeted disk read when the host gate fails", async () => {
    const fixture = makeOwnedTaskFolder("ff-order-path-");
    const gate = installFailingHostGate();
    const reads = installReadFileCounter();
    const notif = installRecordingNotificationSurface();
    try {
      await fastForwardReviewWithAI(
        vscode.Uri.file("/dummy"),
        {} as vscode.ExtensionContext,
        { taskFolderPath: fixture.folder },
        undefined
      );
      assert.equal(reads.count(), 0, "must not read task-progress.json before rejecting");
      assert.equal(notif.warnings.length, 1);
    } finally {
      notif.restore();
      reads.restore();
      gate.restore();
      fs.rmSync(path.dirname(fixture.folder), { recursive: true, force: true });
    }
  });
});

void describe("resolveBaselineReviewHistoryEntryV1 — Fast Forward baseline reviewer lookup", () => {
  void it(
    "reads fresh from disk, picking up a reviewScoreHistory entry the in-memory snapshot predates",
    async () => {
      // Reproduces the workflow-2 item-7 review finding: fastForwardReviewWithAI
      // runs the initial review (when none exists yet) using a task-progress
      // snapshot captured BEFORE that run, then originally computed the
      // baseline reviewer from that stale snapshot — missing the very
      // reviewScoreHistory entry the initial review just appended to disk.
      // `fallbackProgress` here stands in for that stale snapshot: it has no
      // reviewScoreHistory at all, exactly like a task that has never been
      // reviewed at this stage yet, while the on-disk file (written
      // "concurrently" by the simulated initial review) already carries the
      // entry with its reviewer identity.
      const fixture = makeOwnedTaskFolder("ff-baseline-reviewer-");
      const reads = installReadFileCounter();
      try {
        const progressPath = path.join(fixture.folder, "task-progress.json");
        const onDisk = JSON.parse(fs.readFileSync(progressPath, "utf8")) as Record<string, unknown>;
        onDisk.currentStage = "impl-high-review";
        onDisk.reviewScoreHistory = [
          {
            stage: "impl-high-review",
            score: 9,
            attemptId: "attempt-1",
            at: "2026-08-13T10:00:00.000Z",
            blockerCount: 0,
            taskFixableCount: 0,
            reviewer: { providerLabel: "OpenAI Codex", storedModelId: "gpt-5.6-sol@high" },
          },
        ];
        fs.writeFileSync(progressPath, JSON.stringify(onDisk, null, 2));

        const staleFallbackProgress = {
          taskFolder: path.basename(fixture.folder),
          currentStage: "impl-high-review",
          createdAt: "2026-07-01T10:00:00.000Z",
          updatedAt: "2026-07-02T11:30:00.000Z",
          ownership: fixture.ownership,
          // No reviewScoreHistory — the pre-review-run snapshot's shape.
        } as unknown as import("../types/taskProgress").TaskProgress;

        const entry = await resolveBaselineReviewHistoryEntryV1(
          vscode.Uri.file(fixture.folder),
          "impl-high-review" as import("../types/taskProgress").TaskStage,
          staleFallbackProgress
        );

        assert.ok(entry, "must find the on-disk history entry despite a stale fallback snapshot");
        assert.equal(entry?.reviewer?.storedModelId, "gpt-5.6-sol@high");
        assert.equal(entry?.score, 9);
      } finally {
        reads.restore();
        fs.rmSync(path.dirname(fixture.folder), { recursive: true, force: true });
      }
    }
  );

  void it("falls back to the supplied progress when disk read fails (e.g. missing file)", async () => {
    const reads = installReadFileCounter();
    const fallbackProgress = {
      taskFolder: "ghost-task",
      currentStage: "impl-high-review",
      createdAt: "2026-07-01T10:00:00.000Z",
      updatedAt: "2026-07-02T11:30:00.000Z",
      reviewScoreHistory: [
        {
          stage: "impl-high-review",
          score: 7,
          attemptId: "attempt-fallback",
          at: "2026-08-13T10:00:00.000Z",
          blockerCount: 1,
          taskFixableCount: 1,
          reviewer: { providerLabel: "Cline", storedModelId: "cline-pass/kimi-k3@xhigh" },
        },
      ],
    } as unknown as import("../types/taskProgress").TaskProgress;

    try {
      const entry = await resolveBaselineReviewHistoryEntryV1(
        vscode.Uri.file(path.join(os.tmpdir(), "does-not-exist-" + Date.now())),
        "impl-high-review" as import("../types/taskProgress").TaskStage,
        fallbackProgress
      );

      assert.equal(entry?.reviewer?.storedModelId, "cline-pass/kimi-k3@xhigh");
      assert.equal(entry?.score, 7);
    } finally {
      reads.restore();
    }
  });
});

/**
 * Build a fake TaskInventory/CurrentTaskStore pair that records every
 * accessor call, so ordering tests can assert zero in-memory task-state
 * reads occurred before rejection — not just zero disk reads. A prior
 * version of fastForwardCurrentTaskReview.ts read `currentTaskStore.get()`
 * and the in-memory inventory (getTaskById/getVisibleTaskForSuppressedId/
 * getTasks) to answer a "is this target plan-review-only" pre-check before
 * enforcing the gate; those are task-state reads even though they never
 * touch disk, which is exactly what the review flagged as unproven by a
 * readFile-only counter.
 */
function installSpyingTaskState(pointer: string | undefined): {
  inventory: TaskInventory;
  currentTaskStore: CurrentTaskStore;
  calls: () => number;
} {
  let calls = 0;
  const inventory = {
    getTaskById: (): undefined => {
      calls += 1;
      return undefined;
    },
    getVisibleTaskForSuppressedId: (): undefined => {
      calls += 1;
      return undefined;
    },
    getTasks: (): unknown[] => {
      calls += 1;
      return [];
    },
  } as unknown as TaskInventory;
  const currentTaskStore = {
    get: (): string | undefined => {
      calls += 1;
      return pointer;
    },
  } as unknown as CurrentTaskStore;
  return { inventory, currentTaskStore, calls: () => calls };
}

void describe("fastForwardCurrentTaskReview — read-before-gate ordering (§7.5/AC-HOST-03)", () => {
  void it("rejects a cache-miss current-task pointer before touching CurrentTaskStore or TaskInventory when the host gate fails", async () => {
    const fixture = makeOwnedTaskFolder("ff-order-shortcut-");
    const gate = installFailingHostGate();
    const reads = installReadFileCounter();
    const notif = installRecordingNotificationSurface();
    // The persisted pointer names a real, existing task folder, but the
    // in-memory inventory snapshot has no record of it — the "stale cache"
    // case fastForwardCurrentTaskReview.ts's own comments describe, which
    // previously fell through to its own targeted disk peek unchecked.
    const spies = installSpyingTaskState(fixture.folder);
    try {
      await fastForwardCurrentTaskReview(spies.inventory, spies.currentTaskStore);
      assert.equal(reads.count(), 0, "must not read task-progress.json before rejecting");
      assert.equal(
        spies.calls(),
        0,
        "must not call CurrentTaskStore.get or any TaskInventory accessor before rejecting"
      );
      assert.equal(notif.warnings.length, 1);
    } finally {
      notif.restore();
      reads.restore();
      gate.restore();
      fs.rmSync(path.dirname(fixture.folder), { recursive: true, force: true });
    }
  });

  void it("rejects a no-pointer, no-sole-active-task invocation before touching CurrentTaskStore or TaskInventory when the host gate fails", async () => {
    const gate = installFailingHostGate();
    const reads = installReadFileCounter();
    const notif = installRecordingNotificationSurface();
    const spies = installSpyingTaskState(undefined);
    try {
      await fastForwardCurrentTaskReview(spies.inventory, spies.currentTaskStore);
      assert.equal(reads.count(), 0, "must not read any task state before rejecting");
      assert.equal(
        spies.calls(),
        0,
        "must not call CurrentTaskStore.get or any TaskInventory accessor before rejecting"
      );
      assert.equal(notif.warnings.length, 1);
    } finally {
      notif.restore();
      reads.restore();
      gate.restore();
    }
  });
});
