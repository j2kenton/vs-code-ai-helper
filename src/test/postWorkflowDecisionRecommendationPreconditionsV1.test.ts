/**
 * Integration coverage for `postWorkflowDecisionV1`'s use of
 * `recommendationPreconditionsV1` (task "stage chat as a record of work"
 * item 14 / Part 12 step 34): a decision option whose effect is known to
 * refuse on a paused task is disabled before the record is ever persisted,
 * and a recommendation that pointed at it is downgraded to an explicit "no
 * recommendation" — never posted as a recommendation the user cannot act on.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import * as vscode from "vscode";

import { WorkflowDecisionStoreV1 } from "../state/workflowDecisionStoreV1";
import { postWorkflowDecisionV1 } from "../utils/workflowDecisionDispatchV1";
import { __extensionContextV1TestOnly } from "../utils/extensionContextV1";
import { CreateWorkflowDecisionInputV1 } from "../types/workflowDecisionV1";
import { TASK_PROGRESS_FILENAME } from "../types/taskProgress";
import { makeOwnedTaskFolder } from "./taskFolderFixture";

function makeExtensionContext(): vscode.ExtensionContext {
  const backing = new Map<string, unknown>();
  const memento = {
    keys: (): readonly string[] => [...backing.keys()],
    get: <T>(key: string, defaultValue?: T): T | undefined =>
      backing.has(key) ? (backing.get(key) as T) : defaultValue,
    update: (key: string, value: unknown): Thenable<void> => {
      if (value === undefined) { backing.delete(key); } else { backing.set(key, value); }
      return Promise.resolve();
    },
  };
  return {
    subscriptions: [] as vscode.Disposable[],
    extensionUri: vscode.Uri.file("/tasks"),
    workspaceState: memento,
    globalState: memento,
  } as unknown as vscode.ExtensionContext;
}

/** Same shape as other command tests' `installRealFs` helper — the stub's
 * default `workspace.fs.readFile` throws "not implemented", but
 * `postWorkflowDecisionV1` (via `readTaskProgressStrictV1`) genuinely reads
 * the fixture's on-disk `task-progress.json` through it. */
function installRealFs(): { restore: () => void } {
  const stubFs = vscode.workspace.fs as unknown as Record<string, unknown>;
  const orig = { readFile: stubFs.readFile };
  stubFs.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    Promise.resolve(new Uint8Array(fs.readFileSync(uri.fsPath)));
  return {
    restore: (): void => {
      stubFs.readFile = orig.readFile;
    },
  };
}

function setStatus(folder: string, status: "active" | "paused"): void {
  const progressPath = path.join(folder, TASK_PROGRESS_FILENAME);
  const progress = JSON.parse(fs.readFileSync(progressPath, "utf8")) as Record<string, unknown>;
  progress.status = status;
  fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2));
}

function setReviewInvalidatedByRound(folder: string, stage: string): void {
  const progressPath = path.join(folder, TASK_PROGRESS_FILENAME);
  const progress = JSON.parse(fs.readFileSync(progressPath, "utf8")) as Record<string, unknown>;
  progress.reviewInvalidatedByRound = { stage, at: new Date().toISOString() };
  fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2));
}

function setImplRecovery(folder: string): void {
  const progressPath = path.join(folder, TASK_PROGRESS_FILENAME);
  const progress = JSON.parse(fs.readFileSync(progressPath, "utf8")) as Record<string, unknown>;
  progress.implRecovery = {
    sourceAttemptId: "attempt-1",
    reason: "the round ended without a usable report",
    trigger: "summaryRejected",
    mode: "inspect-and-complete",
    dispatch: "pending",
    at: new Date().toISOString(),
  };
  fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2));
}

