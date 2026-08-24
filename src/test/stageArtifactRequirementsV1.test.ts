/**
 * Regression coverage for the stage-prerequisite contract (task: Actionable
 * Hand-offs, "Also in scope: say which artifacts a stage needs before it can
 * run"). Before this module existed, "No plan-final.md or implementation.md
 * found..." and "No plan found (or it is empty)..." were independently
 * authored strings at each refusal call site, arriving only after the user
 * had already clicked the action. These tests prove:
 *
 *   1. `stageActionRequirementMessageV1` is not a second, independently
 *      maintained copy of the text in `requirementsForStageActionV1`'s
 *      records — it reads the SAME record.
 *   2. `firstUnmetStageActionRequirementV1` (the pre-flight check the
 *      task-tree tooltip uses) identifies exactly the requirement whose
 *      `missingMessage` is what the actual refusal shows, so a tooltip and
 *      its refusal can never disagree about which file is missing or why.
 */
import * as assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import * as vscode from "vscode";

import {
  requirementsForStageActionV1,
  stageActionsForPreflightV1,
  stageActionRequirementMessageV1,
  StageActionIdV1,
  STAGE_ACTION_ARTIFACT_REQUIREMENTS_V1,
} from "../utils/stageArtifactRequirementsV1";
import {
  firstUnmetStageActionRequirementV1,
  firstUnmetStagePrerequisiteV1,
} from "../utils/implementationArtifactResolver";

const ALL_ACTION_IDS = Object.keys(STAGE_ACTION_ARTIFACT_REQUIREMENTS_V1) as StageActionIdV1[];

void describe("stageArtifactRequirementsV1 — single source of truth for pre-flight text and refusal text", () => {
  void it("stageActionRequirementMessageV1 returns exactly the missingMessage recorded for that index, for every action and requirement", () => {
    for (const actionId of ALL_ACTION_IDS) {
      const requirements = requirementsForStageActionV1(actionId);
      assert.ok(requirements.length > 0, `${actionId} declares at least one requirement`);
      requirements.forEach((requirement, index) => {
        assert.equal(
          stageActionRequirementMessageV1(actionId, index),
          requirement.missingMessage,
          `${actionId}[${index}] accessor text must equal the requirement record's own missingMessage`
        );
      });
    }
  });

  void it("stageActionRequirementMessageV1 throws on an out-of-range index rather than silently returning stale/undefined text", () => {
    assert.throws(() => stageActionRequirementMessageV1("reviewPlan", 5));
  });

  void it("every requirement carries a non-empty requirementLabel and producedByStage, so a pre-flight surface always has something to render", () => {
    for (const actionId of ALL_ACTION_IDS) {
      for (const requirement of requirementsForStageActionV1(actionId)) {
        assert.ok(requirement.requirementLabel.length > 0);
        assert.ok(requirement.producedByStage.length > 0);
      }
    }
  });

  void it("stageActionsForPreflightV1 maps every artifact-gated stage to its ordered action list, including Implementation and Apply, and gives non-gated stages none", () => {
    assert.deepEqual(stageActionsForPreflightV1("plan-high-review"), ["reviewPlan", "applyReviewPlan"]);
    assert.deepEqual(stageActionsForPreflightV1("plan-low-review"), ["reviewPlan", "applyReviewPlan"]);
    assert.deepEqual(stageActionsForPreflightV1("impl"), ["runImplementation"]);
    assert.deepEqual(stageActionsForPreflightV1("impl-high-review"), [
      "reviewImplementation",
      "applyReviewImplementation",
    ]);
    assert.deepEqual(stageActionsForPreflightV1("impl-low-review"), [
      "reviewImplementation",
      "applyReviewImplementation",
    ]);
    assert.deepEqual(stageActionsForPreflightV1("publish"), [
      "reviewImplementation",
      "applyReviewImplementation",
    ]);
    assert.deepEqual(stageActionsForPreflightV1("desc"), []);
    assert.deepEqual(stageActionsForPreflightV1("plan"), []);
  });
});

