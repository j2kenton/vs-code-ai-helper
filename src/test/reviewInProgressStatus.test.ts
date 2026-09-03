/**
 * Coverage for Part 2 (review status messaging) of the provider-discard/
 * review-status/AI-rename/task-refresh plan: a review marked stale shows
 * "Review in progress" instead of a categorical "run it again" message while
 * a rerun of that SAME review stage is genuinely in flight, and reverts to
 * the stale message on any non-success exit.
 *
 *  - reviewReadiness.ts's markReviewInProgressBannerV1 (pure, line-only
 *    banner transform that preserves the review body).
 *  - reviewActions.ts's isReviewActivelyRerunningV1 (the translated
 *    active-run signal, via REVIEW_TARGETS — including a rerun launched
 *    from a PRE-review stage) and isInProgressReviewArtifact.
 *  - reviewActions.ts's beginInProgressReviewMarkingV1 /
 *    revertInProgressReviewMarkingV1 (the post-claim rewrite/revert
 *    lifecycle, including the reviewAttemptId run-token guard that stops a
 *    superseded attempt's revert from clobbering a newer one).
 *  - taskTreeProvider.ts's StageNode: the review row still renders as
 *    running when its taskOperations entry is registered under the
 *    PRE-review stage the rerun was launched from.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import * as vscode from "vscode";

import { markReviewInProgressBannerV1 } from "../utils/reviewReadiness";
import { refreshStaleReviewBannerForArtifactV1 } from "../utils/reviewFreshness";
import {
  isReviewActivelyRerunningV1,
  isInProgressReviewArtifact,
  isUnusableAsExistingReview,
  beginInProgressReviewMarkingV1,
  revertInProgressReviewMarkingV1,
  backupReviewUnlessStale,
} from "../commands/reviewActions";
import { taskOperations, TaskOperationHandle } from "../utils/taskOperations";
import { StageNode } from "../views/taskTreeProvider";
import { IncompleteTask } from "../types/incompleteTask";
import { TaskProgress } from "../types/taskProgress";

/** Ends every currently-registered operation — the registry is a shared
 * singleton, so tests that register operations must not leak them across
 * files/cases. Mirrors operationIndicators.test.ts's cleanup. */
function endAllOperations(): void {
  for (const op of taskOperations.getAll()) {
    const handle: TaskOperationHandle = {
      id: op.id,
      key: op.key,
      label: op.label,
      stage: op.stage,
      report: () => {},
      setWaitingForUser: () => {},
      setResultTargetUri: () => {},
      reportActivity: () => undefined,
    };
    taskOperations.end(handle);
  }
}

const IN_PROGRESS_BANNER_LINE =
  "> ⏳ Review in progress: re-evaluating this artifact against the current HEAD.";
const STALE_BANNER_LINE =
  "> ⚠ Stale: this review examined abc1234, which is no longer HEAD.";

void describe("markReviewInProgressBannerV1", () => {
  const bodyWithBanner = [
    "Readiness: 7/10",
    "",
    STALE_BANNER_LINE,
    "",
    "## Summary",
    "Some review body text that must survive untouched.",
    "",
  ].join("\n");

  void it("replaces only the stale banner line, preserving the rest of the body", () => {
    const out = markReviewInProgressBannerV1(bodyWithBanner);
    const lines = out.split("\n");
    assert.strictEqual(lines[2], IN_PROGRESS_BANNER_LINE);
    // Swapping the banner line back reproduces the input exactly — nothing
    // else moved or changed.
    const restored = [...lines];
    restored[2] = STALE_BANNER_LINE;
    assert.strictEqual(restored.join("\n"), bodyWithBanner);
  });

  void it("is a no-op when there is no stale banner line", () => {
    const plain = "Readiness: 9/10\n\nNo banner here.\n";
    assert.strictEqual(markReviewInProgressBannerV1(plain), plain);
  });

  void it("is a no-op for a # Review Stale placeholder — that surface is handled separately", () => {
    const placeholder =
      "# Review Stale\n\nThis review was generated before plan.md was updated.\n";
    assert.strictEqual(markReviewInProgressBannerV1(placeholder), placeholder);
  });

  void it("is idempotent", () => {
    const once = markReviewInProgressBannerV1(bodyWithBanner);
    assert.strictEqual(markReviewInProgressBannerV1(once), once);
  });
});