function stageArgDecisionInput(taskFolderPath: string, reviewStage: string): CreateWorkflowDecisionInputV1 {
  return {
    decisionId: "goToReviewDecisionStageArg",
    decisionKey: "exampleReviewRoutingStageArg",
    taskCanonicalId: taskFolderPath,
    stage: "impl",
    whatHappened: "The newest review still reports task-fixable blockers.",
    whyUserNeeded: "Implementation cannot see the blockers; Apply Review can.",
    options: [
      {
        optionId: "goToReviewAndApply",
        label: "Go to Review & Apply",
        consequence: "Moves the task to review and runs Apply Review.",
        effect: {
          kind: "command",
          command: "vs-code-ai-helper.resumeIfPausedThenGoToReviewAndApply",
          args: [{ taskFolderPath, reviewStage }],
        },
      },
      {
        optionId: "doNothing",
        label: "Do nothing",
        consequence: "Leaves the task exactly as it is.",
        effect: { kind: "doNothing" },
      },
    ],
    recommendation: {
      kind: "option",
      optionId: "goToReviewAndApply",
      reasoning: "Apply Review is the only action that can fix what the review still reports.",
    },
    gating: { holdsTaskPaused: false, unblocksProgress: true, detail: "Moves the task toward review." },
    createdAt: new Date().toISOString(),
  };
}

function decisionInput(taskFolderPath: string): CreateWorkflowDecisionInputV1 {
  return {
    decisionId: "goToReviewDecision",
    decisionKey: "exampleReviewRouting",
    taskCanonicalId: taskFolderPath,
    stage: "impl",
    whatHappened: "The newest review still reports task-fixable blockers.",
    whyUserNeeded: "Implementation cannot see the blockers; Apply Review can.",
    options: [
      {
        optionId: "goToReviewAndApply",
        label: "Go to Review & Apply",
        consequence: "Moves the task to review and runs Apply Review.",
        effect: { kind: "command", command: "vs-code-ai-helper.goToReviewAndApply" },
      },
      {
        optionId: "doNothing",
        label: "Do nothing",
        consequence: "Leaves the task exactly as it is.",
        effect: { kind: "doNothing" },
      },
    ],
    recommendation: {
      kind: "option",
      optionId: "goToReviewAndApply",
      reasoning: "Apply Review is the only action that can fix what the review still reports.",
    },
    gating: { holdsTaskPaused: false, unblocksProgress: true, detail: "Moves the task toward review." },
    createdAt: new Date().toISOString(),
  };
}

let contextActive = false;
afterEach(() => {
  if (contextActive) {
    __extensionContextV1TestOnly.reset();
    contextActive = false;
  }
});

