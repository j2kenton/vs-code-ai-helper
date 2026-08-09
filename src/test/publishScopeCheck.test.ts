/**
 * Coverage for the report-only Publish Scope Check: which files a task
 * actually changed (its tracked `implReviewFiles`) its plan never mentions.
 * Never a gate — `PublishScopeCheckResult` has no `passed` field, and these
 * tests do not assert one exists.
 */
import * as assert from "node:assert/strict";
import * as cp from "node:child_process";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { after, describe, it } from "node:test";
import * as vscode from "vscode";

import {
  computePublishScopeCheck,
  computeScopeCheckDiff,
  extractPlanMentionedPaths,
  mergeScopeCheckSection,
  PublishScopeCheckResult,
  upsertScopeCheckInPublishReview,
} from "../utils/publishScopeCheck";

const TEST_ROOT = nodeFs.mkdtempSync(
  nodePath.join(nodeOs.tmpdir(), "ensemble-publish-scope-check-test-")
);
after(() => {
  nodeFs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

function makeDir(name: string): string {
  const dir = nodePath.join(TEST_ROOT, name);
  nodeFs.mkdirSync(dir, { recursive: true });
  return dir;
}

function git(cwd: string, args: string[]): void {
  cp.execFileSync("git", args, { cwd, stdio: "ignore", windowsHide: true });
}

function makeGitRepo(name: string): string {
  const dir = makeDir(name);
  git(dir, ["init"]);
  nodeFs.writeFileSync(nodePath.join(dir, "task.md"), "task\n");
  git(dir, ["add", "."]);
  git(dir, ["-c", "user.email=test@example.invalid", "-c", "user.name=Test", "commit", "-m", "initial"]);
  return dir;
}

// ---------------------------------------------------------------------------
// extractPlanMentionedPaths
// ---------------------------------------------------------------------------

void describe("extractPlanMentionedPaths", () => {
  void it("extracts backticked paths", () => {
    const paths = extractPlanMentionedPaths("Edit `src/utils/foo.ts` and `package.json`.");
    assert.deepEqual(paths, ["package.json", "src/utils/foo.ts"]);
  });

  void it("extracts markdown link targets, ignoring external URLs", () => {
    const paths = extractPlanMentionedPaths(
      "See [the util](src/utils/bar.ts) and [docs](https://example.com/readme.md)."
    );
    assert.deepEqual(paths, ["src/utils/bar.ts"]);
  });

  void it("extracts bare src/...-style strings", () => {
    const paths = extractPlanMentionedPaths("Update src/commands/runPublishChecks.ts directly.");
    assert.deepEqual(paths, ["src/commands/runPublishChecks.ts"]);
  });

  void it("normalizes backslashes and a leading ./", () => {
    const paths = extractPlanMentionedPaths("Touch `./src/a.ts` and `src\\b.ts`.");
    assert.deepEqual(paths, ["src/a.ts", "src/b.ts"]);
  });

  void it("does not treat ordinary prose as paths (false positives)", () => {
    const paths = extractPlanMentionedPaths(
      "Fix the pass/fail and/or before/after cases. Call `resolveRunnerForModel` " +
        "e.g. once, i.e. cleanly. Version 1.2.3 is unrelated."
    );
    assert.deepEqual(paths, []);
  });

  void it("scans the whole document, not just a Files Changed heading", () => {
    const paths = extractPlanMentionedPaths(
      "## What I found and did\n\nI also touched `src/late/mention.ts` down here.\n"
    );
    assert.deepEqual(paths, ["src/late/mention.ts"]);
  });

  void it("dedupes and sorts", () => {
    const paths = extractPlanMentionedPaths("`src/b.ts` and again `src/b.ts` and `src/a.ts`.");
    assert.deepEqual(paths, ["src/a.ts", "src/b.ts"]);
  });
});

// ---------------------------------------------------------------------------
// computeScopeCheckDiff
// ---------------------------------------------------------------------------

void describe("computeScopeCheckDiff", () => {
  void it("reports changed files the plan doesn't mention", () => {
    const result = computeScopeCheckDiff(
      ["src/a.ts", "src/b.ts"],
      ["src/a.ts"]
    );
    assert.deepEqual(result.unplannedFiles, ["src/b.ts"]);
    assert.deepEqual(result.ensembleArtifacts, []);
  });

  void it("treats a plan-mentioned suffix path as a match", () => {
    const result = computeScopeCheckDiff(
      ["src/utils/foo.ts"],
      ["utils/foo.ts"]
    );
    assert.deepEqual(result.unplannedFiles, []);
  });

  void it("excludes .ensemble/ task-artifact paths from unplannedFiles and reports them separately", () => {
    const result = computeScopeCheckDiff(
      ["src/a.ts", ".ensemble/2026-08-09_task_1/plan.md"],
      []
    );
    assert.deepEqual(result.unplannedFiles, ["src/a.ts"]);
    assert.deepEqual(result.ensembleArtifacts, [".ensemble/2026-08-09_task_1/plan.md"]);
  });

  void it("returns nothing unplanned when every changed file is mentioned", () => {
    const result = computeScopeCheckDiff(["src/a.ts"], ["src/a.ts"]);
    assert.deepEqual(result.unplannedFiles, []);
  });

  void it("normalizes backslashes in changed file paths", () => {
    const result = computeScopeCheckDiff(["src\\a.ts"], []);
    assert.deepEqual(result.unplannedFiles, ["src/a.ts"]);
  });
});

// ---------------------------------------------------------------------------
// computePublishScopeCheck — basis availability
// ---------------------------------------------------------------------------

void describe("computePublishScopeCheck", () => {
  void it("reports basisUnavailable when implReviewFiles is undefined, even with git available", async () => {
    const dir = makeGitRepo("basis-unavailable-no-files");
    const result = await computePublishScopeCheck(vscode.Uri.file(dir), {});
    assert.equal(result.basisUnavailable, true);
    assert.deepEqual(result.unplannedFiles, []);
  });

  void it("reports basisUnavailable when git is unavailable", async () => {
    const dir = makeDir("basis-unavailable-no-git");
    const result: PublishScopeCheckResult = await computePublishScopeCheck(vscode.Uri.file(dir), {
      implReviewFiles: ["a.ts"],
    });
    assert.equal(result.basisUnavailable, true);
  });

  void it("treats an explicitly empty implReviewFiles as a real (not unavailable) basis", async () => {
    const dir = makeGitRepo("basis-available-empty-files");
    const result = await computePublishScopeCheck(vscode.Uri.file(dir), { implReviewFiles: [] });
    assert.equal(result.basisUnavailable, false);
    assert.deepEqual(result.unplannedFiles, []);
  });

  void it("flags a changed file the plan document doesn't mention", async () => {
    const dir = makeGitRepo("finds-unplanned-file");
    nodeFs.writeFileSync(
      nodePath.join(dir, "plan-final.md"),
      "## Files Changed\n\n- `src/a.ts` — updated.\n"
    );
    const result = await computePublishScopeCheck(vscode.Uri.file(dir), {
      implReviewFiles: ["src/a.ts", "src/unexpected.ts"],
    });
    assert.equal(result.basisUnavailable, false);
    assert.deepEqual(result.unplannedFiles, ["src/unexpected.ts"]);
  });
});

// ---------------------------------------------------------------------------
// mergeScopeCheckSection
// ---------------------------------------------------------------------------

void describe("mergeScopeCheckSection", () => {
  void it("writes just the section when the file was empty", () => {
    const merged = mergeScopeCheckSection(
      "",
      "<!-- scope-check:start -->\nsection\n<!-- scope-check:end -->"
    );
    assert.equal(merged, "<!-- scope-check:start -->\nsection\n<!-- scope-check:end -->\n");
  });

  void it("appends the section when the file has no managed section yet", () => {
    const merged = mergeScopeCheckSection(
      "# Publish Review\n\nAI-authored readiness notes.\n",
      "<!-- scope-check:start -->\nnew\n<!-- scope-check:end -->"
    );
    assert.match(merged, /AI-authored readiness notes\./);
    assert.match(merged, /new/);
  });

  void it("replaces a previous managed section in place, preserving surrounding content", () => {
    const existing =
      "# Publish Review\n\nAI notes above.\n\n" +
      "<!-- scope-check:start -->\nold section\n<!-- scope-check:end -->\n\n" +
      "AI notes below.\n";
    const merged = mergeScopeCheckSection(
      existing,
      "<!-- scope-check:start -->\nnew section\n<!-- scope-check:end -->"
    );
    assert.match(merged, /AI notes above\./);
    assert.match(merged, /AI notes below\./);
    assert.match(merged, /new section/);
    assert.doesNotMatch(merged, /old section/);
  });

  void it("preserves a separate Completion Checks section untouched", () => {
    const existing =
      "<!-- completion-checks:start -->\ncompletion section\n<!-- completion-checks:end -->\n\n" +
      "<!-- scope-check:start -->\nold scope section\n<!-- scope-check:end -->\n";
    const merged = mergeScopeCheckSection(
      existing,
      "<!-- scope-check:start -->\nnew scope section\n<!-- scope-check:end -->"
    );
    assert.match(merged, /completion section/);
    assert.match(merged, /new scope section/);
    assert.doesNotMatch(merged, /old scope section/);
  });
});

// ---------------------------------------------------------------------------
// upsertScopeCheckInPublishReview
// ---------------------------------------------------------------------------

void describe("upsertScopeCheckInPublishReview", () => {
  void it("creates publish-review.md with a Scope Check section when it doesn't exist", async () => {
    const dir = makeDir("upsert-create");
    await upsertScopeCheckInPublishReview(vscode.Uri.file(dir), {
      unplannedFiles: ["src/unexpected.ts"],
      ensembleArtifacts: [],
      basisUnavailable: false,
    });

    const content = nodeFs.readFileSync(nodePath.join(dir, "publish-review.md"), "utf8");
    assert.match(content, /## Scope Check/);
    assert.match(content, /Files the plan doesn't mention/);
    assert.match(content, /src\/unexpected\.ts/);
  });

  void it("renders the no-basis statement instead of an empty ok-looking result", async () => {
    const dir = makeDir("upsert-no-basis");
    await upsertScopeCheckInPublishReview(vscode.Uri.file(dir), {
      unplannedFiles: [],
      ensembleArtifacts: [],
      basisUnavailable: true,
    });

    const content = nodeFs.readFileSync(nodePath.join(dir, "publish-review.md"), "utf8");
    assert.match(content, /No basis for this check/);
    assert.doesNotMatch(content, /No files the plan doesn't mention/);
  });

  void it("preserves pre-existing AI review content and updates only the managed section on rerun", async () => {
    const dir = makeDir("upsert-preserve");
    nodeFs.writeFileSync(
      nodePath.join(dir, "publish-review.md"),
      "Readiness: 8/10\n\nSummary verdict: ready to publish.\n",
      "utf8"
    );

    await upsertScopeCheckInPublishReview(vscode.Uri.file(dir), {
      unplannedFiles: ["src/first.ts"],
      ensembleArtifacts: [],
      basisUnavailable: false,
    });
    await upsertScopeCheckInPublishReview(vscode.Uri.file(dir), {
      unplannedFiles: [],
      ensembleArtifacts: [],
      basisUnavailable: false,
    });

    const content = nodeFs.readFileSync(nodePath.join(dir, "publish-review.md"), "utf8");
    assert.match(content, /Readiness: 8\/10/);
    assert.doesNotMatch(content, /src\/first\.ts/);
    assert.match(content, /No files the plan doesn't mention\./);
  });

  void it("keeps a separate Completion Checks section intact", async () => {
    const dir = makeDir("upsert-alongside-completion-checks");
    nodeFs.writeFileSync(
      nodePath.join(dir, "publish-review.md"),
      "<!-- completion-checks:start -->\n## Completion Checks\n\n- Status: Passed\n<!-- completion-checks:end -->\n",
      "utf8"
    );

    await upsertScopeCheckInPublishReview(vscode.Uri.file(dir), {
      unplannedFiles: ["src/unexpected.ts"],
      ensembleArtifacts: [".ensemble/2026-08-09_task_1/plan.md"],
      basisUnavailable: false,
    });

    const content = nodeFs.readFileSync(nodePath.join(dir, "publish-review.md"), "utf8");
    assert.match(content, /## Completion Checks/);
    assert.match(content, /Status: Passed/);
    assert.match(content, /## Scope Check/);
    assert.match(content, /src\/unexpected\.ts/);
    assert.match(content, /1 `\.ensemble\/` task-artifact file\(s\)/);
  });
});