void describe("firstUnmetStageActionRequirementV1 — the pre-flight check reads the same requirement the refusal reads", () => {
  const FOLDER = vscode.Uri.file("/tasks/stage-prereq-task");
  const files = new Map<string, string>();

  const workspace = vscode.workspace as unknown as {
    fs: {
      readFile: (uri: vscode.Uri) => Promise<Uint8Array>;
      stat: (uri: vscode.Uri) => Promise<vscode.FileStat>;
    };
  };
  let originalReadFile: typeof workspace.fs.readFile;
  let originalStat: typeof workspace.fs.stat;

  function setFile(name: string, content: string | undefined): void {
    const key = vscode.Uri.joinPath(FOLDER, name).fsPath;
    if (content === undefined) {
      files.delete(key);
    } else {
      files.set(key, content);
    }
  }

  before(() => {
    originalReadFile = workspace.fs.readFile;
    originalStat = workspace.fs.stat;
    workspace.fs.readFile = (uri: vscode.Uri): Promise<Uint8Array> => {
      const content = files.get(uri.fsPath);
      if (content === undefined) {
        return Promise.reject(new Error(`ENOENT: ${uri.fsPath}`));
      }
      return Promise.resolve(new TextEncoder().encode(content));
    };
    workspace.fs.stat = (uri: vscode.Uri): Promise<vscode.FileStat> => {
      if (!files.has(uri.fsPath)) {
        return Promise.reject(new Error(`ENOENT: ${uri.fsPath}`));
      }
      return Promise.resolve({ type: 1, ctime: 0, mtime: 0, size: 1 } as vscode.FileStat);
    };
  });

  after(() => {
    workspace.fs.readFile = originalReadFile;
    workspace.fs.stat = originalStat;
  });

  afterEach(() => {
    files.clear();
  });

  void it("reviewPlan: reports the plan requirement missing when plan.md is absent, matching the refusal text exactly", async () => {
    const unmet = await firstUnmetStageActionRequirementV1("reviewPlan", FOLDER);
    assert.ok(unmet, "plan.md absent -> a requirement is unmet");
    assert.equal(unmet.missingMessage, stageActionRequirementMessageV1("reviewPlan", 0));
  });

  void it("reviewPlan: reports nothing missing once plan.md has non-empty content", async () => {
    setFile("plan.md", "# Plan\n\nDo the thing.");
    const unmet = await firstUnmetStageActionRequirementV1("reviewPlan", FOLDER);
    assert.equal(unmet, undefined);
  });

  void it("reviewImplementation: the plan requirement is checked before the implementation-notes requirement (declared order)", async () => {
    // Neither plan.md nor impl-summary.md/plan-final.md exist — the FIRST
    // declared requirement (plan) must be the one reported, not the second.
    const unmet = await firstUnmetStageActionRequirementV1("reviewImplementation", FOLDER);
    assert.ok(unmet);
    assert.equal(unmet.missingMessage, stageActionRequirementMessageV1("reviewImplementation", 0));
  });

  void it("reviewImplementation: once plan.md exists, the unmet requirement moves on to implementation notes", async () => {
    setFile("plan.md", "# Plan\n\nDo the thing.");
    const unmet = await firstUnmetStageActionRequirementV1("reviewImplementation", FOLDER);
    assert.ok(unmet);
    assert.equal(unmet.missingMessage, stageActionRequirementMessageV1("reviewImplementation", 1));
  });

  void it("reviewImplementation: satisfied once both plan.md and impl-summary.md exist", async () => {
    setFile("plan.md", "# Plan\n\nDo the thing.");
    setFile("impl-summary.md", "Implemented the thing.");
    const unmet = await firstUnmetStageActionRequirementV1("reviewImplementation", FOLDER);
    assert.equal(unmet, undefined);
  });

  void it("runImplementation: reports the implementation-artifact requirement missing when neither plan-final.md nor implementation.md exist", async () => {
    const unmet = await firstUnmetStageActionRequirementV1("runImplementation", FOLDER);
    assert.ok(unmet);
    assert.equal(unmet.missingMessage, stageActionRequirementMessageV1("runImplementation", 0));
  });

  void it("runImplementation: satisfied by the legacy implementation.md fallback alone", async () => {
    setFile("implementation.md", "Legacy checklist content.");
    const unmet = await firstUnmetStageActionRequirementV1("runImplementation", FOLDER);
    assert.equal(unmet, undefined);
  });

  void it("applyReviewPlan and applyReviewImplementation check different artifacts, so satisfying one does not satisfy the other", async () => {
    // Only plan.md exists: applyReviewPlan (needs plan.md) is satisfied,
    // applyReviewImplementation (needs plan-final.md, not plan.md) is not.
    setFile("plan.md", "# Plan\n\nDo the thing.");
    assert.equal(await firstUnmetStageActionRequirementV1("applyReviewPlan", FOLDER), undefined);
    const unmetApplyImpl = await firstUnmetStageActionRequirementV1("applyReviewImplementation", FOLDER);
    assert.ok(unmetApplyImpl);
    assert.equal(unmetApplyImpl.missingMessage, stageActionRequirementMessageV1("applyReviewImplementation", 0));
  });
});