void describe("postWorkflowDecisionV1 — recommendationPreconditionsV1 integration", () => {
  void it("disables a pause-sensitive option and downgrades the recommendation on a paused task", async () => {
    const fixture = makeOwnedTaskFolder("recPrecond-paused-");
    setStatus(fixture.folder, "paused");
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    contextActive = true;
    const realFs = installRealFs();

    let posted;
    try {
      posted = await postWorkflowDecisionV1(decisionInput(fixture.folder), {
        taskFolderPath: fixture.folder,
        canonicalId: fixture.folder,
        stage: "impl",
      });
    } finally {
      realFs.restore();
    }

    assert.ok(posted);
    const goToReview = posted.options.find((o) => o.optionId === "goToReviewAndApply");
    assert.equal(goToReview?.disabled, true);
    assert.match(goToReview?.disabledReason ?? "", /resume the task first/);
    assert.equal(posted.recommendation.kind, "none");

    const store = new WorkflowDecisionStoreV1(context.workspaceState);
    const persisted = store.get(posted.decisionId);
    assert.equal(persisted?.options.find((o) => o.optionId === "goToReviewAndApply")?.disabled, true);
    assert.equal(persisted?.recommendation.kind, "none");
  });

  void it("leaves the option enabled and the recommendation intact on an active task", async () => {
    const fixture = makeOwnedTaskFolder("recPrecond-active-");
    setStatus(fixture.folder, "active");
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    contextActive = true;
    const realFs = installRealFs();

    let posted;
    try {
      posted = await postWorkflowDecisionV1(decisionInput(fixture.folder), {
        taskFolderPath: fixture.folder,
        canonicalId: fixture.folder,
        stage: "impl",
      });
    } finally {
      realFs.restore();
    }

    assert.ok(posted);
    const goToReview = posted.options.find((o) => o.optionId === "goToReviewAndApply");
    assert.equal(goToReview?.disabled, undefined);
    assert.equal(posted.recommendation.kind, "option");
    if (posted.recommendation.kind === "option") {
      assert.equal(posted.recommendation.optionId, "goToReviewAndApply");
    }
  });

  // Review-invalidation axis (review blocker 2026-08-31, extending Part 12
  // step 34): the same resume-safe wrapper the paused-status axis never
  // blocks IS blocked here, because nothing "does the whole thing" for a
  // stale review — the review genuinely must be regenerated first.
  void it("disables the resume-safe apply-review option when its target stage's review is invalidated", async () => {
    const fixture = makeOwnedTaskFolder("recPrecond-invalidated-");
    setStatus(fixture.folder, "active");
    setReviewInvalidatedByRound(fixture.folder, "impl-high-review");
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    contextActive = true;
    const realFs = installRealFs();

    let posted;
    try {
      posted = await postWorkflowDecisionV1(
        stageArgDecisionInput(fixture.folder, "impl-high-review"),
        { taskFolderPath: fixture.folder, canonicalId: fixture.folder, stage: "impl" }
      );
    } finally {
      realFs.restore();
    }

    assert.ok(posted);
    const goToReview = posted.options.find((o) => o.optionId === "goToReviewAndApply");
    assert.equal(goToReview?.disabled, true);
    assert.match(goToReview?.disabledReason ?? "", /run the review again/);
    assert.equal(posted.recommendation.kind, "none");
  });

  void it("leaves the resume-safe apply-review option enabled when a DIFFERENT stage's review is invalidated", async () => {
    const fixture = makeOwnedTaskFolder("recPrecond-invalidated-other-");
    setStatus(fixture.folder, "active");
    setReviewInvalidatedByRound(fixture.folder, "impl-low-review");
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    contextActive = true;
    const realFs = installRealFs();

    let posted;
    try {
      posted = await postWorkflowDecisionV1(
        stageArgDecisionInput(fixture.folder, "impl-high-review"),
        { taskFolderPath: fixture.folder, canonicalId: fixture.folder, stage: "impl" }
      );
    } finally {
      realFs.restore();
    }

    assert.ok(posted);
    const goToReview = posted.options.find((o) => o.optionId === "goToReviewAndApply");
    assert.equal(goToReview?.disabled, undefined);
    assert.equal(posted.recommendation.kind, "option");
  });

  // Continuation-owed axis (review blocker 2026-08-31, round 2 — Part 12
  // step 34 names this as its own precondition, distinct from
  // review-invalidation).
  void it("disables the resume-safe apply-review option when a continuation is owed", async () => {
    const fixture = makeOwnedTaskFolder("recPrecond-continuationOwed-");
    setStatus(fixture.folder, "active");
    setImplRecovery(fixture.folder);
    const context = makeExtensionContext();
    __extensionContextV1TestOnly.set(context);
    contextActive = true;
    const realFs = installRealFs();

    let posted;
    try {
      posted = await postWorkflowDecisionV1(
        stageArgDecisionInput(fixture.folder, "impl-high-review"),
        { taskFolderPath: fixture.folder, canonicalId: fixture.folder, stage: "impl" }
      );
    } finally {
      realFs.restore();
    }

    assert.ok(posted);
    const goToReview = posted.options.find((o) => o.optionId === "goToReviewAndApply");
    assert.equal(goToReview?.disabled, true);
    assert.match(goToReview?.disabledReason ?? "", /continuation from an earlier round/);
    assert.equal(posted.recommendation.kind, "none");
  });
});