void describe("isInProgressReviewArtifact / isUnusableAsExistingReview", () => {
  const IN_PROGRESS_PLACEHOLDER =
    "# Review in progress\n\nThis review is being re-evaluated against the current artifact.\n";

  void it("recognizes the in-progress placeholder and rejects unrelated content", () => {
    assert.ok(isInProgressReviewArtifact(IN_PROGRESS_PLACEHOLDER));
    assert.ok(
      !isInProgressReviewArtifact(
        "# Review Stale\n\nThis review was generated before plan.md was updated.\n"
      )
    );
    assert.ok(!isInProgressReviewArtifact("Readiness: 9/10\n"));
  });

  void it("treats the in-progress placeholder as unusable, same as the stale one — Fast Forward must never read it as a scoreable baseline", () => {
    assert.ok(isUnusableAsExistingReview(IN_PROGRESS_PLACEHOLDER));
  });
});

void describe("isReviewActivelyRerunningV1", () => {
  beforeEach(endAllOperations);

  void it("is true for a review-kind op whose stage translates through REVIEW_TARGETS to the target review stage — including one launched from a PRE-review stage", () => {
    const op = taskOperations.begin("/dev/task_x", {
      label: "Review",
      stage: "plan",
      kind: "review",
    });
    assert.ok(op);
    try {
      assert.ok(isReviewActivelyRerunningV1("/dev/task_x", "plan-high-review"));
      assert.ok(!isReviewActivelyRerunningV1("/dev/task_x", "impl-high-review"));
    } finally {
      taskOperations.end(op);
    }
    // Ending the op clears the signal — it is display-time, never cached.
    assert.ok(!isReviewActivelyRerunningV1("/dev/task_x", "plan-high-review"));
  });

  void it("is true for a review-kind op already registered directly under the review stage", () => {
    const op = taskOperations.begin("/dev/task_y", {
      label: "Re-running review",
      stage: "impl-high-review",
      kind: "review",
    });
    assert.ok(op);
    try {
      assert.ok(isReviewActivelyRerunningV1("/dev/task_y", "impl-high-review"));
    } finally {
      taskOperations.end(op);
    }
  });

  void it("ignores a fast-forward-kind root registration — it proves nothing about an actual review dispatch being in flight", () => {
    const op = taskOperations.begin("/dev/task_z", {
      label: "Fast Forward Review",
      stage: "plan",
      kind: "fast-forward",
    });
    assert.ok(op);
    try {
      assert.ok(!isReviewActivelyRerunningV1("/dev/task_z", "plan-high-review"));
    } finally {
      taskOperations.end(op);
    }
  });
});