void describe("firstUnmetStagePrerequisiteV1 — the combined pre-flight check the task-tree tooltip uses per stage", () => {
  const FOLDER = vscode.Uri.file("/tasks/stage-prereq-combined-task");
  const files = new Map<string, string>();

  const workspace = vscode.workspace as unknown as {
    fs: {
      readFile: (uri: vscode.Uri) => Promise<Uint8Array>;
      stat: (uri: vscode.Uri) => Promise<vscode.FileStat>;
    };
  };
  let originalReadFile: typeof workspace.fs.readFile;
  let originalStat: typeof workspace.fs.stat;

  function setFile(name: string, content: string | undefined): void {
    const key = vscode.Uri.joinPath(FOLDER, name).fsPath;
    if (content === undefined) {
      files.delete(key);
    } else {
      files.set(key, content);
    }
  }

  before(() => {
    originalReadFile = workspace.fs.readFile;
    originalStat = workspace.fs.stat;
    workspace.fs.readFile = (uri: vscode.Uri): Promise<Uint8Array> => {
      const content = files.get(uri.fsPath);
      if (content === undefined) {
        return Promise.reject(new Error(`ENOENT: ${uri.fsPath}`));
      }
      return Promise.resolve(new TextEncoder().encode(content));
    };
    workspace.fs.stat = (uri: vscode.Uri): Promise<vscode.FileStat> => {
      if (!files.has(uri.fsPath)) {
        return Promise.reject(new Error(`ENOENT: ${uri.fsPath}`));
      }
      return Promise.resolve({ type: 1, ctime: 0, mtime: 0, size: 1 } as vscode.FileStat);
    };
  });

  after(() => {
    workspace.fs.readFile = originalReadFile;
    workspace.fs.stat = originalStat;
  });

  afterEach(() => {
    files.clear();
  });

  void it("impl stage: surfaces the Run Implementation requirement before the attempt — this was the gap the review flagged", async () => {
    const unmet = await firstUnmetStagePrerequisiteV1("impl", FOLDER);
    assert.ok(unmet, "plan-final.md/implementation.md absent -> Run Implementation's requirement is unmet");
    assert.equal(unmet.missingMessage, stageActionRequirementMessageV1("runImplementation", 0));
  });

  void it("impl stage: satisfied once plan-final.md exists", async () => {
    setFile("plan-final.md", "## Implementation Checklist\n- [ ] Step 1");
    const unmet = await firstUnmetStagePrerequisiteV1("impl", FOLDER);
    assert.equal(unmet, undefined);
  });

  void it("plan-high-review: reports the Review requirement (plan.md) before ever considering Apply", async () => {
    const unmet = await firstUnmetStagePrerequisiteV1("plan-high-review", FOLDER);
    assert.ok(unmet);
    assert.equal(unmet.missingMessage, stageActionRequirementMessageV1("reviewPlan", 0));
  });

  void it("impl-high-review: once Review's own requirements are satisfied, surfaces the Apply action's distinct requirement (plan-final.md) instead of reporting nothing missing", async () => {
    // Review needs plan.md + (impl-summary.md OR plan-final.md OR implementation.md).
    // Apply Review Edit needs plan-final.md specifically. Seed only impl-summary.md
    // so Review is satisfied but Apply is not — this is exactly the case the old
    // single-action tooltip could not see.
    setFile("plan.md", "# Plan\n\nDo the thing.");
    setFile("impl-summary.md", "Implemented the thing.");
    const unmet = await firstUnmetStagePrerequisiteV1("impl-high-review", FOLDER);
    assert.ok(unmet, "Apply Review Edit's plan-final.md requirement must surface even though Review is satisfied");
    assert.equal(unmet.missingMessage, stageActionRequirementMessageV1("applyReviewImplementation", 0));
  });

  void it("impl-high-review: reports nothing missing once both Review and Apply requirements are satisfied", async () => {
    setFile("plan.md", "# Plan\n\nDo the thing.");
    setFile("plan-final.md", "## Implementation Checklist\n- [x] Step 1");
    const unmet = await firstUnmetStagePrerequisiteV1("impl-high-review", FOLDER);
    assert.equal(unmet, undefined);
  });

  void it("desc/plan stages: never gated, always reports nothing missing", async () => {
    assert.equal(await firstUnmetStagePrerequisiteV1("desc", FOLDER), undefined);
    assert.equal(await firstUnmetStagePrerequisiteV1("plan", FOLDER), undefined);
  });
});
