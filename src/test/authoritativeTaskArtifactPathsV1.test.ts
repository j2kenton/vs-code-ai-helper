import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import * as vscode from "vscode";
import { renderPromptTemplate } from "../utils/promptTemplates";
import {
  formatAuthoritativeTaskArtifactGuidanceV1,
  resolveAuthoritativeTaskArtifactPathsV1,
} from "../utils/implementationArtifactResolver";
import { buildReviewResumeVariablesV1 } from "../commands/reviewActions";
import { deactivateNotificationRouter, initNotificationRouter } from "../utils/notificationRouter";

class TestSurface {
  addEntry(): void {}
}

void describe("authoritative task artifact paths (Step 10 / finding 3)", () => {
  const workspace = vscode.workspace as unknown as {
    fs: { readFile: (uri: vscode.Uri) => Promise<Uint8Array> };
  };
  let originalReadFile: (uri: vscode.Uri) => Promise<Uint8Array>;

  before(() => {
    originalReadFile = workspace.fs.readFile;
    workspace.fs.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
      fs.promises.readFile(uri.fsPath);
  });

  after(() => {
    workspace.fs.readFile = originalReadFile;
  });

  const extensionUri = vscode.Uri.file(path.resolve(__dirname, "../.."));

  void describe("resolveAuthoritativeTaskArtifactPathsV1", () => {
    void it("derives authoritative paths for date-only-different task folders", () => {
      const folderUri1 = vscode.Uri.file("/workspace/vs-code-ai-helper/.ensemble/2026-10-21_task_1");
      const folderUri2 = vscode.Uri.file("/workspace/vs-code-ai-helper/.ensemble/2026-10-22_task_1");

      const paths1 = resolveAuthoritativeTaskArtifactPathsV1(folderUri1);
      const paths2 = resolveAuthoritativeTaskArtifactPathsV1(folderUri2);

      assert.strictEqual(paths1.taskFolderPath, "/workspace/vs-code-ai-helper/.ensemble/2026-10-21_task_1");
      assert.strictEqual(
        paths1.planFinalPath,
        "/workspace/vs-code-ai-helper/.ensemble/2026-10-21_task_1/plan-final.md"
      );
      assert.strictEqual(
        paths1.roundProgressPath,
        "/workspace/vs-code-ai-helper/.ensemble/2026-10-21_task_1/round-progress.md"
      );
      assert.strictEqual(
        paths1.implSummaryPath,
        "/workspace/vs-code-ai-helper/.ensemble/2026-10-21_task_1/impl-summary.md"
      );
      assert.strictEqual(
        paths1.legacyImplementationPath,
        "/workspace/vs-code-ai-helper/.ensemble/2026-10-21_task_1/implementation.md"
      );

      assert.strictEqual(paths2.taskFolderPath, "/workspace/vs-code-ai-helper/.ensemble/2026-10-22_task_1");
      assert.strictEqual(
        paths2.planFinalPath,
        "/workspace/vs-code-ai-helper/.ensemble/2026-10-22_task_1/plan-final.md"
      );
      assert.strictEqual(
        paths2.roundProgressPath,
        "/workspace/vs-code-ai-helper/.ensemble/2026-10-22_task_1/round-progress.md"
      );
      assert.strictEqual(
        paths2.implSummaryPath,
        "/workspace/vs-code-ai-helper/.ensemble/2026-10-22_task_1/impl-summary.md"
      );
      assert.strictEqual(
        paths2.legacyImplementationPath,
        "/workspace/vs-code-ai-helper/.ensemble/2026-10-22_task_1/implementation.md"
      );

      // Verify they do not collide or share task files
      assert.notStrictEqual(paths1.taskFolderPath, paths2.taskFolderPath);
      assert.notStrictEqual(paths1.planFinalPath, paths2.planFinalPath);
      assert.notStrictEqual(paths1.roundProgressPath, paths2.roundProgressPath);
      assert.notStrictEqual(paths1.implSummaryPath, paths2.implSummaryPath);
    });

    void it("derives authoritative paths for an external metadata root", () => {
      const externalUri = vscode.Uri.file("/var/data/custom-ensemble-root/external_task_99");
      const paths = resolveAuthoritativeTaskArtifactPathsV1(externalUri);

      assert.strictEqual(paths.taskFolderPath, "/var/data/custom-ensemble-root/external_task_99");
      assert.strictEqual(
        paths.planFinalPath,
        "/var/data/custom-ensemble-root/external_task_99/plan-final.md"
      );
      assert.strictEqual(
        paths.roundProgressPath,
        "/var/data/custom-ensemble-root/external_task_99/round-progress.md"
      );
      assert.strictEqual(
        paths.implSummaryPath,
        "/var/data/custom-ensemble-root/external_task_99/impl-summary.md"
      );
    });

    void it("resolves plan.md for plan stages and plan-final.md for implementation stages", () => {
      const folderUri = vscode.Uri.file("/workspace/vs-code-ai-helper/.ensemble/2026-10-22_task_1");
      const planPaths = resolveAuthoritativeTaskArtifactPathsV1(folderUri, "plan");
      const implPaths = resolveAuthoritativeTaskArtifactPathsV1(folderUri, "impl");

      assert.strictEqual(
        planPaths.planFinalPath,
        "/workspace/vs-code-ai-helper/.ensemble/2026-10-22_task_1/plan.md"
      );
      assert.strictEqual(
        planPaths.planPath,
        "/workspace/vs-code-ai-helper/.ensemble/2026-10-22_task_1/plan.md"
      );

      assert.strictEqual(
        implPaths.planFinalPath,
        "/workspace/vs-code-ai-helper/.ensemble/2026-10-22_task_1/plan-final.md"
      );
      assert.strictEqual(
        implPaths.planPath,
        "/workspace/vs-code-ai-helper/.ensemble/2026-10-22_task_1/plan.md"
      );
    });
  });

  void describe("formatAuthoritativeTaskArtifactGuidanceV1", () => {
    void it("distinguishes files read, files written, and summaries returned for persistence", () => {
      const folderUri = vscode.Uri.file("/workspace/project/.ensemble/2026-10-21_task_1");
      const paths = resolveAuthoritativeTaskArtifactPathsV1(folderUri);
      const guidance = formatAuthoritativeTaskArtifactGuidanceV1(paths);

      // Plan of record: read-only
      assert.ok(guidance.includes(`Plan of record (read-only): ${paths.planFinalPath}`));
      // In-round progress: bookkeeping write
      assert.ok(
        guidance.includes(`In-round progress (in-round bookkeeping write): ${paths.roundProgressPath}`)
      );
      // Implementation summary: returned as response text, persisted by Ensemble
      assert.ok(
        guidance.includes(
          `Implementation summary: do NOT write directly to disk; return markdown summary as plain response text, which Ensemble persists to ${paths.implSummaryPath}`
        )
      );
      // Root reservation warning
      assert.ok(
        guidance.includes("Do not create or edit plan-final.md or implementation.md at the repository root.")
      );
    });
  });

  void describe("prompt template rendering with authoritative variables", () => {
    const olderFolderUri = vscode.Uri.file("/workspace/vs-code-ai-helper/.ensemble/2026-10-21_task_1");
    const newerFolderUri = vscode.Uri.file("/workspace/vs-code-ai-helper/.ensemble/2026-10-22_task_1");
    const paths1 = resolveAuthoritativeTaskArtifactPathsV1(olderFolderUri);
    const paths2 = resolveAuthoritativeTaskArtifactPathsV1(newerFolderUri);

    void it("renders run-implementation.md with authoritative paths that cannot be overridden by foreign links", async () => {
      // Prior summary in task 1 erroneously links to task 2's folder
      const misleadingContextPack = [
        "## Prior summary",
        `[round-progress.md](${paths2.roundProgressPath})`,
        `[plan-final.md](${paths2.planFinalPath})`,
      ].join("\n");

      const rendered1 = await renderPromptTemplate(extensionUri, "run-implementation.md", {
        contextPack: misleadingContextPack,
        plan: "Step 1: do work",
        taskFolderPath: paths1.taskFolderPath,
        planFinalPath: paths1.planFinalPath,
        roundProgressPath: paths1.roundProgressPath,
        implSummaryPath: paths1.implSummaryPath,
      });

      // The authoritative instructions MUST use paths1
      assert.ok(
        rendered1.includes(`\`round-progress.md\` in the task folder (${paths1.roundProgressPath})`),
        `Prompt does not contain authoritative roundProgressPath: ${rendered1.slice(0, 500)}`
      );
      assert.ok(
        rendered1.includes(`The authoritative on-disk plan of record is at ${paths1.planFinalPath}`),
        "Prompt does not contain authoritative planFinalPath"
      );
      assert.ok(
        rendered1.includes(`Ensemble persists your returned summary to ${paths1.implSummaryPath}`),
        "Prompt does not contain authoritative implSummaryPath"
      );
      // Ensure no raw unexpanded placeholder remains
      assert.ok(!rendered1.includes("{{roundProgressPath}}"));
      assert.ok(!rendered1.includes("{{planFinalPath}}"));
      assert.ok(!rendered1.includes("{{implSummaryPath}}"));
    });

    void it("renders apply-impl-review-code.md with authoritative paths", async () => {
      const rendered2 = await renderPromptTemplate(extensionUri, "apply-impl-review-code.md", {
        contextPack: "ctx",
        approvedPlan: "approved plan content",
        implementation: "notes",
        review: "review content",
        taskFolderPath: paths2.taskFolderPath,
        planFinalPath: paths2.planFinalPath,
        roundProgressPath: paths2.roundProgressPath,
        implSummaryPath: paths2.implSummaryPath,
      });

      assert.ok(
        rendered2.includes(`\`round-progress.md\` in the task folder (${paths2.roundProgressPath})`),
        "Prompt does not contain authoritative roundProgressPath"
      );
      assert.ok(
        rendered2.includes(`The authoritative on-disk plan of record is at ${paths2.planFinalPath}`),
        "Prompt does not contain authoritative planFinalPath"
      );
      assert.ok(
        rendered2.includes(`Ensemble persists your returned summary to ${paths2.implSummaryPath}`),
        "Prompt does not contain authoritative implSummaryPath"
      );
      assert.ok(!rendered2.includes("{{roundProgressPath}}"));
      assert.ok(!rendered2.includes("{{planFinalPath}}"));
      assert.ok(!rendered2.includes("{{implSummaryPath}}"));
    });

    void it("renders review templates with authoritative on-disk plan path via rubric", async () => {
      const reviewTemplates = [
        "review-impl-high.md",
        "review-impl-low.md",
        "review-plan-high.md",
        "review-plan-low.md",
        "review-publish.md",
      ];

      for (const template of reviewTemplates) {
        const rendered = await renderPromptTemplate(extensionUri, template, {
          contextPack: "ctx",
          plan: "plan content",
          implementation: "impl content",
          review: "review content",
          planFinalPath: paths1.planFinalPath,
        });

        assert.ok(
          rendered.includes(
            `The authoritative on-disk plan of record to inspect for this task is at \`${paths1.planFinalPath}\``
          ),
          `${template} did not render authoritative planFinalPath in rubric`
        );
        assert.ok(
          rendered.includes(
            "Do not follow links in prior summaries, citations, or prompt context pointing to other task folders."
          ),
          `${template} did not render instruction forbidding foreign task links`
        );
        assert.ok(
          !rendered.includes("{{planFinalPath}}"),
          `${template} left {{planFinalPath}} unexpanded`
        );
      }
    });

    void it("renders apply-review.md with authoritative plan path pointing to plan.md and formatted guidance", async () => {
      const planPaths = resolveAuthoritativeTaskArtifactPathsV1(olderFolderUri, "plan");
      const guidance = formatAuthoritativeTaskArtifactGuidanceV1(planPaths, "plan");
      const rendered = await renderPromptTemplate(extensionUri, "apply-review.md", {
        contextPack: "ctx",
        plan: "current plan text",
        review: "review text",
        planFinalPath: planPaths.planFinalPath,
        taskArtifactGuidance: guidance,
      });

      assert.ok(
        rendered.includes(`replaces the current plan file at ${planPaths.planFinalPath} in place`),
        "Prompt does not contain authoritative plan path for replacement"
      );
      assert.ok(
        rendered.includes(`Plan (plan.md): ${planPaths.planFinalPath}`),
        "Prompt does not contain formatted guidance for plan stage"
      );
      assert.ok(!rendered.includes("{{planFinalPath}}"), "Unexpanded planFinalPath in apply-review.md");
      assert.ok(!rendered.includes("{{taskArtifactGuidance}}"), "Unexpanded taskArtifactGuidance in apply-review.md");
    });

    void it("renders create-implementation.md with authoritative plan-final.md and formatted guidance", async () => {
      const implPaths = resolveAuthoritativeTaskArtifactPathsV1(newerFolderUri, "impl");
      const guidance = formatAuthoritativeTaskArtifactGuidanceV1(implPaths, "impl");
      const rendered = await renderPromptTemplate(extensionUri, "create-implementation.md", {
        contextPack: "ctx",
        plan: "final plan text",
        planFinalPath: implPaths.planFinalPath,
        taskArtifactGuidance: guidance,
      });

      assert.ok(
        rendered.includes(`authoritative plan-of-record file at ${implPaths.planFinalPath} in place`),
        "Prompt does not contain authoritative plan-final path"
      );
      assert.ok(
        rendered.includes(`Plan of record (read-only): ${implPaths.planFinalPath}`),
        "Prompt does not contain formatted guidance for implementation stage"
      );
      assert.ok(!rendered.includes("{{planFinalPath}}"), "Unexpanded planFinalPath in create-implementation.md");
      assert.ok(!rendered.includes("{{taskArtifactGuidance}}"), "Unexpanded taskArtifactGuidance in create-implementation.md");
    });
  });

  void describe("buildReviewResumeVariablesV1", () => {
    let tmpDir: string;

    before(() => {
      initNotificationRouter(new TestSurface());
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-resume-vars-"));
    });

    after(() => {
      deactivateNotificationRouter();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    void it("resolves plan.md for plan review stages and plan-final.md for implementation review stages", async () => {
      const taskFolder = path.join(tmpDir, "task_1");
      fs.mkdirSync(taskFolder, { recursive: true });
      fs.writeFileSync(path.join(taskFolder, "plan.md"), "# Plan\nSome plan content", "utf8");
      fs.writeFileSync(path.join(taskFolder, "plan-final.md"), "# Final Plan\nSome checklist content", "utf8");
      fs.writeFileSync(path.join(taskFolder, "impl-summary.md"), "# Implementation Summary\nBuilt features", "utf8");
      fs.writeFileSync(path.join(taskFolder, "reviewed.ts"), "export const reviewed = true;\n", "utf8");
      fs.writeFileSync(
        path.join(taskFolder, "task-progress.json"),
        JSON.stringify({
          taskFolder: "task_1",
          displayName: "Task 1",
          currentStage: "plan-high-review",
          status: "active",
          implReviewFiles: ["reviewed.ts"],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
        "utf8"
      );

      const planReviewResult = await buildReviewResumeVariablesV1(
        vscode.Uri.file(taskFolder),
        vscode.Uri.file(tmpDir),
        "plan-high-review",
        undefined
      );
      assert.ok(planReviewResult.ok, "buildReviewResumeVariablesV1 should succeed for plan-high-review");
      if (planReviewResult.ok) {
        assert.strictEqual(
          planReviewResult.variables.planFinalPath,
          path.join(taskFolder, "plan.md"),
          "plan-high-review should resolve planFinalPath to plan.md"
        );
      }

      const implReviewResult = await buildReviewResumeVariablesV1(
        vscode.Uri.file(taskFolder),
        vscode.Uri.file(tmpDir),
        "impl-high-review",
        undefined
      );
      assert.ok(implReviewResult.ok, "buildReviewResumeVariablesV1 should succeed for impl-high-review");
      if (implReviewResult.ok) {
        assert.strictEqual(
          implReviewResult.variables.planFinalPath,
          path.join(taskFolder, "plan-final.md"),
          "impl-high-review should resolve planFinalPath to plan-final.md"
        );
      }
    });
  });
});