void describe("StageNode — review row running detection for a rerun launched from a pre-review stage", () => {
  beforeEach(endAllOperations);

  void it("renders the review row as running when its own op is registered under the pre-review 'plan' stage, not 'plan-high-review'", () => {
    const mockTask: IncompleteTask = {
      folderUri: vscode.Uri.file("/dev/task_prerun"),
      folderName: "task_prerun",
      progress: {
        taskFolder: "task_prerun",
        createdAt: new Date().toISOString(),
        currentStage: "plan-high-review",
        updatedAt: new Date().toISOString(),
        status: "active",
      },
      canonicalId: "/dev/task_prerun",
    };
    const op = taskOperations.begin("/dev/task_prerun", {
      label: "Review",
      stage: "plan",
      kind: "review",
    });
    assert.ok(op);
    try {
      const node = new StageNode(
        mockTask,
        "plan-high-review",
        "current",
        vscode.Uri.file("/dev/task_prerun/plan-high-review.md")
      );
      assert.strictEqual(
        node.iconPath instanceof vscode.ThemeIcon ? node.iconPath.id : "",
        "loading~spin"
      );
      assert.strictEqual(node.description, "running");
    } finally {
      taskOperations.end(op);
    }
  });

  void it("renders the review row as WAITING, not running, when its translated rerun op is paused on the user (a question or round-limit) — even though its own stage is a pre-review stage", () => {
    const mockTask: IncompleteTask = {
      folderUri: vscode.Uri.file("/dev/task_prerun_waiting"),
      folderName: "task_prerun_waiting",
      progress: {
        taskFolder: "task_prerun_waiting",
        createdAt: new Date().toISOString(),
        currentStage: "plan-high-review",
        updatedAt: new Date().toISOString(),
        status: "active",
      },
      canonicalId: "/dev/task_prerun_waiting",
    };
    const op = taskOperations.begin("/dev/task_prerun_waiting", {
      label: "Review",
      stage: "plan",
      kind: "review",
    });
    assert.ok(op);
    op?.setWaitingForUser(true);
    try {
      const node = new StageNode(
        mockTask,
        "plan-high-review",
        "current",
        vscode.Uri.file("/dev/task_prerun_waiting/plan-high-review.md")
      );
      // Must NOT read as the spinning "running" state — a spinner over a
      // paused-on-the-user op reads as "the computer is working, leave it
      // alone", exactly backwards.
      assert.notStrictEqual(
        node.iconPath instanceof vscode.ThemeIcon ? node.iconPath.id : "",
        "loading~spin"
      );
      assert.notStrictEqual(node.description, "running");
      assert.strictEqual(node.description, "waiting for you");
      assert.strictEqual(
        node.iconPath instanceof vscode.ThemeIcon ? node.iconPath.id : "",
        "comment-unresolved"
      );
    } finally {
      taskOperations.end(op);
    }
  });

  void it("shows 'Review in progress' in the tooltip (not the rerun instruction) when a stale review has an active translated rerun", () => {
    const mockTask: IncompleteTask = {
      folderUri: vscode.Uri.file("/dev/task_tooltip_running"),
      folderName: "task_tooltip_running",
      progress: {
        taskFolder: "task_tooltip_running",
        createdAt: new Date().toISOString(),
        currentStage: "impl-high-review",
        updatedAt: new Date().toISOString(),
        status: "active",
      },
      canonicalId: "/dev/task_tooltip_running",
    };
    // Rerun launched from the pre-review "impl" stage, per the reported
    // regression: the review IS active, but its op's own stage is not the
    // review stage.
    const op = taskOperations.begin("/dev/task_tooltip_running", {
      label: "Review",
      stage: "impl",
      kind: "review",
    });
    assert.ok(op);
    try {
      const node = new StageNode(
        mockTask,
        "impl-high-review",
        "current",
        vscode.Uri.file("/dev/task_tooltip_running/impl-high-review.md"),
        { label: "7/10", staleReviewedSha: "abc1234" }
      );
      const tooltip = (node.tooltip as vscode.MarkdownString).value;
      assert.ok(tooltip.includes("Review in progress"));
      assert.ok(!tooltip.includes("re-run Review with AI to assess the current state"));
    } finally {
      taskOperations.end(op);
    }
  });

  void it("still shows 'Review in progress' in the tooltip when the translated rerun is paused waiting on the user, not just while it's spinning", () => {
    const mockTask: IncompleteTask = {
      folderUri: vscode.Uri.file("/dev/task_tooltip_waiting"),
      folderName: "task_tooltip_waiting",
      progress: {
        taskFolder: "task_tooltip_waiting",
        createdAt: new Date().toISOString(),
        currentStage: "impl-high-review",
        updatedAt: new Date().toISOString(),
        status: "active",
      },
      canonicalId: "/dev/task_tooltip_waiting",
    };
    const op = taskOperations.begin("/dev/task_tooltip_waiting", {
      label: "Review",
      stage: "impl",
      kind: "review",
    });
    assert.ok(op);
    op?.setWaitingForUser(true);
    try {
      const node = new StageNode(
        mockTask,
        "impl-high-review",
        "current",
        vscode.Uri.file("/dev/task_tooltip_waiting/impl-high-review.md"),
        { label: "7/10", staleReviewedSha: "abc1234" }
      );
      const tooltip = (node.tooltip as vscode.MarkdownString).value;
      assert.ok(tooltip.includes("Review in progress"));
      assert.ok(!tooltip.includes("re-run Review with AI to assess the current state"));
    } finally {
      taskOperations.end(op);
    }
  });

  void it("still shows the categorical stale instruction in the tooltip when no rerun is active", () => {
    const mockTask: IncompleteTask = {
      folderUri: vscode.Uri.file("/dev/task_tooltip_idle"),
      folderName: "task_tooltip_idle",
      progress: {
        taskFolder: "task_tooltip_idle",
        createdAt: new Date().toISOString(),
        currentStage: "impl-high-review",
        updatedAt: new Date().toISOString(),
        status: "active",
      },
      canonicalId: "/dev/task_tooltip_idle",
    };
    const node = new StageNode(
      mockTask,
      "impl-high-review",
      "current",
      vscode.Uri.file("/dev/task_tooltip_idle/impl-high-review.md"),
      { label: "7/10", staleReviewedSha: "abc1234" }
    );
    const tooltip = (node.tooltip as vscode.MarkdownString).value;
    assert.ok(tooltip.includes("re-run Review with AI to assess the current state"));
    assert.ok(!tooltip.includes("Review in progress"));
  });
});

