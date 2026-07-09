import * as vscode from "vscode";
import * as path from "path";
import { spawn } from "child_process";
import { TaskInventory } from "../state/taskInventory";
import { resolveTaskContext } from "../utils/resolveTaskContext";
import { TASK_FILENAME, STAGE_DISPLAY_NAMES } from "../types/taskProgress";
import { resolveImplementationArtifact } from "../utils/implementationArtifactResolver";
import { getLowLevelPlanUri } from "../utils/lowLevelPlanArtifactResolver";
import { IncompleteTask, patchTaskProgress, updateLintPayload } from "../utils/taskProgressUtils";
import { CurrentTaskStore } from "../utils/currentTaskStore";
import { advanceStage } from "../utils/stageTransition";
import { selectNextTask } from "./markTaskDone";

/**
 * Accepted argument shapes for commitAndPushTask.
 * - Tree-view task node passes { task: IncompleteTask }
 * - Resolver-aware callers pass { canonicalId?, taskFolderPath? }
 */
type CommitAndPushTaskArg =
  | { task?: IncompleteTask }
  | { canonicalId?: string; taskFolderPath?: string };

/**
 * Normalize a command argument into the shape resolveTaskContext expects.
 */
function normalizeArg(node: CommitAndPushTaskArg | undefined): {
  canonicalId?: string;
  taskFolderPath?: string;
} | undefined {
  if (!node) {
    return undefined;
  }

  if ("task" in node && node.task) {
    return { taskFolderPath: node.task.folderUri.fsPath };
  }

  const n = node as { canonicalId?: string; taskFolderPath?: string };
  const hasExplicit = !!(n.canonicalId || n.taskFolderPath);
  return hasExplicit
    ? { canonicalId: n.canonicalId, taskFolderPath: n.taskFolderPath }
    : undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Lazily-created singleton output channel used for the full file-list debug
 * surface in the commit-and-push flow. Cleared before each use.
 *
 * Name is pinned: "Ensemble: Commit Preview"
 */
let commitPreviewChannel: vscode.OutputChannel | undefined;
function getCommitPreviewChannel(): vscode.OutputChannel {
  if (!commitPreviewChannel) {
    commitPreviewChannel = vscode.window.createOutputChannel(
      "Ensemble: Commit Preview"
    );
  }
  return commitPreviewChannel;
}

/**
 * Render a repo-relative path for display in modal dialogs and the output
 * channel. Uses JSON string-escaping so quotes, backslashes, tabs, and
 * newlines render losslessly and reversibly.
 *
 * e.g.  src/foo.ts  →  src/foo.ts
 *       a "b".ts    →  "a \"b\".ts"
 */
function renderPath(repoRelativePath: string): string {
  // JSON.stringify adds surrounding quotes and escapes special chars.
  // We only want the escaping, not the outer quotes, unless there are
  // characters that need escaping.
  const json = JSON.stringify(repoRelativePath);
  // If the path contains any character that JSON needed to escape,
  // keep the quoted form; otherwise return the bare path.
  if (json === `"${repoRelativePath}"`) {
    return repoRelativePath;
  }
  return json;
}

/**
 * Check if a file path is inside a folder.
 * Uses proper path boundary checking to avoid false positives.
 * Case normalization is applied on Windows only for drive-letter compatibility.
 */
function isFileInFolder(filePath: string, folderPath: string): boolean {
  // Normalize separators first
  const normalizedFilePath = filePath.replace(/\\/g, "/");
  const normalizedFolderPath = folderPath.replace(/\\/g, "/");

  // Apply case normalization on Windows only
  const isCaseSensitive = process.platform !== "win32";
  const compareFilePath = isCaseSensitive
    ? normalizedFilePath
    : normalizedFilePath.toLowerCase();
  const compareFolderPath = isCaseSensitive
    ? normalizedFolderPath
    : normalizedFolderPath.toLowerCase();

  // Ensure folder path ends with separator for boundary-safe comparison
  const folderPathWithSeparator = compareFolderPath.endsWith("/")
    ? compareFolderPath
    : compareFolderPath + "/";

  return compareFilePath.startsWith(folderPathWithSeparator) ||
         compareFilePath === compareFolderPath;
}

/**
 * Run a git command with safe argument passing (no shell interpolation).
 */
async function runGitCommand(
  cwd: string,
  command: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const gitProcess = spawn("git", [command, ...args], { cwd, shell: false });

    let stdout = "";
    let stderr = "";

    gitProcess.stdout?.on("data", (data: Buffer | string) => {
      stdout += typeof data === "string" ? data : data.toString("utf8");
    });

    gitProcess.stderr?.on("data", (data: Buffer | string) => {
      stderr += typeof data === "string" ? data : data.toString("utf8");
    });

    gitProcess.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(new Error("Git is not installed or not on PATH"));
      } else {
        reject(error);
      }
    });

    gitProcess.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`git ${command} failed with code ${code}\n${stderr}`));
      }
    });
  });
}

