import * as assert from "node:assert/strict";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import * as vscode from "vscode";
import { buildStageResponsePrompt } from "../commands/chatWithStage";
import {
  changedStageResponsePathsSince,
  normalizeStageResponseChangedFiles,
  partitionScopedFiles,
  resolveStageResponseScope,
  resolveStageResponseScopePath,
  revertOutOfScopeFiles,
  snapshotDirtyPaths,
  snapshotStageResponseState,
} from "../utils/stageResponseScope";

function git(cwd: string, args: string[]): void {
  cp.execFileSync("git", args, { cwd, stdio: "ignore", windowsHide: true });
}

function makeGitFixture(): { repoRoot: string; workspaceRoot: string; taskRoot: string } {
  const repoRoot = fs.mkdtempSync(path.join(process.cwd(), ".ensemble-stage-scope-"));
  const workspaceRoot = path.join(repoRoot, "workspace");
  const taskRoot = path.join(workspaceRoot, "plans", "2026-07-13_task_2");
  fs.mkdirSync(taskRoot, { recursive: true });
  fs.writeFileSync(path.join(taskRoot, "plan.md"), "initial\n");
  git(repoRoot, ["init"]);
  git(repoRoot, ["add", "."]);
  git(repoRoot, [
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "user.name=Test",
    "commit",
    "-m",
    "initial",
  ]);
  return { repoRoot, workspaceRoot, taskRoot };
}

void test("stage response prompt forbids tool calls and code edits, but permits scoped markdown updates", () => {
  const prompt = buildStageResponsePrompt(
    "Plan",
    "task-42",
    "plans/2026-07-13_task_2/plan.md",
    "# Context\nImportant repository details",
    "What should I change?"
  );

  assert.match(prompt, /Plan stage/);
  assert.match(prompt, /task-42/);
  assert.match(prompt, /Do not invoke tools/);
  assert.match(prompt, /use the stage action that applies it explicitly/);
  // C4 boundary: markdown files inside the task's own folder may be updated
  // directly via the UPDATE_FILE envelope, but this must never be framed as
  // general tool access or code editing.
  assert.match(prompt, /UPDATE_FILE/);
  assert.match(prompt, /never target a source code file/);
  assert.match(prompt, /Important repository details/);
  assert.match(prompt, /What should I change\?/);
});

void test("resolveStageResponseScopePath maps each stage to its one workspace-relative artifact", () => {
  const workspaceUri = vscode.Uri.file("/repo");
  const taskFolderUri = vscode.Uri.file("/repo/plans/2026-07-13_task_2");

  assert.equal(
    resolveStageResponseScopePath(workspaceUri, taskFolderUri, "desc"),
    "plans/2026-07-13_task_2/task.md"
  );
  assert.equal(
    resolveStageResponseScopePath(workspaceUri, taskFolderUri, "plan"),
    "plans/2026-07-13_task_2/plan.md"
  );
  assert.equal(
    resolveStageResponseScopePath(workspaceUri, taskFolderUri, "impl"),
    "plans/2026-07-13_task_2/plan-final.md"
  );
  assert.equal(
    resolveStageResponseScopePath(workspaceUri, taskFolderUri, "publish"),
    "plans/2026-07-13_task_2/publish-review.md"
  );
});

void test("partitionScopedFiles keeps only the allowed artifact and buckets everything else as out of scope", () => {
  const allowed = "plans/2026-07-13_task_2/task.md";

  assert.deepEqual(
    partitionScopedFiles(
      [allowed, "src/other.ts", "plans/2026-07-13_task_2/plan.md"],
      allowed
    ),
    { kept: [allowed], outOfScope: ["src/other.ts", "plans/2026-07-13_task_2/plan.md"] }
  );

  assert.deepEqual(partitionScopedFiles([], allowed), { kept: [], outOfScope: [] });

  assert.deepEqual(partitionScopedFiles(["src/other.ts"], allowed), {
    kept: [],
    outOfScope: ["src/other.ts"],
  });
});