/** Shared real-tmp-dir fixture and fs stub for every describe block below
 * that needs to read/write actual files through the vscode.workspace.fs
 * surface (which the stub `vscode` module leaves unimplemented). */
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-review-inprogress-"));
after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

function installFsStub(): () => void {
  const fsRecord = vscode.workspace.fs as unknown as Record<string, unknown>;
  const originalRead = fsRecord.readFile;
  const originalWrite = fsRecord.writeFile;
  fsRecord.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    fs.promises.readFile(uri.fsPath) as Promise<Uint8Array>;
  fsRecord.writeFile = (uri: vscode.Uri, content: Uint8Array): Promise<void> =>
    fs.promises.writeFile(uri.fsPath, content).then(() => undefined);
  return (): void => {
    fsRecord.readFile = originalRead;
    fsRecord.writeFile = originalWrite;
  };
}

function makeTaskFolder(name: string): { folderUri: vscode.Uri; folderPath: string } {
  const folderPath = path.join(ROOT, name);
  fs.mkdirSync(folderPath, { recursive: true });
  return { folderUri: vscode.Uri.file(folderPath), folderPath };
}

/** Writes task-progress.json directly via real fs — read back through the
 * stub by readTaskProgressAdvisoryV1 inside revertInProgressReviewMarkingV1. */