/**
 * Resolve the git repository root for a given path.
 */
async function resolveGitRepo(
  folderPath: string
): Promise<string | undefined> {
  try {
    const { stdout } = await runGitCommand(folderPath, "rev-parse", [
      "--show-toplevel",
    ]);
    return stdout.trim();
  } catch {
    return undefined;
  }
}

/**
 * Check if there are any changes to commit (optionally scoped to a folder).
 */
async function hasChangesToCommit(
  repoRoot: string,
  scopePath?: string
): Promise<boolean> {
  try {
    const args = ["--porcelain"];
    if (scopePath) {
      args.push("--", scopePath);
    }
    const { stdout } = await runGitCommand(repoRoot, "status", args);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Parse git status --porcelain=v1 -z --untracked-files=all output.
 * Returns an array of { status, path } records.
 *
 * The -z format uses NUL as a field/record separator.
 * For rename/copy entries (R/C), the format is:
 *   "XY old-path\0new-path\0"
 * For all other entries:
 *   "XY path\0"
 *
 * This parser handles both forms defensively.
 */
function parsePortcelainZ(output: string): Array<{ status: string; path: string }> {
  const results: Array<{ status: string; path: string }> = [];
  const entries = output.split("\0");

  let i = 0;
  while (i < entries.length) {
    const entry = entries[i]!;
    i++;

    if (entry.length < 3) {
      continue;
    }

    const status = entry.substring(0, 2);
    const filePath = entry.substring(3);

    if (filePath.length === 0) {
      continue;
    }

    // Rename/copy entries: "XY old-path" followed by "new-path" as next NUL-delimited token
    if (status[0] === "R" || status[0] === "C" || status[1] === "R" || status[1] === "C") {
      results.push({ status, path: filePath }); // old path
      if (i < entries.length && entries[i] && entries[i]!.length > 0) {
        results.push({ status, path: entries[i]! }); // new path
        i++;
      }
    } else {
      results.push({ status, path: filePath });
    }
  }

  return results.filter((r) => r.path.length > 0);
}

/**
 * Get the list of changed files scoped to the task folder (default mode)
 * or the entire repo (include-all mode).
 *
 * Returns two arrays:
 *  - scopedFiles: files to be staged and shown in the preview
 *  - repoFiles:   all changed files in the repo (for include-all mode display)
 */
async function getChangedFiles(
  repoRoot: string,
  taskFolderPath: string,
  includeAll: boolean
): Promise<{
  scopedFiles: string[];
  repoFiles: string[];
  runArtifactPaths: string[];
}> {
  try {
    const { stdout } = await runGitCommand(repoRoot, "status", [
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);

    const allEntries = parsePortcelainZ(stdout);

    // Compute the task folder relative to the repo root
    const taskRelative = path
      .relative(repoRoot, taskFolderPath)
      .replace(/\\/g, "/");

    // Identify run-artifact paths (runs/ and context-pack.md under the task folder)
    const runArtifactPaths: string[] = [];
    const scopedFiles: string[] = [];
    const repoFiles: string[] = [];

    for (const entry of allEntries) {
      repoFiles.push(entry.path);

      // Determine if this file is inside the task folder
      const isInTaskFolder =
        entry.path === taskRelative ||
        entry.path.startsWith(taskRelative + "/");

      if (!includeAll && !isInTaskFolder) {
        continue;
      }

      // Check for run artifacts (runs/ directory and context-pack.md)
      const isRunArtifact =
        entry.path.startsWith(taskRelative + "/runs/") ||
        entry.path === taskRelative + "/context-pack.md" ||
        entry.path === taskRelative + "/pr-description.md";

      if (isRunArtifact) {
        runArtifactPaths.push(entry.path);
        if (!includeAll) {
          // In default mode, run artifacts are excluded from the staged set
          continue;
        }
      }

      scopedFiles.push(entry.path);
    }

    return {
      scopedFiles: scopedFiles.filter((f) => f.length > 0),
      repoFiles: repoFiles.filter((f) => f.length > 0),
      runArtifactPaths,
    };
  } catch {
    return { scopedFiles: [], repoFiles: [], runArtifactPaths: [] };
  }
}

/**
 * Extract first H1 from markdown content
 */
function extractFirstH1(content: string): string | undefined {
  const match = /^# (.+)$/m.exec(content);
  return match?.[1]?.trim();
}

/**
 * Extract first non-empty paragraph from a section
 */
function extractFirstParagraph(content: string): string | undefined {
  const lines = content.split(/\r?\n/);
  let paragraph = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0 && !trimmed.startsWith("#")) {
      paragraph += (paragraph ? " " : "") + trimmed;
    } else if (paragraph.length > 0) {
      break;
    }
  }
  return paragraph.length > 0 ? paragraph : undefined;
}

/**
 * Extract section body from markdown content
 */
function extractSectionBody(
  content: string,
  sectionHeader: string
): string | undefined {
  const headerIndex = content.indexOf(sectionHeader);
  if (headerIndex === -1) {
    return undefined;
  }

  const afterHeader = content.slice(headerIndex + sectionHeader.length);
  const nextHeaderMatch = /^## /m.exec(afterHeader);
  const sectionEnd = nextHeaderMatch
    ? headerIndex + sectionHeader.length + nextHeaderMatch.index
    : content.length;

  return content
    .slice(headerIndex + sectionHeader.length, sectionEnd)
    .trim();
}

/**
 * Generate PR description from task artifacts
 */
async function generatePRDescription(
  taskFolderPath: string,
  folderName: string,
  changedFiles: string[]
): Promise<string> {
  const taskFileUri = vscode.Uri.file(path.join(taskFolderPath, TASK_FILENAME));
  const taskFolderUri = vscode.Uri.file(taskFolderPath);
  const implementationArtifact = await resolveImplementationArtifact(
    taskFolderUri
  );
  const lowLevelPlanUri = getLowLevelPlanUri(taskFolderUri);

  // Read task.md
  let taskTitle = folderName;
  let summary = "No summary provided.";
  try {
    const taskBytes = await vscode.workspace.fs.readFile(taskFileUri);
    const taskContent = new TextDecoder().decode(taskBytes);
    taskTitle = extractFirstH1(taskContent) ?? folderName;

    const taskDescBody =
      extractSectionBody(taskContent, "## Task Description");
    if (taskDescBody) {
      summary = extractFirstParagraph(taskDescBody) ?? summary;
    } else {
      const draftBody = extractSectionBody(taskContent, "## Draft with AI");
      if (draftBody) {
        summary = extractFirstParagraph(draftBody) ?? summary;
      }
    }
  } catch {
    // ignore
  }

  // Implementation summary
  let implementationSummary = "Implementation summary not available.";
  try {
    const implBytes = await vscode.workspace.fs.readFile(
      implementationArtifact.uri
    );
    const implContent = new TextDecoder().decode(implBytes);
    const implSection = extractSectionBody(
      implContent,
      "## Implementation"
    );
    if (implSection) {
      implementationSummary = extractFirstParagraph(implSection) ?? implSection;
    } else {
      implementationSummary =
        extractFirstParagraph(implContent) ?? implementationSummary;
    }
  } catch {
    // ignore
  }

  // Testing summary
  let testingSummary = "Testing summary not available.";
  try {
    const implBytes = await vscode.workspace.fs.readFile(
      implementationArtifact.uri
    );
    const implContent = new TextDecoder().decode(implBytes);
    const testingSection = extractSectionBody(implContent, "## Testing");
    if (testingSection) {
      testingSummary = extractFirstParagraph(testingSection) ?? testingSection;
    }
  } catch {
    try {
      const lowLevelBytes = await vscode.workspace.fs.readFile(lowLevelPlanUri);
      const lowLevelContent = new TextDecoder().decode(lowLevelBytes);
      const testingSection = extractSectionBody(
        lowLevelContent,
        "## Testing"
      );
      if (testingSection) {
        testingSummary =
          extractFirstParagraph(testingSection) ?? testingSection;
      }
    } catch {
      // ignore
    }
  }

  const parts: string[] = [];
  parts.push(`# ${taskTitle}`);
  parts.push("");
  parts.push("## Summary");
  parts.push("");
  parts.push(summary);
  parts.push("");
  parts.push("## Implementation");
  parts.push("");
  parts.push(implementationSummary);
  parts.push("");
  parts.push("## Testing");
  parts.push("");
  parts.push(testingSummary);
  parts.push("");
  parts.push("## Changed Files");
  parts.push("");
  if (changedFiles.length > 0) {
    for (const file of changedFiles) {
      parts.push(`- ${file}`);
    }
  } else {
    parts.push("- (no changes)");
  }
  parts.push("");

  return parts.join("\n");
}

/**
 * Save relevant dirty documents before git operations.
 * In default (task-folder-only) mode, only saves documents inside the
 * task folder. In include-all mode, saves any dirty document in the repo.
 */
async function saveDirtyDocuments(
  taskFolderPath: string,
  repoRoot: string,
  includeAll: boolean
): Promise<boolean> {
  const taskFileUri = vscode.Uri.file(path.join(taskFolderPath, TASK_FILENAME));
  const taskFolderUri = vscode.Uri.file(taskFolderPath);
  const implementationArtifact = await resolveImplementationArtifact(
    taskFolderUri
  );
  const lowLevelPlanUri = getLowLevelPlanUri(taskFolderUri);

  const relevantPaths = new Set([
    taskFileUri.fsPath,
    implementationArtifact.uri.fsPath,
    lowLevelPlanUri.fsPath,
  ]);

  const dirtyDocs = vscode.workspace.textDocuments.filter((doc) => {
    if (!doc.isDirty) {
      return false;
    }
    if (relevantPaths.has(doc.uri.fsPath)) {
      return true;
    }
    // In task-folder-only mode: only save files inside the task folder
    if (!includeAll) {
      return isFileInFolder(doc.uri.fsPath, taskFolderPath);
    }
    // In include-all mode: also include dirty files inside the repo
    return isFileInFolder(doc.uri.fsPath, repoRoot);
  });

  for (const doc of dirtyDocs) {
    const saved = await doc.save();
    if (!saved || doc.isDirty) {
      void vscode.window.showErrorMessage(
        `Could not save ${path.basename(doc.uri.fsPath)}. Please save all files before committing.`
      );
      return false;
    }
  }

  return true;
}

/**
 * Determine the push destination string for display in the confirm dialog.
 */
async function describePushDestination(
  repoRoot: string,
  currentBranch: string
): Promise<{ description: string; hasUpstream: boolean; singleRemote?: string }> {
  // Try to find upstream
  try {
    const { stdout } = await runGitCommand(repoRoot, "rev-parse", [
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    ]);
    const upstream = stdout.trim();
    if (upstream) {
      return { description: upstream, hasUpstream: true };
    }
  } catch {
    // No upstream
  }

  // Try single remote
  try {
    const { stdout } = await runGitCommand(repoRoot, "remote", []);
    const remotes = stdout.trim().split("\n").filter((r) => r.length > 0);
    if (remotes.length === 1) {
      return {
        description: `${remotes[0]}/${currentBranch} (first push — will set upstream)`,
        hasUpstream: false,
        singleRemote: remotes[0],
      };
    }
    if (remotes.length > 1) {
      return {
        description: `(multiple remotes: ${remotes.join(", ")} — cannot auto-push)`,
        hasUpstream: false,
      };
    }
  } catch {
    // ignore
  }

  return { description: "(no remote configured)", hasUpstream: false };
}

/**
 * Commit and push the current task.
 *
 * ⚠️ RISK NOTICE (IMPORTANT — READ BEFORE MODIFYING):
 *
 * Default mode: stages ONLY the task folder, excluding run artifacts.
 * Include-all mode: stages the entire repo (requires explicit opt-in).
 *
 * Run artifacts (runs/, context-pack.md) contain full AI prompts and
 * file contents. They are excluded from the default staged set.
 *
 * This command does NOT roll back local commits if push fails.
 * If push fails, the local commit is kept and the user is shown how to undo.
 *
 * See DISCLAIMER.md §4 for the full risk disclosure.
 */
export async function commitAndPushTask(
  inventory: TaskInventory,
  explicitArg?: CommitAndPushTaskArg,
  currentTaskStore?: CurrentTaskStore
): Promise<void> {
  const resolverArg = normalizeArg(explicitArg);

  // Resolution order (matches resolveTaskContext contract):
  //   1. explicit task arg (tree node, canonical ID, folder path) — highest precedence
  //   2. persisted current-task canonical ID from CurrentTaskStore
  // Malformed explicit args are hard failures (no redirect to unrelated tasks).
  const resolvedTask = await resolveTaskContext(inventory, resolverArg, {
    allowPaused: true,
  }, currentTaskStore);

  if (!resolvedTask) {
    // If an explicit arg was supplied but resolution failed, the task is gone;
    // a clear error was already shown by resolveTaskContext. If no arg and no
    // persisted task, guide the user.
    if (resolverArg) {
      void vscode.window.showErrorMessage(
        "The task could not be found. It may have been deleted or moved. " +
          "Please refresh the Tasks panel and try again."
      );
    } else {
      void vscode.window.showInformationMessage(
        "No completed task found to commit and push. " +
          "Select a task in the Tasks panel first, or invoke from a completed task row."
      );
    }
    return;
  }

  // Allow committing from completed stage only
  if (resolvedTask.progress.currentStage !== "completed") {
    void vscode.window.showWarningMessage(
      `Task is at stage "${STAGE_DISPLAY_NAMES[resolvedTask.progress.currentStage]}" — must be completed before committing and pushing.`
    );
    return;
  }

  // ── Lint-state gate ────────────────────────────────────────────────────────
  // If the lint state is unknown (no lintPayload), warn the user before
  // committing. The user can bypass by confirming, or cancel to run lint first.
  const lintPayload = resolvedTask.progress.lintPayload;
  if (!lintPayload) {
    const choice = await vscode.window.showWarningMessage(
      `Lint state is unknown for "${resolvedTask.folderName}".\n\n` +
        "Run linting fixes first to record the lint state, or proceed without lint validation.",
      { modal: true },
      "Proceed Without Lint",
      "Cancel"
    );
    if (choice !== "Proceed Without Lint") {
      void vscode.window.showInformationMessage(
        "Commit and push cancelled. Run 'Fix Linting Issues' first to record lint state."
      );
      return;
    }
    // Backfill lint payload for older completed tasks that have no lint payload yet
    const taskFolderUri = vscode.Uri.file(resolvedTask.taskFolderPath);
    await patchTaskProgress(taskFolderUri, (current) =>
      updateLintPayload(current, {
        runAt: new Date().toISOString(),
        passed: true,
        summary: "Bypassed/Backfilled",
      })
    );
  } else if (!lintPayload.passed) {
    const summary = lintPayload.summary ? ` (${lintPayload.summary})` : "";
    const choice = await vscode.window.showWarningMessage(
      `Lint reported failures for "${resolvedTask.folderName}"${summary}.\n\n` +
        "The task was committed despite lint failures. Proceed anyway?",
      { modal: true },
      "Proceed",
      "Cancel"
    );
    if (choice !== "Proceed") {
      void vscode.window.showInformationMessage("Commit and push cancelled.");
      return;
    }
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Committing and pushing ${resolvedTask.folderName}...`,
      cancellable: false,
    },
    async (progress) => {
      try {
        // Resolve repository
        progress.report({ message: "Resolving git repository..." });
        const repoRoot = await resolveGitRepo(resolvedTask.taskFolderPath);
        if (!repoRoot) {
          throw new Error(
            "Could not find git repository. Make sure the task is inside a git repository."
          );
        }

        // Check for existing staged changes
        const { stdout: stagedOutput } = await runGitCommand(
          repoRoot,
          "diff",
          ["--cached", "--name-only"]
        );
        if (stagedOutput.trim().length > 0) {
          throw new Error(
            "There are already staged changes. Please commit or unstage them first."
          );
        }

        // Check for changes in the task folder (default mode)
        progress.report({ message: "Checking for changes..." });
        const hasTaskFolderChanges = await hasChangesToCommit(
          repoRoot,
          resolvedTask.taskFolderPath
        );

        // Determine staging scope
        let includeAll = false;
        if (!hasTaskFolderChanges) {
          // Task folder is clean — offer include-all or cancel
          const hasRepoChanges = await hasChangesToCommit(repoRoot);
          if (!hasRepoChanges) {
            void vscode.window.showInformationMessage(
              "No changes to commit — the repository is clean."
            );
            return;
          }

          const choice = await vscode.window.showInformationMessage(
            "No changes in the task folder.\n\n" +
              "There are changes elsewhere in the repository. " +
              "Would you like to include all repository changes?",
            { modal: true },
            "Include All Repository Changes",
          );
          if (choice !== "Include All Repository Changes") {
            void vscode.window.showInformationMessage("Commit and push cancelled.");
            return;
          }
          includeAll = true;
        }

        // Get changed files for preview
        progress.report({ message: "Collecting changed files..." });
        const { scopedFiles, repoFiles, runArtifactPaths } =
          await getChangedFiles(repoRoot, resolvedTask.taskFolderPath, includeAll);

        if (scopedFiles.length === 0 && !includeAll) {
          // All task-folder changes were run artifacts
          const choice = await vscode.window.showWarningMessage(
            "The only changes in the task folder are run artifacts " +
              "(runs/, context-pack.md). " +
              "These are excluded from the default staged set because they " +
              "contain AI prompts and file contents.\n\n" +
              "Include run artifacts in this commit?",
            { modal: true },
            "Include Run Artifacts",
          );
          if (choice === "Include Run Artifacts") {
            includeAll = false;
            // Re-fetch with run artifacts included
            const withRunArtifacts = await getChangedFiles(
              repoRoot,
              resolvedTask.taskFolderPath,
              false
            );
            // Force include run artifacts by using all task-folder files
            scopedFiles.push(...withRunArtifacts.repoFiles.filter((f) => {
              const taskRelative = path
                .relative(repoRoot, resolvedTask.taskFolderPath)
                .replace(/\\/g, "/");
              return f === taskRelative || f.startsWith(taskRelative + "/");
            }));
          } else {
            void vscode.window.showInformationMessage("Commit and push cancelled.");
            return;
          }
        }

        // Get current branch and push destination for the confirm dialog
        let currentBranch = "(unknown)";
        try {
          const { stdout: branchOut } = await runGitCommand(repoRoot, "rev-parse", [
            "--abbrev-ref",
            "HEAD",
          ]);
          currentBranch = branchOut.trim();
        } catch {
          // ignore
        }

        if (currentBranch === "HEAD") {
          throw new Error(
            "Repository is in detached HEAD state. Check out a branch before committing."
          );
        }

        const { description: pushDestination, hasUpstream, singleRemote } =
          await describePushDestination(repoRoot, currentBranch);

        if (!hasUpstream && !singleRemote) {
          // Multiple remotes or no remote — cannot auto-push
          throw new Error(
            `Push target is ambiguous: ${pushDestination}. ` +
              `Set an upstream manually with: git push -u <remote> ${currentBranch}`
          );
        }

        // ----------------------------------------------------------------
        // ⚠️  CONFIRMATION DIALOG with file preview and push destination
        //
        // This is the critical safety gate. Staging and pushing are NOT
        // reversible once changes reach a shared remote.
        // ----------------------------------------------------------------
        const MAX_PREVIEW_FILES = 15;
        const previewFiles = scopedFiles.slice(0, MAX_PREVIEW_FILES);
        const remaining = scopedFiles.length - previewFiles.length;

        const scopeLabel = includeAll
          ? "all repository changes"
          : "task folder only (run artifacts excluded by default)";

        const fileList = previewFiles
          .map((f) => {
            const isRunArtifact = runArtifactPaths.includes(f);
            const marker = isRunArtifact ? " ⚠ (run artifact — contains AI prompts)" : "";
            return `  • ${renderPath(f)}${marker}`;
          })
          .join("\n");
        const moreNote =
          remaining > 0 ? `\n  … and ${remaining} more file(s)` : "";

        const repoExtra =
          !includeAll && repoFiles.length > scopedFiles.length + runArtifactPaths.length
            ? `\n\n(${repoFiles.length - scopedFiles.length - runArtifactPaths.length} additional file(s) changed elsewhere in the repo — not staged in default mode)`
            : "";

        const confirmMessage =
          `⚠️ Commit and push — please review carefully\n\n` +
          `Scope: ${scopeLabel}\n` +
          `Branch: ${currentBranch}\n` +
          `Destination: ${pushDestination}\n\n` +
          `Files to be staged (${scopedFiles.length} total):\n` +
          fileList +
          moreNote +
          repoExtra +
          `\n\nPushing is outward-facing and largely irreversible.\n` +
          `Run artifacts (runs/, context-pack.md) contain AI prompts and file contents.\n` +
          `See DISCLAIMER.md §4-5 for full risk details.\n\n` +
          `Proceed?`;

        const confirmed = await vscode.window.showWarningMessage(
          confirmMessage,
          { modal: true },
          "Commit & Push",
          "View Full List"
        );

        if (confirmed === "View Full List") {
          // Show the full file list in the output channel and return —
          // the user can re-invoke the command after reviewing.
          const channel = getCommitPreviewChannel();
          channel.clear();
          channel.appendLine("=== Ensemble: Commit Preview — Full File List ===");
          channel.appendLine("");
          channel.appendLine(`Scope: ${scopeLabel}`);
          channel.appendLine(`Branch: ${currentBranch}`);
          channel.appendLine(`Destination: ${pushDestination}`);
          channel.appendLine("");
          channel.appendLine(`Files to be staged (${scopedFiles.length} total):`);
          for (const f of scopedFiles) {
            const isRunArtifact = runArtifactPaths.includes(f);
            const marker = isRunArtifact
              ? "  [run artifact — contains AI prompts and file contents]"
              : "";
            channel.appendLine(`  ${renderPath(f)}${marker}`);
          }
          if (!includeAll && repoFiles.length > scopedFiles.length + runArtifactPaths.length) {
            channel.appendLine("");
            channel.appendLine("Not staged (outside task folder in default mode):");
            for (const f of repoFiles) {
              const taskRelative = path
                .relative(repoRoot, resolvedTask.taskFolderPath)
                .replace(/\\/g, "/");
              const inTaskFolder = f === taskRelative || f.startsWith(taskRelative + "/");
              if (!inTaskFolder) {
                channel.appendLine(`  ${renderPath(f)}`);
              }
            }
          }
          channel.appendLine("");
          channel.appendLine("Run the command again to proceed after reviewing.");
          channel.show(true);
          void vscode.window.showInformationMessage(
            "Full file list shown in 'Ensemble: Commit Preview'. Re-run the command to proceed."
          );
          return;
        }

        if (confirmed !== "Commit & Push") {
          void vscode.window.showInformationMessage(
            "Commit and push cancelled."
          );
          return;
        }

        // Save dirty documents (scoped to task folder or entire repo)
        progress.report({ message: "Saving open files..." });
        const saved = await saveDirtyDocuments(
          resolvedTask.taskFolderPath,
          repoRoot,
          includeAll
        );
        if (!saved) {
          return;
        }

        // Generate PR description
        progress.report({ message: "Generating PR description..." });
        const prDescription = await generatePRDescription(
          resolvedTask.taskFolderPath,
          resolvedTask.folderName,
          scopedFiles
        );
        const prDescPath = path.join(
          resolvedTask.taskFolderPath,
          "pr-description.md"
        );
        const prDescUri = vscode.Uri.file(prDescPath);

        // Write PR description atomically
        const tempPath = prDescPath + ".tmp";
        const tempUri = vscode.Uri.file(tempPath);
        await vscode.workspace.fs.writeFile(
          tempUri,
          new TextEncoder().encode(prDescription)
        );
        await vscode.workspace.fs.rename(tempUri, prDescUri, {
          overwrite: true,
        });

        try {
          // Stage changes — scoped to task folder in default mode,
          // or the entire repo in include-all mode.
          progress.report({ message: "Staging changes..." });
          if (includeAll) {
            // Include-all mode: stage everything in the repo
            await runGitCommand(repoRoot, "add", ["-A", "--", "."]);
          } else {
            // Default mode: stage only files from scopedFiles (excludes run artifacts)
            // We need to stage each file individually to exclude run artifacts.
            if (scopedFiles.length > 0) {
              await runGitCommand(repoRoot, "add", [
                "--",
                ...scopedFiles,
              ]);
            }
          }

          // Commit
          progress.report({ message: "Creating commit..." });
          const commitMessage = `Ensemble: ${resolvedTask.folderName}`;
          await runGitCommand(repoRoot, "commit", ["-m", commitMessage]);

          // Push with explicit destination
          progress.report({ message: "Pushing to remote..." });
          if (hasUpstream) {
            // Upstream exists — push explicitly to avoid ambiguity
            await runGitCommand(repoRoot, "push", []);
          } else if (singleRemote) {
            // First push — set upstream
            await runGitCommand(repoRoot, "push", [
              "-u",
              singleRemote,
              currentBranch,
            ]);
          }

          void vscode.window.showInformationMessage(
            `Successfully committed and pushed ${resolvedTask.folderName} to ${pushDestination}`
          );
        } catch (error: unknown) {
          // Push failed after commit was created — keep the local commit.
          // Do NOT automatically roll back: this mutates user's git history
          // without their explicit instruction. Instead, tell them how to
          // undo manually if they want to.
          const errMsg = getErrorMessage(error);
          void vscode.window.showErrorMessage(
            `Push failed. Your local commit was kept — it has NOT been rolled back automatically.\n\n` +
            `To undo the commit manually: git reset --mixed HEAD~1\n\n` +
            `Error: ${errMsg}`
          );
        }
      } catch (error: unknown) {
        void vscode.window.showErrorMessage(
          `Commit and push failed: ${getErrorMessage(error)}`
        );
      }
    }
  );
}

/**
 * Combined complete + commit + push command.
 * Marks the task completed, selects the next task, and commits/pushes the completed task.
 */
export async function completeCommitAndPushTask(
  inventory: TaskInventory,
  explicitArg?: CommitAndPushTaskArg,
  currentTaskStore?: CurrentTaskStore
): Promise<void> {
  const resolverArg = normalizeArg(explicitArg);
  const resolvedTask = await resolveTaskContext(inventory, resolverArg, {
    allowPaused: false,
  }, currentTaskStore);

  if (!resolvedTask) {
    if (resolverArg) {
      void vscode.window.showErrorMessage(
        "The task could not be found. It may have been deleted or moved. " +
          "Please refresh the Tasks panel and try again."
      );
    } else {
      void vscode.window.showInformationMessage(
        "No active task found to complete, commit, and push."
      );
    }
    return;
  }

  // Check stage eligibility: must be at final review stage (impl-low-review) or completed
  if (resolvedTask.progress.currentStage !== "impl-low-review") {
    if (resolvedTask.progress.currentStage === "completed") {
      // If already completed, fall back directly to commit & push
      return commitAndPushTask(inventory, explicitArg, currentTaskStore);
    }
    void vscode.window.showWarningMessage(
      `"Complete, Commit and Push" is only available when the task is at the final review stage (Implementation: Low-Level Review) or completed.`
    );
    return;
  }

  // Gate on known lint state (only when lint state is known)
  const lintPayload = resolvedTask.progress.lintPayload;
  if (!lintPayload) {
    void vscode.window.showWarningMessage(
      `Lint state is unknown for "${resolvedTask.folderName}". Run linting fixes first.`
    );
    return;
  }

  // 1. Transition stage to "completed" using the shared advanceStage helper
  const taskFolderUri = vscode.Uri.file(resolvedTask.taskFolderPath);
  const transitionResult = await advanceStage(
    taskFolderUri,
    resolvedTask.progress.currentStage,
    "completed",
    false,
    false
  );

  if (!transitionResult?.persisted) {
    void vscode.window.showErrorMessage(
      `Could not persist completion for ${resolvedTask.folderName}. Please try again.`
    );
    return;
  }

  // 2. Refresh inventory
  await inventory.refresh();

  // 3. Select next active task deterministically
  if (currentTaskStore) {
    const nextCanonicalId = selectNextTask(inventory, resolvedTask.canonicalId);
    if (nextCanonicalId) {
      await currentTaskStore.set(nextCanonicalId);
    } else {
      await currentTaskStore.clear();
    }
  }

  // 4. Run commit & push
  const completedTask: IncompleteTask = {
    folderUri: vscode.Uri.file(resolvedTask.taskFolderPath),
    folderName: resolvedTask.folderName,
    progress: {
      ...resolvedTask.progress,
      currentStage: "completed", // Since it was just advanced
    },
    canonicalId: resolvedTask.canonicalId,
  };
  await commitAndPushTask(inventory, { task: completedTask }, currentTaskStore);
}

/**
 * Register the commitAndPushTask command.
 */
export function registerCommitAndPushTaskCommand(
  context: vscode.ExtensionContext,
  inventory: TaskInventory,
  currentTaskStore?: CurrentTaskStore
): void {
  const disposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.commitAndPushTask",
    (arg?: CommitAndPushTaskArg) =>
      commitAndPushTask(inventory, arg, currentTaskStore)
  );
  const completeDisposable = vscode.commands.registerCommand(
    "vs-code-ai-helper.completeCommitAndPushTask",
    (arg?: CommitAndPushTaskArg) =>
      completeCommitAndPushTask(inventory, arg, currentTaskStore)
  );
  context.subscriptions.push(disposable, completeDisposable);
}