void test("stage response scope compares nested-workspace paths in git-root coordinates", async () => {
  const { repoRoot, workspaceRoot, taskRoot } = makeGitFixture();
  try {
    const scope = await resolveStageResponseScope(
      vscode.Uri.file(workspaceRoot),
      vscode.Uri.file(taskRoot),
      "plan"
    );

    assert.equal(scope.artifactWorkspacePath, "plans/2026-07-13_task_2/plan.md");
    assert.equal(scope.artifactScopePath, "workspace/plans/2026-07-13_task_2/plan.md");

    const changed = normalizeStageResponseChangedFiles(
      ["plans/2026-07-13_task_2/plan.md", "src/other.ts"],
      scope,
      "copilot-lm"
    );
    assert.deepEqual(changed, [
      "workspace/plans/2026-07-13_task_2/plan.md",
      "workspace/src/other.ts",
    ]);

    assert.deepEqual(partitionScopedFiles(changed, scope.artifactScopePath), {
      kept: ["workspace/plans/2026-07-13_task_2/plan.md"],
      outOfScope: ["workspace/src/other.ts"],
    });
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

void test("stage response dirty snapshot protects individual untracked files", async () => {
  const { repoRoot, workspaceRoot, taskRoot } = makeGitFixture();
  try {
    const notesDir = path.join(workspaceRoot, "notes");
    fs.mkdirSync(notesDir, { recursive: true });
    fs.writeFileSync(path.join(notesDir, "draft.md"), "do not delete\n");

    const scope = await resolveStageResponseScope(
      vscode.Uri.file(workspaceRoot),
      vscode.Uri.file(taskRoot),
      "plan"
    );
    const dirty = await snapshotDirtyPaths(scope);

    assert.ok(dirty?.has("workspace/notes/draft.md"));
    assert.equal(dirty?.has("workspace/notes/"), false);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

void test("stage response dirty snapshot lines up with nested Copilot paths", async () => {
  const { repoRoot, workspaceRoot, taskRoot } = makeGitFixture();
  try {
    const srcDir = path.join(workspaceRoot, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, "other.ts"), "tracked\n");
    git(repoRoot, ["add", "."]);
    git(repoRoot, [
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "user.name=Test",
      "commit",
      "-m",
      "add other",
    ]);
    fs.writeFileSync(path.join(srcDir, "other.ts"), "user edit\n");

    const scope = await resolveStageResponseScope(
      vscode.Uri.file(workspaceRoot),
      vscode.Uri.file(taskRoot),
      "plan"
    );
    const dirty = await snapshotDirtyPaths(scope);
    const changed = normalizeStageResponseChangedFiles(
      ["src/other.ts"],
      scope,
      "copilot-lm"
    );

    assert.deepEqual(changed, ["workspace/src/other.ts"]);
    assert.ok(dirty?.has(changed[0]!));
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

void test("stage response state diff catches out-of-scope edits hidden by fallback results", async () => {
  const { repoRoot, workspaceRoot, taskRoot } = makeGitFixture();
  try {
    const srcDir = path.join(workspaceRoot, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, "outside.ts"), "initial\n");
    git(repoRoot, ["add", "."]);
    git(repoRoot, [
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "user.name=Test",
      "commit",
      "-m",
      "add outside file",
    ]);

    const scope = await resolveStageResponseScope(
      vscode.Uri.file(workspaceRoot),
      vscode.Uri.file(taskRoot),
      "plan"
    );
    const before = await snapshotStageResponseState(scope);
    assert.ok(before);

    fs.writeFileSync(path.join(taskRoot, "plan.md"), "fallback edit\n");
    fs.writeFileSync(path.join(srcDir, "outside.ts"), "primary stray edit\n");

    const after = await snapshotStageResponseState(scope);
    assert.ok(after);
    assert.deepEqual(changedStageResponsePathsSince(before, after), [
      "workspace/plans/2026-07-13_task_2/plan.md",
      "workspace/src/outside.ts",
    ]);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

void test("stage response cleanup removes out-of-scope untracked directories", async () => {
  const { repoRoot, workspaceRoot, taskRoot } = makeGitFixture();
  try {
    const scope = await resolveStageResponseScope(
      vscode.Uri.file(workspaceRoot),
      vscode.Uri.file(taskRoot),
      "plan"
    );
    const outDir = path.join(workspaceRoot, "generated");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "extra.md"), "out of scope\n");

    const result = await revertOutOfScopeFiles(scope, ["workspace/generated/"]);

    assert.deepEqual(result, {
      restored: [],
      deleted: ["workspace/generated/"],
      failed: [],
    });
    assert.equal(fs.existsSync(outDir), false);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