function seedProgress(folderPath: string, overrides: Partial<TaskProgress>): void {
  const full: TaskProgress = {
    taskFolder: path.basename(folderPath),
    currentStage: "impl-high-review",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
  fs.writeFileSync(
    path.join(folderPath, "task-progress.json"),
    JSON.stringify(full, null, 2),
    "utf8"
  );
}

void describe("beginInProgressReviewMarkingV1 / revertInProgressReviewMarkingV1 (post-claim rewrite/revert)", () => {
  void it("rewrites a # Review Stale placeholder to # Review in progress, and reverts it verbatim when the attempt is still current", async () => {
    const { folderUri, folderPath } = makeTaskFolder("task_a");
    const reviewFile = path.join(folderPath, "impl-high-review.md");
    const staleText =
      "# Review Stale\n\nThis review was generated before plan-final.md was updated.\n\n" +
      "Run Review with AI again to evaluate the current artifact.\n";
    fs.writeFileSync(reviewFile, staleText, "utf8");
    seedProgress(folderPath, { reviewAttemptId: "attempt-1" });

    const restore = installFsStub();
    try {
      const reviewUri = vscode.Uri.file(reviewFile);
      const marking = await beginInProgressReviewMarkingV1(reviewUri);
      assert.ok(marking.rewrote);
      assert.strictEqual(marking.priorContent, staleText);
      const rewritten = fs.readFileSync(reviewFile, "utf8");
      assert.ok(rewritten.startsWith("# Review in progress"));
      assert.ok(!rewritten.includes("Run Review with AI again"));

      await revertInProgressReviewMarkingV1(folderUri, reviewUri, "attempt-1", marking);
      assert.strictEqual(fs.readFileSync(reviewFile, "utf8"), staleText);
    } finally {
      restore();
    }
  });

  void it("does NOT revert when a newer attempt has since claimed the review (run-token guard)", async () => {
    const { folderUri, folderPath } = makeTaskFolder("task_b");
    const reviewFile = path.join(folderPath, "impl-high-review.md");
    const staleText =
      "# Review Stale\n\nThis review was generated before plan-final.md was updated.\n";
    fs.writeFileSync(reviewFile, staleText, "utf8");
    seedProgress(folderPath, { reviewAttemptId: "attempt-old" });

    const restore = installFsStub();
    try {
      const reviewUri = vscode.Uri.file(reviewFile);
      const marking = await beginInProgressReviewMarkingV1(reviewUri);
      assert.ok(marking.rewrote);
      const inProgressText = fs.readFileSync(reviewFile, "utf8");
      assert.ok(inProgressText.startsWith("# Review in progress"));

      // A newer attempt claims the review before this (older, now-failing)
      // attempt's revert runs — e.g. the user reran Review again.
      seedProgress(folderPath, { reviewAttemptId: "attempt-new" });

      await revertInProgressReviewMarkingV1(folderUri, reviewUri, "attempt-old", marking);
      // The on-disk state must be untouched by the superseded attempt's revert.
      assert.strictEqual(fs.readFileSync(reviewFile, "utf8"), inProgressText);
    } finally {
      restore();
    }
  });

  void it("swaps only the stale banner line on a real review body, preserving the body, and reverts it verbatim", async () => {
    const { folderUri, folderPath } = makeTaskFolder("task_c");
    const reviewFile = path.join(folderPath, "impl-high-review.md");
    const bannerBody = [
      "Readiness: 6/10",
      "",
      STALE_BANNER_LINE,
      "",
      "## Summary",
      "The body text that must survive untouched.",
      "",
    ].join("\n");
    fs.writeFileSync(reviewFile, bannerBody, "utf8");
    seedProgress(folderPath, { reviewAttemptId: "attempt-1" });

    const restore = installFsStub();
    try {
      const reviewUri = vscode.Uri.file(reviewFile);
      const marking = await beginInProgressReviewMarkingV1(reviewUri);
      assert.ok(marking.rewrote);
      const rewritten = fs.readFileSync(reviewFile, "utf8");
      assert.ok(rewritten.includes(IN_PROGRESS_BANNER_LINE));
      assert.ok(rewritten.includes("The body text that must survive untouched."));
      assert.ok(!rewritten.includes("⚠ Stale"));

      await revertInProgressReviewMarkingV1(folderUri, reviewUri, "attempt-1", marking);
      assert.strictEqual(fs.readFileSync(reviewFile, "utf8"), bannerBody);
    } finally {
      restore();
    }
  });

  void it("is a no-op for a current review with no stale marker at all", async () => {
    const { folderPath } = makeTaskFolder("task_d");
    const reviewFile = path.join(folderPath, "impl-high-review.md");
    const current = "Readiness: 9/10\n\n## Summary\nAll good.\n";
    fs.writeFileSync(reviewFile, current, "utf8");
    seedProgress(folderPath, { reviewAttemptId: "attempt-1" });

    const restore = installFsStub();
    try {
      const marking = await beginInProgressReviewMarkingV1(vscode.Uri.file(reviewFile));
      assert.strictEqual(marking.rewrote, false);
      assert.strictEqual(fs.readFileSync(reviewFile, "utf8"), current);
    } finally {
      restore();
    }
  });
});

void describe("gated banner healing — reviewActions.ts's two freshness call sites (rerun start, viewReview) both guard refreshStaleReviewBannerForArtifactV1 behind `if (!isReviewActivelyRerunningV1(...))`", () => {
  beforeEach(endAllOperations);

  function bodyWithInProgressBanner(reviewedSha: string): string {
    return [
      "Readiness: 6/10",
      "",
      IN_PROGRESS_BANNER_LINE,
      "",
      "## Summary",
      "Body text that must survive untouched.",
      "",
      `<!-- reviewed-commit: ${reviewedSha} -->`,
      "",
    ].join("\n");
  }

  /** Reproduces the exact guard reviewActions.ts uses at reviewActions.ts:2831
   * and reviewActions.ts:4753 verbatim, against the real production
   * `isReviewActivelyRerunningV1` and `refreshStaleReviewBannerForArtifactV1` —
   * this is the composition under test, not a reimplementation of it. */
  async function guardedRefresh(
    taskPath: string,
    targetStage: Parameters<typeof isReviewActivelyRerunningV1>[1],
    reviewUri: vscode.Uri,
    headSha: string
  ): Promise<void> {
    if (!isReviewActivelyRerunningV1(taskPath, targetStage)) {
      await refreshStaleReviewBannerForArtifactV1(reviewUri, headSha);
    }
  }

  void it("leaves a leftover in-progress banner untouched while a translated rerun is active — must never recreate the stale complaint mid-run", async () => {
    const { folderPath } = makeTaskFolder("task_heal_active");
    const reviewFile = path.join(folderPath, "impl-high-review.md");
    const content = bodyWithInProgressBanner("abc1234");
    fs.writeFileSync(reviewFile, content, "utf8");

    // Rerun launched from the pre-review "impl" stage, same as the tree-row
    // test above — the translated signal must still gate this healing path.
    const op = taskOperations.begin(folderPath, {
      label: "Review",
      stage: "impl",
      kind: "review",
    });
    assert.ok(op);
    const restore = installFsStub();
    try {
      await guardedRefresh(folderPath, "impl-high-review", vscode.Uri.file(reviewFile), "def5678");
      assert.strictEqual(fs.readFileSync(reviewFile, "utf8"), content);
    } finally {
      restore();
      taskOperations.end(op);
    }
  });

  void it("heals a leftover in-progress banner back to the stale form once no active run remains, when the recorded commit is still behind HEAD", async () => {
    const { folderPath } = makeTaskFolder("task_heal_idle_stale");
    const reviewFile = path.join(folderPath, "impl-high-review.md");
    const content = bodyWithInProgressBanner("abc1234");
    fs.writeFileSync(reviewFile, content, "utf8");

    const restore = installFsStub();
    try {
      await guardedRefresh(folderPath, "impl-high-review", vscode.Uri.file(reviewFile), "def5678");
      const healed = fs.readFileSync(reviewFile, "utf8");
      assert.ok(healed.includes(STALE_BANNER_LINE));
      assert.ok(!healed.includes("⏳ Review in progress"));
      assert.ok(healed.includes("Body text that must survive untouched."));
    } finally {
      restore();
    }
  });

  void it("fully heals — removes the banner entirely — when the recorded commit matches HEAD again and no run is active", async () => {
    const { folderPath } = makeTaskFolder("task_heal_idle_current");
    const reviewFile = path.join(folderPath, "impl-high-review.md");
    const content = bodyWithInProgressBanner("abc1234");
    fs.writeFileSync(reviewFile, content, "utf8");

    const restore = installFsStub();
    try {
      await guardedRefresh(folderPath, "impl-high-review", vscode.Uri.file(reviewFile), "abc1234");
      const healed = fs.readFileSync(reviewFile, "utf8");
      assert.ok(!healed.includes("⏳ Review in progress"));
      assert.ok(!healed.includes("⚠ Stale"));
      assert.ok(healed.includes("Body text that must survive untouched."));
    } finally {
      restore();
    }
  });
});

void describe("backupReviewUnlessStale — excludes the in-progress placeholder from ever becoming a review's backup", () => {
  void it("does NOT back up an in-progress placeholder", async () => {
    const { folderPath } = makeTaskFolder("task_backup_inprogress");
    const reviewFile = path.join(folderPath, "impl-high-review.md");
    const inProgressText = [
      "# Review in progress",
      "",
      "This review is being re-evaluated against the current artifact.",
      "",
    ].join("\n");
    fs.writeFileSync(reviewFile, inProgressText, "utf8");
    const backupFile = path.join(folderPath, "impl-high-review_prev.md");

    const restore = installFsStub();
    try {
      await backupReviewUnlessStale(vscode.Uri.file(reviewFile));
      assert.ok(
        !fs.existsSync(backupFile),
        "the in-progress placeholder must never become the backup"
      );
    } finally {
      restore();
    }
  });

  void it("still backs up a real (non-placeholder) review — contrast case proving the guard is specific to the stale/in-progress placeholders, not a general no-op", async () => {
    const { folderPath } = makeTaskFolder("task_backup_real");
    const reviewFile = path.join(folderPath, "impl-high-review.md");
    const realReview = "Readiness: 8/10\n\n## Summary\nEverything looks good.\n";
    fs.writeFileSync(reviewFile, realReview, "utf8");
    const backupFile = path.join(folderPath, "impl-high-review_prev.md");

    const restore = installFsStub();
    try {
      await backupReviewUnlessStale(vscode.Uri.file(reviewFile));
      assert.ok(fs.existsSync(backupFile), "a real review must still be backed up");
      assert.strictEqual(fs.readFileSync(backupFile, "utf8"), realReview);
    } finally {
      restore();
    }
  });
});
